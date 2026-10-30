"""docs.markdrop.in: Ask AI (SSE) and the two feedback widgets.

    POST /api/v1/docs/ask             Server-Sent Events, see services/docs_agent.py
    POST /api/v1/docs/ask/feedback    {request_id, helpful, comment?}
    POST /api/v1/docs/feedback        {path, helpful, comment?}   ("Did this page help?")
    GET  /api/v1/docs/ai/status       {available, reason?}        (show Ask AI or Open-in links)

CORS for the docs origins is middleware/docs_cors.py. Sign-in is optional: a
Markdrop session or API token unlocks the personal tools for that account; a
tenant token (a workspace domain's scoped session) and anything invalid count
as signed out, never as an error.
"""

# No `from __future__ import annotations` here: slowapi wraps these routes, and
# FastAPI resolves string annotations against the wrapper's module, not this one.
import asyncio
import json
import re
from typing import Any

import jwt
from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.services import api_token, docs_agent
from app.services import user as user_service
from app.utils.auth import decode_access_token
from app.utils.net import get_client_ip

router = APIRouter(prefix="/api/v1/docs", tags=["docs"])

KEEPALIVE_S = 15.0
SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    # nginx: pass each event through as it is written.
    "X-Accel-Buffering": "no",
}


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


async def docs_caller(request: Request) -> User | None:
    """The signed-in Markdrop user behind the request, or None.

    Only a full session JWT or an API token counts. A tenant token is a
    credential for one workspace's own domain and is never honoured here; an
    expired or invalid credential is simply "signed out".
    """
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth.removeprefix("Bearer ").strip()
    if not token:
        return None
    db = get_database()
    if token.startswith(api_token.TOKEN_PREFIX):
        user_id = await api_token.verify_token(db, token)
    else:
        try:
            payload = decode_access_token(token)
        except jwt.InvalidTokenError:
            return None
        if payload.get("typ") == "tenant":
            return None
        user_id = payload.get("sub")
    if not user_id:
        return None
    return await user_service.get_user_by_id(db, user_id)


class AskBody(BaseModel):
    # The 2,000-character limit is enforced by the agent (an `error` event the
    # panel can show); this bound only rejects absurd bodies outright.
    question: str = Field(..., max_length=10_000)
    history: list[Any] = Field(default_factory=list, max_length=60)
    page_path: str | None = Field(None, max_length=300)
    conversation_id: str | None = Field(None, max_length=64)


def _sse(event: str, data: dict) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")


@router.post("/ask")
@limiter.limit("20/minute")
async def ask(
    request: Request,
    body: AskBody,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User | None = Depends(docs_caller),
):
    req = docs_agent.AskRequest(
        question=body.question, history=body.history, page_path=body.page_path,
        conversation_id=body.conversation_id, user=user, ip=get_client_ip(request),
    )

    async def stream():
        queue: asyncio.Queue = asyncio.Queue()
        done = object()

        async def produce():
            try:
                async for event, data in docs_agent.ask(db, req):
                    await queue.put((event, data))
            except Exception:
                await queue.put(("error", {"message": "Ask AI hit a problem answering that. Try again.",
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


class AnswerFeedbackBody(BaseModel):
    request_id: str = Field(..., pattern=r"^[a-f0-9]{32}$")
    helpful: bool
    comment: str | None = Field(None, max_length=2000)


@router.post("/ask/feedback")
@limiter.limit("30/minute")
async def ask_feedback(request: Request, body: AnswerFeedbackBody, db: AsyncIOMotorDatabase = Depends(get_db)):
    ok = await docs_agent.answer_feedback(db, body.request_id, body.helpful, body.comment)
    return {"status": "received" if ok else "unknown"}


_PATH = re.compile(r"^/[A-Za-z0-9/_.-]{0,299}$")


class PageFeedbackBody(BaseModel):
    path: str = Field(..., max_length=400)
    helpful: bool
    comment: str | None = Field(None, max_length=4000)


@router.post("/feedback")
@limiter.limit("20/minute")
async def page_feedback(
    request: Request,
    body: PageFeedbackBody,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User | None = Depends(docs_caller),
):
    path = body.path.split("#", 1)[0].split("?", 1)[0].strip()
    path = path.rstrip("/") or "/"
    if not _PATH.match(path):
        return {"status": "ignored"}
    await docs_agent.page_feedback(db, path=path, helpful=body.helpful, comment=body.comment,
                                   user_id=user.id if user else None, ip=get_client_ip(request))
    return {"status": "received"}


@router.get("/ai/status")
@limiter.limit("60/minute")
async def ai_status(request: Request):
    if not docs_agent.enabled():
        return {"available": False, "reason": "disabled"}
    if not docs_agent.configured():
        return {"available": False, "reason": "not_configured"}
    return {"available": True}
