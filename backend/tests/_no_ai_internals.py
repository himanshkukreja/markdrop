"""What a non-admin response must never carry (memory: feedback_no_internal_ai_details): what AI
cost, the budgets and caps, or which model answered. The ledger (ai_usage / ai_log) and the admin
routes keep them; every person-facing AI response, stream event and MCP result goes through
:func:`leaks` in its tests."""
from __future__ import annotations

from typing import Any

#: Keys that name a cost, a budget or the model, anywhere in a response.
KEYS = {"cost_usd", "total_cost_usd", "est_usd", "usd", "left_today_usd", "model", "budget",
        "daily_cap_usd", "monthly_cap_usd", "cost_estimate_usd"}


def leaks(obj: Any, path: str = "$") -> list[str]:
    """Where ``obj`` (decoded JSON, or SSE events as (event, data) pairs) carries one of
    :data:`KEYS` or any ``*_usd`` key."""
    out: list[str] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(k, str) and (k in KEYS or k.endswith("_usd")):
                out.append(f"{path}.{k}")
            out += leaks(v, f"{path}.{k}")
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            out += leaks(v, f"{path}[{i}]")
    return out


def assert_clean(tc, obj: Any) -> Any:
    """Fails ``tc`` when ``obj`` leaks an AI internal; returns ``obj``."""
    tc.assertEqual(leaks(obj), [], "a person-facing AI response carries a cost, budget or model field")
    return obj
