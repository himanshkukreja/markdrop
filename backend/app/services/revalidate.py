"""Purge the frontend's cached renders — durably (access policy §5.1).

``/[slug]`` and a workspace's own domain are ISR / data-cached, so after any
access-affecting change the cached copy must be purged, or the next anonymous
visitor can be served the old (more open) render however long afterwards.

Every purge is a row in the ``revalidate_jobs`` outbox, written *in the same
request* (before the response, for a narrowing). It is attempted at once in the
background and then retried with backoff by a lease-holding worker
(services/background.py) until the frontend answers 2xx.

Job keys:

    doc:<slug>          POST {frontend}/api/revalidate {"slug": slug}
                        (revalidatePath("/<slug>") + revalidateTag("doc:<slug>"))
    tag:<tag>           POST {frontend}/api/revalidate {"tag": tag}
                        tags: wsl:<workspaceId> (folder listings),
                              host:<host> (host resolution / branding),
                              share:<shareId> (a shared folder page)

The frontend route accepts ``{"slug"}`` today; ``{"tag"}`` is new (integrator:
extend ``frontend/src/app/api/revalidate/route.ts`` to revalidateTag(tag) for
tags matching ``^(wsl|host|share):[A-Za-z0-9._:-]{1,200}$``). Until it does, tag
jobs get a 400, which is recorded as permanent ("rejected") rather than retried.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Iterable

import httpx
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings

settings = get_settings()
log = logging.getLogger(__name__)

JOBS = "revalidate_jobs"
TIMEOUT_S = 3.0
MAX_BACKOFF_S = 3600
GIVE_UP_AFTER = timedelta(days=7)
DONE_KEEP = timedelta(days=1)
_SLUG = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_TASKS: set[asyncio.Task] = set()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt):
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


# ── Enqueue ───────────────────────────────────────────────────────────────────


def doc_key(slug: str) -> str:
    return f"doc:{slug}"


def tag_key(tag: str) -> str:
    return f"tag:{tag}"


async def enqueue(
    db: AsyncIOMotorDatabase,
    *,
    slugs: Iterable[str | None] = (),
    tags: Iterable[str | None] = (),
    attempt_now: bool = True,
) -> list[str]:
    """Write one pending job per slug/tag (deduplicated against pending ones),
    then try them in the background. Returns the job keys written."""
    keys: list[tuple[str, dict]] = []
    for slug in slugs:
        if slug and _SLUG.match(slug):
            keys.append((doc_key(slug), {"slug": slug}))
    for tag in tags:
        if tag:
            keys.append((tag_key(tag), {"tag": tag}))
    if not keys:
        return []
    now = _now()
    seen: set[str] = set()
    for key, payload in keys:
        if key in seen:
            continue
        seen.add(key)
        # A pending job for the same key already covers this purge: the worker
        # sends it after this write, so it purges the newer state anyway. A due
        # time in the future (backoff) is pulled forward to now.
        await db[JOBS].update_one(
            {"key": key, "state": "pending"},
            {"$setOnInsert": {"key": key, "payload": payload, "state": "pending",
                              "attempts": 0, "created_at": now},
             "$set": {"next_at": now, "updated_at": now}},
            upsert=True,
        )
    if attempt_now:
        _spawn(db, list(seen))
    return list(seen)


async def purge_doc(
    db: AsyncIOMotorDatabase,
    raw: dict,
    *,
    extra_slugs: Iterable[str | None] = (),
    listing: bool = True,
) -> list[str]:
    """Purge(doc): the document's page/data cache, plus its workspace's
    folder listings when it is filed. Its old slugs (Q4) too: a cached render
    of an old slug is a redirect to the current one, which must not outlive a
    narrowing (it would show the new slug to someone who can no longer read
    the document)."""
    tags = [f"wsl:{raw['workspace_id']}"] if listing and raw.get("workspace_id") else []
    old = [s for s in (raw.get("old_slugs") or []) if isinstance(s, str)]
    return await enqueue(db, slugs=[raw.get("slug"), *extra_slugs, *old], tags=tags)


def page(slug: str | None) -> None:
    """Legacy fire-and-forget purge of one page (kept for old callers);
    prefer :func:`enqueue`, which survives a failed attempt."""
    if not slug or not settings.page_revalidate_enabled:
        return
    try:
        task = asyncio.get_running_loop().create_task(_post({"slug": slug}))
    except RuntimeError:
        return
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)


# ── Sending ───────────────────────────────────────────────────────────────────


async def _post(payload: dict) -> int:
    """POST one purge. Returns the HTTP status (0 when nothing answered)."""
    url = f"{settings.frontend_url.rstrip('/')}/api/revalidate"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            r = await client.post(url, json=payload)
            return r.status_code
    except Exception:
        log.info("revalidate failed for %s", payload, exc_info=True)
        return 0


def _backoff(attempts: int) -> timedelta:
    return timedelta(seconds=min(MAX_BACKOFF_S, 5 * (2 ** min(attempts, 12))))


async def _run_job(db: AsyncIOMotorDatabase, job: dict) -> str:
    """Send one claimed job and record the outcome. Returns the new state."""
    status = await _post(job["payload"])
    now = _now()
    if 200 <= status < 300:
        state, extra = "done", {"done_at": now, "purge_at": now + DONE_KEEP}
    elif 400 <= status < 500 and status not in (408, 425, 429):
        # The frontend refused the shape: retrying can't help.
        state, extra = "rejected", {"purge_at": now + GIVE_UP_AFTER, "last_status": status}
    elif now - (_aware(job.get("created_at")) or now) > GIVE_UP_AFTER:
        state, extra = "dead", {"purge_at": now + GIVE_UP_AFTER, "last_status": status}
    else:
        attempts = int(job.get("attempts") or 0) + 1
        state, extra = "pending", {"attempts": attempts, "next_at": now + _backoff(attempts),
                                   "last_status": status}
    await db[JOBS].update_one(
        {"_id": job["_id"]},
        {"$set": {"state": state, "updated_at": now, "lease_until": None, **extra}},
    )
    return state


async def _claim(db: AsyncIOMotorDatabase, query: dict) -> dict | None:
    now = _now()
    return await db[JOBS].find_one_and_update(
        {**query, "state": "pending", "next_at": {"$lte": now},
         "$or": [{"lease_until": None}, {"lease_until": {"$lt": now}}]},
        {"$set": {"lease_until": now + timedelta(seconds=30)}},
        return_document=True,
    )


async def run_due(db: AsyncIOMotorDatabase, *, limit: int = 100, keys: list[str] | None = None) -> int:
    """Send every due job (or only ``keys``). Returns how many were sent."""
    if not settings.page_revalidate_enabled:
        return 0
    sent = 0
    query = {"key": {"$in": keys}} if keys else {}
    while sent < limit:
        job = await _claim(db, query)
        if job is None:
            break
        await _run_job(db, job)
        sent += 1
    return sent


def _spawn(db: AsyncIOMotorDatabase, keys: list[str]) -> None:
    """The immediate attempt, off the request path."""
    if not settings.page_revalidate_enabled or not keys:
        return
    try:
        task = asyncio.get_running_loop().create_task(run_due(db, keys=keys, limit=len(keys)))
    except RuntimeError:
        return
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)


async def pending_keys(db: AsyncIOMotorDatabase) -> set[str]:
    """Keys with a pending job (tests and diagnostics)."""
    rows = await db[JOBS].find({"state": "pending"}, {"key": 1}).to_list(length=100_000)
    return {r["key"] for r in rows}


async def all_keys(db: AsyncIOMotorDatabase) -> set[str]:
    rows = await db[JOBS].find({}, {"key": 1}).to_list(length=100_000)
    return {r["key"] for r in rows}
