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
month, plus "*" for all features), bumped with $inc in the same step as the
ledger row. That makes the caps exact across API workers and restarts. A small
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
    meta: dict | None = None,
    ts: datetime | None = None,
) -> dict:
    """Write one ledger row and bump the spend counters. Returns the row."""
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
        **(meta or {}),
    }
    await db[REQUESTS].insert_one(dict(row))
    if meter.cost_usd > 0:
        await _bump(db, feature, ts, meter.cost_usd)
    return row


async def _bump(db: AsyncIOMotorDatabase, feature: str, ts: datetime, usd: float) -> None:
    d, m = day_key(ts), month_key(ts)
    day_exp = ts + timedelta(days=40)
    month_exp = ts + timedelta(days=400)
    for f in (feature, ALL):
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

    Includes what running requests of this feature have reserved. A cap of 0
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
