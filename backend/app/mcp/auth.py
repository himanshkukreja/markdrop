"""Who is calling /mcp, and what their token allows.

Only OAuth access tokens minted for this MCP resource are accepted. A
markdrop.in session JWT, a tenant token or an `mdk_` API token is refused
outright, never downgraded: those carry the whole account, while an MCP token
carries only the scopes its user approved for one app.
"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlsplit

from fastapi import Request
from fastapi.responses import JSONResponse

from app.database import get_database
from app.models.user import User
from app.services import oauth_server
from app.services import user as user_service

READ = "documents:read"
WRITE = "documents:write"


@dataclass
class Principal:
    user: User
    client_id: str
    scopes: list[str]
    token_record: dict

    def has(self, scope: str) -> bool:
        return scope in self.scopes


def resource_metadata_url() -> str:
    """RFC 9728 metadata for this resource: the well-known path plus the
    resource's own path (https://api.markdrop.in/.well-known/oauth-protected-resource/mcp)."""
    parts = urlsplit(oauth_server.resource())
    return f"{parts.scheme}://{parts.netloc}/.well-known/oauth-protected-resource{parts.path}"


def _challenge(error: str | None = None, scope: str | None = None, description: str | None = None) -> str:
    fields = [f'resource_metadata="{resource_metadata_url()}"']
    fields.append(f'scope="{scope or " ".join(oauth_server.SUPPORTED_SCOPES)}"')
    if error:
        fields.append(f'error="{error}"')
    if description:
        fields.append(f'error_description="{description}"')
    return "Bearer " + ", ".join(fields)


def unauthorized(invalid: bool, description: str | None = None) -> JSONResponse:
    """401 that points the client at the OAuth metadata. `invalid` marks a
    token that was presented but is not (or no longer) good."""
    body = {"error": "invalid_token" if invalid else "unauthorized",
            "error_description": description or (
                "The access token is invalid or expired." if invalid
                else "Sign in to Markdrop to use this server.")}
    return JSONResponse(
        body,
        status_code=401,
        headers={
            "WWW-Authenticate": _challenge("invalid_token" if invalid else None,
                                           description=description if invalid else None),
            "Cache-Control": "no-store",
        },
    )


def insufficient_scope(scope: str, request_id) -> JSONResponse:
    """403 asking for a step-up to `scope` (a JSON-RPC error body, so the
    client can still correlate it with the request)."""
    message = (
        f"This needs the {scope} permission, which this app wasn't given. "
        "Reconnect Markdrop and approve it to continue."
    )
    return JSONResponse(
        {"jsonrpc": "2.0", "id": request_id,
         "error": {"code": -32600, "message": message, "data": {"required_scope": scope}}},
        status_code=403,
        headers={
            "WWW-Authenticate": _challenge("insufficient_scope", scope=scope,
                                           description=f"The {scope} scope is required."),
            "Cache-Control": "no-store",
        },
    )


async def authenticate(request: Request) -> Principal | JSONResponse:
    header = request.headers.get("authorization") or ""
    scheme, _, token = header.partition(" ")
    token = token.strip()
    if not header:
        return unauthorized(False)
    if scheme.lower() != "bearer" or not token:
        return unauthorized(True, "Use a Bearer access token.")
    db = get_database()
    record = await oauth_server.validate_access_token(db, token)
    if record is None:
        return unauthorized(True)
    # Audience: a token is good only for the resource it was issued for.
    if not oauth_server.resource_matches(record.get("resource")):
        return unauthorized(True, "This token was issued for a different resource.")
    user = await user_service.get_user_by_id(db, record["user_id"])
    if user is None:
        return unauthorized(True, "The account behind this token no longer exists.")
    return Principal(
        user=user,
        client_id=record["client_id"],
        scopes=list(record.get("scopes") or []),
        token_record=record,
    )
