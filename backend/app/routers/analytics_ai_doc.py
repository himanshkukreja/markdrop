"""Analytics AI for one document (services/analytics_ai_doc.py), under ``/api/v1/me``.

    GET  /documents/{slug}/analytics/ai/{kind}?range&internal&ver    the cached analysis (no model call)
    POST /documents/{slug}/analytics/ai/{kind}?range&internal&ver    analyse; body {"refresh": true} re-analyses

``kind`` is content | media | pages | versions. Access is the analytics one exactly
(``access.require(..., "view_stats")``, as routers/creator_analytics._owned_doc). Both answer
``{kind, state, result, stale, generated_at, sample:{have, need}, note, limit, can_apply, kinds}``
with ``state`` ready | empty | thin | encrypted | unsupported. A limit is
``{detail, code: "limit", type: "limit", reason}`` (429 for the spend limits, 503 when AI is off
or not set up, 403 when the workspace has AI off or the account is blocked); a failed or
unusable answer is 502 ``{detail, code}``.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Path, Query, Request
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.routers.creator_analytics import RANGE, _owned_doc
from app.services import access
from app.services import analytics_ai_doc as aid
from app.services.pages_ai import AIError

KIND = "^(content|media|pages|versions)$"


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


router = APIRouter(prefix="/api/v1/me", tags=["creator-analytics"], route_class=AIRoute)


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


@router.get("/documents/{slug}/analytics/ai/{kind}")
@limiter.limit("120/minute")
async def analytics_ai_get(
    request: Request, slug: str,
    kind: str = Path(..., pattern=KIND),
    range: str = Query("30d", pattern=RANGE),
    internal: int = Query(0, ge=0, le=1),
    ver: int | None = Query(None, ge=1, le=100_000),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """The cached analysis of this kind, or whether one can be made (never calls the model)."""
    raw = await _owned_doc(request, db, slug, user)
    return await aid.analysis(db, raw, kind, range_key=range, internal=bool(internal), ver=ver, user=user,
                              actor=access.actor_from_request(request, user))


@router.post("/documents/{slug}/analytics/ai/{kind}")
@limiter.limit("20/minute")
async def analytics_ai_run(
    request: Request, slug: str,
    kind: str = Path(..., pattern=KIND),
    range: str = Query("30d", pattern=RANGE),
    internal: int = Query(0, ge=0, le=1),
    ver: int | None = Query(None, ge=1, le=100_000),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Analyse with AI unless a cached analysis exists; ``{"refresh": true}`` in the
    body re-analyses. Below 20 sessions with data the model isn't called (``state: thin``)."""
    raw = await _owned_doc(request, db, slug, user)
    refresh = False
    try:
        body = await request.json()
        refresh = isinstance(body, dict) and body.get("refresh") is True
    except Exception:
        pass   # no body: a first analysis
    return await aid.analysis(db, raw, kind, range_key=range, internal=bool(internal), ver=ver, user=user,
                              actor=access.actor_from_request(request, user), run=True, refresh=refresh)
