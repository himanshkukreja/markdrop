"""A file's text for an AI app, a few pages at a time (MCP ``get_document`` and ``fetch``).

* **PDF**: each page's text under ``--- Page N ---``; ``page_from`` / ``page_to`` (1-based, inclusive)
  choose the pages, and a response stops at about :data:`MAX_CHARS` characters with the page to
  continue from. A PDF with no text on any page is a scan ("No extractable text (looks scanned)");
  there is no OCR yet.
* **PowerPoint** (.pptx): each slide's text and speaker notes under ``--- Slide N ---``, paged the
  same way. A deck converted to PDF (services/pptx_preview.slide_texts, where that service exists)
  gives its slide texts; otherwise the deck itself is read.
* **Word / Excel**: their sections and sheets as parts (``--- Sheet Budget ---``).
* **HTML**: the page's visible text (scripts, styles and markup out; headings kept as ``#`` lines,
  link text kept), split into parts of about :data:`PART_CHARS` characters: ``part`` / ``total_parts``.

Access is the caller's: these functions only run on a row the reader already may open. Texts are
cached per version of the file's bytes (blob key, revision, size, hash and time; see :func:`_key`).
"""

from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Any

from app.services import file_text, search_chunks
from app.services import search_text as st

MAX_CHARS = 40_000             # characters of text per response
PART_CHARS = 30_000            # an HTML part
FETCH_MAX = 25 * 1024 * 1024   # bytes read from storage (search_index.FILE_FETCH_MAX)
HTML_TEXT_MAX = 2_000_000      # visible characters kept from an HTML file
DEADLINE_S = 20.0
SCAN_SAMPLE = 10               # pages looked at before calling a PDF scanned
SCANNED = "No extractable text (looks scanned): this PDF's pages are images. OCR isn't available yet."

PDF = "application/pdf"
PAGED_MIMES = (PDF, file_text.PPTX, file_text.DOCX, file_text.XLSX)


class Unreadable(Exception):
    """The file's text can't be read (encrypted, damaged, too large, storage down): the message says why."""


def pages_for(mime: str | None) -> bool:
    """A file type returned by pages / slides / parts."""
    return (mime or "").split(";")[0].strip().lower() in PAGED_MIMES


def is_html(mime: str | None) -> bool:
    return (mime or "").split(";")[0].strip().lower() == "text/html"


# ── Cache ─────────────────────────────────────────────────────────────────────


class _Cache:
    def __init__(self, entries: int = 24):
        self.rows: OrderedDict[str, Any] = OrderedDict()
        self.entries = entries

    def get(self, key: str) -> Any:
        v = self.rows.get(key)
        if v is not None:
            self.rows.move_to_end(key)
        return v

    def put(self, key: str, value: Any) -> None:
        self.rows[key] = value
        self.rows.move_to_end(key)
        while len(self.rows) > self.entries:
            self.rows.popitem(last=False)

    def clear(self) -> None:
        self.rows.clear()


_cache = _Cache()


def clear_cache() -> None:
    _cache.clear()


def _key(raw: dict, what: str) -> str:
    """A cache key for this version of the file's bytes: an editor-synced (live) file keeps its blob
    key while its bytes change, so the revision, size and time are part of it."""
    return ":".join(str(x) for x in (raw.get("blob_key"), raw.get("rev"), raw.get("size_bytes"),
                                     raw.get("sha256"), raw.get("updated_at"), what))


@dataclass
class _Units:
    """A file's units (pages, slides or parts): ``texts[n]`` for the ones read so far."""
    unit: str                          # "page" | "slide" | "part"
    total: int
    texts: dict[int, str] = field(default_factory=dict)
    labels: dict[int, str] = field(default_factory=dict)
    lazy: bool = False                 # a PDF: pages are read as they are asked for


# ── Reading ───────────────────────────────────────────────────────────────────


async def _bytes(raw: dict) -> bytes:
    from starlette.concurrency import run_in_threadpool

    from app.services import r2

    key = raw.get("blob_key")
    if not key:
        raise Unreadable("This file has no stored content.")
    if int(raw.get("size_bytes") or 0) > FETCH_MAX:
        raise Unreadable(f"This file is larger than {FETCH_MAX // (1024 * 1024)} MB, so its text can't be read here.")
    if not r2.is_configured():
        raise Unreadable("File storage isn't available on this server, so the file can't be read.")
    data = await run_in_threadpool(r2.get_bytes, key, FETCH_MAX)
    if not data:
        raise Unreadable("The file couldn't be read from storage. Try again in a moment.")
    return data


def _refused(exc: file_text.Refused, label: str) -> Unreadable:
    why = str(exc)
    if "encrypt" in why:
        return Unreadable(f"This {label} is password-protected, so its text can't be read.")
    if "too long" in why:
        return Unreadable(f"This {label} took too long to read.")
    return Unreadable(f"This {label} couldn't be read ({why}).")


def _covered(units: _Units, start: int, stop: int, budget: int) -> bool:
    """Whether ``units`` already holds pages ``start``… as far as one response of ``budget`` goes."""
    if not units.lazy:
        return True
    size = 0
    for n in range(start, min(stop, units.total) + 1):
        if n not in units.texts:
            return False
        size += len(units.texts[n]) + 20
        if size > budget:
            return True
    return True


def _pdf_pages(data: bytes, cached: _Units | None, start: int, stop: int | None, budget: int) -> _Units:
    """Read the first :data:`SCAN_SAMPLE` pages, then pages from ``start`` until about ``budget``
    characters (or ``stop``), into ``cached``."""
    reader = file_text.pdf_reader(data)
    units = cached or _Units("page", min(len(reader.pages), file_text.PDF_MAX_PAGES), lazy=True)
    end = time.monotonic() + DEADLINE_S
    for n in range(1, min(units.total, SCAN_SAMPLE) + 1):
        if n not in units.texts:
            units.texts[n] = file_text.pdf_page_text(reader, n)
    size = 0
    for n in range(start, min(stop or units.total, units.total) + 1):
        if n not in units.texts:
            if time.monotonic() > end:
                break
            units.texts[n] = file_text.pdf_page_text(reader, n)
        size += len(units.texts[n]) + 20
        if size > budget:
            break
    return units


def _whole(data: bytes, mime: str, filename: str | None) -> _Units:
    if mime == file_text.PPTX:
        slides = file_text.pptx_slide_texts(data)
        return _Units("slide", len(slides), {i: t for i, t in enumerate(slides, 1)})
    parts = file_text.extract(data, mime, filename).parts
    return _Units("part", len(parts), {i: p.text for i, p in enumerate(parts, 1)},
                  {i: p.label for i, p in enumerate(parts, 1) if p.label})


async def _converted_slides(db: Any, raw: dict) -> _Units | None:
    """A deck's slide texts from its PDF conversion (services/pptx_preview.slide_texts, when that
    service is on this server); None to read the deck here instead."""
    import importlib

    try:
        preview = importlib.import_module("app.services.pptx_preview")
    except ImportError:
        return None
    fn = getattr(preview, "slide_texts", None)
    if fn is None:
        return None
    try:
        got = await fn(db, raw)
    except Exception:
        return None
    if not got or not isinstance(got.get("slides"), list):
        return None
    texts = {int(s["slide"]): str(s.get("text") or "").strip() for s in got["slides"] if s.get("slide")}
    total = int(got.get("total_slides") or len(texts))
    return _Units("slide", total, {n: texts.get(n, "") for n in range(1, total + 1)})


async def _units(raw: dict, start: int, stop: int | None, budget: int, db: Any = None) -> _Units:
    from starlette.concurrency import run_in_threadpool

    from app.services import artifact as art_service

    mime = (raw.get("mime") or "").split(";")[0].strip().lower()
    label = art_service.label_for(mime)
    if mime == file_text.PPTX and db is not None:
        converted = await _converted_slides(db, raw)
        if converted is not None:
            return converted
    key = _key(raw, mime)
    cached = _cache.get(key)
    if cached is not None and _covered(cached, start, stop or cached.total, budget):
        return cached
    data = await _bytes(raw)
    try:
        if mime == PDF:
            units = await asyncio.wait_for(run_in_threadpool(_pdf_pages, data, cached, start, stop, budget),
                                           DEADLINE_S + 5)
        else:
            units = await asyncio.wait_for(run_in_threadpool(_whole, data, mime, raw.get("original_filename")),
                                           DEADLINE_S + 5)
    except file_text.Refused as exc:
        raise _refused(exc, label) from exc
    except asyncio.TimeoutError as exc:
        raise Unreadable(f"This {label} took too long to read.") from exc
    _cache.put(key, units)
    return units


# ── Pages, slides and parts ───────────────────────────────────────────────────


def _clip_one(text: str, room: int) -> tuple[str, bool]:
    if len(text) <= room:
        return text, False
    return text[:room].rstrip() + "\n[… the rest of this page is cut: it's longer than one response]", True


async def paged(raw: dict, page_from: int | None = None, page_to: int | None = None,
                max_chars: int = MAX_CHARS, *, db: Any = None) -> dict:
    """{content, unit, total_pages, page_from, page_to, next_page_from, note?, scanned?} for a PDF,
    deck, Word or Excel file. Raises :class:`Unreadable`."""
    start = max(1, int(page_from or 1))
    stop_hint = int(page_to) if page_to else None
    if stop_hint is not None and stop_hint < start:
        raise ValueError("page_to must be at least page_from.")
    units = await _units(raw, start, stop_hint, max_chars, db)
    total = units.total
    word = units.unit
    out: dict[str, Any] = {"unit": word, "total_pages": total}
    if total == 0:
        out.update(content="", page_from=None, page_to=None, next_page_from=None,
                   note=SCANNED if word == "page" else "This file has no text.")
        out["scanned"] = word == "page"
        return out
    if start > total:
        raise ValueError(f"page_from is past the end: this file has {total} {word}(s).")
    stop = min(stop_hint or total, total)
    if word == "page" and not any(units.texts.values()):
        out.update(content="", page_from=start, page_to=stop, next_page_from=None, note=SCANNED, scanned=True)
        return out
    blocks: list[str] = []
    size = 0
    last = start - 1
    cut = False
    for n in range(start, stop + 1):
        if n not in units.texts:
            break       # not read in time: the next response starts here
        head = f"--- {word.capitalize()} {n} ---" if word != "part" or n not in units.labels \
            else f"--- {units.labels[n][:1].upper()}{units.labels[n][1:]} ---"
        body = units.texts[n] or (
            "(no extractable text on this page: it may be an image)" if word == "page" else "(no text)")
        block = f"{head}\n{body}"
        if blocks and size + len(block) + 2 > max_chars:
            break
        if not blocks:
            block, cut = _clip_one(block, max_chars)
        blocks.append(block)
        size += len(block) + 2
        last = n
    nxt = last + 1 if last < stop else None
    out.update(content="\n\n".join(blocks), page_from=start, page_to=last, next_page_from=nxt)
    span = f"{word.capitalize()} {start}" if last == start else f"{word.capitalize()}s {start}–{last}"
    note = f"{span} of {total}."
    if nxt:
        note += f" Continue with page_from={nxt}" + (f" (page_to={stop})" if stop_hint else "") + "."
    if cut:
        note += f" {word.capitalize()} {start} is longer than {max_chars:,} characters, so it's cut."
    out["note"] = note
    return out


# ── HTML ──────────────────────────────────────────────────────────────────────


class _Visible(HTMLParser):
    """Visible text: scripts, styles, templates and SVG out; headings as Markdown ``#`` lines."""
    SKIP = {"script", "style", "noscript", "template", "svg", "head", "iframe", "object"}
    BLOCK = st._HTMLText.BLOCK | {"main", "nav", "aside", "figure", "figcaption", "dt", "dd", "td", "th",
                                  "details", "summary", "hr"}
    HEADINGS = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}

    def __init__(self, limit: int):
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.size = 0
        self.skip = 0
        self.limit = limit

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        if tag in self.BLOCK:
            self.out.append("\n")
        if tag in self.HEADINGS and not self.skip:
            self.out.append("\n" + "#" * self.HEADINGS[tag] + " ")
        if tag in ("td", "th"):
            self.out.append(" ")

    def handle_startendtag(self, tag, attrs):
        if tag in ("br", "hr"):
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skip:
            self.skip -= 1
        if tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, data):
        if self.skip or self.size >= self.limit:
            return
        self.out.append(data)
        self.size += len(data)


def html_visible_text(source: str | bytes, limit: int = HTML_TEXT_MAX) -> str:
    if isinstance(source, bytes):
        source = source.decode("utf-8", "replace")
    p = _Visible(limit)
    try:
        p.feed(source)
        p.close()
    except Exception:
        pass
    t = st._SPACES.sub(" ", "".join(p.out))
    lines = [line.strip() for line in t.split("\n")]
    # A heading marker whose heading had no text is dropped.
    t = "\n".join(line for line in lines if line.strip("# ") or not line.startswith("#"))
    return st._BLANKS.sub("\n\n", t).strip()[:limit]


async def html_parts(raw: dict, source: str | None = None) -> list[str]:
    """An HTML file's visible text in parts of about :data:`PART_CHARS` characters."""
    from starlette.concurrency import run_in_threadpool

    key = _key(raw, "html")
    cached = _cache.get(key)
    if cached is not None:
        return cached
    data: str | bytes = source if source is not None else await _bytes(raw)
    text = await run_in_threadpool(html_visible_text, data)
    parts = search_chunks.split_text(text, size=PART_CHARS, overlap=0)
    if raw.get("blob_key"):
        _cache.put(key, parts)
    return parts


async def html_paged(raw: dict, part: int | None = None, source: str | None = None) -> dict:
    """{content, part, total_parts, next_part, note} of an HTML file's visible text."""
    parts = await html_parts(raw, source)
    total = len(parts)
    n = max(1, int(part or 1))
    if total == 0:
        return {"content": "", "part": None, "total_parts": 0, "next_part": None,
                "note": "This HTML file has no visible text."}
    if n > total:
        raise ValueError(f"part is past the end: this file's text has {total} part(s).")
    nxt = n + 1 if n < total else None
    note = f"Visible text, part {n} of {total}."
    if nxt:
        note += f" Continue with part={nxt}."
    return {"content": parts[n - 1], "part": n, "total_parts": total, "next_part": nxt, "note": note}
