"""Zoom: /api/v1/zoom/… (services/zoom.py).

Settings (signed in, markdrop.in only):
    GET    /status?workspace_id=            the Integrations card: connected?, the team, counts, recent imports
    PUT    /connection                      {workspace_id, account_id, client_id, client_secret?, secret_token?, team_id?}
                                            save the workspace's Server-to-Server OAuth app (admins; checked with Zoom)
    PUT    /team                            {workspace_id, team_id}: where Zoom meetings go (admins)
    DELETE /connection?workspace_id=        disconnect (admins): the credentials are deleted

Import past meetings (admins and the team's leads):
    GET    /recordings?workspace_id=&days=|from=&to=   the team members' recorded meetings
    POST   /import {workspace_id, uuids}    import the chosen ones

From Zoom (no session; Zoom's signature with the workspace's Secret Token; out of the public schema):
    POST   /webhook/{workspace_id}
"""

# No `from __future__ import annotations`: slowapi wraps these routes (see routers/docs_ai.py).
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import is_tenant_request, require_user
from app.services import zoom

log = logging.getLogger("markdrop.zoom")

router = APIRouter(prefix="/api/v1/zoom", tags=["zoom"])

_WS = r"^[0-9a-f]{24}$"
MAX_BODY = 1024 * 1024


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _app_only(request: Request) -> None:
    if is_tenant_request(request):
        raise HTTPException(status_code=403, detail="Zoom settings are on markdrop.in.")


class ConnectionIn(BaseModel):
    workspace_id: str = Field(..., pattern=_WS)
    account_id: str = Field(..., min_length=1, max_length=128)
    client_id: str = Field(..., min_length=1, max_length=128)
    client_secret: Optional[str] = Field(None, max_length=256, description="Blank: keep the saved one.")
    secret_token: Optional[str] = Field(None, max_length=256, description="The event subscription's Secret Token. Blank: keep the saved one.")
    team_id: Optional[str] = Field(None, pattern=r"^([0-9a-f]{24})?$")


class TeamIn(BaseModel):
    workspace_id: str = Field(..., pattern=_WS)
    team_id: str = Field(..., pattern=_WS)


class ImportIn(BaseModel):
    workspace_id: str = Field(..., pattern=_WS)
    uuids: list[str] = Field(..., min_length=1, max_length=zoom.MAX_IMPORT)


@router.get("/status", summary="Zoom connection status")
@limiter.limit("120/minute")
async def status(request: Request, workspace_id: str = Query(..., pattern=_WS),
                 db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    _app_only(request)
    return await zoom.status(db, user, workspace_id)


@router.put("/connection", summary="Connect Zoom (a Server-to-Server OAuth app)")
@limiter.limit("20/minute")
async def put_connection(request: Request, body: ConnectionIn, db: AsyncIOMotorDatabase = Depends(get_db),
                         user: User = Depends(require_user)):
    _app_only(request)
    return await zoom.connect(db, user, body.workspace_id, account_id=body.account_id, client_id=body.client_id,
                              client_secret=body.client_secret, secret_token=body.secret_token, team_id=body.team_id)


@router.put("/team", summary="The team Zoom meetings go to")
@limiter.limit("30/minute")
async def put_team(request: Request, body: TeamIn, db: AsyncIOMotorDatabase = Depends(get_db),
                   user: User = Depends(require_user)):
    _app_only(request)
    return await zoom.set_team(db, user, body.workspace_id, body.team_id)


@router.delete("/connection", summary="Disconnect Zoom")
@limiter.limit("20/minute")
async def delete_connection(request: Request, workspace_id: str = Query(..., pattern=_WS),
                            db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    _app_only(request)
    return await zoom.disconnect(db, user, workspace_id)


@router.get("/recordings", summary="Recorded Zoom meetings to import")
@limiter.limit("20/minute")
async def recordings(request: Request, workspace_id: str = Query(..., pattern=_WS),
                     days: Optional[int] = Query(30, ge=1, le=zoom.MAX_RANGE_DAYS),
                     from_: Optional[str] = Query(None, alias="from", max_length=10),
                     to: Optional[str] = Query(None, max_length=10),
                     db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    _app_only(request)
    return await zoom.list_recordings(db, user, workspace_id, days=days, from_=from_, to=to)


@router.post("/import", summary="Import recorded Zoom meetings")
@limiter.limit("10/minute")
async def import_(request: Request, body: ImportIn, db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    _app_only(request)
    return await zoom.import_recordings(db, user, body.workspace_id, body.uuids)


@router.post("/webhook/{workspace_id}", include_in_schema=False)
@limiter.limit("600/minute")
async def webhook(request: Request, workspace_id: str, db: AsyncIOMotorDatabase = Depends(get_db)):
    body = await request.body()
    if len(body) > MAX_BODY:
        return JSONResponse({"detail": "Too large"}, status_code=413)
    code, out = await zoom.handle_webhook(db, workspace_id, request.headers, body)
    return JSONResponse(out, status_code=code)
