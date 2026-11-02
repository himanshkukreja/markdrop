"""Settings › Export & self-host: /api/v1/docs-sites/{site_id}/export (services/docs_site_export.py).

    POST /{site_id}/export            {source: published|drafts, private: omit|public}  (Guides admins)
                                      → {url, expires_at, filename, pages, files, bytes, notes, …}
    GET  /{site_id}/export/download?token=…   the zip, streamed (no sign-in header: the token is it)

Included by routers/docs_sites.py.
"""

from typing import Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel

from app.config import get_settings
from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.routers.docs_site_pages import DocsRoute
from app.services import docs_site_export as export
from app.services import docs_site_store as store

router = APIRouter(route_class=DocsRoute)


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


class ExportRequest(BaseModel):
    source: Literal["published", "drafts"] = "published"
    private: Literal["omit", "public"] = "omit"


@router.post("/{site_id}/export")
@limiter.limit("20/minute")
async def start_export(request: Request, site_id: str, body: ExportRequest,
                       db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """What the download will hold (pages, files, size, what's different when self-hosted) and a
    five-minute link to it. Guides admins only."""
    site, _role = await store.load_site(db, site_id, user, "admin")
    p = await export.plan(db, site, source=body.source, private=body.private, user_id=user.id)
    token, exp = export.sign(str(site["_id"]), user.id, body.source, body.private)
    base = get_settings().api_base_url.rstrip("/")
    return {
        **export.summary(p),
        "url": f"{base}/api/v1/docs-sites/{site['_id']}/export/download?token={token}",
        "expires_at": exp,
        "filename": f"{p['folder']}.zip",
    }


@router.get("/{site_id}/export/download")
@limiter.limit("20/minute")
async def download_export(request: Request, site_id: str, token: str = Query(..., max_length=2000),
                          db: AsyncIOMotorDatabase = Depends(get_db)):
    """The content folder as a zip, written while it's sent."""
    site, user_id, opts = await export.redeem(db, site_id, token)
    p = await export.plan(db, site, source=opts["source"], private=opts["private"], user_id=user_id)
    await export.record(db, site, user_id, p)
    return StreamingResponse(
        export.zip_stream(p),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{p["folder"]}.zip"',
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
