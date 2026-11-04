"""What people searched for in a workspace and didn't find: the input to content gaps
(services/analytics_ai_home.py, "Write this next").

Privacy-safe on purpose. A row holds only:

    q        the normalised query text (lowercased, whitespace collapsed, 100 characters)
    ws       the workspace the search ran in (its scope, or the workspace the person was in)
    results  how many results it had
    clicked  whether a result was opened from it
    ts       when
    sid      a random id the search box makes when it opens (not tied to the person, never stored
             anywhere else); a refinement of the session's last query overwrites that row, so
             typing "onb", "onbo", "onboarding" leaves one row, not three

No user id, no IP address, no device. Rows expire after :data:`TTL_DAYS` days (a TTL index).
Searches outside any workspace (personal) aren't logged. Queries that look like an email address
or a long number are not logged either.
"""

from __future__ import annotations

import re
import secrets
import unicodedata
from datetime import datetime, timedelta, timezone

from motor.motor_asyncio import AsyncIOMotorDatabase

COLL = "search_queries"
TTL_DAYS = 90
QUERY_MIN = 2
QUERY_MAX = 100
SESSION_WINDOW = timedelta(minutes=10)

_WS = re.compile(r"\s+")
_EMAIL = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")
_DIGITS = re.compile(r"\d[\d\s-]{5,}\d")
_SID = re.compile(r"^[A-Za-z0-9_-]{8,40}$")
_ID = re.compile(r"^[0-9a-f]{32}$")


def now() -> datetime:
    return datetime.now(timezone.utc)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index("ts", expireAfterSeconds=TTL_DAYS * 24 * 3600)
    await db[COLL].create_index([("ws", 1), ("ts", -1)])
    await db[COLL].create_index([("sid", 1), ("ts", -1)])


def normalize(q: str | None) -> str | None:
    """The query as stored, or None when it isn't worth (or safe) keeping."""
    q = unicodedata.normalize("NFKC", q or "").replace("\x00", "")
    q = _WS.sub(" ", q).strip().lower()[:QUERY_MAX].strip()
    if len(q) < QUERY_MIN or _EMAIL.search(q) or _DIGITS.search(q):
        return None
    return q


def _refines(a: str, b: str) -> bool:
    """Is ``b`` the same search as ``a``, still being typed or trimmed?"""
    return b.startswith(a) or a.startswith(b)


async def record(db: AsyncIOMotorDatabase, *, q: str, ws: str | None, results: int,
                 sid: str | None = None, at: datetime | None = None) -> str | None:
    """Log one settled search; returns the row id (for :func:`clicked`), or None when not logged."""
    nq = normalize(q)
    if nq is None or not ws:
        return None
    at = at or now()
    sid = sid if sid and _SID.match(sid) else None
    if sid:
        last = await db[COLL].find_one({"sid": sid, "ts": {"$gte": at - SESSION_WINDOW}}, sort=[("ts", -1)])
        if last and last.get("ws") == ws and not last.get("clicked") and _refines(last["q"], nq):
            await db[COLL].update_one({"_id": last["_id"]},
                                      {"$set": {"q": nq, "results": int(results), "ts": at}})
            return last["_id"]
    row_id = secrets.token_hex(16)
    await db[COLL].insert_one({"_id": row_id, "q": nq, "ws": ws, "results": max(0, int(results)),
                               "clicked": False, "ts": at, **({"sid": sid} if sid else {})})
    return row_id


async def clicked(db: AsyncIOMotorDatabase, row_id: str) -> bool:
    if not row_id or not _ID.match(row_id):
        return False
    res = await db[COLL].update_one({"_id": row_id}, {"$set": {"clicked": True}})
    return res.matched_count == 1


async def misses(db: AsyncIOMotorDatabase, ws: str, since: datetime, limit: int = 200) -> list[dict]:
    """Searches in ``ws`` since ``since`` that found nothing, or found things nobody opened, grouped
    by query: [{q, n, empty, unclicked}], most frequent first."""
    rows = await db[COLL].aggregate([
        {"$match": {"ws": ws, "ts": {"$gte": since},
                    "$or": [{"results": 0}, {"clicked": False}]}},
        {"$group": {"_id": "$q", "n": {"$sum": 1},
                    "empty": {"$sum": {"$cond": [{"$eq": ["$results", 0]}, 1, 0]}}}},
        {"$sort": {"n": -1, "_id": 1}},
        {"$limit": limit},
    ]).to_list(length=limit)
    return [{"q": r["_id"], "n": r["n"], "empty": r["empty"], "unclicked": r["n"] - r["empty"]} for r in rows]
