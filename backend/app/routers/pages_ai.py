"""Page AI (services/pages_ai.py): Claude in pages, and in the Guides page editor.

    GET  /api/v1/ai/pages/status?slug=&workspace=   {enabled, reason, message, can_write, can_ask, vision, …}
    POST /api/v1/ai/pages/notes                     SSE   {notes, template?, title?, workspace?}
    POST /api/v1/ai/pages/{slug}/transform          SSE   {action, text, tone?, lang?, before?, after?}
    POST /api/v1/ai/pages/{slug}/write              SSE   {prompt, before?, after?}
    POST /api/v1/ai/pages/{slug}/action-items       SSE   {text?}
    POST /api/v1/ai/pages/{slug}/summary            SSE
    POST /api/v1/ai/pages/{slug}/ask                SSE   {question, history?: [{q, a}]}
    POST /api/v1/ai/pages/{slug}/meta               JSON  {title, description, icon}
    POST /api/v1/ai/pages/{slug}/translate          JSON  {slug, url, title}  (SSE with progress when the
                                                          request sends Accept: text/event-stream)
    POST /api/v1/ai/pages/{slug}/alt-text           JSON  {alt}   {asset_id}

    POST /api/v1/docs-sites/{site_id}/pages/{page_id}/ai/{transform|write|action-items|summary|meta|alt-text}

Who: the writing features need ``can(edit_content)`` on the page (Guides: editor
and up on the guide); Ask needs a signed-in reader past ``can(read)`` (a tenant
token on the workspace's own domain counts: ask and status are on its
allowlist, routers/auth.py). Anonymous callers get 401: no AI at all. An
end-to-end encrypted document is a 422 ``{code: "encrypted"}`` and nothing is
sent anywhere.

SSE events are ``event: <type>`` lines whose data carries ``type`` too:
``delta {text, reset?}``, ``done {request_id, usage, trimmed, truncated, markdown}``,
``limit {reason, message}``, ``error {detail, code}``, and for translate
``progress {done, total}`` and ``done {slug, url, title}``. Limits (kill switch,
key, workspace switch, the admin's per-person limits, spend caps) arrive as a
``limit`` event; on the JSON endpoints they are an HTTP error (429, 403 for
workspace_off / blocked, 503 for off / not_configured) with
``{type: "limit", reason, detail, code: "limit"}``.
"""

# No `from __future__ import annotations`: slowapi wraps these routes (see routers/docs_ai.py).
import asyncio
import json
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.routing import APIRoute
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import optional_user, require_user
from app.services import access, pages_ai
from app.services.pages_ai import AIError
from app.utils.net import get_client_ip

KEEPALIVE_S = 15.0
SSE_HEADERS = {"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"}


class AIRoute(APIRoute):
    """Answers an :class:`AIError` with its ``{detail, code}`` body."""

    def get_route_handler(self):
        original = super().get_route_handler()

        async def handler(request: Request):
            try:
                return await original(request)
            except AIError as exc:
                return JSONResponse(exc.body(), status_code=exc.status)

        return handler


router = APIRouter(prefix="/api/v1/ai/pages", tags=["page-ai"], route_class=AIRoute)
guides_router = APIRouter(prefix="/api/v1/docs-sites", tags=["page-ai"], route_class=AIRoute)


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _sse(event: str, data: dict) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")


def sse(gen) -> StreamingResponse:
    """The stream as Server-Sent Events, with keep-alives (the docs Ask AI's shape)."""

    async def stream():
        queue: asyncio.Queue = asyncio.Queue()
        done = object()

        async def produce():
            try:
                async for item in gen:
                    await queue.put(item)
            except AIError as exc:
                await queue.put(("error", {"type": "error", "detail": exc.detail, "code": exc.code}))
            except Exception:
                await queue.put(("error", {"type": "error", "detail": "AI hit a problem. Try again.",
                                           "code": "internal"}))
            finally:
                await queue.put(done)

        task = asyncio.create_task(produce())
        try:
            yield b": ok\n\n"
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=KEEPALIVE_S)
                except asyncio.TimeoutError:
                    yield b": keep-alive\n\n"
                    continue
                if item is done:
                    break
                yield _sse(*item)
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(stream(), media_type="text/event-stream", headers=SSE_HEADERS)


def _ctx(db, request: Request, scope: str | None) -> access.Ctx:
    return access.Ctx(db, surface="rest", workspace_scope=scope or None, ip=get_client_ip(request))


async def load_page(db, request: Request, slug: str, user: User | None, need: str, *,
                    read_password: str | None = None, edit_secret: str | None = None,
                    scope: str | None = None) -> tuple[dict, access.Actor, access.Ctx]:
    """(row, actor, ctx) for a signed-in caller past ``can(need)`` on a Markdown document."""
    if user is None:
        raise HTTPException(status_code=401, detail="Sign in to use AI.")
    actor = access.actor_from_request(request, user, edit_secret=edit_secret, read_password=read_password)
    ctx = _ctx(db, request, scope)
    raw = await db["documents"].find_one({"slug": slug})
    d = await access.can(actor, raw, need, ctx)
    if not d.allowed:
        if need != "read" and d.status == 403:
            raise HTTPException(status_code=403, detail="Only people who can edit this page can use AI on it.")
        d.raise_()
    if raw.get("kind") == "artifact":
        raise AIError(422, "not_a_page", "AI works on pages and Markdown documents, not files.")
    if raw.get("encrypted"):
        raise AIError(422, "encrypted", "This document is end-to-end encrypted, so AI can't read it.")
    return raw, actor, ctx


async def _target(db, raw: dict, actor, ctx) -> pages_ai.Target:
    from app.services import pages

    return pages_ai.page_target(raw, await pages.content_for(actor, raw, ctx))


def _job(db, user: User, action: str, target=None, **meta) -> pages_ai.Job:
    return pages_ai.Job(db=db, user=user, action=action, target=target, meta=meta)


# ── Status ────────────────────────────────────────────────────────────────────


@router.get("/status")
@limiter.limit("120/minute")
async def status(
    request: Request,
    slug: str | None = Query(None, max_length=64),
    workspace: str | None = Query(None, max_length=64),
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_read_password: str | None = Header(None),
    x_edit_secret: str | None = Header(None),
    x_markdrop_workspace: str | None = Header(None),
    user: User | None = Depends(optional_user),
):
    """What the UI may offer: ``{enabled, reason, message, can_write, can_ask, vision, actions, tones,
    languages}``. ``reason``: signin | encrypted | off | not_configured | workspace_off | blocked |
    daily | monthly."""
    out: dict[str, Any] = {
        "enabled": False, "reason": None, "message": None, "can_write": False, "can_ask": False,
        "vision": pages_ai.VISION, "actions": list(pages_ai.ACTIONS), "tones": list(pages_ai.TONES),
        "languages": list(pages_ai.LANGUAGES),
    }
    ws_id = None
    if user is None:
        out["reason"] = "signin"
        return out
    if slug:
        raw, actor, ctx = await load_page_status(db, request, slug, user, x_read_password, x_edit_secret,
                                                 x_markdrop_workspace)
        if raw.get("encrypted") or raw.get("kind") == "artifact":
            out["reason"] = "encrypted" if raw.get("encrypted") else "not_a_page"
            return out
        ws_id = raw.get("workspace_id")
        out["can_ask"] = True
        out["can_write"] = (await access.can(actor, raw, "edit_content", ctx)).allowed
    else:
        if workspace:
            ws_id = await _creatable_workspace(db, workspace, user)
        out["can_write"] = not getattr(request.state, "tenant_token", False)
    lim = await pages_ai.page_limit(db, user.id, ws_id, reserve=0.0, count=False)
    if lim is not None:
        out["reason"], out["message"] = lim.reason, lim.message
        out["can_write"] = out["can_ask"] = False
        return out
    out["enabled"] = True
    return out


async def load_page_status(db, request, slug, user, read_password, edit_secret, scope):
    actor = access.actor_from_request(request, user, edit_secret=edit_secret, read_password=read_password)
    ctx = _ctx(db, request, scope)
    raw = await db["documents"].find_one({"slug": slug})
    await access.require(actor, raw, "read", ctx)
    return raw, actor, ctx


async def _creatable_workspace(db, workspace: str, user: User) -> str:
    """A workspace id the caller may create pages in (member and up), else 404 / 403."""
    from app.models.workspace import role_allows
    from app.services import workspace as ws_service

    try:
        role = await ws_service.role_for(db, workspace, user.id)
    except Exception:
        role = None
    if role is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    if not role_allows(role, "member"):
        raise HTTPException(status_code=403, detail="Only members of the workspace can create pages in it.")
    return workspace


# ── Writing features ──────────────────────────────────────────────────────────


class TransformBody(BaseModel):
    action: str = Field(..., max_length=20)
    text: str = Field(..., max_length=pages_ai.MAX_SELECTION + 2000)
    tone: str | None = Field(None, max_length=20)
    lang: str | None = Field(None, max_length=40)
    before: str | None = Field(None, max_length=pages_ai.MAX_AROUND + 500)
    after: str | None = Field(None, max_length=pages_ai.MAX_AROUND + 500)


class WriteBody(BaseModel):
    prompt: str = Field(..., max_length=pages_ai.MAX_PROMPT + 500)
    before: str | None = Field(None, max_length=pages_ai.MAX_AROUND + 500)
    after: str | None = Field(None, max_length=pages_ai.MAX_AROUND + 500)


class NotesBody(BaseModel):
    notes: str = Field(..., max_length=pages_ai.MAX_NOTES + 2000)
    template: str | None = Field(None, max_length=64)
    title: str | None = Field(None, max_length=200)
    workspace: str | None = Field(None, max_length=64)


class ActionItemsBody(BaseModel):
    text: str | None = Field(None, max_length=pages_ai.MAX_SELECTION + 2000)


class AskBody(BaseModel):
    question: str = Field(..., max_length=pages_ai.MAX_QUESTION + 2000)
    history: list[Any] = Field(default_factory=list, max_length=40)


class TranslateBody(BaseModel):
    lang: str = Field(..., max_length=40)


class AltTextBody(BaseModel):
    asset_id: str = Field(..., max_length=300)


def _wants_sse(request: Request) -> bool:
    return "text/event-stream" in (request.headers.get("accept") or "").lower()


@router.post("/notes")
@limiter.limit("30/minute")
async def notes(request: Request, body: NotesBody, db: AsyncIOMotorDatabase = Depends(get_db),
                user: User = Depends(require_user)):
    ws_id = await _creatable_workspace(db, body.workspace, user) if body.workspace else None
    job = _job(db, user, "notes", workspace_id=ws_id)
    return sse(await pages_ai.notes(job, notes_text=body.notes, title=body.title, template_id=body.template))


@router.post("/{slug}/transform")
@limiter.limit("60/minute")
async def transform(request: Request, slug: str, body: TransformBody, db: AsyncIOMotorDatabase = Depends(get_db),
                    x_edit_secret: str | None = Header(None), user: User = Depends(require_user)):
    raw, actor, ctx = await load_page(db, request, slug, user, "edit_content", edit_secret=x_edit_secret)
    job = _job(db, user, "transform", await _target(db, raw, actor, ctx))
    return sse(await pages_ai.transform(job, action=body.action, text=body.text, tone=body.tone, lang=body.lang,
                                        before=body.before, after=body.after))


@router.post("/{slug}/write")
@limiter.limit("60/minute")
async def write(request: Request, slug: str, body: WriteBody, db: AsyncIOMotorDatabase = Depends(get_db),
                x_edit_secret: str | None = Header(None), user: User = Depends(require_user)):
    raw, actor, ctx = await load_page(db, request, slug, user, "edit_content", edit_secret=x_edit_secret)
    job = _job(db, user, "write", await _target(db, raw, actor, ctx))
    return sse(await pages_ai.write(job, prompt=body.prompt, before=body.before, after=body.after))


@router.post("/{slug}/action-items")
@limiter.limit("60/minute")
async def action_items(request: Request, slug: str, body: ActionItemsBody | None = None,
                       db: AsyncIOMotorDatabase = Depends(get_db), x_edit_secret: str | None = Header(None),
                       user: User = Depends(require_user)):
    raw, actor, ctx = await load_page(db, request, slug, user, "edit_content", edit_secret=x_edit_secret)
    job = _job(db, user, "action_items", await _target(db, raw, actor, ctx))
    return sse(await pages_ai.action_items(job, text=body.text if body else None))


@router.post("/{slug}/summary")
@limiter.limit("60/minute")
async def summary(request: Request, slug: str, db: AsyncIOMotorDatabase = Depends(get_db),
                  x_edit_secret: str | None = Header(None), user: User = Depends(require_user)):
    raw, actor, ctx = await load_page(db, request, slug, user, "edit_content", edit_secret=x_edit_secret)
    job = _job(db, user, "summary", await _target(db, raw, actor, ctx))
    return sse(await pages_ai.summary(job))


@router.post("/{slug}/meta")
@limiter.limit("60/minute")
async def meta(request: Request, slug: str, db: AsyncIOMotorDatabase = Depends(get_db),
               x_edit_secret: str | None = Header(None), user: User = Depends(require_user)):
    raw, actor, ctx = await load_page(db, request, slug, user, "edit_content", edit_secret=x_edit_secret)
    job = _job(db, user, "meta", await _target(db, raw, actor, ctx))
    return await pages_ai.meta(job)


@router.post("/{slug}/translate")
@limiter.limit("10/minute")
async def translate(request: Request, slug: str, body: TranslateBody, db: AsyncIOMotorDatabase = Depends(get_db),
                    x_edit_secret: str | None = Header(None), user: User = Depends(require_user)):
    raw, actor, ctx = await load_page(db, request, slug, user, "edit_content", edit_secret=x_edit_secret)
    job = _job(db, user, "translate", await _target(db, raw, actor, ctx))
    # The copy is created as the person (never with the page's edit secret).
    person = access.actor_from_request(request, user)
    gen = await pages_ai.translate_page(job, lang=body.lang, actor=person, ctx=ctx)
    if _wants_sse(request):
        return sse(gen)
    done = await pages_ai.collect(gen)
    return {"slug": done["slug"], "url": done["url"], "title": done["title"], "request_id": done["request_id"],
            "workspace_error": done.get("workspace_error")}


@router.post("/{slug}/alt-text")
@limiter.limit("60/minute")
async def alt_text(request: Request, slug: str, body: AltTextBody, db: AsyncIOMotorDatabase = Depends(get_db),
                   x_edit_secret: str | None = Header(None), user: User = Depends(require_user)):
    raw, actor, ctx = await load_page(db, request, slug, user, "edit_content", edit_secret=x_edit_secret)
    if not pages_ai.VISION:
        raise AIError(501, "not_supported", "Alt text suggestions aren't available.")
    job = _job(db, user, "alt_text", await _target(db, raw, actor, ctx))
    data, mime = await pages_ai.page_image(db, raw, body.asset_id)
    return await pages_ai.alt_text(job, data, mime)


# ── Ask (readers) ─────────────────────────────────────────────────────────────


@router.post("/{slug}/ask")
@limiter.limit("30/minute")
async def ask(request: Request, slug: str, body: AskBody, db: AsyncIOMotorDatabase = Depends(get_db),
              x_read_password: str | None = Header(None), x_edit_secret: str | None = Header(None),
              x_markdrop_workspace: str | None = Header(None), user: User = Depends(require_user)):
    raw, actor, ctx = await load_page(db, request, slug, user, "read", read_password=x_read_password,
                                      edit_secret=x_edit_secret, scope=x_markdrop_workspace)
    target = await _target(db, raw, actor, ctx)
    # Embedded items are opened as the person (no password or edit secret of the page), each
    # checked with access.can, exactly as POST /documents/{slug}/embeds resolves them.
    person = access.actor_from_request(request, user)
    target.embeds = await pages_ai.readable_embeds(db, target.body, person, _ctx(db, request, x_markdrop_workspace))
    job = _job(db, user, "ask", target)
    return sse(await pages_ai.ask(job, question=body.question, history=body.history))


# ── Guides studio ─────────────────────────────────────────────────────────────


async def _guide(db, site_id: str, page_id: str, user: User):
    from app.services import docs_site_pages as gpages
    from app.services import docs_site_store as store

    site, _role = await store.load_site(db, site_id, user, "editor")
    page = await gpages.load_page(db, site, page_id)
    target = pages_ai.guide_target(site, page)
    return site, target


def _gjob(db, user: User, action: str, site: dict, target) -> pages_ai.Job:
    return pages_ai.Job(db=db, user=user, action=action, target=target, site=site)


@guides_router.post("/{site_id}/pages/{page_id}/ai/transform")
@limiter.limit("60/minute")
async def guide_transform(request: Request, site_id: str, page_id: str, body: TransformBody,
                          db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, t = await _guide(db, site_id, page_id, user)
    return sse(await pages_ai.transform(_gjob(db, user, "transform", site, t), action=body.action, text=body.text,
                                        tone=body.tone, lang=body.lang, before=body.before, after=body.after))


@guides_router.post("/{site_id}/pages/{page_id}/ai/write")
@limiter.limit("60/minute")
async def guide_write(request: Request, site_id: str, page_id: str, body: WriteBody,
                      db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, t = await _guide(db, site_id, page_id, user)
    return sse(await pages_ai.write(_gjob(db, user, "write", site, t), prompt=body.prompt, before=body.before,
                                    after=body.after))


@guides_router.post("/{site_id}/pages/{page_id}/ai/action-items")
@limiter.limit("60/minute")
async def guide_action_items(request: Request, site_id: str, page_id: str, body: ActionItemsBody | None = None,
                             db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, t = await _guide(db, site_id, page_id, user)
    return sse(await pages_ai.action_items(_gjob(db, user, "action_items", site, t), text=body.text if body else None))


@guides_router.post("/{site_id}/pages/{page_id}/ai/summary")
@limiter.limit("60/minute")
async def guide_summary(request: Request, site_id: str, page_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                        user: User = Depends(require_user)):
    site, t = await _guide(db, site_id, page_id, user)
    return sse(await pages_ai.summary(_gjob(db, user, "summary", site, t)))


@guides_router.post("/{site_id}/pages/{page_id}/ai/meta")
@limiter.limit("60/minute")
async def guide_meta(request: Request, site_id: str, page_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                     user: User = Depends(require_user)):
    site, t = await _guide(db, site_id, page_id, user)
    return await pages_ai.meta(_gjob(db, user, "meta", site, t))


@guides_router.post("/{site_id}/pages/{page_id}/ai/alt-text")
@limiter.limit("60/minute")
async def guide_alt_text(request: Request, site_id: str, page_id: str, body: AltTextBody,
                         db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, t = await _guide(db, site_id, page_id, user)
    if not pages_ai.VISION:
        raise AIError(501, "not_supported", "Alt text suggestions aren't available.")
    data, mime = await pages_ai.guide_image(db, site, body.asset_id)
    return await pages_ai.alt_text(_gjob(db, user, "alt_text", site, t), data, mime)
