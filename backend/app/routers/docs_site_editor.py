"""The page editor's helpers: /api/v1/docs-sites/{site_id}/ai/edit…, …/comments…, …/presence.

* AI help (services/docs_editor_ai.py): rewrite a selected passage. Editors and up.
  Errors are ``{detail, code}`` so the editor can say what happened and offer the
  right next step (a 429 per day, a 503 when it's off or over budget, a 502 when
  the model failed).
* Review comments (services/docs_page_comments.py), anchored to quoted text.
  Editors, reviewers and admins; viewers get a 403 (they're working notes).
* Presence (services/docs_presence.py): who else has the guide open, and on which
  page. Anyone on the guide.

Included by routers/docs_sites.py (one registration in main.py).
"""

from fastapi import APIRouter, Depends, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.routers.docs_site_pages import DocsRoute
from app.schemas.docs_site import CommentCreate, CommentReply, CommentResolve, EditorAIRequest, PresenceBeat
from app.services import docs_editor_ai as editor_ai
from app.services import docs_page_comments as comments
from app.services import docs_presence as presence
from app.services import docs_site_pages as pages
from app.services import docs_site_store as store

router = APIRouter(route_class=DocsRoute)


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


# ── AI help ───────────────────────────────────────────────────────────────────


@router.get("/{site_id}/ai/edit/status")
@limiter.limit("120/minute")
async def editor_ai_status(request: Request, site_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                           user: User = Depends(require_user)):
    """{available, reason, message, used_today, limit_today, guide_used_month, guide_limit_month,
    max_chars, actions, languages}."""
    site, _role = await store.load_site(db, site_id, user, "editor")
    return await editor_ai.status(db, site, user)


@router.post("/{site_id}/ai/edit")
@limiter.limit("30/minute")
async def editor_ai_edit(request: Request, site_id: str, body: EditorAIRequest,
                         db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """{markdown, request_id, used_today, limit_today}: the passage rewritten."""
    site, _role = await store.load_site(db, site_id, user, "editor")
    return await editor_ai.edit(db, site, user, action=body.action, text=body.text, language=body.language,
                                page_id=body.page_id)


# ── Review comments ───────────────────────────────────────────────────────────


@router.get("/{site_id}/comments/summary")
@limiter.limit("120/minute")
async def comments_summary(request: Request, site_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                           user: User = Depends(require_user)):
    """{pages: {page_id: open comments}}."""
    site, _role = await store.load_site(db, site_id, user, "editor")
    return await comments.summary(db, site)


@router.get("/{site_id}/pages/{page_id}/comments")
@limiter.limit("120/minute")
async def list_comments(request: Request, site_id: str, page_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                        user: User = Depends(require_user)):
    site, role = await store.load_site(db, site_id, user, "editor")
    page = await pages.load_page(db, site, page_id)
    return await comments.list_comments(db, site, page, user, role)


@router.post("/{site_id}/pages/{page_id}/comments", status_code=201)
@limiter.limit("60/minute")
async def add_comment(request: Request, site_id: str, page_id: str, body: CommentCreate,
                      db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, role = await store.load_site(db, site_id, user, "editor")
    page = await pages.load_page(db, site, page_id)
    return await comments.add(db, site, page, user, role, quote=body.quote, prefix=body.prefix,
                              suffix=body.suffix, body=body.body)


@router.post("/{site_id}/pages/{page_id}/comments/{comment_id}/replies")
@limiter.limit("60/minute")
async def reply_comment(request: Request, site_id: str, page_id: str, comment_id: str, body: CommentReply,
                        db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, role = await store.load_site(db, site_id, user, "editor")
    page = await pages.load_page(db, site, page_id)
    return await comments.reply(db, site, page, user, role, comment_id, body.body)


@router.post("/{site_id}/pages/{page_id}/comments/{comment_id}/resolve")
@limiter.limit("60/minute")
async def resolve_comment(request: Request, site_id: str, page_id: str, comment_id: str, body: CommentResolve,
                          db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, role = await store.load_site(db, site_id, user, "editor")
    page = await pages.load_page(db, site, page_id)
    return await comments.resolve(db, site, page, user, role, comment_id, body.resolved)


@router.delete("/{site_id}/pages/{page_id}/comments/{comment_id}")
@limiter.limit("60/minute")
async def delete_comment(request: Request, site_id: str, page_id: str, comment_id: str,
                         db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, role = await store.load_site(db, site_id, user, "editor")
    page = await pages.load_page(db, site, page_id)
    await comments.delete(db, site, page, user, role, comment_id)
    return {"deleted": True}


# ── Presence ──────────────────────────────────────────────────────────────────


@router.post("/{site_id}/presence")
@limiter.limit("120/minute")
async def presence_beat(request: Request, site_id: str, body: PresenceBeat,
                        db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """A heartbeat (every ~30 s per tab): {people: [{user_id, name, page_id, page_title, page_path,
    editing}]}, everyone else on the guide right now."""
    site, _role = await store.load_site(db, site_id, user)
    return await presence.beat(db, site, user, body.session, body.page_id)


@router.delete("/{site_id}/presence")
@limiter.limit("120/minute")
async def presence_leave(request: Request, site_id: str,
                         session: str = Query(..., pattern=r"^[A-Za-z0-9_-]{8,40}$"),
                         db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user)
    await presence.leave(db, site, user, session)
    return {"ok": True}
