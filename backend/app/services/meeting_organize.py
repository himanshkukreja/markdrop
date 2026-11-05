""""Organize meetings" as a background job (workspace admins; .work/meetings/ORGANIZE-FIX.md).

    GET  /api/v1/meetings/organize?workspace=   {preview, job}: what a run would do, and the current / last run
    POST /api/v1/meetings/organize              {workspace} → 202 {job}: starts a run, or joins the running one
    GET  /api/v1/meetings/organize/{run}        the run's progress {done, total, filed, folders, series, covers, errors}

Every meeting in the workspace gets its series (a name seen on two or more days, unless a person set
or cleared it: meeting_series) and its page moves into ``Meetings/<Series>`` or ``Meetings/Other
meetings`` (meeting_place.place_meeting), with the series' cover; transcripts are hidden from
listings (they are their meeting page's sub-page).

Until 2026-11-05 this ran inside the request and, with ~80 meetings, outlived nginx's 60 s (each
move waited on the frontend purge). Now:

* **One run per workspace.** The job is one document per workspace (``_id`` = the workspace id,
  ``run`` = this run's id). Starting is atomic: a second click while a run is going joins it.
* **Resumable.** A meeting is done in this run once its row has ``organize_run == run``; the job
  holds a lease (renewed per meeting) and whoever finds it running with a lapsed lease — the next
  status poll, the next click, or the background loop (services/background.py "meetings_backfill")
  — carries on from the meetings not done yet. Every step is idempotent (place_meeting finds the
  series' folder by its key), so a meeting caught half way is simply done again.
* **Cheap moves.** Meetings go in batches of :data:`BATCH` inside one ``revalidate.batch`` (the
  purges of a whole batch are sent once, not one bounded wait per page) and ``notifications.quiet``.
* **No duplicate folders.** Runs that overlapped before this fix could each make a series folder;
  the finish step removes the empty extra ``Meetings/<Series>`` folders (never one with anything in it).
"""

from __future__ import annotations

import asyncio
import logging
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.services import access
from app.services import meeting_backfill_detect as det

log = logging.getLogger("markdrop.meeting_organize")

JOBS = "meeting_organize_jobs"
COLL = "meetings"
BATCH = 20
LEASE = timedelta(seconds=90)
MAX_ROWS = 5000
MAX_CRASHES = 3
SAMPLES = 5
COUNTERS = ("done", "filed", "series_set", "covers", "errors")

_tasks: dict[str, asyncio.Task] = {}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _holder() -> str:
    from app.services import background

    return background.HOLDER


# ── The plan (shared by the preview and the run) ─────────────────────────────


async def _rows(db: AsyncIOMotorDatabase, workspace_id: str, query: dict | None = None, *,
                limit: int = MAX_ROWS) -> list[dict]:
    return await db[COLL].find({"workspace_id": workspace_id, **(query or {})}, {"segments": 0}) \
        .sort([("date", 1), ("_id", 1)]).to_list(length=limit)


def plan_of(rows: list[dict]) -> dict[str, str]:
    """{series key: the series every meeting of that name joins} — the name most of them already
    have, else (a name seen on two or more different days) the name without its numbers."""
    from app.services import meeting_series

    by_key: dict[str, list[dict]] = {}
    for r in rows:
        by_key.setdefault(meeting_series.key_of(r), []).append(r)
    out: dict[str, str] = {}
    for key, rs in by_key.items():
        have = Counter(r["series"] for r in rs if r.get("series"))
        if have:
            out[key] = have.most_common(1)[0][0]
        elif key and len({r.get("date") for r in rs if r.get("date")}) >= 2:
            name = det.pick_label(det.series_label(r.get("title")) for r in rs)
            if name:
                out[key] = name
    return out


def wanted_series(row: dict, plan: dict[str, str]) -> str | None:
    """The series the meeting ends up in: the group's, unless a person chose (or cleared) it."""
    from app.services import meeting_series

    name = plan.get(meeting_series.key_of(row))
    if name and row.get("series") != name and row.get("series_from") != "user":
        return name
    return row.get("series") or None


async def preview(db: AsyncIOMotorDatabase, workspace_id: str) -> dict:
    """What a run would do now: N meetings → M series folders + Other meetings, how many move, how
    many get a series, how many transcripts get hidden. Read-only."""
    rows = await _rows(db, workspace_id)
    plan = plan_of(rows)
    root = await db["folders"].find_one({"workspace_id": workspace_id, "meetings": True}, sort=[("created_at", 1)])
    have: dict[str, str] = {}
    other = None
    if root is not None:
        async for f in db["folders"].find({"workspace_id": workspace_id, "parent_id": str(root["_id"]),
                                           "meetings_sub": True}, sort=[("created_at", 1), ("_id", 1)]):
            if f.get("meetings_other"):
                other = other or str(f["_id"])
            elif f.get("meetings_series"):
                have.setdefault(f["meetings_series"], str(f["_id"]))
    series: Counter = Counter()
    to_move = series_set = in_other = 0
    for r in rows:
        name = wanted_series(r, plan)
        if name:
            series[name] += 1
            if name != r.get("series"):
                series_set += 1
        else:
            in_other += 1
        target = have.get(name.casefold()) if name else other
        if target is None or target != r.get("folder_id"):
            to_move += 1
    hidden = await db["documents"].count_documents({"workspace_id": workspace_id, "meeting_role": "transcript",
                                                    "hidden_in_listings": {"$ne": True}})
    return {"meetings": len(rows), "series": len(series), "other": in_other, "to_move": to_move,
            "series_set": series_set, "transcripts_to_hide": hidden,
            "series_names": [{"name": n, "count": c}
                             for n, c in sorted(series.items(), key=lambda x: (-x[1], x[0].casefold()))[:12]]}


# ── Starting, joining, reading ───────────────────────────────────────────────


def view(job: dict | None) -> dict | None:
    if job is None:
        return None
    c = {k: int(job.get(k) or 0) for k in COUNTERS}
    total = max(int(job.get("total") or 0), c["done"])
    return {"id": job.get("run"), "workspace": job["_id"], "state": job.get("state"), "phase": job.get("phase"),
            "total": total, **c, "moved": c["filed"], "meetings": total,
            "folders": int(job.get("folders") or 0), "series": int(job.get("series") or 0),
            "transcripts_hidden": int(job.get("transcripts_hidden") or 0),
            "duplicates_removed": int(job.get("duplicates_removed") or 0),
            "error_samples": list(job.get("error_samples") or [])[-SAMPLES:],
            "message": job.get("message"),
            "started_at": _iso(job.get("started_at")), "done_at": _iso(job.get("done_at"))}


def _iso(dt: datetime | None) -> str | None:
    dt = _aware(dt)
    return dt.isoformat() if dt else None


async def require_admin(db: AsyncIOMotorDatabase, workspace_id: str, user) -> None:
    from app.services import meetings

    if not await meetings.is_ws_admin(db, workspace_id, user.id):
        raise HTTPException(status_code=403, detail="Only workspace admins can organize the meetings.")


async def start(db: AsyncIOMotorDatabase, workspace_id: str, user) -> dict:
    """Start a run (admins), or join the one already running. Returns the job; it runs in the background."""
    await require_admin(db, workspace_id, user)
    now = now_utc()
    fresh = {"state": "running", "phase": "prepare", "run": str(ObjectId()), "user_id": user.id,
             "total": 0, **{k: 0 for k in COUNTERS}, "folders": 0, "series": 0, "transcripts_hidden": 0,
             "duplicates_removed": 0, "error_samples": [], "message": None, "plan": [], "lease": None,
             "crashes": 0, "started_at": now, "updated_at": now, "done_at": None}
    try:
        job = await db[JOBS].find_one_and_update({"_id": workspace_id, "state": {"$ne": "running"}},
                                                 {"$set": fresh}, upsert=True, return_document=ReturnDocument.AFTER)
    except DuplicateKeyError:
        job = await db[JOBS].find_one({"_id": workspace_id})   # running: this click joins it
    job = await wake(db, job)
    return job


async def get(db: AsyncIOMotorDatabase, workspace_id: str) -> dict | None:
    """The workspace's current (or last) run; a running one nobody holds is picked up."""
    job = await db[JOBS].find_one({"_id": workspace_id})
    return await wake(db, job) if job is not None else None


async def get_run(db: AsyncIOMotorDatabase, run: str) -> dict | None:
    job = await db[JOBS].find_one({"run": run})
    return await wake(db, job) if job is not None else None


def kick(db: AsyncIOMotorDatabase, job: dict | None) -> None:
    """Run the job in this process (unless it already runs here)."""
    if job is None or job.get("state") != "running":
        return
    ws = job["_id"]
    t = _tasks.get(ws)
    if t is not None and not t.done():
        return
    task = asyncio.get_running_loop().create_task(run(db, ws))
    _tasks[ws] = task
    task.add_done_callback(lambda _t, k=ws: _tasks.pop(k, None) if _tasks.get(k) is _t else None)


async def wake(db: AsyncIOMotorDatabase, job: dict | None) -> dict | None:
    if job is None or job.get("state") != "running":
        return job
    lease = job.get("lease") or {}
    until = _aware(lease.get("until"))
    if until is None or until <= now_utc() or lease.get("holder") == _holder():
        kick(db, job)
    return job


async def wait(db: AsyncIOMotorDatabase, workspace_id: str, run_id: str, timeout: float) -> dict | None:
    """The job once this run has finished, or as it is after ``timeout`` seconds."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        job = await db[JOBS].find_one({"_id": workspace_id})
        left = deadline - loop.time()
        if job is None or job.get("run") != run_id or job.get("state") != "running" or left <= 0:
            return job
        await wake(db, job)
        t = _tasks.get(workspace_id)
        if t is not None and not t.done():
            await asyncio.wait({t}, timeout=min(left, 5.0))
        else:
            await asyncio.sleep(min(left, 0.5))   # another process runs it


async def background(db: AsyncIOMotorDatabase) -> None:
    """The loop's pass: running jobs a stopped process left behind carry on here."""
    now = now_utc()
    async for j in db[JOBS].find({"state": "running", "$or": [{"lease": None}, {"lease.until": {"$lt": now}}]}).limit(20):
        await wake(db, j)


# ── Running ──────────────────────────────────────────────────────────────────


async def _claim(db: AsyncIOMotorDatabase, workspace_id: str) -> dict | None:
    now = now_utc()
    return await db[JOBS].find_one_and_update(
        {"_id": workspace_id, "state": "running",
         "$or": [{"lease": None}, {"lease.until": {"$lt": now}}, {"lease.holder": _holder()}]},
        {"$set": {"lease": {"holder": _holder(), "until": now + LEASE}}}, return_document=ReturnDocument.AFTER)


async def _release(db: AsyncIOMotorDatabase, workspace_id: str) -> None:
    await db[JOBS].update_one({"_id": workspace_id, "lease.holder": _holder()}, {"$set": {"lease": None}})


async def run(db: AsyncIOMotorDatabase, workspace_id: str) -> str:
    """Carry the workspace's running job to its end (while this process holds it). Returns its state."""
    job = await _claim(db, workspace_id)
    if job is None:
        return "busy"
    run_id = job["run"]
    try:
        user = await _admin(db, job)
        if user is None:
            await _end(db, workspace_id, run_id, "failed",
                       "Whoever started it is no longer an admin of this workspace. Start it again.")
            return "failed"
        if job.get("phase") == "prepare":
            job = await _prepare(db, job, user)
        while True:
            n = await _batch(db, job, user)
            if n == 0:
                break
        await _finish(db, job)
        return "done"
    except asyncio.CancelledError:
        raise
    except Exception:
        log.warning("meetings: organize run %s of %s stopped", run_id, workspace_id, exc_info=True)
        after = await db[JOBS].find_one_and_update({"_id": workspace_id, "run": run_id}, {"$inc": {"crashes": 1}},
                                                   return_document=ReturnDocument.AFTER)
        if after is not None and int(after.get("crashes") or 0) >= MAX_CRASHES:
            await _end(db, workspace_id, run_id, "failed", "Something went wrong while organizing. Try again.")
            return "failed"
        return "running"   # the lease lapses; the next poll or the background loop carries on
    finally:
        await _release(db, workspace_id)


async def _admin(db: AsyncIOMotorDatabase, job: dict):
    from app.services import meetings
    from app.services import user as user_service

    user = await user_service.get_user_by_id(db, job.get("user_id"))
    if user is None or not await meetings.is_ws_admin(db, job["_id"], user.id):
        return None
    return user


async def _prepare(db: AsyncIOMotorDatabase, job: dict, user) -> dict:
    """The Meetings folder (with its Series property), transcripts out of listings, the plan, the total."""
    from app.services import meeting_series, meetings

    ws = job["_id"]
    root = await meetings.ensure_folder(db, ws, user.id)
    await meeting_series.organise_folder(db, root, user.id)
    hid = await db["documents"].update_many({"workspace_id": ws, "meeting_role": "transcript",
                                             "hidden_in_listings": {"$ne": True}}, {"$set": {"hidden_in_listings": True}})
    rows = await _rows(db, ws)
    plan = plan_of(rows)
    return await db[JOBS].find_one_and_update(
        {"_id": ws, "run": job["run"]},
        {"$set": {"phase": "files", "plan": [[k, v] for k, v in plan.items()], "total": len(rows),
                  "transcripts_hidden": int(hid.modified_count or 0), "updated_at": now_utc(),
                  "lease.until": now_utc() + LEASE}},
        return_document=ReturnDocument.AFTER) or job


async def _batch(db: AsyncIOMotorDatabase, job: dict, user) -> int:
    """The next :data:`BATCH` meetings not done in this run. Returns how many."""
    from app.services import notifications, revalidate

    ws, run_id = job["_id"], job["run"]
    plan = {k: v for k, v in job.get("plan") or []}
    rows = await _rows(db, ws, {"organize_run": {"$ne": run_id}}, limit=BATCH)
    if not rows:
        return 0
    actor, ctx = access.Actor.of(user), access.Ctx(db)
    async with revalidate.batch(db):
        with notifications.quiet():
            for r in rows:
                cur = await db[JOBS].find_one({"_id": ws}, {"run": 1, "state": 1})
                if cur is None or cur.get("run") != run_id or cur.get("state") != "running":
                    return 0
                inc: dict[str, int] = {"done": 1}
                push: dict | None = None
                try:
                    got = await _one(db, ws, r, plan, actor, ctx)
                    for k in ("filed", "series_set", "covers"):
                        if got.get(k):
                            inc[k] = got[k]
                except Exception as exc:   # one meeting never stops the rest
                    log.warning("meetings: %s not organized", r.get("_id"), exc_info=True)
                    inc["errors"] = 1
                    detail = getattr(exc, "detail", None)
                    push = {"title": (r.get("title") or "Untitled meeting")[:120],
                            "error": (detail if isinstance(detail, str) else "Something went wrong.")[:200]}
                await db[COLL].update_one({"_id": r["_id"]}, {"$set": {"organize_run": run_id}})
                upd: dict[str, Any] = {"$inc": inc, "$set": {"updated_at": now_utc(), "lease.until": now_utc() + LEASE}}
                if push:
                    upd["$push"] = {"error_samples": {"$each": [push], "$slice": -SAMPLES}}
                await db[JOBS].update_one({"_id": ws, "run": run_id}, upd)
    return len(rows)


async def _one(db: AsyncIOMotorDatabase, ws: str, r: dict, plan: dict[str, str], actor, ctx) -> dict:
    """One meeting: its series, its folder, its cover. {filed, series_set, covers} as 0/1."""
    from app.services import meeting_place, meeting_series, meetings

    before, cover_before = r.get("folder_id"), r.get("cover")
    name = wanted_series(r, plan)
    named = 0
    if name and r.get("series") != name:
        # set_series also moves the page into the series' folder and sets the series' cover.
        raw = await db["documents"].find_one({"_id": meetings.oid(r.get("doc_id"))}) if r.get("doc_id") else None
        r = await meeting_series.set_series(db, r, raw, name, actor, ctx, source="auto", check=False) or r
        named = 1
    else:
        await meeting_place.place_meeting(db, ws, r)
        r = await db[COLL].find_one({"_id": r["_id"]}) or r
        await meetings.refresh_cover(db, r)
    r = await db[COLL].find_one({"_id": r["_id"]}, {"folder_id": 1, "cover": 1, "v2": 1}) or r
    if not r.get("v2"):
        await db[COLL].update_one({"_id": r["_id"]}, {"$set": {"v2": True}})
    return {"filed": int(before != r.get("folder_id")), "series_set": named,
            "covers": int(r.get("cover") != cover_before)}


async def _finish(db: AsyncIOMotorDatabase, job: dict) -> None:
    from app.services import revalidate

    ws = job["_id"]
    removed = await _drop_empty_duplicates(db, ws)
    folders: set[str] = set()
    names: set[str] = set()
    async for r in db[COLL].find({"workspace_id": ws}, {"folder_id": 1, "series": 1}):
        if r.get("folder_id"):
            folders.add(r["folder_id"])
        if r.get("series"):
            names.add(r["series"])
    try:
        await revalidate.enqueue(db, tags=[f"wsl:{ws}"])   # the folder listings, once more at the end
    except Exception:
        log.warning("meetings: listing purge after organize failed", exc_info=True)
    await _end(db, ws, job["run"], "done", None,
               folders=len(folders), series=len(names), duplicates_removed=removed)


async def _end(db: AsyncIOMotorDatabase, ws: str, run_id: str, state: str, message: str | None, **sets) -> None:
    now = now_utc()
    await db[JOBS].update_one({"_id": ws, "run": run_id}, {"$set": {
        "state": state, "phase": "done", "message": message, "done_at": now, "updated_at": now, "plan": [], **sets}})


async def _drop_empty_duplicates(db: AsyncIOMotorDatabase, ws: str) -> int:
    """Extra Meetings/<Series> (or Other meetings) folders of one series with nothing in them: the
    first one made is the series' folder (meeting_series.target_folder); the others go."""
    from app.services import folder as folder_service

    root = await db["folders"].find_one({"workspace_id": ws, "meetings": True}, sort=[("created_at", 1)])
    if root is None:
        return 0
    seen: set[str] = set()
    n = 0
    async for f in db["folders"].find({"workspace_id": ws, "parent_id": str(root["_id"]), "meetings_sub": True},
                                      sort=[("created_at", 1), ("_id", 1)]):
        key = "\x00other" if f.get("meetings_other") else (f.get("meetings_series") or "")
        if not key:
            continue
        if key not in seen:
            seen.add(key)
            continue
        fid = str(f["_id"])
        if await db["documents"].count_documents({"folder_id": fid}, limit=1) or \
                await db["folders"].count_documents({"parent_id": fid}, limit=1):
            continue
        try:
            await folder_service.delete_folder(db, ws, fid)
            n += 1
        except HTTPException as exc:
            log.info("meetings: duplicate folder %s kept (%s)", fid, exc.detail)
    return n
