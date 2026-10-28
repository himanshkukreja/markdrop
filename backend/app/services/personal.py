"""The caller's own cross-workspace lists (simpler workspaces UI):
Shared with me, Recent, and the ⌘K quick search.

Every row is re-decided at read time with ``access.can(read)`` (and listings
use ``access.readable_filter``), so revoking a grant, leaving a workspace, a
narrowed level or an expiry takes an item out of every list on the next
request. No list ever shows a redacted row, and nothing searches the content
of anything (titles and slugs of readable items only).

``recent_views {user_id, doc_id, viewed_at}`` — one row per (user, document),
upserted on each successful signed-in read (REST ``GET /documents/{slug}``,
which is what the page calls), the newest 100 per user kept, 90-day TTL.
"""

from __future__ import annotations

import base64
import json
import re
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import access, publicity, urls
from app.services import folder as folder_service
from app.services import workspace_items as items_service

RECENT = "recent_views"
RECENT_KEEP = 100
RECENT_TTL_S = 90 * 24 * 3600
RECENT_LIST = 30
NEW_WINDOW = timedelta(days=7)
MAX_SHARED_PAGE = 100
QUICK_MIN = 2
QUICK_MAX_LIMIT = 20
MAX_WORKSPACES = 100


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime | None) -> datetime | None:
    return publicity.aware(value)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[RECENT].create_index([("user_id", 1), ("doc_id", 1)], unique=True)
    await db[RECENT].create_index([("user_id", 1), ("viewed_at", -1)])
    await db[RECENT].create_index("viewed_at", expireAfterSeconds=RECENT_TTL_S)


# ── Row shaping (workspace-item shape, for documents from anywhere) ───────────


class _Shaper:
    """Builds workspace-item rows for documents from many workspaces. Folder
    names are workspace metadata: shown only to members of that workspace."""

    def __init__(self, db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx):
        self.db, self.actor, self.ctx = db, actor, ctx
        self.hosts = urls.HostCache(db)
        self._folders: dict[str, dict] = {}
        self._names: dict[str, str | None] = {}

    async def folders_for(self, ws_id: str | None) -> dict:
        if not ws_id:
            return {}
        if ws_id not in self._folders:
            if await self.ctx.role(ws_id, self.actor.user_id) is None:
                self._folders[ws_id] = {}
            else:
                self._folders[ws_id] = items_service.folder_index(
                    await folder_service.list_folders(self.db, ws_id))
        return self._folders[ws_id]

    async def names(self, rows: list[dict]) -> None:
        missing = [r.get("owner_id") for r in rows if r.get("owner_id") not in self._names]
        self._names.update(await items_service.owner_names(self.db, missing))

    async def item(self, raw: dict) -> dict:
        out = await items_service.item_for(
            self.db, raw, self.actor, self.ctx, names=self._names,
            folders=await self.folders_for(raw.get("workspace_id")), hosts=self.hosts)
        f = await access.facts(self.actor, raw, self.ctx)
        ws = f.ws
        out["role"] = f.role
        out["workspace"] = {"id": f.ws_id, "name": ws.name} if (ws is not None and f.ws_id) else None
        return out


async def _readable(actor: access.Actor, raw: dict | None, ctx: access.Ctx) -> bool:
    return raw is not None and (await access.can(actor, raw, "read", ctx)).allowed


async def _docs_by_id(db: AsyncIOMotorDatabase, ids: list) -> dict[str, dict]:
    oids = []
    for i in ids:
        try:
            oids.append(i if isinstance(i, ObjectId) else ObjectId(i))
        except Exception:
            continue
    if not oids:
        return {}
    rows = await db["documents"].find({"_id": {"$in": oids}}).to_list(length=len(oids))
    return {str(r["_id"]): r for r in rows}


# ── Recent ────────────────────────────────────────────────────────────────────


async def record_view(db: AsyncIOMotorDatabase, user_id: str | None, doc_id) -> None:
    """Called after a successful signed-in read. Never fails the read."""
    if not user_id or doc_id is None:
        return
    try:
        now = _now()
        await db[RECENT].update_one({"user_id": user_id, "doc_id": str(doc_id)},
                                    {"$set": {"viewed_at": now}}, upsert=True)
        old = await db[RECENT].find({"user_id": user_id}, {"_id": 1}).sort(
            "viewed_at", -1).skip(RECENT_KEEP).limit(200).to_list(length=200)
        if old:
            await db[RECENT].delete_many({"_id": {"$in": [o["_id"] for o in old]}})
    except Exception:
        pass


async def recent(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx,
                 limit: int = RECENT_LIST) -> dict:
    rows = await db[RECENT].find({"user_id": actor.user_id}).sort("viewed_at", -1).limit(
        RECENT_KEEP).to_list(length=RECENT_KEEP)
    docs = await _docs_by_id(db, [r["doc_id"] for r in rows])
    shaper = _Shaper(db, actor, ctx)
    keep = []
    for r in rows:
        raw = docs.get(r["doc_id"])
        # Re-decided now: a revoked grant, a narrowed level, an expiry or a
        # password (asked again each time) all take it off the list.
        if await _readable(actor, raw, ctx):
            keep.append((r, raw))
        if len(keep) >= limit:
            break
    await shaper.names([raw for _r, raw in keep])
    items = []
    for r, raw in keep:
        item = await shaper.item(raw)
        item["viewed_at"] = r.get("viewed_at")
        items.append(item)
    return {"items": items}


# ── Shared with me ────────────────────────────────────────────────────────────


def _encode(created_at: datetime, gid: ObjectId) -> str:
    c = _aware(created_at) or _now()
    return base64.urlsafe_b64encode(json.dumps({"c": c.isoformat(), "i": str(gid)}).encode()).decode().rstrip("=")


def _decode(cursor: str | None) -> dict | None:
    if not cursor:
        return None
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        c = datetime.fromisoformat(data["c"]).astimezone(timezone.utc).replace(tzinfo=None)
        i = ObjectId(data["i"])
    except Exception:
        raise HTTPException(status_code=422, detail="That cursor isn't valid; start again without one.")
    return {"$or": [{"created_at": {"$lt": c}}, {"created_at": c, "_id": {"$lt": i}}]}


async def _opened_after(db: AsyncIOMotorDatabase, user_id: str, pairs: list[tuple[str, datetime]]) -> set[str]:
    if not pairs:
        return set()
    views = await db[RECENT].find({"user_id": user_id, "doc_id": {"$in": [d for d, _ in pairs]}},
                                  {"doc_id": 1, "viewed_at": 1}).to_list(length=len(pairs))
    seen = {v["doc_id"]: _aware(v.get("viewed_at")) for v in views}
    out = set()
    for doc_id, granted in pairs:
        v = seen.get(doc_id)
        if v is not None and (granted is None or v >= (_aware(granted) or v)):
            out.add(doc_id)
    return out


async def _shared_ok(actor: access.Actor, raw: dict | None, effective: dict[str, str],
                     ctx: access.Ctx) -> bool:
    """A grant row counts when its chain still gives something (GrantGraph),
    the caller doesn't own the document, and the caller can read it now."""
    if raw is None or str(raw["_id"]) not in effective:
        return False
    if raw.get("owner_id") and raw.get("owner_id") == actor.user_id:
        return False
    return await _readable(actor, raw, ctx)


async def shared(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx,
                 cursor: str | None = None, limit: int = 30) -> dict:
    limit = max(1, min(MAX_SHARED_PAGE, int(limit or 30)))
    email = actor.email
    effective = await ctx.grants_for(email)
    base = {"email": email}
    filt = {"$and": [base, c]} if (c := _decode(cursor)) else base
    shaper = _Shaper(db, actor, ctx)
    picked: list[tuple[dict, dict]] = []
    last_seen = None
    more = False
    batch = max(limit * 2, 20)
    scan = db["document_grants"].find(filt).sort([("created_at", -1), ("_id", -1)])
    rows = await scan.to_list(length=5000)
    i = 0
    while i < len(rows) and len(picked) <= limit:
        chunk = rows[i:i + batch]
        i += batch
        docs = await _docs_by_id(db, [g["document_id"] for g in chunk])
        for g in chunk:
            raw = docs.get(g["document_id"])
            if await _shared_ok(actor, raw, effective, ctx):
                if len(picked) == limit:
                    more = True
                    break
                picked.append((g, raw))
                last_seen = g
        if more:
            break
    opened = await _opened_after(db, actor.user_id,
                                 [(str(raw["_id"]), g.get("created_at")) for g, raw in picked])
    await shaper.names([raw for _g, raw in picked])
    now = _now()
    items = []
    for g, raw in picked:
        item = await shaper.item(raw)
        granted = _aware(g.get("created_at"))
        item["granted_at"] = g.get("created_at")
        item["opened"] = str(raw["_id"]) in opened
        item["new"] = bool(granted and granted > now - NEW_WINDOW and not item["opened"])
        items.append(item)
    return {
        "items": items,
        "next_cursor": _encode(last_seen["created_at"], last_seen["_id"]) if (more and last_seen) else None,
        "new_count": await new_count(db, actor, ctx),
    }


async def new_count(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx) -> int:
    """Granted in the last 7 days, still readable, not yet opened."""
    since = (_now() - NEW_WINDOW).replace(tzinfo=None)
    rows = await db["document_grants"].find(
        {"email": actor.email, "created_at": {"$gt": since}}).to_list(length=1000)
    if not rows:
        return 0
    effective = await ctx.grants_for(actor.email)
    docs = await _docs_by_id(db, [g["document_id"] for g in rows])
    live = [(g, docs.get(g["document_id"])) for g in rows]
    live = [(g, raw) for g, raw in live if await _shared_ok(actor, raw, effective, ctx)]
    opened = await _opened_after(db, actor.user_id, [(str(raw["_id"]), g.get("created_at")) for g, raw in live])
    return sum(1 for _g, raw in live if str(raw["_id"]) not in opened)


# ── Quick search (⌘K) ─────────────────────────────────────────────────────────


def _rx(q: str) -> dict:
    return {"$regex": re.escape(q), "$options": "i"}


def _rank(title: str | None, slug: str, q: str) -> tuple:
    t = (title or "").lower()
    ql = q.lower()
    return (0 if t.startswith(ql) else 1 if ql in t else 2 if slug.lower().startswith(ql) else 3,)


async def quick(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, q: str,
                limit: int = 8) -> dict:
    # NUL is dropped: Mongo refuses it inside a regex (a 500), and no title has one.
    q = (q or "").replace("\x00", "").strip()[:100]
    limit = max(1, min(QUICK_MAX_LIMIT, int(limit or 8)))
    empty = {"files": [], "folders": [], "workspaces": []}
    if len(q) < QUICK_MIN:
        return empty
    uid = actor.user_id
    now = ctx.now
    # Titles and slugs only — never content — and never an encrypted title
    # (ciphertext would match at random).
    text = {"$or": [{"title": _rx(q)}, {"slug": _rx(q)}, {"original_filename": _rx(q)}],
            "encrypted": {"$ne": True}}
    alive = access.not_expired_clause(now)
    found: dict[str, dict] = {}

    def take(rows: list[dict]) -> None:
        for r in rows:
            found.setdefault(str(r["_id"]), r)

    cap = limit * 4
    # 1. Own documents (filed anywhere or not).
    take(await db["documents"].find({"$and": [{"owner_id": uid}, alive, text]}).sort(
        "updated_at", -1).limit(cap).to_list(length=cap))
    # 2. Workspaces the caller is in: readable rows only (never redacted).
    from app.services import workspace as ws_service

    memberships = (await ws_service.list_for_user(db, uid))[:MAX_WORKSPACES]
    for ws, _role in memberships:
        rf = await access.readable_filter(actor, ws.id, ctx)
        take(await db["documents"].find(rf.query(text)).sort("updated_at", -1).limit(cap).to_list(length=cap))
    # 3. Shared with me (grants whose chain still holds).
    granted = await access.granted_ids(actor, ctx)
    if granted:
        take(await db["documents"].find({"$and": [{"_id": {"$in": granted}}, alive, text]}).sort(
            "updated_at", -1).limit(cap).to_list(length=cap))

    readable = [r for r in found.values() if await _readable(actor, r, ctx)]
    readable.sort(key=lambda r: (_rank(items_service.display_title(r), r["slug"], q),
                                 -(_aware(r.get("updated_at")) or now).timestamp()))
    readable = readable[:limit]
    shaper = _Shaper(db, actor, ctx)
    await shaper.names(readable)
    files = [await shaper.item(r) for r in readable]

    ql = q.lower()
    folders_out: list[dict] = []
    for ws, _role in memberships:
        if len(folders_out) >= limit:
            break
        flist = await folder_service.list_folders(db, ws.id)
        paths = folder_service.paths_by_id(flist)
        for f in flist:
            if ql in f.name.lower() or ql in f.slug.lower():
                folders_out.append({"id": f.id, "name": f.name, "path": "/".join(paths.get(f.id) or []),
                                    "workspace": {"id": ws.id, "name": ws.name}})
    folders_out.sort(key=lambda f: (0 if f["name"].lower().startswith(ql) else 1, f["name"].lower()))
    workspaces_out = [{"id": ws.id, "name": ws.name, "role": role}
                      for ws, role in memberships if ql in (ws.name or "").lower()]
    workspaces_out.sort(key=lambda w: (0 if w["name"].lower().startswith(ql) else 1, w["name"].lower()))
    return {"files": files, "folders": folders_out[:limit], "workspaces": workspaces_out[:limit]}
