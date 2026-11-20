"""Customizable Home (services/dashboards.py): each person's Home layout, per workspace.

    GET    /api/v1/me/dashboard?workspace=<id>             the layout (resolved for you), the catalog and templates
    PUT    /api/v1/me/dashboard                            {workspace, main, side} or {workspace, preset}
    DELETE /api/v1/me/dashboard?workspace=<id>             reset: the workspace's default again (else Default)
    PUT    /api/v1/workspaces/{ws}/dashboard-default       admins: {main, side} or {preset}
    DELETE /api/v1/workspaces/{ws}/dashboard-default       admins: members see Default again

No workspace (``workspace`` left out or empty): the Home of someone not in a workspace yet. Signed in, on
markdrop.in only. Widgets load their own data from the existing endpoints (the website's widget registry).
"""

# No `from __future__ import annotations`: slowapi wraps these routes (see routers/docs_ai.py).
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import is_tenant_request, require_user
from app.services import access
from app.services import dashboards as D
from app.utils.net import get_client_ip

router = APIRouter(prefix="/api/v1", tags=["home"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _ac(request: Request, user: User, db):
    if is_tenant_request(request):
        raise HTTPException(status_code=403, detail="The home is on markdrop.in.")
    return access.actor_from_request(request, user), access.Ctx(db, surface="rest", ip=get_client_ip(request))


async def _ws(db, user: User, workspace: Optional[str]) -> Optional[str]:
    try:
        return await D.member_workspace(db, user.id, (workspace or "").strip() or None)
    except LookupError:
        raise HTTPException(status_code=404, detail="Workspace not found")


class Widget(BaseModel):
    id: Optional[str] = Field(None, max_length=12, description="Kept when it's a short id; new widgets get one.")
    type: str = Field(..., max_length=40, description="One of the catalog's types (GET returns the catalog).")
    settings: dict[str, Any] = Field(default_factory=dict, description="The type's settings: team, folder, page, count, category, status, range.")


class LayoutBody(BaseModel):
    workspace: Optional[str] = Field(None, max_length=40, description="The workspace's id; leave out for the Home without a workspace.")
    main: Optional[list[Widget]] = Field(None, max_length=D.MAX_WIDGETS, description="The wide column, top to bottom.")
    side: Optional[list[Widget]] = Field(None, max_length=D.MAX_WIDGETS, description="The narrow column, top to bottom.")
    preset: Optional[str] = Field(None, max_length=20, description="Start from a template instead: default, writer, meetings, sales, manager.")


class DefaultBody(BaseModel):
    main: Optional[list[Widget]] = Field(None, max_length=D.MAX_WIDGETS)
    side: Optional[list[Widget]] = Field(None, max_length=D.MAX_WIDGETS)
    preset: Optional[str] = Field(None, max_length=20)


def _layout(body) -> dict:
    if body.preset is None and body.main is None and body.side is None:
        raise HTTPException(status_code=422, detail="Send main and side, or a preset.")
    dump = lambda col: None if col is None else [w.model_dump() for w in col]  # noqa: E731
    return {"main": dump(body.main), "side": dump(body.side), "preset": body.preset}


@router.get("/me/dashboard")
@limiter.limit("120/minute")
async def get_dashboard(request: Request, workspace: Optional[str] = Query(None, max_length=40),
                        db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """Your Home in this workspace: ``main`` and ``side`` (each widget ``{id, type, settings, available}``;
    ``note`` says why one isn't available), ``source`` (``mine``, ``workspace`` = the admins' default, or
    ``default``), the widget ``catalog`` and the ``presets`` (templates). 404 for a workspace you're not in."""
    actor, ctx = _ac(request, user, db)
    ws = await _ws(db, user, workspace)
    return jsonable_encoder(await D.resolve(db, actor, ctx, ws))


@router.put("/me/dashboard")
@limiter.limit("60/minute")
async def put_dashboard(request: Request, body: LayoutBody, db: AsyncIOMotorDatabase = Depends(get_db),
                        user: User = Depends(require_user)):
    """Save your Home: both columns (at most 16 widgets in all), or a template made concrete for you. 422
    names what's wrong (an unknown type or setting, a team or folder that isn't in the workspace)."""
    actor, ctx = _ac(request, user, db)
    ws = await _ws(db, user, body.workspace)
    try:
        return jsonable_encoder(await D.save(db, actor, ctx, ws, **_layout(body)))
    except D.Invalid as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.delete("/me/dashboard")
@limiter.limit("30/minute")
async def reset_dashboard(request: Request, workspace: Optional[str] = Query(None, max_length=40),
                          db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """Reset to default: forget your layout, so you see the workspace's default (else Default) again."""
    actor, ctx = _ac(request, user, db)
    ws = await _ws(db, user, workspace)
    return jsonable_encoder(await D.reset(db, actor, ctx, ws))


async def _admin(request: Request, db, user: User, workspace_id: str):
    actor, ctx = _ac(request, user, db)
    ws = await _ws(db, user, workspace_id)
    from app.services import workspace as ws_service

    if await ws_service.role_for(db, ws, user.id) not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="Only the workspace's admins can set its default Home.")
    return actor, ctx, ws


@router.put("/workspaces/{workspace_id}/dashboard-default")
@limiter.limit("30/minute")
async def put_workspace_default(request: Request, workspace_id: str, body: DefaultBody,
                                db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """Workspace admins: the Home members see until they customize their own. A template keeps its
    placeholders (each member's first team, newest page), filled in for each member."""
    actor, ctx, ws = await _admin(request, db, user, workspace_id)
    try:
        return jsonable_encoder(await D.set_workspace_default(db, actor, ctx, ws, **_layout(body)))
    except D.Invalid as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.delete("/workspaces/{workspace_id}/dashboard-default")
@limiter.limit("30/minute")
async def clear_workspace_default(request: Request, workspace_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                                  user: User = Depends(require_user)):
    """Workspace admins: forget the workspace's default Home (members who never customized see Default)."""
    actor, ctx, ws = await _admin(request, db, user, workspace_id)
    return jsonable_encoder(await D.set_workspace_default(db, actor, ctx, ws, clear=True))
