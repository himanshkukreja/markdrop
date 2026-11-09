"""Comments on pages and markdown documents (CONTRACT §5; services/comments).

    GET    /api/v1/documents/{slug}/comments                         the item's threads
    POST   /api/v1/documents/{slug}/comments                         start a thread
    GET    /api/v1/documents/{slug}/comments/people                  who can be @mentioned
    PUT    /api/v1/documents/{slug}/comments/settings                per-item switches (owner)
    GET    /api/v1/documents/{slug}/comments/{thread_id}             one thread
    POST   /api/v1/documents/{slug}/comments/{thread_id}/replies     reply
    PATCH  /api/v1/documents/{slug}/comments/{thread_id}/messages/{message_id}   edit your message
    DELETE /api/v1/documents/{slug}/comments/{thread_id}/messages/{message_id}   delete your message
    POST   /api/v1/documents/{slug}/comments/{thread_id}/messages/{message_id}/reactions
    POST   /api/v1/documents/{slug}/comments/{thread_id}/resolve | /reopen
    PUT    /api/v1/documents/{slug}/comments/{thread_id}/assignee
    GET    /api/v1/comments/mine                                     threads waiting on you / assigned / mentions
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Header, Path, Query, Request, Response
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import optional_user, require_user
from app.services import access
from app.services.comments import people, service, tasks
from app.utils.net import get_client_ip

router = APIRouter(tags=["comments"])

_TID = r"^[0-9a-f]{24}$"


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


class QuoteIn(BaseModel):
    exact: str = Field(min_length=1, max_length=1000)
    prefix: str | None = Field(None, max_length=64)
    suffix: str | None = Field(None, max_length=64)


class AnchorIn(BaseModel):
    type: Literal["text", "block", "page"]
    block_id: str | None = Field(None, max_length=40)
    block_text: str | None = Field(None, max_length=2000)
    quote: QuoteIn | None = None
    start: int | None = Field(None, ge=0)


class ThreadCreate(BaseModel):
    anchor: AnchorIn
    body: str = Field(min_length=1, max_length=5000)
    mentions: list[str] | None = Field(None, max_length=20)
    assignee: str | None = Field(None, max_length=40)
    attachments: list[str] | None = Field(None, max_length=10)
    suggestion: str | None = Field(None, max_length=5000)


class ReplyCreate(BaseModel):
    body: str = Field(min_length=1, max_length=5000)
    mentions: list[str] | None = Field(None, max_length=20)
    attachments: list[str] | None = Field(None, max_length=10)
    suggestion: str | None = Field(None, max_length=5000)


class MessageEdit(BaseModel):
    body: str = Field(min_length=1, max_length=5000)
    mentions: list[str] | None = Field(None, max_length=20)


class ReactionIn(BaseModel):
    emoji: str = Field(min_length=1, max_length=16)
    on: bool | None = None


class AssigneeIn(BaseModel):
    user_id: str | None = Field(None, max_length=40)


class CommentSettingsIn(BaseModel):
    enabled: bool | None = None
    public: bool | None = None


async def _load(request: Request, db, slug: str, user: User | None, read_password: str | None,
                scope: str | None) -> tuple[dict | None, access.Actor, access.Ctx]:
    actor = access.actor_from_request(request, user, read_password=read_password)
    ctx = access.Ctx(db, surface="rest", workspace_scope=scope or None, ip=get_client_ip(request))
    raw = await db["documents"].find_one({"slug": slug})
    return raw, actor, ctx


# Literal paths first: `/{thread_id}` only matches 24-hex ids anyway.

@router.get("/api/v1/documents/{slug}/comments")
@limiter.limit("240/minute")
async def list_comments(request: Request, slug: str,
                        status: Literal["open", "resolved", "all"] = Query("all"),
                        mine: bool = Query(False),
                        db: AsyncIOMotorDatabase = Depends(get_db),
                        x_read_password: str | None = Header(None),
                        x_markdrop_workspace: str | None = Header(None),
                        user: User | None = Depends(optional_user)):
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    return await service.list_threads(db, actor, raw, ctx, status=status, mine=mine)


@router.post("/api/v1/documents/{slug}/comments", status_code=201)
@limiter.limit("30/minute")
async def create_comment(request: Request, slug: str, data: ThreadCreate,
                         db: AsyncIOMotorDatabase = Depends(get_db),
                         x_read_password: str | None = Header(None),
                         x_markdrop_workspace: str | None = Header(None),
                         user: User = Depends(require_user)):
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    return await service.create_thread(
        db, actor, raw, ctx, anchor=data.anchor.model_dump(), body=data.body, mentions=data.mentions,
        assignee=data.assignee, attachments=data.attachments, suggestion=data.suggestion)


@router.get("/api/v1/documents/{slug}/comments/people")
@limiter.limit("120/minute")
async def comment_people(request: Request, slug: str, q: str | None = Query(None, max_length=200),
                         db: AsyncIOMotorDatabase = Depends(get_db),
                         x_read_password: str | None = Header(None),
                         x_markdrop_workspace: str | None = Header(None),
                         user: User = Depends(require_user)):
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    return await people.mentionable(db, actor, raw, ctx, q)


@router.put("/api/v1/documents/{slug}/comments/settings")
@limiter.limit("60/minute")
async def comment_settings(request: Request, slug: str, data: CommentSettingsIn,
                           db: AsyncIOMotorDatabase = Depends(get_db),
                           user: User = Depends(require_user)):
    raw, actor, ctx = await _load(request, db, slug, user, None, None)
    return await service.update_settings(db, actor, raw, ctx, enabled=data.enabled, public=data.public)


@router.get("/api/v1/documents/{slug}/comments/{thread_id}")
@limiter.limit("240/minute")
async def get_comment_thread(request: Request, slug: str, thread_id: str = Path(pattern=_TID),
                             db: AsyncIOMotorDatabase = Depends(get_db),
                             x_read_password: str | None = Header(None),
                             x_markdrop_workspace: str | None = Header(None),
                             user: User | None = Depends(optional_user)):
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    return await service.get_thread(db, actor, raw, ctx, thread_id)


@router.post("/api/v1/documents/{slug}/comments/{thread_id}/replies", status_code=201)
@limiter.limit("60/minute")
async def reply_comment(request: Request, slug: str, data: ReplyCreate, thread_id: str = Path(pattern=_TID),
                        db: AsyncIOMotorDatabase = Depends(get_db),
                        x_read_password: str | None = Header(None),
                        x_markdrop_workspace: str | None = Header(None),
                        user: User = Depends(require_user)):
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    thread, message = await service.reply(db, actor, raw, ctx, thread_id, body=data.body, mentions=data.mentions,
                                          attachments=data.attachments, suggestion=data.suggestion)
    return {"thread": thread, "message": message}


@router.patch("/api/v1/documents/{slug}/comments/{thread_id}/messages/{message_id}")
@limiter.limit("60/minute")
async def edit_comment(request: Request, slug: str, data: MessageEdit, thread_id: str = Path(pattern=_TID),
                       message_id: str = Path(pattern=_TID),
                       db: AsyncIOMotorDatabase = Depends(get_db),
                       x_read_password: str | None = Header(None),
                       x_markdrop_workspace: str | None = Header(None),
                       user: User = Depends(require_user)):
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    return await service.edit_message(db, actor, raw, ctx, thread_id, message_id, body=data.body,
                                      mentions=data.mentions)


@router.delete("/api/v1/documents/{slug}/comments/{thread_id}/messages/{message_id}", status_code=204)
@limiter.limit("60/minute")
async def delete_comment(request: Request, slug: str, thread_id: str = Path(pattern=_TID),
                         message_id: str = Path(pattern=_TID),
                         db: AsyncIOMotorDatabase = Depends(get_db),
                         x_read_password: str | None = Header(None),
                         x_markdrop_workspace: str | None = Header(None),
                         user: User = Depends(require_user)):
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    await service.delete_message(db, actor, raw, ctx, thread_id, message_id)
    return Response(status_code=204)


@router.post("/api/v1/documents/{slug}/comments/{thread_id}/messages/{message_id}/reactions")
@limiter.limit("120/minute")
async def react_comment(request: Request, slug: str, data: ReactionIn, thread_id: str = Path(pattern=_TID),
                        message_id: str = Path(pattern=_TID),
                        db: AsyncIOMotorDatabase = Depends(get_db),
                        x_read_password: str | None = Header(None),
                        x_markdrop_workspace: str | None = Header(None),
                        user: User = Depends(require_user)):
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    return await service.react(db, actor, raw, ctx, thread_id, message_id, data.emoji, on=data.on)


@router.post("/api/v1/documents/{slug}/comments/{thread_id}/resolve")
@limiter.limit("60/minute")
async def resolve_comment(request: Request, slug: str, thread_id: str = Path(pattern=_TID),
                          db: AsyncIOMotorDatabase = Depends(get_db),
                          x_read_password: str | None = Header(None),
                          x_markdrop_workspace: str | None = Header(None),
                          user: User = Depends(require_user)):
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    return await service.resolve(db, actor, raw, ctx, thread_id)


@router.post("/api/v1/documents/{slug}/comments/{thread_id}/reopen")
@limiter.limit("60/minute")
async def reopen_comment(request: Request, slug: str, thread_id: str = Path(pattern=_TID),
                         db: AsyncIOMotorDatabase = Depends(get_db),
                         x_read_password: str | None = Header(None),
                         x_markdrop_workspace: str | None = Header(None),
                         user: User = Depends(require_user)):
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    return await service.reopen(db, actor, raw, ctx, thread_id)


@router.put("/api/v1/documents/{slug}/comments/{thread_id}/assignee")
@limiter.limit("60/minute")
async def assign_comment(request: Request, slug: str, data: AssigneeIn, thread_id: str = Path(pattern=_TID),
                         db: AsyncIOMotorDatabase = Depends(get_db),
                         x_read_password: str | None = Header(None),
                         x_markdrop_workspace: str | None = Header(None),
                         user: User = Depends(require_user)):
    raw, actor, ctx = await _load(request, db, slug, user, x_read_password, x_markdrop_workspace)
    return await service.assign(db, actor, raw, ctx, thread_id, data.user_id)


@router.get("/api/v1/comments/mine")
@limiter.limit("120/minute")
async def my_comments(request: Request, view: Literal["assigned", "waiting", "mentions"] = Query("waiting"),
                      limit: int = Query(20, ge=1, le=50),
                      db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    actor = access.actor_from_request(request, user)
    ctx = access.Ctx(db, surface="rest", ip=get_client_ip(request))
    return await tasks.mine(db, actor, ctx, view=view, limit=limit)
