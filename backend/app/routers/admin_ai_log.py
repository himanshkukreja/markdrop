"""Admin → AI → Requests: every AI call as a readable conversation (services/ai_log.py).

    GET  /api/v1/admin/ai/log/conversations              the list (filters below), newest activity first
    GET  /api/v1/admin/ai/log/conversations/{id}         one conversation: every call in order, as said
    GET  /api/v1/admin/ai/log/conversations/{id}/markdown  the transcript as Markdown (copy / export)
    GET  /api/v1/admin/ai/log/summary                    totals by feature and by person, for the filters
    GET  /api/v1/admin/ai/log/settings                   content capture, internal accounts and addresses
    PUT  /api/v1/admin/ai/log/settings

Filters (every list): ``audience`` real (default) | system | public | test | live | all, ``feature``,
``workspace`` (id), ``user`` (an account id, or part of an email or name), ``outcome`` ok | error |
limit | refused, ``since`` / ``until`` (ISO dates, UTC), ``q`` (text in the question, the answer, the
label or the person). A conversation is listed when any of its calls matches; its numbers count all
of its calls. Admins only (routers/admin.require_admin: anyone else gets a 404).
"""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel

from app.routers.admin import get_db, require_admin
from app.services import ai_log, ai_usage

router = APIRouter(prefix="/api/v1/admin/ai/log", tags=["admin"])

ROW_CAP = 20_000
OUTCOMES = ("ok", "error", "limit", "refused")
_LIST_FIELDS = {k: 1 for k in (
    "ts", "conversation_id", "feature", "kind", "label", "actor", "actor_kind", "test", "test_reason", "job", "app",
    "user_id", "user_email", "user_name", "ip_hash", "workspace_id", "workspace_name", "scope_label", "preview",
    "cost_usd", "usage", "outcome", "latency_ms", "via", "site", "content")}
ACTOR_LABEL = {"user": "Person", "api": "AI app", "system": "System", "public": "Public", "test": "Test & internal"}
TEST_REASON = {"header": "Test harness (X-Markdrop-Test)", "test_domain": "Test email domain",
               "internal": "Internal account", "local": "From localhost or our server", "client": "Test client"}


def _aware(d: datetime | None) -> datetime | None:
    if d is None:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _iso(d: datetime | None) -> str | None:
    d = _aware(d)
    return d.isoformat() if d else None


def _day(s: str | None, *, end: bool = False) -> datetime | None:
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s.strip().replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(400, "Dates look like 2026-11-07.")
    d = _aware(d)
    if end and len(s.strip()) <= 10:
        d = d + timedelta(days=1)
    return d


def _outcome_kind(o: str | None) -> str:
    if o in ("limit",):
        return "limit"
    if o in ("refused",):
        return "refused"
    if o in ("error", None, "unparsed"):
        return "error"
    return "ok"


def _query(*, audience: str, feature: str | None, workspace: str | None, user: str | None, outcome: str | None,
           since: str | None, until: str | None, q: str | None) -> dict:
    cond: list[dict] = [ai_log.audience_query(audience if audience in ai_log.AUDIENCES else "real")]
    s, u = _day(since), _day(until, end=True)
    if s or u:
        cond.append({"ts": {**({"$gte": s} if s else {}), **({"$lt": u} if u else {})}})
    if feature:
        cond.append({"feature": feature})
    if workspace:
        cond.append({"workspace_id": workspace})
    if user:
        if ObjectId.is_valid(user):
            cond.append({"user_id": user})
        else:
            rx = {"$regex": re.escape(user.strip()), "$options": "i"}
            cond.append({"$or": [{"user_email": rx}, {"user_name": rx}, {"job": rx}, {"app": rx}]})
    if outcome:
        if outcome not in OUTCOMES:
            raise HTTPException(400, f"Outcome is one of: {', '.join(OUTCOMES)}.")
        cond.append({"outcome": {"$in": [None, "error", "unparsed"]}} if outcome == "error"
                    else {"outcome": outcome} if outcome in ("limit", "refused")
                    else {"outcome": {"$nin": [None, "error", "unparsed", "limit", "refused"]}})
    if q and q.strip():
        rx = {"$regex": re.escape(q.strip()[:200]), "$options": "i"}
        cond.append({"$or": [{"input": rx}, {"output": rx}, {"label": rx}, {"description": rx}, {"user_email": rx},
                             {"user_name": rx}, {"scope_label": rx}, {"selection": rx}]})
    cond = [c for c in cond if c]
    return {"$and": cond} if len(cond) > 1 else (cond[0] if cond else {})


def _tokens(r: dict) -> tuple[int, int]:
    u = r.get("usage") or {}
    tin = int(u.get("input") or 0) + int(u.get("cache_read") or 0) + int(u.get("cache_write_5m") or 0) \
        + int(u.get("cache_write_1h") or 0)
    return tin, int(u.get("output") or 0)


def _who(r: dict) -> dict:
    """How the admin sees who made a call."""
    kind = r.get("actor_kind") or r.get("actor") or ("user" if r.get("user_id") else "public")
    if kind == "system":
        name = r.get("job") or "System"
        sub = r.get("workspace_name")
    elif kind == "public":
        h = r.get("ip_hash") or ""
        name = f"Visitor {h[:8]}" if h else "Visitor"
        sub = None
    else:
        name = r.get("user_name") or (r.get("user_email") or "").split("@")[0] or "Deleted account"
        sub = r.get("user_email")
        if kind == "api":
            sub = " · ".join(x for x in (sub, f"via {r.get('app') or 'AI app'}") if x)
    return {"kind": kind, "actor": r.get("actor") or kind, "name": name, "sub": sub, "user_id": r.get("user_id"),
            "email": r.get("user_email"), "test": bool(r.get("test")), "test_reason": r.get("test_reason"),
            "test_reason_label": TEST_REASON.get(r.get("test_reason") or ""), "job": r.get("job"), "app": r.get("app")}


def _conv_card(cid: str, rows: list[dict]) -> dict:
    rows = sorted(rows, key=lambda r: _aware(r.get("ts")) or datetime.min.replace(tzinfo=timezone.utc))
    first, last = rows[0], rows[-1]
    tin = tout = 0
    cost = 0.0
    outcomes: dict[str, int] = defaultdict(int)
    for r in rows:
        a, b = _tokens(r)
        tin += a
        tout += b
        cost += float(r.get("cost_usd") or 0)
        outcomes[_outcome_kind(r.get("outcome"))] += 1
    title = first.get("preview") or first.get("label") or "AI request"
    return {
        "conversation_id": cid, "title": title, "label": first.get("label"), "feature": first.get("feature"),
        "kind": first.get("kind"), "features": sorted({r.get("feature") for r in rows if r.get("feature")}),
        "who": _who(first), "workspace_id": first.get("workspace_id"), "workspace_name": first.get("workspace_name"),
        "scope_label": next((r.get("scope_label") for r in rows if r.get("scope_label")), None),
        "turns": len(rows), "first_ts": _iso(first.get("ts")), "last_ts": _iso(last.get("ts")),
        "cost_usd": round(cost, 6), "tokens_in": tin, "tokens_out": tout, "outcomes": dict(outcomes),
        "has_error": bool(outcomes.get("error")), "content": any(r.get("content") for r in rows),
        "via": first.get("via"),
    }


@router.get("/conversations")
async def conversations(
    audience: str = Query("real"),
    feature: str | None = Query(None, max_length=40),
    workspace: str | None = Query(None, max_length=40),
    user: str | None = Query(None, max_length=200),
    outcome: str | None = Query(None, max_length=20),
    since: str | None = Query(None, max_length=40),
    until: str | None = Query(None, max_length=40),
    q: str | None = Query(None, max_length=200),
    page: int = Query(1, ge=1, le=10_000),
    limit: int = Query(25, ge=1, le=100),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """Conversations with a call matching the filters, the latest activity first."""
    query = _query(audience=audience, feature=feature, workspace=workspace, user=user, outcome=outcome,
                   since=since, until=until, q=q)
    hits = await db[ai_log.COLL].find(query, {"conversation_id": 1, "ts": 1}).sort("ts", -1).to_list(length=ROW_CAP)
    order: list[str] = []
    seen: set[str] = set()
    for h in hits:
        cid = h.get("conversation_id") or f"r:{h['_id']}"
        if cid not in seen:
            seen.add(cid)
            order.append(cid)
    total = len(order)
    start = (page - 1) * limit
    ids = order[start:start + limit]
    rows = await db[ai_log.COLL].find({"conversation_id": {"$in": ids}}, _LIST_FIELDS).to_list(length=ROW_CAP)
    by: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by[r["conversation_id"]].append(r)
    items = [_conv_card(cid, by[cid]) for cid in ids if by.get(cid)]
    return {"audience": audience, "page": page, "pages": max(1, -(-total // limit)), "total": total,
            "truncated": len(hits) >= ROW_CAP, "items": items,
            "counts": await _audience_counts(db, since=since, until=until)}


async def _audience_counts(db: AsyncIOMotorDatabase, *, since: str | None, until: str | None) -> dict:
    """Calls per actor in the date range, for the filter's chips."""
    s, u = _day(since), _day(until, end=True)
    q = {"ts": {**({"$gte": s} if s else {}), **({"$lt": u} if u else {})}} if (s or u) else {}
    out = dict.fromkeys(ai_log.ACTORS, 0)
    rows = await db[ai_log.COLL].find(q, {"actor": 1}).to_list(length=ROW_CAP * 5)
    for r in rows:
        a = r.get("actor") or "user"
        out[a] = out.get(a, 0) + 1
    out["real"] = out["user"] + out["api"]
    out["all"] = len(rows)
    out["live"] = out["all"] - out["test"]
    return out


def _turn(r: dict) -> dict:
    tin, tout = _tokens(r)
    u = r.get("usage") or {}
    return {
        "request_id": r.get("request_id") or r.get("_id"), "ts": _iso(r.get("ts")), "feature": r.get("feature"),
        "feature_label": ai_usage.FEATURES.get(r.get("feature") or "", r.get("feature")), "kind": r.get("kind"),
        "label": r.get("label"), "who": _who(r), "via": r.get("via"), "site": r.get("site"),
        "workspace_id": r.get("workspace_id"), "workspace_name": r.get("workspace_name"),
        "scope_label": r.get("scope_label"), "slug": r.get("slug"), "page_title": r.get("page_title"),
        "model": r.get("model"), "calls": r.get("calls"),
        "tokens": {"input": int(u.get("input") or 0), "output": tout, "cache_read": int(u.get("cache_read") or 0),
                   "cache_write": int(u.get("cache_write_5m") or 0) + int(u.get("cache_write_1h") or 0),
                   "prompt": tin},
        "cost_usd": round(float(r.get("cost_usd") or 0), 6), "latency_ms": r.get("latency_ms"),
        "ttft_ms": r.get("ttft_ms"), "outcome": r.get("outcome"), "outcome_kind": _outcome_kind(r.get("outcome")),
        "stop_reason": r.get("stop_reason"), "error_code": r.get("error_code"), "limit_reason": r.get("limit_reason"),
        "content": bool(r.get("content")),
        "input": r.get("input"), "input_truncated": bool(r.get("input_truncated")), "selection": r.get("selection"),
        "output": r.get("output"), "output_truncated": bool(r.get("output_truncated")),
        "output_format": r.get("output_format") or "markdown", "citations": r.get("citations") or [],
        "context": r.get("context"), "description": r.get("description"), "results": r.get("results"),
        "actions": r.get("actions"),
    }


async def _conversation(db: AsyncIOMotorDatabase, cid: str) -> list[dict]:
    rows = await db[ai_log.COLL].find({"conversation_id": cid}).sort("ts", 1).to_list(length=500)
    if not rows:
        raise HTTPException(404, "Conversation not found")
    return rows


@router.get("/conversations/{conversation_id}")
async def conversation(conversation_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                       _: dict = Depends(require_admin)):
    rows = await _conversation(db, conversation_id)
    return {**_conv_card(conversation_id, rows), "turns_list": [_turn(r) for r in rows]}


def _md_quote(text: str) -> str:
    return "\n".join("> " + line if line.strip() else ">" for line in (text or "").splitlines())


def transcript_markdown(card: dict, turns: list[dict]) -> str:
    who = card["who"]
    head = [f"# {card['title']}", ""]
    bits = [f"**{who['name']}**" + (f" ({who['sub']})" if who.get("sub") else ""),
            card.get("label") or "", card.get("scope_label") or "",
            f"{card['turns']} turn{'s' if card['turns'] != 1 else ''}", f"${card['cost_usd']:.4f}"]
    head.append(" · ".join(b for b in bits if b))
    out = head + [""]
    for t in turns:
        ts = (t["ts"] or "")[:16].replace("T", " ")
        asker = t["who"]["name"]
        out.append(f"## {ts} UTC · {t['label'] or t['feature_label']}")
        out.append("")
        if t.get("description"):
            out.append(f"_{t['description']}_")
            out.append("")
        if t.get("selection"):
            out.append("Selected text:")
            out.append("")
            out.append(_md_quote(t["selection"]))
            out.append("")
        if t.get("input"):
            out.append(f"**{asker} asked:**")
            out.append("")
            out.append(_md_quote(t["input"]))
            out.append("")
        if t.get("output"):
            out.append("**Markdrop replied:**")
            out.append("")
            out.append(t["output"])
            out.append("")
        elif t["outcome_kind"] != "ok":
            out.append(f"_No answer: {t.get('limit_reason') or t.get('error_code') or t.get('outcome')}_")
            out.append("")
        if t.get("citations"):
            out.append("Sources:")
            for c in t["citations"]:
                title = c.get("title") or c.get("url") or "source"
                url = c.get("web_url") or c.get("url")
                out.append(f"- [{c.get('label') or c.get('n') or '•'}] " + (f"[{title}]({url})" if url else title))
            out.append("")
        if t.get("context") and t["context"].get("summary"):
            out.append(f"Context sent: {t['context']['summary']}")
            out.append("")
    return "\n".join(out).rstrip() + "\n"


@router.get("/conversations/{conversation_id}/markdown")
async def conversation_markdown(conversation_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                                _: dict = Depends(require_admin)):
    rows = await _conversation(db, conversation_id)
    card = _conv_card(conversation_id, rows)
    slug = re.sub(r"[^a-z0-9]+", "-", (card["title"] or "conversation").lower()).strip("-")[:50] or "conversation"
    return {"filename": f"ai-{slug}.md", "markdown": transcript_markdown(card, [_turn(r) for r in rows])}


@router.get("/summary")
async def summary(
    audience: str = Query("real"),
    feature: str | None = Query(None, max_length=40),
    workspace: str | None = Query(None, max_length=40),
    user: str | None = Query(None, max_length=200),
    outcome: str | None = Query(None, max_length=20),
    since: str | None = Query(None, max_length=40),
    until: str | None = Query(None, max_length=40),
    q: str | None = Query(None, max_length=200),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """Calls, tokens and cost by feature and by person (or job / visitor), for the filters."""
    query = _query(audience=audience, feature=feature, workspace=workspace, user=user, outcome=outcome,
                   since=since, until=until, q=q)
    rows = await db[ai_log.COLL].find(query, _LIST_FIELDS).to_list(length=ROW_CAP)

    def agg() -> dict:
        return {"calls": 0, "errors": 0, "cost_usd": 0.0, "tokens_in": 0, "tokens_out": 0, "conversations": set()}

    by_feature: dict[str, dict] = defaultdict(agg)
    by_who: dict[str, dict] = defaultdict(agg)
    who_of: dict[str, dict] = {}
    total = agg()
    for r in rows:
        w = _who(r)
        wkey = r.get("user_id") or (f"job:{w['name']}" if w["kind"] == "system" else "public")
        if w["kind"] == "public":
            w = {**w, "name": "Visitors", "sub": None}
        who_of.setdefault(wkey, w)
        for a in (total, by_feature[r.get("feature") or "?"], by_who[wkey]):
            a["calls"] += 1
            a["errors"] += _outcome_kind(r.get("outcome")) == "error"
            a["cost_usd"] += float(r.get("cost_usd") or 0)
            tin, tout = _tokens(r)
            a["tokens_in"] += tin
            a["tokens_out"] += tout
            a["conversations"].add(r.get("conversation_id"))

    def out(a: dict) -> dict:
        return {**{k: v for k, v in a.items() if k != "conversations"}, "cost_usd": round(a["cost_usd"], 6),
                "conversations": len(a["conversations"])}

    return {
        "audience": audience, "total": out(total), "truncated": len(rows) >= ROW_CAP,
        "by_feature": sorted(({"key": f, "label": ai_usage.FEATURES.get(f, f), **out(a)} for f, a in by_feature.items()),
                             key=lambda x: -x["cost_usd"]),
        "by_who": sorted(({"key": k, **who_of[k], **out(a)} for k, a in by_who.items()),
                         key=lambda x: (-x["cost_usd"], -x["calls"]))[:100],
    }


# ── Settings ──


class LogSettingsIn(BaseModel):
    content: bool | None = None
    internal_emails: list[str] | None = None     # null (or left out with reset): the admin emails
    internal_ips: list[str] | None = None
    reset_internal: bool = False


_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


async def _settings_view(db: AsyncIOMotorDatabase) -> dict:
    s = await ai_log.settings(db)
    return {"content": s["content"], "internal_emails": s["internal_emails"],
            "internal_emails_default": s["internal_emails_default"], "default_internal_emails": ai_log.default_internal(),
            "internal_ips": s["internal_ips"], "config_ips": ai_log.config_ips(),
            "retention_days": ai_log.RETENTION_DAYS, "test_domains": [*ai_log.TEST_DOMAINS, *("*" + t for t in ai_log.TEST_TLDS)],
            "updated_at": _iso(s.get("updated_at")), "updated_by": s.get("updated_by")}


@router.get("/settings")
async def get_settings_(db: AsyncIOMotorDatabase = Depends(get_db), _: dict = Depends(require_admin)):
    return await _settings_view(db)


@router.put("/settings")
async def put_settings(body: LogSettingsIn, db: AsyncIOMotorDatabase = Depends(get_db),
                       admin: dict = Depends(require_admin)):
    """Content capture on/off and the internal accounts and addresses. Fields left out are kept."""
    import ipaddress

    key = {"_id": ai_log.SETTINGS_ID}
    before = await db[ai_usage.SETTINGS].find_one(key) or {}
    doc = {k: v for k, v in before.items() if k in ("content", "internal_emails", "internal_ips")}
    sent = body.model_fields_set
    if "content" in sent and body.content is not None:
        doc["content"] = bool(body.content)
    if body.reset_internal:
        doc.pop("internal_emails", None)
    elif "internal_emails" in sent:
        if body.internal_emails is None:
            doc.pop("internal_emails", None)
        else:
            emails = []
            for e in body.internal_emails[:500]:
                e = (e or "").strip().lower()
                if not e:
                    continue
                if not _EMAIL.match(e) or len(e) > 200:
                    raise HTTPException(400, f"Not an email address: {e[:60]}")
                if e not in emails:
                    emails.append(e)
            doc["internal_emails"] = emails
    if "internal_ips" in sent:
        ips = []
        for ip in (body.internal_ips or [])[:100]:
            ip = (ip or "").strip()
            if not ip:
                continue
            try:
                ipaddress.ip_address(ip)
            except ValueError:
                raise HTTPException(400, f"Not an IP address: {ip[:60]}")
            if ip not in ips:
                ips.append(ip)
        doc["internal_ips"] = ips
    now = datetime.now(timezone.utc)
    await db[ai_usage.SETTINGS].replace_one(key, {**key, **doc, "updated_at": now,
                                                  "updated_by": admin.get("sub") or "admin"}, upsert=True)
    ai_log.invalidate()
    plain_before = {k: before.get(k) for k in ("content", "internal_emails", "internal_ips") if k in before}
    if plain_before != doc:
        await db[ai_usage.SETTINGS_AUDIT].insert_one({"ts": now, "admin": admin.get("sub") or "admin",
                                                      "kind": "log", "target": "log",
                                                      "before": plain_before or None, "after": doc})
    return await _settings_view(db)
