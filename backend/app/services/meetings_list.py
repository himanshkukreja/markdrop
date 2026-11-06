"""The Meetings list, a page at a time (owner 2026-11-06: "the meetings page took a lot of time to load").

    GET /api/v1/meetings?workspace=&limit=30&cursor=&sort=&q=&series=&source=&since=&until=
        → {meetings, next_cursor, total, hidden, folder_id}

Used by the hub (routers/meetings.py), Home's Meetings section (services/home.py) and MCP ``list_meetings``,
all through :func:`meetings.list_meetings`.

**Order and cursor.** Keyset pagination over the sort's keys, ``_id`` last, so a page boundary between
meetings on the same date (or time, or title) never repeats or skips one:

* ``date_desc`` (default): date, time, newest first; meetings without a date last;
* ``date_asc``: oldest first; meetings without a date still last (a second segment of the scan);
* ``title``: A→Z, any case (collation), then newest first;
* ``imported``: when they were imported, newest first.

The cursor (opaque, base64 JSON) is the last returned meeting's keys and the segment it came from.

**Cost.** One aggregate for the page's rows (projected to what a card shows: never the transcript, the
notes or the AI sections, only their counts and the summary's first line), one ``$in`` for their pages
(without ``content``, only the front matter's first bytes for the cover), and the access decisions in
memory (``access.Ctx`` caches the workspace, the caller's role and grants). The first page also counts
what the caller can open (``total``) and, for a workspace admin with no filter, the restricted meetings
they can't open (``hidden``) — one light pass over the workspace's rows.

**Access** is unchanged: every meeting is decided on its page with ``access.can(read)``; rows the caller
can't open are skipped wherever they fall, and a page is filled from the rows after them.
"""

from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import access

COLL = "meetings"
PAGE_DEFAULT = 30
PAGE_MAX = 100          # the REST endpoint's cap; MCP asks for up to INTERNAL_MAX
INTERNAL_MAX = 300
SUMMARY_CHARS = 200
ATTENDEES_SHOWN = 5
HIDDEN_MAX = 50
HEAD_CHARS = 6000       # the page's front matter (cover) is at its top
TITLE_COLLATION = {"locale": "en", "strength": 2}


@dataclass(frozen=True)
class _Segment:
    keys: tuple[tuple[str, int], ...]
    filter: dict | None = None


_DATE_DESC = (("date", -1), ("time", -1), ("_id", -1))
SORTS: dict[str, tuple[_Segment, ...]] = {
    "date_desc": (_Segment(_DATE_DESC),),     # Mongo puts null last when descending
    "date_asc": (_Segment((("date", 1), ("time", 1), ("_id", 1)), {"date": {"$ne": None}}),
                 _Segment((("time", 1), ("_id", 1)), {"date": None})),
    "title": (_Segment((("title", 1),) + _DATE_DESC),),
    "imported": (_Segment((("created_at", -1), ("_id", -1))),),
}
SORT_NAMES = tuple(SORTS)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index([("workspace_id", 1), ("date", -1), ("time", -1), ("_id", -1)])
    await db[COLL].create_index([("workspace_id", 1), ("series", 1), ("date", -1), ("time", -1), ("_id", -1)])
    await db[COLL].create_index([("workspace_id", 1), ("created_at", -1), ("_id", -1)])
    await db[COLL].create_index([("workspace_id", 1), ("title", 1), ("date", -1), ("time", -1), ("_id", -1)],
                                collation=TITLE_COLLATION, name="workspace_title_ci")


# ── Cursor ────────────────────────────────────────────────────────────────────


def _enc(v: Any) -> Any:
    if isinstance(v, ObjectId):
        return {"o": str(v)}
    if isinstance(v, datetime):
        return {"d": v.isoformat()}
    return v


def _dec(v: Any) -> Any:
    if isinstance(v, dict):
        if "o" in v and ObjectId.is_valid(v["o"]):
            return ObjectId(v["o"])
        if "d" in v:
            return datetime.fromisoformat(v["d"])
        raise ValueError("bad value")
    if v is None or isinstance(v, (str, int, float)):
        return v
    raise ValueError("bad value")


def encode_cursor(sort: str, seg: int, vals: list[Any]) -> str:
    raw = json.dumps({"s": sort, "g": seg, "v": [_enc(v) for v in vals]}, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def decode_cursor(cursor: str, sort: str) -> tuple[int, list[Any]]:
    try:
        pad = "=" * (-len(cursor) % 4)
        data = json.loads(base64.urlsafe_b64decode(cursor + pad))
        seg, vals = int(data["g"]), [_dec(v) for v in data["v"]]
        if data["s"] != sort or not 0 <= seg < len(SORTS[sort]) or len(vals) != len(SORTS[sort][seg].keys):
            raise ValueError("another order")
        return seg, vals
    except Exception:
        raise HTTPException(status_code=422, detail="That cursor isn't valid for this list. Start again without it.")


def _key(row: dict, seg: _Segment) -> list[Any]:
    return [row.get(f) for f, _ in seg.keys]


def after(keys: tuple[tuple[str, int], ...], vals: list[Any]) -> dict:
    """The rows strictly after ``vals`` in the order ``keys`` (Mongo's: null lowest, so last when
    descending and first when ascending)."""
    ors: list[dict] = []
    for i, (f, d) in enumerate(keys):
        eq = {keys[j][0]: vals[j] for j in range(i)}
        v = vals[i]
        if d < 0:
            if v is None:
                continue                      # nothing sorts after null, descending
            cond: dict = {"$or": [{f: {"$lt": v}}, {f: None}]}
        else:
            cond = {f: {"$gt": v}} if v is not None else {f: {"$ne": None}}
        ors.append({**eq, **cond})
    return {"$or": ors} if ors else {"_id": {"$exists": False}}


# ── Rows and pages ────────────────────────────────────────────────────────────


def _is_array_size(path: str) -> dict:
    return {"$cond": [{"$isArray": path}, {"$size": path}, 0]}


# What a card needs from a row: the transcript, notes and AI sections stay in the database.
CARD_PROJECTION: dict[str, Any] = {
    **{k: 1 for k in ("workspace_id", "title", "date", "time", "duration_s", "type", "series", "restricted",
                      "action_items", "transcript_slug", "doc_id", "created_at", "updated_at", "via", "history",
                      "cover", "attendees", "ai.state", "ai.message")},
    "n_segments": _is_array_size("$segments"),
    "has_notes": {"$and": [{"$eq": [{"$type": "$notes"}, "object"]}, {"$ne": ["$notes", {}]}]},
    "summary_src": {"$let": {"vars": {"g": "$generated.summary"}, "in": {"$cond": [
        {"$and": [{"$eq": [{"$type": "$$g"}, "string"]}, {"$ne": ["$$g", ""]}]}, "$$g", "$notes.summary"]}}},
    "n_decisions": _is_array_size("$generated.decisions"),
    "n_open_questions": _is_array_size("$generated.open_questions"),
}


async def pages_for(db: AsyncIOMotorDatabase, rows: list[dict], *, head: bool = False) -> dict[str, dict]:
    """doc_id → the meeting page (no ``content``; with ``head``: its first bytes as ``_head``), one query."""
    from app.services.meetings import oid

    ids = list({o for o in (oid(r.get("doc_id")) for r in rows) if o is not None})
    if not ids:
        return {}
    if head:
        pipeline = [{"$match": {"_id": {"$in": ids}}},
                    {"$addFields": {"_head": {"$substrCP": [{"$ifNull": ["$content", ""]}, 0, HEAD_CHARS]}}},
                    {"$project": {"content": 0}}]
        docs = await db["documents"].aggregate(pipeline).to_list(length=len(ids))
    else:
        docs = await db["documents"].find({"_id": {"$in": ids}}, {"content": 0}).to_list(length=len(ids))
    return {str(d["_id"]): d for d in docs}


async def readable_pages(db: AsyncIOMotorDatabase, rows: list[dict], actor: access.Actor, ctx: access.Ctx, *,
                         head: bool = False) -> tuple[dict[str, dict], dict[str, dict]]:
    """(readable, unreadable): doc_id → page for the rows' pages the caller can / can't open — one
    query for the pages, the decisions from ``ctx``'s caches. Rows whose page is gone are in neither."""
    pages = await pages_for(db, rows, head=head)
    ok, no = {}, {}
    for did, raw in pages.items():
        (ok if (await access.can(actor, raw, "read", ctx)).allowed else no)[did] = raw
    return ok, no


def _cover(row: dict, raw: dict) -> str:
    from app.services import page_props
    from app.services.meetings import cover_for

    cover = None
    try:
        cur = page_props.parse(raw.get("_head") or "").get("cover") or ""
        if isinstance(cur, str) and cur.startswith("gallery:"):
            cover = cur[len("gallery:"):]
    except Exception:
        cover = None
    return cover or row.get("cover") or cover_for(row.get("series"))


def card(row: dict, raw: dict, *, uid: str | None, admin: bool, attendees_max: int | None = ATTENDEES_SHOWN) -> dict:
    """One meeting as the list shows it (GET /meetings/{id} has the rest)."""
    from app.services.meetings import iso, snippet, source_of

    people = [{"name": a.get("name"), "user_id": a.get("user_id")} for a in row.get("attendees") or [] if a.get("name")]
    n = int(row.get("n_segments") or 0)
    return {
        "id": str(row["_id"]), "workspace_id": row["workspace_id"], "title": row.get("title"),
        "page_title": raw.get("title"), "slug": raw["slug"], "transcript_slug": row.get("transcript_slug"),
        "date": row.get("date"), "time": row.get("time"), "duration_s": row.get("duration_s"),
        "type": row.get("type"), "series": row.get("series") or None,
        "attendees": people[:attendees_max] if attendees_max is not None else people,
        "attendee_count": len(people),
        "restricted": bool(row.get("restricted")), "action_items": int(row.get("action_items") or 0),
        "decisions": int(row.get("n_decisions") or 0), "open_questions": int(row.get("n_open_questions") or 0),
        "summary": snippet(row.get("summary_src") if isinstance(row.get("summary_src"), str) else None, SUMMARY_CHARS),
        "cover": _cover(row, raw),
        "segments": n, "has_transcript": n > 0, "has_notes": bool(row.get("has_notes")),
        "ai": _ai(row),
        "source": source_of(row), "history": bool(row.get("history")),
        "created_at": iso(row.get("created_at")),
        "can_delete": raw.get("owner_id") == uid or admin,
    }


def _ai(row: dict) -> dict:
    """{state, message}: a summary still "pending" long after the import reads as failed (meetings.ai_view)."""
    from app.services.meetings import ai_view

    v = ai_view({"ai": row.get("ai") or {}, "updated_at": row.get("updated_at"), "created_at": row.get("created_at")})
    return {"state": v["state"], "message": v["message"]}


# ── The list ──────────────────────────────────────────────────────────────────


@dataclass
class Filters:
    q: str | None = None
    source: str | None = None
    since: str | None = None
    until: str | None = None
    series: str | None = None
    extra: list[dict] = field(default_factory=list)

    @property
    def any(self) -> bool:
        return bool(self.q or self.source or self.since or self.until or self.series)


def base_query(workspace_id: str, f: Filters) -> dict:
    from app.services.meetings import SOURCES, _VIA

    parts: list[dict] = [{"workspace_id": workspace_id}]
    if f.source:
        if f.source not in SOURCES:
            raise HTTPException(status_code=422, detail=f"source is one of {', '.join(SOURCES)}.")
        parts.append({"via": _VIA[f.source]})
    rng: dict[str, str] = {}
    for name, v, op in (("since", f.since, "$gte"), ("until", f.until, "$lte")):
        if not v:
            continue
        try:
            date.fromisoformat(v)
        except ValueError:
            raise HTTPException(status_code=422, detail=f"{name} is a date, YYYY-MM-DD.")
        rng[op] = v
    if rng:
        parts.append({"date": rng})
    if f.series:
        s = f.series.strip()
        parts.append({"series": {"$in": [None, ""]}} if s.casefold() == "none"
                     else {"series": {"$regex": f"^{re.escape(s)}$", "$options": "i"}})
    q = (f.q or "").strip()
    if q:
        rx = {"$regex": re.escape(q[:100]), "$options": "i"}
        parts.append({"$or": [{"title": rx}, {"series": rx}, {"attendees.name": rx}]})
    parts.extend(f.extra)
    return {"$and": parts}


async def _scan(db: AsyncIOMotorDatabase, query: dict, sort: str, start: tuple[int, list[Any] | None], limit: int,
                actor: access.Actor, ctx: access.Ctx) -> tuple[list[tuple[int, dict, dict]], bool]:
    """Up to ``limit`` + 1 readable (segment, row, page) after ``start``, in order; whether more exist."""
    segs = SORTS[sort]
    seg, vals = start
    out: list[tuple[int, dict, dict]] = []
    batch = max(limit + 1, 20)
    while seg < len(segs) and len(out) <= limit:
        s = segs[seg]
        parts = [query] + ([s.filter] if s.filter else []) + ([after(s.keys, vals)] if vals is not None else [])
        pipeline = [{"$match": {"$and": parts}}, {"$sort": dict(s.keys)}, {"$limit": batch},
                    {"$project": CARD_PROJECTION}]
        opts = {"collation": TITLE_COLLATION} if sort == "title" else {}
        rows = await db[COLL].aggregate(pipeline, **opts).to_list(length=batch)
        if rows:
            ok, _no = await readable_pages(db, rows, actor, ctx, head=True)
            for row in rows:
                vals = _key(row, s)
                raw = ok.get(str(row.get("doc_id")))
                if raw is not None:
                    out.append((seg, row, raw))
                    if len(out) > limit:
                        break
        if len(out) > limit:
            break
        if len(rows) < batch:
            seg, vals = seg + 1, None
    more = len(out) > limit
    return out[:limit], more


async def _overview(db: AsyncIOMotorDatabase, query: dict, actor: access.Actor, ctx: access.Ctx, *,
                    hidden: bool) -> tuple[int, list[dict]]:
    """(how many matching meetings the caller can open, the ones they can't — for an admin)."""
    rows = await db[COLL].find(query, {"doc_id": 1, "date": 1}).sort(list(_DATE_DESC)).to_list(length=None)
    ok, no = await readable_pages(db, rows, actor, ctx)
    total = sum(1 for r in rows if str(r.get("doc_id")) in ok)
    out = []
    if hidden:
        for r in rows:
            if str(r.get("doc_id")) in no:
                out.append({"id": str(r["_id"]), "date": r.get("date"), "restricted": True, "redacted": True,
                            "can_delete": True})
                if len(out) >= HIDDEN_MAX:
                    break
    return total, out


async def list_page(db: AsyncIOMotorDatabase, workspace_id: str, actor: access.Actor, ctx: access.Ctx, *,
                    limit: int = PAGE_DEFAULT, cursor: str | None = None, sort: str = "date_desc",
                    filters: Filters | None = None, overview: bool = True,
                    attendees_max: int | None = ATTENDEES_SHOWN) -> dict:
    from app.models.workspace import role_allows
    from app.services.meetings import folder_of, require_member

    if sort not in SORTS:
        raise HTTPException(status_code=422, detail=f"sort is one of {', '.join(SORT_NAMES)}.")
    role = await require_member(db, workspace_id, actor.user_id, write=False)
    admin = role_allows(role, "admin")
    f = filters or Filters()
    query = base_query(workspace_id, f)
    limit = max(1, min(int(limit), INTERNAL_MAX))
    start = decode_cursor(cursor, sort) if cursor else (0, None)
    got, more = await _scan(db, query, sort, start, limit, actor, ctx)
    uid = actor.user_id
    items = [card(row, raw, uid=uid, admin=admin, attendees_max=attendees_max) for _seg, row, raw in got]
    next_cursor = None
    if more and got:
        seg, row, _raw = got[-1]
        next_cursor = encode_cursor(sort, seg, _key(row, SORTS[sort][seg]))
    out: dict[str, Any] = {"meetings": items, "next_cursor": next_cursor, "total": None, "hidden": []}
    if cursor is None:
        if overview:
            out["total"], out["hidden"] = await _overview(db, query, actor, ctx, hidden=admin and not f.any)
        folder = await folder_of(db, workspace_id)
        out["folder_id"] = str(folder["_id"]) if folder else None
    return out


async def facets(db: AsyncIOMotorDatabase, workspace_id: str, actor: access.Actor, ctx: access.Ctx) -> dict:
    """The series of the meetings the caller can open ([{name, count, last}], most meetings first), how
    many they can open in all, and how many belong to no series — one pass."""
    from collections import Counter

    rows = await db[COLL].find({"workspace_id": workspace_id}, {"series": 1, "date": 1, "doc_id": 1}).to_list(length=None)
    ok, _no = await readable_pages(db, rows, actor, ctx)
    counts: Counter = Counter()
    last: dict[str, str] = {}
    total = one_offs = 0
    for r in rows:
        if str(r.get("doc_id")) not in ok:
            continue
        total += 1
        s = r.get("series")
        if not s:
            one_offs += 1
            continue
        counts[s] += 1
        if (r.get("date") or "") > last.get(s, ""):
            last[s] = r.get("date") or ""
    series = [{"name": n, "count": c, "last": last.get(n) or None}
              for n, c in sorted(counts.items(), key=lambda x: (-x[1], x[0].casefold()))]
    return {"series": series, "total": total, "one_offs": one_offs}
