"""Asking a document's owner for access (simpler workspaces UI).

``access_requests`` rows: ``{_id, doc_id, slug, owner_id, requester_user_id,
requester_email, requester_name, message, status: pending|approved|declined,
role_granted, created_at, decided_at, decided_by, notified}``; at most one
*pending* row per (document, requester) — a partial unique index.

Who may ask (no new existence oracle, I5): a signed-in caller who can't read
the document **and** for whom the read is the plain denial whose only
existence signal is the documented anonymous ``401 signin`` (§2.6) — i.e. an
anonymous read of that document answers the sign-in gate. That is exactly
what the app shows as the "You don't have access" (denied) gate. Missing and
expired documents answer the same 404 as ``GET /documents/{slug}``; a
password gate is not a denial (they need the password, not an invitation);
someone who can already read it gets 409.

Who decides: the document's owner only — ``can(change_access)``, which is the
owner's own session — and only while they own it. Approving goes through the
normal ``access.add_grant`` owner path (an owner-made root grant, which
survives every membership change, I9). Deciding twice the same way is a
no-op; a different second decision is a 409.

Over MCP (app/mcp/access_request_tools.py) the same functions answer: an
assistant's token may ask (``create``), list the requests its user decides on
(``list_for_owner``, a read: a read-only token sees them too) or made
(``list_for_requester``), and decide (``decide``, which needs documents:write).

Edit requests (``role: "editor"``, "Request edit access", 2026-11-04): from
someone who can already *read* the page but not edit it (a workspace viewer, a
viewer grant, a reader of a link page) — on markdrop.in or on the workspace's
own domain (a tenant token may make only this kind, for a page of its own
workspace: every check is ``access.can`` with the token's workspace pinned).
They go to the page's owner. Only when the page has no reachable owner (the
account is gone, has no address, or left the page's workspace) do they go to
that workspace's admins instead (``admin_workspace_id`` on the row), who may
then decide on it while the page is still in that workspace. Approving gives
editor on **that page only**: the grant carries ``sub_role`` (what the
sub-pages that inherit from it get: nothing new, or the viewer access the
person already had there). Only "edit" or "decline" answer an edit request. A
declined edit request can't be asked again for a day (``DECLINED_COOLDOWN``).
"""

from __future__ import annotations

import dataclasses
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.models.access import role_allows as grant_role_allows
from app.services import access, mailer, publicity, urls

COLL = "access_requests"
MAX_MESSAGE = 500
PER_USER_PER_HOUR = 10
ROLE_FOR = {"view": "viewer", "edit": "editor"}
# A declined edit request: the same person can't ask the same page again for this long.
DECLINED_COOLDOWN = timedelta(hours=24)
MAX_ADMIN_EMAILS = 20


def requested_role(row: dict | None) -> str:
    """``viewer`` (asking to open it; every row before edit requests) or ``editor``."""
    return "editor" if (row or {}).get("role_requested") == "editor" else "viewer"


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index(
        [("doc_id", 1), ("requester_user_id", 1)], unique=True,
        partialFilterExpression={"status": "pending"}, name="one_pending_per_doc_user")
    await db[COLL].create_index([("owner_id", 1), ("status", 1), ("created_at", -1)])
    await db[COLL].create_index([("requester_user_id", 1), ("created_at", -1)])


def not_found() -> HTTPException:
    """Byte-for-byte the read route's 404."""
    return HTTPException(status_code=404, detail="Document not found")


def request_not_found() -> HTTPException:
    return HTTPException(status_code=404, detail="Request not found")


def _oid(value: str) -> ObjectId | None:
    try:
        return ObjectId(value)
    except Exception:
        return None


def display_title(raw: dict | None) -> str | None:
    if not raw or raw.get("encrypted"):
        return None
    return raw.get("title") or raw.get("original_filename") or None


def _mail_title(raw: dict) -> str:
    if raw.get("encrypted"):
        return "an encrypted document"
    return display_title(raw) or f"/{raw.get('slug')}"


async def _load_for_read(db: AsyncIOMotorDatabase, slug: str) -> dict | None:
    from app.services import document as doc_service

    raw, _moved = await doc_service.find_for_read(db, slug)
    return raw


async def eligibility(db: AsyncIOMotorDatabase, actor: access.Actor, raw: dict | None,
                      ctx: access.Ctx) -> str:
    """``readable`` | ``eligible`` (the denied gate) | ``gated`` (a password
    gate / wrong password / rate limit: existence already known, not a
    denial) | ``not_found`` (answer exactly like a missing document)."""
    d = await access.can(actor, raw, "read", ctx)
    if d.allowed:
        return "readable"
    if d.status != 404:
        return "gated"
    if raw is None or not raw.get("owner_id"):
        return "not_found"
    # Only where an anonymous read already reveals existence (the accepted
    # `401 signin` oracle). Asked in a context of its own (no caller caches).
    anon = await access.can(access.Actor(), raw, "read", access.Ctx(db))
    return "eligible" if anon.gate == "signin" else "not_found"


async def edit_eligibility(db: AsyncIOMotorDatabase, actor: access.Actor, raw: dict | None,
                           ctx: access.Ctx) -> str:
    """For an edit request: ``eligible`` (reads it, may not edit it), ``editable`` (already
    may), ``unreadable`` (a gate: password, sign-in), ``nobody`` (no owner and no workspace to
    ask), or ``not_found`` (answer exactly like a missing document)."""
    d = await access.can(actor, raw, "read", ctx)
    if not d.allowed:
        return "not_found" if d.status == 404 else "unreadable"
    e = await access.can(actor, raw, "edit_content", ctx)
    if e.allowed:
        return "editable"
    if e.status != 403:
        return "unreadable"
    if not raw.get("owner_id") and not raw.get("workspace_id"):
        return "nobody"
    return "eligible"


async def create(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, slug: str,
                 message: str | None, role: str = "viewer") -> dict:
    user = actor.user
    if actor.cred == "tenant" and role != "editor":
        # A workspace's domain asks only for edit access to a page it can already read; asking to
        # open something goes through markdrop.in (no existence oracle on a customer's domain).
        raise HTTPException(status_code=401, detail="Ask for access on markdrop.in.")
    raw = await _load_for_read(db, slug)
    if role == "editor":
        state = await edit_eligibility(db, actor, raw, ctx)
        if state == "not_found":
            raise not_found()
        if state == "editable":
            raise HTTPException(status_code=409, detail="You can already edit this.")
        if state == "unreadable":
            raise HTTPException(status_code=403, detail="Open it first, then ask to edit it.")
        if state == "nobody":
            raise HTTPException(status_code=409, detail="Nobody can approve edits to this one.")
        declined = await db[COLL].find_one(
            {"doc_id": str(raw["_id"]), "requester_user_id": user.id, "role_requested": "editor",
             "status": "declined", "decided_at": {"$gt": _now() - DECLINED_COOLDOWN}}, {"_id": 1})
        if declined is not None:
            raise HTTPException(status_code=429,
                                detail="They declined your last request. You can ask again tomorrow.",
                                headers={"Retry-After": str(int(DECLINED_COOLDOWN.total_seconds()))})
    else:
        state = await eligibility(db, actor, raw, ctx)
        if state == "not_found":
            raise not_found()
        if state == "readable":
            raise HTTPException(status_code=409, detail="You can already open this.")
        if state == "gated":
            raise HTTPException(status_code=403,
                                detail="This one is protected by a password. Ask its owner for it.")
    doc_id = str(raw["_id"])
    existing = await db[COLL].find_one(
        {"doc_id": doc_id, "requester_user_id": user.id, "status": "pending"}, {"_id": 1})
    if existing is not None:
        raise HTTPException(status_code=409,
                            detail="You've already asked. You'll get an email when they decide.")
    recent = await db[COLL].count_documents(
        {"requester_user_id": user.id, "created_at": {"$gt": _now() - timedelta(hours=1)}})
    if recent >= PER_USER_PER_HOUR:
        raise HTTPException(status_code=429,
                            detail="You've sent a lot of requests in the last hour. Try again later.",
                            headers={"Retry-After": "3600"})
    message = (message or "").strip()[:MAX_MESSAGE] or None
    row = {
        "doc_id": doc_id, "slug": raw["slug"], "owner_id": raw.get("owner_id"),
        "requester_user_id": user.id, "requester_email": actor.email,
        "requester_name": user.name or None, "message": message, "status": "pending",
        "role_granted": None, "created_at": _now(), "decided_at": None, "decided_by": None,
        "notified": False,
    }
    owner = None
    if role == "editor":
        row["role_requested"] = "editor"
        owner = await reachable_owner(db, raw)
        if owner is None:
            # No reachable owner: the page's workspace admins answer instead.
            if not raw.get("workspace_id"):
                raise HTTPException(status_code=409, detail="Nobody can approve edits to this one.")
            row["admin_workspace_id"] = raw["workspace_id"]
    try:
        res = await db[COLL].insert_one(row)
    except DuplicateKeyError:
        raise HTTPException(status_code=409,
                            detail="You've already asked. You'll get an email when they decide.")
    row["_id"] = res.inserted_id
    if role == "editor":
        await _notify_edit_request(db, raw, row, actor, owner)
    else:
        await _notify_owner(db, raw, row, actor)
    # Approve / Decline in Slack too, for deciders who linked it (services/slack_notify).
    from app.services import slack_notify

    await slack_notify.queue_access_request(db, raw, row)
    return row


async def reachable_owner(db: AsyncIOMotorDatabase, raw: dict) -> dict | None:
    """The page owner's user row when an edit request can go to them: the account exists and has
    an address, and (for a page in a workspace) they are still a member of it. Else None."""
    oid = _oid(raw.get("owner_id") or "")
    owner = await db["users"].find_one({"_id": oid}, {"email": 1, "name": 1}) if oid else None
    if not owner or not owner.get("email"):
        return None
    if raw.get("workspace_id"):
        member = await db["memberships"].find_one(
            {"workspace_id": raw["workspace_id"], "user_id": raw["owner_id"]}, {"_id": 1})
        if member is None:
            return None
    return owner


async def _admin_rows(db: AsyncIOMotorDatabase, workspace_id: str) -> list[dict]:
    return await db["memberships"].find(
        {"workspace_id": workspace_id, "role": {"$in": ["admin", "owner"]}},
        {"user_id": 1}).to_list(length=MAX_ADMIN_EMAILS * 2)


async def _notify_edit_request(db: AsyncIOMotorDatabase, raw: dict, row: dict, actor: access.Actor,
                               owner: dict | None) -> None:
    if not mailer.is_configured():
        return
    to: list[str] = []
    if owner is not None:
        to = [owner["email"]]
    else:
        ids = [_oid(m["user_id"]) for m in await _admin_rows(db, row["admin_workspace_id"])]
        users = await db["users"].find({"_id": {"$in": [i for i in ids if i]}}, {"email": 1}).to_list(
            length=MAX_ADMIN_EMAILS * 2)
        to = sorted({u["email"] for u in users if u.get("email")})[:MAX_ADMIN_EMAILS]
    workspace_name = None
    if raw.get("workspace_id"):
        ws = await access.Ctx(db).workspace(raw["workspace_id"])
        workspace_name = getattr(ws, "name", None)
    sent = False
    for email in to:
        try:
            await mailer.send_edit_request_email(
                to_email=email,
                requester_name=actor.user.name or actor.email,
                requester_email=actor.email,
                document_title=_mail_title(raw),
                message=row.get("message"),
                request_id=str(row["_id"]),
                as_admin=owner is None,
                workspace_name=workspace_name,
            )
            sent = True
        except Exception:
            pass  # the in-app list has it either way
    if sent:
        await db[COLL].update_one({"_id": row["_id"]}, {"$set": {"notified": True}})


async def _notify_owner(db: AsyncIOMotorDatabase, raw: dict, row: dict, actor: access.Actor) -> None:
    if not mailer.is_configured():
        return
    owner = await db["users"].find_one({"_id": _oid(raw["owner_id"])}, {"email": 1})
    if not owner or not owner.get("email"):
        return
    workspace_name = None
    if raw.get("workspace_id"):
        ctx = access.Ctx(db)
        ws = await ctx.workspace(raw["workspace_id"])
        if ws is not None and await ctx.role(raw["workspace_id"], actor.user_id) is None:
            workspace_name = ws.name
    try:
        await mailer.send_access_request_email(
            to_email=owner["email"],
            requester_name=actor.user.name or actor.email,
            requester_email=actor.email,
            document_title=_mail_title(raw),
            message=row.get("message"),
            request_id=str(row["_id"]),
            workspace_name=workspace_name,
        )
        await db[COLL].update_one({"_id": row["_id"]}, {"$set": {"notified": True}})
    except Exception:
        pass  # the in-app list has it either way


async def mine(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, slug: str,
               role: str = "viewer") -> dict:
    """What the gate page needs: may this caller ask, and is a request open. ``role="editor"``:
    the same for "Request edit access" (a reader of the page who may not edit it)."""
    raw = await _load_for_read(db, slug)
    if role == "editor":
        state = await edit_eligibility(db, actor, raw, ctx)
        if state == "not_found":
            raise not_found()
        out = {"can_request_access": state == "eligible", "request_pending": False, "request": None}
        if state != "eligible":
            return out
        latest = await db[COLL].find_one(
            {"doc_id": str(raw["_id"]), "requester_user_id": actor.user_id, "role_requested": "editor"},
            sort=[("created_at", -1)])
        if latest is not None:
            out["request_pending"] = latest.get("status") == "pending"
            out["request"] = {"id": str(latest["_id"]), "status": latest.get("status"),
                              "created_at": latest.get("created_at"),
                              "decided_at": latest.get("decided_at")}
        return out
    if actor.cred == "tenant":
        raise HTTPException(status_code=401, detail="Ask for access on markdrop.in.")
    state = await eligibility(db, actor, raw, ctx)
    if state == "not_found":
        raise not_found()
    out = {"can_request_access": state == "eligible", "request_pending": False, "request": None}
    if state != "eligible":
        return out
    latest = await db[COLL].find_one(
        {"doc_id": str(raw["_id"]), "requester_user_id": actor.user_id},
        sort=[("created_at", -1)])
    if latest is not None:
        out["request_pending"] = latest.get("status") == "pending"
        out["request"] = {"id": str(latest["_id"]), "status": latest.get("status"),
                          "created_at": latest.get("created_at"),
                          "decided_at": latest.get("decided_at")}
    return out


# ── The owner's side ─────────────────────────────────────────────────────────


def _as_decider(actor: access.Actor) -> access.Actor:
    """Who may decide is a question about the person, not their credential's write scope: a
    read-only MCP token lists the requests its user decides on. Deciding itself needs
    documents:write (``decide``)."""
    if actor.cred == "mcp" and access.MCP_WRITE not in actor.scopes:
        return dataclasses.replace(actor, scopes=frozenset(actor.scopes) | {access.MCP_WRITE})
    return actor


async def _owned_doc(db: AsyncIOMotorDatabase, row: dict, actor: access.Actor,
                     ctx: access.Ctx) -> dict | None:
    """The request's document when the caller may decide on it, else None. Its owner, now; or,
    for an edit request that went to the workspace's admins (no reachable owner), an admin of
    that workspace while the page is still in it. Expired/deleted ⇒ None."""
    oid = _oid(row.get("doc_id") or "")
    raw = await db["documents"].find_one({"_id": oid}) if oid else None
    if raw is None or publicity.is_expired(raw):
        return None
    actor = _as_decider(actor)
    if (await access.can(actor, raw, "change_access", ctx)).allowed:
        return raw
    if await _admin_decides(db, row, raw, actor, ctx):
        return raw
    return None


async def _admin_decides(db: AsyncIOMotorDatabase, row: dict, raw: dict, actor: access.Actor,
                         ctx: access.Ctx) -> bool:
    """An edit request routed to the admins, decided by one of them."""
    ws_id = row.get("admin_workspace_id")
    if requested_role(row) != "editor" or not ws_id or not actor.user_id:
        return False
    if actor.cred not in ("session", "api_token", "mcp"):
        return False  # never a workspace domain's tenant token
    if raw.get("workspace_id") != ws_id:
        return False
    from app.models.workspace import role_allows

    return role_allows(await ctx.role(ws_id, actor.user_id), "admin")


async def _shape(db: AsyncIOMotorDatabase, row: dict, raw: dict, hosts: urls.HostCache) -> dict:
    return {
        "id": str(row["_id"]),
        "status": row.get("status"),
        "role_requested": requested_role(row),
        "as_admin": bool(row.get("admin_workspace_id")),
        "message": row.get("message"),
        "created_at": row.get("created_at"),
        "decided_at": row.get("decided_at"),
        "role_granted": row.get("role_granted"),
        "requester": {"email": row.get("requester_email"), "name": row.get("requester_name")},
        "document": {"slug": raw["slug"], "title": display_title(raw),
                     "kind": raw.get("kind") or "markdown", "encrypted": bool(raw.get("encrypted")),
                     "access": raw.get("access_level") or "link",
                     "url": await urls.canonical_url(db, raw, hosts)},
    }


async def list_for_owner(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx,
                         status: str = "pending", limit: int = 50) -> dict:
    # Their own pages, plus edit requests that went to a workspace they administer.
    admin_ws = [m["workspace_id"] for m in await db["memberships"].find(
        {"user_id": actor.user_id, "role": {"$in": ["admin", "owner"]}}, {"workspace_id": 1}).to_list(
        length=500)] if actor.user_id else []
    who: dict = {"owner_id": actor.user_id}
    if admin_ws:
        who = {"$or": [who, {"admin_workspace_id": {"$in": admin_ws}, "role_requested": "editor"}]}
    query: dict = dict(who)
    if status != "all":
        query["status"] = status
    rows = await db[COLL].find(query).sort([("created_at", -1), ("_id", -1)]).limit(
        limit * 2 + 20).to_list(length=limit * 2 + 20)
    hosts = urls.HostCache(db)
    out = []
    for row in rows:
        raw = await _owned_doc(db, row, actor, ctx)
        if raw is None:
            continue
        out.append(await _shape(db, row, raw, hosts))
        if len(out) >= limit:
            break
    pending = 0
    for row in await db[COLL].find({**who, "status": "pending"},
                                   {"doc_id": 1, "role_requested": 1, "admin_workspace_id": 1}).to_list(
            length=500):
        if await _owned_doc(db, row, actor, ctx) is not None:
            pending += 1
    return {"requests": out, "pending_count": pending}


async def for_decider(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx,
                      request_id: str) -> tuple[dict, dict]:
    """(request row, its document) when the caller may decide on it; else the 404 of an id that
    never existed."""
    oid = _oid(request_id)
    row = await db[COLL].find_one({"_id": oid}) if oid else None
    raw = await _owned_doc(db, row, actor, ctx) if row else None
    if raw is None:
        raise request_not_found()
    return row, raw


async def get_for_owner(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx,
                        request_id: str) -> dict:
    row, raw = await for_decider(db, actor, ctx, request_id)
    return await _shape(db, row, raw, urls.HostCache(db))


async def list_for_requester(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx,
                             status: str = "pending", limit: int = 50) -> dict:
    """The caller's own requests, newest first. The document's title and link only while the
    caller can open it now (a request to open something they still can't shows its slug alone,
    the address they asked at); a deleted or expired one shows ``available: false``."""
    query: dict = {"requester_user_id": actor.user_id}
    if status != "all":
        query["status"] = status
    rows = await db[COLL].find(query).sort([("created_at", -1), ("_id", -1)]).limit(limit).to_list(
        length=limit) if actor.user_id else []
    hosts = urls.HostCache(db)
    out = []
    for row in rows:
        oid = _oid(row.get("doc_id") or "")
        raw = await db["documents"].find_one({"_id": oid}) if oid else None
        readable = raw is not None and (await access.can(actor, raw, "read", ctx)).allowed
        out.append({
            "id": str(row["_id"]),
            "status": row.get("status"),
            "role_requested": requested_role(row),
            "as_admin": bool(row.get("admin_workspace_id")),
            "message": row.get("message"),
            "created_at": row.get("created_at"),
            "decided_at": row.get("decided_at"),
            "role_granted": row.get("role_granted"),
            "requester": {"email": row.get("requester_email"), "name": row.get("requester_name")},
            "document": {"slug": raw["slug"] if readable else row.get("slug"),
                         "title": display_title(raw) if readable else None,
                         "available": readable,
                         "url": await urls.canonical_url(db, raw, hosts) if readable else None},
        })
    return {"requests": out}


def _settled(row: dict, status: str, role: str | None) -> bool:
    return row.get("status") == status and (role is None or row.get("role_granted") == role)


async def decide(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx,
                 request_id: str, decision: str) -> dict:
    if actor.cred == "mcp" and access.MCP_WRITE not in actor.scopes:
        raise HTTPException(status_code=403, detail="insufficient_scope")
    # Not theirs (or gone): the same answer as an id that never existed.
    row, raw = await for_decider(db, actor, ctx, request_id)
    status = "declined" if decision == "decline" else "approved"
    role = ROLE_FOR.get(decision)
    editing = requested_role(row) == "editor"
    if editing and decision == "view":
        raise HTTPException(status_code=422, detail="They can already view it. Let them edit, or decline.")

    def answer(r: dict) -> dict:
        return {"id": str(r["_id"]), "status": r.get("status"), "role_granted": r.get("role_granted"),
                "decided_at": r.get("decided_at")}

    if row.get("status") != "pending":
        if _settled(row, status, role):
            return answer(row)  # idempotent: nothing more happens
        raise HTTPException(status_code=409, detail=f"This request was already {row.get('status')}.")
    now = _now()
    claimed = await db[COLL].find_one_and_update(
        {"_id": row["_id"], "status": "pending"},
        {"$set": {"status": status, "role_granted": role, "decided_at": now,
                  "decided_by": actor.user_id}},
        return_document=ReturnDocument.AFTER)
    if claimed is None:  # decided concurrently
        again = await db[COLL].find_one({"_id": row["_id"]}) or row
        if _settled(again, status, role):
            return answer(again)
        raise HTTPException(status_code=409, detail=f"This request was already {again.get('status')}.")

    if role is not None:
        try:
            if editing:
                await _grant_page_edit(db, raw, row, actor, ctx)
            else:
                await _grant(db, raw, row["requester_email"], role, actor, ctx)
        except HTTPException:
            # Nothing was shared: the request is open again.
            await db[COLL].update_one(
                {"_id": row["_id"], "status": status, "decided_at": now},
                {"$set": {"status": "pending", "role_granted": None, "decided_at": None,
                          "decided_by": None}})
            raise
    await _notify_requester(db, raw, claimed, actor, approved=role is not None, role=role,
                            edit_request=editing)
    return answer(claimed)


async def _grant_page_edit(db: AsyncIOMotorDatabase, raw: dict, row: dict, actor: access.Actor,
                           ctx: access.Ctx) -> None:
    """Editor on this page only (an approved edit request). The sub-pages that inherit from it get
    what this person's grant gave them before (``sub_role``), never more.

    The owner approves through ``access.add_grant`` (an owner-made root grant). An admin approves
    on the workspace's authority (``granted_via``: valid while the page is in the workspace and
    they are still an admin there, like any member's grant) — written here because a filed page
    can't be re-shared through ``add_grant`` by anyone but its owner."""
    email = access.normalize_email(row["requester_email"])
    doc_id = str(raw["_id"])
    existing = await db["document_grants"].find_one({"document_id": doc_id, "email": email})
    before = None
    if existing is not None:
        before = existing["sub_role"] if "sub_role" in existing else existing.get("role")
        effective = (await ctx.grants_for(email)).get(doc_id)
        if effective is not None and grant_role_allows(effective, "editor"):
            return  # already an editor here
        before = access._min_role(before, effective) if effective is not None else None
    if (await access.can(actor, raw, "change_access", ctx)).allowed:
        grant = await access.add_grant(db, raw, email, "editor", actor, ctx)
        await db["document_grants"].update_one({"_id": _oid(grant.id)}, {"$set": {"sub_role": before}})
        ctx.forget()
        try:
            await access.mark_notified(db, grant.id)
        except Exception:
            pass
        return
    # An admin (checked by the caller, _owned_doc → _admin_decides).
    ws_id = row["admin_workspace_id"]
    owner_email = None
    if raw.get("owner_id"):
        o = await db["users"].find_one({"_id": _oid(raw["owner_id"])}, {"email": 1})
        owner_email = access.normalize_email((o or {}).get("email"))
    if email == owner_email:
        raise HTTPException(status_code=409, detail="That's the owner of this document.")
    if email == actor.email:
        raise HTTPException(status_code=403, detail="You can't share a document with yourself.")
    sets = {"role": "editor", "sub_role": before, "granted_by_email": actor.email or None,
            "granted_by_user_id": actor.user_id, "granted_via": ws_id, "parent_grant_id": None,
            "notified": True}
    if existing is not None:
        await db["document_grants"].update_one({"_id": existing["_id"]}, {"$set": sets})
    else:
        if await db["document_grants"].count_documents({"document_id": doc_id}) >= access.MAX_GRANTS_PER_DOCUMENT:
            raise HTTPException(status_code=429, detail=f"A document can be shared with at most "
                                                        f"{access.MAX_GRANTS_PER_DOCUMENT} people.")
        try:
            await db["document_grants"].insert_one(
                {"document_id": doc_id, "email": email, "created_at": _now(), **sets})
        except DuplicateKeyError:
            raise HTTPException(status_code=409, detail="That changed meanwhile. Try again.")
    ctx.forget()
    # Read back what it gives (the admin may have lost the role meanwhile): worthless ⇒ undone.
    if not grant_role_allows((await ctx.grants_for(email)).get(doc_id), "editor"):
        if existing is not None:
            await db["document_grants"].replace_one({"_id": existing["_id"]}, existing)
        else:
            await db["document_grants"].delete_one({"document_id": doc_id, "email": email,
                                                    "granted_by_user_id": actor.user_id})
        ctx.forget()
        raise HTTPException(status_code=403, detail="You can't give someone more access than you have.")
    from app.services import live

    live.access_changed(raw.get("slug"))


async def _grant(db: AsyncIOMotorDatabase, raw: dict, email: str, role: str, actor: access.Actor,
                 ctx: access.Ctx) -> None:
    """Through the normal owner path; never lowers access someone already
    effectively holds (an owner who said "view" to a person who meanwhile got
    "edit" keeps them at edit)."""
    email = access.normalize_email(email)
    have = (await ctx.grants_for(email)).get(str(raw["_id"]))
    if have is not None and grant_role_allows(have, role):
        return
    grant = await access.add_grant(db, raw, email, role, actor, ctx)  # type: ignore[arg-type]
    ctx.forget()
    try:
        await access.mark_notified(db, grant.id)
    except Exception:
        pass


async def _notify_requester(db: AsyncIOMotorDatabase, raw: dict, row: dict, actor: access.Actor, *,
                            approved: bool, role: str | None, edit_request: bool = False) -> None:
    if not mailer.is_configured() or not row.get("requester_email"):
        return
    try:
        await mailer.send_access_decision_email(
            to_email=row["requester_email"],
            owner_name=actor.user.name or actor.email or "The owner",
            document_title=_mail_title(raw),
            slug=raw["slug"],
            approved=approved,
            role=role,
            edit_request=edit_request,
        )
    except Exception:
        pass
