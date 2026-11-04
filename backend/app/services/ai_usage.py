"""AI usage ledger: what every Anthropic call in Markdrop cost, and the budget.

Generic on purpose. Docs Ask AI is the first feature to use it; anything that
calls Claude later records through the same three steps:

    meter = ai_usage.Meter(model)
    meter.add(message.usage)            # once per API call (each tool round)
    await ai_usage.record(db, feature="docs_ask", meter=meter, ...)

Cost is computed per *call* from the usage the API returned: uncached input,
output (thinking included, it is billed as output), cache reads, and cache
writes split by TTL (5 minutes / 1 hour). A call whose prompt (input + cache
read + cache write) is over the model's long-context threshold is priced at the
long tier for the whole call. Summing per call matters: a tool loop's later
rounds carry bigger prompts than its first.

Spend counters live in MongoDB (`ai_spend`, one row per feature per UTC day and
month, plus "*" for all features, plus "<feature>@<site>" for a feature that
serves several sites, like docs Ask AI), bumped with $inc in the same step as
the ledger row. That makes the caps exact across API workers and restarts. A small
in-process reservation per running request keeps a burst of concurrent
questions from all passing the check before any of them is recorded.
"""

from __future__ import annotations

import hashlib
import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from motor.motor_asyncio import AsyncIOMotorDatabase

log = logging.getLogger("markdrop.ai_usage")

REQUESTS = "ai_requests"
SPEND = "ai_spend"
RETENTION_DAYS = 180
ALL = "*"
# Ledger rows written before sites existed have no `site`: they were all this one.
LEGACY_SITE = "markdrop"


def site_scope(feature: str, site: str) -> str:
    """The spend-counter and reservation key for one site of a feature."""
    return f"{feature}@{site}"


def site_filter(site: str | None) -> dict:
    """A ledger query clause for one site's rows (none: every site)."""
    if not site:
        return {}
    if site == LEGACY_SITE:
        return {"site": {"$in": [site, None]}}
    return {"site": site}


# ── Pricing ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Tier:
    """USD per million tokens."""

    input: float
    output: float
    cache_write_5m: float
    cache_write_1h: float
    cache_read: float


@dataclass(frozen=True)
class Pricing:
    base: Tier
    long: Tier | None = None          # used when the call's prompt is over `threshold`
    threshold: int = 100_000          # prompt tokens (input + cache read + cache write)


PRICING: dict[str, Pricing] = {
    # Claude Haiku 5.5 (platform.claude.com pricing, checked 2026-10-30).
    "claude-haiku-5-5": Pricing(
        base=Tier(input=0.10, output=0.50, cache_write_5m=0.125, cache_write_1h=0.20, cache_read=0.01),
        long=Tier(input=0.50, output=2.50, cache_write_5m=0.625, cache_write_1h=1.00, cache_read=0.05),
        threshold=100_000,
    ),
}
# A model missing from the table is priced high on purpose: an unknown price
# must make the budget trip early, never late.
FALLBACK = Pricing(base=Tier(input=5.0, output=25.0, cache_write_5m=6.25, cache_write_1h=10.0, cache_read=0.5))


def pricing_for(model: str) -> tuple[Pricing, bool]:
    """(pricing, known). Dated snapshots (claude-haiku-5-5-20261007) use their alias."""
    if model in PRICING:
        return PRICING[model], True
    base = re.sub(r"-\d{8}$", "", model or "")
    if base in PRICING:
        return PRICING[base], True
    return FALLBACK, False


# ── Usage ─────────────────────────────────────────────────────────────────────


def _get(obj: Any, name: str, default=None):
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _int(v) -> int:
    try:
        return max(0, int(v or 0))
    except (TypeError, ValueError):
        return 0


def normalize_usage(usage: Any) -> dict[str, int]:
    """The API's `usage` (SDK object or dict) → our token fields.

    `cache_creation_input_tokens` is the total written; `cache_creation` breaks
    it down by TTL. Without the breakdown every write is taken as 5-minute
    (the default TTL, and the one this codebase uses).
    """
    write_total = _int(_get(usage, "cache_creation_input_tokens"))
    breakdown = _get(usage, "cache_creation")
    w5 = _int(_get(breakdown, "ephemeral_5m_input_tokens")) if breakdown is not None else 0
    w1 = _int(_get(breakdown, "ephemeral_1h_input_tokens")) if breakdown is not None else 0
    if breakdown is None or (w5 + w1) == 0:
        w5, w1 = write_total, 0
    details = _get(usage, "output_tokens_details")
    return {
        "input": _int(_get(usage, "input_tokens")),
        "output": _int(_get(usage, "output_tokens")),
        "cache_read": _int(_get(usage, "cache_read_input_tokens")),
        "cache_write_5m": w5,
        "cache_write_1h": w1,
        "thinking": _int(_get(details, "thinking_tokens")),
    }


def call_cost(model: str, u: dict[str, int]) -> tuple[float, str]:
    """USD for one API call, and the tier it was priced at ("base" | "long")."""
    p, _known = pricing_for(model)
    prompt = u["input"] + u["cache_read"] + u["cache_write_5m"] + u["cache_write_1h"]
    tier_name = "long" if (p.long is not None and prompt > p.threshold) else "base"
    t = p.long if tier_name == "long" else p.base
    usd = (u["input"] * t.input + u["output"] * t.output + u["cache_read"] * t.cache_read
           + u["cache_write_5m"] * t.cache_write_5m + u["cache_write_1h"] * t.cache_write_1h) / 1_000_000
    return usd, tier_name


@dataclass
class Meter:
    """Usage and cost of one request, accumulated call by call."""

    model: str
    calls: int = 0
    tokens: dict[str, int] = field(default_factory=lambda: {
        "input": 0, "output": 0, "cache_read": 0, "cache_write_5m": 0, "cache_write_1h": 0, "thinking": 0})
    cost_usd: float = 0.0
    long_calls: int = 0
    max_prompt: int = 0

    def add(self, usage: Any) -> dict[str, int]:
        u = normalize_usage(usage)
        usd, tier = call_cost(self.model, u)
        self.calls += 1
        for k in self.tokens:
            self.tokens[k] += u[k]
        self.cost_usd += usd
        self.long_calls += tier == "long"
        self.max_prompt = max(self.max_prompt, u["input"] + u["cache_read"] + u["cache_write_5m"] + u["cache_write_1h"])
        return u

    @property
    def cache_write(self) -> int:
        return self.tokens["cache_write_5m"] + self.tokens["cache_write_1h"]


# ── Keys and time ─────────────────────────────────────────────────────────────


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def day_key(ts: datetime) -> str:
    return ts.astimezone(timezone.utc).strftime("%Y-%m-%d")


def month_key(ts: datetime) -> str:
    return ts.astimezone(timezone.utc).strftime("%Y-%m")


def hash_ip(ip: str | None) -> str | None:
    """Salted SHA-256, as services/analytics does. Raw IPs are never stored."""
    if not ip:
        return None
    from app.config import get_settings

    return hashlib.sha256((get_settings().ip_hash_salt + ip).encode()).hexdigest()


# ── Indexes ───────────────────────────────────────────────────────────────────


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[REQUESTS].create_index("ts", expireAfterSeconds=RETENTION_DAYS * 24 * 3600)
    await db[REQUESTS].create_index("request_id", unique=True)
    await db[REQUESTS].create_index([("feature", 1), ("ts", -1)])
    await db[REQUESTS].create_index([("feature", 1), ("visitor", 1), ("ts", -1)])
    await db[REQUESTS].create_index([("conversation_id", 1), ("turn", 1)])
    await db[REQUESTS].create_index([("site", 1), ("feature", 1), ("ts", -1)])
    # Admin → AI → Users and the per-person checks (user_check).
    await db[REQUESTS].create_index([("user_id", 1), ("ts", -1)])
    await db[SETTINGS_AUDIT].create_index([("ts", -1)])
    # Day rows are only read for today; month rows for this month. A year is plenty.
    await db[SPEND].create_index("expires_at", expireAfterSeconds=0)


# ── Ledger ────────────────────────────────────────────────────────────────────


async def record(
    db: AsyncIOMotorDatabase,
    *,
    feature: str,
    meter: Meter,
    request_id: str,
    outcome: str,
    latency_ms: int | None = None,
    ttft_ms: int | None = None,
    user_id: str | None = None,
    ip_hash: str | None = None,
    visitor: str | None = None,
    site: str | None = None,
    meta: dict | None = None,
    ts: datetime | None = None,
) -> dict:
    """Write one ledger row and bump the spend counters. Returns the row.

    With `site`, the row carries it and the site's own counters are bumped too.
    """
    ts = ts or now_utc()
    _p, known = pricing_for(meter.model)
    row = {
        "feature": feature,
        "request_id": request_id,
        "ts": ts,
        "day": day_key(ts),
        "model": meter.model,
        "priced": known,
        "calls": meter.calls,
        "usage": dict(meter.tokens),
        "cost_usd": round(meter.cost_usd, 8),
        "long_context_calls": meter.long_calls,
        "max_prompt_tokens": meter.max_prompt,
        "latency_ms": latency_ms,
        "ttft_ms": ttft_ms,
        "outcome": outcome,
        "user_id": user_id,
        "ip_hash": ip_hash,
        "visitor": visitor,
        **({"site": site} if site else {}),
        **(meta or {}),
    }
    await db[REQUESTS].insert_one(dict(row))
    if meter.cost_usd > 0:
        await _bump(db, feature, ts, meter.cost_usd, site=site)
    return row


async def _bump(db: AsyncIOMotorDatabase, feature: str, ts: datetime, usd: float, site: str | None = None) -> None:
    d, m = day_key(ts), month_key(ts)
    day_exp = ts + timedelta(days=40)
    month_exp = ts + timedelta(days=400)
    for f in (feature, ALL) + ((site_scope(feature, site),) if site else ()):
        await db[SPEND].update_one({"_id": f"{f}:d:{d}"},
                                   {"$inc": {"usd": usd, "n": 1}, "$set": {"expires_at": day_exp}}, upsert=True)
        await db[SPEND].update_one({"_id": f"{f}:m:{m}"},
                                   {"$inc": {"usd": usd, "n": 1}, "$set": {"expires_at": month_exp}}, upsert=True)


async def _spend(db: AsyncIOMotorDatabase, key: str) -> float:
    row = await db[SPEND].find_one({"_id": key}, {"usd": 1})
    return float(row["usd"]) if row else 0.0


async def spend_today(db: AsyncIOMotorDatabase, feature: str = ALL, now: datetime | None = None) -> float:
    return await _spend(db, f"{feature}:d:{day_key(now or now_utc())}")


async def spend_month(db: AsyncIOMotorDatabase, feature: str = ALL, now: datetime | None = None) -> float:
    return await _spend(db, f"{feature}:m:{month_key(now or now_utc())}")


# ── Budget ────────────────────────────────────────────────────────────────────

# USD held per running request of a feature, released when it is recorded.
_reserved: dict[str, float] = {}


@dataclass
class BudgetState:
    ok: bool
    reason: str | None          # "daily" | "monthly" | None
    today: float
    month: float
    daily_cap: float
    monthly_cap: float


async def budget(db: AsyncIOMotorDatabase, feature: str, *, daily_cap: float, monthly_cap: float,
                 reserve: float = 0.0, now: datetime | None = None) -> BudgetState:
    """Would one more request (estimated at `reserve` USD) stay inside both caps?

    `feature` may be a site_scope() key for one site's caps. Includes what
    running requests of this feature (or site) have reserved. A cap of 0
    (or less) blocks everything: that is how an operator says "no spend".
    """
    today = await spend_today(db, feature, now)
    month = await spend_month(db, feature, now)
    held = _reserved.get(feature, 0.0)
    reason = None
    if today + held + reserve > daily_cap:
        reason = "daily"
    elif month + held + reserve > monthly_cap:
        reason = "monthly"
    return BudgetState(ok=reason is None, reason=reason, today=today, month=month,
                       daily_cap=daily_cap, monthly_cap=monthly_cap)


def hold(feature: str, usd: float) -> None:
    _reserved[feature] = _reserved.get(feature, 0.0) + usd


def release(feature: str, usd: float) -> None:
    left = _reserved.get(feature, 0.0) - usd
    if left <= 1e-12:
        _reserved.pop(feature, None)
    else:
        _reserved[feature] = left


# ── Small helpers for features ────────────────────────────────────────────────


class Stopwatch:
    def __init__(self) -> None:
        self.t0 = time.monotonic()
        self.first: float | None = None

    def mark_first(self) -> None:
        if self.first is None:
            self.first = time.monotonic()

    @property
    def ttft_ms(self) -> int | None:
        return int((self.first - self.t0) * 1000) if self.first is not None else None

    @property
    def elapsed_ms(self) -> int:
        return int((time.monotonic() - self.t0) * 1000)


# ── Features, admin settings and per-person checks ────────────────────────────
#
# Every feature that records to the ledger is listed in FEATURES. Its caps and switch have a
# config default (config.py) that the admin panel can override (routers/admin_ai.py, collection
# `ai_settings`); "*" is the cap on all features together. Overrides are cached in-process for
# CACHE_TTL seconds and the cache is dropped on every admin write, so a change takes effect at
# once on the process that saved it and within CACHE_TTL on the others.
#
# A feature asks, before it calls the model:
#
#     if not await ai_usage.feature_on(db, FEATURE): ...           # admin switch AND config switch
#     why = await ai_usage.user_check(db, user_id, FEATURE)          # blocked | user_daily | burst
#     state = await ai_usage.check_budget(db, FEATURE, reserve=R)    # its caps, then the global ones
#     ai_usage.hold_request(FEATURE, R); ...; ai_usage.release_request(FEATURE, R)

#: key → label, for every feature that records to the ledger. The admin panel lists these.
FEATURES: dict[str, str] = {
    "docs_ask": "Docs Ask AI",
    "docs_editor": "Guides editor AI",
    "pages_ai": "Pages AI",
    "search_ai": "AI search",
}

SETTINGS = "ai_settings"
SETTINGS_AUDIT = "ai_settings_audit"
BUDGETS_ID = "budgets"
CACHE_TTL = 10.0
INF = float("inf")

# feature → (daily cap field, monthly cap field, kill-switch fields that must all be true).
# A missing or None config value means "no cap".
_CONFIG: dict[str, tuple[str, str, tuple[str, ...]]] = {
    ALL: ("ai_daily_usd", "ai_monthly_usd", ()),
    "docs_ask": ("docs_ai_daily_usd", "docs_ai_monthly_usd", ("docs_ai_enabled",)),
    # Guides editor AI is off whenever Ask AI is (services/docs_editor_ai.py).
    "docs_editor": ("docs_editor_ai_daily_usd", "docs_editor_ai_monthly_usd",
                    ("docs_editor_ai_enabled", "docs_ai_enabled")),
    "pages_ai": ("pages_ai_daily_usd", "pages_ai_monthly_usd", ("pages_ai_enabled",)),
    "search_ai": ("search_ai_daily_usd", "search_ai_monthly_usd", ("search_ai_enabled",)),
}

_cache: dict[tuple[str, str], tuple[float, Any]] = {}


def invalidate_settings() -> None:
    """Drop the cached admin settings (every admin write calls this)."""
    _cache.clear()


async def _cached(db: AsyncIOMotorDatabase, key: str, load) -> Any:
    ck = (getattr(db, "name", ""), key)
    hit = _cache.get(ck)
    t = time.monotonic()
    if hit is not None and hit[0] > t:
        return hit[1]
    value = await load()
    _cache[ck] = (t + CACHE_TTL, value)
    return value


async def admin_settings(db: AsyncIOMotorDatabase) -> dict:
    """The admin's overrides (cached): {caps: {feature: {daily_usd, monthly_usd}}, enabled:
    {feature: bool}, burst: {per_minute, per_day}, user_daily_usd}. A missing key = the default."""
    async def load() -> dict:
        try:
            row = await db[SETTINGS].find_one({"_id": BUDGETS_ID})
        except Exception:
            log.warning("ai settings: read failed, using the config defaults")
            row = None
        return row or {}
    return await _cached(db, BUDGETS_ID, load)


async def user_settings(db: AsyncIOMotorDatabase, user_id: str) -> dict:
    """One person's AI settings (cached): {blocked: bool, daily_usd: float | None}."""
    async def load() -> dict:
        try:
            row = await db[SETTINGS].find_one({"_id": f"user:{user_id}"})
        except Exception:
            row = None
        return row or {}
    return await _cached(db, f"user:{user_id}", load)


def _num(v) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def default_caps(feature: str) -> tuple[float, float]:
    """The config default (daily, monthly) USD caps of a feature or "*"; INF = no cap."""
    from app.config import get_settings

    s = get_settings()
    fields = _CONFIG.get(feature)
    if fields is None:
        return INF, INF
    d, m = (_num(getattr(s, f, None)) for f in fields[:2])
    return (INF if d is None else d), (INF if m is None else m)


def default_on(feature: str) -> bool:
    from app.config import get_settings

    s = get_settings()
    fields = _CONFIG.get(feature)
    return all(bool(getattr(s, f, False)) for f in (fields[2] if fields else ()))


async def caps(db: AsyncIOMotorDatabase, feature: str) -> tuple[float, float]:
    """(daily_usd, monthly_usd) for a feature, or "*" for all features together: the admin's
    override from `ai_settings`, else the config default. float('inf') means no cap; 0 blocks
    all spend."""
    d, m = default_caps(feature)
    o = ((await admin_settings(db)).get("caps") or {}).get(feature) or {}
    od, om = _num(o.get("daily_usd")), _num(o.get("monthly_usd"))
    return (d if od is None else od), (m if om is None else om)


async def feature_on(db: AsyncIOMotorDatabase, feature: str) -> bool:
    """The admin's per-feature switch (default on) AND the config kill switch."""
    if not default_on(feature):
        return False
    return (await admin_settings(db)).get("enabled", {}).get(feature, True) is not False


async def burst_limits(db: AsyncIOMotorDatabase) -> tuple[int, int]:
    """(per_minute, per_day) requests per signed-in person across all AI features."""
    from app.config import get_settings

    s = get_settings()
    b = (await admin_settings(db)).get("burst") or {}
    pm, pd = _num(b.get("per_minute")), _num(b.get("per_day"))
    return (int(pm) if pm is not None else int(s.ai_burst_per_minute),
            int(pd) if pd is not None else int(s.ai_burst_per_day))


async def default_user_daily(db: AsyncIOMotorDatabase) -> float | None:
    """The per-person daily USD cap everyone gets unless their own is set (None: no cap)."""
    from app.config import get_settings

    o = await admin_settings(db)
    if "user_daily_usd" in o:
        return _num(o.get("user_daily_usd"))
    return _num(get_settings().ai_user_daily_usd)


async def user_daily_cap(db: AsyncIOMotorDatabase, user_id: str) -> float | None:
    """This person's daily USD cap: their own override, else the default (None: no cap)."""
    own = _num((await user_settings(db, user_id)).get("daily_usd"))
    return own if own is not None else await default_user_daily(db)


def utc_midnight(now: datetime | None = None) -> datetime:
    n = (now or now_utc()).astimezone(timezone.utc)
    return n.replace(hour=0, minute=0, second=0, microsecond=0)


async def user_spend_today(db: AsyncIOMotorDatabase, user_id: str, now: datetime | None = None) -> float:
    """USD this person's AI requests cost since UTC midnight, all features (from the ledger)."""
    total = 0.0
    async for r in db[REQUESTS].find({"user_id": user_id, "ts": {"$gte": utc_midnight(now)}}, {"cost_usd": 1}):
        total += float(r.get("cost_usd") or 0)
    return total


# Checks passed in this process per person (monotonic times), so a burst of concurrent requests
# can't all pass before any of them is recorded. The ledger covers the other API processes.
_recent: dict[str, list[float]] = {}


def _recent_count(user_id: str, seconds: float) -> int:
    t = time.monotonic()
    xs = [x for x in _recent.get(user_id, []) if t - x < 86_400]
    if xs:
        _recent[user_id] = xs
    else:
        _recent.pop(user_id, None)
    return sum(1 for x in xs if t - x < seconds)


async def user_check(db: AsyncIOMotorDatabase, user_id: str | None, feature: str,
                     now: datetime | None = None, *, peek: bool = False) -> str | None:
    """Can this signed-in person make one more AI request? None = yes; else why not:
    "blocked" (an admin blocked them from AI), "user_daily" (their daily USD cap is reached),
    "burst" (more than the per-minute or per-day request limit, all AI features together).
    Signed-out callers (no user_id) are not checked here. A passing check counts towards the
    burst limit, unless `peek` (a status read that won't call the model)."""
    if not user_id:
        return None
    if (await user_settings(db, user_id)).get("blocked"):
        return "blocked"
    cap = await user_daily_cap(db, user_id)
    if cap is not None and await user_spend_today(db, user_id, now) >= cap:
        return "user_daily"
    per_minute, per_day = await burst_limits(db)
    n = now or now_utc()
    q = {"user_id": user_id, "outcome": {"$ne": "limit"}}
    minute = await db[REQUESTS].count_documents({**q, "ts": {"$gte": n - timedelta(minutes=1)}})
    if max(minute, _recent_count(user_id, 60)) >= per_minute:
        return "burst"
    today = await db[REQUESTS].count_documents({**q, "ts": {"$gte": utc_midnight(n)}})
    if max(today, _recent_count(user_id, (n - utc_midnight(n)).total_seconds())) >= per_day:
        return "burst"
    if not peek:
        _recent.setdefault(user_id, []).append(time.monotonic())
    return None


async def check_budget(db: AsyncIOMotorDatabase, feature: str, *, reserve: float = 0.0,
                       now: datetime | None = None) -> BudgetState:
    """The feature's caps (caps(feature)), then all features' together (caps("*")). A failing
    global check says reason "global_daily" / "global_monthly"."""
    d, m = await caps(db, feature)
    state = await budget(db, feature, daily_cap=d, monthly_cap=m, reserve=reserve, now=now)
    if not state.ok:
        return state
    gd, gm = await caps(db, ALL)
    if gd == INF and gm == INF:
        return state
    g = await budget(db, ALL, daily_cap=gd, monthly_cap=gm, reserve=reserve, now=now)
    if not g.ok:
        g.reason = f"global_{g.reason}"
        return g
    return state


def hold_request(feature: str, usd: float) -> None:
    """hold() for the feature and for "*" (check_budget reads both)."""
    hold(feature, usd)
    hold(ALL, usd)


def release_request(feature: str, usd: float) -> None:
    release(feature, usd)
    release(ALL, usd)
