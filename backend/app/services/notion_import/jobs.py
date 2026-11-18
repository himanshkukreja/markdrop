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

Connect Notion (Phase B) runs the same jobs with ``source: "api"``: no zip; the job names the person's
Notion connection and the roots (pages / databases) to read, and the API adapter (api_source.py) builds
the tree instead of export_zip.py. A "Keep in sync" run (sync.py) is such a job with ``sync_ids`` and,
when only changes are wanted, ``since``.
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
    from app.services.notion_import import connect, sync

    await connect.ensure_indexes(db)
    await sync.ensure_indexes(db)


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
        "source": job.get("source") or "zip", "sync": bool(job.get("sync_ids")) and not job.get("manual"),
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
    if await _active_count(db, user) >= MAX_ACTIVE:
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


async def _active_count(db: AsyncIOMotorDatabase, user) -> int:
    """Imports the person started that are still going (scheduled syncs don't count)."""
    return await db[COLL].count_documents({"user_id": user.id, "state": {"$in": list(ACTIVE)},
                                           "$or": [{"sync_ids": None}, {"manual": True}]})


def _root_list(roots: list) -> list[dict]:
    from app.services.notion_import.api_source import hexid

    out: list[dict] = []
    for r in roots or []:
        if isinstance(r, str):
            r = {"id": r}
        rid = hexid(str(r.get("id") or ""))
        if not re.fullmatch(r"[0-9a-f]{32}", rid) or rid in {x["id"] for x in out}:
            continue
        kind = r.get("kind") if r.get("kind") in ("page", "database") else "page"
        out.append({"id": rid, "kind": kind, "title": str(r.get("title") or "")[:200] or None})
    return out


async def create_api(db: AsyncIOMotorDatabase, user, *, connection_id: str | None, roots: list,
                     destination: dict | None, keep_in_sync: bool = False) -> dict:
    """An import of pages / databases the person shared with Markdrop in Notion (Connect Notion)."""
    from app.services.notion_import import api_source, connect
    from app.services.notion_import import sync as S

    connect.need_configured()
    conn = await connect.get_own(db, user, connection_id)
    if conn.get("broken"):
        raise HTTPException(status_code=409, detail="Your Notion connection stopped working. Reconnect Notion.")
    picked = _root_list(roots)
    if not picked:
        raise HTTPException(status_code=422, detail="Pick at least one Notion page or database to import.")
    if len(picked) > 50:
        raise HTTPException(status_code=422, detail="Pick at most 50 pages at a time (sub-pages come with them).")
    # Titles (and kinds) from Notion itself, not from the caller.
    try:
        listing = await shared_listing(db, conn)
    except HTTPException:
        raise
    by_id = {it["id"]: it for it in listing["items"]}
    for r in picked:
        it = by_id.get(r["id"])
        if it is not None:
            r.update(kind=it["kind"], title=it["title"])
        r["title"] = r.get("title") or "Untitled"
    dest = await check_destination(db, user, destination)
    if await _active_count(db, user) >= MAX_ACTIVE:
        raise HTTPException(status_code=429, detail=f"You have {MAX_ACTIVE} imports going already. Wait for one "
                                                    "to finish, or cancel one.")
    if dest.get("new_folder") and not dest.get("folder_name"):
        dest["folder_name"] = (picked[0]["title"] if len(picked) == 1 else conn.get("workspace_name") or "Notion")[:100]
    now = now_utc()
    jid = "ni_" + secrets.token_urlsafe(12)
    name = ", ".join(r["title"] for r in picked)
    job = {"_id": jid, "user_id": user.id, "state": "queued", "source": "api", "connection_id": conn["_id"],
           "roots": picked, "file_name": (name[:197] + "…") if len(name) > 200 else name, "size_bytes": 0,
           "key": None, "dest": dest, "progress": {"phase": "reading", "done": 0, "total": 0, "current": None},
           "created_at": now, "queued_at": now, "purge_at": now + timedelta(days=KEEP_DAYS), "attempts": 0,
           "manual": True, "since": None}
    job["sync_ids"] = await S.record(db, user, connection_id=conn["_id"], roots=picked, dest=dest,
                                     keep=keep_in_sync, job_id=jid)
    await db[COLL].insert_one(job)
    kick(db)
    _ = api_source
    return job


async def shared_listing(db: AsyncIOMotorDatabase, conn: dict) -> dict:
    from app.services.notion_import import api, api_source, connect

    c = await connect.client(db, conn)
    try:
        return await api_source.shared(c)
    except api.NotionError as exc:
        raise _notion_http(exc)
    finally:
        await c.close()


def _notion_http(exc) -> HTTPException:
    if exc.auth:
        return HTTPException(status_code=409, detail="Notion stopped accepting Markdrop's connection. Reconnect Notion.")
    if exc.status == 429:
        return HTTPException(status_code=503, detail="Notion asked Markdrop to slow down. Try again in a minute.")
    return HTTPException(status_code=502, detail="Notion didn't answer. Try again in a minute.")


async def queue_sync(db: AsyncIOMotorDatabase, row: dict, *, since: datetime | None) -> dict:
    """A Keep in sync run of one root (sync.py), queued for the import loop."""
    now = now_utc()
    jid = "ni_" + secrets.token_urlsafe(12)
    job = {"_id": jid, "user_id": row["user_id"], "state": "queued", "source": "api",
           "connection_id": row["connection_id"],
           "roots": [{"id": row["root_id"], "kind": row.get("root_kind") or "page", "title": row.get("root_title")}],
           "file_name": row.get("root_title") or "Notion", "size_bytes": 0, "key": None, "dest": row.get("dest") or {},
           "progress": {"phase": "reading", "done": 0, "total": 0, "current": None}, "created_at": now,
           "queued_at": now, "purge_at": now + timedelta(days=2), "attempts": 0, "sync_ids": [row["_id"]],
           "since": since}
    await db[COLL].insert_one(job)
    return job


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
    return await db[COLL].find({"user_id": user.id, "$or": [{"sync_ids": None}, {"manual": True}]}).sort(
        "created_at", -1).to_list(length=limit)


async def cancel(db: AsyncIOMotorDatabase, user, job_id: str) -> dict:
    job = await _load(db, user, job_id)
    if job["state"] in ACTIVE:
        await db[COLL].update_one({"_id": job_id, "state": {"$in": list(ACTIVE)}}, {"$set": {
            "state": "cancelled", "finished_at": now_utc(), "error": None}})
        if job["state"] != "running" and job.get("key"):
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
        if t - last["t"] >= 1.0 or (total and done >= total):
            last["t"] = t
            await beat(progress={"phase": phase, "done": done, "total": total, "current": (current or "")[:200] or None},
                       counts=report.counts)
        if t - last["check"] >= 2.0:
            last["check"] = t
            cur = await db[COLL].find_one({"_id": jid}, {"state": 1})
            if cur is None or cur.get("state") != "running":
                return False
        return True

    api_job = job.get("source") == "api"
    sync_kw: dict[str, Any] = {}
    try:
        user = await get_user_by_id(db, job["user_id"])
        if user is None:
            raise export_zip.ExportError("The account that started this import is gone.")
        started = job.get("started_at") or now_utc()
        job["started_at"] = started
        await beat(started_at=started, progress={"phase": "reading", "done": 0, "total": 0, "current": None})
        if api_job:
            got = await _read_api(db, user, job, tmp, progress)
            if got is None:
                return  # cancelled while reading
            tree, dest, info = got
        else:
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
        if job.get("sync_ids"):
            sync_kw = {"info": info, "roots": _root_summaries(w, tree), "full": job.get("since") is None}
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
        if job.get("sync_ids"):
            await _after_sync(db, job, state="done", counts=report.counts, **sync_kw)
    except export_zip.ExportError as exc:
        await db[COLL].update_one({"_id": jid}, {"$set": {"state": "failed", "error": str(exc), "finished_at": now_utc(),
                                                         "counts": report.counts, "skipped": report.skipped,
                                                         "errors": report.errors}})
        if job.get("sync_ids"):
            await _after_sync(db, job, state="failed", error=str(exc), counts=report.counts)
    except HTTPException as exc:
        msg = exc.detail if isinstance(exc.detail, str) else "The import was refused."
        await db[COLL].update_one({"_id": jid}, {"$set": {"state": "failed", "error": msg, "finished_at": now_utc(),
                                                         "counts": report.counts}})
        if job.get("sync_ids"):
            await _after_sync(db, job, state="failed", error=msg, status=exc.status_code, counts=report.counts)
    except Exception:
        log.exception("notion import %s failed", jid)
        await db[COLL].update_one({"_id": jid}, {"$set": {
            "state": "failed", "finished_at": now_utc(), "counts": report.counts, "skipped": report.skipped,
            "errors": report.errors,
            "error": "Something went wrong on Markdrop's side. What was imported so far stays; import the same "
                     + ("pages" if api_job else "zip") + " again to finish (pages already imported aren't duplicated)."}})
        if job.get("sync_ids"):
            await _after_sync(db, job, state="failed", error="Something went wrong on Markdrop's side.",
                              counts=report.counts)
    finally:
        if ez is not None:
            ez.close()
        shutil.rmtree(tmp, ignore_errors=True)
        final = await db[COLL].find_one({"_id": jid}, {"state": 1, "key": 1})
        if final is not None and final.get("state") in ("done", "failed", "cancelled") and final.get("key"):
            await run_in_threadpool(r2.delete, final["key"])


# ── Connect Notion (the API source) ───────────────────────────────────────────


async def _read_api(db: AsyncIOMotorDatabase, user, job: dict, tmp: str, progress):
    """(tree, destination, info) read from Notion with the person's own connection; None: cancelled."""
    from app.services.notion_import import api, api_source, connect

    conn = await db[connect.CONNS].find_one({"_id": job.get("connection_id"), "user_id": user.id})
    if conn is None:
        raise export_zip.ExportError("The Notion connection was removed. Connect Notion again to import.")
    if conn.get("broken"):
        raise export_zip.ExportError("Your Notion connection stopped working. Reconnect Notion, then sync again.")
    roots = job.get("roots") or []
    d = job.get("dest") or {}
    name = d.get("folder_name") or (roots[0].get("title") if len(roots) == 1 else conn.get("workspace_name")) or "Notion"
    # Where it goes is checked again now (the person may have left the team since), before reading anything.
    dest, info = await _dest(db, user, job, name)
    known = {r["notion_id"]: r async for r in db[W.LINKS].find({"dest": dest.key})}
    since = _aware(job.get("since"))
    client = await connect.client(db, conn)
    try:
        changed = await api_source.edited_since(client, since) if since is not None else None
        b = api_source.Builder(client, tmp, known=known, changed=changed, progress=progress)
        tree = await b.build(roots, name)
    except api_source.Stop:
        return None
    except api.NotionError as exc:
        if exc.auth:
            await connect._mark_broken(db, conn["_id"])
            raise export_zip.ExportError("Notion stopped accepting Markdrop's connection. Reconnect Notion, then sync again.")
        log.info("notion api import %s: %s", job["_id"], exc)
        raise export_zip.ExportError("Notion didn't answer while reading the pages. Try again in a few minutes.")
    finally:
        await client.close()
    if not tree.nodes:
        raise export_zip.ExportError("Notion didn't return any of the chosen pages. Check that they're still "
                                     "shared with Markdrop (in Notion: ••• › Connections).")
    return tree, dest, info


def _root_summaries(w: "W.Writer", tree) -> dict:
    """Per root: its title, its link in Markdrop and the pages under it edited in Markdrop (detached)."""
    from app.services import urls

    out: dict[str, dict] = {}
    for root in tree.roots():
        ids = [root.notion_id]
        stack = [root.notion_id]
        while stack:
            for ch in tree.children(stack.pop()):
                ids.append(ch.notion_id)
                stack.append(ch.notion_id)
        detached = []
        for nid in ids:
            link = w.links.get(nid) or {}
            if link.get("detached") and link.get("slug"):
                detached.append({"title": (tree.nodes[nid].title or "Untitled")[:200], "slug": link["slug"],
                                 "url": urls.markdrop_url(link["slug"])})
        link = w.links.get(root.notion_id) or {}
        url = urls.markdrop_url(link["slug"]) if link.get("slug") else (
            f"/w/{w.dest.workspace_id}/f/{link['folder_id']}" if link.get("folder_id") and w.dest.workspace_id else None)
        out[root.notion_id] = {"title": root.title, "url": url, "detached": detached[:50]}
    return out


async def _after_sync(db: AsyncIOMotorDatabase, job: dict, **kw) -> None:
    from app.services.notion_import import sync as S

    try:
        await S.after_run(db, job, **kw)
    except Exception:
        log.warning("notion sync bookkeeping for %s failed", job.get("_id"), exc_info=True)
