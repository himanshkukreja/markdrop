"""Short upload links: ``https://api.markdrop.in/u/<token>`` for one part of an upload.

A presigned R2 part URL is ~600 characters. An agent copies every one of them
through its context into a shell command, so 16 files cost more tokens than the
work. A short link names the same thing — one part of one upload session
(services/file_uploads.py, files and page images alike) — and is just as much a
bearer capability as the presigned URL it stands for:

    PUT /u/<token>   (curl -T FILE <url>; the body is the part's bytes)

* **Where the bytes go.** The API takes the PUT and sends it on to R2 itself
  (``r2.upload_part_file``), spooling the body to a temporary file first (at
  most ``file_part_size``, 32 MiB, in memory up to a few MB). A redirect to the
  presigned URL would need ``curl --location`` and would make the client send
  the body twice; a Worker in front of markdrop.in would need the web host
  proxied by Cloudflare and a second copy of the token rules. markdrop.in itself
  is Vercel, whose functions take at most 4.5 MB of body. So the link lives on
  the API host, which already holds the R2 credentials.
* **Valid for** ``file_upload_url_ttl`` (60 minutes) and never past its session.
* **Single use.** A link is claimed (``busy``) while its PUT runs and ``used``
  after storage took the part; a second PUT is refused with what to do next. A
  PUT that fails (wrong size, storage error) gives the link back.
* **Checks.** The Content-Length must be exactly the part's size (no chunked
  bodies: storage needs the length) and the bytes that arrive must match it.
  For a one-part upload — any file up to 32 MiB — the sha256 is checked here
  too, so a wrong file is refused before it reaches storage; a multi-part
  file's sha256 is checked at complete, as before.

Rows live in ``upload_links`` and are dropped (TTL) a day after they expire.
"""

from __future__ import annotations

import hashlib
import secrets
import tempfile
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from motor.motor_asyncio import AsyncIOMotorDatabase
from starlette.requests import ClientDisconnect

from app.config import _public_base, get_settings
from app.services import file_uploads, r2

settings = get_settings()

LINKS = "upload_links"
# A PUT that died mid-way (a restart) leaves its link "busy"; after this long it can be used again.
BUSY_STALE = timedelta(minutes=15)
SPOOL_IN_MEMORY = 4 * 1024 * 1024


def _now() -> datetime:
    return datetime.now(timezone.utc)


def enabled() -> bool:
    return bool(settings.upload_short_links)


def base_url() -> str:
    return _public_base(settings.upload_link_base or settings.api_base_url)


def url_for(token: str) -> str:
    return f"{base_url()}/u/{token}"


def part_bytes(sess: dict, n: int) -> int:
    size, part = int(sess["size_bytes"]), int(sess["part_size"])
    return min(part, size - part * (n - 1))


async def mint(db: AsyncIOMotorDatabase, sess: dict, numbers: list[int]) -> dict[int, str]:
    """A fresh short link for each of ``numbers`` (part numbers of ``sess``)."""
    if not numbers:
        return {}
    now = _now()
    expires = now + timedelta(seconds=int(settings.file_upload_url_ttl))
    sess_exp = file_uploads._aware(sess.get("expires_at"))
    if sess_exp is not None and sess_exp < expires:
        expires = sess_exp
    rows, out = [], {}
    for n in numbers:
        token = secrets.token_urlsafe(12)
        rows.append({
            "_id": token, "upload_id": sess["_id"], "user_id": sess["user_id"], "part_number": int(n),
            "size": part_bytes(sess, int(n)), "state": "open", "created_at": now, "expires_at": expires,
            "purge_at": expires + timedelta(days=1),
        })
        out[int(n)] = url_for(token)
    await db[LINKS].insert_many(rows)
    return out


async def add_short_urls(db: AsyncIOMotorDatabase, session_out: dict) -> dict:
    """``session_out`` (file_uploads._session_out) with ``short_url`` on each part."""
    if not enabled():
        return session_out
    sess = await db[file_uploads.SESSIONS].find_one({"_id": session_out["upload_id"]})
    if sess is None:
        return session_out
    urls = await mint(db, sess, [int(p["part_number"]) for p in session_out["parts"]])
    for p in session_out["parts"]:
        p["short_url"] = urls[int(p["part_number"])]
    return session_out


def _gone(detail: str, status: int = 410) -> HTTPException:
    return HTTPException(status_code=status, detail=detail)


async def _release(db: AsyncIOMotorDatabase, token: str) -> None:
    await db[LINKS].update_one({"_id": token, "state": "busy"}, {"$set": {"state": "open"}, "$unset": {"busy_at": ""}})


async def put(db: AsyncIOMotorDatabase, token: str, request: Request) -> dict:
    """Take the part sent to a short link and hand it to storage. Returns what
    the client prints (the part's number and ETag)."""
    link = await db[LINKS].find_one({"_id": token})
    now = _now()
    if link is None:
        raise _gone("This upload link doesn't exist (or expired a while ago). Ask for fresh links: call "
                    "create_uploads (or create_upload) again with the same arguments.", 404)
    if file_uploads._aware(link["expires_at"]) <= now:
        raise _gone("This upload link has expired (links last 60 minutes). Call create_uploads (or "
                    "create_upload) again with the same arguments for fresh ones; parts already sent are kept.")
    if link["state"] == "used":
        raise _gone(f"This upload link was already used: part {link['part_number']} is uploaded. Links work "
                    "once; finish with complete_uploads (or complete_upload).")
    claimed = await db[LINKS].find_one_and_update(
        {"_id": token, "$or": [{"state": "open"}, {"state": "busy", "busy_at": {"$lt": now - BUSY_STALE}}]},
        {"$set": {"state": "busy", "busy_at": now}},
    )
    if claimed is None:
        raise _gone("This upload link is being used by another request right now.", 409)
    try:
        return await _receive(db, link, request)
    except BaseException:
        await _release(db, token)
        raise


async def _receive(db: AsyncIOMotorDatabase, link: dict, request: Request) -> dict:
    token, n, expected = link["_id"], int(link["part_number"]), int(link["size"])
    sess = await db[file_uploads.SESSIONS].find_one({"_id": link["upload_id"]})
    if sess is None or sess.get("state") != "uploading" or file_uploads._aware(sess["expires_at"]) <= _now():
        state = (sess or {}).get("state") or "expired"
        raise _gone(f"This upload is {state}, so its links no longer take files. Start a new upload.")

    if "chunked" in (request.headers.get("transfer-encoding") or "").lower() or \
            request.headers.get("content-length") is None:
        raise _gone("Send the file with its length: curl -T FILE <link> (storage needs the Content-Length, so "
                    "never stream from stdin or a pipe).", 411)
    try:
        declared = int(request.headers["content-length"])
    except ValueError:
        raise _gone("Content-Length isn't a number.", 400)
    if declared != expected:
        raise _gone(f"This link takes part {n} of {sess['file_name']}: exactly {expected:,} bytes, but "
                    f"{declared:,} were sent. Send the right file (or the right split part).",
                    413 if declared > expected else 400)

    one_part = int(sess["part_count"]) == 1
    digest = hashlib.sha256() if one_part else None
    got = 0
    with tempfile.SpooledTemporaryFile(max_size=SPOOL_IN_MEMORY) as spool:
        try:
            async for chunk in request.stream():
                got += len(chunk)
                if got > expected:
                    raise _gone(f"More than the {expected:,} bytes this link takes arrived.", 413)
                spool.write(chunk)
                if digest is not None:
                    digest.update(chunk)
        except ClientDisconnect:
            raise _gone("The connection closed before the whole part arrived. Run the curl again.", 400)
        if got != expected:
            raise _gone(f"Only {got:,} of {expected:,} bytes arrived. Run the curl again.", 400)
        if digest is not None and digest.hexdigest() != sess["sha256"]:
            raise _gone(f"sha256 mismatch: {sess['file_name']} was declared as {sess['sha256']}, these bytes hash "
                        f"to {digest.hexdigest()}. Nothing was stored; check the file and send it again.", 422)
        try:
            etag = await run_in_threadpool(r2.upload_part_file, sess["key"], sess["r2_upload_id"], n, spool, got)
        except Exception as exc:
            if file_uploads._r2_code(exc) == "NoSuchUpload":
                raise _gone("Storage no longer has this upload (it expired or was cancelled). Start a new one.")
            file_uploads.log.warning("short-link part upload failed for %s", sess["_id"], exc_info=True)
            raise _gone("File storage didn't take the part. Run the curl again in a moment.", 502)
    await db[LINKS].update_one({"_id": token}, {"$set": {"state": "used", "used_at": _now(), "etag": etag},
                                                "$unset": {"busy_at": ""}})
    return {"ok": True, "upload_id": sess["_id"], "file_name": sess["file_name"], "part_number": n,
            "part_count": int(sess["part_count"]), "size": got, "etag": etag}
