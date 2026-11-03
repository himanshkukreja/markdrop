"""A page image sent from a file straight to storage, never through a tool
argument: the MCP tools ``create_page_image_upload`` and
``complete_page_image_upload`` (app/mcp/page_tools.py).

    create   →  {upload_id, part_size, parts:[{part_number, url}], expires_at}
    (the client PUTs the file to each part URL, keeping each part's ETag)
    complete →  {id, mime, size, width, height}: the image is asset:<id> of the page

The same flow as a file upload (services/file_uploads.py), and the same
sessions: a row in ``file_uploads`` with ``purpose: "page_image"``, so the
per-account cap on open uploads, the per-account and background sweeps that
abort lapsed uploads, and the TTL that drops old rows all apply. Each kind is
finished only by its own call (``file_uploads.load`` refuses the other kind).

The bytes go to the image's final key, ``pa/<doc_id>/<asset_id>.<ext>``,
private (no ``public`` flag, so the artifact Worker serves them to nobody) and
with no ``page_assets`` row, so no link to them is ever minted. ``complete``
checks the real size and sha256 against the declared ones and sniffs the bytes
(PNG, JPEG, GIF or WebP only), re-checks that the caller may still add images
to the page, and only then registers the image through
``page_assets.adopt``, which gives the object its real type and the page's
publicity. Anything wrong deletes the object and changes nothing.

An image is at most ``page_assets.FILE_MAX_BYTES``, so it is hashed in
process and ``complete`` answers at once (no "verifying" state to poll).
"""

from __future__ import annotations

import hashlib
import math
import secrets
from datetime import timedelta
from typing import Awaitable, Callable

from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.services import file_uploads, page_assets, r2

settings = get_settings()

PURPOSE = file_uploads.PURPOSE_PAGE_IMAGE
MAX_BYTES = page_assets.FILE_MAX_BYTES
# A complete that died mid-way (a restart) leaves "verifying" behind: after this
# long the next complete takes the session over again.
STALE_AFTER = timedelta(minutes=2)
_MIME_BY_EXT = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
                "webp": "image/webp"}
_EXT_BY_MIME = {"image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/pjpeg": "jpg",
                "image/gif": "gif", "image/webp": "webp"}

Authorize = Callable[[dict], Awaitable[None]]


def declared_type(file_name: str, content_type: str | None) -> tuple[str, str]:
    """(mime, ext) the client says the image is, from content_type or else the
    name's extension; 415 for anything but PNG, JPEG, GIF or WebP. The bytes
    are sniffed again at complete (they decide; this only names the key)."""
    ct = (content_type or "").split(";", 1)[0].strip().lower()
    if ct:
        ext = _EXT_BY_MIME.get(ct)
        if ext is None:
            raise HTTPException(status_code=415, detail=(
                f"Pages take PNG, JPEG, GIF or WebP images; {ct} isn't one (an SVG can carry script, "
                "so it isn't accepted). Convert it to PNG first."))
        return _MIME_BY_EXT[ext], ext
    ext = file_name.rsplit(".", 1)[-1].lower() if "." in file_name else ""
    mime = _MIME_BY_EXT.get(ext)
    if mime is None:
        raise HTTPException(status_code=415, detail=(
            "Pages take PNG, JPEG, GIF or WebP images: give the file a .png, .jpg, .gif or .webp "
            "name, or pass content_type."))
    return mime, _EXT_BY_MIME[mime]


def _session_out(sess: dict) -> dict:
    out = file_uploads._session_out(sess)
    out["slug"] = sess.get("slug")
    return out


async def create(db: AsyncIOMotorDatabase, user, page: dict, *, file_name: str, size_bytes: int,
                 sha256: str, content_type: str | None = None, alt: str | None = None) -> dict:
    """Open an upload of an image for ``page`` (the caller has checked
    can(edit_content) and the page's lock). Everything that can be refused is
    refused here, before a byte moves."""
    sha = (sha256 or "").strip().lower()
    if len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
        raise HTTPException(status_code=422, detail="sha256 must be the file's hex sha256 (64 characters).")
    size = int(size_bytes)
    if size > MAX_BYTES:
        raise HTTPException(status_code=413, detail=(
            f"This image is {size / (1024 * 1024):.1f} MB; page images can be up to "
            f"{MAX_BYTES // (1024 * 1024)} MB. Make it smaller (a PNG screenshot often halves as a JPEG or WebP)."))
    mime, ext = declared_type(file_name, content_type)
    await page_assets.check_room(db, page, size, user_id=user.id, max_bytes=MAX_BYTES)

    await file_uploads.sweep_expired(db, user.id)
    now = file_uploads._now()
    doc_id = str(page["_id"])
    # The same upload asked for again (a retry, or URLs that lapsed): the open
    # session with fresh URLs instead of a second one.
    same = await db[file_uploads.SESSIONS].find_one({
        "user_id": user.id, "purpose": PURPOSE, "state": "uploading", "expires_at": {"$gt": now},
        "doc_id": doc_id, "sha256": sha, "size_bytes": size, "file_name": file_name, "mime": mime,
    })
    if same is not None:
        if alt is not None and alt != same.get("alt"):
            await db[file_uploads.SESSIONS].update_one({"_id": same["_id"]}, {"$set": {"alt": alt}})
        return _session_out(same)
    if await db[file_uploads.SESSIONS].count_documents(
        {"user_id": user.id, "state": "uploading", "expires_at": {"$gt": now}}
    ) >= file_uploads.MAX_OPEN_SESSIONS:
        raise HTTPException(status_code=429, detail=(
            "Too many uploads in progress. Finish or cancel some before starting another."))

    asset_id = secrets.token_hex(12)
    key = page_assets.key_for(doc_id, asset_id, ext)
    part_size = file_uploads.part_size_for(size)
    try:
        # Private: no ``public`` flag, and no page_assets row to mint a link from.
        r2_upload_id = await run_in_threadpool(r2.create_multipart, key, mime, False)
    except Exception:
        file_uploads.log.warning("create_multipart failed for a page image", exc_info=True)
        raise HTTPException(status_code=502, detail="Image storage didn't respond. Try again in a moment.")
    expires_at = now + timedelta(hours=int(settings.page_image_upload_hours))
    sess = {
        "_id": "up_" + secrets.token_urlsafe(18),
        "purpose": PURPOSE,
        "user_id": user.id,
        "state": "uploading",
        "key": key,
        "r2_upload_id": r2_upload_id,
        "file_name": file_name,
        "alt": alt,
        "mime": mime,
        "size_bytes": size,
        "sha256": sha,
        "part_size": part_size,
        "part_count": max(1, math.ceil(size / part_size)),
        "doc_id": doc_id,
        "slug": page["slug"],
        "asset_id": asset_id,
        "created_at": now,
        "expires_at": expires_at,
        "purge_at": expires_at + file_uploads.PURGE_AFTER,
    }
    await db[file_uploads.SESSIONS].insert_one(sess)
    return _session_out(sess)


async def fresh_session(db: AsyncIOMotorDatabase, user_id: str, upload_id: str) -> dict:
    """The session (for its page), refusing one that can't be finished."""
    sess = await file_uploads.load(db, user_id, upload_id, purpose=PURPOSE)
    if sess["state"] in ("expired", "cancelled"):
        raise HTTPException(status_code=410, detail=(
            f"This upload has {sess['state']}; start a new one with create_page_image_upload."))
    return sess


async def complete(db: AsyncIOMotorDatabase, user_id: str, upload_id: str, parts: list[dict] | None, *,
                   authorize: Authorize) -> dict:
    """Finish an upload: assemble the parts, check size, sha256 and type, then
    register the image on its page. ``authorize(page)`` raises unless the
    caller may still add images to it. Returns the image (the same result again
    for a session already done)."""
    sess = await fresh_session(db, user_id, upload_id)
    if sess["state"] == "done":
        return sess["result"]
    if sess["state"] == "failed":
        raise HTTPException(status_code=int(sess.get("error_status") or 422),
                            detail=sess.get("error") or "This upload failed; start a new one.")
    clean = file_uploads._clean_parts(sess, parts) if sess["state"] == "uploading" else None
    now = file_uploads._now()
    claimed = await db[file_uploads.SESSIONS].find_one_and_update(
        {"_id": upload_id, "$or": [{"state": "uploading"},
                                   {"state": "verifying", "verify_started_at": {"$lt": now - STALE_AFTER}}]},
        {"$set": {"state": "verifying", "error": None, "verify_started_at": now}},
        return_document=True,
    )
    if claimed is None:
        cur = await db[file_uploads.SESSIONS].find_one({"_id": upload_id})
        if cur and cur["state"] == "done":
            return cur["result"]
        raise HTTPException(status_code=409, detail="This upload is being completed already; try again in a moment.")
    sess = claimed
    key = sess["key"]

    async def back_to_uploading(detail: str, status: int = 400) -> HTTPException:
        await db[file_uploads.SESSIONS].update_one(
            {"_id": upload_id, "state": "verifying"}, {"$set": {"state": "uploading", "error": detail}})
        return HTTPException(status_code=status, detail=detail)

    async def fail(status: int, detail: str) -> HTTPException:
        await db[file_uploads.SESSIONS].update_one(
            {"_id": upload_id},
            {"$set": {"state": "failed", "error": detail, "error_status": status,
                      "ended_at": file_uploads._now()}})
        await run_in_threadpool(r2.delete, key)
        await run_in_threadpool(r2.abort_multipart, key, sess["r2_upload_id"])
        return HTTPException(status_code=status, detail=detail)

    try:
        return await _finish(db, sess, clean, user_id, authorize, back_to_uploading, fail)
    except HTTPException:
        raise
    except Exception:
        file_uploads.log.exception("completing page image upload %s failed", upload_id)
        raise await fail(500, "Something went wrong on Markdrop's side finishing this upload. Start it again "
                              "with create_page_image_upload.")


async def _finish(db: AsyncIOMotorDatabase, sess: dict, clean: list[dict] | None, user_id: str,
                  authorize: Authorize, back_to_uploading, fail) -> dict:
    upload_id, key = sess["_id"], sess["key"]
    gone = ("Storage no longer has this upload (it expired or was cancelled); start a new one with "
            "create_page_image_upload.")

    async def expired(reason: str) -> HTTPException:
        await db[file_uploads.SESSIONS].update_one(
            {"_id": upload_id}, {"$set": {"state": "expired", "ended_at": file_uploads._now(), "error": reason}})
        return HTTPException(status_code=410, detail=gone)

    # 1. Assemble the parts (a retry may find that done already: fine if the object is there).
    use = clean
    if use is None:
        try:
            use = await run_in_threadpool(r2.list_parts, key, sess["r2_upload_id"])
        except Exception as exc:
            if file_uploads._r2_code(exc) != "NoSuchUpload":
                raise
            use = []
            if await run_in_threadpool(r2.head, key) is None:
                raise await expired(file_uploads._r2_reason(exc))
    if not use and await run_in_threadpool(r2.head, key) is None:
        raise await back_to_uploading(
            "No part of the image has reached storage yet: run the curl command(s) from "
            "create_page_image_upload, then call complete_page_image_upload again.")
    if use:
        try:
            await run_in_threadpool(r2.complete_multipart, key, sess["r2_upload_id"], use)
        except Exception as exc:
            if await run_in_threadpool(r2.head, key) is None:
                if file_uploads._r2_code(exc) == "NoSuchUpload":
                    raise await expired(file_uploads._r2_reason(exc))
                raise await back_to_uploading(file_uploads._r2_reason(exc))

    # 2. Size, sha256 and type of the bytes that actually arrived.
    meta = await run_in_threadpool(r2.head, key)
    if meta is None:
        raise await fail(502, "The uploaded image couldn't be found in storage. Upload it again.")
    declared = int(sess["size_bytes"])
    if int(meta["size"]) != declared:
        raise await fail(422, f"The uploaded file is {int(meta['size']):,} bytes but {declared:,} were declared. "
                              "It was discarded and nothing was changed.")
    data = await run_in_threadpool(r2.get_bytes, key, declared + 1)
    if data is None or len(data) != declared:
        raise await fail(502, "The uploaded image couldn't be read back from storage. Upload it again.")
    digest = hashlib.sha256(data).hexdigest()
    if digest != sess["sha256"]:
        raise await fail(422, f"sha256 mismatch: declared {sess['sha256']}, the uploaded bytes hash to {digest}. "
                              "It was discarded and nothing was changed.")
    if page_assets.sniff(data) is None:
        raise await fail(415, "That file isn't a PNG, JPEG, GIF or WebP image (its bytes say so, whatever "
                              "its name). It was discarded; convert it to PNG and upload again.")

    # 3. The page, and the caller's right to add to it, as they stand now.
    from bson import ObjectId

    try:
        oid = ObjectId(sess["doc_id"])
    except Exception:
        oid = sess["doc_id"]
    page = await db["documents"].find_one({"_id": oid})
    if page is None:
        raise await fail(404, f"The page {sess.get('slug')} no longer exists; the image was discarded.")
    try:
        await authorize(page)
        info = await page_assets.adopt(db, page, asset_id=sess["asset_id"], key=key, data=data, user_id=user_id)
    except HTTPException as exc:
        raise await fail(exc.status_code, str(exc.detail))
    result = {**info, "slug": page["slug"], "alt": sess.get("alt"), "file_name": sess.get("file_name")}
    await db[file_uploads.SESSIONS].update_one(
        {"_id": upload_id},
        {"$set": {"state": "done", "result": result, "ended_at": file_uploads._now()}})
    return result
