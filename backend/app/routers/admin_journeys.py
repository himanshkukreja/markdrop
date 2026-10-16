"""Admin Journeys: people, their timelines and session recordings, read from PostHog.

Read-only and admin-only. The PostHog personal API key stays on the server
(services/posthog_api.py); the console never talks to PostHog directly.
Document references in events (`doc_ref`) are resolved to slugs and titles
here, from our own database (services/doc_ref.py), since PostHog never has them.
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.routers.admin import get_db, require_admin
from app.services import posthog_api as ph
from app.services.doc_ref import resolve_refs

settings = get_settings()
router = APIRouter(prefix="/api/v1/admin/journeys", tags=["admin"])


def _require_configured() -> None:
    if not settings.posthog_configured:
        raise HTTPException(
            status_code=503,
            detail="PostHog isn't configured on the server (MARKDROP_POSTHOG_PROJECT_ID, MARKDROP_POSTHOG_PERSONAL_API_KEY).",
        )


async def _call(coro):
    try:
        return await coro
    except ph.PostHogError as e:
        status = 502 if e.status >= 500 or e.status in (401, 403) else e.status
        raise HTTPException(status_code=status, detail=f"PostHog: {e.detail}")


@router.get("/status")
async def status(_: dict = Depends(require_admin)):
    return {"configured": settings.posthog_configured, "ui_host": settings.posthog_host}


@router.get("/summary")
async def summary(days: int = Query(7, ge=1, le=90), _: dict = Depends(require_admin)):
    _require_configured()
    return await _call(ph.summary(days))


@router.get("/people")
async def people(
    days: int = Query(7, ge=1, le=90),
    q: str | None = Query(None, max_length=200),
    identified: bool = False,
    limit: int = Query(50, ge=1, le=100),
    before: str | None = Query(None, max_length=40, description="last_seen of the previous page's last row"),
    _: dict = Depends(require_admin),
):
    _require_configured()
    rows = await _call(ph.people(days, (q or "").strip() or None, identified, limit, before))
    return {"people": rows, "has_more": len(rows) == limit}


async def _resolve_docs(db: AsyncIOMotorDatabase, refs: set[str]) -> dict[str, dict]:
    docs = await resolve_refs(db, refs)
    return {r: {k: d[k] for k in ("slug", "title", "kind", "encrypted")} for r, d in docs.items()}


@router.get("/people/{person_id}")
async def person(person_id: str, db: AsyncIOMotorDatabase = Depends(get_db), _: dict = Depends(require_admin)):
    _require_configured()
    if not ph.valid_person_id(person_id):
        raise HTTPException(status_code=400, detail="Invalid person id")
    p = await _call(ph.person(person_id))
    if not p:
        raise HTTPException(status_code=404, detail="Person not found")
    props = p["properties"]
    # Link to the Markdrop account when the person signed in.
    account = None
    email = props.get("email")
    if email:
        u = await db["users"].find_one({"email": email}, {"_id": 1, "email": 1, "name": 1, "created_at": 1})
        if u:
            account = {"id": str(u["_id"]), "email": u.get("email"), "name": u.get("name"), "created_at": u.get("created_at")}
    return {"id": p["id"], "created_at": p.get("created_at"), "properties": props, "account": account}


@router.get("/people/{person_id}/timeline")
async def timeline(
    person_id: str,
    before: datetime | None = None,
    limit: int = Query(200, ge=1, le=500),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    _require_configured()
    if not ph.valid_person_id(person_id):
        raise HTTPException(status_code=400, detail="Invalid person id")
    events = await _call(ph.timeline(person_id, before, limit))
    refs = {e["props"].get("doc_ref") for e in events if e["props"].get("doc_ref")}
    return {"events": events, "docs": await _resolve_docs(db, refs), "has_more": len(events) == limit}


@router.get("/recordings")
async def recordings(
    person: str | None = None,
    limit: int = Query(20, ge=1, le=50),
    offset: int = Query(0, ge=0, le=5_000),
    _: dict = Depends(require_admin),
):
    _require_configured()
    if person and not ph.valid_person_id(person):
        raise HTTPException(status_code=400, detail="Invalid person id")
    rows = await _call(ph.recordings(person, limit, offset))
    return {"recordings": rows, "has_more": len(rows) == limit}


@router.get("/recordings/{recording_id}/snapshots")
async def snapshots(recording_id: str, _: dict = Depends(require_admin)):
    _require_configured()
    if not recording_id.replace("-", "").isalnum() or len(recording_id) > 64:
        raise HTTPException(status_code=400, detail="Invalid recording id")
    events = await _call(ph.snapshots(recording_id))
    # Recordings are large; never cache them in a shared cache.
    return JSONResponse({"events": events}, headers={"Cache-Control": "private, no-store"})
