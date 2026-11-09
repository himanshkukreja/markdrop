"""Suggested edits, AI and files on comment threads (Track B; CONTRACT §5).

    GET    /api/v1/documents/{slug}/comments/{thread_id}/suggestion          the suggestion + what accepting does now
    PUT    /api/v1/documents/{slug}/comments/{thread_id}/suggestion          suggest replacement text (anyone who can comment)
    DELETE /api/v1/documents/{slug}/comments/{thread_id}/suggestion          withdraw (its author) / reject (an editor)
    POST   /api/v1/documents/{slug}/comments/{thread_id}/suggestion/accept   accept (editors): 200 applied, 202 offered
    POST   /api/v1/documents/{slug}/comments/{thread_id}/ai/apply            Apply with AI: a drafted suggestion
    POST   /api/v1/documents/{slug}/comments/{thread_id}/ai/ask              @AI: an answer posted in the thread
    GET    /api/v1/documents/{slug}/comments/ai/status                       whether comment AI can run now
    POST   /api/v1/documents/{slug}/comments/ai/summary                      Summarize discussion
    POST   /api/v1/documents/{slug}/comments/ai/tone                         tone / clarity check of a draft
    POST   /api/v1/documents/{slug}/comments/attachments                     upload a file for a comment
    POST   /api/v1/documents/{slug}/comments/attachments/urls                signed links for this viewer
    DELETE /api/v1/documents/{slug}/comments/attachments/{attachment_id}     drop a file from a draft

Every path is deeper than core's ``/{thread_id}`` or starts with a literal it never matches (24-hex ids only).
"""


from fastapi import APIRouter, Depends, File, Header, Path, Request, Response, UploadFile
from fastapi.responses import JSONResponse
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import optional_user, require_user
from app.services import access
from app.services.comments import ai, attachments, suggestions
from app.utils.net import get_client_ip

router = APIRouter(tags=["comments"])

_TID = r"^[0-9a-f]{24}$"
_AID = r"^[0-9a-f]{24}$"


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


class SuggestionIn(BaseModel):
    text: str = Field(min_length=1, max_length=suggestions.MAX_TEXT)
    ai: bool = False


class AcceptIn(BaseModel):
    resolve: bool = True


class ApplyIn(BaseModel):
    instruction: str | None = Field(None, max_length=300)


class AskIn(BaseModel):
    question: str = Field(min_length=1, max_length=ai.QUESTION_MAX)


class SummaryIn(BaseModel):
    refresh: bool = False


class ToneIn(BaseModel):
    body: str = Field(min_length=1, max_length=5000)
    force: bool = False


class UrlsIn(BaseModel):
    ids: list[str] = Field(default_factory=list, max_length=100)


async def _load(request: Request, db, slug: str, user: User | None, read_password: str | None,
                scope: str | None) -> tuple[dict | None, access.Actor, access.Ctx]:
    actor = access.actor_from_request(request, user, read_password=read_password)
    ctx = access.Ctx(db, surface="rest", workspace_scope=scope or None, ip=get_client_ip(request))
    raw = await db["documents"].find_one({"slug": slug})
    return raw, actor, ctx


# ── Item-level (literal second segment: never a thread id) ────────────────────


@router.get("/api/v1/documents/{slug}/comments/ai/status")
@limiter.limit("120/minute")
async def comments_ai_status(request: Request, slug: str, db: AsyncIOMotorDatabase = Depends(get_db),
                             x_read_password: str | None = Header(None),
                             x_markdrop_workspace: str | None = Header(None),
                             user: User | None = Depends(optional_user)):
    """``{"enabled", "reason", "message"}``: whether comment AI can run for you here now (nothing counted)."""
    from app.services.comments import perms

    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    await perms.require(db, actor, raw, ctx, "view")
    return await ai.status(db, actor, raw)


@router.post("/api/v1/documents/{slug}/comments/ai/summary")
@limiter.limit("20/minute")
async def comments_ai_summary(request: Request, slug: str, data: SummaryIn | None = None,
                              db: AsyncIOMotorDatabase = Depends(get_db),
                              x_read_password: str | None = Header(None),
                              x_markdrop_workspace: str | None = Header(None),
                              user: User = Depends(require_user)):
    """Summarize discussion: ``{"decided", "open", "waiting", "counts", "generated_at", "cached", "empty"}``;
    each line names its threads. Cached until the comments change (``refresh`` asks again)."""
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    return await ai.summarize(db, actor, raw, ctx, refresh=bool(data and data.refresh))


@router.post("/api/v1/documents/{slug}/comments/ai/tone")
@limiter.limit("30/minute")
async def comments_ai_tone(request: Request, slug: str, data: ToneIn,
                           db: AsyncIOMotorDatabase = Depends(get_db),
                           x_read_password: str | None = Header(None),
                           x_markdrop_workspace: str | None = Header(None),
                           user: User = Depends(require_user)):
    """A draft comment's tone and clarity: ``{"ok", "issues", "rewrite", "ai"}``. Only drafts that look harsh
    reach AI unless ``force`` (the composer's Check tone)."""
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    return await ai.tone(db, actor, raw, ctx, data.body, force=data.force)


@router.post("/api/v1/documents/{slug}/comments/attachments", status_code=201)
@limiter.limit("30/minute")
async def comment_attachment_upload(request: Request, slug: str, file: UploadFile = File(...),
                                    db: AsyncIOMotorDatabase = Depends(get_db),
                                    x_read_password: str | None = Header(None),
                                    x_markdrop_workspace: str | None = Header(None),
                                    user: User = Depends(require_user)):
    """A file for a comment you are writing (images, PDF, Office, zip, text; up to 10 MB):
    ``{id, name, mime, size, width?, height?, url}``. Send its id in the comment's ``attachments``."""
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    data = await file.read(attachments.MAX_BYTES + 1)
    return await attachments.upload(db, actor, raw, ctx, name=file.filename, data=data)


@router.post("/api/v1/documents/{slug}/comments/attachments/urls")
@limiter.limit("240/minute")
async def comment_attachment_urls(request: Request, slug: str, data: UrlsIn,
                                  db: AsyncIOMotorDatabase = Depends(get_db),
                                  x_read_password: str | None = Header(None),
                                  x_markdrop_workspace: str | None = Header(None),
                                  user: User | None = Depends(optional_user)):
    """Signed links (expiring) for files in this item's comments, for someone who can see its comments:
    ``{"attachments": {id: {url, expires_at, name, mime, size}}}``. Files of deleted comments aren't served."""
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    return await attachments.urls(db, actor, raw, ctx, data.ids)


@router.delete("/api/v1/documents/{slug}/comments/attachments/{attachment_id}", status_code=204)
@limiter.limit("60/minute")
async def comment_attachment_discard(request: Request, slug: str, attachment_id: str = Path(pattern=_AID),
                                     db: AsyncIOMotorDatabase = Depends(get_db),
                                     x_read_password: str | None = Header(None),
                                     x_markdrop_workspace: str | None = Header(None),
                                     user: User = Depends(require_user)):
    """Remove a file you uploaded from a draft (before it is posted)."""
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    await attachments.discard(db, actor, raw, ctx, attachment_id)
    return Response(status_code=204)


# ── One thread ────────────────────────────────────────────────────────────────


@router.get("/api/v1/documents/{slug}/comments/{thread_id}/suggestion")
@limiter.limit("240/minute")
async def get_suggestion(request: Request, slug: str, thread_id: str = Path(pattern=_TID),
                         db: AsyncIOMotorDatabase = Depends(get_db),
                         x_read_password: str | None = Header(None),
                         x_markdrop_workspace: str | None = Header(None),
                         user: User | None = Depends(optional_user)):
    """The thread's suggested edit for you: ``{suggestion, applies, reason, holder, offer, before, after, can}``.
    ``reason``: why accepting wouldn't apply it now (``stale``, ``unappliable``, ``changed``, ``locked``)."""
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    return await suggestions.detail(db, actor, raw, ctx, thread_id)


@router.put("/api/v1/documents/{slug}/comments/{thread_id}/suggestion")
@limiter.limit("60/minute")
async def put_suggestion(request: Request, slug: str, data: SuggestionIn, thread_id: str = Path(pattern=_TID),
                         db: AsyncIOMotorDatabase = Depends(get_db),
                         x_read_password: str | None = Header(None),
                         x_markdrop_workspace: str | None = Header(None),
                         user: User = Depends(require_user)):
    """Suggest replacement text for the thread's quote (replaces your own open suggestion). ThreadOut."""
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    return await suggestions.propose(db, actor, raw, ctx, thread_id, data.text, ai=data.ai)


@router.delete("/api/v1/documents/{slug}/comments/{thread_id}/suggestion")
@limiter.limit("60/minute")
async def delete_suggestion(request: Request, slug: str, thread_id: str = Path(pattern=_TID),
                            db: AsyncIOMotorDatabase = Depends(get_db),
                            x_read_password: str | None = Header(None),
                            x_markdrop_workspace: str | None = Header(None),
                            user: User = Depends(require_user)):
    """Withdraw your suggestion, or (an editor) reject it. ThreadOut."""
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    return await suggestions.reject(db, actor, raw, ctx, thread_id)


@router.post("/api/v1/documents/{slug}/comments/{thread_id}/suggestion/accept")
@limiter.limit("60/minute")
async def accept_suggestion(request: Request, slug: str, data: AcceptIn | None = None,
                            thread_id: str = Path(pattern=_TID),
                            db: AsyncIOMotorDatabase = Depends(get_db),
                            x_read_password: str | None = Header(None),
                            x_markdrop_workspace: str | None = Header(None),
                            user: User = Depends(require_user)):
    """Accept the suggested edit (people who can edit). 200 ``{applied: true, version_id, rev, thread}``: the
    page now says it (a version in its history, the thread resolved unless ``resolve`` is false). 202
    ``{applied: false, offered: true, holder}``: someone else is editing the page, so it waits for them.
    409 ``suggestion_stale`` / ``suggestion_unappliable``; 423 locked page or signed-off section."""
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    out = await suggestions.accept(db, actor, raw, ctx, thread_id, resolve=data.resolve if data else True)
    if not out["applied"]:
        from fastapi.encoders import jsonable_encoder

        return JSONResponse(status_code=202, content=jsonable_encoder(out))
    return out


@router.post("/api/v1/documents/{slug}/comments/{thread_id}/ai/apply")
@limiter.limit("20/minute")
async def ai_apply(request: Request, slug: str, data: ApplyIn | None = None, thread_id: str = Path(pattern=_TID),
                   db: AsyncIOMotorDatabase = Depends(get_db),
                   x_read_password: str | None = Header(None),
                   x_markdrop_workspace: str | None = Header(None),
                   user: User = Depends(require_user)):
    """Apply with AI: replacement text for the thread's quote drafted from the discussion,
    ``{"text", "note", "quote"}``. Nothing is saved: propose it with PUT …/suggestion (``ai: true``)."""
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    return await ai.draft_suggestion(db, actor, raw, ctx, thread_id, data.instruction if data else None)


@router.post("/api/v1/documents/{slug}/comments/{thread_id}/ai/ask", status_code=201)
@limiter.limit("20/minute")
async def ai_ask(request: Request, slug: str, data: AskIn, thread_id: str = Path(pattern=_TID),
                 db: AsyncIOMotorDatabase = Depends(get_db),
                 x_read_password: str | None = Header(None),
                 x_markdrop_workspace: str | None = Header(None),
                 user: User = Depends(require_user)):
    """Ask Markdrop AI in the thread: your question ("@AI …") and the answer are posted as replies everyone in
    the thread sees
    (``{"thread", "message", "answer", "sources"}``). Grounded in the page, the thread and workspace items at
    least as open as the page. Writing ``@AI`` in a comment does the same."""
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    return await ai.ask(db, actor, raw, ctx, thread_id, data.question, post_question=True)
