"""Publishing a docs site: snapshots, builds, reviews, restore, changes, assets.

Publishing freezes every current draft and the settings into an immutable
``docs_snapshots`` row, numbers a ``docs_builds`` row and queues a ``build``
job; the worker turns the snapshot into the live site and marks the build
live. Until then readers keep the previous build.

When a site requires review, an editor submits instead (one open review per
site) and an admin approves, which publishes the drafts as they are at
approval time, or asks for changes.

Restore re-points the site to an earlier successful build: no rebuild, drafts
untouched.
"""

from __future__ import annotations

import difflib

import bson
from bson import ObjectId
from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.models.user import User
from app.services import docs_site_assets as assets
from app.services import docs_site_pages as pages
from app.services import docs_site_store as store
from app.services.docs_site_jobs import enqueue_job
from app.services.docs_site_store import (ASSETS, BUILDS, JOBS, PAGES, REVIEWS, SITES, SNAPSHOTS, DocsError,
                                          aware, now)

settings = get_settings()

SNAPSHOT_MAX_BYTES = 15 * 1024 * 1024
# Settings that change what readers see (review rules don't).
_COMPARED_SETTINGS = ("theme", "ai", "access", "seo", "nav", "redirects")


# ── Changes since the live build ─────────────────────────────────────────────


def _lines_changed(old: str, new: str) -> int:
    n = 0
    for line in difflib.unified_diff(old.splitlines(), new.splitlines(), lineterm="", n=0):
        if line.startswith(("+++", "---", "@@")):
            continue
        n += 1
    return n


async def changes(db: AsyncIOMotorDatabase, site: dict) -> dict:
    snap = await pages.live_snapshot(db, site, markdown=True)
    live = {p.get("page_id"): p for p in (snap or {}).get("pages") or []}
    rows = await db[PAGES].find({"site_id": site["_id"], "deleted_at": None}).to_list(
        length=settings.docs_pages_per_site + 50)
    names = await store.user_names(db, [(r.get("draft") or {}).get("updated_by") for r in rows])
    out = []
    seen = set()
    for r in rows:
        pid = str(r["_id"])
        seen.add(pid)
        old = live.get(pid)
        draft = r.get("draft") or {}
        h = pages.content_hash(r)
        if old is not None and old.get("hash") == h:
            continue
        item = {
            "id": pid, "path": r.get("path"), "title": r.get("title"),
            "change": "added" if old is None else "modified",
            "updated_by": draft.get("updated_by"), "updated_by_name": names.get(draft.get("updated_by") or ""),
            "updated_at": aware(draft.get("updated_at")),
        }
        if old is not None:
            item["lines_changed"] = _lines_changed(old.get("markdown") or "", draft.get("markdown") or "")
            if old.get("path") != r.get("path"):
                item["moved_from"] = old.get("path")
        out.append(item)
    for pid, old in live.items():
        if pid not in seen:
            out.append({"id": pid, "path": old.get("path"), "title": old.get("title"), "change": "deleted"})
    current = site.get("settings") or {}
    before = (snap or {}).get("settings") or {}
    settings_changed = [k for k in _COMPARED_SETTINGS if snap is not None and current.get(k) != before.get(k)]
    site_meta = (snap or {}).get("site") or {}
    if snap is not None and site_meta.get("name") != site.get("name"):
        settings_changed.append("name")
    if snap is not None and site_meta.get("slug") != site.get("slug"):
        settings_changed.append("address")
    live_build = await db[BUILDS].find_one({"_id": site["live_build_id"]}) if site.get("live_build_id") else None
    return {
        "live_build": store.build_view(live_build),
        "last_published_at": aware(site.get("last_published_at")),
        "pages": out,
        "settings_changed": settings_changed,
        "count": len(out) + len(settings_changed),
        "ever_published": snap is not None,
    }


# ── Snapshot + build ──────────────────────────────────────────────────────────


async def _snapshot(db: AsyncIOMotorDatabase, site: dict, user: User) -> dict:
    rows = await db[PAGES].find({"site_id": site["_id"], "deleted_at": None}).sort("path", 1).to_list(
        length=settings.docs_pages_per_site + 50)
    if not rows:
        raise HTTPException(status_code=422, detail="Add a page before publishing.")
    snap = {
        "site_id": site["_id"],
        "site": {"name": site.get("name"), "slug": site.get("slug"), "url": store.site_url(site.get("slug")),
                 "workspace_id": site.get("workspace_id")},
        "pages": [{
            "page_id": str(r["_id"]),
            "path": r.get("path"),
            "title": r.get("title"),
            "description": r.get("description") or "",
            "icon": r.get("icon"),
            "hidden": bool(r.get("hidden")),
            "markdown": (r.get("draft") or {}).get("markdown") or "",
            "frontmatter_extra": (r.get("draft") or {}).get("frontmatter_extra") or {},
            "rev": (r.get("draft") or {}).get("rev"),
            "hash": pages.content_hash(r),
        } for r in rows],
        "settings": site.get("settings") or {},
        "created_by": user.id,
        "created_at": now(),
    }
    if len(bson.encode(snap)) > SNAPSHOT_MAX_BYTES:
        raise HTTPException(status_code=413, detail="This site is too large to publish in one snapshot.")
    res = await db[SNAPSHOTS].insert_one(snap)
    snap["_id"] = res.inserted_id
    return snap


def _public_only(site: dict) -> None:
    """Non-public sites aren't enforced at the edge yet: never put one live (see config)."""
    level = (((site.get("settings") or {}).get("access") or {}).get("level")) or "public"
    if level != "public" and not settings.docs_private_sites_enabled:
        raise HTTPException(status_code=409, detail="Password and members-only sites are coming soon. "
                                                    "Make the site public to publish it.")


async def publish(db: AsyncIOMotorDatabase, site: dict, role: str, user: User, *, note: str | None,
                  review_id: ObjectId | None = None, enforce_review: bool = True) -> dict:
    _public_only(site)
    if enforce_review and ((site.get("settings") or {}).get("review") or {}).get("required") \
            and not store.is_admin(role):
        raise DocsError(409, {"detail": "review required"})
    if await store.builds_today(db, site["_id"]) >= settings.docs_builds_per_day:
        raise HTTPException(status_code=429,
                            detail=f"The free plan has {settings.docs_builds_per_day} publishes per site per day. "
                                   "Try again tomorrow (UTC).")
    snap = await _snapshot(db, site, user)
    seq = await db[SITES].find_one_and_update({"_id": site["_id"]}, {"$inc": {"build_seq": 1}},
                                              {"build_seq": 1}, return_document=ReturnDocument.AFTER)
    number = int((seq or {}).get("build_seq") or 1)
    # A site from before build_seq, or a seq behind its builds, catches up.
    top = await db[BUILDS].find_one({"site_id": site["_id"]}, {"number": 1}, sort=[("number", -1)])
    if top and top["number"] >= number:
        number = top["number"] + 1
        await db[SITES].update_one({"_id": site["_id"]}, {"$max": {"build_seq": number}})
    at = now()
    build = {
        "site_id": site["_id"],
        "number": number,
        "status": "queued",
        "requested_by": user.id,
        "review_id": review_id,
        "note": (note or "").strip()[:500] or None,
        "snapshot_id": snap["_id"],
        "manifest_hash": None,
        "stats": None,
        "error": None,
        "created_at": at,
        "started_at": None,
        "finished_at": None,
    }
    try:
        res = await db[BUILDS].insert_one(build)
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="Another publish started at the same moment. Try again.") \
            from None
    build["_id"] = res.inserted_id
    job = await enqueue_job(db, "build", site["_id"], {
        "build_id": str(build["_id"]), "snapshot_id": str(snap["_id"]), "number": number})
    await db[BUILDS].update_one({"_id": build["_id"]}, {"$set": {"job_id": job["_id"]}})
    build["job_id"] = job["_id"]
    await store.log_event(db, "docs_published", site, user.id, build_id=str(build["_id"]), number=number,
                          pages=len(snap["pages"]), review_id=str(review_id) if review_id else None)
    names = await store.user_names(db, [user.id])
    return {**store.build_view(build, names), "job": store.job_view(job)}


# ── Reviews ───────────────────────────────────────────────────────────────────


def review_view(r: dict, names: dict[str, str]) -> dict:
    return {
        "id": str(r["_id"]),
        "site_id": str(r["site_id"]),
        "requested_by": r.get("requested_by"),
        "requested_by_name": names.get(r.get("requested_by") or ""),
        "note": r.get("note"),
        "page_ids": r.get("page_ids") or [],
        "status": r.get("status"),
        "decided_by": r.get("decided_by"),
        "decided_by_name": names.get(r.get("decided_by") or ""),
        "decided_at": aware(r.get("decided_at")),
        "comment": r.get("comment"),
        "build_id": str(r["build_id"]) if r.get("build_id") else None,
        "created_at": aware(r.get("created_at")),
    }


async def _review_out(db: AsyncIOMotorDatabase, r: dict) -> dict:
    return review_view(r, await store.user_names(db, [r.get("requested_by"), r.get("decided_by")]))


async def submit_review(db: AsyncIOMotorDatabase, site: dict, user: User, note: str | None) -> dict:
    ch = await changes(db, site)
    if ch["ever_published"] and not ch["count"]:
        raise HTTPException(status_code=422, detail="Nothing has changed since the last publish.")
    row = {
        "site_id": site["_id"],
        "requested_by": user.id,
        "note": (note or "").strip()[:2000],
        "page_ids": [p["id"] for p in ch["pages"]],
        "status": "open",
        "decided_by": None,
        "decided_at": None,
        "comment": None,
        "created_at": now(),
    }
    try:
        res = await db[REVIEWS].insert_one(row)
    except DuplicateKeyError:
        existing = await db[REVIEWS].find_one({"site_id": site["_id"], "status": "open"})
        raise DocsError(409, {"detail": "A review is already open for this site.",
                              "review": await _review_out(db, existing) if existing else None}) from None
    row["_id"] = res.inserted_id
    await store.log_event(db, "docs_review_submitted", site, user.id, review_id=str(row["_id"]),
                          pages=len(row["page_ids"]))
    return await _review_out(db, row)


async def _load_review(db: AsyncIOMotorDatabase, site: dict, review_id: str) -> dict:
    r = await db[REVIEWS].find_one({"_id": store.oid(review_id, "Review"), "site_id": site["_id"]})
    if r is None:
        raise HTTPException(status_code=404, detail="Review not found")
    return r


async def _decide(db: AsyncIOMotorDatabase, review: dict, status: str, user: User, comment: str | None) -> dict:
    res = await db[REVIEWS].find_one_and_update(
        {"_id": review["_id"], "status": "open"},
        {"$set": {"status": status, "decided_by": user.id, "decided_at": now(),
                  "comment": (comment or "").strip()[:2000] or None}},
        return_document=ReturnDocument.AFTER)
    if res is None:
        raise HTTPException(status_code=409, detail="This review isn't open any more.")
    return res


def _not_own(review: dict, role: str, user: User) -> None:
    """A reviewer decides other people's reviews; their own goes to someone else (an admin, who
    publishes directly anyway, may decide their own)."""
    if review.get("requested_by") == user.id and not store.is_admin(role):
        raise HTTPException(status_code=403, detail="Someone else has to review your own changes.")


async def approve_review(db: AsyncIOMotorDatabase, site: dict, role: str, user: User, review_id: str,
                         comment: str | None) -> dict:
    review = await _load_review(db, site, review_id)
    _not_own(review, role, user)
    decided = await _decide(db, review, "approved", user, comment)
    try:
        build = await publish(db, site, role, user, note=review.get("note") or comment,
                              review_id=review["_id"], enforce_review=False)
    except HTTPException:
        # Nothing was published: the review stays open for another try.
        await db[REVIEWS].update_one({"_id": review["_id"], "status": "approved"},
                                     {"$set": {"status": "open", "decided_by": None, "decided_at": None,
                                               "comment": None}})
        raise
    await db[REVIEWS].update_one({"_id": review["_id"]}, {"$set": {"build_id": ObjectId(build["id"])}})
    decided["build_id"] = ObjectId(build["id"])
    await store.log_event(db, "docs_review_approved", site, user.id, review_id=str(review["_id"]),
                          build_id=build["id"], requested_by=review.get("requested_by"))
    return {"review": await _review_out(db, decided), "build": build}


async def request_changes(db: AsyncIOMotorDatabase, site: dict, role: str, user: User, review_id: str,
                          comment: str | None) -> dict:
    review = await _load_review(db, site, review_id)
    _not_own(review, role, user)
    return await _review_out(db, await _decide(db, review, "changes_requested", user, comment))


async def withdraw_review(db: AsyncIOMotorDatabase, site: dict, role: str, user: User, review_id: str) -> dict:
    review = await _load_review(db, site, review_id)
    if review.get("requested_by") != user.id and not store.is_admin(role):
        raise HTTPException(status_code=403, detail="Only the person who submitted it, or an admin, can withdraw it.")
    return await _review_out(db, await _decide(db, review, "withdrawn", user, None))


async def list_reviews(db: AsyncIOMotorDatabase, site: dict, status: str | None) -> list[dict]:
    q: dict = {"site_id": site["_id"]}
    if status:
        q["status"] = status
    rows = await db[REVIEWS].find(q).sort("created_at", -1).to_list(length=50)
    names = await store.user_names(db, [r.get("requested_by") for r in rows] + [r.get("decided_by") for r in rows])
    return [review_view(r, names) for r in rows]


# ── Builds, restore, jobs ─────────────────────────────────────────────────────


async def list_builds(db: AsyncIOMotorDatabase, site: dict, limit: int = 50) -> list[dict]:
    rows = await db[BUILDS].find({"site_id": site["_id"]}).sort("number", -1).to_list(length=max(1, min(limit, 100)))
    names = await store.user_names(db, [r.get("requested_by") for r in rows])
    out = []
    for r in rows:
        v = store.build_view(r, names)
        v["live"] = site.get("live_build_id") == r["_id"]
        out.append(v)
    return out


async def restore_build(db: AsyncIOMotorDatabase, site: dict, user: User, build_id: str) -> dict:
    _public_only(site)
    build = await db[BUILDS].find_one({"_id": store.oid(build_id, "Build"), "site_id": site["_id"]})
    if build is None:
        raise HTTPException(status_code=404, detail="Build not found")
    if build.get("status") not in ("live", "superseded") or not build.get("manifest_hash"):
        raise HTTPException(status_code=409, detail="Only a build that went live can be restored.")
    if site.get("live_build_id") == build["_id"] and site.get("status") == "live":
        raise HTTPException(status_code=409, detail="That version is already live.")
    pending = await db[JOBS].find_one({"site_id": site["_id"], "kind": "restore",
                                       "status": {"$in": ["queued", "running"]}})
    if pending is not None:
        raise HTTPException(status_code=409, detail="A restore is already in progress.")
    job = await enqueue_job(db, "restore", site["_id"], {
        "build_id": str(build["_id"]), "number": build.get("number"), "manifest_hash": build["manifest_hash"],
        "requested_by": user.id})
    names = await store.user_names(db, [build.get("requested_by")])
    return {"build": store.build_view(build, names), "job": store.job_view(job)}


async def get_job(db: AsyncIOMotorDatabase, site: dict, job_id: str) -> dict:
    job = await db[JOBS].find_one({"_id": store.oid(job_id, "Job"), "site_id": site["_id"]})
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return store.job_view(job)


# ── Assets ────────────────────────────────────────────────────────────────────


async def upload_asset(db: AsyncIOMotorDatabase, site: dict, user: User, data: bytes,
                       filename: str | None) -> dict:
    if len(data) > settings.docs_asset_max_bytes:
        raise HTTPException(status_code=413,
                            detail=f"Files can be at most {settings.docs_asset_max_bytes // (1024 * 1024)} MB.")
    if not data:
        raise HTTPException(status_code=422, detail="That file is empty.")
    try:
        ext = assets.sniff(data, filename)
    except assets.AssetRejected as exc:
        raise HTTPException(status_code=415, detail=str(exc)) from None
    digest = assets.sha256(data)
    name = f"{digest}.{ext}"
    sid = str(site["_id"])
    existing = await db[ASSETS].find_one({"site_id": site["_id"], "sha256": digest})
    if existing is None:
        used = await store.storage_bytes(db, site["_id"])
        if used + len(data) > settings.docs_site_storage_bytes:
            raise HTTPException(status_code=413, detail="This site has used its 2 GB of storage.")
        if not assets.is_configured():
            raise HTTPException(status_code=503, detail="File uploads aren't available right now.")
        ok = await run_in_threadpool(assets.put_bytes, assets.key_for(sid, name), data, assets.TYPES[ext])
        if not ok:
            raise HTTPException(status_code=502, detail="The upload didn't go through. Try again.")
        row = {
            "site_id": site["_id"], "sha256": digest, "ext": ext, "name": name,
            "key": assets.key_for(sid, name), "url": assets.url_for(name), "size": len(data),
            "content_type": assets.TYPES[ext], "original_name": (filename or "")[:200] or None,
            "by": user.id, "created_at": now(),
        }
        try:
            await db[ASSETS].insert_one(row)
        except DuplicateKeyError:
            pass
    return {"url": assets.url_for(name), "name": name, "size": len(data), "content_type": assets.TYPES[ext],
            "sha256": digest}


async def upload_dark_asset(db: AsyncIOMotorDatabase, site: dict, user: User, data: bytes,
                            filename: str | None, for_url: str) -> dict:
    """The dark-theme version of an image already on this site (``for_url``: its
    ``/docs-assets/…`` address). Stored at the engine's dark address, ``x.png`` →
    ``x.dark.png``, in the image's own format (a different raster format is converted;
    an SVG stays SVG). One dark version per image: a new one replaces the old."""
    rel = assets.rel_of(for_url)
    dark_rel = assets.dark_name(rel) if rel else None
    if not rel or not dark_rel:
        raise HTTPException(status_code=422, detail="Add a dark version to an image uploaded to this site.")
    light = await db[ASSETS].find_one({"site_id": site["_id"], "name": rel})
    if light is None or not str(light.get("content_type") or "").startswith("image/"):
        raise HTTPException(status_code=422, detail="Add a dark version to an image uploaded to this site.")
    if len(data) > settings.docs_asset_max_bytes:
        raise HTTPException(status_code=413,
                            detail=f"Files can be at most {settings.docs_asset_max_bytes // (1024 * 1024)} MB.")
    if not data:
        raise HTTPException(status_code=422, detail="That file is empty.")
    try:
        ext = assets.sniff(data, filename)
    except assets.AssetRejected as exc:
        raise HTTPException(status_code=415, detail=str(exc)) from None
    want = dark_rel.rsplit(".", 1)[-1]
    if ext != want:
        converted = assets.convert_image(data, want) if ext in ("png", "jpg", "webp", "gif") else None
        if converted is None:
            raise HTTPException(status_code=415,
                                detail=f"Upload the dark version as {want.upper()}, like the original image.")
        data, ext = converted, want
    key = assets.key_for(str(site["_id"]), dark_rel)
    marker = f"{light.get('sha256') or rel}.dark"
    old = await db[ASSETS].find_one({"site_id": site["_id"], "sha256": marker}, {"size": 1})
    used = await store.storage_bytes(db, site["_id"]) - int((old or {}).get("size") or 0)
    if used + len(data) > settings.docs_site_storage_bytes:
        raise HTTPException(status_code=413, detail="This site has used its 2 GB of storage.")
    if not assets.is_configured():
        raise HTTPException(status_code=503, detail="File uploads aren't available right now.")
    ok = await run_in_threadpool(assets.put_bytes, key, data, assets.TYPES[ext], assets.SHORT)
    if not ok:
        raise HTTPException(status_code=502, detail="The upload didn't go through. Try again.")
    digest = assets.sha256(data)
    # The unique (site, sha256) key is "<image's sha256>.dark": one row per image's dark version.
    await db[ASSETS].update_one({"site_id": site["_id"], "sha256": marker}, {"$set": {
        "ext": ext, "name": dark_rel, "key": key, "url": assets.url_for(dark_rel), "size": len(data),
        "content_type": assets.TYPES[ext], "content_sha256": digest, "variant": "dark", "dark_for": rel,
        "original_name": (filename or "")[:200] or None, "by": user.id, "updated_at": now(),
    }, "$setOnInsert": {"created_at": now()}}, upsert=True)
    return {"url": assets.url_for(dark_rel), "name": dark_rel, "size": len(data), "content_type": assets.TYPES[ext],
            "sha256": digest, "variant": "dark", "for": assets.url_for(rel)}


async def asset_preview_url(db: AsyncIOMotorDatabase, site_id: str, name: str) -> str | None:
    if not assets.is_configured():
        return None
    row = await db[ASSETS].find_one({"site_id": store.oid(site_id), "name": name}, {"key": 1})
    if row is None:
        return None
    site = await db[SITES].find_one({"_id": store.oid(site_id), "deleted_at": None}, {"_id": 1})
    if site is None:
        return None
    return assets.presign_get(row["key"], 3600)
