"""Jira Cloud: connections, tokens, sites, people, the issue cache and webhooks.

    routers/jira.py            /api/v1/jira/… (settings cards, create, chips, Team, webhooks)
    services/jira_links.py     issues made from or linked to page items, both-way status sync, webhooks
    services/jira_ai.py        Haiku drafts of an issue (ledger feature ``jira_ai``)
    services/jira_team.py      the Team board's tickets, Ask's Jira sources, MCP listings
    mcp/jira_tools.py          jira_status, create_jira_issue, link_jira_issue, list_jira_issues, transition_jira_issue

**One Atlassian OAuth 2.0 (3LO) app** (MARKDROP_ATLASSIAN_CLIENT_ID / _CLIENT_SECRET; the callback
is ``<frontend_url>/integrations/jira/callback``). Two kinds of connection, both through it:

* **Each person connects their own Atlassian account** (Settings › Account › Jira, or the first
  time they create an issue). Every action Markdrop takes in Jira for someone — create, transition,
  read for a chip, the Team board's details, Ask — runs with *their* token, so Jira's own
  permissions apply and they are the reporter.
* **A workspace admin connects the Jira site** (Workspace settings › Integrations › Jira): they
  connect their own account, then pick one of the sites it reaches (``accessible-resources``), the
  projects the workspace follows and the default project / issue type. Their token is the site's
  *connector*: it registers the webhooks and keeps the workspace's counts for people who haven't
  connected (counts only, never an issue's details).

Tokens: access + refresh token, both Fernet-encrypted (utils/crypto, MARKDROP_TOKEN_ENCRYPTION_KEY).
Atlassian rotates refresh tokens: every refresh returns a new one and the old one stops working, so
a refresh is serialised per person (an in-process lock, then a re-read) and the new pair is stored
before it is used. A refresh refused with ``invalid_grant`` marks the account ``broken`` (the card
says "Reconnect").

The OAuth ``state`` is HMAC-signed, bound to the signed-in person and the purpose, 15 minutes, one
use (PKCE isn't part of Atlassian's 3LO flow).

Collections
    jira_accounts  _id = user id: account_id, name, email, avatar, access_enc, refresh_enc, expires_at,
                   scopes, sites [{id, url, name}], connected_at, refreshed_at, broken
    jira_sites     _id = workspace id: cloud_id, url, name, connected_by, projects [keys],
                   default_project, default_issue_type, webhook {ids, expires_at, error, at}, created_at
    jira_people    _id = "<cloud>:<user id>": account_id | None, how (connected | email), at (7 days)
    jira_issues    _id = "<cloud>:<KEY>": the issue's fields as Markdrop shows them (:func:`shape_issue`)
    jira_seen      _id = key, expires_at (TTL): used states, webhook deliveries
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.services import jira_api
from app.utils import crypto

log = logging.getLogger("markdrop.jira")

ACCOUNTS = "jira_accounts"
SITES = "jira_sites"
PEOPLE = "jira_people"
ISSUES = "jira_issues"
SEEN = "jira_seen"

# Classic scopes (developer.atlassian.com › Jira platform REST API scopes). offline_access: a refresh token.
SCOPES = ("read:jira-work", "write:jira-work", "read:jira-user", "manage:jira-webhook", "offline_access")
STATE_TTL = 15 * 60
REFRESH_EARLY = timedelta(seconds=90)
PEOPLE_TTL = timedelta(days=7)
WEBHOOK_EVENTS = ("jira:issue_created", "jira:issue_updated", "jira:issue_deleted")
WEBHOOK_REFRESH_BEFORE = timedelta(days=10)     # webhooks live 30 days; refresh well before
MAX_PROJECTS = 20
ISSUE_FIELDS = ("summary", "status", "assignee", "duedate", "priority", "project", "issuetype", "updated",
                "resolutiondate", "labels", "created", "reporter")
KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,8}$")


class NotConnected(Exception):
    """This person has no (working) Atlassian connection, or it doesn't reach that site."""

    def __init__(self, why: str = "not_connected"):
        super().__init__(why)
        self.why = why


def _s():
    return get_settings()


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
    return _s().jira_configured


def need_configured() -> None:
    if not configured():
        raise HTTPException(status_code=503, detail="Jira isn't set up on this Markdrop server yet.")


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[SITES].create_index("cloud_id")
    await db[ACCOUNTS].create_index("account_id")
    await db[ISSUES].create_index([("cloud_id", 1), ("assignee.account_id", 1)])
    await db[SEEN].create_index("expires_at", expireAfterSeconds=0)
    from app.services import jira_links

    await jira_links.ensure_indexes(db)


# ── Background work ───────────────────────────────────────────────────────────

_bg: set[asyncio.Task] = set()


def spawn(coro) -> asyncio.Task:
    task = asyncio.create_task(coro)
    _bg.add(task)
    task.add_done_callback(_bg.discard)
    task.add_done_callback(lambda t: (not t.cancelled() and t.exception() is not None
                                      and log.warning("jira: background work failed: %r", t.exception())))
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


async def remember(db: AsyncIOMotorDatabase, key: str, ttl: timedelta) -> bool:
    """True the first time ``key`` is seen within ``ttl``; False for a repeat."""
    try:
        await db[SEEN].insert_one({"_id": key[:200], "expires_at": now_utc() + ttl})
        return True
    except DuplicateKeyError:
        row = await db[SEEN].find_one({"_id": key[:200]}, {"expires_at": 1})
        exp = _aware((row or {}).get("expires_at"))
        if exp is not None and exp < now_utc():
            await db[SEEN].update_one({"_id": key[:200]}, {"$set": {"expires_at": now_utc() + ttl}})
            return True
        return False


# ── Signed state ──────────────────────────────────────────────────────────────


def _key(purpose: str) -> bytes:
    s = _s()
    return hmac.new(s.auth_secret.encode(), f"markdrop-jira|{purpose}|".encode() + s.atlassian_client_secret.encode(),
                    hashlib.sha256).digest()


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign_state(kind: str, user_id: str, workspace_id: str | None, *, back: str | None = None,
               at: float | None = None) -> str:
    raw = json.dumps({"k": kind, "u": user_id, "w": workspace_id, "b": back, "t": int(at if at is not None else time.time()),
                      "n": secrets.token_hex(8)}, separators=(",", ":"))
    body = _b64(raw.encode())
    return body + "." + _b64(hmac.new(_key("state"), body.encode(), hashlib.sha256).digest())


def read_state(state: str, user_id: str, *, at: float | None = None) -> dict | None:
    """The state's fields when it's ours, for this person, and recent; else None."""
    try:
        body, sig = (state or "").split(".", 1)
        want = _b64(hmac.new(_key("state"), body.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, want):
            return None
        data = json.loads(_unb64(body))
    except (ValueError, TypeError):
        return None
    now = at if at is not None else time.time()
    if data.get("k") not in ("site", "me") or data.get("u") != user_id or not (0 <= now - int(data.get("t", 0)) <= STATE_TTL):
        return None
    return data


def redirect_uri() -> str:
    return _s().frontend_url.rstrip("/") + "/integrations/jira/callback"


def authorize_url(state: str) -> str:
    q = {"audience": "api.atlassian.com", "client_id": _s().atlassian_client_id, "scope": " ".join(SCOPES),
         "redirect_uri": redirect_uri(), "state": state, "response_type": "code", "prompt": "consent"}
    return jira_api.auth_base() + "/authorize?" + urlencode(q)


def _safe_back(back: str | None) -> str | None:
    """Where to land after connecting: a path on markdrop.in only."""
    if not back or not isinstance(back, str):
        return None
    if not back.startswith("/") or back.startswith("//") or "\\" in back or len(back) > 500:
        return None
    return back


# ── Workspaces ────────────────────────────────────────────────────────────────


async def require_admin(db: AsyncIOMotorDatabase, user, workspace_id: str) -> None:
    from app.services import workspace as ws_service

    if not workspace_id or not ObjectId.is_valid(workspace_id):
        raise HTTPException(status_code=404, detail="Workspace not found")
    await ws_service.require_role(db, workspace_id, user.id, "admin")


async def require_member(db: AsyncIOMotorDatabase, user, workspace_id: str) -> str:
    from app.services import workspace as ws_service

    if not workspace_id or not ObjectId.is_valid(workspace_id):
        raise HTTPException(status_code=404, detail="Workspace not found")
    return await ws_service.require_role(db, workspace_id, user.id, "viewer")


async def site_for(db: AsyncIOMotorDatabase, workspace_id: str | None) -> dict | None:
    if not workspace_id:
        return None
    return await db[SITES].find_one({"_id": str(workspace_id)})


# ── Connecting an Atlassian account ───────────────────────────────────────────


async def start(db: AsyncIOMotorDatabase, user, kind: str, workspace_id: str | None, back: str | None = None) -> str:
    """The Atlassian consent screen's address. ``kind`` "site": a workspace admin connecting the
    workspace's Jira site (their own account first); "me": anyone connecting their own account."""
    need_configured()
    if kind == "site":
        await require_admin(db, user, workspace_id or "")
    elif workspace_id:
        await require_member(db, user, workspace_id)
    return authorize_url(sign_state(kind, user.id, workspace_id, back=_safe_back(back)))


def _site_row(r: dict) -> dict:
    return {"id": str(r.get("id")), "url": str(r.get("url") or "").rstrip("/"), "name": str(r.get("name") or "")[:120],
            "avatar": r.get("avatarUrl")}


async def finish(db: AsyncIOMotorDatabase, user, code: str, state: str) -> dict:
    """Atlassian came back: exchange the code, find the person's Jira sites and who they are there,
    store the tokens (encrypted). Returns {kind, workspace_id, back, sites, account}."""
    need_configured()
    data = read_state(state, user.id)
    if data is None:
        raise HTTPException(status_code=400, detail="This Jira link expired or isn't yours. Start again from Settings.")
    if not await remember(db, "state:" + state[-40:], timedelta(seconds=STATE_TTL * 2)):
        raise HTTPException(status_code=400, detail="This Jira link was already used. Start again from Settings.")
    if data["k"] == "site":
        await require_admin(db, user, data.get("w") or "")
    try:
        tok = await jira_api.token(grant_type="authorization_code", code=code, redirect_uri=redirect_uri())
    except jira_api.JiraError as exc:
        log.info("jira connect: token %s %s", exc.status, exc.reason)
        raise HTTPException(status_code=400, detail="Atlassian didn't accept the sign-in. Try connecting again.")
    access_token = tok["access_token"]
    try:
        resources = await jira_api.accessible_resources(access_token)
    except jira_api.JiraError:
        raise HTTPException(status_code=502, detail="Atlassian didn't answer. Try again in a minute.")
    sites = [_site_row(r) for r in resources if _is_jira(r)]
    if not sites:
        raise HTTPException(status_code=409, detail="Your Atlassian account doesn't reach any Jira site. "
                                                    "Ask your Jira admin for access, then connect again.")
    me = {}
    for site in sites:
        try:
            me = await jira_api.jira("GET", site["id"], "myself", access_token) or {}
            if me.get("accountId"):
                break
        except jira_api.JiraError:
            continue
    if not me.get("accountId"):
        raise HTTPException(status_code=409, detail="Jira didn't say who you are. Try connecting again.")
    now = now_utc()
    refresh = tok.get("refresh_token")
    if not refresh:
        raise HTTPException(status_code=400, detail="Atlassian didn't allow offline access. Connect again and allow it.")
    other = await db[ACCOUNTS].find_one({"account_id": me["accountId"], "_id": {"$ne": user.id}}, {"_id": 1})
    if other is not None:
        raise HTTPException(status_code=409, detail="That Atlassian account is connected to another Markdrop account. "
                                                    "Disconnect it there first.")
    await db[ACCOUNTS].update_one({"_id": user.id}, {"$set": {
        "account_id": me["accountId"], "name": str(me.get("displayName") or "")[:120],
        "email": (me.get("emailAddress") or None), "avatar": ((me.get("avatarUrls") or {}).get("48x48")),
        "access_enc": crypto.encrypt(access_token), "refresh_enc": crypto.encrypt(refresh),
        "expires_at": now + timedelta(seconds=int(tok.get("expires_in") or 3600)),
        "scopes": str(tok.get("scope") or "").split(), "sites": sites, "refreshed_at": now, "broken": None,
        "connected_at": now}}, upsert=True)
    # Who this person is in each Jira site, for matching (members ↔ Jira users).
    for site in sites:
        await db[PEOPLE].update_one({"_id": f"{site['id']}:{user.id}"}, {"$set": {
            "cloud_id": site["id"], "user_id": user.id, "account_id": me["accountId"], "how": "connected", "at": now}},
            upsert=True)
    log.info("jira: %s connected their Atlassian account (%d sites)", user.id, len(sites))
    return {"kind": data["k"], "workspace_id": data.get("w"), "back": data.get("b"), "sites": sites,
            "account": {"name": me.get("displayName"), "account_id": me["accountId"]}}


def _is_jira(r: dict) -> bool:
    scopes = r.get("scopes")
    if not scopes:
        return True
    return any("jira" in str(x) for x in scopes)


_locks: dict[str, asyncio.Lock] = {}


def _lock(user_id: str) -> asyncio.Lock:
    lk = _locks.get(user_id)
    if lk is None:
        lk = _locks[user_id] = asyncio.Lock()
    return lk


async def account(db: AsyncIOMotorDatabase, user_id: str | None) -> dict | None:
    if not user_id:
        return None
    return await db[ACCOUNTS].find_one({"_id": user_id})


async def access_token(db: AsyncIOMotorDatabase, user_id: str | None, cloud_id: str | None = None) -> str:
    """A working access token for this person (refreshed when it's about to expire), that reaches
    ``cloud_id`` when given. Raises :class:`NotConnected` ("not_connected" | "broken" | "no_site")."""
    if not configured():
        raise NotConnected("not_configured")
    row = await account(db, user_id)
    if row is None:
        raise NotConnected("not_connected")
    if row.get("broken"):
        raise NotConnected("broken")
    if cloud_id and not any(s.get("id") == cloud_id for s in row.get("sites") or []):
        raise NotConnected("no_site")
    exp = _aware(row.get("expires_at"))
    if exp is not None and exp - REFRESH_EARLY > now_utc():
        try:
            return crypto.decrypt(row["access_enc"])
        except Exception:
            raise NotConnected("broken")
    async with _lock(user_id):
        row = await account(db, user_id)          # someone else may have refreshed it meanwhile
        if row is None or row.get("broken"):
            raise NotConnected("broken" if row else "not_connected")
        exp = _aware(row.get("expires_at"))
        if exp is not None and exp - REFRESH_EARLY > now_utc():
            return crypto.decrypt(row["access_enc"])
        try:
            refresh = crypto.decrypt(row["refresh_enc"])
        except Exception:
            await _mark_broken(db, user_id, "key")
            raise NotConnected("broken")
        try:
            tok = await jira_api.token(grant_type="refresh_token", refresh_token=refresh)
        except jira_api.JiraError as exc:
            if exc.auth or exc.status in (400, 403):
                await _mark_broken(db, user_id, exc.reason or "refresh")
                raise NotConnected("broken")
            raise
        now = now_utc()
        sets = {"access_enc": crypto.encrypt(tok["access_token"]),
                "expires_at": now + timedelta(seconds=int(tok.get("expires_in") or 3600)), "refreshed_at": now}
        if tok.get("refresh_token"):
            # Rotating refresh tokens: the old one is spent; keep the new one before anything else.
            sets["refresh_enc"] = crypto.encrypt(tok["refresh_token"])
        await db[ACCOUNTS].update_one({"_id": user_id}, {"$set": sets})
        return tok["access_token"]


async def _mark_broken(db: AsyncIOMotorDatabase, user_id: str, why: str) -> None:
    log.info("jira: %s's Atlassian connection broke (%s)", user_id, why)
    await db[ACCOUNTS].update_one({"_id": user_id}, {"$set": {"broken": str(why)[:80] or "refresh", "broken_at": now_utc()}})


async def call_as(db: AsyncIOMotorDatabase, user_id: str, cloud_id: str, method: str, path: str, *,
                  body: Any = None, params: dict | None = None) -> Any:
    """A Jira REST call on ``cloud_id`` as this person. A 401 refreshes once and retries."""
    tok = await access_token(db, user_id, cloud_id)
    try:
        return await jira_api.jira(method, cloud_id, path, tok, body=body, params=params)
    except jira_api.JiraError as exc:
        if exc.status != 401:
            raise
    await db[ACCOUNTS].update_one({"_id": user_id}, {"$set": {"expires_at": now_utc()}})
    tok = await access_token(db, user_id, cloud_id)
    return await jira_api.jira(method, cloud_id, path, tok, body=body, params=params)


async def can_use(db: AsyncIOMotorDatabase, user_id: str | None, cloud_id: str | None) -> bool:
    """This person's own connection works and reaches that site."""
    if not user_id or not cloud_id or not configured():
        return False
    row = await account(db, user_id)
    return bool(row and not row.get("broken") and any(s.get("id") == cloud_id for s in row.get("sites") or []))


async def disconnect_me(db: AsyncIOMotorDatabase, user) -> None:
    """Forget this person's Atlassian tokens (Atlassian has no revoke call for 3LO apps: they remove
    Markdrop under their Atlassian account's Connected apps). Sites they connected keep their
    settings but lose their connector until an admin connects again."""
    await db[ACCOUNTS].delete_one({"_id": user.id})
    await db[PEOPLE].delete_many({"user_id": user.id, "how": "connected"})


# ── The workspace's site ──────────────────────────────────────────────────────


async def my_sites(db: AsyncIOMotorDatabase, user) -> list[dict]:
    """The Jira sites this person's connection reaches (asked again; the stored list is refreshed)."""
    tok = await access_token(db, user.id)
    try:
        resources = await jira_api.accessible_resources(tok)
    except jira_api.JiraError:
        raise HTTPException(status_code=502, detail="Atlassian didn't answer. Try again in a minute.")
    sites = [_site_row(r) for r in resources if _is_jira(r)]
    await db[ACCOUNTS].update_one({"_id": user.id}, {"$set": {"sites": sites}})
    return sites


async def projects(db: AsyncIOMotorDatabase, user_id: str, cloud_id: str) -> list[dict]:
    try:
        out = await call_as(db, user_id, cloud_id, "GET", "project/search", params={"maxResults": 100, "orderBy": "name"})
    except jira_api.JiraError as exc:
        raise _http(exc)
    return [{"key": p.get("key"), "name": p.get("name") or p.get("key"), "id": str(p.get("id"))}
            for p in (out or {}).get("values") or [] if p.get("key")]


async def issue_types(db: AsyncIOMotorDatabase, user_id: str, cloud_id: str, project: str) -> list[dict]:
    """The issue types a person can create in ``project`` (createmeta)."""
    try:
        out = await call_as(db, user_id, cloud_id, "GET", f"issue/createmeta/{project}/issuetypes", params={"maxResults": 50})
    except jira_api.JiraError as exc:
        raise _http(exc)
    rows = (out or {}).get("issueTypes") or (out or {}).get("values") or []
    return [{"id": str(t.get("id")), "name": t.get("name")} for t in rows if t.get("name") and not t.get("subtask")]


async def priorities(db: AsyncIOMotorDatabase, user_id: str, cloud_id: str) -> list[dict]:
    try:
        out = await call_as(db, user_id, cloud_id, "GET", "priority")
    except jira_api.JiraError:
        return []
    return [{"id": str(p.get("id")), "name": p.get("name")} for p in (out or []) if isinstance(p, dict) and p.get("name")]


def _http(exc: jira_api.JiraError) -> HTTPException:
    if exc.status == 0:
        return HTTPException(status_code=502, detail="Jira didn't answer. Try again in a minute.")
    if exc.forbidden:
        return HTTPException(status_code=403, detail="Jira says you don't have permission for that.")
    if exc.missing:
        return HTTPException(status_code=404, detail="Jira couldn't find that.")
    if exc.status == 429:
        return HTTPException(status_code=429, detail="Jira is rate limiting Markdrop. Try again in a minute.")
    if 400 <= exc.status < 500:
        return HTTPException(status_code=422, detail=f"Jira refused it: {exc.reason or 'invalid request'}"[:300])
    return HTTPException(status_code=502, detail="Jira had a problem. Try again in a minute.")


def not_connected(exc: NotConnected) -> HTTPException:
    return HTTPException(status_code=409, detail={
        "not_configured": "Jira isn't set up on this Markdrop server yet.",
        "not_connected": "Connect your Atlassian account first (Settings › Account › Jira).",
        "broken": "Your Atlassian connection stopped working. Reconnect it in Settings › Account › Jira.",
        "no_site": "Your Atlassian account doesn't reach this workspace's Jira site. Ask your Jira admin for access.",
    }.get(exc.why, "Connect your Atlassian account first."))


async def set_site(db: AsyncIOMotorDatabase, user, workspace_id: str, cloud_id: str, chosen: list[str],
                   default_project: str | None, default_issue_type: str | None) -> dict:
    """An admin connects (or reconfigures) the workspace's Jira site with their own account."""
    need_configured()
    await require_admin(db, user, workspace_id)
    try:
        sites = await my_sites(db, user)
    except NotConnected as exc:
        raise not_connected(exc)
    site = next((s for s in sites if s["id"] == cloud_id), None)
    if site is None:
        raise HTTPException(status_code=422, detail="Pick a Jira site your Atlassian account reaches.")
    known = {p["key"]: p for p in await projects(db, user.id, cloud_id)}
    # Owner decision 2026-11-06: the default project (+ issue type) is for new issues; ``projects`` are the
    # ones that feed the Team board (none: the board shows nothing from Jira and asks an admin to pick).
    keys = [k for k in dict.fromkeys(x.strip().upper() for x in chosen or []) if k in known][:MAX_PROJECTS]
    default_project = (default_project or "").strip().upper() or (keys[0] if keys else "")
    if default_project not in known:
        raise HTTPException(status_code=422, detail="Pick a default project for new issues.")
    other = await db[SITES].find_one({"_id": workspace_id})
    now = now_utc()
    await db[SITES].update_one({"_id": workspace_id}, {"$set": {
        "cloud_id": cloud_id, "url": site["url"], "name": site["name"], "connected_by": user.id,
        "projects": keys, "default_project": default_project,
        "default_issue_type": (default_issue_type or "Task")[:60], "updated_at": now},
        "$setOnInsert": {"created_at": now}}, upsert=True)
    if other is not None and other.get("cloud_id") != cloud_id:
        await _forget_site_data(db, workspace_id)
        await db[SITES].update_one({"_id": workspace_id}, {"$set": {"hook_projects": []}})
    spawn(register_webhooks(db, workspace_id))
    log.info("jira: workspace %s connected to %s (%s) by %s", workspace_id, site["name"], cloud_id, user.id)
    return await status(db, user, workspace_id)


async def _forget_site_data(db: AsyncIOMotorDatabase, workspace_id: str) -> None:
    await db["jira_ws_cache"].delete_many({"_id": workspace_id})
    await db["jira_views"].delete_many({"workspace_id": workspace_id})


async def disconnect_site(db: AsyncIOMotorDatabase, user, workspace_id: str) -> dict:
    await require_admin(db, user, workspace_id)
    site = await site_for(db, workspace_id)
    if site is not None:
        await unregister_webhooks(db, site)
        await db[SITES].delete_one({"_id": workspace_id})
        await _forget_site_data(db, workspace_id)
    return await status(db, user, workspace_id)


async def connector(db: AsyncIOMotorDatabase, site: dict) -> str | None:
    """The user id whose token speaks for the site (the admin who connected it), when it still works."""
    uid = site.get("connected_by")
    if uid and await can_use(db, uid, site.get("cloud_id")):
        return uid
    return None


# ── Webhooks ──────────────────────────────────────────────────────────────────


def webhook_url(workspace_id: str) -> str:
    return _s().api_base_url.rstrip("/") + f"/api/v1/jira/webhook/{workspace_id}"


def _jql_projects(keys: list[str]) -> str:
    return "project in (" + ", ".join(f'"{k}"' for k in keys) + ")"


async def register_webhooks(db: AsyncIOMotorDatabase, workspace_id: str) -> dict:
    """Register (or re-register) the workspace's dynamic webhook with the connector's token: issue
    created / updated / deleted in the chosen projects, sent to /api/v1/jira/webhook/<workspace>."""
    site = await site_for(db, workspace_id)
    if site is None:
        return {"ok": False, "error": "no_site"}
    uid = await connector(db, site)
    if uid is None:
        await db[SITES].update_one({"_id": workspace_id}, {"$set": {"webhook.error": "connector", "webhook.at": now_utc()}})
        return {"ok": False, "error": "connector"}
    old = (site.get("webhook") or {}).get("ids") or []
    if old:
        try:
            await call_as(db, uid, site["cloud_id"], "DELETE", "webhook", body={"webhookIds": old})
        except (jira_api.JiraError, NotConnected):
            pass
    covered = watched_projects(site)
    body = {"url": webhook_url(workspace_id),
            "webhooks": [{"events": list(WEBHOOK_EVENTS), "jqlFilter": _jql_projects(covered)}]}
    try:
        out = await call_as(db, uid, site["cloud_id"], "POST", "webhook", body=body)
    except (jira_api.JiraError, NotConnected) as exc:
        why = getattr(exc, "reason", None) or getattr(exc, "why", None) or "error"
        log.info("jira: registering the webhook of %s failed: %s", workspace_id, why)
        await db[SITES].update_one({"_id": workspace_id}, {"$set": {"webhook": {
            "ids": [], "error": str(why)[:200], "at": now_utc()}}})
        return {"ok": False, "error": why}
    ids = [r.get("createdWebhookId") for r in (out or {}).get("webhookRegistrationResult") or [] if r.get("createdWebhookId")]
    errs = [e for r in (out or {}).get("webhookRegistrationResult") or [] for e in r.get("errors") or []]
    await db[SITES].update_one({"_id": workspace_id}, {"$set": {"webhook": {
        "ids": ids, "expires_at": now_utc() + timedelta(days=30), "error": "; ".join(map(str, errs))[:200] or None,
        "at": now_utc(), "by": uid, "projects": covered}}})
    return {"ok": bool(ids), "ids": ids}


def watched_projects(site: dict) -> list[str]:
    """The projects the webhook covers: the Team board's, the default one, and any project an issue
    linked from this workspace lives in (``hook_projects``), so both-way sync works wherever it was made."""
    keys = [*(site.get("projects") or []), site.get("default_project"), *(site.get("hook_projects") or [])]
    return [k for k in dict.fromkeys(k for k in keys if k)][:50]


async def cover_project(db: AsyncIOMotorDatabase, workspace_id: str, project: str) -> None:
    """An issue was linked in ``project``: make sure the webhook reports its changes."""
    site = await site_for(db, workspace_id)
    if site is None or not project or project in ((site.get("webhook") or {}).get("projects") or []):
        return
    await db[SITES].update_one({"_id": workspace_id}, {"$addToSet": {"hook_projects": project}})
    spawn(register_webhooks(db, workspace_id))


async def unregister_webhooks(db: AsyncIOMotorDatabase, site: dict) -> None:
    ids = (site.get("webhook") or {}).get("ids") or []
    uid = await connector(db, site)
    if not ids or uid is None:
        return
    try:
        await call_as(db, uid, site["cloud_id"], "DELETE", "webhook", body={"webhookIds": ids})
    except (jira_api.JiraError, NotConnected) as exc:
        log.info("jira: removing webhooks of %s: %s", site["_id"], exc)


async def refresh_webhooks(db: AsyncIOMotorDatabase) -> int:
    """Background: extend webhooks that expire within WEBHOOK_REFRESH_BEFORE (they live 30 days);
    re-register ones that are gone or failed. Returns how many sites were handled."""
    n = 0
    soon = now_utc() + WEBHOOK_REFRESH_BEFORE
    async for site in db[SITES].find({"$or": [{"webhook.expires_at": {"$lt": soon}}, {"webhook.ids": {"$size": 0}},
                                              {"webhook": {"$exists": False}}]}).limit(50):
        n += 1
        ids = (site.get("webhook") or {}).get("ids") or []
        uid = await connector(db, site)
        if not ids or uid is None:
            last = _aware((site.get("webhook") or {}).get("at"))
            if last is None or last < now_utc() - timedelta(hours=6):
                await register_webhooks(db, site["_id"])
            continue
        try:
            out = await call_as(db, uid, site["cloud_id"], "PUT", "webhook/refresh", body={"webhookIds": ids})
            exp = (out or {}).get("expirationDate")
            when = now_utc() + timedelta(days=30)
            if isinstance(exp, (int, float)):
                when = datetime.fromtimestamp(exp / 1000, tz=timezone.utc)
            await db[SITES].update_one({"_id": site["_id"]}, {"$set": {"webhook.expires_at": when, "webhook.at": now_utc()}})
        except (jira_api.JiraError, NotConnected):
            await register_webhooks(db, site["_id"])
    return n


def verify_webhook(headers, *, now: float | None = None) -> str | None:
    """None when the request carries a JWT signed (HS256) with our client secret and not expired;
    else why not. Atlassian: "Webhooks for OAuth 2.0 apps are secured by bearer authentication. The
    token is present in the Authorization header and is signed with the app's client secret.\""""
    import jwt

    secret = _s().atlassian_client_secret
    if not secret:
        return "not_configured"
    auth = (headers.get("authorization") or "").strip()
    if not auth.lower().startswith("bearer "):
        return "unsigned"
    token = auth[7:].strip()
    try:
        claims = jwt.decode(token, secret, algorithms=["HS256"], options={"require": ["exp"], "verify_aud": False},
                            leeway=60)
    except jwt.ExpiredSignatureError:
        return "expired"
    except jwt.InvalidTokenError:
        return "bad_signature"
    iat = claims.get("iat")
    if isinstance(iat, (int, float)) and iat > (now if now is not None else time.time()) + 300:
        return "future"
    return None


# ── People ────────────────────────────────────────────────────────────────────


async def member_accounts(db: AsyncIOMotorDatabase, workspace_id: str, cloud_id: str, *,
                          lookup_as: str | None = None, limit: int = 300) -> dict[str, str]:
    """{Markdrop user id: Jira account id} for the workspace's members: their own connection first,
    else found by their Markdrop email (``user/search``, with ``lookup_as``'s token, cached 7 days,
    misses too). Only exact email matches count; Jira may hide emails, then only connected people match."""
    members = [m async for m in db["memberships"].find({"workspace_id": workspace_id}, {"user_id": 1, "email": 1})]
    ids = [m["user_id"] for m in members if m.get("user_id")][:limit]
    out: dict[str, str] = {}
    known = {r["user_id"]: r async for r in db[PEOPLE].find({"cloud_id": cloud_id, "user_id": {"$in": ids}})}
    fresh = now_utc() - PEOPLE_TTL
    todo = []
    for uid in ids:
        r = known.get(uid)
        if r is not None and (r.get("how") == "connected" or (_aware(r.get("at")) or fresh) > fresh):
            if r.get("account_id"):
                out[uid] = r["account_id"]
            continue
        todo.append(uid)
    if todo and lookup_as:
        emails = {str(u["_id"]): (u.get("email") or "").strip().lower() async for u in db["users"].find(
            {"_id": {"$in": [ObjectId(x) for x in todo if ObjectId.is_valid(x)]}}, {"email": 1})}
        for uid in todo[:40]:
            email = emails.get(uid) or ""
            acc = None
            if "@" in email:
                try:
                    found = await call_as(db, lookup_as, cloud_id, "GET", "user/search", params={"query": email, "maxResults": 5})
                except (jira_api.JiraError, NotConnected):
                    break
                for u in found or []:
                    if u.get("accountType") not in (None, "atlassian"):
                        continue
                    addr = (u.get("emailAddress") or "").strip().lower()
                    if addr == email or (not addr and len(found) == 1):
                        acc = u.get("accountId")
                        break
            await db[PEOPLE].update_one({"_id": f"{cloud_id}:{uid}"}, {"$set": {
                "cloud_id": cloud_id, "user_id": uid, "account_id": acc, "how": "email", "at": now_utc()}}, upsert=True)
            if acc:
                out[uid] = acc
    return out


async def user_for_account(db: AsyncIOMotorDatabase, workspace_id: str, cloud_id: str, account_id: str | None) -> str | None:
    """The workspace member who is ``account_id`` in Jira, else None."""
    if not account_id:
        return None
    async for r in db[PEOPLE].find({"cloud_id": cloud_id, "account_id": account_id}, {"user_id": 1}):
        if await db["memberships"].find_one({"workspace_id": workspace_id, "user_id": r["user_id"]}, {"_id": 1}):
            return r["user_id"]
    return None


# ── Issues ────────────────────────────────────────────────────────────────────


def browse_url(site_url: str | None, key: str) -> str:
    return f"{(site_url or '').rstrip('/')}/browse/{key}"


def _cat(status: dict | None) -> str:
    """Jira's status category: "new" (To do) | "indeterminate" (In progress) | "done"."""
    key = ((status or {}).get("statusCategory") or {}).get("key")
    return key if key in ("new", "indeterminate", "done") else "new"


def shape_issue(cloud_id: str, site_url: str | None, raw: dict) -> dict:
    f = raw.get("fields") or {}
    st = f.get("status") or {}
    asg = f.get("assignee") or None
    labels = [str(x) for x in f.get("labels") or []][:20]
    name = st.get("name") or ""
    key = raw.get("key") or ""
    return {
        "_id": f"{cloud_id}:{key}", "cloud_id": cloud_id, "key": key, "id": str(raw.get("id") or ""),
        "summary": str(f.get("summary") or "")[:300],
        "status": {"name": name[:60], "category": _cat(st)},
        "blocked": bool(re.search(r"block", name, re.I) or any(re.search(r"^blocked$", x, re.I) for x in labels)
                        or bool(f.get("flagged"))),
        "assignee": ({"account_id": asg.get("accountId"), "name": str(asg.get("displayName") or "")[:120],
                      "avatar": (asg.get("avatarUrls") or {}).get("48x48")} if asg else None),
        "due": (f.get("duedate") or None),
        "priority": ((f.get("priority") or {}).get("name") or None),
        "project": {"key": (f.get("project") or {}).get("key"), "name": (f.get("project") or {}).get("name")},
        "type": ((f.get("issuetype") or {}).get("name") or None),
        "labels": labels,
        "updated": f.get("updated"), "resolved": f.get("resolutiondate"),
        "url": browse_url(site_url, key),
        "fetched_at": now_utc(),
    }


async def store_issues(db: AsyncIOMotorDatabase, shaped: list[dict]) -> None:
    for it in shaped:
        await db[ISSUES].update_one({"_id": it["_id"]}, {"$set": it}, upsert=True)


def public_issue(it: dict) -> dict:
    """An issue as the API answers it (for someone allowed to see it)."""
    return {"key": it["key"], "summary": it.get("summary"), "status": it.get("status"), "assignee": it.get("assignee"),
            "due": it.get("due"), "priority": it.get("priority"), "project": it.get("project"), "type": it.get("type"),
            "url": it.get("url"), "blocked": bool(it.get("blocked")), "updated": it.get("updated"),
            "resolved": it.get("resolved"), "labels": it.get("labels") or []}


async def search_as(db: AsyncIOMotorDatabase, user_id: str, site: dict, jql: str, *, limit: int = 200) -> list[dict]:
    """JQL as this person (``POST search/jql``), shaped and stored in the cache."""
    out: list[dict] = []
    token = None
    for _ in range(4):
        body: dict[str, Any] = {"jql": jql, "fields": list(ISSUE_FIELDS), "maxResults": min(100, limit - len(out))}
        if token:
            body["nextPageToken"] = token
        res = await call_as(db, user_id, site["cloud_id"], "POST", "search/jql", body=body)
        for raw in (res or {}).get("issues") or []:
            out.append(shape_issue(site["cloud_id"], site.get("url"), raw))
        token = (res or {}).get("nextPageToken")
        if not token or len(out) >= limit or (res or {}).get("isLast"):
            break
    await store_issues(db, out)
    return out


async def visible_keys(db: AsyncIOMotorDatabase, user_id: str, site: dict, keys: list[str]) -> dict[str, dict]:
    """Which of ``keys`` this person's own connection can open now: {key: shaped issue}. Unknown or
    hidden keys are left out."""
    keys = [k for k in dict.fromkeys(keys) if KEY_RE.match(k or "")][:100]
    if not keys:
        return {}
    try:
        found = await search_as(db, user_id, site, "key in (" + ", ".join(keys) + ")", limit=len(keys))
    except jira_api.JiraError as exc:
        if exc.status == 400 and len(keys) > 1:
            # One unknown key makes the whole JQL a 400: ask one by one.
            got: dict[str, dict] = {}
            for k in keys:
                got.update(await visible_keys(db, user_id, site, [k]))
            return got
        if exc.status in (400, 404):
            return {}
        raise
    return {it["key"]: it for it in found}


# ── Status (the settings cards) ───────────────────────────────────────────────


def _me_part(row: dict | None, cloud_id: str | None) -> dict:
    if row is None:
        return {"connected": False, "name": None, "broken": False, "reaches_site": False, "avatar": None}
    return {"connected": True, "name": row.get("name"), "avatar": row.get("avatar"), "broken": bool(row.get("broken")),
            "reaches_site": bool(cloud_id and any(s.get("id") == cloud_id for s in row.get("sites") or [])),
            "sites": [{"id": s["id"], "name": s.get("name"), "url": s.get("url")} for s in row.get("sites") or []]}


async def status(db: AsyncIOMotorDatabase, user, workspace_id: str) -> dict:
    from app.models.workspace import role_allows

    role = await require_member(db, user, workspace_id)
    site = await site_for(db, workspace_id)
    me = await account(db, user.id)
    out: dict[str, Any] = {"configured": configured(), "can_manage": role_allows(role, "admin"), "site": None,
                           "me": _me_part(me, (site or {}).get("cloud_id"))}
    if site is not None:
        who = None
        if site.get("connected_by") and ObjectId.is_valid(site["connected_by"]):
            row = await db["users"].find_one({"_id": ObjectId(site["connected_by"])}, {"name": 1, "email": 1})
            who = (row or {}).get("name") or (row or {}).get("email")
        hook = site.get("webhook") or {}
        out["site"] = {
            "cloud_id": site["cloud_id"], "name": site.get("name"), "url": site.get("url"), "connected_by": who,
            "connected_at": iso(site.get("created_at")), "projects": site.get("projects") or [],
            "default_project": site.get("default_project"), "default_issue_type": site.get("default_issue_type"),
            "connector_ok": await connector(db, site) is not None,
            "webhook": {"ok": bool(hook.get("ids")), "error": hook.get("error") if role_allows(role, "admin") else None,
                        "expires_at": iso(hook.get("expires_at"))},
            "connected_people": await db[PEOPLE].count_documents({"cloud_id": site["cloud_id"], "how": "connected",
                                                                  "user_id": {"$in": [m["user_id"] async for m in db["memberships"].find(
                                                                      {"workspace_id": workspace_id}, {"user_id": 1})]}}),
        }
    return out


async def me_status(db: AsyncIOMotorDatabase, user) -> dict:
    from app.services import workspace as ws_service

    row = await account(db, user.id)
    pairs = await ws_service.list_for_user(db, user.id)
    names = {w.id: w.name for w, _r in pairs}
    sites = await db[SITES].find({"_id": {"$in": list(names)}}).to_list(length=100) if names else []
    mine = {s.get("id") for s in (row or {}).get("sites") or []}
    return {"configured": configured(), **_me_part(row, None),
            "workspaces": [{"workspace_id": s["_id"], "workspace_name": names.get(s["_id"]), "site": s.get("name"),
                            "url": s.get("url"), "reaches": s.get("cloud_id") in mine} for s in sites]}
