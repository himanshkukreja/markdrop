"""Who a document is shared with.

Every route asks access.can(); this layer is plumbing and the share email.
"""

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.schemas.access import (
    AccessResponse,
    GrantCreate,
    GrantResponse,
    BatchLevelUpdate,
    LevelUpdate,
    ResharingUpdate,
)
from app.services import access as access_service
from app.services import mailer, urls
from app.utils.net import get_client_ip

router = APIRouter(prefix="/api/v1/documents", tags=["access"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


async def _load(db: AsyncIOMotorDatabase, slug: str) -> dict | None:
    return await db["documents"].find_one({"slug": slug})


def _to_grant(g) -> GrantResponse:
    return GrantResponse(
        email=g.email, role=g.role, created_at=g.created_at,
        granted_by_email=g.granted_by_email, notified=g.notified,
        active=getattr(g, "active", True),
        effective_role=getattr(g, "effective_role", None) if getattr(g, "active", True) else None,
    )


def _actor_ctx(request: Request, db, user: User):
    return (access_service.actor_from_request(request, user),
            access_service.Ctx(db, surface="rest", ip=get_client_ip(request)))


@router.post("/access/level")
@limiter.limit("30/minute")
async def set_levels(
    request: Request,
    data: BatchLevelUpdate,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Batch level change ("Open up the K you own"): owner-only per document,
    each through the same rules as PUT /{slug}/access/level. Per-slug results
    ``{results:[{slug, ok, error?}]}``."""
    from fastapi import HTTPException as _HTTPException

    from app.services import revalidate

    actor, ctx = _actor_ctx(request, db, user)
    results = []
    # B-R1: one bounded wait for the whole batch's purges, not one per document.
    async with revalidate.batch(db):
        for slug in dict.fromkeys(data.slugs):
            try:
                raw = await _load(db, slug)
                await access_service.set_level(db, raw, data.level, actor, ctx)
                results.append({"slug": slug, "ok": True})
            except _HTTPException as exc:
                results.append({"slug": slug, "ok": False,
                                "error": exc.detail if isinstance(exc.detail, str) else "Not allowed",
                                "status": exc.status_code})
    return {"results": results}


@router.get("/{slug}/access", response_model=AccessResponse)
@limiter.limit("120/minute")
async def get_access(
    request: Request,
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """The sharing state, for anyone holding a role on the document (A6).

    A reader who merely has the link (no role) gets 404: the owner's address
    and the grantee list are not something a link exposes. Viewers see their
    own role and the owner's display name; the grantee list (and the owner's
    address) is for the owner and editors.
    """
    actor, ctx = _actor_ctx(request, db, user)
    raw = await _load(db, slug)
    await access_service.require(actor, raw, "read", ctx)
    f = await access_service.facts(actor, raw, ctx)
    role = f.role
    if role is None:
        raise HTTPException(status_code=404, detail="Document not found")

    sees_grants = (await access_service.can(actor, raw, "see_grants", ctx)).allowed
    grants = await access_service.list_grants(db, str(raw["_id"])) if sees_grants else []

    owner_name = owner_email = None
    if raw.get("owner_id"):
        try:
            owner = await db["users"].find_one(
                {"_id": ObjectId(raw["owner_id"])}, {"name": 1, "email": 1}
            )
        except Exception:
            owner = None
        if owner:
            owner_name, owner_email = owner.get("name"), owner.get("email")
    # The same flags (and names) as the document response and item rows (§7).
    can = await access_service.can_flags(actor, raw, ctx)
    return AccessResponse(
        level=raw.get("access_level") or "link",
        allow_resharing=access_service.resharing_allowed(raw),
        is_password_protected=bool(raw.get("read_password_hash")),
        encrypted=bool(raw.get("encrypted")),
        in_workspace=bool(f.ws_id),
        workspace_id=f.ws_id,
        workspace_name=f.ws.name if f.ws is not None else None,
        folder_id=raw.get("folder_id") if f.ws_id else None,
        can=can,
        your_role=role,
        owner_name=owner_name,
        owner_email=owner_email if sees_grants else None,
        your_email=user.email,
        can_manage=f.is_owner,
        can_share=(await access_service.can(actor, raw, "share", ctx)).allowed,
        grants=[_to_grant(g) for g in grants],
        url=urls.markdrop_url(raw["slug"]),
        workspace_url=await urls.workspace_url(db, raw) if f.ws_id else None,
        expires_at=raw.get("expires_at"),
    )


@router.put("/{slug}/access/level", status_code=204)
@limiter.limit("60/minute")
async def set_level(
    request: Request,
    slug: str,
    data: LevelUpdate,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    actor, ctx = _actor_ctx(request, db, user)
    raw = await _load(db, slug)
    await access_service.set_level(db, raw, data.level, actor, ctx)


@router.put("/{slug}/access/resharing", status_code=204)
@limiter.limit("60/minute")
async def set_resharing(
    request: Request,
    slug: str,
    data: ResharingUpdate,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    actor, ctx = _actor_ctx(request, db, user)
    raw = await _load(db, slug)
    await access_service.set_resharing(db, raw, data.allow, actor, ctx)


@router.post("/{slug}/access/people", response_model=GrantResponse, status_code=201)
@limiter.limit("60/hour")
async def add_person(
    request: Request,
    slug: str,
    data: GrantCreate,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Share with a named person, optionally telling them.

    A failed notification does **not** undo the grant: the access is real and
    correct, the email is a courtesy. The response says whether it went.
    """
    actor, ctx = _actor_ctx(request, db, user)
    raw = await _load(db, slug)
    grant = await access_service.add_grant(db, raw, str(data.email), data.role, actor, ctx)

    # Nothing was written for someone who already had access: no email either.
    if data.notify and not grant.unchanged and mailer.is_configured():
        try:
            await mailer.send_document_share_email(
                to_email=grant.email,
                document_title=raw.get("title") or f"/{slug}",
                slug=slug,
                sharer_name=user.name or user.email or "Someone",
                role=grant.role,
                encrypted=bool(raw.get("encrypted")),
                message=data.message,
            )
            await access_service.mark_notified(db, grant.id)
            grant.notified = True
        except Exception:
            grant.notified = False

    return _to_grant(grant)


@router.delete("/{slug}/access/people/{email}", status_code=204)
@limiter.limit("60/minute")
async def remove_person(
    request: Request,
    slug: str,
    email: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    actor, ctx = _actor_ctx(request, db, user)
    raw = await _load(db, slug)
    await access_service.remove_grant(db, raw, email, actor, ctx)
