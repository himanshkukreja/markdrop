"""CORS for the docs site's own endpoints (/api/v1/docs/*).

docs.markdrop.in is a separate origin from the app. It calls Ask AI and the
page-feedback widget from the browser, without cookies: the only credential
those routes read is an optional Authorization header. So the docs origins get
CORS on these paths only, never `Allow-Credentials`, and every other path
passes straight through to the app's CORS layers unchanged.

Pure ASGI (not BaseHTTPMiddleware) so the Ask AI event stream passes through
unbuffered. Registered outermost, like PublicCORSMiddleware, so it answers the
preflight before CORSMiddleware would refuse an origin it doesn't list.
"""

from __future__ import annotations

import re

from app.config import get_settings

PREFIX = "/api/v1/docs/"
_LOCAL = re.compile(r"^http://docs\.localhost(:\d{1,5})?$")
_HEADER_LIST = re.compile(r"^[A-Za-z0-9!#$%&'*+\-.^_`|~,\s]{0,1000}$")
_DEFAULT_HEADERS = "Authorization, Content-Type, Accept, Last-Event-ID"


def origin_allowed(origin: str | None) -> bool:
    if not origin:
        return False
    if _LOCAL.match(origin):
        return True
    return origin.rstrip("/") in {o.rstrip("/") for o in get_settings().docs_cors_origins}


class DocsCORSMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope.get("path", "").startswith(PREFIX):
            return await self.app(scope, receive, send)
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers") or []}
        origin = headers.get("origin")
        allowed = origin_allowed(origin)
        if scope["method"] == "OPTIONS" and origin and headers.get("access-control-request-method"):
            if not allowed:
                return await self.app(scope, receive, send)
            asked = headers.get("access-control-request-headers") or ""
            allow_headers = asked if asked and _HEADER_LIST.match(asked) else _DEFAULT_HEADERS
            out = [
                (b"access-control-allow-origin", origin.encode("latin-1")),
                (b"access-control-allow-methods", b"POST, GET, OPTIONS"),
                (b"access-control-allow-headers", allow_headers.encode("latin-1")),
                (b"access-control-max-age", b"7200"),
                (b"vary", b"Origin, Access-Control-Request-Headers"),
                (b"content-length", b"0"),
            ]
            await send({"type": "http.response.start", "status": 204, "headers": out})
            await send({"type": "http.response.body", "body": b""})
            return
        if not allowed:
            return await self.app(scope, receive, send)

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                hdrs = [(k, v) for k, v in message.get("headers", [])
                        if k.lower() not in (b"access-control-allow-origin", b"access-control-allow-credentials")]
                hdrs.append((b"access-control-allow-origin", origin.encode("latin-1")))
                hdrs.append((b"access-control-expose-headers", b"Retry-After"))
                if not any(k.lower() == b"vary" for k, _ in hdrs):
                    hdrs.append((b"vary", b"Origin"))
                message = {**message, "headers": hdrs}
            await send(message)

        return await self.app(scope, receive, send_wrapper)
