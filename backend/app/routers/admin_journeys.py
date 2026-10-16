"""Admin Journeys: live visitors, people, their timelines, session replays, paths and the funnel,
and per-page clicks and reading depth, read from PostHog.

Read-only and admin-only. The PostHog personal API key stays on the server
(services/posthog_api.py); the console never talks to PostHog directly. Document references in
events (`doc_ref`) are resolved to titles and slugs here, from our own database
(services/doc_ref.py), since PostHog never has them.

Every data endpoint answers HTTP 200 `{configured: false, status}` while PostHog isn't set up,
so the console shows its setup card instead of an error. Upstream failures come back as
502/504/429/424 with `{detail, scope}`; never 401/403 (a 401 signs the admin out).
"""

import re
from collections.abc import Awaitable, Callable

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
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


async def _answer(fn: Callable[[], Awaitable[object]]):
    if not settings.posthog_configured:
        return ph.not_configured()
    try:
        return await fn()
    except ph.PostHogError as e:
        return JSONResponse({"detail": e.message, "scope": e.scope}, status_code=e.status)


@router.get("/status")
async def status(_: dict = Depends(require_admin)):
    return ph.status()


@router.get("/live")
async def live(db: AsyncIOMotorDatabase = Depends(get_db), _: dict = Depends(require_admin)):
    return await _answer(lambda: jm.live(_resolver(db)))


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


@router.get("/recordings/{recording_id}/snapshots")
async def snapshots(recording_id: str, _: dict = Depends(require_admin)):
    if not _RECORDING_ID.match(recording_id):
        raise HTTPException(status_code=400, detail="Invalid recording id")

    async def run():
        events = await ph.snapshots(recording_id)
        body = {
            "configured": True,
            "id": recording_id,
            "found": events is not None,
            "events": events or [],
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
