"""Upload a file, or replace the one behind a link, in parts straight to R2.

For clients with no browser: the CLI, the local MCP server, and an agent with a
shell talking to the hosted MCP server. The bytes go from the client to R2 on
presigned part URLs and never pass through this server (or an MCP argument).

    create  →  {upload_id, part_size, parts:[{part_number, url}], expires_at}
    (client PUTs each part, keeps each part's ETag)
    complete →  200 result | 202 {state: "verifying"} → poll status until
                "done" (result) or "failed" (error)

A session lives in ``file_uploads`` (the ``_id`` is our opaque upload id) and
moves through states:

    uploading → verifying → done
                          ↘ failed
    uploading → expired | cancelled        (the R2 multipart is aborted)

``complete`` stitches the parts, checks the real size against the declared
one, then streams the object back through sha256 in constant memory. A
mismatch deletes the object and changes nothing. Only then is the file
committed: a new artifact, or a new version of ``target_slug`` with the old
bytes kept (services/file_versions.py). Hashing 2 GB takes tens of seconds, so
it runs as a task; ``complete`` waits for it up to ``file_complete_wait_seconds``
and otherwise answers 202, and the session row is the source of truth either
way (a client polls ``GET /uploads/{id}``).
"""

from __future__ import annotations

import asyncio
import logging
import math
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

import bcrypt
from bson import ObjectId
from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.services import artifact as art_service
from app.services import file_versions, live, media, r2, revalidate

settings = get_settings()
log = logging.getLogger(__name__)

SESSIONS = "file_uploads"
MAX_PARTS = 10_000
MIN_PART = 5 * 1024 * 1024
# A verification whose worker has been silent this long is presumed dead (a
# restart mid-hash) and is picked up again by the next complete or status call.
STALE_AFTER = timedelta(minutes=2)
HEARTBEAT_S = 5.0
# Open sessions per account. Each one is an R2 multipart upload holding parts.
MAX_OPEN_SESSIONS = 20
PURGE_AFTER = timedelta(hours=24)  # after expires_at, the row itself goes (TTL)

_RUNNING: dict[str, asyncio.Task] = {}


class UploadFailed(Exception):
    """Ends a verification: the session becomes "failed" with this status."""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _mb(n: int) -> str:
    if n >= 1024 ** 3:
        return f"{n / 1024 ** 3:.1f}".rstrip("0").rstrip(".") + " GB"
    return f"{n // (1024 * 1024)} MB"


def part_size_for(size: int) -> int:
    """The configured part size, grown if a file would need over 10,000 parts."""
    size_per = max(MIN_PART, int(settings.file_part_size))
    if math.ceil(size / size_per) > MAX_PARTS:
        size_per = math.ceil(size / MAX_PARTS)
    return size_per


def file_url(slug: str) -> str:
    return f"{settings.frontend_url.rstrip('/')}/{slug}"


# ── Resolving the target and its owner ───────────────────────────────────────


async def owned_artifact(db: AsyncIOMotorDatabase, user, slug: str, *, action: str) -> dict:
    """The user's own file at ``slug``. 404 when there's nothing there (or
    nothing they can see), 403 when it's someone else's they can read, 409
    for a markdown document."""
    from app.services import access as access_service

    raw = await db["documents"].find_one({"slug": slug})
    if not raw:
        raise HTTPException(status_code=404, detail=f"There's no document at {slug}.")
    if raw.get("owner_id") != user.id:
        if await access_service.can_read(db, raw, user.id, getattr(user, "email", None)):
            raise HTTPException(status_code=403, detail=f"You can only {action} files you own.")
        raise HTTPException(status_code=404, detail=f"There's no document at {slug}.")
    if raw.get("kind") != "artifact":
        raise HTTPException(
            status_code=409,
            detail=f"{slug} is a markdown document, not a file; use update_document to change it.",
        )
    return raw


def require_single_blob(raw: dict) -> None:
    if raw.get("bundle_prefix"):
        raise HTTPException(
            status_code=409,
            detail=(f"{raw['slug']} is a zipped website, which has no file versions; "
                    "replace it from the Markdrop website instead."),
        )


# ── Create ────────────────────────────────────────────────────────────────────


def _part_urls(sess: dict, numbers: list[int]) -> list[dict]:
    ttl = int(settings.file_upload_url_ttl)
    return [
        {"part_number": n, "url": r2.presign_upload_part(sess["key"], sess["r2_upload_id"], n, ttl)}
        for n in numbers
    ]


def _session_out(sess: dict, numbers: list[int] | None = None) -> dict:
    numbers = numbers if numbers is not None else list(range(1, int(sess["part_count"]) + 1))
    return {
        "upload_id": sess["_id"],
        "part_size": int(sess["part_size"]),
        "parts": _part_urls(sess, numbers),
        "expires_at": _aware(sess["expires_at"]),
    }


async def sweep_expired(db: AsyncIOMotorDatabase, user_id: str) -> int:
    """Abort this user's lapsed sessions (their parts would otherwise sit in
    R2 until the bucket's lifecycle rule clears them)."""
    n = 0
    async for sess in db[SESSIONS].find(
        {"user_id": user_id, "state": "uploading", "expires_at": {"$lt": _now()}}
    ).limit(50):
        await _expire(db, sess)
        n += 1
    return n


async def _expire(db: AsyncIOMotorDatabase, sess: dict, state: str = "expired") -> None:
    res = await db[SESSIONS].update_one(
        {"_id": sess["_id"], "state": "uploading"}, {"$set": {"state": state, "ended_at": _now()}}
    )
    if res.modified_count and r2.is_configured():
        await run_in_threadpool(r2.abort_multipart, sess["key"], sess["r2_upload_id"])


async def create(db: AsyncIOMotorDatabase, user, data) -> dict:
    """Validate everything that can be validated before a byte moves, then
    open the R2 multipart upload and presign its parts."""
    sha = data.sha256.lower()
    mime = art_service.normalize_mime(data.content_type, data.file_name)
    if not mime:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type. Accepted: {', '.join(sorted(art_service.BY_EXT))}.",
        )
    if mime == "application/zip":
        raise HTTPException(
            status_code=415,
            detail="Zipped websites can't be uploaded here; upload them at markdrop.in/upload.",
        )
    limit = art_service.max_bytes_for(mime)
    if data.size_bytes > limit:
        raise HTTPException(
            status_code=413,
            detail=f"This file is {_mb(data.size_bytes)}; {art_service.label_for(mime)} files can be up to {_mb(limit)}.",
        )

    target: dict | None = None
    level, password_hash, workspace = "link", None, None
    if data.target_slug:
        if data.access is not None or data.password is not None or data.workspace is not None:
            raise HTTPException(
                status_code=422,
                detail=("access, password and workspace apply to new uploads only; a replaced "
                        "file keeps its link's settings (change them with set_access)."),
            )
        target = await owned_artifact(db, user, data.target_slug, action="replace")
        require_single_blob(target)
    else:
        access = data.access or ("workspace" if data.workspace else ("password" if data.password else "link"))
        if access == "password" and not data.password:
            raise HTTPException(status_code=422, detail='Access "password" needs a password.')
        if data.password and access != "password":
            raise HTTPException(status_code=422, detail='A password only applies when access is "password".')
        if access == "workspace" and not data.workspace:
            raise HTTPException(status_code=422, detail='Access "workspace" needs a workspace id.')
        if data.workspace:
            from app.services import workspace as ws_service

            await ws_service.require_role(db, data.workspace, user.id, "member")
            workspace = data.workspace
        level = access
        if data.password:
            password_hash = bcrypt.hashpw(data.password.encode(), bcrypt.gensalt()).decode()

    await sweep_expired(db, user.id)

    plan = await file_versions.quota_plan(db, user.id, target, data.size_bytes)
    if plan is None:
        raise HTTPException(status_code=507, detail=file_versions.quota_message())

    now = _now()
    # The same upload asked for again (a retry, or URLs that lapsed): hand back
    # the open session with fresh URLs instead of starting a second one.
    same = await db[SESSIONS].find_one({
        "user_id": user.id, "state": "uploading", "expires_at": {"$gt": now},
        "sha256": sha, "size_bytes": data.size_bytes, "file_name": data.file_name, "mime": mime,
        "target_slug": data.target_slug or None, "title": data.title, "access": level,
        "workspace": workspace,
    })
    if same is not None:
        if password_hash:
            await db[SESSIONS].update_one({"_id": same["_id"]}, {"$set": {"read_password_hash": password_hash}})
        return _session_out(same)

    if await db[SESSIONS].count_documents(
        {"user_id": user.id, "state": "uploading", "expires_at": {"$gt": now}}
    ) >= MAX_OPEN_SESSIONS:
        raise HTTPException(
            status_code=429,
            detail="Too many uploads in progress. Finish or cancel some before starting another.",
        )

    part_size = part_size_for(data.size_bytes)
    part_count = max(1, math.ceil(data.size_bytes / part_size))
    key = art_service.make_blob_key(user.id, mime)
    if target is not None:
        public = file_versions.is_public(target)
    else:
        public = not art_service.is_guarded(has_password=bool(password_hash),
                                            access_level="link" if level == "password" else level)
    try:
        r2_upload_id = await run_in_threadpool(r2.create_multipart, key, mime, public)
    except Exception:
        log.warning("create_multipart failed", exc_info=True)
        raise HTTPException(status_code=502, detail="File storage didn't respond. Try again in a moment.")

    expires_at = now + timedelta(hours=int(settings.file_upload_session_hours))
    sess = {
        "_id": "up_" + secrets.token_urlsafe(18),
        "user_id": user.id,
        "state": "uploading",
        "key": key,
        "r2_upload_id": r2_upload_id,
        "file_name": data.file_name,
        "mime": mime,
        "size_bytes": int(data.size_bytes),
        "sha256": sha,
        "part_size": part_size,
        "part_count": part_count,
        "target_slug": data.target_slug or None,
        "target_doc_id": str(target["_id"]) if target else None,
        "title": data.title,
        "access": level,
        "workspace": workspace,
        "read_password_hash": password_hash,
        "public_at_create": public,
        "created_at": now,
        "expires_at": expires_at,
        "purge_at": expires_at + PURGE_AFTER,
    }
    await db[SESSIONS].insert_one(sess)
    return _session_out(sess)


# ── Looking a session up ──────────────────────────────────────────────────────


async def load(db: AsyncIOMotorDatabase, user_id: str, upload_id: str) -> dict:
    """The caller's session. Someone else's is indistinguishable from none."""
    sess = await db[SESSIONS].find_one({"_id": upload_id})
    if not sess or sess.get("user_id") != user_id:
        raise HTTPException(status_code=404, detail="Upload not found. It may have expired; start a new one.")
    if sess["state"] == "uploading" and _aware(sess["expires_at"]) <= _now():
        await _expire(db, sess)
        sess = await db[SESSIONS].find_one({"_id": upload_id})
    return sess


async def fresh_urls(db: AsyncIOMotorDatabase, user_id: str, upload_id: str,
                     part_numbers: list[int] | None) -> dict:
    sess = await load(db, user_id, upload_id)
    _require_uploading(sess)
    count = int(sess["part_count"])
    if part_numbers:
        bad = [n for n in part_numbers if not 1 <= n <= count]
        if bad:
            raise HTTPException(status_code=422, detail=f"This upload has parts 1 to {count}; got {bad[:5]}.")
        numbers = sorted(set(part_numbers))
    else:
        have = {p["part_number"] for p in await _list_parts(sess)}
        numbers = [n for n in range(1, count + 1) if n not in have]
    return _session_out(sess, numbers)


def _require_uploading(sess: dict) -> None:
    state = sess["state"]
    if state in ("expired", "cancelled"):
        raise HTTPException(status_code=410, detail=f"This upload has {state}; start a new one.")
    if state != "uploading":
        raise HTTPException(status_code=409, detail=f"This upload is already {state}.")


async def _list_parts(sess: dict) -> list[dict]:
    try:
        return await run_in_threadpool(r2.list_parts, sess["key"], sess["r2_upload_id"])
    except Exception:
        log.info("list_parts failed for %s", sess["_id"], exc_info=True)
        return []


async def status(db: AsyncIOMotorDatabase, user_id: str, upload_id: str) -> dict:
    sess = await load(db, user_id, upload_id)
    if sess["state"] == "verifying":
        _maybe_resume(db, sess)
    parts = await _list_parts(sess) if sess["state"] == "uploading" else []
    out: dict[str, Any] = {
        "upload_id": sess["_id"],
        "state": sess["state"],
        "file_name": sess["file_name"],
        "content_type": sess["mime"],
        "size_bytes": int(sess["size_bytes"]),
        "sha256": sess["sha256"],
        "part_size": int(sess["part_size"]),
        "part_count": int(sess["part_count"]),
        "parts_uploaded": parts,
        "target_slug": sess.get("target_slug"),
        "expires_at": _aware(sess["expires_at"]),
    }
    if sess["state"] == "verifying":
        out["verified_bytes"] = int(sess.get("verified_bytes") or 0)
    if sess.get("result") is not None:
        out["result"] = sess["result"]
    if sess.get("error"):
        out["error"] = sess["error"]
    return out


async def cancel(db: AsyncIOMotorDatabase, user_id: str, upload_id: str) -> None:
    sess = await load(db, user_id, upload_id)
    if sess["state"] == "uploading":
        await _expire(db, sess, "cancelled")


# ── Complete ──────────────────────────────────────────────────────────────────


def _clean_parts(sess: dict, parts: list[dict] | None) -> list[dict] | None:
    """The client's part list, checked against the session. None means "use
    the parts R2 has", which the verification fetches itself."""
    if not parts:
        return None
    count = int(sess["part_count"])
    seen: dict[int, str] = {}
    for p in parts:
        n, etag = int(p["part_number"]), str(p["etag"]).strip().strip('"')
        if not 1 <= n <= count:
            raise HTTPException(status_code=422, detail=f"This upload has parts 1 to {count}; got part {n}.")
        if not etag:
            raise HTTPException(status_code=422, detail=f"Part {n} has no ETag.")
        seen[n] = etag
    missing = [n for n in range(1, count + 1) if n not in seen]
    if missing:
        more = f" (and {len(missing) - 10} more)" if len(missing) > 10 else ""
        raise HTTPException(
            status_code=422,
            detail=f"This upload has {count} part(s); missing part(s) {missing[:10]}{more}.",
        )
    return [{"part_number": n, "etag": seen[n]} for n in range(1, count + 1)]


def respond(sess: dict) -> tuple[int, dict]:
    """(HTTP status, body) for a session after complete."""
    state = sess["state"]
    if state == "done":
        return 200, sess["result"]
    if state == "verifying":
        return 202, {"state": "verifying", "upload_id": sess["_id"]}
    if state == "failed":
        return int(sess.get("error_status") or 422), {"detail": sess.get("error") or "The upload failed.",
                                                      "state": "failed"}
    if state == "uploading":  # R2 refused to stitch the parts; fix and retry
        return 400, {"detail": sess.get("error") or "The upload isn't complete.", "state": "uploading"}
    return 410, {"detail": f"This upload has {state}; start a new one.", "state": state}


async def complete(db: AsyncIOMotorDatabase, user_id: str, upload_id: str,
                   parts: list[dict] | None, *, wait: float | None = None) -> tuple[int, dict]:
    sess = await load(db, user_id, upload_id)
    if sess["state"] == "uploading":
        clean = _clean_parts(sess, parts)
        claimed = await db[SESSIONS].find_one_and_update(
            {"_id": upload_id, "state": "uploading"},
            {"$set": {"state": "verifying", "complete_parts": clean, "error": None,
                      "verify_started_at": _now(), "heartbeat_at": _now(), "verified_bytes": 0}},
            return_document=True,
        )
        if claimed is not None:
            _start(db, upload_id)
        sess = await db[SESSIONS].find_one({"_id": upload_id})
    if sess["state"] == "verifying":
        _maybe_resume(db, sess)
        task = _RUNNING.get(upload_id)
        if task is not None:
            timeout = settings.file_complete_wait_seconds if wait is None else wait
            await asyncio.wait({task}, timeout=timeout)
        sess = await db[SESSIONS].find_one({"_id": upload_id})
    return respond(sess)


def _start(db: AsyncIOMotorDatabase, upload_id: str) -> asyncio.Task:
    task = asyncio.get_running_loop().create_task(_verify_and_commit(db, upload_id))
    _RUNNING[upload_id] = task
    task.add_done_callback(lambda _t: _RUNNING.pop(upload_id, None))
    return task


def _maybe_resume(db: AsyncIOMotorDatabase, sess: dict) -> None:
    """A verification that went quiet (the server restarted mid-hash) is
    started again; it is idempotent up to the commit."""
    if sess["_id"] in _RUNNING:
        return
    beat = _aware(sess.get("heartbeat_at")) or _aware(sess.get("verify_started_at"))
    if beat is not None and _now() - beat < STALE_AFTER:
        return
    asyncio.get_running_loop().create_task(_resume(db, sess["_id"], sess.get("heartbeat_at")))


async def _resume(db: AsyncIOMotorDatabase, upload_id: str, last_beat) -> None:
    claimed = await db[SESSIONS].find_one_and_update(
        {"_id": upload_id, "state": "verifying", "heartbeat_at": last_beat},
        {"$set": {"heartbeat_at": _now()}},
    )
    if claimed is not None and upload_id not in _RUNNING:
        _start(db, upload_id)


async def _beat(db: AsyncIOMotorDatabase, upload_id: str, **fields) -> None:
    await db[SESSIONS].update_one({"_id": upload_id}, {"$set": {"heartbeat_at": _now(), **fields}})


async def _verify_and_commit(db: AsyncIOMotorDatabase, upload_id: str) -> None:
    sess = await db[SESSIONS].find_one({"_id": upload_id})
    if not sess or sess["state"] != "verifying":
        return
    key = sess["key"]
    committed = False
    try:
        # 1. Stitch the parts. A retry after a restart may find this already
        #    done, which is fine as long as the object is there.
        parts = sess.get("complete_parts") or await _list_parts(sess)
        try:
            await run_in_threadpool(r2.complete_multipart, key, sess["r2_upload_id"], parts)
        except Exception as exc:
            if await run_in_threadpool(r2.head, key) is None:
                await db[SESSIONS].update_one(
                    {"_id": upload_id, "state": "verifying"},
                    {"$set": {"state": "uploading", "error": _r2_reason(exc)}},
                )
                return
        await _beat(db, upload_id)

        # 2. The real size must be the declared one.
        meta = await run_in_threadpool(r2.head, key)
        if meta is None:
            raise UploadFailed(502, "The uploaded file couldn't be found in storage. Upload it again.")
        if int(meta["size"]) != int(sess["size_bytes"]):
            raise UploadFailed(
                422, f"The uploaded file is {meta['size']:,} bytes but {int(sess['size_bytes']):,} "
                     "were declared. Nothing was changed.")

        # 3. The real bytes must hash to the declared sha256.
        digest = await _hash(db, upload_id, key)
        if digest != sess["sha256"]:
            raise UploadFailed(
                422, f"sha256 mismatch: declared {sess['sha256']}, uploaded bytes hash to {digest}. "
                     "The upload was discarded and nothing was changed.")

        # 4. Commit.
        result, committed = await _commit(db, sess)
        await db[SESSIONS].update_one(
            {"_id": upload_id},
            {"$set": {"state": "done", "result": result, "ended_at": _now(), "heartbeat_at": _now()}},
        )
    except UploadFailed as exc:
        await _fail(db, sess, exc.status, exc.detail, delete=not committed)
    except Exception:
        log.exception("verifying upload %s failed", upload_id)
        await _fail(db, sess, 500, "Something went wrong on Markdrop's side finishing this upload. "
                    "Start the upload again.", delete=not committed)


def _r2_reason(exc: Exception) -> str:
    code = ""
    try:
        code = exc.response["Error"]["Code"]  # type: ignore[attr-defined]
    except Exception:
        pass
    if code in ("InvalidPart", "InvalidPartOrder", "EntityTooSmall"):
        return (f"Storage rejected the parts ({code}): check every part was uploaded in full with "
                "its own ETag, and that all parts but the last are part_size bytes.")
    if code == "NoSuchUpload":
        return "Storage no longer has this upload; start a new one."
    return "Storage couldn't assemble the parts. Check they all uploaded, then call complete again."


async def _fail(db: AsyncIOMotorDatabase, sess: dict, status: int, detail: str, *, delete: bool) -> None:
    await db[SESSIONS].update_one(
        {"_id": sess["_id"]},
        {"$set": {"state": "failed", "error": detail, "error_status": status, "ended_at": _now()}},
    )
    if delete and r2.is_configured():
        await run_in_threadpool(r2.delete, sess["key"])
        await run_in_threadpool(r2.abort_multipart, sess["key"], sess["r2_upload_id"])


async def _hash(db: AsyncIOMotorDatabase, upload_id: str, key: str) -> str:
    """sha256 of the stored object, in a thread, with a heartbeat on the session
    every few seconds (it says the worker is alive, and how far it has got)."""
    progress = {"n": 0}

    def on_progress(n: int) -> None:
        progress["n"] = n

    fut = asyncio.ensure_future(run_in_threadpool(r2.sha256_of, key, on_progress))
    while True:
        done, _ = await asyncio.wait({fut}, timeout=HEARTBEAT_S)
        if done:
            break
        await _beat(db, upload_id, verified_bytes=progress["n"])
    digest, n = fut.result()
    await _beat(db, upload_id, verified_bytes=n)
    return digest


async def _commit(db: AsyncIOMotorDatabase, sess: dict) -> tuple[dict, bool]:
    """Publish the verified object. Returns (result, committed)."""
    if sess.get("target_doc_id"):
        return await _commit_replace(db, sess)
    return await _commit_new(db, sess)


def _result(slug: str, version: int, sess: dict) -> dict:
    return {
        "url": file_url(slug),
        "slug": slug,
        "version": int(version),
        "size_bytes": int(sess["size_bytes"]),
        "content_type": sess["mime"],
        "sha256": sess["sha256"],
    }


async def _commit_replace(db: AsyncIOMotorDatabase, sess: dict) -> tuple[dict, bool]:
    raw = await db["documents"].find_one({"_id": ObjectId(sess["target_doc_id"])})
    if not raw or raw.get("owner_id") != sess["user_id"] or raw.get("kind") != "artifact":
        raise UploadFailed(404, f"The file at {sess['target_slug']} no longer exists, so nothing was replaced.")
    if raw.get("bundle_prefix"):
        raise UploadFailed(409, f"{raw['slug']} became a zipped website, which has no versions.")
    plan = await file_versions.quota_plan(db, sess["user_id"], raw, int(sess["size_bytes"]),
                                          new_blob_key=sess["key"])
    if plan is None:
        raise UploadFailed(507, file_versions.quota_message())
    swapped = await file_versions.swap(
        db, raw, blob_key=sess["key"], size_bytes=int(sess["size_bytes"]), mime=sess["mime"],
        filename=sess["file_name"], sha256=sess["sha256"], title=sess.get("title"),
    )
    if swapped is None:
        raise UploadFailed(404, f"The file at {sess['target_slug']} no longer exists, so nothing was replaced.")
    before, after, version = swapped
    # From here the new bytes are live: a failure below must not delete them.
    try:
        await file_versions.apply_publicity(before, after, new_blob_already=sess.get("public_at_create"))
        await file_versions.prune(db, after, plan)
    except Exception:
        log.warning("post-swap housekeeping failed for %s", after.get("slug"), exc_info=True)
    await after_swap(db, before, after, version, action="replace", user_id=sess["user_id"],
                     probe=True)
    return _result(after["slug"], version, sess), True


async def _commit_new(db: AsyncIOMotorDatabase, sess: dict) -> tuple[dict, bool]:
    size = int(sess["size_bytes"])
    used = await file_versions.usage_bytes(db, sess["user_id"])
    if used + size > settings.artifact_user_quota_bytes:
        raise UploadFailed(507, file_versions.quota_message())
    access = sess.get("access") or "link"
    # Born private, and opened up only once its password or workspace is in
    # place: the document is never more reachable than asked, even for a moment.
    level = "link" if access == "link" else "private"
    doc, _secret = await art_service.create_artifact(
        db, user_id=sess["user_id"], blob_key=sess["key"], mime=sess["mime"], size_bytes=size,
        title=sess.get("title"), filename=sess["file_name"], preferred_slug=sess["file_name"],
        access_level=level,
    )
    # A document now points at the object: whatever happens next, keep it.
    try:
        return await _finish_new(db, sess, doc.slug, access), True
    except Exception:
        log.exception("finishing upload %s failed after its document was created", sess["_id"])
        return _result(doc.slug, 1, sess), True


async def _finish_new(db: AsyncIOMotorDatabase, sess: dict, slug: str, access: str) -> dict:
    from app.services import access as access_service

    size = int(sess["size_bytes"])
    raw = await db["documents"].find_one({"slug": slug})
    now = _now()
    extra = {"sha256": sess["sha256"], "file_version": 1, "file_updated_at": now}
    if access == "password" and sess.get("read_password_hash"):
        extra["read_password_hash"] = sess["read_password_hash"]
        extra["access_level"] = "link"
    await db["documents"].update_one({"_id": raw["_id"]}, {"$set": extra})
    raw = await db["documents"].find_one({"_id": raw["_id"]})
    await file_versions.ensure_current_row(db, raw)

    if sess.get("workspace"):
        try:
            from app.services import library as lib_service
            from app.services import user as user_service

            user = await user_service.get_user_by_id(db, sess["user_id"])
            await lib_service.add_document(db, sess["workspace"], str(raw["_id"]), user)
            if access == "workspace":
                fresh = await db["documents"].find_one({"_id": raw["_id"]})
                await access_service.set_level(db, fresh, "workspace", sess["user_id"])
        except Exception:
            # The file stays private to its owner: never more open than asked.
            log.warning("adding upload %s to workspace failed", sess["_id"], exc_info=True)
        raw = await db["documents"].find_one({"_id": raw["_id"]})

    public = file_versions.is_public(raw)
    if public != bool(sess.get("public_at_create")):
        await run_in_threadpool(r2.set_public, sess["key"], public, sess["mime"])
    await file_versions.log_event(
        db, user_id=sess["user_id"], slug=raw["slug"], doc_id=str(raw["_id"]), action="upload",
        old_sha256=None, new_sha256=sess["sha256"], size_bytes=size, version=1,
    )
    media.schedule(db, str(raw["_id"]), 1, sess["key"], sess["mime"])
    return _result(raw["slug"], 1, sess)


async def after_swap(db: AsyncIOMotorDatabase, before: dict, after: dict, version: int, *,
                     action: str, user_id: str, probe: bool) -> None:
    """What every swap does once the document points at its new bytes: tell
    live viewers, purge the cached page, log it, and probe new media."""
    live.publish(after["slug"], int(after.get("rev", 1)))
    revalidate.page(after["slug"])
    await file_versions.log_event(
        db, user_id=user_id, slug=after["slug"], doc_id=str(after["_id"]), action=action,
        old_sha256=before.get("sha256"), new_sha256=after.get("sha256"),
        size_bytes=int(after.get("size_bytes") or 0), version=version,
    )
    if probe and not after.get("media"):
        media.schedule(db, str(after["_id"]), version, after["blob_key"], after.get("mime") or "")


# ── File info, versions, restore ──────────────────────────────────────────────


def access_of(raw: dict) -> str:
    level = raw.get("access_level") or "link"
    if level != "link":
        return level
    return "password" if raw.get("read_password_hash") else "link"


def file_info(raw: dict) -> dict:
    private = art_service.is_guarded(
        has_password=bool(raw.get("read_password_hash")), access_level=raw.get("access_level")
    )
    blob = raw.get("blob_key") or ""
    configured = r2.is_configured()
    poster = raw.get("poster_key")
    return {
        "slug": raw["slug"],
        "url": file_url(raw["slug"]),
        "title": raw.get("title"),
        "content_type": raw.get("mime") or "application/octet-stream",
        "size_bytes": int(raw.get("size_bytes") or 0),
        "sha256": raw.get("sha256"),
        "version": file_versions.current_version(raw),
        "updated_at": _aware(raw.get("updated_at")),
        "created_at": _aware(raw.get("created_at")),
        "media": raw.get("media"),
        "poster_url": art_service.build_download_url(poster, private=private) if poster and configured else None,
        "download_url": art_service.build_download_url(blob, private=private) if blob and configured else None,
        "access": access_of(raw),
    }


async def readable_artifact(db: AsyncIOMotorDatabase, user, slug: str) -> dict:
    """The file at ``slug`` for anyone who may read it: the owner, or someone
    the website's own read path lets in (every gate applies)."""
    from app.services import document as doc_service

    raw = await db["documents"].find_one({"slug": slug})
    if not raw:
        raise HTTPException(status_code=404, detail=f"There's no document at {slug}.")
    if raw.get("owner_id") != user.id:
        await doc_service.get_document(db, slug, user_id=user.id, user_email=getattr(user, "email", None))
    if raw.get("kind") != "artifact":
        raise HTTPException(
            status_code=409,
            detail=f"{slug} is a markdown document, not a file; read it with get_document.",
        )
    return raw


async def versions(db: AsyncIOMotorDatabase, raw: dict) -> dict:
    cur = file_versions.current_version(raw)
    rows = await file_versions.rows_for(db, raw)
    return {"versions": [
        {
            "version": int(r["version"]),
            "size_bytes": int(r.get("size_bytes") or 0),
            "sha256": r.get("sha256"),
            "content_type": r.get("mime") or "application/octet-stream",
            "created_at": _aware(r.get("created_at")),
            "current": int(r["version"]) == cur,
            "media": r.get("media"),
            "filename": r.get("filename"),
        }
        for r in rows
    ]}


async def restore(db: AsyncIOMotorDatabase, user, raw: dict, version: int) -> dict:
    require_single_blob(raw)
    res = await file_versions.restore(db, raw, version)
    if res is None:
        kept = [r["version"] for r in await file_versions.rows_for(db, raw)]
        raise HTTPException(
            status_code=404,
            detail=f"Version {version} of {raw['slug']} isn't kept. Kept versions: {sorted(kept)}.",
        )
    before, after, new_version = res
    if new_version != file_versions.current_version(before):
        # A non-current blob is never public, so the restored one starts private.
        await file_versions.apply_publicity(before, after, new_blob_already=False)
        await file_versions.prune(db, after)
        await after_swap(db, before, after, new_version, action="restore", user_id=user.id, probe=True)
    fresh = await db["documents"].find_one({"_id": raw["_id"]})
    return file_info(fresh or after)
