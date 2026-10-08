"""Ingest for first-party site analytics (see services/traffic.py).

Named /beat rather than /collect or /track: ad-blocker lists match those
names, and a blocked beacon doesn't fail loudly — it just quietly removes a
large, skewed slice of visitors from every number we look at.
"""

import json
import logging

from fastapi import APIRouter, Request

from app.database import get_database
from app.limiter import limiter
from app.routers.auth import optional_user
from app.routers.documents import _is_bot
from app.services import traffic
from app.utils.net import get_client_ip

router = APIRouter(prefix="/api/v1", tags=["analytics"])
log = logging.getLogger(__name__)

MAX_BODY = 16 * 1024


@router.post("/beat", status_code=204)
@limiter.limit("120/minute")
async def beat(request: Request) -> None:
    ua = request.headers.get("user-agent") or ""
    if _is_bot(ua):
        return
    raw = await request.body()
    if len(raw) > MAX_BODY:
        return
    try:
        body = json.loads(raw)
    except ValueError:
        return
    if not isinstance(body, dict):
        return
    try:
        user = await optional_user(request)
    except Exception:
        user = None  # a token scoped elsewhere is simply not an identity here
    try:
        await traffic.ingest(
            get_database(),
            body,
            ip=get_client_ip(request),
            user_agent=ua,
            user_id=user.id if user else None,
        )
    except Exception:
        # Never surface to a visitor — but never vanish either: a silently
        # failing ingest is a dashboard that quietly undercounts.
        log.warning("beat ingest failed", exc_info=True)
