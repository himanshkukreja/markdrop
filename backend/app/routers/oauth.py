"""OAuth 2.1 for the MCP server: discovery, authorization, tokens, consent and
connected apps. The rules live in services/oauth_server.py; this is the HTTP
surface.

Public, cross-origin (no credentials), for AI clients and browser inspectors:
  GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728
  GET  /.well-known/oauth-authorization-server       RFC 8414
  GET  /.well-known/openid-configuration             (same document)
  GET  /oauth/authorize                              → markdrop.in consent
  POST /oauth/token                                  code / refresh_token
  POST /oauth/register                               RFC 7591
  POST /oauth/revoke                                 RFC 7009

The signed-in site (Bearer session token):
  GET  /api/v1/oauth/requests/{id}                   what the consent screen shows
  POST /api/v1/oauth/requests/{id}/decision          approve or deny
  GET  /api/v1/me/connections                        connected apps
  DELETE /api/v1/me/connections/{client_id}          disconnect

(No `from __future__ import annotations` here: slowapi's decorator wraps the
handlers, and FastAPI must resolve their body models from real annotations.)
"""

import base64
import binascii
import html
import json
from urllib.parse import unquote_plus

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from pydantic import BaseModel

from app.config import get_settings
from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.services import cimd, oauth_server
from app.services import user as user_service
from app.services.oauth_server import OAuthError
from app.utils.auth import decode_access_token

settings = get_settings()
router = APIRouter(tags=["oauth"])

_NO_STORE = {"Cache-Control": "no-store", "Pragma": "no-cache"}


# ── Discovery ─────────────────────────────────────────────────────────────────


def protected_resource_metadata() -> dict:
    return {
        "resource": oauth_server.resource(),
        "authorization_servers": [oauth_server.issuer()],
        "scopes_supported": oauth_server.SUPPORTED_SCOPES,
        "bearer_methods_supported": ["header"],
        "resource_name": "Markdrop",
        "resource_documentation": "https://markdrop.in/mcp",
    }


def authorization_server_metadata() -> dict:
    base = oauth_server.issuer()
    return {
        "issuer": base,
        "authorization_endpoint": f"{base}/oauth/authorize",
        "token_endpoint": f"{base}/oauth/token",
        "registration_endpoint": f"{base}/oauth/register",
        "revocation_endpoint": f"{base}/oauth/revoke",
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": list(oauth_server.AUTH_METHODS),
        "revocation_endpoint_auth_methods_supported": list(oauth_server.AUTH_METHODS),
        "scopes_supported": oauth_server.SUPPORTED_SCOPES,
        "client_id_metadata_document_supported": True,
        "authorization_response_iss_parameter_supported": True,
        "service_documentation": "https://markdrop.in/mcp",
    }


def _metadata(body: dict) -> JSONResponse:
    return JSONResponse(body, headers={"Cache-Control": "public, max-age=3600"})


@router.get("/.well-known/oauth-protected-resource/mcp", include_in_schema=False)
@router.get("/.well-known/oauth-protected-resource", include_in_schema=False)
async def oauth_protected_resource():
    return _metadata(protected_resource_metadata())


@router.get("/.well-known/oauth-authorization-server", include_in_schema=False)
@router.get("/.well-known/openid-configuration", include_in_schema=False)
async def oauth_authorization_server():
    return _metadata(authorization_server_metadata())


# ── Authorization endpoint ────────────────────────────────────────────────────


def _error_page(title: str, message: str, status: int = 400) -> HTMLResponse:
    """Shown when we can't trust the redirect URI, so can't send the user back."""
    page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Markdrop - {html.escape(title)}</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ font: 16px/1.5 system-ui, -apple-system, sans-serif; margin: 0; padding: 16px;
         display: grid; place-items: center; min-height: 100vh; box-sizing: border-box; }}
  main {{ max-width: 420px; }}
  h1 {{ font-size: 1.25rem; margin: 0 0 .5rem; }}
  p {{ margin: 0 0 .75rem; opacity: .85; }}
</style></head>
<body><main>
  <h1>{html.escape(title)}</h1>
  <p>{html.escape(message)}</p>
  <p>Go back to the app you came from and try connecting Markdrop again.</p>
</main></body></html>"""
    return HTMLResponse(page, status_code=status, headers=_NO_STORE)


@router.get("/oauth/authorize", include_in_schema=False)
@limiter.limit("60/minute")
async def authorize(request: Request):
    q = request.query_params
    client_id = q.get("client_id") or ""
    db = get_database()

    # 1. Client and redirect URI. Until both check out we have nowhere safe to
    #    send the user, so failures render here instead of redirecting.
    if not client_id:
        return _error_page("Missing app details", "The sign-in request didn't say which app it came from.")
    try:
        client = await oauth_server.get_client(db, client_id)
    except cimd.CIMDError as exc:
        return _error_page("This app can't connect", str(exc))
    if client is None:
        return _error_page("Unknown app", "Markdrop doesn't recognise the app that sent this request.")
    redirect_uri = q.get("redirect_uri")
    explicit = redirect_uri is not None
    if not explicit:
        if len(client.redirect_uris) != 1:
            return _error_page("Missing return address", "The sign-in request didn't say where to send you back.")
        redirect_uri = client.redirect_uris[0]
    if not oauth_server.redirect_uri_matches(client.redirect_uris, redirect_uri):
        return _error_page("Return address not allowed",
                           "This app asked to send you back to an address it didn't register.")

    # 2. Everything else is reported back to the app.
    state = q.get("state")

    def fail(error: str, description: str) -> RedirectResponse:
        return RedirectResponse(
            oauth_server.error_redirect(redirect_uri, error, description, state), status_code=302
        )

    if q.get("response_type") != "code":
        return fail("unsupported_response_type", "Only response_type=code is supported.")
    challenge = q.get("code_challenge")
    if not challenge:
        return fail("invalid_request", "PKCE is required: send code_challenge with S256.")
    if q.get("code_challenge_method") != "S256":
        return fail("invalid_request", "code_challenge_method must be S256.")
    if not oauth_server.valid_code_challenge(challenge):
        return fail("invalid_request", "code_challenge is malformed.")
    resource_param = q.get("resource")
    if resource_param is not None and not oauth_server.resource_matches(resource_param):
        return fail("invalid_target", f"Unknown resource; use {oauth_server.resource()}.")
    try:
        scopes = oauth_server.parse_scopes(q.get("scope"))
    except OAuthError as exc:
        return fail(exc.error, exc.description)
    if state is not None and len(state) > 1000:
        return fail("invalid_request", "state is too long.")

    request_id = await oauth_server.create_request(
        db, client,
        redirect_uri=redirect_uri,
        redirect_uri_explicit=explicit,
        code_challenge=challenge,
        scopes=scopes,
        state=state,
    )
    consent = f"{settings.frontend_url.rstrip('/')}/oauth/consent?request={request_id}"
    return RedirectResponse(consent, status_code=302, headers=_NO_STORE)


# ── Token, registration, revocation ───────────────────────────────────────────


def _oauth_error(exc: OAuthError, basic: bool = False) -> JSONResponse:
    headers = dict(_NO_STORE)
    if exc.status == 401 and basic:
        headers["WWW-Authenticate"] = 'Basic realm="markdrop"'
    return JSONResponse(exc.body(), status_code=exc.status, headers=headers)


async def _form(request: Request) -> dict:
    """Form fields (RFC 6749), or a JSON object from lenient clients."""
    ctype = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if ctype == "application/json":
        try:
            data = json.loads(await request.body())
        except (ValueError, UnicodeDecodeError):
            raise OAuthError("invalid_request", "The body isn't valid JSON.")
        if not isinstance(data, dict):
            raise OAuthError("invalid_request", "Expected an object.")
        return {k: v for k, v in data.items() if isinstance(v, str)}
    form = await request.form()
    return {k: v for k, v in form.items() if isinstance(v, str)}


def _client_credentials(request: Request, form: dict) -> tuple[str | None, str | None, bool]:
    """(client_id, client_secret, used_basic) from Basic auth or the body."""
    header = request.headers.get("authorization") or ""
    if header[:6].lower() == "basic ":
        try:
            decoded = base64.b64decode(header[6:].strip(), validate=True).decode("utf-8")
            raw_id, _, raw_secret = decoded.partition(":")
        except (binascii.Error, ValueError, UnicodeDecodeError):
            raise OAuthError("invalid_client", "Malformed Basic credentials.", 401)
        client_id, secret = unquote_plus(raw_id), unquote_plus(raw_secret)
        if form.get("client_id") and form["client_id"] != client_id:
            raise OAuthError("invalid_request", "client_id differs from the authenticated client.")
        return client_id, secret, True
    return form.get("client_id"), form.get("client_secret"), False


@router.post("/oauth/token", include_in_schema=False)
@limiter.limit(settings.oauth_token_rate_limit)
async def token(request: Request):
    db = get_database()
    basic = False
    try:
        form = await _form(request)
        client_id, secret, basic = _client_credentials(request, form)
        client = await oauth_server.authenticate_client(db, client_id, secret)
        grant_type = form.get("grant_type")
        if grant_type == "authorization_code":
            body = await oauth_server.exchange_code(
                db, client,
                code=form.get("code"),
                redirect_uri=form.get("redirect_uri"),
                code_verifier=form.get("code_verifier"),
                resource_param=form.get("resource"),
            )
        elif grant_type == "refresh_token":
            body = await oauth_server.refresh(
                db, client,
                refresh_token=form.get("refresh_token"),
                scope=form.get("scope"),
                resource_param=form.get("resource"),
            )
        elif not grant_type:
            raise OAuthError("invalid_request", "grant_type is required.")
        else:
            raise OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.")
    except OAuthError as exc:
        return _oauth_error(exc, basic)
    return JSONResponse(body, headers=_NO_STORE)


@router.post("/oauth/register", include_in_schema=False)
@limiter.limit(settings.oauth_register_rate_limit)
async def register(request: Request):
    raw = await request.body()
    if len(raw) > 16 * 1024:
        return _oauth_error(OAuthError("invalid_client_metadata", "Registration request is too large."))
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return _oauth_error(OAuthError("invalid_client_metadata", "Expected a JSON object."))
    try:
        out = await oauth_server.register_client(get_database(), body)
    except OAuthError as exc:
        return _oauth_error(exc)
    return JSONResponse(out, status_code=201, headers=_NO_STORE)


@router.post("/oauth/revoke", include_in_schema=False)
@limiter.limit(settings.oauth_token_rate_limit)
async def revoke(request: Request):
    db = get_database()
    basic = False
    try:
        form = await _form(request)
        client_id, secret, basic = _client_credentials(request, form)
        if client_id:
            client = await oauth_server.authenticate_client(db, client_id, secret)
            await oauth_server.revoke(db, client, form.get("token"))
        else:
            # Whoever holds a token may give it up; it proves nothing more.
            await oauth_server.revoke(db, None, form.get("token"))
    except OAuthError as exc:
        return _oauth_error(exc, basic)
    return Response(status_code=200, headers=_NO_STORE)


# ── Consent (called by markdrop.in with the user's session) ───────────────────


async def require_session_user(request: Request) -> User:
    """A signed-in person on markdrop.in. Consent is a human decision, so only
    a site session counts here: not an API token, not a tenant token."""
    header = request.headers.get("authorization") or ""
    token = header[7:].strip() if header[:7].lower() == "bearer " else ""
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    try:
        payload = decode_access_token(token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Session expired — please log in again")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid session token")
    if payload.get("typ") != "access":
        raise HTTPException(status_code=401, detail="Sign in on markdrop.in to approve apps.")
    user = await user_service.get_user_by_id(get_database(), payload.get("sub") or "")
    if user is None:
        raise HTTPException(status_code=401, detail="User no longer exists")
    return user


class Decision(BaseModel):
    approve: bool


@router.get("/api/v1/oauth/requests/{request_id}")
@limiter.limit("60/minute")
async def get_authorization_request(
    request: Request, request_id: str, user: User = Depends(require_session_user)
):
    req = await oauth_server.get_request(get_database(), request_id)
    if req is None:
        raise HTTPException(status_code=404, detail="This sign-in link expired. Start again from your AI app.")
    return JSONResponse(oauth_server.request_summary(req, user), headers=_NO_STORE)


@router.post("/api/v1/oauth/requests/{request_id}/decision")
@limiter.limit("30/minute")
async def decide_authorization_request(
    request: Request, request_id: str, data: Decision,
    user: User = Depends(require_session_user),
):
    db = get_database()
    req = await oauth_server.take_request(db, request_id)
    if req is None:
        raise HTTPException(status_code=404, detail="This sign-in link expired. Start again from your AI app.")
    if data.approve:
        url = await oauth_server.approve(db, req, user.id)
    else:
        url = oauth_server.deny(req)
    return JSONResponse({"redirect_url": url}, headers=_NO_STORE)


# ── Connected apps ────────────────────────────────────────────────────────────


@router.get("/api/v1/me/connections")
async def list_connections(user: User = Depends(require_user)):
    rows = await oauth_server.list_connections(get_database(), user.id)
    return JSONResponse(json.loads(json.dumps(rows, default=_iso)), headers=_NO_STORE)


@router.delete("/api/v1/me/connections/{client_id:path}", status_code=204)
async def disconnect(client_id: str, user: User = Depends(require_user)):
    if not await oauth_server.disconnect(get_database(), user.id, client_id):
        raise HTTPException(status_code=404, detail="That app isn't connected.")
    return Response(status_code=204)


def _iso(value):
    from datetime import timezone

    if hasattr(value, "isoformat"):
        if getattr(value, "tzinfo", None) is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat().replace("+00:00", "Z")
    raise TypeError(f"not JSON serializable: {type(value).__name__}")
