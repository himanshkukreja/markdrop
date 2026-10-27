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
from datetime import datetime, timezone

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
#   "video" → custom player on the sandbox origin; needs range requests to seek
#   "audio" → <audio controls> page on the sandbox origin (same range support)
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
    # Video. quicktime covers .mov, which is what phones and screen recorders
    # produce; whether a given .mov actually plays depends on its codec, not its
    # container, so the player has to cope with a file the browser refuses.
    ArtifactType("video/mp4", "video", "Video", "mp4"),
    ArtifactType("video/quicktime", "video", "Video", "mov"),
    ArtifactType("video/webm", "video", "Video", "webm"),
    ArtifactType("video/ogg", "video", "Video", "ogv"),
    # Audio. Browsers disagree on the MIME type of an .m4a (audio/x-m4a) or a
    # .wav (audio/x-wav, audio/wave); normalize_mime falls back to the
    # extension, so those still land on the canonical type here.
    ArtifactType("audio/mpeg", "audio", "Audio", "mp3"),
    ArtifactType("audio/mp4", "audio", "Audio", "m4a"),
    ArtifactType("audio/wav", "audio", "Audio", "wav"),
    ArtifactType("audio/ogg", "audio", "Audio", "ogg"),
)

# Renderers whose files are routinely far larger than a document. A 25 MB cap is
# right for a PDF and useless for a screen recording, so the ceiling is chosen
# per renderer rather than one number for everything.
_LARGE_RENDERERS = frozenset({"video", "audio"})

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


def max_bytes_for(mime: str) -> int:
    """The size ceiling that applies to this type."""
    t = BY_MIME.get(mime)
    if t and t.renderer in _LARGE_RENDERERS:
        return settings.artifact_max_video_bytes
    return settings.artifact_max_bytes


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


def sign_access_token(blob_key: str, *, epoch: int = 0, ttl: int | None = None) -> str:
    """Short-lived HMAC token the Worker checks before serving a private blob.

    Public artifacts don't get one — their URL is an unguessable capability and
    stays fully edge-cacheable. Guarded ones do, so that a viewer who unlocked
    the document can't just paste the raw blob URL around forever. The token
    carries the document's access epoch (``e``): the Worker refuses it once the
    object's ``ae`` metadata has moved on (services/publicity.py).
    """
    from app.services import publicity

    return publicity.sign(blob_key, epoch=epoch, ttl=ttl)


def build_download_url(blob_key: str, *, private: bool, epoch: int = 0,
                       ttl: int | None = None) -> str:
    """URL for the raw bytes, whatever the renderer is.

    Distinct from :func:`build_artifact_url` on purpose: for a PDF, sheet or
    docx that returns the *viewer page*, so downloading from it would save the
    HTML wrapper instead of the file. This always points at /r/<key>.
    """
    url = f"{settings.artifact_origin.rstrip('/')}/r/{blob_key}"
    if private:
        url += f"?t={sign_access_token(blob_key, epoch=epoch, ttl=ttl)}"
    return url


def build_artifact_url(blob_key: str, mime: str, *, private: bool, epoch: int = 0,
                       ttl: int | None = None) -> str:
    """URL on the sandbox origin that renders this blob.

    ``/r/<key>`` serves raw bytes (an HTML artifact IS the page); ``/v/<r>/<key>``
    is a viewer page that fetches those bytes and renders them.
    """
    origin = settings.artifact_origin.rstrip("/")
    renderer = renderer_for(mime)
    path = f"/r/{blob_key}" if renderer in ("html", "image", "bundle") else f"/v/{renderer}/{blob_key}"
    url = f"{origin}{path}"
    if private:
        url += f"?t={sign_access_token(blob_key, epoch=epoch, ttl=ttl)}"
    return url


# ── Quota ──────────────────────────────────────────────────────────────────────


async def user_usage_bytes(db: AsyncIOMotorDatabase, user_id: str) -> int:
    """Total artifact bytes this account is storing, old file versions included
    (see services/file_versions.usage_bytes)."""
    from app.services import file_versions

    return await file_versions.usage_bytes(db, user_id)


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
    preferred_slug: str | None = None,
    expires_in: str = "never",
    custom_expires_at: datetime | None = None,
    read_password: str | None = None,
    access_level: str = "link",
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
        access_level=access_level,  # type: ignore[arg-type]
    )
    return await doc_service.create_document(
        db,
        payload,
        owner_id=user_id,
        # Filename first when the caller names one — an editor publish should
        # land on a slug matching the file, the way markdown sync already does.
        preferred_slug=None if custom_slug else (preferred_slug or title or filename),
        extra={
            "kind": "artifact",
            "mime": mime,
            "blob_key": blob_key,
            "size_bytes": size_bytes,
            "original_filename": filename,
            "bundle_prefix": bundle_prefix,
        },
    )


def is_guarded(*, has_password: bool, access_level: str | None,
               require_auth: bool = False) -> bool:
    """Whether this artifact's bytes must require a signed token.

    Kept for callers that only know the two document-level facts; the full rule
    (which also closes everything in a sign-in-required workspace and anything
    expired) is ``publicity.is_public``, and every byte path goes through that.
    """
    return has_password or (access_level or "link") != "link" or require_auth


def poster_url(doc, *, private: bool) -> str | None:
    """Raw URL of a video's poster frame (signed when guarded)."""
    key = getattr(doc, "poster_key", None)
    if not key:
        return None
    from app.services import publicity

    return build_download_url(key, private=private, epoch=publicity.epoch_of(doc),
                              ttl=publicity.ttl_for(getattr(doc, "mime", None)))


def to_response(doc, *, is_owner: bool, public: bool | None = None,
                workspace_url: str | None = None) -> dict:
    """Shape an artifact Document for the API, including its sandbox URL.

    ``public`` is ``publicity.is_public`` for the document (callers that know
    the workspace pass it); without it the document-level facts decide."""
    from app.services import publicity

    if public is None:
        public = not is_guarded(
            has_password=bool(doc.read_password_hash),
            access_level=getattr(doc, "access_level", "link"),
        )
    epoch, ttl = publicity.epoch_of(doc), publicity.ttl_for(doc.mime)
    return dict(
        poster_url=poster_url(doc, private=not public),
        media=getattr(doc, "media", None),
        slug=doc.slug,
        url=f"{settings.frontend_url.rstrip('/')}/{doc.slug}",
        workspace_url=workspace_url,
        title=doc.title,
        kind="artifact",
        mime=doc.mime or "application/octet-stream",
        renderer=renderer_for(doc.mime or ""),
        type_label=label_for(doc.mime or ""),
        size_bytes=doc.size_bytes or 0,
        original_filename=doc.original_filename,
        artifact_url=build_artifact_url(doc.blob_key or "", doc.mime or "", private=not public,
                                        epoch=epoch, ttl=ttl),
        download_url=build_download_url(doc.blob_key or "", private=not public, epoch=epoch, ttl=ttl),
        created_at=doc.created_at,
        updated_at=doc.updated_at,
        expires_at=doc.expires_at,
        views=doc.views,
        is_password_protected=not public,
        is_owner=is_owner,
    )


async def update_settings(
    db: AsyncIOMotorDatabase,
    slug: str,
    actor,
    ctx,
    *,
    title: str | None,
    read_password: str | None,
    remove_password: bool,
    expires_in: str | None,
    custom_expires_at: datetime | None,
) -> dict:
    """Edit an artifact's title (can(edit_content): owner, editors, members on
    non-private files) or its password / expiry (can(edit_settings): owner or
    edit secret). Only what was supplied changes; the blob never does here.
    Returns the row after."""
    import bcrypt
    from fastapi import HTTPException

    from app.services import access, transitions
    from app.services.document import _EXPIRY_DELTA, _check_expiry

    raw = await db["documents"].find_one({"slug": slug})
    await access.require(actor, raw, "edit_content", ctx)
    if raw.get("kind") != "artifact":
        raise HTTPException(status_code=404, detail="Artifact not found")
    settings_change = (read_password is not None or remove_password or expires_in is not None
                       or custom_expires_at is not None)
    if settings_change:
        await access.require(actor, raw, "edit_settings", ctx)

    now = datetime.now(timezone.utc)
    sets: dict = {"updated_at": now}
    narrows = False
    if title is not None:
        sets["title"] = title.strip() or None
    if remove_password or read_password == "":
        sets["read_password_hash"] = None
    elif read_password:
        sets["read_password_hash"] = bcrypt.hashpw(read_password.encode(), bcrypt.gensalt()).decode()
        narrows = True
    if expires_in is not None:
        _check_expiry(expires_in, custom_expires_at, now)
        if expires_in == "custom":
            sets["expires_at"] = custom_expires_at
        else:
            delta = _EXPIRY_DELTA.get(expires_in)
            sets["expires_at"] = (now + delta) if delta else None
    elif custom_expires_at is not None:
        _check_expiry("custom", custom_expires_at, now)
        sets["expires_at"] = custom_expires_at

    after = await transitions.change(db, raw, sets=sets, inc={"rev": 1}, narrows=narrows or None,
                                     cas={"slug": slug})
    ctx.forget(raw)
    return after


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

    Only for swaps involving a zipped site (bundle), which keep no versions.
    Single files go through ``file_versions.swap``, which keeps the old bytes.
    """
    from app.services.document import _doc_from_mongo

    raw = await db["documents"].find_one({"slug": slug})
    if not raw or raw.get("owner_id") != user_id or raw.get("kind") != "artifact":
        return None, None

    old_key = raw.get("bundle_prefix") or raw.get("blob_key")
    now = datetime.now(timezone.utc)
    updated = await db["documents"].find_one_and_update(
        {"_id": raw["_id"]},
        {
            "$set": {
                "blob_key": blob_key,
                "bundle_prefix": bundle_prefix,
                "mime": mime,
                "size_bytes": size_bytes,
                "original_filename": filename,
                "updated_at": now,
                "file_updated_at": now,
                # A bundle has no versions (services/file_versions.py), and
                # nothing about the old file describes the new one.
                "sha256": None,
                "media": None,
                "poster_key": None,
            },
            "$inc": {"rev": 1, "file_version": 1},
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

# A file synced from the editor gets the same ceiling as one uploaded on the
# site (25 MB by default). It travels as JSON through the API rather than
# straight to R2, so nginx's client_max_body_size on the API host must stay
# above this plus JSON escaping (32m in the server's nginx site for api.markdrop.in,
# /etc/nginx/sites-enabled). A self-contained HTML page
# with inlined images or fonts is routinely 10–25 MB.
MAX_SYNC_BYTES = settings.artifact_max_bytes


def sync_size_error(size_bytes: int) -> str:
    """The editor shows this verbatim when a file is over the sync limit."""
    mb = lambda n: f"{n / (1024 * 1024):.1f}".rstrip("0").rstrip(".")
    return (
        f"This file is {mb(size_bytes)} MB; files synced from your editor can be up to "
        f"{mb(MAX_SYNC_BYTES)} MB. Move large images or fonts out of the page, or upload it at "
        "markdrop.in/upload."
    )


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
    db: AsyncIOMotorDatabase, doc_id: str, user_id: str, content: str, base_rev: int,
    *, authorized: bool = False,
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
    # `authorized`: the caller already holds a can(edit_content) decision (an
    # editor or member writing through MCP). Otherwise sync is owner-only.
    if not raw or raw.get("kind") != "artifact" or (
            not authorized and raw.get("owner_id") != user_id):
        return ("notfound", None)
    if not is_syncable(raw.get("mime")) or raw.get("bundle_prefix"):
        return ("unsupported", None)

    cur_rev = raw.get("rev", 1)
    if base_rev != cur_rev:
        return ("conflict", _doc_from_mongo(raw))

    payload = content.encode("utf-8")
    if len(payload) > MAX_SYNC_BYTES:
        return ("too_large", None)

    from app.services import publicity

    mime = raw["mime"]
    is_public = await publicity.doc_is_public(db, raw)
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
