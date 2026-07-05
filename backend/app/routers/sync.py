"""Two-way document sync for the VS Code extension.

All endpoints are owner-scoped (session JWT or API token) and keyed on the
document's immutable ``_id`` — so renaming the slug on the web never breaks a
link. Concurrency is handled with an integer ``rev`` (optimistic locking): a
push carrying a stale ``base_rev`` returns 409 with the current content so the
client can resolve the conflict.
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.schemas.document import (
    DocumentCreate,
    SyncCreateRequest,
    SyncDocResponse,
    SyncPushRequest,
    SyncRevResponse,
)
from app.services import document as doc_service
from app.services import live

router = APIRouter(prefix="/api/v1/sync", tags=["sync"])

BASE_URL = "https://markdrop.in"


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _doc_response(doc) -> SyncDocResponse:
    return SyncDocResponse(
        id=doc.id,
        slug=doc.slug,
        url=f"{BASE_URL}/{doc.slug}",
        title=doc.title,
        content=doc.content,
        rev=doc.rev,
        updated_at=doc.updated_at,
    )


@router.post("", response_model=SyncDocResponse, status_code=201)
@limiter.limit("60/minute")
async def sync_create(
    request: Request,
    data: SyncCreateRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Create + link a document from the editor (owned by the caller)."""
    payload = DocumentCreate(title=data.title, content=data.content)
    doc, _secret = await doc_service.create_document(
        db, payload, owner_id=user.id, preferred_slug=data.desired_slug, via_vscode=True
    )
    return _doc_response(doc)


@router.get("/{doc_id}", response_model=SyncDocResponse)
async def sync_pull(
    doc_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Full pull of the current server content."""
    doc = await doc_service.get_owned_document_by_id(db, doc_id, user.id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return _doc_response(doc)


@router.get("/{doc_id}/rev", response_model=SyncRevResponse)
async def sync_rev(
    doc_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Cheap revision check for polling."""
    doc = await doc_service.get_owned_document_by_id(db, doc_id, user.id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return SyncRevResponse(id=doc.id, rev=doc.rev, updated_at=doc.updated_at)


@router.put("/{doc_id}", response_model=SyncDocResponse)
@limiter.limit("120/minute")
async def sync_push(
    request: Request,
    doc_id: str,
    data: SyncPushRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Push local content. 409 (with current content) if base_rev is stale."""
    status, doc = await doc_service.sync_push(
        db, doc_id, user.id, data.content, data.title, data.base_rev
    )
    if status == "notfound":
        raise HTTPException(status_code=404, detail="Document not found")
    if status == "conflict":
        raise HTTPException(
            status_code=409,
            detail={
                "error": "conflict",
                "id": doc.id,
                "slug": doc.slug,
                "rev": doc.rev,
                "title": doc.title,
                "content": doc.content,
            },
        )
    # Notify any open viewers so they refresh live (best-effort, in-process).
    live.publish(doc.slug, doc.rev)
    return _doc_response(doc)
