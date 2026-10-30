"""The docs build queue: one row in ``docs_jobs`` per thing a builder must do.

Every job the API creates goes through :func:`enqueue_job`, so dispatching a
job to wherever builds run (a runner, a worker process) can hang off this one
place. Kinds:

- ``build``     payload ``{build_id, snapshot_id, number}``: build a snapshot, publish it, mark it live.
- ``import``    payload ``{source: "gitbook", url}``: import a site's pages into its drafts.
- ``restore``   payload ``{build_id, number, manifest_hash}``: re-point the site to an earlier build.
- ``unpublish`` payload ``{reason: "unpublish"|"delete"}``: take the site off its address.

A worker claims a row with ``findOneAndUpdate({status: "queued"} or an expired
``locked_until``) → running``; one running build per site at a time.
"""

from __future__ import annotations

from datetime import datetime, timezone

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

JOBS = "docs_jobs"
KINDS = ("build", "import", "restore", "unpublish")


async def enqueue_job(db: AsyncIOMotorDatabase, kind: str, site_id: str | ObjectId, payload: dict) -> dict:
    """Insert a queued job and return the row (with ``_id``)."""
    if kind not in KINDS:
        raise ValueError(f"unknown docs job kind {kind!r}")
    now = datetime.now(timezone.utc)
    row = {
        "kind": kind,
        "site_id": ObjectId(site_id) if not isinstance(site_id, ObjectId) else site_id,
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
    return row
