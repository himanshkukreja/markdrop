"""The docs build queue: one row in ``docs_jobs`` per thing a builder must do.

Every job the API creates goes through :func:`enqueue_job`, so dispatching a
job to wherever builds run (a runner, a worker process) can hang off this one
place. Kinds:

- ``build``     payload ``{build_id, snapshot_id, number}``: build a snapshot, publish it, mark it live.
- ``import``    payload ``{source: "gitbook", url}``: import a site's pages into its drafts.
- ``restore``   payload ``{build_id, number, manifest_hash}``: re-point the site to an earlier build.
- ``unpublish`` payload ``{reason, slug, hosts?}``: take the site off its addresses (and the
                ``hosts`` a build published to). Idempotent; a waiting one absorbs a new one.
- ``access``    payload ``{reason}``: write the site's access policy for the edge
                (services/docs_site_access.py). Idempotent; a waiting one absorbs a new one.
- ``cf_host``   payload ``{reason, hosts}``: attach / detach the site's free address on Cloudflare
                (services/docs_cf_hosts.py). Idempotent; a waiting one absorbs a new one.

A worker claims a row with ``findOneAndUpdate({status: "queued"} or an expired
``locked_until``) → running``; one running build per site at a time.

Builds coalesce: when the site already has a build job waiting (queued, not
running yet), a new publish points that job at the newer build instead of
queueing another, and the build it carried becomes ``superseded`` (never
built). A burst of publishes during a running build gives one follow-up build,
of the latest content. Every new job is then handed to the dispatcher
(services/docs_dispatch.py), which routes it (Actions or the local worker) and
starts it.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument

JOBS = "docs_jobs"
BUILDS = "docs_builds"
KINDS = ("build", "import", "restore", "unpublish", "access", "cf_host")

log = logging.getLogger(__name__)
_KICKS: set[asyncio.Task] = set()


async def enqueue_job(db: AsyncIOMotorDatabase, kind: str, site_id: str | ObjectId, payload: dict) -> dict:
    """Insert a queued job (or, for a build, update the site's waiting one) and return the row."""
    if kind not in KINDS:
        raise ValueError(f"unknown docs job kind {kind!r}")
    now = datetime.now(timezone.utc)
    sid = ObjectId(site_id) if not isinstance(site_id, ObjectId) else site_id
    if kind == "build":
        waiting = await _coalesce(db, sid, dict(payload or {}), now)
        if waiting is not None:
            return waiting
    if kind == "access":
        # It writes whatever the policy is when it runs: one waiting job covers any number of changes.
        waiting = await db[JOBS].find_one({"kind": "access", "site_id": sid, "status": "queued"})
        if waiting is not None:
            return waiting
    if kind in ("unpublish", "cf_host"):
        # Idempotent: one waiting job covers another (with the extra hosts it names).
        extra = [h for h in (payload or {}).get("hosts") or [] if isinstance(h, str)]
        waiting = await db[JOBS].find_one_and_update(
            {"kind": kind, "site_id": sid, "status": "queued"},
            {"$addToSet": {"payload.hosts": {"$each": extra}}, "$set": {"updated_at": now}},
            return_document=ReturnDocument.AFTER)
        if waiting is not None:
            return waiting
    row = {
        "kind": kind,
        "site_id": sid,
        "payload": dict(payload or {}),
        "status": "queued",
        "attempts": 0,
        "locked_by": None,
        "locked_until": None,
        "progress": None,
        "result": None,
        "error": None,
        "created_at": now,
        "updated_at": now,
    }
    res = await db[JOBS].insert_one(row)
    row["_id"] = res.inserted_id
    _kick(db, row["_id"])
    return row


async def _coalesce(db: AsyncIOMotorDatabase, site_id: ObjectId, payload: dict, now: datetime) -> dict | None:
    """Point the site's waiting build job at this newer build. Returns that job (with the new
    payload), or None when no build job is waiting."""
    before = await db[JOBS].find_one_and_update(
        {"kind": "build", "site_id": site_id, "status": "queued"},
        {"$set": {"payload": payload, "updated_at": now}},
        sort=[("created_at", 1)],
        return_document=ReturnDocument.BEFORE,
    )
    if before is None:
        return None
    old = (before.get("payload") or {}).get("build_id")
    if old and old != payload.get("build_id"):
        try:
            await db[BUILDS].update_one(
                {"_id": ObjectId(old), "status": "queued"},
                {"$set": {"status": "superseded", "coalesced": True, "finished_at": now,
                          "error": f"Replaced by version {payload.get('number')} before it was built."}})
        except Exception:  # a malformed id must not fail the publish
            log.warning("docs build coalesce: couldn't mark %s superseded", old)
    return {**before, "payload": payload, "updated_at": now}


def _kick(db: AsyncIOMotorDatabase, job_id: ObjectId) -> None:
    """Route and start the job now, in the background, rather than on the dispatcher's next pass."""
    from app.config import get_settings

    if not get_settings().background_workers_enabled:
        return
    try:
        from app.services import docs_dispatch

        task = asyncio.get_running_loop().create_task(docs_dispatch.kick(db, job_id))
    except RuntimeError:  # no running loop: the dispatcher's pass picks it up
        return
    _KICKS.add(task)
    task.add_done_callback(_KICKS.discard)
