"""Workspace CRUD and membership.

A workspace is the tenant that owns custom domains, branding and members. It is
entirely additive: a user with no workspace, and a document with no
`workspace_id`, behave exactly as they did before this existed.
"""

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.models.workspace import Workspace
from app.routers.auth import require_user
from app.schemas.workspace import (
    BrandingAssetResponse,
    BrandingPayload,
    InviteCreateRequest,
    InviteListResponse,
    InviteResponse,
    MemberListResponse,
    MemberResponse,
    MemberRoleRequest,
    SettingsPayload,
    WorkspaceCreate,
    WorkspaceListResponse,
    WorkspaceResponse,
    WorkspaceUpdate,
)
from app.services import branding as branding_service
from app.services import invitation as invite_service
from app.services import mailer, r2
from app.services import workspace as ws_service

router = APIRouter(prefix="/api/v1/workspaces", tags=["workspaces"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _to_response(workspace: Workspace, role: str) -> WorkspaceResponse:
    b = workspace.branding
    s = workspace.settings
    return WorkspaceResponse(
        id=workspace.id,
        name=workspace.name,
        owner_id=workspace.owner_id,
        created_at=workspace.created_at,
        updated_at=workspace.updated_at,
        branding=BrandingPayload(
            site_name=b.site_name,
            favicon_url=b.favicon_url,
            logo_url=b.logo_url,
            accent_color=b.accent_color,
            hide_markdrop_branding=b.hide_markdrop_branding,
        ),
        settings=SettingsPayload(
            viewer_chrome=s.viewer_chrome,
            require_auth_to_view=s.require_auth_to_view,
        ),
        role=role,  # type: ignore[arg-type]
    )


@router.get("", response_model=WorkspaceListResponse)
@limiter.limit("60/minute")
async def list_workspaces(
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    pairs = await ws_service.list_for_user(db, user.id)
    return WorkspaceListResponse(
        workspaces=[_to_response(w, role) for w, role in pairs]
    )


@router.post("", response_model=WorkspaceResponse, status_code=201)
@limiter.limit("10/minute")
async def create_workspace(
    request: Request,
    data: WorkspaceCreate,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    workspace = await ws_service.create_workspace(db, data.name, user)
    return _to_response(workspace, "owner")


@router.get("/{workspace_id}", response_model=WorkspaceResponse)
@limiter.limit("120/minute")
async def get_workspace(
    request: Request,
    workspace_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    role = await ws_service.require_role(db, workspace_id, user.id, "viewer")
    workspace = await ws_service.get_workspace(db, workspace_id)
    if workspace is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return _to_response(workspace, role)


@router.put("/{workspace_id}", response_model=WorkspaceResponse)
@limiter.limit("60/minute")
async def update_workspace(
    request: Request,
    workspace_id: str,
    data: WorkspaceUpdate,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    # Branding and viewer settings change what every visitor sees, so they sit
    # behind admin rather than member.
    role = await ws_service.require_role(db, workspace_id, user.id, "admin")
    workspace = await ws_service.update_workspace(
        db,
        workspace_id,
        name=data.name,
        branding=data.branding.model_dump() if data.branding is not None else None,
        settings=data.settings.model_dump() if data.settings is not None else None,
    )
    return _to_response(workspace, role)


# ── Members ───────────────────────────────────────────────────────────────────


@router.get("/{workspace_id}/members", response_model=MemberListResponse)
@limiter.limit("120/minute")
async def list_members(
    request: Request,
    workspace_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    await ws_service.require_role(db, workspace_id, user.id, "viewer")
    members = await ws_service.list_members(db, workspace_id)
    return MemberListResponse(
        members=[
            MemberResponse(
                user_id=m.user_id, role=m.role, email=m.email, name=m.name,
                created_at=m.created_at,
            )
            for m in members
        ]
    )


# ── Invitations ───────────────────────────────────────────────────────────────
#
# There is deliberately no "add member" endpoint. Membership means your documents
# are readable by the workspace and your name is visible to its other members, so
# it is not something an admin can do to someone. It starts with an invitation
# and ends when that person accepts.


def _invite_response(inv) -> InviteResponse:
    return InviteResponse(
        id=inv.id,
        email=inv.email,
        role=inv.role,
        status=inv.effective_status,  # type: ignore[arg-type]
        created_at=inv.created_at,
        expires_at=inv.expires_at,
        invited_by_name=inv.invited_by_name,
        responded_at=inv.responded_at,
    )


@router.get("/{workspace_id}/invitations", response_model=InviteListResponse)
@limiter.limit("120/minute")
async def list_invitations(
    request: Request,
    workspace_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    # Admin, not viewer: the list is every address anyone tried to bring in,
    # which is more than a read-only member needs to see.
    await ws_service.require_role(db, workspace_id, user.id, "admin")
    rows = await invite_service.list_invitations(db, workspace_id)
    return InviteListResponse(invitations=[_invite_response(i) for i in rows])


@router.post("/{workspace_id}/invitations", response_model=InviteResponse, status_code=201)
@limiter.limit("20/hour")
async def create_invitation(
    request: Request,
    workspace_id: str,
    data: InviteCreateRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Invite someone by email.

    Rate-limited by the hour rather than the minute, because the thing being
    spent here is not our CPU — it is someone else's inbox, and this endpoint
    will happily send mail to an address its caller does not own.
    """
    await ws_service.require_role(db, workspace_id, user.id, "admin")
    workspace = await ws_service.get_workspace(db, workspace_id)
    if workspace is None:
        raise HTTPException(status_code=404, detail="Workspace not found")

    invite, token = await invite_service.create_invitation(
        db, workspace_id, str(data.email), data.role, user
    )

    if not mailer.is_configured():
        # Without mail there is no way for the invitee to ever learn the token,
        # so an invitation that cannot be delivered is not one worth keeping.
        await invite_service.revoke_invitation(db, workspace_id, invite.id)
        raise HTTPException(
            status_code=503, detail="Email isn't configured, so invitations can't be sent."
        )
    try:
        await mailer.send_invite_email(
            to_email=invite.email,
            workspace_name=workspace.name,
            inviter_name=user.name or user.email,
            role=invite.role,
            token=token,
        )
    except Exception:
        await invite_service.revoke_invitation(db, workspace_id, invite.id)
        raise HTTPException(
            status_code=502,
            detail="We couldn't send that invitation email. Check the address and try again.",
        )
    return _invite_response(invite)


@router.delete("/{workspace_id}/invitations/{invite_id}", status_code=204)
@limiter.limit("60/minute")
async def revoke_invitation(
    request: Request,
    workspace_id: str,
    invite_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    await ws_service.require_role(db, workspace_id, user.id, "admin")
    await invite_service.revoke_invitation(db, workspace_id, invite_id)


# ── Branding assets ───────────────────────────────────────────────────────────


@router.post("/{workspace_id}/branding/{kind}", response_model=BrandingAssetResponse)
@limiter.limit("30/hour")
async def upload_branding_asset(
    request: Request,
    workspace_id: str,
    kind: str,
    file: UploadFile = File(...),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Upload a favicon or logo.

    The stored URL is returned but not saved onto the workspace here: the
    settings form owns that, and saving a field the user hasn't confirmed would
    make "upload, change your mind, close the tab" leave the wrong logo live.
    """
    from starlette.concurrency import run_in_threadpool

    await ws_service.require_role(db, workspace_id, user.id, "admin")
    if kind not in ("favicon", "logo"):
        raise HTTPException(status_code=404, detail="Unknown branding asset.")
    if not r2.is_configured():
        raise HTTPException(status_code=503, detail="Uploads aren't available right now.")

    # Bounded read. UploadFile would otherwise spool an arbitrarily large body to
    # disk before we ever get to check its size.
    raw = await file.read(branding_service.MAX_UPLOAD_BYTES + 1)
    data, suffix = await run_in_threadpool(branding_service.process, raw, kind)

    key = f"branding/{workspace_id}/{suffix}"
    ok = await run_in_threadpool(r2.put_bytes, key, data, "image/png", True, False)
    if not ok:
        raise HTTPException(status_code=502, detail="That upload didn't go through. Try again.")
    return BrandingAssetResponse(url=branding_service.public_url(key), kind=kind)  # type: ignore[arg-type]


@router.put("/{workspace_id}/members/{member_user_id}", status_code=204)
@limiter.limit("30/minute")
async def set_member_role(
    request: Request,
    workspace_id: str,
    member_user_id: str,
    data: MemberRoleRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    await ws_service.require_role(db, workspace_id, user.id, "admin")
    await ws_service.set_member_role(db, workspace_id, member_user_id, data.role)


@router.delete("/{workspace_id}/members/{member_user_id}", status_code=204)
@limiter.limit("30/minute")
async def remove_member(
    request: Request,
    workspace_id: str,
    member_user_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    # Leaving is always allowed; removing someone else needs admin.
    if member_user_id != user.id:
        await ws_service.require_role(db, workspace_id, user.id, "admin")
    else:
        await ws_service.require_role(db, workspace_id, user.id, "viewer")
    await ws_service.remove_member(db, workspace_id, member_user_id)
