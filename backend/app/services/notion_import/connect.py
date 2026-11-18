"""Connect Notion: each person's Notion connections (OAuth, public integration), read-only.

One Notion public integration (MARKDROP_NOTION_CLIENT_ID / _CLIENT_SECRET; redirect
``<frontend_url>/integrations/notion/callback``). A person connects a Notion workspace and, on Notion's
consent screen, picks the pages Markdrop may read; Markdrop only ever reads them (never writes to Notion).

* One connection per person per Notion workspace (``notion_connections``, _id ``nc_<hash>``): the Notion
  workspace's id, name and icon, the bot id, who authorised it, and the tokens (access + refresh),
  Fernet-encrypted (utils/crypto, MARKDROP_TOKEN_ENCRYPTION_KEY). Nobody else can use it: every call
  takes the signed-in person and finds only their own rows.
* The OAuth ``state`` is HMAC-signed, bound to the person, 15 minutes, used once (``notion_seen``).
* A token Notion refuses (401) is refreshed once when Notion gave a refresh token; refused again, the
  connection is marked ``broken`` (the card says "Reconnect") and its syncs pause.
* Disconnect: Notion is asked to revoke the token, the row is deleted and its syncs stop. What was
  imported stays in Markdrop.
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

from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.services.notion_import import api
from app.utils import crypto

log = logging.getLogger("markdrop.notion")

CONNS = "notion_connections"
SEEN = "notion_seen"
STATE_TTL = 15 * 60
_LOCKS: dict[str, asyncio.Lock] = {}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: Any) -> datetime | None:
    if not isinstance(dt, datetime):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def iso(dt: Any) -> str | None:
    dt = _aware(dt)
    return dt.isoformat() if dt else None


def configured() -> bool:
    return get_settings().notion_configured


def need_configured() -> None:
    if not configured():
        raise HTTPException(status_code=503, detail="Connect Notion isn't set up on this Markdrop yet. Import a "
                                                    "Notion export file instead.")


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[CONNS].create_index("user_id")
    await db[SEEN].create_index("expires_at", expireAfterSeconds=0)


# ── Signed state ──────────────────────────────────────────────────────────────


def _key() -> bytes:
    s = get_settings()
    return hmac.new(s.auth_secret.encode(), b"markdrop-notion|state|" + s.notion_client_secret.encode(),
                    hashlib.sha256).digest()


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign_state(user_id: str, *, back: str | None = None, at: float | None = None) -> str:
    raw = json.dumps({"u": user_id, "b": back, "t": int(at if at is not None else time.time()),
                      "n": secrets.token_hex(8)}, separators=(",", ":"))
    body = _b64(raw.encode())
    return body + "." + _b64(hmac.new(_key(), body.encode(), hashlib.sha256).digest())


def read_state(state: str, user_id: str, *, at: float | None = None) -> dict | None:
    try:
        body, sig = (state or "").split(".", 1)
        if not hmac.compare_digest(sig, _b64(hmac.new(_key(), body.encode(), hashlib.sha256).digest())):
            return None
        data = json.loads(_unb64(body))
    except (ValueError, TypeError):
        return None
    now = at if at is not None else time.time()
    if data.get("u") != user_id or not (0 <= now - int(data.get("t", 0)) <= STATE_TTL):
        return None
    return data


async def _once(db: AsyncIOMotorDatabase, key: str) -> bool:
    try:
        await db[SEEN].insert_one({"_id": key[:200], "expires_at": now_utc() + timedelta(seconds=STATE_TTL * 2)})
        return True
    except DuplicateKeyError:
        return False


def redirect_uri() -> str:
    return get_settings().frontend_url.rstrip("/") + "/integrations/notion/callback"


def _safe_back(back: str | None) -> str | None:
    if not back or not isinstance(back, str):
        return None
    if not back.startswith("/") or back.startswith("//") or "\\" in back or len(back) > 500:
        return None
    return back


def start(user, back: str | None = None) -> str:
    """Notion's consent screen (where the person picks the pages Markdrop may read)."""
    need_configured()
    q = {"client_id": get_settings().notion_client_id, "redirect_uri": redirect_uri(), "response_type": "code",
         "owner": "user", "state": sign_state(user.id, back=_safe_back(back))}
    return api.base() + "/v1/oauth/authorize?" + urlencode(q)


def conn_id(user_id: str, workspace_id: str) -> str:
    return "nc_" + hashlib.sha256(f"{user_id}:{workspace_id}".encode()).hexdigest()[:20]


def out(row: dict) -> dict:
    return {"id": row["_id"], "workspace_id": row.get("workspace_id"), "workspace_name": row.get("workspace_name"),
            "workspace_icon": row.get("workspace_icon"), "owner_name": row.get("owner_name"),
            "owner_email": row.get("owner_email"), "connected_at": iso(row.get("connected_at")),
            "broken": bool(row.get("broken"))}


async def finish(db: AsyncIOMotorDatabase, user, code: str, state: str) -> dict:
    """Notion came back: check the state, exchange the code, store the tokens (encrypted)."""
    need_configured()
    data = read_state(state, user.id)
    if data is None:
        raise HTTPException(status_code=400, detail="This Notion link expired or isn't yours. Start again.")
    if not await _once(db, "state:" + state[-40:]):
        raise HTTPException(status_code=400, detail="This Notion link was already used. Start again.")
    if not code or len(code) > 500:
        raise HTTPException(status_code=400, detail="Notion didn't send a sign-in code. Connect again.")
    try:
        tok = await api.exchange(grant_type="authorization_code", code=code, redirect_uri=redirect_uri())
    except api.NotionError as exc:
        log.info("notion connect: token %s %s", exc.status, exc.code)
        raise HTTPException(status_code=400, detail="Notion didn't accept the sign-in. Try connecting again.")
    access = tok.get("access_token")
    ws_id = str(tok.get("workspace_id") or "")
    if not access or not ws_id:
        raise HTTPException(status_code=502, detail="Notion's answer was incomplete. Try connecting again.")
    owner = ((tok.get("owner") or {}).get("user") or {}) if isinstance(tok.get("owner"), dict) else {}
    now = now_utc()
    cid = conn_id(user.id, ws_id)
    sets: dict[str, Any] = {
        "user_id": user.id, "workspace_id": ws_id, "workspace_name": str(tok.get("workspace_name") or "Notion")[:120],
        "workspace_icon": (tok.get("workspace_icon") or None), "bot_id": tok.get("bot_id"),
        "owner_name": str(owner.get("name") or "")[:120] or None,
        "owner_email": ((owner.get("person") or {}).get("email") or None),
        "access_enc": crypto.encrypt(access),
        "refresh_enc": crypto.encrypt(tok["refresh_token"]) if tok.get("refresh_token") else None,
        "expires_at": now + timedelta(seconds=int(tok["expires_in"])) if tok.get("expires_in") else None,
        "connected_at": now, "refreshed_at": now, "broken": None}
    await db[CONNS].update_one({"_id": cid}, {"$set": sets}, upsert=True)
    # Syncs paused because this connection had broken pick up again.
    await db["notion_syncs"].update_many({"connection_id": cid, "paused": "connection"},
                                         {"$set": {"paused": None, "next_at": now}})
    log.info("notion: %s connected a Notion workspace", user.id)
    row = await db[CONNS].find_one({"_id": cid})
    return {"connection": out(row), "back": data.get("b")}


async def list_for(db: AsyncIOMotorDatabase, user) -> list[dict]:
    return await db[CONNS].find({"user_id": user.id}).sort("connected_at", 1).to_list(length=20)


async def get_own(db: AsyncIOMotorDatabase, user, cid: str | None) -> dict:
    """The person's own connection (``cid``; or their only one). Anyone else's is "not found"."""
    if cid:
        row = await db[CONNS].find_one({"_id": str(cid), "user_id": user.id})
    else:
        rows = await list_for(db, user)
        if len(rows) > 1:
            raise HTTPException(status_code=422, detail="You've connected more than one Notion workspace: say which.")
        row = rows[0] if rows else None
    if row is None:
        raise HTTPException(status_code=404, detail="Notion isn't connected. Connect Notion first.")
    return row


async def _mark_broken(db: AsyncIOMotorDatabase, cid: str) -> None:
    await db[CONNS].update_one({"_id": cid}, {"$set": {"broken": now_utc()}})
    await db["notion_syncs"].update_many({"connection_id": cid, "paused": None}, {"$set": {"paused": "connection"}})


async def _refresh(db: AsyncIOMotorDatabase, cid: str) -> str | None:
    """A new access token from the refresh token (serialised per connection), or None (then: broken)."""
    lock = _LOCKS.setdefault(cid, asyncio.Lock())
    async with lock:
        row = await db[CONNS].find_one({"_id": cid})
        if row is None or not row.get("refresh_enc"):
            if row is not None:
                await _mark_broken(db, cid)
            return None
        try:
            tok = await api.exchange(grant_type="refresh_token", refresh_token=crypto.decrypt(row["refresh_enc"]))
        except api.NotionError as exc:
            log.info("notion: refresh for %s refused (%s %s)", cid, exc.status, exc.code)
            await _mark_broken(db, cid)
            return None
        sets: dict[str, Any] = {"access_enc": crypto.encrypt(tok["access_token"]), "refreshed_at": now_utc(),
                                "broken": None}
        if tok.get("refresh_token"):
            sets["refresh_enc"] = crypto.encrypt(tok["refresh_token"])
        if tok.get("expires_in"):
            sets["expires_at"] = now_utc() + timedelta(seconds=int(tok["expires_in"]))
        await db[CONNS].update_one({"_id": cid}, {"$set": sets})
        return tok["access_token"]


async def client(db: AsyncIOMotorDatabase, row: dict) -> api.Client:
    """An API client acting as this connection (refreshes the token when Notion refuses it)."""
    if row.get("broken"):
        raise HTTPException(status_code=409, detail="Your Notion connection stopped working. Reconnect Notion.")
    token = crypto.decrypt(row["access_enc"])
    exp = _aware(row.get("expires_at"))
    if exp is not None and exp < now_utc() + timedelta(seconds=60) and row.get("refresh_enc"):
        token = await _refresh(db, row["_id"]) or token
    cid = row["_id"]

    async def on_auth():
        new = await _refresh(db, cid)
        if new is None:
            await _mark_broken(db, cid)
        return new

    return api.Client(token, on_auth_error=on_auth)


async def disconnect(db: AsyncIOMotorDatabase, user, cid: str) -> dict:
    """Revoke (best effort) and forget the connection; its syncs stop. Imported pages stay."""
    row = await get_own(db, user, cid)
    revoked = False
    try:
        revoked = await api.revoke(crypto.decrypt(row["access_enc"]))
    except Exception:
        log.info("notion: revoke failed for %s", cid, exc_info=True)
    await db[CONNS].delete_one({"_id": row["_id"], "user_id": user.id})
    n = await db["notion_syncs"].count_documents({"connection_id": row["_id"]})
    await db["notion_syncs"].delete_many({"connection_id": row["_id"], "user_id": user.id})
    return {"disconnected": True, "revoked": revoked, "syncs_stopped": n}
