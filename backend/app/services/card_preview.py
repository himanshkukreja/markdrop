"""Card previews: what a card in the workspace listing's Cards view shows of an item.

    POST /api/v1/workspaces/{id}/items/previews {slugs}  ->  {"previews": {slug: Preview}}

The listing asks only for the cards on screen, a few at a time, after the folder has rendered,
so opening a folder never waits for a preview. Every preview is computed for the caller:

* ``locked``    - the caller can't open it now (or it isn't in this workspace, or there is no such
                  item: one answer for all three, so the endpoint is no oracle). The card keeps
                  its plain icon band.
* ``encrypted`` - end-to-end encrypted: the server holds ciphertext and says nothing about it.
* ``pending``   - being made (a first look at a PDF, an image, a video's poster...); ask again.
* ``ok``        - with ``type`` and the fields below; ``type: "none"`` when there is nothing worth
                  showing (audio, a zip, a file type without a preview).

The decision is ``access.can(actor, doc, "read")``, the same as opening the item. A reader who
would be asked for a password, to sign in, or is refused gets ``locked``; a workspace member's
role opens a password-protected item, exactly as it does when they click it.

Nothing here is HTML. Text comes back as plain strings in small typed blocks
(``{"t": "h1"|"h2"|"h3"|"p"|"li"|"todo"|"quote"|"code"|"hr"|"table"|"img", "x": ...}``) that the
app renders as text; a user's HTML file is only ever *live* on the artifact origin (``live``: its
signed URL, for a sandboxed frame there, exactly the URL its own page frames). Pictures (an image,
a PDF's first page, a video's poster frame, a page's uploaded cover) are small WebP thumbnails
made in a child process (``card_preview_proc.py``) and inlined as ``data:`` URIs, so there is no
second request, no bearer URL to leak and nothing for a shared cache to keep.

Pages and Markdown documents are read for the caller as their own embeds are
(``pages.sees_people``, other items' labels left out); files' previews depend only on the file's
bytes and are kept in ``card_previews`` (by the source object and its version) for two weeks.
"""

from __future__ import annotations

import asyncio
import base64
import csv
import hashlib
import html.parser
import io
import json
import logging
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi.concurrency import run_in_threadpool
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import access, publicity

log = logging.getLogger(__name__)

COLL = "card_previews"
SPEC = 2                       # bump to remake every cached file preview
MAX_SLUGS = 12                 # per request
KEEP = timedelta(days=14)      # a cached file preview
KEEP_FAILED = timedelta(hours=1)
WAIT_S = 1.5                   # how long a request waits for new pictures before saying "pending"
PROC_TIMEOUT_S = 15.0
PROC = Path(__file__).with_name("card_preview_proc.py")
_RENDERS: asyncio.Semaphore | None = None  # child processes at once (per API process): 2
_RUNNING: dict[str, asyncio.Task] = {}

# How much of a source is read, by what is made of it.
TEXT_PEEK = 64 * 1024
HTML_PEEK = 160 * 1024
CONTENT_PEEK = 8000            # characters of a document's Markdown
SOURCE_MAX = {"image": 25 * 1024 * 1024, "pdf": 40 * 1024 * 1024, "docx": 20 * 1024 * 1024,
              "pptx": 25 * 1024 * 1024, "xlsx": 20 * 1024 * 1024}
POSTER_MAX = 4 * 1024 * 1024
COVER_MAX = 12 * 1024 * 1024

MAX_BLOCKS = 14
MAX_TEXT = 280
MAX_TOTAL = 1800
CODE_LINES = 6
TEXT_LINES = 16
LINE_CHARS = 140
SHEET_ROWS, SHEET_COLS, CELL = 8, 6, 48

LOCKED = {"state": "locked"}
ENCRYPTED = {"state": "encrypted"}
NONE = {"state": "ok", "type": "none"}

_CTRL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index("expire_at", expireAfterSeconds=0)
    await db[COLL].create_index("doc")


async def forget_document(db: AsyncIOMotorDatabase, doc_id: str) -> None:
    """A document is gone: its cached previews go with it."""
    try:
        await db[COLL].delete_many({"doc": doc_id})
    except Exception:  # pragma: no cover - never fail a delete over this
        log.warning("card previews of %s not dropped", doc_id, exc_info=True)


def _text(s: str | None, n: int = MAX_TEXT) -> str:
    s = _CTRL.sub("", s or "")
    s = re.sub(r"\s+", " ", s).strip()
    if len(s) > n:
        cut = s[:n]
        sp = cut.rfind(" ")
        s = (cut[:sp] if sp > n - 30 else cut).rstrip(" ,.;:") + "…"
    return s


class _Blocks:
    """Collects blocks up to the limits."""

    def __init__(self):
        self.out: list[dict] = []
        self.chars = 0

    @property
    def full(self) -> bool:
        return len(self.out) >= MAX_BLOCKS or self.chars >= MAX_TOTAL

    def add(self, t: str, x: str = "", **extra) -> None:
        if self.full:
            return
        x = _text(x)
        if not x and t not in ("hr", "img", "table"):
            return
        b: dict[str, Any] = {"t": t}
        if x:
            b["x"] = x
        b.update(extra)
        self.out.append(b)
        self.chars += len(x) + 20

    def code(self, text: str, lang: str = "") -> None:
        if self.full:
            return
        lines = [_CTRL.sub("", ln.replace("\t", "  "))[:LINE_CHARS] for ln in text.strip("\n").split("\n")[:CODE_LINES]]
        x = "\n".join(lines).rstrip()
        if not x:
            return
        self.out.append({"t": "code", "x": x, **({"lang": lang} if lang else {})})
        self.chars += len(x) + 20


# -- Markdown (documents and pages) --------------------------------------------

_FENCE_DIRECTIVE = re.compile(r"^\s*:{3,}[A-Za-z]?[\w-]*(?:\[[^\]\n]*\])?(?:\{[^}\n]*\})?\s*$")
_LEAF_DIRECTIVE = re.compile(r"^\s*::[A-Za-z][\w-]*(?:\[[^\]\n]*\])?(?:\{[^}\n]*\})?\s*$")
_INLINE_DIRECTIVE = re.compile(r"(?<![A-Za-z0-9_:\\]):[A-Za-z][\w-]*\[((?:\\.|[^\]\\\n])*)\](?:\{[^}\n]*\})?")
_TASK = re.compile(r"^\[([ xX])\]\s+")
# A block's id at the end of its line (the page editor's "{#b-…}"): never text.
_BLOCK_ID = re.compile(r"\s*\{#b-[A-Za-z0-9_-]+[^}\n]*\}\s*$")
_MD = None


def _md():
    global _MD
    if _MD is None:
        from markdown_it import MarkdownIt

        # html on, so raw HTML becomes html_* tokens, which are dropped (never shown, never rendered).
        _MD = MarkdownIt("commonmark", {"html": True, "linkify": False, "typographer": False}).enable(
            ["table", "strikethrough"])
    return _MD


def _inline_text(tok) -> str:
    parts: list[str] = []
    for c in tok.children or []:
        if c.type in ("text", "code_inline"):
            parts.append(c.content)
        elif c.type in ("softbreak", "hardbreak"):
            parts.append(" ")
    return "".join(parts)


def _only_image(tok) -> bool:
    kids = [c for c in (tok.children or []) if not (c.type == "text" and not c.content.strip())
            and c.type not in ("softbreak", "hardbreak")]
    return bool(kids) and all(c.type == "image" for c in kids)


def markdown_blocks(markdown: str) -> list[dict]:
    """The start of a Markdown document as typed text blocks (no HTML, ever)."""
    lines = []
    for ln in markdown.split("\n"):
        if _FENCE_DIRECTIVE.match(ln) or _LEAF_DIRECTIVE.match(ln):
            continue  # :::callout / ::markdrop{...} / ::toc: fences and embeds, not text
        lines.append(_BLOCK_ID.sub("", ln))
    text = _INLINE_DIRECTIVE.sub(lambda m: m.group(1).replace("\\]", "]"), "\n".join(lines))
    tokens = _md().parse(text)
    out = _Blocks()
    stack: list[str] = []          # enclosing lists and quotes
    ordered: list[int] = []        # the next number of each enclosing list (0: bullets)
    i = 0
    while i < len(tokens) and not out.full:
        tok = tokens[i]
        ty = tok.type
        if ty in ("bullet_list_open", "ordered_list_open"):
            stack.append(ty)
            ordered.append(int(tok.attrGet("start") or 1) if ty == "ordered_list_open" else 0)
        elif ty in ("bullet_list_close", "ordered_list_close"):
            stack.pop()
            ordered.pop()
        elif ty == "blockquote_open":
            stack.append("quote")
        elif ty == "blockquote_close":
            stack.pop()
        elif ty == "heading_open":
            level = int(tok.tag[1:]) if tok.tag[1:].isdigit() else 3
            out.add("h1" if level == 1 else "h2" if level == 2 else "h3", _inline_text(tokens[i + 1]))
            i += 2
        elif ty == "paragraph_open":
            inline = tokens[i + 1]
            if _only_image(inline):
                out.add("img")
            else:
                x = _inline_text(inline)
                lists = [s for s in stack if s.endswith("list_open")]
                depth = {"d": min(len(lists) - 1, 3)} if len(lists) > 1 else {}
                m = _TASK.match(x) if lists else None
                if m:
                    out.add("todo", x[m.end():], done=m.group(1) in "xX", **depth)
                elif lists and lists[-1] == "ordered_list_open":
                    n = ordered[-1]
                    ordered[-1] = n + 1
                    out.add("li", x, n=n, **depth)
                elif lists:
                    out.add("li", x, **depth)
                elif "quote" in stack:
                    out.add("quote", x)
                else:
                    out.add("p", x)
            i += 2
        elif ty in ("fence", "code_block"):
            lang = (tok.info or "").strip().split(" ")[0].lower()[:20]
            if lang in ("mermaid", "math", "latex", "katex"):
                out.add("img", kind="diagram" if lang == "mermaid" else "math")
            else:
                out.code(tok.content, lang)
        elif ty == "hr":
            out.add("hr")
        elif ty == "table_open":
            rows: list[list[str]] = []
            row: list[str] | None = None
            j = i + 1
            while j < len(tokens) and tokens[j].type != "table_close":
                t = tokens[j]
                if t.type == "tr_open":
                    row = []
                elif t.type == "tr_close" and row is not None:
                    if len(rows) < 5:
                        rows.append(row[:4])
                    row = None
                elif t.type == "inline" and row is not None:
                    row.append(_text(_inline_text(t), 40))
                j += 1
            if rows:
                out.add("table", rows=rows)
            i = j
        i += 1
    return out.out


def _cut_lines(text: str, n: int) -> str:
    """At most ``n`` characters, ending at a line break: a mention or an item label is never cut
    in half (their redactions match whole ``:name[label]{...}`` runs, which never span lines)."""
    if len(text) <= n:
        return text
    cut = text[:n]
    nl = cut.rfind("\n")
    return cut[:nl] if nl > 0 else ""


async def _readers_markdown(actor: access.Actor, ctx: access.Ctx, raw: dict, text: str) -> str:
    """The Markdown as this reader may see it, by the rules of a page embed's excerpt
    (services/pages.py): names only inside the page's circle, other items' labels left out."""
    from app.services.page_people import _BARE as _BARE_PERSON
    from app.services.pages import _PERSON, redact_people, sees_people, strip_ref_labels

    if ":person[" in text and not await sees_people(actor, raw, ctx):
        text = redact_people(text) or ""
    text = strip_ref_labels(text) or ""
    return _BARE_PERSON.sub(lambda m: "@" + m.group(1),
                            _PERSON.sub(lambda m: "@" + (m.group(1) or "someone"), text))


async def _cover(db: AsyncIOMotorDatabase, raw: dict, props: dict) -> tuple[dict | None, Any]:
    """A page's cover for its card: a built-in one by name, an https image by URL, or a page image
    as a thumbnail (made like a file's, so it may be on its way: then its task)."""
    v = props.get("cover") or ""
    y = props.get("cover_y", 50)
    if v.startswith("gallery:"):
        return {"gallery": v[8:], "y": y}, None
    if v.startswith("https://"):
        return {"url": v, "y": y}, None
    if v.startswith("asset:"):
        from app.services import page_assets

        row = await db[page_assets.COLL].find_one({"_id": v[6:], "doc_id": str(raw["_id"])}, {"key": 1})
        if not row or not row.get("key"):
            return None, None
        key = _cache_key("cover", row["key"])
        hit = await _cached(db, key)
        if hit is not None:
            return ({"src": hit["src"], "y": y} if hit.get("src") else None), None
        return {"y": y}, _start(db, key, str(raw["_id"]), _make_picture(row["key"], COVER_MAX, "image"))
    return None, None


async def _document(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, raw: dict) -> tuple[dict, Any]:
    from app.services import page_props

    content = _cut_lines(raw.get("content") or "", CONTENT_PEEK)
    page = raw.get("editor") == "blocks"
    props = page_props.parse(content) if page else {}
    _fm, body = page_props.split(content)
    body = await _readers_markdown(actor, ctx, raw, body)
    out: dict[str, Any] = {"state": "ok", "type": "page" if page else "markdown", "blocks": markdown_blocks(body)}
    task = None
    if page:
        icon = props.get("icon")
        if icon and not str(icon).startswith("asset:"):
            out["icon"] = icon
        cover, task = await _cover(db, raw, props)
        if cover:
            out["cover"] = cover
    return out, task


# -- Files ---------------------------------------------------------------------


class _HtmlText(html.parser.HTMLParser):
    """The readable start of an HTML file: headings, paragraphs, list items; its <title> when it
    has no heading up front. Scripts, styles, templates, SVG and embedded frames are skipped."""

    SKIP = {"script", "style", "noscript", "template", "svg", "iframe", "object", "canvas", "select"}
    BLOCK = {"p", "div", "section", "article", "main", "header", "footer", "aside", "li", "ul", "ol",
             "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "table", "tr", "td", "th",
             "dt", "dd", "figcaption", "br", "hr", "nav", "form", "label", "button"}
    KINDS = {"h1": "h1", "h2": "h2", "h3": "h3", "h4": "h3", "h5": "h3", "h6": "h3", "li": "li",
             "blockquote": "quote", "pre": "code"}
    # Tags that sit inside a sentence. Any other tag may be laid out as its own box by the page's
    # CSS (a <b> or <span> styled as a block, a card of divs), so its edges separate words.
    INLINE = {"a", "em", "i", "u", "s", "code", "sub", "sup", "mark", "small", "abbr", "q", "cite",
              "kbd", "var", "wbr", "span", "font"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks = _Blocks()
        self.skip = 0
        self.title = ""
        self.in_title = False
        self.buf: list[str] = []
        self.open: list[str] = []

    def flush(self):
        x = re.sub(r"[ \t]+([.,;:!?)])", r"\1", "".join(self.buf))  # "export ." → "export."
        self.buf = []
        if not x.strip():
            return
        kind = next((self.KINDS[t] for t in reversed(self.open) if t in self.KINDS), "p")
        if kind == "code":
            self.blocks.code(x)
        else:
            self.blocks.add(kind, x)

    def handle_starttag(self, tag, attrs):
        if tag == "title" and not self.title:
            self.in_title = True
        if tag not in self.INLINE and self.buf:
            self.buf.append(" ")
        if tag in self.SKIP:
            self.skip += 1
        elif tag in self.BLOCK and not self.skip:
            self.flush()
            if tag not in ("br", "hr"):
                self.open.append(tag)

    def handle_startendtag(self, tag, attrs):
        if tag in ("br", "hr") and not self.skip:
            self.flush()

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        if tag not in self.INLINE and self.buf:
            self.buf.append(" ")
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
        elif tag in self.BLOCK and not self.skip:
            self.flush()
            if tag in self.open:
                while self.open and self.open.pop() != tag:
                    pass

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        elif not self.skip and not self.blocks.full:
            self.buf.append(data)


def _decode(data: bytes) -> str:
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        try:
            return data.decode("utf-16")
        except UnicodeDecodeError:
            pass
    return data.decode("utf-8-sig", errors="replace")


def html_blocks(data: bytes) -> dict:
    p = _HtmlText()
    try:
        p.feed(_decode(data))
        p.close()
    except Exception:  # pragma: no cover - html.parser is forgiving; a cut-off file is fine
        pass
    p.flush()
    blocks = p.blocks.out
    title = _text(p.title, 120)
    if title and not any(b["t"] == "h1" for b in blocks[:2]):
        blocks = [{"t": "h1", "x": title}, *blocks][:MAX_BLOCKS]
    return {"blocks": blocks} if blocks else {}


def text_lines(data: bytes, mime: str, truncated: bool) -> dict:
    text = _decode(data)
    if mime == "application/json" and not truncated:
        try:
            text = json.dumps(json.loads(text), indent=2, ensure_ascii=False)[:TEXT_PEEK]
        except ValueError:
            pass
    lines = [_CTRL.sub("", ln.replace("\t", "  ").rstrip("\r"))[:LINE_CHARS] for ln in text.split("\n")[:TEXT_LINES]]
    while lines and not lines[-1].strip():
        lines.pop()
    return {"lines": lines} if lines else {}


def csv_rows(data: bytes, truncated: bool) -> dict:
    text = _decode(data)
    if truncated:
        text = text[: text.rfind("\n")] if "\n" in text else ""
    try:
        delim = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|").delimiter
    except csv.Error:
        delim = ","
    rows = []
    try:
        for row in csv.reader(io.StringIO(text), delimiter=delim):
            rows.append([_text(c, CELL) for c in row[:SHEET_COLS]])
            if len(rows) >= SHEET_ROWS:
                break
    except csv.Error:
        pass
    while rows and not any(rows[-1]):
        rows.pop()
    return {"rows": rows} if rows else {}


def _cache_key(what: str, source: str, *version: Any) -> str:
    return hashlib.sha256(json.dumps([SPEC, what, source, *[str(v) for v in version]]).encode()).hexdigest()


async def _cached(db: AsyncIOMotorDatabase, key: str) -> dict | None:
    row = await db[COLL].find_one({"_id": key}, {"payload": 1})
    return row.get("payload") if row else None


async def _store(db: AsyncIOMotorDatabase, key: str, doc_id: str, payload: dict) -> None:
    try:
        await db[COLL].replace_one(
            {"_id": key},
            {"doc": doc_id, "payload": payload, "created_at": now_utc(),
             "expire_at": now_utc() + (KEEP if payload else KEEP_FAILED)},
            upsert=True)
    except Exception:  # pragma: no cover - a cache write never fails a preview
        log.warning("card preview not cached", exc_info=True)


async def run_proc(kind: str, data: bytes) -> dict:
    """``card_preview_proc.py <kind>`` on ``data``: its JSON, or {} (it failed, or timed out)."""
    global _RENDERS
    if _RENDERS is None:
        _RENDERS = asyncio.Semaphore(2)
    async with _RENDERS:
        try:
            p = await asyncio.create_subprocess_exec(
                sys.executable, "-I", str(PROC), kind,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL)
        except Exception:  # pragma: no cover
            log.warning("card preview process didn't start", exc_info=True)
            return {}
        try:
            out, _ = await asyncio.wait_for(p.communicate(data), PROC_TIMEOUT_S)
        except asyncio.TimeoutError:
            p.kill()
            await p.wait()
            return {}
        if p.returncode != 0:
            return {}
        try:
            res = json.loads(out or b"{}")
        except ValueError:
            return {}
        return res if isinstance(res, dict) else {}


def _picture(res: dict) -> dict:
    """The child's output as a payload (the thumbnail as a data: URI)."""
    out: dict[str, Any] = {}
    thumb = res.get("thumb")
    if isinstance(thumb, str) and thumb:
        try:
            base64.b64decode(thumb, validate=True)
            out["src"] = "data:image/webp;base64," + thumb
            out["w"], out["h"] = int(res.get("w") or 0), int(res.get("h") or 0)
        except ValueError:
            pass
    if isinstance(res.get("pages"), int):
        out["pages"] = res["pages"]
    if isinstance(res.get("blocks"), list):
        blocks = [{"t": b.get("t") if b.get("t") in ("h1", "h2", "h3", "p", "li") else "p",
                   "x": _text(str(b.get("x") or ""))}
                  for b in res["blocks"][:MAX_BLOCKS] if isinstance(b, dict) and b.get("x")]
        if blocks:
            out["blocks"] = blocks
    if isinstance(res.get("rows"), list):
        rows = [[_text(str(c), CELL) for c in r[:SHEET_COLS]] for r in res["rows"][:SHEET_ROWS] if isinstance(r, list)]
        if rows:
            out["rows"] = rows
    return out


def _make_picture(key: str, cap: int, proc_kind: str):
    async def make() -> dict:
        from app.services import r2

        data = await run_in_threadpool(r2.get_bytes, key, cap + 1)
        if not data or len(data) > cap:
            return {}
        return _picture(await run_proc(proc_kind, data))

    return make


def _start(db: AsyncIOMotorDatabase, key: str, doc_id: str, make) -> asyncio.Task:
    """Make and cache a file preview (once per process at a time); the task's result is the payload.
    It outlives the request that started it: the next ask finds it in the cache."""
    task = _RUNNING.get(key)
    if task is not None and not task.done():
        return task

    async def run() -> dict:
        try:
            payload = await make()
        except Exception:
            log.warning("card preview failed", exc_info=True)
            payload = {}
        await _store(db, key, doc_id, payload)
        return payload

    task = asyncio.get_running_loop().create_task(run())
    _RUNNING[key] = task
    task.add_done_callback(lambda t: _RUNNING.pop(key, None) if _RUNNING.get(key) is t else None)
    return task


def _file_plan(raw: dict):
    """(what, source key, maker) for an artifact's preview, or None when it has none."""
    from app.services import artifact as art_service
    from app.services import r2

    mime = raw.get("mime") or ""
    renderer = art_service.renderer_for(mime)
    blob = raw.get("blob_key")
    size = int(raw.get("size_bytes") or 0)

    def peek(cap: int, fn):
        async def make() -> dict:
            data = await run_in_threadpool(r2.get_bytes, blob, cap + 1)
            if not data:
                return {}
            return fn(data[:cap], len(data) > cap or size > cap)
        return make

    if renderer == "video":
        poster = raw.get("poster_key")
        return ("video", poster, _make_picture(poster, POSTER_MAX, "image")) if poster else None
    if not blob:
        return None
    if renderer == "html":
        return "html", blob, peek(HTML_PEEK, lambda d, _t: html_blocks(d))
    if renderer == "text":
        return "text", blob, peek(TEXT_PEEK, lambda d, t: text_lines(d, mime, t))
    if renderer == "sheet" and mime == "text/csv":
        return "sheet", blob, peek(TEXT_PEEK, csv_rows)
    proc_kind = None
    if renderer == "image" and mime != "image/svg+xml":
        proc_kind = "image"  # an SVG is never rasterised here, nor shown in the app's origin
    elif renderer == "pdf":
        proc_kind = "pdf"
    elif renderer == "docx":
        proc_kind = "docx"
    elif renderer == "pptx":
        proc_kind = "pptx"
    elif renderer == "sheet" and mime.endswith(".sheet"):
        proc_kind = "xlsx"  # a legacy .xls has no preview
    if proc_kind is None or size > SOURCE_MAX[proc_kind]:
        return None
    return renderer, blob, _make_picture(blob, SOURCE_MAX[proc_kind], proc_kind)


async def _file(db: AsyncIOMotorDatabase, raw: dict) -> tuple[dict, Any]:
    from app.services import artifact as art_service

    mime = raw.get("mime") or ""
    renderer = art_service.renderer_for(mime)
    base: dict[str, Any] = {"state": "ok", "type": renderer}
    media = raw.get("media")
    if renderer == "video" and isinstance(media, dict) and media.get("duration_s"):
        base["duration"] = round(float(media["duration_s"]), 1)
    if renderer in ("html", "bundle"):
        # The live render: the URL the item's own page frames (signed unless the bytes are
        # public), for a sandboxed frame on the artifact origin, a few at a time, on hover.
        urls = publicity.byte_urls(raw, public=await publicity.doc_is_public(db, raw))
        if urls.get("artifact_url"):
            base["live"] = urls["artifact_url"]
            base["live_ttl"] = publicity.ttl_for(mime)
    plan = _file_plan(raw)
    if plan is None:
        return (base if base.get("live") else {**NONE, "type": renderer}), None
    what, source, make = plan
    key = _cache_key(what, source, raw.get("file_version"), raw.get("sha256"), raw.get("size_bytes"),
                     raw.get("file_updated_at"))
    hit = await _cached(db, key)
    if hit is not None:
        return with_payload(base, hit), None
    return base, _start(db, key, str(raw["_id"]), make)


def with_payload(base: dict, payload: dict) -> dict:
    out = {**base, **{k: v for k, v in payload.items() if k in ("src", "w", "h", "pages", "blocks", "rows", "lines")}}
    if not any(k in out for k in ("src", "blocks", "rows", "lines", "live")):
        return {**NONE, "type": base.get("type") or "none"}
    return out


# -- The batch -----------------------------------------------------------------


async def _load(db: AsyncIOMotorDatabase, workspace_id: str | None, slugs: list[str]) -> dict[str, dict]:
    """The rows (in this workspace only; ``None``: wherever they are, the home's "Continue" cards),
    everything a read decision needs, and of a document's body only its first characters: a long
    document never crosses the wire whole."""
    match: dict = {"slug": {"$in": slugs}, "deleted_at": None}
    if workspace_id is not None:
        match = {"slug": {"$in": slugs}, "workspace_id": workspace_id}
    pipeline = [
        {"$match": match},
        {"$addFields": {"content": {"$cond": [
            {"$eq": [{"$type": "$content"}, "string"]},
            {"$substrCP": ["$content", 0, CONTENT_PEEK + 1]}, None]}}},
    ]
    rows = await db["documents"].aggregate(pipeline).to_list(length=len(slugs))
    return {r["slug"]: r for r in rows}


async def previews(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, workspace_id: str | None,
                   slugs: list[str], *, wait: float = WAIT_S) -> dict[str, dict]:
    """``{slug: preview}`` for ``slugs``; past the first MAX_SLUGS they answer ``locked``."""
    from app.services.pages import SLUG_RE

    asked = list(dict.fromkeys(s for s in slugs if isinstance(s, str)))
    valid = [s for s in asked[:MAX_SLUGS] if SLUG_RE.match(s)]
    rows = await _load(db, workspace_id, valid) if valid else {}
    out: dict[str, dict] = {s: dict(LOCKED) for s in asked}
    waiting: dict[str, tuple[dict, asyncio.Task]] = {}
    for slug in valid:
        raw = rows.get(slug)
        if raw is None or not (await access.can(actor, raw, "read", ctx)).allowed:
            continue
        if raw.get("encrypted"):
            out[slug] = dict(ENCRYPTED)
            continue
        try:
            if raw.get("kind") == "artifact":
                res, task = await _file(db, raw)
            else:
                res, task = await _document(db, actor, ctx, raw)
        except Exception:
            log.warning("card preview of %s failed", slug, exc_info=True)
            res, task = dict(NONE), None
        out[slug] = res
        if task is not None:
            waiting[slug] = (res, task)
    if waiting:
        await asyncio.wait({t for _r, t in waiting.values()}, timeout=max(0.0, wait))
        for slug, (res, task) in waiting.items():
            if not task.done():
                out[slug] = {**res, "state": "pending"}
                continue
            payload = (task.result() or {}) if not task.cancelled() and task.exception() is None else {}
            if res.get("type") == "page":
                if payload.get("src"):
                    res["cover"] = {**res.get("cover", {}), "src": payload["src"]}
                else:
                    res.pop("cover", None)
                out[slug] = res
            else:
                out[slug] = with_payload(res, payload)
    return out


# -- For AI apps (MCP list_workspace_items with previews) ----------------------


def as_text(p: dict, limit: int = 400) -> str | None:
    """A preview as a line or two of plain text, or None when it has no text."""
    state = p.get("state")
    if state == "encrypted":
        return "(end-to-end encrypted: no preview)"
    if state not in ("ok", "pending"):
        return None
    parts: list[str] = []
    for b in p.get("blocks") or []:
        if b.get("t") == "table":
            parts.extend(" | ".join(r) for r in b.get("rows") or [])
        elif b.get("t") == "todo":
            parts.append(("[x] " if b.get("done") else "[ ] ") + (b.get("x") or ""))
        elif b.get("x"):
            parts.append(("- " if b["t"] == "li" else "") + b["x"])
    for r in p.get("rows") or []:
        parts.append(" | ".join(r))
    parts.extend(p.get("lines") or [])
    text = " / ".join(x for x in parts if x.strip())
    if not text:
        return None
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"
