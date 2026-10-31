"""Hosted docs sites: /api/v1/docs-sites (the dashboard and editor's API).

Sites, settings, publishing, reviews, builds, jobs and uploads live here; pages,
locks, versions and the sidebar order in routers/docs_site_pages.py, which is
included below so main.py registers one router. Roles and limits are in
services/docs_site_store.py. App-internal: kept out of the public OpenAPI
schema (the dashboard is the only client and the shapes will move while the
product does).
"""

import re

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import RedirectResponse
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.routers.docs_site_api import router as api_router
from app.routers.docs_site_pages import DocsRoute
from app.routers.docs_site_pages import router as pages_router
from app.routers.docs_site_people import router as people_router
from app.schemas.docs_site import PublishRequest, ReviewCreate, ReviewDecision, SiteCreate, SiteUpdate
from app.services import docs_site_assets as assets
from app.services import docs_site_publish as publishing
from app.services import docs_site_store as store

settings = get_settings()


router = APIRouter(prefix="/api/v1/docs-sites", tags=["docs-sites"], route_class=DocsRoute)


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


# ── Sites ─────────────────────────────────────────────────────────────────────


@router.get("")
@limiter.limit("120/minute")
async def list_sites(request: Request, workspace_id: str | None = Query(None),
                     scope: str | None = Query(None, pattern="^all$"),
                     db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """A workspace's sites (any member), or with no workspace_id your personal ones. With
    ``scope=all`` (Markdrop Guides' home): every site across your workspaces and your personal ones,
    each with its ``workspace``, plus ``workspaces`` and ``personal`` (usage, may you create there)."""
    if scope == "all":
        return await store.list_all_sites(db, user)
    return await store.list_sites(db, user, workspace_id or None)


@router.get("/slug-available")
@limiter.limit("120/minute")
async def slug_available(request: Request, slug: str = Query(..., max_length=100),
                         site_id: str | None = Query(None),
                         db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    exclude = store.oid(site_id) if site_id else None
    return await store.slug_status(db, slug, exclude)


@router.post("", status_code=201)
@limiter.limit("10/minute")
async def create_site(request: Request, body: SiteCreate, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    source = body.source.model_dump()
    site, role, job = await store.create_site(db, user, workspace_id=body.workspace_id, name=body.name,
                                              slug=body.slug, source=source)
    return await store.site_view(db, site, role, job=job)


@router.get("/{site_id}")
@limiter.limit("240/minute")
async def get_site(request: Request, site_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                   user: User = Depends(require_user)):
    site, role = await store.site_access(db, site_id, user)
    return await store.site_view(db, site, role)


@router.patch("/{site_id}")
@limiter.limit("60/minute")
async def update_site(request: Request, site_id: str, body: SiteUpdate, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    site, role = await store.site_access(db, site_id, user, "admin")
    site = await store.update_site(db, site, name=body.name, slug=body.slug, settings_patch=body.settings)
    return await store.site_view(db, site, role)


@router.delete("/{site_id}")
@limiter.limit("10/minute")
async def delete_site(request: Request, site_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user, "admin")
    job = await store.delete_site(db, site, user)
    return {"deleted": True, "job": store.job_view(job, details=True)}


@router.post("/{site_id}/unpublish")
@limiter.limit("10/minute")
async def unpublish_site(request: Request, site_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                         user: User = Depends(require_user)):
    site, role = await store.site_access(db, site_id, user, "admin")
    job = await store.unpublish_site(db, site)
    fresh = await db[store.SITES].find_one({"_id": site["_id"]})
    return await store.site_view(db, fresh, role, job=job)


# ── Publishing ────────────────────────────────────────────────────────────────


@router.get("/{site_id}/changes")
@limiter.limit("120/minute")
async def changes(request: Request, site_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user)
    return await publishing.changes(db, site)


@router.post("/{site_id}/publish", status_code=202)
@limiter.limit("20/minute")
async def publish(request: Request, site_id: str, body: PublishRequest | None = None,
                  db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """Editors and admins. 409 {"detail": "review required"} for an editor when the site requires review."""
    site, role = await store.load_site(db, site_id, user, "editor")
    return await publishing.publish(db, site, role, user, note=body.note if body else None)


@router.post("/{site_id}/reviews", status_code=201)
@limiter.limit("20/minute")
async def submit_review(request: Request, site_id: str, body: ReviewCreate | None = None,
                        db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user, "editor")
    return await publishing.submit_review(db, site, user, body.note if body else None)


@router.get("/{site_id}/reviews")
@limiter.limit("120/minute")
async def list_reviews(request: Request, site_id: str,
                       status: str | None = Query(None, pattern="^(open|approved|changes_requested|withdrawn)$"),
                       db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user)
    return await publishing.list_reviews(db, site, status)


@router.post("/{site_id}/reviews/{review_id}/approve", status_code=202)
@limiter.limit("20/minute")
async def approve_review(request: Request, site_id: str, review_id: str, body: ReviewDecision | None = None,
                         db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, role = await store.load_site(db, site_id, user, "reviewer")
    return await publishing.approve_review(db, site, role, user, review_id, body.comment if body else None)


@router.post("/{site_id}/reviews/{review_id}/request-changes")
@limiter.limit("20/minute")
async def request_changes(request: Request, site_id: str, review_id: str, body: ReviewDecision | None = None,
                          db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, role = await store.load_site(db, site_id, user, "reviewer")
    return await publishing.request_changes(db, site, role, user, review_id, body.comment if body else None)


@router.post("/{site_id}/reviews/{review_id}/withdraw")
@limiter.limit("20/minute")
async def withdraw_review(request: Request, site_id: str, review_id: str,
                          db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, role = await store.load_site(db, site_id, user, "editor")
    return await publishing.withdraw_review(db, site, role, user, review_id)


@router.get("/{site_id}/builds")
@limiter.limit("120/minute")
async def list_builds(request: Request, site_id: str, limit: int = Query(50, ge=1, le=100),
                      db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, role = await store.load_site(db, site_id, user)
    return await publishing.list_builds(db, site, limit, details=store.sees_details(role))


@router.post("/{site_id}/builds/{build_id}/restore", status_code=202)
@limiter.limit("10/minute")
async def restore_build(request: Request, site_id: str, build_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                        user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user, "admin")
    return await publishing.restore_build(db, site, user, build_id)


@router.get("/{site_id}/jobs/{job_id}")
@limiter.limit("240/minute")
async def get_job(request: Request, site_id: str, job_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    site, role = await store.load_site(db, site_id, user)
    return await publishing.get_job(db, site, job_id, details=store.sees_details(role))


# ── Assets ────────────────────────────────────────────────────────────────────


@router.post("/{site_id}/assets", status_code=201)
@limiter.limit("60/minute")
async def upload_asset(request: Request, site_id: str, file: UploadFile = File(...),
                       variant: str = Form("light", pattern="^(light|dark)$"),
                       for_: str | None = Form(None, alias="for", max_length=300),
                       db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """One image or file (≤ 25 MB) → ``{url: "/docs-assets/<sha256>.<ext>", …}`` for the Markdown.

    ``variant=dark`` with ``for=/docs-assets/<sha256>.<ext>`` (an uploaded image): the dark-theme
    version of that image, stored as ``<sha256>.dark.<ext>`` (where the engine looks for it,
    the build fetches it with its image) and replacing any earlier dark version."""
    site, _role = await store.load_site(db, site_id, user, "editor")
    data = await file.read(settings.docs_asset_max_bytes + 1)
    if variant == "dark":
        return await publishing.upload_dark_asset(db, site, user, data, file.filename, for_ or "")
    return await publishing.upload_asset(db, site, user, data, file.filename)


@router.get("/{site_id}/assets/{name:path}")
@limiter.limit("600/minute")
async def asset_preview(request: Request, site_id: str, name: str, db: AsyncIOMotorDatabase = Depends(get_db)):
    """The editor's preview of an uploaded file: a redirect to a short-lived link.

    No sign-in (an <img> can't send one): the name is the file's sha256 (a dark
    version: its image's sha256 + ``.dark``), so only someone who has the file,
    or the page that uses it, can ask for it. Files an import brought in
    (``import/<page>/<name>``, copied from a public site) are answered only when
    the site has a row for that exact name."""
    if not re.fullmatch(r"[0-9a-f]{64}(?:\.dark)?\.[a-z0-9]{2,5}", name) and not (
            name.startswith("import/") and assets.rel_of(f"/docs-assets/{name}")):
        raise HTTPException(status_code=404, detail="Not found")
    url = await publishing.asset_preview_url(db, site_id, name)
    if url is None:
        raise HTTPException(status_code=404, detail="Not found")
    return RedirectResponse(url, status_code=302, headers={"Cache-Control": "private, max-age=600"})


# Pages, locks, versions and nav (routers/docs_site_pages.py).
router.include_router(pages_router)

# Per-site Guides role overrides (routers/docs_site_people.py).
router.include_router(people_router)

# The API reference's OpenAPI description (routers/docs_site_api.py).
router.include_router(api_router)
