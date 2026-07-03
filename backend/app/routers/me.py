"""User-scoped endpoints (require login) — the dashboard.

Phase 3: GET /api/v1/me/documents (list the caller's own documents).
Phase 4 adds per-document analytics under this same prefix.
"""

import math

from fastapi import APIRouter, Depends, HTTPException, Query
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.models.user import User
from app.routers.auth import require_user
from app.schemas.document import MyDocListItem, MyDocListResponse
from app.services import analytics, document as doc_service

router = APIRouter(prefix="/api/v1/me", tags=["me"])

BASE_URL = "https://markdrop.in"


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _to_list_item(doc) -> MyDocListItem:
    return MyDocListItem(
        slug=doc.slug,
        url=f"{BASE_URL}/{doc.slug}",
        title=doc.title,
        content_preview=doc.content[:300],
        created_at=doc.created_at,
        updated_at=doc.updated_at,
        expires_at=doc.expires_at,
        views=doc.views,
        export_pdf_count=doc.export_pdf_count,
        copy_url_count=doc.copy_url_count,
        is_password_protected=bool(doc.read_password_hash),
    )


@router.get("/documents", response_model=MyDocListResponse)
async def list_my_documents(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    q: str | None = Query(None),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    docs, total = await doc_service.list_user_documents(db, user.id, page, limit, q)
    return MyDocListResponse(
        documents=[_to_list_item(d) for d in docs],
        total=total,
        page=page,
        pages=max(1, math.ceil(total / limit)),
    )


@router.get("/documents/{slug}/analytics")
async def document_analytics(
    slug: str,
    range: str = Query("30d", pattern="^(7d|30d|all)$"),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Aggregated analytics for a document the caller owns."""
    doc_id = await doc_service.get_owned_doc_id(db, slug, user.id)
    if doc_id is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return await analytics.get_analytics(db, doc_id, range)
