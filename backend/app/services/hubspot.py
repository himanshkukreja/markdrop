"""HubSpot: a workspace's team calls written up in HubSpot (Phase 1, owner decisions 2026-11-17,
brief .work/briefs/hubspot-v1.md).

    routers/hubspot.py        /api/v1/hubspot/… (Integrations › HubSpot, the meeting panel)
    mcp/hubspot_tools.py      hubspot_status, hubspot_match, log_to_hubspot, hubspot_tasks
    services/hubspot_api.py   HubSpot's REST calls (tests: tests/_hubspot_fake.py)
    scripts/hubspot_match_report.py   the read-only dry run of the matching

**Who does what.** HubSpot's own Zoom connection keeps *booking* (a scheduling link makes a HubSpot meeting
on the contact/deal); Markdrop *writes up* the call into that same HubSpot meeting. Never a duplicate:
the booked meeting is filled, and a meeting Markdrop logged or created is remembered and updated.

**Connection** (one HubSpot account per workspace, one workspace per HubSpot account): a workspace admin
pastes a HubSpot *service key* (Development › Keys › Service keys) or an existing legacy *private app*
token, and picks the team (Sales). Fernet-encrypted (utils/crypto). Saving checks it: the account (portal
id, its UI domain and time zone) and the scopes (HubSpot's token info, else a cheap read per scope; the
write scope can't be checked without writing and is reported as unchecked). ``mode`` is "token" (a
public OAuth app can be added later as "oauth"). Disconnect deletes the token, the account's cached
owners and stages, and every meeting's match; the ids of the HubSpot records Markdrop wrote stay on the
meetings (no content), so reconnecting the same account updates them instead of duplicating.

**Which meetings.** Only meetings of the workspace that are in the connected team (``team_ids``), and only
for people who can read the meeting (``meetings.for_read``) and are in that team (or workspace admins).
Nothing of a meeting outside the team, or of another workspace, is ever sent.

**Matching** (:func:`match`), stored on the meeting row (``hubspot.match``):
  (a) "meeting": the HubSpot meeting whose owner is the Markdrop host (owner matched by email) and that
      starts within ±15 min of the call (the call's day when only its date is known, and then only when
      it's the owner's one meeting that day) → its contacts, companies and deal. Confidence high.
  (b) "contacts": attendee emails → contacts → their companies → open deals (most recently active).
      Medium with one open deal, low with several (the others are offered) or none. "names": the same
      from attendees' full names (exactly one contact each), low.
  (c) "none": a person picks the deal (deal search), "user", high.
A person's pick is never replaced by an automatic match; Match again re-runs it on request.

**Log to HubSpot** (:func:`log_meeting`): the summary, next steps and decisions, with links to the
Markdrop page (and its recording), go into the HubSpot meeting's *internal notes*
(``hs_internal_meeting_notes``), never the attendee-facing body (``hs_meeting_body``); a rep's own
internal notes are kept (Markdrop's block between its two marker lines is replaced). The matched meeting
is filled, or one is created (associated to the contacts, company and deal). Idempotent: the HubSpot
meeting id is remembered (``hubspot.logged``). *Log calls automatically* (off by default) logs a
meeting after its summary is written when the match is high-confidence (not past meetings imported in
bulk, which are ``history``).

**Tasks** (:func:`proposals`, :func:`create_tasks`): the meeting's action items (Google's next steps and
the AI's), each with a due date (said in the call, resolved against its date; else 3 days after) and an
owner (the person named, matched by email to a HubSpot user; else the deal's owner; else the host's).
A person ticks and approves; each task is claimed before it is created (``hubspot.tasks.<key>``) so a
double click never makes two.

Collections
    hubspot_connections  _id = workspace id: mode, token_enc, portal_id, ui_domain, time_zone, currency,
                         scopes, scopes_from (token_info | probe), unchecked, team_id, auto_log,
                         connected_by, connected_at, checked_at, broken, last_error, stats {logged,
                         created, tasks, auto}, owners [{id, email, name}] + owners_at,
                         stages [{id, label, pipeline, closed}] + stages_at (caches)
    meetings.hubspot     match {portal_id, how, confidence, meeting_id, deal_id, contact_ids, company_ids,
                         candidates, at, by}; logged {portal_id, meeting_id, created, at, by, auto};
                         tasks {<key>: {state, id, portal_id, at, by}}; logging_at (the claim)
"""

from __future__ import annotations

import asyncio
import hashlib
import html
import logging
import re
import time as _time
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.services import hubspot_api
from app.services.hubspot_api import ASSOC, HubSpotError
from app.utils import crypto

log = logging.getLogger("markdrop.hubspot")

CONNS = "hubspot_connections"

# What Markdrop needs. HubSpot has no separate public scopes for meetings and tasks: its activities are
# read and written with the contacts scopes.
SCOPES: list[dict] = [
    {"scope": "crm.objects.contacts.read", "required": True,
     "why": "Find attendees' contacts, and read the meetings and tasks on them (HubSpot covers activities with the contacts scopes)"},
    {"scope": "crm.objects.contacts.write", "required": True,
     "why": "Write the call into the HubSpot meeting and create tasks (HubSpot covers activities with the contacts scopes)"},
    {"scope": "crm.objects.companies.read", "required": True, "why": "See the contacts' companies"},
    {"scope": "crm.objects.deals.read", "required": True, "why": "Find the deal, its stage, amount and close date"},
    {"scope": "crm.objects.owners.read", "required": True,
     "why": "Match the call's host to their HubSpot user, and assign tasks"},
    # Phase 2: Apply on a suggested deal update (never automatic). Optional: everything else works without it.
    {"scope": "crm.objects.deals.write", "required": False,
     "why": "Apply a suggested deal update (stage, close date, amount, next step) when someone approves it"},
    # Deal folders (services/hubspot_folders.py): optional reads; without them the deal's emails and attachment
    # names are left out and the deal overview says what to add.
    {"scope": "sales-email-read", "required": False,
     "why": "Show what the deal's emails say (subject and a short preview) in its deal folder"},
    {"scope": "files.ui_hidden.read", "required": False,
     "why": "Show the names of the files attached to the deal's activity (they open in HubSpot)"},
]
# Read checks for a token HubSpot's token info doesn't describe (a service key): one cheap read per scope.
PROBES = [("crm.objects.owners.read", "crm/v3/owners"), ("crm.objects.contacts.read", "crm/v3/objects/contacts"),
          ("crm.objects.companies.read", "crm/v3/objects/companies"), ("crm.objects.deals.read", "crm/v3/objects/deals")]
UNPROBED = ["crm.objects.contacts.write", "crm.objects.deals.write", "sales-email-read", "files.ui_hidden.read"]

WINDOW = timedelta(minutes=15)
CACHE_TTL = timedelta(hours=6)
RETRIES = 4
SLEEP_CAP = 10.0          # the longest wait in-line for a retry (tests: 0)
PACE = 0.12               # seconds between calls per workspace (~8/s; HubSpot: 100+ per 10 s per app)
SEARCH_PACE = 0.3         # seconds between searches (HubSpot: 5 per second per account)
LOG_CLAIM = timedelta(minutes=2)
MAX_CONTACTS = 8
MAX_EMAILS = 50
MAX_NAMES = 8
MAX_CANDIDATES = 5
DUE_DAYS = 3
MARK_START = "Call notes from Markdrop"
MARK_END = "End of Markdrop notes"
_TOKEN = re.compile(r"^[\x21-\x7e]{10,600}$")
_ID = re.compile(r"^[0-9]{1,20}$")
DEAL_PROPS = ["dealname", "dealstage", "pipeline", "amount", "closedate", "hubspot_owner_id", "hs_lastmodifieddate",
              "hs_is_closed", "deal_currency_code"]
MEETING_PROPS = ["hs_meeting_title", "hs_meeting_start_time", "hs_meeting_end_time", "hubspot_owner_id", "hs_timestamp"]
CONFIDENCE = ("high", "medium", "low", "none")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: Any) -> datetime | None:
    if not isinstance(dt, datetime):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def iso(dt: Any) -> str | None:
    dt = _aware(dt)
    return dt.isoformat().replace("+00:00", "Z") if dt else None


def _ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def _from_hs_time(v: Any) -> datetime | None:
    """HubSpot datetimes come as ISO strings (search, objects) or epoch milliseconds."""
    if v in (None, ""):
        return None
    s = str(v)
    if s.isdigit():
        return datetime.fromtimestamp(int(s) / 1000, tz=timezone.utc)
    try:
        return _aware(datetime.fromisoformat(s.replace("Z", "+00:00")))
    except ValueError:
        return None


def configured() -> bool:
    """HubSpot works on this server when secrets can be stored encrypted."""
    return crypto.is_configured()


def is_connected(conn: dict | None) -> bool:
    return bool(conn and conn.get("token_enc"))


def mode_of(conn: dict | None) -> str | None:
    return (conn.get("mode") or "token") if conn else None


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[CONNS].create_index("portal_id", unique=True, sparse=True)
    from app.services import hubspot_accounts, hubspot_folders, hubspot_notify

    await hubspot_accounts.ensure_indexes(db)
    await hubspot_folders.ensure_indexes(db)
    await hubspot_notify.ensure_indexes(db)


async def get(db: AsyncIOMotorDatabase, workspace_id: str) -> dict | None:
    return await db[CONNS].find_one({"_id": str(workspace_id)}) if workspace_id else None


# ── Background work ───────────────────────────────────────────────────────────

_bg: set[asyncio.Task] = set()
_pace: dict[str, list[float]] = {}
_pace_locks: dict[str, asyncio.Lock] = {}


def spawn(coro) -> asyncio.Task:
    task = asyncio.create_task(coro)
    _bg.add(task)
    task.add_done_callback(_bg.discard)
    task.add_done_callback(lambda t: (not t.cancelled() and t.exception() is not None
                                      and log.warning("hubspot: background work failed: %r", t.exception())))
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


# ── Who may do what ───────────────────────────────────────────────────────────


async def role_of(db: AsyncIOMotorDatabase, user, workspace_id: str) -> str:
    from app.services import workspace as ws_service

    if not workspace_id or not ObjectId.is_valid(workspace_id):
        raise HTTPException(status_code=404, detail="Workspace not found")
    return await ws_service.require_role(db, workspace_id, user.id, "viewer")


async def require_admin(db: AsyncIOMotorDatabase, user, workspace_id: str) -> None:
    from app.services import workspace as ws_service

    if not workspace_id or not ObjectId.is_valid(workspace_id):
        raise HTTPException(status_code=404, detail="Workspace not found")
    await ws_service.require_role(db, workspace_id, user.id, "admin")


async def _team(db: AsyncIOMotorDatabase, workspace_id: str, team_id: str | None) -> dict | None:
    from app.services import teams as T

    oid = T.oid(team_id) if team_id else None
    return await db[T.TEAMS].find_one({"_id": oid, "workspace_id": workspace_id}) if oid else None


async def _check_team(db: AsyncIOMotorDatabase, workspace_id: str, team_id: str) -> dict:
    team = await _team(db, workspace_id, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Team not found")
    if team.get("general"):
        raise HTTPException(status_code=422, detail="Pick a team other than the company-wide one: HubSpot works with one team's calls.")
    return team


async def can_use(db: AsyncIOMotorDatabase, user_id: str | None, conn: dict) -> bool:
    """The connected team's members, and workspace admins."""
    from app.models.workspace import role_allows
    from app.services import workspace as ws_service

    if not user_id:
        return False
    if role_allows(await ws_service.role_for(db, conn["_id"], user_id), "admin"):
        return True
    team = await _team(db, conn["_id"], conn.get("team_id"))
    return bool(team and user_id in (team.get("member_ids") or []))


def in_scope(row: dict, conn: dict | None) -> bool:
    """A meeting HubSpot may see: this workspace's, in the connected team."""
    return bool(is_connected(conn) and conn.get("team_id") and row.get("workspace_id") == conn["_id"]
                and conn["team_id"] in (row.get("team_ids") or []))


# ── Calls ─────────────────────────────────────────────────────────────────────


class Unavailable(Exception):
    """HubSpot can't be used with this workspace's token now (rejected, or a scope is missing)."""


async def _sleep(seconds: float) -> None:
    await asyncio.sleep(seconds)


async def _wait_turn(key: str, search: bool) -> None:
    gap = SEARCH_PACE if search else PACE
    if gap <= 0:
        return
    lk = _pace_locks.setdefault(key, asyncio.Lock())
    async with lk:
        last = _pace.setdefault(key, [0.0, 0.0])
        i = 1 if search else 0
        wait = last[i] + gap - _time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        last[i] = _time.monotonic()


def token_of(conn: dict) -> str:
    return crypto.decrypt(conn["token_enc"])


#: What Markdrop may write to a customer's HubSpot (Senseloaf, 2026-11-17: never delete, never overwrite, never
#: change deals). Reads and searches; new meetings and tasks; adding links between records; a meeting's internal
#: notes (merge_notes keeps what people wrote there). A deal field only when the workspace turned on
#: ``deal_updates`` (off by default) and someone clicks Apply. Anything else is refused before it is sent.
_WRITE_OK = (
    ("POST", re.compile(r"^crm/v3/objects/(meetings|tasks)$")),
    ("PUT", re.compile(r"^crm/v4/objects/[a-z_]+/\d+/associations/default/[a-z_]+/\d+$")),
)
_MEETING = re.compile(r"^crm/v3/objects/meetings/\d+$")
_DEAL = re.compile(r"^crm/v3/objects/deals/\d+$")


def guard(conn: dict, method: str, path: str, json: Any = None) -> None:
    """Raise unless this request is one Markdrop is allowed to make in HubSpot (:data:`_WRITE_OK`)."""
    m, p = method.upper(), path.strip("/").split("?", 1)[0]
    if m == "GET" or (m == "POST" and (p.endswith("/search") or p.endswith("/batch/read"))):
        return
    if any(m == wm and rx.match(p) for wm, rx in _WRITE_OK):
        return
    props = set(((json or {}).get("properties") or {}) if isinstance(json, dict) else {})
    if m == "PATCH" and _MEETING.match(p) and props and props <= {"hs_internal_meeting_notes"}:
        return
    if m == "PATCH" and _DEAL.match(p) and props and switch(conn, "deal_updates"):
        return
    log.warning("hubspot: refused %s %s for %s (not an allowed write)", m, p, conn.get("_id"))
    raise HubSpotError(409, "Markdrop doesn't make this change in HubSpot: it never deletes or overwrites records there.",
                       category="MARKDROP_GUARD")


async def call(db: AsyncIOMotorDatabase | None, conn: dict, method: str, path: str, *, params: dict | None = None,
               json: Any = None) -> Any:
    """A REST call with the workspace's token: paced, and retried on 429/5xx with HubSpot's Retry-After or
    an exponential backoff (up to :data:`RETRIES` times). A rejected token marks the connection broken.
    Every write passes :func:`guard` first."""
    guard(conn, method, path, json)
    search = path.rstrip("/").endswith("/search")
    tok = token_of(conn)
    for attempt in range(RETRIES + 1):
        await _wait_turn(str(conn.get("_id")), search)
        try:
            return await hubspot_api.api(method, path, tok, params=params, json=json)
        except HubSpotError as exc:
            if exc.retryable and attempt < RETRIES:
                await _sleep(min(SLEEP_CAP, float(exc.retry_after) if exc.retry_after else 0.5 * (2 ** attempt)))
                continue
            if exc.auth and db is not None and not conn.get("_dry"):
                await db[CONNS].update_one({"_id": conn["_id"]}, {"$set": {"broken": "token", "last_error": "HubSpot no longer accepts the token."}})
                conn["broken"] = "token"
            raise
    raise HubSpotError(429, "HubSpot asked Markdrop to slow down.")


def _http_error(exc: HubSpotError) -> HTTPException:
    if exc.auth:
        return HTTPException(status_code=409, detail="HubSpot no longer accepts this workspace's token. An admin pastes a new one in Integrations › HubSpot.")
    if exc.scope:
        return HTTPException(status_code=409, detail="The HubSpot key is missing a scope Markdrop needs (Integrations › HubSpot lists them).")
    if exc.limited:
        return HTTPException(status_code=429, detail="HubSpot asked Markdrop to slow down. Try again in a minute.")
    if exc.missing:
        return HTTPException(status_code=404, detail="That record isn't in HubSpot any more.")
    if exc.status >= 500:
        return HTTPException(status_code=502, detail="HubSpot didn't answer. Try again in a minute.")
    return HTTPException(status_code=502, detail=f"HubSpot said: {exc.message or exc.status}")


# ── Connect ───────────────────────────────────────────────────────────────────


def missing_scopes(granted: list[str] | None, denied: list[str] | None = None) -> list[dict]:
    """The scopes the token lacks (None: HubSpot didn't say; nothing reported missing). ``denied``: scopes
    HubSpot refused since (a write that can't be checked in advance, e.g. Apply on a deal)."""
    if granted is None:
        granted = []
        if not denied:
            return []
    have = set(granted) - set(denied or [])
    return [{"scope": s["scope"], "why": s["why"], "required": s["required"]} for s in SCOPES if s["scope"] not in have]


async def check_token(token: str) -> dict:
    """What HubSpot says about a token: ``{portal_id, ui_domain, time_zone, currency, scopes, scopes_from,
    unchecked}``. Raises :class:`HubSpotError` (401: not accepted)."""
    info: dict | None = None
    try:
        info = await hubspot_api.token_info(token)
    except HubSpotError as exc:
        if exc.retryable:
            raise
        info = None          # a service key, or not a private app token: the account call decides
    portal, ui_domain, tz, currency = None, "app.hubspot.com", None, None
    try:
        acct = await hubspot_api.api("GET", "account-info/v3/details", token)
        portal = acct.get("portalId")
        ui_domain = str(acct.get("uiDomain") or ui_domain)
        tz, currency = acct.get("timeZone"), acct.get("companyCurrency")
    except HubSpotError as exc:
        if exc.auth or exc.retryable or not info:
            raise
    if portal is None and info:
        portal = info.get("hubId")
    if portal is None:
        raise HubSpotError(401, "HubSpot didn't say which account the token is for.")
    scopes: list[str] | None = None
    scopes_from, unchecked = "token_info", []
    if info and isinstance(info.get("scopes"), list):
        scopes = [str(s) for s in info["scopes"]]
    else:
        scopes_from, unchecked, scopes = "probe", list(UNPROBED), []
        for scope, path in PROBES:
            try:
                await hubspot_api.api("GET", path, token, params={"limit": 1})
                scopes.append(scope)
            except HubSpotError as exc:
                if exc.auth or exc.retryable:
                    raise
        scopes += unchecked     # can't be checked without writing: listed as unchecked, never as missing
    return {"portal_id": str(portal), "ui_domain": ui_domain.replace("https://", "").strip("/") or "app.hubspot.com",
            "time_zone": tz, "currency": currency, "scopes": scopes, "scopes_from": scopes_from, "unchecked": unchecked}


def _cred_message(exc: HubSpotError) -> str:
    if exc.limited:
        return "HubSpot asked Markdrop to slow down. Try again in a minute."
    if exc.status >= 500:
        return "HubSpot didn't answer. Try again in a minute."
    return ("HubSpot didn't accept the key. Copy it again from HubSpot (Development › Keys › Service keys, "
            "or the private app's Auth tab) and check it hasn't been rotated or deleted.")


async def connect(db: AsyncIOMotorDatabase, user, workspace_id: str, *, token: str | None,
                  team_id: str | None = None) -> dict:
    """Save (or replace) the workspace's HubSpot key after checking it with HubSpot."""
    await require_admin(db, user, workspace_id)
    if not configured():
        raise HTTPException(status_code=503, detail="HubSpot isn't available on this Markdrop server yet.")
    old = await get(db, workspace_id)
    tok = (token or "").strip() or (crypto.decrypt(old["token_enc"]) if old and old.get("token_enc") else "")
    if not _TOKEN.match(tok):
        raise HTTPException(status_code=422, detail="Paste the HubSpot service key (it starts with pat-).")
    if team_id:
        await _check_team(db, workspace_id, team_id)
    try:
        info = await check_token(tok)
    except HubSpotError as exc:
        log.info("hubspot connect: %s %s", exc.status, exc.message)
        raise HTTPException(status_code=400, detail=_cred_message(exc))
    other = await db[CONNS].find_one({"portal_id": info["portal_id"], "_id": {"$ne": str(workspace_id)}}, {"_id": 1})
    if other is not None:
        raise HTTPException(status_code=409, detail="That HubSpot account is connected to another Markdrop workspace. Disconnect it there first.")
    missing = missing_scopes(info["scopes"])
    now = now_utc()
    sets: dict[str, Any] = {
        "mode": "token", "token_enc": crypto.encrypt(tok), "portal_id": info["portal_id"], "ui_domain": info["ui_domain"],
        "time_zone": info["time_zone"], "currency": info["currency"], "scopes": info["scopes"],
        "scopes_from": info["scopes_from"], "unchecked": info["unchecked"],
        "broken": "missing_scopes" if any(m["required"] for m in missing) else None, "last_error": None, "denied": [],
        "checked_at": now, "updated_at": now, "owners": None, "owners_at": None, "stages": None, "stages_at": None,
    }
    if not old or not old.get("token_enc"):
        sets.update(connected_by=user.id, connected_at=now)
    if team_id is not None:
        sets["team_id"] = team_id or None
    try:
        await db[CONNS].update_one({"_id": str(workspace_id)}, {"$set": sets, "$setOnInsert": {"auto_log": False, "stats": {}}},
                                   upsert=True)
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="That HubSpot account is connected to another Markdrop workspace.")
    if old and old.get("portal_id") and old["portal_id"] != info["portal_id"]:
        await _forget_matches(db, workspace_id)      # another HubSpot account: the old matches mean nothing
    log.info("hubspot: workspace %s connected HubSpot account %s", workspace_id, info["portal_id"])
    return await status(db, user, workspace_id)


async def set_team(db: AsyncIOMotorDatabase, user, workspace_id: str, team_id: str) -> dict:
    await require_admin(db, user, workspace_id)
    conn = await get(db, workspace_id)
    if not is_connected(conn):
        raise HTTPException(status_code=404, detail="This workspace isn't connected to HubSpot.")
    await _check_team(db, workspace_id, team_id)
    await db[CONNS].update_one({"_id": str(workspace_id)}, {"$set": {"team_id": team_id, "updated_at": now_utc()}})
    return await status(db, user, workspace_id)


async def set_auto_log(db: AsyncIOMotorDatabase, user, workspace_id: str, on: bool) -> dict:
    return await set_settings(db, user, workspace_id, {"auto_log": on})


#: The workspace's switches and their defaults (Phase 2: every one that sends a message or uses AI can be
#: turned off by a workspace admin; each person can also turn off what reaches them, services/hubspot_notify).
SWITCHES = {"auto_log": False, "suggest": True, "accounts": True, "precall": True, "approve": True, "deal_updates": False}


def switch(conn: dict | None, key: str) -> bool:
    v = (conn or {}).get(key)
    return SWITCHES[key] if v is None else bool(v)


async def set_settings(db: AsyncIOMotorDatabase, user, workspace_id: str, changes: dict) -> dict:
    await require_admin(db, user, workspace_id)
    conn = await get(db, workspace_id)
    if not is_connected(conn):
        raise HTTPException(status_code=404, detail="This workspace isn't connected to HubSpot.")
    sets = {k: bool(v) for k, v in changes.items() if k in SWITCHES and v is not None}
    if sets:
        await db[CONNS].update_one({"_id": str(workspace_id)}, {"$set": {**sets, "updated_at": now_utc()}})
    return await status(db, user, workspace_id)


async def _forget_matches(db: AsyncIOMotorDatabase, workspace_id: str) -> int:
    from app.services import meetings

    res = await db[meetings.COLL].update_many({"workspace_id": str(workspace_id), "hubspot.match": {"$exists": True}},
                                              {"$unset": {"hubspot.match": "", "hubspot.logging_at": ""}})
    return res.modified_count


async def disconnect(db: AsyncIOMotorDatabase, user, workspace_id: str) -> dict:
    """Delete the token, the cached owners and stages, and every meeting's match. Notes and tasks already
    in HubSpot stay there (they're the company's records); Markdrop keeps only their ids."""
    await require_admin(db, user, workspace_id)
    await db[CONNS].delete_one({"_id": str(workspace_id)})
    n = await _forget_matches(db, workspace_id)
    from app.services import hubspot_deals, hubspot_folders

    await hubspot_deals.forget(db, workspace_id)       # the cached pipeline and the weekly stage snapshots
    await hubspot_folders.forget(db, workspace_id)     # the deals' cached HubSpot history (folders stay)
    log.info("hubspot: workspace %s disconnected HubSpot (%d matches forgotten)", workspace_id, n)
    return await status(db, user, workspace_id)


# ── HubSpot's lists (cached on the connection) ────────────────────────────────


async def _pages(db, conn: dict, path: str, params: dict | None = None, limit: int = 2000) -> list[dict]:
    out: list[dict] = []
    after = None
    while len(out) < limit:
        q = {**(params or {}), **({"after": after} if after else {})}
        got = await call(db, conn, "GET", path, params=q) or {}
        out += got.get("results") or []
        after = ((got.get("paging") or {}).get("next") or {}).get("after")
        if not after:
            break
    return out


async def owners(db, conn: dict) -> list[dict]:
    """HubSpot users who can own records: [{id, email, name}] (cached for a few hours)."""
    at = _aware(conn.get("owners_at"))
    if conn.get("owners") is not None and at and now_utc() - at < CACHE_TTL:
        return conn["owners"]
    rows = await _pages(db, conn, "crm/v3/owners", {"limit": 500, "archived": "false"})
    out = [{"id": str(o.get("id")), "email": (o.get("email") or "").lower() or None,
            "name": " ".join(x for x in (o.get("firstName"), o.get("lastName")) if x) or o.get("email") or None}
           for o in rows if o.get("id")]
    conn["owners"], conn["owners_at"] = out, now_utc()
    if db is not None and not conn.get("_dry"):
        await db[CONNS].update_one({"_id": conn["_id"]}, {"$set": {"owners": out, "owners_at": conn["owners_at"]}})
    return out


async def stages(db, conn: dict) -> list[dict]:
    """Deal stages: [{id, label, pipeline, pipeline_id, closed}] (cached for a few hours)."""
    at = _aware(conn.get("stages_at"))
    if conn.get("stages") is not None and at and now_utc() - at < CACHE_TTL:
        return conn["stages"]
    got = await call(db, conn, "GET", "crm/v3/pipelines/deals") or {}
    out = []
    for p in got.get("results") or []:
        for s in p.get("stages") or []:
            meta = s.get("metadata") or {}
            out.append({"id": str(s.get("id")), "label": s.get("label"), "pipeline": p.get("label"), "pipeline_id": str(p.get("id")),
                        "closed": str(meta.get("isClosed") or "").lower() == "true"})
    conn["stages"], conn["stages_at"] = out, now_utc()
    if db is not None and not conn.get("_dry"):
        await db[CONNS].update_one({"_id": conn["_id"]}, {"$set": {"stages": out, "stages_at": conn["stages_at"]}})
    return out


async def assoc(db, conn: dict, from_type: str, ids: list[str], to_type: str) -> dict[str, list[str]]:
    """{from id: [to ids]} through associations v4 (one id: the record's list; several: batch read)."""
    ids = [str(i) for i in dict.fromkeys(ids) if i]
    if not ids:
        return {}
    if len(ids) == 1:
        got = await call(db, conn, "GET", f"crm/v4/objects/{from_type}/{ids[0]}/associations/{to_type}", params={"limit": 100}) or {}
        return {ids[0]: [str(r.get("toObjectId")) for r in got.get("results") or [] if r.get("toObjectId")]}
    got = await call(db, conn, "POST", f"crm/v4/associations/{from_type}/{to_type}/batch/read",
                     json={"inputs": [{"id": i} for i in ids[:100]]}) or {}
    out: dict[str, list[str]] = {}
    for r in got.get("results") or []:
        fid = str((r.get("from") or {}).get("id"))
        out[fid] = [str(t.get("toObjectId")) for t in r.get("to") or [] if t.get("toObjectId")]
    return out


async def batch_read(db, conn: dict, obj: str, ids: list[str], props: list[str]) -> list[dict]:
    ids = [str(i) for i in dict.fromkeys(ids) if i][:100]
    if not ids:
        return []
    got = await call(db, conn, "POST", f"crm/v3/objects/{obj}/batch/read",
                     json={"properties": props, "inputs": [{"id": i} for i in ids]}) or {}
    return got.get("results") or []


# ── Matching ──────────────────────────────────────────────────────────────────


def _tz(conn: dict) -> Any:
    try:
        return ZoneInfo(conn.get("time_zone")) if conn.get("time_zone") else timezone.utc
    except (ZoneInfoNotFoundError, ValueError):
        return timezone.utc


async def start_of(db: AsyncIOMotorDatabase, row: dict, conn: dict) -> tuple[datetime | None, bool]:
    """(when the call started, exact?): Zoom's start time; else the row's date and time in the HubSpot
    account's time zone; else its date (not exact)."""
    zid = (row.get("zoom") or {}).get("uuid")
    if zid:
        z = await db["zoom_meetings"].find_one({"_id": f"{row['workspace_id']}:{zid}"}, {"start_time": 1})
        st = _from_hs_time((z or {}).get("start_time"))
        if st:
            return st, True
    d = row.get("date")
    try:
        day = date.fromisoformat(str(d)) if d else None
    except ValueError:
        day = None
    if day is None:
        return None, False
    t = str(row.get("time") or "")
    if re.match(r"^\d{1,2}:\d{2}$", t):
        hh, mm = (int(x) for x in t.split(":"))
        return datetime(day.year, day.month, day.day, hh, mm, tzinfo=_tz(conn)).astimezone(timezone.utc), True
    return datetime(day.year, day.month, day.day, tzinfo=_tz(conn)).astimezone(timezone.utc), False


async def host_email_of(db: AsyncIOMotorDatabase, row: dict) -> str | None:
    """The call's host in Markdrop: Zoom's host, else the organizer, else who imported it."""
    zid = (row.get("zoom") or {}).get("uuid")
    if zid:
        z = await db["zoom_meetings"].find_one({"_id": f"{row['workspace_id']}:{zid}"}, {"host": 1})
        e = ((z or {}).get("host") or {}).get("email")
        if e:
            return e.lower()
    for uid in ((row.get("organizer") or {}).get("user_id"), row.get("imported_by") or row.get("created_by")):
        if uid and ObjectId.is_valid(str(uid)):
            u = await db["users"].find_one({"_id": ObjectId(str(uid))}, {"email": 1})
            if u and u.get("email"):
                return u["email"].lower()
    return None


async def _member_emails(db: AsyncIOMotorDatabase, workspace_id: str) -> set[str]:
    uids = [m["user_id"] for m in await db["memberships"].find({"workspace_id": workspace_id}, {"user_id": 1}).to_list(length=5000)]
    oids = [ObjectId(u) for u in uids if ObjectId.is_valid(str(u))]
    users = await db["users"].find({"_id": {"$in": oids}}, {"email": 1}).to_list(length=5000)
    return {(u.get("email") or "").lower() for u in users if u.get("email")}


def _deal_open(d: dict, stage_by: dict[str, dict]) -> bool:
    p = d.get("properties") or {}
    if str(p.get("hs_is_closed") or "").lower() == "true":
        return False
    st = stage_by.get(str(p.get("dealstage") or ""))
    return not (st and st.get("closed"))


def _recency(d: dict) -> float:
    p = d.get("properties") or {}
    dt = _from_hs_time(p.get("hs_lastmodifieddate")) or _from_hs_time(d.get("updatedAt"))
    return dt.timestamp() if dt else 0.0


async def _pick_deal(db, conn: dict, deal_ids: list[str]) -> tuple[dict | None, list[dict], int]:
    """(the deal, the others worth offering, how many are open) among ``deal_ids``: the open deal most
    recently active; else the most recent closed one."""
    deals = await batch_read(db, conn, "deals", deal_ids, DEAL_PROPS)
    if not deals:
        return None, [], 0
    stage_by = {s["id"]: s for s in await stages(db, conn)}
    open_ = sorted([d for d in deals if _deal_open(d, stage_by)], key=_recency, reverse=True)
    pool = open_ or sorted(deals, key=_recency, reverse=True)
    return pool[0], pool[1:MAX_CANDIDATES + 1], len(open_)


def _cand(d: dict) -> dict:
    return {"id": str(d.get("id")), "name": (d.get("properties") or {}).get("dealname")}


async def _deals_of(db, conn: dict, contact_ids: list[str], company_ids: list[str]) -> list[str]:
    ids: list[str] = []
    for got in (await assoc(db, conn, "contacts", contact_ids, "deals"), await assoc(db, conn, "companies", company_ids, "deals")):
        for v in got.values():
            ids += v
    return list(dict.fromkeys(ids))


async def _contacts_by_email(db, conn: dict, emails: list[str]) -> list[dict]:
    if not emails:
        return []
    got = await call(db, conn, "POST", "crm/v3/objects/contacts/search", json={
        "filterGroups": [{"filters": [{"propertyName": "email", "operator": "IN", "values": emails[:MAX_EMAILS]}]}],
        "properties": ["email", "firstname", "lastname"], "limit": 100}) or {}
    return got.get("results") or []


async def _contacts_by_name(db, conn: dict, names: list[str]) -> list[dict]:
    out: list[dict] = []
    for name in names[:MAX_NAMES]:
        parts = name.split()
        if len(parts) < 2:
            continue
        got = await call(db, conn, "POST", "crm/v3/objects/contacts/search", json={
            "filterGroups": [{"filters": [{"propertyName": "firstname", "operator": "EQ", "value": parts[0]},
                                          {"propertyName": "lastname", "operator": "EQ", "value": " ".join(parts[1:])}]}],
            "properties": ["email", "firstname", "lastname"], "limit": 2}) or {}
        res = got.get("results") or []
        if len(res) == 1:
            out.append(res[0])
    return out


async def match(db: AsyncIOMotorDatabase, conn: dict, row: dict, *, by: str | None = None,
                persist: bool = True) -> dict:
    """Find the call in HubSpot (a, b, c in the module doc). ``persist=False``: nothing is written (the
    dry run). Never replaces a person's pick unless ``by`` is given (Match again)."""
    m = await _match(db, conn, row)
    m.update(portal_id=conn["portal_id"], at=now_utc(), by=by)
    if persist:
        q: dict[str, Any] = {"_id": row["_id"]}
        if by is None:
            q["hubspot.match.how"] = {"$ne": "user"}
        await db[meetings_coll()].update_one(q, {"$set": {"hubspot.match": m}})
    return m


def meetings_coll() -> str:
    from app.services import meetings

    return meetings.COLL


async def _match(db: AsyncIOMotorDatabase, conn: dict, row: dict) -> dict:
    none = {"how": "none", "confidence": "none", "meeting_id": None, "deal_id": None, "contact_ids": [],
            "company_ids": [], "candidates": [], "detail": None}
    start, exact = await start_of(db, row, conn)
    host = await host_email_of(db, row)
    owner = next((o for o in await owners(db, conn) if host and o.get("email") == host), None)
    # (a) The meeting HubSpot booked: the host's, starting within ±15 min (or their only one that day).
    if owner and start:
        lo, hi = (start - WINDOW, start + WINDOW) if exact else (start, start + timedelta(days=1))
        got = await call(db, conn, "POST", "crm/v3/objects/meetings/search", json={
            "filterGroups": [{"filters": [
                {"propertyName": "hubspot_owner_id", "operator": "EQ", "value": owner["id"]},
                {"propertyName": "hs_meeting_start_time", "operator": "BETWEEN", "value": str(_ms(lo)), "highValue": str(_ms(hi))}]}],
            "properties": MEETING_PROPS, "limit": 20}) or {}
        res = got.get("results") or []
        if res and (exact or len(res) == 1):
            hs = min(res, key=lambda r: abs(((_from_hs_time((r.get("properties") or {}).get("hs_meeting_start_time")) or start) - start).total_seconds()))
            hid = str(hs["id"])
            contacts = (await assoc(db, conn, "meetings", [hid], "contacts")).get(hid, [])
            companies = (await assoc(db, conn, "meetings", [hid], "companies")).get(hid, [])
            deal_ids = (await assoc(db, conn, "meetings", [hid], "deals")).get(hid, [])
            from_contacts = False
            if not deal_ids and (contacts or companies):
                deal_ids, from_contacts = await _deals_of(db, conn, contacts[:MAX_CONTACTS], companies[:3]), True
            deal, others, _n_open = await _pick_deal(db, conn, deal_ids)
            if not companies and contacts:
                companies = list(dict.fromkeys(c for v in (await assoc(db, conn, "contacts", contacts[:MAX_CONTACTS], "companies")).values() for c in v))
            title = (hs.get("properties") or {}).get("hs_meeting_title")
            return {**none, "how": "meeting", "confidence": "high", "meeting_id": hid, "deal_id": str(deal["id"]) if deal else None,
                    "contact_ids": contacts[:MAX_CONTACTS], "company_ids": companies[:3], "candidates": [_cand(d) for d in others],
                    "detail": f"HubSpot meeting “{title or 'Meeting'}”" + (" (deal through its contacts)" if from_contacts and deal else "")}
    # (b) Attendees → contacts → companies → open deals.
    members = await _member_emails(db, row["workspace_id"])
    people = [*(row.get("attendees") or []), *(row.get("invited") or [])]
    emails = list(dict.fromkeys((p.get("email") or "").lower() for p in people
                                if p.get("email") and (p.get("email") or "").lower() not in members and not p.get("user_id")))
    contacts = await _contacts_by_email(db, conn, emails)
    how = "contacts"
    if not contacts:
        names = list(dict.fromkeys(p["name"] for p in people if p.get("name") and not p.get("user_id") and not p.get("email")))
        contacts, how = await _contacts_by_name(db, conn, names), "names"
    if not contacts:
        return none
    cids = [str(c["id"]) for c in contacts][:MAX_CONTACTS]
    companies = list(dict.fromkeys(c for v in (await assoc(db, conn, "contacts", cids, "companies")).values() for c in v))[:3]
    deal, others, n_open = await _pick_deal(db, conn, await _deals_of(db, conn, cids, companies))
    conf = "medium" if (how == "contacts" and deal is not None and n_open == 1) else "low"
    detail = (f"{len(cids)} attendee{'s' if len(cids) != 1 else ''} found in HubSpot by "
              + ("email" if how == "contacts" else "name")
              + ("" if deal else ", no open deal") + (f"; {n_open} open deals, the latest picked" if n_open > 1 else ""))
    return {**none, "how": how, "confidence": conf, "deal_id": str(deal["id"]) if deal else None, "contact_ids": cids,
            "company_ids": companies, "candidates": [_cand(d) for d in others], "detail": detail}


async def set_match(db: AsyncIOMotorDatabase, user, actor, ctx, meeting_id: str, deal_id: str | None) -> dict:
    """A person's pick (Change match): the deal (its contacts and company come with it), or none. The
    HubSpot meeting found for the call (if any) stays the one Log fills."""
    row, conn = await _usable(db, user, actor, ctx, meeting_id)
    old = (row.get("hubspot") or {}).get("match") or {}
    keep = old.get("meeting_id") if old.get("portal_id") == conn["portal_id"] else None
    m: dict[str, Any] = {"how": "user", "confidence": "high" if deal_id else "none", "meeting_id": keep, "deal_id": None,
                         "contact_ids": [], "company_ids": [], "candidates": [], "detail": None,
                         "portal_id": conn["portal_id"], "at": now_utc(), "by": user.id}
    if deal_id:
        if not _ID.match(str(deal_id)):
            raise HTTPException(status_code=422, detail="Pick a deal from the search.")
        try:
            deals = await batch_read(db, conn, "deals", [deal_id], DEAL_PROPS)
            if not deals:
                raise HTTPException(status_code=404, detail="That deal isn't in HubSpot.")
            m["deal_id"] = str(deals[0]["id"])
            m["contact_ids"] = (await assoc(db, conn, "deals", [m["deal_id"]], "contacts")).get(m["deal_id"], [])[:MAX_CONTACTS]
            m["company_ids"] = (await assoc(db, conn, "deals", [m["deal_id"]], "companies")).get(m["deal_id"], [])[:3]
        except HubSpotError as exc:
            raise _http_error(exc)
    else:
        m["confidence"] = "none"
        m["meeting_id"] = None
    await db[meetings_coll()].update_one({"_id": row["_id"]}, {"$set": {"hubspot.match": m}})
    from app.services import hubspot_folders

    await hubspot_folders.file_call(db, conn, await db[meetings_coll()].find_one({"_id": row["_id"]}) or row)
    return await panel(db, user, actor, ctx, meeting_id)


async def rematch(db: AsyncIOMotorDatabase, user, actor, ctx, meeting_id: str) -> dict:
    row, conn = await _usable(db, user, actor, ctx, meeting_id)
    try:
        await match(db, conn, row, by=user.id)
    except HubSpotError as exc:
        raise _http_error(exc)
    from app.services import hubspot_folders

    hubspot_folders.file_soon(db, conn, meeting_id)
    return await panel(db, user, actor, ctx, meeting_id)


async def search_deals(db: AsyncIOMotorDatabase, user, workspace_id: str, q: str) -> dict:
    conn = await get(db, workspace_id)
    await role_of(db, user, workspace_id)
    if not is_connected(conn):
        raise HTTPException(status_code=404, detail="This workspace isn't connected to HubSpot.")
    if not await can_use(db, user.id, conn):
        raise HTTPException(status_code=403, detail="The HubSpot team's members and workspace admins use HubSpot here.")
    q = " ".join((q or "").split())[:100]
    body: dict[str, Any] = {"properties": DEAL_PROPS, "limit": 10,
                            "sorts": [{"propertyName": "hs_lastmodifieddate", "direction": "DESCENDING"}]}
    if q:
        body["query"] = q
    try:
        got = await call(db, conn, "POST", "crm/v3/objects/deals/search", json=body) or {}
        stage_by = {s["id"]: s for s in await stages(db, conn)}
    except HubSpotError as exc:
        raise _http_error(exc)
    return {"deals": [_deal_view(conn, d, stage_by, {}) for d in got.get("results") or []]}


# ── The meeting panel ─────────────────────────────────────────────────────────


def record_url(conn: dict, kind: str, rid: str | None) -> str | None:
    """A record in HubSpot's app: 0-1 contacts, 0-2 companies, 0-3 deals."""
    if not rid:
        return None
    t = {"contact": "0-1", "company": "0-2", "deal": "0-3"}[kind]
    return f"https://{conn.get('ui_domain') or 'app.hubspot.com'}/contacts/{conn['portal_id']}/record/{t}/{rid}"


def _deal_view(conn: dict, d: dict, stage_by: dict[str, dict], owner_by: dict[str, dict]) -> dict:
    p = d.get("properties") or {}
    st = stage_by.get(str(p.get("dealstage") or "")) or {}
    amt = p.get("amount")
    try:
        amount = float(amt) if amt not in (None, "") else None
    except ValueError:
        amount = None
    close = _from_hs_time(p.get("closedate"))
    return {"id": str(d.get("id")), "name": p.get("dealname") or "Untitled deal",
            "stage": st.get("label") or p.get("dealstage"), "pipeline": st.get("pipeline"),
            "closed": not _deal_open(d, stage_by), "amount": amount,
            "currency": p.get("deal_currency_code") or conn.get("currency"),
            "close_date": close.date().isoformat() if close else None,
            "owner": (owner_by.get(str(p.get("hubspot_owner_id") or "")) or {}).get("name"),
            "owner_id": str(p.get("hubspot_owner_id")) if p.get("hubspot_owner_id") else None,
            "url": record_url(conn, "deal", str(d.get("id")))}


async def _usable(db: AsyncIOMotorDatabase, user, actor, ctx, meeting_id: str) -> tuple[dict, dict]:
    """(row, conn) when the person can read the meeting, it's in the connected team and they may use
    HubSpot; else the reason as an HTTP error."""
    from app.services import meetings

    row, _raw = await meetings.for_read(db, meeting_id, actor, ctx)
    conn = await get(db, row["workspace_id"])
    if not is_connected(conn):
        raise HTTPException(status_code=404, detail="This workspace isn't connected to HubSpot.")
    if not in_scope(row, conn):
        raise HTTPException(status_code=409, detail="Only the HubSpot team's meetings go to HubSpot.")
    if not await can_use(db, user.id if user else None, conn):
        raise HTTPException(status_code=403, detail="The HubSpot team's members and workspace admins use HubSpot here.")
    return row, conn


async def panel(db: AsyncIOMotorDatabase, user, actor, ctx, meeting_id: str) -> dict:
    """The meeting page's HubSpot section: whether it applies, the match with the deal's details (fresh
    from HubSpot), the logged state and the proposed tasks."""
    from app.services import meetings

    row, _raw = await meetings.for_read(db, meeting_id, actor, ctx)
    conn = await get(db, row["workspace_id"])
    base: dict[str, Any] = {"available": False, "reason": None, "auto_log": False, "match": None, "deal": None,
                            "contacts": [], "companies": [], "logged": None, "tasks": [], "error": None,
                            "suggestions": None, "account": None}
    if not is_connected(conn):
        return {**base, "reason": "not_connected"}
    if not in_scope(row, conn):
        return {**base, "reason": "not_team"}
    if not await can_use(db, user.id if user else None, conn):
        return {**base, "reason": "not_member"}
    base.update(available=True, auto_log=bool(conn.get("auto_log")), broken=conn.get("broken"))
    hs = row.get("hubspot") or {}
    m = hs.get("match") if (hs.get("match") or {}).get("portal_id") == conn["portal_id"] else None
    try:
        if m is None:
            m = await match(db, conn, row)
        owner_by = {o["id"]: o for o in await owners(db, conn)}
        stage_by = {s["id"]: s for s in await stages(db, conn)}
        if m.get("deal_id"):
            ds = await batch_read(db, conn, "deals", [m["deal_id"]], DEAL_PROPS)
            base["deal"] = _deal_view(conn, ds[0], stage_by, owner_by) if ds else None
        cs = await batch_read(db, conn, "contacts", m.get("contact_ids") or [], ["email", "firstname", "lastname"])
        base["contacts"] = [{"id": str(c["id"]), "name": " ".join(x for x in ((c.get("properties") or {}).get("firstname"),
                                                                            (c.get("properties") or {}).get("lastname")) if x)
                             or (c.get("properties") or {}).get("email"), "email": (c.get("properties") or {}).get("email"),
                             "url": record_url(conn, "contact", str(c["id"]))} for c in cs]
        co = await batch_read(db, conn, "companies", m.get("company_ids") or [], ["name", "domain"])
        base["companies"] = [{"id": str(c["id"]), "name": (c.get("properties") or {}).get("name") or (c.get("properties") or {}).get("domain"),
                              "url": record_url(conn, "company", str(c["id"]))} for c in co]
        base["tasks"] = await proposals(db, conn, row, m, base.get("deal"))
    except HubSpotError as exc:
        base["error"] = _http_error(exc).detail
        base["tasks"] = await proposals(db, conn, row, m or {}, None, offline=True)
    base["match"] = _match_view(m) if m else None
    lg = hs.get("logged") if (hs.get("logged") or {}).get("portal_id") == conn["portal_id"] else None
    if lg:
        who = await _name_of(db, lg.get("by"))
        base["logged"] = {"at": iso(lg.get("at")), "by": who, "auto": bool(lg.get("auto")), "created": bool(lg.get("created")),
                          "meeting_id": lg.get("meeting_id"),
                          "url": (base["deal"] or {}).get("url") or (base["contacts"][0]["url"] if base["contacts"] else None)}
    base["portal_url"] = f"https://{conn.get('ui_domain') or 'app.hubspot.com'}"
    # Phase 2: suggested deal updates (services/hubspot_deals.py) and the account page (hubspot_accounts.py).
    from app.services import hubspot_accounts, hubspot_deals

    base["suggestions"] = hubspot_deals.suggestions_view(row, conn, m, switch(conn, "suggest"))
    base["account"] = await hubspot_accounts.link_for(db, conn, m)
    base["deals_write"] = ("missing" if "crm.objects.deals.write" in (conn.get("denied") or []) else
                           "granted" if "crm.objects.deals.write" in (conn.get("scopes") or []) and
                           "crm.objects.deals.write" not in (conn.get("unchecked") or []) else "unchecked")
    return base


def _match_view(m: dict) -> dict:
    return {"how": m.get("how"), "confidence": m.get("confidence"), "detail": m.get("detail"),
            "meeting_found": bool(m.get("meeting_id")), "deal_id": m.get("deal_id"),
            "candidates": m.get("candidates") or [], "at": iso(m.get("at")), "by_person": m.get("how") == "user"}


async def _name_of(db: AsyncIOMotorDatabase, uid: str | None) -> str | None:
    if not uid or not ObjectId.is_valid(str(uid)):
        return None
    u = await db["users"].find_one({"_id": ObjectId(str(uid))}, {"name": 1, "email": 1})
    return (u or {}).get("name") or ((u or {}).get("email") or "").split("@")[0] or None


# ── Log to HubSpot ────────────────────────────────────────────────────────────


_MD = re.compile(r"\*\*|__|`|\{#[^}]*\}")
_MDLINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")


def _plain(text: Any) -> str:
    t = _MDLINK.sub(r"\1", str(text or ""))
    return " ".join(_MD.sub("", t).split())


def _e(text: Any) -> str:
    return html.escape(_plain(text), quote=False)


def page_url(row: dict) -> str | None:
    from app.services import urls

    return urls.markdrop_url(row["slug"]) if row.get("slug") else None


def items_of(row: dict) -> list[dict]:
    """The meeting's action items: Google's next steps, then the AI's ({text, owner, due})."""
    out: list[dict] = []
    for step in (row.get("notes") or {}).get("next_steps") or []:
        if _plain(step):
            out.append({"text": _plain(step), "owner": None, "due": None})
    for it in (row.get("generated") or {}).get("action_items") or []:
        if _plain(it.get("text")):
            out.append({"text": _plain(it.get("text")), "owner": _plain(it.get("owner")) or None, "due": _plain(it.get("due")) or None})
    return out


def notes_html(row: dict) -> str:
    """The block Markdrop writes into the meeting's internal notes."""
    from app.services import meetings

    gen = row.get("generated") or {}
    notes = row.get("notes") or {}
    url = page_url(row)
    head = f"<p><strong>{MARK_START}</strong>"
    if url:
        head += f' · <a href="{html.escape(url)}">Open the meeting in Markdrop</a>'
        if meetings._recording_view(row):
            head += f' · <a href="{html.escape(url)}">Recording</a>'
    head += "</p>"
    parts = [head]
    summary = gen.get("summary") or notes.get("summary")
    if summary:
        parts.append("<p><strong>Summary</strong></p>")
        parts += [f"<p>{_e(p)}</p>" for p in str(summary).split("\n\n") if _plain(p)]
    steps = items_of(row)
    if steps:
        parts.append("<p><strong>Next steps</strong></p><ul>")
        for it in steps:
            extra = " · ".join(x for x in (it.get("owner"), f"due {it['due']}" if it.get("due") else None) if x)
            parts.append(f"<li>{_e(it['text'])}{f' ({_e(extra)})' if extra else ''}</li>")
        parts.append("</ul>")
    decisions = [d.get("text") if isinstance(d, dict) else d for d in gen.get("decisions") or []]
    decisions = [d for d in decisions if _plain(d)]
    if decisions:
        parts.append("<p><strong>Decisions</strong></p><ul>" + "".join(f"<li>{_e(d)}</li>" for d in decisions) + "</ul>")
    if not summary and not steps and not decisions:
        parts.append("<p>No summary yet: the notes are on the Markdrop page.</p>")
    parts.append(f"<p><em>{MARK_END}</em></p>")
    return "".join(parts)


def merge_notes(existing: str | None, block: str) -> str:
    """The meeting's internal notes with Markdrop's block in place of the previous one (a rep's own notes
    around it are kept), or after them the first time."""
    cur = existing or ""
    i = cur.find(MARK_START)
    if i < 0:
        return (cur + "<p></p>" + block) if _plain(re.sub(r"<[^>]+>", " ", cur)) else block
    start = cur.rfind("<p", 0, i)
    start = start if start >= 0 else i
    j = cur.find(MARK_END, i)
    if j < 0:
        end = len(cur)
    else:
        k = cur.find("</p>", j)
        end = k + 4 if k >= 0 else len(cur)
    return cur[:start] + block + cur[end:]


async def _host_owner(db, conn: dict, row: dict) -> str | None:
    host = await host_email_of(db, row)
    o = next((o for o in await owners(db, conn) if host and o.get("email") == host), None)
    return o["id"] if o else None


async def log_meeting(db: AsyncIOMotorDatabase, user, actor, ctx, meeting_id: str) -> dict:
    """Log to HubSpot (one click): see the module doc."""
    row, conn = await _usable(db, user, actor, ctx, meeting_id)
    await _log(db, conn, row, by=user.id, auto=False)
    return await panel(db, user, actor, ctx, meeting_id)


async def _log(db: AsyncIOMotorDatabase, conn: dict, row: dict, *, by: str | None, auto: bool) -> dict:
    from app.services import meetings

    now = now_utc()
    claimed = await db[meetings.COLL].find_one_and_update(
        {"_id": row["_id"], "$or": [{"hubspot.logging_at": {"$exists": False}}, {"hubspot.logging_at": {"$lt": now - LOG_CLAIM}}]},
        {"$set": {"hubspot.logging_at": now}}, return_document=ReturnDocument.AFTER)
    if claimed is None:
        raise HTTPException(status_code=409, detail="It's being logged to HubSpot right now.")
    try:
        row = claimed
        hs = row.get("hubspot") or {}
        try:
            m = hs.get("match") if (hs.get("match") or {}).get("portal_id") == conn["portal_id"] else None
            if m is None:
                m = await match(db, conn, row)
            if not (m.get("meeting_id") or m.get("deal_id") or m.get("contact_ids")):
                raise HTTPException(status_code=409, detail="Markdrop couldn't find this call in HubSpot. Pick the deal first.")
            block = notes_html(row)
            lg = hs.get("logged") if (hs.get("logged") or {}).get("portal_id") == conn["portal_id"] else None
            target = (lg or {}).get("meeting_id") or m.get("meeting_id")
            created = bool((lg or {}).get("created")) and target == (lg or {}).get("meeting_id")
            if target:
                try:
                    cur = await call(db, conn, "GET", f"crm/v3/objects/meetings/{target}",
                                     params={"properties": "hs_internal_meeting_notes"}) or {}
                    old_notes = (cur.get("properties") or {}).get("hs_internal_meeting_notes")
                    await call(db, conn, "PATCH", f"crm/v3/objects/meetings/{target}",
                               json={"properties": {"hs_internal_meeting_notes": merge_notes(old_notes, block)}})
                except HubSpotError as exc:
                    if not exc.missing:
                        raise
                    target = None       # deleted in HubSpot: a new one
            if not target:
                target = await _create_meeting(db, conn, row, m, block)
                created = True
            else:
                await _associate(db, conn, "meetings", target, m)
        except HubSpotError as exc:
            await db[CONNS].update_one({"_id": conn["_id"]}, {"$set": {"last_error": _http_error(exc).detail}})
            raise _http_error(exc)
        logged = {"portal_id": conn["portal_id"], "meeting_id": str(target), "created": created, "at": now_utc(), "by": by, "auto": auto}
        await db[meetings.COLL].update_one({"_id": row["_id"]}, {"$set": {"hubspot.logged": logged}})
        inc = {"stats.logged": 1, **({"stats.auto": 1} if auto else {}), **({"stats.created": 1} if created and not (lg or {}).get("created") else {})}
        await db[CONNS].update_one({"_id": conn["_id"]}, {"$inc": inc, "$set": {"stats.last_log_at": now_utc(), "last_error": None}})
        return logged
    finally:
        await db[meetings.COLL].update_one({"_id": row["_id"]}, {"$unset": {"hubspot.logging_at": ""}})


async def _create_meeting(db, conn: dict, row: dict, m: dict, block: str) -> str:
    start, _exact = await start_of(db, row, conn)
    start = start or now_utc()
    end = start + timedelta(seconds=int(row.get("duration_s") or 1800))
    props: dict[str, Any] = {"hs_timestamp": iso(start), "hs_meeting_start_time": iso(start), "hs_meeting_end_time": iso(end),
                             "hs_meeting_title": (row.get("title") or "Meeting")[:200], "hs_meeting_outcome": "COMPLETED",
                             "hs_internal_meeting_notes": block}
    owner = await _host_owner(db, conn, row)
    if owner:
        props["hubspot_owner_id"] = owner
    got = await call(db, conn, "POST", "crm/v3/objects/meetings", json={"properties": props, "associations": _assocs("meetings", m)})
    return str(got["id"])


def _assocs(obj: str, m: dict) -> list[dict]:
    out = []
    for kind, ids in (("deals", [m.get("deal_id")] if m.get("deal_id") else []), ("contacts", m.get("contact_ids") or []),
                      ("companies", m.get("company_ids") or [])):
        for i in ids[:MAX_CONTACTS]:
            out.append({"to": {"id": str(i)}, "types": [{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": ASSOC[(obj, kind)]}]})
    return out


async def _associate(db, conn: dict, obj: str, rid: str, m: dict) -> None:
    """The matched deal, contacts and company on an existing record (HubSpot ignores ones already there)."""
    for kind, ids in (("deals", [m.get("deal_id")] if m.get("deal_id") else []), ("contacts", m.get("contact_ids") or []),
                      ("companies", m.get("company_ids") or [])):
        for i in ids[:MAX_CONTACTS]:
            await call(db, conn, "PUT", f"crm/v4/objects/{obj}/{rid}/associations/default/{kind}/{i}")


# ── Tasks ─────────────────────────────────────────────────────────────────────


def task_key(text: str) -> str:
    return hashlib.sha1(_plain(text).casefold().encode("utf-8")).hexdigest()[:16]


def _due(row: dict, said: str | None) -> date:
    from app.services import workspace_memory

    try:
        base = date.fromisoformat(str(row.get("date")))
    except ValueError:
        base = now_utc().date()
    got = workspace_memory.resolve_due(said, base) if said else None
    if got is None and said:
        try:
            got = date.fromisoformat(said[:10])
        except ValueError:
            got = None
    return got or (base + timedelta(days=DUE_DAYS))


async def proposals(db: AsyncIOMotorDatabase, conn: dict, row: dict, m: dict, deal: dict | None, *,
                    offline: bool = False) -> list[dict]:
    """The action items as HubSpot tasks to approve: {key, text, owner_said, due, assignee, created}."""
    from app.services import meetings

    items = items_of(row)
    if not items:
        return []
    done = ((row.get("hubspot") or {}).get("tasks") or {})
    os_ = [] if offline else await owners(db, conn)
    by_email = {o["email"]: o for o in os_ if o.get("email")}
    people = await meetings.people_of(db, row["workspace_id"])
    host_owner = None if offline else await _host_owner(db, conn, row)
    fallback = (deal or {}).get("owner_id") or host_owner
    fb = next((o for o in os_ if o["id"] == fallback), None)
    out = []
    seen: set[str] = set()
    for it in items:
        key = task_key(it["text"])
        if key in seen:
            continue
        seen.add(key)
        assignee = None
        if it.get("owner"):
            mem = people.match(it["owner"])
            att = next((a for a in row.get("attendees") or [] if a.get("email") and a.get("name", "").casefold() == it["owner"].casefold()), None)
            email = ((mem or {}).get("email") or (att or {}).get("email") or "").lower()
            o = by_email.get(email)
            if o:
                assignee = {"owner_id": o["id"], "name": o.get("name"), "from": "named"}
        if assignee is None and fb:
            assignee = {"owner_id": fb["id"], "name": fb.get("name"), "from": "deal_owner" if fallback == (deal or {}).get("owner_id") else "host"}
        t = done.get(key)
        created = None
        if isinstance(t, dict) and t.get("id") and t.get("portal_id") == conn["portal_id"]:
            created = {"id": t["id"], "at": iso(t.get("at"))}
        out.append({"key": key, "text": it["text"], "owner_said": it.get("owner"), "due": _due(row, it.get("due")).isoformat(),
                    "due_said": it.get("due"), "assignee": assignee, "created": created,
                    "pending": isinstance(t, dict) and t.get("state") == "pending"})
    return out


async def create_tasks(db: AsyncIOMotorDatabase, user, actor, ctx, meeting_id: str, keys: list[str]) -> dict:
    """Create the approved tasks (by key): each once, associated to the deal and contacts."""
    from app.services import meetings

    row, conn = await _usable(db, user, actor, ctx, meeting_id)
    hs = row.get("hubspot") or {}
    m = hs.get("match") if (hs.get("match") or {}).get("portal_id") == conn["portal_id"] else None
    try:
        if m is None:
            m = await match(db, conn, row)
        deal = None
        if m.get("deal_id"):
            ds = await batch_read(db, conn, "deals", [m["deal_id"]], DEAL_PROPS)
            deal = _deal_view(conn, ds[0], {}, {}) if ds else None
        props = {p["key"]: p for p in await proposals(db, conn, row, m, deal)}
    except HubSpotError as exc:
        raise _http_error(exc)
    want = [k for k in dict.fromkeys(keys) if k in props]
    if not want:
        raise HTTPException(status_code=422, detail="Pick the action items to send to HubSpot.")
    url = page_url(row)
    title = row.get("title") or "Meeting"
    results = []
    for key in want:
        p = props[key]
        if p["created"]:
            results.append({"key": key, "status": "exists", "id": p["created"]["id"]})
            continue
        f = f"hubspot.tasks.{key}"
        claim = await db[meetings.COLL].update_one(
            {"_id": row["_id"], "$or": [{f: {"$exists": False}}, {f"{f}.state": "failed"},
                                        {f"{f}.portal_id": {"$ne": conn["portal_id"]}, f"{f}.state": {"$ne": "pending"}}]},
            {"$set": {f: {"state": "pending", "portal_id": conn["portal_id"], "at": now_utc(), "by": user.id}}})
        if claim.modified_count == 0:
            results.append({"key": key, "status": "exists"})
            continue
        due = datetime.combine(date.fromisoformat(p["due"]), datetime.min.time(), tzinfo=timezone.utc) + timedelta(hours=12)
        body = f"<p>From the call “{html.escape(title)}” on {html.escape(str(row.get('date') or ''))}.</p>"
        if url:
            body += f'<p><a href="{html.escape(url)}">Open the meeting in Markdrop</a></p>'
        tprops: dict[str, Any] = {"hs_timestamp": iso(due), "hs_task_subject": p["text"][:250], "hs_task_body": body,
                                  "hs_task_status": "NOT_STARTED", "hs_task_type": "TODO"}
        if p.get("assignee"):
            tprops["hubspot_owner_id"] = p["assignee"]["owner_id"]
        try:
            got = await call(db, conn, "POST", "crm/v3/objects/tasks", json={"properties": tprops, "associations": _assocs("tasks", m)})
        except HubSpotError as exc:
            await db[meetings.COLL].update_one({"_id": row["_id"]}, {"$set": {f: {"state": "failed", "portal_id": conn["portal_id"],
                                                                                  "at": now_utc(), "error": exc.message[:200]}}})
            results.append({"key": key, "status": "failed", "reason": _http_error(exc).detail})
            continue
        await db[meetings.COLL].update_one({"_id": row["_id"]}, {"$set": {f: {
            "state": "created", "id": str(got["id"]), "portal_id": conn["portal_id"], "at": now_utc(), "by": user.id}}})
        await db[CONNS].update_one({"_id": conn["_id"]}, {"$inc": {"stats.tasks": 1}})
        results.append({"key": key, "status": "created", "id": str(got["id"])})
    out = await panel(db, user, actor, ctx, meeting_id)
    out["results"] = results
    return out


# ── Automatically (the workspace's switch) ────────────────────────────────────


async def meeting_ready(db: AsyncIOMotorDatabase, meeting_id: str) -> None:
    """The hook in meetings_ai after a meeting's summary is written, for the HubSpot team's meetings (never
    raises; runs in the background):

    * *Log calls automatically* (off by default): log it when it's not a bulk-imported past meeting and
      matched with high confidence.
    * Phase 2 (each behind a workspace switch, and never for past meetings): the suggested deal updates
      (services/hubspot_deals.py, one AI call; never applied without a person), the call filed into its
      deal's folder (services/hubspot_folders.py; company account pages are no longer made: Deals replaced
      them), and the host's Slack message with Log / Create tasks buttons (services/hubspot_notify.py)."""
    if not configured():
        return
    from app.services import meetings

    row = await meetings.get_row(db, meeting_id)
    if row is None or row.get("history"):
        return
    conn = await get(db, row["workspace_id"])
    if not (conn and in_scope(row, conn) and not conn.get("broken")):
        return

    async def go() -> None:
        from app.services import hubspot_deals, hubspot_folders, hubspot_notify

        try:
            r = await meetings.get_row(db, meeting_id)
            if r is None:
                return
            hs = r.get("hubspot") or {}
            m = hs.get("match") if (hs.get("match") or {}).get("portal_id") == conn["portal_id"] else None
            if m is None:
                m = await match(db, conn, r)
        except Exception:
            log.warning("hubspot: matching %s failed", meeting_id, exc_info=True)
            return
        if conn.get("auto_log") and m.get("confidence") == "high":
            try:
                await _log(db, conn, r, by=None, auto=True)
            except HTTPException as exc:
                log.info("hubspot: auto-log %s: %s", meeting_id, exc.detail)
            except Exception:
                log.warning("hubspot: auto-log %s failed", meeting_id, exc_info=True)
        for name, step in (("suggestions", hubspot_deals.suggest_after), ("deal folder", hubspot_folders.file_after),
                           ("Slack offer", hubspot_notify.offer)):
            try:
                await step(db, conn, meeting_id, m)
            except Exception:
                log.warning("hubspot: %s for %s failed", name, meeting_id, exc_info=True)

    spawn(go())


# ── Status ────────────────────────────────────────────────────────────────────


async def status(db: AsyncIOMotorDatabase, user, workspace_id: str) -> dict:
    from app.models.workspace import role_allows
    from app.services import teams as T

    role = await role_of(db, user, workspace_id)
    admin = role_allows(role, "admin")
    conn = await get(db, workspace_id)
    connected = is_connected(conn)
    team = await _team(db, workspace_id, (conn or {}).get("team_id")) if conn else None
    out: dict[str, Any] = {
        "configured": configured(), "can_manage": admin, "connected": connected, "mode": mode_of(conn) if connected else None,
        "scopes_needed": [{"scope": s["scope"], "why": s["why"], "required": s["required"]} for s in SCOPES] if admin else None,
        "team": ({"id": str(team["_id"]), "name": team.get("name"), "visibility": team.get("visibility") or "open",
                  "slug": team.get("slug")} if team else None),
        "auto_log": bool((conn or {}).get("auto_log")), "can_use": False, "connection": None, "teams": None,
        "switches": {k: switch(conn, k) for k in SWITCHES},
        "deals_write": ("missing" if "crm.objects.deals.write" in ((conn or {}).get("denied") or [])
                        else "unchecked" if "crm.objects.deals.write" in ((conn or {}).get("unchecked") or [])
                        else "granted" if "crm.objects.deals.write" in ((conn or {}).get("scopes") or []) else "missing")
        if connected else None,
    }
    if connected:
        st = conn.get("stats") or {}
        c: dict[str, Any] = {"portal_id": conn.get("portal_id"), "connected_at": iso(conn.get("connected_at")),
                             "broken": conn.get("broken"), "logged": int(st.get("logged") or 0),
                             "created": int(st.get("created") or 0), "tasks": int(st.get("tasks") or 0),
                             "auto": int(st.get("auto") or 0), "last_log_at": iso(st.get("last_log_at")),
                             "url": f"https://{conn.get('ui_domain') or 'app.hubspot.com'}"}
        if admin:
            c.update(connected_by=await _name_of(db, conn.get("connected_by")), checked_at=iso(conn.get("checked_at")),
                     missing_scopes=missing_scopes(conn.get("scopes"), conn.get("denied")),
                     unchecked_scopes=[x for x in conn.get("unchecked") or [] if x not in (conn.get("denied") or [])],
                     scopes_from=conn.get("scopes_from"), last_error=conn.get("last_error"))
        out["connection"] = c
        out["can_use"] = await can_use(db, user.id, conn)
    if admin:
        teams = await db[T.TEAMS].find({"workspace_id": workspace_id, "general": {"$ne": True}}, {"name": 1, "visibility": 1}) \
            .sort("name", 1).to_list(length=T.MAX_TEAMS + 10)
        out["teams"] = [{"id": str(t["_id"]), "name": t.get("name"), "visibility": t.get("visibility") or "open"} for t in teams]
    return out


# ── The dry run (scripts/hubspot_match_report.py) ─────────────────────────────


async def match_report(db: AsyncIOMotorDatabase, workspace_id: str, *, limit: int | None = None, on_row=None) -> dict:
    """Match every meeting of the connected team without writing anything (Markdrop or HubSpot):
    ``{rows: [...], counts: {how: n}, confidence: {level: n}, total, errors}``."""
    conn = await get(db, workspace_id)
    if not is_connected(conn):
        raise RuntimeError("This workspace isn't connected to HubSpot.")
    if not conn.get("team_id"):
        raise RuntimeError("No team is picked for HubSpot yet.")
    from app.services import meetings

    conn = {**conn, "_dry": True}       # nothing is written back (not even HubSpot's lists to the cache)
    owner_by = {o["id"]: o for o in await owners(db, conn)}
    stage_by = {s["id"]: s for s in await stages(db, conn)}
    q = {"workspace_id": workspace_id, "team_ids": conn["team_id"]}
    cur = db[meetings.COLL].find(q, {"segments": 0}).sort([("date", -1), ("created_at", -1)])
    if limit:
        cur = cur.limit(int(limit))
    rows, counts, conf, errors = [], {}, {}, 0
    async for row in cur:
        try:
            m = await match(db, conn, row, persist=False)
            deal = None
            if m.get("deal_id"):
                ds = await batch_read(db, conn, "deals", [m["deal_id"]], DEAL_PROPS)
                deal = _deal_view(conn, ds[0], stage_by, owner_by) if ds else None
            out = {"id": str(row["_id"]), "date": row.get("date"), "time": row.get("time"), "title": row.get("title"),
                   "how": m["how"], "confidence": m["confidence"], "hubspot_meeting": m.get("meeting_id"),
                   "deal": deal, "contacts": len(m.get("contact_ids") or []), "companies": len(m.get("company_ids") or []),
                   "others": [c.get("name") for c in m.get("candidates") or []], "detail": m.get("detail"), "error": None}
        except HubSpotError as exc:
            errors += 1
            out = {"id": str(row["_id"]), "date": row.get("date"), "time": row.get("time"), "title": row.get("title"),
                   "how": "error", "confidence": "none", "deal": None, "error": str(exc)}
        counts[out["how"]] = counts.get(out["how"], 0) + 1
        conf[out["confidence"]] = conf.get(out["confidence"], 0) + 1
        rows.append(out)
        if on_row:
            on_row(out)
    return {"rows": rows, "counts": counts, "confidence": conf, "total": len(rows), "errors": errors}
