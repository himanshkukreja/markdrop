"""HubSpot: /api/v1/hubspot/… (services/hubspot.py).

Settings (signed in, markdrop.in only; workspace admins change them):
    GET    /status?workspace_id=            the Integrations card: connected?, the team, scopes, counts
    PUT    /connection                      {workspace_id, token?, team_id?}: save the HubSpot key (checked with HubSpot)
    PUT    /team                            {workspace_id, team_id}: whose calls go to HubSpot
    PUT    /settings                        {workspace_id, auto_log?, suggest?, accounts?, precall?, approve?}: the switches
    DELETE /connection?workspace_id=        disconnect: the key, the cached HubSpot lists and every match are deleted

A meeting (people who can read it and are in the HubSpot team, or workspace admins):
    GET    /meetings/{id}                   the meeting page's HubSpot section: match, deal, contacts, logged, tasks
    POST   /meetings/{id}/match             match it again
    PUT    /meetings/{id}/match             {deal_id | null}: pick the deal (Change match)
    POST   /meetings/{id}/log               Log to HubSpot (fills the HubSpot meeting's internal notes; idempotent)
    POST   /meetings/{id}/tasks             {keys}: create the approved action items as HubSpot tasks (once each)
    GET    /deals?workspace_id=&q=          search deals by name (Change match)

Phase 2 (services/hubspot_deals.py, hubspot_accounts.py, hubspot_notify.py):
    POST   /meetings/{id}/suggestions                 suggest deal updates again (one AI request)
    POST   /meetings/{id}/suggestions/{sid}/apply     apply one (PATCHes the deal; never automatic)
    POST   /meetings/{id}/suggestions/{sid}/dismiss   dismiss one
    POST   /meetings/{id}/account                     make or update the company's account page
    GET    /pipeline?workspace_id=                    deals with stage, last call and why they're at risk
    GET    /me, PUT /me {precall?, approve?}          your own pre-call briefs and Slack messages
"""

# No `from __future__ import annotations`: slowapi wraps these routes (see routers/docs_ai.py).
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import is_tenant_request, require_user
from app.services import access, hubspot, hubspot_accounts, hubspot_deals, hubspot_notify
from app.utils.net import get_client_ip

router = APIRouter(prefix="/api/v1/hubspot", tags=["hubspot"])

_WS = r"^[0-9a-f]{24}$"


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _app_only(request: Request) -> None:
    if is_tenant_request(request):
        raise HTTPException(status_code=403, detail="HubSpot is on markdrop.in.")


def _ac(request: Request, db, user: User):
    return access.actor_from_request(request, user), access.Ctx(db, surface="rest", ip=get_client_ip(request))


def _mid(meeting_id: str) -> str:
    if not (len(meeting_id) == 24 and all(c in "0123456789abcdef" for c in meeting_id)):
        raise HTTPException(status_code=404, detail="Meeting not found")
    return meeting_id


class HubSpotConnectionIn(BaseModel):
    workspace_id: str = Field(..., pattern=_WS)
    token: Optional[str] = Field(None, max_length=600, description="A HubSpot service key or private app access token. Blank: keep the saved one.")
    team_id: Optional[str] = Field(None, pattern=r"^([0-9a-f]{24})?$")


class HubSpotTeamIn(BaseModel):
    workspace_id: str = Field(..., pattern=_WS)
    team_id: str = Field(..., pattern=_WS)


class HubSpotSettingsIn(BaseModel):
    workspace_id: str = Field(..., pattern=_WS)
    auto_log: Optional[bool] = Field(None, description="Log the team's calls to HubSpot after their summary is written, when the match is confident (off by default).")
    suggest: Optional[bool] = Field(None, description="Suggest deal updates after a call matched to a deal (on by default; never applied without a person).")
    accounts: Optional[bool] = Field(None, description="Keep an account page per HubSpot company (on by default).")
    precall: Optional[bool] = Field(None, description="Pre-call briefs to the team's members before their HubSpot meetings (on by default).")
    approve: Optional[bool] = Field(None, description="A Slack message to the call's host with Log to HubSpot and Create tasks buttons (on by default).")
    deal_updates: Optional[bool] = Field(None, description="Let Apply on a suggested deal update change the deal in HubSpot (off by default; the key also needs crm.objects.deals.write).")


class HubSpotMeIn(BaseModel):
    precall: Optional[bool] = Field(None, description="Pre-call briefs before your HubSpot meetings.")
    approve: Optional[bool] = Field(None, description="The Slack message after your calls with Log to HubSpot and Create tasks.")


class HubSpotMatchIn(BaseModel):
    deal_id: Optional[str] = Field(None, pattern=r"^[0-9]{1,20}$", description="The HubSpot deal; null: none of them.")


class HubSpotTasksIn(BaseModel):
    keys: list[str] = Field(..., min_length=1, max_length=50, description="The proposed tasks' keys (from GET /meetings/{id}).")


@router.get("/status", summary="HubSpot connection status")
@limiter.limit("120/minute")
async def status(request: Request, workspace_id: str = Query(..., pattern=_WS),
                 db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    _app_only(request)
    return await hubspot.status(db, user, workspace_id)


@router.put("/connection", summary="Connect HubSpot (a service key)")
@limiter.limit("20/minute")
async def put_connection(request: Request, body: HubSpotConnectionIn, db: AsyncIOMotorDatabase = Depends(get_db),
                         user: User = Depends(require_user)):
    _app_only(request)
    return await hubspot.connect(db, user, body.workspace_id, token=body.token, team_id=body.team_id)


@router.put("/team", summary="The team whose calls go to HubSpot")
@limiter.limit("30/minute")
async def put_team(request: Request, body: HubSpotTeamIn, db: AsyncIOMotorDatabase = Depends(get_db),
                   user: User = Depends(require_user)):
    _app_only(request)
    return await hubspot.set_team(db, user, body.workspace_id, body.team_id)


@router.put("/settings", summary="HubSpot's switches for the workspace")
@limiter.limit("30/minute")
async def put_settings(request: Request, body: HubSpotSettingsIn, db: AsyncIOMotorDatabase = Depends(get_db),
                       user: User = Depends(require_user)):
    _app_only(request)
    return await hubspot.set_settings(db, user, body.workspace_id, body.model_dump(exclude={"workspace_id"}))


@router.delete("/connection", summary="Disconnect HubSpot")
@limiter.limit("20/minute")
async def delete_connection(request: Request, workspace_id: str = Query(..., pattern=_WS),
                            db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    _app_only(request)
    return await hubspot.disconnect(db, user, workspace_id)


@router.get("/meetings/{meeting_id}", summary="A meeting in HubSpot")
@limiter.limit("60/minute")
async def meeting(request: Request, meeting_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    _app_only(request)
    actor, ctx = _ac(request, db, user)
    return await hubspot.panel(db, user, actor, ctx, _mid(meeting_id))


@router.post("/meetings/{meeting_id}/match", summary="Match a meeting to HubSpot again")
@limiter.limit("20/minute")
async def rematch(request: Request, meeting_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    _app_only(request)
    actor, ctx = _ac(request, db, user)
    return await hubspot.rematch(db, user, actor, ctx, _mid(meeting_id))


@router.put("/meetings/{meeting_id}/match", summary="Pick a meeting's HubSpot deal")
@limiter.limit("30/minute")
async def set_match(request: Request, meeting_id: str, body: HubSpotMatchIn, db: AsyncIOMotorDatabase = Depends(get_db),
                    user: User = Depends(require_user)):
    _app_only(request)
    actor, ctx = _ac(request, db, user)
    return await hubspot.set_match(db, user, actor, ctx, _mid(meeting_id), body.deal_id)


@router.post("/meetings/{meeting_id}/log", summary="Log a meeting to HubSpot")
@limiter.limit("20/minute")
async def log_meeting(request: Request, meeting_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    _app_only(request)
    actor, ctx = _ac(request, db, user)
    return await hubspot.log_meeting(db, user, actor, ctx, _mid(meeting_id))


@router.post("/meetings/{meeting_id}/tasks", summary="Create a meeting's action items as HubSpot tasks")
@limiter.limit("20/minute")
async def create_tasks(request: Request, meeting_id: str, body: HubSpotTasksIn, db: AsyncIOMotorDatabase = Depends(get_db),
                       user: User = Depends(require_user)):
    _app_only(request)
    actor, ctx = _ac(request, db, user)
    return await hubspot.create_tasks(db, user, actor, ctx, _mid(meeting_id), [k[:32] for k in body.keys])


@router.get("/deals", summary="Search HubSpot deals")
@limiter.limit("60/minute")
async def deals(request: Request, workspace_id: str = Query(..., pattern=_WS), q: str = Query("", max_length=100),
                db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    _app_only(request)
    return await hubspot.search_deals(db, user, workspace_id, q)


_SID = r"^[0-9a-f]{12}$"


def _sid(sid: str) -> str:
    if not (len(sid) == 12 and all(c in "0123456789abcdef" for c in sid)):
        raise HTTPException(status_code=404, detail="That suggestion isn't there any more.")
    return sid


@router.post("/meetings/{meeting_id}/suggestions", summary="Suggest HubSpot deal updates for a meeting")
@limiter.limit("10/minute")
async def suggest(request: Request, meeting_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    _app_only(request)
    actor, ctx = _ac(request, db, user)
    return await hubspot_deals.request(db, user, actor, ctx, _mid(meeting_id))


@router.post("/meetings/{meeting_id}/suggestions/{suggestion_id}/apply", summary="Apply a suggested deal update")
@limiter.limit("30/minute")
async def apply_suggestion(request: Request, meeting_id: str, suggestion_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                           user: User = Depends(require_user)):
    _app_only(request)
    actor, ctx = _ac(request, db, user)
    return await hubspot_deals.apply(db, user, actor, ctx, _mid(meeting_id), _sid(suggestion_id))


@router.post("/meetings/{meeting_id}/suggestions/{suggestion_id}/dismiss", summary="Dismiss a suggested deal update")
@limiter.limit("60/minute")
async def dismiss_suggestion(request: Request, meeting_id: str, suggestion_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                             user: User = Depends(require_user)):
    _app_only(request)
    actor, ctx = _ac(request, db, user)
    return await hubspot_deals.dismiss(db, user, actor, ctx, _mid(meeting_id), _sid(suggestion_id))


@router.post("/meetings/{meeting_id}/account", summary="Make or update a meeting's account page")
@limiter.limit("20/minute")
async def account(request: Request, meeting_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    _app_only(request)
    actor, ctx = _ac(request, db, user)
    out = await hubspot_accounts.account(db, user, actor, ctx, _mid(meeting_id), refresh_now=True)
    return {k: out.get(k) for k in ("name", "slug", "href", "updated_at")}


@router.get("/pipeline", summary="The HubSpot pipeline")
@limiter.limit("30/minute")
async def pipeline(request: Request, workspace_id: str = Query(..., pattern=_WS), db: AsyncIOMotorDatabase = Depends(get_db),
                   user: User = Depends(require_user)):
    _app_only(request)
    return await hubspot_deals.pipeline_for(db, user, workspace_id)


@router.get("/me", summary="Your HubSpot messages")
@limiter.limit("60/minute")
async def get_me(request: Request, db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    _app_only(request)
    return await hubspot_notify.me(db, user)


@router.put("/me", summary="Turn your HubSpot messages on or off")
@limiter.limit("30/minute")
async def put_me(request: Request, body: HubSpotMeIn, db: AsyncIOMotorDatabase = Depends(get_db),
                 user: User = Depends(require_user)):
    _app_only(request)
    return await hubspot_notify.set_me(db, user, body.model_dump())
