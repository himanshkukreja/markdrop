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
from contextlib import asynccontextmanager
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
from typing import AsyncIterator, Iterable

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
# How many purges are in flight at once — per flush and per worker pass (B-N4,
# B-R1): a mass expiry or a 50-document batch must not drain one RTT at a time.
CONCURRENCY = 8
LEASE = timedelta(seconds=30)
# Inline purges of the current request, collected by ``batch()`` (B-R1).
_BATCH: ContextVar[list[str] | None] = ContextVar("revalidate_batch", default=None)


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
        await _upsert_pending(db, key, payload, now)
    if attempt_now:
        _spawn(db, list(seen))
    return list(seen)


async def _upsert_pending(db: AsyncIOMotorDatabase, key: str, payload: dict, now: datetime) -> None:
    """One pending, unsent job for ``key`` (B-N1).

    A pending job nobody is sending yet covers this purge: it goes out after
    this write, so it purges the newer state anyway (a backoff due time is
    pulled forward to now). A job that is *leased* — being sent right now — may
    already have reached the frontend with the older state, so it never
    absorbs a newer purge: a second job is written instead. The generation
    (``gen``) makes the same true for a lease that expired mid-send: the
    sender only marks a job done when nothing was merged into it meanwhile."""
    await db[JOBS].update_one(
        # Scheduled jobs (``schedule``) are left alone: pulling one forward
        # would spend the purge that must happen at its due time.
        {"key": key, "state": "pending", "scheduled": {"$ne": True},
         "$or": [{"lease_until": None}, {"lease_until": {"$lt": now}}]},
        {"$setOnInsert": {"key": key, "payload": payload, "state": "pending",
                          "attempts": 0, "created_at": now},
         "$set": {"next_at": now, "updated_at": now},
         "$inc": {"gen": 1}},
        upsert=True,
    )


def _payload(key: str) -> dict | None:
    kind, _, value = key.partition(":")
    if kind == "doc" and _SLUG.match(value):
        return {"slug": value}
    if kind == "tag" and value:
        return {"tag": value}
    return None


async def rearm(db: AsyncIOMotorDatabase, keys: Iterable[str]) -> list[str]:
    """Re-enqueue jobs written *before* a state change (B-N1, transitions):
    the outbox row had to exist before the narrower row was written, but a
    worker may have claimed and sent it in between — with the old state. Called
    after the write, this guarantees one more send that sees the new state.
    Nothing is attempted here; the caller flushes."""
    now = _now()
    out: list[str] = []
    for key in dict.fromkeys(keys):
        payload = _payload(key)
        if payload is None:
            continue
        await _upsert_pending(db, key, payload, now)
        out.append(key)
    return out


async def schedule(
    db: AsyncIOMotorDatabase,
    *,
    at: datetime,
    slugs: Iterable[str | None] = (),
    tags: Iterable[str | None] = (),
) -> list[str]:
    """Purge jobs due at ``at`` rather than now — a document's expiry (B3):
    the cached render must go the moment the document does, not when the
    sweeper next passes. Sent by the revalidate worker (every few seconds)."""
    at = _aware(at)
    # Whole seconds (rounded up, never early): documents of one workspace that
    # expire in the same second share one listing purge (B-N4).
    if at.microsecond:
        at = at.replace(microsecond=0) + timedelta(seconds=1)
    keys: list[tuple[str, dict]] = []
    for slug in slugs:
        if slug and _SLUG.match(slug):
            keys.append((doc_key(slug), {"slug": slug}))
    for tag in tags:
        if tag:
            keys.append((tag_key(tag), {"tag": tag}))
    now = _now()
    out: list[str] = []
    for key, payload in dict(keys).items():
        await db[JOBS].update_one(
            {"key": key, "state": "pending", "scheduled": True, "next_at": at},
            {"$setOnInsert": {"payload": payload, "attempts": 0, "created_at": now,
                              "scheduled_for": at, "gen": 0},
             "$set": {"updated_at": now}},
            upsert=True,
        )
        out.append(key)
    return out


async def schedule_expiry(db: AsyncIOMotorDatabase, raw: dict) -> list[str]:
    """Purge(doc) at the document's ``expires_at`` (a second after it, so the
    API already answers 404 when the page is rebuilt)."""
    exp = _aware(raw.get("expires_at"))
    if exp is None:
        return []
    tags = [f"wsl:{raw['workspace_id']}"] if raw.get("workspace_id") else []
    old = [s for s in (raw.get("old_slugs") or []) if isinstance(s, str)]
    return await schedule(db, at=exp + timedelta(seconds=1), slugs=[raw.get("slug"), *old], tags=tags)


async def flush(db: AsyncIOMotorDatabase, keys: list[str], *, timeout: float = TIMEOUT_S) -> None:
    """Send these jobs now and wait (bounded) — for narrowing transitions,
    whose response must not come back while the old, wider render is still
    cached (B2). Also waits for a job of these keys that another sender is
    already sending (B-N1). A slow or failed attempt leaves the job in the
    outbox for the worker; the request is never failed by it. Sends that are
    still running when the bound is reached carry on in the background.

    Inside ``batch()`` the keys are only collected: the batch flushes once."""
    if not keys or not settings.page_revalidate_enabled:
        return
    collecting = _BATCH.get()
    if collecting is not None:
        collecting.extend(keys)
        return
    task = asyncio.get_running_loop().create_task(_drain(db, list(dict.fromkeys(keys))))
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    try:
        done, _pending = await asyncio.wait({task}, timeout=timeout)
    except asyncio.CancelledError:  # pragma: no cover - the request went away
        raise
    if not done:
        log.info("inline purge of %d key(s) still running after %.1fs; left to finish", len(keys), timeout)
    elif task.exception() is not None:
        log.warning("inline purge of %s failed; left to the worker", keys[:5], exc_info=task.exception())


async def _drain(db: AsyncIOMotorDatabase, keys: list[str]) -> None:
    """Send every due job of ``keys`` (bounded concurrency) and wait for the
    ones someone else is sending, until none of them is due."""
    give_up = _now() + LEASE * 2
    while _now() < give_up:
        await run_due(db, keys=keys, limit=max(1, len(keys)) * 2)
        now = _now()
        left = await db[JOBS].find(
            {"key": {"$in": keys}, "state": "pending", "next_at": {"$lte": now}},
            {"lease_until": 1}).to_list(length=len(keys) * 4 + 10)
        if not left:
            return
        if any(_aware(j.get("lease_until")) is None or _aware(j["lease_until"]) < now for j in left):
            continue  # claimable again (a newer purge arrived, or a lease lapsed)
        await asyncio.sleep(0.05)  # in flight elsewhere: wait for its outcome


@asynccontextmanager
async def batch(db: AsyncIOMotorDatabase, *, timeout: float = TIMEOUT_S) -> AsyncIterator[None]:
    """One bounded wait for a whole batch of narrowings (B-R1).

    Every inline ``flush`` inside the block (transitions, releases, deletes)
    only collects its keys; leaving the block sends them all at once with
    bounded concurrency under one ``timeout`` — instead of one ≈3 s wait per
    document. The flush runs even when the block raises: the documents changed
    before the error are narrower already and their purges are owed. Nested
    batches defer to the outermost one."""
    if _BATCH.get() is not None:
        yield
        return
    keys: list[str] = []
    token = _BATCH.set(keys)
    try:
        yield
    finally:
        _BATCH.reset(token)
        if keys:
            await flush(db, keys, timeout=timeout)


async def purge_doc(
    db: AsyncIOMotorDatabase,
    raw: dict,
    *,
    extra_slugs: Iterable[str | None] = (),
    listing: bool = True,
    inline: bool = False,
    attempt: bool = True,
) -> list[str]:
    """Purge(doc): the document's page/data cache, plus its workspace's
    folder listings when it is filed. ``inline``: send now and wait (bounded,
    ``flush``); ``attempt=False``: only write the jobs (the caller flushes
    once the new state is in the database — a purge sent before that would
    let the frontend re-cache the old state). Its old slugs (Q4) too: a cached render
    of an old slug is a redirect to the current one, which must not outlive a
    narrowing (it would show the new slug to someone who can no longer read
    the document)."""
    tags = [f"wsl:{raw['workspace_id']}"] if listing and raw.get("workspace_id") else []
    old = [s for s in (raw.get("old_slugs") or []) if isinstance(s, str)]
    keys = await enqueue(db, slugs=[raw.get("slug"), *extra_slugs, *old], tags=tags,
                         attempt_now=attempt and not inline)
    if inline:
        await flush(db, keys)
    return keys


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
    """Send one claimed job and record the outcome. Returns the new state.

    The outcome is recorded only if no newer purge was merged into the job
    while it was being sent (its ``gen`` is unchanged); otherwise the job goes
    straight back to pending, due now, so the newer state is purged too."""
    status = await _post(job["payload"])
    now = _now()
    if 200 <= status < 300:
        state, extra = "done", {"done_at": now, "purge_at": now + DONE_KEEP}
    elif 400 <= status < 500 and status not in (408, 425, 429):
        # The frontend refused the shape: retrying can't help.
        state, extra = "rejected", {"purge_at": now + GIVE_UP_AFTER, "last_status": status}
    elif now - (_aware(job.get("scheduled_for")) or _aware(job.get("created_at")) or now) > GIVE_UP_AFTER:
        state, extra = "dead", {"purge_at": now + GIVE_UP_AFTER, "last_status": status}
    else:
        attempts = int(job.get("attempts") or 0) + 1
        state, extra = "pending", {"attempts": attempts, "next_at": now + _backoff(attempts),
                                   "last_status": status}
    res = await db[JOBS].update_one(
        {"_id": job["_id"], "gen": job.get("gen")},
        {"$set": {"state": state, "updated_at": now, "lease_until": None, **extra}},
    )
    if res.matched_count == 0:
        await db[JOBS].update_one(
            {"_id": job["_id"]},
            {"$set": {"state": "pending", "next_at": now, "updated_at": now, "lease_until": None,
                      "last_status": status}},
        )
        return "pending"
    return state


async def _claim(db: AsyncIOMotorDatabase, query: dict) -> dict | None:
    now = _now()
    return await db[JOBS].find_one_and_update(
        {**query, "state": "pending", "next_at": {"$lte": now},
         "$or": [{"lease_until": None}, {"lease_until": {"$lt": now}}]},
        {"$set": {"lease_until": now + LEASE}},
        return_document=True,
    )


async def run_due(db: AsyncIOMotorDatabase, *, limit: int = 100, keys: list[str] | None = None,
                  concurrency: int = CONCURRENCY) -> int:
    """Send every due job (or only ``keys``), up to ``concurrency`` at a time
    (B-N4: a mass expiry must not drain one round trip after another).
    Returns how many were sent."""
    if not settings.page_revalidate_enabled:
        return 0
    query = {"key": {"$in": keys}} if keys else {}
    counter = {"n": 0}

    async def lane() -> None:
        while counter["n"] < limit:
            counter["n"] += 1
            job = await _claim(db, query)
            if job is None:
                counter["n"] -= 1
                return
            try:
                await _run_job(db, job)
            except Exception:  # pragma: no cover - a database hiccup; the lease lapses
                log.warning("sending purge job %s failed", job.get("key"), exc_info=True)

    lanes = max(1, min(concurrency, limit))
    await asyncio.gather(*(lane() for _ in range(lanes)))
    return counter["n"]


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
