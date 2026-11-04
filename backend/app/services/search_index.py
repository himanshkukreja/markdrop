"""The content side of global search: one ``search_index`` row per document, page, file and
Guides page, holding what a search matches below the title.

What lives where (2026-11-04, .work/search/SPEC.md):

* **Titles, slugs, filenames, placement and access are never copied here.** A search reads
  them live from ``documents`` / ``docs_pages`` with the caller's readable filter, so a rename,
  a move, a level change, a grant, a membership or a delete is in the very next search, with
  no hook to forget. This collection only answers "which of these readable ids mention X".
* **Rows** (``_id`` = the document's ObjectId; a Guides page is ``"g:<page id>"``)::

      src   "doc" | "guide"           site  the guide's id (guide rows)
      hd    [{t, id}]  headings (text, the reader's anchor id), at most MAX_HEADINGS
      hw    heading words              w     body words (distinct, stopwords out, capped)
      x     plain text for snippets: the first DOC_TEXT chars (FILE_TEXT for a file's contents)
      v     the source's updated_at when indexed (the reconciler compares it)
      fx    files only: "pending" | "done" | "none" | "failed" (contents extraction)
      at    when indexed

  Encrypted and password-protected documents get an empty row: they match by title only and
  never show a snippet (services/search.py also refuses to read ``x`` for them).
* **Freshness.** Content writes call :func:`touch` (update_document, create_document, sync
  push, MCP appends, admin edits, file swaps, Guides page saves). It is async and coalesced: the
  write returns at once and the row follows a moment later. The ``search_index`` background loop
  (services/background.py, every 10 s) re-indexes anything whose ``updated_at`` moved past the
  row's ``v`` (a write path without a hook), runs the one-time backfill, extracts file contents
  (HTML and PDF text, capped, never on the upload's request) and drops rows whose source is gone.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import UpdateOne

from app.services import heading_ids
from app.services import search_text as st

log = logging.getLogger("markdrop.search_index")

COLL = "search_index"
META = "search_meta"
INDEX_VERSION = 1             # bump to re-run the backfill (a changed row shape)
DOC_TEXT = 20_000             # characters of a page's text kept for matching and snippets
FILE_TEXT = 50_000            # characters of a file's extracted contents
MAX_HEADINGS = 60
MAX_HEADING_WORDS = 300
FILE_FETCH_MAX = 25 * 1024 * 1024
TEXT_MIMES = ("text/plain", "text/markdown", "text/csv", "application/json")
EXTRACT_MIMES = ("text/html", "application/pdf", *TEXT_MIMES)
EXTRACT_TIMEOUT_S = 20.0
DEBOUNCE_S = 0.25
BACKFILL_BUDGET_S = 8.0       # per background tick, then it yields
BACKFILL_BATCH = 200
FILES_PER_TICK = 8
RECONCILE_LIMIT = 500


def now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: Any) -> datetime | None:
    if not isinstance(dt, datetime):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    # Word lookups return ids only and are answered from these indexes alone (covered: a row's big
    # text is never read to say whether it holds a word). services/search.py hints them by name.
    await db[COLL].create_index([("w", 1), ("_id", 1)], name="w_id")
    await db[COLL].create_index([("hw", 1), ("_id", 1)], name="hw_id")
    await db[COLL].create_index("site", sparse=True)
    await db[COLL].create_index("fx", sparse=True)
    # The reconciler's "what changed since" scans.
    await db["documents"].create_index("updated_at")
    await db["docs_pages"].create_index("draft.updated_at")


# ── Building a row ────────────────────────────────────────────────────────────


def doc_kind(raw: dict) -> str:
    """page | doc | file (the search's kinds; services/pages.deleted_item's file/page/document)."""
    if raw.get("kind") == "artifact":
        return "file"
    return "page" if raw.get("editor") == "blocks" else "doc"


def title_only(raw: dict) -> bool:
    """Encrypted or password-protected: matched by title (slug) only, never by content."""
    return bool(raw.get("encrypted") or raw.get("read_password_hash"))


def _headings(md: str) -> list[dict]:
    out = []
    try:
        hs = heading_ids.extract(md)
    except Exception:
        hs = []
    for h in hs[:MAX_HEADINGS]:
        text = (h.text or "").strip()
        if text:
            out.append({"t": text[:200], "id": h.id})
    return out


def text_fields(markdown: str | None, *, limit: int = DOC_TEXT) -> dict:
    """hd / hw / w / x for a Markdown body (its first ``limit`` characters of text)."""
    md = (markdown or "")[: limit * 3]
    hd = _headings(md)
    text = st.markdown_text(md)[:limit]
    return {
        "hd": hd,
        "hw": st.word_set(" ".join(h["t"] for h in hd), limit=MAX_HEADING_WORDS),
        "w": st.word_set(text),
        "x": text,
    }


def plain_fields(text: str | None, *, limit: int = FILE_TEXT) -> dict:
    t = (text or "")[:limit]
    return {"hd": [], "hw": [], "w": st.word_set(t), "x": t}


EMPTY = {"hd": [], "hw": [], "w": [], "x": ""}


def doc_row(raw: dict) -> dict:
    """The row for a document (without ``_id``). Files get their contents later (``fx``)."""
    base = {"src": "doc", "v": _aware(raw.get("updated_at")), "at": now()}
    if title_only(raw):
        return {**base, **EMPTY}
    if raw.get("kind") == "artifact":
        mime = (raw.get("mime") or "").split(";")[0].strip().lower()
        fx = "pending" if (mime in EXTRACT_MIMES and raw.get("blob_key") and not raw.get("bundle_prefix")) else "none"
        return {**base, **EMPTY, "fx": fx, "fk": raw.get("blob_key")}
    return {**base, **text_fields(raw.get("content"))}


def guide_row(page: dict) -> dict:
    draft = page.get("draft") or {}
    md = draft.get("markdown") or ""
    desc = page.get("description") or ""
    fields = text_fields(f"{desc}\n\n{md}" if desc else md)
    return {"src": "guide", "site": page.get("site_id"), "v": _aware(draft.get("updated_at") or page.get("updated_at")),
            "at": now(), **fields}


# ── Writing rows ──────────────────────────────────────────────────────────────

_DOC_FIELDS = {"content": 1, "updated_at": 1, "encrypted": 1, "read_password_hash": 1, "kind": 1, "mime": 1,
               "blob_key": 1, "bundle_prefix": 1, "editor": 1, "template": 1}


async def index_doc(db: AsyncIOMotorDatabase, doc_id: Any) -> bool:
    """(Re)index one document from its current row. A missing or template row drops its row.
    A file keeps its extracted contents while the blob is the same one."""
    oid = doc_id if isinstance(doc_id, ObjectId) else ObjectId(str(doc_id))
    raw = await db["documents"].find_one({"_id": oid}, _DOC_FIELDS)
    if raw is None or raw.get("template"):
        await db[COLL].delete_one({"_id": oid})
        return False
    row = doc_row(raw)
    if raw.get("kind") == "artifact" and row.get("fx") == "pending":
        old = await db[COLL].find_one({"_id": oid}, {"fk": 1, "fx": 1, "w": 1, "x": 1})
        if old and old.get("fk") == row.get("fk") and old.get("fx") in ("done", "failed"):
            row.update(fx=old["fx"], w=old.get("w") or [], x=old.get("x") or "")
    await db[COLL].update_one({"_id": oid}, {"$set": row}, upsert=True)
    return True


async def index_guide_page(db: AsyncIOMotorDatabase, page_id: Any) -> bool:
    oid = page_id if isinstance(page_id, ObjectId) else ObjectId(str(page_id))
    page = await db["docs_pages"].find_one({"_id": oid})
    key = f"g:{oid}"
    if page is None or page.get("deleted_at") is not None:
        await db[COLL].delete_one({"_id": key})
        return False
    await db[COLL].update_one({"_id": key}, {"$set": guide_row(page)}, upsert=True)
    return True


async def drop(db: AsyncIOMotorDatabase, doc_id: Any) -> None:
    try:
        oid = doc_id if isinstance(doc_id, ObjectId) else ObjectId(str(doc_id))
        await db[COLL].delete_one({"_id": oid})
    except Exception:
        pass


# ── Async, coalesced hooks ────────────────────────────────────────────────────

_pending: dict[tuple, tuple] = {}
_task: asyncio.Task | None = None


def touch(db: AsyncIOMotorDatabase, doc_id: Any) -> None:
    """A document's content changed: re-index it shortly, off the request. Never raises."""
    _queue(db, "doc", doc_id)


def touch_guide(db: AsyncIOMotorDatabase, page_id: Any) -> None:
    _queue(db, "guide", page_id)


def _queue(db: AsyncIOMotorDatabase, src: str, ident: Any) -> None:
    global _task
    try:
        if ident is None:
            return
        # Keyed by database name: get_database() hands out a new handle per request.
        _pending[(getattr(db, "name", ""), src, str(ident))] = (db, src, ident)
        if _task is None or _task.done():
            _task = asyncio.get_running_loop().create_task(_drain_loop())
    except Exception:
        log.debug("search index: could not queue %s %s", src, ident, exc_info=True)


async def _drain_loop() -> None:
    await asyncio.sleep(DEBOUNCE_S)
    while _pending:
        batch = list(_pending.items())[:100]
        for key, _ in batch:
            _pending.pop(key, None)
        for key, (db, src, ident) in batch:
            try:
                if src == "doc":
                    await index_doc(db, ident)
                else:
                    await index_guide_page(db, ident)
            except Exception as exc:
                log.warning("search index: %s failed: %s", key, type(exc).__name__)


async def drain() -> None:
    """Wait until queued re-indexes are written (tests; the backfill)."""
    while _task is not None and not _task.done():
        await asyncio.shield(_task)


# ── File contents ─────────────────────────────────────────────────────────────


def extract_text(data: bytes, mime: str) -> str:
    """Searchable text of a file's bytes: HTML's visible text, a PDF's text (pypdf, the extractor
    Guides embeds use), plain text as is. Capped at FILE_TEXT characters."""
    mime = (mime or "").split(";")[0].strip().lower()
    if mime == "text/html":
        return st.html_text(data, FILE_TEXT)
    if mime == "application/pdf":
        from app.services import docs_embeds

        return (docs_embeds.extract_pdf(data).get("text") or "")[:FILE_TEXT]
    if mime in TEXT_MIMES:
        return data[: FILE_TEXT * 4].decode("utf-8", "replace")[:FILE_TEXT]
    return ""


async def extract_file(db: AsyncIOMotorDatabase, doc_id: ObjectId) -> str:
    """Fetch one file's bytes from R2 and store its text. Returns the new ``fx`` state."""
    from starlette.concurrency import run_in_threadpool

    from app.services import r2

    raw = await db["documents"].find_one({"_id": doc_id}, {"blob_key": 1, "mime": 1, "size_bytes": 1,
                                                          "encrypted": 1, "read_password_hash": 1})
    if raw is None:
        await db[COLL].delete_one({"_id": doc_id})
        return "gone"
    state, fields = "failed", {}
    if title_only(raw):
        state = "none"
    elif int(raw.get("size_bytes") or 0) > FILE_FETCH_MAX:
        state = "none"
    elif not r2.is_configured():
        state = "failed"
    else:
        try:
            data = await run_in_threadpool(r2.get_bytes, raw["blob_key"], FILE_FETCH_MAX)
            if data:
                text = await asyncio.wait_for(run_in_threadpool(extract_text, data, raw.get("mime") or ""),
                                              timeout=EXTRACT_TIMEOUT_S)
                fields, state = plain_fields(text), "done"
        except Exception as exc:
            log.info("search index: file text for %s skipped (%s)", doc_id, type(exc).__name__)
    # Only if the row still points at the blob we read (a swap meanwhile re-queues it).
    await db[COLL].update_one({"_id": doc_id, "fk": raw.get("blob_key")},
                              {"$set": {**fields, "fx": state, "fx_at": now()}})
    return state


async def extract_pending(db: AsyncIOMotorDatabase, limit: int = FILES_PER_TICK) -> int:
    rows = await db[COLL].find({"fx": "pending"}, {"_id": 1}).limit(limit).to_list(length=limit)
    for r in rows:
        await extract_file(db, r["_id"])
    return len(rows)


# ── Backfill, reconcile, clean up (the background loop) ───────────────────────


async def _meta(db: AsyncIOMotorDatabase, key: str) -> dict:
    return await db[META].find_one({"_id": key}) or {}


async def backfill_tick(db: AsyncIOMotorDatabase, *, budget_s: float = BACKFILL_BUDGET_S,
                        batch: int = BACKFILL_BATCH) -> dict:
    """One slice of the one-time backfill: documents by ``_id``, then Guides pages. Resumable
    (the cursor is saved after every batch); a no-op once done for INDEX_VERSION."""
    state = await _meta(db, "backfill")
    if state.get("version") == INDEX_VERSION and state.get("done"):
        return {"done": True, "indexed": 0}
    if state.get("version") != INDEX_VERSION:
        state = {"version": INDEX_VERSION, "phase": "docs", "cursor": None, "count": 0,
                 "started_at": now()}
    t0 = time.monotonic()
    n = 0
    while time.monotonic() - t0 < budget_s:
        coll = "documents" if state["phase"] == "docs" else "docs_pages"
        q: dict = {"_id": {"$gt": state["cursor"]}} if state.get("cursor") is not None else {}
        if coll == "docs_pages":
            q["deleted_at"] = None
        proj = _DOC_FIELDS if coll == "documents" else None
        rows = await db[coll].find(q, proj).sort("_id", 1).limit(batch).to_list(length=batch)
        if not rows:
            if state["phase"] == "docs":
                state.update(phase="guides", cursor=None)
                continue
            state.update(done=True, finished_at=now())
            break
        ops = []
        for raw in rows:
            if coll == "documents":
                if raw.get("template"):
                    continue
                ops.append(UpdateOne({"_id": raw["_id"]}, {"$set": doc_row(raw)}, upsert=True))
            else:
                ops.append(UpdateOne({"_id": f"g:{raw['_id']}"}, {"$set": guide_row(raw)}, upsert=True))
        if ops:
            await db[COLL].bulk_write(ops, ordered=False)
        n += len(rows)
        state["cursor"] = rows[-1]["_id"]
        state["count"] = int(state.get("count") or 0) + len(rows)
        await db[META].update_one({"_id": "backfill"}, {"$set": state}, upsert=True)
    await db[META].update_one({"_id": "backfill"}, {"$set": state}, upsert=True)
    return {"done": bool(state.get("done")), "indexed": n, "total": state.get("count")}


async def reconcile(db: AsyncIOMotorDatabase, *, limit: int = RECONCILE_LIMIT) -> int:
    """Re-index what changed through a path without a hook: documents (and Guides pages) whose
    ``updated_at`` moved past the row's ``v`` since the last pass (with a minute of overlap)."""
    state = await _meta(db, "reconcile")
    since = _aware(state.get("since")) or (now() - timedelta(hours=1))
    started = now()
    n = 0
    rows = await db["documents"].find({"updated_at": {"$gte": since - timedelta(minutes=1)}},
                                      {"updated_at": 1}).sort("updated_at", 1).limit(limit).to_list(length=limit)
    if rows:
        have = {r["_id"]: _aware(r.get("v")) for r in await db[COLL].find(
            {"_id": {"$in": [r["_id"] for r in rows]}}, {"v": 1}).to_list(length=len(rows))}
        for r in rows:
            if have.get(r["_id"]) != _aware(r.get("updated_at")):
                await index_doc(db, r["_id"])
                n += 1
    pages = await db["docs_pages"].find({"draft.updated_at": {"$gte": since - timedelta(minutes=1)}},
                                        {"draft.updated_at": 1, "deleted_at": 1}).limit(limit).to_list(length=limit)
    if pages:
        have = {r["_id"]: _aware(r.get("v")) for r in await db[COLL].find(
            {"_id": {"$in": [f"g:{p['_id']}" for p in pages]}}, {"v": 1}).to_list(length=len(pages))}
        for p in pages:
            if p.get("deleted_at") is not None or have.get(f"g:{p['_id']}") != _aware((p.get("draft") or {}).get("updated_at")):
                await index_guide_page(db, p["_id"])
                n += 1
    nxt = started if len(rows) < limit else _aware(rows[-1].get("updated_at")) or started
    await db[META].update_one({"_id": "reconcile"}, {"$set": {"since": nxt, "at": now()}}, upsert=True)
    return n


async def sweep_orphans(db: AsyncIOMotorDatabase, *, batch: int = 500) -> int:
    """Drop rows whose document is gone for good (not in ``documents`` and not in the trash,
    whose restore brings the same id back). One batch per call, resumable."""
    state = await _meta(db, "orphans")
    q: dict = {"src": "doc"}
    if state.get("cursor") is not None:
        q["_id"] = {"$gt": state["cursor"]}
    rows = await db[COLL].find(q, {"_id": 1}).sort("_id", 1).limit(batch).to_list(length=batch)
    if not rows:
        await db[META].update_one({"_id": "orphans"}, {"$set": {"cursor": None, "at": now()}}, upsert=True)
        return 0
    ids = [r["_id"] for r in rows]
    live = {r["_id"] for r in await db["documents"].find({"_id": {"$in": ids}}, {"_id": 1}).to_list(length=len(ids))}
    trashed = {r["_id"] for r in await db["trash"].find({"_id": {"$in": ids}}, {"_id": 1}).to_list(length=len(ids))}
    gone = [i for i in ids if i not in live and i not in trashed]
    if gone:
        await db[COLL].delete_many({"_id": {"$in": gone}})
    await db[META].update_one({"_id": "orphans"}, {"$set": {"cursor": ids[-1], "at": now()}}, upsert=True)
    return len(gone)


_last_orphans: dict[str, float] = {}


async def background(db: AsyncIOMotorDatabase) -> None:
    """The ``search_index`` loop body (services/background.py)."""
    await backfill_tick(db)
    await reconcile(db)
    await extract_pending(db)
    t = time.monotonic()
    if t - _last_orphans.get("t", 0.0) > 600:
        _last_orphans["t"] = t
        await sweep_orphans(db)


async def status(db: AsyncIOMotorDatabase) -> dict:
    """For the admin panel and the deploy check."""
    bf = await _meta(db, "backfill")
    return {
        "backfill": {k: bf.get(k) for k in ("version", "phase", "done", "count", "started_at", "finished_at")},
        "rows": await db[COLL].estimated_document_count(),
        "files_pending": await db[COLL].count_documents({"fx": "pending"}),
    }
