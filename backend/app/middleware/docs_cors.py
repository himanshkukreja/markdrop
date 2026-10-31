"""CORS for the docs site (docs.markdrop.in): its own endpoints, and Try it.

docs.markdrop.in is a separate origin from the app, and it never sends cookies.
It calls the API from the browser in two ways:

* Its own endpoints, /api/v1/docs/* (Ask AI, page feedback). The only
  credential they read is an optional Authorization header.
* Try it on the API reference: the reader sends a real request to a documented
  endpoint, anonymously or with an API token they paste in as
  `Authorization: Bearer`. That covers the public API, the routes in the
  OpenAPI schema, minus the ones only markdrop.in's own pages, emails and
  sign-in flows use (DENIED below): admin, sign-in and session flows, email
  links, Google Docs export, the VS Code sync protocol, OAuth consent screens.

Both get CORS for the docs origins only, never `Allow-Credentials`. That is
what keeps this safe: a credentialed request (cookies) from the docs origin
needs `Allow-Credentials: true` on the preflight and the response, so the
browser refuses it, and the markdrop.in session can never be read or used from
here. Without a cookie the request is exactly what curl could send.

Every registered docs site (services/docs_sites.py) gets the same treatment
for its own endpoints: its site.json `url` origin may call /api/v1/docs/*. So
does every live Markdrop Guides site's address (its free address and its own
domains; a set read from MongoDB and cached, see
docs_sites.studio_origin_allowed). Try it stays with docs_cors_origins (the
public API documented there is Markdrop's).

A guide's Insights beacons (/api/v1/docs/insights/<site id>/…) are narrower: only that
guide's own live addresses get CORS there, not every guide's.

Every other path and every other origin passes straight through to the app's
CORS layers unchanged, and an origin the app itself lists (markdrop.in) is never
touched here, so it keeps its credentialed CORS.

Pure ASGI (not BaseHTTPMiddleware) so the Ask AI event stream passes through
unbuffered. Registered outermost, like PublicCORSMiddleware, so it answers the
preflight before CORSMiddleware would refuse an origin it doesn't list.
"""

from __future__ import annotations

import re

from app.config import get_settings

PREFIX = "/api/v1/docs/"
# A guide's Insights beacons (routers/guide_insights.py): only that guide's own live addresses.
_INSIGHTS = re.compile(r"^/api/v1/docs/insights/([0-9a-f]{24})/")
API_PREFIX = "/api/v1/"
_LOCAL = re.compile(r"^http://docs\.localhost(:\d{1,5})?$")
_HEADER_LIST = re.compile(r"^[A-Za-z0-9!#$%&'*+\-.^_`|~,\s]{0,1000}$")
_DEFAULT_HEADERS = "Authorization, Content-Type, Accept, Last-Event-ID, X-Docs-Site"

# Try it: the public API. Spelled out rather than echoed: these are every
# header the documented endpoints read (a test checks it against the schema).
API_ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
API_ALLOW_HEADERS = ", ".join((
    "Authorization", "Content-Type", "Accept", "Accept-Language", "Content-Language",
    "X-Edit-Secret", "X-Read-Password", "X-Markdrop-Workspace", "X-Markdrop-Path",
))
# Readable by the docs page, so Try it can show them.
API_EXPOSE_HEADERS = ", ".join((
    "Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset",
    "X-Markdrop-Gate", "X-Markdrop-Moved", "WWW-Authenticate", "Location", "ETag",
    "Content-Disposition", "Content-Length",
))

# Never open to the docs origin, whatever the schema says. A prefix ending in
# "/" covers everything under it; anything else is the path itself plus
# everything under it.
DENIED = (
    "/api/v1/admin/",
    "/api/v1/auth/",          # sign-in, sign-out, email links, tenant-token (but see ALLOWED_EXTRA)
    "/api/v1/email/",
    "/api/v1/google/",        # Google Docs export: OAuth redirects
    "/api/v1/sync",           # the VS Code extension's sync protocol
    "/api/v1/oauth/",         # the MCP consent screen
    "/api/v1/me/digest/",     # the digest's unsubscribe link
    "/api/v1/unsubscribe",
    "/api/v1/beat",
    "/api/v1/host",
    "/api/v1/share/",         # P2P share signalling
    PREFIX,                   # the docs endpoints have their own rules above
)
# Documented under /api/v1/auth/ and usable with an API token.
ALLOWED_EXTRA = frozenset({"/api/v1/auth/me"})


def origin_allowed(origin: str | None) -> bool:
    if not origin:
        return False
    if _LOCAL.match(origin):
        return True
    return origin.rstrip("/") in {o.rstrip("/") for o in get_settings().docs_cors_origins}


def docs_origin_allowed(origin: str | None) -> bool:
    """For /api/v1/docs/*: the docs origins above, or any registered site's own origin."""
    if origin_allowed(origin):
        return True
    if not origin:
        return False
    from app.services import docs_sites

    return origin.rstrip("/").lower() in docs_sites.origins()


async def docs_origin_allowed_async(origin: str | None) -> bool:
    """docs_origin_allowed, or a live Markdrop Guides site's address."""
    if docs_origin_allowed(origin):
        return True
    if not origin:
        return False
    from app.services import docs_sites

    return await docs_sites.studio_origin_allowed(origin)


async def insights_origin_allowed(site_id: str, origin: str | None) -> bool:
    """For a guide's Insights beacons: that guide's own live https addresses, nothing else."""
    if not origin:
        return False
    try:
        from app.database import get_database
        from app.services import guide_insights

        return await guide_insights.origin_allowed(get_database(), site_id, origin)
    except Exception:
        return False


def _denied(path: str) -> bool:
    if path in ALLOWED_EXTRA:
        return False
    for p in DENIED:
        if p.endswith("/"):
            if path.startswith(p):
                return True
        elif path == p or path.startswith(p + "/") or path.startswith(p + "?"):
            return True
    return False


# Path regexes of the routes in the public OpenAPI schema, per app (built once).
_schema_routes: dict[int, list[re.Pattern]] = {}


def _routes_for(app) -> list[re.Pattern]:
    key = id(app)
    hit = _schema_routes.get(key)
    if hit is None:
        hit = []
        for r in getattr(app, "routes", None) or []:
            regex = getattr(r, "path_regex", None)
            path = getattr(r, "path", "")
            if regex is None or not getattr(r, "include_in_schema", False) or not getattr(r, "methods", None):
                continue
            if not path.startswith(API_PREFIX) or _denied(path):
                continue
            hit.append(regex)
        _schema_routes[key] = hit
    return hit


def is_public_api_path(path: str, app) -> bool:
    """A documented, public /api/v1 route: in the OpenAPI schema and not internal."""
    if not path.startswith(API_PREFIX) or _denied(path):
        return False
    return any(rx.match(path) for rx in _routes_for(app))


def _merge_vary(headers: list[tuple[bytes, bytes]], *names: str) -> list[tuple[bytes, bytes]]:
    have: list[str] = []
    out = []
    for k, v in headers:
        if k.lower() == b"vary":
            have += [x.strip() for x in v.decode("latin-1").split(",") if x.strip()]
        else:
            out.append((k, v))
    for n in names:
        if n.lower() not in {h.lower() for h in have}:
            have.append(n)
    out.append((b"vary", ", ".join(have).encode("latin-1")))
    return out


class DocsCORSMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        if path.startswith(PREFIX):
            return await self._docs(scope, receive, send)
        if path.startswith(API_PREFIX):
            return await self._api(scope, receive, send)
        return await self.app(scope, receive, send)

    # ── /api/v1/docs/* ────────────────────────────────────────────────────────
    async def _docs(self, scope, receive, send):
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers") or []}
        origin = headers.get("origin")
        own = _INSIGHTS.match(scope.get("path", ""))
        allowed = await insights_origin_allowed(own.group(1), origin) if own else await docs_origin_allowed_async(origin)
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

    # ── Try it: the public /api/v1 routes ────────────────────────────────────
    async def _api(self, scope, receive, send):
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers") or []}
        origin = headers.get("origin")
        if (not origin_allowed(origin)
                or origin in get_settings().cors_origins
                or not is_public_api_path(scope.get("path", ""), scope.get("app") or self.app)):
            return await self.app(scope, receive, send)

        if scope["method"] == "OPTIONS" and headers.get("access-control-request-method"):
            out = [
                (b"access-control-allow-origin", origin.encode("latin-1")),
                (b"access-control-allow-methods", API_ALLOW_METHODS.encode("latin-1")),
                (b"access-control-allow-headers", API_ALLOW_HEADERS.encode("latin-1")),
                (b"access-control-max-age", b"7200"),
                (b"vary", b"Origin"),
                (b"content-length", b"0"),
            ]
            await send({"type": "http.response.start", "status": 204, "headers": out})
            await send({"type": "http.response.body", "body": b""})
            return

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                # Drop whatever the inner CORS layer said (it emits Allow-Credentials
                # and its own expose list even for an origin it refuses) and say ours.
                hdrs = [(k, v) for k, v in message.get("headers", [])
                        if not k.lower().startswith(b"access-control-")]
                hdrs.append((b"access-control-allow-origin", origin.encode("latin-1")))
                hdrs.append((b"access-control-expose-headers", API_EXPOSE_HEADERS.encode("latin-1")))
                message = {**message, "headers": _merge_vary(hdrs, "Origin")}
            await send(message)

        return await self.app(scope, receive, send_wrapper)
