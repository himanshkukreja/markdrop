"""Ask's index, Layer 1: Markdrop's facts as compact rows (AI quality stage 2, .work/briefs/ai-quality-phase2.md).

No AI. One collection, ``ai_facts``, with a row per

* **doc** (``d:<doc id>``) — a page, document, file, meeting page or transcript: title, kind, who created it, who
  edited it (and who last), its teams, folder, created / updated, status, comment counts; a meeting page also its
  meeting id, day, series and attendees (user ids and names). ``system`` marks the pages Markdrop keeps itself
  (a team's backlog, to-do lists) and transcripts: they never count as "created by" a person.
* **action** (``a:<doc id>:<n>``) — a task line: a meeting page's action items (owner or not) and, on other
  pages, the unticked or ticked tasks that @mention someone: text, owner (user id + name), done, due, the
  meeting's day.
* **comment** (``c:<thread id>``) — a comment thread: its item, status, who started it, who took part, when,
  the first message's words.
* **backlog** (``b:<item id>``) — a team backlog item: team, text, category, status, owner, the calls it came from.

So "how many documents has Arun created", "meetings Neha attended in the last two weeks", "open items assigned to
Rahul Das", "what changed in the last 2 days" are exact queries (:func:`query`), not guesses from 30 search hits.

**Incremental.** :func:`index_doc` runs from the search index's save hook (services/search_index.py: every save,
import, move, delete reaches it); comment threads through ``comments.service.recount``; a team's backlog items when
its page is rebuilt (services/team_backlog.py). :func:`reconcile` (the ``ai_index`` background loop) re-indexes
what changed through a path without a hook, and once a day sweeps every row against its source in batches
(never a full rebuild). :func:`backfill_tick` fills a database that had no index (scripts/ai_index_backfill.py).

**Access at read time.** A row is only Markdrop's record of an item; :func:`query` decides every row again for the
asker — the item's document with ``access.discoverable`` (and the request's team space), a comment also with the
comment permissions, a backlog item with the team being readable and one of its calls readable (as the backlog page
shows it). Encrypted documents never get a row's title or text; password-protected ones keep their title only.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import DeleteMany, ReplaceOne, UpdateOne

from app.services import access

log = logging.getLogger("markdrop.ai_index")

COLL = "ai_facts"
META = "ai_index_meta"
VERSION = 3                     # bump to re-index every row (a changed row shape; 2: action rows carry their block id; 3: action text without its owner's name)
MAX_EDITORS = 20
MAX_ATTENDEES = 60
MAX_ACTIONS_PER_DOC = 80
TEXT_CHARS = 240
TITLE_CHARS = 200
RECONCILE_LIMIT = 500
SWEEP_BATCH = 300
SWEEP_EVERY = timedelta(hours=24)
QUERY_MAX = 2000                # rows read per query before access is decided
DEBOUNCE_S = 0.25

_PERSON = re.compile(r':person\[([^\]]*)\]\{[^}]*?id="([^"]+)"[^}]*\}')
_PERSON_ANY = re.compile(r':person\[([^\]]*)\]\{[^}]*\}')
_DATE_CHIP = re.compile(r":date\[([^\]]*)\]")
_ISO = re.compile(r"\b(\d{4}-\d{2}-\d{2})\b")
_DUE = re.compile(r"(?:·\s*)?\bdue\s+(?::date\[)?([^\]·{}\[]{3,30}?)\]?(?=\s*(?:\[#|\{#|·|$))", re.I)
_TASK = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s+(.+?)\s*$")
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+(.*?)\s*$")
_BLOCK = re.compile(r"\{#(b-[A-Za-z0-9_-]{2,40})[^}]*\}\s*$")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: Any) -> datetime | None:
    if isinstance(dt, datetime):
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return None


def _day(v: Any) -> str | None:
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, date):
        return v.isoformat()
    s = str(v or "")[:10]
    return s if _ISO.fullmatch(s) else None


def _oid(v: Any) -> ObjectId | None:
    if isinstance(v, ObjectId):
        return v
    try:
        return ObjectId(str(v))
    except Exception:
        return None


def content_hash(text: str | None) -> str:
    return hashlib.sha1((text or "").encode("utf-8", "ignore")).hexdigest()[:16]


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    c = db[COLL]
    await c.create_index([("ws", 1), ("t", 1), ("creator", 1)])
    await c.create_index([("ws", 1), ("t", 1), ("updated", -1)])
    await c.create_index([("ws", 1), ("t", 1), ("created", -1)])
    await c.create_index([("ws", 1), ("t", 1), ("date", -1)])
    await c.create_index([("ws", 1), ("t", 1), ("attendees", 1)])
    await c.create_index([("ws", 1), ("t", 1), ("owner", 1)])
    await c.create_index([("ws", 1), ("t", 1), ("teams", 1)])
    await c.create_index([("ws", 1), ("t", 1), ("editors", 1)])
    await c.create_index([("doc", 1), ("t", 1)])
    await c.create_index([("t", 1), ("team", 1)])
    await c.create_index([("sx", 1), ("updated", -1)], partialFilterExpression={"sx": True})
    await c.create_index([("vx", 1), ("updated", -1)], partialFilterExpression={"vx": True})


# ── Rows ──────────────────────────────────────────────────────────────────────


def plain(text: str | None) -> str:
    """A Markdown line as words (mentions as names, chips as their text, no links / block ids)."""
    from app.services import ask_context

    return ask_context.plain(text or "")


def _short(text: str, n: int) -> str:
    t = re.sub(r"\s+", " ", text or "").strip()
    return t if len(t) <= n else t[:n].rsplit(" ", 1)[0].rstrip(",;:") + "…"


def system_kind(raw: dict) -> str | None:
    """Pages Markdrop keeps itself (never "created by" the person who owns them)."""
    if raw.get("backlog_team_id"):
        return "backlog"
    if raw.get("todo_team_id") or raw.get("todo_user_id"):
        return "todo"
    if raw.get("meeting_role") == "transcript":
        return "transcript"
    return None


def doc_kind(raw: dict) -> str:
    if raw.get("meeting_id"):
        return "transcript" if raw.get("meeting_role") == "transcript" else "meeting"
    if raw.get("kind") == "artifact":
        return "file"
    return "page" if raw.get("editor") == "blocks" else "doc"


def due_of(text: str, base: date | None = None) -> str | None:
    """An action line's due date as YYYY-MM-DD when it says one ("· due 2026-11-22", ":date[2026-11-22]")."""
    m = _DATE_CHIP.search(text or "")
    cands = [m.group(1)] if m else []
    d = _DUE.search(text or "")
    if d:
        cands.append(d.group(1))
    for c in cands:
        iso = _ISO.search(c or "")
        if iso:
            return iso.group(1)
    return None


def task_rows(content: str | None, *, meeting: bool) -> list[dict]:
    """The page's task lines worth a row: a meeting page's whole "Action items" section; on other pages, the
    tasks that @mention someone. [{done, text, owner, owner_name, due, block}] (``block``: the line's block id, the task's
    identity on to-do and backlog pages and for "likely done", services/likely_done.py)"""
    out: list[dict] = []
    inside = False
    fence = False
    for line in (content or "").split("\n"):
        if line.lstrip().startswith(("```", "~~~")):
            fence = not fence
            continue
        if fence:
            continue
        h = _HEADING.match(line)
        if h:
            inside = bool(re.search(r"\b(action items?|next steps?)\b", h.group(1), re.I))
            continue
        m = _TASK.match(line)
        if not m:
            continue
        body = m.group(2)
        people = _PERSON.findall(body)
        if meeting and not inside:
            continue
        if not meeting and not people:
            continue
        text = plain(body)
        if not text:
            continue
        name, uid = (people[0] if people else (None, None))
        # "@Alex Chen Update the forecast sheet": the owner is its own field, so the text is just the task.
        lead = (name or "").strip()
        if lead and text.startswith(lead) and len(text) > len(lead):
            text = text[len(lead):].lstrip(" :,—–-") or text
        blk = _BLOCK.search(body)
        out.append({"done": m.group(1) != " ", "text": _short(text, TEXT_CHARS), "owner": uid or None,
                    "owner_name": (name or "").strip() or None, "due": due_of(body), "block": blk.group(1) if blk else None})
        if len(out) >= MAX_ACTIONS_PER_DOC:
            break
    return out


async def _editors(db: AsyncIOMotorDatabase, doc_id: ObjectId) -> tuple[list[str], dict | None]:
    """(people who saved a version, newest first; the newest such version {author_id, ts})."""
    ids: list[str] = []
    last = None
    try:
        async for r in db["document_versions"].find({"doc_id": str(doc_id), "author_kind": "user"},
                                                    {"author_id": 1, "ts": 1}).sort("ts", -1).limit(400):
            a = r.get("author_id")
            if not a:
                continue
            if last is None:
                last = {"author_id": a, "ts": r.get("ts")}
            if a not in ids:
                ids.append(a)
            if len(ids) >= MAX_EDITORS:
                break
    except Exception:
        log.warning("ai index: editors of %s failed", doc_id, exc_info=True)
    return ids, last


def doc_row(raw: dict, *, editors: list[str], last_edit: dict | None, mrow: dict | None) -> dict:
    """The ``doc`` row of a documents row (and its meeting row, for a meeting page / transcript)."""
    from app.services import ask_context

    enc = bool(raw.get("encrypted"))
    kind = doc_kind(raw)
    title = None if enc else (raw.get("title") or (raw.get("original_filename") if raw.get("kind") == "artifact" else None))
    counts = raw.get("comment_counts") or {}
    row: dict[str, Any] = {
        "_id": f"d:{raw['_id']}", "t": "doc", "v": VERSION, "doc": raw["_id"], "ws": raw.get("workspace_id"),
        "kind": kind, "title": _short(title or "", TITLE_CHARS) or None, "slug": raw.get("slug"),
        "creator": raw.get("owner_id"), "system": system_kind(raw),
        "editors": editors, "last_editor": (last_edit or {}).get("author_id"),
        "last_edit": _aware((last_edit or {}).get("ts")),
        "teams": [str(t) for t in raw.get("team_ids") or []], "projects": [str(p) for p in raw.get("project_ids") or []],
        "folder": raw.get("folder_id"), "parent": raw.get("parent_id"),
        "created": _aware(raw.get("created_at")), "updated": _aware(raw.get("updated_at")),
        "status": None if (enc or raw.get("read_password_hash") or kind in ("meeting", "transcript"))
        else ask_context.status_of(raw.get("content")),
        "c_open": int(counts.get("open") or 0), "c_resolved": int(counts.get("resolved") or 0),
        "locked": enc or bool(raw.get("read_password_hash")), "deleted": raw.get("deleted_at") is not None,
        "h": None if enc else content_hash(raw.get("content")), "at": now_utc(),
    }
    if mrow is not None:
        att = [a for a in mrow.get("attendees") or [] if isinstance(a, dict)]
        row.update(meeting=str(mrow["_id"]), date=mrow.get("date") or _day(raw.get("created_at")),
                   series=mrow.get("series"), mtitle=mrow.get("title"),
                   attendees=list(dict.fromkeys(a["user_id"] for a in att if a.get("user_id")))[:MAX_ATTENDEES],
                   attendee_names=list(dict.fromkeys(a["name"] for a in att if a.get("name")))[:MAX_ATTENDEES],
                   organizer=(mrow.get("organizer") or {}).get("user_id"))
    return row


async def index_doc(db: AsyncIOMotorDatabase, doc_id: Any) -> bool:
    """(Re)build one document's rows (its ``doc`` row, its task lines). A missing, deleted or template row drops
    them. Never raises (a hook)."""
    try:
        return await _index_doc(db, doc_id)
    except Exception:
        log.warning("ai index: %s failed", doc_id, exc_info=True)
        return False


async def _index_doc(db: AsyncIOMotorDatabase, doc_id: Any) -> bool:
    oid = _oid(doc_id)
    if oid is None:
        return False
    raw = await db["documents"].find_one({"_id": oid})
    if raw is None or raw.get("template") or raw.get("deleted_at") is not None:
        await drop(db, oid)
        return False
    editors, last = await _editors(db, oid)
    mrow = None
    if raw.get("meeting_id"):
        from app.services import meetings

        mid = meetings.oid(raw["meeting_id"])
        if mid is not None:
            mrow = await db[meetings.COLL].find_one({"_id": mid}, {"segments": 0, "generated": 0, "notes": 0})
    row = doc_row(raw, editors=editors, last_edit=last, mrow=mrow)
    old = await db[COLL].find_one({"_id": row["_id"]}, {"h": 1})
    if old is None or old.get("h") != row["h"]:
        # Its text changed: its summary and its vectors are due (services/ai_summaries.py, ai_vectors.py).
        row["sx"] = row["vx"] = True
    # $set, not a replace: the row keeps ``sh`` / ``vh`` (the content hash its summary and its vectors were
    # made from, services/ai_summaries.py / ai_vectors.py), so a changed ``h`` is what marks them stale.
    ops: list = [UpdateOne({"_id": row["_id"]}, {"$set": row}, upsert=True), DeleteMany({"doc": oid, "t": "action"})]
    if not row["locked"] and row["kind"] != "transcript" and row["system"] is None:
        for n, a in enumerate(task_rows(raw.get("content"), meeting=row["kind"] == "meeting")):
            ops.append(ReplaceOne({"_id": f"a:{oid}:{n}"}, {
                "_id": f"a:{oid}:{n}", "t": "action", "v": VERSION, "doc": oid, "ws": row["ws"], **a,
                "date": row.get("date") or _day(raw.get("updated_at")), "meeting": row.get("meeting"),
                "title": row["title"], "teams": row["teams"], "updated": row["updated"], "at": row["at"]}, upsert=True))
    await db[COLL].bulk_write(ops, ordered=True)
    if row["locked"]:
        # Encrypted / password-protected now: no summary, no chunks of its text.
        from app.services import ai_summaries, ai_vectors

        await db[ai_summaries.COLL].delete_one({"_id": oid})
        await ai_vectors.drop_doc(db, oid)
    return True


async def drop(db: AsyncIOMotorDatabase, doc_id: Any) -> None:
    oid = _oid(doc_id)
    if oid is None:
        return
    try:
        await db[COLL].delete_many({"doc": oid, "t": {"$in": ["doc", "action", "comment"]}})
        from app.services import ai_summaries, ai_vectors

        await db[ai_summaries.COLL].delete_one({"_id": oid})
        await ai_vectors.drop_doc(db, oid)
    except Exception:
        log.warning("ai index: drop %s failed", oid, exc_info=True)


async def index_comments(db: AsyncIOMotorDatabase, doc_id: Any) -> int:
    """A document's comment threads as rows (replacing its old ones). Never raises."""
    from app.services.comments import model as cm

    oid = _oid(doc_id)
    if oid is None:
        return 0
    try:
        raw = await db["documents"].find_one({"_id": oid}, {"workspace_id": 1, "deleted_at": 1, "encrypted": 1})
        threads = [] if raw is None or raw.get("deleted_at") is not None else await db[cm.THREADS].find(
            {"doc_id": str(oid), "deleted_at": None}).to_list(length=cm.MAX_THREADS_PER_ITEM)
        firsts: dict[Any, dict] = {}
        if threads:
            async for m in db[cm.MESSAGES].find({"thread_id": {"$in": [t["_id"] for t in threads]}, "deleted_at": None},
                                                {"thread_id": 1, "body": 1, "author_id": 1, "created_at": 1}).sort(
                    [("created_at", 1), ("_id", 1)]):
                firsts.setdefault(m["thread_id"], m)
        ops: list = [DeleteMany({"doc": oid, "t": "comment"})]
        for t in threads:
            m = firsts.get(t["_id"]) or {}
            ops.append(ReplaceOne({"_id": f"c:{t['_id']}"}, {
                "_id": f"c:{t['_id']}", "t": "comment", "v": VERSION, "doc": oid, "ws": raw.get("workspace_id"),
                "thread": t["_id"], "status": t.get("status") or "open", "author": t.get("created_by") or m.get("author_id"),
                "participants": [p for p in t.get("participants") or [] if p][:30],
                "created": _aware(t.get("created_at")), "updated": _aware(t.get("updated_at")),
                "text": None if raw.get("encrypted") else _short(plain(m.get("body") or ""), TEXT_CHARS),
                "at": now_utc()}, upsert=True))
        await db[COLL].bulk_write(ops, ordered=True)
        return len(threads)
    except Exception:
        log.warning("ai index: comments of %s failed", oid, exc_info=True)
        return 0


async def index_backlog(db: AsyncIOMotorDatabase, team_id: str) -> int:
    """A team's backlog items as rows (replacing its old ones). Never raises."""
    from app.services import team_backlog

    try:
        items = await db[team_backlog.ITEMS].find({"team_id": team_id, "orphan": {"$ne": True}}).to_list(length=5000)
        team = await db["teams"].find_one({"_id": _oid(team_id)}, {"workspace_id": 1})
        ops: list = [DeleteMany({"t": "backlog", "team": team_id})]
        for it in items:
            ops.append(ReplaceOne({"_id": f"b:{it['_id']}"}, {
                "_id": f"b:{it['_id']}", "t": "backlog", "v": VERSION, "ws": (team or {}).get("workspace_id"),
                "team": team_id, "item": it["_id"], "text": _short(team_backlog.norm_display(it.get("text")), TEXT_CHARS),
                "category": it.get("category") or team_backlog.DEFAULT_CATEGORY, "status": it.get("status") or "open",
                "owner": it.get("owner_id"), "manual": bool(it.get("manual")),
                "docs": [s.get("doc_id") for s in it.get("sources") or [] if s.get("doc_id") is not None],
                "first_seen": _aware(it.get("first_seen")), "updated": _aware(it.get("updated_at")), "at": now_utc()},
                upsert=True))
        await db[COLL].bulk_write(ops, ordered=True)
        return len(items)
    except Exception:
        log.warning("ai index: backlog of %s failed", team_id, exc_info=True)
        return 0


# ── Hooks (coalesced, off the request) ────────────────────────────────────────

_pending: dict[tuple, tuple] = {}
_task: asyncio.Task | None = None


def touch_comments(db: AsyncIOMotorDatabase, doc_id: Any) -> None:
    _queue(db, "comments", doc_id)


def touch_backlog(db: AsyncIOMotorDatabase, team_id: Any) -> None:
    _queue(db, "backlog", team_id)


def touch_doc(db: AsyncIOMotorDatabase, doc_id: Any) -> None:
    _queue(db, "doc", doc_id)


def _queue(db: AsyncIOMotorDatabase, src: str, ident: Any) -> None:
    global _task
    try:
        if ident is None:
            return
        loop = asyncio.get_running_loop()
        if _task is not None and _task.get_loop() is not loop:
            _pending.clear()
            _task = None
        _pending[(getattr(db, "name", ""), src, str(ident))] = (db, src, ident)
        if _task is None or _task.done():
            _task = loop.create_task(_drain_loop())
    except Exception:
        log.debug("ai index: could not queue %s %s", src, ident, exc_info=True)


async def _drain_loop() -> None:
    await asyncio.sleep(DEBOUNCE_S)
    while _pending:
        batch = list(_pending.items())[:100]
        for key, _ in batch:
            _pending.pop(key, None)
        for _key, (db, src, ident) in batch:
            if src == "comments":
                await index_comments(db, ident)
            elif src == "backlog":
                await index_backlog(db, str(ident))
            else:
                await index_doc(db, ident)


async def drain() -> None:
    """Tests: wait until the queue is empty."""
    for _ in range(200):
        t = _task
        if t is None or t.done():
            if not _pending:
                return
        else:
            await asyncio.wait({t}, timeout=5)
        await asyncio.sleep(0)


# ── Reconcile, sweep, backfill ────────────────────────────────────────────────


async def _meta(db: AsyncIOMotorDatabase, key: str) -> dict:
    return await db[META].find_one({"_id": key}) or {}


async def reconcile(db: AsyncIOMotorDatabase, *, limit: int = RECONCILE_LIMIT) -> dict:
    """Rows for what changed through a path without a hook: documents and meetings updated since the last pass
    (with a minute of overlap) whose row is older; comment threads updated since; backlog items updated since."""
    from app.services import meetings, team_backlog
    from app.services.comments import model as cm

    state = await _meta(db, "reconcile")
    since = (_aware(state.get("since")) or (now_utc() - timedelta(hours=1))) - timedelta(minutes=1)
    started = now_utc()
    out = {"docs": 0, "comments": 0, "backlog": 0}
    rows = await db["documents"].find({"updated_at": {"$gte": since.replace(tzinfo=None)}}, {"updated_at": 1}).sort(
        "updated_at", 1).limit(limit).to_list(length=limit)
    if rows:
        have = {r["doc"]: _aware(r.get("updated")) for r in await db[COLL].find(
            {"_id": {"$in": [f"d:{r['_id']}" for r in rows]}}, {"doc": 1, "updated": 1}).to_list(length=len(rows))}
        for r in rows:
            if have.get(r["_id"]) != _aware(r.get("updated_at")):
                await index_doc(db, r["_id"])
                out["docs"] += 1
    async for m in db[meetings.COLL].find({"updated_at": {"$gte": since.replace(tzinfo=None)}}, {"doc_id": 1}).limit(limit):
        if m.get("doc_id"):
            await index_doc(db, m["doc_id"])
            out["docs"] += 1
    docs = await db[cm.THREADS].distinct("doc_id", {"updated_at": {"$gte": since.replace(tzinfo=None)}})
    for d in docs[:limit]:
        await index_comments(db, d)
        out["comments"] += 1
    teams = await db[team_backlog.ITEMS].distinct("team_id", {"updated_at": {"$gte": since.replace(tzinfo=None)}})
    for t in teams[:50]:
        await index_backlog(db, t)
        out["backlog"] += 1
    nxt = started if len(rows) < limit else _aware(rows[-1].get("updated_at")) or started
    await db[META].update_one({"_id": "reconcile"}, {"$set": {"since": nxt, "at": now_utc()}}, upsert=True)
    return out


async def sweep_tick(db: AsyncIOMotorDatabase, *, batch: int = SWEEP_BATCH) -> dict:
    """The nightly reconcile, a batch per call: documents by ``_id`` whose row is missing, of an older version or
    out of date are re-indexed; rows whose document is gone are dropped. Starts again once a day."""
    state = await _meta(db, "sweep")
    now = now_utc()
    if state.get("done"):
        if now - (_aware(state.get("finished_at")) or now) < SWEEP_EVERY:
            return {"done": True, "n": 0}
        state = {}
    q: dict = {"_id": {"$gt": state["cursor"]}} if state.get("cursor") is not None else {}
    rows = await db["documents"].find(q, {"updated_at": 1, "deleted_at": 1, "template": 1, "comment_counts": 1}).sort(
        "_id", 1).limit(batch).to_list(length=batch)
    n = 0
    if rows:
        have = {r["doc"]: r for r in await db[COLL].find({"_id": {"$in": [f"d:{r['_id']}" for r in rows]}},
                                                         {"doc": 1, "updated": 1, "v": 1, "c_open": 1, "c_resolved": 1}
                                                         ).to_list(length=len(rows))}
        for r in rows:
            h = have.get(r["_id"])
            gone = r.get("deleted_at") is not None or r.get("template")
            cc = r.get("comment_counts") or {}
            if gone:
                if h is not None:
                    await drop(db, r["_id"])
                    n += 1
                continue
            if (h is None or h.get("v") != VERSION or _aware(h.get("updated")) != _aware(r.get("updated_at"))):
                await index_doc(db, r["_id"])
                n += 1
            if h is None or int(cc.get("open") or 0) != int(h.get("c_open") or 0) or int(cc.get("resolved") or 0) != int(
                    h.get("c_resolved") or 0):
                if cc.get("open") or cc.get("resolved") or (h and (h.get("c_open") or h.get("c_resolved"))):
                    await index_comments(db, r["_id"])
        state["cursor"] = rows[-1]["_id"]
        state["n"] = int(state.get("n") or 0) + n
        state.setdefault("started_at", now)
    else:
        # Rows whose document no longer exists at all (not even in the trash).
        live = set()
        async for r in db[COLL].find({"t": "doc"}, {"doc": 1}).limit(200_000):
            live.add(r["doc"])
        if live:
            exists = set()
            ids = list(live)
            for i in range(0, len(ids), 5000):
                exists |= {r["_id"] for r in await db["documents"].find({"_id": {"$in": ids[i:i + 5000]}}, {"_id": 1}).to_list(length=5000)}
            for d in live - exists:
                await drop(db, d)
                n += 1
        state.update(done=True, finished_at=now, cursor=None)
    await db[META].update_one({"_id": "sweep"}, {"$set": state}, upsert=True)
    return {"done": bool(state.get("done")), "n": n}


async def backfill_tick(db: AsyncIOMotorDatabase, *, batch: int = 200, apply: bool = True) -> dict:
    """One slice of the backfill (documents by ``_id`` without a current row, then every team's backlog);
    resumable, a no-op once done for VERSION. ``apply=False``: count only (the script's dry run)."""
    state = await _meta(db, "backfill")
    if state.get("version") == VERSION and state.get("done"):
        return {"done": True, "n": 0}
    if state.get("version") != VERSION:
        state = {"version": VERSION, "cursor": None, "n": 0}
    q: dict = {"_id": {"$gt": state["cursor"]}} if state.get("cursor") is not None else {}
    q.update({"deleted_at": None, "template": {"$ne": True}})
    rows = await db["documents"].find(q, {"_id": 1, "comment_counts": 1}).sort("_id", 1).limit(batch).to_list(length=batch)
    n = 0
    for r in rows:
        if apply:
            await index_doc(db, r["_id"])
            cc = r.get("comment_counts") or {}
            if cc.get("open") or cc.get("resolved"):
                await index_comments(db, r["_id"])
        n += 1
    if rows:
        state["cursor"] = rows[-1]["_id"]
        state["n"] = int(state.get("n") or 0) + n
    else:
        if apply:
            async for t in db["teams"].find({}, {"_id": 1}):
                await index_backlog(db, str(t["_id"]))
        state["done"] = True
    if apply:
        await db[META].update_one({"_id": "backfill"}, {"$set": state}, upsert=True)
    return {"done": bool(state.get("done")), "n": n, "cursor": str(state.get("cursor") or "")}


async def background(db: AsyncIOMotorDatabase) -> None:
    """The ``ai_index`` loop body (services/background.py): backfill, reconcile, the daily sweep, then
    Layer 2 summaries and Layer 3 embeddings (each under its own AI cap; embeddings only with a key)."""
    from app.services import ai_summaries, ai_vectors

    await backfill_tick(db)
    await reconcile(db)
    await sweep_tick(db)
    await ai_summaries.tick(db)
    await ai_vectors.tick(db)


async def status(db: AsyncIOMotorDatabase) -> dict:
    return {"rows": await db[COLL].estimated_document_count(), "backfill": await _meta(db, "backfill"),
            "sweep": {k: v for k, v in (await _meta(db, "sweep")).items() if k != "_id"}}


# ── Queries (access decided per row, for this asker) ──────────────────────────


@dataclass
class Filter:
    """What to list. ``kind``: doc | meeting | action | comment | backlog. People are user ids."""

    kind: str = "doc"
    workspaces: list[str] = field(default_factory=list)
    creator: str | None = None          # docs: created by (system pages never count)
    editor: str | None = None           # docs: edited by (saved a version)
    attendee: str | None = None         # meetings: attended
    owner: str | None = None            # actions / backlog: owned by
    author: str | None = None           # comments: started or replied
    team: str | None = None             # a team id (only rows tagged with it)
    project: str | None = None          # a project id (only rows of documents in that project)
    since: date | None = None
    since_at: datetime | None = None    # an exact moment instead of a day (what changed since someone last looked)
    until: date | None = None
    on: str = "updated"                 # docs: which date the window applies to (created | updated)
    done: bool | None = None            # actions: done / open
    status: str | None = None           # comments: open | resolved; backlog: open | in_progress | done | wont_do
    series: str | None = None           # meetings: a series or title (case-insensitive substring)
    title: str | None = None            # docs: a word or phrase in the title
    kinds: tuple = ()                   # docs: page, doc, file
    include_system: bool = False
    limit: int = 200


@dataclass
class Result:
    rows: list[dict]
    total: int                          # rows the asker may see (exact up to QUERY_MAX scanned)
    capped: bool = False                # more rows matched than were scanned


def _window(f: Filter, key: str) -> dict:
    out: dict = {}
    if key == "date":
        if f.since_at is not None:
            # A meeting has a day, not a time: the moment's own day counts when the moment is before noon (UTC) or within
            # the last day, else from the next day.
            at = _aware(f.since_at)
            same_day = at.hour < 12 or (now_utc() - at) < timedelta(days=1)
            out["$gte" if same_day else "$gt"] = at.date().isoformat()
        elif f.since:
            out["$gte"] = f.since.isoformat()
        if f.until:
            out["$lte"] = f.until.isoformat()
        return out
    if f.since_at is not None:
        out["$gte"] = _aware(f.since_at)
    elif f.since:
        out["$gte"] = datetime(f.since.year, f.since.month, f.since.day, tzinfo=timezone.utc)
    if f.until:
        out["$lt"] = datetime(f.until.year, f.until.month, f.until.day, tzinfo=timezone.utc) + timedelta(days=1)
    return out


def mongo_filter(f: Filter) -> dict:
    q: dict[str, Any] = {"ws": {"$in": list(f.workspaces)}}
    if f.kind in ("doc", "meeting"):
        q["t"] = "doc"
        q["deleted"] = {"$ne": True}
        if f.kind == "meeting":
            q["kind"] = "meeting"
            if f.attendee:
                q["attendees"] = f.attendee
            if f.series:
                rx = re.escape(f.series.strip())
                q["$or"] = [{"series": {"$regex": rx, "$options": "i"}}, {"mtitle": {"$regex": rx, "$options": "i"}}]
            w = _window(f, "date")
            if w:
                q["date"] = w
        else:
            q["kind"] = {"$in": list(f.kinds)} if f.kinds else {"$nin": ["meeting", "transcript"]}
            if not f.include_system:
                q["system"] = None
            if f.creator:
                q["creator"] = f.creator
                q["system"] = None
            if f.editor:
                q["editors"] = f.editor
            if f.title:
                q["title"] = {"$regex": re.escape(f.title.strip()), "$options": "i"}
            w = _window(f, f.on if f.on in ("created", "updated") else "updated")
            if w:
                q["created" if f.on == "created" else "updated"] = w
    elif f.kind == "action":
        q["t"] = "action"
        if f.owner:
            q["owner"] = f.owner
        if f.done is not None:
            q["done"] = f.done
        w = _window(f, "date")
        if w:
            q["date"] = w
    elif f.kind == "comment":
        q["t"] = "comment"
        if f.author:
            q["$or"] = [{"author": f.author}, {"participants": f.author}]
        if f.status:
            q["status"] = f.status
        w = _window(f, "updated")
        if w:
            q["updated"] = w
    elif f.kind == "backlog":
        q["t"] = "backlog"
        if f.owner:
            q["owner"] = f.owner
        if f.status:
            q["status"] = {"$in": ["open", "in_progress"]} if f.status == "open" else f.status
    if f.team:
        q["team" if f.kind == "backlog" else "teams"] = f.team
    return q


def _sort_of(f: Filter) -> list:
    if f.kind == "meeting" or f.kind == "action":
        return [("date", -1), ("_id", 1)]
    if f.kind == "doc":
        return [("created" if f.on == "created" else "updated", -1), ("_id", 1)]
    return [("updated", -1), ("_id", 1)]


async def readable_docs(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx,
                        ids: list) -> dict[ObjectId, dict]:
    """The documents among ``ids`` that may show up for the asker now (``access.discoverable``, inside the
    request's team space), by id (projection without content)."""
    from app.services import teams as teams_service

    out: dict[ObjectId, dict] = {}
    oids = [i for i in {_oid(x) for x in ids} if i is not None]
    if not oids or not actor.user_id:
        return out
    space = teams_service.parse_space(ctx.space) if ctx.space else None
    for i in range(0, len(oids), 1000):
        for d in await db["documents"].find({"_id": {"$in": oids[i:i + 1000]}, "deleted_at": None},
                                            {"content": 0}).to_list(length=1000):
            if d.get("template") or not await access.discoverable(actor, d, ctx):
                continue
            if space is not None and space.kind != "all" and d.get("workspace_id"):
                view = await ctx.team_view(d["workspace_id"], actor.user_id)
                if not teams_service.in_space(view, space, d):
                    continue
            out[d["_id"]] = d
    return out


async def query(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, f: Filter) -> Result:
    """The rows matching ``f`` that this asker may see, newest first, with the exact count."""
    if not actor.user_id or not f.workspaces:
        return Result([], 0)
    # Only workspaces the asker belongs to (their own items elsewhere are not this index's business).
    wss = [w for w in f.workspaces if await ctx.role(w, actor.user_id) is not None]
    if not wss:
        return Result([], 0)
    f = Filter(**{**f.__dict__, "workspaces": wss})
    if f.team:
        view = await ctx.team_view(wss[0], actor.user_id)
        if f.team not in view.readable_teams:
            return Result([], 0)
    if f.project:
        view = await ctx.team_view(wss[0], actor.user_id)
        if f.project not in view.readable_projects:
            return Result([], 0)
    rows = await db[COLL].find(mongo_filter(f)).sort(_sort_of(f)).limit(QUERY_MAX).to_list(length=QUERY_MAX)
    capped = len(rows) >= QUERY_MAX
    if f.kind == "backlog":
        ids = [d for r in rows for d in r.get("docs") or []]
    else:
        ids = [r["doc"] for r in rows]
    ok = await readable_docs(db, actor, ctx, ids)
    keep: list[dict] = []
    if f.kind == "backlog":
        views: dict[str, Any] = {}
        for r in rows:
            ws = r.get("ws")
            if ws not in views:
                views[ws] = await ctx.team_view(ws, actor.user_id) if ws else None
            v = views[ws]
            if v is None or r.get("team") not in v.readable_teams:
                continue
            if not r.get("manual") and not any(_oid(d) in ok for d in r.get("docs") or []):
                continue
            keep.append(r)
    elif f.kind == "comment":
        from app.services.comments import perms as comment_perms

        seen: dict[Any, bool] = {}
        for r in rows:
            d = ok.get(r["doc"])
            if d is None:
                continue
            if r["doc"] not in seen:
                seen[r["doc"]] = (await comment_perms.perms_for(db, actor, d, ctx)).view
            if seen[r["doc"]]:
                keep.append(r)
    else:
        for r in rows:
            d = ok.get(r["doc"])
            if d is None:
                continue
            if d.get("encrypted"):
                continue
            keep.append(r)
    if f.project and f.kind != "backlog":
        keep = [r for r in keep if f.project in [str(p) for p in (ok.get(r.get("doc")) or {}).get("project_ids") or []]]
    # Teams on a row: only those the asker can read (a private team's name stays with its members).
    readable_teams: set[str] = set()
    for ws in {r.get("ws") for r in keep if r.get("ws")}:
        readable_teams |= set((await ctx.team_view(ws, actor.user_id)).readable_teams)
    for r in keep:
        if r.get("teams"):
            r["teams"] = [t for t in r["teams"] if t in readable_teams]
        r["_doc"] = ok.get(r.get("doc")) if r.get("doc") is not None else None
    return Result(keep[: max(1, f.limit)], len(keep), capped)
