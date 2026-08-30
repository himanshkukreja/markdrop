"""User authentication router — the optional-login feature.

Phase 0 ships the session primitives:
  - require_user / optional_user  FastAPI dependencies
  - GET  /api/v1/auth/me          current user profile
  - POST /api/v1/auth/logout      stateless (client drops the token)

Google (Phase 1) and email magic-link/OTP (Phase 2) endpoints are added to
this same router.
"""

from datetime import datetime, timezone
from urllib.parse import urlencode

import httpx
from bson import ObjectId
import jwt
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.schemas.auth import EmailRequest, EmailVerifyRequest, NameUpdateRequest, TokenResponse, UserResponse
from app.services import api_token, email_auth, mailer, oauth
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


async def _user_id_from_token(token: str) -> str | None:
    """Resolve a bearer token (API token `mdk_…` OR session JWT) to a user id.

    Never raises — returns None for anything invalid.
    """
    if token.startswith(api_token.TOKEN_PREFIX):
        return await api_token.verify_token(get_database(), token)
    try:
        payload = decode_access_token(token)
    except jwt.InvalidTokenError:
        return None
    return payload.get("sub")


async def optional_user(request: Request) -> User | None:
    """Return the authenticated user, or None if no/invalid token is present.

    Never raises — for endpoints that behave differently when logged in
    (e.g. auto-claiming a document on create).
    """
    token = _bearer_token(request)
    if not token:
        return None
    user_id = await _user_id_from_token(token)
    if not user_id:
        return None
    return await user_service.get_user_by_id(get_database(), user_id)


async def require_user(request: Request) -> User:
    """Return the authenticated user or raise 401."""
    token = _bearer_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")

    if token.startswith(api_token.TOKEN_PREFIX):
        user_id = await api_token.verify_token(get_database(), token)
        if not user_id:
            raise HTTPException(status_code=401, detail="Invalid API token")
    else:
        try:
            payload = decode_access_token(token)
        except jwt.ExpiredSignatureError:
            raise HTTPException(status_code=401, detail="Session expired — please log in again")
        except jwt.InvalidTokenError:
            raise HTTPException(status_code=401, detail="Invalid session token")
        user_id = payload.get("sub", "")

    user = await user_service.get_user_by_id(get_database(), user_id)
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


@router.patch("/me", response_model=UserResponse)
async def update_me(data: NameUpdateRequest, user: User = Depends(require_user)):
    """Set the display name (used for passwordless email accounts with no name)."""
    updated = await user_service.update_name(get_database(), user.id, data.name.strip())
    return _to_user_response(updated or user)


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


# ── Passwordless email login: magic link + OTP (Phase 2) ────────────────────────


@router.post("/email/request")
@limiter.limit("5/minute")
async def email_request(request: Request, data: EmailRequest):
    """Email the caller a login code + magic link. Always returns {status: sent}."""
    if not mailer.is_configured():
        raise HTTPException(status_code=503, detail="Email login is not configured")

    otp, link_token = await email_auth.create_challenge(get_database(), data.email)
    link_url = f"{settings.api_base_url.rstrip('/')}/api/v1/auth/email/verify?token={link_token}"
    try:
        await mailer.send_login_email(data.email, otp, link_url)
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Could not send login email. Try again.")
    return {"status": "sent"}


@router.post("/email/verify", response_model=TokenResponse)
@limiter.limit("10/minute")
async def email_verify_otp(request: Request, data: EmailVerifyRequest):
    """Verify a 6-digit OTP and return a session token (used by the frontend form)."""
    email = await email_auth.verify_otp(get_database(), data.email, data.code)
    if not email:
        raise HTTPException(status_code=401, detail="Invalid or expired code")
    user = await user_service.upsert_user(get_database(), email, provider="email")
    token, exp = create_access_token(user.id, user.email)
    return TokenResponse(token=token, expires_at=exp, user=_to_user_response(user))


@router.get("/email/verify")
async def email_verify_link(token: str = Query(...), next: str | None = Query(None)):
    """Consume a magic link and redirect to the frontend with a session token."""
    email = await email_auth.verify_link(get_database(), token)
    if not email:
        return _frontend_redirect("/login", error="link_invalid")
    user = await user_service.upsert_user(get_database(), email, provider="email")
    access, _ = create_access_token(user.id, user.email)
    return _login_success_redirect(access, next or "")


@router.get("/unsubscribe")
async def unsubscribe(
    t: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """One-click opt-out of bulk email. Public by design.

    Mail clients hit this unauthenticated via List-Unsubscribe, so authority
    comes from the signed token rather than a session. It only ever stops mail,
    so there is nothing to escalate even if a link leaks. Transactional mail
    (sign-in codes) is unaffected — those are never bulk sends.
    """
    from fastapi.responses import HTMLResponse

    from app.services import campaign

    user_id = campaign.verify_unsubscribe_token(t)
    ok = False
    if user_id and ObjectId.is_valid(user_id):
        res = await db["users"].update_one(
            {"_id": ObjectId(user_id)},
            {"$set": {"unsubscribed_at": datetime.now(timezone.utc)}},
        )
        ok = res.matched_count > 0

    body = (
        "<h2>You're unsubscribed</h2><p>You won't receive Markdrop product updates "
        "again. Sign-in emails will still work.</p>"
        if ok
        else "<h2>Link not recognised</h2><p>This unsubscribe link is invalid or expired.</p>"
    )
    return HTMLResponse(
        f"""<!doctype html><meta charset=utf-8><title>Markdrop</title>
<div style="font:16px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
            max-width:460px;margin:15vh auto;padding:0 24px;color:#111;text-align:center">
  {body}
  <p style="margin-top:24px"><a href="{get_settings().frontend_url}" style="color:#2563eb">Back to Markdrop</a></p>
</div>""",
        status_code=200 if ok else 400,
    )


@router.post("/unsubscribe")
async def unsubscribe_post(t: str, db: AsyncIOMotorDatabase = Depends(get_db)):
    """RFC 8058 one-click: some clients POST rather than GET."""
    return await unsubscribe(t, db)
