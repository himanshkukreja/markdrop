"""Who else is in a Markdrop Guides site's editor right now ("Priya is here").

The editor sends a heartbeat every ~30 seconds per open tab (``session``: a random
id the tab makes), naming the page it shows. An entry lives 75 seconds past its
last heartbeat, so a closed tab drops off within a minute or so even when its
goodbye (DELETE) never arrives; MongoDB's TTL monitor removes old rows later
and every read also ignores expired ones.

The answer lists the *other* people on the guide, one entry each (their latest
tab), with the page they're on and whether they're editing it: editing means they
hold the page's lock (services/docs_site_pages.py), the same thing that stops
anyone else saving it.
"""

from __future__ import annotations

from datetime import timedelta

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.models.user import User
from app.services.docs_site_pages import lock_view
from app.services.docs_site_store import PAGES, now

PRESENCE = "docs_presence"
TTL = timedelta(seconds=75)
MAX_PEOPLE = 50


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[PRESENCE].create_index("expires_at", expireAfterSeconds=0)
    await db[PRESENCE].create_index([("site_id", 1), ("expires_at", -1)])


def _key(site: dict, session: str) -> str:
    return f"{site['_id']}:{session}"


async def beat(db: AsyncIOMotorDatabase, site: dict, user: User, session: str, page_id: str | None) -> dict:
    at = now()
    page = page_id if page_id and ObjectId.is_valid(page_id) else None
    try:
        # Keyed by the tab's session, and only ever the caller's own: someone else's session id
        # (never shown to anyone) can't be taken over, it just isn't written.
        await db[PRESENCE].update_one(
            {"_id": _key(site, session), "user_id": user.id},
            {"$set": {"site_id": site["_id"], "user_id": user.id, "name": user.name or user.email,
                      "page_id": page, "at": at, "expires_at": at + TTL}},
            upsert=True)
    except DuplicateKeyError:
        pass
    return {"people": await people(db, site, user)}


async def leave(db: AsyncIOMotorDatabase, site: dict, user: User, session: str) -> None:
    await db[PRESENCE].delete_one({"_id": _key(site, session), "user_id": user.id})


async def people(db: AsyncIOMotorDatabase, site: dict, user: User) -> list[dict]:
    rows = await db[PRESENCE].find(
        {"site_id": site["_id"], "expires_at": {"$gt": now()}, "user_id": {"$ne": user.id}}
    ).sort("at", -1).to_list(length=MAX_PEOPLE * 4)
    latest: dict[str, dict] = {}
    for r in rows:
        latest.setdefault(r["user_id"], r)
    chosen = list(latest.values())[:MAX_PEOPLE]
    page_ids = {ObjectId(r["page_id"]) for r in chosen if r.get("page_id")}
    pages = {}
    if page_ids:
        for p in await db[PAGES].find({"_id": {"$in": list(page_ids)}, "site_id": site["_id"], "deleted_at": None},
                                      {"title": 1, "path": 1, "lock": 1}).to_list(length=len(page_ids)):
            pages[str(p["_id"])] = p
    out = []
    for r in chosen:
        page = pages.get(r.get("page_id") or "")
        lock = lock_view(page.get("lock")) if page else None
        out.append({
            "user_id": r["user_id"],
            "name": r.get("name") or "Someone",
            "page_id": str(page["_id"]) if page else None,
            "page_title": page.get("title") if page else None,
            "page_path": page.get("path") if page else None,
            "editing": bool(lock and lock.get("user_id") == r["user_id"]),
        })
    return out
