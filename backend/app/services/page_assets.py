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
MAX_BYTES = 10 * 1024 * 1024
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


async def upload(db: AsyncIOMotorDatabase, page: dict, data: bytes, *, user_id: str) -> dict:
    """Store an image for ``page`` (the caller has checked can(edit_content))."""
    from app.services import artifact as art_service
    from app.services import pages

    if not pages.is_page_capable(page):
        raise HTTPException(status_code=422, detail="Images can be added to Markdown documents only.")
    if not data:
        raise HTTPException(status_code=422, detail="That file is empty.")
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="Images in a page can be up to 10 MB.")
    kind = sniff(data)
    if kind is None:
        raise HTTPException(status_code=415, detail="Pages take PNG, JPEG, GIF or WebP images.")
    if not r2.is_configured():
        raise HTTPException(status_code=503, detail="Image storage isn't available right now.")
    doc_id = str(page["_id"])
    if await db[COLL].count_documents({"doc_id": doc_id}) >= MAX_PER_PAGE:
        raise HTTPException(status_code=429, detail=f"A page can hold at most {MAX_PER_PAGE} images.")
    owner = page.get("owner_id") or user_id
    if not owner:
        raise HTTPException(status_code=401, detail="Sign in to add images to a page.")
    allowed, _used = await art_service.check_quota(db, owner, len(data))
    if not allowed:
        raise HTTPException(status_code=413, detail="The page owner's Markdrop storage is full.")
    mime, ext = kind
    width, height = await run_in_threadpool(_dimensions, data)
    asset_id = secrets.token_hex(12)
    key = key_for(doc_id, asset_id, ext)
    public = await is_public(db, page)
    if not await run_in_threadpool(r2.put_bytes, key, data, mime, public):
        raise HTTPException(status_code=502, detail="The image couldn't be stored. Try again.")
    if not public and publicity.epoch_of(page):
        # Bind it to the page's current access epoch from the start.
        await run_in_threadpool(r2.set_public, key, False, mime, publicity.epoch_of(page))
    row = {"_id": asset_id, "doc_id": doc_id, "key": key, "mime": mime, "size": len(data),
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
    return {"id": asset_id, "mime": mime, "size": len(data), "width": width, "height": height}


async def urls_for(db: AsyncIOMotorDatabase, page: dict, ids: list[str] | None = None) -> dict[str, dict]:
    """``{id: {url, expires_at}}`` for this page's images among ``ids`` (all of
    them when None), for a reader already past can(read) on the page. Ids that
    aren't this page's are left out."""
    from app.services import artifact as art_service

    if ids is not None and not ids:
        return {}
    if not r2.is_configured():
        return {}
    q: dict = {"doc_id": str(page["_id"])}
    if ids is not None:
        q["_id"] = {"$in": list(ids)[:MAX_PER_PAGE]}
    rows = await db[COLL].find(q, {"key": 1, "mime": 1}).to_list(length=MAX_PER_PAGE)
    if not rows:
        return {}
    public = await is_public(db, page)
    epoch = publicity.epoch_of(page)
    ttl = int(get_settings().artifact_url_ttl_seconds)
    expires = None if public else (now_utc() + timedelta(seconds=ttl)).isoformat().replace("+00:00", "Z")
    return {
        r["_id"]: {"url": art_service.build_download_url(r["key"], private=not public, epoch=epoch, ttl=ttl),
                   "expires_at": expires}
        for r in rows
    }


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
