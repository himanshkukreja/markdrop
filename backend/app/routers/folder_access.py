"""Who can access a folder: its people, teams, restriction and what new items start as
(services/folder_access.py). Workspace members read it; admins, the folder's creator and its editors
change it. Changing who can access a folder is done on markdrop.in (never with a workspace domain's token)."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.services import access
from app.services import folder_access as svc

router = APIRouter(prefix="/api/v1/workspaces", tags=["folders"])

Role = Literal["viewer", "editor"]


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


class PersonEntry(BaseModel):
    email: str = Field(..., min_length=3, max_length=254)
    role: Role = "viewer"


class TeamEntry(BaseModel):
    team_id: str = Field(..., min_length=1, max_length=80, description="The team's id, slug or name.")
    role: Role = "editor"


class FolderAccessUpdate(BaseModel):
    """Present fields change; absent ones are kept. ``people`` / ``teams`` replace the folder's own lists
    (people and teams named on folders above it still reach it)."""
    restricted: bool | None = Field(None, description="Only the folder's people and teams (and item owners, people "
                                                      "an item is shared with, workspace admins) open what's inside.")
    people: list[PersonEntry] | None = Field(None, max_length=svc.MAX_PEOPLE)
    teams: list[TeamEntry] | None = Field(None, max_length=svc.MAX_TEAMS)
    default_access: Literal["private", "folder", "workspace", "link"] | None = Field(
        None, description="What new items here start as; send null to clear (the workspace's default).")
    notify: bool = Field(False, description="Tell people newly given access (one email / notification each).")
    message: str | None = Field(None, max_length=500)


class FolderShareRequest(BaseModel):
    emails: list[str] = Field(default_factory=list, max_length=50)
    team_ids: list[str] = Field(default_factory=list, max_length=20, description="Team ids, slugs or names.")
    role: Role = "viewer"
    notify: bool = True
    message: str | None = Field(None, max_length=500)
    restrict: bool | None = Field(None, description="Also restrict the folder to its people and teams (true), or lift "
                                                    "the restriction (false). Absent: unchanged.")


def _ac(request: Request, db, user: User):
    return access.actor_from_request(request, user), access.Ctx(db)


def _no_tenant(actor) -> None:
    if actor.cred == "tenant":
        raise HTTPException(status_code=401, detail="Change who can access a folder on markdrop.in.")


@router.get("/{workspace_id}/folders/{folder_id}/access")
@limiter.limit("120/minute")
async def get_folder_access(request: Request, workspace_id: str, folder_id: str,
                            db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """The folder's people, teams (each with the folder above that names them, if inherited), whether it is
    restricted (and where), what new items start as, ``can_manage``, a re-apply ``job`` in progress and the
    last changes (``log``). Workspace members."""
    actor, ctx = _ac(request, db, user)
    return jsonable_encoder(await svc.describe(db, actor, ctx, workspace_id, folder_id))


@router.put("/{workspace_id}/folders/{folder_id}/access")
@limiter.limit("60/minute")
async def put_folder_access(request: Request, workspace_id: str, folder_id: str, data: FolderAccessUpdate,
                            db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """Restrict the folder, name its people and teams, set what new items start as. Everything inside —
    pages, files, subfolders, and what is added later — follows at once. Returns the folder's access (as
    GET) plus ``notified``."""
    actor, ctx = _ac(request, db, user)
    _no_tenant(actor)
    kw: dict = {}
    fields = data.model_fields_set
    if "restricted" in fields and data.restricted is not None:
        kw["restricted"] = data.restricted
    if "people" in fields:
        kw["people"] = [p.model_dump() for p in data.people or []]
    if "teams" in fields:
        kw["teams"] = [{"team": t.team_id, "role": t.role} for t in data.teams or []]
    if "default_access" in fields:
        kw["default_access"] = data.default_access
    res = await svc.update(db, actor, ctx, workspace_id, folder_id, **kw)
    notified = {}
    if data.notify and (res["added_people"] or res["added_teams"]):
        notified = await svc.notify_people(db, actor, ctx, workspace_id, folder_id, res["added_people"],
                                           res["added_teams"], message=data.message,
                                           role=next((res["role_of"].get(e) for e in res["added_people"]), "editor"))
    ctx.forget()
    out = await svc.describe(db, actor, ctx, workspace_id, folder_id)
    return jsonable_encoder({**out, "notified": notified})


@router.post("/{workspace_id}/folders/{folder_id}/access/share")
@limiter.limit("30/minute")
async def share_folder_with(request: Request, workspace_id: str, folder_id: str, data: FolderShareRequest,
                            db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """Share the folder with people and/or teams: they reach everything inside that isn't private, now and
    later. One notification and one email per person newly given access (not one per item)."""
    actor, ctx = _ac(request, db, user)
    _no_tenant(actor)
    res = await svc.share(db, actor, ctx, workspace_id, folder_id, emails=data.emails, teams=data.team_ids,
                          role=data.role, notify=data.notify, message=data.message, restrict=data.restrict)
    ctx.forget()
    out = await svc.describe(db, actor, ctx, workspace_id, folder_id)
    return jsonable_encoder({**out, "added_people": res["added_people"], "added_teams": res["added_teams"],
                             "notified": res["notified"]})
