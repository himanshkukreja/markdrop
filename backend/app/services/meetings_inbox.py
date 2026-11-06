"""Meetings, imported automatically: "Connect Google Meet" (a Google Apps Script in the user's own
Google account; .work/meetings/AUTO.md).

    GET    /api/v1/meetings/connection?workspace=    mine (and who else sends meetings to that workspace)
    POST   /api/v1/meetings/connection               {workspace, restricted} → the token (once), the script
    DELETE /api/v1/meetings/connection               Disconnect: the token is revoked, the script stops
    POST   /api/v1/meetings/inbox                    the script's deliveries (Bearer: that token only)
    PUT    /api/v1/meetings/connection/check-now     {url} the script's web app (Check now), or null: off
    POST   /api/v1/meetings/check-now                {workspace} → runs the scripts now (check_now below)

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

import asyncio
import hashlib
import json
import logging
import re
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
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
DONE = ("imported", "attached", "duplicate", "ignored", "updated")
# A Doc with no notes or transcript in it yet (Gemini makes its notes Doc when note-taking starts and
# fills it in when the call ends): "not_ready" (the script sends it again once Google changes it) for
# this long after Google made it; after that it is ignored for good.
NOT_READY_FOR = timedelta(hours=12)
# What Gemini writes in its notes Doc before the call ends (and other placeholders): not notes yet.
_PLACEHOLDER = re.compile(
    r"gemini (?:is|will be) taking notes|taking notes (?:for|in) (?:you|this|the) |notes (?:will|are going to) be "
    r"(?:shared|available|ready|added|generated|written|sent)|notes (?:will )?appear (?:here )?(?:after|when|once)|"
    r"(?:being|been) (?:generated|written|prepared)|will be (?:available|ready|shared) (?:after|when|once)|"
    r"after the (?:meeting|call) (?:ends|is over)|in progress", re.I)
_DIR = Path(__file__).parent / "meeting_script"
_FILE_ID = re.compile(r"^[A-Za-z0-9_-]{10,200}$")
_PROJECT = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
DRIVE_API_PAGE = "https://console.developers.google.com/apis/api/drive.googleapis.com/overview"


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
    # "Get the new script" is pasted into the same Apps Script project: its web app (Check now) and the
    # key Markdrop calls it with carry over (setup hands the key to the new code on its first run).
    old = await mine(db, user.id)
    carry = {k: old[k] for k in ("check_key", "check_now") if old and old.get(k)}
    if carry.get("check_now"):
        carry["check_now"] = {"url": carry["check_now"].get("url")} if carry["check_now"].get("url") else None
    await db["api_tokens"].delete_many({"user_id": user.id, "scope": SCOPE})
    raw, rec = await api_token.create_token(
        db, user.id, f"Google Meet → {getattr(ws, 'name', None) or 'Meetings'}"[:80], scope=SCOPE,
        extra={"workspace_id": workspace_id, "restricted": bool(restricted), "provider": SOURCE, "tz": _tz(tz),
               "include_shared": bool(include_shared), "script_given": script_version(),
               "stats": {"received": 0, "imported": 0, "attached": 0, "duplicates": 0, "ignored": 0,
                         "last_received_at": None, "last_imported_at": None, "last_meeting_id": None,
                         "last_title": None, "last_error": None},
               "check_key": carry.get("check_key") or secrets.token_urlsafe(24),
               **({"check_now": carry["check_now"]} if carry.get("check_now") else {})})
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
        "ignored": int(st.get("ignored") or 0), "updated": int(st.get("updated") or 0),
        "not_ready": int(st.get("not_ready") or 0), "last_error": st.get("last_error"),
        "prefix": rec.get("prefix"),
        "include_shared": rec.get("include_shared"),
        # How the script's runs go (v2+ reports each run; v1 never does) and whether to get the new one.
        "script": _script_view(rec.get("script")),
        "script_version": _installed(rec),
        "latest_script_version": script_version(),
        "needs_update": _installed(rec) < script_version(),
        # "Check for new meetings" (the script's web app; never its address): on, and the last check.
        "check_now": _check_view(rec),
    }


def _check_view(rec: dict) -> dict:
    cn = rec.get("check_now") or {}
    return {"ready": bool(cn.get("url")), "last_at": _iso(cn.get("last_at")), "last": cn.get("last")}


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
            "errors": sc.get("errors") or [], "search": sc.get("search"),
            # v3: what waits for the next run (it sends for a time budget), and whether it searches shared
            # drives ("off": the Drive API is off in the script's own project; optional, so a hint, not an error).
            "remaining": int(sc.get("remaining") or 0), "shared_drives": sc.get("shared_drives"),
            "drive_api_url": _drive_api_url(sc) if sc.get("shared_drives") == "off" else None}


def _drive_api_url(sc: dict) -> str:
    """Google Cloud's page that turns the Drive API on for the script's project (built here, never taken
    from the script as a link)."""
    project = sc.get("drive_project")
    return f"{DRIVE_API_PAGE}?project={project}" if project else DRIVE_API_PAGE


async def for_workspace(db: AsyncIOMotorDatabase, workspace_id: str) -> list[dict]:
    """Everyone's connections into a workspace (who connected it, when it last imported)."""
    rows = await db["api_tokens"].find({"scope": SCOPE, "workspace_id": workspace_id}).sort("created_at", 1).to_list(length=200)
    return [await view(db, r) for r in rows]


# ── The script's runs ─────────────────────────────────────────────────────────

_SKIPS = ("already_sent", "too_old", "not_yours", "title", "writing", "not_ready")
_RESULTS = ("imported", "attached", "duplicate", "ignored", "updated", "not_ready")


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
    # The key "Check for new meetings" calls the script's web app with (connections made before v4 get one now).
    key = rec.get("check_key")
    if not key:
        key = secrets.token_urlsafe(24)
        await db["api_tokens"].update_one({"_id": rec["_id"]}, {"$set": {"check_key": key}})
    sc: dict[str, Any] = {"version": _count(body.get("version")) or 1,
                          "mode": str(body.get("mode") or "run")[:12],
                          "include_shared": bool(body.get("include_shared"))}
    if phase == "start":
        sets = {f"script.{k}": v for k, v in sc.items()}
        sets["script.started_at"] = now
        await db["api_tokens"].update_one({"_id": rec["_id"]}, {"$set": sets})
        from app.services import meeting_links
        queue = await meeting_links.queued_for(db, rec)
        return {"ok": True, "latest_version": script_version(), "queue": queue, "check_key": key}
    errors = []
    for e in (body.get("errors") or [])[:5]:
        if isinstance(e, dict):
            errors.append({"title": str(e.get("title") or "")[:200], "error": str(e.get("error") or "")[:300]})
    sc.update({
        "ran_at": now, "found": _count(body.get("found")), "sent": _count(body.get("sent")),
        "results": {k: _count((body.get("results") or {}).get(k)) for k in _RESULTS},
        "skipped": {k: _count((body.get("skipped") or {}).get(k)) for k in _SKIPS},
        "errors": errors, "search": str(body.get("search") or "")[:20] or None,
        "remaining": _count(body.get("remaining")),
        "shared_drives": body.get("shared_drives") if body.get("shared_drives") in ("on", "off") else None,
        "drive_project": project if _PROJECT.match(project := str(body.get("drive_project") or "").lower()) else None,
    })
    upd: dict[str, Any] = {"$set": {f"script.{k}": v for k, v in sc.items()}}
    await db["api_tokens"].update_one({"_id": rec["_id"]}, upd)
    from app.services import meeting_links
    await meeting_links.script_reported(db, rec, done=[str(x) for x in (body.get("queue_done") or [])[:50]],
                                        failed=[f for f in (body.get("queue_failed") or [])[:50] if isinstance(f, dict)])
    return {"ok": True, "latest_version": script_version(), "check_key": key}


# ── Check now: the script's web app ───────────────────────────────────────────
#
# The server can't search the person's Drive (Markdrop's Google connection is drive.file: only files
# picked in the Picker), so "Check for new meetings" asks their script to run now. The script is
# deployed once as a web app (execute as the person, access: anyone) and its URL pasted in Markdrop;
# Markdrop POSTs {key} to it (the per-connection key the script received with its status calls: anyone
# else calling the URL gets "bad_key" and nothing runs), the script runs a quick sync (the usual
# deliveries to /inbox) and answers with its counts. Google answers a web app POST with a 302 to
# script.googleusercontent.com, which is fetched with GET.

WEB_APP = re.compile(r"^https://script\.google\.com/(?:a/macros/[A-Za-z0-9.-]{1,253}/|macros/)s/[A-Za-z0-9_-]{20,200}/exec$")
CHECK_COLL = "meeting_check_now"
CHECK_GAP = timedelta(seconds=60)
# The answer must beat nginx's 60 s proxy timeout: the script sends for at most ~35 s (NOW_BUDGET_MS); past
# CHECK_DEADLINE Markdrop stops waiting (the script carries on, and its meetings arrive as it sends them).
CHECK_TIMEOUT = httpx.Timeout(50.0, connect=10.0)
CHECK_DEADLINE = 50.0
CHECK_TRANSPORT: httpx.AsyncBaseTransport | None = None   # tests: a fake script (httpx.MockTransport)
_ECHO_HOST = "script.googleusercontent.com"

CHECK_ERRORS = {
    "bad_key": "The script's web app doesn't run the new script yet. In Apps Script: Run setup once, then Deploy › "
               "Manage deployments › Edit (pencil) › Version: New version › Deploy.",
    "no_key": "The script hasn't run since it was updated. In Apps Script, Run setup once.",
    "too_soon": "It was checked less than a minute ago. Try again in a minute.",
    "busy": "The script is already checking (its regular run). New meetings arrive in a minute or two.",
    "disconnected": "The script's token was replaced. In Apps Script, paste the newest script and Run setup.",
    "failed": "The script stopped with an error. In Apps Script, open Executions to see it.",
    "sign_in": "Google asks for a sign-in before the web app runs. In Apps Script: Deploy › Manage deployments › Edit, "
               "set Who has access to Anyone and Deploy.",
    "not_script": "That address didn't answer like the Markdrop script. Check the Web app URL (Deploy › Manage "
                  "deployments) and that the deployment runs the newest script (Version: New version).",
    "unreachable": "Couldn't reach the script's web app. Check the Web app URL in Deploy › Manage deployments.",
    "timeout": "The script is still working: new meetings appear here as it sends them.",
}


def web_app_url(value: str | None) -> str | None:
    """A pasted Apps Script web app URL, when it is one (…/macros/s/<id>/exec, also a Workspace domain's
    …/a/macros/<domain>/s/<id>/exec); anything else → None (never fetched)."""
    v = (value or "").strip()
    return v if len(v) <= 400 and WEB_APP.match(v) else None


async def set_web_app(db: AsyncIOMotorDatabase, user_id: str, url: str | None) -> dict:
    """Turn Check now on (the web app's URL) or off (None) for the caller's connection."""
    rec = await mine(db, user_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="Connect Google Meet first.")
    if url is None:
        await db["api_tokens"].update_one({"_id": rec["_id"]}, {"$unset": {"check_now": 1}})
    else:
        good = web_app_url(url)
        if not good:
            raise HTTPException(status_code=422, detail="Paste the Web app URL from Apps Script: it starts with "
                                                        "https://script.google.com/ and ends with /exec.")
        await db["api_tokens"].update_one({"_id": rec["_id"]}, {"$set": {"check_now.url": good}})
    return await view(db, await mine(db, user_id), viewer_id=user_id)


async def _call_script(client: httpx.AsyncClient, rec: dict) -> dict:
    """POST {key} to one connection's web app → the script's answer, or {ok: False, error}."""
    url = web_app_url((rec.get("check_now") or {}).get("url"))
    if not url or not rec.get("check_key"):
        return {"ok": False, "error": "not_set_up"}
    try:
        r = await client.post(url, json={"key": rec["check_key"]})
        for _ in range(2):
            if r.status_code not in (301, 302, 303, 307, 308):
                break
            host = urlparse(r.headers.get("location") or "").hostname or ""
            if host == _ECHO_HOST:
                r = await client.get(r.headers["location"])
            else:
                return {"ok": False, "error": "sign_in" if host.endswith("google.com") else "not_script"}
    except httpx.TimeoutException:
        return {"ok": False, "error": "timeout"}
    except httpx.HTTPError:
        return {"ok": False, "error": "unreachable"}
    if r.status_code in (401, 403):
        return {"ok": False, "error": "sign_in"}
    if r.status_code != 200:
        return {"ok": False, "error": "unreachable", "status": r.status_code}
    try:
        data = r.json()
    except ValueError:
        return {"ok": False, "error": "not_script"}
    if not isinstance(data, dict) or "ok" not in data:
        return {"ok": False, "error": "not_script"}
    if not data.get("ok"):
        err = str(data.get("error") or "failed")
        return {"ok": False, "error": err if err in CHECK_ERRORS else "failed",
                "retry_in": _count(data.get("retry_in")) or None}
    res = data.get("results") if isinstance(data.get("results"), dict) else {}
    sk = data.get("skipped") if isinstance(data.get("skipped"), dict) else {}
    return {"ok": True, "found": _count(data.get("found")), "sent": _count(data.get("sent")),
            "imported": _count(res.get("imported")), "attached": _count(res.get("attached")),
            "updated": _count(res.get("updated")), "not_ready": _count(res.get("not_ready")) + _count(sk.get("not_ready")),
            "writing": _count(sk.get("writing")), "remaining": _count(data.get("remaining")),
            "errors": _count(data.get("errors"))}


def _plural(n: int, one: str) -> str:
    return f"{n} {one}" if n == 1 else f"{n} {one}s"


def check_message(out: dict) -> str:
    """'Found 2 new meetings.' / 'No new meetings.' (+ what's still being written, what failed)."""
    if not out["ok"]:
        first = next((c for c in out["connections"] if not c["ok"]), None)
        return first["message"] if first else "Couldn't check right now. Try again in a minute."
    new = out["imported"] + out["attached"]
    parts = [f"Found {_plural(out['imported'], 'new meeting')}." if out["imported"]
             else f"Added {_plural(out['attached'], 'Doc')} to meetings already here." if new
             else "No new meetings."]
    if out["updated"]:
        parts.append(f"Updated {_plural(out['updated'], 'meeting')} with Google's latest notes or transcript.")
    if out["not_ready"]:
        parts.append(f"{_plural(out['not_ready'], 'Doc')} Google hasn't filled in yet (Gemini writes its notes when the call "
                     "ends): it's sent as soon as Google does.")
    if out["writing"]:
        parts.append(f"{_plural(out['writing'], 'Doc')} Google is still writing: check again in a couple of minutes.")
    if out["remaining"]:
        parts.append(f"{out['remaining']} more arrive with the next run.")
    if out["failed"]:
        parts.append(f"{out['failed']} of {out['checked']} scripts couldn't check.")
    return " ".join(parts)


async def check_now(db: AsyncIOMotorDatabase, user, workspace_id: str) -> dict:
    """"Check for new meetings": run every connected script of the workspace that has Check now on, now
    (in parallel), wait for their answers (under a minute) → {ok, checked, imported, attached, writing,
    remaining, failed, message, connections: [{connected_by, mine, ok, error?, message?, …}]}. Members
    only; once a minute per workspace (429 with retry_after)."""
    await meetings.require_member(db, workspace_id, user.id)
    conns = await db["api_tokens"].find({"scope": SCOPE, "workspace_id": workspace_id}).sort("created_at", 1).to_list(length=50)
    if not conns:
        raise HTTPException(status_code=409, detail={"error": "not_connected", "message":
                            "Google Meet isn't connected here. Connect it first: Meetings › Connect Google Meet."})
    ready = [c for c in conns if web_app_url((c.get("check_now") or {}).get("url"))]
    if not ready:
        raise HTTPException(status_code=409, detail={"error": "not_set_up", "message":
                            "Check now isn't turned on yet: whoever connected Google Meet turns it on once "
                            "(Meetings › Turn on Check now)."})
    now = now_utc()
    try:
        await db[CHECK_COLL].update_one({"_id": workspace_id, "at": {"$lt": now - CHECK_GAP}},
                                        {"$set": {"at": now, "by": user.id}}, upsert=True)
    except DuplicateKeyError:
        last = await db[CHECK_COLL].find_one({"_id": workspace_id}) or {}
        at = last.get("at") or now
        if at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        wait = max(1, int((CHECK_GAP - (now - at)).total_seconds()))
        raise HTTPException(status_code=429, detail={"error": "too_soon", "retry_after": wait,
                                                     "message": f"Checked less than a minute ago. Try again in {wait} s."})
    async def bounded(client: httpx.AsyncClient, c: dict) -> dict:
        try:
            return await asyncio.wait_for(_call_script(client, c), CHECK_DEADLINE)
        except asyncio.TimeoutError:
            return {"ok": False, "error": "timeout"}

    async with httpx.AsyncClient(timeout=CHECK_TIMEOUT, transport=CHECK_TRANSPORT, follow_redirects=False) as client:
        answers = await asyncio.gather(*(bounded(client, c) for c in ready))
    people = await _names(db, [c["user_id"] for c in ready])
    rows = []
    for rec, a in zip(ready, answers):
        if not a["ok"]:
            a["message"] = CHECK_ERRORS.get(a["error"], CHECK_ERRORS["failed"])
        rows.append({"connected_by": {"id": rec["user_id"], "name": people.get(rec["user_id"])},
                     "mine": rec["user_id"] == user.id, **a})
        await db["api_tokens"].update_one({"_id": rec["_id"]}, {"$set": {
            "check_now.last_at": now_utc(),
            "check_now.last": {k: a.get(k) for k in ("ok", "error", "imported", "attached", "updated", "writing") if k in a}}})
    ok = [r for r in rows if r["ok"]]
    out = {"ok": bool(ok), "checked": len(rows), "failed": len(rows) - len(ok),
           "imported": sum(r["imported"] for r in ok), "attached": sum(r["attached"] for r in ok),
           "updated": sum(r["updated"] for r in ok), "not_ready": sum(r["not_ready"] for r in ok),
           "writing": sum(r["writing"] for r in ok), "remaining": sum(r["remaining"] for r in ok),
           "not_set_up": len(conns) - len(ready), "connections": rows}
    out["message"] = check_message(out)
    return out


async def _names(db: AsyncIOMotorDatabase, ids: list[str]) -> dict[str, str | None]:
    oids = [ObjectId(i) for i in ids if ObjectId.is_valid(i)]
    users = await db["users"].find({"_id": {"$in": oids}}, {"name": 1, "email": 1}).to_list(length=len(oids) or 1)
    return {str(u["_id"]): u.get("name") or (u.get("email") or "").split("@")[0] or None for u in users}


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


class NotReadyOld(HTTPException):
    """Not ready, told to a script older than v4 (it marks any 2xx as sent for good): a 409 it retries."""

    def __init__(self) -> None:
        super().__init__(status_code=409, detail="Google hasn't written this meeting's notes or transcript yet: it's "
                                                 "sent again on the next run.")


def usable(src: mp.Source) -> bool:
    """Does a parsed Doc hold a meeting yet: spoken lines, or Gemini's notes with something in them (not
    only empty sections, not only "Gemini is taking notes… notes will be shared after the meeting")?"""
    if any(seg.get("speaker") for seg in src.segments):
        return True
    n = src.notes or {}
    if n.get("details") or n.get("next_steps"):
        return True
    summary = (n.get("summary") or "").strip()
    return bool(summary) and not (len(summary) < 400 and _PLACEHOLDER.search(summary))


def text_hash(text: str) -> str:
    return hashlib.sha256((text or "").encode()).hexdigest()[:32]


async def receive(db: AsyncIOMotorDatabase, rec: dict, item: dict) -> dict:
    """One Doc from the script → {status: imported | attached | updated | duplicate | ignored | not_ready,
    meeting_id?, url?}. Raises HTTPException (403: no longer a member; 409: being imported right now, or
    — to a script older than v4, which would never send it again — not ready yet; 422…).

    A Doc sent again (v4 sends a Doc again when Google changed it): unchanged → duplicate; it was ignored
    or not ready before → imported now; its meeting is here → the meeting takes the new content
    (``meetings.refresh_sources``: "updated"). A meeting someone deleted isn't made again."""
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
    digest = text_hash(text)
    key = {"workspace_id": ws_id, "file_id": file_id}
    claim = {**key, "user_id": user.id, "token_id": str(rec["_id"]), "state": "processing", "at": now,
             "title": title, "kind_hint": item.get("kind_hint"), "created": item.get("created"), "attempts": 1,
             "owner": _owner(item.get("owner")), "requested": bool(item.get("requested")), "version": item.get("version")}
    before: dict = {}
    try:
        await db[COLL].insert_one(claim)
    except DuplicateKeyError:
        ex = await db[COLL].find_one(key) or {}
        state = ex.get("state")
        if state in DONE and (ex.get("text_hash") == digest or (state != "ignored" and not ex.get("meeting_id"))):
            await _stats(db, rec, {"duplicates": 1}, {})
            if item.get("requested"):
                from app.services import meeting_links

                await meeting_links.mark_sent(db, rec, file_id, meeting_id=ex.get("meeting_id"), status="duplicate")
            return {"status": "duplicate", "meeting_id": ex.get("meeting_id")}
        at = ex.get("at")
        if at is not None and at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        if state == "processing" and at is not None and now - at < PROCESSING_STALE:
            raise HTTPException(status_code=409, detail="That Doc is being imported right now.")
        got = await db[COLL].update_one({"_id": ex.get("_id"), "state": state, "at": ex.get("at")},
                                        {"$set": {"state": "processing", "at": now, "user_id": user.id,
                                                  "token_id": str(rec["_id"]), "title": title},
                                         "$inc": {"attempts": 1}})
        if not got.modified_count:
            raise HTTPException(status_code=409, detail="That Doc is being imported right now.")
        # Its meeting is here (and the Doc changed): that meeting takes the new content.
        if state in ("imported", "attached", "duplicate", "updated") and ex.get("meeting_id"):
            before = ex

    async def finish(state: str, **extra) -> None:
        await db[COLL].update_one(key, {"$set": {"state": state, "done_at": now_utc(), "text_hash": digest, **extra}})

    async def link_done(meeting_id: str | None, status: str) -> None:
        if item.get("requested"):
            from app.services import meeting_links

            await meeting_links.mark_sent(db, rec, file_id, meeting_id=meeting_id, status=status)

    try:
        src = mp.parse_source(title, text)
        # The script only sends Docs titled like Meet's. One without a meeting in it yet (Gemini's notes Doc
        # while the call is on) is "not ready": sent again when Google changes it, for NOT_READY_FOR. After
        # that (a shopping list called "… - Notes"), it's handled once and left alone.
        if not text.strip() or not usable(src):
            if before:
                # Its meeting stays as it is (the Doc was emptied, or holds less than the meeting has).
                await finish(before.get("state") or "imported")
                await _stats(db, rec, {"duplicates": 1}, {})
                return {"status": "duplicate", "meeting_id": before.get("meeting_id")}
            if _recent(item.get("created"), hours=int(NOT_READY_FOR.total_seconds() // 3600)):
                await finish("not_ready")
                await _stats(db, rec, {"not_ready": 1}, {})
                if int(item.get("version") or 1) < 4:
                    # v3 and older mark a 2xx as sent for good: an error makes them try again next run.
                    raise NotReadyOld()
                return {"status": "not_ready", "reason": "Google hasn't written the notes or transcript in it yet."}
            await finish("ignored", reason="no_meeting")
            await link_done(None, "ignored")
            await _stats(db, rec, {"ignored": 1}, {})
            return {"status": "ignored", "reason": "No transcript or meeting notes found in it."}
        inc = meetings.Incoming(name=title, text=text, origin="google", file_id=file_id,
                                url=_doc_url(item.get("doc_url"), file_id), owner=_owner(item.get("owner")))
        if before:
            row = await db[meetings.COLL].find_one({"_id": ObjectId(before["meeting_id"])}) \
                if ObjectId.is_valid(str(before["meeting_id"])) else None
            if row is None:
                # Someone deleted the meeting: it isn't made again.
                await finish(before.get("state") or "imported")
                await _stats(db, rec, {"duplicates": 1}, {})
                return {"status": "duplicate", "meeting_id": None}
            src._incoming = inc  # type: ignore[attr-defined]
            row = await meetings.refresh_sources(db, user, row, [src])
            rows = [row]
        else:
            # The meeting's own date: from Google's title when it has one, else when the Doc was made.
            date_ = None if src.date else meeting_date(item.get("created"), rec.get("tz"))
            # A past meeting sent by the script's backfill is history: nobody is notified about it. A Doc asked
            # for by link is a manual import: notified as usual unless the call is more than a day old.
            notify = not item.get("backfill")
            if item.get("requested"):
                notify = _recent(item.get("created"))
            rows = await meetings.import_meetings(db, user, ws_id, [inc], date_=date_,
                                                  restricted=True if rec.get("restricted") else None,
                                                  via="inbox", dedupe="all", notify=notify)
    except NotReadyOld:
        raise
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
    await finish(status if not before or status == "updated" else before.get("state") or status, meeting_id=str(row["_id"]))
    counter = {"imported": "imported", "attached": "attached", "duplicate": "duplicates", "updated": "updated"}[status]
    sets: dict[str, Any] = {"last_error": None}
    if status != "duplicate":
        sets.update(last_imported_at=now_utc(), last_meeting_id=str(row["_id"]), last_title=row.get("title"))
    await _stats(db, rec, {counter: 1}, sets)
    await link_done(str(row["_id"]), status)
    out: dict[str, Any] = {"status": status, "meeting_id": str(row["_id"])}
    if status != "duplicate" and row.get("slug"):
        out["url"] = urls.markdrop_url(row["slug"])
    return out
