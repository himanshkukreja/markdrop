"""Ask Markdrop (services/ask_markdrop.py): the home's question box.

    GET    /api/v1/ask/home             {status, suggestions, recent}
    POST   /api/v1/ask                  SSE  {question, thread_id?, intent?, page?}
           page (a slug) + intent "page": Ask AI in that page with its workspace's meeting memory
           events: status {stage}, results {items}, delta {text},
                   done {request_id, thread_id, intent, answer, citations, ranked, usage, truncated},
                   limit {reason, message}, error {detail, code}
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
from app.services import access, ask_markdrop
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


class AskBody(BaseModel):
    question: str = Field("", max_length=ask_markdrop.MAX_QUESTION)
    thread_id: Optional[str] = Field(None, max_length=40)
    intent: Optional[Literal["ask", "catch_up", "my_actions", "page"]] = None
    page: Optional[str] = Field(None, max_length=200, description="Ask AI in this page (its slug): the page, then its "
                                "workspace's meetings (recorded decisions first) and documents. Implies intent \"page\".")


@router.post("")
@limiter.limit("30/minute")
async def ask(request: Request, body: AskBody, db: AsyncIOMotorDatabase = Depends(get_db),
              user: User = Depends(require_user)):
    """Ask a question (a follow-up with ``thread_id``); the answer streams as Server-Sent Events."""
    actor, ctx = _ac(request, db, user)
    return sse(ask_markdrop.ask(db, actor, ctx, body.question, thread_id=body.thread_id, intent=body.intent,
                                via="home", page=body.page))


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
