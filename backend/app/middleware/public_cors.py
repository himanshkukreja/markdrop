"""CORS for the public OAuth and MCP endpoints.

The API's normal CORS (main.py, plus TenantCORS for custom domains) allows a
fixed set of origins *with credentials*. The MCP endpoint and the OAuth
discovery, token, registration and revocation endpoints are different: any
site may call them (browser-based MCP inspectors, web clients), and none of
them use cookies, so they answer every origin with `*` and never with
`Allow-Credentials`. Bearer tokens travel in the Authorization header, which
CORS without credentials still permits once it is named in the preflight.

Only these paths are touched. Everything else passes straight through to the
existing middleware, unchanged. Registered outside TenantCORS and CORS so that
it sees the preflight first (CORSMiddleware answers preflights itself).

/mcp additionally refuses browsers from origins that aren't on its allow-list
(routers/mcp.py); the preflight says so up front.
"""

from __future__ import annotations

import re

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

_EXACT = frozenset({"/mcp", "/oauth/token", "/oauth/register", "/oauth/revoke"})
_PREFIXES = ("/.well-known/",)
_DEFAULT_HEADERS = (
    "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, "
    "Mcp-Session-Id, Last-Event-ID"
)
# What a preflight may ask for: header names only (RFC 9110 tokens), bounded.
_HEADER_LIST = re.compile(r"^[A-Za-z0-9!#$%&'*+\-.^_`|~,\s]{0,1000}$")
EXPOSE = "WWW-Authenticate, Mcp-Session-Id"


def is_public_path(path: str) -> bool:
    return path in _EXACT or path.startswith(_PREFIXES)


def _apply(response: Response) -> None:
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Expose-Headers"] = EXPOSE
    if "access-control-allow-credentials" in response.headers:
        del response.headers["access-control-allow-credentials"]


class PublicCORSMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if not is_public_path(path):
            return await call_next(request)

        origin = request.headers.get("origin")
        if request.method == "OPTIONS" and origin and request.headers.get("access-control-request-method"):
            if path == "/mcp":
                from app.routers.mcp import origin_allowed

                if not origin_allowed(origin):
                    return Response(status_code=403)
            asked = request.headers.get("access-control-request-headers") or ""
            allow_headers = asked if asked and _HEADER_LIST.match(asked) else _DEFAULT_HEADERS
            response = Response(status_code=204)
            _apply(response)
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = allow_headers
            response.headers["Access-Control-Max-Age"] = "7200"
            response.headers["Vary"] = "Access-Control-Request-Headers"
            return response

        response = await call_next(request)
        # Unconditional: the value never varies by origin, so a cached copy
        # is right for every caller.
        _apply(response)
        return response
