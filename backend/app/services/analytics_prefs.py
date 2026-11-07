"""What analytics an item collects: per-type switches at every level (owner decisions 2026-11-07).

Nine types, each on or off:

==========  ==============================================================================
counts      View counts and totals. Off: nothing is recorded for the item at all.
identity    Signed-in viewers' names and emails. Off: their views are stored as anonymous.
location    Country, region, city, timezone. Off: no location lookup at all.
device      Device, OS and browser with versions, screen, language, app context.
source      Referrer, campaign tags, where they came from.
activity    The activity timeline: sections read, scroll depth, link clicks, copies, prints,
            Ask questions and sign-offs (and the reading-depth numbers built from them).
video       Video and audio watch analytics: watched ranges, plays, seeks, speed, quality.
pages       PDF pages, slides and spreadsheet tabs.
downloads   Downloads and PDF exports.
==========  ==============================================================================

Where a value comes from, highest first (``resolve``):

1. **Workspace, enforced.** A workspace admin can enforce the workspace's settings: a type the
   workspace has *off* is off for every item in it, whatever the item says (it can't be loosened).
   An enforced *on* leaves the item free to turn it off.
2. **The item's own settings** (``documents.analytics_prefs``; absent or null: "use my defaults").
3. **Its folder**, then the folders above it (``folders.analytics_prefs``), for workspace items.
4. **The workspace's defaults** (``workspaces.analytics_prefs``).
5. **The owner's account defaults** (``users.analytics_prefs``).
6. On.

Each level stores only the types it sets (a partial map); a missing type falls through. The
backend decides at ingest (``effective``): the viewer's page also gets the switches with the
document (``track``) so it doesn't send what would be dropped, but nothing relies on that.

Resolved settings are cached in-process per item for :data:`CACHE_S` seconds; every write here
clears the cache.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

KEYS = ("counts", "identity", "location", "device", "source", "activity", "video", "pages", "downloads")
LABELS = {
    "counts": "View counts and totals", "identity": "Viewer identity", "location": "Location",
    "device": "Device and system", "source": "Source and referrer", "activity": "Activity timeline",
    "video": "Video watching", "pages": "PDF pages and slides", "downloads": "Downloads",
}
SHORT = {
    "counts": "counts", "identity": "identity", "location": "location", "device": "device", "source": "source",
    "activity": "activity", "video": "video", "pages": "pages", "downloads": "downloads",
}
CACHE_S = 30
MAX_FOLDER_HOPS = 12

_cache: dict[str, tuple[float, dict]] = {}


def clear_cache() -> None:
    _cache.clear()


def clean(raw) -> dict[str, bool]:
    """Only known types with real booleans."""
    if not isinstance(raw, dict):
        return {}
    return {k: v for k, v in raw.items() if k in KEYS and isinstance(v, bool)}


def _oid(v) -> ObjectId | None:
    try:
        return ObjectId(str(v))
    except Exception:
        return None


async def _folder_chain(db: AsyncIOMotorDatabase, workspace_id: str | None, folder_id: str | None) -> list[dict]:
    """The item's folder and the folders above it, nearest first: [{id, name, prefs}]."""
    out: list[dict] = []
    cursor, hops = folder_id, 0
    while cursor and workspace_id and hops <= MAX_FOLDER_HOPS:
        oid = _oid(cursor)
        if oid is None:
            break
        f = await db["folders"].find_one({"_id": oid, "workspace_id": workspace_id},
                                         {"parent_id": 1, "name": 1, "analytics_prefs": 1})
        if not f:
            break
        out.append({"id": str(f["_id"]), "name": f.get("name"), "prefs": clean(f.get("analytics_prefs"))})
        cursor = f.get("parent_id")
        hops += 1
    return out


async def layers(db: AsyncIOMotorDatabase, raw: dict) -> dict:
    """Every level's settings for an item (what ``resolve`` combines)."""
    owner = _oid(raw.get("owner_id")) if raw.get("owner_id") else None
    account = {}
    if owner:
        u = await db["users"].find_one({"_id": owner}, {"analytics_prefs": 1})
        account = clean((u or {}).get("analytics_prefs"))
    ws_id = raw.get("workspace_id")
    ws: dict = {"id": None, "prefs": {}, "enforce": False, "name": None}
    if ws_id and _oid(ws_id):
        w = await db["workspaces"].find_one({"_id": _oid(ws_id)}, {"analytics_prefs": 1, "analytics_enforce": 1, "name": 1})
        if w:
            ws = {"id": ws_id, "prefs": clean(w.get("analytics_prefs")), "enforce": bool(w.get("analytics_enforce")),
                  "name": w.get("name")}
    folders = await _folder_chain(db, ws["id"], raw.get("folder_id")) if ws["id"] else []
    item = raw.get("analytics_prefs")
    return {"account": account, "workspace": ws, "folders": folders,
            "item": clean(item) if isinstance(item, dict) else None}


def combine(lay: dict) -> dict:
    """{effective, source, enforced, custom} from the levels (see the module docstring)."""
    eff: dict[str, bool] = {}
    src: dict[str, str] = {}
    enforced: dict[str, bool] = {}
    ws = lay["workspace"]
    item = lay["item"] or {}
    for k in KEYS:
        if ws["enforce"] and ws["prefs"].get(k) is False:
            eff[k], src[k], enforced[k] = False, "workspace_enforced", True
            continue
        enforced[k] = False
        if k in item:
            eff[k], src[k] = item[k], "item"
            continue
        hit = next((f for f in lay["folders"] if k in f["prefs"]), None)
        if hit is not None:
            eff[k], src[k] = hit["prefs"][k], f"folder:{hit['id']}"
        elif k in ws["prefs"]:
            eff[k], src[k] = ws["prefs"][k], "workspace"
        elif k in lay["account"]:
            eff[k], src[k] = lay["account"][k], "account"
        else:
            eff[k], src[k] = True, "default"
    return {"effective": eff, "source": src, "enforced": enforced, "custom": lay["item"] is not None}


async def resolve(db: AsyncIOMotorDatabase, raw: dict) -> dict:
    return combine(await layers(db, raw))


async def effective(db: AsyncIOMotorDatabase, raw: dict) -> dict[str, bool]:
    """The switches that apply to this item now (cached ``CACHE_S`` seconds per item)."""
    key = str(raw.get("_id"))
    hit = _cache.get(key)
    now = time.monotonic()
    if hit and now - hit[0] < CACHE_S:
        return hit[1]
    eff = (await resolve(db, raw))["effective"]
    _cache[key] = (now, eff)
    if len(_cache) > 5000:
        for k in list(_cache)[:1000]:
            _cache.pop(k, None)
    return eff


def summary(eff: dict[str, bool]) -> str:
    """"Tracking everything", "Tracking: counts, location · identity off", "Not tracked"."""
    if not eff.get("counts", True):
        return "Not tracked"
    off = [SHORT[k] for k in KEYS if k != "counts" and not eff.get(k, True)]
    if not off:
        return "Tracking everything"
    on = [SHORT[k] for k in KEYS if eff.get(k, True)]
    return f"Tracking: {', '.join(on)} · {', '.join(off)} off"


def describe(resolved: dict, lay: dict) -> dict:
    """The API's view of an item's settings: each type's value, where it comes from (a readable
    label), whether it's locked by the workspace; plus the item's own overrides and the chip."""
    folder_names = {f["id"]: f.get("name") for f in lay["folders"]}

    def where(s: str) -> str:
        if s == "workspace_enforced":
            return f"Enforced by {lay['workspace'].get('name') or 'the workspace'}"
        if s == "item":
            return "This item"
        if s.startswith("folder:"):
            return f"Folder {folder_names.get(s[7:]) or ''}".strip()
        if s == "workspace":
            return f"{lay['workspace'].get('name') or 'Workspace'} default"
        if s == "account":
            return "Your defaults"
        return "Default"

    return {
        "types": [{"key": k, "label": LABELS[k], "on": resolved["effective"][k], "source": resolved["source"][k],
                   "from": where(resolved["source"][k]), "locked": resolved["enforced"][k]} for k in KEYS],
        "effective": resolved["effective"],
        "custom": resolved["custom"],
        "item": lay["item"],
        "summary": summary(resolved["effective"]),
    }


# ── Writes ────────────────────────────────────────────────────────────────────


async def set_account(db: AsyncIOMotorDatabase, user_id: str, prefs: dict) -> dict:
    p = {k: v for k, v in clean(prefs).items()}
    await db["users"].update_one({"_id": ObjectId(user_id)}, {"$set": {"analytics_prefs": p}})
    clear_cache()
    return p


async def get_account(db: AsyncIOMotorDatabase, user_id: str) -> dict[str, bool]:
    u = await db["users"].find_one({"_id": ObjectId(user_id)}, {"analytics_prefs": 1})
    saved = clean((u or {}).get("analytics_prefs"))
    return {k: saved.get(k, True) for k in KEYS}


async def set_item(db: AsyncIOMotorDatabase, doc_ids: list, prefs: dict | None) -> int:
    """An item's own settings; None goes back to "use my defaults"."""
    value = None if prefs is None else clean(prefs)
    res = await db["documents"].update_many({"_id": {"$in": doc_ids}}, {"$set": {"analytics_prefs": value}})
    clear_cache()
    return res.modified_count


async def set_folder(db: AsyncIOMotorDatabase, folder_id: str, prefs: dict | None) -> None:
    await db["folders"].update_one({"_id": ObjectId(folder_id)},
                                   {"$set": {"analytics_prefs": clean(prefs) if prefs else {}}})
    clear_cache()


async def set_workspace(db: AsyncIOMotorDatabase, workspace_id: str, prefs: dict | None,
                        enforce: bool | None) -> None:
    upd: dict = {}
    if prefs is not None:
        upd["analytics_prefs"] = clean(prefs)
    if enforce is not None:
        upd["analytics_enforce"] = bool(enforce)
    if upd:
        await db["workspaces"].update_one({"_id": ObjectId(workspace_id)}, {"$set": upd})
    clear_cache()


# ── Ingest filters ────────────────────────────────────────────────────────────

ACTIVITY_EVENTS = frozenset({"sec", "depth", "link", "copy", "find", "fs", "print"})
VIDEO_EVENTS = frozenset({"play", "pause", "seek", "end", "rate"})
PAGE_EVENTS = frozenset({"pg", "sl", "tab"})
DOWNLOAD_EVENTS = frozenset({"dl"})


def event_allowed(kind: str, eff: dict[str, bool]) -> bool:
    if kind in ACTIVITY_EVENTS or kind in ("ask", "signoff"):
        return eff.get("activity", True)
    if kind in VIDEO_EVENTS:
        return eff.get("video", True)
    if kind in PAGE_EVENTS:
        return eff.get("pages", True)
    if kind in DOWNLOAD_EVENTS:
        return eff.get("downloads", True)
    return True


def filter_beacon(msg: dict, eff: dict[str, bool]) -> dict:
    """The engagement beacon with what this item doesn't collect taken out (a copy)."""
    m = dict(msg)
    d = dict(m.get("d") or {})
    if not eff.get("activity", True):
        for f in ("depth", "reached", "sec", "copies", "links", "print"):
            d.pop(f, None)
    if not eff.get("video", True):
        d.pop("media", None)
    if not eff.get("pages", True):
        for f in ("pages", "npages", "pmax", "rv", "nsl", "smax", "ntab", "tabs"):
            d.pop(f, None)
    m["d"] = d
    pos = m.get("pos") or None
    if pos and (("h" in pos and not eff.get("activity", True)) or ("s" in pos and not eff.get("video", True))
                or ("p" in pos and not eff.get("pages", True))):
        m["pos"] = None
    first = m.get("first")
    if isinstance(first, dict):
        first = dict(first)
        if not eff.get("source", True):
            first.pop("ref", None)
            first.pop("utm", None)
        sysinfo = first.get("sys") if isinstance(first.get("sys"), dict) else None
        if sysinfo is not None:
            sysinfo = dict(sysinfo)
            if not eff.get("device", True):
                for f in ("vw", "vh", "sw", "sh", "dpr", "lang", "app", "emb", "touch", "pv"):
                    sysinfo.pop(f, None)
            if not eff.get("location", True):
                sysinfo.pop("tz", None)
            if not eff.get("source", True):
                sysinfo.pop("from", None)
                if not eff.get("device", True):
                    sysinfo.pop("emb", None)
            first["sys"] = sysinfo
        m["first"] = first
    if isinstance(m.get("ev"), list):
        m["ev"] = [e for e in m["ev"] if isinstance(e, dict) and event_allowed(str(e.get("k")), eff)]
    return m


def client_track(eff: dict[str, bool]) -> dict[str, bool]:
    """What the viewer's page is told (it skips what would be dropped)."""
    return dict(eff)


# ── Deleting what was collected ───────────────────────────────────────────────


async def delete_collected(db: AsyncIOMotorDatabase, doc_ids: list[str], types: list[str]) -> dict:
    """Remove already collected data of these types for these items. Returns counts per store."""
    from app.services import doc_views, engage

    types = [t for t in types if t in KEYS]
    if not doc_ids or not types:
        return {}
    q = {"doc_id": {"$in": doc_ids}}
    out: dict[str, int] = {}

    async def upd(coll: str, update: dict, extra: dict | None = None) -> None:
        r = await db[coll].update_many({**q, **(extra or {})}, update)
        out[coll] = out.get(coll, 0) + r.modified_count

    if "counts" in types:
        for coll, extra in ((doc_views.COLL, None), (engage.COLL, None), ("events", {"type": "view"}),
                            ("events", {"type": "read"})):
            r = await db[coll].delete_many({**q, **(extra or {})})
            out[coll] = out.get(coll, 0) + r.deleted_count
        oids = [ObjectId(i) for i in doc_ids if ObjectId.is_valid(i)]
        await db["documents"].update_many({"_id": {"$in": oids}}, {"$set": {"views": 0}})
        return out
    if "identity" in types:
        await upd(doc_views.COLL, {"$set": {"viewer_id": None}})
    if "location" in types:
        unset = {"country": "", "region": "", "city": ""}
        await upd(doc_views.COLL, {"$unset": {**unset, "sys.tz": ""}})
        await upd(engage.COLL, {"$set": {"country": None, "region": None, "city": None}})
        await upd("events", {"$set": {"country": None, "region": None, "city": None}})
    if "device" in types:
        await upd(doc_views.COLL, {"$unset": {"device": "", "os": "", "os_ver": "", "browser": "", "browser_ver": "",
                                              "inapp": "", "sys.vw": "", "sys.vh": "", "sys.sw": "", "sys.sh": "",
                                              "sys.dpr": "", "sys.lang": "", "sys.app": "", "sys.emb": "",
                                              "sys.touch": "", "sys.pv": ""}})
        await upd(engage.COLL, {"$set": {"device": None, "os": None, "browser": None}})
        await upd("events", {"$set": {"device": None, "os": None, "browser": None}})
    if "source" in types:
        blank = {"ref": None, "utm_source": None, "utm_medium": None, "utm_campaign": None, "channel": "Direct"}
        await upd(doc_views.COLL, {"$set": {**blank, "source": "Direct"}, "$unset": {"sys.from": ""}})
        await upd(engage.COLL, {"$set": blank})
        await upd("events", {"$set": {"referrer": None, "utm_source": None, "utm_medium": None,
                                      "utm_campaign": None, "channel": "Direct"}})
    pulls = set()
    if "activity" in types:
        pulls |= ACTIVITY_EVENTS | {"ask", "signoff"}
        await upd(doc_views.COLL, {"$unset": {"depth": "", "acts.link": "", "acts.copy": "", "acts.print": "",
                                              "acts.ask": "", "acts.signoff": "", "acts.fs": ""}})
        await upd(engage.COLL, {"$set": {"depth": 0, "reached": [], "sec": {}, "copies": {}, "links": {}, "prints": 0}})
        await db["events"].delete_many({**q, "type": "read"})
    if "video" in types:
        pulls |= VIDEO_EVENTS
        await upd(doc_views.COLL, {"$unset": {"segs": "", "dur": "", "m_plays": "", "m_ended": "", "mpos": ""}})
        await upd(engage.COLL, {"$set": {"media": None}})
    if "pages" in types:
        pulls |= PAGE_EVENTS
        await upd(doc_views.COLL, {"$unset": {"npages": "", "pmax": "", "nsl": "", "smax": "", "ntab": "", "tabs_seen": ""}})
        await upd(engage.COLL, {"$set": {"pages": {}, "rv": {}, "npages": None, "pmax": 0}})
    if "downloads" in types:
        pulls |= DOWNLOAD_EVENTS
        await upd(doc_views.COLL, {"$unset": {"acts.dl": ""}})
        r = await db["events"].delete_many({**q, "type": "export_pdf"})
        out["events"] = out.get("events", 0) + r.deleted_count
    if pulls:
        await upd(doc_views.COLL, {"$pull": {"tl": {"k": {"$in": sorted(pulls)}}}})
    return out


def now() -> datetime:
    return datetime.now(timezone.utc)
