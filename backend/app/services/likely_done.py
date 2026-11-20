"""Action items that look done but aren't ticked — "likely done" (AI quality stage 3, R7; owner decision 2026-11-20,
.work/briefs/ai-quality-phase2.md).

**Where the candidates come from.** Team memory's extraction (services/workspace_memory.py) reads every meeting and
page once. When it reads a source, it is also given the open (unticked) action items of the people in it — their
items from earlier meetings and pages, from Ask's index (services/ai_index.py, ``t: "action"`` rows) — and says which
of them this source shows as already done ("the SSO PRD draft is up", "v4.2 shipped this morning", the postmortem
page itself). Each such item becomes a candidate here, with its evidence: the source, its date and one sentence.
No extra model call: the same extraction call answers it.

**Never ticked automatically.** A candidate only adds a note:

* in Ask's answers — an open action item in the index block reads "open — likely done: <evidence> (<source>, <date>)"
  (services/ask_route.py), and the answer says "likely done", never "done";
* on to-do pages and the team's backlog page — the item's line gets " · likely done: <evidence> (<date>)"; its
  checkbox is the one-click Tick (two-way ticking as always, services/todo_pages.py / team_backlog.py);
* in the MCP tools ``list_items`` (action items), ``my_todos`` / ``team_backlog`` and ``likely_done``.

Ticking the item ends it (a done item never shows the note). ``dismiss`` hides a wrong one for everyone.

**Access.** A candidate is only shown with evidence the reader may open: in Ask and MCP, the evidence document is
decided for the asker (``ai_index.readable_docs``: access.discoverable, the request's team space); on a to-do or
backlog page — shared content — for every person who reads that page (the page's owner and the team's leads; the
whole team for the backlog), else the page shows no note.

Collection ``likely_done``: _id "<doc id>:<block>" (or "<doc id>:t<hash of the text>" for a line without a block id):
workspace_id, doc (the page holding the task), block, text, owner, evidence {doc, title, date, text}, source_key
(the memory source that said so), at, dismissed_at, dismissed_by.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import access

log = logging.getLogger("markdrop.likely_done")

COLL = "likely_done"
MAX_OPEN = 25                    # open items shown to one extraction
LOOKBACK_DAYS = 60               # items older than this aren't offered
EVIDENCE_CHARS = 160
ITEM_CHARS = 160


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _oid(v: Any) -> ObjectId | None:
    if isinstance(v, ObjectId):
        return v
    try:
        return ObjectId(str(v))
    except Exception:
        return None


def _norm(text: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (text or "").casefold()).strip()


def key_of(doc: Any, block: str | None, text: str | None) -> str:
    """An action item's identity: its page and block id (the same id on to-do and backlog pages), else its text."""
    if block:
        return f"{doc}:{block}"
    return f"{doc}:t" + hashlib.sha1(_norm(text).encode()).hexdigest()[:12]


def _clean(text: Any, n: int) -> str:
    t = re.sub(r"\s+", " ", str(text or "")).strip()
    # Never something a backlog line would read as a status or an owner (team_backlog.parse_line).
    t = t.replace("·", "-").replace(":person[", "").replace("{#", "(").replace("[", "(").replace("]", ")")
    return t[:n].rstrip()


def _day(v: Any) -> date | None:
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except (TypeError, ValueError):
        return None


def fmt_day(v: Any) -> str:
    d = _day(v)
    return f"{d.strftime('%b')} {d.day}" + ("" if d.year == now_utc().year else f", {d.year}") if d else ""


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index([("workspace_id", 1), ("owner", 1)])
    await db[COLL].create_index("source_key")
    await db[COLL].create_index("doc")


# ── For one extraction: the open items it may close ───────────────────────────


async def open_items(db: AsyncIOMotorDatabase, workspace_id: str, owners: list[str], *, before: Any,
                     exclude_doc: Any = None) -> list[dict]:
    """The open action items (Ask's index rows) of these people from sources dated on or before ``before`` (a day),
    newest first, never from ``exclude_doc`` itself. Rows of a locked or system page never exist (ai_index)."""
    from app.services import ai_index

    owners = [o for o in dict.fromkeys(owners) if o]
    day = _day(before) or now_utc().date()
    if not owners or not workspace_id:
        return []
    q: dict = {"t": "action", "ws": workspace_id, "done": False, "owner": {"$in": owners},
               "date": {"$lte": day.isoformat(), "$gte": (day - timedelta(days=LOOKBACK_DAYS)).isoformat()}}
    ex = _oid(exclude_doc)
    if ex is not None:
        q["doc"] = {"$ne": ex}
    return await db[ai_index.COLL].find(q, {"doc": 1, "block": 1, "text": 1, "owner": 1, "owner_name": 1, "title": 1,
                                            "date": 1, "due": 1}).sort([("date", -1), ("_id", 1)]).limit(
        MAX_OPEN).to_list(length=MAX_OPEN)


def items_block(items: list[dict], names: dict[str, str]) -> str:
    """The open items for the extraction prompt, labelled a1…aN (the caller wraps it as untrusted data)."""
    lines = []
    for n, it in enumerate(items, 1):
        who = names.get(it.get("owner") or "") or it.get("owner_name") or "someone"
        lines.append(f"a{n}: {_clean(it.get('text'), ITEM_CHARS)} — owner {who}, from “{_clean(it.get('title'), 100)}”"
                     + (f" ({it['date']})" if it.get("date") else ""))
    return "\n".join(lines)


def parse_done(raw: str | None, n_items: int) -> list[dict]:
    """[{i, evidence, seg}] from the extraction's JSON ``done`` list (bounded, checked)."""
    m = re.search(r"\{.*\}", raw or "", re.S)
    if not m or n_items <= 0:
        return []
    try:
        data = json.loads(m.group(0))
    except Exception:
        return []
    got = data.get("done") if isinstance(data, dict) else None
    out, seen = [], set()
    for d in (got if isinstance(got, list) else [])[:n_items]:
        if not isinstance(d, dict):
            continue
        mm = re.match(r"^\s*a?(\d{1,3})\s*$", str(d.get("item") or ""))
        ev = _clean(d.get("evidence"), EVIDENCE_CHARS)
        if not mm or not ev:
            continue
        i = int(mm.group(1))
        if not 1 <= i <= n_items or i in seen:
            continue
        seen.add(i)
        cm = re.match(r"^\s*\[?s?(\d{1,5})\]?\s*$", str(d.get("cite") or ""))
        out.append({"i": i, "evidence": ev, "seg": int(cm.group(1)) if cm else None})
    return out


async def record(db: AsyncIOMotorDatabase, workspace_id: str, src_key: str, source: dict, items: list[dict],
                 done: list[dict]) -> int:
    """This source's say on the items it was shown: candidates it names (re)written, the ones it named before and no
    longer does removed. ``source``: {doc, title, date}. Returns the candidates written. Rebuilds the to-do and backlog
    pages the change touches (in the background)."""
    now = now_utc()
    before = {r["_id"]: r async for r in db[COLL].find({"source_key": src_key}, {"doc": 1, "owner": 1})}
    keep: set[str] = set()
    touched: list[dict] = []
    for d in done:
        it = items[d["i"] - 1]
        k = key_of(it["doc"], it.get("block"), it.get("text"))
        prev = await db[COLL].find_one({"_id": k}, {"dismissed_at": 1})
        if prev is not None and prev.get("dismissed_at"):
            continue                 # someone said it isn't done: never offered again
        keep.add(k)
        await db[COLL].update_one({"_id": k}, {"$set": {
            "workspace_id": workspace_id, "doc": it["doc"], "block": it.get("block"), "text": it.get("text"),
            "owner": it.get("owner"), "item_date": it.get("date"), "source_key": src_key,
            "evidence": {"doc": _oid(source.get("doc")), "title": _clean(source.get("title"), 120) or "Untitled",
                         "date": str(source.get("date") or "")[:10] or None, "text": d["evidence"], "seg": d.get("seg")},
            "at": now}}, upsert=True)
        if k not in before:
            touched.append({"doc": it["doc"], "owner": it.get("owner")})
    gone = [k for k in before if k not in keep]
    if gone:
        await db[COLL].delete_many({"_id": {"$in": gone}, "source_key": src_key})
        touched += [{"doc": before[k].get("doc"), "owner": before[k].get("owner")} for k in gone]
    if touched:
        await _refresh_pages(db, touched)
    return len(keep)


async def _refresh_pages(db: AsyncIOMotorDatabase, touched: list[dict]) -> None:
    """The to-do pages (of the items' owners) and backlog pages of the teams of the pages holding the items."""
    try:
        from app.services import team_backlog, todo_pages

        docs = {d["_id"]: d for d in await db["documents"].find(
            {"_id": {"$in": list({t["doc"] for t in touched if t.get("doc") is not None})}}, {"team_ids": 1}).to_list(length=500)}
        teams: set[str] = set()
        for t in touched:
            for tid in [str(x) for x in (docs.get(t.get("doc")) or {}).get("team_ids") or []]:
                teams.add(tid)
                if t.get("owner") and await db["todo_pages"].find_one({"_id": todo_pages.page_key(tid, t["owner"])}, {"_id": 1}):
                    todo_pages.schedule(db, tid, t["owner"])
        for tid in teams:
            team_backlog.schedule_build(db, tid)
    except Exception:
        log.warning("likely done: page refresh failed", exc_info=True)


# ── Reading them ─────────────────────────────────────────────────────────────


def note(ev: dict, *, with_source: bool = True) -> str:
    """"likely done: <evidence> (<source>, <date>)"."""
    when = fmt_day(ev.get("date"))
    where = ", ".join(x for x in ((ev.get("title") if with_source else None), when) if x)
    return f"likely done: {ev.get('text')}" + (f" ({where})" if where else "")


async def for_rows(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, rows: list[dict]) -> dict[str, dict]:
    """{action row _id: evidence} for open action rows (already decided readable, ai_index.query) whose candidate's
    evidence the asker may open."""
    want = {key_of(r.get("doc"), r.get("block"), r.get("text")): r["_id"] for r in rows
            if r.get("t", "action") == "action" and not r.get("done") and r.get("doc") is not None}
    return await for_keys(db, actor, ctx, want)


async def for_keys(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, want: dict[str, Any]) -> dict[Any, dict]:
    """{want[key]: evidence} for the candidates among ``want`` (item key → the caller's id) whose evidence the asker
    may open. The items themselves are the caller's to have decided readable."""
    from app.services import ai_index

    if not want or not actor.user_id:
        return {}
    cands = await db[COLL].find({"_id": {"$in": list(want)}, "dismissed_at": None}).to_list(length=len(want))
    if not cands:
        return {}
    ok = await ai_index.readable_docs(db, actor, ctx, [c["evidence"].get("doc") for c in cands if c.get("evidence")])
    return {want[c["_id"]]: c["evidence"] for c in cands
            if c.get("evidence") and _oid(c["evidence"].get("doc")) in ok}


async def page_notes(db: AsyncIOMotorDatabase, items: list[tuple[Any, str | None, str | None]],
                     readers: list[str]) -> dict[str, str]:
    """{block: " · likely done: …"} for items on a to-do or backlog page ((doc, block, text) each), only with
    evidence EVERY reader of that page may open (it is shared content)."""
    from app.services.user import get_user_by_id

    keys = {key_of(d, b, t): b for d, b, t in items if b}
    if not keys or not readers:
        return {}
    cands = await db[COLL].find({"_id": {"$in": list(keys)}, "dismissed_at": None}).to_list(length=len(keys))
    if not cands:
        return {}
    ev_ids = list({c["evidence"].get("doc") for c in cands if (c.get("evidence") or {}).get("doc") is not None})
    docs = {d["_id"]: d for d in await db["documents"].find({"_id": {"$in": ev_ids}, "deleted_at": None}).to_list(length=len(ev_ids))}
    users = [await get_user_by_id(db, r) for r in dict.fromkeys(readers)]
    if not users or any(u is None for u in users):
        return {}                    # a reader we can't decide for: fail closed
    # One actor and one Ctx per reader, kept for the whole loop: access.Ctx caches facts by id(actor), and a
    # throwaway actor's id can be reused by the next one (another person's cached answer).
    deciders = [(access.Actor.of(u), access.Ctx(db)) for u in users]
    ok: dict[Any, bool] = {}
    for i, d in docs.items():
        good = not d.get("encrypted") and not d.get("template")
        for actor, ctx in deciders:
            if not good:
                break
            good = (await access.can(actor, d, "read", ctx)).allowed
        ok[i] = good
    out = {}
    for c in cands:
        ev = c.get("evidence") or {}
        if ok.get(ev.get("doc")):
            out[keys[c["_id"]]] = " · " + note(ev, with_source=False)
    return out


async def dismiss(db: AsyncIOMotorDatabase, key: str, user_id: str) -> bool:
    r = await db[COLL].update_one({"_id": key, "dismissed_at": None},
                                  {"$set": {"dismissed_at": now_utc(), "dismissed_by": user_id}})
    if r.modified_count:
        c = await db[COLL].find_one({"_id": key}, {"doc": 1, "owner": 1})
        if c is not None:
            await _refresh_pages(db, [{"doc": c.get("doc"), "owner": c.get("owner")}])
    return bool(r.modified_count)


async def drop_doc(db: AsyncIOMotorDatabase, doc_id: Any) -> None:
    """A page deleted: its items' candidates go (its evidence stays: unreadable evidence is never shown)."""
    oid = _oid(doc_id)
    if oid is not None:
        await db[COLL].delete_many({"doc": oid})
