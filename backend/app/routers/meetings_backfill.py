"""Import past meetings (services/meeting_backfill.py) and how meetings are organised
(services/meeting_series.py). Registered before routers/meetings.py (its /{meeting_id}).

    GET    /api/v1/meetings/backfill?workspace=            {jobs: [...]} the caller's imports here, newest first
    POST   /api/v1/meetings/backfill                       {workspace, quiet?, restricted?} → a draft (the open one, reused)
    GET    /api/v1/meetings/backfill/{id}                  the import (review, progress, estimate)
    POST   /api/v1/meetings/backfill/{id}/sources          {sources: [{name, text | data_b64 | google_file_id, created?}], tz_offset_min?}
    DELETE /api/v1/meetings/backfill/{id}/rows/{row}       take a row (its files) out of the review
    PATCH  /api/v1/meetings/backfill/{id}                  {quiet?, restricted?, rows: [{id, title?, date?, series?, include?}]}
    POST   /api/v1/meetings/backfill/{id}/start            the queue starts (every included row needs a date)
    POST   /api/v1/meetings/backfill/{id}/pause | resume
    POST   /api/v1/meetings/backfill/{id}/rows/{row}/retry
    DELETE /api/v1/meetings/backfill/{id}                  discard (a draft / a finished one) or stop (a running one)
    GET    /api/v1/meetings/series?workspace=              {series: [{name, count, last}]} of the meetings the caller can open
    POST   /api/v1/meetings/organize                       {workspace} "Organize meetings" (admins): series + Meetings/<Series> folders

Signed-in workspace members (importing: member+). An import is its owner's alone: anyone else gets 404.
"""

# No `from __future__ import annotations`: slowapi wraps these routes (see routers/docs_ai.py).
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.routers.meetings import SourceIn, _ac, _ws
from app.services import gdocs, meeting_backfill, meeting_google, meeting_series, meetings

router = APIRouter(prefix="/api/v1/meetings", tags=["meetings"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


class BackfillSource(SourceIn):
    # The Google Doc's (or the file's) creation time as the browser knows it: a date in the person's
    # own day ("2026-10-28") or an ISO time.
    created: str | None = Field(None, max_length=40)


class CreateBody(BaseModel):
    workspace: str = Field(..., max_length=40)
    quiet: bool = True
    restricted: bool = False


class AddBody(BaseModel):
    sources: list[BackfillSource] = Field(..., min_length=1, max_length=meeting_backfill.MAX_ADD)
    # Minutes east of UTC (the browser's), to read a Google Doc's creation time as the person's day.
    tz_offset_min: int = Field(0, ge=-840, le=840)


class EditRow(BaseModel):
    id: str = Field(..., max_length=20)
    title: str | None = Field(None, max_length=150)
    date: str | None = Field(None, max_length=10)
    series: str | None = Field(None, max_length=60)
    include: bool | None = None
    # Who sees it: true = its attendees, false = the team (default: by the number of attendees).
    restricted: bool | None = None


class EditBody(BaseModel):
    quiet: bool | None = None
    restricted: bool | None = None
    rows: list[EditRow] | None = Field(None, max_length=meeting_backfill.MAX_ROWS)


async def _google_created(token: str, file_id: str) -> str | None:
    """The Doc's createdTime (drive.file reaches a file the person picked)."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(f"{meeting_google.DRIVE_API}/{file_id}", params={"fields": "createdTime"},
                                 headers={"Authorization": f"Bearer {token}"})
        if r.status_code == 200:
            return (r.json() or {}).get("createdTime")
    except httpx.HTTPError:
        pass
    return None


def _local_day(value: str | None, offset_min: int) -> str | None:
    """"2026-10-28" as given, or an ISO time read in the person's own time zone."""
    v = (value or "").strip()
    if len(v) == 10:
        return v
    try:
        t = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return (t.astimezone(timezone.utc) + timedelta(minutes=offset_min)).date().isoformat()


async def _incoming(db, user: User, body: AddBody) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    token = None
    for s in body.sources:
        if s.google_file_id:
            if token is None:
                try:
                    token = (await meeting_google.picker_credentials(db, user))["access_token"]
                except gdocs.ReconnectRequired as exc:
                    raise HTTPException(status_code=428, detail={"error": "reconnect_required", "message": str(exc)})
            try:
                title, text, url = await meeting_google.fetch(token, s.google_file_id)
            except meeting_google.PickError as exc:
                out.append({"name": s.name or "Google Doc", "text": "", "error": str(exc)})
                continue
            except gdocs.ReconnectRequired as exc:
                raise HTTPException(status_code=428, detail={"error": "reconnect_required", "message": str(exc)})
            created = s.created or await _google_created(token, s.google_file_id)
            out.append({"name": title, "text": text, "origin": "google", "file_id": s.google_file_id, "url": url,
                        "created": _local_day(created, body.tz_offset_min)})
            continue
        if not (s.text or s.data_b64):
            raise HTTPException(status_code=422, detail="Each source needs text, a file or a Google Doc.")
        try:
            inc = meetings.incoming_from(s.model_dump(), "paste")
        except ValueError as exc:
            out.append({"name": s.name or "File", "text": "", "error": str(exc)})
            continue
        out.append({"name": inc.name, "text": inc.text, "origin": inc.origin,
                    "created": _local_day(s.created, body.tz_offset_min) if s.created and s.google_file_id else None})
    return out


async def _job(db, user: User, job_id: str) -> dict:
    job = await meeting_backfill.get_job(db, job_id, user.id)
    await meetings.require_member(db, job["workspace_id"], user.id, write=False)
    return job


@router.get("/backfill")
@limiter.limit("120/minute")
async def list_jobs(request: Request, workspace: str = Query(..., max_length=40),
                    db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    ws = _ws(workspace)
    await meetings.require_member(db, ws, user.id, write=False)
    out = []
    for j in await meeting_backfill.jobs_for(db, user.id, ws):
        j = await meeting_backfill.wake(db, j)
        out.append(await meeting_backfill.view(db, j, with_estimate=j["state"] in meeting_backfill.OPEN))
    return {"jobs": out}


@router.post("/backfill")
@limiter.limit("30/minute")
async def create_job(request: Request, body: CreateBody, db: AsyncIOMotorDatabase = Depends(get_db),
                     user: User = Depends(require_user)):
    job, _made = await meeting_backfill.create_job(db, user, _ws(body.workspace), quiet=body.quiet,
                                                   restricted=body.restricted)
    return await meeting_backfill.view(db, job)


@router.get("/backfill/{job_id}")
@limiter.limit("240/minute")
async def get_job(request: Request, job_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    job = await meeting_backfill.wake(db, await _job(db, user, job_id))
    return await meeting_backfill.view(db, job)


@router.post("/backfill/{job_id}/sources")
@limiter.limit("60/minute")
async def add_sources(request: Request, job_id: str, body: AddBody, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    job = await _job(db, user, job_id)
    await meetings.require_member(db, job["workspace_id"], user.id)
    items = await _incoming(db, user, body)
    bad = [{"name": i["name"], "error": i["error"]} for i in items if i.get("error")]
    job = await meeting_backfill.add_sources(db, job, [i for i in items if not i.get("error")])
    if bad:
        await db[meeting_backfill.JOBS].update_one({"_id": job["_id"]}, {"$push": {"problems": {"$each": bad}}})
        job = await db[meeting_backfill.JOBS].find_one({"_id": job["_id"]})
    return await meeting_backfill.view(db, job)


@router.delete("/backfill/{job_id}/rows/{row_id}")
@limiter.limit("120/minute")
async def remove_row(request: Request, job_id: str, row_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                     user: User = Depends(require_user)):
    job = await meeting_backfill.remove_source(db, await _job(db, user, job_id), row_id)
    return await meeting_backfill.view(db, job)


@router.patch("/backfill/{job_id}")
@limiter.limit("120/minute")
async def edit_job(request: Request, job_id: str, body: EditBody, db: AsyncIOMotorDatabase = Depends(get_db),
                   user: User = Depends(require_user)):
    job = await _job(db, user, job_id)
    rows = [r.model_dump(exclude_unset=True) for r in body.rows] if body.rows else None
    job = await meeting_backfill.edit(db, job, quiet=body.quiet, restricted=body.restricted, rows=rows)
    return await meeting_backfill.view(db, job)


@router.post("/backfill/{job_id}/start")
@limiter.limit("20/minute")
async def start_job(request: Request, job_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                    user: User = Depends(require_user)):
    job = await _job(db, user, job_id)
    await meetings.require_member(db, job["workspace_id"], user.id)
    return await meeting_backfill.view(db, await meeting_backfill.start(db, job))


@router.post("/backfill/{job_id}/pause")
@limiter.limit("60/minute")
async def pause_job(request: Request, job_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                    user: User = Depends(require_user)):
    return await meeting_backfill.view(db, await meeting_backfill.pause(db, await _job(db, user, job_id)))


@router.post("/backfill/{job_id}/resume")
@limiter.limit("60/minute")
async def resume_job(request: Request, job_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                     user: User = Depends(require_user)):
    return await meeting_backfill.view(db, await meeting_backfill.resume(db, await _job(db, user, job_id)))


@router.post("/backfill/{job_id}/rows/{row_id}/retry")
@limiter.limit("60/minute")
async def retry_row(request: Request, job_id: str, row_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                    user: User = Depends(require_user)):
    return await meeting_backfill.view(db, await meeting_backfill.retry(db, await _job(db, user, job_id), row_id))


@router.delete("/backfill/{job_id}")
@limiter.limit("60/minute")
async def discard_job(request: Request, job_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    return await meeting_backfill.discard(db, await _job(db, user, job_id))


@router.get("/series")
@limiter.limit("120/minute")
async def list_series(request: Request, workspace: str = Query(..., max_length=40),
                      db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    ws = _ws(workspace)
    await meetings.require_member(db, ws, user.id, write=False)
    actor, ctx = _ac(request, db, user)
    return {"series": await meeting_series.list_series(db, ws, actor, ctx)}


class OrganizeBody(BaseModel):
    workspace: str = Field(..., max_length=40)


@router.post("/organize")
@limiter.limit("6/minute")
async def organize(request: Request, body: OrganizeBody, db: AsyncIOMotorDatabase = Depends(get_db),
                   user: User = Depends(require_user)):
    """The meetings already here get their series and move into Meetings/<Series> (or Meetings/Other
    meetings): workspace admins and owners."""
    ws = _ws(body.workspace)
    await meetings.require_member(db, ws, user.id, write=False)
    return await meeting_series.organize(db, ws, user)
