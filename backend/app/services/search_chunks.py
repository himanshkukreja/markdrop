"""Windows of long texts for search and Ask: a meeting transcript every few minutes, a file's pages,
slides, sheets and sections, a video's captions, so every minute and every page is searchable and an
answer can say where ("at 12:34", "page 3", "slide 5") and link there.

``search_chunks`` rows (``_id`` ``"<item id>:<src letter><n>"``)::

    p    the item (documents _id): access is always the item's, decided per search
    src  "transcript" | "file" | "captions" | "around" (a page's text around a video it embeds)
    n    order within the item and src
    w    the window's words (distinct, stopwords out)          x  its text (≤ CHUNK_CHARS + overlap)
    l    where it is: "12:34", "page 3", "slide 5", "sheet Budget", a section heading
    f    the link fragment that opens there: "b-t0012" (a transcript line's anchor), "page=3", "t=754"
    sp   speakers in the window (transcripts)
    g    "around" rows only: the embedding page's _id. The row counts (matching, excerpts) only when
         that page is readable by the person too: a video's reader who can't open the page never
         matches on, or sees, its text.

The parent ``search_index`` row keeps the first part's words and text as before; services/search.py
also looks the words up here (``_content_hits``) and folds a window's hits into its item's body score.
"""

from __future__ import annotations

import re
from typing import Any, Awaitable, Callable

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import search_text as st

COLL = "search_chunks"
CHUNK_CHARS = 2400            # a window: about four minutes of talk, a page or two of a document
OVERLAP_CHARS = 300           # the end of a window starts the next one (a sentence cut in two still matches)
TRANSCRIPT_WINDOW_S = 240
MAX_TOTAL = 200_000           # characters per item (~3.5 hours of transcript)
MAX_CHUNKS = 160
CHUNK_WORDS = 900
SRC_LETTER = {"transcript": "t", "file": "f", "captions": "c", "around": "a"}


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index([("w", 1), ("p", 1)], name="w_p")
    await db[COLL].create_index([("p", 1), ("src", 1), ("n", 1)], name="p_src_n")
    await db[COLL].create_index("g", sparse=True)


def _oid(v: Any) -> ObjectId | None:
    if isinstance(v, ObjectId):
        return v
    try:
        return ObjectId(str(v))
    except Exception:
        return None


# ── Building windows ──────────────────────────────────────────────────────────


def split_text(text: str, *, size: int = CHUNK_CHARS, overlap: int = OVERLAP_CHARS) -> list[str]:
    """``text`` in windows of about ``size`` characters, cut on line or word breaks, each starting
    ``overlap`` characters before the previous one ended."""
    text = (text or "").strip()
    if len(text) <= size:
        return [text] if text else []
    out = []
    start = 0
    while start < len(text):
        end = min(len(text), start + size)
        if end < len(text):
            cut = text.rfind("\n", start + size // 2, end)
            if cut < 0:
                cut = text.rfind(" ", start + size // 2, end)
            end = cut if cut > start else end
        piece = text[start:end].strip()
        if piece:
            out.append(piece)
        if end >= len(text):
            break
        nxt = max(start + 1, end - overlap)
        sp = text.find(" ", nxt, end)
        start = sp + 1 if 0 <= sp < end else nxt
    return out


def parts_chunks(parts: list, *, src: str = "file") -> list[dict]:
    """Rows (without p) for a file's located parts (services/file_text.Part)."""
    out: list[dict] = []
    total = 0
    for part in parts:
        for piece in split_text(part.text):
            if total >= MAX_TOTAL or len(out) >= MAX_CHUNKS:
                return out
            piece = piece[: MAX_TOTAL - total]
            total += len(piece)
            out.append({"src": src, "x": piece, "l": part.label, "f": part.frag})
    return out


# A transcript page's line (services/meetings.transcript_markdown): **12:34 · Ada Lovelace** words {#b-t0012}
_LINE = re.compile(r"^\*\*(?P<head>.*?)\*\*\s*(?P<text>.*?)\s*\{#(?P<anchor>b-t\d{3,5})\}\s*$")
_CLOCK = re.compile(r"^(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*·\s*(.*))?$")


def _unescape(t: str) -> str:
    return re.sub(r"\\(.)", r"\1", t)


def transcript_lines(markdown: str) -> list[dict]:
    """[{anchor, clock, speaker, text}] of a transcript page's anchored lines, in order."""
    out = []
    for raw in (markdown or "").split("\n"):
        m = _LINE.match(raw.strip())
        if not m:
            continue
        head = _unescape(m.group("head")).strip()
        cm = _CLOCK.match(head)
        clock, who = (cm.group(1), (cm.group(2) or "").strip()) if cm else (None, head)
        out.append({"anchor": m.group("anchor"), "clock": clock, "speaker": who or None,
                    "text": _unescape(m.group("text")).strip()})
    return out


def _seconds(clock: str | None) -> int | None:
    if not clock:
        return None
    bits = [int(b) for b in clock.split(":")]
    s = 0
    for b in bits:
        s = s * 60 + b
    return s


def transcript_chunks(markdown: str, *, window_s: int = TRANSCRIPT_WINDOW_S, size: int = CHUNK_CHARS) -> list[dict]:
    """Rows (without p) for a transcript page: windows of ``window_s`` seconds or ``size`` characters,
    whichever comes first, each repeating the previous window's last line; labelled with the first
    line's time and linked to its anchor; the speakers in it listed."""
    lines = transcript_lines(markdown)
    out: list[dict] = []
    total = 0
    i = 0
    while i < len(lines) and total < MAX_TOTAL and len(out) < MAX_CHUNKS:
        first = lines[i]
        t0 = _seconds(first["clock"])
        buf, chars, j = [], 0, i
        while j < len(lines):
            ln = lines[j]
            t = _seconds(ln["clock"])
            if buf and ((t0 is not None and t is not None and t - t0 >= window_s) or chars >= size):
                break
            text = (f"[{ln['clock']}] " if ln["clock"] else "") + (f"{ln['speaker']}: " if ln["speaker"] else "") + ln["text"]
            buf.append(text)
            chars += len(text) + 1
            j += 1
        x = "\n".join(buf)
        total += len(x)
        speakers = list(dict.fromkeys(ln["speaker"] for ln in lines[i:j] if ln["speaker"]))[:12]
        out.append({"src": "transcript", "x": x, "l": first["clock"], "f": first["anchor"], "sp": speakers,
                    "k": int(first["anchor"].rsplit("t", 1)[1])})
        if j >= len(lines):
            break
        # Overlap: the next window starts with this one's last line (unless it was a single line).
        i = j - 1 if j - i > 1 else j
    return out


# ── Storing ───────────────────────────────────────────────────────────────────


async def replace(db: AsyncIOMotorDatabase, parent: Any, src: str, rows: list[dict], *, gate: Any = None) -> int:
    """Put ``rows`` as ``parent``'s ``src`` windows (those already there replaced)."""
    pid = _oid(parent)
    if pid is None:
        return 0
    q: dict = {"p": pid, "src": src}
    if gate is not None:
        q["g"] = _oid(gate)
    await db[COLL].delete_many(q)
    if not rows:
        return 0
    letter = SRC_LETTER.get(src, "x")
    if gate is not None:
        letter += str(_oid(gate))[-8:]
    docs = []
    for n, r in enumerate(rows):
        x = r.get("x") or ""
        doc = {"_id": f"{pid}:{letter}{n}", "p": pid, "src": src, "n": n, "x": x,
               "w": st.word_set(" ".join(filter(None, [x, " ".join(r.get("sp") or [])])), limit=CHUNK_WORDS)}
        for k in ("l", "f", "sp", "k"):
            if r.get(k) not in (None, "", []):
                doc[k] = r[k]
        if gate is not None:
            doc["g"] = _oid(gate)
        docs.append(doc)
    await db[COLL].insert_many(docs, ordered=False)
    return len(docs)


async def drop(db: AsyncIOMotorDatabase, parent: Any, src: str | None = None) -> None:
    pid = _oid(parent)
    if pid is None:
        return
    q: dict = {"p": pid}
    if src:
        q["src"] = src
    await db[COLL].delete_many(q)


async def drop_gate(db: AsyncIOMotorDatabase, page: Any) -> None:
    """A page is gone: the "around" text it gave other items goes with it."""
    gid = _oid(page)
    if gid is not None:
        await db[COLL].delete_many({"g": gid})


# ── Reading ───────────────────────────────────────────────────────────────────


def _score(words: list[str], terms) -> tuple[float, int]:
    """How well a window matches the query: the summed weight of the query words it holds."""
    got: dict[int, float] = {}
    for w in words:
        for i, q in terms.expand.get(w, ()):
            if q > got.get(i, 0):
                got[i] = q
        if terms.prefixes and w.startswith(terms.prefixes):
            i = len(terms.tokens) - 1
            got[i] = max(got.get(i, 0), 92.0)
    score = sum(got[i] / 100.0 * terms.weights[i] for i in got)
    return score, len(got)


GateCheck = Callable[[ObjectId], Awaitable[bool]]


async def best(db: AsyncIOMotorDatabase, parents: list, terms, *, per: int = 2,
               gate_ok: GateCheck | None = None) -> dict[Any, list[dict]]:
    """Per parent id, its ``per`` best windows for ``terms`` (with text), best first. Windows from a
    page around an embed only when ``gate_ok(page id)`` says the person can read that page."""
    pids = [p for p in (_oid(x) for x in parents) if p is not None]
    if not pids or not terms.tokens:
        return {}
    # The query's own words first, then their typo variants (a long query has hundreds of those).
    want = list(dict.fromkeys([t for t in terms.tokens if len(t) >= 2] + [w for w in terms.expand if len(w) >= 2]))
    q: dict = {"p": {"$in": pids}}
    if want:
        q["w"] = {"$in": want[:600]}
    rows = await db[COLL].find(q, {"x": 0}).limit(5000).to_list(length=5000)
    if not rows and terms.prefixes:
        rows = await db[COLL].find({"p": {"$in": pids}, "w": {"$regex": "^" + re.escape(terms.prefixes[0])}},
                                   {"x": 0}).limit(2000).to_list(length=2000)
    gates: dict[ObjectId, bool] = {}
    scored: dict[Any, list[tuple[float, int, dict]]] = {}
    for r in rows:
        g = r.get("g")
        if g is not None:
            if gate_ok is None:
                continue
            if g not in gates:
                gates[g] = bool(await gate_ok(g))
            if not gates[g]:
                continue
        s, n = _score(r.get("w") or [], terms)
        if s > 0:
            scored.setdefault(r["p"], []).append((s, -int(r.get("n") or 0), r))
    keep_ids, order = [], {}
    for p, lst in scored.items():
        lst.sort(key=lambda x: (-x[0], -x[1]))
        order[p] = [r["_id"] for _s, _n, r in lst[:per]]
        keep_ids += order[p]
    if not keep_ids:
        return {}
    texts = {r["_id"]: r for r in await db[COLL].find({"_id": {"$in": keep_ids}}, {"w": 0}).to_list(length=len(keep_ids))}
    return {p: [texts[i] for i in ids if i in texts] for p, ids in order.items()}


async def has_chunks(db: AsyncIOMotorDatabase, parents: list) -> set:
    pids = [p for p in (_oid(x) for x in parents) if p is not None]
    if not pids:
        return set()
    return set(await db[COLL].distinct("p", {"p": {"$in": pids}}))


_LINE_CLOCK = re.compile(r"^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s")


def focus(row: dict, terms) -> dict:
    """The window narrowed to its best line when it is a transcript's: that line's time and anchor
    (``l``, ``f``), so a quote and its link land on the moment, not the window's start."""
    if row.get("src") != "transcript" or not row.get("k"):
        return row
    lines = (row.get("x") or "").split("\n")
    best, best_i = 0.0, -1
    for i, line in enumerate(lines):
        s, _n = _score(st.words(line), terms)
        if s > best:
            best, best_i = s, i
    if best_i < 0:
        return row
    m = _LINE_CLOCK.match(lines[best_i])
    out = dict(row)
    out["f"] = f"b-t{int(row['k']) + best_i:04d}"
    if m:
        out["l"] = m.group(1)
    return out


def fragment_url(url: str | None, row: dict) -> str | None:
    """``url`` opened at the window: a transcript line's anchor, a PDF page, a video's second."""
    if not url:
        return url
    f = row.get("f")
    if not f:
        return url
    base = url.split("#", 1)[0]
    return f"{base}#{f}"


def where(row: dict) -> str | None:
    """"at 12:34" / "page 3" / "slide 5" / "sheet Budget" / "section Rollout plan"."""
    label = row.get("l")
    if not label:
        return None
    if row.get("src") in ("transcript", "captions") or re.match(r"^\d{1,2}:\d{2}", str(label)):
        return f"at {label}"
    if row.get("src") == "around":
        return f"on the page {label}"
    if re.match(r"^(page|slide|sheet|rows)\b", str(label)):
        return str(label)
    return f"section “{label}”"
