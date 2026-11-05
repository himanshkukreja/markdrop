"""How meetings are organised: a **Series** for recurring calls, a **subfolder** per series, and the
Meetings folder's views.

* **Folders** (owner, 2026-11-05): every meeting page lives in a subfolder of the workspace's
  Meetings folder — ``Meetings/<Series>`` for a recurring call ("Meetings/Daily Sync Up"), else
  ``Meetings/Other meetings``. :func:`place_meeting` is THE placement function: every import path
  (the website, Import past meetings, the Google Meet inbox, MCP) and every series change goes
  through it. Subfolders are made on demand (found again by their ``meetings_series`` key, so a
  person may rename the folder), with the Meetings folder's properties and views, and open on
  "All meetings" (newest first, by month). :func:`organize` places the meetings that are already
  there (workspace admins: "Organize meetings").
* **Who sees a meeting** (owner): 1:1s and two-person calls start restricted to their attendees,
  three or more people are visible to the team (:func:`auto_restricted`); changeable per meeting.

* Every meeting row has ``series`` (a name or None) and ``series_from`` ("auto": detected, "user":
  set or cleared by a person, who always wins). Detection (:func:`detect`): meetings whose names
  differ only by numbers and dates share a key (meeting_backfill_detect.series_key); when the
  workspace already names that series, a new meeting joins it; when a name has been seen on **two
  or more different days**, it is a series and the earlier one-offs join it (:func:`adopt`: their
  series is set and they move into its folder). Two calls of one name on one day aren't a series.
* The **Meetings folder** gets a Series property (once, ``folders.meetings_views``) and opens on its
  folders. Each subfolder gets the Meetings folder's properties (a Series option per series, added
  as series appear) and saved views: "All meetings" (table, Date newest first, grouped by month),
  plus "By series" (board) and "Series table" in Other meetings. A subfolder opens on "All meetings"
  (frontend FolderView); a person's own changes to the views are never redone.
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
    """The Series property on the Meetings folder (once; idempotent). Its meetings live in its
    subfolders (:func:`place_meeting`), which get the properties and the meetings views; the Meetings
    folder itself opens on those folders."""
    from app.services import page_db

    if folder is None or folder.get("meetings_views"):
        return folder
    schema = list(folder.get("properties") or [])
    if not any(p.get("key") == "series" for p in schema) and \
            not any((p.get("name") or "").casefold() == "series" for p in schema) and len(schema) < page_db.MAX_PROPERTIES:
        at = next((i + 1 for i, p in enumerate(schema) if p.get("key") == "type"), len(schema))
        schema = [*schema[:at], dict(SERIES_PROP), *schema[at:]]
        try:
            await page_db.set_schema(db, folder["workspace_id"], str(folder["_id"]), user_id, schema)
        except HTTPException as exc:
            log.info("meetings: Series property not added (%s)", exc.detail)
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
                                 {"title": 1, "series": 1, "series_key": 1, "series_from": 1, "date": 1}):
        k = key_of(r)
        if not k:
            continue
        e = out.setdefault(k, {"series": Counter(), "rows": 0, "loose": [], "dates": set()})
        e["rows"] += 1
        if r.get("date"):
            e["dates"].add(r["date"])
        if r.get("series"):
            e["series"][r["series"]] += 1
        elif r.get("series_from") != "user":
            e["loose"].append(r["_id"])
    return out


def decide(key: str, label: str | None, entry: dict | None, *, dates: set[str] | frozenset = frozenset()) -> str | None:
    """The series of a new meeting with series key ``key``: the series its namesakes already have;
    else, when that name has been seen on two or more different days (the workspace's meetings, and
    ``dates``: this one's and the others' in the same import), the name without its numbers."""
    if not key:
        return None
    if entry and entry["series"]:
        return entry["series"].most_common(1)[0][0]
    seen = set(entry.get("dates") or ()) if entry else set()
    if len(seen | {d for d in dates if d}) >= 2:
        return label
    return None


async def detect(db: AsyncIOMotorDatabase, workspace_id: str, title: str | None, *,
                 date_: str | None = None) -> tuple[str | None, str]:
    """(series or None, key) for a new meeting called ``title`` on ``date_``."""
    key = det.series_key(title)
    if not key:
        return None, ""
    entry = (await known(db, workspace_id)).get(key)
    return decide(key, det.series_label(title), entry, dates={date_} if date_ else frozenset()), key


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
            # set_series also moves it into the series' folder (place_meeting).
            if quiet:
                with notifications.quiet():
                    await set_series(db, r, raw, series, actor, ctx, source="auto", check=False)
            else:
                await set_series(db, r, raw, series, actor, ctx, source="auto", check=False)
            n += 1
        except HTTPException as exc:
            log.info("meetings: series not set on %s (%s)", r["_id"], exc.detail)
    return n


# ── Changing it ───────────────────────────────────────────────────────────────


async def set_series(db: AsyncIOMotorDatabase, row: dict, raw: dict | None, value: str | None, actor, ctx, *,
                     source: str = "user", check: bool = True) -> dict:
    """The meeting's series on its row and its page (the folder's Series property), and the page in
    that series' folder (:func:`place_meeting`). ``source``: "user" (a person: wins over detection
    from now on) or "auto"."""
    from app.services import meetings, page_db

    name = clean_name(value)
    if raw is not None and check:
        await access.require(actor, raw, "edit_content", ctx)
    await db[COLL].update_one({"_id": row["_id"]}, {"$set": {
        "series": name, "series_from": source, "series_key": det.series_key(row.get("title")),
        "updated_at": meetings.now_utc()}})
    row = await db[COLL].find_one({"_id": row["_id"]}) or row
    try:
        await place_meeting(db, row["workspace_id"], row)
    except HTTPException as exc:
        log.info("meetings: %s not moved to its series' folder (%s)", row["_id"], exc.detail)
    row = await db[COLL].find_one({"_id": row["_id"]}) or row
    raw = await db["documents"].find_one({"_id": row.get("doc_id")}) if row.get("doc_id") else None
    folder = await db["folders"].find_one({"_id": meetings.oid(row.get("folder_id"))}) if row.get("folder_id") else None
    if raw is not None and folder is not None and any(p.get("key") == "series" for p in folder.get("properties") or []):
        untouched = int(raw.get("rev") or 1) == int(row.get("base_rev") or 0)
        try:
            after = await page_db.set_values(db, raw, {"series": option_name(folder, name) if name else None}, actor, ctx)
            if untouched and after is not None:
                await db[COLL].update_one({"_id": row["_id"]}, {"$set": {"base_rev": int(after.get("rev") or 1)}})
        except (HTTPException, page_db.PropsError) as exc:  # being edited, or the option couldn't be added
            log.info("meetings: series not written to %s (%s)", raw.get("slug"), getattr(exc, "detail", exc))
    return await db[COLL].find_one({"_id": row["_id"]})


# ── Folders: Meetings/<Series>, Meetings/Other meetings ──────────────────────

OTHER = "Other meetings"


def auto_restricted(attendees: list | None) -> bool:
    """A 1:1 or a two-person call starts restricted to its attendees; 3+ people: the team (owner)."""
    n = len(attendees or [])
    return 1 <= n <= 2


async def _copy_setup(db: AsyncIOMotorDatabase, root: dict, sub: dict, user_id: str | None) -> dict:
    """The Meetings folder's properties and views on a new subfolder (so its table, board and
    month groups work), once."""
    from app.services import page_db

    if sub.get("meetings_views"):
        return sub
    keys = {p.get("key") for p in root.get("properties") or []}
    views = [{**v, "hidden": [k for k in v["hidden"] if k in keys]} for v in VIEWS if v["group"] in keys]
    if sub.get("meetings_series"):
        views = [v for v in views if v.get("group") != "series"] or views   # one series: no "by series" views
    try:
        await page_db.set_schema(db, sub["workspace_id"], str(sub["_id"]), user_id, root.get("properties") or [],
                                 views=views)
    except HTTPException as exc:
        log.info("meetings: subfolder setup skipped (%s)", exc.detail)
    await db["folders"].update_one({"_id": sub["_id"]}, {"$set": {"meetings_views": True}})
    return await db["folders"].find_one({"_id": sub["_id"]}) or sub


async def target_folder(db: AsyncIOMotorDatabase, root: dict, series: str | None, user_id: str | None) -> dict:
    """``Meetings/<series>`` (or ``Meetings/Other meetings``), made on demand. Found by its key
    first (so a renamed folder is still that series' folder), then by name among the Meetings
    folder's subfolders (a folder a person made is used, not doubled)."""
    from app.services import folder as folder_service

    ws, parent = root["workspace_id"], str(root["_id"])
    key = {"meetings_series": series.casefold()} if series else {"meetings_other": True}
    q = {"workspace_id": ws, "parent_id": parent, "meetings_sub": True, **key}
    f = await db["folders"].find_one(q, sort=[("created_at", 1), ("_id", 1)])
    if f is None:
        name = (series or OTHER)[:SERIES_MAX]
        async for c in db["folders"].find({"workspace_id": ws, "parent_id": parent, "meetings_sub": {"$ne": True}}):
            if (c.get("name") or "").casefold() == name.casefold():
                f = c
                break
        if f is None:
            made = await folder_service.create_folder(db, ws, name, parent)
            f = await db["folders"].find_one({"_id": ObjectId(made.id)})
        await db["folders"].update_one({"_id": f["_id"]}, {"$set": {"meetings_sub": True, **key}})
        first = await db["folders"].find_one(q, sort=[("created_at", 1), ("_id", 1)])
        if first is not None and first["_id"] != f["_id"]:
            # Another import made it at the same moment: keep the first (ours is empty).
            if not await db["documents"].count_documents({"folder_id": str(f["_id"])}):
                await db["folders"].delete_one({"_id": f["_id"]})
            f = first
        f = await db["folders"].find_one({"_id": f["_id"]}) or f
    return await _copy_setup(db, root, f, user_id)


async def place_meeting(db: AsyncIOMotorDatabase, workspace_id: str, meeting: dict) -> str:
    """THE placement of a meeting: its page into ``Meetings/<its series>`` or ``Meetings/Other
    meetings`` (made on demand), the row's ``folder_id`` updated, the series an option of that
    folder's Series property. Acts as the meeting's importer. Returns the folder's id."""
    from app.services import folder as folder_service
    from app.services import meetings

    root = await meetings.ensure_folder(db, workspace_id, meeting.get("created_by"))
    series = meeting.get("series") or None
    target = await target_folder(db, root, series, meeting.get("created_by"))
    if series:
        target = await ensure_option(db, target, series, meeting.get("created_by")) or target
    fid = str(target["_id"])
    raw = await db["documents"].find_one({"_id": meetings.oid(meeting.get("doc_id"))}) if meeting.get("doc_id") else None
    if raw is not None and (raw.get("folder_id") or None) != fid and raw.get("parent_id") is None \
            and raw.get("workspace_id") == workspace_id and not raw.get("deleted_at"):
        await folder_service.file_document(db, raw, workspace_id, fid)
    if meeting.get("folder_id") != fid:
        await db[COLL].update_one({"_id": meeting["_id"]}, {"$set": {"folder_id": fid}})
    return fid


async def organize(db: AsyncIOMotorDatabase, workspace_id: str, user) -> dict:
    """"Organize meetings" (workspace admins): the meetings already here get their series (a name
    seen on two or more days, unless a person set it) and move into their folders. Returns counts."""
    from app.services import meetings, notifications

    if not await meetings.is_ws_admin(db, workspace_id, user.id):
        raise HTTPException(status_code=403, detail="Only workspace admins can organize the meetings.")
    root = await meetings.ensure_folder(db, workspace_id, user.id)
    root = await organise_folder(db, root, user.id)
    rows = await db[COLL].find({"workspace_id": workspace_id}, {"segments": 0}).sort("date", 1).to_list(length=5000)
    by_key: dict[str, list[dict]] = {}
    for r in rows:
        by_key.setdefault(key_of(r), []).append(r)
    actor, ctx = access.Actor.of(user), access.Ctx(db)
    named = moved = 0
    folders: set[str] = set()
    for key, rs in by_key.items():
        have = Counter(r["series"] for r in rs if r.get("series"))
        name = have.most_common(1)[0][0] if have else (
            det.pick_label(det.series_label(r.get("title")) for r in rs) if key and len({r.get("date") for r in rs if r.get("date")}) >= 2 else None)
        for r in rs:
            before = r.get("folder_id")
            if name and not r.get("series") and r.get("series_from") != "user":
                raw = await db["documents"].find_one({"_id": r.get("doc_id")}) if r.get("doc_id") else None
                with notifications.quiet():
                    await set_series(db, r, raw, name, actor, ctx, source="auto", check=False)
                named += 1
                r = await db[COLL].find_one({"_id": r["_id"]}) or r
            try:
                fid = await place_meeting(db, workspace_id, r)
            except HTTPException as exc:
                log.info("meetings: %s not organized (%s)", r["_id"], exc.detail)
                continue
            folders.add(fid)
            moved += int(before != fid)
    return {"meetings": len(rows), "moved": moved, "series_set": named, "folders": len(folders)}


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
