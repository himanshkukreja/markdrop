"""A signed-in admin for tests of admin routes.

The admin console takes the owner's own Markdrop session (routers/admin.require_admin): an account
whose email is in MARKDROP_ADMIN_EMAILS, signed in recently. `admin_headers(db)` makes (or finds)
that account in `db` and returns the Authorization header of a fresh session for it.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.config import get_settings
from app.utils.auth import create_access_token

settings = get_settings()


def admin_email() -> str:
    return sorted(settings.admin_email_set)[0]


async def admin_user_id(db, email: str | None = None) -> str:
    email = (email or admin_email()).lower()
    raw = await db["users"].find_one({"email": email}, {"_id": 1})
    if raw:
        return str(raw["_id"])
    now = datetime.now(timezone.utc)
    res = await db["users"].insert_one({"email": email, "name": "Site Admin", "providers": ["google"],
                                        "created_at": now, "updated_at": now})
    return str(res.inserted_id)


async def admin_headers(db, email: str | None = None) -> dict[str, str]:
    email = (email or admin_email()).lower()
    token, _ = create_access_token(await admin_user_id(db, email), email)
    return {"Authorization": f"Bearer {token}"}


def admin_override() -> dict:
    """For `app.dependency_overrides[require_admin]` where a test has no database for the guard."""
    email = admin_email()
    return {"sub": email, "email": email, "user_id": "0" * 24, "ip_hash": None, "role": "owner",
            "issued_at": datetime.now(timezone.utc), "name": "Site Admin", "picture": None}
