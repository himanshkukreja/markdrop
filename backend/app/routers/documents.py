from fastapi import APIRouter, Depends, Header, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from slowapi import Limiter

from app.config import get_settings
from app.database import get_database
from app.schemas.document import (
    DocumentCreate,
    DocumentCreateResponse,
    DocumentResponse,
    DocumentUpdate,
)
from app.services import document as doc_service
from app.utils.net import get_client_ip

settings = get_settings()
router = APIRouter(prefix="/api/v1/documents", tags=["documents"])
# Key on the real client IP (behind nginx) and share limits across workers/
# restarts via Redis. Without this, key_func saw nginx's 127.0.0.1 for every
# request, making limits effectively global.
limiter = Limiter(key_func=get_client_ip, storage_uri=settings.redis_url)

BASE_URL = "https://markdrop.in"


def _build_url(slug: str) -> str:
    return f"{BASE_URL}/{slug}"


def _to_response(doc) -> dict:
    return dict(
        slug=doc.slug,
        url=_build_url(doc.slug),
        title=doc.title,
        content=doc.content,
        created_at=doc.created_at,
        updated_at=doc.updated_at,
        expires_at=doc.expires_at,
        views=doc.views,
        is_password_protected=bool(doc.read_password_hash),
    )


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


@router.post("", response_model=DocumentCreateResponse, status_code=201)
@limiter.limit(settings.rate_limit_create)
async def create_document(
    request: Request,
    data: DocumentCreate,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    doc, raw_secret = await doc_service.create_document(db, data)
    return DocumentCreateResponse(**_to_response(doc), edit_secret=raw_secret)


@router.get("/{slug}", response_model=DocumentResponse)
@limiter.limit(settings.rate_limit_read)
async def get_document(
    request: Request,
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_read_password: str | None = Header(None),
    x_edit_secret: str | None = Header(None),
):
    doc = await doc_service.get_document(db, slug, x_read_password, x_edit_secret)
    return DocumentResponse(**_to_response(doc))


@router.put("/{slug}", response_model=DocumentResponse)
@limiter.limit(settings.rate_limit_create)
async def update_document(
    request: Request,
    slug: str,
    data: DocumentUpdate,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_edit_secret: str = Header(...),
):
    doc = await doc_service.update_document(db, slug, data, x_edit_secret)
    return DocumentResponse(**_to_response(doc))


@router.delete("/{slug}", status_code=204)
@limiter.limit(settings.rate_limit_create)
async def delete_document(
    request: Request,
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_edit_secret: str = Header(...),
):
    await doc_service.delete_document(db, slug, x_edit_secret)
