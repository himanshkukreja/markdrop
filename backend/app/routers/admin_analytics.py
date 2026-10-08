"""Admin analytics center — the queries behind the Analytics tab.

Everything reads the first-party collections written by services/traffic.py,
plus the product's own records (users, documents, share_events, events) for
numbers that should come from the source of truth rather than the browser.

Filters are one dict applied to every traffic query in a request, so all the
numbers on screen always describe the same slice.
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.routers.admin import get_db, require_admin
from app.services.analytics import clean_referrer

router = APIRouter(prefix="/api/v1/admin/analytics", tags=["admin"])

RANGES = {"24h": timedelta(hours=24), "7d": timedelta(days=7), "30d": timedelta(days=30),
          "90d": timedelta(days=90), "12m": timedelta(days=365)}

# filter key → field on traffic_pageviews / traffic_events (sessions share the
# same names; "page" is the one that needs translating for sessions)
FILTER_FIELDS = {
    "page": "path", "entry": "entry_path", "host": "host", "channel": "channel",
    "ref": "ref_host", "utm_source": "utm_source", "utm_medium": "utm_medium",
    "utm_campaign": "utm_campaign", "country": "country", "city": "city",
    "device": "device", "os": "os", "browser": "browser",
    "visitor": "new_visitor", "signed_in": "signed_in",
}


# ── Shared parsing ────────────────────────────────────────────────────────────

class Window:
    def __init__(self, range_key: str, start: str | None, end: str | None, tz: str):
        try:
            self.tz = ZoneInfo(tz)
        except (ZoneInfoNotFoundError, ValueError):
            self.tz = ZoneInfo("UTC")
        self.tz_name = str(self.tz)
        now = datetime.now(timezone.utc)
        if range_key == "custom" and start and end:
            try:
                s = datetime.fromisoformat(start).replace(tzinfo=self.tz)
                e = datetime.fromisoformat(end).replace(tzinfo=self.tz) + timedelta(days=1)
            except ValueError:
                raise HTTPException(422, "Bad custom range")
            self.since, self.until = s.astimezone(timezone.utc), min(e.astimezone(timezone.utc), now)
        else:
            span = RANGES.get(range_key, RANGES["30d"])
            self.until = now
            self.since = now - span
        span = self.until - self.since
        if span <= timedelta(hours=48):
            self.unit = "hour"
        elif span <= timedelta(days=120):
            self.unit = "day"
        else:
            self.unit = "week"
        self.prev_since, self.prev_until = self.since - span, self.since

    def buckets(self) -> list[datetime]:
        """Every bucket start in the window, as UTC instants of local boundaries."""
        local = self.since.astimezone(self.tz)
        if self.unit == "hour":
            cur = local.replace(minute=0, second=0, microsecond=0)
            step = timedelta(hours=1)
        else:
            cur = local.replace(hour=0, minute=0, second=0, microsecond=0)
            if self.unit == "week":
                cur -= timedelta(days=cur.weekday())  # Monday, as Mongo's isoWeek-ish default below
            step = timedelta(days=7 if self.unit == "week" else 1)
        out = []
        while cur < self.until.astimezone(self.tz):
            out.append(cur.astimezone(timezone.utc))
            # step in wall-clock terms, then re-anchor so DST shifts don't drift
            cur = (cur.replace(tzinfo=None) + step).replace(tzinfo=self.tz)
        return out

    def trunc(self, field: str) -> dict:
        spec = {"date": f"${field}", "unit": self.unit, "timezone": self.tz_name}
        if self.unit == "week":
            spec["startOfWeek"] = "monday"
        return {"$dateTrunc": spec}


def parse_filters(raw: str | None) -> dict:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        raise HTTPException(422, "Bad filters")
    out = {}
    for k, v in (data.items() if isinstance(data, dict) else []):
        field = FILTER_FIELDS.get(k)
        if not field:
            continue
        if field in ("new_visitor", "signed_in"):
            v = v in (True, "true", "new", "yes", 1)
        elif v in ("(none)", None):
            v = None
        elif not isinstance(v, str):
            continue
        out[field] = v
    return out


def pv_match(w: Window, f: dict, prev: bool = False) -> dict:
    since, until = (w.prev_since, w.prev_until) if prev else (w.since, w.until)
    return {"ts": {"$gte": since, "$lt": until}, **f}


async def session_match(db, w: Window, f: dict, prev: bool = False) -> dict:
    since, until = (w.prev_since, w.prev_until) if prev else (w.since, w.until)
    m: dict = {"started_at": {"$gte": since, "$lt": until}}
    for field, v in f.items():
        if field == "path":
            sids = await db["traffic_pageviews"].distinct("sid", {"path": v, "ts": {"$gte": since, "$lt": until}})
            m["_id"] = {"$in": sids}
        elif field == "signed_in":
            m["user_id"] = {"$ne": None} if v else None
        else:
            m[field] = v
    return m


def iso(d: datetime | None) -> str | None:
    if d is None:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.isoformat()


async def _count_distinct(coll, match: dict, field: str = "vid") -> int:
    rows = await coll.aggregate([{"$match": match}, {"$group": {"_id": f"${field}"}}, {"$count": "n"}]).to_list(1)
    return rows[0]["n"] if rows else 0


# ── Overview ──────────────────────────────────────────────────────────────────

async def _kpis(db, w: Window, f: dict, prev: bool) -> dict:
    pvm = pv_match(w, f, prev)
    pv = db["traffic_pageviews"]
    visitors = await _count_distinct(pv, pvm)
    pageviews = await pv.count_documents(pvm)
    sm = await session_match(db, w, f, prev)
    agg = await db["traffic_sessions"].aggregate([
        {"$match": sm},
        {"$group": {
            "_id": None,
            "sessions": {"$sum": 1},
            "bounces": {"$sum": {"$cond": [{"$lte": ["$pageviews", 1]}, 1, 0]}},
            "engaged": {"$sum": "$engaged_ms"},
            "engaged_n": {"$sum": {"$cond": [{"$gt": ["$engaged_ms", 0]}, 1, 0]}},
        }},
    ]).to_list(1)
    s = agg[0] if agg else {"sessions": 0, "bounces": 0, "engaged": 0, "engaged_n": 0}
    new_visitors = await _count_distinct(pv, {**pvm, "new_visitor": True})
    signed_in = await _count_distinct(pv, {**pvm, "signed_in": True})
    return {
        "visitors": visitors,
        "pageviews": pageviews,
        "sessions": s["sessions"],
        "views_per_session": round(pageviews / s["sessions"], 2) if s["sessions"] else 0,
        "bounce_rate": round(100 * s["bounces"] / s["sessions"], 1) if s["sessions"] else 0,
        "avg_duration_s": round(s["engaged"] / s["engaged_n"] / 1000) if s["engaged_n"] else 0,
        "new_visitors": new_visitors,
        "returning_visitors": max(0, visitors - new_visitors),
        "signed_in_visitors": signed_in,
    }


async def _series(db, w: Window, f: dict) -> list[dict]:
    rows = await db["traffic_pageviews"].aggregate([
        {"$match": pv_match(w, f)},
        {"$group": {"_id": w.trunc("ts"), "pageviews": {"$sum": 1}, "v": {"$addToSet": "$vid"}}},
        {"$project": {"pageviews": 1, "visitors": {"$size": "$v"}}},
    ]).to_list(None)
    srows = await db["traffic_sessions"].aggregate([
        {"$match": await session_match(db, w, f)},
        {"$group": {"_id": w.trunc("started_at"), "sessions": {"$sum": 1}}},
    ]).to_list(None)
    key = lambda d: iso(d)  # noqa: E731
    by = {key(r["_id"]): r for r in rows}
    sby = {key(r["_id"]): r["sessions"] for r in srows}
    return [
        {"t": iso(b), "visitors": by.get(iso(b), {}).get("visitors", 0),
         "pageviews": by.get(iso(b), {}).get("pageviews", 0), "sessions": sby.get(iso(b), 0)}
        for b in w.buckets()
    ]


async def _breakdown_pv(db, w: Window, f: dict, field: str, limit: int = 50) -> list[dict]:
    rows = await db["traffic_pageviews"].aggregate([
        {"$match": pv_match(w, f)},
        {"$group": {"_id": f"${field}", "pageviews": {"$sum": 1}, "v": {"$addToSet": "$vid"}}},
        {"$project": {"pageviews": 1, "visitors": {"$size": "$v"}}},
        {"$sort": {"visitors": -1, "pageviews": -1}},
        {"$limit": limit},
    ]).to_list(None)
    return [{"key": r["_id"], "visitors": r["visitors"], "pageviews": r["pageviews"]} for r in rows]


async def _breakdown_sessions(db, w: Window, f: dict, field: str, limit: int = 50) -> list[dict]:
    rows = await db["traffic_sessions"].aggregate([
        {"$match": await session_match(db, w, f)},
        {"$group": {
            "_id": f"${field}", "sessions": {"$sum": 1},
            "bounces": {"$sum": {"$cond": [{"$lte": ["$pageviews", 1]}, 1, 0]}},
            "v": {"$addToSet": "$vid"},
        }},
        {"$project": {"sessions": 1, "bounces": 1, "visitors": {"$size": "$v"}}},
        {"$sort": {"sessions": -1}},
        {"$limit": limit},
    ]).to_list(None)
    return [{"key": r["_id"], "visitors": r["visitors"], "sessions": r["sessions"],
             "bounce_rate": round(100 * r["bounces"] / r["sessions"], 1) if r["sessions"] else 0}
            for r in rows]


@router.get("/overview")
async def overview(
    range_: str = Query("30d", alias="range"),
    start: str | None = None,
    end: str | None = None,
    tz: str = "UTC",
    filters: str | None = None,
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    w = Window(range_, start, end, tz)
    f = parse_filters(filters)
    pv_fields = {
        "pages": "path", "ref_host": "ref_host", "channel": "channel",
        "utm_source": "utm_source", "utm_medium": "utm_medium", "utm_campaign": "utm_campaign",
        "country": "country", "city": "city", "device": "device", "browser": "browser",
        "os": "os", "host": "host",
    }
    breakdowns = {name: await _breakdown_pv(db, w, f, field) for name, field in pv_fields.items()}
    breakdowns["entry"] = await _breakdown_sessions(db, w, f, "entry_path")
    breakdowns["exit"] = await _breakdown_sessions(db, w, f, "exit_path")
    return {
        "range": {"since": iso(w.since), "until": iso(w.until), "unit": w.unit, "tz": w.tz_name},
        "filters": {k: v for k, v in f.items()},
        "kpis": await _kpis(db, w, f, prev=False),
        "prev": await _kpis(db, w, f, prev=True),
        "series": await _series(db, w, f),
        "breakdowns": breakdowns,
    }


# ── Product (source of truth, unfiltered by traffic filters) ─────────────────

@router.get("/product")
async def product(
    range_: str = Query("30d", alias="range"),
    start: str | None = None,
    end: str | None = None,
    tz: str = "UTC",
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    w = Window(range_, start, end, tz)
    sources = {
        "signups": ("users", "created_at", {}),
        "documents": ("documents", "created_at", {"kind": {"$ne": "artifact"}}),
        "artifacts": ("documents", "created_at", {"kind": "artifact"}),
        "file_shares": ("share_events", "ts", {}),
        "workspaces": ("workspaces", "created_at", {}),
    }
    metrics = {}
    for name, (coll, field, extra) in sources.items():
        rows = await db[coll].aggregate([
            {"$match": {field: {"$gte": w.since, "$lt": w.until}, **extra}},
            {"$group": {"_id": w.trunc(field), "n": {"$sum": 1}}},
        ]).to_list(None)
        by = {iso(r["_id"]): r["n"] for r in rows}
        prev = await db[coll].count_documents({field: {"$gte": w.prev_since, "$lt": w.prev_until}, **extra})
        series = [{"t": iso(b), "n": by.get(iso(b), 0)} for b in w.buckets()]
        metrics[name] = {"total": sum(p["n"] for p in series), "prev": prev, "series": series}

    # Active signed-in users: distinct accounts seen by the tracker, or that
    # logged in, within the window.
    seen = set(await db["traffic_sessions"].distinct("user_id", {"last_seen": {"$gte": w.since}, "user_id": {"$ne": None}}))
    async for u in db["users"].find({"last_login_at": {"$gte": w.since}}, {"_id": 1}):
        seen.add(str(u["_id"]))
    metrics["active_users"] = {"total": len(seen)}
    return {"range": {"since": iso(w.since), "until": iso(w.until), "unit": w.unit}, "metrics": metrics}


# ── Documents (from per-document view events) ─────────────────────────────────

@router.get("/documents")
async def top_documents(
    range_: str = Query("30d", alias="range"),
    start: str | None = None,
    end: str | None = None,
    tz: str = "UTC",
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    w = Window(range_, start, end, tz)
    match = {"type": "view", "ts": {"$gte": w.since, "$lt": w.until}}
    rows = await db["events"].aggregate([
        {"$match": match},
        {"$group": {"_id": "$doc_id", "views": {"$sum": 1}, "v": {"$addToSet": "$ip_hash"}}},
        {"$project": {"views": 1, "visitors": {"$size": "$v"}}},
        {"$sort": {"views": -1}},
        {"$limit": 25},
    ]).to_list(None)
    ids = [ObjectId(r["_id"]) for r in rows if ObjectId.is_valid(r["_id"])]
    docs = {str(d["_id"]): d async for d in db["documents"].find(
        {"_id": {"$in": ids}}, {"slug": 1, "title": 1, "kind": 1, "encrypted": 1, "original_filename": 1})}

    # Where each document's views came from (recorded since the referrer fix).
    refs: dict[str, list] = defaultdict(list)
    async for r in db["events"].aggregate([
        {"$match": {**match, "doc_id": {"$in": [r["_id"] for r in rows]}, "referrer": {"$ne": None}}},
        {"$group": {"_id": {"d": "$doc_id", "r": "$referrer"}, "n": {"$sum": 1}}},
        {"$sort": {"n": -1}},
    ]):
        refs[r["_id"]["d"]].append({"referrer": r["_id"]["r"], "views": r["n"]})

    out = []
    for r in rows:
        d = docs.get(r["_id"], {})
        hosts: dict[str, int] = defaultdict(int)
        for ref in refs.get(r["_id"], []):
            c = clean_referrer(ref["referrer"])
            if c:
                hosts[urlsplit(c).hostname or c] += ref["views"]
        out.append({
            "doc_id": r["_id"],
            "slug": d.get("slug"),
            "title": None if d.get("encrypted") else (d.get("title") or d.get("original_filename")),
            "encrypted": bool(d.get("encrypted")),
            "kind": d.get("kind", "markdown"),
            "views": r["views"],
            "visitors": r["visitors"],
            "referrers": sorted(({"host": h, "views": n} for h, n in hosts.items()), key=lambda x: -x["views"])[:5],
        })

    # All document-view referrers in the window, by host.
    hosts_all: dict[str, int] = defaultdict(int)
    async for r in db["events"].aggregate([
        {"$match": {**match, "referrer": {"$ne": None}}},
        {"$group": {"_id": "$referrer", "n": {"$sum": 1}}},
    ]):
        c = clean_referrer(r["_id"])
        if c:
            hosts_all[urlsplit(c).hostname or c] += r["n"]
    return {
        "documents": out,
        "referrers": sorted(({"host": h, "views": n} for h, n in hosts_all.items()), key=lambda x: -x["views"])[:25],
    }


# ── Realtime ──────────────────────────────────────────────────────────────────

@router.get("/realtime")
async def realtime(db: AsyncIOMotorDatabase = Depends(get_db), _: dict = Depends(require_admin)):
    since = datetime.now(timezone.utc) - timedelta(minutes=5)
    sessions = await db["traffic_sessions"].find(
        {"last_seen": {"$gte": since}},
        {"vid": 1, "exit_path": 1, "channel": 1, "ref_host": 1, "country": 1, "city": 1, "device": 1, "last_seen": 1},
    ).sort("last_seen", -1).to_list(500)
    pages: dict[str, int] = defaultdict(int)
    sources: dict[str, int] = defaultdict(int)
    for s in sessions:
        pages[s.get("exit_path") or "/"] += 1
        sources[s.get("ref_host") or s.get("channel") or "Direct"] += 1
    recent = await db["traffic_pageviews"].find(
        {"ts": {"$gte": since}}, {"path": 1, "country": 1, "city": 1, "device": 1, "ts": 1, "channel": 1},
    ).sort("ts", -1).to_list(20)
    top = lambda d: sorted(({"key": k, "n": v} for k, v in d.items()), key=lambda x: -x["n"])[:8]  # noqa: E731
    return {
        "visitors": len({s["vid"] for s in sessions}),
        "pages": top(pages),
        "sources": top(sources),
        "recent": [{"path": p["path"], "country": p.get("country"), "city": p.get("city"),
                    "device": p.get("device"), "channel": p.get("channel"), "ts": iso(p["ts"])} for p in recent],
    }


# ── Product events ────────────────────────────────────────────────────────────

@router.get("/events")
async def events(
    range_: str = Query("30d", alias="range"),
    start: str | None = None,
    end: str | None = None,
    tz: str = "UTC",
    filters: str | None = None,
    name: str | None = None,
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    w = Window(range_, start, end, tz)
    f = parse_filters(filters)
    match = pv_match(w, f)
    rows = await db["traffic_events"].aggregate([
        {"$match": match},
        {"$group": {"_id": "$name", "count": {"$sum": 1}, "v": {"$addToSet": "$vid"}}},
        {"$project": {"count": 1, "visitors": {"$size": "$v"}}},
        {"$sort": {"count": -1}},
    ]).to_list(None)
    out: dict = {"events": [{"name": r["_id"], "count": r["count"], "visitors": r["visitors"]} for r in rows]}
    if name:
        props: dict[str, dict] = defaultdict(lambda: defaultdict(int))
        async for e in db["traffic_events"].find({**match, "name": name}, {"props": 1}):
            for k, v in (e.get("props") or {}).items():
                props[k][("yes" if v else "no") if isinstance(v, bool) else str(v)] += 1
        out["props"] = {k: sorted(({"value": vv, "n": n} for vv, n in d.items()), key=lambda x: -x["n"])[:15]
                        for k, d in props.items()}
    return out


# ── Funnels ───────────────────────────────────────────────────────────────────

@router.get("/funnel")
async def funnel(
    steps: str,
    range_: str = Query("30d", alias="range"),
    start: str | None = None,
    end: str | None = None,
    tz: str = "UTC",
    filters: str | None = None,
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """Visitors who did each step, in order, within the window.

    A step is {"t": "visit"} (any page view), {"t": "page", "v": "/new"} or
    {"t": "event", "v": "doc_published"}. Order is by time per visitor: a step
    only counts if it happened after the previous one.
    """
    try:
        spec = json.loads(steps)
        assert isinstance(spec, list) and 2 <= len(spec) <= 6
        spec = [{"t": s["t"], "v": s.get("v")} for s in spec]
        assert all(s["t"] in ("visit", "page", "event") for s in spec)
    except (ValueError, AssertionError, KeyError, TypeError):
        raise HTTPException(422, "steps must be 2-6 of {t: visit|page|event, v}")
    w = Window(range_, start, end, tz)
    f = parse_filters(filters)
    match = pv_match(w, f)

    timeline: dict[str, list] = defaultdict(list)
    pages = [s["v"] for s in spec if s["t"] == "page"]
    any_visit = any(s["t"] == "visit" for s in spec)
    pv_q = match if any_visit else {**match, "path": {"$in": pages}}
    if any_visit or pages:
        async for p in db["traffic_pageviews"].find(pv_q, {"vid": 1, "ts": 1, "path": 1}):
            timeline[p["vid"]].append((p["ts"], "page", p["path"]))
    names = [s["v"] for s in spec if s["t"] == "event"]
    if names:
        async for e in db["traffic_events"].find({**match, "name": {"$in": names}}, {"vid": 1, "ts": 1, "name": 1}):
            timeline[e["vid"]].append((e["ts"], "event", e["name"]))

    counts = [0] * len(spec)
    for items in timeline.values():
        items.sort(key=lambda x: x[0])
        i = 0
        for _, kind, value in items:
            s = spec[i]
            hit = (s["t"] == "visit" and kind == "page") or (s["t"] == kind and s["v"] == value)
            if hit:
                counts[i] += 1
                i += 1
                if i == len(spec):
                    break
    first = counts[0] or 1
    return {"steps": [
        {**s, "visitors": n,
         "from_start": round(100 * n / first, 1),
         "from_prev": round(100 * n / counts[i - 1], 1) if i and counts[i - 1] else (100.0 if i == 0 else 0.0)}
        for i, (s, n) in enumerate(zip(spec, counts))
    ]}


# ── Retention ─────────────────────────────────────────────────────────────────

@router.get("/retention")
async def retention(
    weeks: int = Query(8, ge=2, le=26),
    tz: str = "UTC",
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """Weekly cohorts by first visit: what share came back in each later week.

    Visitors whose browser asked not to be tracked across days (GPC/DNT) have
    a fresh id every session and would read as never returning, so they are
    left out rather than dragging every cohort down.
    """
    try:
        zone = ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo("UTC")
    today = datetime.now(zone).replace(hour=0, minute=0, second=0, microsecond=0)
    week0 = today - timedelta(days=today.weekday()) - timedelta(weeks=weeks - 1)
    start_utc = week0.astimezone(timezone.utc)

    def week_of(d: datetime) -> int:
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return (d.astimezone(zone) - week0).days // 7

    cohorts: dict[int, set] = defaultdict(set)
    async for v in db["traffic_visitors"].find({"first_seen": {"$gte": start_utc}, "ephemeral": {"$ne": True}},
                                                {"first_seen": 1}):
        cohorts[week_of(v["first_seen"])].add(v["_id"])
    active: dict[str, set] = defaultdict(set)
    async for s in db["traffic_sessions"].find({"started_at": {"$gte": start_utc}}, {"vid": 1, "started_at": 1}):
        active[s["vid"]].add(week_of(s["started_at"]))

    rows = []
    for c in range(weeks):
        members = cohorts.get(c, set())
        size = len(members)
        cells = []
        for k in range(weeks - c):
            n = sum(1 for vid in members if (c + k) in active.get(vid, ()))
            cells.append({"n": n, "pct": round(100 * n / size, 1) if size else 0})
        rows.append({"week": iso((week0 + timedelta(weeks=c)).astimezone(timezone.utc)), "size": size, "cells": cells})
    return {"cohorts": rows}
