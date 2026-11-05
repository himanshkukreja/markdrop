"""Meetings (services/meetings.py, services/meetings_ai.py): team calls as pages, and asking them.

    GET    /api/v1/meetings/status?workspace=        {ai, google, folder_id, can_import, types}
    POST   /api/v1/meetings/preview                  {sources: [{name, text | data_b64}]} → {meetings}
    POST   /api/v1/meetings/import                   {workspace, sources: [{name, text | data_b64 | google_file_id}],
                                                      title?, date?, type?, restricted?, wait?} → {meetings}
    POST   /api/v1/meetings/google/token             {access_token, api_key, app_id, client_id}  (the Picker)
    GET    /api/v1/meetings/connection?workspace=    "Connect Google Meet": {connection | null, others}
    POST   /api/v1/meetings/connection               {workspace, restricted?} → {token, script, manifest, …} (once)
    DELETE /api/v1/meetings/connection               Disconnect (the token is revoked; the script stops)
    POST   /api/v1/meetings/inbox                    the Google Meet script's deliveries (its own token only)
    GET    /api/v1/meetings?workspace=&limit=&q=&source=&since=   {meetings, hidden, folder_id}
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
allowlist); the inbox takes only a ``meetings:import`` token (services/meetings_inbox.py). Every meeting read is decided on its page with ``access.can``: a restricted meeting is
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
from app.services import access, api_token, gdocs, meeting_google, meetings, meetings_ai, meetings_inbox
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


class ConnectBody(BaseModel):
    workspace: str = Field(..., max_length=40)
    restricted: bool = False
    # Past meetings the script's setup brings in once (0, 7, 30 or 90 days; quietly: no notifications).
    backfill_days: Literal[0, 7, 30, 90] = 0
    # The browser's time zone (IANA), to date a Doc without a date in its title.
    tz: str | None = Field(None, max_length=64)
    # Also the meetings shared with this person (organized by someone else: the Docs live in their Drive).
    include_shared: bool = True


class DriveOwner(BaseModel):
    name: str | None = Field(None, max_length=200)
    email: str | None = Field(None, max_length=320)
    me: bool | None = None


class InboxBody(BaseModel):
    source: Literal["google-meet-script"] = "google-meet-script"
    file_id: str = Field(..., min_length=1, max_length=200)
    title: str | None = Field(None, max_length=500)
    created: str | None = Field(None, max_length=40)
    kind_hint: Literal["transcript", "notes", "unknown"] | None = None
    text: str = Field(...)
    doc_url: str | None = Field(None, max_length=500)
    # Sent by the script's backfill: a past meeting, imported without notifying anyone.
    backfill: bool = False
    # v2: the script's version; the Doc's owner in Drive (who organized the call); a Doc someone asked for by link.
    version: int | None = Field(None, ge=1, le=1000)
    owner: DriveOwner | None = None
    requested: bool = False


class StatusBody(BaseModel):
    phase: Literal["start", "done"] = "done"
    version: int = Field(1, ge=1, le=1000)
    mode: str | None = Field(None, max_length=12)
    include_shared: bool | None = None
    lookback_hours: int | None = None
    found: int | None = None
    sent: int | None = None
    results: dict[str, int] | None = None
    skipped: dict[str, int] | None = None
    errors: list[dict[str, Any]] | None = Field(None, max_length=20)
    search: str | None = Field(None, max_length=20)
    queue_done: list[str] | None = Field(None, max_length=100)
    queue_failed: list[dict[str, Any]] | None = Field(None, max_length=100)


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
    # A Google Doc already imported into this workspace (by hand or by the Google Meet script) opens
    # that meeting instead of making a second one.
    rows = await meetings.import_meetings(db, user, ws, incoming, title=body.title, date_=body.date,
                                          type_=body.type, restricted=body.restricted, wait=body.wait,
                                          dedupe="file")
    actor, ctx = _ac(request, db, user)
    out = []
    for row in rows:
        raw = await meetings.readable(db, row, actor, ctx)
        if raw is not None:
            out.append({**await meetings.shape(db, row, raw, actor, ctx), "status": row.get("_status") or "imported"})
    if not out and rows:
        raise HTTPException(status_code=409, detail="That Google Doc is already a meeting in this workspace, "
                                                    "restricted to its attendees.")
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


# ── Connect Google Meet (services/meetings_inbox.py) ──────────────────────────


@router.get("/connection")
@limiter.limit("120/minute")
async def get_connection(request: Request, workspace: str | None = Query(None, max_length=40),
                         db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """Mine (wherever it sends meetings), and the others sending to ``workspace`` (a member's view)."""
    mine = await meetings_inbox.view(db, await meetings_inbox.mine(db, user.id), viewer_id=user.id)
    others: list[dict] = []
    if workspace:
        ws = _ws(workspace)
        await meetings.require_member(db, ws, user.id, write=False)
        others = [c for c in await meetings_inbox.for_workspace(db, ws) if c["connected_by"]["id"] != user.id]
    return {"connection": mine, "others": others, "endpoint": meetings_inbox.endpoint()}


@router.post("/connection")
@limiter.limit("10/hour")
async def connect(request: Request, body: ConnectBody, db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    """A new token for the Google Meet script, shown once, inside the script. Replaces an earlier one."""
    from app.services import workspace as ws_service

    ws = _ws(body.workspace)
    raw, rec = await meetings_inbox.connect(db, user, ws, restricted=body.restricted, tz=body.tz,
                                            include_shared=body.include_shared)
    w = await ws_service.get_workspace(db, ws)
    return {"token": raw, "script": meetings_inbox.script(raw, getattr(w, "name", "") or "", backfill_days=body.backfill_days,
                                                          include_shared=body.include_shared),
            "manifest": meetings_inbox.manifest(), "endpoint": meetings_inbox.endpoint(),
            "connection": await meetings_inbox.view(db, rec, viewer_id=user.id)}


@router.delete("/connection")
@limiter.limit("30/minute")
async def disconnect(request: Request, db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    return {"disconnected": await meetings_inbox.disconnect(db, user.id)}


def _inline_schema(model: type[BaseModel]) -> dict:
    """A model's JSON schema with its ``$defs`` written in place (the body is described by hand above)."""
    schema = model.model_json_schema()
    defs = schema.pop("$defs", {})

    def walk(v):
        if isinstance(v, dict):
            ref = v.get("$ref", "")
            if ref.startswith("#/$defs/"):
                return walk(dict(defs[ref.split("/")[-1]]))
            return {k: walk(x) for k, x in v.items()}
        if isinstance(v, list):
            return [walk(x) for x in v]
        return v

    return walk(schema)


def _inbox_key(request: Request) -> str:
    auth = request.headers.get("Authorization", "")
    return meetings_inbox.token_key(auth.removeprefix("Bearer ").strip())


@router.post("/inbox", openapi_extra={
    # The body is read raw (size-checked first) and validated as InboxBody; the token is a scoped one.
    "requestBody": {"required": True, "content": {"application/json": {"schema": _inline_schema(InboxBody)}}},
    "x-markdrop": {"auth": "token"},   # a Bearer token: the script's meetings:import one
})
@limiter.limit("30/minute", key_func=_inbox_key)
@limiter.limit("600/day", key_func=_inbox_key)
async def inbox(request: Request, db: AsyncIOMotorDatabase = Depends(get_db)):
    """One Google Doc from the Google Meet script (Bearer: a ``meetings:import`` token, which works
    here and nowhere else). Idempotent on the Doc's id: → {status: imported | attached | duplicate |
    ignored, meeting_id?, url?}."""
    auth = request.headers.get("Authorization", "")
    raw = auth.removeprefix("Bearer ").strip() if auth.startswith("Bearer ") else ""
    rec = await api_token.verify_scoped(db, raw, meetings_inbox.SCOPE) if raw else None
    if rec is None:
        raise HTTPException(status_code=401, detail="This script is disconnected. Connect Google Meet again in Markdrop.")
    size = request.headers.get("content-length")
    if size and size.isdigit() and int(size) > meetings_inbox.MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="That Doc is too big to import.")
    data = await request.body()
    if len(data) > meetings_inbox.MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="That Doc is too big to import.")
    try:
        body = InboxBody.model_validate_json(data)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"That isn't a delivery from the Google Meet script ({str(exc)[:200]}).")
    return await meetings_inbox.receive(db, rec, body.model_dump())


@router.post("/inbox/status", openapi_extra={"x-markdrop": {"auth": "token"}})
@limiter.limit("30/minute", key_func=_inbox_key)
@limiter.limit("600/day", key_func=_inbox_key)
async def inbox_status(request: Request, body: StatusBody, db: AsyncIOMotorDatabase = Depends(get_db)):
    """How a run of the Google Meet script went (Bearer: its ``meetings:import`` token): 'start' →
    {queue: the Docs asked for by link, to fetch first; latest_version}; 'done' → counts (found, sent,
    skipped by reason), errors. Shown on the Meetings page."""
    auth = request.headers.get("Authorization", "")
    raw = auth.removeprefix("Bearer ").strip() if auth.startswith("Bearer ") else ""
    rec = await api_token.verify_scoped(db, raw, meetings_inbox.SCOPE) if raw else None
    if rec is None:
        raise HTTPException(status_code=401, detail="This script is disconnected. Connect Google Meet again in Markdrop.")
    return await meetings_inbox.run_status(db, rec, body.model_dump())


@router.get("")
@limiter.limit("120/minute")
async def list_meetings(request: Request, workspace: str = Query(..., max_length=40),
                        limit: int = Query(100, ge=1, le=meetings.MAX_LIST), q: str | None = Query(None, max_length=100),
                        source: Literal["manual", "auto", "mcp"] | None = Query(None),
                        since: str | None = Query(None, max_length=10),
                        db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    actor, ctx = _ac(request, db, user)
    return jsonable_encoder(await meetings.list_meetings(db, _ws(workspace), actor, ctx, limit=limit, q=q,
                                                         source=source, since=since))


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
