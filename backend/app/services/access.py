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
        """document_id → role for every grant to this address (one query)."""
        if not email:
            return {}
        if email not in self._grants:
            rows = await self.db["document_grants"].find(
                {"email": email}, {"document_id": 1, "role": 1}).to_list(length=20_000)
            self._grants[email] = {r["document_id"]: r["role"] for r in rows}
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
    PER_MINUTE = 10
    PER_HOUR = 50

    def __init__(self) -> None:
        self._fails: dict[tuple[str, str], deque] = {}

    def _window(self, key) -> deque:
        q = self._fails.setdefault(key, deque())
        cutoff = time.monotonic() - 3600
        while q and q[0] < cutoff:
            q.popleft()
        return q

    def blocked(self, slug: str, ip: str | None) -> bool:
        q = self._window((slug, ip or "?"))
        recent = sum(1 for t in q if t >= time.monotonic() - 60)
        return recent >= self.PER_MINUTE or len(q) >= self.PER_HOUR

    def fail(self, slug: str, ip: str | None) -> None:
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
    if password_attempts.blocked(doc.get("slug") or "", ctx.ip):
        return Decision(False, 429, "Too many wrong passwords. Try again in a few minutes.",
                        code="rate_limited")
    try:
        ok = bcrypt.checkpw(pw.encode(), doc["read_password_hash"].encode())
    except ValueError:
        ok = False
    if ok:
        d = _allow(None)
    else:
        password_attempts.fail(doc.get("slug") or "", ctx.ip)
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


def _to_grant(raw: dict) -> Grant:
    return Grant(
        id=str(raw["_id"]),
        document_id=raw["document_id"],
        email=raw["email"],
        role=raw["role"],
        created_at=raw["created_at"],
        granted_by_email=raw.get("granted_by_email"),
        user_id=raw.get("user_id"),
        notified=bool(raw.get("notified")),
    )


async def list_grants(db: AsyncIOMotorDatabase, document_id: str) -> list[Grant]:
    rows = await db["document_grants"].find({"document_id": document_id}).to_list(
        length=MAX_GRANTS_PER_DOCUMENT
    )
    rows.sort(key=lambda r: r["created_at"])
    return [_to_grant(r) for r in rows]


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


async def add_grant(db: AsyncIOMotorDatabase, raw_doc: dict, email: str, role: GrantRole,
                    actor: Actor, ctx: Ctx) -> Grant:
    """G1: normalised address; never the granter's own or the owner's; never
    more than the granter's own role; records who granted it and whether that
    authority came from a workspace role (``granted_via``)."""
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

    granted_via = None
    if not f.is_owner:
        if not grant_role_allows(f.role, role):
            raise HTTPException(status_code=403,
                                detail="You can't give someone more access than you have.")
        # Whose authority is this? The grant alone, if it suffices; otherwise it
        # came from workspace membership, and dies with it (I9).
        if not grant_role_allows(f.grant_role, role):
            granted_via = f.ws_id

    count = await db["document_grants"].count_documents({"document_id": document_id})
    exists = await db["document_grants"].find_one({"document_id": document_id, "email": email},
                                                  {"_id": 1})
    if count >= MAX_GRANTS_PER_DOCUMENT and not exists:
        raise HTTPException(
            status_code=429,
            detail=f"A document can be shared with at most {MAX_GRANTS_PER_DOCUMENT} people.",
        )

    now = ctx.now
    row = {
        "document_id": document_id, "email": email, "role": role,
        "granted_by_email": actor.email or None, "granted_by_user_id": actor.user_id,
        "granted_via": granted_via, "created_at": now, "notified": False,
    }
    result = await db["document_grants"].find_one_and_update(
        {"document_id": document_id, "email": email}, {"$set": row},
        upsert=True, return_document=True,
    )
    # Race with a delete (§3.8): a grant must never outlive its document.
    if not await db["documents"].find_one({"_id": raw_doc["_id"]}, {"_id": 1}):
        await db["document_grants"].delete_many({"document_id": document_id})
        raise HTTPException(status_code=404, detail="Document not found")
    ctx.forget()
    return _to_grant(result)


async def mark_notified(db: AsyncIOMotorDatabase, grant_id: str) -> None:
    await db["document_grants"].update_one({"_id": ObjectId(grant_id)}, {"$set": {"notified": True}})


async def remove_grant(db: AsyncIOMotorDatabase, raw_doc: dict, email: str, actor: Actor,
                       ctx: Ctx) -> None:
    """The owner removes anybody; anyone else only themselves (G2)."""
    await require(actor, raw_doc, "revoke_grant", ctx)
    f = await facts(actor, raw_doc, ctx)
    email = normalize_email(email)
    if not f.is_owner and email != actor.email:
        raise HTTPException(status_code=403, detail="Only the owner can remove someone else's access.")
    res = await db["document_grants"].delete_one({"document_id": str(raw_doc["_id"]), "email": email})
    if res.deleted_count:
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
