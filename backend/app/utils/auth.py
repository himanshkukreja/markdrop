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


def create_access_token(user_id: str, email: str) -> tuple[str, datetime]:
    """Return (signed JWT, expiry datetime) for a user session."""
    exp = datetime.now(timezone.utc) + timedelta(hours=settings.access_token_ttl_hours)
    payload = {"sub": user_id, "email": email, "typ": "access", "exp": exp}
    token = jwt.encode(payload, settings.auth_secret, algorithm=_ALGO)
    return token, exp


def decode_access_token(token: str) -> dict:
    """Decode and validate a user session token. Raises jwt exceptions on failure."""
    return jwt.decode(token, settings.auth_secret, algorithms=[_ALGO])
