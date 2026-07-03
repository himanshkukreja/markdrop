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


async def fetch_userinfo(access_token: str) -> dict:
    """Fetch the Google profile (sub, email, email_verified, name, picture)."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"}
        )
        resp.raise_for_status()
        return resp.json()
