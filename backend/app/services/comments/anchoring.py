"""Anchors: where a thread points (CONTRACT §2). Text quote (W3C TextQuoteSelector), whole block, or page.

Content stays clean: nothing is written into the Markdown. A thread stores its anchor; the server re-anchors
it on every save against the new text and marks it ``attached`` or ``changed``.

Plain text is the text a reader sees, approximated from the Markdown one top-level block at a time (a
paragraph, a heading, one list item, one table row, a code block, a callout's or toggle's label…): inline
syntax goes (links keep their text, images go, mentions read as their name), block ids ``{#b-…}`` and other
attributes go, and whitespace is normalised (every run is one space). The browser normalises the selected
text the same way (``text.replace(/\\s+/g, " ").trim()``), so a quote taken from the rendered page matches
here even though the two texts aren't byte-for-byte the same.

Resolving an anchor against new text (:func:`resolve`):

1. the exact quote in its block (by block id, else fingerprint, else index), the prefix / suffix deciding
   between repeats;
2. the exact quote anywhere, nearest the old position, prefix / suffix as the tiebreak;
3. fuzzy (RapidFuzz alignment, score ≥ 85, length within ±30 %) in its block, then anywhere;

→ ``attached`` with the new exact / prefix / suffix; otherwise ``changed`` (the anchor keeps its last good
quote; the thread's ``original`` keeps the first one). A ``changed`` thread can come back (text put back).
"""

from __future__ import annotations

import hashlib
import logging
import re
import unicodedata
from dataclasses import dataclass

from rapidfuzz import fuzz

from app.services.comments.model import BLOCK_TEXT_MAX, CONTEXT, MAX_QUOTE, THREADS
from app.services.md_outline import inline_text

log = logging.getLogger(__name__)

FUZZY_MIN = 85
BLOCK_FUZZY_MIN = 80
MIN_FUZZY_LEN = 4
MAX_BLOCKS = 5000


class AnchorError(ValueError):
    code = "anchor_not_found"


@dataclass
class Block:
    index: int
    bid: str | None
    kind: str
    text: str
    start: int
    end: int


# ── Plain text ────────────────────────────────────────────────────────────────

_WS = re.compile(r"\s+")
_FRONTMATTER = re.compile(r"\A---\n.*?\n---[ \t]*(?:\n|\Z)", re.S)
_FENCE_OPEN = re.compile(r"^\s{0,3}(`{3,}|~{3,})(.*)$")
_HEADING = re.compile(r"^\s{0,3}#{1,6}(?:\s+|$)")
_SETEXT = re.compile(r"^\s{0,3}(=+|-+)\s*$")
_HR = re.compile(r"^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$")
_ITEM = re.compile(r"^(\s*)(?:[-+*]|\d{1,9}[.)])(?:\s+|$)")
_TASK = re.compile(r"^\s*(?:[-+*]|\d{1,9}[.)])\s+\[[ xX]\]\s*")
_ITEM_MARK = re.compile(r"^\s*(?:[-+*]|\d{1,9}[.)])(?:\s+|$)")
_QUOTE = re.compile(r"^\s{0,3}>\s?")
_TABLE_ROW = re.compile(r"^\s*\|.*\|\s*$")
_TABLE_RULE = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$")
_CONTAINER = re.compile(r"^\s*(:{3,})([A-Za-z][\w-]*)?(?:\[([^\]\n]*)\])?(?:\{[^}\n]*\})?\s*$")
_LEAF = re.compile(r"^\s*::([A-Za-z][\w-]*)(?:\[([^\]\n]*)\])?(?:\{[^}\n]*\})?\s*$")
_BID = re.compile(r"\{#(b-[a-z0-9]{4,12})\b[^}\n]*\}")
_ATTRS = re.compile(r"\{#?[\w-]*(?:\s+[\w-]+=(?:\"[^\"\n]*\"|'[^'\n]*'|[^\s}]+))*\s*\}")
_INLINE_DIR = re.compile(r"(?<![\w:]):([A-Za-z][\w-]*)\[([^\]\n]*)\](?:\{[^}\n]*\})?")
_LEAF_INLINE = re.compile(r"(?<![\w:])::?[A-Za-z][\w-]*\{[^}\n]*\}")
_HTML_LINE = re.compile(r"^\s*</?[A-Za-z][^>]*>\s*$")


def normalise(text: str | None) -> str:
    """NFC, every whitespace run → one space, trimmed (the browser does the same)."""
    if not text:
        return ""
    return _WS.sub(" ", unicodedata.normalize("NFC", text)).strip()


def _ctx(text: str | None) -> str:
    return _WS.sub(" ", unicodedata.normalize("NFC", text)) if text else ""


def _inline(src: str) -> str:
    s = _BID.sub("", src)
    s = _INLINE_DIR.sub(lambda m: m.group(2), s)
    s = _LEAF_INLINE.sub("", s)
    s = _ATTRS.sub("", s)
    return normalise(inline_text(s))


def _bid_of(lines: list[str]) -> str | None:
    for ln in lines:
        m = _BID.search(ln)
        if m:
            return m.group(1)
    return None


def blocks(markdown: str | None) -> list[Block]:
    """The item's top-level blocks with their plain text, in order (empty blocks dropped)."""
    if not markdown:
        return []
    md = markdown.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    md = _FRONTMATTER.sub("", md)
    lines = md.split("\n")
    raw: list[tuple[str, list[str], str, str | None]] = []   # (kind, source lines, text source, container bid)
    containers: list[tuple[int, str | None]] = []             # open ::: containers: (colons, their block id)

    def outer() -> str | None:
        for _n, cb in reversed(containers):
            if cb:
                return cb
        return None
    para: list[str] = []
    para_kind = "p"

    def flush() -> None:
        nonlocal para, para_kind
        if para:
            src = " ".join(para)
            if para_kind == "li":
                src = _TASK.sub("", src) if _TASK.match(src) else _ITEM_MARK.sub("", src, count=1)
            elif para_kind == "quote":
                src = " ".join(_QUOTE.sub("", p) for p in para)
            raw.append((para_kind, list(para), src, outer()))
        para = []
        para_kind = "p"

    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        stripped = line.strip()
        fence = _FENCE_OPEN.match(line)
        if fence:
            flush()
            mark = fence.group(1)
            body: list[str] = []
            i += 1
            while i < n and not re.match(rf"^\s{{0,3}}{re.escape(mark[0])}{{{len(mark)},}}\s*$", lines[i]):
                body.append(lines[i])
                i += 1
            i += 1  # the closing fence
            text = normalise("\n".join(body))
            if text:
                raw.append(("code", [line, *body], "\x00" + text, outer()))
            continue
        if not stripped:
            flush()
            i += 1
            continue
        c = _CONTAINER.match(line)
        if c:
            flush()
            colons = len(c.group(1))
            if c.group(2):
                bid = _bid_of([line])
                containers.append((colons, bid))
                if c.group(3):
                    raw.append(("label", [line], c.group(3), bid))
            else:
                # A closing fence closes the innermost container opened with as many colons or fewer.
                while containers:
                    n_open, _cb = containers.pop()
                    if n_open <= colons:
                        break
            i += 1
            continue
        lf = _LEAF.match(line)
        if lf:
            flush()
            if lf.group(2):
                raw.append(("leaf", [line], lf.group(2), _bid_of([line]) or outer()))
            i += 1
            continue
        if _HEADING.match(line):
            flush()
            src = re.sub(r"^\s{0,3}#{1,6}(?=\s|$)", "", line)
            src = re.sub(r"(?:^|\s+)#+\s*$", "", _BID.sub("", src))
            raw.append(("h", [line], src, outer()))
            i += 1
            continue
        if para and para_kind == "p" and len(para) >= 1 and _SETEXT.match(line):
            src = " ".join(para)
            raw.append(("h", [*para, line], src, outer()))
            para = []
            i += 1
            continue
        if _HR.match(line):
            flush()
            i += 1
            continue
        if _TABLE_ROW.match(line):
            flush()
            if not _TABLE_RULE.match(line):
                cells = [c for c in line.strip().strip("|").split("|")]
                raw.append(("tr", [line], " ".join(cells), outer()))
            i += 1
            continue
        if _HTML_LINE.match(line):
            flush()
            i += 1
            continue
        if _ITEM.match(line):
            flush()
            para = [line]
            para_kind = "li"
            i += 1
            continue
        if _QUOTE.match(line):
            if para_kind != "quote":
                flush()
                para_kind = "quote"
            para.append(line)
            i += 1
            continue
        para.append(line)
        i += 1
    flush()

    out: list[Block] = []
    pos = 0
    for kind, src_lines, src, cbid in raw[:MAX_BLOCKS]:
        text = src[1:] if src.startswith("\x00") else _inline(src)
        if not text:
            continue
        out.append(Block(index=len(out), bid=_bid_of(src_lines) or cbid, kind=kind, text=text, start=pos,
                         end=pos + len(text)))
        pos += len(text) + 1  # the "\n" between blocks
    return out


def plain_text(markdown: str | None) -> str:
    return "\n".join(b.text for b in blocks(markdown))


def _joined(bl: list[Block]) -> str:
    """The blocks' text joined by one space (what a selection across two blocks normalises to); offsets
    are the same as :func:`plain_text`'s."""
    return " ".join(b.text for b in bl)


def fingerprint(text: str) -> str:
    return hashlib.sha1(normalise(text).lower().encode("utf-8")).hexdigest()[:16]


# ── Finding ───────────────────────────────────────────────────────────────────


def _occurrences(hay: str, needle: str, limit: int = 200) -> list[int]:
    out: list[int] = []
    if not needle:
        return out
    i = hay.find(needle)
    while i != -1 and len(out) < limit:
        out.append(i)
        i = hay.find(needle, i + 1)
    return out


def _ctx_score(full: str, pos: int, exact: str, prefix: str, suffix: str) -> int:
    """How many characters of prefix (from its end) and suffix (from its start) agree around ``pos``."""
    score = 0
    if prefix:
        before = full[max(0, pos - len(prefix)):pos]
        k = 0
        while k < len(before) and k < len(prefix) and before[-1 - k] == prefix[-1 - k]:
            k += 1
        score += k
    if suffix:
        after = full[pos + len(exact):pos + len(exact) + len(suffix)]
        k = 0
        while k < len(after) and k < len(suffix) and after[k] == suffix[k]:
            k += 1
        score += k
    return score


def _block_at(bl: list[Block], pos: int) -> Block | None:
    for b in bl:
        if b.start <= pos <= b.end:
            return b
    return bl[-1] if bl else None


def _target_block(bl: list[Block], anchor: dict) -> Block | None:
    bid = anchor.get("block_id")
    if bid:
        for b in bl:
            if b.bid == bid:
                return b
    fp = anchor.get("block_fp")
    if fp:
        same = [b for b in bl if fingerprint(b.text) == fp]
        if same:
            idx = anchor.get("block_index")
            if isinstance(idx, int):
                same.sort(key=lambda b: abs(b.index - idx))
            return same[0]
    text = normalise(anchor.get("block_text"))
    if text:
        best, best_score = None, 0.0
        for b in bl:
            if b.text == text:
                return b
            s = fuzz.ratio(text, b.text[: max(len(text) * 2, 64)]) if len(text) >= MIN_FUZZY_LEN else 0
            if b.text.startswith(text) and len(text) >= 20:
                s = max(s, 95)
            if s > best_score:
                best, best_score = b, s
        if best is not None and best_score >= BLOCK_FUZZY_MIN:
            return best
    return None


def _quote_at(full: str, pos: int, exact: str) -> dict:
    return {"exact": exact, "prefix": full[max(0, pos - CONTEXT):pos],
            "suffix": full[pos + len(exact):pos + len(exact) + CONTEXT]}


def _block_fields(b: Block | None) -> dict:
    if b is None:
        return {"block_id": None, "block_index": None, "block_fp": None, "block_text": None}
    return {"block_id": b.bid, "block_index": b.index, "block_fp": fingerprint(b.text),
            "block_text": b.text[:BLOCK_TEXT_MAX]}


def _find_exact(full: str, bl: list[Block], exact: str, prefix: str, suffix: str, hint: int | None,
                within: Block | None) -> int | None:
    occ = _occurrences(full, exact)
    if not occ:
        return None
    if within is not None:
        inside = [p for p in occ if within.start <= p and p + len(exact) <= within.end]
        if inside:
            occ = inside

    def key(p: int) -> tuple:
        return (-_ctx_score(full, p, exact, prefix, suffix), abs(p - hint) if isinstance(hint, int) else 0, p)

    return min(occ, key=key)


def _find_fuzzy(bl: list[Block], exact: str, within: Block | None) -> tuple[Block, int, int] | None:
    if len(exact) < MIN_FUZZY_LEN:
        return None
    order = ([within] if within is not None else []) + [b for b in bl if b is not within]
    best: tuple[float, Block, int, int] | None = None
    for b in order:
        if len(b.text) < MIN_FUZZY_LEN:
            continue
        res = fuzz.partial_ratio_alignment(exact, b.text, score_cutoff=FUZZY_MIN)
        if res is None:
            continue
        s, e = res.dest_start, res.dest_end
        while s < e and b.text[s] == " ":
            s += 1
        while e > s and b.text[e - 1] == " ":
            e -= 1
        got = b.text[s:e]
        if not got.strip() or abs(len(got) - len(exact)) > max(2, len(exact) * 0.3):
            continue
        if best is None or res.score > best[0] + (2 if b is within else 0):
            best = (res.score, b, s, e)
            if b is within and res.score >= 97:
                break
    if best is None:
        return None
    _score, b, s, e = best
    return b, b.start + s, e - s


# ── Anchors ───────────────────────────────────────────────────────────────────


def _page(rev: int) -> dict:
    return {"type": "page", "block_id": None, "block_index": None, "block_fp": None, "block_text": None,
            "quote": None, "start": None, "rev": int(rev)}


def make_anchor(markdown: str, anchor_in: dict, rev: int) -> dict:
    """A new thread's anchor from what the browser (or an AI app) sent. Raises :class:`AnchorError`
    when the text or block isn't on the item."""
    kind = (anchor_in or {}).get("type")
    if kind == "page":
        return _page(rev)
    bl = blocks(markdown)
    full = _joined(bl)
    target = _target_block(bl, {"block_id": anchor_in.get("block_id"), "block_text": anchor_in.get("block_text")})
    if kind == "block":
        if target is None:
            raise AnchorError("That block isn't on the page any more. Reload and try again.")
        return {"type": "block", **_block_fields(target), "quote": None, "start": None, "rev": int(rev)}
    if kind != "text":
        raise AnchorError("Unknown anchor type.")
    q = anchor_in.get("quote") or {}
    exact = normalise(q.get("exact"))[:MAX_QUOTE]
    if not exact:
        raise AnchorError("Select some text to comment on.")
    # Context keeps its edge spaces (" delta" must not become "delta"); runs still collapse to one.
    prefix = _ctx(q.get("prefix"))[-CONTEXT:]
    suffix = _ctx(q.get("suffix"))[:CONTEXT]
    # The browser's prefix / suffix may begin or end mid-whitespace: compare on what normalising kept.
    hint = anchor_in.get("start") if isinstance(anchor_in.get("start"), int) else None
    pos = _find_exact(full, bl, exact, prefix, suffix, hint, target)
    if pos is not None:
        b = _block_at(bl, pos)
        return {"type": "text", **_block_fields(b), "quote": _quote_at(full, pos, exact), "start": pos,
                "rev": int(rev)}
    fz = _find_fuzzy(bl, exact, target)
    if fz is not None:
        b, p, ln = fz
        if target is None or b is target:
            return {"type": "text", **_block_fields(b), "quote": _quote_at(full, p, full[p:p + ln]), "start": p,
                    "rev": int(rev)}
    if target is not None:
        # The rendered text differs from what the server can see (math, a rendered embed…): keep the quote
        # as the browser had it, tied to its block. It stays attached while the block does.
        return {"type": "text", **_block_fields(target), "quote": {"exact": exact, "prefix": prefix, "suffix": suffix},
                "start": None, "loose": True, "rev": int(rev)}
    raise AnchorError("That text isn't on the page any more. Reload and try again.")


def anchor_from_quote(markdown: str, quote: str, rev: int, *, block_id: str | None = None,
                      occurrence: int = 1) -> dict:
    """An anchor from a quote an AI app gives (MCP add_comment): the visible text, or its Markdown."""
    bl = blocks(markdown)
    full = _joined(bl)
    target = _target_block(bl, {"block_id": block_id}) if block_id else None
    if block_id and target is None:
        raise AnchorError(f"There's no block {block_id} on that page.")
    candidates = [normalise(quote), _inline(quote)]
    for exact in dict.fromkeys(c for c in candidates if c):
        exact = exact[:MAX_QUOTE]
        occ = _occurrences(full, exact)
        if target is not None:
            occ = [p for p in occ if target.start <= p and p + len(exact) <= target.end]
        if occ:
            k = max(1, int(occurrence or 1))
            if k > len(occ):
                raise AnchorError(f"That text appears {len(occ)} time(s); occurrence {k} doesn't exist.")
            pos = occ[k - 1]
            return {"type": "text", **_block_fields(_block_at(bl, pos)), "quote": _quote_at(full, pos, exact),
                    "start": pos, "rev": int(rev)}
    fz = _find_fuzzy(bl, normalise(quote)[:MAX_QUOTE], target)
    if fz is not None:
        b, p, ln = fz
        return {"type": "text", **_block_fields(b), "quote": _quote_at(full, p, full[p:p + ln]), "start": p,
                "rev": int(rev)}
    raise AnchorError("That text isn't on the page. Quote it exactly as the page shows it.")


def resolve(markdown: str, anchor: dict, rev: int) -> tuple[dict, str]:
    """``anchor`` against new text: ``(new anchor, "attached" | "changed")``."""
    kind = (anchor or {}).get("type")
    if kind not in ("text", "block"):
        return {**_page(rev)}, "attached"
    bl = blocks(markdown)
    full = _joined(bl)
    target = _target_block(bl, anchor)
    if kind == "block":
        if target is None:
            return {**anchor, "rev": int(rev)}, "changed"
        return {**anchor, **_block_fields(target), "rev": int(rev)}, "attached"
    q = anchor.get("quote") or {}
    exact = q.get("exact") or ""
    prefix = q.get("prefix") or ""
    suffix = q.get("suffix") or ""
    pos = _find_exact(full, bl, exact, prefix, suffix, anchor.get("start"), target)
    if pos is not None:
        b = _block_at(bl, pos)
        out = {**anchor, **_block_fields(b), "quote": _quote_at(full, pos, exact), "start": pos, "rev": int(rev)}
        out.pop("loose", None)
        return out, "attached"
    fz = _find_fuzzy(bl, exact, target)
    if fz is not None:
        b, p, ln = fz
        out = {**anchor, **_block_fields(b), "quote": _quote_at(full, p, full[p:p + ln]), "start": p, "rev": int(rev)}
        out.pop("loose", None)
        return out, "attached"
    if anchor.get("loose") and target is not None:
        return {**anchor, **_block_fields(target), "rev": int(rev)}, "attached"
    return {**anchor, "rev": int(rev)}, "changed"


# ── Re-anchoring an item's threads ────────────────────────────────────────────


async def reanchor_item(db, doc: dict, *, force: bool = False) -> int:
    """Re-resolve the item's live threads whose anchor is older than the item (all with ``force``).
    Returns how many changed status. Needs ``doc`` with ``content`` and ``rev``."""
    if not doc or doc.get("_id") is None:
        return 0
    rev = int(doc.get("rev") or 1)
    q: dict = {"doc_id": str(doc["_id"]), "deleted_at": None, "anchor.type": {"$in": ["text", "block"]}}
    if not force:
        q["anchor.rev"] = {"$ne": rev}
    rows = await db[THREADS].find(q, {"anchor": 1, "anchor_status": 1, "status": 1}).to_list(length=5000)
    if not rows:
        return 0
    content = doc.get("content")
    if content is None:
        fresh = await db["documents"].find_one({"_id": doc["_id"]}, {"content": 1, "rev": 1})
        content = (fresh or {}).get("content") or ""
        rev = int((fresh or {}).get("rev") or rev)
    flipped = 0
    from pymongo import UpdateOne

    ops = []
    changed_rows = []
    for r in rows:
        new, status = resolve(content, r.get("anchor") or {}, rev)
        sets = {"anchor": new, "anchor_status": status}
        if status != r.get("anchor_status"):
            flipped += 1
            if status == "changed":
                changed_rows.append(r["_id"])
        ops.append(UpdateOne({"_id": r["_id"], "anchor.rev": (r.get("anchor") or {}).get("rev")}, {"$set": sets}))
    if ops:
        await db[THREADS].bulk_write(ops, ordered=False)
    if changed_rows:
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc)
        await db[THREADS].update_many(
            {"_id": {"$in": changed_rows}},
            {"$push": {"history": {"$each": [{"action": "anchor_changed", "by": None, "at": now, "to": None,
                                              "version_id": None}], "$slice": -50}}})
    return flipped


async def on_content_saved(db, before: dict | None, after: dict) -> None:
    """After every content write: re-anchor the item's threads (a no-op when it has none)."""
    try:
        if not after or after.get("_id") is None:
            return
        counts = after.get("comment_counts")
        if counts is None:
            row = await db["documents"].find_one({"_id": after["_id"]}, {"comment_counts": 1})
            counts = (row or {}).get("comment_counts")
        if not counts or not (int(counts.get("open") or 0) + int(counts.get("resolved") or 0)):
            return
        flipped = await reanchor_item(db, after)
        if flipped:
            from app.services.comments import service

            service.live_event(after, {"_id": None}, "anchor_changed")
    except Exception:
        log.exception("comments: re-anchoring after a save failed")
