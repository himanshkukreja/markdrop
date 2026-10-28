"""Creator analytics read API (build spec §3), under ``/api/v1/me``.

Per-document endpoints are the owner's only: ``access.require(..., "view_stats")``
(anonymous 401, a reader who isn't the owner 403, anyone else the read denial,
404). The home and live boards cover the caller's own documents
(``owner_id == user.id``). Computation lives in services/creator_analytics.py.

Common query parameters: ``range=7d|30d|90d|all`` (default 30d) and
``internal=0|1`` (default 0: workspace members' views and sessions hidden).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.services import access
from app.services import creator_analytics as ca

router = APIRouter(prefix="/api/v1/me", tags=["creator-analytics"])

RANGE = "^(7d|30d|90d|all)$"


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


async def _owned_doc(request: Request, db: AsyncIOMotorDatabase, slug: str, user: User) -> dict:
    raw = await db["documents"].find_one({"slug": slug})
    await access.require(access.actor_from_request(request, user), raw, "view_stats", access.Ctx(db))
    return raw


def _csv(body: str, filename: str) -> Response:
    return Response(content=body, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"',
                             "Cache-Control": "private, no-store"})


@router.get("/documents/{slug}/analytics/overview")
@limiter.limit("120/minute")
async def analytics_overview(
    request: Request, slug: str,
    range: str = Query("30d", pattern=RANGE),
    internal: int = Query(0, ge=0, le=1),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    raw = await _owned_doc(request, db, slug, user)
    return await ca.overview(db, raw, ca.window(range), bool(internal))


@router.get("/documents/{slug}/analytics/media")
@limiter.limit("120/minute")
async def analytics_media(
    request: Request, slug: str,
    ver: int | None = Query(None, ge=1, le=100_000),
    range: str = Query("30d", pattern=RANGE),
    internal: int = Query(0, ge=0, le=1),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    raw = await _owned_doc(request, db, slug, user)
    return await ca.media_report(db, raw, ca.window(range), bool(internal), ver)


@router.get("/documents/{slug}/analytics/frame")
@limiter.limit("60/minute")
async def analytics_frame(
    request: Request, slug: str,
    t: float = Query(..., ge=0, le=24 * 3600),
    ver: int | None = Query(None, ge=1, le=100_000),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """A frame of the owner's video at ``t`` seconds (rounded), as a JPEG.
    404 when it isn't a video, or frames can't be made here."""
    raw = await _owned_doc(request, db, slug, user)
    jpg = await ca.frame(db, raw, t, ver)
    if not jpg:
        raise HTTPException(status_code=404, detail="No frame available")
    return Response(content=jpg, media_type="image/jpeg",
                    headers={"Cache-Control": "private, max-age=86400"})


@router.get("/documents/{slug}/analytics/content")
@limiter.limit("120/minute")
async def analytics_content(
    request: Request, slug: str,
    range: str = Query("30d", pattern=RANGE),
    internal: int = Query(0, ge=0, le=1),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    raw = await _owned_doc(request, db, slug, user)
    return await ca.content_report(db, raw, ca.window(range), bool(internal))


@router.get("/documents/{slug}/analytics/pages")
@limiter.limit("120/minute")
async def analytics_pages(
    request: Request, slug: str,
    range: str = Query("30d", pattern=RANGE),
    internal: int = Query(0, ge=0, le=1),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    raw = await _owned_doc(request, db, slug, user)
    return await ca.pages_report(db, raw, ca.window(range), bool(internal))


@router.get("/documents/{slug}/analytics/audience")
@limiter.limit("120/minute")
async def analytics_audience(
    request: Request, slug: str,
    range: str = Query("30d", pattern=RANGE),
    internal: int = Query(0, ge=0, le=1),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    raw = await _owned_doc(request, db, slug, user)
    return await ca.audience_report(db, raw, ca.window(range), bool(internal))


@router.get("/documents/{slug}/analytics/versions")
@limiter.limit("120/minute")
async def analytics_versions(
    request: Request, slug: str,
    # Accepted for symmetry; versions are compared over their whole lifetime.
    range: str = Query("30d", pattern=RANGE),
    internal: int = Query(0, ge=0, le=1),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    raw = await _owned_doc(request, db, slug, user)
    return await ca.versions_report(db, raw, bool(internal))


@router.get("/documents/{slug}/analytics.csv")
@limiter.limit("60/minute")
async def analytics_csv(
    request: Request, slug: str,
    range: str = Query("30d", pattern=RANGE),
    internal: int = Query(0, ge=0, le=1),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    raw = await _owned_doc(request, db, slug, user)
    body = await ca.daily_csv(db, raw, ca.window(range), bool(internal))
    return _csv(body, f"{raw['slug']}-analytics-{range}.csv")


@router.get("/analytics")
@limiter.limit("120/minute")
async def analytics_home(
    request: Request,
    range: str = Query("30d", pattern=RANGE),
    internal: int = Query(0, ge=0, le=1),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    return await ca.home(db, user.id, ca.window(range), bool(internal))


@router.get("/analytics/live")
@limiter.limit("240/minute")
async def analytics_live(
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    return await ca.live(db, user.id)


@router.get("/analytics.csv")
@limiter.limit("60/minute")
async def analytics_home_csv(
    request: Request,
    range: str = Query("30d", pattern=RANGE),
    internal: int = Query(0, ge=0, le=1),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    body = await ca.home_csv(db, user.id, ca.window(range), bool(internal))
    return _csv(body, f"markdrop-analytics-{range}.csv")
