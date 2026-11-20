"""Person cards and "what changed since I last looked" (AI quality stage 4).

    GET  /api/v1/people/{user_id}/card?workspace=          services/person_cards.py
    POST /api/v1/workspaces/{workspace_id}/visit {space}    services/what_changed.visit
    GET  /api/v1/workspaces/{workspace_id}/changes          services/what_changed.changes

Signed-in members only; every list is decided for the caller (access.discoverable per item, team / project spaces
they can read). A person outside every workspace the caller shares with them, a workspace they aren't in, a team or
project they can't open: 404.
"""

# No `from __future__ import annotations`: slowapi wraps these routes (see routers/docs_ai.py).
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.services import access, person_cards, what_changed
from app.utils.net import get_client_ip

router = APIRouter(prefix="/api/v1", tags=["team"])



def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _ac(request: Request, db, user: User):
    return (access.actor_from_request(request, user),
            access.Ctx(db, surface="rest", ip=get_client_ip(request)))


async def _member(ctx: access.Ctx, workspace_id: str, user: User) -> None:
    if await ctx.role(workspace_id, user.id) is None:
        raise HTTPException(status_code=404, detail="Workspace not found")


async def _space_ok(ctx: access.Ctx, workspace_id: str, user: User, team: Optional[str], project: Optional[str]) -> None:
    if not team and not project:
        return
    view = await ctx.team_view(workspace_id, user.id)
    if team and team not in view.readable_teams:
        raise HTTPException(status_code=404, detail="Team not found")
    if project and project not in view.readable_projects:
        raise HTTPException(status_code=404, detail="Project not found")


@router.get("/people/{user_id}/card")
@limiter.limit("120/minute")
async def person_card(request: Request, user_id: str, workspace: Optional[str] = Query(None, max_length=40),
                      db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """One member at a glance, as you may see them (a workspace you share with them; ``workspace`` first)."""
    actor, ctx = _ac(request, db, user)
    ws = await person_cards.shared_workspace(db, ctx, user.id, user_id, workspace)
    got = await person_cards.card(db, actor, ctx, ws, user_id) if ws else None
    if got is None:
        raise HTTPException(status_code=404, detail="Person not found")
    return jsonable_encoder(got)


class VisitBody(BaseModel):
    space: Optional[str] = Field(None, max_length=40, description="team:<id> | project:<id>; none: the workspace itself.")


@router.post("/workspaces/{workspace_id}/visit")
@limiter.limit("120/minute")
async def visit(request: Request, workspace_id: str, body: VisitBody, db: AsyncIOMotorDatabase = Depends(get_db),
                user: User = Depends(require_user)):
    """Mark that you are looking at the workspace (or one of its teams / projects): "what changed since I last looked"
    counts from the end of your previous look."""
    _actor, ctx = _ac(request, db, user)
    await _member(ctx, workspace_id, user)
    team = project = None
    if body.space:
        kind, _, ident = body.space.partition(":")
        if kind not in ("team", "project") or not ident:
            raise HTTPException(status_code=422, detail="space must be team:<id> or project:<id>")
        team, project = (ident, None) if kind == "team" else (None, ident)
    await _space_ok(ctx, workspace_id, user, team, project)
    got = await what_changed.visit(db, user.id, workspace_id, what_changed.space_key(workspace_id, team, project))
    return {"since": got["since"].isoformat() if got.get("since") else None}


@router.get("/workspaces/{workspace_id}/changes")
@limiter.limit("60/minute")
async def changes(request: Request, workspace_id: str, team: Optional[str] = Query(None, max_length=40),
                  project: Optional[str] = Query(None, max_length=40),
                  since: Optional[datetime] = Query(None, description="ISO time; default: when you last looked"),
                  limit: int = Query(what_changed.ROWS, ge=1, le=50),
                  db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """What changed in the workspace (or a team / project of it) since you last looked: meetings held, decisions,
    new and updated documents, action items, comment threads — only what you can open."""
    actor, ctx = _ac(request, db, user)
    await _member(ctx, workspace_id, user)
    await _space_ok(ctx, workspace_id, user, team, project)
    if since is not None and since.tzinfo is None:
        since = since.replace(tzinfo=timezone.utc)
    got = await what_changed.changes(db, actor, ctx, workspace_id, since=since, team=team, project=project, limit=limit)
    return jsonable_encoder(got.as_dict())
