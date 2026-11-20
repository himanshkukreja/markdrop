"""Ask's index, Layer 3: semantic search over Voyage AI embeddings (AI quality stage 2, .work/briefs/ai-quality-phase2.md).

OFF unless ``MARKDROP_VOYAGE_API_KEY`` is set (and the ``embeddings`` switch is on): Ask, ⌘K AI search and MCP
then work exactly as before. With it:

* **Chunks.** Pages, documents, files with text, meeting pages and transcripts are cut into ~500-token chunks
  (:data:`CHUNK_CHARS`; a transcript by its lines, each chunk remembering its first line K), embedded with
  ``input_type="document"`` and kept per workspace in ``ai_chunks`` (float16, normalised). Only chunks whose text
  changed are embedded again; :data:`DEBOUNCE` after an item's last save, by the ``ai_index`` loop (:func:`tick`).
  Encrypted, password-protected and template items never get chunks; nothing outside a workspace does.
* **Search.** :func:`search` embeds the question (``input_type="query"``) and scores it against the chunks of
  the documents the caller passes — the asker's readable candidates (search's wall 1, ``access`` per item):
  **the access filter is applied before scoring**, so a chunk of an unreadable item is never even compared.
  The matrix per workspace is held in an LRU (:data:`CACHE_WORKSPACES`) and reloaded when that workspace's
  chunks change. In-process numpy cosine: no vector database at this scale (≈10k chunks a workspace).
* **Fusion.** services/search_ai.retrieve adds the semantic ranking to its keyword rankings (reciprocal rank
  fusion); the best chunk travels with its candidate as a passage for the answer.

Cost: tokens × ``voyage_usd_per_mtok`` in the AI ledger under ``embeddings`` (its own caps; internal only).
Tests and the eval inject an embedder with :func:`set_embedder` (a deterministic fake; nothing leaves the machine).
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import secrets
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Protocol

from bson import Binary, ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import DeleteMany, UpdateOne

from app.config import get_settings
from app.services import ai_index, ai_usage

log = logging.getLogger("markdrop.ai_index")
settings = get_settings()

COLL = "ai_chunks"
META = "ai_vectors_meta"
FEATURE = "embeddings"
CHUNK_CHARS = 2000              # ≈ 500 tokens
MAX_CHUNKS_PER_DOC = 120
DOC_TEXT_CHARS = 60_000
DEBOUNCE = timedelta(minutes=2)
PER_TICK = 40                   # documents a tick
BATCH = 64                      # texts per embedding call
CACHE_WORKSPACES = 8
QUERY_CACHE = 256
RESERVE = 0.001
PASSAGE_CHARS = 700
TIMEOUT_S = 30.0


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index([("ws", 1), ("doc", 1)])
    await db[COLL].create_index("doc")


# ── Embedders ─────────────────────────────────────────────────────────────────


class Embedder(Protocol):
    model: str
    dims: int

    async def embed(self, texts: list[str], kind: str) -> tuple[list[list[float]], int]:
        """(vectors, tokens billed) for ``texts``; ``kind`` "document" | "query"."""


class Voyage:
    """The Voyage AI embeddings API (https://docs.voyageai.com/reference/embeddings-api)."""

    def __init__(self, key: str | None = None, model: str | None = None, dims: int | None = None):
        self.key = key or settings.voyage_api_key
        self.model = model or settings.voyage_model
        self.dims = int(dims or settings.voyage_dims)

    async def embed(self, texts: list[str], kind: str) -> tuple[list[list[float]], int]:
        import httpx

        body = {"input": texts, "model": self.model, "input_type": kind, "output_dimension": self.dims,
                "truncation": True}
        last: Exception | None = None
        for attempt in range(4):
            try:
                async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
                    r = await client.post(f"{settings.voyage_api_base.rstrip('/')}/embeddings", json=body,
                                          headers={"Authorization": f"Bearer {self.key}"})
                if r.status_code == 429 or r.status_code >= 500:
                    last = RuntimeError(f"voyage {r.status_code}")
                    await asyncio.sleep(1.5 * (attempt + 1))
                    continue
                r.raise_for_status()
                data = r.json()
                rows = sorted(data.get("data") or [], key=lambda d: d.get("index", 0))
                return [d["embedding"] for d in rows], int((data.get("usage") or {}).get("total_tokens") or 0)
            except Exception as exc:          # network: retry, then give up (the layer degrades to keywords)
                last = exc
                await asyncio.sleep(1.0 * (attempt + 1))
        raise RuntimeError(f"voyage embeddings failed: {type(last).__name__ if last else 'unknown'}")


_override: Embedder | None = None


def set_embedder(e: Embedder | None) -> None:
    """Tests and the eval: use ``e`` instead of Voyage (None: back to the configured one)."""
    global _override
    _override = e
    _qcache.clear()


def embedder() -> Embedder | None:
    if _override is not None:
        return _override
    return Voyage() if settings.voyage_api_key else None


def configured() -> bool:
    return embedder() is not None


async def enabled(db: AsyncIOMotorDatabase) -> bool:
    return configured() and await ai_usage.feature_on(db, FEATURE)


async def _record(db: AsyncIOMotorDatabase, e: Embedder, tokens: int, *, kind: str, user_id: str | None = None,
                  workspace_id: str | None = None, ms: int | None = None, outcome: str = "ok") -> None:
    meter = ai_usage.Meter(model=f"voyage:{e.model}")
    meter.calls = 1
    meter.tokens["input"] = tokens
    meter.cost_usd = round(tokens / 1e6 * float(settings.voyage_usd_per_mtok or 0.0), 8)
    try:
        await ai_usage.record(db, feature=FEATURE, meter=meter, request_id="em_" + secrets.token_hex(8), outcome=outcome,
                              latency_ms=ms, user_id=user_id, meta={"kind": kind, "workspace_id": workspace_id},
                              job=None if kind == "query" else "Ask index embeddings",
                              log={"kind": "embeddings", "subject": f"{kind} embeddings", "output": f"{tokens} tokens",
                                   "output_format": "text"})
    except Exception:
        log.warning("ai vectors: recording failed", exc_info=True)


# ── Chunks ────────────────────────────────────────────────────────────────────


def _h(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8", "ignore")).hexdigest()[:16]


def chunk_text(text: str, size: int = CHUNK_CHARS) -> list[str]:
    """Plain text in chunks of about ``size`` characters, cut at paragraph, then line, then sentence ends."""
    t = (text or "").strip()
    if not t:
        return []
    parts = [p.strip() for p in re.split(r"\n\s*\n", t) if p.strip()]
    out: list[str] = []
    buf = ""
    for p in parts:
        while len(p) > size:
            cut = p.rfind("\n", 0, size)
            if cut < size // 2:
                cut = max(p.rfind(". ", 0, size), p.rfind(" ", 0, size))
            cut = cut if cut > size // 3 else size
            piece, p = p[:cut + 1].strip(), p[cut + 1:].strip()
            if buf:
                out.append(buf)
                buf = ""
            out.append(piece)
        if buf and len(buf) + len(p) + 2 > size:
            out.append(buf)
            buf = p
        else:
            buf = f"{buf}\n\n{p}" if buf else p
    if buf:
        out.append(buf)
    return out[:MAX_CHUNKS_PER_DOC]


async def chunks_of(db: AsyncIOMotorDatabase, row: dict) -> list[dict]:
    """[{k, x, line}] for a Layer 1 doc row: a transcript by its lines (``line`` = its first line K), anything else
    from the search index's text of it, prefixed with the title (so a chunk knows what it is from)."""
    from app.services import search_chunks, search_index

    title = row.get("title") or ""
    if row.get("kind") == "transcript":
        raw = await db["documents"].find_one({"_id": row["doc"]}, {"content": 1})
        wins = search_chunks.transcript_chunks((raw or {}).get("content") or "", window_s=10 ** 9, size=CHUNK_CHARS)
        return [{"k": i, "x": f"{title}\n{w['x']}", "line": w.get("k")} for i, w in enumerate(wins[:MAX_CHUNKS_PER_DOC])]
    srow = await db[search_index.COLL].find_one({"_id": row["doc"]}, {"x": 1})
    text = ((srow or {}).get("x") or "")[:DOC_TEXT_CHARS]
    return [{"k": i, "x": f"{title}\n{c}" if title else c, "line": None} for i, c in enumerate(chunk_text(text))]


def _pack(vec: list[float]):
    import numpy as np

    a = np.asarray(vec, dtype=np.float32)
    n = float(np.linalg.norm(a)) or 1.0
    return Binary((a / n).astype(np.float16).tobytes())


async def _bump(db: AsyncIOMotorDatabase, ws: str) -> None:
    await db[META].update_one({"_id": ws}, {"$inc": {"rev": 1}, "$set": {"at": now_utc()}}, upsert=True)


async def embed_doc(db: AsyncIOMotorDatabase, row: dict, e: Embedder) -> int:
    """(Re)embed one Layer 1 doc row's changed chunks; drop chunks it no longer has. Returns tokens billed."""
    oid = row["doc"]
    want = await chunks_of(db, row)
    have = {c["k"]: c for c in await db[COLL].find({"doc": oid}, {"k": 1, "ch": 1, "model": 1}).to_list(length=1000)}
    todo = [c for c in want if (have.get(c["k"]) or {}).get("ch") != _h(c["x"]) or (have.get(c["k"]) or {}).get("model") != e.model]
    tokens = 0
    ops: list = []
    for i in range(0, len(todo), BATCH):
        part = todo[i:i + BATCH]
        t0 = time.monotonic()
        vecs, n = await e.embed([c["x"] for c in part], "document")
        tokens += n
        await _record(db, e, n, kind="document", workspace_id=row.get("ws"), ms=round((time.monotonic() - t0) * 1000))
        for c, v in zip(part, vecs):
            ops.append(UpdateOne({"_id": f"{oid}:{c['k']}"}, {"$set": {
                "ws": row.get("ws"), "doc": oid, "k": c["k"], "x": c["x"][:CHUNK_CHARS + 200], "line": c.get("line"),
                "ch": _h(c["x"]), "v": _pack(v), "model": e.model, "dims": len(v), "at": now_utc()}}, upsert=True))
    ops.append(DeleteMany({"doc": oid, "k": {"$gte": len(want)}}))
    await db[COLL].bulk_write(ops, ordered=True)
    await db[ai_index.COLL].update_one({"_id": row["_id"], "h": row.get("h")}, {"$set": {"vh": row.get("h"), "vx": False}})
    if todo or len(have) > len(want):
        await _bump(db, row.get("ws"))
    return tokens


async def drop_doc(db: AsyncIOMotorDatabase, doc_id: Any) -> None:
    oid = ai_index._oid(doc_id)
    if oid is None:
        return
    one = await db[COLL].find_one({"doc": oid}, {"ws": 1})
    if one is not None:
        await db[COLL].delete_many({"doc": oid})
        await _bump(db, one.get("ws"))


async def stale(db: AsyncIOMotorDatabase, *, limit: int = PER_TICK, settle: timedelta = DEBOUNCE) -> list[dict]:
    from app.services import pages_ai

    cutoff = now_utc() - settle
    q = {"vx": True, "t": "doc", "deleted": {"$ne": True}, "locked": {"$ne": True}, "system": {"$in": [None, "transcript"]},
         "ws": {"$ne": None}, "updated": {"$lte": cutoff}}
    out: list[dict] = []
    ok: dict[str, bool] = {}
    async for r in db[ai_index.COLL].find(q, {"doc": 1, "ws": 1, "h": 1, "kind": 1, "title": 1}).sort(
            "updated", -1).limit(limit * 4):
        ws = r.get("ws")
        if ws not in ok:
            ok[ws] = await pages_ai.workspace_on(db, ws)
        if ok[ws]:
            out.append(r)
        if len(out) >= limit:
            break
    return out


async def tick(db: AsyncIOMotorDatabase, *, limit: int = PER_TICK, settle: timedelta = DEBOUNCE) -> dict:
    """One pass: embed up to ``limit`` items whose text changed (under the ``embeddings`` caps). Deleted, encrypted
    and password-protected items lose their chunks at once (services/ai_index.py: index_doc / drop)."""
    e = embedder()
    if e is None or not await ai_usage.feature_on(db, FEATURE):
        return {"done": 0, "skipped": "off"}
    rows = await stale(db, limit=limit, settle=settle)
    done = tokens = 0
    for r in rows:
        if not (await ai_usage.check_budget(db, FEATURE, reserve=RESERVE)).ok:
            break
        try:
            tokens += await embed_doc(db, r, e)
            done += 1
        except Exception as exc:
            log.warning("ai vectors: %s failed: %s", r.get("doc"), type(exc).__name__)
            break
    return {"done": done, "tokens": tokens}


# ── Search ────────────────────────────────────────────────────────────────────


@dataclass
class _Matrix:
    rev: int
    docs: Any          # np.ndarray[int] — index into ``ids``
    ids: list          # doc ObjectIds
    keys: list         # chunk _ids
    m: Any             # np.ndarray float16 [n, dims]
    model: str


_cache: "OrderedDict[tuple[str, str], _Matrix]" = OrderedDict()
_qcache: "OrderedDict[tuple[str, str], Any]" = OrderedDict()


async def _matrix(db: AsyncIOMotorDatabase, ws: str, model: str) -> _Matrix | None:
    import numpy as np

    meta = await db[META].find_one({"_id": ws}, {"rev": 1}) or {}
    rev = int(meta.get("rev") or 0)
    key = (getattr(db, "name", ""), ws)
    got = _cache.get(key)
    if got is not None and got.rev == rev and got.model == model:
        _cache.move_to_end(key)
        return got
    ids: list = []
    pos: dict = {}
    docs, keys, vecs = [], [], []
    async for c in db[COLL].find({"ws": ws, "model": model}, {"doc": 1, "v": 1}):
        d = c["doc"]
        if d not in pos:
            pos[d] = len(ids)
            ids.append(d)
        docs.append(pos[d])
        keys.append(c["_id"])
        vecs.append(np.frombuffer(bytes(c["v"]), dtype=np.float16))
    if not vecs:
        return None
    dims = max(len(v) for v in vecs)
    vecs = [v for v in vecs]
    mat = _Matrix(rev, np.asarray(docs, dtype=np.int32), ids, keys,
                  np.vstack([v if len(v) == dims else np.zeros(dims, dtype=np.float16) for v in vecs]), model)
    _cache[key] = mat
    _cache.move_to_end(key)
    while len(_cache) > CACHE_WORKSPACES:
        _cache.popitem(last=False)
    return mat


async def query_vector(db: AsyncIOMotorDatabase, e: Embedder, text: str, *, user_id: str | None = None):
    import numpy as np

    key = (e.model, text)
    if key in _qcache:
        _qcache.move_to_end(key)
        return _qcache[key]
    t0 = time.monotonic()
    vecs, n = await e.embed([text], "query")
    await _record(db, e, n, kind="query", user_id=user_id, ms=round((time.monotonic() - t0) * 1000))
    a = np.asarray(vecs[0], dtype=np.float32)
    a = a / (float(np.linalg.norm(a)) or 1.0)
    _qcache[key] = a
    while len(_qcache) > QUERY_CACHE:
        _qcache.popitem(last=False)
    return a


@dataclass
class Hit:
    doc: ObjectId
    score: float
    chunk: str             # the chunk's _id
    text: str = ""
    line: int | None = None


async def search(db: AsyncIOMotorDatabase, allowed: dict[ObjectId, str | None], text: str, *, k: int = 40,
                 user_id: str | None = None) -> list[Hit]:
    """The documents among ``allowed`` (doc id → its workspace, already decided readable for the asker) whose
    chunks best match ``text``, best first, with their best chunk. [] when the layer is off or fails."""
    import numpy as np

    e = embedder()
    if e is None or not allowed or not (text or "").strip():
        return []
    if not await ai_usage.feature_on(db, FEATURE):
        return []
    try:
        if not (await ai_usage.check_budget(db, FEATURE, reserve=RESERVE)).ok:
            return []
        q = await query_vector(db, e, text.strip()[:2000], user_id=user_id)
        best: dict[ObjectId, tuple[float, str]] = {}
        for ws in sorted({w for w in allowed.values() if w}):
            mat = await _matrix(db, ws, e.model)
            if mat is None or mat.m.shape[1] != q.shape[0]:
                continue
            # Access first: only the rows of documents the asker may read are scored at all.
            ok_pos = np.asarray([i for i, d in enumerate(mat.ids) if d in allowed], dtype=np.int32)
            if ok_pos.size == 0:
                continue
            rows = np.nonzero(np.isin(mat.docs, ok_pos))[0]
            if rows.size == 0:
                continue
            scores = mat.m[rows].astype(np.float32) @ q
            top = rows[np.argsort(-scores)[: k * 4]]
            sc = {int(r): float(s) for r, s in zip(rows, scores)}
            for r in top:
                d = mat.ids[int(mat.docs[r])]
                s = sc[int(r)]
                if d not in best or s > best[d][0]:
                    best[d] = (s, mat.keys[int(r)])
    except Exception as exc:
        log.warning("ai vectors: search failed: %s", type(exc).__name__)
        return []
    order = sorted(best.items(), key=lambda kv: -kv[1][0])[:k]
    hits = [Hit(d, s, ck) for d, (s, ck) in order]
    if hits:
        rows_ = {c["_id"]: c for c in await db[COLL].find({"_id": {"$in": [h.chunk for h in hits]}},
                                                          {"x": 1, "line": 1}).to_list(length=len(hits))}
        for h in hits:
            c = rows_.get(h.chunk) or {}
            h.text = c.get("x") or ""
            h.line = c.get("line")
    return hits


async def status(db: AsyncIOMotorDatabase) -> dict:
    return {"configured": configured(), "chunks": await db[COLL].estimated_document_count(),
            "model": (embedder().model if configured() else None)}
