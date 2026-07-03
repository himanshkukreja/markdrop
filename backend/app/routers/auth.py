"""User authentication router — the optional-login feature.

Phase 0 ships the session primitives:
  - require_user / optional_user  FastAPI dependencies
  - GET  /api/v1/auth/me          current user profile
  - POST /api/v1/auth/logout      stateless (client drops the token)

Google (Phase 1) and email magic-link/OTP (Phase 2) endpoints are added to
this same router.
"""

from urllib.parse import urlencode

import httpx
import jwt
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.database import get_database
from app.models.user import User
from app.schemas.auth import UserResponse
from app.services import oauth
from app.services import user as user_service
from app.utils.auth import create_access_token, decode_access_token

settings = get_settings()
router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


def _frontend_redirect(path: str, **params: str) -> RedirectResponse:
    url = f"{settings.frontend_url.rstrip('/')}{path}"
    if params:
        url = f"{url}?{urlencode(params)}"
    return RedirectResponse(url, status_code=307)


def _login_success_redirect(token: str, next_path: str) -> RedirectResponse:
    # Token goes in the URL fragment so it never reaches the server/logs.
    safe_next = next_path if next_path.startswith("/") else ""
    frag = urlencode({"token": token, "next": safe_next}) if safe_next else urlencode({"token": token})
    return RedirectResponse(
        f"{settings.frontend_url.rstrip('/')}/auth/callback#{frag}", status_code=307
    )


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _bearer_token(request: Request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth.removeprefix("Bearer ").strip()
    return None


async def optional_user(request: Request) -> User | None:
    """Return the authenticated user, or None if no/invalid token is present.

    Never raises — for endpoints that behave differently when logged in
    (e.g. auto-claiming a document on create).
    """
    token = _bearer_token(request)
    if not token:
        return None
    try:
        payload = decode_access_token(token)
    except jwt.InvalidTokenError:
        return None
    user_id = payload.get("sub")
    if not user_id:
        return None
    return await user_service.get_user_by_id(get_database(), user_id)


async def require_user(request: Request) -> User:
    """Return the authenticated user or raise 401."""
    token = _bearer_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    try:
        payload = decode_access_token(token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Session expired — please log in again")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid session token")

    user = await user_service.get_user_by_id(get_database(), payload.get("sub", ""))
    if user is None:
        raise HTTPException(status_code=401, detail="User no longer exists")
    return user


def _to_user_response(user: User) -> UserResponse:
    return UserResponse(
        id=user.id,
        email=user.email,
        name=user.name,
        picture=user.picture,
        providers=user.providers,
        created_at=user.created_at,
    )


@router.get("/me", response_model=UserResponse)
async def get_me(user: User = Depends(require_user)):
    return _to_user_response(user)


@router.post("/logout")
async def logout(_: User = Depends(require_user)):
    # Sessions are stateless JWTs; the client discards the token.
    # A server-side revocation list can be added in a hardening phase.
    return {"status": "ok"}


# ── Google OAuth (Phase 1) ─────────────────────────────────────────────────────


@router.get("/google/login")
async def google_login(next: str | None = Query(None)):
    """Redirect the browser to Google's consent screen."""
    if not oauth.is_configured():
        raise HTTPException(status_code=503, detail="Google login is not configured")
    state = oauth.make_state(next)
    return RedirectResponse(oauth.build_auth_url(state), status_code=307)


@router.get("/google/callback")
async def google_callback(
    code: str | None = Query(None),
    state: str | None = Query(None),
    error: str | None = Query(None),
):
    """Handle Google's redirect: exchange code, upsert user, issue our session."""
    if error or not code or not state:
        return _frontend_redirect("/login", error="oauth_cancelled")

    try:
        next_path = oauth.verify_state(state)
    except jwt.InvalidTokenError:
        return _frontend_redirect("/login", error="oauth_state")

    try:
        access_token = await oauth.exchange_code(code)
        info = await oauth.fetch_userinfo(access_token)
    except httpx.HTTPError:
        return _frontend_redirect("/login", error="oauth_failed")

    email = info.get("email")
    if not email or not info.get("email_verified", False):
        return _frontend_redirect("/login", error="email_unverified")

    user = await user_service.upsert_user(
        get_database(),
        email,
        provider="google",
        name=info.get("name"),
        picture=info.get("picture"),
        google_sub=info.get("sub"),
    )
    token, _ = create_access_token(user.id, user.email)
    return _login_success_redirect(token, next_path)
