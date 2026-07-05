"""User persistence — upsert/lookup for the optional-login feature."""

import asyncio
import logging
from datetime import datetime, timezone

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.models.user import User
from app.services import mailer

logger = logging.getLogger(__name__)

# Hold references to fire-and-forget welcome-email tasks so they aren't
# garbage-collected mid-flight (asyncio only keeps weak refs to tasks).
_bg_tasks: set[asyncio.Task] = set()


async def _send_welcome_safe(email: str, name: str | None) -> None:
    try:
        await mailer.send_welcome_email(email, name)
    except Exception:  # never let a welcome-email failure affect login
        logger.warning("welcome email failed for %s", email, exc_info=True)


def _dispatch_welcome(email: str, name: str | None) -> None:
    """Fire-and-forget the welcome email (best-effort, non-blocking)."""
    if not mailer.is_configured():
        return
    task = asyncio.create_task(_send_welcome_safe(email, name))
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


def _user_from_mongo(raw: dict) -> User:
    return User(
        id=str(raw["_id"]),
        email=raw["email"],
        name=raw.get("name"),
        picture=raw.get("picture"),
        google_sub=raw.get("google_sub"),
        providers=raw.get("providers", []),
        created_at=raw["created_at"],
        updated_at=raw["updated_at"],
        last_login_at=raw.get("last_login_at"),
        google_refresh_token_enc=raw.get("google_refresh_token_enc"),
    )


async def update_name(db: AsyncIOMotorDatabase, user_id: str, name: str) -> User | None:
    from datetime import datetime, timezone

    if not ObjectId.is_valid(user_id):
        return None
    raw = await db["users"].find_one_and_update(
        {"_id": ObjectId(user_id)},
        {"$set": {"name": name, "updated_at": datetime.now(timezone.utc)}},
        return_document=True,
    )
    return _user_from_mongo(raw) if raw else None


async def set_google_refresh_token(
    db: AsyncIOMotorDatabase, user_id: str, token_enc: str | None
) -> None:
    """Store (or clear, with None) the encrypted Google refresh token."""
    if not ObjectId.is_valid(user_id):
        return
    await db["users"].update_one(
        {"_id": ObjectId(user_id)},
        {"$set": {"google_refresh_token_enc": token_enc, "updated_at": datetime.now(timezone.utc)}},
    )


async def get_user_by_id(db: AsyncIOMotorDatabase, user_id: str) -> User | None:
    if not ObjectId.is_valid(user_id):
        return None
    raw = await db["users"].find_one({"_id": ObjectId(user_id)})
    return _user_from_mongo(raw) if raw else None


async def get_user_by_email(db: AsyncIOMotorDatabase, email: str) -> User | None:
    raw = await db["users"].find_one({"email": email.lower()})
    return _user_from_mongo(raw) if raw else None


async def upsert_user(
    db: AsyncIOMotorDatabase,
    email: str,
    *,
    provider: str,
    name: str | None = None,
    picture: str | None = None,
    google_sub: str | None = None,
) -> User:
    """Create the user if absent, otherwise link the provider / refresh profile.

    Accounts are keyed by lowercased email, so signing in with Google and with
    an email link for the same address resolves to one account.
    """
    email = email.lower()
    now = datetime.now(timezone.utc)

    set_fields: dict = {"updated_at": now, "last_login_at": now}
    if name:
        set_fields["name"] = name
    if picture:
        set_fields["picture"] = picture
    if google_sub:
        set_fields["google_sub"] = google_sub

    raw = await db["users"].find_one_and_update(
        {"email": email},
        {
            "$set": set_fields,
            "$setOnInsert": {"email": email, "created_at": now},
            "$addToSet": {"providers": provider},
        },
        upsert=True,
        return_document=True,
    )

    # `created_at` is only written on insert (via $setOnInsert with `now`), so it
    # equalling `now` uniquely identifies a brand-new account → send the one-time
    # welcome / feature-tour email (best-effort, never blocks the login response).
    if raw.get("created_at") == now:
        _dispatch_welcome(email, raw.get("name"))

    return _user_from_mongo(raw)
