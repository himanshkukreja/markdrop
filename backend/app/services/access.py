"""Who may do what to a document — one decision function (access policy, 2026-10-27).

Every surface (REST, MCP, listings, beacons, the live socket, folder pages, the
files API, sync, Google export) asks :func:`can` — ``can(actor, doc, action,
ctx) -> Decision`` — and nothing re-derives a document rule from ``owner_id``,
``access_level``, a password hash or a workspace role on its own (I1).

The evaluation order (policy §2.2), first match decides:

1. credential validity — handled by the auth dependencies before we get here
   (an invalid ``mdk_`` token is a 401 everywhere; an expired session is anonymous);
2. existence — no row, or ``expires_at <= now`` ⇒ 404 (I11);
3. scope — a tenant token's workspace, else the ``X-Markdrop-Workspace`` header,
   must equal the document's workspace ⇒ else 404 (scopes only ever narrow);
4. credential ceiling — tenant tokens read only; MCP writes need documents:write;
5. read — ``doc_role ≠ None ∨ (¬ws.require_auth ∧ level == link ∧ password ok)``;
6. the action rule (``_action``). Without read, every action answers with the
   read denial (404 / 401 gate); with read, a refusal is a 403 with a reason.

Roles::

    member_doc_role = None      if level == private or not a member
                    = "editor"  if workspace role in {owner, admin, member}
                    = "viewer"  if workspace role == viewer
    doc_role        = "owner" if owner or edit secret, else max(grant, member_doc_role)

Grants key on the **address** (lower-cased, IDNA-ASCII domain, no plus/dot
folding) of the authenticated account, never on an email claim in a token (I10).

A grant made by someone other than the owner is *delegated*: it is worth
something only while its authority chain holds, and that is decided when it is
read (:class:`GrantGraph`), not by a cleanup that may lag behind — walk
``parent_grant_id`` to a root; the root must be the owner's grant, or a grant
made through a workspace role its granter still holds (``granted_via``). Every
hop caps the role at its parent's; a cycle, a missing link, a lost membership
or a chain deeper than ``MAX_GRANT_DEPTH`` gives nothing (I9).

A dangling ``workspace_id`` (its workspace is gone) is treated as unfiled for
every rule, and released by the reconciler.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import bcrypt
from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.models.access import Grant, GrantRole, role_allows as grant_role_allows
from app.models.workspace import role_allows as ws_role_allows
from app.services import publicity

MAX_GRANTS_PER_DOCUMENT = 200
# Re-sharing hops from the root grant (the owner's, or a member's) to the
# deepest grant that still gives access. Deeper chains are refused at write
# time and worth nothing at read time.
MAX_GRANT_DEPTH = 10
MCP_WRITE = "documents:write"

# Policy §2.1. `list` is answered for many rows at once by `readable_filter`.
ACTIONS = frozenset({
    "read", "list", "edit_content", "replace_file", "replace_bundle", "list_versions",
    "restore_version", "edit_settings", "set_resharing", "change_access", "rename_slug",
    "delete", "share", "revoke_grant", "see_grants", "file_into_workspace",
    "move_in_workspace", "unshare", "view_stats", "copy", "claim", "sync", "gdocs_export",
    "subscribe", "beacon",
})
# §2.2 step 4: what a tenant token may ever do.
TENANT_ACTIONS = frozenset({"read", "list", "beacon", "subscribe"})
# Actions that change something (MCP needs documents:write for these).
WRITE_ACTIONS = ACTIONS - frozenset({
    "read", "list", "see_grants", "view_stats", "list_versions", "subscribe", "beacon",
})
_ROLE_RANK = {None: 0, "viewer": 1, "editor": 2, "owner": 3}
LEVEL_RANK = {"private": 0, "workspace": 1, "link": 2}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


# ── Identity ──────────────────────────────────────────────────────────────────


def normalize_email(email: str | None) -> str:
    """Lower-cased and stripped; the domain IDNA-encoded to ASCII. No plus or
    dot folding: ``a.lice@`` and ``alice+x@`` are other addresses (G1, I10)."""
    value = (email or "").strip().lower()
    if "@" not in value:
        return value
    local, _, domain = value.rpartition("@")
    try:
        domain = domain.encode("idna").decode("ascii")
    except (UnicodeError, ValueError):
        pass
    return f"{local}@{domain}"


@dataclass
class Actor:
    """Who is asking (policy §1.1). ``cred`` is how they proved it."""

    user: Any = None                     # app.models.user.User | None
    cred: str = "none"                   # none | session | api_token | tenant | mcp
    scopes: frozenset = frozenset()
    tenant_ws: str | None = None
    tenant_host: str | None = None
    edit_secret: str | None = None
    read_password: str | None = None
    site_admin: bool = False

    @property
    def user_id(self) -> str | None:
        return self.user.id if self.user is not None else None

    @property
    def email(self) -> str:
        return normalize_email(getattr(self.user, "email", None)) if self.user is not None else ""

    @classmethod
    def anonymous(cls, **kw) -> "Actor":
        return cls(**kw)

    @classmethod
    def of(cls, user, cred: str = "session", **kw) -> "Actor":
        return cls(user=user, cred=cred if user is not None else "none", **kw)


def actor_from_request(request, user, *, edit_secret: str | None = None,
                       read_password: str | None = None) -> Actor:
    """The actor behind an HTTP request authenticated by optional/require_user."""
    tenant_ws = getattr(request.state, "tenant_workspace", None) if request is not None else None
    auth = request.headers.get("Authorization", "") if request is not None else ""
    token = auth.removeprefix("Bearer ").strip() if auth.startswith("Bearer ") else ""
    if user is None:
        cred = "none"
    elif tenant_ws:
        cred = "tenant"
    elif token.startswith("mdk_"):
        cred = "api_token"
    else:
        cred = "session"
    return Actor(user=user, cred=cred, tenant_ws=tenant_ws, edit_secret=edit_secret or None,
                 read_password=read_password if read_password not in (None, "") else None)


@dataclass
class Ctx:
    """Where the question is asked, plus per-request caches so a listing's
    per-row decisions cost no extra queries (``can_many``)."""

    db: AsyncIOMotorDatabase
    surface: str = "rest"
    workspace_scope: str | None = None
    host: str | None = None
    ip: str | None = None
    now: datetime = field(default_factory=now_utc)
    target_workspace: str | None = None
    _ws: dict = field(default_factory=dict, repr=False)
    _roles: dict = field(default_factory=dict, repr=False)
    _grants: dict = field(default_factory=dict, repr=False)
    _facts: dict = field(default_factory=dict, repr=False)

    async def workspace(self, workspace_id: str | None):
        if not workspace_id:
            return None
        if workspace_id not in self._ws:
            from app.services import workspace as ws_service

            self._ws[workspace_id] = await ws_service.get_workspace(self.db, workspace_id)
        return self._ws[workspace_id]

    async def role(self, workspace_id: str | None, user_id: str | None) -> str | None:
        if not workspace_id or not user_id:
            return None
        key = (workspace_id, user_id)
        if key not in self._roles:
            raw = await self.db["memberships"].find_one(
                {"workspace_id": workspace_id, "user_id": user_id}, {"role": 1})
            self._roles[key] = raw["role"] if raw else None
        return self._roles[key]

    async def grants_for(self, email: str) -> dict[str, str]:
        """document_id → *effective* role for every grant to this address that
        still gives access (its authority chain holds — :class:`GrantGraph`)."""
        if not email:
            return {}
        if email not in self._grants:
            rows = await self.db["document_grants"].find(
                {"email": email},
                {"document_id": 1, "role": 1, "parent_grant_id": 1, "granted_via": 1,
                 "granted_by_user_id": 1}).to_list(length=20_000)
            graph = await GrantGraph.load(self.db, rows)
            out: dict[str, str] = {}
            for r in rows:
                role = graph.role(str(r["_id"]))
                if role is not None:
                    out[r["document_id"]] = role
            self._grants[email] = out
        return self._grants[email]

    def forget(self, doc: dict | None = None) -> None:
        """Drop cached facts (after a write changed them)."""
        if doc is None:
            self._facts.clear()
            self._roles.clear()
            self._grants.clear()
            self._ws.clear()
        else:
            for k in [k for k in self._facts if k[1] == str(doc.get("_id"))]:
                self._facts.pop(k, None)


@dataclass
class Decision:
    allowed: bool
    status: int = 200
    detail: str | None = None
    gate: str | None = None
    code: str | None = None
    role: str | None = None

    def __bool__(self) -> bool:
        return self.allowed

    def exception(self) -> HTTPException:
        headers = {"X-Markdrop-Gate": self.gate} if self.gate else None
        return HTTPException(status_code=self.status, detail=self.detail or "Not allowed", headers=headers)

    def raise_(self) -> "Decision":
        if not self.allowed:
            raise self.exception()
        return self


def _allow(role: str | None = None) -> Decision:
    return Decision(True, 200, role=role)


def not_found() -> Decision:
    return Decision(False, 404, "Document not found", code="not_found")


def _account() -> Decision:
    return Decision(False, 401, "Sign in to do that.", code="account")


def _forbid(detail: str) -> Decision:
    return Decision(False, 403, detail, code="forbidden")


# ── Facts ─────────────────────────────────────────────────────────────────────


@dataclass
class Facts:
    level: str
    has_password: bool
    ws_id: str | None          # effective (None when unfiled or dangling)
    ws: Any
    require_auth: bool
    is_owner: bool
    secret_ok: bool
    grant_role: str | None
    ws_role: str | None
    member_doc_role: str | None
    role: str | None           # without the edit secret
    doc_role: str | None       # with it


def _max_role(a: str | None, b: str | None) -> str | None:
    return a if _ROLE_RANK.get(a, 0) >= _ROLE_RANK.get(b, 0) else b


def _secret_ok(secret: str | None, hashed: str | None) -> bool:
    if not secret or not hashed:
        return False
    try:
        return bcrypt.checkpw(secret.encode(), hashed.encode())
    except ValueError:
        return False


async def facts(actor: Actor, doc: dict, ctx: Ctx) -> Facts:
    key = (id(actor), str(doc.get("_id")), doc.get("slug"))
    cached = ctx._facts.get(key)
    if cached is not None:
        return cached
    level = doc.get("access_level") or "link"
    ws_id = doc.get("workspace_id") or None
    ws = await ctx.workspace(ws_id) if ws_id else None
    if ws is None:
        if ws_id and level == "link":
            # Dangling: its workspace is gone and whether it required sign-in
            # is unknown. Never assume it didn't (I8): until the reconciler
            # releases it (link ⇒ private), it reads as private — owner,
            # grantees and the edit secret only (C1).
            level = "private"
        ws_id = None  # dangling ⇒ unfiled
    uid = actor.user_id
    is_owner = bool(uid) and doc.get("owner_id") == uid
    secret_ok = _secret_ok(actor.edit_secret, doc.get("edit_secret_hash"))
    ws_role = await ctx.role(ws_id, uid) if ws_id and uid else None
    member_doc_role = None
    if ws_role is not None and level != "private":
        member_doc_role = "viewer" if ws_role == "viewer" else "editor"
    grant_role = None
    if uid and doc.get("_id") is not None:
        grant_role = (await ctx.grants_for(actor.email)).get(str(doc["_id"]))
    role = "owner" if is_owner else _max_role(grant_role, member_doc_role)
    f = Facts(
        level=level, has_password=bool(doc.get("read_password_hash")), ws_id=ws_id, ws=ws,
        require_auth=bool(ws is not None and ws.settings.require_auth_to_view),
        is_owner=is_owner, secret_ok=secret_ok, grant_role=grant_role, ws_role=ws_role,
        member_doc_role=member_doc_role, role=role,
        doc_role="owner" if (is_owner or secret_ok) else role,
    )
    ctx._facts[key] = f
    return f


def resharing_allowed(doc: dict) -> bool:
    """Stored value; absent ⇒ true for unfiled documents, false for filed ones."""
    stored = doc.get("allow_resharing")
    if stored is None:
        return not doc.get("workspace_id")
    return bool(stored)


# ── Password attempts (§2.6: 10/min, 50/h per slug + IP ⇒ 429) ────────────────


class _Attempts:
    """Wrong-password attempts per (slug, client IP), shared by every API
    worker through Redis (``settings.redis_url``) — an in-process window let
    each worker grant its own 10/min (A1). Falls back to process memory when
    Redis isn't configured (``memory://``) or doesn't answer, and retries
    Redis after a short pause."""

    PER_MINUTE = 10
    PER_HOUR = 50
    _RETRY_AFTER_S = 30.0

    def __init__(self) -> None:
        self._fails: dict[tuple[str, str], deque] = {}
        self._redis = None
        self._redis_loop = None
        self._down_until = 0.0

    # ── Redis ──
    def _client(self):
        from app.config import get_settings

        url = get_settings().redis_url or ""
        if not url.startswith(("redis://", "rediss://", "unix://")):
            return None
        if time.monotonic() < self._down_until:
            return None
        import asyncio

        loop = asyncio.get_running_loop()
        if self._redis is None or self._redis_loop is not loop:
            import redis.asyncio as aioredis

            self._redis = aioredis.from_url(url, socket_timeout=0.5, socket_connect_timeout=0.5)
            self._redis_loop = loop
        return self._redis

    def _down(self) -> None:
        self._down_until = time.monotonic() + self._RETRY_AFTER_S
        self._redis = None

    @staticmethod
    def _key(slug: str, ip: str | None) -> str:
        import hashlib

        return "md:pwfail:" + hashlib.sha256(f"{slug}\x00{ip or '?'}".encode()).hexdigest()[:40]

    # ── Memory fallback ──
    def _window(self, key) -> deque:
        q = self._fails.setdefault(key, deque())
        cutoff = time.monotonic() - 3600
        while q and q[0] < cutoff:
            q.popleft()
        return q

    def _blocked_memory(self, slug: str, ip: str | None) -> bool:
        q = self._window((slug, ip or "?"))
        recent = sum(1 for t in q if t >= time.monotonic() - 60)
        return recent >= self.PER_MINUTE or len(q) >= self.PER_HOUR

    async def blocked(self, slug: str, ip: str | None) -> bool:
        r = self._client()
        if r is not None:
            try:
                key, now = self._key(slug, ip), time.time()
                pipe = r.pipeline()
                pipe.zremrangebyscore(key, 0, now - 3600)
                pipe.zcount(key, now - 60, "+inf")
                pipe.zcard(key)
                _, recent, total = await pipe.execute()
                return int(recent) >= self.PER_MINUTE or int(total) >= self.PER_HOUR
            except Exception:
                self._down()
        return self._blocked_memory(slug, ip)

    async def fail(self, slug: str, ip: str | None) -> None:
        r = self._client()
        if r is not None:
            try:
                import secrets as _secrets

                key, now = self._key(slug, ip), time.time()
                pipe = r.pipeline()
                pipe.zadd(key, {f"{now:.6f}:{_secrets.token_hex(4)}": now})
                pipe.expire(key, 3600)
                await pipe.execute()
                return
            except Exception:
                self._down()
        self._window((slug, ip or "?")).append(time.monotonic())

    def reset(self) -> None:
        self._fails.clear()


password_attempts = _Attempts()


# ── The decision ──────────────────────────────────────────────────────────────


def _no_read(actor: Actor, *, password_gate: bool) -> Decision:
    if password_gate:
        return Decision(False, 401, "Password required", gate="password", code="password")
    if actor.user is None:
        return Decision(False, 401, "Sign in to view this document.", gate="signin", code="signin")
    return not_found()


async def _read(actor: Actor, doc: dict, f: Facts, ctx: Ctx) -> Decision:
    if f.doc_role is not None:
        return _allow(f.doc_role)
    if f.require_auth or f.level != "link":
        return _no_read(actor, password_gate=False)
    if not f.has_password:
        return _allow(None)
    pw = actor.read_password
    if not pw:
        return _no_read(actor, password_gate=True)
    cache_key = ("pw", id(actor), str(doc.get("_id")))
    if cache_key in ctx._facts:
        return ctx._facts[cache_key]
    if await password_attempts.blocked(doc.get("slug") or "", ctx.ip):
        return Decision(False, 429, "Too many wrong passwords. Try again in a few minutes.",
                        code="rate_limited")
    try:
        ok = bcrypt.checkpw(pw.encode(), doc["read_password_hash"].encode())
    except ValueError:
        ok = False
    if ok:
        d = _allow(None)
    else:
        await password_attempts.fail(doc.get("slug") or "", ctx.ip)
        d = Decision(False, 403, "Incorrect password", code="wrong_password")
    ctx._facts[cache_key] = d
    return d


async def can(actor: Actor, doc: dict | None, action: str, ctx: Ctx) -> Decision:
    """Policy §2.2. Returns a value (never raises), so listings can call it per row."""
    if action not in ACTIONS:
        raise ValueError(f"unknown action {action!r}")
    if doc is None or publicity.is_expired(doc, ctx.now):
        return not_found()
    f = await facts(actor, doc, ctx)
    scope = actor.tenant_ws or ctx.workspace_scope
    if scope is not None and f.ws_id != scope:
        return not_found()
    if actor.cred == "tenant" and action not in TENANT_ACTIONS:
        return Decision(False, 401, "This session only works for reading documents on that "
                                    "workspace's domain.", code="credential")
    if actor.cred == "mcp" and action in WRITE_ACTIONS and MCP_WRITE not in actor.scopes:
        return Decision(False, 403, "insufficient_scope", code="scope")
    # Owners and workspace admins can always take a document out of the
    # workspace, even one they can't read (D4, Q1).
    if action == "unshare" and f.ws_id and (f.is_owner or ws_role_allows(f.ws_role, "admin")):
        return _allow(f.doc_role)
    r = await _read(actor, doc, f, ctx)
    if not r.allowed:
        return r
    return await _action(actor, doc, f, action, ctx)


async def _action(actor: Actor, doc: dict, f: Facts, action: str, ctx: Ctx) -> Decision:
    uid = actor.user_id
    owner = f.is_owner
    editor = owner or f.role == "editor"
    allow = _allow(f.doc_role)

    if action in ("read", "list", "subscribe", "beacon"):
        return allow
    if action == "copy":
        return allow if uid else _account()
    if action == "edit_content":
        if editor or f.secret_ok:
            return allow
        return _forbid("You can read this document but not edit it.") if uid else _account()
    if action in ("replace_file", "list_versions", "restore_version"):
        if editor:
            return allow
        verb = {"replace_file": "replace", "list_versions": "see the versions of",
                "restore_version": "restore versions of"}[action]
        return _forbid(f"You can only {verb} files you own or can edit.") if uid else _account()
    if action == "replace_bundle":
        if owner:
            return allow
        return _forbid("Only the owner can replace a zipped website.") if uid else _account()
    if action in ("edit_settings", "rename_slug", "delete"):
        if owner or f.secret_ok:
            return allow
        what = {"edit_settings": "change its password or expiry",
                "rename_slug": "change its address", "delete": "delete it"}[action]
        return _forbid(f"Only the document's owner can {what}.") if uid else _account()
    if action == "change_access":
        if owner:
            return allow
        if f.secret_ok or uid:
            return _forbid("Only the document's owner can change who it's visible to.")
        return _account()
    if action in ("set_resharing", "view_stats", "sync", "gdocs_export"):
        if owner:
            return allow
        return _forbid("Only the document's owner can do that.") if uid else _account()
    if action == "share":
        if not uid:
            return _account()
        if owner:
            return allow
        if f.role in ("viewer", "editor") and resharing_allowed(doc):
            return allow
        return _forbid("Only the owner can share this document.")
    if action == "revoke_grant":
        return allow if uid else _account()
    if action == "see_grants":
        if not uid:
            return _account()
        if editor:
            return allow
        return Decision(False, 403, "You can see only your own access.", code="own", role=f.doc_role)
    if action == "file_into_workspace":
        if not uid:
            return _account()
        if not owner:
            return not_found()  # an admin can never pull someone else's document in
        target = ctx.target_workspace or f.ws_id
        if target is None or await ctx.workspace(target) is None:
            return Decision(False, 404, "Workspace not found", code="not_found")
        trole = await ctx.role(target, uid)
        if trole is None:
            return Decision(False, 404, "Workspace not found", code="not_found")
        if not ws_role_allows(trole, "member"):
            return _forbid("Viewers can't add documents to a workspace.")
        return allow
    if action == "move_in_workspace":
        if not uid:
            return _account()
        if f.ws_id is None or f.ws_role is None:
            return Decision(False, 404, "Workspace not found", code="not_found")
        if not ws_role_allows(f.ws_role, "member"):
            return _forbid("Viewers can't move documents.")
        return allow
    if action == "unshare":
        if not uid:
            return _account()
        if f.ws_id is None:
            return Decision(False, 404, "That document isn't in a workspace.", code="not_found")
        return _forbid("Only the document's owner or a workspace admin can remove it from "
                       "the workspace.")
    if action == "claim":
        if not uid:
            return _account()
        if doc.get("owner_id") in (None, uid) and (f.secret_ok or owner):
            return allow
        if doc.get("owner_id"):
            return Decision(False, 409, "This document is already owned by another account",
                            code="conflict")
        return _forbid("Invalid edit secret")
    raise ValueError(action)  # pragma: no cover


async def require(actor: Actor, doc: dict | None, action: str, ctx: Ctx) -> Decision:
    """:func:`can`, raising the denial as an HTTPException."""
    return (await can(actor, doc, action, ctx)).raise_()


async def can_flags(actor: Actor, doc: dict, ctx: Ctx) -> dict[str, bool]:
    """What the UI may offer (`can:{…}` in responses, §7) — never re-derived
    on the client (P3)."""
    async def ok(action: str) -> bool:
        return (await can(actor, doc, action, ctx)).allowed

    kind_bundle = bool(doc.get("bundle_prefix"))
    return {
        "edit": await ok("edit_content"),
        "replace": doc.get("kind") == "artifact" and await ok(
            "replace_bundle" if kind_bundle else "replace_file"),
        "settings": await ok("edit_settings"),
        "access": await ok("change_access"),
        "rename": await ok("rename_slug"),
        "delete": await ok("delete"),
        "share": await ok("share"),
        "move": bool(doc.get("workspace_id")) and await ok("move_in_workspace"),
        "unshare": bool(doc.get("workspace_id")) and await ok("unshare"),
    }


async def anonymous_can_read(db: AsyncIOMotorDatabase, doc: dict | None) -> bool:
    """``can(AN, read)`` without a password — what a link crawler or a cache
    may see (OG cards, beacons without a ticket, anonymous folder pages)."""
    return (await can(Actor(), doc, "read", Ctx(db))).allowed


# ── Compatibility wrappers (older call sites) ─────────────────────────────────


async def effective_role(db: AsyncIOMotorDatabase, raw_doc: dict, user_id: str | None,
                         user_email: str | None) -> str | None:
    """"owner" | "editor" | "viewer" | None for a signed-in account."""
    from app.models.user import User

    if not user_id:
        return None
    user = User(id=user_id, email=user_email or "", created_at=now_utc(), updated_at=now_utc())
    f = await facts(Actor.of(user), raw_doc, Ctx(db))
    return f.role


async def can_read(db: AsyncIOMotorDatabase, raw_doc: dict, user_id: str | None,
                   user_email: str | None) -> bool:
    """Level/role read (no password involved): a role, or a link document
    outside a sign-in-required workspace. Expired ⇒ False."""
    from app.models.user import User

    if publicity.is_expired(raw_doc):
        return False
    user = (User(id=user_id, email=user_email or "", created_at=now_utc(), updated_at=now_utc())
            if user_id else None)
    actor = Actor.of(user) if user else Actor()
    f = await facts(actor, raw_doc, Ctx(db))
    return f.doc_role is not None or (not f.require_auth and f.level == "link")


# ── Listings (§4.2) ───────────────────────────────────────────────────────────


def not_expired_clause(now: datetime) -> dict:
    return {"$or": [{"expires_at": None}, {"expires_at": {"$gt": now}}]}


def public_clause() -> dict:
    """What an anonymous visitor can open (outside a sign-in workspace)."""
    return {"access_level": {"$in": ["link", None]}, "read_password_hash": None,
            "encrypted": {"$ne": True}}


async def granted_ids(actor: Actor, ctx: Ctx) -> list[ObjectId]:
    out = []
    for doc_id in (await ctx.grants_for(actor.email)).keys() if actor.user_id else []:
        try:
            out.append(ObjectId(doc_id))
        except Exception:
            continue
    return out


@dataclass
class ReadableFilter:
    """Mongo clauses for one caller and one workspace (all ANDed)."""

    base: list[dict]
    readable: dict
    redacted: dict | None      # admins/owner only: private rows they can't read
    role: str | None
    require_auth: bool

    def query(self, *extra: dict) -> dict:
        return {"$and": [*self.base, self.readable, *[e for e in extra if e]]}

    def redacted_query(self, *extra: dict) -> dict | None:
        if self.redacted is None:
            return None
        return {"$and": [*self.base, self.redacted, *[e for e in extra if e]]}


async def readable_filter(actor: Actor, workspace_id: str, ctx: Ctx) -> ReadableFilter:
    """Rows of ``workspace_id`` the caller can read (§4.2). ``q``, ``kind`` and
    ``folder`` go *inside* (as extra clauses), so counts, totals and search
    never see an unreadable row (A1)."""
    ws = await ctx.workspace(workspace_id)
    require_auth = bool(ws is not None and ws.settings.require_auth_to_view)
    base = [{"workspace_id": workspace_id}, not_expired_clause(ctx.now)]
    uid = actor.user_id
    role = await ctx.role(workspace_id, uid) if (uid and ws is not None) else None
    granted = await granted_ids(actor, ctx)
    nothing = {"_id": {"$in": []}}
    if ws is None:
        return ReadableFilter(base, nothing, None, None, False)
    if role is not None:
        readable = {"$or": [{"owner_id": uid}, {"access_level": {"$ne": "private"}},
                            {"_id": {"$in": granted}}]}
    elif uid:
        ors: list[dict] = [{"owner_id": uid}, {"_id": {"$in": granted}}]
        if not require_auth:
            ors.append(public_clause())
        readable = {"$or": ors}
    else:
        readable = nothing if require_auth else public_clause()
    redacted = None
    if ws_role_allows(role, "admin"):
        redacted = {"access_level": "private", "owner_id": {"$ne": uid}, "_id": {"$nin": granted}}
    return ReadableFilter(base, readable, redacted, role, require_auth)


# ── Grants (§3.2) ─────────────────────────────────────────────────────────────


_UNSET: Any = object()


def _to_grant(raw: dict, effective: Any = _UNSET) -> Grant:
    g = Grant(
        id=str(raw["_id"]),
        document_id=raw["document_id"],
        email=raw["email"],
        role=raw["role"],
        created_at=raw["created_at"],
        granted_by_email=raw.get("granted_by_email"),
        user_id=raw.get("user_id"),
        notified=bool(raw.get("notified")),
    )
    if effective is not _UNSET:
        g.effective_role = effective
        g.active = effective is not None
    return g


def _min_role(a: str | None, b: str | None) -> str | None:
    if a is None or b is None:
        return None
    return a if _ROLE_RANK.get(a, 0) <= _ROLE_RANK.get(b, 0) else b


class GrantGraph:
    """Read-time validity of grants (I9, C-N1/N2/N4/N9).

    ``role(grant_id)`` is the role a grant *currently* gives, or None:

    * no ``parent_grant_id`` and no ``granted_via`` — a root, valid only when
      its granter is the document's owner (``granted_by_user_id`` is the owner,
      or absent on rows that predate the field);
    * ``granted_via`` = W and no parent — a member's grant: valid while the
      document is still filed in W and the granter is still in W, capped at
      what that role may give (viewer ⇒ viewer, member+ ⇒ editor);
    * ``parent_grant_id`` set — the parent's effective role caps it; a missing
      parent, a parent on another document, a cycle or more than
      ``MAX_GRANT_DEPTH`` hops from the root ⇒ None.

    Built from a handful of queries (grants of the documents involved, those
    documents, the memberships the roots rest on), then evaluated in memory."""

    def __init__(self, rows: dict[str, dict], docs: dict[str, dict], roles: dict[tuple, str]):
        self._rows = rows
        self._docs = docs
        self._roles = roles
        self._role: dict[str, str | None] = {}
        self._depth: dict[str, int] = {}

    @classmethod
    async def load(cls, db: AsyncIOMotorDatabase, rows: list[dict]) -> "GrantGraph":
        by_id = {str(r["_id"]): r for r in rows}
        doc_ids = {r["document_id"] for r in rows}
        # Chains are walked over every grant of the documents that have one.
        chained = sorted({r["document_id"] for r in rows if r.get("parent_grant_id")})
        if chained:
            for r in await db["document_grants"].find(
                    {"document_id": {"$in": chained}},
                    {"document_id": 1, "role": 1, "parent_grant_id": 1, "granted_via": 1,
                     "granted_by_user_id": 1, "email": 1}).to_list(
                    length=len(chained) * (MAX_GRANTS_PER_DOCUMENT + 50)):
                by_id.setdefault(str(r["_id"]), r)
        oids = []
        for d in doc_ids:
            try:
                oids.append(ObjectId(d))
            except Exception:
                continue
        docs = {}
        if oids:
            for d in await db["documents"].find(
                    {"_id": {"$in": oids}}, {"owner_id": 1, "workspace_id": 1}).to_list(length=len(oids)):
                docs[str(d["_id"])] = d
        pairs = {(r.get("granted_via"), r.get("granted_by_user_id")) for r in by_id.values()
                 if r.get("granted_via") and not r.get("parent_grant_id") and r.get("granted_by_user_id")}
        roles: dict[tuple, str] = {}
        if pairs:
            for m in await db["memberships"].find(
                    {"$or": [{"workspace_id": w, "user_id": u} for w, u in pairs]},
                    {"workspace_id": 1, "user_id": 1, "role": 1}).to_list(length=len(pairs) + 10):
                roles[(m["workspace_id"], m["user_id"])] = m["role"]
        return cls(by_id, docs, roles)

    def _root_role(self, g: dict) -> str | None:
        doc = self._docs.get(g.get("document_id"))
        if doc is None:
            return None
        via = g.get("granted_via")
        if via:
            if doc.get("workspace_id") != via:
                return None
            ws_role = self._roles.get((via, g.get("granted_by_user_id")))
            if ws_role is None:
                return None
            return _min_role(g.get("role"), "viewer" if ws_role == "viewer" else "editor")
        by = g.get("granted_by_user_id")
        if by is None or by == doc.get("owner_id"):
            return g.get("role")
        return None  # a non-owner's grant with no authority recorded (C-N4)

    def _resolve(self, gid: str) -> None:
        first = self._rows.get(gid)
        chain: list[dict] = []
        seen: set[str] = set()
        cur = gid
        role: str | None
        depth: int
        while True:
            if cur in self._role:
                role, depth = self._role[cur], self._depth[cur]
                break
            g = self._rows.get(cur)
            if g is None or cur in seen or first is None or g.get("document_id") != first.get("document_id"):
                role, depth = None, MAX_GRANT_DEPTH + 1  # missing link, cycle or foreign parent
                break
            seen.add(cur)
            parent = g.get("parent_grant_id")
            if not parent:
                role, depth = self._root_role(g), 0
                self._role[cur], self._depth[cur] = role, 0
                break
            chain.append(g)
            if len(chain) > MAX_GRANT_DEPTH:
                # Too far from any root to count; intermediate hops are left
                # for their own walk (each walk stays bounded).
                self._role[gid], self._depth[gid] = None, MAX_GRANT_DEPTH + 1
                return
            cur = str(parent)
        for g in reversed(chain):
            depth += 1
            role = _min_role(g.get("role"), role) if depth <= MAX_GRANT_DEPTH else None
            key = str(g["_id"])
            self._role[key], self._depth[key] = role, depth

    def role(self, gid: str) -> str | None:
        if gid not in self._role:
            self._resolve(gid)
        return self._role.get(gid)

    def depth(self, gid: str) -> int:
        if gid not in self._depth:
            self._resolve(gid)
        return self._depth.get(gid, MAX_GRANT_DEPTH + 1)


async def document_grant_graph(db: AsyncIOMotorDatabase, document_id: str) -> tuple[list[dict], GrantGraph]:
    rows = await db["document_grants"].find({"document_id": document_id}).to_list(
        length=MAX_GRANTS_PER_DOCUMENT + 50)
    return rows, await GrantGraph.load(db, rows)


async def list_grants(db: AsyncIOMotorDatabase, document_id: str) -> list[Grant]:
    """Every grant of the document, each marked with what it gives *now*
    (``active`` / ``effective_role``): the owner sees a delegated grant whose
    authority lapsed as inactive until housekeeping removes it."""
    rows, graph = await document_grant_graph(db, document_id)
    rows.sort(key=lambda r: r["created_at"])
    return [_to_grant(r, graph.role(str(r["_id"]))) for r in rows[:MAX_GRANTS_PER_DOCUMENT]]


async def grant_for(db: AsyncIOMotorDatabase, document_id: str, email: str | None) -> Grant | None:
    email = normalize_email(email)
    if not email:
        return None
    raw = await db["document_grants"].find_one({"document_id": document_id, "email": email})
    return _to_grant(raw) if raw else None


async def _owner_email(db: AsyncIOMotorDatabase, raw_doc: dict) -> str:
    owner_id = raw_doc.get("owner_id")
    if not owner_id:
        return ""
    try:
        row = await db["users"].find_one({"_id": ObjectId(owner_id)}, {"email": 1})
    except Exception:
        row = None
    return normalize_email((row or {}).get("email"))


def _unchanged(existing: dict, role: str) -> Grant:
    g = _to_grant(existing)
    g.unchanged = True
    return g


async def add_grant(db: AsyncIOMotorDatabase, raw_doc: dict, email: str, role: GrantRole,
                    actor: Actor, ctx: Ctx) -> Grant:
    """G1: normalised address; never the granter's own or the owner's; never
    more than the granter's own role; records who granted it and on what
    authority — the granter's own grant (``parent_grant_id``) or their
    workspace role (``granted_via``).

    Only the owner changes an existing grant. Anyone else asking for a person
    who already has access gets a no-op (same or lower role) or a 409 —
    never a re-parented, re-attributed or downgraded row (C-N2, M7)."""
    from pymongo.errors import DuplicateKeyError

    await require(actor, raw_doc, "share", ctx)
    document_id = str(raw_doc["_id"])
    email = normalize_email(email)
    if not email or "@" not in email:
        raise HTTPException(status_code=422, detail="Enter an email address.")
    f = await facts(actor, raw_doc, ctx)

    if email == await _owner_email(db, raw_doc):
        raise HTTPException(status_code=409, detail="That's the owner of this document.")
    if email == actor.email:
        raise HTTPException(status_code=403, detail="You can't share a document with yourself.")

    def already(existing: dict) -> Grant:
        if grant_role_allows(existing.get("role"), role):
            return _unchanged(existing, role)
        raise HTTPException(status_code=409,
                            detail="That person already has access. Only the document's owner can "
                                   "change their role.")

    existing = await db["document_grants"].find_one({"document_id": document_id, "email": email})
    count = await db["document_grants"].count_documents({"document_id": document_id})
    if count >= MAX_GRANTS_PER_DOCUMENT and not existing:
        raise HTTPException(
            status_code=429,
            detail=f"A document can be shared with at most {MAX_GRANTS_PER_DOCUMENT} people.",
        )
    now = ctx.now

    if f.is_owner:
        row = {
            "document_id": document_id, "email": email, "role": role,
            "granted_by_email": actor.email or None, "granted_by_user_id": actor.user_id,
            "granted_via": None, "parent_grant_id": None,
            "created_at": now, "notified": False,
        }
        result = await db["document_grants"].find_one_and_update(
            {"document_id": document_id, "email": email}, {"$set": row},
            upsert=True, return_document=True,
        )
        if existing is not None and existing.get("role") != role:
            # A role change cascades: grants re-shared from this one are capped.
            await settle_document_grants(db, document_id)
    else:
        if not grant_role_allows(f.role, role):
            raise HTTPException(status_code=403,
                                detail="You can't give someone more access than you have.")
        if existing is not None:
            return already(existing)
        # Whose authority is this? Their own grant, if it suffices; otherwise
        # their workspace role, and the grant dies with it (I9). A grant that
        # rests on the granter's own grant points at it and inherits where
        # *that* came from (C2): validity is the chain, read at read time.
        granted_via = None
        parent_grant_id = None
        if grant_role_allows(f.grant_role, role):
            own = await db["document_grants"].find_one(
                {"document_id": document_id, "email": actor.email}, {"_id": 1, "granted_via": 1})
            if own is None:
                # C-N4: the grant this rests on is gone (revoked meanwhile).
                ctx.forget()
                raise HTTPException(status_code=403,
                                    detail="You can't give someone more access than you have.")
            rows, graph = await document_grant_graph(db, document_id)
            if graph.depth(str(own["_id"])) + 1 > MAX_GRANT_DEPTH:
                raise HTTPException(status_code=403,
                                    detail="This document has been re-shared through too many people. "
                                           "Ask its owner to share it.")
            parent_grant_id = str(own["_id"])
            granted_via = own.get("granted_via")
        elif f.ws_id is not None and grant_role_allows(f.member_doc_role, role):
            granted_via = f.ws_id
        else:
            raise HTTPException(status_code=403,
                                detail="You can't give someone more access than you have.")
        row = {
            "document_id": document_id, "email": email, "role": role,
            "granted_by_email": actor.email or None, "granted_by_user_id": actor.user_id,
            "granted_via": granted_via, "parent_grant_id": parent_grant_id,
            "created_at": now, "notified": False,
        }
        try:
            res = await db["document_grants"].insert_one(row)
        except DuplicateKeyError:
            # Someone (perhaps the owner) granted the same address meanwhile:
            # theirs stands.
            existing = await db["document_grants"].find_one({"document_id": document_id, "email": email})
            if existing is None:  # pragma: no cover - deleted again at once
                raise HTTPException(status_code=409, detail="That changed meanwhile. Try again.")
            return already(existing)
        result = {**row, "_id": res.inserted_id}
    # Race with a delete (§3.8): a grant must never outlive its document.
    if not await db["documents"].find_one({"_id": raw_doc["_id"]}, {"_id": 1}):
        await db["document_grants"].delete_many({"document_id": document_id})
        raise HTTPException(status_code=404, detail="Document not found")
    # Race with the granter losing the authority it rests on (C7, C-N4): read
    # back what the new grant gives *after* it was written. Worthless ⇒ gone.
    if not f.is_owner:
        _rows, graph = await document_grant_graph(db, document_id)
        if graph.role(str(result["_id"])) is None:
            await db["document_grants"].delete_one({"_id": result["_id"], "granted_by_user_id": actor.user_id})
            ctx.forget()
            raise HTTPException(status_code=403, detail="You can't give someone more access than you have.")
    ctx.forget()
    return _to_grant(result)


async def grant_authority_holds(db: AsyncIOMotorDatabase, grant: dict) -> bool:
    """Does this grant still give anything (its chain holds — GrantGraph)?"""
    _rows, graph = await document_grant_graph(db, grant["document_id"])
    return graph.role(str(grant["_id"])) is not None


async def settle_document_grants(db: AsyncIOMotorDatabase, document_id: str) -> int:
    """Housekeeping for one document (read-time validity already applies):
    delete every grant that gives nothing any more and lower stored roles to
    what they give. No hop limit — a whole chain goes at once. Returns how
    many rows changed."""
    rows, graph = await document_grant_graph(db, document_id)
    dead, lowered = [], 0
    for r in rows:
        eff = graph.role(str(r["_id"]))
        if eff is None:
            dead.append(r["_id"])
        elif eff != r.get("role"):
            res = await db["document_grants"].update_one(
                {"_id": r["_id"], "role": r.get("role")}, {"$set": {"role": eff}})
            lowered += res.modified_count
    removed = 0
    if dead:
        res = await db["document_grants"].delete_many({"_id": {"$in": dead}})
        removed = res.deleted_count
    return removed + lowered


async def mark_notified(db: AsyncIOMotorDatabase, grant_id: str) -> None:
    await db["document_grants"].update_one({"_id": ObjectId(grant_id)}, {"$set": {"notified": True}})


async def remove_grant(db: AsyncIOMotorDatabase, raw_doc: dict, email: str, actor: Actor,
                       ctx: Ctx) -> None:
    """The owner removes anybody; anyone else only themselves (G2). Grants
    re-shared from the removed one go with it, synchronously."""
    await require(actor, raw_doc, "revoke_grant", ctx)
    f = await facts(actor, raw_doc, ctx)
    email = normalize_email(email)
    if not f.is_owner and email != actor.email:
        raise HTTPException(status_code=403, detail="Only the owner can remove someone else's access.")
    document_id = str(raw_doc["_id"])
    res = await db["document_grants"].delete_one({"document_id": document_id, "email": email})
    if res.deleted_count:
        await settle_document_grants(db, document_id)
        from app.services import live

        live.access_changed(raw_doc.get("slug"))
    ctx.forget()


async def attach_user(db: AsyncIOMotorDatabase, document_id: str, email: str, user_id: str) -> None:
    """Cosmetic: which account a grant turned out to belong to."""
    await db["document_grants"].update_one(
        {"document_id": document_id, "email": normalize_email(email), "user_id": None},
        {"$set": {"user_id": user_id}},
    )


# ── Level and resharing (§3.6 A1/A2) ─────────────────────────────────────────


async def set_level(db: AsyncIOMotorDatabase, raw_doc: dict, level: str, actor: Actor,
                    ctx: Ctx) -> dict:
    """Change how the document is reachable. Owner (session) only. Closes the
    bytes before narrowing the row; opens them after widening it (I4)."""
    from app.services import transitions

    if level not in LEVEL_RANK:
        raise HTTPException(status_code=422, detail="Unknown access level.")
    await require(actor, raw_doc, "change_access", ctx)
    f = await facts(actor, raw_doc, ctx)
    if level == "workspace":
        if f.ws_id is None:
            raise HTTPException(
                status_code=422,
                detail="Share this document with a workspace first, then it can be workspace-only.",
            )
        if not ws_role_allows(await ctx.role(f.ws_id, actor.user_id), "member"):
            raise HTTPException(
                status_code=403,
                detail="You need to be a member of its workspace to make it workspace-only.",
            )
    current = raw_doc.get("access_level") or "link"
    if current == level:
        return raw_doc
    sets: dict = {"access_level": level, "updated_at": ctx.now}
    if level == "workspace":
        sets["allow_resharing"] = False
    after = await transitions.change(
        db, raw_doc, sets=sets, cas={"workspace_id": raw_doc.get("workspace_id")},
        narrows=LEVEL_RANK[level] < LEVEL_RANK[current],
    )
    ctx.forget(raw_doc)
    return after


async def set_resharing(db: AsyncIOMotorDatabase, raw_doc: dict, allow: bool, actor: Actor,
                        ctx: Ctx) -> None:
    await require(actor, raw_doc, "set_resharing", ctx)
    await db["documents"].update_one({"_id": raw_doc["_id"]}, {"$set": {"allow_resharing": bool(allow)}})
