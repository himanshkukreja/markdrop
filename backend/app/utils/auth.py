"""User-session JWT helpers (distinct from the admin JWT in routers/admin.py).

Tokens are signed with MARKDROP_AUTH_SECRET (HS256) and carry the user's id
and email. Used for the optional-login feature — anonymous flows never touch
this module.
"""

from datetime import datetime, timedelta, timezone

import jwt

from app.config import get_settings

settings = get_settings()

_ALGO = "HS256"


def create_access_token(user_id: str, email: str, *, via: str | None = None) -> tuple[str, datetime]:
    """Return (signed JWT, expiry datetime) for a user session.

    `iat` says when the person signed in (the admin console asks for a recent one). `via` marks a
    session handed to another of our hosts rather than signed into here: "studio" for Markdrop
    Guides' studio host (routers/auth.mint_studio_token). It is a full session everywhere except the
    admin console, which takes only sessions signed in on markdrop.in itself.
    """
    now = datetime.now(timezone.utc)
    exp = now + timedelta(hours=settings.access_token_ttl_hours)
    payload = {"sub": user_id, "email": email, "typ": "access", "iat": now, "exp": exp}
    if via:
        payload["via"] = via
    token = jwt.encode(payload, settings.auth_secret, algorithm=_ALGO)
    return token, exp


def session_issued_at(payload: dict) -> datetime | None:
    """When a decoded session was signed in: its `iat`, or (sessions made before `iat` was added)
    its expiry less the session lifetime."""
    iat = payload.get("iat")
    if isinstance(iat, (int, float)):
        return datetime.fromtimestamp(iat, timezone.utc)
    exp = payload.get("exp")
    if isinstance(exp, (int, float)):
        return datetime.fromtimestamp(exp, timezone.utc) - timedelta(hours=settings.access_token_ttl_hours)
    return None


# A tenant token lasts hours, not weeks. It exists to carry one reader across
# one origin boundary, and the shorter it lives the less a captured one is worth.
TENANT_TOKEN_TTL_HOURS = 12


def create_tenant_token(
    user_id: str, email: str, workspace_id: str, host: str
) -> tuple[str, datetime]:
    """A session for one workspace's own domain, and nothing else.

    Custom domains are the one place where a Markdrop session would sit on an
    origin we do not control. The workspace owner controls that domain's DNS and
    could repoint it at their own server at any time, so whatever we hand over
    has to be worth as little as possible if it is captured.

    This token names the workspace and the host it was minted for, expires in
    hours, and is accepted only for reading documents of that workspace --
    enforced in `require_user`, at the single point every request passes
    through. Someone who captured one would hold read access to documents of
    the workspace whose domain they already own. They could not touch the
    reader's own documents, their other workspaces, or their account.
    """
    exp = datetime.now(timezone.utc) + timedelta(hours=TENANT_TOKEN_TTL_HOURS)
    # No email: the token sits in the custom domain's storage, readable by
    # whoever controls that domain, and a JWT payload is plain base64. The
    # `email` parameter stays for callers; it is deliberately not embedded.
    payload = {
        "sub": user_id, "typ": "tenant",
        "ws": workspace_id, "host": host.lower().rstrip("."), "exp": exp,
    }
    return jwt.encode(payload, settings.auth_secret, algorithm=_ALGO), exp


def decode_access_token(token: str) -> dict:
    """Decode and validate a user session token. Raises jwt exceptions on failure."""
    return jwt.decode(token, settings.auth_secret, algorithms=[_ALGO])
