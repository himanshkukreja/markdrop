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
