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
import re

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from fastapi.responses import RedirectResponse
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.schemas.auth import EmailRequest, EmailVerifyRequest, NameUpdateRequest, TokenResponse, UserResponse
from app.services import api_token, domain as domain_service, email_auth, mailer, oauth
from app.services import user as user_service
from app.services import workspace as ws_service
from app.utils.auth import create_tenant_token, create_access_token, decode_access_token

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



class TenantTokenRequest(BaseModel):
    """The workspace domain a scoped session is wanted for."""
    host: str = Field(..., min_length=3, max_length=253)
    # The reader said yes on the handoff page ("Continue to <host> as you?").
    # Required unless they are a member of the workspace that owns the host or
    # already consented for this host.
    consent: bool = False
    # Remember that yes for this host, so the next sign-in there is silent.
    remember: bool = True


# ── Tenant tokens ─────────────────────────────────────────────────────────────
#
# A tenant token is the only Markdrop credential that ever sits on an origin we
# do not control (a workspace's own domain, whose DNS its owner can repoint at
# will). Everything below exists to make a captured one nearly worthless.
#
# One allowlist, checked in the one function every authenticated request passes
# through. An allowlist rather than a denylist because the failure modes are not
# symmetric: forgetting to *allow* a route breaks a feature visibly, forgetting
# to *deny* one hands a customer's domain a capability nobody intended.
_TENANT_ALLOWED = (
    ("GET", re.compile(r"^/api/v1/documents/[^/]+$")),      # read one document
    ("POST", re.compile(r"^/api/v1/documents/[^/]+/events$")),  # the view beacon
    # Reading one's own profile. Not a convenience: the app clears a token whose
    # /me call fails, so without this the credential deletes itself the moment
    # it arrives. For a tenant token it answers the display name only, never
    # the address (see `get_me`).
    ("GET", re.compile(r"^/api/v1/auth/me$")),
    # Folder pages on the workspace's own domain, and shared folders: listings
    # filtered to what this reader may open. Read-only, workspace-scoped.
    ("GET", re.compile(r"^/api/v1/host/folder$")),
    ("GET", re.compile(r"^/api/v1/folders/shared/[^/]+$")),
)


def _origin_host(request: Request) -> str | None:
    origin = request.headers.get("origin")
    if not origin or origin == "null":
        return None
    return domain_service.clean_host(origin) or None


def _tenant_scope_ok(request: Request, payload: dict) -> bool:
    """May this tenant token be used for this request at all?

    Two conditions: an allowed route, and a request made *from the host the
    token was minted for* (its `host` claim must equal the request's Origin).
    The second is what makes a captured token nearly worthless elsewhere: a
    browser cannot be made to send another site's Origin, and a token replayed
    from a script with no Origin at all is refused too.

    The workspace itself is enforced separately and deeper: the document read
    runs with `workspace_scope` pinned to the token's workspace, so a token for
    one customer's domain cannot resolve another customer's document even on an
    allowed route.
    """
    claim = domain_service.clean_host(payload.get("host"))
    if not claim or _origin_host(request) != claim:
        return False
    path = request.url.path
    method = request.method.upper()
    return any(m == method and rx.match(path) for m, rx in _TENANT_ALLOWED)


async def _tenant_host_live(payload: dict) -> bool:
    """Is the host this token was minted for still a live domain of its
    workspace? A domain that lapsed, was detached, removed or moved to another
    workspace takes its outstanding tokens with it at once, rather than leaving
    them good for the rest of their 12 hours."""
    try:
        domain = await domain_service.resolve_host(get_database(), payload.get("host") or "")
    except Exception:
        return False
    return domain is not None and domain.kind == "app" and domain.workspace_id == payload.get("ws")


def is_tenant_request(request: Request) -> bool:
    """True when this request was authenticated with a tenant token."""
    return bool(getattr(request.state, "tenant_token", False))


def tenant_workspace(request: Request) -> str | None:
    """The workspace a tenant token pins this request to, if any.

    Set by `optional_user`/`require_user` while decoding. Read by the document
    router, which passes it down as the read scope — reusing the narrowing that
    custom domains already rely on rather than inventing a second rule.
    """
    return getattr(request.state, "tenant_workspace", None)


async def optional_user(request: Request) -> User | None:
    """Return the authenticated user, or None if no/invalid token is present.

    Treats a missing or unreadable token as "not signed in" — for endpoints that
    behave differently when logged in (e.g. auto-claiming a document on create).

    The one thing it does raise on is a *valid* tenant token used somewhere it
    was not minted for: that is a credential being used out of scope, and
    answering it as though nobody had presented anything would hide the misuse.
    """
    token = _bearer_token(request)
    if not token:
        return None
    if not token.startswith(api_token.TOKEN_PREFIX):
        try:
            payload = decode_access_token(token)
        except jwt.InvalidTokenError:
            return None
        if payload.get("typ") == "tenant":
            # Rejected, not quietly downgraded to anonymous. Ignoring a
            # credential that was presented means the caller gets whatever an
            # anonymous visitor would get, which is harmless on the routes that
            # exist today and is exactly the kind of thing that stops being
            # harmless when someone adds a route where anonymous is the more
            # permissive path. `require_user` already refuses these outright;
            # this keeps the two dependencies saying the same thing.
            if not _tenant_scope_ok(request, payload) or not await _tenant_host_live(payload):
                raise HTTPException(
                    status_code=401,
                    detail="This session only works for documents on that workspace's domain.",
                )
            request.state.tenant_workspace = payload.get("ws")
            request.state.tenant_token = True
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
        if payload.get("typ") == "tenant":
            if not _tenant_scope_ok(request, payload) or not await _tenant_host_live(payload):
                raise HTTPException(
                    status_code=401,
                    detail="This session only works for documents on that workspace's domain.",
                )
            request.state.tenant_workspace = payload.get("ws")
            request.state.tenant_token = True
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
async def get_me(request: Request, user: User = Depends(require_user)):
    if is_tenant_request(request):
        # On a workspace's own domain: who they are to show in the header, and
        # nothing the domain's owner could harvest. No address, no picture
        # (a third-party avatar URL is its own identifier), no providers.
        return UserResponse(
            id=user.id, email="", name=user.name, picture=None, providers=[],
            created_at=user.created_at,
        )
    return _to_user_response(user)


@router.patch("/me", response_model=UserResponse)
async def update_me(data: NameUpdateRequest, user: User = Depends(require_user)):
    """Set the display name (used for passwordless email accounts with no name)."""
    updated = await user_service.update_name(get_database(), user.id, data.name.strip())
    return _to_user_response(updated or user)


async def _tenant_target(host_raw: str):
    host = domain_service.clean_host(host_raw)
    domain = await domain_service.resolve_host(get_database(), host)
    # Unverified, unattached, lapsed, unknown, or a cdn host — none of which
    # serve documents, and none of which should ever receive a credential.
    if domain is None or domain.kind != "app":
        raise HTTPException(status_code=404, detail="Unknown domain.")
    return domain


async def _needs_consent(user: User, domain) -> bool:
    """Members of the workspace that owns the host go straight through (it is
    their own site); everyone else is asked once per host."""
    db = get_database()
    if await ws_service.role_for(db, domain.workspace_id, user.id):
        return False
    return not await db["tenant_consents"].find_one(
        {"user_id": user.id, "host": domain.host}, {"_id": 1}
    )


@router.get("/tenant-token/consent")
@limiter.limit("60/minute")
async def tenant_token_consent(
    request: Request,
    host: str = Query(..., min_length=3, max_length=253),
    user: User = Depends(require_user),
):
    """What the handoff page shows before handing a reader to a custom domain:
    the site, who they will appear as, and whether it has to ask at all."""
    domain = await _tenant_target(host)
    workspace = await ws_service.get_workspace(get_database(), domain.workspace_id)
    site_name = (workspace.branding.site_name if workspace else None) or None
    return {
        "host": domain.host,
        "site_name": site_name,
        "needs_consent": await _needs_consent(user, domain),
        "name": user.name,
        "email": user.email,
    }


@router.post("/tenant-token")
@limiter.limit("30/minute")
async def mint_tenant_token(
    request: Request,
    data: TenantTokenRequest,
    user: User = Depends(require_user),
):
    """Exchange a full session for one scoped to a workspace's own domain.

    Called only from markdrop.in, where the reader's real session lives, and the
    result is handed to the custom domain so they can keep reading there instead
    of being bounced back here for every document.

    Any signed-in reader may mint one for any live domain: the token grants
    *nothing by itself*. Every document read still runs the full access check
    for that person, so a token for a workspace they have no claim on resolves
    exactly nothing. Requiring membership here would also lock out the case
    this exists for — somebody outside the workspace who was named on a single
    document.

    But it does tell that domain's owner who visited. So it is never silent for
    a stranger: unless the reader is a member of the workspace, or said yes for
    this host before, they must consent first (403 `consent_required` until
    they do). The handoff page asks "Continue to <host> as you?".
    """
    domain = await _tenant_target(data.host)
    if await _needs_consent(user, domain):
        if not data.consent:
            raise HTTPException(status_code=403, detail="consent_required")
        if data.remember:
            await get_database()["tenant_consents"].update_one(
                {"user_id": user.id, "host": domain.host},
                {"$set": {"at": datetime.now(timezone.utc)}},
                upsert=True,
            )

    token, exp = create_tenant_token(user.id, user.email, domain.workspace_id, domain.host)
    return {"token": token, "expires_at": exp, "host": domain.host}


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
    t: str = "",
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """One-click opt-out of bulk email. Public by design.

    Mail clients hit this unauthenticated via List-Unsubscribe, so authority
    comes from the signed token (HMAC(AUTH_SECRET, "unsub:{uid}")) rather than a
    session. It only ever stops mail, so there is nothing to escalate even if a
    link leaks. Transactional mail (sign-in codes, invitations) is unaffected:
    those are never bulk sends.

    Also served at /api/v1/unsubscribe (``unsubscribe_alias_router`` below):
    campaigns sent before the URL fix link there.
    """
    from fastapi.responses import HTMLResponse

    from app.services import campaign

    user_id = campaign.verify_unsubscribe_token(t) if t else None
    ok = False
    if user_id and ObjectId.is_valid(user_id):
        user = await db["users"].find_one_and_update(
            {"_id": ObjectId(user_id)},
            {"$set": {"unsubscribed_at": datetime.now(timezone.utc)}},
            projection={"email": 1},
        )
        ok = user is not None
        if ok and user.get("email"):
            # Also on the campaign suppression list, which covers addresses
            # with no account (services/email_campaigns).
            from app.services.email_campaigns import audience, store

            await store.suppress(db, user["email"], "unsubscribed", "unsubscribe link (account)")
            audience.invalidate()

    return HTMLResponse(
        mailer.unsubscribe_page_html(ok),
        status_code=200 if ok else 400,
        headers={
            # The token is in this page's URL: keep it out of caches and out of
            # the Referer sent when someone follows the link back to the site.
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
        },
    )


@router.post("/unsubscribe")
async def unsubscribe_post(t: str = "", db: AsyncIOMotorDatabase = Depends(get_db)):
    """RFC 8058 one-click: some clients POST rather than GET."""
    return await unsubscribe(t, db)


# Campaigns sent before the fix built their links (and List-Unsubscribe headers)
# as /api/v1/unsubscribe, a path that 404'd. Those emails stay in inboxes
# forever, so the old path is served by the same handlers, with the same HMAC
# check and the same one-click POST. Registered in main.py. Never remove it.
unsubscribe_alias_router = APIRouter(prefix="/api/v1", tags=["auth"])
unsubscribe_alias_router.add_api_route(
    "/unsubscribe", unsubscribe, methods=["GET"], include_in_schema=False
)
unsubscribe_alias_router.add_api_route(
    "/unsubscribe", unsubscribe_post, methods=["POST"], include_in_schema=False
)
