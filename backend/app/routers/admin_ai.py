"""Admin → AI: usage, tokens, cost and quality of every AI feature.

Reads the generic ledger (`ai_requests`, services/ai_usage.py), the exact spend
counters (`ai_spend`) and the docs site's page votes (`docs_feedback`). Same
admin JWT as every other admin tab (routers/admin.require_admin).

Raw IPs are never stored, so never shown: a signed-out asker appears as the
first 8 characters of their salted IP hash.

Docs Ask AI serves several docs sites (services/docs_sites.py). Every list
takes an optional `site` filter (none: every site), rows say which site they
came from, and the overview adds `by_site`: questions, outcomes, spend and caps
per site. Rows written before sites existed count as "markdrop".

Aggregation happens in Python over one window's rows (projected, no answers):
the budget caps keep this collection small (a $50 month at Haiku prices is a
few thousand questions), and it keeps the numbers identical under mongomock.
"""

from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel

from app.config import get_settings
from app.routers.admin import get_db, require_admin
from app.services import ai_usage, docs_agent, docs_sites

router = APIRouter(prefix="/api/v1/admin/ai", tags=["admin"])

RANGES = {"24h": timedelta(hours=24), "7d": timedelta(days=7), "30d": timedelta(days=30), "90d": timedelta(days=90)}
ROW_CAP = 50_000
OUTCOMES = ("answered", "no_answer", "off_topic", "refused", "limit", "error")
_LIST_FIELDS = {"answer": 0, "citations": 0}


def _tz(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def _window(range_key: str) -> tuple[datetime, datetime, str]:
    key = range_key if range_key in RANGES else "30d"
    until = datetime.now(timezone.utc)
    return until - RANGES[key], until, key


def _aware(d: datetime | None) -> datetime | None:
    if d is None:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _iso(d: datetime | None) -> str | None:
    d = _aware(d)
    return d.isoformat() if d else None


def _pct(xs: list[float], p: float) -> int | None:
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    k = max(0, min(len(xs) - 1, math.ceil(p / 100 * len(xs)) - 1))
    return int(xs[k])


def _ratio(a: int, b: int) -> float | None:
    return round(100 * a / b, 1) if b else None


def normalize_question(q: str) -> str:
    q = re.sub(r"[^\w\s]", " ", (q or "").lower())
    return re.sub(r"\s+", " ", q).strip()[:160]


def _visitor_label(row: dict, emails: dict[str, str]) -> str:
    uid = row.get("user_id")
    if uid:
        return emails.get(uid) or f"Account {uid[-6:]}"
    h = row.get("ip_hash") or ""
    return f"Visitor {h[:8]}" if h else "Visitor"


async def _emails(db, ids: set[str]) -> dict[str, str]:
    oids = []
    for i in ids:
        try:
            oids.append(ObjectId(i))
        except Exception:
            continue
    if not oids:
        return {}
    rows = await db["users"].find({"_id": {"$in": oids}}, {"email": 1}).to_list(length=len(oids))
    return {str(r["_id"]): r.get("email") or "" for r in rows}


def _site_param(site: str | None) -> str | None:
    """A `site` filter: None for every site; a malformed id is a 404."""
    if site is None or not site.strip():
        return None
    sid = docs_sites.normalize_id(site)
    if sid is None:
        raise HTTPException(404, "Unknown docs site")
    return sid


def _site_of(row: dict) -> str:
    return row.get("site") or ai_usage.LEGACY_SITE


async def _rows(db, feature: str | None, since: datetime, until: datetime, projection: dict | None = None,
                site: str | None = None) -> list[dict]:
    q: dict = {"ts": {"$gte": since, "$lt": until}, **ai_usage.site_filter(site)}
    if feature:
        q["feature"] = feature
    if projection:
        projection = {**projection, "site": 1}
    return await db[ai_usage.REQUESTS].find(q, projection or _LIST_FIELDS).sort("ts", -1).to_list(length=ROW_CAP)


def _days(since: datetime, until: datetime, tz: ZoneInfo) -> list[str]:
    cur = since.astimezone(tz).date()
    end = until.astimezone(tz).date()
    out = []
    while cur <= end:
        out.append(cur.isoformat())
        cur += timedelta(days=1)
    return out


# ── Overview ──────────────────────────────────────────────────────────────────


@router.get("/overview")
async def overview(
    range_: str = Query("30d", alias="range"),
    tz: str = "UTC",
    feature: str = Query(docs_agent.FEATURE, max_length=40),
    site: str | None = Query(None, max_length=64),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    s = get_settings()
    site = _site_param(site)
    since, until, key = _window(range_)
    zone = _tz(tz)
    all_rows = await _rows(db, None, since, until)
    feature_rows = [r for r in all_rows if r.get("feature") == feature]
    rows = [r for r in feature_rows if site is None or _site_of(r) == site]
    served = [r for r in rows if r.get("outcome") != "limit"]
    tokens = Counter()
    for r in rows:
        for k, v in (r.get("usage") or {}).items():
            tokens[k] += int(v or 0)
    prompt_total = tokens["input"] + tokens["cache_read"] + tokens["cache_write_5m"] + tokens["cache_write_1h"]
    rated = [r for r in rows if isinstance(r.get("feedback"), dict)]
    helpful = sum(1 for r in rated if r["feedback"].get("helpful"))
    outcomes = Counter(r.get("outcome") or "error" for r in rows)
    answered = outcomes["answered"]

    # Daily series in the admin's time zone.
    days = _days(since, until, zone)
    per_day: dict[str, dict] = {d: {"t": d, "questions": 0, "answered": 0, "cost_usd": 0.0, "tokens": 0} for d in days}
    for r in rows:
        ts = _aware(r.get("ts"))
        d = ts.astimezone(zone).date().isoformat() if ts else None
        if d in per_day:
            b = per_day[d]
            b["questions"] += 1
            b["answered"] += r.get("outcome") == "answered"
            b["cost_usd"] += float(r.get("cost_usd") or 0)
            u = r.get("usage") or {}
            b["tokens"] += sum(int(u.get(k) or 0) for k in ("input", "output", "cache_read", "cache_write_5m", "cache_write_1h"))
    for b in per_day.values():
        b["cost_usd"] = round(b["cost_usd"], 6)

    # Tools.
    tool_stats: dict[str, dict] = defaultdict(lambda: {"calls": 0, "errors": 0, "ms": 0, "questions": 0})
    for r in rows:
        seen = set()
        for t in r.get("tools") or []:
            name = t.get("name") or "?"
            st = tool_stats[name]
            st["calls"] += 1
            st["errors"] += bool(t.get("error"))
            st["ms"] += int(t.get("ms") or 0)
            if name not in seen:
                st["questions"] += 1
                seen.add(name)
    tools = sorted(({"name": n, "calls": v["calls"], "errors": v["errors"], "questions": v["questions"],
                     "avg_ms": round(v["ms"] / v["calls"]) if v["calls"] else 0} for n, v in tool_stats.items()),
                   key=lambda x: -x["calls"])
    rounds = [len({t.get("name") for t in (r.get("tools") or [])}) for r in served]

    # Per model / feature (every feature in the window).
    combos: dict[tuple, dict] = defaultdict(lambda: {"requests": 0, "cost_usd": 0.0, "input": 0, "output": 0,
                                                     "cache_read": 0, "cache_write": 0})
    for r in all_rows:
        c = combos[(r.get("feature") or "?", r.get("model") or "?")]
        u = r.get("usage") or {}
        c["requests"] += 1
        c["cost_usd"] += float(r.get("cost_usd") or 0)
        c["input"] += int(u.get("input") or 0)
        c["output"] += int(u.get("output") or 0)
        c["cache_read"] += int(u.get("cache_read") or 0)
        c["cache_write"] += int(u.get("cache_write_5m") or 0) + int(u.get("cache_write_1h") or 0)
    by_model = sorted(({"feature": f, "model": m, **{k: (round(v, 6) if k == "cost_usd" else v) for k, v in c.items()}}
                       for (f, m), c in combos.items()), key=lambda x: -x["cost_usd"])

    limit_reasons = Counter(r.get("limit_reason") or "unknown" for r in rows if r.get("outcome") == "limit")
    window_cost = sum(float(r.get("cost_usd") or 0) for r in rows)
    return {
        "range": key,
        "feature": feature,
        "site": site,
        "by_site": await _by_site(db, feature, feature_rows),
        "status": {
            "enabled": await ai_usage.feature_on(db, feature),
            "configured": docs_agent.configured(),
            "model": s.docs_ai_model,
            "effort": docs_agent.effort(),
            "per_visitor_hour": s.docs_ai_per_visitor_hour,
            "max_concurrent": s.docs_ai_max_concurrent,
            "max_tool_rounds": s.docs_ai_max_tool_rounds,
        },
        "budget": {
            "today_usd": round(await ai_usage.spend_today(db, feature), 6),
            "month_usd": round(await ai_usage.spend_month(db, feature), 6),
            "all_features_today_usd": round(await ai_usage.spend_today(db), 6),
            "all_features_month_usd": round(await ai_usage.spend_month(db), 6),
            "daily_cap_usd": _cap((await ai_usage.caps(db, feature))[0]),
            "monthly_cap_usd": _cap((await ai_usage.caps(db, feature))[1]),
        },
        "kpis": {
            "questions": len(rows),
            "served": len(served),
            "limited": outcomes["limit"],
            "people": len({r.get("visitor") for r in rows if r.get("visitor")}),
            "signed_in_people": len({r.get("visitor") for r in rows if r.get("user_id")}),
            "conversations": len({r.get("conversation_id") for r in rows if r.get("conversation_id")}),
            "answered_pct": _ratio(answered, len(served)),
            "helpful_pct": _ratio(helpful, len(rated)),
            "rated": len(rated),
            "cost_usd": round(window_cost, 6),
            "cost_per_answer_usd": round(window_cost / len(served), 6) if served else None,
            "tokens": {"input": tokens["input"], "output": tokens["output"], "thinking": tokens["thinking"],
                       "cache_read": tokens["cache_read"], "cache_write_5m": tokens["cache_write_5m"],
                       "cache_write_1h": tokens["cache_write_1h"]},
            "cache_hit_pct": _ratio(tokens["cache_read"], prompt_total),
            "ttft_ms": {"p50": _pct([r.get("ttft_ms") for r in served], 50), "p95": _pct([r.get("ttft_ms") for r in served], 95)},
            "latency_ms": {"p50": _pct([r.get("latency_ms") for r in served], 50), "p95": _pct([r.get("latency_ms") for r in served], 95)},
            "avg_tools_per_answer": round(sum(len(r.get("tools") or []) for r in served) / len(served), 2) if served else None,
            "avg_distinct_tools": round(sum(rounds) / len(rounds), 2) if rounds else None,
            "long_context_calls": sum(int(r.get("long_context_calls") or 0) for r in rows),
            "links_removed": sum(int(r.get("links_removed") or 0) for r in rows),
        },
        "series": list(per_day.values()),
        "outcomes": [{"key": k, "n": outcomes.get(k, 0)} for k in OUTCOMES],
        "limit_reasons": [{"key": k, "n": n} for k, n in limit_reasons.most_common()],
        "tools": tools,
        "by_model": by_model,
        "truncated": len(all_rows) >= ROW_CAP,
    }


async def _by_site(db, feature: str, rows: list[dict]) -> list[dict]:
    """Per docs site: questions, outcomes and cost in the window, today's and this month's spend, caps."""
    per: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        per[_site_of(r)].append(r)
    registered = {c.id: c for c in docs_sites.configs()}
    others = sorted(k for k in per if k not in registered)
    studio = await _studio_sites(db, [k for k in others if docs_sites.is_studio_id(k)])
    out = []
    for sid in list(registered) + others:
        cfg = registered.get(sid)
        st = studio.get(sid)
        site_rows = per.get(sid, [])
        served = [r for r in site_rows if r.get("outcome") != "limit"]
        outcomes = Counter(r.get("outcome") or "error" for r in site_rows)
        scope = ai_usage.site_scope(feature, sid)
        out.append({
            "site": sid,
            "name": cfg.name if cfg else (st or {}).get("name"),
            "url": (cfg.url or None) if cfg else (st or {}).get("url"),
            "registered": cfg is not None,
            "studio": st is not None,
            "ai_enabled": cfg.ai_enabled if cfg else None,
            "product_tools": cfg.product_tools if cfg else None,
            "questions": len(site_rows),
            "served": len(served),
            "answered": outcomes["answered"],
            "limited": outcomes["limit"],
            "answered_pct": _ratio(outcomes["answered"], len(served)),
            "people": len({r.get("visitor") for r in site_rows if r.get("visitor")}),
            "cost_usd": round(sum(float(r.get("cost_usd") or 0) for r in site_rows), 6),
            "today_usd": round(await ai_usage.spend_today(db, scope), 6),
            "month_usd": round(await ai_usage.spend_month(db, scope), 6),
            "daily_cap_usd": cfg.daily_cap if cfg else None,
            "monthly_cap_usd": cfg.monthly_cap if cfg else None,
            "monthly_answers_cap": get_settings().docs_ai_answers_per_month if st else None,
        })
    return out


async def _studio_sites(db, ids: list[str]) -> dict[str, dict]:
    """Markdrop Guides sites among the ledger's site ids (deleted ones too): {id: {name, url}}."""
    if not ids:
        return {}
    from app.services import docs_snapshot
    from app.services.docs_site_store import SITES

    out = {}
    async for r in db[SITES].find({"_id": {"$in": [ObjectId(i) for i in ids]}}, {"name": 1, "slug": 1, "domains": 1}):
        out[str(r["_id"])] = {"name": r.get("name"), "url": docs_snapshot.site_url(r)}
    return out


# ── Questions and gaps ────────────────────────────────────────────────────────


@router.get("/questions")
async def top_questions(
    range_: str = Query("30d", alias="range"),
    limit: int = Query(50, ge=1, le=200),
    site: str | None = Query(None, max_length=64),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    since, until, key = _window(range_)
    rows = await _rows(db, docs_agent.FEATURE, since, until,
                       {"question": 1, "outcome": 1, "ts": 1, "feedback": 1, "conversation_id": 1, "request_id": 1},
                       site=_site_param(site))
    groups: dict[str, dict] = {}
    for r in rows:  # newest first
        k = normalize_question(r.get("question") or "")
        if not k:
            continue
        g = groups.get(k)
        if g is None:
            g = groups[k] = {"question": r.get("question") or "", "count": 0, "last_ts": _iso(r.get("ts")),
                             "outcomes": Counter(), "helpful": 0, "unhelpful": 0,
                             "conversation_id": r.get("conversation_id")}
        g["count"] += 1
        g["outcomes"][r.get("outcome") or "error"] += 1
        fb = r.get("feedback")
        if isinstance(fb, dict):
            g["helpful" if fb.get("helpful") else "unhelpful"] += 1
    out = sorted(groups.values(), key=lambda g: (-g["count"], g["last_ts"] or ""))[:limit]
    for g in out:
        g["outcomes"] = dict(g["outcomes"])
    return {"range": key, "questions": out, "distinct": len(groups)}


@router.get("/gaps")
async def content_gaps(
    range_: str = Query("30d", alias="range"),
    site: str | None = Query(None, max_length=64),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """flag_unanswered calls, no-answer outcomes and thumbs-down answers, grouped."""
    since, until, key = _window(range_)
    rows = await _rows(db, docs_agent.FEATURE, since, until,
                       {"question": 1, "outcome": 1, "ts": 1, "feedback": 1, "gaps": 1, "conversation_id": 1,
                        "page_path": 1}, site=_site_param(site))
    groups: dict[str, dict] = {}
    off_topic = 0
    for r in rows:
        gaps = [g for g in (r.get("gaps") or []) if isinstance(g, dict)]
        reasons = {g.get("reason") for g in gaps}
        fb = r.get("feedback") if isinstance(r.get("feedback"), dict) else None
        thumbs_down = bool(fb and fb.get("helpful") is False)
        if reasons == {"off_topic"} and not thumbs_down:
            off_topic += 1
            continue
        if not (gaps or r.get("outcome") == "no_answer" or thumbs_down):
            continue
        summary = next((g.get("summary") for g in gaps if g.get("reason") != "off_topic" and g.get("summary")), None)
        k = normalize_question(summary or r.get("question") or "")
        if not k:
            continue
        g = groups.get(k)
        if g is None:
            g = groups[k] = {"summary": summary or r.get("question") or "", "question": r.get("question") or "",
                             "count": 0, "reasons": Counter(), "thumbs_down": 0, "comments": [],
                             "details": [], "pages": Counter(), "last_ts": _iso(r.get("ts")),
                             "conversation_id": r.get("conversation_id")}
        g["count"] += 1
        for gap in gaps:
            if gap.get("reason") and gap.get("reason") != "off_topic":
                g["reasons"][gap["reason"]] += 1
            if gap.get("detail") and len(g["details"]) < 3:
                g["details"].append(gap["detail"])
        if r.get("outcome") == "no_answer" and not gaps:
            g["reasons"]["no_answer"] += 1
        if thumbs_down:
            g["thumbs_down"] += 1
            if fb.get("comment") and len(g["comments"]) < 3:
                g["comments"].append(fb["comment"])
        if r.get("page_path"):
            g["pages"][r["page_path"]] += 1
    out = sorted(groups.values(), key=lambda g: (-g["count"], g["last_ts"] or ""))[:100]
    for g in out:
        g["reasons"] = dict(g["reasons"])
        g["pages"] = [p for p, _n in g["pages"].most_common(3)]
    return {"range": key, "gaps": out, "off_topic": off_topic}


# ── Conversations ─────────────────────────────────────────────────────────────


def _row_summary(r: dict, emails: dict[str, str]) -> dict:
    u = r.get("usage") or {}
    fb = r.get("feedback") if isinstance(r.get("feedback"), dict) else None
    return {
        "request_id": r.get("request_id"),
        "conversation_id": r.get("conversation_id"),
        "site": _site_of(r),
        "turn": r.get("turn"),
        "ts": _iso(r.get("ts")),
        "question": (r.get("question") or "")[:300],
        "outcome": r.get("outcome"),
        "page_path": r.get("page_path"),
        "who": _visitor_label(r, emails),
        "signed_in": bool(r.get("user_id")),
        "cost_usd": round(float(r.get("cost_usd") or 0), 6),
        "tokens": {"input": u.get("input", 0), "output": u.get("output", 0), "cache_read": u.get("cache_read", 0),
                   "cache_write": int(u.get("cache_write_5m") or 0) + int(u.get("cache_write_1h") or 0)},
        "latency_ms": r.get("latency_ms"),
        "ttft_ms": r.get("ttft_ms"),
        "tools": len(r.get("tools") or []),
        "feedback": {"helpful": fb.get("helpful"), "comment": fb.get("comment")} if fb else None,
        "model": r.get("model"),
    }


@router.get("/conversations")
async def conversations(
    range_: str = Query("30d", alias="range"),
    page: int = Query(1, ge=1, le=10_000),
    limit: int = Query(25, ge=1, le=100),
    outcome: str | None = Query(None, max_length=20),
    q: str | None = Query(None, max_length=200),
    signed_in: bool | None = None,
    site: str | None = Query(None, max_length=64),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    since, until, key = _window(range_)
    query: dict = {"feature": docs_agent.FEATURE, "ts": {"$gte": since, "$lt": until},
                   **ai_usage.site_filter(_site_param(site))}
    if outcome in OUTCOMES:
        query["outcome"] = outcome
    if q and q.strip():
        query["question"] = {"$regex": re.escape(q.strip()), "$options": "i"}
    if signed_in is not None:
        query["user_id"] = {"$ne": None} if signed_in else None
    total = await db[ai_usage.REQUESTS].count_documents(query)
    rows = await (db[ai_usage.REQUESTS].find(query, _LIST_FIELDS).sort("ts", -1)
                  .skip((page - 1) * limit).limit(limit)).to_list(length=limit)
    emails = await _emails(db, {r["user_id"] for r in rows if r.get("user_id")})
    return {"range": key, "page": page, "pages": max(1, -(-total // limit)), "total": total,
            "items": [_row_summary(r, emails) for r in rows]}


@router.get("/conversations/{conversation_id}")
async def conversation(
    conversation_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    if not re.match(r"^[A-Za-z0-9_-]{8,64}$", conversation_id):
        raise HTTPException(404, "Conversation not found")
    rows = await db[ai_usage.REQUESTS].find({"conversation_id": conversation_id}, {"ip_hash": 1, "user_id": 1, **{
        k: 1 for k in ("request_id", "turn", "ts", "question", "answer", "citations", "tools", "usage", "cost_usd",
                       "latency_ms", "ttft_ms", "model", "effort", "stop_reason", "stop_details", "outcome",
                       "feedback", "gaps", "page_path", "links_removed", "error_code", "limit_reason", "calls",
                       "conversation_id", "feature", "long_context_calls", "max_prompt_tokens", "signed_in",
                       "site")}}
    ).sort([("ts", 1)]).to_list(length=200)
    if not rows:
        raise HTTPException(404, "Conversation not found")
    emails = await _emails(db, {r["user_id"] for r in rows if r.get("user_id")})
    turns = []
    for r in rows:
        base = _row_summary(r, emails)
        base.update({
            "answer": r.get("answer") or "",
            "citations": r.get("citations") or [],
            "tool_calls": [{k: t.get(k) for k in ("name", "args_summary", "ms", "result_count", "error")}
                           for t in (r.get("tools") or [])],
            "usage": r.get("usage") or {},
            "calls": r.get("calls"),
            "effort": r.get("effort"),
            "stop_reason": r.get("stop_reason"),
            "stop_details": r.get("stop_details"),
            "gaps": r.get("gaps") or [],
            "links_removed": r.get("links_removed") or 0,
            "error_code": r.get("error_code"),
            "limit_reason": r.get("limit_reason"),
            "long_context_calls": r.get("long_context_calls") or 0,
            "max_prompt_tokens": r.get("max_prompt_tokens"),
        })
        turns.append(base)
    return {"conversation_id": conversation_id, "who": turns[0]["who"], "turns": turns,
            "cost_usd": round(sum(t["cost_usd"] for t in turns), 6)}


# ── Page feedback ─────────────────────────────────────────────────────────────


@router.get("/page-feedback")
async def page_feedback(
    range_: str = Query("30d", alias="range"),
    site: str | None = Query(None, max_length=64),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    since, until, key = _window(range_)
    rows = await db["docs_feedback"].find({"ts": {"$gte": since, "$lt": until}, **ai_usage.site_filter(_site_param(site))},
                                          {"path": 1, "helpful": 1, "comment": 1, "ts": 1, "known_page": 1, "site": 1}
                                          ).sort("ts", -1).to_list(length=ROW_CAP)
    pages: dict[tuple[str, str], dict] = {}
    for r in rows:
        path, sid = r.get("path") or "/", _site_of(r)
        p = pages.setdefault((sid, path), {"path": path, "site": sid, "up": 0, "down": 0, "comments": [],
                                           "known_page": r.get("known_page", True), "last_ts": _iso(r.get("ts"))})
        p["up" if r.get("helpful") else "down"] += 1
        if r.get("comment") and len(p["comments"]) < 5:
            p["comments"].append({"text": r["comment"], "helpful": bool(r.get("helpful")), "ts": _iso(r.get("ts"))})
    out = sorted(pages.values(), key=lambda p: (-p["down"], -(p["up"] + p["down"]), p["path"], p["site"]))
    for p in out:
        p["helpful_pct"] = _ratio(p["up"], p["up"] + p["down"])
    up = sum(p["up"] for p in out)
    down = sum(p["down"] for p in out)
    return {"range": key, "votes": up + down, "up": up, "down": down, "helpful_pct": _ratio(up, up + down),
            "pages": out[:200]}


# ══ All AI features: usage per person, and the budgets ════════════════════════
#
# Every feature in ai_usage.FEATURES (plus any other the ledger holds). Rows are read with an
# explicit projection that never includes a prompt or an answer (docs Ask AI keeps its question
# and answer on the row for the Conversations view above; nothing below returns them).
# Signed-out usage is one "Anonymous visitors" row (user id "anonymous").

ANON = "anonymous"
_USAGE_FIELDS = {k: 1 for k in ("feature", "ts", "usage", "cost_usd", "outcome", "user_id", "visitor", "limit_reason",
                                "action", "kind", "site", "slug", "page_path", "page_id", "workspace_id", "latency_ms",
                                "error_code", "model", "request_id", "conversation_id", "language")}
_USER_SORTS = ("cost", "requests", "tokens", "last_used", "email", "errors")
_TOK = ("input", "output", "cache_read", "cache_write")


def _label(feature: str) -> str:
    return ai_usage.FEATURES.get(feature) or feature.replace("_", " ").capitalize()


def _cap(v: float) -> float | None:
    """A cap for JSON: inf (no cap) is null."""
    return None if v is None or v == ai_usage.INF else round(float(v), 6)


def _tokens(r: dict) -> dict[str, int]:
    u = r.get("usage") or {}
    return {"input": int(u.get("input") or 0), "output": int(u.get("output") or 0),
            "cache_read": int(u.get("cache_read") or 0),
            "cache_write": int(u.get("cache_write_5m") or 0) + int(u.get("cache_write_1h") or 0)}


def _kind(outcome: str | None) -> str:
    """ok | limit | error, across features' own outcome names."""
    if outcome == "limit":
        return "limit"
    if outcome in ("error", None):
        return "error"
    return "ok"


class _Agg:
    """Requests, outcomes, tokens and cost of a set of ledger rows."""

    __slots__ = ("requests", "ok", "errors", "limited", "cost", "tok", "last", "features", "visitors")

    def __init__(self):
        self.requests = self.ok = self.errors = self.limited = 0
        self.cost = 0.0
        self.tok = dict.fromkeys(_TOK, 0)
        self.last: datetime | None = None
        self.features: Counter = Counter()
        self.visitors: set = set()

    def add(self, r: dict) -> None:
        self.requests += 1
        k = _kind(r.get("outcome"))
        self.ok += k == "ok"
        self.errors += k == "error"
        self.limited += k == "limit"
        self.cost += float(r.get("cost_usd") or 0)
        for key, v in _tokens(r).items():
            self.tok[key] += v
        ts = _aware(r.get("ts"))
        if ts and (self.last is None or ts > self.last):
            self.last = ts
        self.features[r.get("feature") or "?"] += 1
        if r.get("visitor"):
            self.visitors.add(r["visitor"])

    @property
    def total_tokens(self) -> int:
        return sum(self.tok.values())

    def cache_hit_pct(self) -> float | None:
        prompt = self.tok["input"] + self.tok["cache_read"] + self.tok["cache_write"]
        return _ratio(self.tok["cache_read"], prompt)

    def out(self) -> dict:
        return {"requests": self.requests, "ok": self.ok, "errors": self.errors, "limited": self.limited,
                "cost_usd": round(self.cost, 6), "tokens": dict(self.tok), "total_tokens": self.total_tokens,
                "cache_hit_pct": self.cache_hit_pct()}


async def _usage_rows(db, since: datetime, until: datetime, extra: dict | None = None) -> list[dict]:
    q = {"ts": {"$gte": since, "$lt": until}, **(extra or {})}
    return await db[ai_usage.REQUESTS].find(q, _USAGE_FIELDS).sort("ts", -1).to_list(length=ROW_CAP)


def _feature_keys(rows: list[dict]) -> list[str]:
    seen = {r.get("feature") for r in rows if r.get("feature")}
    return list(ai_usage.FEATURES) + sorted(seen - set(ai_usage.FEATURES))


def _series(rows: list[dict], since: datetime, until: datetime, zone: ZoneInfo, features: list[str]) -> list[dict]:
    days = _days(since, until, zone)
    per = {d: {"t": d, "requests": 0, "cost_usd": 0.0, "tokens": 0, "by_feature": dict.fromkeys(features, 0.0),
               "requests_by_feature": dict.fromkeys(features, 0)} for d in days}
    for r in rows:
        ts = _aware(r.get("ts"))
        b = per.get(ts.astimezone(zone).date().isoformat()) if ts else None
        if b is None:
            continue
        f = r.get("feature") or "?"
        c = float(r.get("cost_usd") or 0)
        b["requests"] += 1
        b["cost_usd"] += c
        b["tokens"] += sum(_tokens(r).values())
        b["by_feature"][f] = b["by_feature"].get(f, 0.0) + c
        b["requests_by_feature"][f] = b["requests_by_feature"].get(f, 0) + 1
    for b in per.values():
        b["cost_usd"] = round(b["cost_usd"], 6)
        b["by_feature"] = {k: round(v, 6) for k, v in b["by_feature"].items()}
    return list(per.values())


async def _users_info(db, ids: set[str]) -> dict[str, dict]:
    oids = [ObjectId(i) for i in ids if ObjectId.is_valid(i)]
    if not oids:
        return {}
    rows = await db["users"].find({"_id": {"$in": oids}}, {"email": 1, "name": 1, "created_at": 1}).to_list(length=len(oids))
    return {str(r["_id"]): {"email": r.get("email") or "", "name": r.get("name") or "",
                            "created_at": _iso(r.get("created_at"))} for r in rows}


async def _user_overrides(db) -> dict[str, dict]:
    out = {}
    async for r in db[ai_usage.SETTINGS].find({"_id": {"$regex": "^user:"}}):
        out[r["_id"][5:]] = {"blocked": bool(r.get("blocked")), "daily_usd": ai_usage._num(r.get("daily_usd")),
                             "updated_at": _iso(r.get("updated_at")), "updated_by": r.get("updated_by")}
    return out


async def _spend_today_by_user(db) -> dict[str, float]:
    out: dict[str, float] = defaultdict(float)
    async for r in db[ai_usage.REQUESTS].find({"ts": {"$gte": ai_usage.utc_midnight()}, "user_id": {"$ne": None}},
                                              {"user_id": 1, "cost_usd": 1}):
        out[r["user_id"]] += float(r.get("cost_usd") or 0)
    return out


# ── Overview ──


@router.get("/usage/overview")
async def usage_overview(
    range_: str = Query("30d", alias="range"),
    tz: str = "UTC",
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """Every AI feature: spend today and this month against the caps, the window's requests,
    tokens, cache hit rate, errors and limits, and a per-day series by feature."""
    since, until, key = _window(range_)
    zone = _tz(tz)
    rows = await _usage_rows(db, since, until)
    features = _feature_keys(rows)
    total, by_feature = _Agg(), defaultdict(_Agg)
    users: set[str] = set()
    anon = 0
    limit_reasons: Counter = Counter()
    for r in rows:
        total.add(r)
        by_feature[r.get("feature") or "?"].add(r)
        if r.get("user_id"):
            users.add(r["user_id"])
        else:
            anon += 1
        if r.get("outcome") == "limit":
            limit_reasons[(r.get("feature") or "?", r.get("limit_reason") or "unknown")] += 1
    out_features = []
    for f in features:
        d, m = await ai_usage.caps(db, f)
        a = by_feature.get(f) or _Agg()
        out_features.append({
            "key": f, "label": _label(f), "registered": f in ai_usage.FEATURES,
            "enabled": await ai_usage.feature_on(db, f),
            "config_enabled": ai_usage.default_on(f),
            "today_usd": round(await ai_usage.spend_today(db, f), 6),
            "month_usd": round(await ai_usage.spend_month(db, f), 6),
            "daily_cap_usd": _cap(d), "monthly_cap_usd": _cap(m),
            "users": len({r.get("user_id") for r in rows if r.get("feature") == f and r.get("user_id")}),
            **a.out(),
        })
    gd, gm = await ai_usage.caps(db, ai_usage.ALL)
    return {
        "range": key,
        "configured": docs_agent.configured(),
        "global": {"today_usd": round(await ai_usage.spend_today(db), 6),
                   "month_usd": round(await ai_usage.spend_month(db), 6),
                   "daily_cap_usd": _cap(gd), "monthly_cap_usd": _cap(gm)},
        "kpis": {**total.out(), "users": len(users), "anonymous_requests": anon},
        "features": out_features,
        "limit_reasons": [{"feature": f, "reason": k, "n": n} for (f, k), n in limit_reasons.most_common()],
        "series": _series(rows, since, until, zone, features),
        "truncated": len(rows) >= ROW_CAP,
    }


# ── Users ──


async def _user_table(db, since: datetime, until: datetime, *, feature: str | None, q: str | None) -> list[dict]:
    extra = {"feature": feature} if feature else None
    rows = await _usage_rows(db, since, until, extra)
    per: dict[str, _Agg] = defaultdict(_Agg)
    for r in rows:
        per[r.get("user_id") or ANON].add(r)
    overrides = await _user_overrides(db)
    if not feature:
        for uid in overrides:  # blocked or capped people stay listed, used or not
            per.setdefault(uid, _Agg())
    info = await _users_info(db, {u for u in per if u != ANON})
    today = await _spend_today_by_user(db)
    default_cap = await ai_usage.default_user_daily(db)
    needle = (q or "").strip().lower()
    out = []
    for uid, a in per.items():
        if uid == ANON:
            row = {"user_id": ANON, "anonymous": True, "email": "", "name": "Anonymous visitors",
                   "visitors": len(a.visitors), "blocked": False, "daily_cap_usd": None, "effective_daily_cap_usd": None,
                   "today_usd": None}
        else:
            u = info.get(uid) or {}
            o = overrides.get(uid) or {}
            own = o.get("daily_usd")
            row = {"user_id": uid, "anonymous": False, "email": u.get("email") or "", "name": u.get("name") or "",
                   "deleted": uid not in info, "blocked": bool(o.get("blocked")), "daily_cap_usd": own,
                   "effective_daily_cap_usd": own if own is not None else default_cap,
                   "today_usd": round(today.get(uid, 0.0), 6)}
        if needle and needle not in f"{row['email']} {row['name']} {uid}".lower():
            continue
        row.update(a.out())
        row["features"] = [f for f, _n in a.features.most_common()]
        row["last_used"] = _iso(a.last)
        out.append(row)
    return out


def _sort_users(items: list[dict], sort: str, order: str) -> list[dict]:
    key = {"cost": lambda r: r["cost_usd"], "requests": lambda r: r["requests"],
           "tokens": lambda r: r["total_tokens"], "last_used": lambda r: r["last_used"] or "",
           "email": lambda r: (r["email"] or r["name"] or "~").lower(), "errors": lambda r: r["errors"]}[sort]
    return sorted(items, key=key, reverse=order == "desc")


@router.get("/usage/users")
async def usage_users(
    range_: str = Query("30d", alias="range"),
    q: str | None = Query(None, max_length=200),
    sort: str = Query("cost"),
    order: str = Query("desc"),
    feature: str | None = Query(None, max_length=40),
    page: int = Query(1, ge=1, le=10_000),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """Everyone who used AI in the window (and anyone blocked or with their own cap)."""
    since, until, key = _window(range_)
    sort = sort if sort in _USER_SORTS else "cost"
    order = "asc" if order == "asc" else "desc"
    items = _sort_users(await _user_table(db, since, until, feature=feature or None, q=q), sort, order)
    total = len(items)
    start = (page - 1) * limit
    return {"range": key, "sort": sort, "order": order, "page": page, "pages": max(1, -(-total // limit)),
            "total": total, "default_daily_cap_usd": await ai_usage.default_user_daily(db),
            "items": items[start:start + limit]}


def _request_row(r: dict) -> dict:
    """One ledger row for the admin: what, where, how much. Never the prompt or the answer."""
    return {
        "request_id": r.get("request_id"),
        "ts": _iso(r.get("ts")),
        "feature": r.get("feature"),
        "action": r.get("action") or r.get("kind"),
        "site": r.get("site"),
        "slug": r.get("slug"),
        "page": r.get("page_path") or r.get("page_id"),
        "workspace_id": r.get("workspace_id"),
        "conversation_id": r.get("conversation_id") if r.get("feature") == docs_agent.FEATURE else None,
        "outcome": r.get("outcome"),
        "limit_reason": r.get("limit_reason"),
        "error_code": r.get("error_code"),
        "tokens": _tokens(r),
        "cost_usd": round(float(r.get("cost_usd") or 0), 6),
        "latency_ms": r.get("latency_ms"),
        "model": r.get("model"),
    }


@router.get("/usage/users/{user_id}")
async def usage_user(
    user_id: str,
    range_: str = Query("30d", alias="range"),
    tz: str = "UTC",
    limit: int = Query(50, ge=1, le=200),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """One person (or "anonymous"): per-feature and per-day breakdowns, and recent requests."""
    anonymous = user_id == ANON
    if not anonymous and not ObjectId.is_valid(user_id):
        raise HTTPException(404, "User not found")
    since, until, key = _window(range_)
    zone = _tz(tz)
    rows = await _usage_rows(db, since, until, {"user_id": None if anonymous else user_id})
    info = {} if anonymous else (await _users_info(db, {user_id})).get(user_id)
    if not anonymous and info is None and not rows and not await db[ai_usage.SETTINGS].find_one({"_id": f"user:{user_id}"}):
        raise HTTPException(404, "User not found")
    total = _Agg()
    by_feature: dict[str, _Agg] = defaultdict(_Agg)
    by_action: dict[tuple, _Agg] = defaultdict(_Agg)
    for r in rows:
        total.add(r)
        by_feature[r.get("feature") or "?"].add(r)
        by_action[(r.get("feature") or "?", r.get("action") or r.get("kind") or "—")].add(r)
    features = [f for f in _feature_keys(rows) if f in by_feature]
    settings_out = None
    if not anonymous:
        o = await ai_usage.user_settings(db, user_id)
        own = ai_usage._num(o.get("daily_usd"))
        settings_out = {"blocked": bool(o.get("blocked")), "daily_cap_usd": own,
                        "effective_daily_cap_usd": await ai_usage.user_daily_cap(db, user_id),
                        "default_daily_cap_usd": await ai_usage.default_user_daily(db),
                        "today_usd": round(await ai_usage.user_spend_today(db, user_id), 6),
                        "burst": dict(zip(("per_minute", "per_day"), await ai_usage.burst_limits(db)))}
    return {
        "range": key,
        "user": {"user_id": user_id, "anonymous": anonymous,
                 "email": (info or {}).get("email") or "", "name": (info or {}).get("name") or (
                     "Anonymous visitors" if anonymous else ""),
                 "created_at": (info or {}).get("created_at"), "deleted": not anonymous and info is None},
        "settings": settings_out,
        "kpis": {**total.out(), "last_used": _iso(total.last), "visitors": len(total.visitors) if anonymous else None},
        "by_feature": [{"key": f, "label": _label(f), **by_feature[f].out()} for f in features],
        "by_action": sorted(({"feature": f, "label": _label(f), "action": a, **v.out()} for (f, a), v in by_action.items()),
                            key=lambda x: -x["cost_usd"]),
        "series": _series(rows, since, until, zone, features),
        "recent": [_request_row(r) for r in rows[:limit]],
        "truncated": len(rows) >= ROW_CAP,
    }


# ── Export ──


def _csv_cell(v) -> str:
    """A spreadsheet-safe cell (no formula injection)."""
    s = "" if v is None else str(v)
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s


@router.get("/usage/export.csv")
async def usage_export(
    kind: str = Query("users"),
    range_: str = Query("30d", alias="range"),
    feature: str | None = Query(None, max_length=40),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    import csv
    import io

    from fastapi.responses import Response

    if kind not in ("users", "requests"):
        raise HTTPException(400, "kind is users or requests")
    since, until, key = _window(range_)
    buf = io.StringIO()
    w = csv.writer(buf)
    if kind == "users":
        w.writerow(["user_id", "email", "name", "requests", "ok", "errors", "limited", "input_tokens",
                    "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_usd", "features", "last_used",
                    "blocked", "daily_cap_usd"])
        for r in _sort_users(await _user_table(db, since, until, feature=feature or None, q=None), "cost", "desc"):
            w.writerow([_csv_cell(x) for x in (
                r["user_id"], r["email"], r["name"], r["requests"], r["ok"], r["errors"], r["limited"],
                r["tokens"]["input"], r["tokens"]["output"], r["tokens"]["cache_read"], r["tokens"]["cache_write"],
                f"{r['cost_usd']:.6f}", " ".join(r["features"]), r["last_used"], r["blocked"], r["daily_cap_usd"])])
    else:
        rows = await _usage_rows(db, since, until, {"feature": feature} if feature else None)
        emails = await _emails(db, {r["user_id"] for r in rows if r.get("user_id")})
        w.writerow(["ts", "feature", "action", "user_id", "email", "site", "slug", "page", "outcome", "limit_reason",
                    "error_code", "model", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
                    "cost_usd", "latency_ms", "request_id"])
        for r in rows:
            x = _request_row(r)
            uid = r.get("user_id")
            w.writerow([_csv_cell(v) for v in (
                x["ts"], x["feature"], x["action"], uid or ANON, emails.get(uid, "") if uid else "", x["site"],
                x["slug"], x["page"], x["outcome"], x["limit_reason"], x["error_code"], x["model"],
                x["tokens"]["input"], x["tokens"]["output"], x["tokens"]["cache_read"], x["tokens"]["cache_write"],
                f"{x['cost_usd']:.6f}", x["latency_ms"], x["request_id"])])
    name = f"markdrop-ai-{kind}-{key}{'-' + re.sub(r'[^a-z0-9_]', '', feature) if feature else ''}.csv"
    return Response(buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})


# ── Budgets ──


class CapIn(BaseModel):
    daily_usd: float | None = None
    monthly_usd: float | None = None


class BurstIn(BaseModel):
    per_minute: int | None = None
    per_day: int | None = None


class BudgetsIn(BaseModel):
    """The whole override document: null (or missing) = the config default."""

    caps: dict[str, CapIn] = {}
    enabled: dict[str, bool] = {}
    burst: BurstIn = BurstIn()
    user_daily_usd: float | None = None


class UserAiIn(BaseModel):
    blocked: bool | None = None
    daily_usd: float | None = None


def _bad(msg: str):
    raise HTTPException(400, msg)


def _check_money(v: float | None, what: str) -> float | None:
    if v is None:
        return None
    if not math.isfinite(v) or v < 0:
        _bad(f"{what} must be a number of dollars, 0 or more.")
    if v > 1_000_000:
        _bad(f"{what} is too large.")
    return round(float(v), 6)


async def _budgets_view(db) -> dict:
    o = await db[ai_usage.SETTINGS].find_one({"_id": ai_usage.BUDGETS_ID}) or {}
    from app.config import get_settings as _gs

    s = _gs()
    caps_o = o.get("caps") or {}
    rows = []
    for f in [ai_usage.ALL, *ai_usage.FEATURES]:
        dd, dm = ai_usage.default_caps(f)
        ov = caps_o.get(f) or {}
        d, m = await ai_usage.caps(db, f)
        rows.append({
            "key": f, "label": "All AI features" if f == ai_usage.ALL else _label(f),
            "default_daily_usd": _cap(dd), "default_monthly_usd": _cap(dm),
            "daily_usd": ai_usage._num(ov.get("daily_usd")), "monthly_usd": ai_usage._num(ov.get("monthly_usd")),
            "effective_daily_usd": _cap(d), "effective_monthly_usd": _cap(m),
            "today_usd": round(await ai_usage.spend_today(db, f), 6),
            "month_usd": round(await ai_usage.spend_month(db, f), 6),
            **({} if f == ai_usage.ALL else {
                "config_enabled": ai_usage.default_on(f),
                "enabled": (o.get("enabled") or {}).get(f, True) is not False,
                "effective_enabled": await ai_usage.feature_on(db, f)}),
        })
    burst = o.get("burst") or {}
    pm, pd = await ai_usage.burst_limits(db)
    users = await _user_overrides(db)
    return {
        "caps": rows,
        "burst": {"per_minute": ai_usage._num(burst.get("per_minute")), "per_day": ai_usage._num(burst.get("per_day")),
                  "default_per_minute": s.ai_burst_per_minute, "default_per_day": s.ai_burst_per_day,
                  "effective_per_minute": pm, "effective_per_day": pd},
        "user_daily_usd": ai_usage._num(o.get("user_daily_usd")),
        "default_user_daily_usd": ai_usage._num(s.ai_user_daily_usd),
        "effective_user_daily_usd": await ai_usage.default_user_daily(db),
        "blocked_users": sum(1 for u in users.values() if u["blocked"]),
        "capped_users": sum(1 for u in users.values() if u["daily_usd"] is not None),
        "configured": docs_agent.configured(),
        "updated_at": _iso(o.get("updated_at")),
        "updated_by": o.get("updated_by"),
    }


def _plain(doc: dict | None) -> dict | None:
    if not doc:
        return None
    return {k: v for k, v in doc.items() if k not in ("_id", "updated_at", "updated_by")}


async def _audit(db, admin: dict, kind: str, target: str, before: dict | None, after: dict | None) -> None:
    await db[ai_usage.SETTINGS_AUDIT].insert_one({
        "ts": datetime.now(timezone.utc), "admin": admin.get("sub") or "admin", "kind": kind, "target": target,
        "before": _plain(before), "after": _plain(after)})


@router.get("/budgets")
async def get_budgets(db: AsyncIOMotorDatabase = Depends(get_db), _: dict = Depends(require_admin)):
    return await _budgets_view(db)


@router.put("/budgets")
async def put_budgets(body: BudgetsIn, db: AsyncIOMotorDatabase = Depends(get_db),
                      admin: dict = Depends(require_admin)):
    """Replace the overrides (null = the config default). Takes effect at once; audited."""
    known = {ai_usage.ALL, *ai_usage.FEATURES}
    caps_out: dict = {}
    for f, c in body.caps.items():
        if f not in known:
            _bad(f"Unknown AI feature: {f}")
        label = "All AI features" if f == ai_usage.ALL else _label(f)
        d = _check_money(c.daily_usd, f"{label}'s daily cap")
        m = _check_money(c.monthly_usd, f"{label}'s monthly cap")
        dd, dm = ai_usage.default_caps(f)
        if (m if m is not None else dm) < (d if d is not None else dd):
            _bad(f"{label}: the monthly cap can't be lower than the daily cap.")
        entry = {k: v for k, v in (("daily_usd", d), ("monthly_usd", m)) if v is not None}
        if entry:
            caps_out[f] = entry
    enabled: dict = {}
    for f, on in body.enabled.items():
        if f not in ai_usage.FEATURES:
            _bad(f"Unknown AI feature: {f}")
        if on is False:
            enabled[f] = False
    burst: dict = {}
    for k, v in (("per_minute", body.burst.per_minute), ("per_day", body.burst.per_day)):
        if v is None:
            continue
        if v < 1 or v > 1_000_000:
            _bad("Burst limits are whole numbers of requests, 1 or more.")
        burst[k] = int(v)
    from app.config import get_settings as _gs

    s = _gs()
    if burst.get("per_day", s.ai_burst_per_day) < burst.get("per_minute", s.ai_burst_per_minute):
        _bad("The per-day burst limit can't be lower than the per-minute one.")
    doc = {"_id": ai_usage.BUDGETS_ID, "caps": caps_out, "enabled": enabled, "burst": burst}
    ud = _check_money(body.user_daily_usd, "The per-person daily cap")
    if ud is not None:
        doc["user_daily_usd"] = ud
    before = await db[ai_usage.SETTINGS].find_one({"_id": ai_usage.BUDGETS_ID})
    doc["updated_at"] = datetime.now(timezone.utc)
    doc["updated_by"] = admin.get("sub") or "admin"
    await db[ai_usage.SETTINGS].replace_one({"_id": ai_usage.BUDGETS_ID}, doc, upsert=True)
    ai_usage.invalidate_settings()
    if _plain(before) != _plain(doc):
        await _audit(db, admin, "budgets", "budgets", before, doc)
    return await _budgets_view(db)


@router.put("/users/{user_id}")
async def put_user_ai(user_id: str, body: UserAiIn, db: AsyncIOMotorDatabase = Depends(get_db),
                      admin: dict = Depends(require_admin)):
    """Block or unblock a person from every AI feature, and/or set their own daily USD cap
    (null: back to the default). Fields left out are kept."""
    if not ObjectId.is_valid(user_id) or not await db["users"].find_one({"_id": ObjectId(user_id)}, {"_id": 1}):
        raise HTTPException(404, "User not found")
    sent = body.model_fields_set
    if not sent:
        _bad("Nothing to change.")
    key = f"user:{user_id}"
    before = await db[ai_usage.SETTINGS].find_one({"_id": key})
    doc = {"_id": key, "kind": "user", "user_id": user_id, "blocked": bool((before or {}).get("blocked")),
           "daily_usd": ai_usage._num((before or {}).get("daily_usd"))}
    if "blocked" in sent:
        doc["blocked"] = bool(body.blocked)
    if "daily_usd" in sent:
        doc["daily_usd"] = _check_money(body.daily_usd, "The daily cap")
    doc["updated_at"] = datetime.now(timezone.utc)
    doc["updated_by"] = admin.get("sub") or "admin"
    if not doc["blocked"] and doc["daily_usd"] is None:
        await db[ai_usage.SETTINGS].delete_one({"_id": key})  # back to the defaults
    else:
        await db[ai_usage.SETTINGS].replace_one({"_id": key}, doc, upsert=True)
    ai_usage.invalidate_settings()
    after = {k: doc[k] for k in ("blocked", "daily_usd")}
    if {k: (before or {}).get(k, False if k == "blocked" else None) for k in ("blocked", "daily_usd")} != after:
        await _audit(db, admin, "user", user_id, {k: (before or {}).get(k) for k in ("blocked", "daily_usd")}
                     if before else None, after)
    return {"user_id": user_id, "blocked": doc["blocked"], "daily_cap_usd": doc["daily_usd"],
            "effective_daily_cap_usd": await ai_usage.user_daily_cap(db, user_id)}


@router.get("/budgets/audit")
async def budgets_audit(
    limit: int = Query(50, ge=1, le=500),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    rows = await db[ai_usage.SETTINGS_AUDIT].find({}).sort("ts", -1).limit(limit).to_list(length=limit)
    emails = await _emails(db, {r["target"] for r in rows if r.get("kind") == "user"})
    return {"items": [{"id": str(r["_id"]), "ts": _iso(r.get("ts")), "admin": r.get("admin"), "kind": r.get("kind"),
                       "target": r.get("target"),
                       "target_label": emails.get(r.get("target")) if r.get("kind") == "user" else "Budgets",
                       "before": r.get("before"), "after": r.get("after")} for r in rows]}
