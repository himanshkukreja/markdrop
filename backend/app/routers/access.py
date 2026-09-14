"""Who a document is shared with.

Everything here operates on a document the caller can already see, and every
route re-derives their role rather than trusting a client-supplied one. The
rules themselves live in `services.access`; this layer is only plumbing and the
share notification email.
"""

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
    LevelUpdate,
    ResharingUpdate,
)
from app.services import access as access_service
from app.services import mailer

router = APIRouter(prefix="/api/v1/documents", tags=["access"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


async def _load(db: AsyncIOMotorDatabase, slug: str) -> dict:
    raw = await db["documents"].find_one({"slug": slug})
    if not raw:
        raise HTTPException(status_code=404, detail="Document not found")
    return raw


def _to_grant(g) -> GrantResponse:
    return GrantResponse(
        email=g.email, role=g.role, created_at=g.created_at,
        granted_by_email=g.granted_by_email, notified=g.notified,
    )


@router.get("/{slug}/access", response_model=AccessResponse)
@limiter.limit("120/minute")
async def get_access(
    request: Request,
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """The sharing state, for anyone who can already see the document.

    The list of people is visible to everyone with access, exactly as it is in
    a shared drive: you can see who else is in the room. What differs by role is
    what you can *change*, which the flags below describe so the UI doesn't have
    to re-implement the rules and get them subtly wrong.
    """
    raw = await _load(db, slug)
    role = await access_service.effective_role(db, raw, user.id, user.email)
    if role is None and (raw.get("access_level") or "link") != "link":
        raise HTTPException(status_code=404, detail="Document not found")

    is_owner = role == "owner"
    grants = await access_service.list_grants(db, str(raw["_id"]))

    owner_name = owner_email = None
    if raw.get("owner_id"):
        from bson import ObjectId

        try:
            owner = await db["users"].find_one(
                {"_id": ObjectId(raw["owner_id"])}, {"name": 1, "email": 1}
            )
        except Exception:
            owner = None
        if owner:
            owner_name, owner_email = owner.get("name"), owner.get("email")
    return AccessResponse(
        level=raw.get("access_level") or "link",
        allow_resharing=raw.get("allow_resharing", True),
        is_password_protected=bool(raw.get("read_password_hash")),
        encrypted=bool(raw.get("encrypted")),
        in_workspace=bool(raw.get("workspace_id")),
        workspace_id=raw.get("workspace_id"),
        your_role=role or "viewer",
        owner_name=owner_name,
        owner_email=owner_email,
        your_email=user.email,
        can_manage=is_owner,
        can_share=is_owner or (raw.get("allow_resharing", True) and role is not None),
        grants=[_to_grant(g) for g in grants],
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
    raw = await _load(db, slug)
    await access_service.set_level(db, raw, data.level, user.id)


@router.put("/{slug}/access/resharing", status_code=204)
@limiter.limit("60/minute")
async def set_resharing(
    request: Request,
    slug: str,
    data: ResharingUpdate,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    raw = await _load(db, slug)
    await access_service.set_resharing(db, raw, data.allow, user.id)


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

    Rate-limited by the hour, because what this spends is somebody else's inbox
    rather than our CPU, and it will happily mail an address its caller does not
    own.

    A failed notification does **not** undo the grant: the access is real and
    correct, the email is a courtesy, and silently revoking someone because a
    mail server was slow would be the worse outcome. The response says whether
    the message actually went.
    """
    raw = await _load(db, slug)
    grant = await access_service.add_grant(
        db, raw, str(data.email), data.role, user.id, user.email
    )

    if data.notify and mailer.is_configured():
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
    raw = await _load(db, slug)
    await access_service.remove_grant(db, raw, email, user.id, user.email)
