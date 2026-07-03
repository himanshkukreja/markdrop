"""User persistence — upsert/lookup for the optional-login feature."""

from datetime import datetime, timezone

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.models.user import User


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
    return _user_from_mongo(raw)
