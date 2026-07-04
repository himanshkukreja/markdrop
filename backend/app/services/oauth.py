"""Google OAuth 2.0 (Authorization Code flow) — HTTP helpers.

The router owns the request/response + session issuance; this module just
talks to Google's endpoints and signs/verifies the CSRF `state`.
"""

from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx
import jwt

from app.config import get_settings

settings = get_settings()

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"

# Additional scope for the opt-in Google Docs integration. `drive.file` only
# grants access to files this app creates — never the user's other Drive files.
DOCS_SCOPE = "openid email https://www.googleapis.com/auth/drive.file"

_STATE_TTL = timedelta(minutes=10)


def is_configured() -> bool:
    return bool(settings.google_client_id and settings.google_client_secret)


def make_state(next_path: str | None) -> str:
    """Signed, short-lived CSRF state carrying the post-login redirect target."""
    payload = {
        "exp": datetime.now(timezone.utc) + _STATE_TTL,
        "next": next_path or "",
        "typ": "oauth_state",
    }
    return jwt.encode(payload, settings.auth_secret, algorithm="HS256")


def verify_state(state: str) -> str:
    """Return the `next` path from a valid state, else raise jwt.InvalidTokenError."""
    payload = jwt.decode(state, settings.auth_secret, algorithms=["HS256"])
    if payload.get("typ") != "oauth_state":
        raise jwt.InvalidTokenError("wrong token type")
    return payload.get("next") or ""


def build_auth_url(state: str) -> str:
    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": settings.google_redirect_uri,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "access_type": "online",
        "prompt": "select_account",
    }
    return f"{AUTH_URL}?{urlencode(params)}"


async def exchange_code(code: str) -> str:
    """Exchange an authorization code for a Google access token."""
    data = {
        "code": code,
        "client_id": settings.google_client_id,
        "client_secret": settings.google_client_secret,
        "redirect_uri": settings.google_redirect_uri,
        "grant_type": "authorization_code",
    }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(TOKEN_URL, data=data)
        resp.raise_for_status()
        return resp.json()["access_token"]


# ── Google Docs integration: incremental-auth connect flow ──────────────────────


def make_docs_state(user_id: str, next_path: str | None) -> str:
    """Signed, short-lived state binding the connect flow to the logged-in user.

    We can't send an Authorization header on a top-level browser redirect, so the
    user id is carried (signed) in the OAuth ``state`` and verified on callback.
    """
    payload = {
        "exp": datetime.now(timezone.utc) + _STATE_TTL,
        "uid": user_id,
        "next": next_path or "",
        "typ": "gdocs_state",
    }
    return jwt.encode(payload, settings.auth_secret, algorithm="HS256")


def verify_docs_state(state: str) -> tuple[str, str]:
    """Return (user_id, next_path) from a valid state, else raise InvalidTokenError."""
    payload = jwt.decode(state, settings.auth_secret, algorithms=["HS256"])
    if payload.get("typ") != "gdocs_state":
        raise jwt.InvalidTokenError("wrong token type")
    uid = payload.get("uid")
    if not uid:
        raise jwt.InvalidTokenError("missing uid")
    return uid, payload.get("next") or ""


def build_docs_auth_url(state: str) -> str:
    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": settings.google_docs_redirect_uri,
        "response_type": "code",
        "scope": DOCS_SCOPE,
        "state": state,
        "access_type": "offline",       # ask for a refresh token
        "prompt": "consent",            # force refresh-token re-issue every time
        "include_granted_scopes": "true",
    }
    return f"{AUTH_URL}?{urlencode(params)}"


async def exchange_docs_code(code: str) -> dict:
    """Exchange the connect-flow code for tokens. Returns the full token dict
    (access_token, refresh_token, expires_in, scope, …)."""
    data = {
        "code": code,
        "client_id": settings.google_client_id,
        "client_secret": settings.google_client_secret,
        "redirect_uri": settings.google_docs_redirect_uri,
        "grant_type": "authorization_code",
    }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(TOKEN_URL, data=data)
        resp.raise_for_status()
        return resp.json()


async def refresh_access_token(refresh_token: str) -> str:
    """Mint a fresh access token from a stored refresh token.

    Raises ``httpx.HTTPStatusError`` (typically 400/401) if the refresh token was
    revoked — callers should treat that as "reconnect required".
    """
    data = {
        "refresh_token": refresh_token,
        "client_id": settings.google_client_id,
        "client_secret": settings.google_client_secret,
        "grant_type": "refresh_token",
    }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(TOKEN_URL, data=data)
        resp.raise_for_status()
        return resp.json()["access_token"]


async def fetch_userinfo(access_token: str) -> dict:
    """Fetch the Google profile (sub, email, email_verified, name, picture)."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"}
        )
        resp.raise_for_status()
        return resp.json()
