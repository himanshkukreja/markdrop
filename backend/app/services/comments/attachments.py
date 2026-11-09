"""Images and files in comments (CONTRACT §1.2 ``attachments``; Track B).

They follow the item's access like page images (services/page_assets.py): a row in ``page_assets`` with
``comment: True`` and ``name``, its bytes in R2 under the item's own prefix (``pa/<doc_id>/…``), so a
narrowing closes them under the new access epoch, deleting the item deletes them, and the owner's storage
quota counts them. Unlike page images they are **never public**: every link is signed for one viewer who can
see the item's comments (``GET …/comments/attachments/urls``), and only for files a live message holds (or
the caller's own upload still waiting for its message). A page reader without comment access never gets one,
and ``asset:<id>`` written into the page doesn't resolve to them either (page_assets.urls_for skips them).

Flow: the composer uploads (``POST …/comments/attachments`` → ``{id, name, mime, size, …}``), then sends the
ids with the comment; service.create_thread / reply call :func:`resolve_ids`, which checks each one is the
poster's own fresh upload on this item and marks it attached. Uploads never attached, and files of deleted
messages, are dropped by the daily page-image clean-up (page_history.cleanup_images → :func:`in_use`).

Types: PNG, JPEG, GIF, WebP images; PDF; Word / Excel / PowerPoint / zip; plain text, CSV, Markdown, JSON
(stored as text/plain or text/csv, never as anything a browser would run). Up to 10 MB each, 10 per message,
200 per item. Bytes are sniffed, never trusted by name.
"""

from __future__ import annotations

import logging
import re
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool

from app.services.comments import model

log = logging.getLogger(__name__)

MAX_BYTES = 10 * 1024 * 1024
MAX_PER_MESSAGE = 10
MAX_PER_ITEM = 200
PENDING_GRACE = timedelta(days=1)
NAME_MAX = 120

_ZIP = b"PK\x03\x04"
_OFFICE = {
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "zip": "application/zip",
}
_TEXT = {"txt": "text/plain; charset=utf-8", "md": "text/plain; charset=utf-8", "log": "text/plain; charset=utf-8",
         "json": "text/plain; charset=utf-8", "csv": "text/csv; charset=utf-8"}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _err(status: int, detail: str, code: str) -> HTTPException:
    from app.services.pages import PageError

    return PageError(status, {"detail": detail, "code": code})


def clean_name(name: str | None, ext: str) -> str:
    base = re.sub(r"[\x00-\x1f\x7f/\\]+", "", str(name or "")).strip().strip(".") or f"file.{ext}"
    if len(base) > NAME_MAX:
        stem, dot, tail = base.rpartition(".")
        base = (stem[: NAME_MAX - len(tail) - 2] + "." + tail) if dot and len(tail) <= 8 else base[:NAME_MAX]
    return base


def kind_of(data: bytes, name: str | None) -> tuple[str, str]:
    """(mime, extension) of a file a comment may hold, from its bytes (the name only picks between
    formats that share a container), or 415."""
    from app.services import page_assets

    img = page_assets.sniff(data)
    if img is not None:
        return img
    ext = (str(name or "").rsplit(".", 1)[-1].lower() if "." in str(name or "") else "")
    if data.startswith(b"%PDF-"):
        return "application/pdf", "pdf"
    if data.startswith(_ZIP):
        e = ext if ext in _OFFICE else "zip"
        return _OFFICE[e], e
    if ext in _TEXT and b"\x00" not in data[:65536]:
        try:
            data[:65536].decode("utf-8")
        except UnicodeDecodeError as exc:
            # A multi-byte character cut at the window's edge is still text.
            if exc.start < 65530:
                raise _err(415, "That text file isn't UTF-8.", "unsupported_type")
        return _TEXT[ext], ext
    raise _err(415, "Comments take images (PNG, JPEG, GIF, WebP), PDFs, Word, Excel, PowerPoint, zip and "
                    "text files (txt, csv, md, json).", "unsupported_type")


async def upload(db, actor, raw: dict, ctx, *, name: str | None, data: bytes) -> dict:
    """Store a file for a comment on ``raw`` (anyone who can comment). ``{id, name, mime, size, width, height,
    url}`` — the url signed for the uploader."""
    from app.services import page_assets, publicity, r2
    from app.services.comments import perms

    await perms.require(db, actor, raw, ctx, "comment")
    if not data:
        raise _err(422, "That file is empty.", "empty")
    if len(data) > MAX_BYTES:
        raise _err(413, f"Files in comments can be up to {MAX_BYTES // (1024 * 1024)} MB.", "too_large")
    mime, ext = kind_of(data, name)
    doc_id = str(raw["_id"])
    if await db[page_assets.COLL].count_documents({"doc_id": doc_id, "comment": True}) >= MAX_PER_ITEM:
        raise _err(429, f"This item holds {MAX_PER_ITEM} files in comments already.", "too_many")
    owner = await page_assets.check_room(db, raw, len(data), user_id=actor.user_id, max_bytes=MAX_BYTES)
    width = height = None
    if mime.startswith("image/"):
        width, height = await run_in_threadpool(page_assets._dimensions, data)
    asset_id = secrets.token_hex(12)
    key = page_assets.key_for(doc_id, asset_id, ext)
    if not await run_in_threadpool(r2.put_bytes, key, data, mime, False):
        raise _err(502, "The file couldn't be stored. Try again.", "storage")
    await run_in_threadpool(r2.set_public, key, False, mime, publicity.epoch_of(raw))
    row = {"_id": asset_id, "doc_id": doc_id, "key": key, "mime": mime, "size": len(data), "width": width,
           "height": height, "created_by": actor.user_id, "owner_id": owner, "created_at": now_utc(),
           "comment": True, "name": clean_name(name, ext), "attached_at": None}
    await db[page_assets.COLL].insert_one(row)
    # The item may have narrowed while the bytes went up: follow its epoch now.
    fresh = await db["documents"].find_one({"_id": raw["_id"]}, {"content": 0})
    if fresh is None:
        await db[page_assets.COLL].delete_one({"_id": asset_id})
        await run_in_threadpool(r2.delete, key)
        raise HTTPException(status_code=404, detail="Document not found")
    if publicity.epoch_of(fresh) != publicity.epoch_of(raw):
        await run_in_threadpool(r2.set_public, key, False, mime, publicity.epoch_of(fresh))
    return {**public_row(row), "url": _url(fresh, row)}


def public_row(row: dict) -> dict:
    out = {"id": row["_id"], "name": row.get("name") or "file", "mime": row.get("mime") or "application/octet-stream",
           "size": int(row.get("size") or 0)}
    if isinstance(row.get("width"), int) and isinstance(row.get("height"), int):
        out["width"], out["height"] = row["width"], row["height"]
    return out


def _url(raw: dict, row: dict) -> str:
    from app.config import get_settings
    from app.services import artifact as art_service
    from app.services import publicity

    ttl = int(get_settings().artifact_url_ttl_seconds)
    return art_service.build_download_url(row["key"], private=True, epoch=publicity.epoch_of(raw), ttl=ttl)


async def resolve_ids(db, raw: dict, actor, ids: list[str] | None) -> list[dict]:
    """Attachment ids a comment draft names → the rows stored on the message
    (``{"id", "name", "mime", "size", "key"}``). Each must be the poster's own upload on this item that no
    message holds yet; they are marked attached here."""
    from app.services import page_assets

    if not ids:
        return []
    want = list(dict.fromkeys(str(i) for i in ids if i))
    if len(want) > MAX_PER_MESSAGE:
        raise _err(422, f"A comment can carry up to {MAX_PER_MESSAGE} files.", "too_many")
    if not actor.user_id:
        raise _err(401, "Sign in to comment.", "signin")
    rows = {r["_id"]: r for r in await db[page_assets.COLL].find(
        {"_id": {"$in": want}, "doc_id": str(raw["_id"]), "comment": True}).to_list(length=len(want))}
    out = []
    for i in want:
        r = rows.get(i)
        if r is None or r.get("created_by") != actor.user_id:
            raise _err(422, "One of the files isn't there any more. Attach it again.", "attachment_missing")
        if r.get("attached_at") is not None:
            raise _err(422, "One of the files is already in another comment. Attach it again.", "attachment_used")
        out.append(r)
    at = now_utc()
    res = await db[page_assets.COLL].update_many({"_id": {"$in": want}, "attached_at": None},
                                                 {"$set": {"attached_at": at}})
    if res.modified_count != len(want):
        raise _err(409, "Those files were just used in another comment. Attach them again.", "attachment_used")
    return [{"id": r["_id"], "name": r.get("name") or "file", "mime": r.get("mime") or "application/octet-stream",
             "size": int(r.get("size") or 0), "key": r["key"]} for r in out]


async def live_ids(db, doc_id: str, ids: list[str] | None = None) -> set[str]:
    """Attachment ids held by live (not deleted) messages of the item (among ``ids``)."""
    q: dict = {"doc_id": doc_id, "deleted_at": None, "attachments.0": {"$exists": True}}
    if ids is not None:
        q["attachments.id"] = {"$in": list(ids)}
    out: set[str] = set()
    async for m in db[model.MESSAGES].find(q, {"attachments.id": 1}):
        for a in m.get("attachments") or []:
            if a.get("id"):
                out.add(a["id"])
    return out


async def in_use(db, doc_id: str, rows: list[dict], now: datetime | None = None) -> set[str]:
    """Which of an item's comment files the clean-up must keep (page_history.cleanup_images): held by a live
    message, or an upload younger than a day still waiting for its message."""
    now = now or now_utc()
    keep = await live_ids(db, doc_id)
    for r in rows:
        if not r.get("comment") or r["_id"] in keep:
            continue
        at = r.get("created_at")
        if at is not None and at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        if r.get("attached_at") is None and at is not None and at > now - PENDING_GRACE:
            keep.add(r["_id"])
    return keep


async def urls(db, actor, raw: dict, ctx, ids: list[str]) -> dict:
    """``{"attachments": {id: {url, expires_at, name, mime, size, width?, height?}}}`` for this viewer (who
    can see the comments): files live messages hold, and the caller's own pending uploads."""
    from app.config import get_settings
    from app.services import page_assets
    from app.services.comments import perms

    await perms.require(db, actor, raw, ctx, "view")
    want = list(dict.fromkeys(str(i) for i in ids if i))[:100]
    if not want:
        return {"attachments": {}}
    doc_id = str(raw["_id"])
    held = await live_ids(db, doc_id, want)
    rows = await db[page_assets.COLL].find({"_id": {"$in": want}, "doc_id": doc_id, "comment": True}).to_list(
        length=len(want))
    ttl = int(get_settings().artifact_url_ttl_seconds)
    expires = (now_utc() + timedelta(seconds=ttl)).isoformat().replace("+00:00", "Z")
    out = {}
    for r in rows:
        mine_pending = r.get("attached_at") is None and actor.user_id and r.get("created_by") == actor.user_id
        if r["_id"] not in held and not mine_pending:
            continue
        out[r["_id"]] = {**public_row(r), "url": _url(raw, r), "expires_at": expires}
    return {"attachments": out}


async def discard(db, actor, raw: dict, ctx, asset_id: str) -> None:
    """The uploader removes a file from a draft before posting (it isn't in any message yet)."""
    from app.services import page_assets, r2
    from app.services.comments import perms

    await perms.require(db, actor, raw, ctx, "comment")
    row = await db[page_assets.COLL].find_one({"_id": asset_id, "doc_id": str(raw["_id"]), "comment": True})
    if row is None or row.get("created_by") != actor.user_id or row.get("attached_at") is not None:
        raise _err(404, "That file isn't there.", "not_found")
    await db[page_assets.COLL].delete_one({"_id": asset_id, "attached_at": None})
    try:
        await run_in_threadpool(r2.delete, row["key"])
    except Exception:  # pragma: no cover - r2.delete swallows its own errors
        log.warning("comment file delete failed")
