"""Files API: upload a file, or replace the one behind a link, and its versions.

For clients without a browser (the markdrop CLI, the local MCP server, an agent
with a shell). Bytes go client → R2 on presigned part URLs; see
services/file_uploads.py for the flow and services/file_versions.py for the
version rules. Everything requires a signed-in user (session or ``mdk_`` API
token).

    POST   /api/v1/files/uploads                       open an upload (part URLs)
    POST   /api/v1/files/uploads/{id}/urls             fresh part URLs
    GET    /api/v1/files/uploads/{id}                  state, parts received, result
    POST   /api/v1/files/uploads/{id}/complete         verify + publish (200 | 202)
    DELETE /api/v1/files/uploads/{id}                  cancel
    GET    /api/v1/files/{slug}                        file info
    GET    /api/v1/files/{slug}/versions               versions, newest first
    POST   /api/v1/files/{slug}/versions/{n}/restore   make version n current again
"""

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.artifacts import _require_configured
from app.routers.auth import require_user
from app.schemas.files import (
    FileInfoResponse,
    FileVersionsResponse,
    UploadCompleteRequest,
    UploadCreateRequest,
    UploadSessionResponse,
    UploadStatusResponse,
    UploadUrlsRequest,
)
from app.services import file_uploads

router = APIRouter(prefix="/api/v1/files", tags=["files"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


@router.post("/uploads", response_model=UploadSessionResponse)
@limiter.limit("30/minute")
async def create_upload(
    request: Request,
    data: UploadCreateRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    _require_configured()
    return await file_uploads.create(db, user, data)


@router.post("/uploads/{upload_id}/urls", response_model=UploadSessionResponse)
@limiter.limit("60/minute")
async def refresh_upload_urls(
    request: Request,
    upload_id: str,
    data: UploadUrlsRequest | None = None,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    _require_configured()
    numbers = data.part_numbers if data else None
    return await file_uploads.fresh_urls(db, user.id, upload_id, numbers)


@router.get("/uploads/{upload_id}", response_model=UploadStatusResponse)
@limiter.limit("240/minute")
async def upload_status(
    request: Request,
    upload_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    _require_configured()
    return await file_uploads.status(db, user.id, upload_id)


@router.post("/uploads/{upload_id}/complete")
@limiter.limit("60/minute")
async def complete_upload(
    request: Request,
    upload_id: str,
    data: UploadCompleteRequest | None = None,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """200 with the result, or 202 ``{state: "verifying", upload_id}`` when the
    sha256 check outlasts the wait: poll ``GET /uploads/{id}`` until ``state``
    is "done" (``result``) or "failed" (``error``). Calling it again on a
    finished upload returns the same result."""
    _require_configured()
    parts = [p.model_dump() for p in data.parts] if data and data.parts else None
    status, body = await file_uploads.complete(db, user.id, upload_id, parts)
    return JSONResponse(jsonable_encoder(body), status_code=status)


@router.delete("/uploads/{upload_id}", status_code=204)
@limiter.limit("60/minute")
async def cancel_upload(
    request: Request,
    upload_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    _require_configured()
    await file_uploads.cancel(db, user.id, upload_id)
    return Response(status_code=204)


@router.get("/{slug}", response_model=FileInfoResponse)
@limiter.limit("120/minute")
async def file_info(
    request: Request,
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    raw = await file_uploads.readable_artifact(db, user, slug)
    return await file_uploads.file_info_for(db, raw)


@router.get("/{slug}/versions", response_model=FileVersionsResponse)
@limiter.limit("120/minute")
async def file_versions(
    request: Request,
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    raw = await file_uploads.owned_artifact(db, user, slug, action="see the versions of")
    return await file_uploads.versions(db, raw)


@router.post("/{slug}/versions/{version}/restore", response_model=FileInfoResponse)
@limiter.limit("30/minute")
async def restore_file_version(
    request: Request,
    slug: str,
    version: int,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    _require_configured()
    if version < 1:
        raise HTTPException(status_code=422, detail="Versions start at 1.")
    raw = await file_uploads.owned_artifact(db, user, slug, action="restore versions of")
    return await file_uploads.restore(db, user, raw, version)
