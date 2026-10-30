"""Markdrop Docs job queue: the ``docs_jobs`` collection (scratchpad specs/docs-phase1.md).

A job is a build (publish), a GitBook import, or a restore. The API inserts it
``queued``; the dispatcher (services/docs_dispatch.py) picks where it runs
(``target``: "actions" = a GitHub Actions run in the builder repo, "local" = the
Python worker, backend/scripts/docs_build_worker.py); whoever runs it claims it
here, renews the lock while it works, and finishes it.

    queued ──claim──▶ running ──complete──▶ done
       ▲                 │ └────fail─────▶ failed
       └──lock expired───┘ (a crashed runner; after max attempts: failed)

Rules every runner follows:
- A claim is one atomic ``find_one_and_update`` (queued, or running with an
  expired lock) → running + ``locked_by`` + ``locked_until`` + attempts + 1.
- One running build per site: a site with a running build (live lock) is
  skipped when claiming, and a race between two claims is settled by the
  older claim (the newer one hands its job back).
- The lock is renewed while the job runs (progress posts, a heartbeat); a
  runner that stops renewing loses the job to the next claim.

Runners outside the server (GitHub Actions) never see Mongo: they call
routers/docs_jobs_internal.py with a per-job HMAC token (``job_token``).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import time
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Any

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.services.docs_site_jobs import KINDS  # noqa: E402  (build, import, restore, unpublish)
from app.services.docs_site_store import ASSETS, BUILDS, JOBS, PAGES, SITES, SNAPSHOTS, VERSIONS  # noqa: E402,F401


class DocsJobsSettings(BaseSettings):
    """Env-only settings of the docs job pipeline (MARKDROP_ prefix, like the app)."""

    model_config = SettingsConfigDict(env_file=".env", env_prefix="MARKDROP_", extra="ignore")

    # Per-job tokens for runners outside the server (HMAC-SHA256). Blank: the
    # internal API refuses every runner (local worker only).
    docs_job_secret: str = ""
    docs_job_token_ttl_seconds: int = 3 * 3600
    # Base URL runners call back (blank: the app's api_base_url).
    docs_job_api_base: str = ""
    docs_job_lock_seconds: int = 120
    docs_job_max_attempts: int = 3
    # A job running longer than this (or queued and never picked up for this
    # long) is failed by the sweeper.
    docs_job_running_timeout_minutes: int = 25
    docs_job_queued_timeout_minutes: int = 180

    # Where sites are served (blank: "{slug}.<docs_sites_domain>"; a fixed host for a preview
    # Worker) and what their pages call for Ask AI (blank: api_base_url).
    docs_site_host_template: str = ""
    docs_ai_api: str = ""

    # Routing (services/docs_dispatch.py).
    docs_build_targets: str = "actions,local"
    docs_builder_repo: str = ""  # "owner/name" of the private builder repo
    docs_builder_token: str = ""  # fine-grained token: Actions read/write on that repo
    docs_builder_workflow: str = "docs-job.yml"
    docs_builder_ref: str = "main"
    docs_actions_monthly_minutes: int = 1800
    docs_dispatch_retry_minutes: int = 10
    docs_local_import_max_pages: int = 40
    # The local (API box) build guards: Node heap cap per process, the free
    # memory a build needs before it starts, a hard timeout, one at a time.
    # Measured (docs-platform/runner/README.md): with 1 render worker a build
    # peaks at 0.6-0.85 GB warm and up to 1.16 GB cold (RSS; SWC's native
    # memory sits outside the heap cap), so 1,200 MB free is the floor.
    docs_local_build_max_mb: int = 768
    docs_local_min_free_mb: int = 1200
    docs_local_build_timeout_seconds: int = 900
    # The docs bucket's keys are the app's (config.py docs_r2_*: MARKDROP_DOCS_R2_* or CF_ACCOUNT_ID /
    # R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY + MARKDROP_DOCS_R2_BUCKET).

    @property
    def targets(self) -> list[str]:
        return [t.strip() for t in self.docs_build_targets.split(",") if t.strip() in ("actions", "local")]

    @property
    def actions_configured(self) -> bool:
        return bool(self.docs_builder_repo and self.docs_builder_token and self.docs_builder_workflow)


@lru_cache(maxsize=1)
def get_jobs_settings() -> DocsJobsSettings:
    return DocsJobsSettings()


def now() -> datetime:
    return datetime.now(timezone.utc)


def aware(dt: datetime | None) -> datetime | None:
    """Motor hands back naive UTC datetimes; compare them as UTC."""
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def oid(v: Any) -> ObjectId | None:
    if isinstance(v, ObjectId):
        return v
    try:
        return ObjectId(str(v))
    except Exception:
        return None


# ── tokens ──────────────────────────────────────────────────────────────────


def _sig(secret: str, job_id: str, exp: int) -> str:
    mac = hmac.new(secret.encode(), f"docs-job:{job_id}:{exp}".encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac).decode().rstrip("=")


def job_token(job_id: str | ObjectId, ttl_seconds: int | None = None, *, secret: str | None = None) -> str:
    """``<expiry>.<hmac>``: good for this one job until the expiry."""
    s = get_jobs_settings()
    secret = s.docs_job_secret if secret is None else secret
    if not secret:
        raise RuntimeError("MARKDROP_DOCS_JOB_SECRET is not set")
    exp = int(time.time()) + int(ttl_seconds or s.docs_job_token_ttl_seconds)
    return f"{exp}.{_sig(secret, str(job_id), exp)}"


def verify_job_token(job_id: str, token: str | None, *, secret: str | None = None) -> bool:
    secret = get_jobs_settings().docs_job_secret if secret is None else secret
    if not secret or not token or "." not in token:
        return False
    exp_s, sig = token.split(".", 1)
    if not exp_s.isdigit() or int(exp_s) < time.time():
        return False
    return hmac.compare_digest(sig, _sig(secret, str(job_id), int(exp_s)))


# ── queue ───────────────────────────────────────────────────────────────────


async def insert_job(db: AsyncIOMotorDatabase, kind: str, site_id: Any, payload: dict, *, target: str | None = None) -> dict:
    """A job row (through docs_site_jobs.enqueue_job, so builds coalesce), optionally pre-routed."""
    from app.services.docs_site_jobs import enqueue_job

    job = await enqueue_job(db, kind, site_id, payload)
    if target is not None:
        await db[JOBS].update_one({"_id": job["_id"]}, {"$set": {"target": target, "routed_at": now()}})
        job["target"] = target
    return job


async def busy_sites(db: AsyncIOMotorDatabase) -> set:
    """Sites with a running build whose lock is live."""
    rows = db[JOBS].find({"kind": "build", "status": "running", "locked_until": {"$gt": now()}}, {"site_id": 1})
    return {r["site_id"] async for r in rows}


def _claimable(t: datetime, max_attempts: int) -> dict:
    return {
        "$or": [
            {"status": "queued"},
            {"status": "running", "locked_until": {"$lt": t}},
        ],
        "attempts": {"$lt": max_attempts},
    }


async def _settle_site_race(db: AsyncIOMotorDatabase, job: dict, worker: str) -> bool:
    """True when ``job`` (a build just claimed) may run: no other live build of
    its site claimed before it. Otherwise it is handed back to the queue."""
    if job["kind"] != "build":
        return True
    t = now()
    others = db[JOBS].find({
        "_id": {"$ne": job["_id"]}, "kind": "build", "site_id": job["site_id"],
        "status": "running", "locked_until": {"$gt": t},
    }, {"claimed_at": 1})
    mine = aware(job.get("claimed_at")) or t
    async for o in others:
        theirs = aware(o.get("claimed_at")) or t
        if theirs < mine or (theirs == mine and o["_id"] < job["_id"]):
            await release(db, job["_id"], worker)
            return False
    return True


async def claim_next(
    db: AsyncIOMotorDatabase,
    worker: str,
    *,
    kinds: tuple[str, ...] = KINDS,
    target: str | None = "local",
    skip: list | None = None,
) -> dict | None:
    """Claim the oldest runnable job (``target``: only jobs routed there; None:
    any). Builds of a busy site are skipped. Returns the claimed job or None."""
    s = get_jobs_settings()
    tried: list = list(skip or [])
    for _ in range(8):
        t = now()
        busy = await busy_sites(db)
        q: dict = {**_claimable(t, s.docs_job_max_attempts), "kind": {"$in": list(kinds)}}
        if target is not None:
            q["target"] = target
        if tried:
            q["_id"] = {"$nin": tried}
        if busy:
            q["$nor"] = [{"kind": "build", "site_id": {"$in": list(busy)}}]
        job = await db[JOBS].find_one_and_update(
            q,
            {"$set": {"status": "running", "locked_by": worker, "locked_until": t + timedelta(seconds=s.docs_job_lock_seconds),
                      "claimed_at": t, "updated_at": t}, "$inc": {"attempts": 1}},
            sort=[("created_at", 1)],
            return_document=True,
        )
        if job is None:
            return None
        if await _settle_site_race(db, job, worker):
            return job
        tried.append(job["_id"])
    return None


async def claim_job(db: AsyncIOMotorDatabase, job_id: Any, runner: str) -> tuple[dict | None, str]:
    """Claim one named job (a runner that was dispatched for it).

    Returns (job, "ok") or (None, reason): "missing", "finished", "taken"
    (another runner holds a live lock), "busy" (another build of the site is
    running), "exhausted" (out of attempts). A runner re-asking for a job it
    already holds gets it again ("ok")."""
    s = get_jobs_settings()
    _id = oid(job_id)
    if _id is None:
        return None, "missing"
    t = now()
    cur = await db[JOBS].find_one({"_id": _id})
    if cur is None:
        return None, "missing"
    if cur["status"] in ("done", "failed"):
        return None, "finished"
    if cur["status"] == "running" and cur.get("locked_by") == runner:
        job = await db[JOBS].find_one_and_update(
            {"_id": _id, "status": "running", "locked_by": runner},
            {"$set": {"locked_until": t + timedelta(seconds=s.docs_job_lock_seconds), "updated_at": t}},
            return_document=True,
        )
        return (job, "ok") if job else (None, "taken")
    if cur["kind"] == "build" and cur["site_id"] in await busy_sites(db):
        return None, "busy"
    job = await db[JOBS].find_one_and_update(
        {"_id": _id, **_claimable(t, s.docs_job_max_attempts)},
        {"$set": {"status": "running", "locked_by": runner, "locked_until": t + timedelta(seconds=s.docs_job_lock_seconds),
                  "claimed_at": t, "updated_at": t}, "$inc": {"attempts": 1}},
        return_document=True,
    )
    if job is None:
        cur = await db[JOBS].find_one({"_id": _id})
        if cur and cur.get("attempts", 0) >= s.docs_job_max_attempts and cur["status"] != "running":
            return None, "exhausted"
        return None, "taken"
    if not await _settle_site_race(db, job, runner):
        return None, "busy"
    return job, "ok"


async def renew(db: AsyncIOMotorDatabase, job_id: Any, worker: str) -> bool:
    s = get_jobs_settings()
    t = now()
    res = await db[JOBS].update_one(
        {"_id": oid(job_id), "status": "running", "locked_by": worker},
        {"$set": {"locked_until": t + timedelta(seconds=s.docs_job_lock_seconds), "updated_at": t}},
    )
    return res.matched_count == 1


async def set_progress(db: AsyncIOMotorDatabase, job_id: Any, worker: str, progress: dict) -> bool:
    """Record progress (and renew the lock). False when the job isn't this worker's any more."""
    s = get_jobs_settings()
    t = now()
    p = {
        "step": str(progress.get("step") or "")[:40],
        "done": int(progress.get("done") or 0),
        "total": int(progress.get("total") or 0),
        "message": str(progress.get("message") or "")[:200],
    }
    res = await db[JOBS].update_one(
        {"_id": oid(job_id), "status": "running", "locked_by": worker},
        {"$set": {"progress": p, "locked_until": t + timedelta(seconds=s.docs_job_lock_seconds), "updated_at": t}},
    )
    return res.matched_count == 1


async def release(db: AsyncIOMotorDatabase, job_id: Any, worker: str) -> bool:
    """Hand a claimed job back (shutdown, a lost site race): queued again, the attempt not counted."""
    t = now()
    res = await db[JOBS].update_one(
        {"_id": oid(job_id), "status": "running", "locked_by": worker},
        {"$set": {"status": "queued", "locked_by": None, "locked_until": None, "updated_at": t}, "$inc": {"attempts": -1}},
    )
    return res.matched_count == 1


async def complete(db: AsyncIOMotorDatabase, job_id: Any, worker: str | None, result: dict | None) -> bool:
    t = now()
    q: dict = {"_id": oid(job_id), "status": "running"}
    if worker is not None:
        q["locked_by"] = worker
    res = await db[JOBS].update_one(q, {"$set": {
        "status": "done", "result": result, "error": None, "locked_until": None, "finished_at": t, "updated_at": t,
    }})
    return res.matched_count == 1


async def fail(db: AsyncIOMotorDatabase, job_id: Any, worker: str | None, error: str, *, result: dict | None = None) -> bool:
    t = now()
    q: dict = {"_id": oid(job_id), "status": {"$in": ["running", "queued"]}}
    if worker is not None:
        q["locked_by"] = worker
    upd: dict = {"status": "failed", "error": str(error)[:2000], "locked_until": None, "finished_at": t, "updated_at": t}
    if result is not None:
        upd["result"] = result
    res = await db[JOBS].update_one(q, {"$set": upd})
    return res.matched_count == 1


async def exhausted_jobs(db: AsyncIOMotorDatabase) -> list[dict]:
    """Running jobs whose runner vanished (lock expired) and that are out of attempts."""
    s = get_jobs_settings()
    rows = db[JOBS].find({"status": "running", "locked_until": {"$lt": now()}, "attempts": {"$gte": s.docs_job_max_attempts}})
    return [r async for r in rows]


async def log_event(db: AsyncIOMotorDatabase, kind: str, site_id: Any, user_id: Any = None, **meta: Any) -> None:
    """A docs_events row (docs_build_live, docs_build_failed, docs_import_finished, docs_restored,
    docs_unpublished) through the API's event log. Never fails the caller."""
    from app.services import docs_site_store

    site = await db[SITES].find_one({"_id": oid(site_id)}, {"workspace_id": 1})
    await docs_site_store.log_event(db, kind, site, str(user_id) if user_id else None, **meta)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    """The routing index (the API's docs_site_store.ensure_indexes makes the rest)."""
    await db[JOBS].create_index([("status", 1), ("target", 1), ("created_at", 1)])
