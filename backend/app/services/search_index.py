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
  (never on the upload's request) and drops rows whose source is gone.
* **Whole length** (2026-11-06, .work/briefs/ask-coverage.md). A row holds the first DOC_TEXT
  characters; the rest of a long text lives in windows (services/search_chunks.py), which search
  and Ask match and quote with where they are:

  - a meeting **transcript** page: every few minutes, with the time, the speakers and the line's
    anchor (:func:`index_doc`, from the page's Markdown; ``ch`` = its hash, so an unchanged
    transcript is never re-chunked);
  - a **file's** contents (services/file_text.py: Word sections, PowerPoint slides and notes, Excel
    sheets, CSV rows, PDF pages, HTML, text): :func:`extract_file`, in the background;
  - a **video's** captions (``captions_key``, .vtt) by minute, and the text around it on each page
    that embeds it (gated by that page: services/search_chunks.py ``g``), refreshed when such a page
    is saved (``ax`` pending, :func:`refresh_around`).

  ``cv`` stamps the row with :data:`COVERAGE_VERSION`; :func:`coverage_tick` brings older rows up
  (transcripts re-chunked, files re-queued for extraction): background, resumable, a slice per tick,
  files at FILES_PER_TICK per tick (fetched from R2).
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

from app.services import file_text, heading_ids, search_chunks
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
EXTRACT_MIMES = file_text.EXTRACTABLE
EXTRACT_TIMEOUT_S = 20.0
COVERAGE_VERSION = 1          # bump to re-chunk transcripts and re-extract files (coverage_tick)
COVERAGE_BATCH = 100
CAPTIONS_FETCH_MAX = 4 * 1024 * 1024
AROUND_PAGES = 5              # pages around a video read for its "around" text
AROUND_CHARS = 1500           # characters before and after the embed
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
    await db[COLL].create_index("ax", sparse=True)
    await search_chunks.ensure_indexes(db)
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
    # Front matter's closing "---" would make its last line a (setext) heading: "icon: … props: {…}".
    md = st._FRONTMATTER.sub("", md.replace("\r\n", "\n"), count=1)
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


def is_video(raw: dict) -> bool:
    return (raw.get("mime") or "").lower().startswith("video/")


def file_key(raw: dict) -> str | None:
    """What a file's extracted text depends on: its blob, and a video's captions file."""
    if not raw.get("blob_key"):
        return None
    return raw["blob_key"] + (f"|{raw['captions_key']}" if raw.get("captions_key") else "")


def doc_row(raw: dict) -> dict:
    """The row for a document (without ``_id``). Files get their contents later (``fx``)."""
    base = {"src": "doc", "v": _aware(raw.get("updated_at")), "at": now()}
    if title_only(raw):
        return {**base, **EMPTY}
    if raw.get("kind") == "artifact":
        mime = (raw.get("mime") or "").split(";")[0].strip().lower()
        readable = (mime in EXTRACT_MIMES or (is_video(raw) and raw.get("captions_key")))
        fx = "pending" if (readable and raw.get("blob_key") and not raw.get("bundle_prefix")) else "none"
        row = {**base, **EMPTY, "fx": fx, "fk": file_key(raw)}
        if is_video(raw):
            row["ax"] = "pending"
        return row
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
               "blob_key": 1, "bundle_prefix": 1, "editor": 1, "template": 1, "meeting_role": 1,
               "captions_key": 1, "slug": 1}


def _hash(text: str) -> str:
    import hashlib

    return hashlib.sha1((text or "").encode("utf-8", "replace")).hexdigest()[:16]


async def _chunk_transcript(db: AsyncIOMotorDatabase, raw: dict, old: dict | None) -> dict:
    """A transcript page's windows, rewritten only when its Markdown changed. Returns row fields."""
    content = raw.get("content") or ""
    h = _hash(content)
    if old and old.get("ch") == h and old.get("cv") == COVERAGE_VERSION:
        return {"ch": h, "cv": COVERAGE_VERSION, "nc": old.get("nc", 0)}
    rows = search_chunks.transcript_chunks(content)
    n = await search_chunks.replace(db, raw["_id"], "transcript", rows)
    return {"ch": h, "cv": COVERAGE_VERSION, "nc": n}


async def index_doc(db: AsyncIOMotorDatabase, doc_id: Any) -> bool:
    """(Re)index one document from its current row. A missing or template row drops its row.
    A file keeps its extracted contents while the blob is the same one."""
    oid = doc_id if isinstance(doc_id, ObjectId) else ObjectId(str(doc_id))
    raw = await db["documents"].find_one({"_id": oid}, _DOC_FIELDS)
    if raw is None or raw.get("template"):
        await db[COLL].delete_one({"_id": oid})
        await search_chunks.drop(db, oid)
        return False
    row = doc_row(raw)
    if title_only(raw):
        await search_chunks.drop(db, oid)       # encrypted / password: never a word of its text
        row.update(nc=0, ch=None, cv=COVERAGE_VERSION)
    elif raw.get("kind") == "artifact" and row.get("fx") == "pending":
        old = await db[COLL].find_one({"_id": oid}, {"fk": 1, "fx": 1, "w": 1, "x": 1, "cv": 1, "nc": 1})
        if (old and old.get("fk") == row.get("fk") and old.get("fx") in ("done", "failed", "refused")
                and old.get("cv") == COVERAGE_VERSION):
            row.update(fx=old["fx"], w=old.get("w") or [], x=old.get("x") or "", nc=old.get("nc", 0))
    elif raw.get("kind") == "artifact":
        old = await db[COLL].find_one({"_id": oid}, {"nc": 1})
        if old and old.get("nc"):
            await search_chunks.drop(db, oid, "file")
            await search_chunks.drop(db, oid, "captions")
        row.update(nc=0, cv=COVERAGE_VERSION)
    elif raw.get("meeting_role") == "transcript":
        old = await db[COLL].find_one({"_id": oid}, {"ch": 1, "cv": 1, "nc": 1})
        row.update(await _chunk_transcript(db, raw, old))
    if row.get("ax") == "pending":
        old = await db[COLL].find_one({"_id": oid}, {"ax": 1})
        if old and old.get("ax") == "done":
            row.pop("ax")          # the around text follows the embedding pages' saves, not the file's
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
        await search_chunks.drop(db, oid)
        await search_chunks.drop_gate(db, oid)
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
        loop = asyncio.get_running_loop()
        if _task is not None and _task.get_loop() is not loop:
            # A new event loop (tests run one per case; the app has one): what an old loop queued
            # holds that loop's clients, which can't be used from this one.
            _pending.clear()
            _task = None
        # Keyed by database name: get_database() hands out a new handle per request.
        _pending[(getattr(db, "name", ""), src, str(ident))] = (db, src, ident)
        if _task is None or _task.done():
            _task = loop.create_task(_drain_loop())
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
    loop = asyncio.get_running_loop()
    while _task is not None and _task.get_loop() is loop and not _task.done():
        await asyncio.shield(_task)


# ── File contents ─────────────────────────────────────────────────────────────


def extract_text(data: bytes, mime: str) -> str:
    """Searchable text of a file's bytes (services/file_text.py), capped at FILE_TEXT characters.
    Empty for what is refused (encrypted, a ZIP bomb, malformed)."""
    try:
        return file_text.extract(data, mime).text[:FILE_TEXT]
    except file_text.Refused:
        return ""


def _extract_parts(data: bytes, mime: str, filename: str | None) -> list:
    return file_text.extract(data, mime, filename).parts


async def extract_file(db: AsyncIOMotorDatabase, doc_id: ObjectId) -> str:
    """Fetch one file's bytes from R2 and store its text (the row's first part, the rest in windows
    with their pages / slides / sheets; a video's captions by minute). Returns the new ``fx`` state:
    done | none | failed | refused (never read: encrypted, a ZIP bomb, malformed) | gone."""
    from starlette.concurrency import run_in_threadpool

    from app.services import r2

    raw = await db["documents"].find_one({"_id": doc_id}, {"blob_key": 1, "mime": 1, "size_bytes": 1,
                                                          "encrypted": 1, "read_password_hash": 1,
                                                          "captions_key": 1, "original_filename": 1})
    if raw is None:
        await db[COLL].delete_one({"_id": doc_id})
        await search_chunks.drop(db, doc_id)
        return "gone"
    video = is_video(raw)
    key = raw.get("captions_key") if video else raw.get("blob_key")
    limit = CAPTIONS_FETCH_MAX if video else FILE_FETCH_MAX
    state, fields, parts, src = "failed", {}, [], "captions" if video else "file"
    if title_only(raw):
        state = "none"
    elif not key:
        state = "none"
    elif not video and int(raw.get("size_bytes") or 0) > FILE_FETCH_MAX:
        state = "none"
    elif not r2.is_configured():
        state = "failed"
    else:
        try:
            data = await run_in_threadpool(r2.get_bytes, key, limit)
            if data:
                mime = file_text.VTT if video else (raw.get("mime") or "")
                parts = await asyncio.wait_for(run_in_threadpool(_extract_parts, data, mime, raw.get("original_filename")),
                                               timeout=EXTRACT_TIMEOUT_S)
                text = "\n\n".join(p.text for p in parts)
                fields, state = plain_fields(text), "done"
        except file_text.Refused as exc:
            state = "refused"
            log.info("search index: file text for %s refused (%s)", doc_id, exc)
        except Exception as exc:
            log.info("search index: file text for %s skipped (%s)", doc_id, type(exc).__name__)
    fk = file_key(raw)
    # Only if the row still points at the bytes we read (a swap meanwhile re-queues it).
    cur = await db[COLL].find_one({"_id": doc_id}, {"fk": 1})
    if cur is None or cur.get("fk") != fk:
        return state
    n = await search_chunks.replace(db, doc_id, src, search_chunks.parts_chunks(parts, src=src)) if state == "done" else 0
    if state != "done":
        await search_chunks.drop(db, doc_id, src)
    await db[COLL].update_one({"_id": doc_id, "fk": fk},
                              {"$set": {**fields, "fx": state, "fx_at": now(), "nc": n, "cv": COVERAGE_VERSION}})
    return state


EXTRACT_BUDGET_S = 20.0      # per background tick (the loop's lease is 30 s)


async def extract_pending(db: AsyncIOMotorDatabase, limit: int = FILES_PER_TICK,
                          budget_s: float = EXTRACT_BUDGET_S) -> int:
    """Up to ``limit`` queued files, newest uploads first, within ``budget_s`` seconds."""
    rows = await db[COLL].find({"fx": "pending"}, {"_id": 1}).sort("_id", -1).limit(limit).to_list(length=limit)
    t0 = time.monotonic()
    n = 0
    for r in rows:
        if n and time.monotonic() - t0 > budget_s:
            break
        await extract_file(db, r["_id"])
        n += 1
    return n


# ── A video's "around" text: the pages that embed it ──────────────────────────


def around_text(markdown: str, slug: str, chars: int = AROUND_CHARS) -> str:
    """The plain text around ``slug``'s embed in a page's Markdown (before and after it)."""
    import re as _re

    md = st._FRONTMATTER.sub("", (markdown or "").replace("\r\n", "\n"), count=1)
    m = _re.search(r"src=[\"']?(?:https?://[^\s\"'}]*/)?" + _re.escape(slug) + r"(?![\w-])", md)
    if not m:
        return ""
    start, end = max(0, m.start() - chars), min(len(md), m.end() + chars)
    if start > 0:
        nl = md.find("\n", start)
        start = nl + 1 if 0 <= nl < m.start() else start
    return st.markdown_text(md[start:end]).strip()


async def refresh_around(db: AsyncIOMotorDatabase, video_id: ObjectId) -> int:
    """Rewrite a video's "around" windows from the pages that embed it now (each gated by its page)."""
    from app.services import page_links

    raw = await db["documents"].find_one({"_id": video_id}, {"slug": 1, "mime": 1, "encrypted": 1,
                                                            "read_password_hash": 1, "kind": 1})
    await search_chunks.drop(db, video_id, "around")
    n = 0
    if raw is not None and is_video(raw) and not title_only(raw) and raw.get("slug"):
        links = await db[page_links.COLL].find({"to_slug": raw["slug"], "kind": "embed"}, {"from_doc": 1}).limit(
            AROUND_PAGES * 4).to_list(length=AROUND_PAGES * 4)
        seen = 0
        for link in links:
            if seen >= AROUND_PAGES:
                break
            try:
                pid = ObjectId(str(link.get("from_doc")))
            except Exception:
                continue
            page = await db["documents"].find_one({"_id": pid, "deleted_at": None},
                                                  {"content": 1, "title": 1, "encrypted": 1, "read_password_hash": 1,
                                                   "kind": 1, "template": 1})
            if page is None or title_only(page) or page.get("kind") == "artifact" or page.get("template"):
                continue
            text = around_text(page.get("content") or "", raw["slug"])
            if not text:
                continue
            seen += 1
            n += await search_chunks.replace(db, video_id, "around", [
                {"x": text, "l": (page.get("title") or "Untitled")[:120]}], gate=pid)
    await db[COLL].update_one({"_id": video_id}, {"$set": {"ax": "done"}})
    return n


async def requeue_around(db: AsyncIOMotorDatabase, slugs: list[str], page_id: Any = None) -> int:
    """A page that embeds these slugs was saved: the videos among them refresh their "around" text
    (in the background). ``page_id``'s windows on videos it no longer embeds go now."""
    ids = []
    if slugs:
        ids = [r["_id"] for r in await db["documents"].find(
            {"slug": {"$in": list(slugs)[:200]}, "kind": "artifact", "mime": {"$regex": "^video/"}}, {"_id": 1}
        ).to_list(length=200)]
    if page_id is not None:
        gid = page_id if isinstance(page_id, ObjectId) else ObjectId(str(page_id))
        stale = await db[search_chunks.COLL].distinct("p", {"g": gid})
        ids += [p for p in stale if p not in ids]
    if ids:
        await db[COLL].update_many({"_id": {"$in": ids}}, {"$set": {"ax": "pending"}})
    return len(ids)


async def around_pending(db: AsyncIOMotorDatabase, limit: int = 20) -> int:
    rows = await db[COLL].find({"ax": "pending"}, {"_id": 1}).limit(limit).to_list(length=limit)
    for r in rows:
        await refresh_around(db, r["_id"])
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
        await db[search_chunks.COLL].delete_many({"$or": [{"p": {"$in": gone}}, {"g": {"$in": gone}}]})
    await db[META].update_one({"_id": "orphans"}, {"$set": {"cursor": ids[-1], "at": now()}}, upsert=True)
    return len(gone)


COVERAGE_QUEUE_MAX = 40       # files waiting for extraction before the coverage pass queues more


async def coverage_tick(db: AsyncIOMotorDatabase, *, batch: int = COVERAGE_BATCH) -> dict:
    """One slice of bringing transcripts and files up to COVERAGE_VERSION (whole transcripts in
    windows; Office / PDF / caption text with locations). Resumable (cursor by ``_id``), skips rows
    already at the version (a file whose blob is unchanged is never fetched twice), and waits while
    more than COVERAGE_QUEUE_MAX files are queued for extraction (R2 fetches stay at FILES_PER_TICK
    per tick). A no-op once done for the version."""
    state = await _meta(db, "coverage")
    if state.get("version") == COVERAGE_VERSION and state.get("done"):
        return {"done": True, "indexed": 0}
    bf = await _meta(db, "backfill")
    if not (bf.get("version") == INDEX_VERSION and bf.get("done")):
        return {"done": False, "indexed": 0, "waiting": "backfill"}
    if state.get("version") != COVERAGE_VERSION:
        state = {"version": COVERAGE_VERSION, "cursor": None, "count": 0, "queued": 0, "started_at": now()}
    if await db[COLL].count_documents({"fx": "pending"}, limit=COVERAGE_QUEUE_MAX + 1) > COVERAGE_QUEUE_MAX:
        return {"done": False, "indexed": 0, "waiting": "files"}
    q: dict = {"$or": [{"meeting_role": "transcript"}, {"kind": "artifact"}]}
    if state.get("cursor") is not None:
        q["_id"] = {"$gt": state["cursor"]}
    rows = await db["documents"].find(q, {"_id": 1}).sort("_id", 1).limit(batch).to_list(length=batch)
    n = 0
    if rows:
        have = {r["_id"]: r for r in await db[COLL].find({"_id": {"$in": [r["_id"] for r in rows]}},
                                                        {"cv": 1}).to_list(length=len(rows))}
        for r in rows:
            if (have.get(r["_id"]) or {}).get("cv") != COVERAGE_VERSION:
                await index_doc(db, r["_id"])
                n += 1
        state["cursor"] = rows[-1]["_id"]
        state["count"] = int(state.get("count") or 0) + len(rows)
        state["queued"] = int(state.get("queued") or 0) + n
    else:
        state.update(done=True, finished_at=now())
    await db[META].update_one({"_id": "coverage"}, {"$set": state}, upsert=True)
    return {"done": bool(state.get("done")), "indexed": n, "total": state.get("count")}


_last_orphans: dict[str, float] = {}


async def background(db: AsyncIOMotorDatabase) -> None:
    """The ``search_index`` loop body (services/background.py)."""
    await backfill_tick(db)
    await reconcile(db)
    await coverage_tick(db)
    await extract_pending(db)
    await around_pending(db)
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
        "coverage": {k: (await _meta(db, "coverage")).get(k) for k in ("version", "done", "count", "queued",
                                                                        "started_at", "finished_at")},
        "chunks": await db[search_chunks.COLL].estimated_document_count(),
    }
