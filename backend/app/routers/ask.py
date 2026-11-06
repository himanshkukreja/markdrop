"""Ask Markdrop: the one assistant everywhere (services/assistant.py) and the home's box (services/ask_markdrop.py).

    GET    /api/v1/ask/home             {status, suggestions, recent}
    POST   /api/v1/ask                  SSE  {question, thread_id?, intent?, page?}
           page (a slug) + intent "page": Ask AI in that page with its workspace's meeting memory
           events: status {stage}, results {items}, delta {text},
                   done {request_id, thread_id, intent, answer, citations, ranked, usage, truncated},
                   limit {reason, message}, error {detail, code}
           scope (the assistant): {kind: doc|meetings|folder|workspace|everything, page?, workspace?,
                  folder?, meeting?, series?, since?, until?}; context: {heading?, selection?} (doc)
           doc/folder/workspace/everything count towards AI search, meetings towards Meetings AI
    GET    /api/v1/ask/context          {scopes, default, page, workspace, folder, meeting, series,
                                         can_insert, status}   what the assistant offers here
    GET    /api/v1/ask/threads          {threads}            recent questions
    GET    /api/v1/ask/threads/{id}     {id, title, turns}   a turn whose sources you can no longer
                                                             open comes back withheld
    DELETE /api/v1/ask/threads/{id}     one conversation
    DELETE /api/v1/ask/threads          every conversation

Signed-in only (``require_user``). Answers use only what the caller can open now; every cited item
is decided again before it is returned. Counts towards the "AI search" limits.
"""

# No `from __future__ import annotations`: slowapi wraps these routes (see routers/docs_ai.py).
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.routers.pages_ai import sse
from app.services import access, ask_markdrop, assistant
from app.utils.net import get_client_ip

router = APIRouter(prefix="/api/v1/ask", tags=["ask"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _ac(request: Request, db, user: User):
    return (access.actor_from_request(request, user),
            access.Ctx(db, surface="rest", ip=get_client_ip(request)))


@router.get("/home")
@limiter.limit("120/minute")
async def ask_home(request: Request, db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """What the home's Ask box needs: whether AI can answer now, suggested questions, recent ones."""
    actor, ctx = _ac(request, db, user)
    return jsonable_encoder(await ask_markdrop.home(db, actor, ctx))


class ScopeBody(BaseModel):
    kind: Literal["doc", "meetings", "folder", "workspace", "everything"] = "everything"
    page: Optional[str] = Field(None, max_length=200, description="doc: the document or page (its slug)")
    workspace: Optional[str] = Field(None, max_length=40, description="meetings / folder / workspace: the workspace id")
    folder: Optional[str] = Field(None, max_length=40, description="folder: the folder id (its sub-folders too)")
    meeting: Optional[str] = Field(None, max_length=40, description="meetings: one meeting (its id)")
    series: Optional[str] = Field(None, max_length=60, description="meetings: only this series")
    since: Optional[str] = Field(None, max_length=10, description="meetings: from this day (YYYY-MM-DD)")
    until: Optional[str] = Field(None, max_length=10, description="meetings: to this day (YYYY-MM-DD)")


class ContextBody(BaseModel):
    heading: Optional[str] = Field(None, max_length=ask_markdrop.CONTEXT_HEADING)
    selection: Optional[str] = Field(None, max_length=ask_markdrop.CONTEXT_SELECTION)


class AskBody(BaseModel):
    # The chat composer allows 600 characters; the engines use the first MAX_QUESTION (a longer paste
    # is cut, never a 422 the panel can only show as "hit a problem").
    question: str = Field("", max_length=2000)
    thread_id: Optional[str] = Field(None, max_length=40)
    intent: Optional[Literal["ask", "catch_up", "my_actions", "page"]] = None
    page: Optional[str] = Field(None, max_length=200, description="Ask AI in this page (its slug): the page, then its "
                                "workspace's meetings (recorded decisions first) and documents. Implies intent \"page\".")
    scope: Optional[ScopeBody] = Field(None, description="What to answer from (the assistant). Without it: everything "
                                       "(or `page`).")
    context: Optional[ContextBody] = Field(None, description="Where the reader is in the doc (scope doc).")


@router.post("")
@limiter.limit("30/minute")
async def ask(request: Request, body: AskBody, db: AsyncIOMotorDatabase = Depends(get_db),
              user: User = Depends(require_user)):
    """Ask a question (a follow-up with ``thread_id``); the answer streams as Server-Sent Events."""
    actor, ctx = _ac(request, db, user)
    if body.scope is not None:
        try:
            scope = assistant.parse_scope(body.scope.model_dump())
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        intent = body.intent if body.intent in ("ask", "catch_up", "my_actions") else None
        return sse(assistant.ask(db, actor, ctx, body.question, scope=scope, thread_id=body.thread_id, intent=intent,
                                 context=body.context.model_dump() if body.context else None))
    return sse(ask_markdrop.ask(db, actor, ctx, body.question, thread_id=body.thread_id, intent=body.intent,
                                via="home", page=body.page))


@router.get("/context")
@limiter.limit("120/minute")
async def ask_context(request: Request, page: Optional[str] = Query(None, max_length=200),
                      workspace: Optional[str] = Query(None, max_length=40),
                      folder: Optional[str] = Query(None, max_length=40),
                      meeting: Optional[str] = Query(None, max_length=40),
                      db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """What the assistant offers where you are: its scopes (This doc, Meetings, This folder, Workspace,
    Everything) for things you can open, the default one, the workspace's meeting series, whether you
    can insert answers into the doc, and whether AI can answer now (AI search and Meetings AI)."""
    actor, ctx = _ac(request, db, user)
    return jsonable_encoder(await assistant.context_for(db, actor, ctx, page=page, workspace=workspace, folder=folder,
                                                        meeting=meeting))


@router.get("/threads")
@limiter.limit("120/minute")
async def list_threads(request: Request, limit: int = Query(20, ge=1, le=ask_markdrop.MAX_THREADS),
                       db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """Your recent questions, newest first."""
    return jsonable_encoder({"threads": await ask_markdrop.list_threads(db, user.id, limit=limit)})


@router.get("/threads/{thread_id}")
@limiter.limit("120/minute")
async def get_thread(request: Request, thread_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                     user: User = Depends(require_user)):
    """One conversation, its sources decided again for you now."""
    actor, ctx = _ac(request, db, user)
    out = await ask_markdrop.get_thread(db, actor, ctx, thread_id)
    if out is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return jsonable_encoder(out)


@router.delete("/threads/{thread_id}")
@limiter.limit("60/minute")
async def delete_thread(request: Request, thread_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                        user: User = Depends(require_user)):
    if not await ask_markdrop.delete_thread(db, user.id, thread_id):
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"deleted": 1}


@router.delete("/threads")
@limiter.limit("20/minute")
async def clear_threads(request: Request, db: AsyncIOMotorDatabase = Depends(get_db),
                        user: User = Depends(require_user)):
    return {"deleted": await ask_markdrop.clear_threads(db, user.id)}
