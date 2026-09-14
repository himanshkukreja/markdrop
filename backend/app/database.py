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

    # Workspaces: a document with no workspace_id is an ordinary markdrop.in
    # document, so the index is sparse and the existing corpus is untouched.
    await db["documents"].create_index("workspace_id", sparse=True)
    await db["workspaces"].create_index("owner_id")
    # One membership row per person per workspace — the upsert in add_member
    # relies on this to stay idempotent rather than duplicating rows.
    await db["memberships"].create_index(
        [("workspace_id", 1), ("user_id", 1)], unique=True
    )
    await db["memberships"].create_index("user_id")
    # One host belongs to exactly one workspace — this index is what makes the
    # "already claimed" check a guarantee rather than a race.
    # Invitations. The unique index is partial on `pending` so that declining
    # and then being re-invited works, while two simultaneous invites to the
    # same address still collapse to one row.
    await db["invitations"].create_index(
        [("workspace_id", 1), ("email", 1)],
        unique=True,
        partialFilterExpression={"status": "pending"},
    )
    await db["invitations"].create_index("token_hash", sparse=True)
    await db["invitations"].create_index("workspace_id")
    # Sweeps resolved invitations once they stop being useful history.
    await db["invitations"].create_index("purge_at", expireAfterSeconds=0)
    await db["domains"].create_index("host", unique=True)
    await db["domains"].create_index("workspace_id")
    await db["folders"].create_index([("workspace_id", 1), ("parent_id", 1)])
    # Folder slugs are URL segments, so siblings must differ or one of them is
    # unreachable. Partial on `slug` so folders created before slugs existed
    # (which have none) don't collide with each other on a missing field.
    await db["folders"].create_index(
        [("workspace_id", 1), ("parent_id", 1), ("slug", 1)],
        unique=True,
        partialFilterExpression={"slug": {"$exists": True}},
    )
    await db["documents"].create_index([("workspace_id", 1), ("folder_id", 1)], sparse=True)
    # The shared library lists by workspace, newest edit first.
    await db["documents"].create_index([("workspace_id", 1), ("updated_at", -1)], sparse=True)

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
