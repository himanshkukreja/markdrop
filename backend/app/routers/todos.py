"""Personal to-do pages (services/todo_pages.py): one page per person per team from the team's calls.

    GET  /api/v1/me/todos                                   your to-do pages across your teams (You › My to-dos)
    GET  /api/v1/workspaces/{ws}/teams/{team}/todos         the team's (leads: every member's; anyone else: theirs)
    POST /api/v1/todos/tick                                 {block, done} tick one of your to-dos (and its call's)
    GET  /api/v1/workspaces/{ws}/teams/{team}/todos/mine    whether you have a page in the team (nothing is made)
    POST /api/v1/workspaces/{ws}/teams/{team}/todos/mine    create or refresh yours now (calls + the team's pages)
    POST /api/v1/workspaces/{ws}/teams/{team}/todos/all     leads: a page for every member who has none

Signed in, on markdrop.in only.
"""

# No `from __future__ import annotations`: slowapi wraps these routes (see routers/docs_ai.py).
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import is_tenant_request, require_user
from app.services import access
from app.services import teams as T
from app.services import todo_pages
from app.utils.net import get_client_ip

router = APIRouter(prefix="/api/v1", tags=["todos"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _here(request: Request) -> None:
    if is_tenant_request(request):
        raise HTTPException(status_code=403, detail="To-dos are on markdrop.in.")


@router.get("/me/todos")
@limiter.limit("60/minute")
async def my_todos(request: Request, workspace: Optional[str] = Query(None, max_length=40),
                   db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """Your to-do pages, one per team you're in (never General): open count, the companies with open items and
    the last call of each. A page is made the first time it's asked for (from the team's calls)."""
    _here(request)
    pages, missing = await todo_pages.mine_and_missing(db, user, workspace_id=workspace)
    return jsonable_encoder({"pages": pages, "missing": missing})


async def _team_for(request: Request, db: AsyncIOMotorDatabase, user: User, workspace_id: str, team: str, *,
                    member: bool = True, lead: bool = False) -> dict:
    """The team, checked: 404 outside the workspace, for a team you can't open and for General (no to-dos there);
    403 when you're not in it (``member``) or don't lead it (``lead``)."""
    _here(request)
    from app.services import workspace as ws_service

    role = await ws_service.role_for(db, workspace_id, user.id) if T.oid(workspace_id) else None
    if role is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    ctx = access.Ctx(db, surface="rest", ip=get_client_ip(request))
    view = await ctx.team_view(workspace_id, user.id)
    row = await T.get_team(db, workspace_id, team)
    if row is None or str(row["_id"]) not in view.readable_teams:
        raise HTTPException(status_code=404, detail="Team not found")
    if T.is_general(row):
        raise HTTPException(status_code=404, detail="General has no to-do pages.")
    if lead and not view.lead_of(str(row["_id"])):
        raise HTTPException(status_code=403, detail=f"Only {row.get('name') or 'the team'}'s leads can do that.")
    if member and user.id not in (row.get("member_ids") or []):
        raise HTTPException(status_code=403, detail=f"Join {row.get('name') or 'the team'} to get a to-do page there.")
    return row


@router.get("/workspaces/{workspace_id}/teams/{team}/todos/mine")
@limiter.limit("60/minute")
async def my_team_todo_status(request: Request, workspace_id: str, team: str, db: AsyncIOMotorDatabase = Depends(get_db),
                              user: User = Depends(require_user)):
    """Whether you have a to-do page in the team (``exists``, its ``slug``, ``open``), without making one: the
    team's "Create my to-dos" / "Refresh to-dos" button. 404 for General; 403 when you're not in the team."""
    row = await _team_for(request, db, user, workspace_id, team)
    return jsonable_encoder(await todo_pages.status(db, str(row["_id"]), user.id))


@router.post("/workspaces/{workspace_id}/teams/{team}/todos/mine")
@limiter.limit("6/minute")
async def refresh_my_team_todos(request: Request, workspace_id: str, team: str, db: AsyncIOMotorDatabase = Depends(get_db),
                                user: User = Depends(require_user)):
    """Create your to-do page in the team, or refresh it, now: your action items from the team's calls and the tasks
    on the team's pages that mention you. ``added``: items it didn't have before; ``open``: open now; ``created``:
    the page is new. 404 for General; 403 when you're not in the team."""
    row = await _team_for(request, db, user, workspace_id, team)
    return jsonable_encoder(await todo_pages.refresh(db, str(row["_id"]), user))


@router.post("/workspaces/{workspace_id}/teams/{team}/todos/all")
@limiter.limit("3/minute")
async def create_team_todos(request: Request, workspace_id: str, team: str, db: AsyncIOMotorDatabase = Depends(get_db),
                            user: User = Depends(require_user)):
    """Leads: make a to-do page for every member of the team who has none yet (``created``: how many). 403 for
    anyone who doesn't lead the team; 404 for General."""
    row = await _team_for(request, db, user, workspace_id, team, member=False, lead=True)
    built = await todo_pages.ensure_team(db, str(row["_id"]))
    return {"created": sum(1 for b in built if b.created), "skipped": sum(1 for b in built if b.skipped),
            "members": len(row.get("member_ids") or [])}


@router.get("/workspaces/{workspace_id}/teams/{team}/todos")
@limiter.limit("60/minute")
async def team_todos(request: Request, workspace_id: str, team: str, db: AsyncIOMotorDatabase = Depends(get_db),
                     user: User = Depends(require_user)):
    """The team's to-do pages: a lead gets every member's (and every member has one from then on); anyone else in
    the team, their own. ``lead``: you lead the team. 404 outside the workspace or a team you can't open."""
    _here(request)
    from app.services import workspace as ws_service

    role = await ws_service.role_for(db, workspace_id, user.id) if T.oid(workspace_id) else None
    if role is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    ctx = access.Ctx(db, surface="rest", ip=get_client_ip(request))
    view = await ctx.team_view(workspace_id, user.id)
    row = await T.get_team(db, workspace_id, team)
    if row is None or str(row["_id"]) not in view.readable_teams:
        raise HTTPException(status_code=404, detail="Team not found")
    return jsonable_encoder(await todo_pages.team(db, user, view, row))


class TickBody(BaseModel):
    block: str = Field(..., pattern=r"^b-[0-9A-Za-z_-]{1,40}$")
    done: bool = Field(True, description="false: open it again")
    slug: Optional[str] = Field(None, max_length=200, description="The to-do page (default: whichever of yours has it)")


@router.post("/todos/tick")
@limiter.limit("60/minute")
async def tick(request: Request, body: TickBody, db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """Tick (or untick) one of your to-dos on your to-do page; the call's action item follows. 404: not one of
    your to-dos; 409: already that way."""
    _here(request)
    return await todo_pages.tick(db, user, body.block, body.done, slug=body.slug)
