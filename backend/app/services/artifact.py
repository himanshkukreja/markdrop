"""Artifacts — non-markdown files that get a shareable, *rendered* URL.

An artifact is a file (HTML page, PDF, spreadsheet, image…) stored in R2 and
presented at ``markdrop.in/<slug>`` with the usual Markdrop chrome, while the
file itself renders inside an iframe pointed at a **separate origin**.

Why the separate origin is non-negotiable
-----------------------------------------
The session token lives in ``localStorage['markdrop_token']`` and edit secrets /
read passwords live in ``sessionStorage`` on the markdrop.in origin. HTML served
from that same origin could read all of it and hand over the account. Serving
user content from an unrelated domain puts it in a different origin, so the
same-origin policy does the enforcing for us — and keeps a phishing takedown on
the throwaway domain instead of the product.

Artifacts reuse the ``documents`` collection (``kind: "artifact"``), so slug
uniqueness, edit secrets, password gating, the expiry TTL index, ownership,
analytics, abuse reports and the dashboard all work unchanged.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import jwt
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings

settings = get_settings()


@dataclass(frozen=True)
class ArtifactType:
    mime: str
    renderer: str   # how the sandbox origin presents it
    label: str
    ext: str


# The whitelist IS the security boundary: anything not listed is refused at
# upload, so we never store a type we haven't decided how to serve.
#
# renderer:
#   "html"  → served raw into a sandboxed iframe (the page IS the artifact)
#   "pdf"   → PDF.js viewer on the sandbox origin
#   "sheet" → SheetJS grid viewer
#   "image" → <img> (SVG included — it can carry script, so it stays sandboxed)
#   "text"  → escaped <pre>
_TYPES: tuple[ArtifactType, ...] = (
    ArtifactType("text/html", "html", "HTML page", "html"),
    ArtifactType("application/pdf", "pdf", "PDF", "pdf"),
    ArtifactType(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "sheet", "Excel spreadsheet", "xlsx",
    ),
    ArtifactType("application/vnd.ms-excel", "sheet", "Excel spreadsheet", "xls"),
    ArtifactType("text/csv", "sheet", "CSV", "csv"),
    ArtifactType(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "docx", "Word document", "docx",
    ),
    ArtifactType("application/zip", "bundle", "Web bundle", "zip"),
    ArtifactType("application/json", "text", "JSON", "json"),
    ArtifactType("text/plain", "text", "Text file", "txt"),
    ArtifactType("image/png", "image", "Image", "png"),
    ArtifactType("image/jpeg", "image", "Image", "jpg"),
    ArtifactType("image/gif", "image", "Image", "gif"),
    ArtifactType("image/webp", "image", "Image", "webp"),
    ArtifactType("image/svg+xml", "image", "SVG image", "svg"),
)

BY_MIME: dict[str, ArtifactType] = {t.mime: t for t in _TYPES}
BY_EXT: dict[str, ArtifactType] = {t.ext: t for t in _TYPES}


def normalize_mime(mime: str | None, filename: str | None = None) -> str | None:
    """Resolve a supported MIME type, or None if we won't accept it.

    Browsers are inconsistent about spreadsheet and CSV types (and send
    ``application/octet-stream`` for plenty of things), so fall back to the
    filename extension before giving up.
    """
    if mime:
        base = mime.split(";")[0].strip().lower()
        if base in BY_MIME:
            return base
    if filename and "." in filename:
        ext = filename.rsplit(".", 1)[-1].lower()
        t = BY_EXT.get(ext)
        if t:
            return t.mime
    return None


def renderer_for(mime: str) -> str:
    t = BY_MIME.get(mime)
    return t.renderer if t else "download"


def label_for(mime: str) -> str:
    t = BY_MIME.get(mime)
    return t.label if t else "File"


def make_blob_key(user_id: str, mime: str) -> str:
    """Unguessable, immutable, per-owner object key.

    Deliberately NOT content-addressed: with a client-supplied hash as the key,
    a caller could claim someone else's hash and overwrite their artifact. A
    random key namespaced by owner removes that entirely, and because keys are
    never reused the edge can cache them immutably. Dedup isn't worth the hole.
    """
    t = BY_MIME.get(mime)
    ext = f".{t.ext}" if t else ""
    return f"art/{user_id}/{secrets.token_urlsafe(18)}{ext}"


# ── Access tokens for private artifacts ────────────────────────────────────────


def sign_access_token(blob_key: str) -> str:
    """Short-lived HMAC token the Worker checks before serving a private blob.

    Public artifacts don't get one — their URL is an unguessable capability and
    stays fully edge-cacheable. Password-protected ones do, so that a viewer who
    unlocked the document can't just paste the raw blob URL around forever.
    """
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {
            "k": blob_key,
            "iat": now,
            "exp": now + timedelta(seconds=settings.artifact_url_ttl_seconds),
        },
        settings.artifact_signing_key,
        algorithm="HS256",
    )


def build_download_url(blob_key: str, *, private: bool) -> str:
    """URL for the raw bytes, whatever the renderer is.

    Distinct from :func:`build_artifact_url` on purpose: for a PDF, sheet or
    docx that returns the *viewer page*, so downloading from it would save the
    HTML wrapper instead of the file. This always points at /r/<key>.
    """
    url = f"{settings.artifact_origin.rstrip('/')}/r/{blob_key}"
    if private:
        url += f"?t={sign_access_token(blob_key)}"
    return url


def build_artifact_url(blob_key: str, mime: str, *, private: bool) -> str:
    """URL on the sandbox origin that renders this blob.

    ``/r/<key>`` serves raw bytes (an HTML artifact IS the page); ``/v/<r>/<key>``
    is a viewer page that fetches those bytes and renders them.
    """
    origin = settings.artifact_origin.rstrip("/")
    renderer = renderer_for(mime)
    path = f"/r/{blob_key}" if renderer in ("html", "image", "bundle") else f"/v/{renderer}/{blob_key}"
    url = f"{origin}{path}"
    if private:
        url += f"?t={sign_access_token(blob_key)}"
    return url


# ── Quota ──────────────────────────────────────────────────────────────────────


async def user_usage_bytes(db: AsyncIOMotorDatabase, user_id: str) -> int:
    """Total artifact bytes this account is currently storing."""
    cursor = db["documents"].aggregate(
        [
            {"$match": {"owner_id": user_id, "kind": "artifact"}},
            {"$group": {"_id": None, "total": {"$sum": "$size_bytes"}}},
        ]
    )
    rows = await cursor.to_list(length=1)
    return int(rows[0]["total"]) if rows else 0


async def check_quota(db: AsyncIOMotorDatabase, user_id: str, incoming: int) -> tuple[bool, int]:
    """(allowed, used_bytes) for an incoming upload of ``incoming`` bytes."""
    used = await user_usage_bytes(db, user_id)
    return (used + incoming <= settings.artifact_user_quota_bytes), used


# ── Creation ───────────────────────────────────────────────────────────────────

# A pasted HTML page goes through the server rather than a presigned round trip.
# Kept below nginx's client_max_body_size (12m) so an oversized paste is refused
# by the app with an explanation, rather than by nginx with a bare 413.
MAX_PASTE_BYTES = 10 * 1024 * 1024


async def create_artifact(
    db: AsyncIOMotorDatabase,
    *,
    user_id: str,
    blob_key: str,
    mime: str,
    bundle_prefix: str | None = None,
    size_bytes: int,
    title: str | None,
    filename: str | None,
    custom_slug: str | None = None,
    expires_in: str = "never",
    custom_expires_at: datetime | None = None,
    read_password: str | None = None,
):
    """Mint the shareable document record for an already-uploaded blob.

    Delegates to ``document.create_document`` so artifacts inherit the whole
    slug ladder (custom → filename-derived → random, with collision retries)
    plus edit-secret generation, expiry and password hashing.
    """
    from app.schemas.document import DocumentCreate
    from app.services import document as doc_service

    payload = DocumentCreate(
        title=title,
        # `content` is required and min_length=1 on the markdown schema; for an
        # artifact the bytes live in R2, so store the filename as a human-
        # readable stand-in that also keeps admin text search useful.
        content=filename or title or "artifact",
        custom_slug=custom_slug,
        expires_in=expires_in,
        custom_expires_at=custom_expires_at,
        read_password=read_password,
    )
    return await doc_service.create_document(
        db,
        payload,
        owner_id=user_id,
        preferred_slug=None if custom_slug else (title or filename),
        extra={
            "kind": "artifact",
            "mime": mime,
            "blob_key": blob_key,
            "size_bytes": size_bytes,
            "original_filename": filename,
            "bundle_prefix": bundle_prefix,
        },
    )


def to_response(doc, *, is_owner: bool) -> dict:
    """Shape an artifact Document for the API, including its sandbox URL."""
    private = bool(doc.read_password_hash)
    return dict(
        slug=doc.slug,
        url=f"{settings.frontend_url.rstrip('/')}/{doc.slug}",
        title=doc.title,
        kind="artifact",
        mime=doc.mime or "application/octet-stream",
        renderer=renderer_for(doc.mime or ""),
        type_label=label_for(doc.mime or ""),
        size_bytes=doc.size_bytes or 0,
        original_filename=doc.original_filename,
        artifact_url=build_artifact_url(doc.blob_key or "", doc.mime or "", private=private),
        download_url=build_download_url(doc.blob_key or "", private=private),
        created_at=doc.created_at,
        updated_at=doc.updated_at,
        expires_at=doc.expires_at,
        views=doc.views,
        is_password_protected=private,
        is_owner=is_owner,
    )


async def update_settings(
    db: AsyncIOMotorDatabase,
    slug: str,
    user_id: str,
    *,
    title: str | None,
    read_password: str | None,
    remove_password: bool,
    expires_in: str | None,
    custom_expires_at: datetime | None,
):
    """Owner-scoped edit of an artifact's metadata. Returns the Document or None.

    Only touches what was supplied — the blob, mime and size are never altered
    here (see ``replace_file`` for that).
    """
    import bcrypt

    from app.services.document import _doc_from_mongo, _EXPIRY_DELTA

    raw = await db["documents"].find_one({"slug": slug})
    if not raw or raw.get("owner_id") != user_id or raw.get("kind") != "artifact":
        return None

    now = datetime.now(timezone.utc)
    updates: dict = {"updated_at": now}
    if title is not None:
        updates["title"] = title.strip() or None
    if remove_password or read_password == "":
        updates["read_password_hash"] = None
    elif read_password:
        updates["read_password_hash"] = bcrypt.hashpw(
            read_password.encode(), bcrypt.gensalt()
        ).decode()
    if expires_in is not None:
        if expires_in == "custom" and custom_expires_at:
            updates["expires_at"] = custom_expires_at
        else:
            delta = _EXPIRY_DELTA.get(expires_in)
            updates["expires_at"] = (now + delta) if delta else None

    updated = await db["documents"].find_one_and_update(
        {"_id": raw["_id"]}, {"$set": updates}, return_document=True
    )
    return _doc_from_mongo(updated) if updated else None


async def replace_file(
    db: AsyncIOMotorDatabase,
    slug: str,
    user_id: str,
    *,
    blob_key: str,
    bundle_prefix: str | None,
    mime: str,
    size_bytes: int,
    filename: str | None,
):
    """Point an artifact at new bytes, keeping its slug, password and expiry.

    Returns ``(document, old_storage_key)``; the caller frees the old object so
    a replaced file doesn't linger. ``rev`` is bumped so any live viewer
    refreshes, matching how a markdown edit behaves.
    """
    from app.services.document import _doc_from_mongo

    raw = await db["documents"].find_one({"slug": slug})
    if not raw or raw.get("owner_id") != user_id or raw.get("kind") != "artifact":
        return None, None

    old_key = raw.get("bundle_prefix") or raw.get("blob_key")
    updated = await db["documents"].find_one_and_update(
        {"_id": raw["_id"]},
        {
            "$set": {
                "blob_key": blob_key,
                "bundle_prefix": bundle_prefix,
                "mime": mime,
                "size_bytes": size_bytes,
                "original_filename": filename,
                "updated_at": datetime.now(timezone.utc),
            },
            "$inc": {"rev": 1},
        },
        return_document=True,
    )
    if not updated:
        return None, None
    # Only free the old bytes if the new upload actually points somewhere else.
    return _doc_from_mongo(updated), (old_key if old_key != blob_key else None)


# ── Two-way sync (VS Code extension) ───────────────────────────────────────────

# Only artifacts whose bytes ARE their source can round-trip through an editor.
# A PDF or spreadsheet has no meaningful text form, so syncing one would mean
# handing the editor bytes it can't represent and writing back something corrupt.
SYNCABLE_MIMES = frozenset({
    "text/html",
    "text/plain",
    "text/csv",
    "application/json",
    "image/svg+xml",
})

# Sync payloads travel as JSON through the API, unlike uploads which go straight
# to R2, so they're capped below nginx's body limit rather than at the 25 MB
# artifact limit.
MAX_SYNC_BYTES = 10 * 1024 * 1024


def is_syncable(mime: str | None) -> bool:
    return (mime or "") in SYNCABLE_MIMES


def mime_for_filename(filename: str | None) -> str | None:
    """Artifact mime implied by a filename, for editor-initiated publishes."""
    return normalize_mime(None, filename)


async def read_content(doc) -> str | None:
    """Fetch an artifact's bytes back as text, for an editor pull."""
    from fastapi.concurrency import run_in_threadpool

    from app.services import r2

    if not doc.blob_key or not is_syncable(doc.mime):
        return None
    raw = await run_in_threadpool(r2.get_bytes, doc.blob_key, MAX_SYNC_BYTES)
    if raw is None:
        return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return None


async def sync_push_content(
    db: AsyncIOMotorDatabase, doc_id: str, user_id: str, content: str, base_rev: int
):
    """Write editor content back to an artifact, with the same optimistic lock
    the markdown path uses.

    Returns ``("ok"|"conflict"|"notfound"|"unsupported", document | None)``.

    The blob keeps its key and is overwritten in place. Rotating the key made
    every already-rendered page point at an object that had just been deleted —
    the document route is ISR-cached, so a page served from cache kept the old
    URL for up to a minute after a save. A stable key with a revalidating cache
    header keeps those pages working and still shows the new bytes.

    The compare-and-swap therefore happens BEFORE the write: winning the rev is
    what earns the right to overwrite. Doing it the other way round would let a
    push that then loses the race clobber the winner's bytes.
    """
    from bson import ObjectId
    from fastapi.concurrency import run_in_threadpool

    from app.services import r2
    from app.services.document import _doc_from_mongo

    if not ObjectId.is_valid(doc_id):
        return ("notfound", None)
    raw = await db["documents"].find_one({"_id": ObjectId(doc_id)})
    if not raw or raw.get("owner_id") != user_id or raw.get("kind") != "artifact":
        return ("notfound", None)
    if not is_syncable(raw.get("mime")) or raw.get("bundle_prefix"):
        return ("unsupported", None)

    cur_rev = raw.get("rev", 1)
    if base_rev != cur_rev:
        return ("conflict", _doc_from_mongo(raw))

    payload = content.encode("utf-8")
    if len(payload) > MAX_SYNC_BYTES:
        return ("unsupported", None)

    mime = raw["mime"]
    is_public = not raw.get("read_password_hash")
    key = raw.get("blob_key")
    if not key:
        return ("notfound", None)

    # Claim the revision first — only the winner may touch the bytes.
    updated = await db["documents"].find_one_and_update(
        {"_id": ObjectId(doc_id), "rev": cur_rev},
        {
            "$set": {
                "size_bytes": len(payload),
                "updated_at": datetime.now(timezone.utc),
                "vscode_synced": True,
            },
            "$inc": {"rev": 1},
        },
        return_document=True,
    )
    if not updated:
        fresh = await db["documents"].find_one({"_id": ObjectId(doc_id)})
        return ("conflict", _doc_from_mongo(fresh))

    if not await run_in_threadpool(r2.put_bytes, key, payload, mime, is_public, True):
        return ("notfound", None)
    return ("ok", _doc_from_mongo(updated))
