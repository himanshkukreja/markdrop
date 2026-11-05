"""Long-lived, revocable API tokens for the VS Code extension (and future clients).

Tokens look like ``mdk_<random>``. Only a SHA-256 hash is stored; the raw value
is shown exactly once at creation. They authenticate as the owning user.

**Scoped tokens** (``scope`` set, e.g. ``meetings:import`` for the Google Meet script, pinned to
one workspace) do one thing only: :func:`verify_token`, which every general auth path uses
(sessions, MCP, folder pages, the docs AI…), never matches them, so they are a 401 everywhere
except the route that calls :func:`verify_scoped` for their scope. They are not listed with the
personal tokens either; the feature that made them shows and revokes them.
"""

import hashlib
import secrets
from datetime import datetime, timezone

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

TOKEN_PREFIX = "mdk_"
UNSCOPED = {"scope": {"$exists": False}}


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


async def create_token(db: AsyncIOMotorDatabase, user_id: str, name: str, *,
                       scope: str | None = None, extra: dict | None = None) -> tuple[str, dict]:
    """Create a token. Returns (raw_token, record). The raw token is shown once.

    ``scope`` makes a scoped token (see the module docstring); ``extra`` fields go on its record."""
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
    if scope:
        doc.update(extra or {})
        doc["scope"] = scope
    res = await db["api_tokens"].insert_one(doc)
    doc["_id"] = res.inserted_id
    return raw, doc


async def verify_token(db: AsyncIOMotorDatabase, raw: str) -> str | None:
    """Return the owning user_id for a valid token, else None. Touches last_used_at."""
    if not raw.startswith(TOKEN_PREFIX):
        return None
    rec = await db["api_tokens"].find_one_and_update(
        {"token_hash": _hash(raw), **UNSCOPED},
        {"$set": {"last_used_at": datetime.now(timezone.utc)}},
    )
    return rec["user_id"] if rec else None


async def verify_scoped(db: AsyncIOMotorDatabase, raw: str, scope: str) -> dict | None:
    """The record of a valid token made for ``scope`` (and only that scope), else None."""
    if not raw or not raw.startswith(TOKEN_PREFIX) or len(raw) > 200:
        return None
    return await db["api_tokens"].find_one_and_update(
        {"token_hash": _hash(raw), "scope": scope},
        {"$set": {"last_used_at": datetime.now(timezone.utc)}},
    )


async def list_tokens(db: AsyncIOMotorDatabase, user_id: str) -> list[dict]:
    return await db["api_tokens"].find({"user_id": user_id, **UNSCOPED}).sort("created_at", -1).to_list(length=100)


async def revoke_token(db: AsyncIOMotorDatabase, user_id: str, token_id: str) -> bool:
    """A personal token (scoped ones are revoked by the feature that made them)."""
    if not ObjectId.is_valid(token_id):
        return False
    res = await db["api_tokens"].delete_one({"_id": ObjectId(token_id), "user_id": user_id, **UNSCOPED})
    return res.deleted_count > 0
