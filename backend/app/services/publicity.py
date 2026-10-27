"""Whether a document's stored bytes may be served without a token — one rule.

The artifact Worker fails closed: it serves an object without a signed token
only when its R2 metadata says ``public == "1"``. Everything that writes an
object or changes who can read a document therefore has to agree on one
predicate, and it lives here (access policy §5.3):

    is_public(doc, ws) = level == link ∧ ¬password ∧ ¬ws.require_auth ∧ ¬expired

It applies to the current blob, every object of a zipped site's prefix, and the
current poster frame. Old file versions are never public.

Signed links carry the document's **access epoch** (``e``). Each narrowing bumps
``documents.access_epoch`` and writes it onto the objects as ``ae``; the Worker
refuses a token whose ``e`` differs, so narrowing revokes every signed link
already handed out (I3, I4).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings

settings = get_settings()
log = logging.getLogger(__name__)

_MEDIA_RENDERERS = frozenset({"video", "audio"})


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def aware(dt: datetime | None) -> datetime | None:
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _get(doc: Any, name: str, default=None):
    if isinstance(doc, dict):
        return doc.get(name, default)
    return getattr(doc, name, default)


def is_expired(doc: Any, now: datetime | None = None) -> bool:
    exp = aware(_get(doc, "expires_at"))
    return exp is not None and exp <= (now or now_utc())


def epoch_of(doc: Any) -> int:
    return int(_get(doc, "access_epoch") or 0)


def level_of(doc: Any) -> str:
    return _get(doc, "access_level") or "link"


def is_public(doc: Any, *, require_auth: bool, now: datetime | None = None) -> bool:
    """The one predicate (see module docstring)."""
    return (
        level_of(doc) == "link"
        and not _get(doc, "read_password_hash")
        and not require_auth
        and not is_expired(doc, now)
    )


async def workspace_requires_auth(db: AsyncIOMotorDatabase, workspace_id: str | None) -> bool:
    """A dangling or absent workspace requires nothing (it is treated as unfiled)."""
    if not workspace_id:
        return False
    from app.services import workspace as ws_service

    ws = await ws_service.get_workspace(db, workspace_id)
    return bool(ws is not None and ws.settings.require_auth_to_view)


async def doc_is_public(db: AsyncIOMotorDatabase, doc: Any) -> bool:
    return is_public(doc, require_auth=await workspace_requires_auth(db, _get(doc, "workspace_id")))


# ── Applying publicity to R2 ──────────────────────────────────────────────────


def _has_bytes(doc: Any) -> bool:
    return _get(doc, "kind") == "artifact" and bool(_get(doc, "blob_key") or _get(doc, "bundle_prefix"))


async def apply(doc: Any, public: bool, *, epoch: int | None = None) -> bool:
    """Set the current blob (or bundle prefix) and poster to ``public``.

    Returns True when every object took the change (or there is nothing to
    change). Never raises: callers decide whether a failure is a leak (closing)
    or a nuisance (opening)."""
    from app.services import r2

    if not _has_bytes(doc) or not r2.is_configured():
        return True
    ok = True
    try:
        if _get(doc, "bundle_prefix"):
            await run_in_threadpool(r2.set_public_prefix, _get(doc, "bundle_prefix"), public, epoch)
        elif _get(doc, "blob_key"):
            ok = bool(await run_in_threadpool(
                r2.set_public, _get(doc, "blob_key"), public, _get(doc, "mime"), epoch))
        if _get(doc, "poster_key"):
            ok = bool(await run_in_threadpool(
                r2.set_public, _get(doc, "poster_key"), public, "image/jpeg", epoch)) and ok
    except Exception:
        log.warning("R2 publicity change failed for %s", _get(doc, "slug"), exc_info=True)
        return False
    return ok


async def close(doc: Any, epoch: int) -> None:
    """Make the bytes private under ``epoch``, or raise 502 (nothing else has
    been changed yet: the caller closes before it writes the narrower state)."""
    if not await apply(doc, False, epoch=epoch):
        raise HTTPException(
            status_code=502,
            detail="Couldn't secure the stored file. Nothing was changed — try again.",
        )


# ── Signed links ──────────────────────────────────────────────────────────────


def ttl_for(mime: str | None) -> int:
    from app.services import artifact as art_service

    if art_service.renderer_for(mime or "") in _MEDIA_RENDERERS:
        return int(settings.artifact_media_url_ttl_seconds)
    return int(settings.artifact_url_ttl_seconds)


def sign(blob_key: str, *, epoch: int, ttl: int | None = None) -> str:
    now = now_utc()
    return jwt.encode(
        {"k": blob_key, "e": int(epoch), "iat": now,
         "exp": now + timedelta(seconds=ttl or settings.artifact_url_ttl_seconds)},
        settings.artifact_signing_key,
        algorithm="HS256",
    )


def byte_urls(doc: Any, *, public: bool) -> dict[str, str | None]:
    """artifact_url / download_url / poster_url for a reader already past every
    gate. Signed (``?t=``, carrying the epoch) unless the bytes are public."""
    from app.services import artifact as art_service
    from app.services import r2

    out: dict[str, str | None] = {"artifact_url": None, "download_url": None, "poster_url": None}
    if _get(doc, "kind") != "artifact" or not r2.is_configured():
        return out
    blob = _get(doc, "blob_key")
    mime = _get(doc, "mime") or ""
    epoch = epoch_of(doc)
    ttl = ttl_for(mime)
    if blob:
        out["artifact_url"] = art_service.build_artifact_url(
            blob, mime, private=not public, epoch=epoch, ttl=ttl)
        out["download_url"] = art_service.build_download_url(
            blob, private=not public, epoch=epoch, ttl=ttl)
    poster = _get(doc, "poster_key")
    if poster:
        out["poster_url"] = art_service.build_download_url(
            poster, private=not public, epoch=epoch, ttl=ttl)
    return out
