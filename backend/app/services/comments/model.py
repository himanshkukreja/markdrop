"""Collections, limits and indexes for comments (CONTRACT §1)."""

from __future__ import annotations

from motor.motor_asyncio import AsyncIOMotorDatabase

THREADS = "comment_threads"
MESSAGES = "comment_messages"

MAX_BODY = 5000
MAX_QUOTE = 1000
CONTEXT = 32                 # prefix / suffix length of a text quote
BLOCK_TEXT_MAX = 280
MAX_THREADS_PER_ITEM = 2000
MAX_MESSAGES_PER_THREAD = 500
MAX_MENTIONS = 20
MAX_REACTIONS = 20           # distinct emoji per message
HISTORY_MAX = 50
DELETED_NAME = "Deleted account"
AI_NAME = "Markdrop AI"

STATUSES = ("open", "resolved")
ANCHOR_TYPES = ("text", "block", "page")
ANCHOR_STATUSES = ("attached", "changed")


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    t = db[THREADS]
    await t.create_index([("doc_id", 1), ("status", 1), ("created_at", 1)])
    await t.create_index([("mentions", 1), ("status", 1)])
    await t.create_index([("assignee", 1), ("status", 1)])
    await t.create_index([("workspace_id", 1), ("updated_at", -1)])
    await t.create_index([("participants", 1), ("updated_at", -1)])
    await t.create_index([("created_by", 1), ("updated_at", -1)])
    await t.create_index([("status", 1), ("updated_at", -1)])
    await t.create_index("suggestion.state", sparse=True)
    m = db[MESSAGES]
    await m.create_index([("thread_id", 1), ("created_at", 1)])
    await m.create_index([("doc_id", 1), ("created_at", 1)])
    await m.create_index([("author_id", 1), ("created_at", -1)])
