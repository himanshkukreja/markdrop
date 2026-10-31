"""Insights for Markdrop Guides: how a published guide is read, for the people who run it.

First-party and cookieless. Nothing here sets or reads a cookie, a localStorage id or a
fingerprint, and Markdrop's own analytics (PostHog, GA, the first-party beat) never run on a
guide. What is collected, per guide:

    view      a page view: the page path, the referring site's host (no path, no query), the
              device class (desktop / mobile / tablet), the country (two letters), and a
              visitor hash (below). The docs edge Worker sends it server side when it serves
              a page (no script, nothing for an ad blocker to drop); the engine sends one
              for each client-side navigation after that.
    search    a settled search in the guide's search box (3+ characters, debounced by the
              engine): the normalised query and how many results it had.
    feedback  "Did this page help?" (yes / no, an optional comment of up to 1,000
              characters) and the docs MCP server's report_problem.

Ask AI is read from the Ask AI ledger (services/ai_usage.py, ``ai_requests``), which already
records every question for Markdrop's own operations; Insights shows a question to the guide's
team only when it was asked while Insights was on (``insights: true`` on the row, set by
services/docs_agent.py).

Unique visitors: ``sha256(day salt | site | ip | user agent)``. The day salt is random, kept in
``guide_salts`` and deleted after two days, so a hash can't be tied back to an address once its
day is over, and the same reader on two days (or on two guides) is two different hashes. A
reader whose browser sends Do Not Track or Global Privacy Control is counted, with no hash.
Raw IP addresses and user agents are never stored.

Storage: raw events (``guide_events``) expire after 90 days; daily rollups (``guide_daily``,
one row per guide per day, written by the background job for the last few days) after 13
months; feedback (``guide_feedback``) after 13 months. An owner can turn collection off
(settings.insights.enabled; on by default): from then on every beacon is dropped (within a few
seconds, see docs_sites.STUDIO_TTL_S) and the next publish leaves the feedback widget and the
search beacons out of the guide.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import re
import secrets
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlsplit

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.config import get_settings

log = logging.getLogger("markdrop.guide_insights")

RAW = "guide_events"
DAILY = "guide_daily"
FEEDBACK = "guide_feedback"
SALTS = "guide_salts"

RAW_TTL_DAYS = 90
ROLLUP_TTL_DAYS = 400       # 13 months and a bit
FEEDBACK_TTL_DAYS = 400
RANGES = {"7d": 7, "30d": 30, "90d": 90}
# Days the background job rolls up (yesterday and before); older days are read from the raw
# events while they last (90 days), so a missed run costs nothing.
ROLLUP_LOOKBACK_DAYS = 7
# Bounds per guide per UTC day (per API process for events): a flood stops being stored.
EVENTS_PER_SITE_DAY = 200_000
FEEDBACK_PER_SITE_DAY = 500
COMMENT_MAX = 1000
QUERY_MAX = 100
QUERY_MIN = 3
TOP = {"pages": 50, "refs": 20, "countries": 20, "devices": 3, "queries": 50, "empty": 50}
ROLLUP_KEEP = 500           # entries per list in a stored day
QUESTIONS_SCAN = 5000

EDGE_KEY_CONTEXT = b"markdrop-docs-insights/v1"
MCP_PREFIX = "[docs MCP] "

_PATH = re.compile(r"^/[A-Za-z0-9/_.\-~%]{0,299}$")
_COUNTRY = re.compile(r"^[A-Z]{2}$")
_EMAIL = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")
_DIGITS = re.compile(r"\d[\d\s-]{5,}\d")
_WS = re.compile(r"\s+")
DEVICES = ("desktop", "mobile", "tablet")


def now() -> datetime:
    return datetime.now(timezone.utc)


def day_key(ts: datetime) -> str:
    return ts.astimezone(timezone.utc).strftime("%Y-%m-%d")


def iso(ts: datetime | None) -> str | None:
    """A stored time as ISO 8601 UTC (the database hands back naive UTC times)."""
    if ts is None:
        return None
    return (ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)).isoformat().replace("+00:00", "Z")


def _day_start(day: str) -> datetime:
    return datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def range_days(range_key: str, today: datetime | None = None) -> list[str]:
    """The UTC days of a range, oldest first, ending today."""
    n = RANGES.get(range_key, 30)
    t = (today or now()).astimezone(timezone.utc)
    return [day_key(t - timedelta(days=i)) for i in range(n - 1, -1, -1)]


# ── Settings ──────────────────────────────────────────────────────────────────


def enabled(row: dict | None) -> bool:
    """settings.insights.enabled: on unless an admin turned it off."""
    ins = ((row or {}).get("settings") or {}).get("insights") or {}
    return ins.get("enabled", True) is not False


# ── The edge's key ────────────────────────────────────────────────────────────


def edge_key(secret: str | None = None) -> str | None:
    """What the docs edge Worker sends as `Authorization: Bearer …` with a page view: an HMAC of a
    fixed label with the secret the API already shares with it (settings.docs_access_secret, the
    Worker's DOCS_ACCESS_SECRET). None when no secret is set (then no edge page view is taken)."""
    secret = get_settings().docs_access_secret if secret is None else secret
    if not secret or len(secret) < 32:
        return None
    return hmac.new(secret.encode(), EDGE_KEY_CONTEXT, hashlib.sha256).hexdigest()


def edge_authorized(header: str | None) -> bool:
    key = edge_key()
    if not key or not header or not header.startswith("Bearer "):
        return False
    return hmac.compare_digest(header.removeprefix("Bearer ").strip(), key)


# ── Visitors ──────────────────────────────────────────────────────────────────

_salts: dict[tuple[str, str], str] = {}


async def day_salt(db: AsyncIOMotorDatabase, day: str) -> str:
    """The random salt of one UTC day (shared by every API process; deleted two days later)."""
    key = (db.name, day)
    hit = _salts.get(key)
    if hit:
        return hit
    try:
        await db[SALTS].update_one(
            {"_id": day},
            {"$setOnInsert": {"salt": secrets.token_hex(32), "expires_at": _day_start(day) + timedelta(days=2)}},
            upsert=True)
    except DuplicateKeyError:
        pass  # another process created it first
    row = await db[SALTS].find_one({"_id": day})
    salt = row["salt"]
    if len(_salts) > 16:
        _salts.clear()
    _salts[key] = salt
    return salt


def visitor_hash(salt: str, site: str, ip: str | None, ua: str | None) -> str | None:
    if not ip:
        return None
    return hashlib.sha256(f"{salt}|{site}|{ip}|{ua or ''}".encode()).hexdigest()[:24]


def opted_out(dnt: Any = None, gpc: Any = None) -> bool:
    """Do Not Track or Global Privacy Control: the view counts, without a visitor hash."""
    return str(dnt or "").strip() == "1" or str(gpc or "").strip() == "1" or dnt is True


# ── Cleaning ──────────────────────────────────────────────────────────────────


def clean_path(p: Any) -> str | None:
    """A page path on the guide: no query, no fragment, no trailing slash."""
    if not isinstance(p, str):
        return None
    p = p.split("#", 1)[0].split("?", 1)[0].strip()
    p = p.rstrip("/") or "/"
    return p if _PATH.match(p) and "//" not in p else None


def ref_host(ref: Any, own_hosts: tuple[str, ...] | list[str] = ()) -> str | None:
    """The referring site's host (no path, no query); None for the guide itself or nothing."""
    if not isinstance(ref, str) or not ref.strip():
        return None
    try:
        u = urlsplit(ref.strip()[:1000])
        host = (u.hostname or "").lower().rstrip(".")
    except ValueError:
        return None
    if u.scheme not in ("http", "https") or not host or len(host) > 120:
        return None
    own = {h.lower() for h in own_hosts}
    if host in own:
        return None
    return host.removeprefix("www.")


def device_of(ua: str | None) -> str:
    from app.services.traffic import parse_ua

    return parse_ua(ua or "")["device"].lower()


def clean_country(cc: Any) -> str | None:
    if not isinstance(cc, str):
        return None
    cc = cc.strip().upper()
    return cc if _COUNTRY.match(cc) and cc not in ("XX", "T1", "ZZ") else None


def normalize_query(q: Any) -> str | None:
    """Lowercase, one space between words, emails and long numbers masked. None under 3 characters."""
    if not isinstance(q, str):
        return None
    q = unicodedata.normalize("NFKC", q).replace("\x00", "")
    q = _WS.sub(" ", q).strip().lower()
    q = _EMAIL.sub("[email]", q)
    q = _DIGITS.sub("[number]", q)
    q = q[:QUERY_MAX].strip()
    return q if len(q) >= QUERY_MIN else None


def is_bot(ua: str | None) -> bool:
    from app.routers.documents import _is_bot

    return not (ua or "").strip() or _is_bot(ua)


# ── Ingest ────────────────────────────────────────────────────────────────────

_counts: dict[tuple[str, str], int] = {}


def _within_cap(site: str, day: str) -> bool:
    key = (site, day)
    n = _counts.get(key, 0)
    if n >= EVENTS_PER_SITE_DAY:
        return False
    if len(_counts) > 50_000:
        _counts.clear()
    _counts[key] = n + 1
    return True


async def _visitor(db: AsyncIOMotorDatabase, site: str, day: str, ip: str | None, ua: str | None,
                   out: bool) -> str | None:
    if out:
        return None
    return visitor_hash(await day_salt(db, day), site, ip, ua)


async def record_view(db: AsyncIOMotorDatabase, site: str, *, path: str, ref: str | None, own_hosts,
                      ua: str | None, ip: str | None, country: str | None, out: bool, soft: bool) -> bool:
    ts = now()
    day = day_key(ts)
    if not _within_cap(site, day):
        return False
    await db[RAW].insert_one({
        "site": site, "k": "view", "ts": ts, "day": day, "p": path,
        "ref": None if soft else ref_host(ref, own_hosts),
        "dev": device_of(ua), "cc": clean_country(country),
        "v": await _visitor(db, site, day, ip, ua, out),
        **({"nav": True} if soft else {}),
    })
    return True


async def record_search(db: AsyncIOMotorDatabase, site: str, *, query: str, results: int, path: str | None,
                        ua: str | None, ip: str | None, out: bool) -> bool:
    ts = now()
    day = day_key(ts)
    if not _within_cap(site, day):
        return False
    await db[RAW].insert_one({
        "site": site, "k": "search", "ts": ts, "day": day, "q": query, "n": max(0, min(int(results), 10_000)),
        "p": path, "v": await _visitor(db, site, day, ip, ua, out),
    })
    return True


async def record_feedback(db: AsyncIOMotorDatabase, site: str, *, path: str, helpful: bool,
                          comment: str | None) -> str:
    """Store a vote (+ comment). Returns "received", or "capped" past the day's bound."""
    ts = now()
    since = _day_start(day_key(ts))
    if await db[FEEDBACK].count_documents({"site": site, "ts": {"$gte": since}}, limit=FEEDBACK_PER_SITE_DAY) \
            >= FEEDBACK_PER_SITE_DAY:
        return "capped"
    text = (comment or "").replace("\x00", "").strip()
    source = "page"
    if text.startswith(MCP_PREFIX.strip()):
        source = "mcp"
        text = text[len(MCP_PREFIX.strip()):].strip()
    await db[FEEDBACK].insert_one({
        "site": site, "ts": ts, "day": day_key(ts), "path": path, "helpful": bool(helpful),
        "comment": text[:COMMENT_MAX] or None, "source": source, "resolved": False,
    })
    return "received"


# ── Rollups ───────────────────────────────────────────────────────────────────


def _facets(days: list[str]) -> list[dict]:
    """One aggregation over raw events: per-day totals and the top lists, for ``days``."""
    view = {"k": "view"}
    keep = ROLLUP_KEEP
    return [{"$facet": {
        "daily": [
            {"$match": view},
            {"$group": {"_id": {"d": "$day", "v": "$v"}, "n": {"$sum": 1}}},
            {"$group": {"_id": "$_id.d", "views": {"$sum": "$n"},
                        "visitors": {"$sum": {"$cond": [{"$eq": ["$_id.v", None]}, 0, 1]}}}},
        ],
        "searches": [
            {"$match": {"k": "search"}},
            {"$group": {"_id": "$day", "n": {"$sum": 1}, "z": {"$sum": {"$cond": [{"$eq": ["$n", 0]}, 1, 0]}}}},
        ],
        "pages": [
            {"$match": view},
            {"$group": {"_id": {"p": "$p", "d": "$day", "v": "$v"}, "n": {"$sum": 1}}},
            {"$group": {"_id": "$_id.p", "n": {"$sum": "$n"},
                        "v": {"$sum": {"$cond": [{"$eq": ["$_id.v", None]}, 0, 1]}}}},
            {"$sort": {"n": -1, "_id": 1}}, {"$limit": keep},
        ],
        "refs": [
            {"$match": {**view, "ref": {"$ne": None}}},
            {"$group": {"_id": "$ref", "n": {"$sum": 1}}}, {"$sort": {"n": -1, "_id": 1}}, {"$limit": keep},
        ],
        "countries": [
            {"$match": {**view, "cc": {"$ne": None}}},
            {"$group": {"_id": "$cc", "n": {"$sum": 1}}}, {"$sort": {"n": -1, "_id": 1}}, {"$limit": 300},
        ],
        "devices": [
            {"$match": view},
            {"$group": {"_id": "$dev", "n": {"$sum": 1}}}, {"$sort": {"n": -1, "_id": 1}},
        ],
        "queries": [
            {"$match": {"k": "search"}},
            {"$group": {"_id": "$q", "n": {"$sum": 1}, "z": {"$sum": {"$cond": [{"$eq": ["$n", 0]}, 1, 0]}}}},
            {"$sort": {"n": -1, "_id": 1}}, {"$limit": keep},
        ],
    }}]


async def _aggregate(db: AsyncIOMotorDatabase, site: str, days: list[str]) -> dict:
    if not days:
        return {}
    rows = await db[RAW].aggregate([{"$match": {"site": site, "day": {"$in": days}}}, *_facets(days)]).to_list(1)
    return rows[0] if rows else {}


def _pairs(rows: list[dict], *extra: str) -> list[dict]:
    out = []
    for r in rows or []:
        if r.get("_id") is None:
            continue
        item = {"k": r["_id"], "n": int(r.get("n") or 0)}
        for e in extra:
            item[e] = int(r.get(e) or 0)
        out.append(item)
    return out


async def rollup_day(db: AsyncIOMotorDatabase, site: str, day: str) -> dict:
    """Roll one complete UTC day of a guide's raw events into its ``guide_daily`` row."""
    f = await _aggregate(db, site, [day])
    d = next((r for r in f.get("daily") or [] if r["_id"] == day), {})
    s = next((r for r in f.get("searches") or [] if r["_id"] == day), {})
    row = {
        "site": site, "day": day, "views": int(d.get("views") or 0), "visitors": int(d.get("visitors") or 0),
        "searches": int(s.get("n") or 0), "empty_searches": int(s.get("z") or 0),
        "pages": _pairs(f.get("pages"), "v"), "refs": _pairs(f.get("refs")), "countries": _pairs(f.get("countries")),
        "devices": _pairs(f.get("devices")), "queries": _pairs(f.get("queries"), "z"),
        "rolled_at": now(), "expires_at": _day_start(day) + timedelta(days=ROLLUP_TTL_DAYS),
    }
    await db[DAILY].replace_one({"_id": f"{site}:{day}"}, {"_id": f"{site}:{day}", **row}, upsert=True)
    return row


async def rollup_due(db: AsyncIOMotorDatabase, today: datetime | None = None) -> int:
    """The background job: roll up every guide with raw events on one of the last few complete
    days that has no daily row yet. Returns how many rows it wrote."""
    t = (today or now()).astimezone(timezone.utc)
    written = 0
    for i in range(1, ROLLUP_LOOKBACK_DAYS + 1):
        day = day_key(t - timedelta(days=i))
        sites = set(await db[RAW].distinct("site", {"day": day}))
        if not sites:
            continue
        done = set(await db[DAILY].distinct("site", {"day": day}))
        for site in sorted(sites - done):
            try:
                await rollup_day(db, site, day)
                written += 1
            except Exception:
                log.warning("insights rollup failed for %s %s", site, day, exc_info=True)
    return written


# ── Reading ───────────────────────────────────────────────────────────────────


def _merge(lists: list[list[dict]], limit: int, *extra: str) -> list[dict]:
    acc: dict[str, dict] = {}
    for rows in lists:
        for r in rows or []:
            a = acc.setdefault(r["k"], {"k": r["k"], "n": 0, **{e: 0 for e in extra}})
            a["n"] += int(r.get("n") or 0)
            for e in extra:
                a[e] += int(r.get(e) or 0)
    return sorted(acc.values(), key=lambda r: (-r["n"], r["k"]))[:limit]


async def traffic(db: AsyncIOMotorDatabase, site: str, days: list[str]) -> dict:
    """Views, visitors, top lists and searches over ``days``: stored daily rows where they exist,
    raw events for the rest (today, and any day the job hasn't rolled up yet)."""
    if not days:
        return {"daily": [], "views": 0, "visitors": 0, "searches": 0, "empty_searches": 0,
                "pages": [], "refs": [], "countries": [], "devices": [], "queries": [], "empty": []}
    today = day_key(now())
    stored = {r["day"]: r async for r in db[DAILY].find({"site": site, "day": {"$in": [d for d in days if d < today]}})}
    live_days = [d for d in days if d not in stored]
    f = await _aggregate(db, site, live_days)
    per_day: dict[str, dict] = {d: {"date": d, "views": 0, "visitors": 0, "searches": 0} for d in days}
    for d, r in stored.items():
        per_day[d].update(views=r.get("views", 0), visitors=r.get("visitors", 0), searches=r.get("searches", 0))
    empty_total = sum(r.get("empty_searches", 0) for r in stored.values())
    for r in f.get("daily") or []:
        if r["_id"] in per_day:
            per_day[r["_id"]].update(views=int(r["views"]), visitors=int(r["visitors"]))
    for r in f.get("searches") or []:
        if r["_id"] in per_day:
            per_day[r["_id"]]["searches"] = int(r["n"])
            empty_total += int(r.get("z") or 0)
    rows = list(stored.values())
    queries = _merge([*(r.get("queries") for r in rows), _pairs(f.get("queries"), "z")], ROLLUP_KEEP, "z")
    daily = [per_day[d] for d in days]
    return {
        "daily": daily,
        "views": sum(d["views"] for d in daily),
        "visitors": sum(d["visitors"] for d in daily),
        "searches": sum(d["searches"] for d in daily),
        "empty_searches": empty_total,
        "pages": _merge([*(r.get("pages") for r in rows), _pairs(f.get("pages"), "v")], TOP["pages"], "v"),
        "refs": _merge([*(r.get("refs") for r in rows), _pairs(f.get("refs"))], TOP["refs"]),
        "countries": _merge([*(r.get("countries") for r in rows), _pairs(f.get("countries"))], TOP["countries"]),
        "devices": _merge([*(r.get("devices") for r in rows), _pairs(f.get("devices"))], TOP["devices"]),
        "queries": [{"q": r["k"], "n": r["n"], "empty": r["z"]} for r in queries[:TOP["queries"]]],
        "empty": [{"q": r["k"], "n": r["z"]} for r in sorted(
            (r for r in queries if r["z"] > 0), key=lambda r: (-r["z"], r["k"]))[:TOP["empty"]]],
    }


async def totals(db: AsyncIOMotorDatabase, site: str, days: list[str]) -> dict:
    """Just the headline numbers of a window (the previous period, for the change arrows)."""
    t = await traffic(db, site, days)
    return {"views": t["views"], "visitors": t["visitors"], "searches": t["searches"]}


def _question_key(q: str) -> str:
    q = unicodedata.normalize("NFKC", q or "")
    return _WS.sub(" ", q).strip().lower().rstrip("?.!").strip()[:200]


async def questions(db: AsyncIOMotorDatabase, site: str, since: datetime) -> dict:
    """Ask AI over the window: counts, the most asked questions, and the ones it couldn't answer.
    Only questions asked while Insights was on (``insights: true``) are listed."""
    from app.services import ai_usage, docs_agent

    base = {"feature": docs_agent.FEATURE, "site": site, "ts": {"$gte": since}}
    asked = answered = unanswered = up = down = 0
    groups: dict[str, dict] = {}
    cursor = db[ai_usage.REQUESTS].find(
        {**base, "insights": True, "outcome": {"$nin": ["limit"]}},
        {"question": 1, "outcome": 1, "ts": 1, "page_path": 1, "feedback.helpful": 1},
    ).sort("ts", -1).limit(QUESTIONS_SCAN)
    async for r in cursor:
        outcome = r.get("outcome")
        asked += 1
        ok = outcome == "answered"
        miss = outcome == "no_answer"
        answered += ok
        unanswered += miss
        fb = (r.get("feedback") or {}).get("helpful")
        up += fb is True
        down += fb is False
        q = (r.get("question") or "").strip()
        key = _question_key(q)
        if not key:
            continue
        g = groups.get(key)
        if g is None:
            g = groups[key] = {"q": q[:300], "n": 0, "unanswered": 0, "last": iso(r.get("ts")),
                               "page": r.get("page_path")}
        g["n"] += 1
        g["unanswered"] += miss
    top = sorted(groups.values(), key=lambda g: (-g["n"], g["q"]))[:30]
    missed = sorted((g for g in groups.values() if g["unanswered"]), key=lambda g: (-g["unanswered"], g["q"]))[:30]
    return {"asked": asked, "answered": answered, "unanswered": unanswered, "helpful": up, "not_helpful": down,
            "top": top, "unanswered_top": missed, "capped": asked >= QUESTIONS_SCAN}


def feedback_view(r: dict) -> dict:
    return {"id": str(r["_id"]), "path": r.get("path"), "helpful": bool(r.get("helpful")),
            "comment": r.get("comment"), "source": r.get("source") or "page", "ts": iso(r.get("ts")),
            "resolved": bool(r.get("resolved"))}


async def feedback_summary(db: AsyncIOMotorDatabase, site: str, since: datetime, *, status: str = "open",
                           limit: int = 50) -> dict:
    q = {"site": site, "ts": {"$gte": since}}
    yes = await db[FEEDBACK].count_documents({**q, "helpful": True})
    no = await db[FEEDBACK].count_documents({**q, "helpful": False})
    by_page = await db[FEEDBACK].aggregate([
        {"$match": q},
        {"$group": {"_id": "$path", "yes": {"$sum": {"$cond": ["$helpful", 1, 0]}},
                    "no": {"$sum": {"$cond": ["$helpful", 0, 1]}}}},
        {"$sort": {"no": -1, "yes": -1, "_id": 1}}, {"$limit": 10},
    ]).to_list(10)
    listed = {**q, "$or": [{"comment": {"$ne": None}}, {"helpful": False}]}
    if status in ("open", "resolved"):
        listed["resolved"] = status == "resolved"
    open_n = await db[FEEDBACK].count_documents({**q, "resolved": False, "$or": listed["$or"]})
    items = await db[FEEDBACK].find(listed).sort("ts", -1).limit(limit).to_list(limit)
    return {
        "yes": yes, "no": no, "helpful_pct": round(100 * yes / (yes + no)) if yes + no else None,
        "open": open_n,
        "pages": [{"path": r["_id"], "yes": r["yes"], "no": r["no"]} for r in by_page if r["_id"]],
        "items": [feedback_view(r) for r in items],
    }


async def set_resolved(db: AsyncIOMotorDatabase, site: str, feedback_id: str, resolved: bool, user_id: str) -> dict | None:
    if not ObjectId.is_valid(feedback_id):
        return None
    r = await db[FEEDBACK].find_one_and_update(
        {"_id": ObjectId(feedback_id), "site": site},
        {"$set": {"resolved": bool(resolved), "resolved_at": now() if resolved else None,
                  "resolved_by": user_id if resolved else None}},
        return_document=True)
    return feedback_view(r) if r else None


async def page_titles(db: AsyncIOMotorDatabase, site_row: dict) -> dict[str, str]:
    """path → title, from the live build's snapshot (what readers see)."""
    from app.services.docs_site_store import BUILDS, SNAPSHOTS

    bid = site_row.get("live_build_id")
    if not bid:
        return {}
    b = await db[BUILDS].find_one({"_id": bid}, {"snapshot_id": 1})
    if not b or not b.get("snapshot_id"):
        return {}
    snap = await db[SNAPSHOTS].find_one({"_id": b["snapshot_id"]}, {"pages.path": 1, "pages.title": 1})
    return {p["path"]: (p.get("title") or "")[:200] for p in (snap or {}).get("pages") or [] if p.get("path")}


async def first_seen(db: AsyncIOMotorDatabase, site: str) -> datetime | None:
    r = await db[RAW].find_one({"site": site}, {"ts": 1}, sort=[("ts", 1)])
    if r:
        ts = r["ts"]
        return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
    d = await db[DAILY].find_one({"site": site}, {"day": 1}, sort=[("day", 1)])
    return _day_start(d["day"]) if d else None


async def clear(db: AsyncIOMotorDatabase, site: str) -> dict:
    """Delete everything Insights holds for a guide (raw events, rollups, feedback), and take its
    Ask AI questions out of Insights (the ledger row stays: it is Markdrop's own record)."""
    from app.services import ai_usage

    a = await db[RAW].delete_many({"site": site})
    b = await db[DAILY].delete_many({"site": site})
    c = await db[FEEDBACK].delete_many({"site": site})
    await db[ai_usage.REQUESTS].update_many({"site": site, "insights": True}, {"$set": {"insights": False}})
    return {"events": a.deleted_count, "days": b.deleted_count, "feedback": c.deleted_count}


async def overview(db: AsyncIOMotorDatabase, site_row: dict, range_key: str, *, status: str = "open") -> dict:
    """GET /docs-sites/{id}/insights."""
    site = str(site_row["_id"])
    days = range_days(range_key)
    since = _day_start(days[0])
    n = len(days)
    prev_days = [day_key(since - timedelta(days=i)) for i in range(n, 0, -1)]
    t = await traffic(db, site, days)
    prev = await totals(db, site, prev_days)
    titles = await page_titles(db, site_row)
    for p in t["pages"]:
        p["title"] = titles.get(p["k"])
    seen = await first_seen(db, site)
    return {
        "range": range_key if range_key in RANGES else "30d",
        "enabled": enabled(site_row),
        "live": site_row.get("status") == "live" and bool(site_row.get("live_build_id")),
        "since": iso(seen),
        "daily": t["daily"],
        "totals": {"views": t["views"], "visitors": t["visitors"], "searches": t["searches"],
                   "empty_searches": t["empty_searches"]},
        "previous": prev if seen and seen < since else None,
        "pages": [{"path": p["k"], "title": p.get("title"), "views": p["n"], "visitors": p.get("v", 0)}
                  for p in t["pages"]],
        "referrers": [{"host": r["k"], "views": r["n"]} for r in t["refs"]],
        "countries": [{"country": r["k"], "views": r["n"]} for r in t["countries"]],
        "devices": [{"device": r["k"], "views": r["n"]} for r in t["devices"] if r["k"] in DEVICES],
        "searches": {"top": t["queries"], "empty": t["empty"]},
        "ask": await questions(db, site, since),
        "feedback": await feedback_summary(db, site, since, status=status),
    }


# ── The Guides home ───────────────────────────────────────────────────────────

HOME_DAYS = 7


async def _views_by_day(db: AsyncIOMotorDatabase, sites: list[str], days: list[str]) -> dict[str, dict[str, tuple[int, int]]]:
    """site → day → (views, visitors) over ``days``, for many guides at once: their stored daily
    rows where they exist, the raw events for the rest (today, a day the job hasn't rolled up)."""
    out: dict[str, dict[str, tuple[int, int]]] = {s: {} for s in sites}
    if not sites or not days:
        return out
    today = day_key(now())
    async for r in db[DAILY].find({"site": {"$in": sites}, "day": {"$in": [d for d in days if d < today]}},
                                  {"site": 1, "day": 1, "views": 1, "visitors": 1}):
        out.setdefault(r["site"], {})[r["day"]] = (int(r.get("views") or 0), int(r.get("visitors") or 0))
    missing = [d for d in days if any(d not in out[s] for s in sites)]
    if missing:
        async for r in db[RAW].aggregate([
            {"$match": {"site": {"$in": sites}, "day": {"$in": missing}, "k": "view"}},
            {"$group": {"_id": {"s": "$site", "d": "$day", "v": "$v"}, "n": {"$sum": 1}}},
            {"$group": {"_id": {"s": "$_id.s", "d": "$_id.d"}, "views": {"$sum": "$n"},
                        "visitors": {"$sum": {"$cond": [{"$eq": ["$_id.v", None]}, 0, 1]}}}},
        ]):
            s, d = r["_id"]["s"], r["_id"]["d"]
            if d not in out.setdefault(s, {}):
                out[s][d] = (int(r["views"]), int(r["visitors"]))
    return out


async def _feedback_by_site(db: AsyncIOMotorDatabase, sites: list[str], since: datetime) -> dict[str, tuple[int, int]]:
    out: dict[str, tuple[int, int]] = {}
    if not sites:
        return out
    async for r in db[FEEDBACK].aggregate([
        {"$match": {"site": {"$in": sites}, "ts": {"$gte": since}}},
        {"$group": {"_id": "$site", "yes": {"$sum": {"$cond": ["$helpful", 1, 0]}},
                    "no": {"$sum": {"$cond": ["$helpful", 0, 1]}}}},
    ]):
        out[r["_id"]] = (int(r["yes"]), int(r["no"]))
    return out


async def _ask_by_site(db: AsyncIOMotorDatabase, sites: list[str], since: datetime) -> dict[str, tuple[int, int]]:
    """site → (answered, unanswered) Ask AI questions since ``since``, asked while Insights was on."""
    from app.services import ai_usage, docs_agent

    out: dict[str, tuple[int, int]] = {}
    if not sites:
        return out
    async for r in db[ai_usage.REQUESTS].aggregate([
        {"$match": {"feature": docs_agent.FEATURE, "site": {"$in": sites}, "ts": {"$gte": since}, "insights": True,
                    "outcome": {"$in": ["answered", "no_answer"]}}},
        {"$group": {"_id": "$site", "ok": {"$sum": {"$cond": [{"$eq": ["$outcome", "answered"]}, 1, 0]}},
                    "miss": {"$sum": {"$cond": [{"$eq": ["$outcome", "no_answer"]}, 1, 0]}}}},
    ]):
        out[r["_id"]] = (int(r["ok"]), int(r["miss"]))
    return out


def _pct(yes: int, no: int) -> int | None:
    return round(100 * yes / (yes + no)) if yes + no else None


async def home_summary(db: AsyncIOMotorDatabase, rows: list[dict], today: datetime | None = None) -> dict:
    """GET /docs-sites/insights-summary (the Guides home): the last 7 days across ``rows`` (the
    guides the caller can open) and per guide, in a few queries for all of them.

    A guide with Insights turned off gets ``{"enabled": false}`` and nothing else, and counts in
    none of the totals. A total is null when no guide that has ever been published has Insights
    on (there is nothing it could count), never a made-up 0. Readers are the days' unique visitors
    added up (as on a guide's Insights tab); ``readers_change`` is the % change against the 7 days
    before, null when that week had none."""
    t = (today or now()).astimezone(timezone.utc)
    days = [day_key(t - timedelta(days=i)) for i in range(HOME_DAYS - 1, -1, -1)]
    since = _day_start(days[0])
    prev_days = [day_key(since - timedelta(days=i)) for i in range(HOME_DAYS, 0, -1)]
    on = [r for r in rows if enabled(r)]
    ids = [str(r["_id"]) for r in on]
    by_day = await _views_by_day(db, ids, prev_days + days)
    fb = await _feedback_by_site(db, ids, since)
    ask = await _ask_by_site(db, ids, since)

    sites: dict[str, dict] = {}
    for r in rows:
        sid = str(r["_id"])
        if not enabled(r):
            sites[sid] = {"enabled": False}
            continue
        d = by_day.get(sid, {})
        series = [d.get(day, (0, 0)) for day in days]
        yes, no = fb.get(sid, (0, 0))
        ok, miss = ask.get(sid, (0, 0))
        sites[sid] = {
            "enabled": True,
            "views": [v for v, _ in series],
            "views_total": sum(v for v, _ in series),
            "readers": sum(u for _, u in series),
            "readers_previous": sum(d.get(day, (0, 0))[1] for day in prev_days),
            "helpful_pct": _pct(yes, no),
            "votes": yes + no,
            "ask_answered": ok,
            "ask_unanswered": miss,
        }

    # Only guides that have been live can have readers: a draft's zero isn't a measurement.
    counted = [str(r["_id"]) for r in on if r.get("live_build_id") or r.get("last_published_at")]
    if counted:
        c = [sites[s] for s in counted]
        readers = sum(x["readers"] for x in c)
        prev = sum(x["readers_previous"] for x in c)
        yes = sum(fb.get(s, (0, 0))[0] for s in counted)
        no = sum(fb.get(s, (0, 0))[1] for s in counted)
        totals = {
            "readers": readers,
            "readers_previous": prev,
            "readers_change": round(100 * (readers - prev) / prev) if prev else None,
            "views": sum(x["views_total"] for x in c),
            "ask_answered": sum(x["ask_answered"] for x in c),
            "ask_unanswered": sum(x["ask_unanswered"] for x in c),
            "helpful_pct": _pct(yes, no),
            "votes": yes + no,
        }
    else:
        totals = {k: None for k in ("readers", "readers_previous", "readers_change", "views", "ask_answered",
                                    "ask_unanswered", "helpful_pct", "votes")}
    return {
        "range": f"{HOME_DAYS}d",
        "days": days,
        "guides": len(rows),
        "live": sum(1 for r in rows if r.get("status") == "live" and r.get("live_build_id")),
        "counted": len(counted),
        "insights_off": len(rows) - len(on),
        "totals": totals,
        "sites": sites,
    }


# ── Origins ───────────────────────────────────────────────────────────────────


async def origin_allowed(db: AsyncIOMotorDatabase, site_id: str, origin: str | None) -> bool:
    """Is ``origin`` one of this guide's own live addresses (https)? CORS and the beacons' check."""
    from app.services import docs_sites

    if not origin:
        return False
    try:
        u = urlsplit(origin.strip())
    except ValueError:
        return False
    if u.scheme != "https" or not u.hostname or u.path not in ("", "/"):
        return False
    st = await docs_sites.studio_site(db, site_id)
    return st is not None and u.hostname.lower() in st.hosts


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[RAW].create_index("ts", expireAfterSeconds=RAW_TTL_DAYS * 24 * 3600)
    await db[RAW].create_index([("site", 1), ("day", 1), ("k", 1)])
    await db[RAW].create_index([("day", 1), ("site", 1)])
    await db[DAILY].create_index([("site", 1), ("day", 1)])
    await db[DAILY].create_index("expires_at", expireAfterSeconds=0)
    await db[FEEDBACK].create_index("ts", expireAfterSeconds=FEEDBACK_TTL_DAYS * 24 * 3600)
    await db[FEEDBACK].create_index([("site", 1), ("ts", -1)])
    await db[SALTS].create_index("expires_at", expireAfterSeconds=0)


def reset() -> None:
    """Tests: forget the cached salts and the per-day counters."""
    _salts.clear()
    _counts.clear()

