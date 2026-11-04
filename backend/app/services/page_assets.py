"""Images pasted into a page: ``![alt](asset:<id>)``.

The bytes live in R2 at ``pa/<doc_id>/<token>.<ext>`` and a row in
``page_assets`` (``{_id, doc_id, key, mime, size, width, height, created_by,
owner_id, created_at}``) says which page they belong to. They follow the page:
anyone who can read the page sees them, nobody else.

* A page whose bytes may be public (``publicity.is_public`` of its effective
  access) gets the artifact Worker's bare ``/r/<key>``, and its objects carry
  ``customMetadata.public = "1"``.
* Otherwise every reader gets a link signed for them (``?t=``, the page's access
  epoch, the same lifetime as an artifact link), minted only after
  ``can(read)`` on the page. ``GET /documents/{slug}/assets/urls`` renews them.
* ``transitions.change`` keeps the objects in step with the page: a narrowing
  closes them under the new epoch *before* the narrower row is written (I4); a
  widening opens them after. Sub-pages follow their parent through the same
  function (services/pages.py).

Quota counts against the page's owner, like artifacts.

Bytes arrive three ways: :func:`upload` (one request: the app, or base64 over
MCP, up to ``MAX_BYTES``), :func:`adopt` (a file the client sent straight to
storage, services/page_asset_uploads.py, up to ``FILE_MAX_BYTES``) and
:func:`copy` (another page's image, as a new image of this page).
"""

from __future__ import annotations

import io
import logging
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.services import publicity, r2

log = logging.getLogger(__name__)

COLL = "page_assets"
MAX_BYTES = 10 * 1024 * 1024          # one request (the app, base64 over MCP)
FILE_MAX_BYTES = 20 * 1024 * 1024     # straight to storage (services/page_asset_uploads.py)
MAX_PER_PAGE = 500
PREFIX = "pa/"
# Raster images only: an SVG is a document that can carry script.
_SIGNATURES = (
    (b"\x89PNG\r\n\x1a\n", "image/png", "png"),
    (b"\xff\xd8\xff", "image/jpeg", "jpg"),
    (b"GIF87a", "image/gif", "gif"),
    (b"GIF89a", "image/gif", "gif"),
)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index("doc_id")
    await db[COLL].create_index("owner_id")


def sniff(data: bytes) -> tuple[str, str] | None:
    """(mime, extension) from the bytes themselves, never from the name."""
    for sig, mime, ext in _SIGNATURES:
        if data.startswith(sig):
            return mime, ext
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", "webp"
    return None


def _dimensions(data: bytes) -> tuple[int | None, int | None]:
    try:
        from PIL import Image

        with Image.open(io.BytesIO(data)) as im:
            w, h = im.size
            return int(w), int(h)
    except Exception:
        return None, None


def key_for(doc_id: str, asset_id: str, ext: str) -> str:
    return f"{PREFIX}{doc_id}/{asset_id}.{ext}"


async def usage_bytes(db: AsyncIOMotorDatabase, user_id: str) -> int:
    rows = await db[COLL].aggregate([
        {"$match": {"owner_id": user_id}},
        {"$group": {"_id": None, "n": {"$sum": "$size"}}},
    ]).to_list(length=1)
    return int(rows[0]["n"]) if rows else 0


async def is_public(db: AsyncIOMotorDatabase, page: dict) -> bool:
    """Whether the page's images may be served without a token: the page's
    *effective* access (its inherited source's, for a sub-page)."""
    from app.services import access

    eff = await access.effective_doc(db, page)
    return await publicity.doc_is_public(db, eff)


def kind_of(data: bytes) -> tuple[str, str]:
    """(mime, extension) of an image a page may hold, or 415."""
    kind = sniff(data)
    if kind is None:
        raise HTTPException(status_code=415, detail="Pages take PNG, JPEG, GIF or WebP images.")
    return kind


async def check_room(db: AsyncIOMotorDatabase, page: dict, size: int, *, user_id: str | None,
                     max_bytes: int = MAX_BYTES) -> str:
    """Whether ``page`` can take an image of ``size`` bytes: a page, storage
    up, under the per-page count and the owner's quota. Returns the owner whose
    quota it counts against."""
    from app.services import artifact as art_service
    from app.services import pages

    if not pages.is_page_capable(page):
        raise HTTPException(status_code=422, detail="Images can be added to Markdown documents only.")
    if size <= 0:
        raise HTTPException(status_code=422, detail="That file is empty.")
    if size > max_bytes:
        raise HTTPException(status_code=413, detail=f"Images in a page can be up to {max_bytes // (1024 * 1024)} MB.")
    if not r2.is_configured():
        raise HTTPException(status_code=503, detail="Image storage isn't available right now.")
    if await db[COLL].count_documents({"doc_id": str(page["_id"])}) >= MAX_PER_PAGE:
        raise HTTPException(status_code=429, detail=f"A page can hold at most {MAX_PER_PAGE} images.")
    owner = page.get("owner_id") or user_id
    if not owner:
        raise HTTPException(status_code=401, detail="Sign in to add images to a page.")
    allowed, _used = await art_service.check_quota(db, owner, size)
    if not allowed:
        raise HTTPException(status_code=413, detail="The page owner's Markdrop storage is full.")
    return owner


async def upload(db: AsyncIOMotorDatabase, page: dict, data: bytes, *, user_id: str,
                 max_bytes: int = MAX_BYTES) -> dict:
    """Store an image for ``page`` (the caller has checked can(edit_content))."""
    from app.services import pages

    if not pages.is_page_capable(page):
        raise HTTPException(status_code=422, detail="Images can be added to Markdown documents only.")
    if not data:
        raise HTTPException(status_code=422, detail="That file is empty.")
    if len(data) > max_bytes:
        raise HTTPException(status_code=413, detail=f"Images in a page can be up to {max_bytes // (1024 * 1024)} MB.")
    mime, ext = kind_of(data)
    owner = await check_room(db, page, len(data), user_id=user_id, max_bytes=max_bytes)
    width, height = await run_in_threadpool(_dimensions, data)
    doc_id = str(page["_id"])
    asset_id = secrets.token_hex(12)
    key = key_for(doc_id, asset_id, ext)
    public = await is_public(db, page)
    if not await run_in_threadpool(r2.put_bytes, key, data, mime, public):
        raise HTTPException(status_code=502, detail="The image couldn't be stored. Try again.")
    if not public and publicity.epoch_of(page):
        # Bind it to the page's current access epoch from the start.
        await run_in_threadpool(r2.set_public, key, False, mime, publicity.epoch_of(page))
    return await _register(db, page, asset_id=asset_id, key=key, mime=mime, size=len(data), width=width,
                           height=height, user_id=user_id, owner=owner, public=public)


async def adopt(db: AsyncIOMotorDatabase, page: dict, *, asset_id: str, key: str, data: bytes,
                user_id: str) -> dict:
    """Make the object already stored at ``key`` (private, uploaded straight to
    storage: services/page_asset_uploads.py) an image of ``page``. ``data`` is
    its bytes, already checked against the declared size and sha256. The
    caller deletes the object if this raises."""
    mime, _ext = kind_of(data)
    owner = await check_room(db, page, len(data), user_id=user_id, max_bytes=FILE_MAX_BYTES)
    width, height = await run_in_threadpool(_dimensions, data)
    public = await is_public(db, page)
    # The object went up private with the type the client declared: give it the
    # type its bytes have, the page's publicity and the page's access epoch.
    if not await run_in_threadpool(r2.set_public, key, public, mime, publicity.epoch_of(page) or None):
        raise HTTPException(status_code=502, detail="The image couldn't be stored. Try again.")
    return await _register(db, page, asset_id=asset_id, key=key, mime=mime, size=len(data), width=width,
                           height=height, user_id=user_id, owner=owner, public=public)


async def copy(db: AsyncIOMotorDatabase, source: dict, asset_id: str, target: dict, *, user_id: str) -> dict:
    """Copy an image of ``source`` to ``target`` as a new image of its own (the
    caller has checked can(read) on the source and can(edit_content) on the
    target). 404 when ``asset_id`` isn't one of the source's images."""
    row = await db[COLL].find_one({"_id": asset_id, "doc_id": str(source["_id"])})
    if row is None:
        raise HTTPException(status_code=404, detail=f"asset:{asset_id} isn't an image of {source['slug']}.")
    await check_room(db, target, int(row.get("size") or 0) or 1, user_id=user_id, max_bytes=FILE_MAX_BYTES)
    if not r2.is_configured():
        raise HTTPException(status_code=503, detail="Image storage isn't available right now.")
    data = await run_in_threadpool(r2.get_bytes, row["key"], FILE_MAX_BYTES + 1)
    if not data:
        raise HTTPException(status_code=502, detail="That image couldn't be read from storage. Try again.")
    return await upload(db, target, data, user_id=user_id, max_bytes=FILE_MAX_BYTES)


async def _register(db: AsyncIOMotorDatabase, page: dict, *, asset_id: str, key: str, mime: str, size: int,
                    width: int | None, height: int | None, user_id: str, owner: str, public: bool) -> dict:
    doc_id = str(page["_id"])
    row = {"_id": asset_id, "doc_id": doc_id, "key": key, "mime": mime, "size": size,
           "width": width, "height": height, "created_by": user_id, "owner_id": owner,
           "created_at": now_utc()}
    await db[COLL].insert_one(row)
    # The page may have narrowed while the bytes went up: follow it now.
    fresh = await db["documents"].find_one({"_id": page["_id"]}, {"content": 0})
    if fresh is None:
        await forget_document(db, doc_id)
        raise HTTPException(status_code=404, detail="Document not found")
    if await is_public(db, fresh) != public or publicity.epoch_of(fresh) != publicity.epoch_of(page):
        await run_in_threadpool(r2.set_public, key, await is_public(db, fresh), mime, publicity.epoch_of(fresh))
    return {"id": asset_id, "mime": mime, "size": size, "width": width, "height": height}


async def urls_for(db: AsyncIOMotorDatabase, page: dict, ids: list[str] | None = None) -> dict[str, dict]:
    """``{id: {url, expires_at, width?, height?}}`` for this page's images among
    ``ids`` (all of them when None), for a reader already past can(read) on the
    page. Ids that aren't this page's are left out. The size (pixels, when it was
    read at upload) lets the editor and the reader keep an image's room while it
    loads, so nothing below it jumps."""
    from app.services import artifact as art_service

    if ids is not None and not ids:
        return {}
    if not r2.is_configured():
        return {}
    q: dict = {"doc_id": str(page["_id"])}
    if ids is not None:
        q["_id"] = {"$in": list(ids)[:MAX_PER_PAGE]}
    rows = await db[COLL].find(q, {"key": 1, "mime": 1, "width": 1, "height": 1}).to_list(length=MAX_PER_PAGE)
    if not rows:
        return {}
    public = await is_public(db, page)
    epoch = publicity.epoch_of(page)
    ttl = int(get_settings().artifact_url_ttl_seconds)
    expires = None if public else (now_utc() + timedelta(seconds=ttl)).isoformat().replace("+00:00", "Z")
    out: dict[str, dict] = {}
    for r in rows:
        entry = {"url": art_service.build_download_url(r["key"], private=not public, epoch=epoch, ttl=ttl),
                 "expires_at": expires}
        w, h = r.get("width"), r.get("height")
        if isinstance(w, int) and isinstance(h, int) and w > 0 and h > 0:
            entry["width"], entry["height"] = w, h
        out[r["_id"]] = entry
    return out


async def _set(db: AsyncIOMotorDatabase, page: dict, public: bool, epoch: int) -> bool:
    if not r2.is_configured():
        return True
    rows = await db[COLL].find({"doc_id": str(page["_id"])}, {"key": 1, "mime": 1}).to_list(length=MAX_PER_PAGE)
    ok = True
    for r in rows:
        try:
            ok = bool(await run_in_threadpool(r2.set_public, r["key"], public, r.get("mime"), epoch)) and ok
        except Exception:
            log.warning("page image publicity change failed for %s", r["key"], exc_info=True)
            ok = False
    return ok


async def close(db: AsyncIOMotorDatabase, page: dict, epoch: int) -> None:
    """Make the page's images private under ``epoch``, or 502 (nothing else has
    been changed yet: the caller closes before it writes the narrower row)."""
    if not await _set(db, page, False, epoch):
        raise HTTPException(status_code=502, detail="Couldn't secure the page's images. Nothing was changed "
                                                    "— try again.")


async def apply(db: AsyncIOMotorDatabase, page: dict, public: bool) -> bool:
    """Set the page's images to ``public`` under its current epoch."""
    return await _set(db, page, public, publicity.epoch_of(page))


async def sync(db: AsyncIOMotorDatabase, page: dict) -> bool:
    """Re-derive the images' publicity from the page as it stands (reconciler,
    workspace-wide changes)."""
    if not await db[COLL].find_one({"doc_id": str(page["_id"])}, {"_id": 1}):
        return True
    return await apply(db, page, await is_public(db, page))


async def forget_document(db: AsyncIOMotorDatabase, doc_id: str) -> None:
    """The page is gone: its images go too (rows first, then the bytes)."""
    rows = await db[COLL].find({"doc_id": doc_id}, {"key": 1}).to_list(length=MAX_PER_PAGE * 2)
    await db[COLL].delete_many({"doc_id": doc_id})
    if not rows or not r2.is_configured():
        return
    try:
        await run_in_threadpool(r2.delete_prefix, f"{PREFIX}{doc_id}/")
    except Exception:
        log.warning("deleting the images of %s failed", doc_id, exc_info=True)
