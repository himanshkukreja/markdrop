"""The text inside an uploaded file, with where each piece is (page, slide, sheet, section, minute),
for global search and Ask (services/search_index.py, services/search_chunks.py).

    extract(data, mime, filename) -> Extracted(parts=[Part(text, label, frag)], refused=None|reason)

What is read:

* **Word** (.docx): paragraphs in order, headings as section labels ("Rollout plan").
* **PowerPoint** (.pptx): each slide's text and its speaker notes ("slide 5").
* **Excel** (.xlsx): sheet names, then each sheet's first rows as "a | b | c" lines ("sheet Budget").
* **CSV**: the header and the first rows.
* **PDF**: each page's text ("page 3", link fragment ``page=3``), never an encrypted PDF.
* **HTML** (visible text), **text / Markdown / JSON** as is.
* **Captions** (.vtt / .srt): cues with their time ("12:34", fragment ``t=754``).

**Untrusted bytes.** Office files are ZIPs of XML, read with the standard library only: a ZIP is
refused when it has too many members, claims or inflates past :data:`ZIP_MAX_TOTAL` (the read itself
stops there, whatever the header says) or compresses more than :data:`ZIP_MAX_RATIO` to one (a ZIP
bomb); XML carrying a DOCTYPE (entity expansion, external entities) is refused; macros
(``vbaProject.bin``) are never opened. Password-protected Office files are not ZIPs (they are OLE
containers) and encrypted PDFs are refused, so neither is ever read. Every reader stops at
:data:`MAX_TEXT` characters and checks a deadline. Callers run this off the event loop with a
timeout (search_index.extract_file).
"""

from __future__ import annotations

import csv
import io
import re
import time
import zipfile
from dataclasses import dataclass, field
from xml.etree import ElementTree as ET

from app.services import search_text as st

MAX_TEXT = 200_000            # characters kept per file
ZIP_MAX_MEMBERS = 5_000
ZIP_MAX_TOTAL = 120 * 1024 * 1024     # bytes inflated across the members read
ZIP_MAX_MEMBER = 40 * 1024 * 1024
ZIP_MAX_RATIO = 250
PDF_MAX_PAGES = 400
SHEET_MAX_ROWS = 200
SHEET_MAX_COLS = 30
SHEETS_MAX = 30
SLIDES_MAX = 400
CSV_MAX_ROWS = 300
CAPTION_WINDOW_S = 240
DEADLINE_S = 15.0

DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
VTT = "text/vtt"
SRT = "application/x-subrip"
TEXT_MIMES = ("text/plain", "text/markdown", "application/json")
EXTRACTABLE = (DOCX, PPTX, XLSX, "text/csv", "application/pdf", "text/html", *TEXT_MIMES)


class Refused(Exception):
    """The file is not read (too big, a ZIP bomb, encrypted, malformed): it stays title-only."""


@dataclass
class Part:
    text: str
    label: str | None = None      # "page 3", "slide 5", "sheet Budget", a section heading, "12:34"
    frag: str | None = None       # a link fragment that opens there: "page=3", "t=754"
    t: int | None = None          # seconds (captions)


@dataclass
class Extracted:
    parts: list[Part] = field(default_factory=list)

    @property
    def text(self) -> str:
        return "\n\n".join(p.text for p in self.parts if p.text)[:MAX_TEXT]


def can_extract(mime: str | None) -> bool:
    return (mime or "").split(";")[0].strip().lower() in EXTRACTABLE


class _Clock:
    def __init__(self, seconds: float = DEADLINE_S):
        self.end = time.monotonic() + seconds

    def check(self) -> None:
        if time.monotonic() > self.end:
            raise Refused("took too long")


def _cap(parts: list[Part]) -> list[Part]:
    out, size = [], 0
    for p in parts:
        t = (p.text or "").strip()
        if not t:
            continue
        if size + len(t) > MAX_TEXT:
            t = t[: max(0, MAX_TEXT - size)]
            if t:
                out.append(Part(t, p.label, p.frag, p.t))
            break
        out.append(Part(t, p.label, p.frag, p.t))
        size += len(t) + 2
    return out


# ── ZIP + XML, guarded ────────────────────────────────────────────────────────


class SafeZip:
    """A ZIP read member by member under a total inflation budget, refusing bombs."""

    def __init__(self, data: bytes):
        try:
            self.z = zipfile.ZipFile(io.BytesIO(data))
        except (zipfile.BadZipFile, ValueError, OSError) as exc:
            # Password-protected Office files are OLE containers, not ZIPs: never read.
            raise Refused("not a readable Office file (encrypted or damaged)") from exc
        infos = self.z.infolist()
        if len(infos) > ZIP_MAX_MEMBERS:
            raise Refused("too many parts")
        self.names = {i.filename: i for i in infos}
        if any(i.flag_bits & 0x1 for i in infos):
            raise Refused("encrypted")
        claimed = sum(i.file_size for i in infos)
        packed = sum(i.compress_size for i in infos) or 1
        if claimed > ZIP_MAX_TOTAL * 4 or claimed / packed > ZIP_MAX_RATIO:
            raise Refused("zip bomb")
        self.used = 0

    def has(self, name: str) -> bool:
        return name in self.names

    def read(self, name: str) -> bytes:
        info = self.names.get(name)
        if info is None:
            raise KeyError(name)
        if info.file_size > ZIP_MAX_MEMBER or (info.compress_size and info.file_size / max(1, info.compress_size) > ZIP_MAX_RATIO * 4):
            raise Refused("part too big")
        budget = min(ZIP_MAX_MEMBER, ZIP_MAX_TOTAL - self.used)
        with self.z.open(info) as f:
            data = f.read(budget + 1)       # the header's size may lie: the read itself is capped
        if len(data) > budget:
            raise Refused("inflates too far")
        self.used += len(data)
        return data

    def xml(self, name: str) -> ET.Element:
        return parse_xml(self.read(name))


_DTD = re.compile(rb"<!DOCTYPE|<!ENTITY", re.I)


def parse_xml(data: bytes) -> ET.Element:
    """XML without a DOCTYPE (Office XML never has one; one would be entity expansion or XXE)."""
    if _DTD.search(data[:4096]) or _DTD.search(data):
        raise Refused("XML with a DOCTYPE")
    try:
        return ET.fromstring(data)
    except ET.ParseError as exc:
        raise Refused("malformed XML") from exc


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _rels(z: SafeZip, path: str) -> dict[str, str]:
    """Relationship id → target path (resolved against ``path``'s folder) for an OOXML part."""
    folder, _, base = path.rpartition("/")
    rp = f"{folder}/_rels/{base}.rels"
    if not z.has(rp):
        return {}
    out = {}
    for r in z.xml(rp):
        rid, target = r.get("Id"), r.get("Target") or ""
        if not rid or r.get("TargetMode") == "External":
            continue
        parts = (folder.split("/") if folder else []) + target.split("/")
        if target.startswith("/"):
            parts = target.lstrip("/").split("/")
        stack: list[str] = []
        for p in parts:
            if p == "..":
                if stack:
                    stack.pop()
            elif p and p != ".":
                stack.append(p)
        out[rid] = "/".join(stack)
    return out


# ── Word ──────────────────────────────────────────────────────────────────────

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def docx_parts(data: bytes, clock: _Clock | None = None) -> list[Part]:
    clock = clock or _Clock()
    z = SafeZip(data)
    if not z.has("word/document.xml"):
        raise Refused("not a Word document")
    root = z.xml("word/document.xml")
    parts: list[Part] = []
    section: str | None = None
    buf: list[str] = []
    size = 0

    def flush() -> None:
        if buf:
            parts.append(Part("\n".join(buf), section))
            buf.clear()

    for i, p in enumerate(root.iter(f"{_W}p")):
        if i % 200 == 0:
            clock.check()
        style = p.find(f"{_W}pPr/{_W}pStyle")
        sval = (style.get(f"{_W}val") if style is not None else "") or ""
        bits = []
        for el in p.iter():
            if el.tag == f"{_W}t" and el.text:
                bits.append(el.text)
            elif el.tag == f"{_W}tab":
                bits.append("\t")
            elif el.tag in (f"{_W}br", f"{_W}cr"):
                bits.append("\n")
        text = "".join(bits).strip()
        if not text:
            continue
        if re.match(r"^(?:heading\s*\d|title|überschrift\s*\d)$", sval, re.I):
            flush()
            section = text[:120]
        buf.append(text)
        size += len(text) + 1
        if size > MAX_TEXT:
            break
    flush()
    return parts


# ── PowerPoint ────────────────────────────────────────────────────────────────

_A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
_R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
_P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"


def _drawing_text(root: ET.Element) -> str:
    lines = []
    for para in root.iter(f"{_A}p"):
        t = "".join(el.text or "" for el in para.iter(f"{_A}t")).strip()
        if t:
            lines.append(t)
    return "\n".join(lines)


def pptx_parts(data: bytes, clock: _Clock | None = None) -> list[Part]:
    clock = clock or _Clock()
    z = SafeZip(data)
    if not z.has("ppt/presentation.xml"):
        raise Refused("not a PowerPoint deck")
    pres = z.xml("ppt/presentation.xml")
    rels = _rels(z, "ppt/presentation.xml")
    order = []
    lst = pres.find(f"{_P}sldIdLst")
    for sid in (lst if lst is not None else []):
        target = rels.get(sid.get(f"{_R}id") or "")
        if target:
            order.append(target)
    if not order:   # no slide list: the slide files in number order
        order = sorted((n for n in z.names if re.match(r"^ppt/slides/slide\d+\.xml$", n)),
                       key=lambda n: int(re.findall(r"\d+", n)[-1]))
    parts = []
    size = 0
    for n, path in enumerate(order[:SLIDES_MAX], 1):
        clock.check()
        if not z.has(path):
            continue
        text = _drawing_text(z.xml(path))
        notes = ""
        for target in _rels(z, path).values():
            if "notesSlide" in target and z.has(target):
                notes = _drawing_text(z.xml(target))
                # The notes page repeats the slide number as its own text: drop a bare number.
                notes = "\n".join(l for l in notes.split("\n") if not l.strip().isdigit())
        body = text + (f"\nNotes: {notes}" if notes.strip() else "")
        if body.strip():
            parts.append(Part(body.strip(), f"slide {n}", f"slide={n}"))
            size += len(body)
        if size > MAX_TEXT:
            break
    return parts


# ── Excel ─────────────────────────────────────────────────────────────────────

_S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def _col_index(ref: str) -> int:
    n = 0
    for ch in ref:
        if ch.isalpha():
            n = n * 26 + (ord(ch.upper()) - 64)
        else:
            break
    return max(0, n - 1)


def xlsx_parts(data: bytes, clock: _Clock | None = None) -> list[Part]:
    clock = clock or _Clock()
    z = SafeZip(data)
    if not z.has("xl/workbook.xml"):
        raise Refused("not an Excel workbook")
    shared: list[str] = []
    if z.has("xl/sharedStrings.xml"):
        for si in z.xml("xl/sharedStrings.xml").iter(f"{_S}si"):
            shared.append("".join(t.text or "" for t in si.iter(f"{_S}t")))
            if len(shared) > 500_000:
                break
    wb = z.xml("xl/workbook.xml")
    rels = _rels(z, "xl/workbook.xml")
    sheets = []
    for s in wb.iter(f"{_S}sheet"):
        sheets.append((s.get("name") or "Sheet", rels.get(s.get(f"{_R}id") or "")))
    parts = [Part("Sheets: " + ", ".join(n for n, _ in sheets[:SHEETS_MAX]), None)] if len(sheets) > 1 else []
    size = 0
    for name, path in sheets[:SHEETS_MAX]:
        clock.check()
        if not path or not z.has(path):
            continue
        root = z.xml(path)
        lines = []
        for r_i, row in enumerate(root.iter(f"{_S}row")):
            if r_i >= SHEET_MAX_ROWS:
                lines.append(f"(… more rows)")
                break
            cells: dict[int, str] = {}
            for c in row.iter(f"{_S}c"):
                col = _col_index(c.get("r") or "")
                if col >= SHEET_MAX_COLS:
                    continue
                typ = c.get("t")
                v = c.find(f"{_S}v")
                if typ == "s" and v is not None and (v.text or "").strip().isdigit():
                    k = int(v.text)
                    val = shared[k] if 0 <= k < len(shared) else ""
                elif typ == "inlineStr":
                    val = "".join(t.text or "" for t in c.iter(f"{_S}t"))
                else:
                    val = (v.text or "") if v is not None else ""
                val = re.sub(r"\s+", " ", val).strip()
                if val:
                    cells[col] = val[:200]
            if cells:
                lines.append(" | ".join(cells.get(i, "") for i in range(max(cells) + 1)))
        body = "\n".join(lines)
        if body:
            parts.append(Part(f"Sheet {name}\n{body}", f"sheet {name}"[:80]))
            size += len(body)
        if size > MAX_TEXT:
            break
    return parts


def csv_parts(data: bytes) -> list[Part]:
    text = _decode(data[: MAX_TEXT * 4])
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    lines = []
    try:
        for i, row in enumerate(csv.reader(io.StringIO(text), dialect)):
            if i >= CSV_MAX_ROWS:
                lines.append("(… more rows)")
                break
            cells = [re.sub(r"\s+", " ", c).strip()[:200] for c in row[:SHEET_MAX_COLS]]
            if any(cells):
                lines.append(" | ".join(cells))
    except csv.Error:
        return [Part(text[:MAX_TEXT])]
    return [Part("\n".join(lines), "rows")] if lines else []


# ── PDF ───────────────────────────────────────────────────────────────────────


def pdf_parts(data: bytes, clock: _Clock | None = None) -> list[Part]:
    clock = clock or _Clock()
    try:
        from pypdf import PdfReader
    except ImportError:  # pragma: no cover - pypdf is in requirements.txt
        return []
    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as exc:
        raise Refused("not a readable PDF") from exc
    if reader.is_encrypted:
        raise Refused("encrypted PDF")
    parts, size = [], 0
    for n, page in enumerate(reader.pages, 1):
        if n > PDF_MAX_PAGES:
            break
        clock.check()
        try:
            t = page.extract_text() or ""
        except Exception:
            t = ""
        t = re.sub(r"[ \t]+", " ", t)
        t = re.sub(r"\n{2,}", "\n", t).strip()
        if t:
            parts.append(Part(t, f"page {n}", f"page={n}"))
            size += len(t)
        if size > MAX_TEXT:
            break
    return parts


# ── Captions ──────────────────────────────────────────────────────────────────


def caption_cues(text: str) -> list[dict]:
    """[{t (seconds), speaker, text}] of a WebVTT or SubRip file (meeting_parse's cue reader)."""
    from app.services import meeting_parse as mp

    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    cues = mp._vtt(lines)
    return [c for c in cues if (c.get("text") or "").strip()]


def clock(t: int | None) -> str:
    from app.services import meeting_parse as mp

    return mp.clock(t)


def caption_parts(text: str, *, window_s: int = CAPTION_WINDOW_S) -> list[Part]:
    """Caption cues in windows of ``window_s`` seconds, each labelled with its start ("12:34")."""
    parts: list[Part] = []
    buf: list[str] = []
    start: int | None = None
    size = 0
    for c in caption_cues(text):
        t = int(c.get("t") or 0)
        if start is None:
            start = t
        if buf and t - start >= window_s:
            parts.append(Part(" ".join(buf), clock(start), f"t={start}", start))
            buf, start = [], t
        who = c.get("speaker")
        line = f"{who}: {c['text']}" if who else c["text"]
        buf.append(line)
        size += len(line) + 1
        if size > MAX_TEXT:
            break
    if buf and start is not None:
        parts.append(Part(" ".join(buf), clock(start), f"t={start}", start))
    return parts


def to_vtt(text: str) -> str:
    """A .vtt or .srt file as WebVTT (what the player reads). Refuses text with no cues."""
    t = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    if not caption_cues(t):
        raise Refused("no captions found (expected a .vtt or .srt file)")
    if t.lstrip().startswith("WEBVTT"):
        return t if t.endswith("\n") else t + "\n"
    out = ["WEBVTT", ""]
    for block in re.split(r"\n\s*\n", t.strip()):
        lines = [l for l in block.split("\n")]
        if lines and re.match(r"^\s*\d{1,6}\s*$", lines[0]):
            lines = lines[1:]
        if not lines or "-->" not in lines[0]:
            continue
        lines[0] = re.sub(r"(\d{1,2}:\d{2}:\d{2}),(\d{1,3})", r"\1.\2", lines[0])
        out.append("\n".join(lines))
        out.append("")
    return "\n".join(out)


# ── Everything ────────────────────────────────────────────────────────────────


def _decode(data: bytes) -> str:
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        try:
            return data.decode("utf-16")
        except UnicodeDecodeError:
            pass
    return data.decode("utf-8-sig", "replace")


def extract(data: bytes, mime: str, filename: str | None = None) -> Extracted:
    """The file's text in located parts. Raises :class:`Refused` for what is never read."""
    mime = (mime or "").split(";")[0].strip().lower()
    low = (filename or "").lower()
    clk = _Clock()
    if mime == DOCX or low.endswith(".docx"):
        parts = docx_parts(data, clk)
    elif mime == PPTX or low.endswith(".pptx"):
        parts = pptx_parts(data, clk)
    elif mime == XLSX or low.endswith(".xlsx"):
        parts = xlsx_parts(data, clk)
    elif mime == "text/csv":
        parts = csv_parts(data)
    elif mime == "application/pdf":
        parts = pdf_parts(data, clk)
    elif mime == "text/html":
        parts = [Part(st.html_text(data, MAX_TEXT))]
    elif mime in (VTT, SRT) or low.endswith((".vtt", ".srt")):
        parts = caption_parts(_decode(data[: MAX_TEXT * 4]))
    elif mime in TEXT_MIMES:
        parts = [Part(_decode(data[: MAX_TEXT * 4]))]
    else:
        return Extracted()
    return Extracted(_cap(parts))
