"""Client-IP resolution behind the nginx reverse proxy.

nginx sets `X-Real-IP` to the true peer address ($remote_addr) and appends it
to `X-Forwarded-For`. We trust X-Real-IP first (single trusted proxy hop);
without a proxy (local dev) we fall back to the socket peer.

Used both for rate limiting (slowapi key) and analytics geo lookups.
"""

from fastapi import Request
from starlette.requests import Request as StarletteRequest


def get_client_ip(request: Request | StarletteRequest) -> str:
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()

    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        # nginx appends the real peer last; take the last hop.
        return forwarded.split(",")[-1].strip()

    return request.client.host if request.client else "unknown"


# ── Rate-limit key: the account when signed in, else the address ─────────────
#
# Per-IP limits treat an office behind one NAT address as one visitor: four colleagues editing pages at
# once shared one "60/minute" save budget and one beacon budget, and the app answered 429 to all of them
# ("if 3-4 users come together, everything gets blocked"). A request carrying a *valid* session JWT is
# limited per account instead. Only a verified token counts — an unverifiable one (anyone can invent a
# Bearer string) falls back to the address, so per-IP protection against anonymous floods is unchanged.
# API tokens (mdk_…) need a database lookup to verify, so they stay per address here.

_KEY_CACHE: dict[str, tuple[str, float]] = {}
_KEY_CACHE_MAX = 4096


def _account_key(token: str) -> str | None:
    import time

    hit = _KEY_CACHE.get(token)
    now = time.time()
    if hit is not None:
        key, exp = hit
        if exp > now:
            return key
        _KEY_CACHE.pop(token, None)
        return None
    if token.count(".") != 2 or len(token) > 4096:
        return None
    import jwt

    from app.utils.auth import decode_access_token

    try:
        payload = decode_access_token(token)
    except jwt.InvalidTokenError:
        return None
    sub = payload.get("sub")
    if not isinstance(sub, str) or not sub:
        return None
    key = f"user:{sub}"
    if len(_KEY_CACHE) >= _KEY_CACHE_MAX:
        _KEY_CACHE.clear()
    _KEY_CACHE[token] = (key, float(payload.get("exp") or now + 60))
    return key


def rate_limit_key(request: Request | StarletteRequest) -> str:
    """slowapi's key: ``user:<id>`` for a request with a valid session token, else the client IP."""
    auth = request.headers.get("authorization") or ""
    if auth[:7].lower() == "bearer ":
        key = _account_key(auth[7:].strip())
        if key:
            return key
    return get_client_ip(request)
