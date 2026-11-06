"""Team (services/workspace_memory.py): who is doing what in a workspace, from its meetings and pages.

    GET    /api/v1/team/{ws}                          the board: a card per member, charts' data, projects
    GET    /api/v1/team/{ws}/people/{user_id}         a person's page
    GET    /api/v1/team/{ws}/projects/{key}           a project's page
    PUT    /api/v1/team/{ws}/me/focus                 {text}  your "What I'm focused on" note ("" clears)
    PUT    /api/v1/team/{ws}/me/status                {text, emoji?, until?}  your own status (wins over AI)
    POST   /api/v1/team/{ws}/facts/{id}/hide          hide a line about you (for everyone); DELETE: undo
    POST   /api/v1/team/{ws}/facts/{id}/correct       {text?} "This is wrong" (+ the right version); DELETE: undo

Members of the workspace (any role) only: anyone else gets a 404, guests with a link included. Every
line is decided per viewer (a fact shows only while its source is readable by them). With Team memory
off for the workspace, ``GET`` answers ``{enabled: false}`` and everything else 404s.
"""

# No `from __future__ import annotations`: slowapi wraps these routes (see routers/docs_ai.py).
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.services import access
from app.services import workspace_memory as wm
from app.utils.net import get_client_ip

router = APIRouter(prefix="/api/v1/team", tags=["team"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _ac(request: Request, db, user: User):
    return (access.actor_from_request(request, user),
            access.Ctx(db, surface="rest", ip=get_client_ip(request)))


async def _member(db, workspace_id: str, user: User, *, need_on: bool = True) -> tuple[wm.WsInfo, str]:
    from app.services import workspace as ws_service

    ws = await wm.ws_info(db, workspace_id)
    role = await ws_service.role_for(db, workspace_id, user.id) if ws is not None else None
    if ws is None or role is None or ws.deleting:
        raise HTTPException(status_code=404, detail="Workspace not found")
    if need_on and not ws.on:
        raise HTTPException(status_code=404, detail="Team memory is off for this workspace.")
    return ws, role


def _refused(exc: wm.Refused) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=exc.detail)


class FocusBody(BaseModel):
    text: str = Field("", max_length=wm.FOCUS_MAX + 200)


class StatusBody(BaseModel):
    text: str = Field("", max_length=wm.STATUS_MAX + 100)
    emoji: Optional[str] = Field(None, max_length=16)
    until: Optional[datetime] = Field(None, description="When it stops applying (ISO time); none: until cleared.")


class CorrectBody(BaseModel):
    text: Optional[str] = Field(None, max_length=wm.CORRECTION_MAX + 200,
                                description="The right version (optional): shown instead of the line.")


@router.get("/{workspace_id}")
@limiter.limit("120/minute")
async def board(request: Request, workspace_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                user: User = Depends(require_user)):
    """The Team board for you: each member's status, focus, targets, open items and recent activity;
    blockers; projects × people. ``{enabled: false, can_enable}`` when Team memory is off."""
    from app.models.workspace import role_allows

    ws, role = await _member(db, workspace_id, user, need_on=False)
    if not ws.on:
        return {"enabled": False, "can_enable": role_allows(role, "admin"), "role": role,
                "workspace": {"id": ws.id, "name": ws.name}}
    actor, ctx = _ac(request, db, user)
    return jsonable_encoder(await wm.team(db, actor, ctx, ws, role))


@router.get("/{workspace_id}/people/{user_id}")
@limiter.limit("120/minute")
async def person(request: Request, workspace_id: str, user_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                 user: User = Depends(require_user)):
    ws, role = await _member(db, workspace_id, user)
    actor, ctx = _ac(request, db, user)
    got = await wm.person_profile(db, actor, ctx, ws, user_id, role=role)
    if got is None:
        raise HTTPException(status_code=404, detail="Person not found")
    return jsonable_encoder(got)


@router.get("/{workspace_id}/projects/{key}")
@limiter.limit("120/minute")
async def project(request: Request, workspace_id: str, key: str, db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    ws, role = await _member(db, workspace_id, user)
    actor, ctx = _ac(request, db, user)
    got = await wm.project_profile(db, actor, ctx, ws, key[:80], role=role)
    if got is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return jsonable_encoder(got)


@router.put("/{workspace_id}/me/focus")
@limiter.limit("60/minute")
async def put_focus(request: Request, workspace_id: str, body: FocusBody, db: AsyncIOMotorDatabase = Depends(get_db),
                    user: User = Depends(require_user)):
    ws, _role = await _member(db, workspace_id, user)
    return {"focus": await wm.set_focus(db, ws.id, user.id, body.text)}


@router.put("/{workspace_id}/me/status")
@limiter.limit("60/minute")
async def put_status(request: Request, workspace_id: str, body: StatusBody, db: AsyncIOMotorDatabase = Depends(get_db),
                     user: User = Depends(require_user)):
    ws, _role = await _member(db, workspace_id, user)
    try:
        return jsonable_encoder({"status": await wm.set_status(db, ws.id, user.id, body.text, body.emoji, body.until)})
    except wm.Refused as exc:
        raise _refused(exc)


@router.post("/{workspace_id}/facts/{fact_id}/hide")
@limiter.limit("60/minute")
async def hide(request: Request, workspace_id: str, fact_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
               user: User = Depends(require_user)):
    ws, role = await _member(db, workspace_id, user)
    actor, ctx = _ac(request, db, user)
    try:
        return await wm.hide(db, actor, ctx, ws, fact_id, role, on=True)
    except wm.Refused as exc:
        raise _refused(exc)


@router.delete("/{workspace_id}/facts/{fact_id}/hide")
@limiter.limit("60/minute")
async def unhide(request: Request, workspace_id: str, fact_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                 user: User = Depends(require_user)):
    ws, role = await _member(db, workspace_id, user)
    actor, ctx = _ac(request, db, user)
    try:
        return await wm.hide(db, actor, ctx, ws, fact_id, role, on=False)
    except wm.Refused as exc:
        raise _refused(exc)


@router.post("/{workspace_id}/facts/{fact_id}/correct")
@limiter.limit("60/minute")
async def correct(request: Request, workspace_id: str, fact_id: str, body: CorrectBody,
                  db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    ws, role = await _member(db, workspace_id, user)
    actor, ctx = _ac(request, db, user)
    try:
        return jsonable_encoder(await wm.correct(db, actor, ctx, ws, fact_id, role, body.text or ""))
    except wm.Refused as exc:
        raise _refused(exc)


@router.delete("/{workspace_id}/facts/{fact_id}/correct")
@limiter.limit("60/minute")
async def uncorrect(request: Request, workspace_id: str, fact_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                    user: User = Depends(require_user)):
    ws, role = await _member(db, workspace_id, user)
    actor, ctx = _ac(request, db, user)
    try:
        return jsonable_encoder(await wm.correct(db, actor, ctx, ws, fact_id, role, None))
    except wm.Refused as exc:
        raise _refused(exc)
