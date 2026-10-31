"""Background loops for the access policy, each behind a Mongo lease so only
one API worker runs it (§5.1, §5.5, A6):

    revalidate   every 5 s   send due purge jobs from the outbox
    sweeper      every 60 s  destroy expired documents (bytes, versions, grants)
    reconciler   every 60 s  re-derive dirty rows; a full pass once a day
    guide_insights  hourly   roll up Markdrop Guides' reader insights (services/guide_insights.py)

Started from the app lifespan when ``MARKDROP_BACKGROUND_WORKERS_ENABLED`` (on
by default; tests leave it off and call the loop bodies directly).
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
import socket
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable

from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.config import get_settings

settings = get_settings()
log = logging.getLogger(__name__)

LEASES = "leases"
HOLDER = f"{socket.gethostname()}:{os.getpid()}:{secrets.token_hex(3)}"
_TASKS: list[asyncio.Task] = []


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def acquire(db: AsyncIOMotorDatabase, name: str, ttl: timedelta, holder: str = HOLDER) -> bool:
    """Take or renew the lease ``name``. True when this process holds it."""
    now = _now()
    try:
        row = await db[LEASES].find_one_and_update(
            {"_id": name, "$or": [{"holder": holder}, {"until": {"$lt": now}}]},
            {"$set": {"holder": holder, "until": now + ttl}},
            upsert=True, return_document=True,
        )
    except DuplicateKeyError:
        return False  # someone else holds it (the upsert collided with their row)
    return bool(row and row.get("holder") == holder)


async def _loop(name: str, every: float, get_db: Callable[[], AsyncIOMotorDatabase],
                body: Callable[[AsyncIOMotorDatabase], Awaitable[object]]) -> None:
    ttl = timedelta(seconds=max(30.0, every * 3))
    while True:
        try:
            db = get_db()
            if await acquire(db, name, ttl):
                await body(db)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.warning("background loop %s failed", name, exc_info=True)
        await asyncio.sleep(every)


async def _revalidate(db: AsyncIOMotorDatabase) -> None:
    from app.services import revalidate

    await revalidate.run_due(db, limit=200)


SWEEP_EVERY = 60.0


async def _sweep(db: AsyncIOMotorDatabase) -> None:
    """Destroy what has expired; then, for documents expiring before the next
    pass, wait for each and sweep again (B3) — the policy says gone *at*
    expires_at, so a 60 s pass must not mean up to 60 s of late deletion."""
    from app.services import lifecycle

    await lifecycle.sweep_expired(db)
    deadline = _now() + timedelta(seconds=SWEEP_EVERY)
    while True:
        nxt = await lifecycle.next_expiry(db, deadline - _now())
        if nxt is None:
            return
        await asyncio.sleep(max(0.0, (nxt - _now()).total_seconds()) + 0.5)
        await lifecycle.sweep_expired(db)


_last_full: dict[str, datetime] = {}


async def _reconcile(db: AsyncIOMotorDatabase) -> None:
    from app.services import lifecycle

    full = _now() - _last_full.get("t", datetime.min.replace(tzinfo=timezone.utc)) > timedelta(days=1)
    await lifecycle.reconcile_once(db, full=full)
    if full:
        _last_full["t"] = _now()


async def _insights(db: AsyncIOMotorDatabase) -> None:
    from app.services import guide_insights

    await guide_insights.rollup_due(db)


def start(get_db: Callable[[], AsyncIOMotorDatabase]) -> None:
    if not settings.background_workers_enabled or _TASKS:
        return
    loop = asyncio.get_running_loop()
    for name, every, body in (("revalidate", 5.0, _revalidate), ("sweeper", SWEEP_EVERY, _sweep),
                              ("reconciler", 60.0, _reconcile), ("guide_insights", 3600.0, _insights)):
        _TASKS.append(loop.create_task(_loop(name, every, get_db, body)))


async def stop() -> None:
    for t in _TASKS:
        t.cancel()
    for t in _TASKS:
        try:
            await t
        except (asyncio.CancelledError, Exception):
            pass
    _TASKS.clear()
