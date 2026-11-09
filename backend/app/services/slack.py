"""Markdrop for Slack: installs, account links, request verification, preferences.

One Slack app (docs-platform/slack/manifest.yaml) that a Markdrop **workspace admin** adds to a
Slack team from Workspace settings › Integrations › Slack (OAuth v2). One Slack team ↔ one Markdrop
workspace. People link their own Slack account once with Sign in with Slack (OpenID Connect); every
answer Markdrop gives them in Slack is built only from what that Markdrop account can open.

Collections
    slack_installs  _id = team_id: team_name, workspace_id (unique), app_id, bot_user_id,
                    bot_token_enc (Fernet, utils/crypto), scopes, installed_by, meetings_channel
                    {id, name} | None, post_meetings, created_at, updated_at
    slack_links     _id = "<team>:<slack user>": team_id, slack_user_id, user_id, slack_name, linked_at,
                    match: how it was made: "oauth" (Sign in with Slack), "email" (found by the
                    person's Markdrop email when they turned Slack notifications on), "install" (the
                    admin who added the app). A row without ``match`` predates opt-in (see below).
    slack_seen      _id = key, expires_at (TTL): accepted request signatures (replay), Events API
                    event ids (Slack's retries), used OAuth states (one use each)

Requests from Slack (events, slash commands, button clicks) are verified with the app's signing
secret (:func:`verify_request`: v0 HMAC-SHA256 over ``v0:<ts>:<body>``, a 5-minute window), and
each accepted signature is remembered for 10 minutes so an exact replay is refused. The work runs
after the 200 (:func:`spawn`): Slack gives an app 3 seconds.

Direct messages are opt-in (owner, 2026-11-06): ``users.slack_notify.on`` is false until the
person turns on "Get notifications in Slack" (Settings › Account). Turning it on finds them in each
Slack team installed for a Markdrop workspace they belong to by their own (verified) Markdrop email
(``users.lookupByEmail``, bot scope ``users:read.email``), no Sign in with Slack needed; Sign in
with Slack stays as the fallback. Someone who linked before opt-in existed (a link row without
``match``) and never chose keeps getting them (:func:`dm_on`).

Services that use this: slack_events.py (commands, clicks, unfurls), slack_notify.py (DMs and
meeting posts), slack_blocks.py (the messages).
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
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
from app.services import slack_api
from app.utils import crypto

log = logging.getLogger("markdrop.slack")

INSTALLS = "slack_installs"
LINKS = "slack_links"
SEEN = "slack_seen"

# Must match docs-platform/slack/manifest.yaml (tests/test_slack.py checks it).
BOT_SCOPES = ("commands", "chat:write", "chat:write.public", "links:read", "links:write", "im:write",
              "channels:read", "groups:read", "im:read", "mpim:read", "users:read", "users:read.email")
# What finding a person by their email needs (an install made before these were added must be updated).
EMAIL_SCOPES = ("users:read", "users:read.email")
USER_SCOPES = ("openid",)

SIGNATURE_WINDOW = 300          # seconds either side of now (Slack's own recommendation)
REPLAY_TTL = timedelta(minutes=10)
EVENT_TTL = timedelta(days=1)
STATE_TTL = 15 * 60             # an install / link round trip

# Kinds of direct message a linked person can turn off (users.slack_notify.<kind>: false).
NOTIFY_KINDS = ("mention", "signoff_requested", "shared", "access_request", "comment_mention", "comment_assigned")
NOTIFY_LABELS = {
    "mention": "Mentions",
    "signoff_requested": "Sign-off requests",
    "shared": "Shared with you",
    "access_request": "Access requests",
    # Comments (services/comments/slack.py): with Reply and Resolve buttons.
    "comment_mention": "Mentions in comments",
    "comment_assigned": "Comments assigned to you",
}


def _s():
    return get_settings()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def configured() -> bool:
    return _s().slack_configured


def need_configured() -> None:
    if not configured():
        raise HTTPException(status_code=503, detail="Markdrop for Slack isn't set up yet.")


# ── Background work (Slack wants its 200 within 3 seconds) ────────────────────

_bg: set[asyncio.Task] = set()


def spawn(coro) -> asyncio.Task:
    task = asyncio.create_task(coro)
    _bg.add(task)
    task.add_done_callback(_bg.discard)
    task.add_done_callback(_log_failure)
    return task


def _log_failure(task: asyncio.Task) -> None:
    if not task.cancelled() and task.exception() is not None:
        log.warning("slack: background work failed: %r", task.exception())


async def drain() -> None:
    """Wait for the background work started so far (tests).

    Work left from another event loop (a test's loop that closed before a finished task's done
    callbacks ran) is dropped: a finished task stays in ``_bg`` then, and gathering it returns at once
    without yielding, so this loop spun forever and hung the test."""
    loop = asyncio.get_running_loop()
    while True:
        for t in list(_bg):
            if t.done() or t.get_loop() is not loop:
                _bg.discard(t)
        if not _bg:
            return
        await asyncio.gather(*list(_bg), return_exceptions=True)


# ── Indexes ───────────────────────────────────────────────────────────────────


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[INSTALLS].create_index("workspace_id", unique=True, sparse=True)
    await db[LINKS].create_index("user_id")
    await db[LINKS].create_index("team_id")
    await db[SEEN].create_index("expires_at", expireAfterSeconds=0)


# ── Verifying Slack's requests ────────────────────────────────────────────────


def signature_for(body: bytes, ts: str, secret: str | None = None) -> str:
    key = (secret if secret is not None else _s().slack_signing_secret).encode()
    return "v0=" + hmac.new(key, b"v0:" + ts.encode() + b":" + body, hashlib.sha256).hexdigest()


def verify_request(headers, body: bytes, *, now: float | None = None) -> str | None:
    """None when the request is Slack's (signed with our signing secret, recent); else why not."""
    secret = _s().slack_signing_secret
    if not secret:
        return "not_configured"
    ts = (headers.get("x-slack-request-timestamp") or "").strip()
    sig = (headers.get("x-slack-signature") or "").strip()
    if not ts.isdigit() or not sig.startswith("v0="):
        return "unsigned"
    if abs((now if now is not None else time.time()) - int(ts)) > SIGNATURE_WINDOW:
        return "stale"
    if not hmac.compare_digest(sig.encode(), signature_for(body, ts, secret).encode()):
        return "bad_signature"
    return None


async def remember(db: AsyncIOMotorDatabase, key: str, ttl: timedelta) -> bool:
    """True the first time ``key`` is seen within ``ttl``; False for a repeat."""
    try:
        await db[SEEN].insert_one({"_id": key[:200], "expires_at": _now() + ttl})
        return True
    except DuplicateKeyError:
        row = await db[SEEN].find_one({"_id": key[:200]}, {"expires_at": 1})
        exp = (row or {}).get("expires_at")
        if exp is not None and exp.replace(tzinfo=exp.tzinfo or timezone.utc) < _now():
            # The TTL monitor runs once a minute; an expired key counts as unseen.
            await db[SEEN].update_one({"_id": key[:200]}, {"$set": {"expires_at": _now() + ttl}})
            return True
        return False


async def verify_and_claim(db: AsyncIOMotorDatabase, headers, body: bytes) -> str | None:
    """:func:`verify_request`, then refuse an exact replay of an accepted request."""
    why = verify_request(headers, body)
    if why:
        return why
    if not await remember(db, "sig:" + headers.get("x-slack-signature", ""), REPLAY_TTL):
        return "replay"
    return None


# ── Signed values (OAuth state, button values) ────────────────────────────────


def _key(purpose: str) -> bytes:
    s = _s()
    return hmac.new(s.auth_secret.encode(), f"markdrop-slack|{purpose}|".encode() + s.slack_client_secret.encode(),
                    hashlib.sha256).digest()


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign_state(kind: str, user_id: str, workspace_id: str | None, *, at: float | None = None) -> str:
    raw = json.dumps({"k": kind, "u": user_id, "w": workspace_id, "t": int(at if at is not None else time.time()),
                      "n": secrets.token_hex(8)}, separators=(",", ":"))
    body = _b64(raw.encode())
    return body + "." + _b64(hmac.new(_key("state"), body.encode(), hashlib.sha256).digest())


def read_state(state: str, kind: str, user_id: str, *, at: float | None = None) -> dict | None:
    """The state's fields when it's ours, of this kind, for this user, and recent; else None."""
    try:
        body, sig = (state or "").split(".", 1)
        want = _b64(hmac.new(_key("state"), body.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, want):
            return None
        data = json.loads(_unb64(body))
    except (ValueError, TypeError):
        return None
    now = at if at is not None else time.time()
    if data.get("k") != kind or data.get("u") != user_id or not (0 <= now - int(data.get("t", 0)) <= STATE_TTL):
        return None
    return data


def sign_value(team_id: str, *parts: str) -> str:
    """A button's value: ``parts`` joined with "|", bound to the team, with a short MAC."""
    body = "|".join(parts)
    mac = _b64(hmac.new(_key("value"), f"{team_id}|{body}".encode(), hashlib.sha256).digest()[:12])
    return f"{body}|{mac}"


def read_value(team_id: str, value: str | None) -> list[str] | None:
    """The parts of a value made by :func:`sign_value` for this team, else None (forged, or another team's)."""
    if not value or "|" not in value or len(value) > 2000:
        return None
    body, _, mac = value.rpartition("|")
    want = _b64(hmac.new(_key("value"), f"{team_id}|{body}".encode(), hashlib.sha256).digest()[:12])
    if not hmac.compare_digest(mac, want):
        return None
    return body.split("|")


# ── OAuth round trips ─────────────────────────────────────────────────────────


def frontend_link(path: str) -> str:
    return _s().frontend_url.rstrip("/") + path


def redirect_uri() -> str:
    # The frontend page that finishes both round trips (manifest: oauth_config.redirect_urls).
    return _s().frontend_url.rstrip("/") + "/integrations/slack/callback"


def install_url(state: str) -> str:
    q = {"client_id": _s().slack_client_id, "scope": ",".join(BOT_SCOPES), "user_scope": "",
         "redirect_uri": redirect_uri(), "state": state}
    return _s().slack_web_base.rstrip("/") + "/oauth/v2/authorize?" + urlencode(q)


def link_url(state: str, team_id: str | None) -> str:
    q = {"client_id": _s().slack_client_id, "scope": " ".join(USER_SCOPES), "response_type": "code",
         "redirect_uri": redirect_uri(), "state": state, "nonce": secrets.token_hex(8)}
    if team_id:
        q["team"] = team_id
    return _s().slack_web_base.rstrip("/") + "/openid/connect/authorize?" + urlencode(q)


# ── Installs ──────────────────────────────────────────────────────────────────


async def get_install(db: AsyncIOMotorDatabase, team_id: str | None) -> dict | None:
    if not team_id or not isinstance(team_id, str):
        return None
    return await db[INSTALLS].find_one({"_id": team_id})


async def install_for_workspace(db: AsyncIOMotorDatabase, workspace_id: str | None) -> dict | None:
    if not workspace_id:
        return None
    return await db[INSTALLS].find_one({"workspace_id": workspace_id})


def bot_token(install: dict | None) -> str | None:
    enc = (install or {}).get("bot_token_enc")
    if not enc:
        return None
    try:
        return crypto.decrypt(enc)
    except Exception:
        log.warning("slack: the bot token of team %s can't be decrypted (key changed?)", (install or {}).get("_id"))
        return None


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


async def connect(db: AsyncIOMotorDatabase, user, code: str, state: str) -> dict:
    """The end of Add to Slack: exchange the code, store the team (bot token encrypted), link the installer."""
    need_configured()
    data = read_state(state, "install", user.id)
    if data is None:
        raise HTTPException(status_code=400, detail="This Slack link expired or isn't yours. Start again from Workspace settings.")
    if not await remember(db, "state:" + state[-40:], timedelta(seconds=STATE_TTL * 2)):
        raise HTTPException(status_code=400, detail="This Slack link was already used. Start again from Workspace settings.")
    workspace_id = data.get("w") or ""
    await require_admin(db, user, workspace_id)
    s = _s()
    try:
        r = await slack_api.call("oauth.v2.access", None, client_id=s.slack_client_id, client_secret=s.slack_client_secret,
                                 code=code, redirect_uri=redirect_uri())
    except slack_api.SlackError as exc:
        log.info("slack connect: oauth.v2.access %s", exc.error)
        raise HTTPException(status_code=400, detail="Slack didn't accept the sign-in. Try Add to Slack again.")
    if r.get("is_enterprise_install"):
        raise HTTPException(status_code=400, detail="Install Markdrop on one Slack workspace, not the whole organization.")
    team = r.get("team") or {}
    team_id = str(team.get("id") or "")
    token = r.get("access_token") or ""
    if not team_id or not token or r.get("token_type", "bot") != "bot":
        raise HTTPException(status_code=400, detail="Slack didn't send what Markdrop needs. Try Add to Slack again.")
    other = await db[INSTALLS].find_one({"_id": team_id}, {"workspace_id": 1})
    if other is not None and other.get("workspace_id") != workspace_id:
        raise HTTPException(status_code=409, detail="That Slack workspace is already connected to another Markdrop "
                                                    "workspace. Disconnect it there first.")
    mine = await install_for_workspace(db, workspace_id)
    if mine is not None and mine["_id"] != team_id:
        raise HTTPException(status_code=409, detail="This workspace is connected to another Slack workspace. "
                                                    "Disconnect it first.")
    now = _now()
    granted = [x for x in str(r.get("scope") or "").split(",") if x]
    await db[INSTALLS].update_one(
        {"_id": team_id},
        {"$set": {"team_name": str(team.get("name") or "")[:120], "workspace_id": workspace_id,
                  "app_id": r.get("app_id"), "bot_user_id": r.get("bot_user_id"),
                  "bot_token_enc": crypto.encrypt(token), "scopes": granted, "installed_by": user.id,
                  "updated_at": now},
         "$setOnInsert": {"created_at": now, "meetings_channel": None, "post_meetings": True}},
        upsert=True)
    authed = (r.get("authed_user") or {}).get("id")
    if authed:
        await save_link(db, team_id, str(authed), user.id, None, match="install")
    log.info("slack: team %s connected to workspace %s by %s", team_id, workspace_id, user.id)
    # People of this workspace who already turned Slack notifications on are found in the new team.
    spawn(match_opted_in(db, team_id))
    return await status(db, user, workspace_id)


async def disconnect(db: AsyncIOMotorDatabase, user, workspace_id: str) -> None:
    await require_admin(db, user, workspace_id)
    inst = await install_for_workspace(db, workspace_id)
    if inst is None:
        return
    token = bot_token(inst)
    s = _s()
    if token:
        try:
            await slack_api.call("apps.uninstall", token, client_id=s.slack_client_id, client_secret=s.slack_client_secret)
        except slack_api.SlackError as exc:
            log.info("slack disconnect: apps.uninstall %s (forgetting the team anyway)", exc.error)
    await forget_team(db, inst["_id"])


async def forget_team(db: AsyncIOMotorDatabase, team_id: str) -> None:
    """Delete everything Markdrop keeps for this Slack team (uninstalled, token revoked, disconnected)."""
    await db[INSTALLS].delete_one({"_id": team_id})
    await db[LINKS].delete_many({"team_id": team_id})
    await db["slack_outbox"].update_many({"team_id": team_id, "state": "pending"},
                                         {"$set": {"state": "skipped", "error": "uninstalled"}})


async def set_settings(db: AsyncIOMotorDatabase, user, workspace_id: str, *, channel_id: str | None = ...,
                       post_meetings: bool | None = None, action_item_dms: bool | None = None) -> dict:
    await require_admin(db, user, workspace_id)
    inst = await install_for_workspace(db, workspace_id)
    if inst is None:
        raise HTTPException(status_code=404, detail="Slack isn't connected to this workspace.")
    sets: dict[str, Any] = {"updated_at": _now()}
    if channel_id is None:
        sets["meetings_channel"] = None
    elif channel_id is not ...:
        chans = await channels(db, inst)
        hit = next((c for c in chans if c["id"] == channel_id), None)
        if hit is None:
            raise HTTPException(status_code=422, detail="Pick a channel from the list. For a private channel, "
                                                        "first type /invite @Markdrop in it.")
        sets["meetings_channel"] = {"id": hit["id"], "name": hit["name"], "private": hit["private"]}
    if post_meetings is not None:
        sets["post_meetings"] = bool(post_meetings)
    if action_item_dms is not None:
        # Each person's action items as a direct message after a meeting (services/slack_action_items.py).
        sets["action_item_dms"] = bool(action_item_dms)
    await db[INSTALLS].update_one({"_id": inst["_id"]}, {"$set": sets})
    return await status(db, user, workspace_id)


async def channels(db: AsyncIOMotorDatabase, inst: dict) -> list[dict]:
    """Channels the meetings post can go to: public ones (chat:write.public) and private ones the app was invited to."""
    token = bot_token(inst)
    if not token:
        raise HTTPException(status_code=409, detail="Slack's connection broke. Disconnect and add Markdrop to Slack again.")
    out: list[dict] = []
    cursor = None
    for _ in range(10):
        try:
            r = await slack_api.call("conversations.list", token, types="public_channel,private_channel",
                                     exclude_archived=True, limit=500, cursor=cursor)
        except slack_api.SlackError as exc:
            if exc.dead_token:
                raise HTTPException(status_code=409, detail="Slack's connection broke. Disconnect and add Markdrop to Slack again.")
            raise HTTPException(status_code=502, detail="Slack didn't answer. Try again in a minute.")
        for c in r.get("channels") or []:
            private = bool(c.get("is_private"))
            if private and not c.get("is_member"):
                continue
            out.append({"id": c.get("id"), "name": c.get("name") or "", "private": private,
                        "shared": bool(c.get("is_ext_shared") or c.get("is_shared"))})
        cursor = (r.get("response_metadata") or {}).get("next_cursor")
        if not cursor:
            break
    out.sort(key=lambda c: c["name"])
    return out


# ── Account links ─────────────────────────────────────────────────────────────


def _link_id(team_id: str, slack_user_id: str) -> str:
    return f"{team_id}:{slack_user_id}"


async def save_link(db: AsyncIOMotorDatabase, team_id: str, slack_user_id: str, user_id: str, slack_name: str | None,
                    *, match: str = "oauth") -> None:
    now = _now()
    # A link from before opt-in counted as "on": linking again (which replaces it) mustn't turn that off.
    await keep_legacy_opt_in(db, user_id)
    await db[LINKS].update_one(
        {"_id": _link_id(team_id, slack_user_id)},
        {"$set": {"team_id": team_id, "slack_user_id": slack_user_id, "user_id": user_id,
                  "slack_name": (slack_name or None) and slack_name[:80], "linked_at": now, "match": match}},
        upsert=True)
    # One Slack account per Markdrop account per team: a new link replaces the old one.
    await db[LINKS].delete_many({"team_id": team_id, "user_id": user_id,
                                 "_id": {"$ne": _link_id(team_id, slack_user_id)}})


async def linked_user(db: AsyncIOMotorDatabase, team_id: str, slack_user_id: str):
    """The Markdrop account (models.user.User) linked to this Slack person, else None."""
    from app.services.user import get_user_by_id

    if not team_id or not slack_user_id:
        return None
    row = await db[LINKS].find_one({"_id": _link_id(team_id, slack_user_id)})
    if row is None:
        return None
    return await get_user_by_id(db, row["user_id"])


async def link_for(db: AsyncIOMotorDatabase, team_id: str, user_id: str) -> dict | None:
    return await db[LINKS].find_one({"team_id": team_id, "user_id": user_id})


async def start_link(db: AsyncIOMotorDatabase, user, *, workspace_id: str | None = None,
                     team_id: str | None = None) -> str:
    """Sign in with Slack for the team connected to ``workspace_id`` (the settings card; members
    only), or for ``team_id`` (the button /markdrop shows in Slack; anyone signed in to Markdrop:
    Slack itself then proves who they are there)."""
    need_configured()
    if workspace_id:
        await require_member(db, user, workspace_id)
        inst = await install_for_workspace(db, workspace_id)
    else:
        inst = await get_install(db, team_id)
    if inst is None:
        raise HTTPException(status_code=404, detail="Markdrop isn't connected to that Slack workspace.")
    return link_url(sign_state("link", user.id, inst["_id"]), inst["_id"])


async def link_info(db: AsyncIOMotorDatabase, user, team_id: str) -> dict:
    inst = await get_install(db, team_id)
    if inst is None:
        raise HTTPException(status_code=404, detail="Markdrop isn't connected to that Slack workspace.")
    link = await link_for(db, inst["_id"], user.id)
    return {"team_id": inst["_id"], "team_name": inst.get("team_name") or "",
            "linked": link is not None, "slack_name": (link or {}).get("slack_name")}


async def finish_link(db: AsyncIOMotorDatabase, user, code: str, state: str) -> dict:
    """Sign in with Slack came back: who is this in Slack? Link them; keep no Slack token."""
    need_configured()
    data = read_state(state, "link", user.id)
    if data is None:
        raise HTTPException(status_code=400, detail="This Slack link expired or isn't yours. Try Link my Slack account again.")
    if not await remember(db, "state:" + state[-40:], timedelta(seconds=STATE_TTL * 2)):
        raise HTTPException(status_code=400, detail="This Slack link was already used. Try again.")
    inst = await get_install(db, data.get("w") or "")
    if inst is None:
        raise HTTPException(status_code=404, detail="Markdrop isn't connected to that Slack workspace any more.")
    s = _s()
    try:
        tok = await slack_api.call("openid.connect.token", None, client_id=s.slack_client_id,
                                   client_secret=s.slack_client_secret, code=code, redirect_uri=redirect_uri())
        info = await slack_api.call("openid.connect.userInfo", tok.get("access_token") or "")
    except slack_api.SlackError as exc:
        log.info("slack link: %s", exc.error)
        raise HTTPException(status_code=400, detail="Slack didn't confirm who you are. Try again.")
    team_id = str(info.get("https://slack.com/team_id") or "")
    slack_user = str(info.get("https://slack.com/user_id") or "")
    if not slack_user or team_id != inst["_id"]:
        raise HTTPException(status_code=409, detail=f"You signed in to another Slack workspace. Sign in to "
                                                     f"{inst.get('team_name') or 'the connected one'} instead.")
    await save_link(db, team_id, slack_user, user.id, info.get("name"))
    from app.services import workspace as ws_service

    member = bool(inst.get("workspace_id") and await ws_service.role_for(db, inst["workspace_id"], user.id))
    return {"team_id": team_id, "team_name": inst.get("team_name") or "",
            "workspace_id": inst.get("workspace_id") if member else None, "linked": True, "slack_name": info.get("name")}


async def unlink(db: AsyncIOMotorDatabase, user, workspace_id: str) -> dict:
    await require_member(db, user, workspace_id)
    inst = await install_for_workspace(db, workspace_id)
    if inst is not None:
        await keep_legacy_opt_in(db, user.id)
        await db[LINKS].delete_many({"team_id": inst["_id"], "user_id": user.id})
    return await status(db, user, workspace_id)


# ── Preferences ───────────────────────────────────────────────────────────────


def prefs_of(user_row: dict | None) -> dict[str, bool]:
    """Which kinds of direct message, once Slack notifications are on (each kind on unless turned off)."""
    saved = (user_row or {}).get("slack_notify") or {}
    return {k: saved.get(k) is not False for k in NOTIFY_KINDS}


async def set_prefs(db: AsyncIOMotorDatabase, user_id: str, changes: dict[str, bool]) -> dict[str, bool]:
    sets = {f"slack_notify.{k}": bool(v) for k, v in changes.items() if k in NOTIFY_KINDS}
    if sets:
        await db["users"].update_one({"_id": ObjectId(user_id)}, {"$set": sets})
    return prefs_of(await db["users"].find_one({"_id": ObjectId(user_id)}, {"slack_notify": 1}))


async def dm_on(db: AsyncIOMotorDatabase, user_row: dict | None) -> bool:
    """Did this person turn Slack notifications on? Off by default. Someone who never chose and
    linked their Slack account before opt-in existed (a link row without ``match``) keeps them."""
    if not user_row:
        return False
    saved = (user_row.get("slack_notify") or {}).get("on")
    if saved is not None:
        return saved is True
    return await db[LINKS].find_one({"user_id": str(user_row["_id"]), "match": {"$exists": False}}, {"_id": 1}) is not None


async def keep_legacy_opt_in(db: AsyncIOMotorDatabase, user_id: str) -> None:
    """Write down the implied "on" of a pre-opt-in link before that link row is replaced or stamped."""
    if not ObjectId.is_valid(user_id or ""):
        return
    if await db[LINKS].find_one({"user_id": user_id, "match": {"$exists": False}}, {"_id": 1}) is None:
        return
    await db["users"].update_one({"_id": ObjectId(user_id), "slack_notify.on": {"$exists": False}},
                                 {"$set": {"slack_notify.on": True}})


def can_find_by_email(install: dict | None) -> bool:
    """False when the install is known to lack the scopes users.lookupByEmail needs (made before they
    were added: a workspace admin updates the app; the settings card says so). Shown, not enforced:
    :func:`find_by_email` asks Slack anyway and corrects the stored list from the answer."""
    scopes = (install or {}).get("scopes")
    if not scopes:
        return True
    return all(x in scopes for x in EMAIL_SCOPES)


async def find_by_email(db: AsyncIOMotorDatabase, inst: dict, user_id: str, email: str) -> str:
    """Link ``user_id`` to the person in ``inst``'s Slack team who uses ``email`` (their own Markdrop
    sign-in address; callers never pass another). Returns what happened: linked (already) | matched |
    not_found | taken (that Slack account is linked to another Markdrop account) | needs_update (the
    install lacks users:read.email) | token | error."""
    if await link_for(db, inst["_id"], user_id) is not None:
        return "linked"
    token = bot_token(inst)
    if not token:
        return "token"
    email = (email or "").strip().lower()
    if not email or "@" not in email:
        return "not_found"
    # Asked even when the stored scope list says no: the app may have been reinstalled from Slack's
    # own app page since (that doesn't come through Markdrop). Slack's answer corrects the list.
    try:
        r = await slack_api.call("users.lookupByEmail", token, email=email)
    except slack_api.SlackError as exc:
        if exc.error == "users_not_found":
            await _note_email_scopes(db, inst, True)
            return "not_found"
        if exc.error in ("missing_scope", "no_permission"):
            await _note_email_scopes(db, inst, False)
            return "needs_update"
        if exc.dead_token:
            return "token"
        log.info("slack: users.lookupByEmail in %s: %s", inst["_id"], exc.error)
        return "error"
    await _note_email_scopes(db, inst, True)
    u = r.get("user") or {}
    sid = str(u.get("id") or "")
    profile_email = str((u.get("profile") or {}).get("email") or "").strip().lower()
    # Never someone Slack hasn't confirmed has that address, a bot, or a deactivated account.
    if (not sid or u.get("deleted") or u.get("is_bot") or u.get("is_email_confirmed") is False
            or (profile_email and profile_email != email)):
        return "not_found"
    other = await db[LINKS].find_one({"_id": _link_id(inst["_id"], sid)}, {"user_id": 1})
    if other is not None and other.get("user_id") != user_id:
        return "taken"
    name = (u.get("profile") or {}).get("real_name") or u.get("real_name") or u.get("name")
    await save_link(db, inst["_id"], sid, user_id, name, match="email")
    return "matched"


async def _note_email_scopes(db: AsyncIOMotorDatabase, inst: dict, have: bool) -> None:
    if can_find_by_email(inst) == have:
        return
    op = {"$addToSet": {"scopes": {"$each": list(EMAIL_SCOPES)}}} if have else \
        {"$pull": {"scopes": {"$in": list(EMAIL_SCOPES)}}}
    await db[INSTALLS].update_one({"_id": inst["_id"]}, op)


async def my_installs(db: AsyncIOMotorDatabase, user_id: str) -> list[tuple[dict, str, str]]:
    """(install, workspace id, workspace name) for every Markdrop workspace this person belongs to
    that has Slack connected."""
    from app.services import workspace as ws_service

    pairs = await ws_service.list_for_user(db, user_id)
    names = {w.id: w.name for w, _role in pairs}
    if not names:
        return []
    rows = await db[INSTALLS].find({"workspace_id": {"$in": list(names)}}).to_list(length=100)
    order = list(names)
    rows.sort(key=lambda r: order.index(r["workspace_id"]))
    return [(r, r["workspace_id"], names[r["workspace_id"]]) for r in rows]


def find_message(result: str, team_name: str, email: str, slack_name: str | None = None) -> str | None:
    team = team_name or "that Slack workspace"
    return {
        "matched": f"Found you in {team}" + (f" as {slack_name}." if slack_name else "."),
        "not_found": f"No one in {team} uses {email}. Link your Slack account instead.",
        "taken": f"Your Slack account in {team} is linked to another Markdrop account. "
                 "Link your Slack account here instead, or unlink it there first (/markdrop unlink in Slack).",
        "needs_update": f"Markdrop for Slack in {team} needs an update before Markdrop can find you by email: "
                        "a workspace admin updates it in Workspace settings › Integrations › Slack. "
                        "Or link your Slack account instead.",
        "token": f"{team}'s connection to Markdrop broke: a workspace admin reconnects it.",
        "error": "Slack didn't answer. Try again in a minute.",
    }.get(result)


async def me_status(db: AsyncIOMotorDatabase, user) -> dict:
    """Settings › Account › Slack notifications: on?, which kinds, and each Slack team they're in
    through a Markdrop workspace (found there? as whom?)."""
    urow = await db["users"].find_one({"_id": ObjectId(user.id)}, {"slack_notify": 1})
    teams = []
    for inst, ws_id, ws_name in await my_installs(db, user.id):
        link = await link_for(db, inst["_id"], user.id)
        teams.append({"team_id": inst["_id"], "team_name": inst.get("team_name") or "", "workspace_id": ws_id,
                      "workspace_name": ws_name, "linked": link is not None,
                      "slack_name": (link or {}).get("slack_name"), "match": (link or {}).get("match") or
                      ("legacy" if link is not None else None),
                      "can_find_by_email": can_find_by_email(inst), "token_ok": bot_token(inst) is not None})
    from app.services import slack_action_items

    return {"configured": configured(), "on": await dm_on(db, {"_id": user.id, **(urow or {})}),
            "prefs": prefs_of(urow), "kinds": [{"key": k, "label": NOTIFY_LABELS[k]} for k in NOTIFY_KINDS],
            "action_items": slack_action_items.member_on(urow), "teams": teams, "email": user.email}


async def set_on(db: AsyncIOMotorDatabase, user, on: bool) -> dict:
    """Turn Slack notifications on or off for **this** person (the caller; never anyone else).
    On: find them by their own Markdrop email in every Slack team connected to a workspace of theirs."""
    if not on:
        await db["users"].update_one({"_id": ObjectId(user.id)}, {"$set": {"slack_notify.on": False}})
        return {**await me_status(db, user), "results": []}
    need_configured()
    installs = await my_installs(db, user.id)
    if not installs:
        raise HTTPException(status_code=409, detail="None of your workspaces has Slack connected yet. A workspace "
                                                    "admin adds it in Workspace settings › Integrations › Slack.")
    await db["users"].update_one({"_id": ObjectId(user.id)}, {"$set": {"slack_notify.on": True}})
    results = []
    for inst, _ws_id, _ws_name in installs:
        res = await find_by_email(db, inst, user.id, user.email)
        link = await link_for(db, inst["_id"], user.id) if res in ("matched", "linked") else None
        results.append({"team_id": inst["_id"], "team_name": inst.get("team_name") or "", "result": res,
                        "message": find_message(res, inst.get("team_name") or "", user.email, (link or {}).get("slack_name"))})
    log.info("slack: %s turned Slack notifications on (%s)", user.id, ", ".join(r["result"] for r in results))
    return {**await me_status(db, user), "results": results}


async def match_opted_in(db: AsyncIOMotorDatabase, team_id: str, *, limit: int = 300) -> int:
    """A workspace just connected Slack: find its members who already turned Slack notifications on
    (by their own email). Returns how many were found."""
    inst = await get_install(db, team_id)
    if inst is None or not inst.get("workspace_id"):
        return 0
    member_ids = [m["user_id"] async for m in db["memberships"].find({"workspace_id": inst["workspace_id"]}, {"user_id": 1})]
    oids = [ObjectId(u) for u in member_ids if ObjectId.is_valid(u or "")][:limit]
    found = 0
    async for u in db["users"].find({"_id": {"$in": oids}, "slack_notify.on": True}, {"email": 1}):
        try:
            res = await find_by_email(db, inst, str(u["_id"]), u.get("email") or "")
            if res in ("needs_update", "token"):
                break      # the same answer for everyone: stop asking
            found += res == "matched"
        except Exception:
            log.warning("slack: matching %s in %s failed", u["_id"], team_id, exc_info=True)
    return found


# ── Status (the settings card) ────────────────────────────────────────────────


def _last_run(last: dict | None, admin: bool) -> dict | None:
    """The last meeting's action-items messages, for admins: how many went, how many people Markdrop
    couldn't find in Slack, whether the app needs the email permission (``needs_update``)."""
    if not last or not admin:
        return None
    return {"at": last.get("at"), "title": last.get("title"), "people": int(last.get("people") or 0),
            "queued": int(last.get("queued") or 0), "missing": int(last.get("missing") or 0),
            "needs_update": bool(last.get("needs_update"))}


async def status(db: AsyncIOMotorDatabase, user, workspace_id: str) -> dict:
    from app.models.workspace import role_allows
    from app.services import slack_action_items

    role = await require_member(db, user, workspace_id)
    inst = await install_for_workspace(db, workspace_id)
    me_row = await db["users"].find_one({"_id": ObjectId(user.id)}, {"slack_notify": 1})
    out: dict[str, Any] = {
        "configured": configured(),
        "can_manage": role_allows(role, "admin"),
        "install": None,
        "me": {"linked": False, "slack_user_id": None, "slack_name": None, "match": None, "prefs": prefs_of(me_row),
               "on": await dm_on(db, {"_id": user.id, **(me_row or {})}),
               "action_items": slack_action_items.member_on(me_row)},
        "kinds": [{"key": k, "label": NOTIFY_LABELS[k]} for k in NOTIFY_KINDS],
    }
    if inst is not None:
        installer = None
        if inst.get("installed_by") and ObjectId.is_valid(inst["installed_by"]):
            row = await db["users"].find_one({"_id": ObjectId(inst["installed_by"])}, {"name": 1, "email": 1})
            installer = (row or {}).get("name") or (row or {}).get("email")
        out["install"] = {
            "team_id": inst["_id"], "team_name": inst.get("team_name") or "", "installed_by": installer,
            "installed_at": inst.get("created_at"), "meetings_channel": inst.get("meetings_channel"),
            "post_meetings": inst.get("post_meetings") is not False,
            "linked_people": await db[LINKS].count_documents({"team_id": inst["_id"]}),
            "token_ok": bot_token(inst) is not None,
            "can_find_by_email": can_find_by_email(inst),
            # Each person's action items as a direct message after a meeting (on unless an admin turns it off).
            "action_item_dms": slack_action_items.workspace_on(inst),
            "action_items_last": _last_run(inst.get("action_items_last"), role_allows(role, "admin")),
        }
        link = await link_for(db, inst["_id"], user.id)
        if link is not None:
            out["me"].update({"linked": True, "slack_user_id": link["slack_user_id"], "slack_name": link.get("slack_name"),
                              "match": link.get("match") or "legacy"})
    return out
