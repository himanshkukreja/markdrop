"""Artifacts — shareable, rendered URLs for HTML pages, PDFs and spreadsheets.

Upload is a two-step handshake:

  1. ``POST /upload-url``  → we validate type + quota and hand back a presigned
     PUT. The browser uploads straight to R2; the bytes never touch this server.
  2. ``POST /``            → we HEAD the object to learn its *real* size and
     type, then mint the document record.

Step 2's verification is what makes step 1 safe to trust: a presigned PUT can't
enforce a size limit, so the client's declared size is advisory and we check
reality before committing anything.

Everything here requires a logged-in user. Artifacts cost real storage and carry
real abuse risk (hosted HTML is a phishing magnet), so each one is attributable
to a revocable account. Anonymous markdown publishing is unaffected.
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import optional_user, require_user
from app.schemas.artifact import (
    ArtifactCreateRequest,
    ArtifactCreateResponse,
    ArtifactPasteRequest,
    ArtifactStatusResponse,
    ArtifactUploadUrlRequest,
    ArtifactUploadUrlResponse,
)
from app.services import artifact as art_service
from app.services import bundle
from app.services import r2

settings = get_settings()
router = APIRouter(prefix="/api/v1/artifacts", tags=["artifacts"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _require_configured() -> None:
    if not r2.is_configured():
        raise HTTPException(
            status_code=503,
            detail="Artifact storage is not configured on this server.",
        )
    # Refuse to serve user HTML from our own origin, even if someone
    # misconfigures it: that would expose the session token in localStorage.
    if not settings.artifact_origin_is_isolated:
        raise HTTPException(
            status_code=503,
            detail=(
                "Artifact origin is not isolated from the app origin. "
                "Point MARKDROP_ARTIFACT_ORIGIN at a separate site (a bought "
                "domain, or a free *.workers.dev host), or set "
                "MARKDROP_ARTIFACT_ALLOW_SUBDOMAIN_ORIGIN=true to accept the "
                "weaker subdomain posture."
            ),
        )


@router.get("/status", response_model=ArtifactStatusResponse)
async def artifact_status(
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User | None = Depends(optional_user),
):
    """Feature gate + quota for the UI. Safe to call when nothing is configured."""
    used = 0
    if user and r2.is_configured():
        used = await art_service.user_usage_bytes(db, user.id)
    return ArtifactStatusResponse(
        configured=r2.is_configured() and settings.artifact_origin_is_isolated,
        origin_isolated=settings.artifact_origin_is_isolated,
        origin_separate_site=settings.artifact_origin_is_separate_site,
        max_file_bytes=settings.artifact_max_bytes,
        quota_bytes=settings.artifact_user_quota_bytes,
        used_bytes=used,
        accepted_types=sorted(art_service.BY_MIME.keys()),
    )


@router.post("/upload-url", response_model=ArtifactUploadUrlResponse)
@limiter.limit("20/minute")
async def create_upload_url(
    request: Request,
    data: ArtifactUploadUrlRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    _require_configured()

    mime = art_service.normalize_mime(data.content_type, data.filename)
    if not mime:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type. Accepted: {', '.join(sorted(art_service.BY_EXT))}.",
        )
    if data.size_bytes > settings.artifact_max_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"File is larger than the {settings.artifact_max_bytes // (1024*1024)} MB limit.",
        )

    allowed, used = await art_service.check_quota(db, user.id, data.size_bytes)
    if not allowed:
        raise HTTPException(
            status_code=507,
            detail=(
                f"Storage quota exceeded — {used // (1024*1024)} MB of "
                f"{settings.artifact_user_quota_bytes // (1024*1024)} MB used. "
                "Delete an artifact to free space."
            ),
        )

    blob_key = art_service.make_blob_key(user.id, mime)
    # Pure local HMAC, no network I/O — safe to call on the event loop.
    upload_url = r2.presign_put(blob_key, mime)
    return ArtifactUploadUrlResponse(
        upload_url=upload_url,
        blob_key=blob_key,
        mime=mime,
        required_content_type=mime,
        expires_in=settings.artifact_upload_ttl_seconds,
    )


@router.post("", response_model=ArtifactCreateResponse, status_code=201)
@limiter.limit("20/minute")
async def confirm_artifact(
    request: Request,
    data: ArtifactCreateRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Verify the uploaded blob, then publish it at a slug."""
    _require_configured()

    # The key is namespaced by owner, so this stops anyone confirming a blob
    # that isn't theirs (or inventing a key pointing at another account's file).
    if not data.blob_key.startswith(f"art/{user.id}/"):
        raise HTTPException(status_code=403, detail="This upload does not belong to you.")

    meta = await run_in_threadpool(r2.head, data.blob_key)
    if not meta:
        raise HTTPException(status_code=404, detail="Upload not found — please try again.")

    # Real size, not the declared one. Oversized uploads are deleted, not kept.
    if meta["size"] > settings.artifact_max_bytes:
        await run_in_threadpool(r2.delete, data.blob_key)
        raise HTTPException(
            status_code=413,
            detail=f"File is larger than the {settings.artifact_max_bytes // (1024*1024)} MB limit.",
        )

    mime = art_service.normalize_mime(meta["content_type"], data.filename)
    if not mime:
        await run_in_threadpool(r2.delete, data.blob_key)
        raise HTTPException(status_code=415, detail="Unsupported file type.")

    allowed, used = await art_service.check_quota(db, user.id, meta["size"])
    if not allowed:
        await run_in_threadpool(r2.delete, data.blob_key)
        raise HTTPException(status_code=507, detail="Storage quota exceeded.")

    # Default to the uploaded object; only a bundle rewrites these. Assigning
    # blob_key here matters — assigning it solely inside the branch below makes
    # it a local that is unbound on every non-zip upload.
    blob_key = data.blob_key
    bundle_prefix: str | None = None
    size_bytes = meta["size"]

    if mime == "application/zip":
        # Explode the archive into its own prefix and point the document at the
        # entry HTML. Every asset ends up a sibling of that file, so relative
        # paths inside the page resolve with no rewriting on our side.
        blob_key, bundle_prefix, mime, size_bytes = await _explode_bundle(
            data.blob_key, user.id
        )

    try:
        doc, secret = await art_service.create_artifact(
            db,
            user_id=user.id,
            blob_key=blob_key,
            bundle_prefix=bundle_prefix,
            mime=mime,
            size_bytes=size_bytes,
            title=data.title,
            filename=data.filename,
            custom_slug=data.custom_slug,
            expires_in=data.expires_in,
            custom_expires_at=data.custom_expires_at,
            read_password=data.read_password,
        )
    except Exception:
        # The bytes are already in R2 but no document will reference them, so
        # they'd sit there costing storage forever. Anything that fails here —
        # a taken custom slug, a database blip, a bug — must not leak an object.
        if bundle_prefix:
            await run_in_threadpool(r2.delete_prefix, bundle_prefix)
        else:
            await run_in_threadpool(r2.delete, blob_key)
        raise

    return ArtifactCreateResponse(
        **art_service.to_response(doc, is_owner=True), edit_secret=secret
    )


async def _explode_bundle(zip_key: str, user_id: str) -> tuple[str, str, str, int]:
    """Unpack a bundle zip into R2. Returns (entry_key, prefix, mime, bytes).

    The uploaded archive is removed afterwards — we serve the extracted files,
    and keeping the zip would double the storage charged against the quota.
    """
    raw = await run_in_threadpool(r2.get_bytes, zip_key, settings.artifact_max_bytes)
    if raw is None:
        raise HTTPException(status_code=404, detail="Upload not found — please try again.")

    try:
        entry, files = await run_in_threadpool(bundle.extract, raw)
    except bundle.BundleError as e:
        await run_in_threadpool(r2.delete, zip_key)
        raise HTTPException(status_code=422, detail=str(e))

    # Strip the .zip extension to get a directory-shaped prefix.
    prefix = zip_key[: -len(".zip")] if zip_key.endswith(".zip") else zip_key
    prefix = prefix.rstrip("/") + "/"

    total = 0
    for path, content, file_mime in files:
        ok = await run_in_threadpool(r2.put_bytes, f"{prefix}{path}", content, file_mime)
        if not ok:
            await run_in_threadpool(r2.delete_prefix, prefix)
            await run_in_threadpool(r2.delete, zip_key)
            raise HTTPException(status_code=502, detail="Could not store the bundle. Try again.")
        total += len(content)

    await run_in_threadpool(r2.delete, zip_key)  # the archive itself isn't served
    return f"{prefix}{entry}", prefix, "text/html", total


@router.post("/paste", response_model=ArtifactCreateResponse, status_code=201)
@limiter.limit("10/minute")
async def paste_html(
    request: Request,
    data: ArtifactPasteRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Publish pasted HTML directly — the most-requested flow.

    Small enough that a presigned round trip would be pointless; anything larger
    should go through the file-upload path.
    """
    _require_configured()

    payload = data.content.encode("utf-8")
    if len(payload) > art_service.MAX_PASTE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Pasted HTML is over {art_service.MAX_PASTE_BYTES // (1024*1024)} MB — "
                "upload it as a file instead."
            ),
        )

    allowed, used = await art_service.check_quota(db, user.id, len(payload))
    if not allowed:
        raise HTTPException(status_code=507, detail="Storage quota exceeded.")

    blob_key = art_service.make_blob_key(user.id, "text/html")
    ok = await run_in_threadpool(r2.put_bytes, blob_key, payload, "text/html")
    if not ok:
        raise HTTPException(status_code=502, detail="Could not store the page. Try again.")

    doc, secret = await art_service.create_artifact(
        db,
        user_id=user.id,
        blob_key=blob_key,
        mime="text/html",
        size_bytes=len(payload),
        title=data.title,
        filename=None,
        custom_slug=data.custom_slug,
        expires_in=data.expires_in,
        custom_expires_at=data.custom_expires_at,
        read_password=data.read_password,
    )
    return ArtifactCreateResponse(
        **art_service.to_response(doc, is_owner=True), edit_secret=secret
    )
