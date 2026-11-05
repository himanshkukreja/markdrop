"""How meetings are organised: a **Series** for recurring calls, and the Meetings folder's views.

* Every meeting row has ``series`` (a name or None) and ``series_from`` ("auto": detected, "user":
  set or cleared by a person, who always wins). Detection (:func:`detect`): meetings whose names
  differ only by numbers and dates share a key (meeting_backfill_detect.series_key); when the
  workspace already names that series, a new meeting joins it; when a second meeting of a name
  arrives, both become the series (the earlier one-off is updated: :func:`adopt`).
* The **Meetings folder** gets a Series property (Select; an option per series, added as series
  appear) and three saved views, once (``folders.meetings_views``): "All meetings" (table, Date
  newest first, grouped by month), "By series" (board) and "Series table". The folder opens on
  "All meetings" (frontend FolderView); a person's own changes to the views are never redone.
* The series is on the page too (front matter ``props``), so the folder's table, board and filters
  see it; changing it on the page's property panel is a change of the page, not of the row (the hub
  reads the row): :func:`set_series` writes both.
"""

from __future__ import annotations

import logging
from collections import Counter
from typing import Any

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import access
from app.services import meeting_backfill_detect as det

log = logging.getLogger("markdrop.meeting_series")

COLL = "meetings"
SERIES_PROP = {"key": "series", "name": "Series", "type": "select", "options": []}
SERIES_MAX = 60   # page_db.OPTION_MAX
VIEW_ALL = "vmtgall"
VIEW_BOARD = "vmtgseries"
VIEW_TABLE = "vmtgstable"
VIEWS = [
    {"id": VIEW_ALL, "name": "All meetings", "type": "table", "sort": [{"key": "date", "dir": "desc"}],
     "filter": [], "group": "date", "hidden": ["organizer"], "widths": {}, "order": []},
    {"id": VIEW_BOARD, "name": "By series", "type": "board", "sort": [{"key": "date", "dir": "desc"}],
     "filter": [], "group": "series", "hidden": ["attendees", "organizer", "duration"], "widths": {}, "order": []},
    {"id": VIEW_TABLE, "name": "Series table", "type": "table", "sort": [{"key": "date", "dir": "desc"}],
     "filter": [], "group": "series", "hidden": ["organizer"], "widths": {}, "order": []},
]


def clean_name(value: Any) -> str | None:
    v = " ".join(str(value or "").replace("\x00", "").split())[:SERIES_MAX]
    return v or None


# ── The folder ────────────────────────────────────────────────────────────────


async def organise_folder(db: AsyncIOMotorDatabase, folder: dict, user_id: str | None) -> dict:
    """The Series property and the meetings views on the Meetings folder (once; idempotent)."""
    from app.services import page_db

    if folder is None or folder.get("meetings_views"):
        return folder
    schema = list(folder.get("properties") or [])
    if not any(p.get("key") == "series" for p in schema):
        if any((p.get("name") or "").casefold() == "series" for p in schema) or len(schema) >= page_db.MAX_PROPERTIES:
            await db["folders"].update_one({"_id": folder["_id"]}, {"$set": {"meetings_views": True}})
            return folder
        at = next((i + 1 for i, p in enumerate(schema) if p.get("key") == "type"), len(schema))
        schema = [*schema[:at], dict(SERIES_PROP), *schema[at:]]
    keys = {p["key"] for p in schema}
    views = list(folder.get("views") or [])
    have = {v.get("id") for v in views}
    add = []
    for v in VIEWS:
        if v["id"] in have or v["group"] not in keys:
            continue
        add.append({**v, "hidden": [k for k in v["hidden"] if k in keys]})
    try:
        await page_db.set_schema(db, folder["workspace_id"], str(folder["_id"]), user_id, schema,
                                 views=[*add, *views][:page_db.MAX_VIEWS])
    except HTTPException as exc:
        log.info("meetings: folder views not set (%s)", exc.detail)
        return folder
    await db["folders"].update_one({"_id": folder["_id"]}, {"$set": {"meetings_views": True}})
    return await db["folders"].find_one({"_id": folder["_id"]}) or folder


async def ensure_option(db: AsyncIOMotorDatabase, folder: dict | None, name: str | None, user_id: str | None) -> dict | None:
    """The series as an option of the folder's Series property (added when it isn't one yet)."""
    from app.services import page_db

    if folder is None or not name:
        return folder
    schema = list(folder.get("properties") or [])
    prop = next((p for p in schema if p.get("key") == "series" and p.get("type") == "select"), None)
    if prop is None:
        return folder
    opts = list(prop.get("options") or [])
    if any(o["name"].casefold() == name.casefold() for o in opts) or len(opts) >= page_db.MAX_OPTIONS:
        return folder
    new = [{**p, "options": [*opts, {"name": name}]} if p is prop else p for p in schema]
    for _ in range(3):
        try:
            await page_db.set_schema(db, folder["workspace_id"], str(folder["_id"]), user_id, new,
                                     base_rev=int(folder.get("properties_rev") or 0))
            break
        except HTTPException as exc:
            if exc.status_code != 409:
                log.info("meetings: series option not added (%s)", exc.detail)
                break
            folder = await db["folders"].find_one({"_id": folder["_id"]}) or folder
            schema = list(folder.get("properties") or [])
            prop = next((p for p in schema if p.get("key") == "series"), None)
            if prop is None or any(o["name"].casefold() == name.casefold() for o in prop.get("options") or []):
                break
            new = [{**p, "options": [*(p.get("options") or []), {"name": name}]} if p is prop else p for p in schema]
    return await db["folders"].find_one({"_id": folder["_id"]}) or folder


def option_name(folder: dict | None, name: str | None) -> str | None:
    """How the folder writes that series (an option's own casing), or None when it has no such option."""
    if not folder or not name:
        return None
    for p in folder.get("properties") or []:
        if p.get("key") == "series":
            for o in p.get("options") or []:
                if o["name"].casefold() == name.casefold():
                    return o["name"]
    return None


# ── Detection ─────────────────────────────────────────────────────────────────


def key_of(row: dict) -> str:
    return row.get("series_key") if row.get("series_key") is not None else det.series_key(row.get("title"))


async def known(db: AsyncIOMotorDatabase, workspace_id: str) -> dict[str, dict]:
    """The workspace's meetings by series key: {key: {"series": Counter(names), "rows": n, "loose": [ids]}}
    ("loose": meetings of that name without a series that a person didn't clear)."""
    out: dict[str, dict] = {}
    async for r in db[COLL].find({"workspace_id": workspace_id},
                                 {"title": 1, "series": 1, "series_key": 1, "series_from": 1}):
        k = key_of(r)
        if not k:
            continue
        e = out.setdefault(k, {"series": Counter(), "rows": 0, "loose": []})
        e["rows"] += 1
        if r.get("series"):
            e["series"][r["series"]] += 1
        elif r.get("series_from") != "user":
            e["loose"].append(r["_id"])
    return out


def decide(key: str, label: str | None, entry: dict | None, *, batch: int = 0) -> str | None:
    """The series of a new meeting with series key ``key``: the series its namesakes already have;
    else, when it isn't the only one of its name (``batch``: others of the name in the same import),
    the name without its numbers."""
    if not key:
        return None
    if entry and entry["series"]:
        return entry["series"].most_common(1)[0][0]
    if (entry["rows"] if entry else 0) + batch >= 1:
        return label
    return None


async def detect(db: AsyncIOMotorDatabase, workspace_id: str, title: str | None, *, batch: int = 0) -> tuple[str | None, str]:
    """(series or None, key) for a new meeting called ``title``."""
    key = det.series_key(title)
    if not key:
        return None, ""
    entry = (await known(db, workspace_id)).get(key)
    return decide(key, det.series_label(title), entry, batch=batch), key


async def adopt(db: AsyncIOMotorDatabase, user, workspace_id: str, key: str, series: str, *,
                skip_id: Any = None, quiet: bool = True) -> int:
    """The earlier meetings of that name without a series join it (row and page). Returns how many."""
    from app.services import notifications

    if not key or not series:
        return 0
    n = 0
    actor, ctx = access.Actor.of(user), access.Ctx(db)
    async for r in db[COLL].find({"workspace_id": workspace_id, "series": {"$in": [None, ""]},
                                  "series_from": {"$ne": "user"}}, {"segments": 0}):
        if r["_id"] == skip_id or key_of(r) != key:
            continue
        raw = await db["documents"].find_one({"_id": r.get("doc_id")}) if r.get("doc_id") else None
        try:
            with notifications.quietly(quiet):
                await set_series(db, r, raw, series, actor, ctx, source="auto", check=False)
            n += 1
        except HTTPException as exc:
            log.info("meetings: series not set on %s (%s)", r["_id"], exc.detail)
    return n


# ── Changing it ───────────────────────────────────────────────────────────────


async def set_series(db: AsyncIOMotorDatabase, row: dict, raw: dict | None, value: str | None, actor, ctx, *,
                     source: str = "user", check: bool = True) -> dict:
    """The meeting's series on its row and its page (the folder's Series property). ``source``:
    "user" (a person: wins over detection from now on) or "auto"."""
    from app.services import meetings, page_db

    name = clean_name(value)
    if raw is not None and check:
        await access.require(actor, raw, "edit_content", ctx)
    folder = await db["folders"].find_one({"_id": meetings.oid(row.get("folder_id"))}) if row.get("folder_id") else None
    if name and folder is not None:
        folder = await ensure_option(db, folder, name, actor.user_id)
        name = option_name(folder, name) or name
    await db[COLL].update_one({"_id": row["_id"]}, {"$set": {
        "series": name, "series_from": source, "series_key": det.series_key(row.get("title")),
        "updated_at": meetings.now_utc()}})
    if raw is not None and folder is not None and any(p.get("key") == "series" for p in folder.get("properties") or []):
        untouched = int(raw.get("rev") or 1) == int(row.get("base_rev") or 0)
        try:
            after = await page_db.set_values(db, raw, {"series": option_name(folder, name) if name else None}, actor, ctx)
            if untouched and after is not None:
                await db[COLL].update_one({"_id": row["_id"]}, {"$set": {"base_rev": int(after.get("rev") or 1)}})
        except (HTTPException, page_db.PropsError) as exc:  # being edited, or the option couldn't be added
            log.info("meetings: series not written to %s (%s)", raw.get("slug"), getattr(exc, "detail", exc))
    return await db[COLL].find_one({"_id": row["_id"]})


# ── Reading ───────────────────────────────────────────────────────────────────


async def list_series(db: AsyncIOMotorDatabase, workspace_id: str, actor, ctx) -> list[dict]:
    """The series of the meetings the caller can open: [{name, count, last}] (most meetings first)."""
    from app.services import meetings

    counts: Counter = Counter()
    last: dict[str, str] = {}
    async for r in db[COLL].find({"workspace_id": workspace_id, "series": {"$nin": [None, ""]}},
                                 {"series": 1, "date": 1, "doc_id": 1}):
        if await meetings.readable(db, r, actor, ctx) is None:
            continue
        counts[r["series"]] += 1
        if (r.get("date") or "") > last.get(r["series"], ""):
            last[r["series"]] = r.get("date") or ""
    return [{"name": n, "count": c, "last": last.get(n) or None}
            for n, c in sorted(counts.items(), key=lambda x: (-x[1], x[0].casefold()))]


def oid(v: Any) -> ObjectId | None:
    return v if isinstance(v, ObjectId) else ObjectId(v) if isinstance(v, str) and ObjectId.is_valid(v) else None
