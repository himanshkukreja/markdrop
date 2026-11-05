"""Markdrop for Slack: /api/v1/slack/… (services/slack.py, slack_events.py, slack_notify.py).

Settings (signed in, markdrop.in only):
    GET    /status?workspace_id=              the card: set up?, the connected team, me (linked?, prefs)
    POST   /install {workspace_id}            → {url}: Add to Slack (workspace admins and owners)
    POST   /connect {code, state}             the end of Add to Slack
    DELETE /install?workspace_id=             disconnect (uninstalls the app from that Slack team)
    GET    /channels?workspace_id=            channels the meetings post can go to (admins)
    PATCH  /settings {workspace_id, meetings_channel_id?, post_meetings?}            (admins)
    POST   /link/start {workspace_id | team_id} → {url}: Sign in with Slack to link my account
    GET    /link/info?team_id=                which Slack team a link page is for
    POST   /link/finish {code, state}         the end of Sign in with Slack
    DELETE /link?workspace_id=                unlink my Slack account
    PATCH  /me/prefs {mention?, signoff_requested?, shared?, access_request?}   my Slack DMs
    POST   /meetings/{meeting_id}/post        post (again) to the meetings channel (who can edit it)

From Slack (signed with the app's signing secret; no user session; out of the public schema):
    POST   /events          Events API: url_verification, link_shared, app_uninstalled, tokens_revoked
    POST   /commands        /markdrop
    POST   /interactivity   button clicks
"""

# No `from __future__ import annotations`: slowapi wraps these routes (see routers/docs_ai.py).
import json
import logging
from urllib.parse import parse_qs

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import is_tenant_request, require_user
from app.services import access, slack, slack_events, slack_notify

log = logging.getLogger("markdrop.slack")

router = APIRouter(prefix="/api/v1/slack", tags=["slack"])

MAX_BODY = 256 * 1024
_WS = r"^[0-9a-f]{24}$"


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _app_only(request: Request) -> None:
    if is_tenant_request(request):
        raise HTTPException(status_code=403, detail="Slack settings are on markdrop.in.")


class WorkspaceIn(BaseModel):
    workspace_id: str = Field(..., pattern=_WS)


class CodeIn(BaseModel):
    code: str = Field(..., min_length=1, max_length=500)
    state: str = Field(..., min_length=1, max_length=1000)


class SettingsIn(BaseModel):
    workspace_id: str = Field(..., pattern=_WS)
    meetings_channel_id: str | None = Field(None, max_length=40)
    clear_channel: bool = False
    post_meetings: bool | None = None


class LinkStartIn(BaseModel):
    workspace_id: str | None = Field(None, pattern=_WS)
    team_id: str | None = Field(None, pattern=r"^[A-Z0-9]{3,20}$")


class PrefsIn(BaseModel):
    mention: bool | None = None
    signoff_requested: bool | None = None
    shared: bool | None = None
    access_request: bool | None = None


# ── Settings ──────────────────────────────────────────────────────────────────


@router.get("/status", summary="Slack connection status")
@limiter.limit("120/minute")
async def status(request: Request, workspace_id: str = Query(..., pattern=_WS),
                 db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    _app_only(request)
    return await slack.status(db, user, workspace_id)


@router.post("/install", summary="Start Add to Slack")
@limiter.limit("20/minute")
async def install(request: Request, body: WorkspaceIn, db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    _app_only(request)
    slack.need_configured()
    await slack.require_admin(db, user, body.workspace_id)
    return {"url": slack.install_url(slack.sign_state("install", user.id, body.workspace_id))}


@router.post("/connect", summary="Finish Add to Slack")
@limiter.limit("20/minute")
async def connect(request: Request, body: CodeIn, db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    _app_only(request)
    return await slack.connect(db, user, body.code, body.state)


@router.delete("/install", summary="Disconnect Slack")
@limiter.limit("20/minute")
async def disconnect(request: Request, workspace_id: str = Query(..., pattern=_WS),
                     db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    _app_only(request)
    await slack.disconnect(db, user, workspace_id)
    return await slack.status(db, user, workspace_id)


@router.get("/channels", summary="Slack channels for meeting posts")
@limiter.limit("30/minute")
async def channels(request: Request, workspace_id: str = Query(..., pattern=_WS),
                   db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    _app_only(request)
    await slack.require_admin(db, user, workspace_id)
    inst = await slack.install_for_workspace(db, workspace_id)
    if inst is None:
        raise HTTPException(status_code=404, detail="Slack isn't connected to this workspace.")
    return {"channels": await slack.channels(db, inst)}


@router.patch("/settings", summary="Choose the meetings channel")
@limiter.limit("30/minute")
async def settings(request: Request, body: SettingsIn, db: AsyncIOMotorDatabase = Depends(get_db),
                   user: User = Depends(require_user)):
    _app_only(request)
    chan = None if body.clear_channel else (body.meetings_channel_id or ...)
    return await slack.set_settings(db, user, body.workspace_id, channel_id=chan, post_meetings=body.post_meetings)


@router.post("/link/start", summary="Start linking my Slack account")
@limiter.limit("20/minute")
async def link_start(request: Request, body: LinkStartIn, db: AsyncIOMotorDatabase = Depends(get_db),
                     user: User = Depends(require_user)):
    _app_only(request)
    if not body.workspace_id and not body.team_id:
        raise HTTPException(status_code=422, detail="Pass workspace_id or team_id.")
    return {"url": await slack.start_link(db, user, workspace_id=body.workspace_id, team_id=body.team_id)}


@router.get("/link/info", summary="The Slack workspace a link page is for")
@limiter.limit("30/minute")
async def link_info(request: Request, team_id: str = Query(..., pattern=r"^[A-Z0-9]{3,20}$"),
                    db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    _app_only(request)
    return await slack.link_info(db, user, team_id)


@router.post("/link/finish", summary="Finish linking my Slack account")
@limiter.limit("20/minute")
async def link_finish(request: Request, body: CodeIn, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    _app_only(request)
    return await slack.finish_link(db, user, body.code, body.state)


@router.delete("/link", summary="Unlink my Slack account")
@limiter.limit("20/minute")
async def unlink(request: Request, workspace_id: str = Query(..., pattern=_WS),
                 db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    _app_only(request)
    return await slack.unlink(db, user, workspace_id)


@router.patch("/me/prefs", summary="My Slack notifications")
@limiter.limit("60/minute")
async def prefs(request: Request, body: PrefsIn, db: AsyncIOMotorDatabase = Depends(get_db),
                user: User = Depends(require_user)):
    _app_only(request)
    return {"prefs": await slack.set_prefs(db, user.id, body.model_dump(exclude_none=True))}


@router.post("/meetings/{meeting_id}/post", summary="Post a meeting to Slack")
@limiter.limit("10/minute")
async def post_meeting(request: Request, meeting_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                       user: User = Depends(require_user)):
    """Who can edit the meeting's page may post it (again) to the workspace's meetings channel. The
    channel rule still applies: a meeting the whole channel may not see is never posted."""
    from app.services import meetings

    _app_only(request)
    slack.need_configured()
    actor, ctx = access.actor_from_request(request, user), access.Ctx(db)
    row, raw = await meetings.for_read(db, meeting_id, actor, ctx)
    if not (await access.can(actor, raw, "edit_content", ctx)).allowed:
        raise HTTPException(status_code=403, detail="You can post meetings you can edit.")
    out = await slack_notify.post_meeting(db, str(row["_id"]), again=True)
    if not out["posted"]:
        detail = {
            "not_connected": "Slack isn't connected to this workspace.",
            "no_channel": "Choose a meetings channel in Workspace settings › Integrations › Slack first.",
            "private": "Only meetings everyone in the channel may open are posted. This one is restricted.",
            "token": "Slack's connection broke. Reconnect it in Workspace settings.",
            "not_in_channel": "Invite @Markdrop to the meetings channel first (/invite @Markdrop).",
            "channel_not_found": "The meetings channel is gone. Choose another one.",
            "is_archived": "The meetings channel is archived. Choose another one.",
        }.get(out["reason"] or "", "Slack didn't take the post. Try again in a minute.")
        raise HTTPException(status_code=409, detail=detail)
    return out


# ── From Slack ────────────────────────────────────────────────────────────────


async def _body(request: Request) -> bytes | None:
    n = int(request.headers.get("content-length") or 0)
    if n > MAX_BODY:
        return None
    raw = b""
    async for chunk in request.stream():
        raw += chunk
        if len(raw) > MAX_BODY:
            return None
    return raw


async def _verified(request: Request, db) -> tuple[bytes | None, JSONResponse | None]:
    if not slack.configured():
        return None, JSONResponse({"detail": "not set up"}, status_code=503)
    raw = await _body(request)
    if raw is None:
        return None, JSONResponse({"detail": "too large"}, status_code=413)
    why = await slack.verify_and_claim(db, request.headers, raw)
    if why:
        log.info("slack: refused a request (%s)", why)
        return None, JSONResponse({"detail": why}, status_code=401)
    return raw, None


def _form(raw: bytes) -> dict:
    return {k: v[0] for k, v in parse_qs(raw.decode("utf-8", "replace"), keep_blank_values=True).items()}


@router.post("/events", include_in_schema=False)
async def events(request: Request, db: AsyncIOMotorDatabase = Depends(get_db)):
    raw, err = await _verified(request, db)
    if err is not None:
        return err
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        return JSONResponse({"detail": "body must be JSON"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"detail": "body must be a JSON object"}, status_code=400)
    if body.get("type") == "url_verification":
        return {"challenge": str(body.get("challenge") or "")[:200]}
    if body.get("type") != "event_callback":
        return {"ok": True}
    eid = str(body.get("event_id") or "")
    if eid and not await slack.remember(db, "evt:" + eid, slack.EVENT_TTL):
        return {"ok": True, "duplicate": True}  # Slack's retry of one we already have
    slack.spawn(slack_events.event(db, body))
    return {"ok": True}


@router.post("/commands", include_in_schema=False)
async def commands(request: Request, db: AsyncIOMotorDatabase = Depends(get_db)):
    raw, err = await _verified(request, db)
    if err is not None:
        return err
    form = _form(raw or b"")
    return await slack_events.command(db, form)


@router.post("/interactivity", include_in_schema=False)
async def interactivity(request: Request, db: AsyncIOMotorDatabase = Depends(get_db)):
    raw, err = await _verified(request, db)
    if err is not None:
        return err
    try:
        payload = json.loads(_form(raw or b"").get("payload") or "{}")
    except ValueError:
        return JSONResponse({"detail": "payload must be JSON"}, status_code=400)
    if isinstance(payload, dict):
        slack.spawn(slack_events.interaction(db, payload))
    return Response(status_code=200)
