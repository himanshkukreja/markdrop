"""Meetings, imported automatically: "Connect Google Meet" (a Google Apps Script in the user's own
Google account; .work/meetings/AUTO.md).

    GET    /api/v1/meetings/connection?workspace=    mine (and who else sends meetings to that workspace)
    POST   /api/v1/meetings/connection               {workspace, restricted} → the token (once), the script
    DELETE /api/v1/meetings/connection               Disconnect: the token is revoked, the script stops
    POST   /api/v1/meetings/inbox                    the script's deliveries (Bearer: that token only)

**The connection is a scoped API token** (services/api_token.py): ``scope: "meetings:import"``,
pinned to one workspace (where the meetings land: its Meetings folder), with its counters on the
record. A scoped token can't do anything else: every general auth path refuses it. One per person:
connecting again replaces it (the old script gets a 401 and unschedules itself).

**The inbox** is idempotent on (workspace, Drive file id): ``meeting_inbox`` rows go
processing → imported | attached | duplicate | ignored (failed ones are retried by the next run).
It feeds the import pipeline (services/meetings.py ``import_meetings(dedupe="all")``): a Doc
already in the workspace (a manual Picker import of that file, or the same call by name, date and
time with that half) is a duplicate; the other half of a call that is already here (Google's notes
after the transcript, or the other way round, in another run or from another person's script)
is attached to it. The import runs as the token's owner, who must still be a member: their
Meetings AI limits, their mentions, their page.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.services import api_token, meetings
from app.services import meeting_parse as mp

log = logging.getLogger("markdrop.meetings_inbox")

SCOPE = "meetings:import"
COLL = "meeting_inbox"
SOURCE = "google-meet-script"
MAX_BODY_BYTES = 6_000_000          # a long call's text, UTF-8 (nginx allows 12 MB)
MAX_TEXT_CHARS = meetings.MAX_PASTE_CHARS
PROCESSING_STALE = timedelta(minutes=5)
DONE = ("imported", "attached", "duplicate", "ignored")
_DIR = Path(__file__).parent / "meeting_script"
_FILE_ID = re.compile(r"^[A-Za-z0-9_-]{10,200}$")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index([("workspace_id", 1), ("file_id", 1)], unique=True)
    await db[COLL].create_index("token_id")
    await db["api_tokens"].create_index([("scope", 1), ("workspace_id", 1)], sparse=True)


def token_key(raw: str) -> str:
    """What the inbox's rate limit counts by: the token (Apps Script calls share Google's addresses)."""
    return "mtg-inbox:" + hashlib.sha256((raw or "").encode()).hexdigest()[:32]


# ── The script ────────────────────────────────────────────────────────────────


def endpoint() -> str:
    return get_settings().api_base_url.rstrip("/") + "/api/v1/meetings/inbox"


BACKFILL_CHOICES = (0, 7, 30, 90)


def script_version() -> int:
    """The version of the script Markdrop hands out now (``var SCRIPT_VERSION = n;`` in Code.gs). A
    connection whose script reports less (or never reports: v1) is told to get the new one."""
    m = re.search(r"var SCRIPT_VERSION = (\d+);", (_DIR / "Code.gs").read_text())
    return int(m.group(1)) if m else 1


def script(token: str, workspace_name: str, *, url: str | None = None, backfill_days: int = 0,
           include_shared: bool = True) -> str:
    """Code.gs with the endpoint and token filled in (JSON string literals: always valid JS), how
    many days of past meetings ``setup`` brings in once (0: none), and whether it also sends the
    meetings shared with this person (organized by someone else: they live in that person's Drive)."""
    name = re.sub(r"[\r\n  ]+", " ", workspace_name or "your workspace").replace("*/", "* /")[:80]
    src = (_DIR / "Code.gs").read_text()
    return (src.replace("'{{ENDPOINT}}'", json.dumps(url or endpoint()))
               .replace("'{{TOKEN}}'", json.dumps(token))
               .replace("'{{BACKFILL_DAYS}}'", str(int(backfill_days) if int(backfill_days) in BACKFILL_CHOICES else 0))
               .replace("'{{INCLUDE_SHARED}}'", "true" if include_shared else "false")
               .replace("{{WORKSPACE_NAME}}", name))


def manifest() -> str:
    """appsscript.json: read-only Drive, calling Markdrop, scheduling itself; the Docs service (tabs)."""
    return (_DIR / "appsscript.json").read_text()


# ── Connections ───────────────────────────────────────────────────────────────


async def mine(db: AsyncIOMotorDatabase, user_id: str) -> dict | None:
    return await db["api_tokens"].find_one({"user_id": user_id, "scope": SCOPE}, sort=[("created_at", -1)])


async def connect(db: AsyncIOMotorDatabase, user, workspace_id: str, *, restricted: bool = False,
                  tz: str | None = None, include_shared: bool = True) -> tuple[str, dict]:
    """A new connection (and token) for ``user`` into ``workspace_id``; an earlier one is revoked."""
    from app.services import workspace as ws_service

    await meetings.require_member(db, workspace_id, user.id)
    await ws_service.assert_open(db, workspace_id)
    ws = await ws_service.get_workspace(db, workspace_id)
    await db["api_tokens"].delete_many({"user_id": user.id, "scope": SCOPE})
    raw, rec = await api_token.create_token(
        db, user.id, f"Google Meet → {getattr(ws, 'name', None) or 'Meetings'}"[:80], scope=SCOPE,
        extra={"workspace_id": workspace_id, "restricted": bool(restricted), "provider": SOURCE, "tz": _tz(tz),
               "include_shared": bool(include_shared), "script_given": script_version(),
               "stats": {"received": 0, "imported": 0, "attached": 0, "duplicates": 0, "ignored": 0,
                         "last_received_at": None, "last_imported_at": None, "last_meeting_id": None,
                         "last_title": None, "last_error": None}})
    return raw, rec


async def disconnect(db: AsyncIOMotorDatabase, user_id: str) -> bool:
    res = await db["api_tokens"].delete_many({"user_id": user_id, "scope": SCOPE})
    return res.deleted_count > 0


def _iso(dt: datetime | None) -> str | None:
    return meetings.iso(dt)


async def view(db: AsyncIOMotorDatabase, rec: dict | None, *, viewer_id: str | None = None) -> dict | None:
    """A connection as the UI and MCP see it (never the token, never the script)."""
    if rec is None:
        return None
    from app.services import workspace as ws_service

    st = rec.get("stats") or {}
    ws = await ws_service.get_workspace(db, rec["workspace_id"])
    user = await db["users"].find_one({"_id": ObjectId(rec["user_id"])}, {"name": 1, "email": 1}) \
        if ObjectId.is_valid(rec["user_id"]) else None
    return {
        "id": str(rec["_id"]), "workspace_id": rec["workspace_id"], "workspace_name": getattr(ws, "name", None),
        "restricted": bool(rec.get("restricted")), "created_at": _iso(rec.get("created_at")),
        "connected_by": {"id": rec["user_id"], "name": (user or {}).get("name") or ((user or {}).get("email") or "").split("@")[0] or None},
        "mine": viewer_id == rec["user_id"],
        "last_received_at": _iso(st.get("last_received_at")), "last_imported_at": _iso(st.get("last_imported_at")),
        "received": int(st.get("received") or 0), "imported": int(st.get("imported") or 0),
        "attached": int(st.get("attached") or 0), "duplicates": int(st.get("duplicates") or 0),
        "ignored": int(st.get("ignored") or 0), "last_error": st.get("last_error"),
        "prefix": rec.get("prefix"),
        "include_shared": rec.get("include_shared"),
        # How the script's runs go (v2+ reports each run; v1 never does) and whether to get the new one.
        "script": _script_view(rec.get("script")),
        "script_version": _installed(rec),
        "latest_script_version": script_version(),
        "needs_update": _installed(rec) < script_version(),
    }


def _installed(rec: dict) -> int:
    """The script version this connection runs: what it last reported, else the one it was given when
    it connected (connections made before v2 were given v1, which never reports)."""
    return int((rec.get("script") or {}).get("version") or rec.get("script_given") or 1)


def _script_view(sc: dict | None) -> dict | None:
    if not sc:
        return None
    return {"version": sc.get("version"), "mode": sc.get("mode"), "started_at": _iso(sc.get("started_at")),
            "ran_at": _iso(sc.get("ran_at")), "include_shared": sc.get("include_shared"),
            "found": int(sc.get("found") or 0), "sent": int(sc.get("sent") or 0),
            "results": sc.get("results") or {}, "skipped": sc.get("skipped") or {},
            "errors": sc.get("errors") or [], "search": sc.get("search")}


async def for_workspace(db: AsyncIOMotorDatabase, workspace_id: str) -> list[dict]:
    """Everyone's connections into a workspace (who connected it, when it last imported)."""
    rows = await db["api_tokens"].find({"scope": SCOPE, "workspace_id": workspace_id}).sort("created_at", 1).to_list(length=200)
    return [await view(db, r) for r in rows]


# ── The script's runs ─────────────────────────────────────────────────────────

_SKIPS = ("already_sent", "too_old", "not_yours", "title", "writing")
_RESULTS = ("imported", "attached", "duplicate", "ignored")


def _count(v: Any) -> int:
    try:
        return max(0, min(int(v), 1_000_000))
    except (TypeError, ValueError):
        return 0


async def run_status(db: AsyncIOMotorDatabase, rec: dict, body: dict) -> dict:
    """The script says how a run went ('start': it began; 'done': counts by outcome and skip reason,
    errors). Stored on the connection (the Meetings page shows it). 'start' → the Docs asked for by
    link that this script should fetch first (Markdrop couldn't open them), and the latest version."""
    now = now_utc()
    phase = body.get("phase")
    sc: dict[str, Any] = {"version": _count(body.get("version")) or 1,
                          "mode": str(body.get("mode") or "run")[:12],
                          "include_shared": bool(body.get("include_shared"))}
    if phase == "start":
        sets = {f"script.{k}": v for k, v in sc.items()}
        sets["script.started_at"] = now
        await db["api_tokens"].update_one({"_id": rec["_id"]}, {"$set": sets})
        from app.services import meeting_links
        queue = await meeting_links.queued_for(db, rec)
        return {"ok": True, "latest_version": script_version(), "queue": queue}
    errors = []
    for e in (body.get("errors") or [])[:5]:
        if isinstance(e, dict):
            errors.append({"title": str(e.get("title") or "")[:200], "error": str(e.get("error") or "")[:300]})
    sc.update({
        "ran_at": now, "found": _count(body.get("found")), "sent": _count(body.get("sent")),
        "results": {k: _count((body.get("results") or {}).get(k)) for k in _RESULTS},
        "skipped": {k: _count((body.get("skipped") or {}).get(k)) for k in _SKIPS},
        "errors": errors, "search": str(body.get("search") or "")[:20] or None,
    })
    upd: dict[str, Any] = {"$set": {f"script.{k}": v for k, v in sc.items()}}
    await db["api_tokens"].update_one({"_id": rec["_id"]}, upd)
    from app.services import meeting_links
    await meeting_links.script_reported(db, rec, done=[str(x) for x in (body.get("queue_done") or [])[:50]],
                                        failed=[f for f in (body.get("queue_failed") or [])[:50] if isinstance(f, dict)])
    return {"ok": True, "latest_version": script_version()}


# ── The inbox ─────────────────────────────────────────────────────────────────


async def _stats(db: AsyncIOMotorDatabase, rec: dict, inc: dict[str, int], sets: dict[str, Any]) -> None:
    upd: dict[str, Any] = {}
    if inc:
        upd["$inc"] = {f"stats.{k}": v for k, v in inc.items()}
    if sets:
        upd["$set"] = {f"stats.{k}": v for k, v in sets.items()}
    if upd:
        await db["api_tokens"].update_one({"_id": rec["_id"]}, upd)


def _tz(name: str | None) -> str | None:
    """The connecting browser's time zone (a Doc without a date in its title is dated by when Google
    made it, in that zone), when it's a real one."""
    try:
        return name if name and len(name) <= 64 and ZoneInfo(name) else None
    except (ZoneInfoNotFoundError, ValueError):
        return None


def meeting_date(created: str | None, tz: str | None) -> str | None:
    """YYYY-MM-DD of the Doc's creation (an ISO time), in ``tz`` when known (else as written)."""
    raw = str(created or "").strip()
    try:
        at = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        m = re.match(r"^(\d{4}-\d{2}-\d{2})", raw)
        return m.group(1) if m else None
    if at.tzinfo is not None and tz:
        at = at.astimezone(ZoneInfo(tz))
    return at.date().isoformat()


def _owner(value: Any) -> dict | None:
    """The Doc's owner in Drive as the script saw it ({name, email, me}): who organized the call."""
    if not isinstance(value, dict):
        return None
    name = " ".join(str(value.get("name") or "").split())[:120] or None
    email = str(value.get("email") or "").strip().lower()[:320] or None
    if email and not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        email = None
    return {"name": name, "email": email, "me": value.get("me")} if (name or email) else None


def _recent(created: str | None, *, hours: int = 24) -> bool:
    raw = str(created or "").strip()
    try:
        at = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return False
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    return now_utc() - at <= timedelta(hours=hours)


def _doc_url(value: str | None, file_id: str) -> str:
    v = (value or "").strip()
    if v.startswith("https://docs.google.com/") and len(v) <= 500 and not any(c in v for c in " \"'<>\\"):
        return v
    return f"https://docs.google.com/document/d/{file_id}/edit"


async def receive(db: AsyncIOMotorDatabase, rec: dict, item: dict) -> dict:
    """One Doc from the script → {status: imported | attached | duplicate | ignored, meeting_id?, url?}.
    Raises HTTPException (403: no longer a member; 409: being imported right now; 422…)."""
    from app.services import urls, user as user_service, workspace as ws_service

    ws_id = rec["workspace_id"]
    file_id = str(item.get("file_id") or "")
    if not _FILE_ID.match(file_id):
        raise HTTPException(status_code=422, detail="file_id isn't a Google Drive file id.")
    text = str(item.get("text") or "")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(status_code=413, detail=f"That Doc is longer than {MAX_TEXT_CHARS:,} characters.")
    user = await user_service.get_user_by_id(db, rec["user_id"])
    if user is None:
        raise HTTPException(status_code=401, detail="Invalid API token")
    role = await ws_service.role_for(db, ws_id, user.id)
    from app.models.workspace import role_allows

    if role is None or not role_allows(role, "member"):
        await _stats(db, rec, {}, {"last_error": "You're no longer a member of that workspace."})
        raise HTTPException(status_code=403, detail="You're no longer a member who can import meetings into that "
                                                    "workspace. Connect Google Meet again in Markdrop.")
    await ws_service.assert_open(db, ws_id)
    now = now_utc()
    await _stats(db, rec, {"received": 1}, {"last_received_at": now})
    title = " ".join(str(item.get("title") or "").split())[:200] or "Google Doc"
    key = {"workspace_id": ws_id, "file_id": file_id}
    claim = {**key, "user_id": user.id, "token_id": str(rec["_id"]), "state": "processing", "at": now,
             "title": title, "kind_hint": item.get("kind_hint"), "created": item.get("created"), "attempts": 1,
             "owner": _owner(item.get("owner")), "requested": bool(item.get("requested")), "version": item.get("version")}
    try:
        await db[COLL].insert_one(claim)
    except DuplicateKeyError:
        ex = await db[COLL].find_one(key) or {}
        if ex.get("state") in DONE:
            await _stats(db, rec, {"duplicates": 1}, {})
            if item.get("requested"):
                from app.services import meeting_links

                await meeting_links.mark_sent(db, rec, file_id, meeting_id=ex.get("meeting_id"), status="duplicate")
            return {"status": "duplicate", "meeting_id": ex.get("meeting_id")}
        at = ex.get("at")
        if at is not None and at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        if ex.get("state") == "processing" and at is not None and now - at < PROCESSING_STALE:
            raise HTTPException(status_code=409, detail="That Doc is being imported right now.")
        got = await db[COLL].update_one({"_id": ex.get("_id"), "state": ex.get("state"), "at": ex.get("at")},
                                        {"$set": {"state": "processing", "at": now, "user_id": user.id,
                                                  "token_id": str(rec["_id"]), "title": title},
                                         "$inc": {"attempts": 1}})
        if not got.modified_count:
            raise HTTPException(status_code=409, detail="That Doc is being imported right now.")

    async def finish(state: str, **extra) -> None:
        await db[COLL].update_one(key, {"$set": {"state": state, "done_at": now_utc(), **extra}})

    try:
        src = mp.parse_source(title, text)
        # The script only sends Docs titled like Meet's; a Doc that is neither Google's notes nor a transcript
        # with speakers (a shopping list called "… - Notes") is handled once and left alone.
        spoken = any(seg.get("speaker") for seg in src.segments)
        if not text.strip() or (not spoken and not src.notes):
            await finish("ignored", reason="no_meeting")
            if item.get("requested"):
                from app.services import meeting_links

                await meeting_links.mark_sent(db, rec, file_id, meeting_id=None, status="ignored")
            await _stats(db, rec, {"ignored": 1}, {})
            return {"status": "ignored", "reason": "No transcript or meeting notes found in it."}
        # The meeting's own date: from Google's title when it has one, else when the Doc was made.
        date_ = None if src.date else meeting_date(item.get("created"), rec.get("tz"))
        inc = meetings.Incoming(name=title, text=text, origin="google", file_id=file_id,
                                url=_doc_url(item.get("doc_url"), file_id), owner=_owner(item.get("owner")))
        # A past meeting sent by the script's backfill is history: nobody is notified about it. A Doc asked
        # for by link is a manual import: notified as usual unless the call is more than a day old.
        notify = not item.get("backfill")
        if item.get("requested"):
            notify = _recent(item.get("created"))
        rows = await meetings.import_meetings(db, user, ws_id, [inc], date_=date_, restricted=True if rec.get("restricted") else None,
                                              via="inbox", dedupe="all", notify=notify)
    except HTTPException as exc:
        await finish("failed", error=str(exc.detail)[:300])
        await _stats(db, rec, {}, {"last_error": str(exc.detail)[:300]})
        raise
    except Exception:
        log.warning("meetings inbox: %s failed", file_id, exc_info=True)
        await finish("failed", error="internal")
        raise
    row = rows[0]
    status = row.get("_status") or "imported"
    await finish(status, meeting_id=str(row["_id"]))
    counter = {"imported": "imported", "attached": "attached", "duplicate": "duplicates"}[status]
    sets: dict[str, Any] = {"last_error": None}
    if status != "duplicate":
        sets.update(last_imported_at=now_utc(), last_meeting_id=str(row["_id"]), last_title=row.get("title"))
    await _stats(db, rec, {counter: 1}, sets)
    if item.get("requested"):
        from app.services import meeting_links

        await meeting_links.mark_sent(db, rec, file_id, meeting_id=str(row["_id"]), status=status)
    out: dict[str, Any] = {"status": status, "meeting_id": str(row["_id"])}
    if status != "duplicate" and row.get("slug"):
        out["url"] = urls.markdrop_url(row["slug"])
    return out
