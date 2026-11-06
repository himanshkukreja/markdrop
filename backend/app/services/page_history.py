"""Version history for pages, and the clean-up of page images nothing uses.

``document_versions`` holds whole snapshots of a page (plain Markdown; the
front matter carries its icon and cover)::

    {doc_id, slug, n, ts, started_at, author_id, author_kind, author_name,
     client, title, icon, markdown, bytes, sha, assets, sealed, restored_from, reason}

``author_kind``: ``user`` (someone's saves in the editor), ``mcp`` (an AI app;
``client`` names it), ``restore`` (a restore, ``restored_from`` = the version
it brought back), ``system`` (a state written some other way — a template,
a VS Code push — captured the first time history needs it) or ``signoff``
(a sign-off given, changed, cleared or removed: services/signoffs.py; the
page as it was then, ``event.text`` says what happened).

When versions are made
* **Saves** (``on_save``, from ``document.update_document``): one version per
  editing session per 10 minutes. A save by the same person within 10 minutes
  of their open version's start updates that version in place; otherwise a new
  one starts. So each version is the page at the end of a 10-minute stretch.
* **Before any write** the state being replaced is in history (``capture``):
  anything written outside these hooks gets a ``system`` version first.
* **Lock release / leaving** (``on_release``): the session's version is sealed
  (the next save starts a new one) and the current state is captured.
* **MCP writes** (update_page, replace_section, append_blocks, insert_embed,
  set_page_properties, update_document): the state before is captured, the
  state after is its own sealed ``mcp`` version (never merged).
* **Restore** (``restore``): the current state is captured, the old version is
  written as a new ``restore`` version — so a restore is itself undoable.

Retention (``thin``, daily): every version for 30 days, then the last one of
each day up to a year; at most 500 per page (also enforced on insert). The
page's own row is always the newest state, so nothing is lost by thinning.

Who: people who can edit the page (``can(edit_content)``), signed in. Readers
never. End-to-end encrypted documents have no history (the server can't read
them) and files have their own versions (services/file_versions.py).

Page images (§4, ``cleanup_images``, daily): an image is referenced while the
page's Markdown or any retained version names it (``asset:<id>``). One that
isn't gets ``unreferenced_since``; referenced again, it is cleared; 30 days
after it was set, the R2 object and the row go. Rows whose page no longer
exists go the same way. ``dry_run`` counts and writes nothing; logs carry
counts only, never content or keys.
"""

from __future__ import annotations

import contextvars
import hashlib
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import DESCENDING
from pymongo.errors import DuplicateKeyError

log = logging.getLogger(__name__)

COLL = "document_versions"
RUNS = "job_runs"
COALESCE = timedelta(minutes=10)
KEEP_ALL = timedelta(days=30)
KEEP_DAILY = timedelta(days=365)
MAX_VERSIONS = 500
PAGE_SIZE = 50
UNREFERENCED_GRACE = timedelta(days=30)
RUN_EVERY = timedelta(hours=23)
# The MCP client making the current tool call (set by app/mcp/protocol.py), so an
# AI app's write is labelled with its name.
MCP_CLIENT: contextvars.ContextVar[str | None] = contextvars.ContextVar("mcp_client", default=None)
_LIST_FIELDS = {"markdown": 0}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def iso(dt: datetime | None) -> str | None:
    dt = _aware(dt)
    return dt.isoformat().replace("+00:00", "Z") if dt else None


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index([("doc_id", 1), ("n", -1)], unique=True)
    await db[COLL].create_index([("doc_id", 1), ("ts", -1)])
    await db[COLL].create_index("ts")
    await db["page_assets"].create_index("unreferenced_since", sparse=True)


# ── What has history ──────────────────────────────────────────────────────────


def has_history(raw: dict | None) -> bool:
    """Markdown, not encrypted: what history can hold."""
    return bool(raw) and raw.get("kind", "markdown") != "artifact" and not raw.get("encrypted")


def records(raw: dict | None) -> bool:
    """Saves are snapshotted for pages (documents in the block editor)."""
    return has_history(raw) and raw.get("editor") == "blocks"


def _sha(title: str | None, markdown: str | None) -> str:
    h = hashlib.sha256()
    h.update((title or "").encode("utf-8"))
    h.update(b"\x00")
    h.update((markdown or "").encode("utf-8"))
    return h.hexdigest()


def _state(raw: dict) -> dict:
    from app.services import page_props, pages

    md = raw.get("content") or ""
    icon = page_props.parse(md).get("icon")
    return {"title": raw.get("title"), "markdown": md, "bytes": len(md.encode("utf-8")),
            "sha": _sha(raw.get("title"), md), "assets": pages.asset_ids(md),
            "icon": icon if isinstance(icon, str) else None}


async def latest(db: AsyncIOMotorDatabase, doc_id: str, projection: dict | None = None) -> dict | None:
    return await db[COLL].find_one({"doc_id": doc_id}, projection or _LIST_FIELDS, sort=[("n", DESCENDING)])


async def _client_name(db: AsyncIOMotorDatabase, client_id: str | None) -> str:
    if not client_id:
        return "AI app"
    if client_id.startswith("https://"):
        from urllib.parse import urlsplit

        return (urlsplit(client_id).hostname or "AI app")[:80]
    try:
        row = await db["oauth_clients"].find_one({"_id": client_id}, {"client_name": 1})
    except Exception:  # pragma: no cover
        row = None
    return ((row or {}).get("client_name") or "AI app")[:80]


def _author_name(actor) -> str | None:
    from app.services import viewers

    user = getattr(actor, "user", None)
    return viewers.display_name(user) if user is not None else None


async def _insert(db: AsyncIOMotorDatabase, raw: dict, *, kind: str, author_id: str | None,
                  author_name: str | None, client: str | None = None, sealed: bool = True,
                  restored_from: int | None = None, reason: str, ts: datetime | None = None,
                  event: dict | None = None) -> dict:
    doc_id = str(raw["_id"])
    at = ts or now_utc()
    row: dict[str, Any] = {
        "doc_id": doc_id, "slug": raw.get("slug"), "ts": at, "started_at": now_utc(),
        "author_id": author_id, "author_kind": kind, "author_name": author_name, "client": client,
        "sealed": sealed, "restored_from": restored_from, "reason": reason, **_state(raw),
    }
    if event:
        row["event"] = event
    for _ in range(8):
        top = await latest(db, doc_id, {"n": 1})
        row["n"] = int((top or {}).get("n") or 0) + 1
        row.pop("_id", None)
        try:
            await db[COLL].insert_one(row)
            break
        except DuplicateKeyError:
            continue
    else:  # pragma: no cover - eight concurrent writers
        raise RuntimeError("couldn't number a version")
    await _cap(db, doc_id)
    return row


async def _cap(db: AsyncIOMotorDatabase, doc_id: str) -> int:
    """Keep at most MAX_VERSIONS for a page (the oldest go)."""
    extra = await db[COLL].count_documents({"doc_id": doc_id}) - MAX_VERSIONS
    if extra <= 0:
        return 0
    old = await db[COLL].find({"doc_id": doc_id}, {"_id": 1}).sort("n", 1).limit(extra).to_list(length=extra)
    res = await db[COLL].delete_many({"_id": {"$in": [r["_id"] for r in old]}})
    return res.deleted_count


async def capture(db: AsyncIOMotorDatabase, raw: dict, *, reason: str, seal: bool = True) -> dict | None:
    """Make sure the page as ``raw`` holds it is in history (a ``system``
    version when the newest one differs). Seals the newest version."""
    if not has_history(raw):
        return None
    doc_id = str(raw["_id"])
    top = await latest(db, doc_id)
    sha = _sha(raw.get("title"), raw.get("content") or "")
    if top is not None and top.get("sha") == sha:
        if seal and not top.get("sealed"):
            await db[COLL].update_one({"_id": top["_id"]}, {"$set": {"sealed": True}})
            top["sealed"] = True
        return top
    return await _insert(db, raw, kind="system", author_id=None, author_name=None, reason=reason,
                         ts=_aware(raw.get("updated_at")) or now_utc())


async def on_save(db: AsyncIOMotorDatabase, before: dict, after: dict, actor, *,
                  kind: str | None = None, restored_from: int | None = None) -> None:
    """After a write of ``after`` over ``before``. Never fails the write."""
    try:
        await _on_save(db, before, after, actor, kind=kind, restored_from=restored_from)
    except Exception:
        log.warning("version history: snapshot failed", exc_info=True)


async def _on_save(db: AsyncIOMotorDatabase, before: dict, after: dict, actor, *,
                   kind: str | None, restored_from: int | None) -> None:
    if not records(after) and kind != "restore":
        return
    if not has_history(after):
        return
    via_mcp = getattr(actor, "cred", None) == "mcp"
    kind = kind or ("mcp" if via_mcp else "user")
    author_id = getattr(actor, "user_id", None)
    # What this write replaced is in history (a write that bypassed the hooks).
    await capture(db, before, reason="before_mcp" if kind == "mcp" else "before_save", seal=kind != "user")
    new_sha = _sha(after.get("title"), after.get("content") or "")
    top = await latest(db, str(after["_id"]))
    if top is not None and top.get("sha") == new_sha and kind == "user":
        return  # nothing changed (a save of the same text)
    if kind == "user" and top is not None and not top.get("sealed") \
            and top.get("author_kind") == "user" and top.get("author_id") == author_id \
            and (_aware(top.get("started_at")) or now_utc()) > now_utc() - COALESCE:
        await db[COLL].update_one({"_id": top["_id"]}, {"$set": {**_state(after), "ts": now_utc()}})
        return
    client = await _client_name(db, MCP_CLIENT.get()) if kind == "mcp" else None
    await _insert(db, after, kind=kind, author_id=author_id, author_name=_author_name(actor), client=client,
                  sealed=kind != "user", restored_from=restored_from, reason=kind)


async def on_release(db: AsyncIOMotorDatabase, raw: dict, actor) -> None:
    """The editor let go of the page (left, closed, idle): the session's
    version is sealed and the current state is in history."""
    if not records(raw):
        return
    try:
        fresh = await db["documents"].find_one({"_id": raw["_id"]})
        if fresh is None:
            return
        top = await latest(db, str(fresh["_id"]))
        if top is not None and top.get("sha") == _sha(fresh.get("title"), fresh.get("content") or ""):
            if not top.get("sealed"):
                await db[COLL].update_one({"_id": top["_id"]}, {"$set": {"sealed": True}})
            return
        await _insert(db, fresh, kind="user" if getattr(actor, "user_id", None) else "system",
                      author_id=getattr(actor, "user_id", None), author_name=_author_name(actor),
                      reason="release")
    except Exception:
        log.warning("version history: release snapshot failed", exc_info=True)


async def record_event(db: AsyncIOMotorDatabase, raw: dict, actor, *, text: str, event: dict) -> None:
    """Something that happened to the page without changing its text (a
    sign-off, services/signoffs.py): an entry of its own (``author_kind``
    ``signoff``, ``event.text`` is what the list shows), holding the page as it
    is. Never fails the caller."""
    if not records(raw):
        return
    try:
        fresh = await db["documents"].find_one({"_id": raw["_id"]})
        if fresh is None:
            return
        await capture(db, fresh, reason="before_event")
        await _insert(db, fresh, kind="signoff", author_id=getattr(actor, "user_id", None),
                      author_name=_author_name(actor), sealed=True, reason="signoff",
                      event={**event, "text": text[:300]})
    except Exception:
        log.warning("version history: event failed", exc_info=True)


async def keep(db: AsyncIOMotorDatabase, raw: dict, actor, *, title: str | None, markdown: str,
               text: str, reason: str) -> dict | None:
    """Someone's text that never became the page (an editor whose lock was taken over:
    services/pages.keep_unsaved): its own sealed version, ``event`` ``{type: "kept", text}``, with
    the page as it is captured first so the newest version stays the page's. None when it's
    already the page or a version just like it is the newest."""
    if not records(raw):
        return None
    fresh = await db["documents"].find_one({"_id": raw["_id"]})
    if fresh is None:
        return None
    sha = _sha(title, markdown or "")
    if sha == _sha(fresh.get("title"), fresh.get("content") or ""):
        return None
    if await db[COLL].find_one({"doc_id": str(fresh["_id"]), "sha": sha, "event.type": "kept"}, {"_id": 1}):
        return None  # already kept (a retry)
    await capture(db, fresh, reason="before_keep")
    top = await latest(db, str(fresh["_id"]), {"sha": 1, "event": 1})
    if top is not None and top.get("sha") == sha:
        return None
    return await _insert(db, {**fresh, "title": title, "content": markdown}, kind="user",
                         author_id=getattr(actor, "user_id", None), author_name=_author_name(actor),
                         sealed=True, reason=f"kept_{reason}", event={"type": "kept", "text": text[:300]})


async def forget_document(db: AsyncIOMotorDatabase, doc_id: str) -> None:
    await db[COLL].delete_many({"doc_id": doc_id})


# ── Reading (the API and MCP; the caller has checked the reader may edit) ────


async def _people(db: AsyncIOMotorDatabase, ids: set[str]) -> dict[str, dict]:
    oids = [ObjectId(i) for i in ids if i and ObjectId.is_valid(i)]
    if not oids:
        return {}
    out = {}
    async for u in db["users"].find({"_id": {"$in": oids}}, {"name": 1, "email": 1, "picture": 1}):
        name = (u.get("name") or "").strip() or (u.get("email") or "").split("@", 1)[0] or "Someone"
        pic = u.get("picture") if isinstance(u.get("picture"), str) and u["picture"].startswith("https://") else None
        out[str(u["_id"])] = {"name": name[:60], "picture": pic}
    return out


def _author(row: dict, people: dict[str, dict]) -> dict:
    kind = row.get("author_kind") or "system"
    who = people.get(row.get("author_id") or "") or {}
    name = who.get("name") or row.get("author_name")
    if kind == "mcp":
        label = f"{row.get('client') or 'AI app'} via MCP"
    elif kind == "system":
        label = "Earlier version"
    elif kind == "signoff":
        label = (row.get("event") or {}).get("text") or "Sign-off"
    elif kind == "jira":
        # A to-do ticked (or reopened) because its linked issue moved in Jira (services/jira_links.py).
        label = f"{name or 'Someone'} via Jira"
    else:
        label = name or "Someone"
    return {"kind": kind, "id": row.get("author_id"), "name": name, "client": row.get("client"),
            "label": label, "picture": who.get("picture")}


def view(row: dict, people: dict[str, dict], current_sha: str | None = None) -> dict:
    return {
        "n": int(row["n"]), "ts": iso(row.get("ts")), "author": _author(row, people),
        "title": row.get("title"), "icon": row.get("icon"), "bytes": int(row.get("bytes") or 0),
        "restored_from": row.get("restored_from"), "current": bool(current_sha) and row.get("sha") == current_sha,
        **({"event": {k: v for k, v in row["event"].items() if k in ("type", "action", "block", "label", "option",
                                                                     "was", "text")}} if row.get("event") else {}),
    }


async def listing(db: AsyncIOMotorDatabase, raw: dict, cursor: int | None = None,
                  limit: int = PAGE_SIZE) -> dict:
    """``{versions, next_cursor, available}``, newest first."""
    if not has_history(raw):
        return {"versions": [], "next_cursor": None, "available": False,
                "reason": "encrypted" if raw.get("encrypted") else "file"}
    q: dict = {"doc_id": str(raw["_id"])}
    if cursor is not None:
        q["n"] = {"$lt": int(cursor)}
    limit = max(1, min(int(limit), 100))
    rows = await db[COLL].find(q, _LIST_FIELDS).sort("n", DESCENDING).limit(limit + 1).to_list(length=limit + 1)
    more = len(rows) > limit
    rows = rows[:limit]
    people = await _people(db, {r.get("author_id") for r in rows if r.get("author_id")})
    sha = _sha(raw.get("title"), raw.get("content") or "")
    # Only the newest version can be the current state.
    out = [view(r, people, sha if i == 0 and cursor is None else None) for i, r in enumerate(rows)]
    return {"versions": out, "next_cursor": int(rows[-1]["n"]) if more and rows else None, "available": True,
            "reason": None}


async def get_version(db: AsyncIOMotorDatabase, raw: dict, n: int) -> dict | None:
    if not has_history(raw):
        return None
    return await db[COLL].find_one({"doc_id": str(raw["_id"]), "n": int(n)})


async def detail(db: AsyncIOMotorDatabase, raw: dict, row: dict, actor, ctx) -> dict:
    """A version for an editor of the page: its Markdown (people and item
    labels redacted exactly as the page itself would be for them), links for
    its images that still exist, and the page as it is now, to compare."""
    from app.services import page_assets, pages

    people = await _people(db, {row.get("author_id")} if row.get("author_id") else set())
    markdown = await pages.content_for(actor, {**raw, "content": row.get("markdown") or ""}, ctx) or ""
    current = await pages.content_for(actor, raw, ctx) or ""
    ids = list(dict.fromkeys([*pages.asset_ids(row.get("markdown")), *pages.asset_ids(raw.get("content"))]))
    assets = await page_assets.urls_for(db, raw, ids)
    sha = _sha(raw.get("title"), raw.get("content") or "")
    return {**view(row, people, sha), "markdown": markdown, "assets": assets,
            "current_doc": {"title": raw.get("title"), "markdown": current, "rev": int(raw.get("rev") or 1)}}


# ── Restore ───────────────────────────────────────────────────────────────────


async def restore(db: AsyncIOMotorDatabase, raw: dict, n: int, actor, ctx) -> tuple[dict, dict]:
    """Bring back version ``n`` as a new version (the current state is kept
    first, so the restore can be undone). Respects the edit lock: 423 while
    someone else has the page open. Returns (the row after, the new version)."""
    from pydantic import ValidationError

    from app.config import get_settings
    from app.schemas.document import DocumentUpdate
    from app.services import access, live, pages
    from app.services import document as doc_service

    await access.require(actor, raw, "edit_content", ctx)
    if not has_history(raw):
        raise HTTPException(status_code=409, detail="Encrypted documents have no version history."
                            if raw.get("encrypted") else "Files keep their own versions.")
    row = await get_version(db, raw, n)
    if row is None:
        raise HTTPException(status_code=404, detail="That version doesn't exist (any more).")
    await pages.check_write_lock(db, raw, actor, ctx)
    await pages.check_page_lock(raw, actor, ctx, row.get("markdown") or "")
    if len(row.get("markdown") or "") > get_settings().max_content_chars:  # pragma: no cover - cap moved
        raise HTTPException(status_code=413, detail="That version is longer than a page may be now.")
    await capture(db, raw, reason="before_restore")
    try:
        data = DocumentUpdate(title=row.get("title") or None, content=row.get("markdown") or "\n")
    except ValidationError:
        raise HTTPException(status_code=422, detail="That version can't be restored.")
    after = await doc_service.update_document(db, raw["slug"], data, actor, ctx,
                                              history={"kind": "restore", "restored_from": int(n)})
    top = await latest(db, str(after["_id"]))
    # The restorer's own editor holds the lock and ignores "changed": this tells it to load.
    live.notify(after["slug"], {"type": "changed", "rev": int(after.get("rev") or 1), "restored": True})
    return after, top or {}


# ── Retention ────────────────────────────────────────────────────────────────


async def thin(db: AsyncIOMotorDatabase, now: datetime | None = None, *, dry_run: bool = False) -> dict:
    """Every version for 30 days, then the newest of each day up to a year;
    versions of pages that no longer exist go; at most 500 per page."""
    now = now or now_utc()
    keep_all_after = now - KEEP_ALL
    drop_before = now - KEEP_DAILY
    expired = await db[COLL].count_documents({"ts": {"$lt": drop_before}})
    if not dry_run and expired:
        await db[COLL].delete_many({"ts": {"$lt": drop_before}})
    thinned = 0
    doomed: list = []
    last_key: tuple | None = None
    cur = db[COLL].find({"ts": {"$lt": keep_all_after, "$gte": drop_before}}, {"doc_id": 1, "ts": 1, "n": 1}) \
        .sort([("doc_id", 1), ("ts", DESCENDING)])
    async for r in cur:
        ts = _aware(r["ts"])
        key = (r["doc_id"], ts.date())
        if key == last_key:
            doomed.append(r["_id"])  # an older one of a day already kept
        last_key = key
        if len(doomed) >= 500:
            thinned += len(doomed)
            if not dry_run:
                await db[COLL].delete_many({"_id": {"$in": doomed}})
            doomed = []
    thinned += len(doomed)
    if doomed and not dry_run:
        await db[COLL].delete_many({"_id": {"$in": doomed}})
    # Pages that are gone.
    orphans = 0
    ids = await db[COLL].distinct("doc_id")
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        oids = [ObjectId(d) for d in chunk if ObjectId.is_valid(d)]
        alive = {str(d["_id"]) for d in await db["documents"].find({"_id": {"$in": oids}}, {"_id": 1})
                 .to_list(length=len(oids))}
        from app.services import trash

        alive |= await trash.trashed_ids(db, oids)  # in the trash: its history comes back with it
        gone = [d for d in chunk if d not in alive]
        if gone:
            orphans += await db[COLL].count_documents({"doc_id": {"$in": gone}})
            if not dry_run:
                await db[COLL].delete_many({"doc_id": {"$in": gone}})
    capped = 0
    over = await db[COLL].aggregate([
        {"$group": {"_id": "$doc_id", "c": {"$sum": 1}}},
        {"$match": {"c": {"$gt": MAX_VERSIONS}}},
    ]).to_list(length=None)
    for o in over:
        capped += o["c"] - MAX_VERSIONS
        if not dry_run:
            await _cap(db, o["_id"])
    out = {"expired": expired, "thinned": thinned, "orphaned": orphans, "capped": capped, "dry_run": dry_run}
    log.info("version history retention: %s", out)
    return out


# ── Page images nothing references (§4) ──────────────────────────────────────


async def cleanup_images(db: AsyncIOMotorDatabase, now: datetime | None = None, *,
                         dry_run: bool = False) -> dict:
    """Mark, unmark and delete page images by whether the page or any of its
    retained versions references them. Counts only in the result and logs."""
    from app.services import page_assets, pages, r2

    now = now or now_utc()
    cutoff = now - UNREFERENCED_GRACE
    stats = {"pages": 0, "assets": 0, "referenced": 0, "marked": 0, "cleared": 0, "deleted": 0,
             "deleted_bytes": 0, "page_gone": 0, "kept_encrypted": 0, "dry_run": dry_run}
    doc_ids = await db[page_assets.COLL].distinct("doc_id")
    for doc_id in doc_ids:
        stats["pages"] += 1
        rows = await db[page_assets.COLL].find(
            {"doc_id": doc_id}, {"key": 1, "size": 1, "unreferenced_since": 1}).to_list(length=None)
        stats["assets"] += len(rows)
        page = await db["documents"].find_one({"_id": ObjectId(doc_id)}, {"content": 1, "encrypted": 1, "kind": 1}) \
            if ObjectId.is_valid(doc_id) else None
        if page is None:
            from app.services import trash

            # In the trash: its images stay (closed) until it is restored or deleted forever.
            if await trash.trashed_doc(db, doc_id, {"_id": 1}) is not None:
                stats["kept_trashed"] = stats.get("kept_trashed", 0) + len(rows)
                continue
        if page is not None and page.get("encrypted"):
            stats["kept_encrypted"] += len(rows)  # can't read it: never delete
            continue
        if page is None:
            stats["page_gone"] += len(rows)
            used: set[str] = set()
        else:
            used = set(pages.asset_ids(page.get("content")))
            used |= {a for a in await db[COLL].distinct("assets", {"doc_id": doc_id}) if a}
        mark, clear, doomed = [], [], []
        for r in rows:
            since = _aware(r.get("unreferenced_since"))
            if r["_id"] in used:
                stats["referenced"] += 1
                if since is not None:
                    clear.append(r["_id"])
            elif since is None:
                mark.append(r["_id"])
            elif since <= cutoff:
                doomed.append(r)
        stats["marked"] += len(mark)
        stats["cleared"] += len(clear)
        stats["deleted"] += len(doomed)
        stats["deleted_bytes"] += sum(int(r.get("size") or 0) for r in doomed)
        if dry_run:
            continue
        if mark:
            await db[page_assets.COLL].update_many({"_id": {"$in": mark}, "unreferenced_since": None},
                                                   {"$set": {"unreferenced_since": now}})
        if clear:
            await db[page_assets.COLL].update_many({"_id": {"$in": clear}}, {"$unset": {"unreferenced_since": ""}})
        for r in doomed:
            # The row only goes once the object did (a failed delete is retried tomorrow).
            if r2.is_configured():
                try:
                    await run_in_threadpool(r2.delete, r["key"])
                except Exception:  # pragma: no cover - r2.delete swallows its own errors
                    log.warning("page image cleanup: an R2 delete failed")
                    continue
            await db[page_assets.COLL].delete_one({"_id": r["_id"], "unreferenced_since": {"$lte": cutoff}})
    log.info("page image cleanup: %s", {k: v for k, v in stats.items()})
    return stats


async def run_due(db: AsyncIOMotorDatabase, *, dry_run: bool | None = None, force: bool = False) -> dict | None:
    """The daily pass (services/background.py calls this hourly; it runs once
    a day across restarts)."""
    from app.config import get_settings

    if dry_run is None:
        dry_run = bool(get_settings().page_image_cleanup_dry_run)
    now = now_utc()
    if not force:
        last = await db[RUNS].find_one({"_id": "page_history"})
        at = _aware((last or {}).get("at"))
        if at is not None and at > now - RUN_EVERY:
            return None
    thinned = await thin(db, now, dry_run=dry_run)
    images = await cleanup_images(db, now, dry_run=dry_run)
    # Recorded either way, so a dry run also counts once a day (not every hour).
    await db[RUNS].update_one({"_id": "page_history"}, {"$set": {"at": now, "thin": thinned, "images": images}},
                              upsert=True)
    return {"thin": thinned, "images": images}


if __name__ == "__main__":  # pragma: no cover - an operator's dry run: python -m app.services.page_history
    import asyncio
    import json
    import sys

    async def _main() -> None:
        from app.database import connect, disconnect, get_database

        await connect()
        try:
            res = await run_due(get_database(), dry_run="--apply" not in sys.argv, force=True)
            print(json.dumps(res, default=str, indent=2))
        finally:
            await disconnect()

    asyncio.run(_main())
