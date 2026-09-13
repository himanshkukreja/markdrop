"""CORS for verified custom domains.

`CORSMiddleware` takes a fixed list of origins, which is fine while every
browser talks to us from markdrop.in. The moment a workspace serves documents
from its own host, every browser-side call it makes — the view beacon, the
password unlock, an edit, the session check that decides whether a viewer sees
the exit control — comes from an origin that list has never heard of, and the
browser blocks all of them.

The allowed set is therefore dynamic: the static config, plus any host currently
holding a *verified* domain. Verified matters. An unverified row means someone
typed a hostname, not that they control it, and echoing an arbitrary origin back
alongside `allow-credentials` would let any site read authenticated responses.

Lookups are cached for a minute. This sits on the preflight path for every
custom-domain request, and the set of verified domains changes about as often as
someone buys one.
"""

import time

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app.config import get_settings
from app.database import get_database

settings = get_settings()

_CACHE_TTL_SECONDS = 60
_cache: dict[str, tuple[bool, float]] = {}


async def _is_verified_origin(origin: str) -> bool:
    """Whether this Origin belongs to a verified custom domain."""
    now = time.monotonic()
    hit = _cache.get(origin)
    if hit is not None and hit[1] > now:
        return hit[0]

    allowed = False
    # A bare scheme + host only. An Origin carrying a path or credentials is
    # malformed and not worth matching against anything.
    if origin.startswith(("https://", "http://")):
        rest = origin.split("://", 1)[1]
        if "/" not in rest and "@" not in rest:
            host = rest.split(":")[0].lower()
            try:
                found = await get_database()["domains"].find_one(
                    {"host": host, "status": "verified"}, {"_id": 1}
                )
                allowed = found is not None
            except Exception:
                # A database blip must not silently widen CORS.
                allowed = False

    _cache[origin] = (allowed, now + _CACHE_TTL_SECONDS)
    return allowed


def _apply(response: Response, origin: str) -> None:
    response.headers["Access-Control-Allow-Origin"] = origin
    response.headers["Access-Control-Allow-Credentials"] = "true"
    response.headers["Access-Control-Allow-Methods"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "*"
    # Without this a shared cache could hand one origin's CORS headers to another.
    response.headers["Vary"] = "Origin"


class TenantCORSMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        origin = request.headers.get("origin")

        # Statically configured origins are already handled by CORSMiddleware.
        # Doing it twice emits duplicate headers, which browsers reject outright.
        if not origin or origin in settings.cors_origins:
            return await call_next(request)

        if not await _is_verified_origin(origin):
            return await call_next(request)

        if request.method == "OPTIONS":
            # Answer the preflight here — the route itself has no OPTIONS handler.
            response = Response(status_code=200)
            _apply(response, origin)
            response.headers["Access-Control-Max-Age"] = "600"
            return response

        response = await call_next(request)
        _apply(response, origin)
        return response
