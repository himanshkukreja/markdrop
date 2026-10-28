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
"""

from __future__ import annotations

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


async def create(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, slug: str,
                 message: str | None) -> dict:
    user = actor.user
    raw = await _load_for_read(db, slug)
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
        "doc_id": doc_id, "slug": raw["slug"], "owner_id": raw["owner_id"],
        "requester_user_id": user.id, "requester_email": actor.email,
        "requester_name": user.name or None, "message": message, "status": "pending",
        "role_granted": None, "created_at": _now(), "decided_at": None, "decided_by": None,
        "notified": False,
    }
    try:
        res = await db[COLL].insert_one(row)
    except DuplicateKeyError:
        raise HTTPException(status_code=409,
                            detail="You've already asked. You'll get an email when they decide.")
    row["_id"] = res.inserted_id
    await _notify_owner(db, raw, row, actor)
    return row


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


async def mine(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, slug: str) -> dict:
    """What the gate page needs: may this caller ask, and is a request open."""
    raw = await _load_for_read(db, slug)
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


async def _owned_doc(db: AsyncIOMotorDatabase, row: dict, actor: access.Actor,
                     ctx: access.Ctx) -> dict | None:
    """The request's document when the caller may decide on it (its owner,
    now), else None. Expired/deleted ⇒ None."""
    oid = _oid(row.get("doc_id") or "")
    raw = await db["documents"].find_one({"_id": oid}) if oid else None
    if raw is None or publicity.is_expired(raw):
        return None
    if not (await access.can(actor, raw, "change_access", ctx)).allowed:
        return None
    return raw


async def _shape(db: AsyncIOMotorDatabase, row: dict, raw: dict, hosts: urls.HostCache) -> dict:
    return {
        "id": str(row["_id"]),
        "status": row.get("status"),
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
    query: dict = {"owner_id": actor.user_id}
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
    for row in await db[COLL].find({"owner_id": actor.user_id, "status": "pending"},
                                   {"doc_id": 1}).to_list(length=500):
        if await _owned_doc(db, row, actor, ctx) is not None:
            pending += 1
    return {"requests": out, "pending_count": pending}


async def get_for_owner(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx,
                        request_id: str) -> dict:
    oid = _oid(request_id)
    row = await db[COLL].find_one({"_id": oid}) if oid else None
    raw = await _owned_doc(db, row, actor, ctx) if row else None
    if raw is None:
        raise request_not_found()
    return await _shape(db, row, raw, urls.HostCache(db))


def _settled(row: dict, status: str, role: str | None) -> bool:
    return row.get("status") == status and (role is None or row.get("role_granted") == role)


async def decide(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx,
                 request_id: str, decision: str) -> dict:
    oid = _oid(request_id)
    row = await db[COLL].find_one({"_id": oid}) if oid else None
    raw = await _owned_doc(db, row, actor, ctx) if row else None
    if raw is None:
        # Not theirs (or gone): the same answer as an id that never existed.
        raise request_not_found()
    status = "declined" if decision == "decline" else "approved"
    role = ROLE_FOR.get(decision)

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
            await _grant(db, raw, row["requester_email"], role, actor, ctx)
        except HTTPException:
            # Nothing was shared: the request is open again.
            await db[COLL].update_one(
                {"_id": row["_id"], "status": status, "decided_at": now},
                {"$set": {"status": "pending", "role_granted": None, "decided_at": None,
                          "decided_by": None}})
            raise
    await _notify_requester(db, raw, claimed, actor, approved=role is not None, role=role)
    return answer(claimed)


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
                            approved: bool, role: str | None) -> None:
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
        )
    except Exception:
        pass
