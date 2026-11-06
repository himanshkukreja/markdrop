"""Markdrop files embedded in docs pages (services/docs_embeds.py).

Public, no credentials, CORS `*` (middleware/public_cors.py), out of the OpenAPI schema:

    GET  /api/v1/embeds/{slug}?site=<docs site id>&v=<pinned version>
         what the file is now, for a `::markdrop` block: its title, kind, viewer and raw
         addresses on the artifact origin; or a bare state for anything a signed-out reader can't
         open. Cached 30 s (a pinned version's signed links: not cached).
    POST /api/v1/embeds/{slug}/beacon    text/plain {site, p, a, s?, v?}
         a block was seen / opened full screen / opened on Markdrop / played / watched (seconds);
         accepted from the docs site's own addresses only; always 202.

The studio (signed in; a Guides role on the site), under /api/v1/docs-sites/{site_id} (included by
routers/docs_sites.py):

    GET  …/embeds/library?scope=mine|workspace&q=&type=&page=   the picker (viewers and up)
    POST …/embeds/check   {src}               what a link is, and whether the guide's readers can see it
    POST …/embeds/share   {src}               make it "anyone with the link" (the file's owner)
    POST …/embeds/pins    {src, version}      pin a version for this guide (editors of the file)
    GET  …/insights/embeds?range=7d|30d|90d   per-file numbers for the Insights tab
"""

# No `from __future__ import annotations`: slowapi wraps these routes (see routers/docs_ai.py).
from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.routers.docs_site_pages import DocsRoute
from app.services import access
from app.services import docs_embeds as embeds
from app.services import docs_site_store as store
from app.utils.net import get_client_ip

public_router = APIRouter(prefix="/api/v1/embeds", tags=["embeds"])
router = APIRouter(route_class=DocsRoute)


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


# ── Public ────────────────────────────────────────────────────────────────────


@public_router.get("/{slug}", include_in_schema=False)
@limiter.limit("240/minute")
async def resolve_embed(request: Request, slug: str, site: str | None = Query(None, max_length=64),
                        v: int | None = Query(None, ge=1, le=100_000), db: AsyncIOMotorDatabase = Depends(get_db)):
    body, signed = await embeds.resolve(db, slug, site_id=site, version=v)
    cache = "private, no-store" if signed else "public, max-age=30, s-maxage=30"
    return JSONResponse(body, headers={"Cache-Control": cache, "X-Robots-Tag": "noindex"})


@public_router.post("/{slug}/beacon", include_in_schema=False)
@limiter.limit("120/minute")
async def embed_beacon(request: Request, slug: str, db: AsyncIOMotorDatabase = Depends(get_db)):
    status = "ignored"
    try:
        msg = embeds.parse_beacon(await request.body())
        if msg is not None:
            status = await embeds.record_beacon(
                db, slug, msg, origin=request.headers.get("origin"), ip=get_client_ip(request),
                ua=request.headers.get("user-agent") or "")
    except Exception:  # pragma: no cover - a beacon never errors
        import logging

        logging.getLogger(__name__).warning("embed beacon failed", exc_info=True)
    return JSONResponse({"status": "ok" if status == "ok" else "ignored"}, status_code=202, headers={"Cache-Control": "no-store"})


# ── The studio ────────────────────────────────────────────────────────────────


class SrcBody(BaseModel):
    src: str = Field(..., min_length=1, max_length=2000)


class PinBody(SrcBody):
    version: int = Field(..., ge=1, le=100_000)


@router.get("/{site_id}/embeds/library")
@limiter.limit("120/minute")
async def embed_library(request: Request, site_id: str, scope: str = Query("mine", pattern="^(mine|workspace)$"),
                        q: str | None = Query(None, max_length=200),
                        type: str | None = Query(None, pattern="^(all|html|bundle|pdf|sheet|docx|pptx|video|image|audio|text|doc)$"),
                        page: int = Query(1, ge=1, le=500),
                        db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user, "editor")
    actor = access.actor_from_request(request, user)
    return await embeds.library(db, actor, user.id, site, scope=scope, q=q, type_=type, page=page)


@router.post("/{site_id}/embeds/check")
@limiter.limit("120/minute")
async def embed_check(request: Request, site_id: str, body: SrcBody,
                      db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    await store.load_site(db, site_id, user, "editor")
    return await embeds.check(db, access.actor_from_request(request, user), body.src)


@router.post("/{site_id}/embeds/share")
@limiter.limit("30/minute")
async def embed_share(request: Request, site_id: str, body: SrcBody,
                      db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    await store.load_site(db, site_id, user, "editor")
    return await embeds.make_viewable(db, access.actor_from_request(request, user), body.src)


@router.post("/{site_id}/embeds/pins")
@limiter.limit("60/minute")
async def embed_pin(request: Request, site_id: str, body: PinBody,
                    db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user, "editor")
    return await embeds.pin(db, access.actor_from_request(request, user), str(site["_id"]), body.src, body.version, user.id)


@router.get("/{site_id}/insights/embeds")
@limiter.limit("60/minute")
async def embed_stats(request: Request, site_id: str, range: str = Query("30d", pattern="^(7d|30d|90d)$"),
                      db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user)
    return await embeds.stats(db, str(site["_id"]), range)
