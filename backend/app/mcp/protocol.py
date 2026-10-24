"""JSON-RPC dispatch for /mcp, in both protocol eras.

**Handshake era** (2024-11-05 … 2025-11-25; what Claude and ChatGPT speak
today): `initialize` negotiates a version, `notifications/initialized` follows,
then ordinary requests. The server keeps no session: it mints no
`Mcp-Session-Id` and ignores one if sent, because nothing about a request
depends on an earlier one.

**Envelope era** (2026-07-28): there is no handshake. Every request carries
`params._meta["io.modelcontextprotocol/protocolVersion"]` (plus the client's
capabilities) and repeats its version, method and tool name in the
`MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers so intermediaries
can route on them; the body and headers must agree. Results carry
`resultType`, and list results say how long they may be cached.

Errors that mean the request itself was malformed are JSON-RPC errors (with an
HTTP status in the envelope era); anything that went wrong *running* a tool is a
tool result with `isError: true`, so the model can read it and adapt.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from fastapi.responses import JSONResponse

from app.config import get_settings
from app.database import get_database
from app.mcp import schema, tools
from app.mcp.auth import Principal, insufficient_scope

settings = get_settings()
log = logging.getLogger(__name__)

HANDSHAKE_VERSIONS = ("2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25")
MODERN_VERSIONS = ("2026-07-28",)
ALL_VERSIONS = (*HANDSHAKE_VERSIONS, *MODERN_VERSIONS)
LATEST_HANDSHAKE = "2025-11-25"

PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion"
CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities"
SERVER_INFO_META = "io.modelcontextprotocol/serverInfo"

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
HEADER_MISMATCH = -32020
UNSUPPORTED_PROTOCOL_VERSION = -32022

SERVER_INFO = {"name": "markdrop", "title": "Markdrop", "version": "1.0.0"}
CAPABILITIES = {"tools": {"listChanged": False}}
INSTRUCTIONS = (
    "Markdrop turns markdown and files into links that open rendered in any browser. "
    "Use publish_document for markdown (notes, reports, docs, AI write-ups) and publish_page "
    "for a complete HTML page or a text file (csv, json, svg). Always give the user the returned "
    "link. Documents are public to anyone with the link unless access is set to private or "
    "password. Never publish secrets or personal data unless the user asked."
)
# How long a client may reuse discovery and list results (envelope era).
LIST_TTL_MS = 5 * 60 * 1000
_B64_SENTINEL = re.compile(r"^=\?base64\?(?P<payload>.*)\?=$")


@dataclass
class Reply:
    status: int
    body: dict | None = None
    headers: dict[str, str] = field(default_factory=dict)
    raw_response: JSONResponse | None = None  # e.g. a 403 scope challenge

    def to_response(self):
        from fastapi import Response

        if self.raw_response is not None:
            return self.raw_response
        if self.body is None:
            return Response(status_code=self.status, headers=self.headers)
        return JSONResponse(self.body, status_code=self.status, headers=self.headers)


def _error(status: int, request_id: Any, code: int, message: str, data: Any = None) -> Reply:
    err: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return Reply(status, {"jsonrpc": "2.0", "id": request_id, "error": err})


def _result(request_id: Any, result: dict) -> Reply:
    return Reply(200, {"jsonrpc": "2.0", "id": request_id, "result": result})


def decode_header_value(value: str | None) -> str | None:
    """`Mcp-Name` and friends may arrive as =?base64?…?= when the value isn't
    a plain header token. A malformed wrapper decodes to None (never a match)."""
    if value is None:
        return None
    m = _B64_SENTINEL.fullmatch(value)
    if m is None:
        return value
    payload = m.group("payload")
    try:
        decoded = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        return None
    if base64.b64encode(decoded).decode("ascii") != payload:
        return None
    try:
        return decoded.decode("utf-8")
    except UnicodeDecodeError:
        return None


def _unsupported_version(request_id: Any, requested: Any) -> Reply:
    return _error(400, request_id, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version",
                  {"supported": list(ALL_VERSIONS), "requested": requested})


# ── Entry point ───────────────────────────────────────────────────────────────


async def handle(message: Any, headers, principal: Principal) -> Reply:
    """Answer one decoded JSON-RPC message. `headers` is the request's
    Starlette Headers (case-insensitive, duplicates preserved)."""
    if isinstance(message, list):
        return _error(400, None, INVALID_REQUEST, "Batch requests are not supported.")
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        return _error(400, None, INVALID_REQUEST, "Expected a JSON-RPC 2.0 message.")

    if "method" not in message:
        # A client's response to a server request. This server never sends
        # requests, so there is nothing to match it with; accept and move on.
        if "id" in message and ("result" in message or "error" in message):
            return Reply(202)
        return _error(400, message.get("id"), INVALID_REQUEST, "Expected a request or notification.")

    method = message.get("method")
    if not isinstance(method, str):
        return _error(400, message.get("id"), INVALID_REQUEST, "method must be a string.")
    if "id" not in message:
        return Reply(202)  # notification: initialized, cancelled, progress …
    request_id = message["id"]
    if isinstance(request_id, bool) or not isinstance(request_id, (str, int)):
        return _error(400, None, INVALID_REQUEST, "id must be a string or an integer.")
    params = message.get("params")
    if params is not None and not isinstance(params, dict):
        return _error(400, request_id, INVALID_PARAMS, "params must be an object.")
    params = params or {}

    meta = params.get("_meta")
    if isinstance(meta, dict) and PROTOCOL_VERSION_META in meta:
        return await _modern(request_id, method, params, meta, headers, principal)
    return await _handshake(request_id, method, params, headers, principal)


# ── Handshake era ─────────────────────────────────────────────────────────────


async def _handshake(request_id, method: str, params: dict, headers, principal: Principal) -> Reply:
    version_header = headers.get("mcp-protocol-version")
    if method != "initialize" and version_header is not None and version_header not in ALL_VERSIONS:
        return _unsupported_version(request_id, version_header)

    if method == "initialize":
        requested = params.get("protocolVersion")
        version = requested if requested in HANDSHAKE_VERSIONS else LATEST_HANDSHAKE
        return _result(request_id, {
            "protocolVersion": version,
            "capabilities": CAPABILITIES,
            "serverInfo": SERVER_INFO,
            "instructions": INSTRUCTIONS,
        })
    if method == "ping":
        return _result(request_id, {})
    if method == "tools/list":
        return _result(request_id, {"tools": [t.listing() for t in tools.TOOLS]})
    if method == "tools/call":
        return await _call_tool(request_id, params, principal, modern=False)
    if method == "resources/list":
        return _result(request_id, {"resources": []})
    if method == "resources/templates/list":
        return _result(request_id, {"resourceTemplates": []})
    if method == "prompts/list":
        return _result(request_id, {"prompts": []})
    return _error(200, request_id, METHOD_NOT_FOUND, f"Method not found: {method[:80]}")


# ── Envelope era ──────────────────────────────────────────────────────────────


def _cacheable(result: dict) -> dict:
    return {**result, "resultType": "complete", "cacheScope": "public", "ttlMs": LIST_TTL_MS}


async def _modern(request_id, method: str, params: dict, meta: dict, headers, principal: Principal) -> Reply:
    if CLIENT_CAPABILITIES_META not in meta:
        return _error(400, request_id, INVALID_PARAMS,
                      f"params._meta is missing the required envelope key: {CLIENT_CAPABILITIES_META}")
    for name in ("mcp-protocol-version", "mcp-method", "mcp-name"):
        if len(headers.getlist(name)) > 1:
            return _error(400, request_id, HEADER_MISMATCH, f"The {name} header was sent more than once.")
    version = meta[PROTOCOL_VERSION_META]
    version_header = headers.get("mcp-protocol-version")
    if version_header is None or version_header != version:
        return _error(400, request_id, HEADER_MISMATCH,
                      "MCP-Protocol-Version header does not match the request envelope's protocol version")
    if headers.get("mcp-method") != method:
        return _error(400, request_id, HEADER_MISMATCH,
                      "Mcp-Method header does not match the request body's method")
    if method == "tools/call":
        name = params.get("name")
        if name is not None and decode_header_value(headers.get("mcp-name")) != name:
            return _error(400, request_id, HEADER_MISMATCH,
                          "Mcp-Name header does not match the request body's 'name' parameter")
    if not isinstance(version, str):
        return _error(400, request_id, INVALID_PARAMS, "The protocol-version envelope value must be a string.")
    if version not in MODERN_VERSIONS:
        return _unsupported_version(request_id, version)

    if method == "server/discover":
        return _result(request_id, _cacheable({
            "supportedVersions": list(ALL_VERSIONS),
            "capabilities": CAPABILITIES,
            "instructions": INSTRUCTIONS,
            "_meta": {SERVER_INFO_META: SERVER_INFO},
        }))
    if method == "tools/list":
        return _result(request_id, _cacheable({"tools": [t.listing() for t in tools.TOOLS]}))
    if method == "tools/call":
        return await _call_tool(request_id, params, principal, modern=True)
    if method == "resources/list":
        return _result(request_id, _cacheable({"resources": []}))
    if method == "prompts/list":
        return _result(request_id, _cacheable({"prompts": []}))
    if method == "ping":
        return _result(request_id, {"resultType": "complete"})
    return _error(404, request_id, METHOD_NOT_FOUND, f"Method not found: {method[:80]}")


# ── tools/call ────────────────────────────────────────────────────────────────


def _tool_result(text: str, structured: dict | None, is_error: bool, modern: bool) -> dict:
    result: dict[str, Any] = {"content": [{"type": "text", "text": text}], "isError": is_error}
    if structured is not None:
        result["structuredContent"] = structured
    if modern:
        result["resultType"] = "complete"
    return result


def _rate_limited(principal: Principal, writes: bool) -> bool:
    """Per-user ceiling on tool calls (slowapi's storage, so Redis-backed and
    shared with the rest of the API's limits). Fails open: a limiter outage
    shouldn't take the whole server down with it."""
    try:
        from limits import parse

        from app.limiter import limiter

        item = parse(settings.mcp_write_rate_limit if writes else settings.mcp_read_rate_limit)
        return not limiter.limiter.hit(item, "mcp", "write" if writes else "read", principal.user.id)
    except Exception:  # pragma: no cover - depends on the limiter backend
        log.warning("MCP rate limiter unavailable", exc_info=True)
        return False


async def _call_tool(request_id, params: dict, principal: Principal, *, modern: bool) -> Reply:
    name = params.get("name")
    tool = tools.BY_NAME.get(name) if isinstance(name, str) else None
    if tool is None:
        return _error(200 if not modern else 400, request_id, INVALID_PARAMS,
                      f"Unknown tool: {str(name)[:80]}")
    if not principal.has(tool.scope):
        return Reply(403, raw_response=insufficient_scope(tool.scope, request_id))

    started = time.monotonic()
    args = params.get("arguments")
    if args is None:
        args = {}
    ok = False
    try:
        if not isinstance(args, dict):
            raise tools.ToolError("arguments must be an object.")
        problem = schema.validate(tool.input_schema, args)
        if problem:
            raise tools.ToolError(problem)
        if _rate_limited(principal, tool.writes):
            raise tools.ToolError(
                "Too many requests in a short time. Wait a minute before trying again."
            )
        ctx = tools.Context(db=get_database(), user=principal.user,
                            client_id=principal.client_id, scopes=principal.scopes)
        text, structured = await tool.handler(ctx, args)
        ok = True
        result = _tool_result(text, structured, False, modern)
    except tools.ToolError as exc:
        result = _tool_result(str(exc), None, True, modern)
    except Exception:
        log.exception("MCP tool %s failed", tool.name)
        result = _tool_result("Something went wrong on Markdrop's side. Try again in a moment.",
                              None, True, modern)
    await _audit(principal, tool.name, ok, int((time.monotonic() - started) * 1000))
    return _result(request_id, result)


async def _audit(principal: Principal, tool_name: str, ok: bool, ms: int) -> None:
    """One row per call: who, through which app, which tool, whether it
    worked and how long it took. Never arguments or content."""
    now = datetime.now(timezone.utc)
    db = get_database()
    try:
        await db["mcp_events"].insert_one({
            "user_id": principal.user.id,
            "client_id": principal.client_id,
            "tool": tool_name,
            "ok": ok,
            "ms": ms,
            "ts": now,
        })
        # Adoption in the admin Analytics tab. A per-user pseudonymous visitor id
        # so "visitors" counts people, not calls; no slug or document anywhere.
        vid = "mcp-" + hashlib.sha256(f"{settings.ip_hash_salt}:{principal.user.id}".encode()).hexdigest()[:16]
        await db["traffic_events"].insert_one({
            "sid": None,
            "vid": vid,
            "name": "mcp_tool",
            "path": None,
            "props": {"tool": tool_name, "ok": ok},
            "ts": now,
            "channel": "AI assistants",
            "signed_in": True,
        })
    except Exception:  # pragma: no cover - auditing must never fail a call
        log.warning("MCP audit write failed", exc_info=True)
