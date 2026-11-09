"""Jira inside pages: /api/v1/jira/pages/… and /api/v1/jira/issue/… (services/jira_pages.py).

Readers (signed in or not; ``X-Read-Password`` for a password page):
    GET    /pages/{slug}/items                     the page's chips and cards: snapshots for everyone, live
                                                   details through your own Jira (never a Jira call for anonymous readers)
    POST   /pages/{slug}/list                      one page of a list block, under your own Jira
    GET    /pages/{slug}/threads                   discussions linked to issues

Editors and signed-in people with Jira (each change is made as you; Jira's permissions decide):
    POST   /pages/{slug}/remember {key, site}      an issue just put on the page: its "KEY · title" snapshot
    POST   /pages/{slug}/threads/{thread}/draft    an AI draft of an issue from a discussion
    POST   /pages/{slug}/threads/{thread}/issue    create it and link the discussion
    POST   /pages/{slug}/threads/{thread}/link     link the discussion to an existing issue;  DELETE: unlink
    GET    /search?site=&q=                        the editor's issue picker
    GET    /issue/{key}?site=                      one issue, fresh
    GET    /issue/{key}/transitions?site=          the workflow steps you can take, with their fields
    POST   /issue/{key}/transition                 {site, transition, fields?, slug?}
    GET    /issue/{key}/assignable?site=&q=        people it can be assigned to
    PUT    /issue/{key}/assignee                   {site, account_id|null, slug?}
    POST   /issue/{key}/comment                    {site, body, slug?}
    PATCH  /issue/{key}                            {site, summary?, priority?, due?, slug?}
    GET    /priorities?site=
"""

# No `from __future__ import annotations`: slowapi wraps these routes (see routers/docs_ai.py).
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import optional_user, require_user
from app.routers.jira import Fields
from app.services import access, jira_pages
from app.utils.net import get_client_ip

router = APIRouter(prefix="/api/v1/jira", tags=["jira"])

_SLUG = r"^[A-Za-z0-9_-]{1,64}$"
_TID = r"^[0-9a-f]{24}$"
_KEY = r"^[A-Za-z][A-Za-z0-9_]{0,19}-[1-9][0-9]{0,8}$"
_SITE = r"^[A-Za-z0-9:/._-]{3,200}$"


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


async def _load(request: Request, db, slug: str, user: Optional[User], read_password: Optional[str],
                scope: Optional[str]):
    actor = access.actor_from_request(request, user, read_password=read_password)
    ctx = access.Ctx(db, surface="rest", workspace_scope=scope or None, ip=get_client_ip(request))
    raw = await db["documents"].find_one({"slug": slug})
    return raw, actor, ctx


class ListIn(BaseModel):
    jql: Optional[str] = Field(None, max_length=jira_pages.MAX_JQL)
    project: Optional[str] = Field(None, max_length=20)
    filter: Optional[str] = Field(None, max_length=12)
    site: Optional[str] = Field(None, pattern=_SITE)
    cols: Optional[list[str]] = Field(None, max_length=10)
    limit: Optional[int] = Field(None, ge=1, le=jira_pages.LIST_MAX)
    title: Optional[str] = Field(None, max_length=200)
    page_token: Optional[str] = Field(None, max_length=2000)


class RememberIn(BaseModel):
    key: str = Field(..., pattern=_KEY)
    site: Optional[str] = Field(None, pattern=_SITE)


class ThreadDraftIn(BaseModel):
    project: Optional[str] = Field(None, max_length=20)


class ThreadIssueIn(BaseModel):
    fields: Fields


class ThreadLinkIn(BaseModel):
    key: str = Field(..., min_length=3, max_length=300)
    site: Optional[str] = Field(None, pattern=_SITE)


class OnIssue(BaseModel):
    site: Optional[str] = Field(None, pattern=_SITE)
    slug: Optional[str] = Field(None, pattern=_SLUG)


class TransitionIn(OnIssue):
    transition: str = Field(..., min_length=1, max_length=80)
    fields: Optional[dict[str, Any]] = None


class AssigneeIn(OnIssue):
    account_id: Optional[str] = Field(None, max_length=128)


class CommentIn(OnIssue):
    body: str = Field(..., min_length=1, max_length=jira_pages.COMMENT_MAX)


class EditIn(OnIssue):
    summary: Optional[str] = Field(None, max_length=400)
    priority: Optional[str] = Field(None, max_length=40)
    due: Optional[str] = Field(None, max_length=10)


# ── A page's Jira ─────────────────────────────────────────────────────────────


@router.get("/pages/{slug}/items", summary="Jira chips and cards on a page, for this viewer")
@limiter.limit("240/minute")
async def page_items(request: Request, slug: str, db: AsyncIOMotorDatabase = Depends(get_db),
                     x_read_password: Optional[str] = Header(None), x_markdrop_workspace: Optional[str] = Header(None),
                     user: Optional[User] = Depends(optional_user)):
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    return await jira_pages.page_items(db, actor, ctx, raw)


@router.post("/pages/{slug}/list", summary="One page of a Jira list block (as you)")
@limiter.limit("120/minute")
async def page_list(request: Request, slug: str, body: ListIn, db: AsyncIOMotorDatabase = Depends(get_db),
                    x_read_password: Optional[str] = Header(None), x_markdrop_workspace: Optional[str] = Header(None),
                    user: User = Depends(require_user)):
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    return await jira_pages.run_list(db, actor, ctx, raw, body.model_dump(exclude={"page_token"}),
                                     page_token=body.page_token)


@router.post("/pages/{slug}/remember", summary="Remember an issue put on a page (its snapshot)")
@limiter.limit("120/minute")
async def page_remember(request: Request, slug: str, body: RememberIn, db: AsyncIOMotorDatabase = Depends(get_db),
                        x_markdrop_workspace: Optional[str] = Header(None), user: User = Depends(require_user)):
    raw, actor, ctx = await _load(request, db, slug, user, None, x_markdrop_workspace)
    return await jira_pages.remember(db, actor, ctx, raw, body.site, body.key)


@router.get("/pages/{slug}/threads", summary="Discussions on a page linked to Jira issues")
@limiter.limit("240/minute")
async def page_threads(request: Request, slug: str, db: AsyncIOMotorDatabase = Depends(get_db),
                       x_read_password: Optional[str] = Header(None), x_markdrop_workspace: Optional[str] = Header(None),
                       user: Optional[User] = Depends(optional_user)):
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    return await jira_pages.thread_links(db, actor, ctx, raw)


@router.post("/pages/{slug}/threads/{thread_id}/draft", summary="Draft a Jira issue from a discussion")
@limiter.limit("30/minute")
async def thread_draft(request: Request, slug: str, thread_id: str, body: ThreadDraftIn,
                       db: AsyncIOMotorDatabase = Depends(get_db),
                       x_read_password: Optional[str] = Header(None), x_markdrop_workspace: Optional[str] = Header(None),
                       user: User = Depends(require_user)):
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    return await jira_pages.thread_draft(db, actor, ctx, raw, thread_id, body.project)


@router.post("/pages/{slug}/threads/{thread_id}/issue", summary="Create a Jira issue from a discussion")
@limiter.limit("30/minute")
async def thread_issue(request: Request, slug: str, thread_id: str, body: ThreadIssueIn,
                       db: AsyncIOMotorDatabase = Depends(get_db),
                       x_read_password: Optional[str] = Header(None), x_markdrop_workspace: Optional[str] = Header(None),
                       user: User = Depends(require_user)):
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    return await jira_pages.thread_create(db, actor, ctx, raw, thread_id, body.fields.model_dump())


@router.post("/pages/{slug}/threads/{thread_id}/link", summary="Link a discussion to a Jira issue")
@limiter.limit("30/minute")
async def thread_link(request: Request, slug: str, thread_id: str, body: ThreadLinkIn,
                      db: AsyncIOMotorDatabase = Depends(get_db),
                      x_read_password: Optional[str] = Header(None), x_markdrop_workspace: Optional[str] = Header(None),
                      user: User = Depends(require_user)):
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    return await jira_pages.thread_link(db, actor, ctx, raw, thread_id, body.key, body.site)


@router.delete("/pages/{slug}/threads/{thread_id}/link", summary="Unlink a discussion from its Jira issue")
@limiter.limit("30/minute")
async def thread_unlink(request: Request, slug: str, thread_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                        x_read_password: Optional[str] = Header(None), x_markdrop_workspace: Optional[str] = Header(None),
                        user: User = Depends(require_user)):
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    return await jira_pages.thread_unlink(db, actor, ctx, raw, thread_id)


# ── Issues (as you) ───────────────────────────────────────────────────────────


@router.get("/search", summary="Find Jira issues (the editor's picker)")
@limiter.limit("120/minute")
async def search(request: Request, site: str = Query(..., pattern=_SITE), q: str = Query("", max_length=200),
                 db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    return await jira_pages.search(db, user.id, site, q)


@router.get("/priorities", summary="A Jira site's priorities")
@limiter.limit("60/minute")
async def priorities(request: Request, site: str = Query(..., pattern=_SITE), db: AsyncIOMotorDatabase = Depends(get_db),
                     user: User = Depends(require_user)):
    return await jira_pages.priorities(db, user.id, site)


@router.get("/issue/{key}", summary="A Jira issue, fresh (as you)")
@limiter.limit("120/minute")
async def issue(request: Request, key: str, site: str = Query(..., pattern=_SITE),
                db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    return await jira_pages.issue(db, user.id, site, key)


@router.get("/issue/{key}/transitions", summary="The workflow steps you can take on an issue")
@limiter.limit("120/minute")
async def transitions(request: Request, key: str, site: str = Query(..., pattern=_SITE),
                      db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    return await jira_pages.transitions(db, user.id, site, key)


@router.post("/issue/{key}/transition", summary="Move an issue (as you)")
@limiter.limit("60/minute")
async def transition(request: Request, key: str, body: TransitionIn, db: AsyncIOMotorDatabase = Depends(get_db),
                     user: User = Depends(require_user)):
    return await jira_pages.transition(db, user.id, body.site, key, body.transition, fields=body.fields, slug=body.slug)


@router.get("/issue/{key}/assignable", summary="People an issue can be assigned to")
@limiter.limit("120/minute")
async def assignable(request: Request, key: str, site: str = Query(..., pattern=_SITE), q: str = Query("", max_length=100),
                     db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    return await jira_pages.assignable(db, user.id, site, key, q)


@router.put("/issue/{key}/assignee", summary="Assign an issue (as you)")
@limiter.limit("60/minute")
async def assignee(request: Request, key: str, body: AssigneeIn, db: AsyncIOMotorDatabase = Depends(get_db),
                   user: User = Depends(require_user)):
    return await jira_pages.assign(db, user.id, body.site, key, body.account_id, slug=body.slug)


@router.post("/issue/{key}/comment", summary="Comment on an issue in Jira (as you)")
@limiter.limit("30/minute")
async def comment(request: Request, key: str, body: CommentIn, db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    return await jira_pages.comment(db, user.id, body.site, key, body.body, slug=body.slug)


@router.patch("/issue/{key}", summary="Edit an issue's title, priority or due date (as you)")
@limiter.limit("60/minute")
async def edit(request: Request, key: str, body: EditIn, db: AsyncIOMotorDatabase = Depends(get_db),
               user: User = Depends(require_user)):
    changes = body.model_dump(exclude={"site", "slug"}, exclude_unset=True)
    return await jira_pages.edit(db, user.id, body.site, key, changes, slug=body.slug)
