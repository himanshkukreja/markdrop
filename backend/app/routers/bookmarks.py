"""Link previews for the page editor's bookmark block (services/bookmarks.py)."""

import hashlib

from fastapi import APIRouter, Depends, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.services import bookmarks
from app.utils.net import get_client_ip

router = APIRouter(prefix="/api/v1/bookmarks", tags=["pages"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _per_user(request: Request) -> str:
    """Rate-limit key: the caller's credential (one person, whatever their IP)."""
    auth = request.headers.get("authorization") or ""
    if auth.startswith("Bearer ") and len(auth) > 20:
        return "bm:" + hashlib.sha256(auth.encode()).hexdigest()[:32]
    return "bm-ip:" + (get_client_ip(request) or "?")


class PreviewRequest(BaseModel):
    url: str = Field(..., min_length=1, max_length=2048)


@router.post("/preview")
@limiter.limit("30/minute", key_func=_per_user)
@limiter.limit("300/day", key_func=_per_user)
async def preview(
    request: Request,
    data: PreviewRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """``{url, title, description, site_name, favicon, image, fetched}`` for a
    bookmark block. Signed in only. 422 for an address that may not be fetched
    (private networks, other schemes or ports, credentials in the URL)."""
    try:
        return await bookmarks.preview(db, data.url)
    except bookmarks.BookmarkError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
