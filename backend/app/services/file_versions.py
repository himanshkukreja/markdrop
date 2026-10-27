"""File versions: swap the bytes behind an artifact and keep the old ones.

Replacing a file keeps its link (slug, access, password, workspace, title,
views, created_at) and turns the previous bytes into a *version* that can be
restored. Each version is a row in ``file_versions``:

    {doc_id, slug, user_id, version, blob_key, size_bytes, sha256, mime, media,
     poster_key, filename, created_at}

The current file is a row too (its version equals the document's
``file_version``), so the history is one query. Artifacts from before versions
existed have no rows and are version 1; their row is written the first time
they are replaced. A restore never copies bytes: it adds a new version that
points at the old blob, so one blob can sit behind several rows, and a blob is
deleted only once no row and no document references it.

Rules (owner decisions, 2026-10-27):

* At most ``file_versions_keep`` rows per document, the current one included;
  the oldest non-current rows go first.
* Old versions count towards the account quota. When an upload would go over,
  the oldest non-current versions of the *same* file are dropped first, then the
  upload is refused (507).
* Publicity: the current blob (and its poster) follows ``publicity.is_public``
  like every other artifact write; a non-current version is never public.

Single-blob artifacts only. A zipped site (``bundle_prefix``) has no versions:
replacing one still frees the old bundle, as it always did.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from fastapi.concurrency import run_in_threadpool
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.config import get_settings

settings = get_settings()
log = logging.getLogger(__name__)

VERSIONS = "file_versions"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def current_version(raw: dict) -> int:
    return int(raw.get("file_version") or 1)


def current_row(raw: dict) -> dict:
    """The document's current file, shaped as a version row (not stored)."""
    return {
        "doc_id": str(raw["_id"]),
        "slug": raw.get("slug"),
        "user_id": raw.get("owner_id"),
        "version": current_version(raw),
        "blob_key": raw.get("blob_key"),
        "size_bytes": int(raw.get("size_bytes") or 0),
        "sha256": raw.get("sha256"),
        "mime": raw.get("mime"),
        "media": raw.get("media"),
        "poster_key": raw.get("poster_key"),
        "filename": raw.get("original_filename"),
        # The best we know for a legacy file: when it was last set.
        "created_at": raw.get("file_updated_at") or raw.get("updated_at") or raw.get("created_at"),
    }


async def rows_for(db: AsyncIOMotorDatabase, raw: dict) -> list[dict]:
    """Every version of this document, newest first. The current file is
    always included, even if its row was never written (a legacy file)."""
    rows = await db[VERSIONS].find({"doc_id": str(raw["_id"])}).sort("version", -1).to_list(length=1000)
    cur = current_version(raw)
    if not any(r["version"] == cur for r in rows):
        rows.append(current_row(raw))
        rows.sort(key=lambda r: r["version"], reverse=True)
    return rows


async def ensure_current_row(db: AsyncIOMotorDatabase, raw: dict) -> None:
    """Write the current file's row if it isn't there (legacy files, or a
    crash between a swap and its row). Idempotent under races: the row is
    upserted on its unique (doc_id, version)."""
    if raw.get("file_version") is None:
        await db["documents"].update_one(
            {"_id": raw["_id"], "file_version": {"$exists": False}}, {"$set": {"file_version": 1}}
        )
        fresh = await db["documents"].find_one({"_id": raw["_id"]}, {"file_version": 1})
        raw["file_version"] = (fresh or {}).get("file_version") or 1
    row = current_row(raw)
    await _upsert_row(db, row)


async def _upsert_row(db: AsyncIOMotorDatabase, row: dict) -> None:
    try:
        await db[VERSIONS].update_one(
            {"doc_id": row["doc_id"], "version": row["version"]},
            {"$setOnInsert": row},
            upsert=True,
        )
    except DuplicateKeyError:
        pass  # a concurrent writer got there first; same row


# ── Quota ─────────────────────────────────────────────────────────────────────


async def usage_bytes(db: AsyncIOMotorDatabase, user_id: str) -> int:
    """Everything this account stores: every artifact's current bytes, plus
    each distinct blob kept only as an old version (a restore can put the same
    blob behind two rows, and the current blob is a row too; neither is
    counted twice). Posters are a few KB and aren't counted."""
    total = 0
    current: set[str] = set()
    async for d in db["documents"].find(
        {"owner_id": user_id, "kind": "artifact"}, {"size_bytes": 1, "blob_key": 1}
    ):
        total += int(d.get("size_bytes") or 0)
        if d.get("blob_key"):
            current.add(d["blob_key"])
    rows = await db[VERSIONS].aggregate([
        {"$match": {"user_id": user_id}},
        {"$group": {"_id": "$blob_key", "size": {"$max": "$size_bytes"}}},
    ]).to_list(length=None)
    for r in rows:
        if r["_id"] and r["_id"] not in current:
            total += int(r.get("size") or 0)
    return total


def plan_drops(rows: list[dict], *, keep_keys: set[str], used: int, incoming: int,
               quota: int) -> list[dict] | None:
    """Which old versions to drop so ``used + incoming`` fits ``quota``.

    ``rows`` are the candidates (the document's versions that will be
    non-current, any order); ``keep_keys`` are blobs that stay referenced
    whatever happens (the new current blob). Oldest go first, and dropping a
    row frees bytes only once every row behind its blob is gone. Returns the
    rows to drop (empty when it already fits), or None when even dropping
    every candidate isn't enough.
    """
    over = used + incoming - quota
    if over <= 0:
        return []
    refs: dict[str, int] = {}
    for r in rows:
        refs[r["blob_key"]] = refs.get(r["blob_key"], 0) + 1
    drops: list[dict] = []
    freed = 0
    for r in sorted(rows, key=lambda r: r["version"]):
        key = r["blob_key"]
        if key in keep_keys:
            continue
        drops.append(r)
        refs[key] -= 1
        if refs[key] == 0:
            freed += int(r.get("size_bytes") or 0)
        if freed >= over:
            return drops
    return None


async def quota_plan(db: AsyncIOMotorDatabase, user_id: str, raw: dict | None, incoming: int,
                     *, new_blob_key: str | None = None) -> list[dict] | None:
    """The versions to drop for ``incoming`` new bytes to fit (see plan_drops).

    ``raw`` is the document being replaced, or None for a brand-new file (which
    has no versions to give up). Read-only: nothing is dropped here."""
    used = await usage_bytes(db, user_id)
    candidates: list[dict] = []
    if raw is not None and not raw.get("bundle_prefix"):
        # After the swap every existing version is non-current, the
        # outgoing current file included (it is the newest of them).
        candidates = await rows_for(db, raw)
    return plan_drops(candidates, keep_keys={new_blob_key} if new_blob_key else set(),
                      used=used, incoming=incoming, quota=settings.artifact_user_quota_bytes)


def quota_message() -> str:
    gb = settings.artifact_user_quota_bytes / (1024 ** 3)
    quota = f"{gb:.0f} GB" if gb >= 1 else f"{settings.artifact_user_quota_bytes // (1024 * 1024)} MB"
    return (f"Storage quota exceeded ({quota} per account, old versions included). "
            "Delete files or old versions to free space.")


# ── Swapping ──────────────────────────────────────────────────────────────────


async def swap(
    db: AsyncIOMotorDatabase,
    raw: dict,
    *,
    blob_key: str,
    size_bytes: int,
    mime: str,
    filename: str | None,
    sha256: str | None,
    media: dict | None = None,
    poster_key: str | None = None,
    title: str | None = None,
) -> tuple[dict, dict, int] | None:
    """Point the document at new bytes as a new version, atomically.

    Keeps slug, access, password, workspace, views and created_at; bumps rev
    (live viewers refresh) and updated_at; sets the title only when one is
    given. Returns (before, after, new_version), or None when the document
    vanished or changed owner meanwhile. The caller handles R2 publicity
    (:func:`apply_publicity`) and pruning (:func:`prune`)."""
    await ensure_current_row(db, raw)
    now = _now()
    sets: dict[str, Any] = {
        "blob_key": blob_key,
        "bundle_prefix": None,
        "mime": mime,
        "size_bytes": int(size_bytes),
        "original_filename": filename,
        "sha256": sha256,
        "media": media,
        "poster_key": poster_key,
        "updated_at": now,
        "file_updated_at": now,
    }
    if title is not None:
        sets["title"] = title.strip() or None
    before = await db["documents"].find_one_and_update(
        {"_id": raw["_id"], "owner_id": raw.get("owner_id"), "kind": "artifact"},
        {"$set": sets, "$inc": {"rev": 1, "file_version": 1}},
        return_document=False,
    )
    if before is None:
        return None
    version = current_version(before) + 1
    after = {**before, **sets, "rev": int(before.get("rev", 1)) + 1, "file_version": version}
    await _upsert_row(db, {
        "doc_id": str(raw["_id"]),
        "slug": after.get("slug"),
        "user_id": after.get("owner_id"),
        "version": version,
        "blob_key": blob_key,
        "size_bytes": int(size_bytes),
        "sha256": sha256,
        "mime": mime,
        "media": media,
        "poster_key": poster_key,
        "filename": filename,
        "created_at": now,
    })
    return before, after, version


def is_public(raw: dict, require_auth: bool = False) -> bool:
    """services/publicity.is_public: link, no password, not in a sign-in
    workspace, not expired."""
    from app.services import publicity

    return publicity.is_public(raw, require_auth=require_auth)


async def apply_publicity(before: dict, after: dict, *, new_blob_already: bool | None = None,
                          require_auth: bool = False, stamp_epoch: bool = False) -> None:
    """After a swap: the current blob and poster follow the document's access;
    the outgoing ones become non-public (old versions are never public).

    ``new_blob_already`` is the publicity the new object was created with, when
    known, so a 2 GB object isn't copied onto itself for nothing. The current
    objects carry the document's access epoch (``ae``).

    ``stamp_epoch``: rewrite the new current blob's metadata even when its
    publicity is already right — a *restored* version still carries the epoch
    it had when it was last current, and a signed link minted back then (before
    a narrowing) would match it again (C13)."""
    from app.services import publicity, r2

    public = is_public(after, require_auth)
    epoch = publicity.epoch_of(after)
    new_key, old_key = after.get("blob_key"), before.get("blob_key")
    if new_key and (new_blob_already is not public or stamp_epoch):
        await run_in_threadpool(r2.set_public, new_key, public, after.get("mime"), epoch)
    if after.get("poster_key"):
        await run_in_threadpool(r2.set_public, after["poster_key"], public, "image/jpeg", epoch)
    # The outgoing blob was public only if the document was; otherwise it is
    # already private and copying it onto itself would gain nothing.
    if is_public(before, require_auth) and not before.get("bundle_prefix"):
        if old_key and old_key != new_key:
            await run_in_threadpool(r2.set_public, old_key, False, before.get("mime"), epoch)
        old_poster = before.get("poster_key")
        if old_poster and old_poster != after.get("poster_key"):
            await run_in_threadpool(r2.set_public, old_poster, False, "image/jpeg", epoch)


# ── Pruning and deletion ──────────────────────────────────────────────────────


async def _unreferenced(db: AsyncIOMotorDatabase, keys: set[str]) -> list[str]:
    """Those of ``keys`` that no version row and no document points at."""
    out = []
    for key in keys:
        if not key:
            continue
        if await db[VERSIONS].count_documents({"$or": [{"blob_key": key}, {"poster_key": key}]}, limit=1):
            continue
        if await db["documents"].count_documents({"$or": [{"blob_key": key}, {"poster_key": key}]}, limit=1):
            continue
        out.append(key)
    return out


async def _delete_objects(keys: list[str]) -> None:
    from app.services import r2

    if not keys or not r2.is_configured():
        return
    for key in keys:
        await run_in_threadpool(r2.delete, key)


async def drop_rows(db: AsyncIOMotorDatabase, rows: list[dict]) -> list[str]:
    """Delete these version rows, then any blob or poster left unreferenced.
    Returns the R2 keys deleted."""
    if not rows:
        return []
    keys: set[str] = set()
    for r in rows:
        await db[VERSIONS].delete_one({"doc_id": r["doc_id"], "version": r["version"]})
        keys.add(r.get("blob_key") or "")
        keys.add(r.get("poster_key") or "")
    gone = await _unreferenced(db, keys)
    await _delete_objects(gone)
    return gone


async def prune(db: AsyncIOMotorDatabase, after: dict, extra: list[dict] | None = None) -> list[str]:
    """Drop ``extra`` (a quota plan), then everything beyond the newest
    ``file_versions_keep`` rows. Never the current version."""
    doc_id = str(after["_id"])
    cur = current_version(after)
    extra_versions = {r["version"] for r in (extra or []) if r["version"] != cur}
    rows = await db[VERSIONS].find({"doc_id": doc_id}).sort("version", -1).to_list(length=1000)
    keep = max(1, int(settings.file_versions_keep))
    survivors = [r for r in rows if r["version"] not in extra_versions]
    beyond = [r for r in survivors[keep:] if r["version"] != cur]
    victims = [r for r in rows if r["version"] in extra_versions] + beyond
    return await drop_rows(db, victims)


async def forget_document(db: AsyncIOMotorDatabase, doc_id: str, current: dict | None = None) -> list[str]:
    """A document is gone: delete its version rows and every blob and poster
    only they referenced (the caller still frees the current blob/bundle, as
    it always has; its poster is freed here). Returns the keys deleted."""
    rows = await db[VERSIONS].find({"doc_id": doc_id}).to_list(length=1000)
    keys: set[str] = set()
    for r in rows:
        keys.add(r.get("blob_key") or "")
        keys.add(r.get("poster_key") or "")
    await db[VERSIONS].delete_many({"doc_id": doc_id})
    if current:
        keys.add(current.get("poster_key") or "")
        keys.discard(current.get("blob_key") or "")  # the caller deletes it
    gone = await _unreferenced(db, keys)
    await _delete_objects(gone)
    return gone


async def log_event(db: AsyncIOMotorDatabase, *, user_id: str, slug: str, doc_id: str, action: str,
                    old_sha256: str | None, new_sha256: str | None, size_bytes: int,
                    version: int) -> None:
    """One row per upload / replace / restore. Never fails the request."""
    try:
        await db["file_events"].insert_one({
            "user_id": user_id, "slug": slug, "doc_id": doc_id, "action": action,
            "old_sha256": old_sha256, "new_sha256": new_sha256, "size_bytes": int(size_bytes),
            "version": int(version), "ts": _now(),
        })
    except Exception:  # pragma: no cover - logging must not fail a swap
        log.warning("file_events write failed", exc_info=True)


# ── Restore ───────────────────────────────────────────────────────────────────


async def restore(db: AsyncIOMotorDatabase, raw: dict, version: int) -> tuple[dict, dict, int] | None:
    """Make ``version`` current again, as a new version that points at the
    same blob (no copy). Returns (before, after, new_version); None when that
    version isn't kept. Restoring the current version changes nothing and
    returns (raw, raw, current)."""
    cur = current_version(raw)
    if version == cur:
        return raw, raw, cur
    row = await db[VERSIONS].find_one({"doc_id": str(raw["_id"]), "version": int(version)})
    if row is None:
        return None
    return await swap(
        db, raw,
        blob_key=row["blob_key"], size_bytes=int(row.get("size_bytes") or 0),
        mime=row.get("mime") or raw.get("mime"), filename=row.get("filename"),
        sha256=row.get("sha256"), media=row.get("media"), poster_key=row.get("poster_key"),
    )
