"""A docs site's people: /api/v1/docs-sites/{site_id}/members…

Per-site overrides of Docs Studio roles (services/docs_studio_roles.py): for this
site only, a workspace member can have a different role than their workspace-wide
one, higher or lower ("none" hides the site from them). The workspace owner and
admins are always admins. Admins of the site only; included by
routers/docs_sites.py. Every change is audited (…/members-history).
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.schemas.docs_site import StudioRoleUpdate
from app.services import docs_site_store as store
from app.services import docs_studio_roles as roles

router = APIRouter()


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


async def _row(db: AsyncIOMotorDatabase, site: dict, user_id: str) -> dict:
    row = next((m for m in await roles.site_members(db, site) if m["user_id"] == user_id), None)
    if row is None:
        raise HTTPException(status_code=404, detail="That person isn't in this workspace.")
    return row


@router.get("/{site_id}/members")
@limiter.limit("120/minute")
async def list_people(request: Request, site_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    """Every workspace member with their workspace-wide studio role, this site's override for them
    (if any) and the role that results; a personal site lists only its owner."""
    site, access = await store.site_access(db, site_id, user, "admin")
    return {
        "site_id": str(site["_id"]),
        "workspace_id": site.get("workspace_id"),
        "personal": not site.get("workspace_id"),
        "your_role": access.role,
        "your_role_source": access.source,
        "you": user.id,
        "members": await roles.site_members(db, site),
    }


@router.get("/{site_id}/members-history")
@limiter.limit("60/minute")
async def people_history(request: Request, site_id: str, limit: int = Query(50, ge=1, le=200),
                         db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, _access = await store.site_access(db, site_id, user, "admin")
    return {"events": await roles.history(db, site_id=site["_id"], limit=limit)}


@router.get("/{site_id}/members/{member_user_id}")
@limiter.limit("120/minute")
async def get_person(request: Request, site_id: str, member_user_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                     user: User = Depends(require_user)):
    site, _access = await store.site_access(db, site_id, user, "admin")
    return await _row(db, site, member_user_id)


@router.put("/{site_id}/members/{member_user_id}")
@limiter.limit("60/minute")
async def set_person(request: Request, site_id: str, member_user_id: str, body: StudioRoleUpdate,
                     db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """This site's role for a workspace member, whatever their workspace-wide one."""
    site, _access = await store.site_access(db, site_id, user, "admin")
    await roles.set_site_override(db, site, member_user_id, body.role, user.id)
    return await _row(db, site, member_user_id)


@router.delete("/{site_id}/members/{member_user_id}")
@limiter.limit("60/minute")
async def remove_person(request: Request, site_id: str, member_user_id: str,
                        db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """Drop the override: they're back to their workspace-wide studio role here."""
    site, _access = await store.site_access(db, site_id, user, "admin")
    await roles.remove_site_override(db, site, member_user_id, user.id)
    return await _row(db, site, member_user_id)
