from fastapi import APIRouter, Depends, Header, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.config import get_settings
from app.database import get_database
from app.schemas.document import (
    DocumentCreate,
    DocumentCreateResponse,
    DocumentResponse,
    DocumentUpdate,
)
from app.services import document as doc_service

settings = get_settings()
router = APIRouter(prefix="/api/v1/documents", tags=["documents"])
limiter = Limiter(key_func=get_remote_address)

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
):
    doc = await doc_service.get_document(db, slug)
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
