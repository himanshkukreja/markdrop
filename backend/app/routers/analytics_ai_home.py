"""Analytics AI on the analytics home (services/analytics_ai_home.py), under ``/api/v1/me``.

    GET  /api/v1/me/analytics/ai/status                       {enabled, reason, message, model, gap_scopes}
    GET  /api/v1/me/analytics/ai/story?range=7d|30d|90d&fresh= {status, headline, bullets: [{text, href, doc}], ...}
    POST /api/v1/me/analytics/ai/ask   (SSE)  {question, range?, fresh?}
         events: status {stage, label}, delta {text, reset?}, done {answer, links, request_id, usage, cached},
                 limit {reason, message}, error {detail, code}
    GET  /api/v1/me/analytics/ai/gaps?scope=workspace:<id>|personal&fresh=
         {status, scope, label, gaps: [{topic, count, why, outline, examples, markdown}], create: {workspace}}

Signed in (``require_user``), like the analytics home: the story and Ask read only documents the
caller owns. Gaps need the owner or admin role in the workspace (403 otherwise), or the caller's own
personal Guides. Limits come back in the body (``status: "limit"`` / a ``limit`` event), not as an
HTTP error, so the card can say what happened.
"""


from fastapi import APIRouter, Depends, HTTPException, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.routers.pages_ai import sse
from app.services import analytics_ai_home as aah

router = APIRouter(prefix="/api/v1/me/analytics/ai", tags=["analytics-ai"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


@router.get("/status")
@limiter.limit("120/minute")
async def ai_status(request: Request, db: AsyncIOMotorDatabase = Depends(get_db),
                    user: User = Depends(require_user)):
    """Can Analytics AI run for the caller now, and where they may see content gaps."""
    return await aah.status(db, user.id)


@router.get("/story")
@limiter.limit("30/minute")
async def ai_story(request: Request, range: str = Query("7d", pattern="^(7d|30d|90d)$"),
                   fresh: int = Query(0, ge=0, le=1), db: AsyncIOMotorDatabase = Depends(get_db),
                   user: User = Depends(require_user)):
    """What changed in the range and why, in 3-5 bullets (cached for the day; ``fresh=1`` refreshes)."""
    return await aah.story(db, user.id, range, fresh=bool(fresh))


class AskBody(BaseModel):
    question: str = Field(..., min_length=1, max_length=aah.MAX_QUESTION)
    range: str | None = Field(None, pattern="^(7d|30d|90d|all)$")
    fresh: bool = False


@router.post("/ask")
@limiter.limit("20/minute")
async def ai_ask(request: Request, body: AskBody, db: AsyncIOMotorDatabase = Depends(get_db),
                 user: User = Depends(require_user)):
    """Ask your analytics (SSE). The model picks from a fixed set of queries; ours run them."""
    return sse(aah.ask(db, user.id, body.question, range_key=body.range, fresh=body.fresh))


@router.get("/gaps")
@limiter.limit("20/minute")
async def ai_gaps(request: Request, scope: str = Query(..., min_length=1, max_length=80),
                  fresh: int = Query(0, ge=0, le=1), db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    """What people searched for or asked and didn't find, grouped into pages worth writing."""
    try:
        return await aah.gaps(db, user.id, scope, fresh=bool(fresh))
    except aah.Forbidden as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
