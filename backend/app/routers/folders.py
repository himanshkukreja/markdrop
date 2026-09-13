"""Folders for a workspace.

Every route authorises against the workspace first, and every service call is
scoped to it, so a folder id from another tenant is indistinguishable from one
that does not exist.
"""

from fastapi import APIRouter, Depends, Request
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.models.folder import Folder
from app.models.user import User
from app.routers.auth import require_user
from app.schemas.folder import (
    DocumentMoveRequest,
    FolderCreate,
    FolderDeleteResponse,
    FolderListResponse,
    FolderResponse,
    FolderUpdate,
)
from app.services import folder as folder_service
from app.services import workspace as ws_service

router = APIRouter(prefix="/api/v1/workspaces", tags=["folders"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _to_response(f: Folder) -> FolderResponse:
    return FolderResponse(
        id=f.id, workspace_id=f.workspace_id, name=f.name,
        parent_id=f.parent_id, created_at=f.created_at, updated_at=f.updated_at,
    )


@router.get("/{workspace_id}/folders", response_model=FolderListResponse)
@limiter.limit("120/minute")
async def list_folders(
    request: Request, workspace_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user),
):
    await ws_service.require_role(db, workspace_id, user.id, "viewer")
    folders = await folder_service.list_folders(db, workspace_id)
    return FolderListResponse(folders=[_to_response(f) for f in folders])


@router.post("/{workspace_id}/folders", response_model=FolderResponse, status_code=201)
@limiter.limit("60/minute")
async def create_folder(
    request: Request, workspace_id: str, data: FolderCreate,
    db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user),
):
    # Filing is ordinary work, so member rather than admin.
    await ws_service.require_role(db, workspace_id, user.id, "member")
    folder = await folder_service.create_folder(db, workspace_id, data.name, data.parent_id)
    return _to_response(folder)


@router.put("/{workspace_id}/folders/{folder_id}", response_model=FolderResponse)
@limiter.limit("60/minute")
async def update_folder(
    request: Request, workspace_id: str, folder_id: str, data: FolderUpdate,
    db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user),
):
    await ws_service.require_role(db, workspace_id, user.id, "member")
    folder = await folder_service.update_folder(
        db, workspace_id, folder_id,
        name=data.name, parent_id=data.parent_id, reparent=data.reparent,
    )
    return _to_response(folder)


@router.delete("/{workspace_id}/folders/{folder_id}", response_model=FolderDeleteResponse)
@limiter.limit("60/minute")
async def delete_folder(
    request: Request, workspace_id: str, folder_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user),
):
    # Deleting a container can unfile many documents at once, so admin.
    await ws_service.require_role(db, workspace_id, user.id, "admin")
    unfiled = await folder_service.delete_folder(db, workspace_id, folder_id)
    return FolderDeleteResponse(unfiled_documents=unfiled)


@router.post("/{workspace_id}/documents/move", status_code=204)
@limiter.limit("120/minute")
async def move_document(
    request: Request, workspace_id: str, data: DocumentMoveRequest,
    db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user),
):
    await ws_service.require_role(db, workspace_id, user.id, "member")
    await folder_service.move_document(db, workspace_id, data.slug, data.folder_id)
