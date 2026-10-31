"""Markdrop Guides people: /api/v1/docs-studio/workspaces/{workspace_id}/members…

Each workspace member's Guides role (admin / reviewer / editor / viewer /
none), set by the workspace's studio admins; the workspace owner and admins are
always admins and can't be changed here. Per-site overrides are under
/api/v1/docs-sites/{site_id}/members (routers/docs_site_people.py). Every
change is audited (docs_events docs_role_*), readable at …/history. Roles:
services/docs_studio_roles.py. App-internal, like the docs-sites API.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.schemas.docs_site import StudioMembersUpdate, StudioRoleUpdate
from app.services import docs_studio_roles as roles
from app.services import workspace as ws_service

router = APIRouter(prefix="/api/v1/docs-studio", tags=["docs-studio"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


async def _require_studio_admin(db: AsyncIOMotorDatabase, workspace_id: str, user: User):
    """404 for a non-member (the workspace isn't confirmed), 403 for a member who isn't a studio admin."""
    workspace = await ws_service.get_workspace(db, workspace_id)
    ws_role = await ws_service.role_for(db, workspace_id, user.id) if workspace else None
    if workspace is None or ws_role is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    access = await roles.workspace_role(db, workspace_id, user.id, ws_role)
    if not roles.role_at_least(access.role, "admin"):
        raise HTTPException(status_code=403, detail="Only Guides admins can manage its members.")
    return workspace, access


async def _listing(db: AsyncIOMotorDatabase, workspace, access, user: User) -> dict:
    sites = await db["docs_sites"].find({"workspace_id": workspace.id, "deleted_at": None},
                                        {"name": 1}).sort("created_at", 1).to_list(length=500)
    return {
        "workspace": {"id": workspace.id, "name": workspace.name},
        "your_role": access.role,
        "your_role_source": access.source,
        "you": user.id,
        "members": await roles.workspace_members(db, workspace.id),
        "sites": [{"id": str(s["_id"]), "name": s.get("name")} for s in sites],
    }


@router.get("/workspaces/{workspace_id}/members")
@limiter.limit("120/minute")
async def list_members(request: Request, workspace_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                       user: User = Depends(require_user)):
    """Every workspace member with their studio role, its source, who granted it and when, and
    their per-site overrides; plus the workspace's sites (to name the overrides)."""
    workspace, access = await _require_studio_admin(db, workspace_id, user)
    return await _listing(db, workspace, access, user)


@router.put("/workspaces/{workspace_id}/members")
@limiter.limit("30/minute")
async def set_members(request: Request, workspace_id: str, body: StudioMembersUpdate,
                      db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """Several roles at once: all are checked before any is changed."""
    workspace, access = await _require_studio_admin(db, workspace_id, user)
    seen: set[str] = set()
    for m in body.members:
        if m.user_id in seen:
            raise HTTPException(status_code=422, detail="Each person once, please.")
        seen.add(m.user_id)
        await roles.check_target(db, workspace_id, m.user_id, user.id)
    for m in body.members:
        await roles.set_workspace_role(db, workspace_id, m.user_id, m.role, user.id)
    return await _listing(db, workspace, access, user)


@router.put("/workspaces/{workspace_id}/members/{member_user_id}")
@limiter.limit("60/minute")
async def set_member(request: Request, workspace_id: str, member_user_id: str, body: StudioRoleUpdate,
                     db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """One member's studio role ("none" takes it away; their site overrides stay)."""
    await _require_studio_admin(db, workspace_id, user)
    await roles.set_workspace_role(db, workspace_id, member_user_id, body.role, user.id)
    row = next((m for m in await roles.workspace_members(db, workspace_id) if m["user_id"] == member_user_id), None)
    if row is None:  # pragma: no cover - they left meanwhile
        raise HTTPException(status_code=404, detail="That person isn't in this workspace.")
    return row


@router.get("/workspaces/{workspace_id}/history")
@limiter.limit("60/minute")
async def history(request: Request, workspace_id: str, limit: int = Query(50, ge=1, le=200),
                  db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """Who gave whom which role, and when (workspace roles and every site's overrides), newest first."""
    await _require_studio_admin(db, workspace_id, user)
    return {"events": await roles.history(db, workspace_id=workspace_id, limit=limit)}
