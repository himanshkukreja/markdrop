"""Zoom: a workspace's recorded Zoom meetings become Markdrop meetings, in one team.

    routers/zoom.py         /api/v1/zoom/… (Integrations › Zoom, the importer, the webhook)
    mcp/zoom_tools.py       zoom_status, import_zoom_meetings
    services/zoom_api.py    Zoom's OAuth and REST calls (tests: tests/_zoom_fake.py)

**Connection (owner decision 2026-11-10, lead change: Server-to-Server OAuth).** The customer's Zoom
admin makes an internal *Server-to-Server OAuth* app in their own Zoom account and a workspace admin
pastes its Account ID, Client ID, Client Secret and the event subscription's Secret Token into
Workspace settings › Integrations › Zoom. One Zoom account per workspace, one workspace per Zoom
account. Saving checks them: an access token (Zoom says which scopes it has: missing ones are
listed) and a test call (the account's users). The secrets and the access token are Fernet-encrypted
(utils/crypto, MARKDROP_TOKEN_ENCRYPTION_KEY); the access token lasts an hour and a new one is
fetched the same way (S2S apps have no refresh token), once at a time per workspace.

**Which meetings.** Only recorded meetings whose *host* is a member of the team the admin picked
(matched by email: the Zoom user's address is the Markdrop account's). Others are ignored and never
stored (not even their topic). A meeting lands in that team (``team_routing.chosen``), visible to the
team (and, as everywhere, the workspace's admins); the settings suggest making an open team private.
It is imported as its host (their Meetings AI limits, their page), never restricted to attendees.

**How.** The webhook (``POST /api/v1/zoom/webhook/{workspace_id}``; Zoom's URL validation and the
``x-zm-signature`` v0 HMAC with that workspace's Secret Token) gets ``recording.transcript_completed``
(the transcript is ready) and ``recording.completed`` (a fallback: the transcript is often not in it
yet). The transcript (WebVTT) is downloaded, the participants (past meeting participants) become the
attendees, and it goes through the Meetings pipeline (services/meetings.import_meetings: summary,
decisions, action items, Slack, briefs, memory, Jira drafts). **Import past meetings** lists the team
members' cloud recordings for a range (Zoom allows a month per request: several windows) and imports
the chosen ones as history (nobody is notified).

**Dedupe**: ``zoom_meetings`` (_id ``<workspace>:<meeting UUID>``) claims a meeting once
(processing → imported | duplicate | no_transcript | failed), and the meeting's source carries
``file_id = "zoom:<uuid>"`` (import_meetings(dedupe="file")). A meeting without a transcript is
``no_transcript`` (with how to turn on Zoom's Audio transcript) until a transcript arrives.

Collections
    zoom_connections  _id = workspace id: account_id, client_id, client_secret_enc, webhook_secret_enc,
                      access_enc, expires_at, scopes, team_id, connected_by, connected_at, verified_at,
                      broken, last_event_at, last_import_at, last_error, stats {imported, ignored, …}
    zoom_meetings     _id = "<workspace>:<uuid>": state, uuid, topic, host {user_id, name, email},
                      start_time, meeting_id, slug, via (webhook | backfill), reason, at
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
import time as _time
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.services import zoom_api
from app.utils import crypto

log = logging.getLogger("markdrop.zoom")

CONNS = "zoom_connections"
MEETINGS = "zoom_meetings"

# The scopes Markdrop needs (granular scope, then the classic scope that also covers it).
SCOPES: list[dict] = [
    {"scope": "user:read:list_users:admin", "also": ["user:read:admin"], "required": True,
     "why": "See the account's users, to know who hosted a meeting"},
    {"scope": "cloud_recording:read:list_user_recordings:admin", "also": ["recording:read:admin"], "required": True,
     "why": "List each team member's cloud recordings (Import past meetings)"},
    {"scope": "cloud_recording:read:list_recording_files:admin", "also": ["recording:read:admin"], "required": True,
     "why": "Read a meeting's recording files and download its transcript"},
    {"scope": "meeting:read:list_past_participants:admin", "also": ["meeting:read:admin"], "required": False,
     "why": "Who joined each meeting (its attendees); without it, the transcript's speakers are used"},
]
EVENTS = ("recording.transcript_completed", "recording.completed")
NO_TRANSCRIPT = ("Zoom made no transcript for this meeting. In the Zoom web portal, an account admin turns on "
                 "Settings › Recording › Cloud recording › Advanced cloud recording settings › Create audio transcript "
                 "(and can lock it so every host has it). Meetings recorded after that come in on their own.")
SIGNATURE_AGE = 5 * 60
TOKEN_EARLY = timedelta(minutes=2)
PROCESSING_STALE = timedelta(minutes=10)
MAX_RANGE_DAYS = 366
WINDOW_DAYS = 30
MAX_IMPORT = 50
MAX_LIST = 500
RETRIES = 3
SLEEP_CAP = 10.0       # the longest Retry-After waited for in-line (tests: 0)
DONE = ("imported", "duplicate")
_ID = re.compile(r"^[A-Za-z0-9_.=-]{4,128}$")
_SECRET = re.compile(r"^[\x21-\x7e]{8,256}$")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: Any) -> datetime | None:
    if not isinstance(dt, datetime):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def iso(dt: Any) -> str | None:
    dt = _aware(dt)
    return dt.isoformat().replace("+00:00", "Z") if dt else None


def configured() -> bool:
    """Zoom works on this server when secrets can be stored encrypted."""
    return crypto.is_configured()


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[CONNS].create_index("account_id", unique=True, sparse=True)
    await db[MEETINGS].create_index([("workspace_id", 1), ("at", -1)])


# ── Background work ───────────────────────────────────────────────────────────

_bg: set[asyncio.Task] = set()
_locks: dict[str, asyncio.Lock] = {}


def spawn(coro) -> asyncio.Task:
    task = asyncio.create_task(coro)
    _bg.add(task)
    task.add_done_callback(_bg.discard)
    task.add_done_callback(lambda t: (not t.cancelled() and t.exception() is not None
                                      and log.warning("zoom: background work failed: %r", t.exception())))
    return task


async def drain() -> None:
    """Wait for the background work started so far (tests)."""
    loop = asyncio.get_running_loop()
    while True:
        for t in list(_bg):
            if t.done() or t.get_loop() is not loop:
                _bg.discard(t)
        if not _bg:
            return
        await asyncio.gather(*list(_bg), return_exceptions=True)


def _lock(ws: str) -> asyncio.Lock:
    lk = _locks.get(ws)
    if lk is None:
        lk = _locks[ws] = asyncio.Lock()
    return lk


# ── Who may do what ───────────────────────────────────────────────────────────


async def require_admin(db: AsyncIOMotorDatabase, user, workspace_id: str) -> None:
    from app.services import workspace as ws_service

    if not workspace_id or not ObjectId.is_valid(workspace_id):
        raise HTTPException(status_code=404, detail="Workspace not found")
    await ws_service.require_role(db, workspace_id, user.id, "admin")


async def role_of(db: AsyncIOMotorDatabase, user, workspace_id: str) -> str:
    from app.services import workspace as ws_service

    if not workspace_id or not ObjectId.is_valid(workspace_id):
        raise HTTPException(status_code=404, detail="Workspace not found")
    return await ws_service.require_role(db, workspace_id, user.id, "viewer")


async def _team(db: AsyncIOMotorDatabase, workspace_id: str, team_id: str | None) -> dict | None:
    from app.services import teams as T

    oid = T.oid(team_id) if team_id else None
    return await db[T.TEAMS].find_one({"_id": oid, "workspace_id": workspace_id}) if oid else None


async def can_import(db: AsyncIOMotorDatabase, user, workspace_id: str, conn: dict | None = None) -> bool:
    """Workspace admins, and the leads of the team Zoom meetings go to."""
    from app.models.workspace import role_allows

    role = await role_of(db, user, workspace_id)
    if role_allows(role, "admin"):
        return True
    conn = conn if conn is not None else await get(db, workspace_id)
    team = await _team(db, workspace_id, (conn or {}).get("team_id"))
    return bool(team and user.id in (team.get("lead_ids") or []))


async def require_import(db: AsyncIOMotorDatabase, user, workspace_id: str) -> dict:
    conn = await get(db, workspace_id)
    if not await can_import(db, user, workspace_id, conn):
        raise HTTPException(status_code=403, detail="Workspace admins and the team's leads import Zoom meetings.")
    if conn is None or not conn.get("client_secret_enc"):
        raise HTTPException(status_code=404, detail="This workspace isn't connected to Zoom.")
    if not conn.get("team_id"):
        raise HTTPException(status_code=409, detail="Pick the team Zoom meetings go to first (Integrations › Zoom).")
    return conn


async def get(db: AsyncIOMotorDatabase, workspace_id: str) -> dict | None:
    return await db[CONNS].find_one({"_id": str(workspace_id)}) if workspace_id else None


# ── Credentials, tokens, calls ────────────────────────────────────────────────


class ZoomUnavailable(Exception):
    """Zoom can't be reached with this workspace's app (wrong or deactivated credentials, missing scope)."""


def missing_scopes(granted: list[str] | None) -> list[dict]:
    """The scopes the app lacks (None: Zoom didn't say which it has; nothing is reported missing)."""
    if granted is None:
        return []
    have = set(granted)
    return [{"scope": s["scope"], "why": s["why"], "required": s["required"]}
            for s in SCOPES if s["scope"] not in have and not have.intersection(s["also"])]


def _scopes_of(tok: dict) -> list[str] | None:
    raw = tok.get("scope")
    return str(raw).split() if isinstance(raw, str) and raw.strip() else None


def _cred_message(exc: zoom_api.ZoomError) -> str:
    if exc.limited:
        return "Zoom asked Markdrop to slow down. Try again in a minute."
    if exc.status >= 500:
        return "Zoom didn't answer. Try again in a minute."
    return ("Zoom didn't accept the Account ID, Client ID or Client Secret. Copy them again from the app's "
            "App Credentials page, and check that the app is activated.")


async def connect(db: AsyncIOMotorDatabase, user, workspace_id: str, *, account_id: str, client_id: str,
                  client_secret: str | None, secret_token: str | None, team_id: str | None = None) -> dict:
    """Save (or change) the workspace's Server-to-Server OAuth app after checking it with Zoom."""
    await require_admin(db, user, workspace_id)
    if not configured():
        raise HTTPException(status_code=503, detail="Zoom isn't available on this Markdrop server yet.")
    account_id, client_id = (account_id or "").strip(), (client_id or "").strip()
    if not _ID.match(account_id) or not _ID.match(client_id):
        raise HTTPException(status_code=422, detail="The Account ID and Client ID are the short codes on the app's App Credentials page.")
    old = await get(db, workspace_id)
    secret = (client_secret or "").strip() or (crypto.decrypt(old["client_secret_enc"]) if old and old.get("client_secret_enc") else "")
    token_ = (secret_token or "").strip() or (crypto.decrypt(old["webhook_secret_enc"]) if old and old.get("webhook_secret_enc") else "")
    if not _SECRET.match(secret):
        raise HTTPException(status_code=422, detail="Paste the app's Client Secret.")
    if not _SECRET.match(token_):
        raise HTTPException(status_code=422, detail="Paste the Secret Token from the app's Event Subscriptions (Features › Access).")
    other = await db[CONNS].find_one({"account_id": account_id, "_id": {"$ne": str(workspace_id)}}, {"_id": 1})
    if other is not None:
        raise HTTPException(status_code=409, detail="That Zoom account is connected to another Markdrop workspace. Disconnect it there first.")
    if team_id is not None and team_id != "":
        await _check_team(db, workspace_id, team_id)
    try:
        tok = await zoom_api.token(account_id, client_id, secret)
    except zoom_api.ZoomError as exc:
        log.info("zoom connect: token %s %s", exc.status, exc.reason)
        raise HTTPException(status_code=400, detail=_cred_message(exc))
    granted = _scopes_of(tok)
    missing = missing_scopes(granted)
    try:
        await zoom_api.api("GET", "users", tok["access_token"], params={"page_size": 1, "status": "active"})
        test_ok, test_error = True, None
    except zoom_api.ZoomError as exc:
        if exc.scope or exc.status == 400:
            test_ok, test_error = False, "The app can't list the account's users: add the user:read:list_users:admin scope."
        else:
            raise HTTPException(status_code=400, detail=_cred_message(exc))
    now = now_utc()
    same_secret = bool(old and old.get("webhook_secret_enc") and crypto.decrypt(old["webhook_secret_enc"]) == token_)
    sets: dict[str, Any] = {
        "account_id": account_id, "client_id": client_id, "client_secret_enc": crypto.encrypt(secret),
        "webhook_secret_enc": crypto.encrypt(token_), "access_enc": crypto.encrypt(tok["access_token"]),
        "expires_at": now + timedelta(seconds=int(tok.get("expires_in") or 3600)), "scopes": granted,
        "broken": None if test_ok and not [m for m in missing if m["required"]] else (test_error or "missing_scopes"),
        "updated_at": now, "checked_at": now, "test_error": test_error,
    }
    if not old or not old.get("client_secret_enc"):
        sets.update(connected_by=user.id, connected_at=now, stats={})
    if not same_secret:
        sets["verified_at"] = None
    if team_id is not None:
        sets["team_id"] = team_id or None
    try:
        await db[CONNS].update_one({"_id": str(workspace_id)}, {"$set": sets}, upsert=True)
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="That Zoom account is connected to another Markdrop workspace.")
    log.info("zoom: workspace %s connected Zoom account %s", workspace_id, account_id)
    return await status(db, user, workspace_id)


async def _check_team(db: AsyncIOMotorDatabase, workspace_id: str, team_id: str) -> dict:
    team = await _team(db, workspace_id, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Team not found")
    if team.get("general"):
        raise HTTPException(status_code=422, detail="Pick a team other than the company-wide one: Zoom meetings stay with one team.")
    return team


async def set_team(db: AsyncIOMotorDatabase, user, workspace_id: str, team_id: str) -> dict:
    await require_admin(db, user, workspace_id)
    conn = await get(db, workspace_id)
    if conn is None or not conn.get("client_secret_enc"):
        raise HTTPException(status_code=404, detail="This workspace isn't connected to Zoom.")
    await _check_team(db, workspace_id, team_id)
    await db[CONNS].update_one({"_id": str(workspace_id)}, {"$set": {"team_id": team_id, "updated_at": now_utc()}})
    return await status(db, user, workspace_id)


async def disconnect(db: AsyncIOMotorDatabase, user, workspace_id: str) -> dict:
    """Forget the app's credentials and token, and the import log. Meetings already imported stay."""
    await require_admin(db, user, workspace_id)
    await db[CONNS].delete_one({"_id": str(workspace_id)})
    await db[MEETINGS].delete_many({"workspace_id": str(workspace_id)})
    log.info("zoom: workspace %s disconnected Zoom", workspace_id)
    return await status(db, user, workspace_id)


async def _mark_broken(db: AsyncIOMotorDatabase, ws: str, why: str) -> None:
    await db[CONNS].update_one({"_id": ws}, {"$set": {"broken": why, "access_enc": None, "expires_at": None}})


async def access_token(db: AsyncIOMotorDatabase, conn: dict, *, fresh: bool = False) -> str:
    ws = conn["_id"]
    exp = _aware(conn.get("expires_at"))
    if not fresh and conn.get("access_enc") and exp and exp - TOKEN_EARLY > now_utc():
        return crypto.decrypt(conn["access_enc"])
    async with _lock(ws):
        row = await get(db, ws)
        if row is None or not row.get("client_secret_enc"):
            raise ZoomUnavailable("This workspace isn't connected to Zoom.")
        exp = _aware(row.get("expires_at"))
        if row.get("access_enc") and exp and exp - TOKEN_EARLY > now_utc() and (not fresh or row.get("access_enc") != conn.get("access_enc")):
            return crypto.decrypt(row["access_enc"])
        try:
            tok = await zoom_api.token(row["account_id"], row["client_id"], crypto.decrypt(row["client_secret_enc"]))
        except zoom_api.ZoomError as exc:
            if exc.auth or exc.status in (400, 401, 403):
                await _mark_broken(db, ws, "credentials")
                raise ZoomUnavailable("Zoom no longer accepts this workspace's app credentials. Check the app in Zoom and save them again.")
            raise
        now = now_utc()
        await db[CONNS].update_one({"_id": ws}, {"$set": {
            "access_enc": crypto.encrypt(tok["access_token"]), "scopes": _scopes_of(tok) or row.get("scopes"),
            "expires_at": now + timedelta(seconds=int(tok.get("expires_in") or 3600))}})
        conn["access_enc"] = None
        return tok["access_token"]


async def _sleep(seconds: float) -> None:
    await asyncio.sleep(seconds)


async def call(db: AsyncIOMotorDatabase, conn: dict, method: str, path: str, *, params: dict | None = None) -> Any:
    """A REST call as the workspace's app: a new token on a 401 (once), Zoom's Retry-After on a 429
    (up to :data:`RETRIES` times, at most :data:`SLEEP_CAP` seconds each), else the error."""
    fresh = False
    for attempt in range(RETRIES + 1):
        tok = await access_token(db, conn, fresh=fresh)
        try:
            return await zoom_api.api(method, path, tok, params=params)
        except zoom_api.ZoomError as exc:
            if exc.status == 401 and not fresh:
                fresh = True
                continue
            if exc.limited and attempt < RETRIES:
                await _sleep(min(SLEEP_CAP, max(0.0, float(exc.retry_after or 1.0))))
                continue
            raise
    raise zoom_api.ZoomError(429, "Zoom asked Markdrop to slow down.")


async def download(db: AsyncIOMotorDatabase, conn: dict, url: str, download_token: str | None = None) -> str:
    for attempt in range(RETRIES + 1):
        tok = download_token or await access_token(db, conn, fresh=attempt > 0 and download_token is None)
        try:
            return await zoom_api.download(url, tok)
        except zoom_api.ZoomError as exc:
            if exc.status == 401 and download_token:
                download_token = None          # an expired download token: the app's own token
                continue
            if exc.limited and attempt < RETRIES:
                await _sleep(min(SLEEP_CAP, max(0.0, float(exc.retry_after or 1.0))))
                continue
            raise
    raise zoom_api.ZoomError(429, "Zoom asked Markdrop to slow down.")


# ── The webhook ───────────────────────────────────────────────────────────────


def sign(secret: str, ts: str, body: bytes) -> str:
    msg = b"v0:" + ts.encode() + b":" + body
    return "v0=" + hmac.new(secret.encode(), msg, hashlib.sha256).hexdigest()


def verify(secret: str, headers, body: bytes, *, now: float | None = None) -> str | None:
    """None when the request is Zoom's for this workspace (signature and a recent timestamp), else why not."""
    sig, ts = headers.get("x-zm-signature") or "", headers.get("x-zm-request-timestamp") or ""
    if not sig or not ts.isdigit():
        return "unsigned"
    t = int(ts)
    if t > 10_000_000_000:      # milliseconds
        t //= 1000
    if abs((now if now is not None else _time.time()) - t) > SIGNATURE_AGE:
        return "stale"
    if not hmac.compare_digest(sig, sign(secret, ts, body)):
        return "signature"
    return None


def validation_answer(secret: str, plain: str) -> dict:
    return {"plainToken": plain, "encryptedToken": hmac.new(secret.encode(), plain.encode(), hashlib.sha256).hexdigest()}


def webhook_url(workspace_id: str) -> str:
    return get_settings().api_base_url.rstrip("/") + f"/api/v1/zoom/webhook/{workspace_id}"


async def handle_webhook(db: AsyncIOMotorDatabase, workspace_id: str, headers, body: bytes) -> tuple[int, dict]:
    conn = await get(db, workspace_id) if ObjectId.is_valid(workspace_id or "") else None
    if conn is None or not conn.get("webhook_secret_enc"):
        return 404, {"detail": "Not found"}
    secret = crypto.decrypt(conn["webhook_secret_enc"])
    why = verify(secret, headers, body)
    if why:
        log.info("zoom: refused a webhook for %s (%s)", workspace_id, why)
        return 401, {"detail": "Bad signature"}
    try:
        payload = json.loads(body or b"{}")
    except ValueError:
        return 400, {"detail": "Bad JSON"}
    event = str(payload.get("event") or "")
    inner = payload.get("payload") or {}
    if event == "endpoint.url_validation":
        plain = str(inner.get("plainToken") or "")
        if not plain or len(plain) > 256:
            return 400, {"detail": "No plainToken"}
        await db[CONNS].update_one({"_id": conn["_id"]}, {"$set": {"verified_at": now_utc()}})
        return 200, validation_answer(secret, plain)
    if inner.get("account_id") and inner.get("account_id") != conn.get("account_id"):
        log.info("zoom: a webhook for another account reached %s", workspace_id)
        return 200, {"ok": True, "ignored": "account"}
    await db[CONNS].update_one({"_id": conn["_id"]}, {"$set": {"last_event_at": now_utc(), "verified_at": conn.get("verified_at") or now_utc()}})
    if event == "app_deauthorized":
        await db[CONNS].update_one({"_id": conn["_id"]}, {"$set": {"access_enc": None, "client_secret_enc": None,
                                                                  "expires_at": None, "broken": "deauthorized"}})
        log.info("zoom: the app was deauthorized for %s; its credentials are deleted", workspace_id)
        return 200, {"ok": True}
    if event in EVENTS:
        obj = inner.get("object") or {}
        if obj.get("uuid"):
            spawn(handle_recording(db, conn["_id"], obj, event=event, download_token=payload.get("download_token"),
                                   via="webhook"))
        return 200, {"ok": True}
    return 200, {"ok": True, "ignored": "event"}


# ── One recorded meeting → a Markdrop meeting ─────────────────────────────────


def transcript_file(obj: dict) -> dict | None:
    for f in obj.get("recording_files") or []:
        if str(f.get("file_type") or "").upper() == "TRANSCRIPT" or f.get("recording_type") == "audio_transcript":
            if (f.get("status") or "completed").lower() == "completed" and f.get("download_url"):
                return f
    return None


def local_start(obj: dict) -> tuple[str | None, str | None]:
    """(YYYY-MM-DD, HH:MM) of the meeting's start in its own time zone (UTC when Zoom didn't say)."""
    raw = str(obj.get("start_time") or "")
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None, None
    dt = _aware(dt)
    try:
        tz = ZoneInfo(obj.get("timezone")) if obj.get("timezone") else timezone.utc
    except (ZoneInfoNotFoundError, ValueError):
        tz = timezone.utc
    loc = dt.astimezone(tz)
    return loc.date().isoformat(), loc.strftime("%H:%M")


async def _users_by_id(db: AsyncIOMotorDatabase, conn: dict) -> dict[str, dict]:
    """The Zoom account's users: id → {email, name} (paged)."""
    out: dict[str, dict] = {}
    token = ""
    for _ in range(20):
        params: dict[str, Any] = {"page_size": 300, "status": "active"}
        if token:
            params["next_page_token"] = token
        body = await call(db, conn, "GET", "users", params=params) or {}
        for u in body.get("users") or []:
            out[str(u.get("id"))] = {"email": (u.get("email") or "").lower() or None,
                                    "name": " ".join(x for x in (u.get("first_name"), u.get("last_name")) if x) or u.get("display_name")}
        token = body.get("next_page_token") or ""
        if not token:
            break
    return out


async def host_of(db: AsyncIOMotorDatabase, conn: dict, obj: dict, users: dict[str, dict] | None = None) -> dict | None:
    """{email, name} of the meeting's host (the payload's host_email, else the account's users)."""
    email = (obj.get("host_email") or "").strip().lower()
    if email:
        return {"email": email, "name": None}
    hid = str(obj.get("host_id") or "")
    if not hid:
        return None
    users = users if users is not None else await _users_by_id(db, conn)
    return users.get(hid)


async def member_in_team(db: AsyncIOMotorDatabase, conn: dict, email: str | None) -> dict | None:
    """The Markdrop user (``{id, name, email}``) with this address when they're in the Zoom team."""
    if not email:
        return None
    team = await _team(db, conn["_id"], conn.get("team_id"))
    if team is None:
        return None
    u = await db["users"].find_one({"email": email.lower()}, {"name": 1, "email": 1})
    if u is None or str(u["_id"]) not in (team.get("member_ids") or []):
        return None
    m = await db["memberships"].find_one({"workspace_id": conn["_id"], "user_id": str(u["_id"])}, {"_id": 1})
    if m is None:
        return None
    return {"id": str(u["_id"]), "name": u.get("name"), "email": u.get("email")}


async def participants(db: AsyncIOMotorDatabase, conn: dict, uuid: str) -> list[str]:
    """Who joined (names, in order, once each); [] when Zoom won't say (no scope, an old meeting)."""
    names: list[str] = []
    token = ""
    try:
        for _ in range(10):
            params: dict[str, Any] = {"page_size": 300}
            if token:
                params["next_page_token"] = token
            body = await call(db, conn, "GET", f"past_meetings/{zoom_api.uuid_path(uuid)}/participants", params=params) or {}
            for p in body.get("participants") or []:
                n = " ".join(str(p.get("name") or "").split())[:80]
                if n and n.casefold() not in {x.casefold() for x in names}:
                    names.append(n)
            token = body.get("next_page_token") or ""
            if not token:
                break
    except zoom_api.ZoomError as exc:
        log.info("zoom: participants of a meeting: %s %s", exc.status, exc.reason)
    return names[:100]


def transcript_text(vtt: str, attendees: list[str], host: dict | None) -> str:
    """The VTT with a short header the meeting parser reads: "Organizer:" and "Attendees:"."""
    head = []
    if host and host.get("name"):
        head.append(f"Organizer: {host['name']}")
    if attendees:
        head.append("Attendees: " + ", ".join(a.replace(",", " ") for a in attendees))
    body = (vtt or "").lstrip("﻿")
    return ("\n".join(head) + "\n\n" + body) if head else body


async def _claim(db: AsyncIOMotorDatabase, key: str, base: dict) -> bool:
    now = now_utc()
    try:
        await db[MEETINGS].insert_one({"_id": key, **base, "state": "processing", "at": now, "created_at": now})
        return True
    except DuplicateKeyError:
        res = await db[MEETINGS].update_one(
            {"_id": key, "$or": [{"state": {"$in": ["no_transcript", "failed"]}},
                                 {"state": "processing", "at": {"$lt": now - PROCESSING_STALE}}]},
            {"$set": {**base, "state": "processing", "at": now}})
        return res.modified_count > 0


async def _finish(db: AsyncIOMotorDatabase, key: str, state: str, **extra) -> None:
    await db[MEETINGS].update_one({"_id": key}, {"$set": {"state": state, "at": now_utc(), **extra}})


async def _count(db: AsyncIOMotorDatabase, ws: str, field: str, sets: dict | None = None) -> None:
    await db[CONNS].update_one({"_id": ws}, {"$inc": {f"stats.{field}": 1}, **({"$set": sets} if sets else {})})


async def handle_recording(db: AsyncIOMotorDatabase, workspace_id: str, obj: dict, *, event: str = "",
                           download_token: str | None = None, via: str = "webhook",
                           users: dict[str, dict] | None = None) -> dict:
    """Import one recorded meeting (a webhook's object, or ``GET meetings/{uuid}/recordings``).
    ``{status, meeting_id?, slug?, reason?}``: imported | duplicate | ignored | no_transcript | failed."""
    from app.services import meetings, team_routing
    from app.services import user as user_service

    conn = await get(db, workspace_id)
    if conn is None or not conn.get("client_secret_enc"):
        return {"status": "ignored", "reason": "not_connected"}
    if not conn.get("team_id"):
        await _count(db, workspace_id, "ignored")
        return {"status": "ignored", "reason": "no_team"}
    uuid = str(obj.get("uuid") or "")
    try:
        host = await host_of(db, conn, obj, users)
    except (zoom_api.ZoomError, ZoomUnavailable) as exc:
        await _count(db, workspace_id, "failed", {"last_error": str(exc)[:300]})
        return {"status": "failed", "reason": str(exc)[:300]}
    member = await member_in_team(db, conn, (host or {}).get("email"))
    if member is None:
        # Not the team's meeting: never stored, not even its topic.
        await _count(db, workspace_id, "ignored")
        return {"status": "ignored", "reason": "host_not_in_team"}
    key = f"{workspace_id}:{uuid}"
    d, t = local_start(obj)
    base = {"workspace_id": workspace_id, "uuid": uuid, "meeting_id": str(obj.get("id") or "") or None,
            "topic": str(obj.get("topic") or "Zoom meeting")[:200], "start_time": obj.get("start_time"), "date": d,
            "duration_min": obj.get("duration"), "host": member, "via": via, "event": event or None}
    prev = await db[MEETINGS].find_one({"_id": key}, {"state": 1, "meeting_row_id": 1, "slug": 1})
    if prev and prev.get("state") in DONE:
        return {"status": "duplicate", "meeting_id": prev.get("meeting_row_id"), "slug": prev.get("slug")}
    already = await db[meetings.COLL].find_one({"workspace_id": workspace_id, "sources.file_id": f"zoom:{uuid}"}, {"slug": 1})
    if already is not None:
        await db[MEETINGS].update_one({"_id": key}, {"$set": {**base, "state": "duplicate", "at": now_utc(),
                                                              "meeting_row_id": str(already["_id"]), "slug": already.get("slug")}},
                                      upsert=True)
        return {"status": "duplicate", "meeting_id": str(already["_id"]), "slug": already.get("slug")}
    tf = transcript_file(obj)
    if tf is None:
        if prev is None:
            try:
                await db[MEETINGS].insert_one({"_id": key, **base, "state": "no_transcript", "at": now_utc(),
                                               "created_at": now_utc(), "reason": NO_TRANSCRIPT})
                await _count(db, workspace_id, "no_transcript")
            except DuplicateKeyError:
                pass
        elif prev.get("state") != "processing":
            await db[MEETINGS].update_one({"_id": key}, {"$set": {**base, "state": "no_transcript", "at": now_utc(),
                                                                  "reason": NO_TRANSCRIPT}})
        return {"status": "no_transcript", "reason": NO_TRANSCRIPT}
    if not await _claim(db, key, base):
        row = await db[MEETINGS].find_one({"_id": key}, {"state": 1, "meeting_row_id": 1, "slug": 1})
        return {"status": "duplicate", "meeting_id": (row or {}).get("meeting_row_id"), "slug": (row or {}).get("slug")}
    try:
        vtt = await download(db, conn, tf["download_url"], download_token)
        names = await participants(db, conn, uuid)
        user = await user_service.get_user_by_id(db, member["id"])
        if user is None:
            raise HTTPException(status_code=404, detail="The host's Markdrop account is gone.")
        host_named = {"name": member.get("name") or (host or {}).get("name"), "email": member.get("email")}
        inc = meetings.Incoming(name=f"{base['topic']}.vtt", text=transcript_text(vtt, names, host_named), origin="zoom",
                                file_id=f"zoom:{uuid}", owner=host_named)
        tok = team_routing.chosen.set(([conn["team_id"]], []))
        try:
            rows = await meetings.import_meetings(db, user, workspace_id, [inc], title=base["topic"], date_=d,
                                                  restricted=False, via="zoom", dedupe="file", notify=via == "webhook")
        finally:
            team_routing.chosen.reset(tok)
    except HTTPException as exc:
        msg = str(exc.detail)[:300]
        await _finish(db, key, "failed", reason=msg)
        await _count(db, workspace_id, "failed", {"last_error": msg})
        return {"status": "failed", "reason": msg}
    except (zoom_api.ZoomError, ZoomUnavailable) as exc:
        msg = ("Zoom asked Markdrop to slow down; try again in a minute." if isinstance(exc, zoom_api.ZoomError) and exc.limited
               else str(exc)[:300] or "Zoom didn't send the transcript.")
        await _finish(db, key, "failed", reason=msg)
        await _count(db, workspace_id, "failed", {"last_error": msg})
        return {"status": "failed", "reason": msg}
    except Exception:
        log.warning("zoom: importing %s failed", key, exc_info=True)
        await _finish(db, key, "failed", reason="Something went wrong importing it. Try again.")
        await _count(db, workspace_id, "failed")
        return {"status": "failed", "reason": "Something went wrong importing it. Try again."}
    row = rows[0]
    status_ = "duplicate" if row.get("_status") == "duplicate" else "imported"
    fix: dict[str, Any] = {}
    if t and not row.get("time"):
        fix["time"] = t
    if obj.get("duration") and not row.get("duration_s"):
        fix["duration_s"] = int(obj["duration"]) * 60
    if fix and status_ == "imported":
        await db[meetings.COLL].update_one({"_id": row["_id"]}, {"$set": {**fix, "zoom": {"uuid": uuid, "meeting_id": base["meeting_id"]}}})
    await _finish(db, key, status_, meeting_row_id=str(row["_id"]), slug=row.get("slug"), reason=None)
    await _count(db, workspace_id, "imported" if status_ == "imported" else "duplicates",
                 {"last_import_at": now_utc(), "last_error": None} if status_ == "imported" else None)
    return {"status": status_, "meeting_id": str(row["_id"]), "slug": row.get("slug")}


# ── Import past meetings ──────────────────────────────────────────────────────


def date_range(days: int | None, from_: str | None, to: str | None) -> tuple[date, date]:
    today = now_utc().date()
    if from_ or to:
        try:
            a = date.fromisoformat(from_) if from_ else today - timedelta(days=30)
            b = date.fromisoformat(to) if to else today
        except ValueError:
            raise HTTPException(status_code=422, detail="Dates are written YYYY-MM-DD.")
    else:
        b, a = today, today - timedelta(days=int(days or 30))
    if a > b:
        a, b = b, a
    if (b - a).days > MAX_RANGE_DAYS:
        raise HTTPException(status_code=422, detail=f"Pick at most {MAX_RANGE_DAYS} days.")
    return a, b


def windows(a: date, b: date) -> list[tuple[date, date]]:
    out, cur = [], a
    while cur <= b:
        end = min(b, cur + timedelta(days=WINDOW_DAYS - 1))
        out.append((cur, end))
        cur = end + timedelta(days=1)
    return out


async def list_recordings(db: AsyncIOMotorDatabase, user, workspace_id: str, *, days: int | None = 30,
                          from_: str | None = None, to: str | None = None) -> dict:
    """The team members' recorded meetings in the range, newest first, each with whether it has a
    transcript and whether it's already in Markdrop."""
    conn = await require_import(db, user, workspace_id)
    team = await _team(db, workspace_id, conn["team_id"])
    a, b = date_range(days, from_, to)
    members = await db["users"].find({"_id": {"$in": [ObjectId(u) for u in (team or {}).get("member_ids") or [] if ObjectId.is_valid(u)]}},
                                     {"name": 1, "email": 1}).to_list(length=1000)
    rows: dict[str, dict] = {}
    not_in_zoom: list[str] = []
    try:
        for m in members:
            email = (m.get("email") or "").lower()
            if not email:
                continue
            found = False
            for wa, wb in windows(a, b):
                token = ""
                for _ in range(20):
                    params: dict[str, Any] = {"from": wa.isoformat(), "to": wb.isoformat(), "page_size": 300}
                    if token:
                        params["next_page_token"] = token
                    try:
                        body = await call(db, conn, "GET", f"users/{email}/recordings", params=params) or {}
                    except zoom_api.ZoomError as exc:
                        if exc.missing:
                            body = None
                        else:
                            raise
                    if body is None:
                        break
                    found = True
                    for mt in body.get("meetings") or []:
                        uuid = str(mt.get("uuid") or "")
                        if not uuid or uuid in rows:
                            continue
                        d, t = local_start(mt)
                        rows[uuid] = {"uuid": uuid, "topic": mt.get("topic") or "Zoom meeting", "start_time": mt.get("start_time"),
                                      "date": d, "time": t, "duration_min": mt.get("duration"),
                                      "host": {"id": str(m["_id"]), "name": m.get("name") or email.split("@")[0], "email": email},
                                      "transcript": transcript_file(mt) is not None}
                    token = body.get("next_page_token") or ""
                    if not token:
                        break
                if not found:
                    break
            if not found:
                not_in_zoom.append(m.get("name") or email.split("@")[0])
    except ZoomUnavailable as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except zoom_api.ZoomError as exc:
        if exc.scope:
            raise HTTPException(status_code=409, detail="The Zoom app can't list cloud recordings: add the "
                                                        "cloud_recording:read:list_user_recordings:admin scope.")
        raise HTTPException(status_code=502, detail="Zoom asked Markdrop to slow down. Try again in a minute."
                            if exc.limited else "Zoom didn't answer. Try again in a minute.")
    uuids = list(rows)
    done = {r["uuid"]: r async for r in db[MEETINGS].find({"workspace_id": workspace_id, "uuid": {"$in": uuids}},
                                                           {"uuid": 1, "state": 1, "slug": 1})}
    from app.services import meetings

    have = {s["file_id"][5:]: r.get("slug") async for r in db[meetings.COLL].find(
        {"workspace_id": workspace_id, "sources.file_id": {"$in": [f"zoom:{u}" for u in uuids]}}, {"sources.file_id": 1, "slug": 1})
        for s in r.get("sources") or [] if str(s.get("file_id") or "").startswith("zoom:")}
    out = []
    for uuid, r in rows.items():
        st = done.get(uuid) or {}
        r["imported"] = uuid in have or st.get("state") in DONE
        r["slug"] = have.get(uuid) or st.get("slug")
        r["state"] = "imported" if r["imported"] else st.get("state") if st.get("state") in ("failed", "no_transcript") else None
        out.append(r)
    out.sort(key=lambda r: str(r.get("start_time") or ""), reverse=True)
    await db[CONNS].update_one({"_id": conn["_id"]}, {"$set": {"last_sync_at": now_utc()}})
    return {"from": a.isoformat(), "to": b.isoformat(), "meetings": out[:MAX_LIST], "total": len(out),
            "not_in_zoom": not_in_zoom, "no_transcript_help": NO_TRANSCRIPT}


async def import_recordings(db: AsyncIOMotorDatabase, user, workspace_id: str, uuids: list[str]) -> dict:
    """Import chosen past meetings (as history: nobody is notified). Each is checked again: its host
    must be in the team."""
    conn = await require_import(db, user, workspace_id)
    uuids = list(dict.fromkeys(str(u) for u in uuids if u))[:MAX_IMPORT]
    if not uuids:
        raise HTTPException(status_code=422, detail="Pick at least one meeting.")
    try:
        users = await _users_by_id(db, conn)
    except ZoomUnavailable as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except zoom_api.ZoomError:
        users = {}
    results = []
    for uuid in uuids:
        try:
            obj = await call(db, conn, "GET", f"meetings/{zoom_api.uuid_path(uuid)}/recordings") or {}
        except ZoomUnavailable as exc:
            results.append({"uuid": uuid, "status": "failed", "reason": str(exc)})
            continue
        except zoom_api.ZoomError as exc:
            results.append({"uuid": uuid, "status": "failed",
                            "reason": "Zoom has no recording of that meeting." if exc.missing
                            else "Zoom asked Markdrop to slow down; try again in a minute." if exc.limited
                            else "Zoom didn't answer. Try again."})
            continue
        obj.setdefault("uuid", uuid)
        out = await handle_recording(db, workspace_id, obj, via="backfill", users=users)
        out["uuid"] = uuid
        out["topic"] = obj.get("topic") if out["status"] != "ignored" else None
        results.append(out)
    counts: dict[str, int] = {}
    for r in results:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    from app.services import urls

    for r in results:
        if r.get("slug") and r["status"] in DONE:
            r["url"] = urls.markdrop_url(r["slug"])
    return {"results": results, "counts": counts}


# ── Status ────────────────────────────────────────────────────────────────────


def _mask(v: str | None) -> str | None:
    if not v:
        return None
    return v[:4] + "…" + v[-2:] if len(v) > 8 else v[:2] + "…"


async def status(db: AsyncIOMotorDatabase, user, workspace_id: str) -> dict:
    from app.models.workspace import role_allows
    from app.services import teams as T

    role = await role_of(db, user, workspace_id)
    admin = role_allows(role, "admin")
    conn = await get(db, workspace_id)
    connected = bool(conn and conn.get("client_secret_enc"))
    team = await _team(db, workspace_id, (conn or {}).get("team_id")) if conn else None
    out: dict[str, Any] = {
        "configured": configured(), "can_manage": admin, "connected": connected,
        "webhook_url": webhook_url(workspace_id) if admin else None,
        "scopes_needed": [{"scope": s["scope"], "why": s["why"], "required": s["required"]} for s in SCOPES] if admin else None,
        "events": list(EVENTS) if admin else None,
        "no_transcript_help": NO_TRANSCRIPT,
        "team": ({"id": str(team["_id"]), "name": team.get("name"), "visibility": team.get("visibility") or "open",
                  "slug": team.get("slug")} if team else None),
        "can_import": False, "connection": None, "teams": None, "recent": None,
    }
    if conn is not None and (connected or conn.get("broken")):
        st = conn.get("stats") or {}
        c = {"connected_at": iso(conn.get("connected_at")), "last_event_at": iso(conn.get("last_event_at")),
             "last_import_at": iso(st.get("last_import_at") or conn.get("last_import_at")),
             "last_sync_at": iso(conn.get("last_sync_at")),
             "verified": bool(conn.get("verified_at")),
             "broken": conn.get("broken"), "imported": int(st.get("imported") or 0), "ignored": int(st.get("ignored") or 0),
             "no_transcript": int(st.get("no_transcript") or 0), "failed": int(st.get("failed") or 0),
             "duplicates": int(st.get("duplicates") or 0)}
        if admin:
            u = await db["users"].find_one({"_id": ObjectId(conn["connected_by"])}, {"name": 1, "email": 1}) \
                if ObjectId.is_valid(str(conn.get("connected_by") or "")) else None
            c.update(account_id=_mask(conn.get("account_id")), client_id=_mask(conn.get("client_id")),
                     connected_by=(u or {}).get("name") or ((u or {}).get("email") or "").split("@")[0] or None,
                     missing_scopes=missing_scopes(conn.get("scopes")), test_error=conn.get("test_error"),
                     last_error=st.get("last_error"))
        out["connection"] = c
    if admin:
        teams = await db[T.TEAMS].find({"workspace_id": workspace_id, "general": {"$ne": True}}, {"name": 1, "visibility": 1}) \
            .sort("name", 1).to_list(length=T.MAX_TEAMS + 10)
        out["teams"] = [{"id": str(t["_id"]), "name": t.get("name"), "visibility": t.get("visibility") or "open"} for t in teams]
    if connected and team is not None:
        out["can_import"] = await can_import(db, user, workspace_id, conn)
    if out["can_import"]:
        rows = await db[MEETINGS].find({"workspace_id": workspace_id}).sort("at", -1).limit(10).to_list(length=10)
        out["recent"] = [{"uuid": r.get("uuid"), "topic": r.get("topic"), "date": r.get("date"), "state": r.get("state"),
                          "reason": r.get("reason"), "slug": r.get("slug"), "host": (r.get("host") or {}).get("name"),
                          "via": r.get("via"), "at": iso(r.get("at"))} for r in rows]
    return out
