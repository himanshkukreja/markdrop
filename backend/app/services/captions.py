"""Captions for a video file: a .vtt or .srt the owner (or an editor) adds, stored as WebVTT in R2
beside the video with the video's publicity, shown by the player as subtitles and read by search and
Ask by minute ("at 12:34", a link that plays from there).

    PUT    /api/v1/artifacts/{slug}/captions   {file_name, content}   (routers/artifacts.py)
    DELETE /api/v1/artifacts/{slug}/captions
    MCP    set_captions                                              (mcp/tools.py)

**Who:** ``can(edit_content)`` on the file (as renaming it). **Where:** ``art/<owner>/<random>.captions.vtt``
(a fresh random part: the key never reveals or collides with the video's), ``captions_key`` /
``captions_name`` on the document. Publicity follows the video's on every change
(services/publicity.apply); the key is deleted with the document (file_versions.forget_document)
or when the captions are replaced or removed. Captions are not versioned: replacing the video keeps them.
"""

from __future__ import annotations

import logging
import secrets

from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from starlette.concurrency import run_in_threadpool

from app.services import access, file_text, search_index

log = logging.getLogger("markdrop.captions")

MAX_BYTES = 2 * 1024 * 1024
ACCEPTED = (".vtt", ".srt")


def key_for(blob_key: str) -> str:
    owner_dir = blob_key.rsplit("/", 1)[0] if "/" in (blob_key or "") else "art"
    return f"{owner_dir}/{secrets.token_urlsafe(18)}.captions.vtt"


def to_vtt(file_name: str | None, content: str) -> str:
    """The upload as WebVTT, or 422 with what's wrong."""
    name = (file_name or "").strip().lower()
    if name and not name.endswith(ACCEPTED):
        raise HTTPException(status_code=422, detail="Captions must be a .vtt or .srt file.")
    if len(content.encode("utf-8", "replace")) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="That captions file is too big (2 MB at most).")
    try:
        return file_text.to_vtt(content)
    except file_text.Refused:
        raise HTTPException(status_code=422, detail="No captions found in that file. Use a .vtt or .srt file.")


async def _load(db: AsyncIOMotorDatabase, slug: str, actor: access.Actor, ctx: access.Ctx) -> dict:
    raw = await db["documents"].find_one({"slug": slug, "deleted_at": None})
    if raw is None or raw.get("kind") != "artifact":
        raise HTTPException(status_code=404, detail="File not found")
    await access.require(actor, raw, "edit_content", ctx)
    if not (raw.get("mime") or "").startswith("video/"):
        raise HTTPException(status_code=422, detail="Captions are for video files.")
    if raw.get("encrypted"):
        raise HTTPException(status_code=422, detail="Captions can't be added to an encrypted file.")
    return raw


async def set_captions(db: AsyncIOMotorDatabase, slug: str, actor: access.Actor, ctx: access.Ctx, *,
                       file_name: str | None, content: str) -> dict:
    """Add or replace a video's captions. Returns the updated document row."""
    from app.services import publicity, r2

    raw = await _load(db, slug, actor, ctx)
    vtt = to_vtt(file_name, content)
    if not r2.is_configured():
        raise HTTPException(status_code=503, detail="File storage isn't configured.")
    key = key_for(raw.get("blob_key") or "")
    public = await publicity.doc_is_public(db, raw)
    if not await run_in_threadpool(r2.put_bytes, key, vtt.encode("utf-8"), "text/vtt", public):
        raise HTTPException(status_code=502, detail="Couldn't store the captions. Try again.")
    if not public:
        # Signed links carry the access epoch: the object takes it too (as the video's).
        await run_in_threadpool(r2.set_public, key, False, "text/vtt", publicity.epoch_of(raw))
    name = (file_name or "captions.vtt").strip()[:200] or "captions.vtt"
    after = await db["documents"].find_one_and_update(
        {"_id": raw["_id"]}, {"$set": {"captions_key": key, "captions_name": name}}, return_document=True)
    old = raw.get("captions_key")
    if old and old != key:
        await run_in_threadpool(r2.delete, old)
    search_index.touch(db, raw["_id"])
    return after or raw


async def remove_captions(db: AsyncIOMotorDatabase, slug: str, actor: access.Actor, ctx: access.Ctx) -> dict:
    from app.services import r2

    raw = await _load(db, slug, actor, ctx)
    old = raw.get("captions_key")
    after = await db["documents"].find_one_and_update(
        {"_id": raw["_id"]}, {"$unset": {"captions_key": "", "captions_name": ""}}, return_document=True)
    if old and r2.is_configured():
        await run_in_threadpool(r2.delete, old)
    search_index.touch(db, raw["_id"])
    return after or raw
