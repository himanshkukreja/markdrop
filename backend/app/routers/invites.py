"""Responding to a workspace invitation.

Separate from `/workspaces` because the caller is different in kind. Every route
there is for someone who is already inside a workspace; every route here is for
someone standing outside one, holding a link, who may not even have an account
yet. Preview and decline therefore work without a session, and only accept — the
one action that grants access — insists on proof of who you are.
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import optional_user, require_user
from app.schemas.workspace import InviteAcceptResponse, InvitePreview
from app.services import invitation as invite_service
from app.services import workspace as ws_service

router = APIRouter(prefix="/api/v1/invites", tags=["invitations"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


@router.get("/{token}", response_model=InvitePreview)
@limiter.limit("60/minute")
async def preview_invitation(
    request: Request,
    token: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User | None = Depends(optional_user),
):
    """What this link is for — shown before anyone commits to anything.

    Resolved invitations still return 200 rather than an error, because "this was
    already accepted" and "you were uninvited" are answers the reader needs, and
    a 4xx here would leave the page with nothing to say.
    """
    invite = await invite_service.find_by_token(db, token)
    if invite is None:
        raise HTTPException(status_code=404, detail="This invitation link isn't valid.")

    workspace = await ws_service.get_workspace(db, invite.workspace_id)
    if workspace is None:
        raise HTTPException(status_code=404, detail="That workspace no longer exists.")

    signed_in = (user.email or "").strip().lower() if user else None
    already_member = False
    if user is not None:
        already_member = (
            await ws_service.role_for(db, invite.workspace_id, user.id)
        ) is not None

    return InvitePreview(
        workspace_name=workspace.name,
        role=invite.role,
        email=invite.email,
        invited_by_name=invite.invited_by_name,
        status=invite.effective_status,  # type: ignore[arg-type]
        expires_at=invite.expires_at,
        signed_in_as=user.email if user else None,
        email_matches=signed_in == invite.email,
        already_member=already_member,
    )


@router.post("/{token}/accept", response_model=InviteAcceptResponse)
@limiter.limit("20/minute")
async def accept_invitation(
    request: Request,
    token: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    workspace_id, role = await invite_service.accept_invitation(db, token, user)
    workspace = await ws_service.get_workspace(db, workspace_id)
    return InviteAcceptResponse(
        workspace_id=workspace_id,
        workspace_name=workspace.name if workspace else "",
        role=role,  # type: ignore[arg-type]
    )


@router.post("/{token}/decline", status_code=204)
@limiter.limit("20/minute")
async def decline_invitation(
    request: Request,
    token: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    await invite_service.decline_invitation(db, token)
