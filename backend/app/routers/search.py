"""Global search (services/search.py) and AI search (services/search_ai.py).

    GET  /api/v1/search?q=&scope=all|workspace:<id>&kind=&owner=me|anyone&updated=any|week|month
                       &current=<workspace id>&cursor=&limit=&sid=
         → {query, items, groups: [{key, label, items, more}], trash, next_cursor, total, took_ms,
            ai_suggested, log_id}
    POST /api/v1/search/click            {log_id}: a result was opened from that search
    GET  /api/v1/search/ai-status?scope=        {enabled, reason, message, model}
    POST /api/v1/search/ask              SSE   {question, scope?, current?}
         events: status {stage}, results {items}, delta {text},
                 done {request_id, usage, answer, citations, ranked}, limit {reason, message},
                 error {detail, code}

The first page of a search in a workspace is logged without who ran it (services/search_log.py:
query text, workspace, result count, clicked, time; 90 days), for content gaps.

Signed-in only (``require_user``; a workspace's own-domain session isn't on the tenant allowlist,
so it gets 401). Every result is something the caller can open now (services/search.py, "three
walls"); AI search sends only readable text to the model.
"""

# No `from __future__ import annotations`: slowapi wraps these routes (see routers/docs_ai.py).
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.routers.pages_ai import sse
from app.services import access, search, search_ai, search_log
from app.utils.net import get_client_ip

router = APIRouter(prefix="/api/v1/search", tags=["search"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _ac(request: Request, db, user: User):
    return (access.actor_from_request(request, user),
            access.Ctx(db, surface="rest", ip=get_client_ip(request)))


def _scope(scope: str | None) -> str | None:
    try:
        return search.parse_scope(scope)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


def _ws_id(value: str | None) -> str | None:
    v = (value or "").strip()
    return v if len(v) == 24 and all(c in "0123456789abcdef" for c in v) else None


@router.get("")
@limiter.limit("240/minute")
async def search_everything(
    request: Request,
    q: str = Query("", max_length=search.MAX_Q),
    scope: str | None = Query(None, max_length=40),
    kind: str | None = Query(None, max_length=80),
    owner: str = Query("anyone", pattern="^(anyone|me)$"),
    updated: str = Query("any", pattern="^(any|week|month)$"),
    current: str | None = Query(None, max_length=40),
    cursor: str | None = Query(None, max_length=200),
    limit: int = Query(20, ge=1, le=search.MAX_LIMIT),
    trash: bool = Query(True),
    sid: str | None = Query(None, max_length=40),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    actor, ctx = _ac(request, db, user)
    try:
        query = search.Query(q=q, scope=_scope(scope), kinds=search.parse_kinds(kind), owner=owner,
                             updated=updated, current=_ws_id(current), offset=search.decode_cursor(cursor),
                             limit=limit, trash=trash)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    out = await search.run(db, actor, ctx, query)
    log_id = None
    ws = query.scope or query.current
    if query.offset == 0 and ws and ws in await _member_ws(db, user.id):
        total = out.get("total")
        try:
            log_id = await search_log.record(db, q=q, ws=ws, sid=sid,
                                             results=total if total is not None else len(out.get("items") or []))
        except Exception:  # logging never fails a search
            log_id = None
    return jsonable_encoder({**out, "log_id": log_id})


async def _member_ws(db: AsyncIOMotorDatabase, user_id: str) -> set[str]:
    """Workspaces the caller is a member of: a search is only logged against one of them."""
    return {m["workspace_id"] async for m in db["memberships"].find({"user_id": user_id}, {"workspace_id": 1})}


class ClickBody(BaseModel):
    log_id: str = Field(..., min_length=1, max_length=40)


@router.post("/click", status_code=204)
@limiter.limit("240/minute")
async def search_click(request: Request, body: ClickBody, db: AsyncIOMotorDatabase = Depends(get_db),
                       user: User = Depends(require_user)):
    """A result was opened from the search ``log_id`` (no content: nothing to learn from it)."""
    from fastapi import Response

    await search_log.clicked(db, body.log_id)
    return Response(status_code=204)


@router.get("/ai-status")
@limiter.limit("120/minute")
async def ai_status(request: Request, scope: str | None = Query(None, max_length=40),
                    db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    return await search_ai.status(db, user.id, _scope(scope))


class AskBody(BaseModel):
    question: str = Field(..., min_length=1, max_length=search_ai.MAX_QUESTION)
    scope: str | None = Field(None, max_length=40)
    current: str | None = Field(None, max_length=40)


@router.post("/ask")
@limiter.limit("30/minute")
async def ask(request: Request, body: AskBody, db: AsyncIOMotorDatabase = Depends(get_db),
              user: User = Depends(require_user)):
    actor, ctx = _ac(request, db, user)
    gen = search_ai.ask(db, actor, ctx, body.question, scope=_scope(body.scope), current=_ws_id(body.current))
    return sse(gen)
