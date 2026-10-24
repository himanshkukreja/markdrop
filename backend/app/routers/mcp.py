"""POST /mcp — the Model Context Protocol endpoint (streamable HTTP, JSON only).

Stateless and tools-only, so there is no server-to-client stream: GET (the
optional SSE channel) and DELETE (session teardown) answer 405, which the
transport spec defines as "not offered here".
"""

import json
import re
from urllib.parse import urlsplit

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from app.config import get_settings
from app.mcp import auth as mcp_auth
from app.mcp import protocol

settings = get_settings()
router = APIRouter(tags=["mcp"])

# publish_page accepts up to 25 MB of text, which JSON escaping can grow; nginx
# caps the body at 32 MB before it gets here.
MAX_BODY_BYTES = 32 * 1024 * 1024

# Browsers send Origin; servers (Claude's and ChatGPT's backends, CLIs) don't.
# A browser page can only reach /mcp from these sites, which keeps a malicious
# page from driving the endpoint with a token it got hold of (DNS rebinding of
# a local client, for instance).
_ALLOWED_ORIGINS = frozenset({
    "https://markdrop.in", "https://www.markdrop.in",
    "https://claude.ai", "https://claude.com",
    "https://chatgpt.com", "https://chat.openai.com",
})
_DEV_ORIGIN = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$")


def origin_allowed(origin: str | None) -> bool:
    if origin is None:
        return True
    origin = origin.strip().lower().rstrip("/")
    if origin in _ALLOWED_ORIGINS or _DEV_ORIGIN.match(origin):
        return True
    front = urlsplit(settings.frontend_url)
    return bool(front.scheme and front.netloc) and origin == f"{front.scheme}://{front.netloc}".lower()


def _forbidden_origin() -> JSONResponse:
    return JSONResponse(
        {"jsonrpc": "2.0", "id": None,
         "error": {"code": -32600, "message": "Origin not allowed."}},
        status_code=403,
    )


@router.post("/mcp")
async def mcp_post(request: Request):
    if not origin_allowed(request.headers.get("origin")):
        return _forbidden_origin()
    principal = await mcp_auth.authenticate(request)
    if isinstance(principal, Response):
        return principal

    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        return JSONResponse(
            {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Request too large."}},
            status_code=413,
        )
    body = await request.body()
    if len(body) > MAX_BODY_BYTES:
        return JSONResponse(
            {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Request too large."}},
            status_code=413,
        )
    try:
        message = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return JSONResponse(
            {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}},
            status_code=400,
        )
    reply = await protocol.handle(message, request.headers, principal)
    return reply.to_response()


def _not_offered() -> JSONResponse:
    return JSONResponse(
        {"jsonrpc": "2.0", "id": None,
         "error": {"code": -32600, "message": "Method not allowed: this server answers POST only."}},
        status_code=405,
        headers={"Allow": "POST"},
    )


@router.get("/mcp")
async def mcp_get():
    return _not_offered()


@router.delete("/mcp")
async def mcp_delete():
    return _not_offered()
