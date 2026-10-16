"""Admin Journeys: live visitors, people, their timelines, session replays, paths and the funnel,
and per-page clicks and reading depth, read from PostHog.

Read-only and admin-only. The PostHog personal API key stays on the server
(services/posthog_api.py); the console never talks to PostHog directly. Document references in
events (`doc_ref`) are resolved to titles and slugs here, from our own database
(services/doc_ref.py), since PostHog never has them.

Every data endpoint answers HTTP 200 `{configured: false, status}` while PostHog isn't set up,
so the console shows its setup card instead of an error. Upstream failures come back as
502/503/504/429/424 with `{detail, scope, reason, retry_in}` (and Retry-After while PostHog's
breaker is open); never 401/403 (a 401 signs the admin out). When the last good answer stands in
for a failed PostHog call, the 200 answer carries `stale: {age_s, as_of, reason, message,
retry_in}` (services/posthog_api.py).
"""

import math
import re
import time
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.routers.admin import get_db, require_admin
from app.services import journeys as jm
from app.services import posthog_api as ph
from app.services.doc_ref import resolve_refs

settings = get_settings()
router = APIRouter(prefix="/api/v1/admin/journeys", tags=["admin"])

_RECORDING_ID = re.compile(r"^[0-9A-Za-z-]{8,64}$")


def _resolver(db: AsyncIOMotorDatabase) -> jm.DocResolver:
    async def resolve(refs: set[str]) -> dict[str, dict]:
        docs = await resolve_refs(db, refs)
        return {r: {k: d.get(k) for k in ("slug", "title", "kind", "encrypted")} for r, d in docs.items()}

    return resolve


def _error(e: ph.PostHogError) -> JSONResponse:
    body = {"detail": e.message, "scope": e.scope, "reason": e.reason}
    headers = None
    if e.retry_after:
        body["retry_in"] = max(1, math.ceil(e.retry_after))
        headers = {"Retry-After": str(body["retry_in"])}
    return JSONResponse(body, status_code=e.status, headers=headers)


async def _answer(fn: Callable[[], Awaitable[object]]):
    """Run a data endpoint: not-configured shape, PostHog errors mapped, and `stale` added when
    part of the answer is a last good result standing in for a failed PostHog call."""
    if not settings.posthog_configured:
        return ph.not_configured()
    notes = ph.track_stale()
    try:
        res = await fn()
    except ph.PostHogError as e:
        return _error(e)
    if isinstance(res, dict):
        res = dict(res)
        notes = notes + list(res.pop("_stale_notes", None) or [])
        stale = ph.stale_summary(notes)
        if stale:
            res["stale"] = stale
    return res


@router.get("/status")
async def status(_: dict = Depends(require_admin)):
    return ph.status()


@router.get("/live")
async def live(db: AsyncIOMotorDatabase = Depends(get_db), _: dict = Depends(require_admin)):
    return await _answer(lambda: jm.live(_resolver(db)))


@router.get("/live/feed")
async def live_feed(
    since: str | None = Query(None, max_length=40),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """Everything the Live section shows, in one poll (shared by every admin for a few seconds).
    `since` is the `cursor` of the previous answer: only newer events come back."""
    cursor = None
    if since:
        try:
            cursor = datetime.fromisoformat(since.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=400, detail="since must be an ISO timestamp") from None
        if cursor.tzinfo is None:
            cursor = cursor.replace(tzinfo=timezone.utc)
    return await _answer(lambda: jm.live_feed(_resolver(db), cursor))


@router.get("/people")
async def people(
    days: int = 30,
    kind: str = Query("all", pattern="^(all|identified|anonymous)$"),
    q: str | None = Query(None, max_length=200),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    return await _answer(lambda: jm.people(_resolver(db), jm.clamp_days(days, 30), kind, (q or "").strip()[:80] or None))


@router.get("/person")
async def person(
    id: str = Query(..., min_length=1, max_length=200),
    days: int = 30,
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    async def find_account(distinct_ids: list[str], email: str | None) -> dict | None:
        """The Markdrop account behind a signed-in person: distinct id = user id."""
        ids = [ObjectId(d) for d in distinct_ids if ObjectId.is_valid(d) and len(d) == 24]
        query: dict = {"_id": {"$in": ids}} if ids else {"email": email} if email else None
        if not query:
            return None
        u = await db["users"].find_one(query, {"_id": 1, "email": 1, "name": 1, "created_at": 1})
        if not u and ids and email:
            u = await db["users"].find_one({"email": email}, {"_id": 1, "email": 1, "name": 1, "created_at": 1})
        if not u:
            return None
        docs = await db["documents"].count_documents({"owner_id": str(u["_id"])})
        created = u.get("created_at")
        return {
            "id": str(u["_id"]),
            "email": u.get("email"),
            "name": u.get("name"),
            "created_at": created.isoformat() if hasattr(created, "isoformat") else created,
            "documents": docs,
        }

    async def run():
        res = await jm.person(_resolver(db), find_account, id, jm.clamp_days(days, 30))
        if res is None:
            return JSONResponse({"detail": "No events for this person in PostHog", "scope": None}, status_code=404)
        return res

    return await _answer(run)


@router.get("/recordings")
async def recordings(
    days: int = 7,
    offset: int = Query(0, ge=0, le=5000),
    person: str | None = Query(None, max_length=64),
    path: str | None = Query(None, max_length=300),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    if person and not jm.is_uuid(person):
        raise HTTPException(status_code=400, detail="person must be a PostHog person id")
    if path and not jm.valid_page_key(path):
        raise HTTPException(status_code=400, detail="path must start with / (or be a doc:<ref> key)")
    return await _answer(
        lambda: jm.recordings(_resolver(db), days=jm.clamp_days(days, 7), offset=offset, person=person, path=path)
    )


# Live replays poll for new blobs every ~12 s. Each poll costs one or two REST calls against
# PostHog's 1,200 an hour, so at most LIVE_VIEWERS recordings are followed at once.
LIVE_VIEWERS = 2
LIVE_IDLE_S = 45.0
_live_viewers: dict[str, float] = {}


def _claim_live(recording_id: str) -> float | None:
    """Register a live poll; seconds to wait when LIVE_VIEWERS other recordings are followed."""
    now = time.monotonic()
    for k, t in list(_live_viewers.items()):
        if now - t > LIVE_IDLE_S:
            _live_viewers.pop(k, None)
    if recording_id not in _live_viewers and len(_live_viewers) >= LIVE_VIEWERS:
        return LIVE_IDLE_S - (now - min(_live_viewers.values()))
    _live_viewers[recording_id] = now
    return None


@router.get("/recordings/{recording_id}/snapshots")
async def snapshots(
    recording_id: str,
    after: int | None = Query(None, ge=0, le=1_000_000),
    _: dict = Depends(require_admin),
):
    """A recording's rrweb events. With `after` (the `last_key` of an earlier answer) only newer
    blobs: how the live player follows an ongoing recording."""
    if not _RECORDING_ID.match(recording_id):
        raise HTTPException(status_code=400, detail="Invalid recording id")
    if after is not None and settings.posthog_configured:
        wait = _claim_live(recording_id)
        if wait is not None:
            retry = max(1, math.ceil(wait))
            return JSONResponse(
                {"detail": f"{LIVE_VIEWERS} live replays are already being followed; close one first.",
                 "scope": None, "reason": "live_viewers", "retry_in": retry},
                status_code=429,
                headers={"Retry-After": str(retry)},
            )

    async def run():
        snap = await ph.snapshots(recording_id, after=after)
        body = {
            "configured": True,
            "id": recording_id,
            "found": snap is not None,
            "events": (snap or {}).get("events") or [],
            "last_key": (snap or {}).get("last_key"),
            "live_edge": (snap or {}).get("live_edge"),
            "after": after,
            "app_url": ph.app_url(f"/replay/{recording_id}"),
        }
        # Recordings are large and personal; never let a shared cache keep one.
        return JSONResponse(body, headers={"Cache-Control": "private, no-store"})

    return await _answer(run)


@router.get("/paths")
async def paths(days: int = 7, db: AsyncIOMotorDatabase = Depends(get_db), _: dict = Depends(require_admin)):
    return await _answer(lambda: jm.paths(_resolver(db), jm.clamp_days(days, 7)))


@router.get("/page")
async def page(
    path: str = Query(..., max_length=300),
    days: int = 30,
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    key = path.split("?")[0].split("#")[0]
    if not jm.valid_page_key(key):
        raise HTTPException(status_code=400, detail="path must start with / (or be a doc:<ref> key)")
    return await _answer(lambda: jm.page(_resolver(db), key, jm.clamp_days(days, 30)))


# ── Development: fault injection (MARKDROP_POSTHOG_FAULT_INJECTION) ─────────────


class FaultIn(BaseModel):
    status: int = Field(429, ge=0, le=599)
    retry_after: str | None = Field(None, max_length=40)
    code: str | None = Field(None, max_length=60)
    detail: str | None = Field(None, max_length=200)
    count: int = Field(1, ge=1, le=1000)
    path: str = Field("/", max_length=100)
    timeout: bool = False


def _faults_allowed() -> None:
    if not settings.posthog_fault_injection:
        raise HTTPException(status_code=404, detail="Not Found")


@router.post("/_debug/fault")
async def inject_fault(body: FaultIn, _: dict = Depends(require_admin)):
    """Make the next `count` PostHog calls under `path` answer `status` (or time out). The answer
    goes through the real error mapping, breaker and stale path."""
    _faults_allowed()
    headers = {"Retry-After": body.retry_after} if body.retry_after else {}
    payload = {
        "type": "throttled" if body.status == 429 else "server_error",
        "code": body.code,
        "detail": body.detail or f"injected {body.status}",
    }
    ph.inject_fault(status=body.status, headers=headers, body=payload, count=body.count, path=body.path, timeout=body.timeout)
    return {"ok": True, "limits": ph.limits()}


@router.post("/_debug/reset")
async def reset_faults(clear_cache: bool = False, expire: bool = False, _: dict = Depends(require_admin)):
    """Drop injected faults and close the breakers. `expire` also ends every cached answer's
    freshness (the last good answers stay, so the next failure serves them stale);
    `clear_cache` forgets everything."""
    _faults_allowed()
    if clear_cache:
        ph.reset()
    elif expire:
        ph._cache.clear()
    else:
        ph.clear_faults()
    return {"ok": True}


@router.get("/_debug/stats")
async def debug_stats(reset: bool = False, _: dict = Depends(require_admin)):
    """PostHog requests per query name / endpoint since start (to measure what a view costs)."""
    _faults_allowed()
    out = {"stats": ph.stats(), "limits": ph.limits()}
    if reset:
        ph.reset_stats()
    return out
