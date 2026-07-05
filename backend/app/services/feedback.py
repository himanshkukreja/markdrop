"""Bug reports & feature requests.

A single lightweight ``feedback`` collection captures submissions from anyone —
anonymous visitors or signed-in users. The admin dashboard reads them back.
"""

from datetime import datetime, timezone

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase


async def create_feedback(
    db: AsyncIOMotorDatabase,
    *,
    type: str,
    message: str,
    email: str | None,
    user_id: str | None,
    page_url: str | None,
    user_agent: str | None,
) -> str:
    """Insert one feedback document. Returns the string id."""
    doc = {
        "type": type,  # "bug" | "feature"
        "message": message.strip()[:4000],
        "email": (email or "").strip().lower()[:254] or None,
        "user_id": user_id,
        "page_url": (page_url or "").strip()[:500] or None,
        "user_agent": (user_agent or "").strip()[:400] or None,
        "status": "open",  # "open" | "resolved"
        "created_at": datetime.now(timezone.utc),
    }
    res = await db["feedback"].insert_one(doc)
    return str(res.inserted_id)


async def list_feedback(
    db: AsyncIOMotorDatabase,
    *,
    page: int,
    limit: int,
    type_filter: str | None = None,
    status_filter: str | None = None,
) -> tuple[list[dict], int, int]:
    """Return (rows, total, open_count) for the admin dashboard (newest first)."""
    query: dict = {}
    if type_filter in ("bug", "feature"):
        query["type"] = type_filter
    if status_filter in ("open", "resolved"):
        query["status"] = status_filter

    total = await db["feedback"].count_documents(query)
    open_count = await db["feedback"].count_documents({"status": "open"})
    skip = (page - 1) * limit
    rows = await (
        db["feedback"].find(query).sort("created_at", -1).skip(skip).limit(limit)
    ).to_list(length=limit)
    return rows, total, open_count


async def set_status(db: AsyncIOMotorDatabase, feedback_id: str, status: str) -> bool:
    if not ObjectId.is_valid(feedback_id) or status not in ("open", "resolved"):
        return False
    res = await db["feedback"].update_one(
        {"_id": ObjectId(feedback_id)}, {"$set": {"status": status}}
    )
    return res.matched_count > 0


async def delete_feedback(db: AsyncIOMotorDatabase, feedback_id: str) -> bool:
    if not ObjectId.is_valid(feedback_id):
        return False
    res = await db["feedback"].delete_one({"_id": ObjectId(feedback_id)})
    return res.deleted_count > 0
