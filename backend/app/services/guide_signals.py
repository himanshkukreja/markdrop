"""Reader signals for Markdrop Guides: how far readers get down a page, where videos lose their
viewers, which code gets copied, and the guide's broken links. What the Fix list
(services/guide_fixes.py) reads, next to Insights' own page views, searches, feedback and Ask AI
questions (services/guide_insights.py).

Same rules as Insights. First-party, cookieless, nothing stored in the reader's browser, no
visitor hash at all (a signal is never tied to a reader, not even for a day), no text a reader
typed, no address, no user agent. The engine (frontend/src/docs/client/Signals.tsx) sends nothing
when the browser asks not to be tracked (Do Not Track, Global Privacy Control), and the API drops a
beacon that carries either header too. Only a guide with Insights on has the endpoint in its
site.json, and a beacon for a guide with Insights off is dropped here.

One beacon per page view, sent when the reader leaves the page (or after a while on it), so a
reading session costs one request:

    {k: "read", p, n, d, h?, t?, w?, c?, v?}
        p   the page path
        n   how many sections (h2/h3 headings in the article) the page has
        d   the deepest section the reader reached: -1 = still in the introduction, 0..n-1 a
            section (by its place on the page), n = the end of the page
        h   that section's heading id (the slug of the heading the author wrote)
        t   seconds the page was on screen (capped)
        w   the sampling weight (1 = every view is measured; a guide sampling 1 in 4 sends 4)
        c   copy-code clicks: [[section index, code block index on the page], ...]
        v   videos played: [{i: video id, l: length in seconds, b: 40 watched slices as 10 hex digits}]
    {k: "broken", p, f?}
        a page that doesn't exist (the guide's 404 page): p the address, f the guide page the
        reader came from (same guide only, path only)

Storage: the beacons are raw events in ``guide_events`` (kind ``read`` / ``broken``, 90 days,
like the rest of Insights); a background job rolls each complete day into ``guide_signal_daily``
(13 months): per page a histogram of how deep readers got, per video a retention curve, per code
block its copies, per missing address its hits.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import guide_insights as gi

log = logging.getLogger("markdrop.guide_signals")

DAILY = "guide_signal_daily"
KINDS = ("read", "broken")
MAX_SECTIONS = 200
MAX_COPIES = 20
MAX_VIDEOS = 6
SLICES = 40                 # a video's watched slices (2.5% each)
MAX_SECONDS = 4 * 3600
MAX_WEIGHT = 20
ROLLUP_KEEP = 500

_ID = re.compile(r"^[\w\-.:~%]{1,120}$", re.UNICODE)
_HEX = re.compile(r"^[0-9a-f]{10}$")


def now() -> datetime:
    return gi.now()


# ── Cleaning a beacon ─────────────────────────────────────────────────────────


def _int(v: Any, lo: int, hi: int) -> int | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    try:
        n = int(v)
    except (OverflowError, ValueError):
        return None
    return n if lo <= n <= hi else None


def clean_id(v: Any) -> str | None:
    """A heading or video id: the author's slug, nothing a reader typed."""
    if not isinstance(v, str):
        return None
    v = v.strip()
    return v if _ID.match(v) else None


def watched(hexstr: Any) -> list[int] | None:
    """10 hex digits → the indexes (0..39) of the slices watched; None when malformed or empty."""
    if not isinstance(hexstr, str) or not _HEX.match(hexstr.lower()):
        return None
    bits = int(hexstr, 16)
    out = [i for i in range(SLICES) if bits >> i & 1]
    return out or None


def clean_read(body: dict) -> dict | None:
    """A "read" beacon as stored (minus site and time), or None when it can't be used."""
    p = gi.clean_path(body.get("p"))
    n = _int(body.get("n"), 0, MAX_SECTIONS)
    if p is None or n is None:
        return None
    d = _int(body.get("d"), -1, n)
    if d is None:
        return None
    out: dict = {"p": p, "n": n, "d": d, "w": _int(body.get("w"), 1, MAX_WEIGHT) or 1}
    h = clean_id(body.get("h"))
    if h and 0 <= d < n:
        out["h"] = h
    t = _int(body.get("t"), 0, 10**7)
    if t is not None:
        out["t"] = min(t, MAX_SECONDS)
    copies = []
    for c in (body.get("c") or [])[:MAX_COPIES] if isinstance(body.get("c"), list) else []:
        if isinstance(c, list) and len(c) == 2:
            s, b = _int(c[0], -1, MAX_SECTIONS), _int(c[1], 0, 1000)
            if s is not None and b is not None:
                copies.append([s, b])
    if copies:
        out["c"] = copies
    vids = []
    for v in (body.get("v") or [])[:MAX_VIDEOS] if isinstance(body.get("v"), list) else []:
        if not isinstance(v, dict):
            continue
        vid, length, slices = clean_id(v.get("i")), _int(v.get("l"), 1, 6 * 3600), watched(v.get("b"))
        if vid and length and slices:
            vids.append({"i": vid, "l": length, "b": slices})
    if vids:
        out["v"] = vids
    return out


def clean_broken(body: dict) -> dict | None:
    p = gi.clean_path(body.get("p"))
    if p is None or p == "/":
        return None
    f = gi.clean_path(body.get("f")) if body.get("f") else None
    return {"p": p, "f": f if f != p else None}


async def record(db: AsyncIOMotorDatabase, site: str, kind: str, data: dict) -> bool:
    ts = now()
    day = gi.day_key(ts)
    if not gi._within_cap(site, day):
        return False
    await db[gi.RAW].insert_one({"site": site, "k": kind, "ts": ts, "day": day, **data})
    return True


# ── Rollups ───────────────────────────────────────────────────────────────────


def _facets() -> list[dict]:
    return [{"$facet": {
        "reading": [
            {"$match": {"k": "read"}},
            {"$group": {"_id": {"p": "$p", "d": "$d"}, "m": {"$sum": "$w"}, "n": {"$max": "$n"},
                        "h": {"$first": "$h"}, "t": {"$sum": {"$multiply": [{"$ifNull": ["$t", 0]}, "$w"]}}}},
        ],
        "copies": [
            {"$match": {"k": "read", "c": {"$exists": True}}},
            {"$unwind": "$c"},
            {"$group": {"_id": {"p": "$p", "s": {"$arrayElemAt": ["$c", 0]}, "b": {"$arrayElemAt": ["$c", 1]}},
                        "n": {"$sum": "$w"}}},
            {"$sort": {"n": -1}}, {"$limit": ROLLUP_KEEP},
        ],
        "videos": [
            {"$match": {"k": "read", "v": {"$exists": True}}},
            {"$unwind": "$v"},
            {"$group": {"_id": {"i": "$v.i", "p": "$p"}, "plays": {"$sum": "$w"}, "l": {"$max": "$v.l"}}},
            {"$sort": {"plays": -1}}, {"$limit": 200},
        ],
        "slices": [
            {"$match": {"k": "read", "v": {"$exists": True}}},
            {"$unwind": "$v"},
            {"$unwind": "$v.b"},
            {"$group": {"_id": {"i": "$v.i", "p": "$p", "s": "$v.b"}, "n": {"$sum": "$w"}}},
        ],
        "broken": [
            {"$match": {"k": "broken"}},
            {"$group": {"_id": {"p": "$p", "f": "$f"}, "n": {"$sum": 1}, "last": {"$max": "$ts"}}},
            {"$sort": {"n": -1}}, {"$limit": ROLLUP_KEEP},
        ],
    }}]


def _shape(f: dict) -> dict:
    """The facet output → {reading, copies, videos, broken} as stored in a daily row."""
    pages: dict[str, dict] = {}
    for r in f.get("reading") or []:
        p, d = r["_id"]["p"], r["_id"]["d"]
        if p is None or d is None:
            continue
        pg = pages.setdefault(p, {"p": p, "n": 0, "m": 0, "t": 0, "hist": {}, "ids": {}})
        pg["n"] = max(pg["n"], int(r.get("n") or 0))
        pg["m"] += int(r["m"])
        pg["t"] += int(r.get("t") or 0)
        pg["hist"][str(d)] = pg["hist"].get(str(d), 0) + int(r["m"])
        if r.get("h"):
            pg["ids"][str(d)] = r["h"]
    curves: dict[tuple, list[int]] = {}
    for r in f.get("slices") or []:
        key = (r["_id"]["i"], r["_id"]["p"])
        i = r["_id"].get("s")
        if isinstance(i, int) and 0 <= i < SLICES:
            curves.setdefault(key, [0] * SLICES)[i] += int(r["n"])
    videos = [{"i": r["_id"]["i"], "p": r["_id"]["p"], "l": int(r.get("l") or 0), "plays": int(r["plays"]),
               "curve": curves.get((r["_id"]["i"], r["_id"]["p"]), [0] * SLICES)}
              for r in f.get("videos") or [] if r["_id"].get("i")]
    return {
        "reading": sorted(pages.values(), key=lambda x: -x["m"])[:ROLLUP_KEEP],
        "copies": [{"p": r["_id"]["p"], "s": r["_id"]["s"], "b": r["_id"]["b"], "n": int(r["n"])}
                   for r in f.get("copies") or [] if r["_id"].get("p")],
        "videos": videos,
        "broken": [{"p": r["_id"]["p"], "f": r["_id"].get("f"), "n": int(r["n"]), "last": r.get("last")}
                   for r in f.get("broken") or [] if r["_id"].get("p")],
    }


async def _aggregate(db: AsyncIOMotorDatabase, site: str, days: list[str], since: datetime | None = None) -> dict:
    if not days:
        return _shape({})
    match: dict = {"site": site, "day": {"$in": days}, "k": {"$in": list(KINDS)}}
    if since is not None:
        match["ts"] = {"$gte": since}
    rows = await db[gi.RAW].aggregate([{"$match": match}, *_facets()]).to_list(1)
    return _shape(rows[0] if rows else {})


async def rollup_day(db: AsyncIOMotorDatabase, site: str, day: str) -> dict:
    row = {"site": site, "day": day, **(await _aggregate(db, site, [day])), "rolled_at": now(),
           "expires_at": gi._day_start(day) + timedelta(days=gi.ROLLUP_TTL_DAYS)}
    await db[DAILY].replace_one({"_id": f"{site}:{day}"}, {"_id": f"{site}:{day}", **row}, upsert=True)
    return row


async def rollup_due(db: AsyncIOMotorDatabase, today: datetime | None = None) -> int:
    """Roll up every guide with signal events on one of the last few complete days that has no
    signal row for it yet."""
    t = (today or now()).astimezone(timezone.utc)
    written = 0
    for i in range(1, gi.ROLLUP_LOOKBACK_DAYS + 1):
        day = gi.day_key(t - timedelta(days=i))
        sites = set(await db[gi.RAW].distinct("site", {"day": day, "k": {"$in": list(KINDS)}}))
        if not sites:
            continue
        done = set(await db[DAILY].distinct("site", {"day": day}))
        for site in sorted(sites - done):
            try:
                await rollup_day(db, site, day)
                written += 1
            except Exception:
                log.warning("signals rollup failed for %s %s", site, day, exc_info=True)
    return written


# ── Reading a window ──────────────────────────────────────────────────────────


def merge(parts: list[dict]) -> dict:
    """Daily rows (and today's live aggregate) → one window: reading per page, copies per block,
    a retention curve per video (summed over the pages it is on), hits per missing address."""
    pages: dict[str, dict] = {}
    copies: dict[tuple, dict] = {}
    videos: dict[str, dict] = {}
    broken: dict[tuple, dict] = {}
    for part in parts:
        for r in part.get("reading") or []:
            pg = pages.setdefault(r["p"], {"p": r["p"], "n": 0, "m": 0, "t": 0, "hist": {}, "ids": {}})
            pg["n"] = max(pg["n"], int(r.get("n") or 0))
            pg["m"] += int(r.get("m") or 0)
            pg["t"] += int(r.get("t") or 0)
            for d, c in (r.get("hist") or {}).items():
                pg["hist"][d] = pg["hist"].get(d, 0) + int(c)
            for d, h in (r.get("ids") or {}).items():
                pg["ids"][d] = h
        for r in part.get("copies") or []:
            key = (r["p"], r.get("s"), r.get("b"))
            c = copies.setdefault(key, {"p": r["p"], "s": r.get("s"), "b": r.get("b"), "n": 0})
            c["n"] += int(r.get("n") or 0)
        for r in part.get("videos") or []:
            v = videos.setdefault(r["i"], {"i": r["i"], "pages": {}, "l": 0, "plays": 0, "curve": [0] * SLICES})
            v["l"] = max(v["l"], int(r.get("l") or 0))
            v["plays"] += int(r.get("plays") or 0)
            v["pages"][r.get("p")] = v["pages"].get(r.get("p"), 0) + int(r.get("plays") or 0)
            for i, c in enumerate((r.get("curve") or [])[:SLICES]):
                v["curve"][i] += int(c)
        for r in part.get("broken") or []:
            key = (r["p"], r.get("f"))
            b = broken.setdefault(key, {"p": r["p"], "f": r.get("f"), "n": 0, "last": None})
            b["n"] += int(r.get("n") or 0)
            last = r.get("last")
            if last is not None:
                last = last if last.tzinfo else last.replace(tzinfo=timezone.utc)
                b["last"] = max(b["last"], last) if b["last"] else last
    return {"reading": pages, "copies": list(copies.values()), "videos": videos, "broken": list(broken.values())}


async def window(db: AsyncIOMotorDatabase, site: str, days: list[str]) -> dict:
    """Signals over ``days``: stored daily rows where they exist, raw events for the rest."""
    today = gi.day_key(now())
    stored = {r["day"]: r async for r in db[DAILY].find({"site": site, "day": {"$in": [d for d in days if d < today]}})}
    for r in stored.values():
        for b in r.get("broken") or []:
            if b.get("last") is None:
                b["last"] = gi._day_start(r["day"]) + timedelta(hours=12)
    live = await _aggregate(db, site, [d for d in days if d not in stored])
    return merge([*stored.values(), live])


async def clear(db: AsyncIOMotorDatabase, site: str) -> int:
    return (await db[DAILY].delete_many({"site": site})).deleted_count


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[DAILY].create_index([("site", 1), ("day", 1)])
    await db[DAILY].create_index("expires_at", expireAfterSeconds=0)
