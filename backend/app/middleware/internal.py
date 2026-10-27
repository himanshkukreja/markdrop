"""Server-to-server requests from the frontend's own renderer.

Tenant pages (a workspace's own domain) render on the frontend's servers, so
every reader of every custom domain reaches this API from the same few Vercel
egress addresses. Per-IP rate limits then count them as one visitor: a busy
custom domain answered 429 to everybody, and the page turned that into a 404.

The frontend signs those requests with a secret it shares with this API
(`MARKDROP_INTERNAL_SECRET`), and a request carrying a valid signature skips the
per-IP limits. Nothing else changes: it is still anonymous (no user, no
credential), so it reads exactly what any anonymous visitor could.

Header: ``X-Markdrop-Internal: v1.<bucket>.<hex hmac>`` where ``bucket`` is the
10-minute window (unix time // 600) and the HMAC-SHA256 is over
``markdrop-internal.v1.<bucket>``. A window rather than a timestamp because the
header is part of Next's fetch-cache key: a per-request value would defeat the
data cache the tenant pages rely on. The previous and next windows are accepted
for clock skew.
"""

from __future__ import annotations

import hashlib
import hmac
import time

from starlette.types import ASGIApp, Receive, Scope, Send

from app.config import get_settings

settings = get_settings()

HEADER = b"x-markdrop-internal"
WINDOW_SECONDS = 600


def sign(bucket: int, secret: str) -> str:
    mac = hmac.new(secret.encode(), f"markdrop-internal.v1.{bucket}".encode(), hashlib.sha256)
    return f"v1.{bucket}.{mac.hexdigest()}"


def is_valid(value: str | None, secret: str | None = None, now: float | None = None) -> bool:
    secret = settings.internal_secret if secret is None else secret
    if not secret or not value or len(value) > 120:
        return False
    parts = value.split(".")
    if len(parts) != 3 or parts[0] != "v1" or not parts[1].isdigit():
        return False
    bucket = int(parts[1])
    current = int((time.time() if now is None else now) // WINDOW_SECONDS)
    if abs(bucket - current) > 1:
        return False
    return hmac.compare_digest(sign(bucket, secret), value)


class InternalRequestMiddleware:
    """Marks a validly signed request as internal and exempts it from slowapi.

    Pure ASGI (it only touches scope state). Must sit outside SlowAPIMiddleware
    so the flag is set before any limit is checked; the route decorators read
    the same flag (`_rate_limiting_complete`) and skip their check too.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and settings.internal_secret:
            value = None
            for k, v in scope.get("headers") or ():
                if k == HEADER:
                    value = v.decode("latin-1")
                    break
            if value is not None and is_valid(value):
                state = scope.setdefault("state", {})
                state["markdrop_internal"] = True
                # slowapi: skip every limit check for this request, and give its
                # header injection the "no limit applied" value it expects.
                state["_rate_limiting_complete"] = True
                state["view_rate_limit"] = None
        await self.app(scope, receive, send)
