"""Where Markdrop Docs jobs run, and getting them started.

Targets (MARKDROP_DOCS_BUILD_TARGETS, default "actions,local"):

- ``actions``: a GitHub Actions run in the private builder repo
  (MARKDROP_DOCS_BUILDER_REPO / _TOKEN / _WORKFLOW / _REF), started with
  ``workflow_dispatch`` {job_id, site_id, kind, api_base, token}. The run calls
  routers/docs_jobs_internal.py with the per-job token; Mongo never leaves the
  server.
- ``local``: the Python worker (backend/scripts/docs_build_worker.py), which
  claims jobs routed to it. On the API box it runs with guards (one build at a
  time, a free-memory floor, nice/ionice, a Node heap cap, a hard timeout).

Routing:
- restore, unpublish, access → the server: a pointer flip, a few deletes or a
  small access-policy write in R2, run
  inline by whichever process holds the docs bucket keys (the API, right after
  the job is queued; else the local worker).
- import → Actions, always (GIF → clip conversion included). An import fetches
  whatever the given site and its llms.txt point at, so it never runs on the
  API box, and the API never fetches the source itself. With Actions
  unavailable the job waits unrouted (``route_reason`` says why) until Actions
  is back; the sweeper fails it after MARKDROP_DOCS_JOB_QUEUED_TIMEOUT_MINUTES
  with that reason. An import an older API routed "local" is routed again.
  (MARKDROP_DOCS_LOCAL_IMPORT_MAX_PAGES is no longer read.)
- build → Actions; local only when Actions is unavailable (not configured, the
  dispatch call failing, or the month's minutes budget
  MARKDROP_DOCS_ACTIONS_MONTHLY_MINUTES used up, counted from the jobs' own
  timings). A fallback build that the local guards keep waiting goes back to
  Actions once Actions works again.

The sweeper (same loop): re-dispatches Actions jobs that never started (a run
that was cancelled or never queued), puts back jobs whose runner vanished,
fails jobs out of attempts or running/queued far too long.
"""

from __future__ import annotations

import asyncio
import logging
import os
import socket
from datetime import datetime, timedelta
from typing import Any, Callable

import httpx
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument

from app.config import get_settings
from app.services import docs_jobs
from app.services.docs_jobs import JOBS, get_jobs_settings, now, oid

log = logging.getLogger(__name__)

GITHUB_API = "https://api.github.com"
EST_MINUTES_IN_FLIGHT = 3  # a dispatched run not finished yet counts this much against the budget
FALLBACK_RECHECK = timedelta(minutes=2)
DOWN_FOR = timedelta(minutes=5)

SERVER_KINDS = ("restore", "unpublish", "access")
HOLDER = f"api:{socket.gethostname()}:{os.getpid()}"

_state: dict[str, Any] = {"down_until": None, "down_reason": None}
_TASK: list[asyncio.Task] = []


def _month_start(t: datetime) -> datetime:
    return t.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


async def actions_minutes_used(db: AsyncIOMotorDatabase, t: datetime | None = None) -> int:
    """Minutes this month: finished Actions jobs (their own timings, rounded up per job, as GitHub
    bills) plus an estimate for runs still in flight."""
    t = t or now()
    rows = db[JOBS].aggregate([
        {"$match": {"target": "actions", "finished_at": {"$gte": _month_start(t)}}},
        {"$group": {"_id": None, "m": {"$sum": {"$ifNull": ["$actions_minutes", EST_MINUTES_IN_FLIGHT]}}}},
    ])
    used = 0
    async for r in rows:
        used = int(r.get("m") or 0)
    in_flight = await db[JOBS].count_documents({"target": "actions", "status": {"$in": ["queued", "running"]},
                                                "dispatched_at": {"$ne": None}})
    return used + in_flight * EST_MINUTES_IN_FLIGHT


async def actions_status(db: AsyncIOMotorDatabase) -> tuple[bool, str]:
    s = get_jobs_settings()
    if "actions" not in s.targets:
        return False, "actions is not a build target"
    if not s.actions_configured:
        return False, "the builder repo isn't configured"
    if not s.docs_job_secret:
        return False, "MARKDROP_DOCS_JOB_SECRET isn't set"
    down = _state["down_until"]
    if down and down > now():
        return False, f"dispatch failing: {_state['down_reason']}"
    used = await actions_minutes_used(db)
    if s.docs_actions_monthly_minutes and used >= s.docs_actions_monthly_minutes:
        return False, f"this month's Actions minutes are used ({used}/{s.docs_actions_monthly_minutes})"
    return True, "ok"


async def choose_target(db: AsyncIOMotorDatabase, job: dict) -> tuple[str | None, str]:
    """(target, reason) for a queued job; target None = nowhere can take it now."""
    s = get_jobs_settings()
    local = "local" in s.targets
    actions_ok, why = await actions_status(db)
    kind = job["kind"]
    if kind in SERVER_KINDS:
        return "local", f"{kind} runs on the server"
    if kind == "import":
        # Never local (module docstring): an import waits for Actions.
        if actions_ok:
            return "actions", "import"
        return None, f"imports run on GitHub Actions, which is unavailable: {why}"
    if actions_ok:
        return "actions", "build"
    return ("local", f"fallback: {why}") if local else (None, why)


async def route(db: AsyncIOMotorDatabase, job: dict) -> str | None:
    target, reason = await choose_target(db, job)
    if target is None:
        if job["kind"] == "import" and job.get("route_reason") != reason:
            # Waiting: the job says why (and the sweeper's failure, if it comes to that, too).
            await db[JOBS].update_one({"_id": job["_id"], "status": "queued", "target": None},
                                      {"$set": {"route_reason": reason, "updated_at": now()}})
        return None
    t = now()
    got = await db[JOBS].find_one_and_update(
        {"_id": job["_id"], "status": "queued", "target": job.get("target")},
        {"$set": {"target": target, "route_reason": reason, "routed_at": t, "fallback": reason.startswith("fallback"),
                  "dispatched_at": None, "updated_at": t}},
        return_document=ReturnDocument.AFTER,
    )
    if got:
        log.info("docs job %s (%s) → %s: %s", job["_id"], job["kind"], target, reason)
    return target if got else None


async def run_server_job_here(db: AsyncIOMotorDatabase, job: dict, holder: str = HOLDER) -> bool:
    """Run a restore / unpublish in this process when it holds the docs bucket keys."""
    from app.services import docs_build

    if not docs_build.store_available():
        return False
    claimed, _why = await docs_jobs.claim_job(db, job["_id"], holder)
    if claimed is None:
        return False
    res = await docs_build.run_server_job(db, claimed, holder)
    log.info("docs %s job %s ran inline: %s", job["kind"], job["_id"], "ok" if res.get("ok") else res.get("error"))
    return True


def api_base() -> str:
    return (get_jobs_settings().docs_job_api_base or get_settings().api_base_url).rstrip("/")


async def dispatch_actions(db: AsyncIOMotorDatabase, job: dict, *, client: httpx.AsyncClient | None = None) -> tuple[bool, str]:
    """workflow_dispatch for one job. (ok, detail)."""
    s = get_jobs_settings()
    token = docs_jobs.job_token(job["_id"])
    body = {
        "ref": s.docs_builder_ref,
        "inputs": {"job_id": str(job["_id"]), "site_id": str(job["site_id"]), "kind": job["kind"], "api_base": api_base(), "token": token},
    }
    url = f"{GITHUB_API}/repos/{s.docs_builder_repo}/actions/workflows/{s.docs_builder_workflow}/dispatches"
    headers = {"authorization": f"Bearer {s.docs_builder_token}", "accept": "application/vnd.github+json",
               "x-github-api-version": "2022-11-28", "user-agent": "markdrop-docs-dispatch"}
    try:
        if client is None:
            async with httpx.AsyncClient(timeout=15.0) as c:
                r = await c.post(url, json=body, headers=headers)
        else:
            r = await client.post(url, json=body, headers=headers)
    except Exception as e:
        return False, f"network: {type(e).__name__}"
    if r.status_code in (200, 201, 204):
        return True, "dispatched"
    return False, f"HTTP {r.status_code}: {r.text[:200]}"


async def _dispatch_one(db: AsyncIOMotorDatabase, job: dict, *, client: httpx.AsyncClient | None = None) -> bool:
    t = now()
    # Claim the dispatch (two API workers never send two runs for one try).
    stale = t - timedelta(minutes=get_jobs_settings().docs_dispatch_retry_minutes)
    got = await db[JOBS].find_one_and_update(
        {"_id": job["_id"], "status": "queued", "target": "actions",
         "$or": [{"dispatched_at": None}, {"dispatched_at": {"$lt": stale}}]},
        {"$set": {"dispatched_at": t, "updated_at": t}, "$inc": {"dispatch_attempts": 1}},
        return_document=ReturnDocument.AFTER,
    )
    if got is None:
        return False
    ok, detail = await dispatch_actions(db, got, client=client)
    if ok:
        await db[JOBS].update_one({"_id": got["_id"]}, {"$set": {"dispatch_error": None}})
        log.info("docs job %s dispatched to Actions (try %s)", got["_id"], got.get("dispatch_attempts"))
        return True
    log.warning("docs job %s: dispatch failed: %s", got["_id"], detail)
    _state["down_until"] = now() + DOWN_FOR
    _state["down_reason"] = detail
    await db[JOBS].update_one({"_id": got["_id"]}, {"$set": {"dispatch_error": detail, "dispatched_at": None}})
    # Somewhere else to go?
    if "local" in get_jobs_settings().targets:
        await route(db, {**got, "dispatched_at": None})
    return False


async def kick(db: AsyncIOMotorDatabase, job_id: Any = None, *, site_id: Any = None) -> None:
    """Route and dispatch now (after the API queues a job, or a site's build finishes) instead of
    on the next sweep. Best effort."""
    try:
        q: dict = {"status": "queued"}
        if job_id is not None:
            q["_id"] = oid(job_id)
        if site_id is not None:
            q["site_id"] = oid(site_id)
        async for job in db[JOBS].find(q).sort("created_at", 1).limit(20):
            await _advance(db, job, await docs_jobs.busy_sites(db))
    except Exception:
        log.warning("docs dispatch kick failed", exc_info=True)


async def _advance(db: AsyncIOMotorDatabase, job: dict, busy: set, *, client: httpx.AsyncClient | None = None) -> None:
    if job["kind"] == "import" and job.get("target") == "local":
        # Routed by an API from before imports were Actions-only: unroute it, then route it again.
        res = await db[JOBS].update_one({"_id": job["_id"], "status": "queued", "target": "local"},
                                        {"$set": {"target": None, "updated_at": now()}})
        if not res.modified_count:
            return
        job = {**job, "target": None}
    if job.get("target") is None:
        target = await route(db, job)
        if target is None:
            return
        job = {**job, "target": target, "dispatched_at": None}
    if job["target"] == "actions":
        if job["kind"] == "build" and job["site_id"] in busy:
            return  # dispatched when the running build of this site reports
        ok, _why = await actions_status(db)
        if not ok:
            # Actions went away (budget, outage, config): somewhere else, or keep waiting
            # (an import always waits for Actions).
            if "local" in get_jobs_settings().targets and job["kind"] != "import":
                await route(db, job)
            return
        await _dispatch_one(db, job, client=client)
    elif job["target"] == "local" and job["kind"] in SERVER_KINDS:
        await run_server_job_here(db, job)
    elif job["target"] == "local" and job.get("fallback") and job["kind"] == "build":
        routed = docs_jobs.aware(job.get("routed_at"))
        if routed and now() - routed > FALLBACK_RECHECK and (await actions_status(db))[0]:
            await route(db, job)  # back to Actions


async def run_once(db: AsyncIOMotorDatabase, *, client: httpx.AsyncClient | None = None) -> dict:
    """One sweep: fail what can't finish, put back what lost its runner, route and dispatch."""
    s = get_jobs_settings()
    t = now()
    stats = {"failed": 0, "requeued": 0, "advanced": 0}
    from app.services import docs_build

    for job in await docs_jobs.exhausted_jobs(db):
        err = f"the job stopped responding {job.get('attempts')} times"
        if job["kind"] == "build":
            await docs_build.fail_build_job(db, job, None, err)
        else:
            await docs_jobs.fail(db, job["_id"], None, err)
        stats["failed"] += 1
    too_long = t - timedelta(minutes=s.docs_job_running_timeout_minutes)
    async for job in db[JOBS].find({"status": "running", "claimed_at": {"$lt": too_long}}):
        err = f"the job ran longer than {s.docs_job_running_timeout_minutes} minutes"
        if job["kind"] == "build":
            await docs_build.fail_build_job(db, job, None, err)
        else:
            await docs_jobs.fail(db, job["_id"], None, err)
        stats["failed"] += 1
    stale = t - timedelta(minutes=s.docs_job_queued_timeout_minutes)
    async for job in db[JOBS].find({"status": "queued", "created_at": {"$lt": stale}}):
        err = f"no builder picked the job up in {s.docs_job_queued_timeout_minutes} minutes"
        if job.get("target") is None and job.get("route_reason"):
            err += f": {job['route_reason']}"
        if job["kind"] == "build":
            await docs_build.fail_build_job(db, job, None, err)
        else:
            await docs_jobs.fail(db, job["_id"], None, err)
        stats["failed"] += 1
    # An Actions runner that vanished mid-job: nobody will ask for it again unless it is re-sent.
    res = await db[JOBS].update_many(
        {"status": "running", "target": "actions", "locked_until": {"$lt": t}, "attempts": {"$lt": s.docs_job_max_attempts}},
        {"$set": {"status": "queued", "locked_by": None, "locked_until": None, "dispatched_at": None, "updated_at": t}},
    )
    stats["requeued"] = res.modified_count
    # A site whose access policy the edge doesn't hold yet: its access job again (a private site
    # must never stay public because one write failed).
    from app.services import docs_site_access

    stats["access_retried"] = await docs_site_access.requeue_unsynced(db)
    busy = await docs_jobs.busy_sites(db)
    async for job in db[JOBS].find({"status": "queued"}).sort("created_at", 1).limit(100):
        await _advance(db, job, busy, client=client)
        stats["advanced"] += 1
    return stats


async def _loop(get_db: Callable[[], AsyncIOMotorDatabase], every: float) -> None:
    from app.services import background

    while True:
        try:
            db = get_db()
            if await background.acquire(db, "docs_dispatch", timedelta(seconds=max(30.0, every * 3))):
                await run_once(db)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.warning("docs dispatch loop failed", exc_info=True)
        await asyncio.sleep(every)


def start(get_db: Callable[[], AsyncIOMotorDatabase], every: float = 10.0) -> None:
    """From the app lifespan (and the worker). Off with background workers off."""
    if not get_settings().background_workers_enabled or _TASK:
        return
    _TASK.append(asyncio.get_running_loop().create_task(_loop(get_db, every)))


async def stop() -> None:
    for t in _TASK:
        t.cancel()
    for t in _TASK:
        try:
            await t
        except (asyncio.CancelledError, Exception):
            pass
    _TASK.clear()


def reset_state() -> None:
    """Tests: forget a recorded dispatch outage."""
    _state["down_until"] = None
    _state["down_reason"] = None

