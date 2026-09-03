"""Two-way document sync for the VS Code extension.

All endpoints are owner-scoped (session JWT or API token) and keyed on the
document's immutable ``_id`` — so renaming the slug on the web never breaks a
link. Concurrency is handled with an integer ``rev`` (optimistic locking): a
push carrying a stale ``base_rev`` returns 409 with the current content so the
client can resolve the conflict.
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
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
from app.services import artifact as art_service
from app.services import document as doc_service
from app.services import live
from app.services import r2

settings = get_settings()
router = APIRouter(prefix="/api/v1/sync", tags=["sync"])

BASE_URL = "https://markdrop.in"


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _require_markdown_size(content: str) -> None:
    """Markdown documents live in MongoDB, so they keep the smaller character
    limit even though the sync schema now accepts artifact-sized bodies."""
    if len(content) > settings.max_content_chars:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Markdown documents are limited to "
                f"{settings.max_content_chars:,} characters. "
                "Publish this as an artifact instead (rename it to .html)."
            ),
        )


def _doc_response(doc, content: str | None = None) -> SyncDocResponse:
    """Shape a document for the editor.

    `content` is passed explicitly for artifacts, whose bytes live in R2 — the
    `content` column there is only a filename stand-in and must never be sent
    to the editor as if it were the file.
    """
    return SyncDocResponse(
        id=doc.id,
        slug=doc.slug,
        url=f"{BASE_URL}/{doc.slug}",
        title=doc.title,
        content=doc.content if content is None else content,
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
    """Create + link a document from the editor (owned by the caller).

    A markdown file becomes a markdown document; an .html (or other text
    artifact) file becomes an artifact, so it publishes as a rendered page
    rather than as escaped source. Both sync through the same endpoints below,
    so the editor needs no second protocol.
    """
    mime = art_service.mime_for_filename(data.desired_slug)
    if art_service.is_syncable(mime):
        doc = await _create_synced_artifact(db, user, data, mime)
        return _doc_response(doc, content=data.content)

    # The sync schema now allows artifact-sized bodies, so the markdown limit has
    # to be enforced here — otherwise DocumentCreate raises a validation error
    # deep in the handler and the editor sees a 500 instead of an explanation.
    _require_markdown_size(data.content)
    payload = DocumentCreate(title=data.title, content=data.content)
    doc, _secret = await doc_service.create_document(
        db, payload, owner_id=user.id, preferred_slug=data.desired_slug, via_vscode=True
    )
    return _doc_response(doc)


async def _create_synced_artifact(db, user, data, mime: str):
    """Store the editor's text in R2 and mint an artifact pointing at it."""
    if not r2.is_configured():
        raise HTTPException(
            status_code=503, detail="Artifact storage is not configured on this server."
        )
    payload = data.content.encode("utf-8")
    if len(payload) > art_service.MAX_SYNC_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File is over the {art_service.MAX_SYNC_BYTES // (1024*1024)} MB sync limit.",
        )

    blob_key = art_service.make_blob_key(user.id, mime)
    if not await run_in_threadpool(r2.put_bytes, blob_key, payload, mime, True, True):
        raise HTTPException(status_code=502, detail="Could not store the file. Try again.")

    try:
        doc, _secret = await art_service.create_artifact(
            db,
            user_id=user.id,
            blob_key=blob_key,
            mime=mime,
            size_bytes=len(payload),
            title=data.title,
            filename=data.desired_slug,
            preferred_slug=data.desired_slug,
        )
    except Exception:
        await run_in_threadpool(r2.delete, blob_key)
        raise
    await doc_service.mark_vscode_synced(db, doc.id)
    return doc


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
    if not doc.vscode_synced:
        await doc_service.mark_vscode_synced(db, doc.id)
    if doc.kind == "artifact":
        content = await art_service.read_content(doc)
        if content is None:
            raise HTTPException(
                status_code=409,
                detail="This artifact isn't a text file, so it can't be edited from your editor.",
            )
        return _doc_response(doc, content=content)
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
    if not doc.vscode_synced:
        await doc_service.mark_vscode_synced(db, doc.id)
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
    existing = await doc_service.get_owned_document_by_id(db, doc_id, user.id)
    if existing is not None and existing.kind == "artifact":
        status, doc = await art_service.sync_push_content(
            db, doc_id, user.id, data.content, data.base_rev
        )
        if status == "unsupported":
            raise HTTPException(
                status_code=409,
                detail="This artifact isn't a text file, so it can't be edited from your editor.",
            )
        if status == "ok":
            live.publish(doc.slug, doc.rev)
            return _doc_response(doc, content=data.content)
    else:
        _require_markdown_size(data.content)
        status, doc = await doc_service.sync_push(
            db, doc_id, user.id, data.content, data.title, data.base_rev
        )
    if status == "notfound":
        raise HTTPException(status_code=404, detail="Document not found")
    if status == "conflict":
        # The editor diffs against this, so an artifact must hand back its real
        # bytes rather than the filename stand-in in the content column.
        current = (
            await art_service.read_content(doc) if doc.kind == "artifact" else doc.content
        )
        raise HTTPException(
            status_code=409,
            detail={
                "error": "conflict",
                "id": doc.id,
                "slug": doc.slug,
                "rev": doc.rev,
                "title": doc.title,
                "content": current if current is not None else "",
            },
        )
    # Notify any open viewers so they refresh live (best-effort, in-process).
    live.publish(doc.slug, doc.rev)
    return _doc_response(doc)
