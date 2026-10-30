"""Images and files uploaded to a docs site, stored in the docs R2 bucket.

Objects are content-addressed: ``sites/<site_id>/assets/<sha256>.<ext>``. A page
refers to one as ``/docs-assets/<sha256>.<ext>``; the build copies the site's
assets into the content folder's ``public/docs-assets``, so the edge serves
them from the site's own address.

The type is decided from the bytes, never from what the client claims, and
only types a docs page can show are taken. SVG is accepted only without
script, event handlers or embedded documents: it is served from the site's own
origin, where script would run.

This is a separate Cloudflare account from the artifacts one (services/r2.py),
with its own credentials (settings.docs_r2_*). boto3 is synchronous: callers
run the network functions through ``run_in_threadpool``.
"""

from __future__ import annotations

import hashlib
import re
from functools import lru_cache

from app.config import get_settings

settings = get_settings()

# ext -> content type
TYPES = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "avif": "image/avif",
    "ico": "image/x-icon",
    "svg": "image/svg+xml",
    "mp4": "video/mp4",
    "webm": "video/webm",
    "pdf": "application/pdf",
    "zip": "application/zip",
    "txt": "text/plain; charset=utf-8",
    "csv": "text/csv; charset=utf-8",
    "json": "application/json",
    "md": "text/markdown; charset=utf-8",
}
_TEXT_EXTS = ("txt", "csv", "json", "md")
_SVG_BAD = re.compile(
    rb"<\s*script|<\s*foreignobject|<\s*iframe|<\s*embed|<\s*object|\son[a-z]+\s*=|javascript:|data:text/html"
    rb"|<!entity",
    re.I,
)


class AssetRejected(ValueError):
    pass


def sniff(data: bytes, filename: str | None) -> str:
    """The extension for these bytes, or :class:`AssetRejected`."""
    head = data[:64]
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand in (b"avif", b"avis"):
            return "avif"
        return "mp4"
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "webm"
    if head.startswith(b"%PDF-"):
        return "pdf"
    if head.startswith(b"\x00\x00\x01\x00"):
        return "ico"
    if head.startswith(b"PK\x03\x04"):
        return "zip"
    ext = (filename or "").rsplit(".", 1)[-1].lower() if "." in (filename or "") else ""
    stripped = data.lstrip(b"\xef\xbb\xbf \t\r\n")
    if ext == "svg" or stripped[:5].lower() in (b"<svg ", b"<svg>") or stripped[:5] == b"<?xml":
        if b"<svg" not in data[:4096].lower():
            raise AssetRejected("That file type isn't supported.")
        if _SVG_BAD.search(data):
            raise AssetRejected("SVG files can't contain scripts, event handlers or embedded pages.")
        return "svg"
    if ext in _TEXT_EXTS:
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            raise AssetRejected("Text files must be UTF-8.") from None
        return ext
    raise AssetRejected(
        "That file type isn't supported. Upload an image (PNG, JPEG, GIF, WebP, AVIF, SVG), a video "
        "(MP4, WebM), a PDF, or a ZIP, CSV, JSON, Markdown or text file.")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def key_for(site_id: str, name: str) -> str:
    return f"sites/{site_id}/assets/{name}"


def url_for(name: str) -> str:
    return f"/docs-assets/{name}"


IMMUTABLE = "public, max-age=31536000, immutable"
SHORT = "public, max-age=3600"

# An address under /docs-assets/: an upload (<sha256>.<ext>) or an imported file (import/<page>/<name>).
_REL = re.compile(r"^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,199})(?:/[A-Za-z0-9_][A-Za-z0-9._-]{0,199}){0,7}$")


def rel_of(url: str) -> str | None:
    """``/docs-assets/<rel>`` → ``<rel>`` when it is a safe relative path (no ``..``, no hidden
    segments, no query), else None."""
    if not isinstance(url, str) or not url.startswith("/docs-assets/"):
        return None
    rel = url[len("/docs-assets/"):]
    if not _REL.match(rel) or any(seg in (".", "..") or seg.startswith(".") for seg in rel.split("/")):
        return None
    return rel


def dark_name(rel: str) -> str | None:
    """``x.png`` → ``x.dark.png`` (the docs engine's dark-theme variant of an image, and what the
    editor's darkVariantPath gives). None for a name without an extension or already dark."""
    m = re.match(r"^(.*?)(\.[a-z0-9]{2,5})$", rel, re.I)
    if not m or m.group(1).endswith(".dark"):
        return None
    return f"{m.group(1)}.dark{m.group(2).lower()}"


_RASTER = {"png": "PNG", "jpg": "JPEG", "webp": "WEBP", "gif": "GIF"}


def convert_image(data: bytes, ext: str) -> bytes | None:
    """The image re-encoded as ``ext`` (png/jpg/webp/gif), or None when it can't be."""
    fmt = _RASTER.get(ext)
    if fmt is None:
        return None
    try:
        import io

        from PIL import Image

        with Image.open(io.BytesIO(data)) as im:
            im.load()
            if fmt == "JPEG" and im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            out = io.BytesIO()
            im.save(out, format=fmt, **({"quality": 90} if fmt in ("JPEG", "WEBP") else {}))
            return out.getvalue()
    except Exception:
        return None


def is_configured() -> bool:
    return settings.docs_r2_configured


@lru_cache(maxsize=1)
def _client():
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=f"https://{settings.docs_r2_account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=settings.docs_r2_access_key_id,
        aws_secret_access_key=settings.docs_r2_secret_access_key,
        region_name="auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
    )


# ── Network calls — wrap these in run_in_threadpool ────────────────────────────


def put_bytes(key: str, data: bytes, content_type: str, cache_control: str = IMMUTABLE) -> bool:
    try:
        _client().put_object(
            Bucket=settings.docs_r2_bucket, Key=key, Body=data, ContentType=content_type,
            # Content-addressed names never change their bytes; a dark version (replaceable) is SHORT.
            CacheControl=cache_control,
        )
        return True
    except Exception:
        return False


def presign_get(key: str, expires_in: int = 3600) -> str:
    """A short-lived read link (local HMAC, no network), for the editor's preview."""
    return _client().generate_presigned_url(
        "get_object", Params={"Bucket": settings.docs_r2_bucket, "Key": key}, ExpiresIn=expires_in)
