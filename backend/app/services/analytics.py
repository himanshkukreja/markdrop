"""Analytics — record events and aggregate them for the dashboard.

Events are keyed on the document's stable `_id` (string), so renaming a slug
never orphans history. Raw visitor IPs are never stored — only a salted hash
(for unique-visitor counts) plus coarse geography.
"""

import hashlib
from datetime import datetime, timedelta, timezone

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.services import geo

settings = get_settings()

EVENT_TYPES = ("view", "export_pdf", "copy_url")
CLICK_TYPES = ("export_pdf", "copy_url")

_RANGE_DELTA = {"7d": timedelta(days=7), "30d": timedelta(days=30)}


def _hash_ip(ip: str | None) -> str | None:
    if not ip:
        return None
    return hashlib.sha256((settings.ip_hash_salt + ip).encode()).hexdigest()


async def record_event(
    db: AsyncIOMotorDatabase,
    doc_id: str,
    owner_id: str | None,
    event_type: str,
    ip: str | None = None,
    referrer: str | None = None,
) -> None:
    location = geo.lookup(ip)
    await db["events"].insert_one(
        {
            "doc_id": doc_id,
            "owner_id": owner_id,
            "type": event_type,
            "ts": datetime.now(timezone.utc),
            "country": location["country"],
            "region": location["region"],
            "city": location["city"],
            "referrer": (referrer or None),
            "ip_hash": _hash_ip(ip),
        }
    )


async def get_analytics(db: AsyncIOMotorDatabase, doc_id: str, range_key: str) -> dict:
    match: dict = {"doc_id": doc_id}
    delta = _RANGE_DELTA.get(range_key)
    if delta:
        match["ts"] = {"$gte": datetime.now(timezone.utc) - delta}

    # Totals per event type
    totals = {"view": 0, "export_pdf": 0, "copy_url": 0}
    async for row in db["events"].aggregate(
        [{"$match": match}, {"$group": {"_id": "$type", "n": {"$sum": 1}}}]
    ):
        if row["_id"] in totals:
            totals[row["_id"]] = row["n"]

    view_match = {**match, "type": "view"}

    # Unique visitors (distinct hashed IP among views)
    uniq = await db["events"].aggregate(
        [
            {"$match": {**view_match, "ip_hash": {"$ne": None}}},
            {"$group": {"_id": "$ip_hash"}},
            {"$count": "n"},
        ]
    ).to_list(length=1)
    unique_visitors = uniq[0]["n"] if uniq else 0

    # Views per day
    timeseries = [
        {"date": row["_id"], "views": row["n"]}
        async for row in db["events"].aggregate(
            [
                {"$match": view_match},
                {
                    "$group": {
                        "_id": {"$dateToString": {"format": "%Y-%m-%d", "date": "$ts"}},
                        "n": {"$sum": 1},
                    }
                },
                {"$sort": {"_id": 1}},
            ]
        )
    ]

    # Top countries
    countries = [
        {"country": row["_id"], "views": row["n"]}
        async for row in db["events"].aggregate(
            [
                {"$match": {**view_match, "country": {"$ne": None}}},
                {"$group": {"_id": "$country", "n": {"$sum": 1}}},
                {"$sort": {"n": -1}},
                {"$limit": 10},
            ]
        )
    ]

    # Top referrers
    referrers = [
        {"referrer": row["_id"], "views": row["n"]}
        async for row in db["events"].aggregate(
            [
                {"$match": {**view_match, "referrer": {"$ne": None}}},
                {"$group": {"_id": "$referrer", "n": {"$sum": 1}}},
                {"$sort": {"n": -1}},
                {"$limit": 10},
            ]
        )
    ]

    return {
        "range": range_key,
        "totals": {
            "views": totals["view"],
            "unique_visitors": unique_visitors,
            "export_pdf": totals["export_pdf"],
            "copy_url": totals["copy_url"],
        },
        "timeseries": timeseries,
        "countries": countries,
        "referrers": referrers,
    }
