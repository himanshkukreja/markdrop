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


# ── The public export ─────────────────────────────────────────────────────────

FETCH_TIMEOUT = 15.0
MAX_HOPS = 4
MAX_BYTES = 4_000_000


def _allowed_host(host: str | None) -> bool:
    """Google's own hosts only: the Doc's, and where Google hands the file out from."""
    h = (host or "").lower().rstrip(".")
    return h in ("docs.google.com", "drive.google.com", "drive.usercontent.google.com") or h.endswith(".googleusercontent.com")


def _filename(disposition: str | None) -> str | None:
    """The file name in a Content-Disposition header (Google puts the Doc's title there)."""
    from urllib.parse import unquote

    d = disposition or ""
    m = re.search(r"filename\*\s*=\s*UTF-8''([^;]+)", d, re.I)
    if m:
        return unquote(m.group(1)).strip().strip('"') or None
    m = re.search(r'filename\s*=\s*"([^"]+)"', d) or re.search(r"filename\s*=\s*([^;]+)", d)
    return m.group(1).strip() if m else None


class NotPublic(Exception):
    """Google wants a sign-in (the file isn't shared with "anyone with the link") or it doesn't exist."""


async def fetch_public(file_id: str, *, client=None) -> tuple[str, str]:
    """(title, text) of a Doc (or a text file) shared with "anyone with the link", through Google's
    export. Only Google's hosts are followed (no other redirect), with a timeout and a size cap.
    Raises :class:`NotPublic`, or ValueError (too big, not text)."""
    import httpx

    if not _ID.match(file_id or ""):
        raise ValueError("That isn't a Google Drive file id.")
    own = client is None
    client = client or httpx.AsyncClient(timeout=FETCH_TIMEOUT, follow_redirects=False,
                                         headers={"User-Agent": "Markdrop meetings import"})
    try:
        for start in (f"https://docs.google.com/document/d/{file_id}/export?format=txt",
                      f"https://drive.google.com/uc?export=download&id={file_id}"):
            url = start
            for _hop in range(MAX_HOPS + 1):
                async with client.stream("GET", url) as r:
                    if r.status_code in (301, 302, 303, 307, 308):
                        nxt = r.headers.get("location") or ""
                        nxt = str(httpx.URL(url).join(nxt))
                        if not _allowed_host(httpx.URL(nxt).host) or not nxt.startswith("https://"):
                            break        # a sign-in page (accounts.google.com) or anything else: not public
                        url = nxt
                        continue
                    if r.status_code != 200:
                        break
                    ctype = (r.headers.get("content-type") or "").lower()
                    if "text/html" in ctype:
                        break            # a page (sign in, "can't preview"), not the file
                    if ctype and not (ctype.startswith("text/") or "subrip" in ctype or "vtt" in ctype
                                      or "octet-stream" in ctype or "json" in ctype):
                        raise ValueError("That file isn't a transcript or Google Doc Markdrop can read.")
                    size = int(r.headers.get("content-length") or 0)
                    if size > MAX_BYTES:
                        raise ValueError("That file is too big to import.")
                    buf = bytearray()
                    async for chunk in r.aiter_bytes():
                        buf.extend(chunk)
                        if len(buf) > MAX_BYTES:
                            raise ValueError("That file is too big to import.")
                    text = bytes(buf).decode("utf-8", "replace").lstrip("﻿")
                    title = _filename(r.headers.get("content-disposition")) or "Google Doc"
                    title = re.sub(r"\.(txt)$", "", title, flags=re.I)
                    return title, text
        raise NotPublic(file_id)
    except httpx.HTTPError as exc:
        # Google unreachable or too slow: treat it like a private Doc (the person's script can still fetch it).
        raise NotPublic(file_id) from exc
    finally:
        if own:
            await client.aclose()


def doc_url(file_id: str) -> str:
    return f"https://docs.google.com/document/d/{file_id}/edit"


# ── Import by link ────────────────────────────────────────────────────────────

NEEDS_ACCESS = ("Markdrop can't open that Doc: it isn't shared with \"anyone with the link\". Connect Google Meet "
                "(Markdrop then fetches it with your own Google access), share the Doc with \"anyone with the link\", "
                "or download it and upload the file.")


async def import_link(db: AsyncIOMotorDatabase, user, workspace_id: str, url: str, *, restricted: bool = False,
                      via: str = "web", wait: bool = False, client=None) -> dict:
    """One Google Docs / Drive link → {status: imported | attached | duplicate | queued | needs_access,
    url, file_id, meeting_id?, message?}. Raises HTTPException 422 for a link that isn't Google's."""
    from fastapi import HTTPException

    from app.services import meetings, meetings_inbox

    await meetings.require_member(db, workspace_id, user.id)
    fid = file_id_of(url)
    if fid is None:
        raise HTTPException(status_code=422, detail="Paste a Google Docs or Google Drive link "
                                                    "(docs.google.com/document/d/… or drive.google.com/file/d/…).")
    out: dict[str, Any] = {"url": url, "file_id": fid}
    hit = await db[meetings.COLL].find_one({"workspace_id": workspace_id, "sources.file_id": fid})
    if hit is not None:
        return {**out, "status": "duplicate", "meeting_id": str(hit["_id"]), "row": hit}
    try:
        title, text = await fetch_public(fid, client=client)
    except NotPublic:
        rec = await meetings_inbox.mine(db, user.id)
        if rec is not None and rec.get("workspace_id") == workspace_id:
            await queue(db, rec, user.id, workspace_id, fid, url=url, restricted=restricted)
            return {**out, "status": "queued",
                    "message": "Queued: your Google Meet script imports it within 15 minutes (or Run it now in Apps Script)."}
        msg = NEEDS_ACCESS
        if rec is not None:
            msg = ("Markdrop can't open that Doc, and your Google Meet script sends meetings to another workspace. "
                   "Share the Doc with \"anyone with the link\", or download it and upload the file.")
        return {**out, "status": "needs_access", "message": msg, "connected": rec is not None}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if len(text) > meetings.MAX_PASTE_CHARS:
        raise HTTPException(status_code=413, detail="That Doc is too long to import.")
    inc = meetings.Incoming(name=title, text=text, origin="google", file_id=fid, url=doc_url(fid))
    rows = await meetings.import_meetings(db, user, workspace_id, [inc], restricted=restricted, via=via,
                                          dedupe="all", wait=wait)
    row = rows[0]
    return {**out, "status": row.get("_status") or "imported", "meeting_id": str(row["_id"]), "row": row}
