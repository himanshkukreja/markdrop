"""The shared workspace library.

Read access is viewer-and-above; putting a document in is the owner's decision
alone. The privacy rule these routes exist to keep is written up in
`services.library` — in short, a document is private until its owner shares it,
and the listing query can only ever match documents that were shared.
"""

import math

from fastapi import APIRouter, Depends, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.routers.me import _to_list_item
from app.schemas.document import (
    LibraryAddRequest,
    LibraryFolderRequest,
    MyDocListItem,
    MyDocListResponse,
)
from app.services import library as lib_service
from app.services import workspace as ws_service

router = APIRouter(prefix="/api/v1/workspaces", tags=["library"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


async def _attribute(
    db: AsyncIOMotorDatabase, items: list[MyDocListItem], docs, viewer_id: str
) -> list[MyDocListItem]:
    """Fill in who shared each document.

    One query for all of them rather than one per row: a library page is a list,
    and a per-row lookup is how a list page becomes slow on a 2 vCPU box.
    """
    from bson import ObjectId

    owner_ids = {d.owner_id for d in docs if d.owner_id}
    people: dict[str, dict] = {}
    if owner_ids:
        oids = []
        for oid in owner_ids:
            try:
                oids.append(ObjectId(oid))
            except Exception:
                continue
        rows = await db["users"].find(
            {"_id": {"$in": oids}}, {"name": 1, "email": 1}
        ).to_list(length=len(oids))
        people = {str(r["_id"]): r for r in rows}

    for item, doc in zip(items, docs):
        who = people.get(doc.owner_id or "")
        item.shared_by_name = (who or {}).get("name")
        item.shared_by_email = (who or {}).get("email")
        item.is_mine = doc.owner_id == viewer_id
    return items


@router.get("/{workspace_id}/documents", response_model=MyDocListResponse)
@limiter.limit("120/minute")
async def list_library(
    request: Request,
    workspace_id: str,
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    q: str | None = Query(None),
    kind: str | None = Query(None, pattern="^(markdown|artifact)$"),
    folder_id: str | None = Query(None),
    unfiled: bool = Query(False),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    await ws_service.require_role(db, workspace_id, user.id, "viewer")
    docs, total = await lib_service.list_documents(
        db, workspace_id, page, limit, q, kind, folder_id, unfiled
    )
    items = await _attribute(db, [_to_list_item(d) for d in docs], docs, user.id)
    return MyDocListResponse(
        documents=items, total=total, page=page, pages=max(1, math.ceil(total / limit))
    )


@router.get("/{workspace_id}/documents/counts")
@limiter.limit("120/minute")
async def library_counts(
    request: Request,
    workspace_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    await ws_service.require_role(db, workspace_id, user.id, "viewer")
    return await lib_service.counts_by_folder(db, workspace_id)


@router.post("/{workspace_id}/documents", response_model=MyDocListItem, status_code=201)
@limiter.limit("60/minute")
async def add_to_library(
    request: Request,
    workspace_id: str,
    data: LibraryAddRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    doc = await lib_service.add_document(
        db, workspace_id, data.document_id, user, data.folder_id
    )
    return _to_list_item(doc)


@router.delete("/{workspace_id}/documents/{document_id}", status_code=204)
@limiter.limit("60/minute")
async def remove_from_library(
    request: Request,
    workspace_id: str,
    document_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Unshare, not delete. The document goes back to its owner untouched."""
    await lib_service.remove_document(db, workspace_id, document_id, user)


@router.put("/{workspace_id}/documents/{document_id}/folder", status_code=204)
@limiter.limit("60/minute")
async def file_document(
    request: Request,
    workspace_id: str,
    document_id: str,
    data: LibraryFolderRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    await lib_service.set_folder(db, workspace_id, document_id, data.folder_id, user)
