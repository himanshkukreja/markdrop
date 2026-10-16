"""Who a campaign goes to, and the merge data each person brings.

Everything is built from one snapshot of accounts (cached 60 s, dropped before
queueing): per user the documents and artifacts they own, when they last
published, whether they hold a VS Code token, whether they belong to a
workspace. Segments pick from it; exclusions are applied in a fixed order and
each is counted, so the admin sees exactly why the number is what it is:

    duplicate → unsubscribed → suppressed (bounce / complaint / manual)
              → already in this campaign (top-ups)

A pasted custom list may contain addresses with no account: they get empty
merge data (fallbacks apply) and the same exclusions.
"""

from __future__ import annotations

import asyncio
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings

from .tags import MergeVars, first_name_of

settings = get_settings()

CUSTOM_RE = re.compile(r"^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$")
PRESET_KINDS = ("all", "recent", "active", "with_documents", "with_artifacts", "never_published", "vscode", "workspace")

_cache: dict[str, Any] = {"at": 0.0, "value": None, "lock": None}
_TTL = 60.0


def invalidate() -> None:
    _cache["value"] = None
    _cache["lock"] = None


def _aware(d: Any) -> datetime | None:
    if not isinstance(d, datetime):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


async def _build(db: AsyncIOMotorDatabase) -> dict[str, Any]:
    async def users():
        return await db["users"].find(
            {}, {"email": 1, "name": 1, "created_at": 1, "last_login_at": 1, "unsubscribed_at": 1}
        ).to_list(length=None)

    async def docs():
        pipeline = [
            {"$match": {"owner_id": {"$ne": None}}},
            {"$group": {
                "_id": {"o": "$owner_id", "a": {"$eq": ["$kind", "artifact"]}},
                "n": {"$sum": 1},
                "last": {"$max": "$created_at"},
            }},
        ]
        return await db["documents"].aggregate(pipeline).to_list(length=None)

    async def tokens():
        return set(await db["api_tokens"].distinct("user_id"))

    async def members():
        return set(await db["memberships"].distinct("user_id"))

    async def suppressions():
        return {d["_id"]: d.get("reason", "manual") async for d in db["email_suppressions"].find({}, {"reason": 1})}

    u, d, t, m, s = await asyncio.gather(users(), docs(), tokens(), members(), suppressions())
    per: dict[str, dict[str, Any]] = {}
    for row in d:
        o = str(row["_id"]["o"])
        p = per.setdefault(o, {"docs": 0, "artifacts": 0, "last": None})
        if row["_id"]["a"]:
            p["artifacts"] += row["n"]
        else:
            p["docs"] += row["n"]
        last = _aware(row.get("last"))
        if last and (p["last"] is None or last > p["last"]):
            p["last"] = last

    people: dict[str, dict[str, Any]] = {}
    for row in u:
        email = (row.get("email") or "").strip().lower()
        if not email or email in people:
            continue
        uid = str(row["_id"])
        stats = per.get(uid, {"docs": 0, "artifacts": 0, "last": None})
        login = _aware(row.get("last_login_at"))
        last_active = max([x for x in (login, stats["last"]) if x], default=None)
        people[email] = {
            "user_id": uid,
            "email": email,
            "name": (row.get("name") or "").strip() or None,
            "created_at": _aware(row.get("created_at")),
            "last_login_at": login,
            "last_published": stats["last"],
            "last_active": last_active,
            "docs": stats["docs"],
            "artifacts": stats["artifacts"],
            "vscode": uid in t,
            "workspace": uid in m,
            "unsubscribed": bool(row.get("unsubscribed_at")),
        }
    return {"people": people, "suppressions": s}


async def base(db: AsyncIOMotorDatabase) -> dict[str, Any]:
    now = time.monotonic()
    if _cache["value"] is not None and now - _cache["at"] < _TTL:
        return _cache["value"]
    if _cache["lock"] is None:
        _cache["lock"] = asyncio.Lock()
    async with _cache["lock"]:
        if _cache["value"] is not None and time.monotonic() - _cache["at"] < _TTL:
            return _cache["value"]
        value = await _build(db)
        _cache.update(value=value, at=time.monotonic())
        return value


def parse_custom(text: str) -> tuple[list[str], int]:
    """Pasted addresses → (valid lower-cased list in order, invalid count)."""
    valid: list[str] = []
    invalid = 0
    for raw in re.split(r"[\s,;]+", text or ""):
        t = raw.strip().strip("<>").strip().lower()
        if "<" in t:
            t = t.split("<")[-1]
        if not t:
            continue
        if CUSTOM_RE.match(t) and len(t) <= 254:
            valid.append(t)
        else:
            invalid += 1
    return valid, invalid


def _candidates(spec: dict[str, Any], b: dict[str, Any]) -> tuple[list[str], int]:
    people = b["people"]
    kind = spec.get("kind", "all")
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=int(spec.get("days") or 30))
    n = int(spec.get("min") or 1)
    if kind == "custom":
        return parse_custom(spec.get("emails") or "")
    pick = {
        "all": lambda p: True,
        "recent": lambda p: bool(p["created_at"] and p["created_at"] >= since),
        "active": lambda p: bool(p["last_active"] and p["last_active"] >= since),
        "with_documents": lambda p: p["docs"] >= n,
        "with_artifacts": lambda p: p["artifacts"] >= n,
        "never_published": lambda p: p["docs"] + p["artifacts"] == 0,
        "vscode": lambda p: p["vscode"],
        "workspace": lambda p: p["workspace"],
    }.get(kind, lambda p: True)
    return [e for e, p in people.items() if pick(p)], 0


def resolve_with(spec: dict[str, Any], b: dict[str, Any], exclude: set[str] | None = None) -> dict[str, Any]:
    people, sup = b["people"], b["suppressions"]
    cands, invalid = _candidates(spec, b)
    seen: set[str] = set()
    counts = {"duplicates": 0, "unsubscribed": 0, "suppressed": 0, "already": 0}
    recipients: list[dict[str, Any]] = []
    for e in cands:
        if e in seen:
            counts["duplicates"] += 1
            continue
        seen.add(e)
        p = people.get(e)
        reason = sup.get(e)
        if (p and p["unsubscribed"]) or reason == "unsubscribed":
            counts["unsubscribed"] += 1
            continue
        if reason:
            counts["suppressed"] += 1
            continue
        if exclude and e in exclude:
            counts["already"] += 1
            continue
        recipients.append({"email": e, "name": p["name"] if p else None, "user_id": p["user_id"] if p else None})
    recipients.sort(key=lambda r: r["email"])
    return {
        "recipients": recipients,
        "count": {
            "eligible": len(recipients),
            "invalid": invalid,
            **counts,
            "sample": [r["email"] for r in recipients[:6]],
        },
    }


async def resolve(db: AsyncIOMotorDatabase, spec: dict[str, Any], exclude: set[str] | None = None) -> dict[str, Any]:
    return resolve_with(spec, await base(db), exclude)


async def preset_counts(db: AsyncIOMotorDatabase, spec: dict[str, Any]) -> dict[str, int]:
    b = await base(db)
    days, n = spec.get("days") or 30, spec.get("min") or 1
    return {k: resolve_with({"kind": k, "days": days, "min": n}, b)["count"]["eligible"] for k in PRESET_KINDS}


def _fmt_date(d: datetime | None) -> str:
    return f"{d.day} {d.strftime('%b %Y')}" if d else ""


def vars_for_person(email: str, p: dict[str, Any] | None) -> MergeVars:
    site = settings.frontend_url.rstrip("/")
    name = (p or {}).get("name") or ""
    return {
        "first_name": first_name_of(name),
        "name": name,
        "email": email,
        "doc_count": str((p or {}).get("docs", 0)),
        "artifact_count": str((p or {}).get("artifacts", 0)),
        "joined": _fmt_date((p or {}).get("created_at")),
        "vscode_user": "yes" if (p or {}).get("vscode") else "",
        "site_url": site,
        "dashboard_url": f"{site}/dashboard",
        "unsubscribe_url": "",
    }


async def merge_vars_for(db: AsyncIOMotorDatabase, emails: list[str]) -> dict[str, MergeVars]:
    b = await base(db)
    return {e: vars_for_person(e, b["people"].get(e)) for e in emails}


def _meta(p: dict[str, Any]) -> str:
    bits = [f"{p['docs']} doc{'s' if p['docs'] != 1 else ''}"]
    if p["artifacts"]:
        bits.append(f"{p['artifacts']} file{'s' if p['artifacts'] != 1 else ''}")
    if p["vscode"]:
        bits.append("VS Code")
    return " · ".join(bits)


async def search(db: AsyncIOMotorDatabase, q: str, limit: int = 8) -> list[dict[str, Any]]:
    """"Preview as" candidates: an exact unknown address becomes one custom
    entry; otherwise accounts matching the email or name, most recently active
    first (the most recently active people when the query is empty)."""
    b = await base(db)
    people = b["people"]
    t = (q or "").strip().lower()[:120]

    def entry(email: str, p: dict[str, Any] | None) -> dict[str, Any]:
        return {
            "email": email,
            "name": p["name"] if p else None,
            "user_id": p["user_id"] if p else None,
            "source": "account" if p else "custom",
            "meta": _meta(p) if p else "no account · empty merge data",
            "vars": vars_for_person(email, p),
        }

    if t and CUSTOM_RE.match(t) and t not in people:
        return [entry(t, None)]
    epoch = datetime.min.replace(tzinfo=timezone.utc)
    ranked = sorted(people.values(), key=lambda p: p["last_active"] or p["created_at"] or epoch, reverse=True)
    hits = [p for p in ranked if not t or t in p["email"] or t in (p["name"] or "").lower()]
    return [entry(p["email"], p) for p in hits[:limit]]


async def blocked(db: AsyncIOMotorDatabase, emails: list[str]) -> dict[str, str]:
    """Fresh (uncached) unsubscribe / suppression state for these addresses,
    checked right before each batch: email → "unsubscribed" | "suppressed"."""
    if not emails:
        return {}
    out: dict[str, str] = {}
    async for d in db["email_suppressions"].find({"_id": {"$in": emails}}, {"reason": 1}):
        out[d["_id"]] = "unsubscribed" if d.get("reason") == "unsubscribed" else "suppressed"
    async for u in db["users"].find(
        {"email": {"$in": emails}, "unsubscribed_at": {"$ne": None}}, {"email": 1}
    ):
        out[(u.get("email") or "").lower()] = "unsubscribed"
    return out
