"""Meetings by Google Drive link: "Paste a Google Drive link" (.work/meetings/AUTO-V2.md, part B).

A Docs / Drive link → the file id. Markdrop first tries Google's public export (a Doc shared with
"anyone with the link"). When that isn't allowed and the person's Google Meet script is connected,
the file id is queued for that script (``meeting_fetch_queue``): its next run (or a manual Run)
asks Markdrop for the queue first (POST /meetings/inbox/status, phase start), reads the Doc with the
person's own Google access, and sends it through the inbox (``requested: true``). The script then
reports which ones it sent or couldn't open.

    meeting_fetch_queue: {workspace_id, user_id, token_id, file_id, url, state: queued | sent | failed,
                          error, requested_at, done_at, meeting_id, restricted}
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import parse_qs, urlsplit

from motor.motor_asyncio import AsyncIOMotorDatabase

COLL = "meeting_fetch_queue"
QUEUE_TTL = timedelta(days=7)          # a request the script never picked up is dropped after a week
MAX_QUEUED = 50                        # per person, at once
_ID = re.compile(r"^[A-Za-z0-9_-]{20,200}$")
HOSTS = ("docs.google.com", "drive.google.com")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index([("token_id", 1), ("state", 1)])
    await db[COLL].create_index([("workspace_id", 1), ("user_id", 1), ("file_id", 1)], unique=True)


def file_id_of(url: str) -> str | None:
    """The Drive file id in a Google Docs / Drive link, or None (any other host, or no id)."""
    raw = (url or "").strip()
    if not raw or len(raw) > 2000:
        return None
    if _ID.match(raw):
        return raw
    try:
        parts = urlsplit(raw if "://" in raw else "https://" + raw)
    except ValueError:
        return None
    if parts.scheme not in ("https", "http") or (parts.hostname or "").lower() not in HOSTS:
        return None
    path = parts.path or ""
    m = re.search(r"/(?:document|file|spreadsheets|presentation)/(?:u/\d+/)?d/([A-Za-z0-9_-]+)", path)
    if m and _ID.match(m.group(1)):
        return m.group(1)
    qs = parse_qs(parts.query or "")
    for key in ("id",):
        v = (qs.get(key) or [""])[0]
        if _ID.match(v):
            return v
    return None


async def queue(db: AsyncIOMotorDatabase, rec: dict, user_id: str, workspace_id: str, file_id: str, *,
                url: str | None = None, restricted: bool = False) -> dict:
    """Ask ``rec``'s script (the person's own Google Meet connection) to fetch ``file_id``."""
    now = now_utc()
    n = await db[COLL].count_documents({"user_id": user_id, "state": "queued"})
    if n >= MAX_QUEUED:
        from fastapi import HTTPException

        raise HTTPException(status_code=429, detail=f"{MAX_QUEUED} links are already waiting for your Google Meet script.")
    await db[COLL].update_one(
        {"workspace_id": workspace_id, "user_id": user_id, "file_id": file_id},
        {"$set": {"token_id": str(rec["_id"]), "state": "queued", "url": (url or "")[:500], "requested_at": now,
                  "restricted": bool(restricted), "error": None, "done_at": None}},
        upsert=True)
    return {"status": "queued", "file_id": file_id}


async def queued_for(db: AsyncIOMotorDatabase, rec: dict) -> list[dict]:
    """What this connection's script should fetch first ([{file_id}], oldest first)."""
    since = now_utc() - QUEUE_TTL
    rows = await db[COLL].find({"token_id": str(rec["_id"]), "state": "queued", "requested_at": {"$gte": since}},
                               {"file_id": 1}).sort("requested_at", 1).to_list(length=20)
    return [{"file_id": r["file_id"]} for r in rows]


async def is_requested(db: AsyncIOMotorDatabase, rec: dict, file_id: str) -> dict | None:
    return await db[COLL].find_one({"token_id": str(rec["_id"]), "file_id": file_id})


async def mark_sent(db: AsyncIOMotorDatabase, rec: dict, file_id: str, *, meeting_id: str | None, status: str) -> None:
    await db[COLL].update_one({"token_id": str(rec["_id"]), "file_id": file_id},
                              {"$set": {"state": "sent", "done_at": now_utc(), "meeting_id": meeting_id, "result": status}})


async def script_reported(db: AsyncIOMotorDatabase, rec: dict, *, done: list[str], failed: list[dict]) -> None:
    """The script's report on the queue: ``failed`` → [{file_id, error: not_found | unreadable | not_a_doc |
    retry}] (retry: stays queued)."""
    now = now_utc()
    for f in failed:
        err = str(f.get("error") or "")[:40]
        if err == "retry":
            continue
        await db[COLL].update_one({"token_id": str(rec["_id"]), "file_id": str(f.get("file_id") or ""), "state": "queued"},
                                  {"$set": {"state": "failed", "error": err or "unreadable", "done_at": now}})
    for fid in done:
        await db[COLL].update_one({"token_id": str(rec["_id"]), "file_id": fid, "state": "queued"},
                                  {"$set": {"state": "sent", "done_at": now}})


async def requests_of(db: AsyncIOMotorDatabase, user_id: str, workspace_id: str, *, limit: int = 20) -> list[dict[str, Any]]:
    """This person's recent link requests in a workspace (the import dialog shows what's waiting)."""
    rows = await db[COLL].find({"user_id": user_id, "workspace_id": workspace_id}).sort("requested_at", -1).to_list(length=limit)
    from app.services import meetings

    return [{"file_id": r["file_id"], "url": r.get("url"), "state": r.get("state"), "error": r.get("error"),
             "requested_at": meetings.iso(r.get("requested_at")), "done_at": meetings.iso(r.get("done_at")),
             "meeting_id": r.get("meeting_id")} for r in rows]
