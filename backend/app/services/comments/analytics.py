"""Comment analytics (Track C): per item — open / resolved threads, time to first reply, time to resolve,
the most-discussed sections, a daily series, the most active people — and admin totals across Markdrop.

Read-only over ``comment_threads`` / ``comment_messages`` (indexed by ``(doc_id, status, created_at)`` and
``(doc_id, created_at)``); one item's numbers are two queries. Nothing here is written on events: the numbers
are cheap to recompute when someone opens the panel.

Definitions (also on the docs page):

* **Time to first reply** — from a thread's first message to the first message by someone else (not the
  thread's author, not an AI answer). Threads nobody answered yet count as *waiting for a reply* while open.
* **Time to resolve** — from a thread's start to its (last) resolve, resolved threads only.
* **Most-discussed sections** — each thread belongs to the heading its anchor sits under (the block's id, else
  the quoted text found on the page); a page-level thread is "Whole page", one whose text changed and can't be
  placed is "Text that changed". Ranked by threads, then messages.
"""

from __future__ import annotations

import re
import statistics
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

RANGES = {"7d": 7, "30d": 30, "90d": 90, "all": None}
MAX_THREADS = 2000
MAX_MESSAGES = 20000
TOP_SECTIONS = 8
TOP_PEOPLE = 5

_ATTRS = re.compile(r"\s*\{[^{}\n]*\}\s*$")
_LEAD = re.compile(r"^\s{0,3}(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|#{1,6}\s+|>\s?)+")
_DIRECTIVE = re.compile(r"^\s{0,3}:{2,}[A-Za-z][\w-]*(?:\[([^\]\n]*)\])?(?:\{[^}\n]*\})?\s*$")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(v: datetime | None) -> datetime | None:
    if v is None:
        return None
    return v if v.tzinfo else v.replace(tzinfo=timezone.utc)


def _norm(s: str | None) -> str:
    return " ".join((s or "").split()).casefold()


def _median(xs: list[float]) -> float | None:
    return round(statistics.median(xs), 1) if xs else None


def _mean(xs: list[float]) -> float | None:
    return round(sum(xs) / len(xs), 1) if xs else None


# ── Sections ──────────────────────────────────────────────────────────────────


def _plain_line(line: str) -> str:
    from app.services import md_outline

    d = _DIRECTIVE.match(line)
    if d:
        return d.group(1) or ""
    s = _ATTRS.sub("", line)
    s = _LEAD.sub("", s)
    s = re.sub(r":[a-z]+\[((?:\\.|[^\]\\\n])*)\]\{[^}\n]*\}", r"\1", s)
    return md_outline.inline_text(s)


class Sections:
    """Where each thread sits on the page: the heading above its anchor."""

    def __init__(self, markdown: str | None):
        from app.services import md_outline, page_props

        self.md = page_props.split(markdown or "")[1]   # front matter (a page's properties) isn't text
        self.lines = self.md.split("\n")
        self.headings = [h for h in md_outline.extract_headings(self.md, with_lines=True)]
        for h in self.headings:
            h["text"] = _ATTRS.sub("", h["text"]).strip() or h["text"]
        plain = [_norm(_plain_line(x)) for x in self.lines]
        self.offsets: list[int] = []
        pos = 0
        for p in plain:
            self.offsets.append(pos)
            pos += len(p) + 1
        self.plain = " ".join(plain)

    def _line_of_offset(self, off: int) -> int:
        lo, hi = 0, len(self.offsets) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if self.offsets[mid] <= off:
                lo = mid
            else:
                hi = mid - 1
        return lo

    def line_of(self, thread: dict) -> int | None:
        a = thread.get("anchor") or {}
        bid = a.get("block_id")
        if bid:
            pat = re.compile(r"\{[^{}\n]*#" + re.escape(bid) + r"(?:\s|\})")
            for i, line in enumerate(self.lines):
                if pat.search(line):
                    return i
        for text in ((a.get("quote") or {}).get("exact") if isinstance(a.get("quote"), dict) else None,
                     a.get("block_text"), (thread.get("original") or {}).get("exact")):
            needle = _norm(text)[:80]
            if len(needle) >= 2:
                k = self.plain.find(needle)
                if k >= 0:
                    return self._line_of_offset(k)
        return None

    def of(self, thread: dict) -> tuple[str | None, str]:
        """(heading id, title) of the section a thread is in."""
        if ((thread.get("anchor") or {}).get("type") or "page") == "page":
            return None, "Whole page"
        line = self.line_of(thread)
        if line is None:
            return "~changed", "Text that changed"
        above = [h for h in self.headings if h["line"] <= line]
        if not above:
            return "~top", "Top of the page"
        h = above[-1]
        return h["id"], h["text"]


# ── One item ──────────────────────────────────────────────────────────────────


async def _people(db, ids: list[str]) -> dict[str, dict]:
    oids = [ObjectId(i) for i in ids if i and ObjectId.is_valid(i)]
    if not oids:
        return {}
    out = {}
    async for u in db["users"].find({"_id": {"$in": oids}}, {"name": 1, "email": 1, "picture": 1}):
        name = u.get("name") or (u.get("email") or "").split("@")[0] or "Someone"
        out[str(u["_id"])] = {"id": str(u["_id"]), "name": name, "picture": u.get("picture")}
    return out


async def item_stats(db: AsyncIOMotorDatabase, raw: dict, *, range_: str = "30d", now: datetime | None = None) -> dict:
    """The numbers for one item (the caller already checked the reader may see its comments)."""
    now = now or _now()
    days = RANGES.get(range_, 30)
    doc_id = str(raw["_id"])
    threads = await db["comment_threads"].find({"doc_id": doc_id, "deleted_at": None}).sort(
        "created_at", 1).limit(MAX_THREADS).to_list(length=MAX_THREADS)
    tids = [t["_id"] for t in threads]
    msgs = await db["comment_messages"].find(
        {"doc_id": doc_id, "deleted_at": None}, {"thread_id": 1, "author_id": 1, "author_name": 1, "created_at": 1,
                                                  "ai": 1, "kind": 1}).sort("created_at", 1).limit(MAX_MESSAGES).to_list(
        length=MAX_MESSAGES) if tids else []
    live = {t["_id"] for t in threads}
    by_thread: dict[Any, list[dict]] = {}
    for m in msgs:
        if m["thread_id"] in live:
            by_thread.setdefault(m["thread_id"], []).append(m)

    first_reply: list[float] = []
    to_resolve: list[float] = []
    waiting = 0
    secs = Sections(raw.get("content"))
    per_section: dict[str | None, dict] = {}
    per_person: dict[str, int] = {}
    changed = 0
    for t in threads:
        ms = by_thread.get(t["_id"], [])
        start = _aware(t.get("created_at"))
        reply = next((m for m in ms if m.get("author_id") and m.get("author_id") != t.get("created_by")
                      and not m.get("ai") and (m.get("kind") or "comment") == "comment"), None)
        if reply is not None and start:
            first_reply.append(max(0.0, (_aware(reply["created_at"]) - start).total_seconds()))
        elif t.get("status") == "open":
            waiting += 1
        if t.get("status") == "resolved" and t.get("resolved_at") and start:
            to_resolve.append(max(0.0, (_aware(t["resolved_at"]) - start).total_seconds()))
        if t.get("anchor_status") == "changed":
            changed += 1
        sid, title = secs.of(t)
        s = per_section.setdefault(sid, {"id": sid if sid and not sid.startswith("~") else None, "title": title,
                                         "threads": 0, "open": 0, "messages": 0})
        s["threads"] += 1
        s["open"] += t.get("status") == "open"
        s["messages"] += len(ms) or int(t.get("message_count") or 0)
        for m in ms:
            if m.get("author_id") and not m.get("ai"):
                per_person[m["author_id"]] = per_person.get(m["author_id"], 0) + 1

    # The daily series over the range (threads started, messages written).
    span = days or max(1, min(365, ((now - (_aware(threads[0]["created_at"]) if threads else now)).days + 1)))
    first_day = (now - timedelta(days=span - 1)).date()
    series = {(first_day + timedelta(days=i)).isoformat(): {"threads": 0, "messages": 0} for i in range(span)}
    for t in threads:
        d = _aware(t["created_at"]).date().isoformat()
        if d in series:
            series[d]["threads"] += 1
    for m in msgs:
        d = _aware(m["created_at"]).date().isoformat()
        if d in series and m["thread_id"] in live:
            series[d]["messages"] += 1

    top = sorted(per_person.items(), key=lambda kv: -kv[1])[:TOP_PEOPLE]
    who = await _people(db, [k for k, _ in top])
    open_n = sum(1 for t in threads if t.get("status") == "open")
    sections = sorted(per_section.values(), key=lambda s: (-s["threads"], -s["messages"]))[:TOP_SECTIONS]
    return {
        "range": range_ if range_ in RANGES else "30d",
        "counts": {"total": len(threads), "open": open_n, "resolved": len(threads) - open_n,
                   "messages": sum(len(v) for v in by_thread.values()),
                   "participants": len(per_person), "changed": changed},
        "first_reply": {"median_s": _median(first_reply), "avg_s": _mean(first_reply), "replied": len(first_reply),
                        "waiting": waiting},
        "resolve": {"median_s": _median(to_resolve), "resolved": len(to_resolve)},
        "sections": sections,
        "series": [{"date": d, **v} for d, v in series.items()],
        "people": [{**who.get(k, {"id": k, "name": "Someone", "picture": None}), "messages": n} for k, n in top],
    }


def _dur(s: float | None) -> str:
    if s is None:
        return "—"
    if s < 90:
        return f"{int(s)} s"
    if s < 90 * 60:
        return f"{round(s / 60)} min"
    if s < 36 * 3600:
        return f"{round(s / 3600, 1):g} h"
    return f"{round(s / 86400, 1):g} days"


def summary_line(stats: dict, title: str | None = None) -> str:
    """One or two sentences an AI app can quote."""
    c = stats["counts"]
    if not c["total"]:
        return (f"“{title}” has no comments yet." if title else "No comments yet.")
    head = (f"“{title}” has " if title else "") + \
        f"{c['total']} comment thread{'s' if c['total'] != 1 else ''} ({c['open']} open, {c['resolved']} resolved, " \
        f"{c['messages']} message{'s' if c['messages'] != 1 else ''})."
    bits = [head[0].upper() + head[1:]]
    fr = stats["first_reply"]
    if fr["median_s"] is not None:
        bits.append(f"The median time to a first reply is {_dur(fr['median_s'])}.")
    if fr["waiting"]:
        bits.append(f"{fr['waiting']} open thread{'s' if fr['waiting'] != 1 else ''} still wait{'s' if fr['waiting'] == 1 else ''} for a reply.")
    if stats["sections"] and stats["sections"][0]["threads"] > 1:
        s = stats["sections"][0]
        bits.append(f"Most discussed: “{s['title']}” ({s['threads']} threads).")
    return " ".join(bits)


async def mcp_summary(db: AsyncIOMotorDatabase, raw: dict) -> dict | None:
    """The short ``comments`` block of get_document_analytics (None: the item can't have comments)."""
    from app.services.comments import perms

    if not perms.eligible(raw):
        return None
    s = await item_stats(db, raw, range_="all")
    return {"open": s["counts"]["open"], "resolved": s["counts"]["resolved"], "messages": s["counts"]["messages"],
            "median_first_reply_s": s["first_reply"]["median_s"], "waiting_for_reply": s["first_reply"]["waiting"],
            "top_sections": [{"title": x["title"], "threads": x["threads"]} for x in s["sections"][:3]]}


# ── Admin totals ──────────────────────────────────────────────────────────────


async def admin_totals(db: AsyncIOMotorDatabase, *, range_: str = "30d", now: datetime | None = None) -> dict:
    """Across Markdrop, for the admin Analytics tab: activity in the range plus what's open now."""
    now = now or _now()
    days = RANGES.get(range_, 30) or 3650
    since = now - timedelta(days=days)
    t = db["comment_threads"]
    m = db["comment_messages"]
    created = await t.count_documents({"created_at": {"$gte": since}, "deleted_at": None})
    resolved = await t.count_documents({"resolved_at": {"$gte": since}, "status": "resolved", "deleted_at": None})
    open_now = await t.count_documents({"status": "open", "deleted_at": None})
    messages = await m.count_documents({"created_at": {"$gte": since}, "deleted_at": None})
    ai_answers = await m.count_documents({"created_at": {"$gte": since}, "deleted_at": None, "ai": True})
    items = len(await t.distinct("doc_id", {"created_at": {"$gte": since}, "deleted_at": None}))
    people = len([x for x in await m.distinct("author_id", {"created_at": {"$gte": since}, "deleted_at": None}) if x])
    # Time to first reply over the threads started in the range (a sample of the newest 2000).
    sample = await t.find({"created_at": {"$gte": since}, "deleted_at": None},
                          {"created_by": 1, "created_at": 1}).sort("created_at", -1).limit(2000).to_list(length=2000)
    firsts: list[float] = []
    if sample:
        starts = {x["_id"]: x for x in sample}
        async for r in m.aggregate([
            {"$match": {"thread_id": {"$in": list(starts)}, "deleted_at": None, "ai": {"$ne": True}}},
            {"$sort": {"created_at": 1}},
            {"$group": {"_id": "$thread_id", "msgs": {"$push": {"a": "$author_id", "at": "$created_at"}}}},
        ]):
            th = starts.get(r["_id"])
            rep = next((x for x in r["msgs"] if x.get("a") and x["a"] != th.get("created_by")), None)
            if rep and th.get("created_at"):
                firsts.append(max(0.0, (_aware(rep["at"]) - _aware(th["created_at"])).total_seconds()))
    span = min(days, 90)
    first_day = (now - timedelta(days=span - 1)).date()
    series = {(first_day + timedelta(days=i)).isoformat(): {"threads": 0, "messages": 0} for i in range(span)}
    lo = datetime.combine(first_day, datetime.min.time(), tzinfo=timezone.utc)
    for coll, key in ((t, "threads"), (m, "messages")):
        async for r in coll.aggregate([
            {"$match": {"created_at": {"$gte": lo}, "deleted_at": None}},
            {"$group": {"_id": {"$dateToString": {"format": "%Y-%m-%d", "date": "$created_at"}}, "n": {"$sum": 1}}},
        ]):
            if r["_id"] in series:
                series[r["_id"]][key] = r["n"]
    top = await t.aggregate([
        {"$match": {"created_at": {"$gte": since}, "deleted_at": None}},
        {"$group": {"_id": "$doc_id", "threads": {"$sum": 1}, "messages": {"$sum": "$message_count"},
                    "open": {"$sum": {"$cond": [{"$eq": ["$status", "open"]}, 1, 0]}}}},
        {"$sort": {"threads": -1}}, {"$limit": 10},
    ]).to_list(length=10)
    docs = {str(d["_id"]): d async for d in db["documents"].find(
        {"_id": {"$in": [ObjectId(x["_id"]) for x in top if ObjectId.is_valid(x["_id"])]}}, {"slug": 1, "title": 1})}
    return {
        "range": range_ if range_ in RANGES else "30d",
        "kpis": {"threads": created, "messages": messages, "resolved": resolved, "open_now": open_now,
                 "items": items, "people": people, "ai_answers": ai_answers,
                 "median_first_reply_s": _median(firsts)},
        "series": [{"date": d, **v} for d, v in series.items()],
        "top_items": [{"slug": docs.get(x["_id"], {}).get("slug"), "title": docs.get(x["_id"], {}).get("title"),
                       "threads": x["threads"], "messages": x["messages"], "open": x["open"]}
                      for x in top if x["_id"] in docs],
    }
