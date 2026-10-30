"""Docs site pages: /api/v1/docs-sites/{site_id}/pages…, locks, versions, nav.

Included by routers/docs_sites.py (one registration in main.py). Viewers read;
editors and admins write. A save names its ``base_rev``: 409 with the current
rev when someone saved since, 423 with the lock when someone else holds it.
"""

from fastapi import APIRouter, Depends, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.schemas.docs_site import NavUpdate, PageCreate, PageUpdate
from app.services import docs_site_pages as pages
from app.services import docs_site_store as store
from app.services.docs_site_store import DocsError


class DocsRoute(APIRoute):
    """Answers a :class:`DocsError` with its body as is (``{"detail", "rev", …}``)."""

    def get_route_handler(self):
        original = super().get_route_handler()

        async def handler(request: Request):
            try:
                return await original(request)
            except DocsError as exc:
                return JSONResponse(jsonable_encoder(exc.body), status_code=exc.status_code)

        return handler


router = APIRouter(route_class=DocsRoute)


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


@router.get("/{site_id}/pages")
@limiter.limit("240/minute")
async def list_pages(request: Request, site_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                     user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user)
    return await pages.list_pages(db, site)


@router.post("/{site_id}/pages", status_code=201)
@limiter.limit("60/minute")
async def create_page(request: Request, site_id: str, body: PageCreate, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user, "editor")
    page = await pages.create_page(db, site, user, path=body.path, title=body.title, group=body.group,
                                   after_page_id=body.after_page_id, markdown=body.markdown,
                                   description=body.description, icon=body.icon)
    return await pages.view(db, site, page)


@router.get("/{site_id}/pages/{page_id}")
@limiter.limit("240/minute")
async def get_page(request: Request, site_id: str, page_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                   user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user)
    return await pages.view(db, site, await pages.load_page(db, site, page_id))


@router.put("/{site_id}/pages/{page_id}")
@limiter.limit("240/minute")
async def save_page(request: Request, site_id: str, page_id: str, body: PageUpdate,
                    db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user, "editor")
    page = await pages.load_page(db, site, page_id)
    fields = body.model_dump(exclude_unset=True)
    fields.pop("base_rev", None)
    saved = await pages.save_page(db, site, page, user, base_rev=body.base_rev, fields=fields)
    return await pages.view(db, site, saved)


@router.delete("/{site_id}/pages/{page_id}")
@limiter.limit("60/minute")
async def delete_page(request: Request, site_id: str, page_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user, "editor")
    await pages.delete_page(db, site, await pages.load_page(db, site, page_id), user)
    return {"deleted": True}


@router.post("/{site_id}/pages/{page_id}/lock")
@limiter.limit("240/minute")
async def lock_page(request: Request, site_id: str, page_id: str, takeover: bool = Query(False),
                    db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """Acquire, or renew as a heartbeat (every 30 s; a lock lapses 2 min after the last)."""
    site, role = await store.load_site(db, site_id, user, "editor")
    return await pages.lock(db, site, await pages.load_page(db, site, page_id), user, role, takeover)


@router.delete("/{site_id}/pages/{page_id}/lock")
@limiter.limit("240/minute")
async def unlock_page(request: Request, site_id: str, page_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    site, role = await store.load_site(db, site_id, user, "editor")
    await pages.unlock(db, await pages.load_page(db, site, page_id), user, role)
    return {"lock": None}


@router.get("/{site_id}/pages/{page_id}/versions")
@limiter.limit("120/minute")
async def list_versions(request: Request, site_id: str, page_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                        user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user)
    return await pages.versions(db, await pages.load_page(db, site, page_id))


@router.get("/{site_id}/pages/{page_id}/versions/{rev}")
@limiter.limit("120/minute")
async def get_version(request: Request, site_id: str, page_id: str, rev: int,
                      db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user)
    return await pages.version(db, await pages.load_page(db, site, page_id), rev)


@router.post("/{site_id}/pages/{page_id}/versions/{rev}/restore")
@limiter.limit("30/minute")
async def restore_version(request: Request, site_id: str, page_id: str, rev: int,
                          db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user, "editor")
    page = await pages.restore_version(db, site, await pages.load_page(db, site, page_id), user, rev)
    return await pages.view(db, site, page)


@router.put("/{site_id}/nav")
@limiter.limit("60/minute")
async def put_nav(request: Request, site_id: str, body: NavUpdate, db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user, "editor")
    nav = await pages.put_nav(db, site, [g.model_dump() for g in body.nav])
    return {"nav": nav}
