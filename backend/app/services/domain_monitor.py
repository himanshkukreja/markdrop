"""Scheduled re-verification of custom domains.

A verified domain used to stay verified forever: sold, repointed, or with its
TXT record deleted, it kept resolving, kept receiving tenant tokens and kept
its CORS grant. This re-reads every verified domain's TXT *and* routing record
once per `domain_recheck_interval_seconds` (daily by default); a run of failed
checks spanning `domain_lapse_after_hours` (72 h) lapses it
(`services/domain.lapse`).

Runs as an asyncio task in the app lifespan on every worker, but only one
worker does a pass: each wakes every `domain_recheck_poll_seconds`, and the
pass is guarded by a lease in Mongo (`job_leases`), whose expiry lets another
worker take over if the holder dies mid-pass. When the last pass finished is
also stored there, so a restart doesn't re-run a pass that just happened.
"""

from __future__ import annotations

import asyncio
import logging
import os
import socket
import secrets
from datetime import datetime, timedelta, timezone
from typing import Callable

from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.services import domain as domain_service

settings = get_settings()
log = logging.getLogger(__name__)

JOB_ID = "domain-recheck"
# Generous: a pass is DNS lookups, a few seconds per domain at worst.
LEASE_SECONDS = 30 * 60
# Hosts checked at once. DNS-bound, run in the threadpool.
CONCURRENCY = 4

_OWNER = f"{socket.gethostname()}:{os.getpid()}:{secrets.token_hex(3)}"
_task: asyncio.Task | None = None


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


async def acquire_lease(db: AsyncIOMotorDatabase, owner: str, now: datetime,
                        seconds: int = LEASE_SECONDS) -> bool:
    """Take the job's lease if it is free, expired, or already ours.

    The filter only matches a lease we may take; if the row exists and is held
    by someone else, the upsert tries to insert a second row with the same _id
    and the unique _id index refuses it — which is the "no" answer.
    """
    try:
        await db["job_leases"].find_one_and_update(
            {"_id": JOB_ID, "$or": [
                {"lease_until": {"$lte": now}},
                {"owner": owner},
                {"lease_until": None},
            ]},
            {"$set": {"owner": owner, "lease_until": now + timedelta(seconds=seconds)}},
            upsert=True,
        )
        return True
    except DuplicateKeyError:
        return False


async def release_lease(db: AsyncIOMotorDatabase, owner: str,
                        finished_at: datetime | None) -> None:
    update: dict = {"lease_until": None}
    if finished_at is not None:
        update["last_run_at"] = finished_at
    await db["job_leases"].update_one({"_id": JOB_ID, "owner": owner}, {"$set": update})


async def is_due(db: AsyncIOMotorDatabase, now: datetime) -> bool:
    row = await db["job_leases"].find_one({"_id": JOB_ID}, {"last_run_at": 1})
    last = _aware((row or {}).get("last_run_at"))
    return last is None or now - last >= timedelta(seconds=settings.domain_recheck_interval_seconds)


async def run_pass(db: AsyncIOMotorDatabase, now: datetime | None = None) -> dict[str, int]:
    """Re-check every verified domain (and retry detaching lapsed ones that are
    still attached). Returns a count per outcome."""
    now = now or domain_service._now()
    rows = await db["domains"].find(
        {"$or": [{"status": "verified"}, {"status": "lapsed", "attached": True}]}
    ).to_list(length=None)
    counts: dict[str, int] = {}
    sem = asyncio.Semaphore(CONCURRENCY)

    async def one(raw: dict) -> None:
        async with sem:
            try:
                outcome = await domain_service.recheck(db, raw, now)
            except Exception:  # one bad row must not stop the pass
                log.exception("domain re-check failed for %s", raw.get("host"))
                outcome = "error"
            counts[outcome] = counts.get(outcome, 0) + 1

    await asyncio.gather(*(one(r) for r in rows))
    return counts


async def tick(db: AsyncIOMotorDatabase, owner: str = _OWNER,
               now: datetime | None = None) -> dict[str, int] | None:
    """One wake-up: run a pass if one is due and the lease is ours. None when
    nothing ran (not due, or another worker holds the lease)."""
    now = now or domain_service._now()
    if not await is_due(db, now):
        return None
    if not await acquire_lease(db, owner, now):
        return None
    ran = False
    try:
        # Re-read under the lease: another worker may have finished a pass
        # between our due-check and taking the lease.
        if not await is_due(db, now):
            return None
        counts = await run_pass(db, now)
        ran = True
        log.info("domain re-check pass: %s", counts)
        return counts
    finally:
        await release_lease(db, owner, now if ran else None)


async def _loop(get_db: Callable[[], AsyncIOMotorDatabase]) -> None:
    # A little jitter so a fleet restarting together doesn't wake in lockstep.
    await asyncio.sleep(5 + secrets.randbelow(30))
    while True:
        try:
            await tick(get_db())
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("domain re-check tick failed")
        await asyncio.sleep(max(30, settings.domain_recheck_poll_seconds))


def start(get_db: Callable[[], AsyncIOMotorDatabase]) -> None:
    global _task
    if not settings.domain_recheck_enabled or _task is not None:
        return
    _task = asyncio.get_running_loop().create_task(_loop(get_db))


async def stop() -> None:
    global _task
    if _task is None:
        return
    _task.cancel()
    try:
        await _task
    except (asyncio.CancelledError, Exception):
        pass
    _task = None
