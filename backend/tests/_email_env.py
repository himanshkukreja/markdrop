"""Test environment for the email campaign tests.

Imported first by each test module: pins settings before ``app.config`` is
read (console transport, an in-memory rate limiter, predictable hosts) and
provides a throwaway MongoDB database. Mongo comes from MARKDROP_TEST_MONGODB_URI
(default the local sandbox, mongodb://localhost:27018); tests needing it are
skipped when it isn't reachable.
"""

from __future__ import annotations

import os
import secrets

os.environ.update({
    "MARKDROP_RESEND_API_KEY": "",
    "MARKDROP_EMAIL_TRANSPORT": "console",
    "MARKDROP_REDIS_URL": "memory://",
    "MARKDROP_API_BASE_URL": "https://api.markdrop.in",
    "MARKDROP_FRONTEND_URL": "https://markdrop.in",
    "MARKDROP_EMAIL_WORKER_ENABLED": "false",
    "MARKDROP_EMAIL_ROUND_GAP_MS": "0",
    "MARKDROP_AUTH_SECRET": "test-auth-secret",
    "MARKDROP_ADMIN_SECRET": "test-admin-secret",
    # The frontend URL above is production's: never purge its page cache.
    "MARKDROP_PAGE_REVALIDATE_ENABLED": "false",
    # Never let a test spawn ffmpeg against a URL; probe tests call it directly.
    "MARKDROP_FFPROBE_PATH": "/nonexistent/ffprobe",
    "MARKDROP_FFMPEG_PATH": "/nonexistent/ffmpeg",
})

MONGO_URI = os.environ.get("MARKDROP_TEST_MONGODB_URI", "mongodb://localhost:27018")


def mongo_available() -> bool:
    try:
        from pymongo import MongoClient

        MongoClient(MONGO_URI, serverSelectionTimeoutMS=800).admin.command("ping")
        return True
    except Exception:
        return False


MONGO = mongo_available()


def new_db_name() -> str:
    return f"markdrop_test_email_{secrets.token_hex(4)}"


async def make_db(name: str):
    """A fresh database with the campaign indexes (and the users index)."""
    from motor.motor_asyncio import AsyncIOMotorClient

    client = AsyncIOMotorClient(MONGO_URI, tz_aware=False)
    db = client[name]
    await db["users"].create_index("email", unique=True)
    await db["email_messages"].create_index([("campaign_id", 1), ("email", 1)], unique=True)
    await db["email_messages"].create_index("token", unique=True)
    return client, db
