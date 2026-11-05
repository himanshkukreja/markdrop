"""Meetings (services/meetings.py, services/meetings_ai.py): team calls as pages, and asking them.

    GET    /api/v1/meetings/status?workspace=        {ai, google, folder_id, can_import, types}
    POST   /api/v1/meetings/preview                  {sources: [{name, text | data_b64}]} → {meetings}
    POST   /api/v1/meetings/import                   {workspace, sources: [{name, text | data_b64 | google_file_id}],
                                                      title?, date?, type?, restricted?, wait?} → {meetings}
    POST   /api/v1/meetings/google/token             {access_token, api_key, app_id, client_id}  (the Picker)
    GET    /api/v1/meetings?workspace=&limit=&q=     {meetings, hidden, folder_id}
    GET    /api/v1/meetings/{id}                     a meeting
    PATCH  /api/v1/meetings/{id}                     {restricted?, type?}
    DELETE /api/v1/meetings/{id}                     the importer, or a workspace admin/owner (any meeting)
    POST   /api/v1/meetings/{id}/regenerate          writes the AI sections again (waits)
    POST   /api/v1/meetings/{id}/ask         SSE     {question, history?: [{question, answer}]}
    POST   /api/v1/meetings/ask              SSE     {workspace, question}

SSE events: ``status {stage}``, ``results {items}`` (across meetings), ``delta {text}``,
``done {request_id, usage, answer, citations: [{label, kind, text, href, slug}], ranked?}``,
``limit {reason, message}``, ``error {detail, code}``.

Signed-in members of the workspace only (a workspace domain's session is not on the tenant
allowlist). Every meeting read is decided on its page with ``access.can``: a restricted meeting is
404 to everyone it wasn't shared with.
"""

# No `from __future__ import annotations`: slowapi wraps these routes (see routers/docs_ai.py).
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.routers.pages_ai import sse
from app.services import access, gdocs, meeting_google, meetings, meetings_ai
from app.utils.net import get_client_ip

router = APIRouter(prefix="/api/v1/meetings", tags=["meetings"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _ac(request: Request, db, user: User):
    return (access.actor_from_request(request, user),
            access.Ctx(db, surface="rest", ip=get_client_ip(request)))


def _ws(value: str | None) -> str:
    v = (value or "").strip()
    if not (len(v) == 24 and all(c in "0123456789abcdef" for c in v)):
        raise HTTPException(status_code=422, detail="Pass the workspace's id.")
    return v


class SourceIn(BaseModel):
    name: str | None = Field(None, max_length=200)
    text: str | None = Field(None, max_length=meetings.MAX_PASTE_CHARS)
    data_b64: str | None = Field(None, max_length=meetings.MAX_SOURCE_BYTES * 4 // 3 + 16)
    google_file_id: str | None = Field(None, max_length=200)
    # Where the text came from ("upload": a file the browser read), shown on the meeting's Sources.
    origin: Literal["paste", "upload"] | None = None


class PreviewBody(BaseModel):
    sources: list[SourceIn] = Field(..., min_length=1, max_length=meetings.MAX_SOURCES)


class ImportBody(BaseModel):
    workspace: str = Field(..., max_length=40)
    sources: list[SourceIn] = Field(..., min_length=1, max_length=meetings.MAX_SOURCES)
    title: str | None = Field(None, max_length=150)
    date: str | None = Field(None, max_length=10)
    type: str | None = Field(None, max_length=20)
    restricted: bool = False
    wait: bool = False


class PatchBody(BaseModel):
    restricted: bool | None = None
    type: str | None = Field(None, max_length=20)


class AskBody(BaseModel):
    question: str = Field(..., min_length=1, max_length=meetings_ai.MAX_QUESTION)
    history: list[dict[str, Any]] | None = Field(None, max_length=meetings_ai.MAX_HISTORY)


class AskAllBody(BaseModel):
    workspace: str = Field(..., max_length=40)
    question: str = Field(..., min_length=1, max_length=meetings_ai.MAX_QUESTION)


async def _incoming(db, user: User, sources: list[SourceIn], *, allow_google: bool) -> list[meetings.Incoming]:
    out: list[meetings.Incoming] = []
    token = None
    for s in sources:
        if s.google_file_id:
            if not allow_google:
                raise HTTPException(status_code=422, detail="Preview takes text or files.")
            if token is None:
                try:
                    token = (await meeting_google.picker_credentials(db, user))["access_token"]
                except gdocs.ReconnectRequired as exc:
                    raise HTTPException(status_code=428, detail={"error": "reconnect_required", "message": str(exc)})
            try:
                title, text, url = await meeting_google.fetch(token, s.google_file_id)
            except meeting_google.PickError as exc:
                raise HTTPException(status_code=422, detail=str(exc))
            except gdocs.ReconnectRequired as exc:
                raise HTTPException(status_code=428, detail={"error": "reconnect_required", "message": str(exc)})
            out.append(meetings.Incoming(name=title, text=text, origin="google", file_id=s.google_file_id, url=url))
            continue
        if not (s.text or s.data_b64):
            raise HTTPException(status_code=422, detail="Each source needs text, a file or a Google Doc.")
        try:
            out.append(meetings.incoming_from(s.model_dump(), "paste"))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
    return out


@router.get("/status")
@limiter.limit("120/minute")
async def status(request: Request, workspace: str = Query(..., max_length=40),
                 db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    from app.models.workspace import role_allows

    ws = _ws(workspace)
    role = await meetings.require_member(db, ws, user.id, write=False)
    folder = await meetings.folder_of(db, ws)
    return {"ai": await meetings_ai.status(db, user.id, ws), "google": meeting_google.state(user),
            "folder_id": str(folder["_id"]) if folder else None, "can_import": role_allows(role, "member"),
            "types": list(meetings.TYPES)}


@router.post("/preview")
@limiter.limit("60/minute")
async def preview(request: Request, body: PreviewBody, db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    incoming = await _incoming(db, user, body.sources, allow_google=False)
    return {"meetings": meetings.preview(incoming)}


@router.post("/import")
@limiter.limit("20/minute")
async def import_meeting(request: Request, body: ImportBody, db: AsyncIOMotorDatabase = Depends(get_db),
                         user: User = Depends(require_user)):
    ws = _ws(body.workspace)
    await meetings.require_member(db, ws, user.id)
    incoming = await _incoming(db, user, body.sources, allow_google=True)
    rows = await meetings.import_meetings(db, user, ws, incoming, title=body.title, date_=body.date,
                                          type_=body.type, restricted=body.restricted, wait=body.wait)
    actor, ctx = _ac(request, db, user)
    out = []
    for row in rows:
        raw = await meetings.page_of(db, row)
        if raw is not None:
            out.append(await meetings.shape(db, row, raw, actor, ctx))
    return {"meetings": out}


@router.post("/google/token")
@limiter.limit("30/minute")
async def google_token(request: Request, db: AsyncIOMotorDatabase = Depends(get_db),
                       user: User = Depends(require_user)):
    if not meeting_google.picker_configured():
        raise HTTPException(status_code=503, detail="Google Docs import isn't set up on this server.")
    try:
        return await meeting_google.picker_credentials(db, user)
    except gdocs.ReconnectRequired as exc:
        raise HTTPException(status_code=428, detail={"error": "reconnect_required", "message": str(exc)})


@router.get("")
@limiter.limit("120/minute")
async def list_meetings(request: Request, workspace: str = Query(..., max_length=40),
                        limit: int = Query(100, ge=1, le=meetings.MAX_LIST), q: str | None = Query(None, max_length=100),
                        db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    actor, ctx = _ac(request, db, user)
    return jsonable_encoder(await meetings.list_meetings(db, _ws(workspace), actor, ctx, limit=limit, q=q))


@router.post("/ask")
@limiter.limit("30/minute")
async def ask_all(request: Request, body: AskAllBody, db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    actor, ctx = _ac(request, db, user)
    return sse(meetings_ai.ask_meetings(db, actor, ctx, _ws(body.workspace), body.question))


@router.get("/{meeting_id}")
@limiter.limit("240/minute")
async def get_meeting(request: Request, meeting_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    actor, ctx = _ac(request, db, user)
    row, raw = await meetings.for_read(db, meeting_id, actor, ctx)
    out = await meetings.shape(db, row, raw, actor, ctx)
    # Markdrop for Slack: the workspace's meetings channel, for the panel's "Post to Slack".
    from app.services import slack

    inst = await slack.install_for_workspace(db, row["workspace_id"]) if slack.configured() else None
    out["slack_channel"] = ((inst or {}).get("meetings_channel") or {}).get("name")
    return out


@router.patch("/{meeting_id}")
@limiter.limit("60/minute")
async def patch_meeting(request: Request, meeting_id: str, body: PatchBody,
                        db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    actor, ctx = _ac(request, db, user)
    row, raw = await meetings.for_read(db, meeting_id, actor, ctx)
    if body.type is not None:
        row = await meetings.set_type(db, row, raw, body.type, actor, ctx)
    if body.restricted is not None and bool(body.restricted) != bool(row.get("restricted")):
        row = await meetings.set_restricted(db, row, bool(body.restricted), actor, ctx)
    raw = await meetings.page_of(db, row)
    return await meetings.shape(db, row, raw, actor, ctx)


@router.delete("/{meeting_id}")
@limiter.limit("60/minute")
async def delete_meeting(request: Request, meeting_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                         user: User = Depends(require_user)):
    actor, ctx = _ac(request, db, user)
    row = await meetings.get_row(db, meeting_id)
    if row is None or await meetings.require_member(db, row["workspace_id"], user.id, write=False) is None:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return await meetings.delete_meeting(db, row, actor, ctx)


@router.post("/{meeting_id}/regenerate")
@limiter.limit("10/minute")
async def regenerate(request: Request, meeting_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                     user: User = Depends(require_user)):
    actor, ctx = _ac(request, db, user)
    row, raw = await meetings.for_read(db, meeting_id, actor, ctx)
    await access.require(actor, raw, "edit_content", ctx)
    await meetings_ai.generate(db, str(row["_id"]), user)
    row = await meetings.get_row(db, meeting_id)
    return await meetings.shape(db, row, raw, actor, ctx)


@router.post("/{meeting_id}/ask")
@limiter.limit("30/minute")
async def ask_one(request: Request, meeting_id: str, body: AskBody, db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    actor, ctx = _ac(request, db, user)
    await meetings.for_read(db, meeting_id, actor, ctx)   # a 404 before the stream starts
    return sse(meetings_ai.ask_meeting(db, actor, ctx, meeting_id, body.question, history=body.history))
