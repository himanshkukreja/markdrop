from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from app.config import get_settings

settings = get_settings()

_client: AsyncIOMotorClient | None = None


def get_client() -> AsyncIOMotorClient:
    if _client is None:
        raise RuntimeError("MongoDB client not initialised. Call connect() first.")
    return _client


def get_database() -> AsyncIOMotorDatabase:
    return get_client()[settings.mongodb_db]


async def connect() -> None:
    global _client
    _client = AsyncIOMotorClient(settings.mongodb_uri)
    # Ensure the slug index exists (unique, fast lookups)
    db = get_database()
    await db["documents"].create_index("slug", unique=True)
    # TTL index: auto-delete documents when expires_at is reached
    await db["documents"].create_index("expires_at", expireAfterSeconds=0, sparse=True)
    # Owner lookups for the user dashboard (Phase 3)
    await db["documents"].create_index("owner_id", sparse=True)
    # Full-text index for admin search (title + content + slug)
    await db["documents"].create_index(
        [("title", "text"), ("content", "text"), ("slug", "text")],
        name="doc_text",
    )
    # Artifact quota aggregation (sum of size_bytes per owner) + admin filtering
    await db["documents"].create_index([("owner_id", 1), ("kind", 1)], sparse=True)

    # Abuse reports
    await db["reports"].create_index([("doc_id", 1), ("ts", -1)])

    # Users (optional-login feature)
    await db["users"].create_index("email", unique=True)
    await db["users"].create_index("google_sub", unique=True, sparse=True)

    # Passwordless login challenges — auto-expire via TTL (Phase 2)
    await db["login_challenges"].create_index("expires_at", expireAfterSeconds=0)
    await db["login_challenges"].create_index("email")

    # Analytics events (Phase 4)
    await db["events"].create_index([("doc_id", 1), ("ts", -1)])
    await db["events"].create_index([("owner_id", 1), ("ts", -1)], sparse=True)

    # API tokens (VS Code extension / sync)
    await db["api_tokens"].create_index("token_hash", unique=True)
    await db["api_tokens"].create_index("user_id")

    # P2P file-share events (metadata only — bytes never touch the server)
    await db["share_events"].create_index([("ts", -1)])
    await db["share_events"].create_index([("user_id", 1), ("ts", -1)], sparse=True)

    # Email campaigns + opt-out lookups for building an audience
    await db["campaigns"].create_index([("created_at", -1)])
    await db["users"].create_index("unsubscribed_at", sparse=True)

    # Bug reports / feature requests
    await db["feedback"].create_index([("created_at", -1)])
    await db["feedback"].create_index([("status", 1), ("type", 1), ("created_at", -1)])


async def disconnect() -> None:
    global _client
    if _client is not None:
        _client.close()
        _client = None
