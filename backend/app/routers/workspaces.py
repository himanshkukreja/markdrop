"""Workspace CRUD and membership.

A workspace is the tenant that owns custom domains, branding and members. It is
entirely additive: a user with no workspace, and a document with no
`workspace_id`, behave exactly as they did before this existed.
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.models.workspace import Workspace
from app.routers.auth import require_user
from app.schemas.workspace import (
    BrandingPayload,
    MemberAddRequest,
    MemberListResponse,
    MemberResponse,
    MemberRoleRequest,
    SettingsPayload,
    WorkspaceCreate,
    WorkspaceListResponse,
    WorkspaceResponse,
    WorkspaceUpdate,
)
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


@router.post("/{workspace_id}/members", response_model=MemberResponse, status_code=201)
@limiter.limit("30/minute")
async def add_member(
    request: Request,
    workspace_id: str,
    data: MemberAddRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    await ws_service.require_role(db, workspace_id, user.id, "admin")
    member = await ws_service.add_member(db, workspace_id, str(data.email), data.role)
    return MemberResponse(
        user_id=member.user_id, role=member.role, email=member.email,
        name=member.name, created_at=member.created_at,
    )


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
