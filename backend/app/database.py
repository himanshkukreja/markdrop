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
    # Expiry: the sweeper (services/lifecycle.sweep_expired) deletes expired
    # documents properly — bytes, versions, grants, caches. The TTL index stays
    # only as a one-day backstop (access policy A6), migrated in place.
    try:
        from app.services import lifecycle as _lifecycle

        await _lifecycle.ensure_expiry_ttl(db)
    except Exception as exc:  # pragma: no cover - startup must not depend on it
        print(f"[startup] expiry TTL migration skipped: {exc}")
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
    # Domains: unique on *verified* hosts only (a pending claim blocks nobody),
    # pending claims expire, plus the one-time lifecycle backfill. Migrates
    # from the old all-rows unique index safely (new index first, then drop the
    # old one); see services/domain.ensure_indexes. Never fatal: until it runs
    # the old index keeps hosts unique, which is stricter, not looser.
    try:
        from app.services import domain as _domain_service

        await _domain_service.ensure_indexes(db)
    except Exception as exc:  # pragma: no cover - startup must not depend on it
        print(f"[startup] domain index migration skipped: {exc}")
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
    # One grant per person per document; re-sharing updates the role rather
    # than stacking rows.
    await db["document_grants"].create_index(
        [("document_id", 1), ("email", 1)], unique=True
    )
    # "which documents am I shared on?" — answered by address, since a grant
    # exists before its recipient has an account.
    await db["document_grants"].create_index("email")
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
    # Per-connection ICE outcomes. Only worth keeping while it describes the
    # networks people are on now; 90 days, then Mongo drops them itself.
    await db["share_diagnostics"].create_index("ts", expireAfterSeconds=90 * 24 * 3600)
    await db["share_diagnostics"].create_index([("room_id", 1)])
    await db["share_transfers"].create_index("ts", expireAfterSeconds=90 * 24 * 3600)
    # Completed downloads per share, counted by the MCP share tools.
    await db["share_transfers"].create_index([("room_id", 1)])
    # Reading sessions update one row in place (analytics.record_read).
    await db["events"].create_index([("rid", 1), ("doc_id", 1)], sparse=True)

    # First-party site analytics (services/traffic.py). Raw rows are kept 13
    # months — long enough for year-over-year — then Mongo drops them itself.
    # Visitors carry no TTL: one small row each, and retention needs them.
    year = 400 * 24 * 3600
    await db["traffic_pageviews"].create_index("ts", expireAfterSeconds=year)
    await db["traffic_pageviews"].create_index([("vid", 1), ("ts", 1)])
    await db["traffic_pageviews"].create_index([("path", 1), ("ts", 1)])
    await db["traffic_events"].create_index("ts", expireAfterSeconds=year)
    await db["traffic_events"].create_index([("name", 1), ("ts", 1)])
    await db["traffic_sessions"].create_index("started_at", expireAfterSeconds=year)
    await db["traffic_sessions"].create_index("last_seen")
    await db["traffic_visitors"].create_index("first_seen")

    # Email campaigns + opt-out lookups for building an audience
    await db["campaigns"].create_index([("created_at", -1)])
    await db["users"].create_index("unsubscribed_at", sparse=True)

    # Email campaign service (services/email_campaigns). Additive: the legacy
    # `campaigns` collection above is only read, as history.
    await db["email_campaigns"].create_index([("updated_at", -1)])
    await db["email_campaigns"].create_index([("status", 1), ("scheduled_at", 1)])
    await db["email_messages"].create_index([("campaign_id", 1), ("email", 1)], unique=True)
    await db["email_messages"].create_index("token", unique=True)
    await db["email_messages"].create_index([("campaign_id", 1), ("status", 1), ("_id", 1)])
    await db["email_messages"].create_index("claim_id", sparse=True)
    await db["email_messages"].create_index("provider_id", sparse=True)
    await db["email_events"].create_index([("campaign_id", 1), ("ts", -1)])
    await db["email_events"].create_index("message_id")
    await db["email_batches"].create_index([("campaign_id", 1), ("state", 1)])
    await db["email_batches"].create_index("created_at", expireAfterSeconds=30 * 24 * 3600)
    await db["email_senders"].create_index("is_default")
    await db["email_outbox"].create_index("ts", expireAfterSeconds=7 * 24 * 3600)
    await db["email_webhook_events"].create_index("ts", expireAfterSeconds=30 * 24 * 3600)

    # MCP server + OAuth (services/oauth_server.py). New collections only.
    # Pending consent requests (10 min) and authorization codes go by TTL; a
    # used code is kept until purge_at so a replay can still be recognised.
    await db["oauth_requests"].create_index("expires_at", expireAfterSeconds=0)
    await db["oauth_codes"].create_index("purge_at", expireAfterSeconds=0)
    await db["oauth_codes"].create_index([("user_id", 1), ("client_id", 1)])
    # Tokens are looked up by _id (their hash); these serve revocation of a
    # whole family and disconnecting an app.
    await db["oauth_tokens"].create_index("expires_at", expireAfterSeconds=0)
    await db["oauth_tokens"].create_index("family_id")
    await db["oauth_tokens"].create_index([("user_id", 1), ("client_id", 1)])
    await db["oauth_grants"].create_index([("user_id", 1), ("client_id", 1)], unique=True)
    await db["oauth_clients"].create_index("created_at")
    # Tool-call audit (no content), kept 90 days.
    await db["mcp_events"].create_index("ts", expireAfterSeconds=90 * 24 * 3600)
    await db["mcp_events"].create_index([("user_id", 1), ("ts", -1)])

    # File versions (services/file_versions.py). One row per version; blob and
    # poster keys are looked up to decide whether an object is still referenced
    # before it is deleted, so those are indexed on both collections.
    await db["file_versions"].create_index([("doc_id", 1), ("version", -1)], unique=True)
    await db["file_versions"].create_index("user_id")
    await db["file_versions"].create_index("blob_key")
    await db["file_versions"].create_index("poster_key", sparse=True)
    await db["documents"].create_index("blob_key", sparse=True)
    await db["documents"].create_index("poster_key", sparse=True)
    # Multipart upload sessions (services/file_uploads.py): swept per user, and
    # the rows themselves dropped a day after they expire.
    await db["file_uploads"].create_index([("user_id", 1), ("state", 1), ("expires_at", 1)])
    await db["file_uploads"].create_index("purge_at", expireAfterSeconds=0)
    await db["file_events"].create_index([("user_id", 1), ("ts", -1)])

    # Access policy (services/access.py, lifecycle.py, revalidate.py).
    # Former slugs after a rename redirect and stay reserved (Q4).
    await db["documents"].create_index("old_slugs", sparse=True)
    await db["documents"].create_index(
        "access_dirty", partialFilterExpression={"access_dirty": True})
    await db["slug_tombstones"].create_index("slug", unique=True)
    await db["slug_tombstones"].create_index("until", expireAfterSeconds=0)
    await db["revalidate_jobs"].create_index([("state", 1), ("next_at", 1)])
    await db["revalidate_jobs"].create_index([("key", 1), ("state", 1)])
    await db["revalidate_jobs"].create_index("purge_at", expireAfterSeconds=0)
    await db["document_grants"].create_index(
        [("granted_via", 1), ("granted_by_user_id", 1)], sparse=True)
    # Folder shares: /f/<share_id> resolves one folder.
    await db["folders"].create_index(
        "share.id", unique=True, partialFilterExpression={"share.id": {"$exists": True}})

    # Simpler workspaces UI: access requests (one pending per doc + requester)
    # and per-user recently opened documents (newest 100, 90-day TTL).
    try:
        from app.services import access_requests as _access_requests
        from app.services import personal as _personal

        await _access_requests.ensure_indexes(db)
        await _personal.ensure_indexes(db)
    except Exception as exc:  # pragma: no cover - startup must not depend on it
        print(f"[startup] access-request / recent indexes skipped: {exc}")

    # Creator analytics (services/engage.py): engagement sessions, 395-day TTL.
    try:
        from app.services import engage as _engage

        await _engage.ensure_indexes(db)
    except Exception as exc:  # pragma: no cover - startup must not depend on it
        print(f"[startup] engagement indexes skipped: {exc}")
    try:
        from app.services import analytics_digest as _digest

        await _digest.ensure_indexes(db)
    except Exception as exc:  # pragma: no cover - startup must not depend on it
        print(f"[startup] digest indexes skipped: {exc}")

    # Bug reports / feature requests
    await db["feedback"].create_index([("created_at", -1)])
    await db["feedback"].create_index([("status", 1), ("type", 1), ("created_at", -1)])

    # Folders created before slugs existed have none, and fall back to their
    # ObjectId in URLs. Idempotent and a no-op once done, so it runs on every
    # start rather than needing anyone to remember a migration step. Never fatal:
    # ugly URLs are worth far less than a backend that starts.
    try:
        from app.services import folder as _folder_service

        filled = await _folder_service.backfill_slugs(db)
        if filled["folders"]:
            print(f"[startup] gave slugs to {filled['folders']} folder(s) "
                  f"across {filled['workspaces']} workspace(s)")
    except Exception as exc:  # pragma: no cover - startup must not depend on it
        print(f"[startup] folder slug backfill skipped: {exc}")

    # Access-policy data migrations (idempotent): resharing default for filed
    # documents, `workspace` level without a workspace ⇒ private, dangling
    # workspace refs released.
    try:
        from app.services import lifecycle as _lifecycle

        moved = await _lifecycle.migrate(db)
        if any(moved.values()):
            print(f"[startup] access migrations: {moved}")
    except Exception as exc:  # pragma: no cover - startup must not depend on it
        print(f"[startup] access migrations skipped: {exc}")


async def disconnect() -> None:
    global _client
    if _client is not None:
        _client.close()
        _client = None
