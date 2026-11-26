"""Team backlogs (services/team_backlog.py): one shared page per team, filled from the team's calls.

    GET   /api/v1/workspaces/{ws}/teams/{team}/backlog            the page's link and counts (leads: private-call count)
    GET   /api/v1/workspaces/{ws}/teams/{team}/backlog/items      the items as data, filtered, as you may read them
    POST  /api/v1/workspaces/{ws}/teams/{team}/backlog/refresh    leads: re-read every call in the team now
    POST  /api/v1/workspaces/{ws}/teams/{team}/backlog/priorities members: several priorities at once
    PATCH /api/v1/backlog/items/{item_id}                         {category, status, owner, text, priority}: your edit wins

Signed in, on markdrop.in only. The page itself is an ordinary page (GET /api/v1/pages/{slug}).
"""

# No `from __future__ import annotations`: slowapi wraps these routes (see routers/docs_ai.py).
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import is_tenant_request, require_user
from app.services import access
from app.services import team_backlog as TB
from app.services import teams as T
from app.utils.net import get_client_ip

router = APIRouter(prefix="/api/v1", tags=["backlog"])

Category = Literal["feature", "bug", "improvement", "task", "follow_up", "question"]
Status = Literal["open", "in_progress", "done", "wont_do"]
Priority = Literal["urgent", "high", "medium", "low"]
Sort = Literal["category", "priority", "newest", "oldest", "mentions"]


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _here(request: Request) -> None:
    if is_tenant_request(request):
        raise HTTPException(status_code=403, detail="The backlog API is on markdrop.in.")


async def _team_for(request: Request, db: AsyncIOMotorDatabase, user: User, workspace_id: str, team: str,
                    *, lead: bool = False):
    """(team, lead?): 404 outside the workspace, for a team you can't open and for General; 403 for a lead-only
    action when you neither lead the team nor are a workspace admin."""
    _here(request)
    from app.services import workspace as ws_service

    role = await ws_service.role_for(db, workspace_id, user.id) if T.oid(workspace_id) else None
    if role is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    view = await access.Ctx(db, surface="rest", ip=get_client_ip(request)).team_view(workspace_id, user.id)
    row = await T.get_team(db, workspace_id, team)
    if row is None or str(row["_id"]) not in view.readable_teams:
        raise HTTPException(status_code=404, detail="Team not found")
    if T.is_general(row):
        raise HTTPException(status_code=404, detail="General has no backlog.")
    is_lead = view.can_manage(str(row["_id"]))
    if lead and not is_lead:
        raise HTTPException(status_code=403, detail=f"Only {row.get('name') or 'the team'}'s leads can do that.")
    return row, is_lead


@router.get("/workspaces/{workspace_id}/teams/{team}/backlog")
@limiter.limit("60/minute")
async def backlog_status(request: Request, workspace_id: str, team: str, db: AsyncIOMotorDatabase = Depends(get_db),
                         user: User = Depends(require_user)):
    """The team's backlog page: ``slug`` / ``href`` (null until the team's first call), ``open`` and ``counts`` (open
    items per category), the categories and statuses, and — leads only — ``private``: open items only from calls
    restricted to their attendees, kept off the page (a count, nothing else). 404 for General."""
    row, lead = await _team_for(request, db, user, workspace_id, team)
    return jsonable_encoder(await TB.status_of(db, row, lead))


@router.get("/workspaces/{workspace_id}/teams/{team}/backlog/items")
@limiter.limit("30/minute")
async def backlog_items(request: Request, workspace_id: str, team: str,
                        category: Optional[Category] = Query(None), status: Optional[Status] = Query(None),
                        company: Optional[str] = Query(None, max_length=120), include_done: bool = Query(True),
                        priority: Optional[str] = Query(None, max_length=60, description="Any of urgent, high, medium, low (comma-separated)."),
                        since: Optional[str] = Query(None, max_length=10, description="7d, 30d, 90d, month, or a day (2026-11-01)."),
                        until: Optional[str] = Query(None, max_length=10, description="A day (inclusive)."),
                        date_by: Literal["first", "last"] = Query("first", description="Date filters on first seen or last mentioned."),
                        sort: Optional[Sort] = Query(None),
                        db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """The team's backlog items as data, as you may read them: an item shows when you can open one of the calls it
    came from (items only from calls you can't open are left out; leads get their count as ``private``). Each has its
    ``priority`` (urgent, high, medium, low), who set it (``priority_source``: ai, call, person, default) and — when
    you can open the call it came from — why."""
    row, lead = await _team_for(request, db, user, workspace_id, team)
    prios = _priorities(priority)
    try:
        lo, hi = TB.parse_since(since), TB.parse_since(until)
    except ValueError:
        raise HTTPException(status_code=422, detail="since / until: 7d, 30d, 90d, month or a day like 2026-11-01.")
    return jsonable_encoder(await TB.items_for(db, row, user, lead, category=category, status=status, company=company,
                                               include_done=include_done, priority=prios, since=lo, until=hi,
                                               date_by=date_by, sort=sort))


def _priorities(v: Optional[str]) -> Optional[list]:
    if not v:
        return None
    out = []
    for p in v.split(","):
        k = TB._priority_key(p)
        if k is None:
            raise HTTPException(status_code=422, detail="priority: any of urgent, high, medium, low.")
        out.append(k)
    return out


@router.post("/workspaces/{workspace_id}/teams/{team}/backlog/refresh")
@limiter.limit("3/minute")
async def refresh_backlog(request: Request, workspace_id: str, team: str, db: AsyncIOMotorDatabase = Depends(get_db),
                          user: User = Depends(require_user)):
    """Leads and workspace admins: re-read every call in the team into its backlog now (new items, repeats merged,
    categories for items that were waiting) and rewrite the page. Safe to repeat."""
    row, _lead = await _team_for(request, db, user, workspace_id, team, lead=True)
    return jsonable_encoder(await TB.refresh(db, row))


class ItemPatch(BaseModel):
    category: Optional[Category] = None
    status: Optional[Status] = None
    priority: Optional[Priority] = None
    owner: Optional[str] = Field(None, max_length=64, description="A workspace member's id; \"\" clears the owner.")
    text: Optional[str] = Field(None, min_length=1, max_length=300)


@router.patch("/backlog/items/{item_id}")
@limiter.limit("60/minute")
async def update_backlog_item(request: Request, item_id: str, body: ItemPatch, db: AsyncIOMotorDatabase = Depends(get_db),
                              user: User = Depends(require_user)):
    """Change an item's category, status, owner, text or priority (members of its team). Your change wins: the model
    never changes it back, and a call changes its priority only when a later call decides again. Done ticks the call's
    action item too. 404: no such item you can read."""
    _here(request)
    if len(item_id) > 40:
        raise HTTPException(status_code=404, detail="No such backlog item.")
    sent = body.model_dump(exclude_unset=True)
    return jsonable_encoder(await TB.update_item(db, user, item_id, category=sent.get("category"), status=sent.get("status"),
                                                 owner=sent.get("owner") or None, owner_set="owner" in sent, text=sent.get("text"),
                                                 priority=sent.get("priority")))


class PriorityChange(BaseModel):
    id: str = Field(..., min_length=1, max_length=40, description="The item's id, or its block id b-….")
    priority: Priority


class PrioritiesBody(BaseModel):
    changes: list[PriorityChange] = Field(..., min_length=1, max_length=TB.MAX_CHANGES)


@router.post("/workspaces/{workspace_id}/teams/{team}/backlog/priorities")
@limiter.limit("20/minute")
async def set_backlog_priorities(request: Request, workspace_id: str, team: str, body: PrioritiesBody,
                                 db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """Members of the team: set several items' priorities at once (a person's decision: it wins). Returns the
    ``changed`` items and the ones that ``failed`` (not found, or one you can't read). One page rewrite."""
    row, _lead = await _team_for(request, db, user, workspace_id, team)
    return jsonable_encoder(await TB.set_priorities(db, row, user, [c.model_dump() for c in body.changes]))
