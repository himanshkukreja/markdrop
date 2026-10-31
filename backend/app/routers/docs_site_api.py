"""A guide's API reference: /api/v1/docs-sites/{site_id}/api-reference…

Included by routers/docs_sites.py. Everyone on the guide reads the status; editors and admins
upload, fetch, restore and remove the OpenAPI description (it's content); the reader-facing options
(label, placement, Try it, re-fetch on publish) are settings, changed with PATCH /{site_id} by
admins. Nothing here is public: the published guide gets the description through its build.
"""

from fastapi import APIRouter, Depends, File, Request, UploadFile
from fastapi.responses import RedirectResponse
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.routers.docs_site_pages import DocsRoute
from app.services import docs_api_spec as api_spec
from app.services import docs_site_store as store

router = APIRouter(route_class=DocsRoute)


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


class FromUrl(BaseModel):
    url: str = Field(..., min_length=1, max_length=2048)
    # Fetch it again at every publish (None: leave the setting as it is).
    refetch: bool | None = None


@router.get("/{site_id}/api-reference")
@limiter.limit("120/minute")
async def api_reference(request: Request, site_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                        user: User = Depends(require_user)):
    """The current description (operations, version, warnings, the sidebar it makes), the options
    and the version history."""
    site, _role = await store.load_site(db, site_id, user)
    return await api_spec.status(db, site)


@router.post("/{site_id}/api-reference/upload", status_code=201)
@limiter.limit("20/minute")
async def upload(request: Request, site_id: str, file: UploadFile = File(...),
                 db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """An OpenAPI 3.0/3.1 file, JSON or YAML, at most 5 MB → the new current version."""
    site, _role = await store.load_site(db, site_id, user, "editor")
    data = await file.read(api_spec.MAX_BYTES + 1)
    await api_spec.upload(db, site, user, data, file.filename)
    return await api_spec.status(db, site)


@router.post("/{site_id}/api-reference/url", status_code=201)
@limiter.limit("10/minute")
async def from_url(request: Request, site_id: str, body: FromUrl, db: AsyncIOMotorDatabase = Depends(get_db),
                   user: User = Depends(require_user)):
    """Fetch the description from an https URL (public addresses only, 5 MB, 15 seconds)."""
    site, role = await store.load_site(db, site_id, user, "editor")
    # Re-fetch on publish is a setting: only an admin changes it along with the URL.
    refetch = body.refetch if store.is_admin(role) else None
    await api_spec.from_url(db, site, user, body.url, refetch)
    return await api_spec.status(db, site)


@router.post("/{site_id}/api-reference/versions/{version_id}/restore")
@limiter.limit("30/minute")
async def restore(request: Request, site_id: str, version_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user, "editor")
    await api_spec.restore(db, site, user, version_id)
    return await api_spec.status(db, site)


@router.get("/{site_id}/api-reference/versions/{version_id}/download")
@limiter.limit("60/minute")
async def download(request: Request, site_id: str, version_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                   user: User = Depends(require_user)):
    """The stored JSON: a redirect to a short-lived link."""
    site, _role = await store.load_site(db, site_id, user)
    url = await api_spec.download_url(db, site, version_id)
    return RedirectResponse(url, status_code=302, headers={"Cache-Control": "private, no-store"})


@router.delete("/{site_id}/api-reference")
@limiter.limit("30/minute")
async def remove(request: Request, site_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                 user: User = Depends(require_user)):
    """No API reference from the next publish on. Earlier versions stay, to restore."""
    site, _role = await store.load_site(db, site_id, user, "editor")
    await api_spec.remove(db, site, user)
    return await api_spec.status(db, site)
