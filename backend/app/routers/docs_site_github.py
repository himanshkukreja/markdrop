"""A guide's GitHub repository: /api/v1/docs-sites/{site_id}/github…

    GET    /{site_id}/github            the link (or null), the sync history, the app's state
    PUT    /{site_id}/github            connect an existing guide to a repository (admins); first sync
    PATCH  /{site_id}/github            mode (drafts | publish), sync on/off, format, branch (admins)
    POST   /{site_id}/github/sync       sync now (editors and admins)
    DELETE /{site_id}/github            disconnect: the pages stay, syncing stops (admins)
    POST   /{site_id}/github/openapi    use an OpenAPI file found in the repository as the API reference (admins)

Included by routers/docs_sites.py. Everyone on the guide reads the link and its history.
Services: services/docs_github_sync.py.
"""

from fastapi import APIRouter, Depends, Request
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.routers.docs_site_pages import DocsRoute
from app.schemas.docs_site import GitHubLinkPatch, GitHubLinkPut, GitHubOpenApi
from app.services import docs_github_app as gh
from app.services import docs_github_sync as sync
from app.services import docs_site_store as store

router = APIRouter(route_class=DocsRoute)


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


async def _out(db: AsyncIOMotorDatabase, site: dict) -> dict:
    return {"link": await sync.link_status(db, site), "syncs": await sync.history(db, site), "app": gh.app_view()}


@router.get("/{site_id}/github")
@limiter.limit("120/minute")
async def get_link(request: Request, site_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                   user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user)
    return await _out(db, site)


@router.put("/{site_id}/github")
@limiter.limit("10/minute")
async def put_link(request: Request, site_id: str, body: GitHubLinkPut, db: AsyncIOMotorDatabase = Depends(get_db),
                   user: User = Depends(require_user)):
    site, role = await store.load_site(db, site_id, user, "admin")
    site, job = await sync.connect_site(db, site, user, body.model_dump())
    return {**await _out(db, site), "job": store.job_view(job, details=store.sees_details(role))}


@router.patch("/{site_id}/github")
@limiter.limit("30/minute")
async def patch_link(request: Request, site_id: str, body: GitHubLinkPatch, db: AsyncIOMotorDatabase = Depends(get_db),
                     user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user, "admin")
    site = await sync.update_link(db, site, body.model_dump(exclude_none=True))
    return await _out(db, site)


@router.post("/{site_id}/github/sync", status_code=202)
@limiter.limit("10/minute")
async def sync_now(request: Request, site_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                   user: User = Depends(require_user)):
    site, role = await store.load_site(db, site_id, user, "editor")
    job = await sync.sync_now(db, site, user)
    fresh = await db[store.SITES].find_one({"_id": site["_id"]})
    return {**await _out(db, fresh), "job": store.job_view(job, details=store.sees_details(role))}


@router.delete("/{site_id}/github")
@limiter.limit("10/minute")
async def delete_link(request: Request, site_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user, "admin")
    await sync.disconnect(db, site, user)
    return {"ok": True}


@router.post("/{site_id}/github/openapi")
@limiter.limit("10/minute")
async def attach_openapi(request: Request, site_id: str, body: GitHubOpenApi, db: AsyncIOMotorDatabase = Depends(get_db),
                         user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user, "admin")
    return await sync.attach_openapi(db, site, user, body.path)
