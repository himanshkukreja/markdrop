"""Markdrop Docs builds: enqueue (with coalescing), start, finish, restore.

A publish snapshots the drafts (``docs_snapshots``) and asks for a build
(``docs_builds`` + a ``docs_jobs`` row). The build runs elsewhere (GitHub
Actions or the Python worker, both through docs-platform/runner/run-job.mjs),
which publishes to the docs R2 bucket and reports the manifest hash back. Only
then is the build live: the site points at it, the build it replaced becomes
``superseded``, and every page in the snapshot gets its ``published`` copy.

Restore re-points the site at an earlier build's manifest (the store keeps every
manifest and object): one small R2 write, no rebuild; drafts don't change.
"""

from __future__ import annotations

import asyncio
import json
import os
from datetime import timedelta
from typing import Any

from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument

from app.services import docs_jobs
from app.services.docs_jobs import BUILDS, JOBS, PAGES, SITES, SNAPSHOTS, get_jobs_settings, now, oid

RESTORABLE = ("live", "superseded")


class RestoreError(Exception):
    pass


async def next_number(db: AsyncIOMotorDatabase, site_id: Any) -> int:
    """The site's next build number (an atomic counter on the site row)."""
    site = await db[SITES].find_one_and_update(
        {"_id": oid(site_id)}, {"$inc": {"build_seq": 1}}, projection={"build_seq": 1}, return_document=ReturnDocument.AFTER,
    )
    if site is None:
        raise LookupError("site not found")
    seq = int(site["build_seq"])
    # A site whose builds were numbered before the counter existed: continue after the highest.
    last = await db[BUILDS].find_one({"site_id": oid(site_id)}, sort=[("number", -1)], projection={"number": 1})
    if last and int(last.get("number") or 0) >= seq:
        seq = int(last["number"]) + 1
        await db[SITES].update_one({"_id": oid(site_id)}, {"$max": {"build_seq": seq}})
    return seq


async def builds_today(db: AsyncIOMotorDatabase, site_id: Any) -> int:
    """Builds that ran (or are queued to run) in the last 24 hours: the daily cap counts these."""
    since = now() - timedelta(days=1)
    return await db[BUILDS].count_documents({
        "site_id": oid(site_id), "created_at": {"$gte": since}, "status": {"$nin": ["superseded"]}, "coalesced": {"$ne": True},
    })


async def enqueue_build(
    db: AsyncIOMotorDatabase,
    *,
    site_id: Any,
    snapshot_id: Any,
    requested_by: Any,
    note: str | None = None,
    review_id: Any = None,
) -> tuple[dict, dict, bool]:
    """Create the build for a publish and get it run. Returns (build, job, coalesced).

    Coalescing: if the site already has a build job waiting (queued, not yet
    running), that job is pointed at this newer build and snapshot instead of
    queueing another, and the build it carried is marked ``superseded`` (never
    built). So a burst of publishes during a running build gives exactly one
    follow-up build, of the latest content."""
    t = now()
    sid = oid(site_id)
    number = await next_number(db, sid)
    build = {
        "site_id": sid,
        "number": number,
        "status": "queued",
        "requested_by": str(requested_by) if requested_by is not None else None,
        "review_id": oid(review_id) if review_id else None,
        "note": (note or None),
        "snapshot_id": oid(snapshot_id),
        "manifest_hash": None,
        "stats": None,
        "error": None,
        "created_at": t,
        "started_at": None,
        "finished_at": None,
    }
    build["_id"] = (await db[BUILDS].insert_one(build)).inserted_id
    payload = {"build_id": str(build["_id"]), "snapshot_id": str(build["snapshot_id"])}
    waiting = await db[JOBS].find_one_and_update(
        {"kind": "build", "site_id": sid, "status": "queued"},
        {"$set": {"payload": payload, "updated_at": t}},
        sort=[("created_at", 1)],
        return_document=ReturnDocument.BEFORE,
    )
    if waiting is not None:
        old = (waiting.get("payload") or {}).get("build_id")
        if old:
            await db[BUILDS].update_one(
                {"_id": oid(old), "status": "queued"},
                {"$set": {"status": "superseded", "coalesced": True, "error": f"replaced by build #{number} before it started", "finished_at": t}},
            )
        waiting["payload"] = payload
        await db[BUILDS].update_one({"_id": build["_id"]}, {"$set": {"job_id": waiting["_id"]}})
        return build, waiting, True
    job = await docs_jobs.insert_job(db, "build", sid, payload)
    await db[BUILDS].update_one({"_id": build["_id"]}, {"$set": {"job_id": job["_id"]}})
    build["job_id"] = job["_id"]
    return build, job, False


async def job_build(db: AsyncIOMotorDatabase, job: dict) -> dict | None:
    bid = (job.get("payload") or {}).get("build_id")
    return await db[BUILDS].find_one({"_id": oid(bid)}) if bid else None


async def start_build(db: AsyncIOMotorDatabase, job: dict) -> dict:
    """A runner claimed the job: the build is building. Checks the daily cap first.
    Raises LookupError when the build or its snapshot is gone, and
    PermissionError when the site is over its daily build limit."""
    build = await job_build(db, job)
    if build is None:
        raise LookupError("the job's build is missing")
    cap = get_jobs_settings().docs_builds_per_day
    if cap and build["status"] == "queued":
        since = now() - timedelta(days=1)
        ran = await db[BUILDS].count_documents({
            "site_id": build["site_id"], "_id": {"$ne": build["_id"]}, "started_at": {"$gte": since},
        })
        if ran >= cap:
            raise PermissionError(f"this site has had {ran} builds in the last 24 hours (limit {cap}); publish again later")
    await db[BUILDS].update_one(
        {"_id": build["_id"], "status": {"$in": ["queued", "building", "publishing"]}},
        {"$set": {"status": "building", "started_at": now(), "error": None}},
    )
    build["status"] = "building"
    return build


async def build_spec(db: AsyncIOMotorDatabase, job: dict, build: dict | None = None) -> dict:
    """What a runner needs for a build job (GET /internal/docs-jobs/{id}, or the worker's spec file)."""
    from app.services import docs_snapshot

    build = build or await job_build(db, job)
    if build is None:
        raise LookupError("the job's build is missing")
    b = await docs_snapshot.bundle(db, build)
    return {
        "job": {"id": str(job["_id"]), "kind": "build", "site_id": str(job["site_id"]), "attempt": int(job.get("attempts") or 1)},
        "build": {"id": str(build["_id"]), "number": build.get("number")},
        **b,
    }


def _clean_stats(stats: Any) -> dict | None:
    if not isinstance(stats, dict):
        return None
    out = {}
    for k in ("pages", "routes", "objects", "uploaded", "bytes", "total_bytes", "assets", "ms"):
        v = stats.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            out[k] = int(v)
    return out


async def finish_build(db: AsyncIOMotorDatabase, job: dict, worker: str | None, result: dict) -> dict:
    """The runner's result → the build (live or failed), the site pointer fields, the pages'
    published copies, the job. Returns the job's stored result."""
    build = await job_build(db, job)
    t = now()
    if build is None:
        await docs_jobs.fail(db, job["_id"], worker, "the job's build is missing")
        return {"ok": False}
    timings = result.get("timings") if isinstance(result.get("timings"), dict) else None
    runner_ms = result.get("runner_ms")
    minutes = int(-(-int(runner_ms) // 60000)) if isinstance(runner_ms, (int, float)) and runner_ms > 0 else None
    if not result.get("ok"):
        err = str(result.get("error") or "the build failed")[:2000]
        await db[BUILDS].update_one({"_id": build["_id"]}, {"$set": {"status": "failed", "error": err, "finished_at": t}})
        await docs_jobs.fail(db, job["_id"], worker, err, result={"build_id": str(build["_id"])})
        await _record_minutes(db, job, minutes)
        return {"ok": False, "error": err}
    manifest = str(result.get("manifest_hash") or "")
    if len(manifest) != 64:
        return await finish_build(db, job, worker, {"ok": False, "error": "the runner reported no manifest", "runner_ms": runner_ms})
    stats = _clean_stats(result.get("stats")) or {}
    site = await db[SITES].find_one({"_id": build["site_id"]}, {"live_build_id": 1})
    prev = site.get("live_build_id") if site else None
    await db[BUILDS].update_one({"_id": build["_id"]}, {"$set": {
        "status": "live", "manifest_hash": manifest, "stats": stats, "engine": result.get("engine"),
        "timings": timings, "error": None, "finished_at": t,
    }})
    if prev and prev != build["_id"]:
        await db[BUILDS].update_one({"_id": oid(prev), "status": "live"}, {"$set": {"status": "superseded", "superseded_at": t}})
    # Any other build still marked live (a restore raced this one) is superseded too.
    await db[BUILDS].update_many({"site_id": build["site_id"], "status": "live", "_id": {"$ne": build["_id"]}},
                                 {"$set": {"status": "superseded", "superseded_at": t}})
    await db[SITES].update_one({"_id": build["site_id"]}, {"$set": {
        "live_build_id": build["_id"], "last_published_at": t, "last_published_by": build.get("requested_by"),
        "status": "live", "updated_at": t,
    }})
    await _mark_published(db, build)
    out = {"ok": True, "build_id": str(build["_id"]), "number": build.get("number"), "manifest_hash": manifest,
           "unchanged": bool(result.get("unchanged")), "stats": stats}
    await docs_jobs.complete(db, job["_id"], worker, out)
    await _record_minutes(db, job, minutes)
    await docs_jobs.emit(db, "docs_site_published", build["site_id"], build.get("requested_by"),
                         build_id=str(build["_id"]), number=build.get("number"), pages=stats.get("pages"))
    return out


async def _record_minutes(db: AsyncIOMotorDatabase, job: dict, minutes: int | None) -> None:
    if minutes is not None and job.get("target") == "actions":
        await db[JOBS].update_one({"_id": job["_id"]}, {"$set": {"actions_minutes": minutes}})


async def _mark_published(db: AsyncIOMotorDatabase, build: dict) -> None:
    """Each page in the build's snapshot: published = what went live (by page id, else path)."""
    snap = await db[SNAPSHOTS].find_one({"_id": build["snapshot_id"]}, {"pages": 1})
    for p in (snap or {}).get("pages") or []:
        q: dict = {"site_id": build["site_id"]}
        if p.get("id") and oid(p["id"]):
            q["_id"] = oid(p["id"])
        elif p.get("path"):
            q["path"] = p["path"]
        else:
            continue
        await db[PAGES].update_one(q, {"$set": {"published": {
            "markdown": p.get("markdown") or "", "rev": p.get("rev"), "published_build_id": build["_id"],
            "title": p.get("title"), "description": p.get("description"),
        }}})


async def fail_build_job(db: AsyncIOMotorDatabase, job: dict, worker: str | None, error: str) -> None:
    build = await job_build(db, job)
    if build is not None:
        await db[BUILDS].update_one({"_id": build["_id"], "status": {"$nin": ["live", "superseded"]}},
                                    {"$set": {"status": "failed", "error": error[:2000], "finished_at": now()}})
    await docs_jobs.fail(db, job["_id"], worker, error)


# ── restore ─────────────────────────────────────────────────────────────────


def _r2():
    import boto3
    from botocore.config import Config

    s = get_jobs_settings()
    return boto3.client(
        "s3",
        endpoint_url=f"https://{s.docs_r2_account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=s.docs_r2_access_key_id,
        aws_secret_access_key=s.docs_r2_secret_access_key,
        region_name="auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 3}, connect_timeout=5, read_timeout=20),
    )


def point_site(store: Any, site: str, manifest: str, *, force: bool = False) -> dict:
    """Python twin of docs-platform/builder/store.mjs pointSite (same pointer JSON). ``store`` has
    get_text(key) -> str | None and put_text(key, text)."""
    from datetime import datetime, timezone

    if len(manifest) != 64 or any(c not in "0123456789abcdef" for c in manifest):
        raise RestoreError("bad manifest hash")
    raw = store.get_text(f"manifests/{manifest}.json")
    if raw is None:
        raise RestoreError(f"manifest {manifest[:12]} is not in the store")
    m = json.loads(raw)
    if not force and (m.get("site") or {}).get("id") not in (None, site):
        raise RestoreError(f"manifest {manifest[:12]} belongs to another site")
    cur_raw = store.get_text(f"sites/{site}/current.json")
    cur = json.loads(cur_raw) if cur_raw else None
    if cur and cur.get("manifest") == manifest:
        return {"site": site, "manifest": manifest, "unchanged": True, "previous": cur.get("previous")}
    ptr = {"manifest": manifest, "engine": m.get("engine"),
           "publishedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
           "previous": (cur or {}).get("manifest"), "restored": True}
    store.put_text(f"sites/{site}/current.json", json.dumps(ptr, separators=(",", ":")))
    return {"site": site, "manifest": manifest, "unchanged": False, "previous": ptr["previous"]}


class FsPointerStore:
    """get_text / put_text over a folder store (MARKDROP_DOCS_STORE_DIR: tests, self-host)."""

    def __init__(self, root: str):
        self.root = os.path.abspath(root)

    def _f(self, key: str) -> str:
        f = os.path.abspath(os.path.join(self.root, key))
        if not f.startswith(self.root + os.sep):
            raise RestoreError("bad key")
        return f

    def get_text(self, key: str) -> str | None:
        try:
            with open(self._f(key), encoding="utf-8") as fh:
                return fh.read()
        except FileNotFoundError:
            return None

    def put_text(self, key: str, text: str) -> None:
        f = self._f(key)
        os.makedirs(os.path.dirname(f), exist_ok=True)
        tmp = f"{f}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, f)


class R2PointerStore:
    """get_text / put_text over the docs bucket (boto3)."""

    def __init__(self, client=None, bucket: str | None = None):
        self.client = client or _r2()
        self.bucket = bucket or get_jobs_settings().docs_r2_bucket

    def get_text(self, key: str) -> str | None:
        try:
            return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read().decode()
        except Exception as e:  # botocore ClientError NoSuchKey
            code = getattr(e, "response", {}).get("Error", {}).get("Code")
            if code in ("NoSuchKey", "404", "NotFound"):
                return None
            raise

    def put_text(self, key: str, text: str) -> None:
        self.client.put_object(Bucket=self.bucket, Key=key, Body=text.encode(), ContentType="application/json")


async def restore_build(db: AsyncIOMotorDatabase, site_id: Any, build_id: Any, by: Any, *, store: Any = None) -> dict:
    """Make an earlier build live again: flip the site's pointer to its manifest, then record it.
    Only what is live changes; drafts don't. Raises RestoreError with a reason a person can read."""
    build = await db[BUILDS].find_one({"_id": oid(build_id), "site_id": oid(site_id)})
    if build is None:
        raise RestoreError("that build doesn't belong to this site")
    if build.get("status") not in RESTORABLE or not build.get("manifest_hash"):
        raise RestoreError("only a build that was live can be restored")
    site = await db[SITES].find_one({"_id": oid(site_id)}, {"live_build_id": 1})
    if site is None:
        raise RestoreError("site not found")
    if store is None and os.environ.get("MARKDROP_DOCS_STORE_DIR"):
        store = FsPointerStore(os.environ["MARKDROP_DOCS_STORE_DIR"])
    if store is None:
        if not get_jobs_settings().r2_configured:
            raise RestoreError("the docs bucket isn't configured on this server")
        store = R2PointerStore()
    res = await asyncio.to_thread(point_site, store, str(build["site_id"]), build["manifest_hash"])
    t = now()
    await db[BUILDS].update_many({"site_id": build["site_id"], "status": "live", "_id": {"$ne": build["_id"]}},
                                 {"$set": {"status": "superseded", "superseded_at": t}})
    await db[BUILDS].update_one({"_id": build["_id"]}, {"$set": {"status": "live", "restored_at": t, "restored_by": str(by) if by else None}})
    await db[SITES].update_one({"_id": build["site_id"]}, {"$set": {"live_build_id": build["_id"], "status": "live", "updated_at": t}})
    await docs_jobs.emit(db, "docs_site_restored", build["site_id"], by, build_id=str(build["_id"]), number=build.get("number"))
    return {"build_id": str(build["_id"]), "number": build.get("number"), "manifest_hash": build["manifest_hash"], "unchanged": res["unchanged"]}


async def request_restore(db: AsyncIOMotorDatabase, site_id: Any, build_id: Any, by: Any) -> dict:
    """For the API's POST /builds/{bid}/restore: inline when this server has the docs bucket keys
    (one small write), else a ``restore`` job for the local worker. Returns
    {"restored": {...}} or {"job_id": ...}."""
    if get_jobs_settings().r2_configured or os.environ.get("MARKDROP_DOCS_STORE_DIR"):
        return {"restored": await restore_build(db, site_id, build_id, by)}
    build = await db[BUILDS].find_one({"_id": oid(build_id), "site_id": oid(site_id)})
    if build is None or build.get("status") not in RESTORABLE or not build.get("manifest_hash"):
        raise RestoreError("only a build that was live can be restored")
    job = await docs_jobs.insert_job(db, "restore", site_id, {"build_id": str(build_id), "by": str(by) if by else None}, target="local")
    return {"job_id": str(job["_id"])}
