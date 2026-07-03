"""Long-lived, revocable API tokens for the VS Code extension (and future clients).

Tokens look like ``mdk_<random>``. Only a SHA-256 hash is stored; the raw value
is shown exactly once at creation. They authenticate as the owning user.
"""

import hashlib
import secrets
from datetime import datetime, timezone

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

TOKEN_PREFIX = "mdk_"


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


async def create_token(db: AsyncIOMotorDatabase, user_id: str, name: str) -> tuple[str, dict]:
    """Create a token. Returns (raw_token, record). The raw token is shown once."""
    raw = TOKEN_PREFIX + secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    doc = {
        "user_id": user_id,
        "name": name[:80] or "API token",
        "token_hash": _hash(raw),
        "prefix": raw[:12],  # mdk_ + first 8 chars, safe to display
        "created_at": now,
        "last_used_at": None,
    }
    res = await db["api_tokens"].insert_one(doc)
    doc["_id"] = res.inserted_id
    return raw, doc


async def verify_token(db: AsyncIOMotorDatabase, raw: str) -> str | None:
    """Return the owning user_id for a valid token, else None. Touches last_used_at."""
    if not raw.startswith(TOKEN_PREFIX):
        return None
    rec = await db["api_tokens"].find_one_and_update(
        {"token_hash": _hash(raw)},
        {"$set": {"last_used_at": datetime.now(timezone.utc)}},
    )
    return rec["user_id"] if rec else None


async def list_tokens(db: AsyncIOMotorDatabase, user_id: str) -> list[dict]:
    return await db["api_tokens"].find({"user_id": user_id}).sort("created_at", -1).to_list(length=100)


async def revoke_token(db: AsyncIOMotorDatabase, user_id: str, token_id: str) -> bool:
    if not ObjectId.is_valid(token_id):
        return False
    res = await db["api_tokens"].delete_one({"_id": ObjectId(token_id), "user_id": user_id})
    return res.deleted_count > 0
