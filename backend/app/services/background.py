"""Background loops for the access policy, each behind a Mongo lease so only
one API worker runs it (§5.1, §5.5, A6):

    revalidate   every 5 s   send due purge jobs from the outbox
    sweeper      every 60 s  destroy expired documents (bytes, versions, grants); abort lapsed uploads
    reconciler   every 60 s  re-derive dirty rows; a full pass once a day
    require_auth every 5 s   finish a workspace's sign-in change (Team → Locked and back) that a
                             stopped process left half done, or that a request wrote and died
                             before starting (services/lifecycle.py: run_require_auth)
    guide_insights  hourly   roll up Markdrop Guides' reader insights (services/guide_insights.py) and
                             reader signals (services/guide_signals.py), and re-detect each active
                             guide's Fix list once a day (services/guide_fixes.py)
    page_history    hourly   once a day: thin pages' version history and clean up page images
                             nothing references (services/page_history.py)
    trash        every 15 min  destroy what has been in the trash 30 days, or reached its own
                             expiry there (services/trash.py)
    notifications  every 30 s  send the batched mention / sign-off emails (services/notifications.py)
    push            every 5 s  send push notifications to people's devices (services/push.py)
    page_covers     every 15 s  finish auto-cover picks a stopped process left pending, and run one
                             batch of the admin's cover backfill (services/page_covers.py)
    search_index    every 10 s  global search's content index: the one-time backfill (a slice of
                             at most 8 s per pass), re-index what changed through a path without a
                             hook, extract file contents (HTML / PDF text, a few files per pass), and
                             every 10 minutes drop rows whose document is gone (services/search_index.py)
    meetings_backfill every 10 s  pick up "Import past meetings" queues a stopped process left
                             running, wake those that waited for the AI budget (services/meeting_backfill.py)
    meeting_memory  every 15 s  meetings' decisions, action items… as facts for the editor's "From
                             meetings" panel: re-derive a batch of meetings changed since (or never
                             derived: the backfill), drop facts of deleted meetings (services/meeting_memory.py)

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
    from app.services import file_uploads, lifecycle

    await lifecycle.sweep_expired(db)
    try:
        # Uploads (files and page images) nobody finished: abort their parts.
        await file_uploads.sweep_all_expired(db)
    except Exception:
        log.warning("sweeping lapsed uploads failed", exc_info=True)
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


async def _require_auth(db: AsyncIOMotorDatabase) -> None:
    from app.services import lifecycle

    await lifecycle.resume_require_auth(db)


async def _insights(db: AsyncIOMotorDatabase) -> None:
    from app.services import guide_fixes, guide_insights, guide_signals

    await guide_insights.rollup_due(db)
    await guide_signals.rollup_due(db)
    await guide_fixes.check_due(db)


async def _page_history(db: AsyncIOMotorDatabase) -> None:
    from app.services import page_history

    await page_history.run_due(db)


TRASH_EVERY = 900.0


async def _trash(db: AsyncIOMotorDatabase) -> None:
    from app.services import trash

    n = await trash.purge_due(db)
    if n:
        log.info("trash purge: %d item(s) deleted forever", n)


async def _notifications(db: AsyncIOMotorDatabase) -> None:
    from app.services import notifications

    await notifications.flush_emails(db)


async def _slack(db: AsyncIOMotorDatabase) -> None:
    from app.services import slack_notify

    await slack_notify.flush(db)


async def _push(db: AsyncIOMotorDatabase) -> None:
    from app.services import push

    await push.flush(db)


async def _page_covers(db: AsyncIOMotorDatabase) -> None:
    from app.services import page_covers

    await page_covers.background(db)


async def _meetings_backfill(db: AsyncIOMotorDatabase) -> None:
    from app.services import meeting_backfill, meetings

    await meeting_backfill.background(db)
    # Meetings from before covers and hidden transcripts: a batch per tick until none are left.
    await meetings.upgrade_tick(db)


async def _search_index(db: AsyncIOMotorDatabase) -> None:
    from app.services import search_index

    await search_index.background(db)


async def _meeting_memory(db: AsyncIOMotorDatabase) -> None:
    from app.services import meeting_memory

    await meeting_memory.background(db)


def start(get_db: Callable[[], AsyncIOMotorDatabase]) -> None:
    if not settings.background_workers_enabled or _TASKS:
        return
    loop = asyncio.get_running_loop()
    for name, every, body in (("revalidate", 5.0, _revalidate), ("sweeper", SWEEP_EVERY, _sweep),
                              ("reconciler", 60.0, _reconcile), ("require_auth", 5.0, _require_auth),
                              ("guide_insights", 3600.0, _insights),
                              ("page_history", 3600.0, _page_history), ("trash", TRASH_EVERY, _trash),
                              ("notifications", 30.0, _notifications), ("page_covers", 15.0, _page_covers),
                              ("search_index", 10.0, _search_index), ("slack_dm", 5.0, _slack),
                              ("push", 5.0, _push),
                              ("meetings_backfill", 10.0, _meetings_backfill),
                              ("meeting_memory", 15.0, _meeting_memory)):
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
