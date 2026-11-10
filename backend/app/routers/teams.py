"""Teams inside a workspace (services/teams.py; contract .work/teams/CONTRACT.md §4).

    GET    /api/v1/workspaces/{ws}/teams                        sidebar: my teams, projects, browse counts, suggestions
    GET    /api/v1/workspaces/{ws}/teams/browse                 every team (private ones: card only)
    POST   /api/v1/workspaces/{ws}/teams                        admins: create
    GET    /api/v1/workspaces/{ws}/teams/{team}                 team home (brief, recent, meetings, memory, members)
    PATCH  /api/v1/workspaces/{ws}/teams/{team}                 leads/admins: settings (visibility: admins)
    DELETE /api/v1/workspaces/{ws}/teams/{team}                 admins
    POST   /api/v1/workspaces/{ws}/teams/{team}/members         leads/admins {user_ids}
    DELETE /api/v1/workspaces/{ws}/teams/{team}/members/{uid}   leads/admins, or yourself (leave)
    PUT    /api/v1/workspaces/{ws}/teams/{team}/leads           admins {lead_ids}
    GET    /api/v1/workspaces/{ws}/teams/{team}/briefs          + /{brief|latest}, PATCH …/lines/{id}, POST …/lines, POST …/briefs/draft
    POST   /api/v1/workspaces/{ws}/teams/suggested/{group}/accept   DELETE …/suggested/{group}
    GET|PUT /api/v1/workspaces/{ws}/items/{doc_id}/teams        an item's teams / projects (move, share)
    PUT    /api/v1/workspaces/{ws}/folders/{folder_id}/teams    a folder's teams (+ its items)
    GET|POST /api/v1/workspaces/{ws}/projects                   GET|PATCH|DELETE …/projects/{project}
    GET    /api/v1/workspaces/{ws}/teams-review                 admins: the guided review; POST …/apply, POST …/done
    GET|PUT /api/v1/meetings/{meeting_id}/teams                 a meeting's teams (suggestions, confirm)

Members of the workspace only (anyone else: 404).
"""

# No `from __future__ import annotations`: slowapi wraps these routes (see routers/docs_ai.py).
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.encoders import jsonable_encoder
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.services import access
from app.services import team_briefs as briefs
from app.services import team_routing as routing
from app.services import teams as T
from app.utils.net import get_client_ip

router = APIRouter(prefix="/api/v1/workspaces", tags=["teams"])
meetings_router = APIRouter(prefix="/api/v1/meetings", tags=["teams"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


async def _ctx(request: Request, db, user: User, workspace_id: str):
    from app.services import workspace as ws_service

    role = await ws_service.role_for(db, workspace_id, user.id) if T.oid(workspace_id) else None
    if role is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    actor = access.actor_from_request(request, user)
    ctx = access.Ctx(db, surface="rest", ip=get_client_ip(request))
    view = await ctx.team_view(workspace_id, user.id)
    return actor, ctx, view, role


def _err(exc: T.Refused) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=exc.detail)


async def _team(db, view: T.TeamView, ref: str) -> dict:
    row = await T.get_team(db, view.workspace_id, ref)
    if row is None:
        raise HTTPException(status_code=404, detail="Team not found")
    return row


async def _readable_team(db, view: T.TeamView, ref: str) -> dict:
    row = await _team(db, view, ref)
    if str(row["_id"]) not in view.readable_teams:
        raise HTTPException(status_code=404, detail="Team not found")
    return row


def _fresh(ctx: access.Ctx) -> None:
    ctx.forget()


# ── Bodies ───────────────────────────────────────────────────────────────────

Color = Literal["blue", "green", "amber", "red", "violet", "pink", "teal", "gray"]


class SlackChannel(BaseModel):
    id: str = Field(..., min_length=1, max_length=40)
    name: Optional[str] = Field(None, max_length=80)


class Digest(BaseModel):
    enabled: bool = True
    email: bool = True
    slack: bool = True


class TeamCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    icon: Optional[str] = Field(None, max_length=16)
    color: Optional[Color] = None
    description: Optional[str] = Field(None, max_length=400)
    visibility: Literal["open", "private"] = "open"
    lead_ids: list[str] = Field(default_factory=list, max_length=50)
    member_ids: list[str] = Field(default_factory=list, max_length=1000)


class TeamPatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    icon: Optional[str] = Field(None, max_length=16)
    color: Optional[Color] = None
    description: Optional[str] = Field(None, max_length=400)
    visibility: Optional[Literal["open", "private"]] = None
    slack_channel: Optional[SlackChannel] = None
    slack_comments: Optional[bool] = Field(None, description="Post new and resolved comments on the team's items to its Slack channel (default on).")
    jira_projects: Optional[list[str]] = Field(None, max_length=20)
    digest: Optional[Digest] = None


class Members(BaseModel):
    user_ids: list[str] = Field(..., min_length=1, max_length=500)


class Leads(BaseModel):
    lead_ids: list[str] = Field(..., min_length=1, max_length=50)


class Accept(BaseModel):
    name: Optional[str] = Field(None, max_length=80)
    visibility: Literal["open", "private"] = "open"
    lead_ids: list[str] = Field(default_factory=list, max_length=50)
    icon: Optional[str] = Field(None, max_length=16)
    color: Optional[Color] = None


class ItemTeams(BaseModel):
    team_ids: list[str] = Field(default_factory=list, max_length=20)
    project_ids: list[str] = Field(default_factory=list, max_length=20)


class FolderTeams(ItemTeams):
    apply_to_items: bool = True


class ProjectCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    team_ids: list[str] = Field(..., min_length=1, max_length=20)
    icon: Optional[str] = Field(None, max_length=16)
    color: Optional[Color] = None
    description: Optional[str] = Field(None, max_length=400)
    member_ids: list[str] = Field(default_factory=list, max_length=500)
    visibility: Optional[Literal["open", "private"]] = None


class ProjectPatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    team_ids: Optional[list[str]] = Field(None, max_length=20)
    icon: Optional[str] = Field(None, max_length=16)
    color: Optional[Color] = None
    description: Optional[str] = Field(None, max_length=400)
    member_ids: Optional[list[str]] = Field(None, max_length=500)
    visibility: Optional[Literal["open", "private"]] = None
    status: Optional[Literal["active", "archived"]] = None


class LineEdit(BaseModel):
    text: Optional[str] = Field(None, max_length=600)
    hidden: Optional[bool] = None


class LineAdd(BaseModel):
    text: str = Field(..., min_length=1, max_length=600)
    kind: Optional[Literal["shipped", "decision", "update", "blocker", "focus", "note"]] = None


class Move(BaseModel):
    kind: Literal["meeting", "page", "folder"]
    id: str = Field(..., min_length=1, max_length=40)
    team_ids: list[str] = Field(default_factory=list, max_length=20)


class Apply(BaseModel):
    moves: list[Move] = Field(..., max_length=1000)


def _body(m: BaseModel) -> dict:
    return m.model_dump(exclude_unset=True)


# ── Sidebar / browse ─────────────────────────────────────────────────────────


@router.get("/{workspace_id}/teams", summary="Teams: the sidebar")
@limiter.limit("240/minute")
async def sidebar(request: Request, workspace_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    """``{my_role, can_create, teams (mine), projects (readable), browse {open, private}, suggested (admins), review}``."""
    actor, ctx, view, role = await _ctx(request, db, user, workspace_id)
    g = view.teams.get(view.general_id or "")
    if g is None or user.id not in (g.get("member_ids") or []):
        # The default team (General) exists and has everyone in it (it self-heals here; the sidebar asks often).
        await T.ensure_general(db, workspace_id)
        view = await T.load_view(db, workspace_id, user.id, role)
    # General first (pinned), then the rest by name.
    mine = sorted((T.team_card(view, t) for tid, t in view.teams.items() if tid in view.member_teams),
                  key=lambda c: (not c["general"], (c["name"] or "").casefold()))
    projects = sorted((T.project_card(view, p) for pid, p in view.projects.items()
                       if pid in view.readable_projects and (p.get("status") or "active") == "active"),
                      key=lambda c: (c["name"] or "").casefold())
    vis = [t.get("visibility") for t in view.teams.values() if not T.is_general(t)]
    return jsonable_encoder({"my_role": role, "can_create": view.admin, "teams": mine, "projects": projects,
                             "browse": {"open": vis.count("open"), "private": vis.count("private")},
                             "suggested": await T.suggested(db, view), "review": await routing.pending(db, view)})


@router.get("/{workspace_id}/teams/browse", summary="Teams: browse")
@limiter.limit("240/minute")
async def browse(request: Request, workspace_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                 user: User = Depends(require_user)):
    actor, ctx, view, _role = await _ctx(request, db, user, workspace_id)
    return jsonable_encoder({"teams": sorted((T.team_card(view, t) for t in view.teams.values()),
                                             key=lambda c: (not c["general"], (c["name"] or "").casefold()))})


@router.get("/{workspace_id}/teams-review", summary="Teams: the guided review (admins)")
@limiter.limit("60/minute")
async def review(request: Request, workspace_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                 user: User = Depends(require_user)):
    actor, ctx, view, _role = await _ctx(request, db, user, workspace_id)
    try:
        return jsonable_encoder(await routing.review(db, view))
    except T.Refused as exc:
        raise _err(exc)


@router.post("/{workspace_id}/teams-review/apply", summary="Teams: apply the review's moves (admins)")
@limiter.limit("30/minute")
async def review_apply(request: Request, workspace_id: str, body: Apply, db: AsyncIOMotorDatabase = Depends(get_db),
                       user: User = Depends(require_user)):
    actor, ctx, view, _role = await _ctx(request, db, user, workspace_id)
    try:
        return await routing.apply(db, actor, ctx, view, [m.model_dump() for m in body.moves])
    except T.Refused as exc:
        raise _err(exc)


@router.post("/{workspace_id}/teams-review/done", status_code=204, summary="Teams: finish the review (admins)")
@limiter.limit("30/minute")
async def review_done(request: Request, workspace_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    actor, ctx, view, _role = await _ctx(request, db, user, workspace_id)
    try:
        await routing.done(db, view)
    except T.Refused as exc:
        raise _err(exc)
    return Response(status_code=204)


@router.post("/{workspace_id}/teams", status_code=201, summary="Teams: create (admins)")
@limiter.limit("60/minute")
async def create(request: Request, workspace_id: str, body: TeamCreate, db: AsyncIOMotorDatabase = Depends(get_db),
                 user: User = Depends(require_user)):
    actor, ctx, view, _role = await _ctx(request, db, user, workspace_id)
    try:
        row = await T.create_team(db, view, _body(body))
    except T.Refused as exc:
        raise _err(exc)
    view = await T.load_view(db, workspace_id, user.id, _role)
    return jsonable_encoder(T.team_full(view, row, await T.people(db, workspace_id)))


@router.post("/{workspace_id}/teams/suggested/{group_id}/accept", status_code=201, summary="Teams: accept a suggested team")
@limiter.limit("60/minute")
async def accept(request: Request, workspace_id: str, group_id: str, body: Accept,
                 db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    actor, ctx, view, role = await _ctx(request, db, user, workspace_id)
    try:
        row = await T.accept_suggested(db, view, group_id, _body(body))
    except T.Refused as exc:
        raise _err(exc)
    view = await T.load_view(db, workspace_id, user.id, role)
    return jsonable_encoder(T.team_full(view, row, await T.people(db, workspace_id)))


@router.delete("/{workspace_id}/teams/suggested/{group_id}", status_code=204, summary="Teams: dismiss a suggested team")
@limiter.limit("60/minute")
async def dismiss(request: Request, workspace_id: str, group_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    actor, ctx, view, _role = await _ctx(request, db, user, workspace_id)
    try:
        await T.dismiss_suggested(db, view, group_id)
    except T.Refused as exc:
        raise _err(exc)
    return Response(status_code=204)


# ── One team ─────────────────────────────────────────────────────────────────


async def team_home(db, actor: access.Actor, ctx: access.Ctx, view: T.TeamView, team: dict) -> dict:
    from app.services import meetings, team_extras, workspace_items
    from app.services import workspace_memory as wm

    tid = str(team["_id"])
    ppl = await T.people(db, view.workspace_id)
    latest = await briefs.get_brief(db, tid, "latest")
    brief = await briefs.brief_out(db, actor, ctx, view, latest, ppl) if latest else None
    if tid not in view.readable_teams:
        return {"team": T.team_card(view, team), "brief": brief, "can_read": False}
    space = f"team:{tid}"
    recent = (await workspace_items.items(db, actor, ctx, view.workspace_id, limit=10, space=space))["items"]
    try:
        mt = (await meetings.list_meetings(db, view.workspace_id, actor, ctx, limit=6, overview=False, space=space))["meetings"]
    except HTTPException:
        mt = []
    highlights: list[dict] = []
    ws = await wm.ws_info(db, view.workspace_id)
    if ws is not None and ws.on:
        try:
            s = await team_extras.compose(db, ws, await briefs._tz(db, ws.id), ai=False,
                                          team=(view, T.Space("team", tid)))
            for h in s["highlights"]:
                highlights.append({"text": h["text"], "kind": h["kind"], "person": ppl.get((h.get("person") or {}).get("id") or ""),
                                   "source": h["sources"][0] if h.get("sources") else None})
        except Exception:
            highlights = []
    members = team.get("member_ids") or []
    extra: dict = {}
    if T.is_general(team):
        extra = await _general_extras(db, actor, ctx, view, ppl)
    return {**extra, "team": T.team_full(view, team, ppl), "brief": brief, "can_read": True, "recent": recent, "meetings": mt,
            "memory": {"enabled": bool(ws and ws.on), "highlights": highlights,
                       "people": [{**ppl[u], "status": None} for u in members if u in ppl]},
            "jira": {"projects": list(team.get("jira_projects") or [])},
            "projects": [T.project_card(view, view.projects[p]) for p in T.team_project_ids(view, tid)
                         if p in view.readable_projects]}


async def _general_extras(db, actor: access.Actor, ctx: access.Ctx, view: T.TeamView, ppl: dict) -> dict:
    """General's home adds: ``across`` (one line from each other team's latest brief; a private team you can't read:
    its name only), ``activity`` (items + meetings from every team you can see, for "What's happening") and
    ``new_people`` (joined the workspace in the last 30 days)."""
    from datetime import timedelta

    from app.services import meetings, workspace_items

    across = []
    for tid, t in sorted(view.teams.items(), key=lambda kv: (kv[1].get("name") or "").casefold()):
        if T.is_general(t):
            continue
        card = T.team_card(view, t)
        line = None
        if card["can_read"] or t.get("visibility") == "open":
            b = await briefs.get_brief(db, tid, "latest")
            first = next((ln for ln in (b or {}).get("lines") or [] if not ln.get("hidden")), None)
            line = first.get("text") if first else None
        across.append({"team": card, "line": line})
    try:
        items = (await workspace_items.items(db, actor, ctx, view.workspace_id, limit=12))["items"]
    except HTTPException:
        items = []
    try:
        mts = (await meetings.list_meetings(db, view.workspace_id, actor, ctx, limit=6, overview=False))["meetings"]
    except HTTPException:
        mts = []
    since = T.now_utc() - timedelta(days=30)
    joined = await db["memberships"].find({"workspace_id": view.workspace_id, "created_at": {"$gte": since}},
                                          {"user_id": 1, "created_at": 1}).sort("created_at", -1).limit(6).to_list(length=6)
    return {"across": across, "activity": {"items": items, "meetings": mts},
            "new_people": [{**ppl[m["user_id"]], "joined_at": m.get("created_at")} for m in joined if m.get("user_id") in ppl]}


@router.get("/{workspace_id}/teams/{team}", summary="Teams: a team's home")
@limiter.limit("240/minute")
async def get_team(request: Request, workspace_id: str, team: str, db: AsyncIOMotorDatabase = Depends(get_db),
                   user: User = Depends(require_user)):
    actor, ctx, view, _role = await _ctx(request, db, user, workspace_id)
    row = await _team(db, view, team)
    return jsonable_encoder(await team_home(db, actor, ctx, view, row))


async def _full(db, workspace_id: str, user: User, role: str, row: dict) -> dict:
    view = await T.load_view(db, workspace_id, user.id, role)
    return jsonable_encoder(T.team_full(view, row, await T.people(db, workspace_id)))


@router.patch("/{workspace_id}/teams/{team}", summary="Teams: settings")
@limiter.limit("120/minute")
async def patch_team(request: Request, workspace_id: str, team: str, body: TeamPatch,
                     db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    actor, ctx, view, role = await _ctx(request, db, user, workspace_id)
    row = await _readable_team(db, view, team)
    data = _body(body)
    if "slack_channel" in data and body.slack_channel is None:
        data["slack_channel"] = None
    try:
        row = await T.update_team(db, view, row, data)
    except T.Refused as exc:
        raise _err(exc)
    return await _full(db, workspace_id, user, role, row)


@router.delete("/{workspace_id}/teams/{team}", status_code=204, summary="Teams: delete (admins)")
@limiter.limit("30/minute")
async def delete_team(request: Request, workspace_id: str, team: str, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    actor, ctx, view, _role = await _ctx(request, db, user, workspace_id)
    row = await _team(db, view, team)
    try:
        await T.delete_team(db, view, row)
    except T.Refused as exc:
        raise _err(exc)
    return Response(status_code=204)


@router.post("/{workspace_id}/teams/{team}/members", summary="Teams: add members")
@limiter.limit("120/minute")
async def add_members(request: Request, workspace_id: str, team: str, body: Members,
                      db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    actor, ctx, view, role = await _ctx(request, db, user, workspace_id)
    row = await _readable_team(db, view, team)
    try:
        row = await T.add_members(db, view, row, body.user_ids)
    except T.Refused as exc:
        raise _err(exc)
    return await _full(db, workspace_id, user, role, row)


@router.delete("/{workspace_id}/teams/{team}/members/{user_id}", summary="Teams: remove a member (or leave)")
@limiter.limit("120/minute")
async def remove_member(request: Request, workspace_id: str, team: str, user_id: str,
                        db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    actor, ctx, view, role = await _ctx(request, db, user, workspace_id)
    row = await _readable_team(db, view, team)
    try:
        row = await T.remove_member(db, view, row, user_id)
    except T.Refused as exc:
        raise _err(exc)
    return await _full(db, workspace_id, user, role, row)


@router.put("/{workspace_id}/teams/{team}/leads", summary="Teams: pick leads (admins)")
@limiter.limit("60/minute")
async def put_leads(request: Request, workspace_id: str, team: str, body: Leads,
                    db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    actor, ctx, view, role = await _ctx(request, db, user, workspace_id)
    row = await _team(db, view, team)
    try:
        row = await T.set_leads(db, view, row, body.lead_ids)
    except T.Refused as exc:
        raise _err(exc)
    return await _full(db, workspace_id, user, role, row)


# ── Briefs ───────────────────────────────────────────────────────────────────


@router.get("/{workspace_id}/teams/{team}/briefs", summary="Teams: a team's briefs")
@limiter.limit("240/minute")
async def list_briefs(request: Request, workspace_id: str, team: str, limit: int = 8,
                      db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    actor, ctx, view, _role = await _ctx(request, db, user, workspace_id)
    row = await _team(db, view, team)
    return jsonable_encoder({"briefs": await briefs.list_briefs(db, str(row["_id"]), max(1, min(52, limit)))})


@router.post("/{workspace_id}/teams/{team}/briefs/draft", summary="Teams: re-draft this week's brief (leads)")
@limiter.limit("10/minute")
async def draft_brief(request: Request, workspace_id: str, team: str, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    actor, ctx, view, _role = await _ctx(request, db, user, workspace_id)
    row = await _readable_team(db, view, team)
    if not view.can_manage(str(row["_id"])):
        raise HTTPException(status_code=403, detail="Only the team's leads and workspace admins can draft its brief.")
    b = await briefs.draft(db, row)
    if b is None:
        raise HTTPException(status_code=409, detail="Turn on Team memory for this workspace to get team briefs.")
    return jsonable_encoder(await briefs.brief_out(db, actor, ctx, view, b))


@router.get("/{workspace_id}/teams/{team}/briefs/{brief}", summary="Teams: one brief")
@limiter.limit("240/minute")
async def get_brief(request: Request, workspace_id: str, team: str, brief: str,
                    db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    actor, ctx, view, _role = await _ctx(request, db, user, workspace_id)
    row = await _team(db, view, team)
    b = await briefs.get_brief(db, str(row["_id"]), brief)
    if b is None:
        raise HTTPException(status_code=404, detail="Brief not found")
    return jsonable_encoder(await briefs.brief_out(db, actor, ctx, view, b))


@router.patch("/{workspace_id}/teams/{team}/briefs/{brief}/lines/{line_id}", summary="Teams: edit or hide a brief line")
@limiter.limit("120/minute")
async def edit_line(request: Request, workspace_id: str, team: str, brief: str, line_id: str, body: LineEdit,
                    db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    actor, ctx, view, _role = await _ctx(request, db, user, workspace_id)
    row = await _team(db, view, team)
    b = await briefs.get_brief(db, str(row["_id"]), brief)
    if b is None:
        raise HTTPException(status_code=404, detail="Brief not found")
    try:
        b = await briefs.edit_line(db, view, b, line_id, text=body.text, hidden=body.hidden)
    except T.Refused as exc:
        raise _err(exc)
    return jsonable_encoder(await briefs.brief_out(db, actor, ctx, view, b))


@router.post("/{workspace_id}/teams/{team}/briefs/{brief}/lines", summary="Teams: add a brief line")
@limiter.limit("60/minute")
async def add_line(request: Request, workspace_id: str, team: str, brief: str, body: LineAdd,
                   db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    actor, ctx, view, _role = await _ctx(request, db, user, workspace_id)
    row = await _team(db, view, team)
    b = await briefs.get_brief(db, str(row["_id"]), brief)
    if b is None:
        raise HTTPException(status_code=404, detail="Brief not found")
    try:
        b = await briefs.add_line(db, view, b, body.text, body.kind)
    except T.Refused as exc:
        raise _err(exc)
    return jsonable_encoder(await briefs.brief_out(db, actor, ctx, view, b))


# ── Items / folders in teams ─────────────────────────────────────────────────


async def _item(db, workspace_id: str, doc_id: str) -> dict:
    raw = await db["documents"].find_one({"_id": T.oid(doc_id), "workspace_id": workspace_id, "deleted_at": None}) \
        if T.oid(doc_id) else None
    if raw is None:
        raw = await db["documents"].find_one({"slug": doc_id, "workspace_id": workspace_id, "deleted_at": None})
    if raw is None:
        raise HTTPException(status_code=404, detail="Item not found")
    return raw


@router.get("/{workspace_id}/items/{doc_id}/teams", summary="Teams: an item's teams")
@limiter.limit("240/minute")
async def get_item_teams(request: Request, workspace_id: str, doc_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                         user: User = Depends(require_user)):
    actor, ctx, view, _role = await _ctx(request, db, user, workspace_id)
    raw = await _item(db, workspace_id, doc_id)
    if not (await access.can(actor, raw, "read", ctx)).allowed:
        raise HTTPException(status_code=404, detail="Item not found")
    return jsonable_encoder(await T.item_teams(db, actor, ctx, raw))


@router.put("/{workspace_id}/items/{doc_id}/teams", summary="Teams: move / share an item to teams")
@limiter.limit("120/minute")
async def put_item_teams(request: Request, workspace_id: str, doc_id: str, body: ItemTeams,
                         db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    actor, ctx, view, _role = await _ctx(request, db, user, workspace_id)
    raw = await _item(db, workspace_id, doc_id)
    try:
        return jsonable_encoder(await T.set_item_teams(db, actor, ctx, raw, body.team_ids, body.project_ids))
    except T.Refused as exc:
        raise _err(exc)


@router.put("/{workspace_id}/folders/{folder_id}/teams", summary="Teams: a folder's teams")
@limiter.limit("60/minute")
async def put_folder_teams(request: Request, workspace_id: str, folder_id: str, body: FolderTeams,
                           db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    actor, ctx, view, _role = await _ctx(request, db, user, workspace_id)
    try:
        return jsonable_encoder(await T.set_folder_teams(db, actor, ctx, workspace_id, folder_id, body.team_ids,
                                                         body.project_ids, body.apply_to_items))
    except T.Refused as exc:
        raise _err(exc)


# ── Projects ─────────────────────────────────────────────────────────────────


@router.get("/{workspace_id}/projects", summary="Teams: projects")
@limiter.limit("240/minute")
async def list_projects(request: Request, workspace_id: str, team: Optional[str] = None,
                        db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    actor, ctx, view, _role = await _ctx(request, db, user, workspace_id)
    rows = [p for pid, p in view.projects.items() if pid in view.readable_projects]
    if team:
        t = await _readable_team(db, view, team)
        rows = [p for p in rows if str(t["_id"]) in [str(x) for x in p.get("team_ids") or []]]
    return jsonable_encoder({"projects": sorted((T.project_card(view, p) for p in rows),
                                                key=lambda c: (not c["general"], (c["name"] or "").casefold()))})


@router.post("/{workspace_id}/projects", status_code=201, summary="Teams: create a project")
@limiter.limit("60/minute")
async def create_project(request: Request, workspace_id: str, body: ProjectCreate,
                         db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    actor, ctx, view, role = await _ctx(request, db, user, workspace_id)
    try:
        row = await T.create_project(db, view, _body(body))
    except T.Refused as exc:
        raise _err(exc)
    view = await T.load_view(db, workspace_id, user.id, role)
    return jsonable_encoder(T.project_full(view, row, await T.people(db, workspace_id)))


async def _project(db, view: T.TeamView, ref: str) -> dict:
    row = await T.get_project(db, view.workspace_id, ref)
    if row is None or str(row["_id"]) not in view.readable_projects:
        raise HTTPException(status_code=404, detail="Project not found")
    return row


@router.get("/{workspace_id}/projects/{project}", summary="Teams: a project's home")
@limiter.limit("240/minute")
async def get_project(request: Request, workspace_id: str, project: str, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    from app.services import meetings, workspace_items

    actor, ctx, view, _role = await _ctx(request, db, user, workspace_id)
    p = await _project(db, view, project)
    space = f"project:{p['_id']}"
    ppl = await T.people(db, workspace_id)
    recent = (await workspace_items.items(db, actor, ctx, workspace_id, limit=10, space=space))["items"]
    mt = (await meetings.list_meetings(db, workspace_id, actor, ctx, limit=6, overview=False, space=space))["meetings"]
    members = T.project_members(p, view.teams)
    return jsonable_encoder({"project": T.project_full(view, p, ppl), "recent": recent, "meetings": mt,
                             "memory": {"highlights": [], "people": [ppl[u] for u in sorted(members) if u in ppl]}})


@router.patch("/{workspace_id}/projects/{project}", summary="Teams: change a project")
@limiter.limit("120/minute")
async def patch_project(request: Request, workspace_id: str, project: str, body: ProjectPatch,
                        db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    actor, ctx, view, role = await _ctx(request, db, user, workspace_id)
    p = await _project(db, view, project)
    try:
        p = await T.update_project(db, view, p, _body(body))
    except T.Refused as exc:
        raise _err(exc)
    view = await T.load_view(db, workspace_id, user.id, role)
    return jsonable_encoder(T.project_full(view, p, await T.people(db, workspace_id)))


@router.delete("/{workspace_id}/projects/{project}", status_code=204, summary="Teams: delete a project (admins)")
@limiter.limit("30/minute")
async def delete_project(request: Request, workspace_id: str, project: str, db: AsyncIOMotorDatabase = Depends(get_db),
                         user: User = Depends(require_user)):
    actor, ctx, view, _role = await _ctx(request, db, user, workspace_id)
    p = await T.get_project(db, workspace_id, project)
    if p is None:
        raise HTTPException(status_code=404, detail="Project not found")
    try:
        await T.delete_project(db, view, p)
    except T.Refused as exc:
        raise _err(exc)
    return Response(status_code=204)


# ── Meetings ─────────────────────────────────────────────────────────────────


async def _meeting(request: Request, db, user: User, meeting_id: str):
    row = await db["meetings"].find_one({"_id": T.oid(meeting_id)}, {"segments": 0}) if T.oid(meeting_id) else None
    if row is None:
        raise HTTPException(status_code=404, detail="Meeting not found")
    actor, ctx, view, _role = await _ctx(request, db, user, row["workspace_id"])
    raw = await db["documents"].find_one({"_id": row.get("doc_id")}, {"content": 0})
    if raw is None or not (await access.can(actor, raw, "read", ctx)).allowed:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return row, actor, ctx


@meetings_router.get("/{meeting_id}/teams", summary="Teams: a meeting's teams")
@limiter.limit("240/minute")
async def get_meeting_teams(request: Request, meeting_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                            user: User = Depends(require_user)):
    row, actor, ctx = await _meeting(request, db, user, meeting_id)
    return jsonable_encoder(await routing.meeting_teams(db, actor, ctx, row))


@meetings_router.put("/{meeting_id}/teams", summary="Teams: route a meeting to teams")
@limiter.limit("120/minute")
async def put_meeting_teams(request: Request, meeting_id: str, body: ItemTeams, db: AsyncIOMotorDatabase = Depends(get_db),
                            user: User = Depends(require_user)):
    row, actor, ctx = await _meeting(request, db, user, meeting_id)
    try:
        return jsonable_encoder(await routing.set_meeting_teams(db, actor, ctx, row, body.team_ids, body.project_ids))
    except T.Refused as exc:
        raise _err(exc)
