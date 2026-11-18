"""Notion import jobs: the zip's upload, the background run with progress, and the report.

    create  →  a job (state "uploading") and a presigned PUT for the zip (straight to storage, never
               through this server; ``imports/notion/<user>/<job>.zip``, private)
    start   →  the zip arrived (its size checked): "queued"
    tick    →  (background loop ``notion_import``, services/background.py) claims the next queued job — or a
               "running" one whose heartbeat stopped (a restart) — and runs it: the zip is streamed to a
               temporary file, read (export_zip.py) and written (writer.py) with progress N of M; the
               writer is idempotent, so a run picked up again skips what it already wrote
    done / failed / cancelled: the zip is deleted; the report (counts, skipped with reasons, errors per
               page, where it went) stays on the job row (``notion_imports``, kept 30 days)

A job is the caller's own: anyone else's is "not found".
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import secrets
import shutil
import tempfile
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import r2
from app.services.notion_import import export_zip
from app.services.notion_import import writer as W

log = logging.getLogger(__name__)

COLL = "notion_imports"
MAX_BYTES = 2 * 1024 ** 3
UPLOAD_HOURS = 6
STALE_AFTER = timedelta(minutes=3)
KEEP_DAYS = 30
MAX_ACTIVE = 3
ACTIVE = ("uploading", "queued", "running")
CONTENT_TYPE = "application/zip"
_RUNNING: dict[str, asyncio.Task] = {}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _iso(dt: datetime | None) -> str | None:
    dt = _aware(dt)
    return dt.isoformat() if dt else None


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index([("user_id", 1), ("created_at", -1)])
    await db[COLL].create_index([("state", 1), ("heartbeat_at", 1)])
    await db[COLL].create_index("purge_at", expireAfterSeconds=0)
    await W.ensure_indexes(db)


# ── Where an import can go ────────────────────────────────────────────────────


async def destinations(db: AsyncIOMotorDatabase, user) -> dict:
    """My files, and every team space the caller can add to (members of the team; admins: all)."""
    from app.models.workspace import role_allows
    from app.services import access
    from app.services import teams as T
    from app.services import workspace as ws_service

    ctx = access.Ctx(db)
    places: list[dict] = []
    for ws, role in await ws_service.list_for_user(db, user.id):
        if not role_allows(role, "member"):
            continue
        view = await ctx.team_view(ws.id, user.id)
        general = view.general_id
        places.append({"workspace_id": ws.id, "workspace_name": ws.name, "team_id": general,
                       "team_name": (view.teams.get(general) or {}).get("name") if general else "General",
                       "general": True})
        rows = [t for tid, t in view.teams.items() if tid != general and (view.admin or tid in view.member_teams)
                and not t.get("archived")]
        for t in sorted(rows, key=lambda t: (t.get("name") or "").casefold()):
            places.append({"workspace_id": ws.id, "workspace_name": ws.name, "team_id": str(t["_id"]),
                           "team_name": t.get("name"), "general": False})
        _ = T
    return {"personal": True, "places": places}


async def check_destination(db: AsyncIOMotorDatabase, user, dest: dict | None) -> dict:
    """The destination asked for, checked now (and again when the job runs)."""
    from app.models.workspace import role_allows
    from app.services import access
    from app.services import folder as folder_service
    from app.services import teams as T
    from app.services import workspace as ws_service

    dest = dest or {}
    ws_id = (dest.get("workspace") or "").strip() or None
    folder_name = " ".join(str(dest.get("folder_name") or "").split())[:100] or None
    new_folder = dest.get("new_folder")
    out: dict[str, Any] = {"kind": "personal", "workspace_id": None, "workspace_name": None, "team_id": None,
                           "team_name": None, "general": False, "parent_folder_id": None,
                           "new_folder": bool(True if new_folder is None else new_folder), "folder_name": folder_name}
    if not ws_id:
        if dest.get("team") or dest.get("folder"):
            raise HTTPException(status_code=422, detail="A team or folder needs its workspace.")
        return out
    ws = await ws_service.get_workspace(db, ws_id)
    role = await ws_service.role_for(db, ws_id, user.id) if ws else None
    if ws is None or role is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    if not role_allows(role, "member"):
        raise HTTPException(status_code=403, detail="Only members of the workspace can import into it.")
    await ws_service.assert_open(db, ws_id)
    out.update(kind="team", workspace_id=ws_id, workspace_name=ws.name)
    ctx = access.Ctx(db)
    view = await ctx.team_view(ws_id, user.id)
    team_ref = (dest.get("team") or "").strip() or None
    tid = None
    if team_ref:
        tid = next((k for k, t in view.teams.items()
                    if team_ref in (k, t.get("slug")) or (t.get("name") or "").casefold() == team_ref.casefold()), None)
        if tid is None:
            raise HTTPException(status_code=404, detail="Team not found in that workspace.")
    if tid and tid == view.general_id:
        tid = None
    if tid and not view.admin and tid not in view.member_teams:
        raise HTTPException(status_code=403, detail=f"You're not in the team {view.teams[tid].get('name')!r}.")
    out["general"] = tid is None
    out["team_id"] = tid
    out["team_name"] = (view.teams.get(tid) or {}).get("name") if tid else (
        (view.teams.get(view.general_id) or {}).get("name") if view.general_id else "General")
    if dest.get("folder"):
        out["parent_folder_id"] = await folder_service.resolve_ref(db, ws_id, str(dest["folder"]))
    _ = T
    return out


# ── Jobs ──────────────────────────────────────────────────────────────────────


def out(job: dict) -> dict:
    d = job.get("dest") or {}
    res = job.get("result")
    return {
        "id": job["_id"], "state": job["state"], "file_name": job.get("file_name"),
        "size_bytes": int(job.get("size_bytes") or 0),
        "destination": {"kind": d.get("kind", "personal"), "workspace_id": d.get("workspace_id"),
                        "workspace_name": d.get("workspace_name"), "team_id": d.get("team_id"),
                        "team_name": d.get("team_name"), "folder_id": job.get("folder_id") or d.get("parent_folder_id"),
                        "folder_name": job.get("folder_name") or d.get("folder_name")},
        "progress": job.get("progress") or {"phase": "upload", "done": 0, "total": 0, "current": None},
        "counts": {**{k: 0 for k in ("pages", "databases", "rows", "images", "files", "updated", "unchanged",
                                     "kept_edited", "skipped", "errors")}, **(job.get("counts") or {})},
        "skipped": job.get("skipped") or [], "errors": job.get("errors") or [],
        "result": res, "error": job.get("error"),
        "created_at": _iso(job.get("created_at")), "started_at": _iso(job.get("started_at")),
        "finished_at": _iso(job.get("finished_at")),
    }


async def _load(db: AsyncIOMotorDatabase, user, job_id: str) -> dict:
    job = await db[COLL].find_one({"_id": job_id})
    if job is None or job.get("user_id") != user.id:
        raise HTTPException(status_code=404, detail="Import not found.")
    return job


async def create(db: AsyncIOMotorDatabase, user, *, file_name: str, size_bytes: int,
                 destination: dict | None) -> tuple[dict, dict]:
    name = (file_name or "").strip().rsplit("/", 1)[-1][:200]
    if not name.lower().endswith(".zip"):
        raise HTTPException(status_code=415, detail="Import the .zip file Notion's export gave you (Markdown & CSV).")
    size = int(size_bytes or 0)
    if size <= 0:
        raise HTTPException(status_code=422, detail="That file is empty.")
    if size > MAX_BYTES:
        raise HTTPException(status_code=413, detail=(
            f"This export is {size / 1024 ** 3:.1f} GB; an import takes up to {MAX_BYTES // 1024 ** 3} GB. Export "
            "your Notion workspace in parts (a few top-level pages at a time)."))
    if not r2.is_configured():
        raise HTTPException(status_code=503, detail="File storage isn't available right now. Try again later.")
    dest = await check_destination(db, user, destination)
    if await db[COLL].count_documents({"user_id": user.id, "state": {"$in": list(ACTIVE)}}) >= MAX_ACTIVE:
        raise HTTPException(status_code=429, detail=f"You have {MAX_ACTIVE} imports going already. Wait for one "
                                                    "to finish, or cancel one.")
    now = now_utc()
    jid = "ni_" + secrets.token_urlsafe(12)
    key = f"imports/notion/{user.id}/{jid}.zip"
    try:
        url = await run_in_threadpool(r2.presign_put_for, key, CONTENT_TYPE, UPLOAD_HOURS * 3600)
    except Exception:
        log.warning("presigning a notion import upload failed", exc_info=True)
        raise HTTPException(status_code=502, detail="File storage didn't respond. Try again in a moment.")
    job = {"_id": jid, "user_id": user.id, "state": "uploading", "file_name": name, "size_bytes": size, "key": key,
           "dest": dest, "progress": {"phase": "upload", "done": 0, "total": 0, "current": None},
           "created_at": now, "expires_at": now + timedelta(hours=UPLOAD_HOURS),
           "purge_at": now + timedelta(days=KEEP_DAYS), "attempts": 0}
    await db[COLL].insert_one(job)
    upload = {"url": url, "method": "PUT", "headers": {"Content-Type": CONTENT_TYPE},
              "expires_at": _iso(job["expires_at"])}
    return job, upload


async def start(db: AsyncIOMotorDatabase, user, job_id: str) -> dict:
    job = await _load(db, user, job_id)
    if job["state"] != "uploading":
        return job
    if _aware(job.get("expires_at")) and _aware(job["expires_at"]) < now_utc():
        raise HTTPException(status_code=410, detail="This upload expired; start the import again.")
    meta = await run_in_threadpool(r2.head, job["key"])
    if meta is None:
        raise HTTPException(status_code=409, detail="The zip hasn't reached storage yet: upload it to the URL "
                                                    "the import gave you (PUT), then start it.")
    if int(meta.get("size") or 0) != int(job["size_bytes"]):
        await run_in_threadpool(r2.delete, job["key"])
        raise HTTPException(status_code=422, detail=(
            f"The uploaded zip is {int(meta.get('size') or 0):,} bytes but {int(job['size_bytes']):,} were "
            "declared. It was discarded; upload it again."))
    await db[COLL].update_one({"_id": job_id, "state": "uploading"}, {"$set": {
        "state": "queued", "queued_at": now_utc(),
        "progress": {"phase": "reading", "done": 0, "total": 0, "current": None}}})
    kick(db)
    return await db[COLL].find_one({"_id": job_id})


async def get(db: AsyncIOMotorDatabase, user, job_id: str) -> dict:
    return await _load(db, user, job_id)


async def recent(db: AsyncIOMotorDatabase, user, limit: int = 20) -> list[dict]:
    return await db[COLL].find({"user_id": user.id}).sort("created_at", -1).to_list(length=limit)


async def cancel(db: AsyncIOMotorDatabase, user, job_id: str) -> dict:
    job = await _load(db, user, job_id)
    if job["state"] in ACTIVE:
        await db[COLL].update_one({"_id": job_id, "state": {"$in": list(ACTIVE)}}, {"$set": {
            "state": "cancelled", "finished_at": now_utc(), "error": None}})
        if job["state"] != "running":
            await run_in_threadpool(r2.delete, job["key"])
    return await db[COLL].find_one({"_id": job_id})


# ── Running ───────────────────────────────────────────────────────────────────


def kick(db: AsyncIOMotorDatabase) -> None:
    """In a process that runs the background loops, start the next job now rather than at the next tick."""
    from app.services import background

    if not background._TASKS:      # the loops don't run in this process (a web-only one, or tests)
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    if not _RUNNING:
        t = loop.create_task(tick(db))
        _RUNNING["kick"] = t
        t.add_done_callback(lambda _t: _RUNNING.pop("kick", None))


async def tick(db: AsyncIOMotorDatabase) -> int:
    """Expire uploads that never finished, then run queued (or abandoned) jobs one at a time."""
    now = now_utc()
    async for job in db[COLL].find({"state": "uploading", "expires_at": {"$lt": now}}).limit(50):
        await db[COLL].update_one({"_id": job["_id"], "state": "uploading"}, {"$set": {
            "state": "failed", "error": "The zip never finished uploading.", "finished_at": now}})
        await run_in_threadpool(r2.delete, job["key"])
    n = 0
    while n < 5:
        job = await db[COLL].find_one_and_update(
            {"$or": [{"state": "queued"},
                     {"state": "running", "heartbeat_at": {"$lt": now_utc() - STALE_AFTER}}]},
            {"$set": {"state": "running", "heartbeat_at": now_utc()}, "$inc": {"attempts": 1}},
            sort=[("queued_at", 1)], return_document=True)
        if job is None:
            break
        await run(db, job)
        n += 1
    return n


async def _dest(db: AsyncIOMotorDatabase, user, job: dict, tree_name: str) -> tuple[W.Destination, dict]:
    """The writer's destination: the import's folder made (or found again) / My files' page."""
    from app.services import access, pages
    from app.services import folder as folder_service
    from app.services import teams as T

    d = await check_destination(db, user, {
        "workspace": job["dest"].get("workspace_id"), "team": job["dest"].get("team_id"),
        "folder": job["dest"].get("parent_folder_id"), "new_folder": job["dest"].get("new_folder"),
        "folder_name": job["dest"].get("folder_name")})
    name = d.get("folder_name") or tree_name or "Notion import"
    info: dict[str, Any] = {"folder_id": None, "folder_name": None, "root_slug": None}
    if d["workspace_id"]:
        ws, parent = d["workspace_id"], d.get("parent_folder_id")
        fid = parent
        if d["new_folder"]:
            q: dict[str, Any] = {"workspace_id": ws, "parent_id": parent or None, "notion_import_root": True,
                                 "name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}
            f = await db["folders"].find_one(q)
            if f is None:
                made = await folder_service.create_folder(db, ws, name, parent, actor=access.Actor.of(user),
                                                          ctx=access.Ctx(db))
                extra: dict[str, Any] = {"notion_import_root": True, "notion_imported": True}
                if d["team_id"]:
                    extra.update(T.team_update([d["team_id"]], [])["$set"])
                await db["folders"].update_one({"_id": ObjectId(made.id)}, {"$set": extra})
                fid = made.id
                info["folder_name"] = made.name
            else:
                fid = str(f["_id"])
                info["folder_name"] = f.get("name")
        level = await folder_service.effective_default_access(db, ws, fid)
        if level not in ("private", "workspace"):
            level = "workspace"          # never "anyone with the link"
        info["folder_id"] = fid
        key = f"ws:{ws}:{fid or '-'}:{d['team_id'] or '-'}"
        return W.Destination(user=user, workspace_id=ws, team_id=d["team_id"], folder_id=fid, level=level, key=key), info
    root_slug = None
    if d["new_folder"]:
        # My files has no folders: a page named after the export holds everything.
        lid = f"user:{user.id}|__root__:{name.casefold()}"
        row = await db[W.LINKS].find_one({"_id": lid})
        raw = await db["documents"].find_one({"_id": row["doc_id"], "deleted_at": None}) if row else None
        if raw is None:
            raw, _s, _e = await pages.create_page(db, user, access.Actor.of(user), access.Ctx(db), title=name,
                                                  content="Imported from Notion.\n", access_level="private")
            await db[W.LINKS].update_one({"_id": lid}, {"$set": {"dest": f"user:{user.id}", "notion_id": "__root__",
                                                                 "doc_id": raw["_id"], "slug": raw["slug"]}}, upsert=True)
        root_slug = raw["slug"]
        info["root_slug"] = root_slug
        info["folder_name"] = name
    key = f"user:{user.id}:{root_slug or '-'}"
    return W.Destination(user=user, root_page_slug=root_slug, level="private", key=key), info


async def run(db: AsyncIOMotorDatabase, job: dict) -> None:
    """Run one claimed job to its end (done / failed / cancelled)."""
    from app.services import urls
    from app.services.user import get_user_by_id

    jid = job["_id"]
    tmp = tempfile.mkdtemp(prefix="notion-import-")
    ez = None
    report = W.Report()
    last = {"t": 0.0, "check": 0.0}

    async def beat(**sets) -> None:
        await db[COLL].update_one({"_id": jid}, {"$set": {"heartbeat_at": now_utc(), **sets}})

    async def progress(phase: str, done: int, total: int, current: str | None) -> bool:
        t = time.monotonic()
        if t - last["t"] >= 1.0 or done >= total:
            last["t"] = t
            await beat(progress={"phase": phase, "done": done, "total": total, "current": (current or "")[:200] or None},
                       counts=report.counts)
        if t - last["check"] >= 2.0:
            last["check"] = t
            cur = await db[COLL].find_one({"_id": jid}, {"state": 1})
            if cur is None or cur.get("state") != "running":
                return False
        return True

    try:
        user = await get_user_by_id(db, job["user_id"])
        if user is None:
            raise export_zip.ExportError("The account that started this import is gone.")
        await beat(started_at=job.get("started_at") or now_utc(),
                   progress={"phase": "reading", "done": 0, "total": 0, "current": None})
        path = os.path.join(tmp, "export.zip")
        try:
            await run_in_threadpool(r2.download_to, job["key"], path)
        except Exception:
            raise export_zip.ExportError("The uploaded zip couldn't be read from storage. Import it again.")
        await beat()

        def read():
            z = export_zip.ExportZip(path, tmp)
            return z, export_zip.build_tree(z, job.get("file_name"))

        ez, tree = await run_in_threadpool(read)
        dest, info = await _dest(db, user, job, tree.name)
        await beat(folder_id=info["folder_id"], folder_name=info["folder_name"])
        w = W.Writer(db, tree, dest, report, progress)
        await w.run()
        cur = await db[COLL].find_one({"_id": jid}, {"state": 1})
        if cur is None or cur.get("state") != "running":
            return  # cancelled meanwhile: what was written stays (a new import of it picks up from there)
        ws = dest.workspace_id
        items = []
        for r in report.roots[:20]:
            if r.get("slug"):
                items.append({"title": r["title"], "slug": r["slug"], "url": urls.markdrop_url(r["slug"])})
            elif r.get("folder_id") and ws:
                items.append({"title": r["title"], "slug": None, "url": f"/w/{ws}/f/{r['folder_id']}"})
        folder_url = f"/w/{ws}/f/{info['folder_id']}" if ws and info["folder_id"] else None
        if ws:
            where = folder_url or (f"/w/{ws}/teams/{dest.team_id}/pages" if dest.team_id else f"/w/{ws}")
        else:
            where = urls.markdrop_url(info["root_slug"]) if info["root_slug"] else (
                items[0]["url"] if len(items) == 1 else "/dashboard/files")
        result = {"folder_id": info["folder_id"], "folder_url": folder_url, "url": where, "pages": items}
        await db[COLL].update_one({"_id": jid}, {"$set": {
            "state": "done", "finished_at": now_utc(), "result": result, "counts": report.counts,
            "skipped": report.skipped, "errors": report.errors,
            "progress": {"phase": "done", "done": 1, "total": 1, "current": None}}})
    except export_zip.ExportError as exc:
        await db[COLL].update_one({"_id": jid}, {"$set": {"state": "failed", "error": str(exc), "finished_at": now_utc(),
                                                         "counts": report.counts, "skipped": report.skipped,
                                                         "errors": report.errors}})
    except HTTPException as exc:
        msg = exc.detail if isinstance(exc.detail, str) else "The import was refused."
        await db[COLL].update_one({"_id": jid}, {"$set": {"state": "failed", "error": msg, "finished_at": now_utc(),
                                                         "counts": report.counts}})
    except Exception:
        log.exception("notion import %s failed", jid)
        await db[COLL].update_one({"_id": jid}, {"$set": {
            "state": "failed", "finished_at": now_utc(), "counts": report.counts, "skipped": report.skipped,
            "errors": report.errors,
            "error": "Something went wrong on Markdrop's side. What was imported so far stays; import the same "
                     "zip again to finish (pages already imported aren't duplicated)."}})
    finally:
        if ez is not None:
            ez.close()
        shutil.rmtree(tmp, ignore_errors=True)
        final = await db[COLL].find_one({"_id": jid}, {"state": 1, "key": 1})
        if final is not None and final.get("state") in ("done", "failed", "cancelled"):
            await run_in_threadpool(r2.delete, final["key"])
