"""Keep in sync: one-way Notion → Markdrop, per imported root (a page or database picked in Connect Notion).

Every import from Notion's API records one ``notion_syncs`` row per root it imported: whose it is, the
connection, the root, where it went (the destination, made concrete after the first run: the folder the
import made), and whether to keep it in sync. A kept root is imported again about every
``settings.notion_sync_minutes`` (the background loop ``notion_sync`` queues an ordinary import job,
``source: "api"``, that the ``notion_import`` loop runs), and on "Sync now".

* Only what changed is read: a scheduled run asks Notion's search what was edited since the last run;
  "Sync now" and one run a day read every page's ``last_edited_time`` instead (search can lag).
* Never overwritten: a page edited in Markdrop since the last sync is kept as it is and stops syncing
  ("detached"; listed on the sync as "Edited in Markdrop").
* Paused, not failed over and over: when the connection breaks (``paused: connection``, resumed by
  reconnecting) or the person can no longer add to the destination (``paused: access``: they left the
  team or workspace, or it was archived).
* Disconnecting Notion deletes the connection's syncs; the imported pages stay.

{_id: ns_…, user_id, connection_id, root_id, root_kind, root_title, dest, keep, paused, next_at,
 last_synced_at, last_full_at, last_job_id, last_state, last_error, last_counts, detached [{title, slug}],
 exclude [notion id] (left out in the picker), created_at}
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings

log = logging.getLogger("markdrop.notion")

COLL = "notion_syncs"
FULL_EVERY = timedelta(hours=24)
MARGIN = timedelta(minutes=10)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: Any) -> datetime | None:
    if not isinstance(dt, datetime):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _iso(dt: Any) -> str | None:
    dt = _aware(dt)
    return dt.isoformat() if dt else None


def every() -> timedelta:
    return timedelta(minutes=max(5, int(get_settings().notion_sync_minutes or 15)))


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index([("user_id", 1), ("created_at", 1)])
    await db[COLL].create_index([("keep", 1), ("paused", 1), ("next_at", 1)])
    await db[COLL].create_index("connection_id")


def sync_id(user_id: str, connection_id: str, root_id: str, dest: dict) -> str:
    where = json.dumps({k: dest.get(k) for k in ("workspace_id", "team_id", "parent_folder_id", "new_folder",
                                                 "folder_name")}, sort_keys=True)
    return "ns_" + hashlib.sha256(f"{user_id}|{connection_id}|{root_id}|{where}".encode()).hexdigest()[:20]


def out(row: dict, job: dict | None = None) -> dict:
    d = row.get("dest") or {}
    running = bool(job and job.get("state") in ("queued", "running"))
    return {
        "id": row["_id"], "connection_id": row.get("connection_id"), "root_id": row.get("root_id"),
        "root_kind": row.get("root_kind"), "title": row.get("root_title"), "keep_in_sync": bool(row.get("keep")),
        "paused": row.get("paused"),
        "destination": {"kind": d.get("kind", "personal"), "workspace_id": d.get("workspace_id"),
                        "workspace_name": d.get("workspace_name"), "team_id": d.get("team_id"),
                        "team_name": d.get("team_name"), "folder_id": d.get("parent_folder_id"),
                        "folder_name": d.get("folder_name")},
        "url": row.get("url"),
        "state": "syncing" if running else (row.get("last_state") or "never"),
        "last_synced_at": _iso(row.get("last_synced_at")), "next_at": _iso(row.get("next_at")) if row.get("keep") else None,
        "last_error": row.get("last_error"), "last_job_id": row.get("last_job_id"),
        "counts": row.get("last_counts") or {},
        "edited_in_markdrop": row.get("detached") or [],
        "left_out": len(row.get("exclude") or []),
    }


async def list_for(db: AsyncIOMotorDatabase, user) -> list[dict]:
    from app.services.notion_import import jobs

    rows = await db[COLL].find({"user_id": user.id}).sort("created_at", 1).to_list(length=200)
    ids = [r.get("last_job_id") for r in rows if r.get("last_job_id")]
    by = {j["_id"]: j async for j in db[jobs.COLL].find({"_id": {"$in": ids}}, {"state": 1})} if ids else {}
    return [out(r, by.get(r.get("last_job_id"))) for r in rows]


async def _own(db: AsyncIOMotorDatabase, user, sid: str) -> dict:
    row = await db[COLL].find_one({"_id": str(sid), "user_id": user.id})
    if row is None:
        raise HTTPException(status_code=404, detail="That Notion sync wasn't found.")
    return row


async def record(db: AsyncIOMotorDatabase, user, *, connection_id: str, roots: list[dict], dest: dict, keep: bool,
                 job_id: str, exclude: list[str] | None = None) -> list[str]:
    """One sync row per imported root (found again when the same root goes to the same place). ``exclude``:
    what was left out in the picker; every later sync leaves it out too (new pages added in Notion still
    come: it's a list of what to leave out, not of what to bring)."""
    ids = []
    now = now_utc()
    for r in roots:
        sid = sync_id(user.id, connection_id, r["id"], dest)
        await db[COLL].update_one({"_id": sid}, {
            "$set": {"user_id": user.id, "connection_id": connection_id, "root_id": r["id"],
                     "root_kind": r.get("kind") or "page", "root_title": r.get("title") or "Untitled",
                     "keep": bool(keep), "paused": None, "last_job_id": job_id, "next_at": now + every(),
                     "exclude": list(exclude or [])},
            "$setOnInsert": {"dest": dest, "created_at": now}}, upsert=True)
        ids.append(sid)
    return ids


async def after_run(db: AsyncIOMotorDatabase, job: dict, *, state: str, error: str | None = None,
                    status: int | None = None, info: dict | None = None, roots: dict | None = None,
                    counts: dict | None = None, full: bool = False) -> None:
    """A job of these syncs ended: where it went, when, what it did, and when to look again."""
    now = now_utc()
    for sid in job.get("sync_ids") or []:
        row = await db[COLL].find_one({"_id": sid})
        if row is None:
            continue
        sets: dict[str, Any] = {"last_state": state, "last_error": error, "next_at": now + every()}
        if counts is not None:
            sets["last_counts"] = counts
        if state == "done":
            started = _aware(job.get("started_at")) or _aware(job.get("created_at")) or now
            sets["last_synced_at"] = started
            if full:
                sets["last_full_at"] = started
            if info is not None:
                d = dict(row.get("dest") or {})
                if d.get("workspace_id") and info.get("folder_id"):
                    d.update(parent_folder_id=info["folder_id"], new_folder=False)
                    if info.get("folder_name"):
                        d["folder_name"] = info["folder_name"]
                sets["dest"] = d
            got = (roots or {}).get(row["root_id"])
            if got:
                sets["detached"] = got.get("detached") or []
                if got.get("url"):
                    sets["url"] = got["url"]
                if got.get("title"):
                    sets["root_title"] = got["title"]
            elif roots is not None:
                sets["last_error"] = "Notion didn't return this page: it may have been deleted or unshared."
        elif status in (403, 404):
            sets["paused"] = "access"
        await db[COLL].update_one({"_id": sid}, {"$set": sets})


async def _queue(db: AsyncIOMotorDatabase, row: dict, *, full: bool) -> dict:
    from app.services.notion_import import jobs

    last = _aware(row.get("last_synced_at"))
    last_full = _aware(row.get("last_full_at"))
    since = None
    if not full and last is not None and last_full is not None and now_utc() - last_full < FULL_EVERY:
        since = last - MARGIN
    job = await jobs.queue_sync(db, row, since=since)
    await db[COLL].update_one({"_id": row["_id"]}, {"$set": {"last_job_id": job["_id"], "next_at": now_utc() + every()}})
    return job


async def _active(db: AsyncIOMotorDatabase, row: dict) -> dict | None:
    from app.services.notion_import import jobs

    if not row.get("last_job_id"):
        return None
    return await db[jobs.COLL].find_one({"_id": row["last_job_id"], "state": {"$in": ["queued", "running"]}})


async def run_now(db: AsyncIOMotorDatabase, user, sid: str) -> dict:
    """Sync now (reads every page's last edit, so nothing is missed). Running already: that run."""
    from app.services.notion_import import connect, jobs

    row = await _own(db, user, sid)
    conn = await db[connect.CONNS].find_one({"_id": row["connection_id"], "user_id": user.id})
    if conn is None:
        raise HTTPException(status_code=409, detail="Its Notion connection was removed. Connect Notion again.")
    if conn.get("broken"):
        raise HTTPException(status_code=409, detail="Your Notion connection stopped working. Reconnect Notion.")
    job = await _active(db, row)
    if job is None:
        if row.get("paused") == "access":
            await db[COLL].update_one({"_id": sid}, {"$set": {"paused": None}})
        job = await _queue(db, row, full=True)
        jobs.kick(db)
    return job


async def set_keep(db: AsyncIOMotorDatabase, user, sid: str, keep: bool) -> dict:
    row = await _own(db, user, sid)
    sets: dict[str, Any] = {"keep": bool(keep)}
    if keep:
        sets["paused"] = None if row.get("paused") == "access" else row.get("paused")
        sets["next_at"] = now_utc()
    await db[COLL].update_one({"_id": sid}, {"$set": sets})
    return (await list_one(db, user, sid))


async def list_one(db: AsyncIOMotorDatabase, user, sid: str) -> dict:
    from app.services.notion_import import jobs

    row = await _own(db, user, sid)
    job = await db[jobs.COLL].find_one({"_id": row.get("last_job_id")}, {"state": 1}) if row.get("last_job_id") else None
    return out(row, job)


async def remove(db: AsyncIOMotorDatabase, user, sid: str) -> None:
    """Stop following this root (the imported pages stay)."""
    await _own(db, user, sid)
    await db[COLL].delete_one({"_id": sid, "user_id": user.id})


async def tick(db: AsyncIOMotorDatabase) -> int:
    """Queue the kept roots that are due (at most 20 a minute; one run per root at a time)."""
    from app.services.notion_import import connect

    if not connect.configured():
        return 0
    n = 0
    async for row in db[COLL].find({"keep": True, "paused": None, "next_at": {"$lte": now_utc()}}).sort(
            "next_at", 1).limit(20):
        if await _active(db, row) is not None:
            continue
        conn = await db[connect.CONNS].find_one({"_id": row["connection_id"]}, {"broken": 1})
        if conn is None:
            await db[COLL].delete_one({"_id": row["_id"]})
            continue
        if conn.get("broken"):
            await db[COLL].update_one({"_id": row["_id"]}, {"$set": {"paused": "connection"}})
            continue
        await _queue(db, row, full=False)
        n += 1
    return n
