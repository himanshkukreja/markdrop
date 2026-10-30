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
            "enabled": docs_agent.enabled(),
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
            "daily_cap_usd": s.docs_ai_daily_usd,
            "monthly_cap_usd": s.docs_ai_monthly_usd,
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
    out = []
    for sid in list(registered) + sorted(k for k in per if k not in registered):
        cfg = registered.get(sid)
        site_rows = per.get(sid, [])
        served = [r for r in site_rows if r.get("outcome") != "limit"]
        outcomes = Counter(r.get("outcome") or "error" for r in site_rows)
        scope = ai_usage.site_scope(feature, sid)
        out.append({
            "site": sid,
            "name": cfg.name if cfg else None,
            "url": (cfg.url or None) if cfg else None,
            "registered": cfg is not None,
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
        })
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
