"""MongoDB access for campaigns.

Collections (indexes in ``app/database.py``):

``email_campaigns``   one per campaign; content, audience, status, lease, counts
``email_messages``    one per recipient per campaign (unique campaign+email,
                      unique token); the queue *and* the per-recipient report
``email_events``      opens / clicks / unsubscribes / delivery events
``email_batches``     one per provider request: lets a restarted worker finish
                      or safely undo a batch it was in the middle of
``email_suppressions`` ``_id`` = address; never email again (unsubscribed,
                      bounced, complained, manual)
``email_senders``     saved From addresses
``email_outbox``      console transport only: what would have been sent (7 days)
``email_webhook_events`` processed Svix ids, so retries are no-ops (30 days)
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument

STUCK_AFTER = timedelta(minutes=5)
OPEN_EVENT_CAP = 50
STATUSES = ("draft", "scheduled", "sending", "paused", "sent", "cancelled")
MSG_STATUSES = ("queued", "sending", "sent", "failed", "skipped")


def now() -> datetime:
    return datetime.now(timezone.utc)


def oid(v: str | ObjectId | None) -> ObjectId | None:
    if isinstance(v, ObjectId):
        return v
    return ObjectId(v) if v and ObjectId.is_valid(v) else None


def iso(d: Any) -> str | None:
    if not isinstance(d, datetime):
        return None
    return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).isoformat()


# ── Campaigns ──────────────────────────────────────────────────────────────────

async def get_campaign(db: AsyncIOMotorDatabase, cid: str | ObjectId) -> dict[str, Any] | None:
    o = oid(cid)
    return await db["email_campaigns"].find_one({"_id": o}) if o else None


async def update_campaign(
    db: AsyncIOMotorDatabase, cid: ObjectId, patch: dict[str, Any], only_if: tuple[str, ...] | None = None,
    unset: list[str] | None = None,
) -> dict[str, Any] | None:
    q: dict[str, Any] = {"_id": cid}
    if only_if:
        q["status"] = {"$in": list(only_if)}
    upd: dict[str, Any] = {"$set": {**patch, "updated_at": now()}}
    if unset:
        upd["$unset"] = {k: "" for k in unset}
    return await db["email_campaigns"].find_one_and_update(q, upd, return_document=ReturnDocument.AFTER)


async def acquire_lease(db: AsyncIOMotorDatabase, cid: ObjectId, owner: str, seconds: float) -> bool:
    t = now()
    res = await db["email_campaigns"].find_one_and_update(
        {"_id": cid, "$or": [{"lock_until": None}, {"lock_until": {"$lt": t}}, {"lock_owner": owner}]},
        {"$set": {"lock_until": t + timedelta(seconds=seconds), "lock_owner": owner}},
        projection={"_id": 1},
    )
    return res is not None


async def renew_lease(db: AsyncIOMotorDatabase, cid: ObjectId, owner: str, seconds: float) -> bool:
    res = await db["email_campaigns"].update_one(
        {"_id": cid, "lock_owner": owner}, {"$set": {"lock_until": now() + timedelta(seconds=seconds)}}
    )
    return res.matched_count > 0


async def release_lease(db: AsyncIOMotorDatabase, cid: ObjectId, owner: str) -> None:
    await db["email_campaigns"].update_one(
        {"_id": cid, "lock_owner": owner}, {"$set": {"lock_until": None, "lock_owner": None}}
    )


# ── Messages ───────────────────────────────────────────────────────────────────

async def existing_emails(db: AsyncIOMotorDatabase, cid: ObjectId) -> set[str]:
    return set(await db["email_messages"].distinct("email", {"campaign_id": cid}))


async def insert_messages(db: AsyncIOMotorDatabase, cid: ObjectId, rows: list[dict[str, Any]]) -> int:
    """Insert recipients; duplicates of (campaign, email) are ignored."""
    from pymongo.errors import BulkWriteError

    added = 0
    for i in range(0, len(rows), 500):
        chunk = rows[i:i + 500]
        try:
            res = await db["email_messages"].insert_many(chunk, ordered=False)
            added += len(res.inserted_ids)
        except BulkWriteError as e:
            added += e.details.get("nInserted", 0)
            if any(err.get("code") != 11000 for err in e.details.get("writeErrors", [])):
                raise
    return added


def new_message(cid: ObjectId, r: dict[str, Any], token: str) -> dict[str, Any]:
    # first_open_at / first_click_at / unsubscribed_at are left *missing*, not
    # null: they're written with $min, and in BSON order null sorts before any
    # date, so $min onto a null would keep the null forever.
    t = now()
    return {
        "campaign_id": cid, "email": r["email"].strip().lower(), "user_id": r.get("user_id"),
        "name": r.get("name"), "token": token, "status": "queued", "error": None, "provider_id": None,
        "vars": None, "claim_id": None, "claimed_at": None, "sent_at": None,
        "open_count": 0, "last_open_at": None, "click_count": 0, "last_click_at": None,
        "delivered_at": None, "bounced_at": None, "complained_at": None,
        "created_at": t, "updated_at": t,
    }


async def peek_queued(db: AsyncIOMotorDatabase, cid: ObjectId, n: int) -> list[dict[str, Any]]:
    return await db["email_messages"].find(
        {"campaign_id": cid, "status": "queued"}, {"email": 1}
    ).sort("_id", 1).limit(n).to_list(length=n)


async def skip(db: AsyncIOMotorDatabase, ids: list[ObjectId], reason: str) -> int:
    if not ids:
        return 0
    res = await db["email_messages"].update_many(
        {"_id": {"$in": ids}, "status": "queued"},
        {"$set": {"status": "skipped", "error": reason, "updated_at": now()}},
    )
    return res.modified_count


async def claim(db: AsyncIOMotorDatabase, ids: list[ObjectId], claim_id: str) -> list[dict[str, Any]]:
    """Atomically take queued rows for one batch: only rows still ``queued`` are
    taken, and only the ones stamped with this claim id are returned, so two
    senders can never take the same row."""
    if not ids:
        return []
    t = now()
    await db["email_messages"].update_many(
        {"_id": {"$in": ids}, "status": "queued"},
        {"$set": {"status": "sending", "claim_id": claim_id, "claimed_at": t, "updated_at": t}},
    )
    return await db["email_messages"].find({"claim_id": claim_id, "status": "sending"}).sort("_id", 1).to_list(length=len(ids))


async def release_claim(db: AsyncIOMotorDatabase, claim_id: str) -> int:
    res = await db["email_messages"].update_many(
        {"claim_id": claim_id, "status": "sending"},
        {"$set": {"status": "queued", "claim_id": None, "claimed_at": None, "updated_at": now()}},
    )
    return res.modified_count


async def counts(db: AsyncIOMotorDatabase, cid: ObjectId) -> dict[str, int]:
    rows = await counts_many(db, [cid])
    return rows.get(cid, empty_counts())


def empty_counts() -> dict[str, int]:
    return {k: 0 for k in (
        "total", "queued", "sending", "sent", "failed", "skipped", "opened", "opens", "clicked", "clicks",
        "unsubscribed", "delivered", "bounced", "complained", "stuck",
    )}


async def counts_many(db: AsyncIOMotorDatabase, cids: list[ObjectId] | None = None) -> dict[ObjectId, dict[str, int]]:
    stuck_before = now() - STUCK_AFTER
    is_ = lambda s: {"$cond": [{"$eq": ["$status", s]}, 1, 0]}  # noqa: E731
    has = lambda f: {"$cond": [{"$gt": [f"${f}", None]}, 1, 0]}  # noqa: E731
    match: dict[str, Any] = {"campaign_id": {"$in": cids}} if cids is not None else {}
    pipeline = [
        {"$match": match},
        {"$group": {
            "_id": "$campaign_id",
            "total": {"$sum": 1},
            **{s: {"$sum": is_(s)} for s in MSG_STATUSES},
            "opened": {"$sum": {"$cond": [{"$or": [{"$gt": ["$first_open_at", None]}, {"$gt": ["$open_count", 0]}]}, 1, 0]}},
            "opens": {"$sum": "$open_count"},
            "clicked": {"$sum": {"$cond": [{"$gt": ["$click_count", 0]}, 1, 0]}},
            "clicks": {"$sum": "$click_count"},
            "unsubscribed": {"$sum": has("unsubscribed_at")},
            "delivered": {"$sum": has("delivered_at")},
            "bounced": {"$sum": has("bounced_at")},
            "complained": {"$sum": has("complained_at")},
            "stuck": {"$sum": {"$cond": [{"$and": [
                {"$eq": ["$status", "sending"]}, {"$lt": ["$claimed_at", stuck_before]},
            ]}, 1, 0]}},
        }},
    ]
    out: dict[ObjectId, dict[str, int]] = {}
    async for r in db["email_messages"].aggregate(pipeline):
        cid = r.pop("_id")
        out[cid] = {**empty_counts(), **{k: int(v or 0) for k, v in r.items()}}
    return out


async def refresh_counts(db: AsyncIOMotorDatabase, cid: ObjectId) -> dict[str, int]:
    c = await counts(db, cid)
    await db["email_campaigns"].update_one({"_id": cid}, {"$set": {"counts": c, "counts_at": now()}})
    return c


async def requeue(db: AsyncIOMotorDatabase, cid: ObjectId, *, failed: bool, stuck: bool) -> int:
    t = now()
    n = 0
    if failed:
        res = await db["email_messages"].update_many(
            {"campaign_id": cid, "status": "failed"},
            {"$set": {"status": "queued", "error": None, "claim_id": None, "claimed_at": None, "updated_at": t}},
        )
        n += res.modified_count
    if stuck:
        res = await db["email_messages"].update_many(
            {"campaign_id": cid, "status": "sending", "claimed_at": {"$lt": t - STUCK_AFTER}},
            {"$set": {"status": "queued", "claim_id": None, "claimed_at": None, "updated_at": t}},
        )
        n += res.modified_count
    return n


# ── Tracking ───────────────────────────────────────────────────────────────────

async def track(db: AsyncIOMotorDatabase, token: str, kind: str, url: str | None, ua: str | None) -> bool:
    """Count an open or a click on one message. A click also counts as an open.
    Open *events* are capped per message (image prefetchers reload pixels); the
    counter keeps counting."""
    t = now()
    if kind == "open":
        upd = {"$inc": {"open_count": 1}, "$min": {"first_open_at": t}, "$set": {"last_open_at": t}}
    elif kind == "click":
        upd = {"$inc": {"click_count": 1}, "$min": {"first_click_at": t, "first_open_at": t}, "$set": {"last_click_at": t}}
    else:
        return False
    m = await db["email_messages"].find_one_and_update(
        {"token": token}, upd, projection={"campaign_id": 1, "open_count": 1, "email": 1},
        return_document=ReturnDocument.AFTER,
    )
    if not m:
        return False
    if kind == "click" or (m.get("open_count") or 0) <= OPEN_EVENT_CAP:
        await db["email_events"].insert_one({
            "campaign_id": m["campaign_id"], "message_id": m["_id"], "email": m.get("email"), "type": kind,
            "url": (url or "")[:1000] or None, "ua": (ua or "")[:300] or None, "ts": t,
        })
    return True


async def suppress(db: AsyncIOMotorDatabase, email: str, reason: str, detail: str | None = None) -> None:
    e = (email or "").strip().lower()
    if not e:
        return
    t = now()
    await db["email_suppressions"].update_one(
        {"_id": e},
        {"$setOnInsert": {"created_at": t}, "$set": {"reason": reason, "detail": (detail or "")[:400] or None, "updated_at": t}},
        upsert=True,
    )


async def unsubscribe_message(db: AsyncIOMotorDatabase, token: str, ua: str | None = None) -> dict[str, Any] | None:
    """Global opt-out from one message's link: the message, an event, the
    suppression list and the account (``users.unsubscribed_at``)."""
    t = now()
    m = await db["email_messages"].find_one_and_update(
        {"token": token}, {"$min": {"unsubscribed_at": t}, "$set": {"updated_at": t}},
        projection={"campaign_id": 1, "email": 1, "unsubscribed_at": 1}, return_document=ReturnDocument.BEFORE,
    )
    if not m:
        return None
    first = not m.get("unsubscribed_at")
    if first:
        await db["email_events"].insert_one({
            "campaign_id": m["campaign_id"], "message_id": m["_id"], "email": m.get("email"),
            "type": "unsubscribe", "url": None, "ua": (ua or "")[:300] or None, "ts": t,
        })
    await suppress(db, m["email"], "unsubscribed", "unsubscribe link")
    await db["users"].update_one({"email": m["email"], "unsubscribed_at": None}, {"$set": {"unsubscribed_at": t}})
    return m


# ── Report reads ───────────────────────────────────────────────────────────────

FILTERS = ("all", "opened", "unopened", "clicked", "failed", "skipped", "queued", "sending", "sent",
           "unsubscribed", "bounced", "delivered")


def message_query(cid: ObjectId, flt: str, q: str | None) -> dict[str, Any]:
    import re as _re

    query: dict[str, Any] = {"campaign_id": cid}
    if flt == "opened":
        query.update({"status": "sent", "$or": [{"first_open_at": {"$ne": None}}, {"open_count": {"$gt": 0}}]})
    elif flt == "unopened":
        query.update({"status": "sent", "first_open_at": None, "open_count": 0})
    elif flt == "clicked":
        query["click_count"] = {"$gt": 0}
    elif flt == "unsubscribed":
        query["unsubscribed_at"] = {"$ne": None}
    elif flt == "bounced":
        query["bounced_at"] = {"$ne": None}
    elif flt == "delivered":
        query["delivered_at"] = {"$ne": None}
    elif flt in MSG_STATUSES:
        query["status"] = flt
    t = (q or "").strip()[:120]
    if t:
        rx = {"$regex": _re.escape(t), "$options": "i"}
        cond = [{"email": rx}, {"name": rx}]
        query = {"$and": [query, {"$or": cond}]}
    return query


def display_status(m: dict[str, Any]) -> str:
    if m.get("status") == "sent":
        if m.get("bounced_at"):
            return "bounced"
        if (m.get("click_count") or 0) > 0:
            return "clicked"
        if (m.get("open_count") or 0) > 0 or m.get("first_open_at"):
            return "opened"
        if m.get("delivered_at"):
            return "delivered"
        return "sent"
    return m.get("status") or "queued"


def message_row(m: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(m["_id"]), "email": m.get("email"), "name": m.get("name"), "user_id": m.get("user_id"),
        "status": m.get("status"), "display_status": display_status(m), "error": m.get("error"),
        "sent_at": iso(m.get("sent_at")), "delivered_at": iso(m.get("delivered_at")),
        "bounced_at": iso(m.get("bounced_at")), "complained_at": iso(m.get("complained_at")),
        "open_count": m.get("open_count") or 0, "first_open_at": iso(m.get("first_open_at")),
        "last_open_at": iso(m.get("last_open_at")), "click_count": m.get("click_count") or 0,
        "first_click_at": iso(m.get("first_click_at")), "last_click_at": iso(m.get("last_click_at")),
        "unsubscribed_at": iso(m.get("unsubscribed_at")), "created_at": iso(m.get("created_at")),
    }
