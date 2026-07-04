from fastapi import APIRouter, Depends, Header, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import optional_user, require_user
from app.schemas.document import (
    DocumentCreate,
    DocumentCreateResponse,
    DocumentResponse,
    DocumentUpdate,
    EventRequest,
    ReportRequest,
    SlugChangeRequest,
)
from app.services import analytics, document as doc_service
from app.utils.net import get_client_ip

settings = get_settings()
router = APIRouter(prefix="/api/v1/documents", tags=["documents"])

BASE_URL = "https://markdrop.in"


import re

_BOT_RE = re.compile(r"bot|crawl|spider|slurp|preview|fetch|monitor|headless|curl|wget|python-|axios|node-fetch", re.I)


def _is_bot(user_agent: str | None) -> bool:
    return bool(user_agent) and bool(_BOT_RE.search(user_agent or ""))


def _build_url(slug: str) -> str:
    return f"{BASE_URL}/{slug}"


def _to_response(doc, viewer_id: str | None = None) -> dict:
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
        is_owned=bool(doc.owner_id),
        is_owner=bool(viewer_id) and doc.owner_id == viewer_id,
    )


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


@router.post("", response_model=DocumentCreateResponse, status_code=201)
@limiter.limit(settings.rate_limit_create)
async def create_document(
    request: Request,
    data: DocumentCreate,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User | None = Depends(optional_user),
):
    # Logged-in creators automatically own their document.
    owner_id = user.id if user else None
    doc, raw_secret = await doc_service.create_document(db, data, owner_id=owner_id)
    return DocumentCreateResponse(**_to_response(doc, owner_id), edit_secret=raw_secret)


@router.get("/{slug}", response_model=DocumentResponse)
@limiter.limit(settings.rate_limit_read)
async def get_document(
    request: Request,
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_read_password: str | None = Header(None),
    x_edit_secret: str | None = Header(None),
    user: User | None = Depends(optional_user),
):
    viewer_id = user.id if user else None
    doc = await doc_service.get_document(db, slug, x_read_password, x_edit_secret, viewer_id)
    return DocumentResponse(**_to_response(doc, viewer_id))


@router.put("/{slug}", response_model=DocumentResponse)
@limiter.limit(settings.rate_limit_create)
async def update_document(
    request: Request,
    slug: str,
    data: DocumentUpdate,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_edit_secret: str | None = Header(None),
    user: User | None = Depends(optional_user),
):
    viewer_id = user.id if user else None
    doc = await doc_service.update_document(db, slug, data, x_edit_secret, viewer_id)
    return DocumentResponse(**_to_response(doc, viewer_id))


@router.delete("/{slug}", status_code=204)
@limiter.limit(settings.rate_limit_create)
async def delete_document(
    request: Request,
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_edit_secret: str | None = Header(None),
    user: User | None = Depends(optional_user),
):
    await doc_service.delete_document(db, slug, x_edit_secret, user.id if user else None)


@router.post("/{slug}/claim", response_model=DocumentResponse)
@limiter.limit(settings.rate_limit_create)
async def claim_document(
    request: Request,
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_edit_secret: str = Header(...),
    user: User = Depends(require_user),
):
    """Attach an anonymous document to the logged-in account (proven via secret)."""
    doc = await doc_service.claim_document(db, slug, x_edit_secret, user.id)
    return DocumentResponse(**_to_response(doc, user.id))


@router.patch("/{slug}/slug", response_model=DocumentResponse)
@limiter.limit(settings.rate_limit_create)
async def change_slug(
    request: Request,
    slug: str,
    data: SlugChangeRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_edit_secret: str | None = Header(None),
    user: User | None = Depends(optional_user),
):
    viewer_id = user.id if user else None
    doc = await doc_service.change_slug(db, slug, data.new_slug, x_edit_secret, viewer_id)
    return DocumentResponse(**_to_response(doc, viewer_id))


@router.post("/{slug}/events", status_code=202)
@limiter.limit("120/minute")
async def record_click(
    request: Request,
    slug: str,
    data: EventRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """Record a view / export-PDF / copy-URL event (called by the viewer's browser)."""
    # Skip obvious bots/crawlers for view counting (beacons already exclude
    # most non-JS bots; this covers headless/preview fetchers).
    if data.type == "view" and _is_bot(request.headers.get("user-agent")):
        return {"status": "ignored"}
    result = await doc_service.register_event(db, slug, data.type)
    if result is None:
        raise HTTPException(status_code=404, detail="Document not found")
    doc_id, owner_id = result
    await analytics.record_event(
        db, doc_id, owner_id, data.type,
        ip=get_client_ip(request),
        referrer=request.headers.get("referer"),
    )
    return {"status": "ok"}


@router.post("/{slug}/report", status_code=202)
@limiter.limit("5/minute")
async def report_document(
    request: Request,
    slug: str,
    data: ReportRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """Flag a document for abuse (public, rate-limited)."""
    ok = await doc_service.report_document(db, slug, data.reason, get_client_ip(request))
    if not ok:
        raise HTTPException(status_code=404, detail="Document not found")
    return {"status": "ok"}
