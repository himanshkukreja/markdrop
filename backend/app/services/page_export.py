"""Exporting a page: portable Markdown, one self-contained HTML file, or a .zip.

``GET /api/v1/documents/{slug}/export`` (routers/page_export.py) and the MCP tool
``export_page`` both come here. The caller is already past ``can(read)`` on the
page; :func:`check_allowed` then says whether they may export it (editors always;
readers unless the page's ``allow_export: false``).

What a reader can't open never leaves in an export: the Markdown is the one
``pages.content_for`` gives this reader (person names and the labels of items
they can't open already emptied), embeds, mentions and sub-page links are
resolved for them (``pages.resolve_embeds``: anything not "ok" carries no
title), and a sub-page is included only when they can read it.

The page Markdown (GitHub Markdown plus directives) is read as blocks:

* containers ``:::name[label]{attrs}`` … ``:::`` (callouts, toggles, columns,
  indent, buttons), nested by their number of colons;
* leaves ``::name[label]{attrs}`` (Markdrop items, sub-pages, bookmarks, web
  embeds, contents, breadcrumbs);
* everything else is Markdown, whose inline directives (``:span``, ``:u``,
  ``:kbd``, ``:date``, ``:person``, ``:markdrop``), block options (``{#b-… color
  bg …}``) and page images are rewritten line by line, code left alone.

To Markdown, each becomes something any Markdown app reads: callouts are
labelled blockquotes, columns follow one another, chips are text, items are
links ("Locked item" when the reader can't open them), images point into
``images/`` (zip) or at their public address. To HTML, the same blocks become
the page's own look (markdown-it renders the Markdown with raw HTML off: an
author's ``<script>`` is text), inside a page with inline CSS and a Content
Security Policy that runs no script but the export's own (KaTeX and Mermaid
from jsDelivr, only when the page has math or diagrams; offline the source shows).
"""

from __future__ import annotations

import base64
import html
import io
import posixpath
import re
import secrets
import time
import unicodedata
import zipfile
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Callable, Iterator

from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.services import access, page_assets, page_props, pages, publicity, r2

# ── Limits ────────────────────────────────────────────────────────────────────

MAX_PAGES = 200                       # a page and its sub-pages in one zip
MAX_ZIP_IMAGE_BYTES = 200 * 1024 * 1024
MAX_INLINE_IMAGE_BYTES = 25 * 1024 * 1024   # data: URIs in one HTML file
MAX_INLINE_ONE = 8 * 1024 * 1024
MAX_IMAGES_PER_PAGE = page_assets.MAX_PER_PAGE
TOKEN_TTL = 600
TOKEN_PURPOSE = "page-export"
FORMATS = ("md", "html", "zip")

KATEX = "https://cdn.jsdelivr.net/npm/katex@0.16.22/dist"
MERMAID = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs"


class ExportError(pages.PageError):
    """A refusal with a code: answered as ``{detail, code}`` (main.py's PageError handler)."""

    def __init__(self, status_code: int, detail: str, code: str):
        super().__init__(status_code, {"detail": detail, "code": code})
        self.code = code
        self.message = detail


ENCRYPTED = ("This document is end-to-end encrypted, so Markdrop's servers can't read it to export it. "
             "Open it in your browser and use Download Markdown in its ⋯ menu.")
NOT_MARKDOWN = "Only pages and Markdown documents can be exported. Download a file from its own page."
EXPORT_OFF = "The page's editors turned off exporting for readers."


# ── Who may export ────────────────────────────────────────────────────────────


def allows_readers(markdown: str | None) -> bool:
    return bool(page_props.parse(markdown).get("allow_export", True))


async def check_allowed(actor: access.Actor, raw: dict, ctx: access.Ctx) -> bool:
    """None, or raises. The caller is past can(read). Returns whether they can edit it."""
    if raw.get("encrypted"):
        raise ExportError(422, ENCRYPTED, "encrypted")
    if raw.get("kind") == "artifact":
        raise ExportError(422, NOT_MARKDOWN, "not_markdown")
    editor = await is_editor(actor, raw, ctx)
    if not editor and not allows_readers(raw.get("content")):
        raise ExportError(403, EXPORT_OFF, "export_off")
    return editor


async def is_editor(actor: access.Actor, raw: dict, ctx: access.Ctx) -> bool:
    """Can this person edit the page? An AI app's read-only token still exports as the
    person it acts for (exporting writes nothing)."""
    if actor.cred == "mcp":
        from dataclasses import replace

        actor = replace(actor, scopes=frozenset({*actor.scopes, access.MCP_WRITE}))
    return (await access.can(actor, raw, "edit_content", ctx)).allowed


# ── Small helpers ─────────────────────────────────────────────────────────────


def esc(v: Any) -> str:
    return html.escape("" if v is None else str(v), quote=True)


_UNSAFE_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f]+')


def safe_name(title: str | None, fallback: str = "page", limit: int = 80) -> str:
    """A file or folder name every OS accepts, from a title."""
    t = unicodedata.normalize("NFC", (title or "").strip())
    t = _UNSAFE_NAME.sub(" ", t)
    t = re.sub(r"\s+", " ", t).strip(" .")
    if not t or t.upper() in {"CON", "PRN", "AUX", "NUL", "COM1", "LPT1"}:
        t = fallback
    return t[:limit].rstrip(" .") or fallback


def ascii_name(name: str) -> str:
    a = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    a = re.sub(r"[^A-Za-z0-9._ -]+", "", a).strip() or "page"
    return a


def content_disposition(filename: str) -> str:
    from urllib.parse import quote

    return f'attachment; filename="{ascii_name(filename)}"; filename*=UTF-8\'\'{quote(filename, safe="")}'


def slugify(text: str) -> str:
    """GitHub's heading ids (lowercase, punctuation dropped, spaces to hyphens)."""
    t = re.sub(r"<[^>]+>", "", text or "")
    t = html.unescape(t).strip().lower()
    t = re.sub(r"[^\w\- ]+", "", t, flags=re.UNICODE)
    return t.replace(" ", "-") or "section"


def fmt_date(iso: str) -> str:
    try:
        d = date.fromisoformat(iso.strip())
    except ValueError:
        return iso
    return f"{d.strftime('%b')} {d.day}, {d.year}"


def md_text(s: str) -> str:
    """Text safe inside Markdown link text."""
    return re.sub(r"([\\\[\]*_`<>])", r"\\\1", (s or "").replace("\n", " ")).strip()


def md_url(u: str) -> str:
    return f"<{u}>" if re.search(r"[\s()<>]", u) else u


def is_https(u: str | None) -> bool:
    return bool(u) and bool(re.match(r"^https://[^\s\"'<>]+$", u or "")) and len(u or "") <= 2048


def is_web(u: str | None) -> bool:
    return bool(u) and bool(re.match(r"^https?://[^\s\"'<>]+$", u or "")) and len(u or "") <= 2048


# ── Directive syntax ─────────────────────────────────────────────────────────

_FENCE_OPEN = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
_CONTAINER = re.compile(r"^ {0,3}(:{3,})([A-Za-z][\w-]*)(.*)$")
_CLOSE = re.compile(r"^ {0,3}(:{3,})[ \t]*$")
_LEAF = re.compile(r"^ {0,3}::([A-Za-z][\w-]*)(.*)$")
_DATTR = re.compile(r"""\s*(?:#([^\s"'=<>`{}#.]+)|\.([^\s"'=<>`{}#.]+)|([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`{}]+)))?)""")


def _unent(v: str) -> str:
    return pages._unescape(v)


def scan_label(s: str, i: int) -> tuple[str, int] | None:
    """``[label]`` starting at s[i] == "[": (label, index after "]"), brackets nested, \\-escapes."""
    if i >= len(s) or s[i] != "[":
        return None
    depth = 0
    j = i
    while j < len(s):
        c = s[j]
        if c == "\\" and j + 1 < len(s):
            j += 2
            continue
        if c == "\n":
            return None
        if c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                return s[i + 1:j], j + 1
        j += 1
    return None


def parse_dattrs(inner: str) -> dict | None:
    """remark-directive's attributes: ``#id .class key="v" key='v' key=v key``."""
    out: dict[str, str] = {}
    s = inner
    pos = 0
    while pos < len(s):
        if s[pos:].strip() == "":
            break
        m = _DATTR.match(s, pos)
        if not m or m.end() == pos:
            return None
        if m.group(1):
            out["id"] = m.group(1)
        elif m.group(2):
            out["class"] = (out.get("class", "") + " " + m.group(2)).strip()
        else:
            val = next((g for g in (m.group(4), m.group(5), m.group(6)) if g is not None), "")
            out[m.group(3)] = _unent(val)
        pos = m.end()
    return out


def parse_rest(rest: str) -> tuple[str | None, dict] | None:
    """What follows a directive's name: ``[label]`` and/or ``{attrs}``, then only spaces."""
    i = 0
    label = None
    attrs: dict = {}
    if rest[i:i + 1] == "[":
        lab = scan_label(rest, i)
        if lab is None:
            return None
        label, i = lab
    if rest[i:i + 1] == "{":
        j = rest.find("}", i)
        if j < 0:
            return None
        a = parse_dattrs(rest[i + 1:j])
        if a is None:
            return None
        attrs = a
        i = j + 1
    if rest[i:].strip():
        return None
    return label, attrs


@dataclass
class Block:
    kind: str                       # "md" | "container" | "leaf"
    name: str = ""
    label: str | None = None
    attrs: dict = field(default_factory=dict)
    children: list["Block"] = field(default_factory=list)
    text: str = ""
    colons: int = 0


def _fence_closes(line: str, fence: tuple[str, int]) -> bool:
    m = re.match(r"^ {0,3}(`{3,}|~{3,})[ \t]*$", line)
    return bool(m) and m.group(1)[0] == fence[0] and len(m.group(1)) >= fence[1]


def parse_blocks(markdown: str) -> list[Block]:
    root = Block("container", "root")
    stack: list[Block] = [root]
    buf: list[str] = []
    fence: tuple[str, int] | None = None

    def flush() -> None:
        if buf:
            text = "\n".join(buf)
            if text.strip():
                stack[-1].children.append(Block("md", text=text))
            buf.clear()

    for line in markdown.split("\n"):
        if fence:
            buf.append(line)
            if _fence_closes(line, fence):
                fence = None
            continue
        f = _FENCE_OPEN.match(line)
        if f and not (f.group(1)[0] == "`" and "`" in f.group(2)):
            fence = (f.group(1)[0], len(f.group(1)))
            buf.append(line)
            continue
        c = _CONTAINER.match(line)
        if c:
            rest = parse_rest(c.group(3))
            if rest is not None:
                flush()
                node = Block("container", c.group(2), rest[0], rest[1], colons=len(c.group(1)))
                stack[-1].children.append(node)
                stack.append(node)
                continue
        e = _CLOSE.match(line)
        if e and len(stack) > 1 and len(e.group(1)) >= stack[-1].colons:
            flush()
            stack.pop()
            continue
        lf = _LEAF.match(line)
        if lf and not line.lstrip().startswith(":::"):
            rest = parse_rest(lf.group(2))
            if rest is not None:
                flush()
                stack[-1].children.append(Block("leaf", lf.group(1), rest[0], rest[1], text=line))
                continue
        buf.append(line)
    flush()
    return root.children


# ── Block options: {#b-… color="red" …} ──────────────────────────────────────

COLORS = ("gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red")
_ANCHOR = re.compile(r"^b-[a-z0-9]{4,12}$")
_VALUE_OK: dict[str, Callable[[str], bool]] = {
    "id": lambda v: bool(_ANCHOR.match(v)),
    "color": lambda v: v in COLORS,
    "bg": lambda v: v in COLORS,
    "width": lambda v: bool(re.match(r"^(?:100|[1-9]\d?(?:\.\d)?)%$", v)),
    "align": lambda v: v in ("left", "center", "right"),
    "widths": lambda v: bool(re.match(r"^\d{1,4}(?:,\d{0,4})*$", v)),
    "header-column": lambda v: v == "",
    "header-row": lambda v: v == "off",
    "caption": lambda v: "\n" not in v and "\r" not in v,
}
BLOCK_KEYS = {
    "paragraph": ("id", "color", "bg"),
    "cell": ("bg", "color"),
    "figure": ("id", "width", "align"),
    "line": ("id", "widths", "header-column", "header-row", "caption"),
}


def parse_attr_list(inner: str, kind: str) -> dict | None:
    """The editor's attribute list (docs-editor/core/attrs.mjs parseAttrList), or None."""
    allowed = BLOCK_KEYS[kind]
    if re.search(r"[\\&]", inner):
        return None
    s = inner.strip()
    if not s:
        return None
    out: dict[str, str] = {}
    while s:
        m = re.match(r"^#([^\s\"'=<>`{}]+)", s)
        if m:
            key, value = "id", m.group(1)
        else:
            m = re.match(r'^([a-z][a-z-]*)="([^"]*)"', s) or re.match(r"^([a-z][a-z-]*)=([^\s\"'=<>`{}]+)", s)
            if m:
                key, value = m.group(1), m.group(2)
            else:
                m = re.match(r"^([a-z][a-z-]*)(?=\s|$)", s)
                if not m:
                    return None
                key, value = m.group(1), ""
        if key not in allowed or key in out or not _VALUE_OK[key](value):
            return None
        out[key] = value
        s = s[m.end():]
        if s and not s[0].isspace():
            return None
        s = s.lstrip()
    return out


_TRAIL = re.compile(r"([ \t]*)\{([^{}\n]*)\}[ \t]*$")
_CELL_ATTR = re.compile(r"[ \t]*\{([^{}\n|]*)\}(?=[ \t]*\|)")
_ATTR_LINE = re.compile(r"^[ \t]*\{([^{}\n]*)\}[ \t]*$")
_IMAGE = re.compile(r"!\[((?:\\.|[^\]\\\n])*)\]\(\s*<?([^\s)>]+)>?(?:\s+\"((?:\\.|[^\"\\\n])*)\")?\s*\)(\{[^{}\n]*\})?")
_CODE_SPAN = re.compile(r"(`+)(?!`)(.+?)(?<!`)\1(?!`)")
_INLINE_NAMES = ("markdrop", "person", "date", "kbd", "span", "u")


# ── The context an export is made in ─────────────────────────────────────────


@dataclass
class Image:
    asset_id: str
    key: str
    mime: str
    ext: str
    path: str | None = None          # in the zip: images/<file>
    data_uri: str | None = None      # in one HTML file
    size: int = 0


@dataclass
class PageCtx:
    """Everything one page's conversion needs, resolved for the exporter."""

    slug: str
    title: str
    url: str
    props: dict
    embeds: dict[str, dict]
    images: dict[str, Image]
    public: bool
    public_urls: dict[str, str]
    crumbs: list[dict]
    links: dict[str, str] = field(default_factory=dict)    # slug → relative path inside the zip
    children: list[dict] = field(default_factory=list)      # included sub-pages: {title, path}
    mode: str = "single"            # "single" | "zip"
    notes: list[str] = field(default_factory=list)


def _item_icon(e: dict) -> str:
    r = e.get("renderer") or ""
    return {"markdown": "📄", "pdf": "📕", "video": "🎬", "audio": "🎧", "image": "🖼️", "sheet": "📊",
            "html": "🌐", "bundle": "🌐", "docx": "📘", "pptx": "📙", "text": "📃"}.get(r, "📎" if e.get("kind") == "artifact" else "📄")


def _item_kind(e: dict) -> str:
    r = e.get("renderer") or ""
    return {"markdown": "Document", "pdf": "PDF", "video": "Video", "audio": "Audio", "image": "Image",
            "sheet": "Spreadsheet", "html": "HTML page", "bundle": "Website", "docx": "Word document",
            "pptx": "PowerPoint deck", "text": "Text file"}.get(r, "File" if e.get("kind") == "artifact" else "Document")


LOCKED = "Locked item"


# ── Markdown chunks: line by line ────────────────────────────────────────────


class Inline:
    """Rewrites the inline syntax of Markdown lines for one output (md or html)."""

    def __init__(self, pc: PageCtx, out: str, md=None):
        self.pc = pc
        self.out = out
        self.md = md
        self.slots: dict[str, str] = {}
        self.attrs: dict[str, dict] = {}
        self.figures: dict[str, str] = {}   # slot → its HTML when it is a paragraph of its own
        self._n = 0

    def slot(self, value: str, kind: str = "D") -> str:
        self._n += 1
        k = f"\ue000{kind}{self._n}\ue001"
        self.slots[k] = value
        return k

    # Images ------------------------------------------------------------------

    def image_src(self, src: str) -> tuple[str | None, bool]:
        """(the address to use, whether it's this page's image)."""
        aid = None
        m = re.match(r"^asset\\?:([A-Za-z0-9_-]{8,64})$", src)
        if m:
            aid = m.group(1)
        if aid is None:
            if self.out == "html":
                return (src if is_https(src) else None), False
            return (src if is_web(src) else None), False
        img = self.pc.images.get(aid)
        if img is None:
            return None, True
        if self.pc.mode == "zip" and img.path:
            return img.path, True
        if self.out == "html" and img.data_uri:
            return img.data_uri, True
        if self.pc.public and aid in self.pc.public_urls:
            return self.pc.public_urls[aid], True
        return None, True

    def image(self, m: re.Match) -> str:
        alt = re.sub(r"\\(.)", r"\1", m.group(1) or "")
        cap = re.sub(r"\\(.)", r"\1", m.group(3) or "") if m.group(3) is not None else None
        fig = parse_attr_list(m.group(4)[1:-1], "figure") if m.group(4) else None
        src, _own = self.image_src(m.group(2))
        if self.out == "md":
            if not src:
                return f"_[Image: {md_text(alt) or 'image'}]_"
            title = f' "{cap.replace(chr(34), chr(39))}"' if cap else ""
            return f"![{md_text(alt)}]({md_url(src)}{title})" + ("" if m.group(4) and fig else (m.group(4) or ""))
        style = []
        if fig and fig.get("width"):
            style.append(f"--w:{fig['width']}")
        align = fig.get("align") if fig else None
        if not src:
            body = f'<span class="img-missing">🖼️ {esc(alt or "Image")}</span>'
        else:
            body = f'<img src="{esc(src)}" alt="{esc(alt)}"' + (f' title="{esc(cap)}"' if cap else "") + ">"
        figure = (f'<figure class="figure"' + (f' style="{esc(";".join(style))}"' if style else "")
                  + (f' data-align="{esc(align)}"' if align else "") + f">{body}"
                  + (f"<figcaption>{esc(cap)}</figcaption>" if cap else "") + "</figure>")
        inline = (f'<img class="inline-img" src="{esc(src)}" alt="{esc(alt)}">' if src
                  else f'<span class="img-missing">🖼️ {esc(alt or "Image")}</span>')
        k = self.slot(inline, "I")
        self.figures[k] = figure
        return k

    # Inline directives -------------------------------------------------------

    def label_html(self, label: str) -> str:
        sub = Inline(self.pc, "html", self.md)
        text = sub.line(label, attrs=False)
        rendered = self.md.renderInline(text) if self.md is not None else esc(text)
        return sub.fill(rendered)

    def directive(self, name: str, label: str, attrs: dict, source: str) -> str | None:
        pc = self.pc
        if name == "markdrop":
            slug = pages.slug_of_src(attrs.get("src"))
            e = pc.embeds.get(slug or "") or {"state": "missing"}
            if e.get("state") != "ok":
                return f"*{LOCKED}*" if self.out == "md" else self.slot(
                    f'<span class="chip locked">🔒 {LOCKED}</span>')
            title = e.get("title") or slug
            href = pc.links.get(slug or "") or e.get("url") or ""
            if self.out == "md":
                return f"[{md_text(title)}]({md_url(href)})"
            return self.slot(f'<a class="chip" href="{esc(href)}">{_item_icon(e)} {esc(title)}</a>')
        if name == "person":
            who = label.strip()
            if self.out == "md":
                return f"@{md_text(who)}" if who else "a person"
            return self.slot(f'<span class="chip person">{"@" + esc(who) if who else "a person"}</span>')
        if name == "date":
            d = label.strip()
            if not re.match(r"^\d{4}-\d{2}-\d{2}$", d):
                return None
            if self.out == "md":
                return fmt_date(d)
            return self.slot(f'<time class="chip date" datetime="{esc(d)}">{esc(fmt_date(d))}</time>')
        if not label:
            return None
        if name == "kbd":
            plain = re.sub(r"\\(.)", r"\1", label)
            if self.out == "md":
                tick = "``" if "`" in plain else "`"
                return f"{tick}{plain}{tick}"
            return self.slot(f"<kbd>{esc(plain)}</kbd>")
        if name == "span":
            keys = [k for k in attrs if k in ("color", "bg")]
            if len(attrs) != 1 or len(keys) != 1 or attrs[keys[0]] not in COLORS:
                return None
            if self.out == "md":
                return self.directives(label)
            return self.slot(f'<span data-{keys[0]}="{esc(attrs[keys[0]])}">{self.label_html(label)}</span>')
        if name == "u":
            if attrs:
                return None
            return self.directives(label) if self.out == "md" else self.slot(f"<u>{self.label_html(label)}</u>")
        return None

    def directives(self, text: str) -> str:
        out: list[str] = []
        i = 0
        n = len(text)
        while i < n:
            j = text.find(":", i)
            if j < 0:
                out.append(text[i:])
                break
            out.append(text[i:j])
            prev = text[j - 1] if j > 0 else ""
            m = re.match(r":(" + "|".join(_INLINE_NAMES) + r")(?=\[)", text[j:])
            if not m or prev == ":" or prev.isalnum() or prev == "_":
                out.append(":")
                i = j + 1
                continue
            name = m.group(1)
            k = j + len(m.group(0))
            lab = scan_label(text, k)
            if lab is None:
                out.append(":")
                i = j + 1
                continue
            label, k = lab
            attrs: dict = {}
            if text[k:k + 1] == "{":
                end = text.find("}", k)
                parsed = parse_dattrs(text[k + 1:end]) if end > 0 else None
                if parsed is not None:
                    attrs = parsed
                    k = end + 1
            repl = self.directive(name, label, attrs, text[j:k])
            if repl is None:
                out.append(text[j:k])
            else:
                out.append(repl)
            i = k
        return "".join(out)

    # A line --------------------------------------------------------------------

    def line(self, line: str, *, attrs: bool = True) -> str:
        # Inline code is left exactly as written.
        codes: list[str] = []

        def keep(m: re.Match) -> str:
            codes.append(m.group(0))
            return f"\ue002{len(codes) - 1}\ue003"

        s = _CODE_SPAN.sub(keep, line)
        s = _IMAGE.sub(self.image, s)
        s = self.directives(s)
        if attrs:
            if s.lstrip().startswith("|"):
                def cell(m: re.Match) -> str:
                    a = parse_attr_list(m.group(1), "cell")
                    if a is None:
                        return m.group(0)
                    return "" if self.out == "md" else " " + self._attr_slot(a)
                s = _CELL_ATTR.sub(cell, s)
            t = _TRAIL.search(s)
            if t and not (t.start(1) > 0 and s[t.start(1) - 1] == "\\"):
                a = parse_attr_list(t.group(2), "paragraph")
                body = s[:t.start()]
                if a is not None and body.strip() and not re.fullmatch(r"\s*(?:[-*+]|\d+[.)]|>|#{1,6})?\s*(?:\[[ xX]\])?\s*", body):
                    s = body if self.out == "md" else body + " " + self._attr_slot(a)
        return re.sub(r"\ue002(\d+)\ue003", lambda m: codes[int(m.group(1))], s)

    def _attr_slot(self, a: dict) -> str:
        self._n += 1
        k = f"\ue000A{self._n}\ue001"
        self.attrs[k] = a
        return k

    def chunk(self, text: str) -> str:
        """A Markdown chunk with its inline syntax rewritten (fenced code untouched)."""
        out: list[str] = []
        fence: tuple[str, int] | None = None
        for line in text.split("\n"):
            if fence:
                out.append(line)
                if _fence_closes(line, fence):
                    fence = None
                continue
            f = _FENCE_OPEN.match(line)
            if f and not (f.group(1)[0] == "`" and "`" in f.group(2)):
                fence = (f.group(1)[0], len(f.group(1)))
                out.append(line)
                continue
            al = _ATTR_LINE.match(line)
            if al:
                a = parse_attr_list(al.group(1), "line")
                if a is not None:
                    cap = a.get("caption")
                    if self.out == "md":
                        out.append(f"*{md_text(cap)}*" if cap else "")
                    elif cap:
                        k = self.slot(esc(cap), "C")
                        self.figures[k] = f'<p class="caption">{esc(cap)}</p>'
                        out.append("\n" + k + "\n")
                    else:
                        out.append("")
                    continue
            out.append(self.line(line))
        return "\n".join(out)

    def fill(self, rendered: str) -> str:
        """Put the HTML of every slot into rendered HTML."""
        for k, fig in self.figures.items():
            rendered = rendered.replace(f"<p>{k}</p>", fig)
        if self.attrs:
            rendered = _apply_attrs(rendered, self.attrs)
        rendered = re.sub("\ue000[A-Z]\\d+\ue001", lambda m: self.slots.get(m.group(0), ""), rendered)
        return re.sub("[\ue000-\ue003]", "", rendered)


_OPEN_TAG = re.compile(r"<(p|h[1-6]|li|td|th)(\s[^>]*)?>")


def _apply_attrs(rendered: str, attrs: dict[str, dict]) -> str:
    for k in sorted(attrs, key=lambda key: -rendered.find(key)):
        at = rendered.find(k)
        if at < 0:
            continue
        a = attrs[k]
        before = rendered[:at].rstrip(" ")
        rendered = before + rendered[at + len(k):]
        tags = list(_OPEN_TAG.finditer(rendered, 0, len(before)))
        if not tags:
            continue
        t = tags[-1]
        extra = ""
        if a.get("color"):
            extra += f' data-color="{esc(a["color"])}"'
        if a.get("bg"):
            extra += f' data-bg="{esc(a["bg"])}"'
        if a.get("id") and "id=" not in (t.group(2) or ""):
            extra += f' id="{esc(a["id"])}"'
        insert = t.start() + 1 + len(t.group(1))
        rendered = rendered[:insert] + extra + rendered[insert:]
    return rendered


# ── To portable Markdown ─────────────────────────────────────────────────────

CALLOUT_KINDS = {"note": "Note", "tip": "Tip", "warning": "Warning", "danger": "Danger", "info": "Note",
                 "caution": "Warning"}
CALLOUT_ICON = {"note": "ℹ️", "tip": "💡", "warning": "⚠️", "danger": "🚫", "info": "ℹ️", "caution": "⚠️"}


def _join(parts: list[str]) -> str:
    return "\n\n".join(p.strip("\n") for p in parts if p and p.strip())


def _quote(text: str) -> str:
    return "\n".join(("> " + ln) if ln.strip() else ">" for ln in text.split("\n"))


def _toc_md(headings: list[tuple[int, str]]) -> str:
    seen: dict[str, int] = {}
    rows = []
    shown = [(lv, t) for lv, t in headings if lv <= 3]
    top = min((lv for lv, _t in shown), default=1)
    for level, text in shown:
        s = slugify(text)
        n = seen.get(s, 0)
        seen[s] = n + 1
        anchor = s if n == 0 else f"{s}-{n}"
        rows.append("  " * (level - top) + f"- [{md_text(text)}](#{anchor})")
    return "\n".join(rows)


def _md_headings(markdown: str) -> list[tuple[int, str]]:
    out = []
    for _i, level, text in pages.headings(markdown):
        text = _TRAIL.sub("", text).strip()
        text = re.sub(r"[*_`~]", "", text)
        if text:
            out.append((level, text))
    return out


def blocks_to_md(blocks: list[Block], pc: PageCtx, headings: list[tuple[int, str]]) -> str:
    parts: list[str] = []
    for b in blocks:
        if b.kind == "md":
            parts.append(Inline(pc, "md").chunk(b.text))
            continue
        if b.kind == "leaf":
            parts.append(_leaf_md(b, pc, headings))
            continue
        name = b.name
        inner = blocks_to_md(b.children, pc, headings)
        if name in CALLOUT_KINDS:
            icon = b.attrs.get("icon") or CALLOUT_ICON[name]
            title = b.label or b.attrs.get("title")
            head = f"**{md_text(icon)} {CALLOUT_KINDS[name]}" + (f": {md_text(title)}" if title else "") + "**"
            parts.append(_quote(_join([head, inner])))
        elif name == "details":
            summary = b.label or b.attrs.get("summary") or b.attrs.get("title") or "Details"
            level = b.attrs.get("heading")
            if level in ("1", "2", "3"):
                parts.append(_join(["#" * int(level) + " " + summary.strip(), inner]))
            else:
                parts.append(_join([f"<details>\n<summary>{esc(summary.strip())}</summary>", inner, "</details>"]))
        elif name == "button":
            continue
        else:  # columns, column, indent, and anything unknown: their content, in order
            parts.append(inner)
    return _join(parts)


def _leaf_md(b: Block, pc: PageCtx, headings: list[tuple[int, str]]) -> str:
    a = b.attrs
    if b.name in ("markdrop", "page"):
        slug = pages.slug_of_src(a.get("src"))
        e = pc.embeds.get(slug or "") or {"state": "missing"}
        if e.get("state") != "ok":
            return f"*{LOCKED}*"
        href = pc.links.get(slug or "") or e.get("url") or ""
        return f"{_item_icon(e)} [{md_text(e.get('title') or slug)}]({md_url(href)})"
    if b.name == "bookmark":
        url = a.get("url") or ""
        if not is_web(url):
            return md_text(a.get("title") or url)
        title = a.get("title") or url
        desc = a.get("description")
        return f"[{md_text(title)}]({md_url(url)})" + (f" — {md_text(desc)}" if desc else "")
    if b.name == "embed":
        url = a.get("src") or ""
        if not is_web(url):
            return ""
        from app.services import web_embeds

        w = web_embeds.resolve(url)
        label = f"{w['name']}: {url}" if w else url
        return f"[{md_text(label)}]({md_url(url)})"
    if b.name == "toc":
        return _toc_md(headings)
    if b.name == "breadcrumb":
        names = [c.get("title") or "Untitled" for c in pc.crumbs] + [pc.title]
        return "*" + " / ".join(md_text(n) for n in names) + "*" if len(names) > 1 else ""
    return b.text


def _clean(text: str) -> str:
    """The characters the converters use as placeholders, out of the author's text."""
    return re.sub("[\ue000-\ue003]", "", text or "")


def to_markdown(markdown: str, pc: PageCtx) -> str:
    """The page as portable Markdown, its title as the first heading."""
    _front, body = page_props.split(_clean(markdown))
    blocks = parse_blocks(body)
    out = blocks_to_md(blocks, pc, _md_headings(body))
    icon = pc.props.get("icon") or ""
    head = f"# {icon + ' ' if icon and not icon.startswith('asset:') else ''}{pc.title}".rstrip()
    parts = [head]
    cover = _cover_src(pc, "md") if not (pc.props.get("cover") or "").startswith("gallery:") else None
    if cover:
        parts.insert(0, f"![Cover]({md_url(cover)})")
    parts.append(out)
    if pc.children:
        parts.append("## Pages inside\n\n" + "\n".join(
            f"- [{md_text(c['title'])}]({md_url(c['path'])})" for c in pc.children))
    return _join(parts) + "\n"


def _cover_src(pc: PageCtx, out: str) -> str | None:
    cover = pc.props.get("cover") or ""
    if cover.startswith("asset:"):
        img = pc.images.get(cover[6:])
        if img is None:
            return None
        if pc.mode == "zip" and img.path:
            return img.path
        if out == "html" and img.data_uri:
            return img.data_uri
        return pc.public_urls.get(cover[6:]) if pc.public else None
    if cover.startswith("gallery:"):
        return f"{_front_base()}/page-covers/{cover[8:]}.webp"
    return cover if is_https(cover) else None


def _front_base() -> str:
    front = get_settings().frontend_url.rstrip("/")
    return front if front.startswith("http") else "https://markdrop.in"


# ── To HTML ───────────────────────────────────────────────────────────────────


def _markdown_it():
    from markdown_it import MarkdownIt
    from mdit_py_plugins.anchors import anchors_plugin
    from mdit_py_plugins.dollarmath import dollarmath_plugin
    from mdit_py_plugins.tasklists import tasklists_plugin

    md = (MarkdownIt("commonmark", {"html": False, "linkify": False, "typographer": False})
          .enable(["table", "strikethrough"])
          .use(tasklists_plugin)
          .use(dollarmath_plugin, double_inline=True)
          .use(anchors_plugin, min_level=1, max_level=6,
               slug_func=lambda s: slugify(re.sub("[\ue000-\ue003][A-Za-z]?\\d*[\ue001]?", "", s))))

    def fence(self, tokens, idx, options, env):
        t = tokens[idx]
        info = (t.info or "").strip().split(" ")[0] if t.info else ""
        code = esc(t.content)
        if info == "mermaid":
            return f'<pre class="mermaid">{code}</pre>\n'
        cls = f' class="language-{esc(info)}"' if re.match(r"^[\w+#.-]{1,40}$", info) else ""
        lang = f'<span class="code-lang">{esc(info)}</span>' if cls else ""
        return f'<div class="code">{lang}<pre><code{cls}>{code}</code></pre></div>\n'

    md.add_render_rule("fence", fence)
    md.add_render_rule("code_block", fence)
    return md


def blocks_to_html(blocks: list[Block], pc: PageCtx, md) -> str:
    parts: list[str] = []
    for b in blocks:
        if b.kind == "md":
            inl = Inline(pc, "html", md)
            text = inl.chunk(b.text)
            rendered = md.render(text)
            rendered = rendered.replace("<table>", '<div class="table"><table>').replace("</table>", "</table></div>")
            parts.append(inl.fill(rendered))
            continue
        if b.kind == "leaf":
            parts.append(_leaf_html(b, pc, md))
            continue
        name = b.name
        inner = blocks_to_html(b.children, pc, md)
        bid = b.attrs.get("id") if _ANCHOR.match(b.attrs.get("id") or "") else None
        idattr = f' id="{esc(bid)}"' if bid else ""
        if name in CALLOUT_KINDS:
            kind = {"info": "note", "caution": "warning"}.get(name, name)
            icon = b.attrs.get("icon") or CALLOUT_ICON[name]
            color = b.attrs.get("color") if b.attrs.get("color") in COLORS else None
            title = b.label or b.attrs.get("title")
            parts.append(
                f'<div class="callout" data-kind="{kind}"' + (f' data-bg="{color}"' if color else "") + f"{idattr}>"
                f'<span class="callout-icon" aria-hidden="true">{esc(icon[:16])}</span><div class="callout-body">'
                + (f'<p class="callout-title">{esc(title)}</p>' if title else "") + inner + "</div></div>")
        elif name == "details":
            summary = b.label or b.attrs.get("summary") or b.attrs.get("title") or "Details"
            level = b.attrs.get("heading")
            color = b.attrs.get("color") if b.attrs.get("color") in COLORS else None
            bg = b.attrs.get("bg") if b.attrs.get("bg") in COLORS else None
            sm = Inline(pc, "html", md).label_html(summary.strip())
            if level in ("1", "2", "3"):
                sm = f'<span class="h{level}">{sm}</span>'
            parts.append(f'<details class="toggle" open{idattr}' + (f' data-color="{color}"' if color else "")
                         + (f' data-bg="{bg}"' if bg else "") + f"><summary>{sm}</summary>"
                         f'<div class="toggle-body">{inner}</div></details>')
        elif name == "columns":
            parts.append(f'<div class="columns"{idattr}>{inner}</div>')
        elif name == "column":
            w = b.attrs.get("width") or ""
            style = f' style="flex:0 1 {esc(w)}"' if re.match(r"^\d{1,3}(?:\.\d+)?%$", w) else ""
            parts.append(f'<div class="column"{style}>{inner}</div>')
        elif name == "indent":
            parts.append(f'<div class="indent"{idattr}>{inner}</div>')
        elif name == "button":
            continue
        else:
            parts.append(f"<div>{inner}</div>")
    return "\n".join(p for p in parts if p)


def _card(icon: str, title: str, meta: str, href: str | None, extra: str = "", cls: str = "") -> str:
    body = (f'<span class="card-icon" aria-hidden="true">{icon}</span><span class="card-text">'
            f"<strong>{title}</strong>" + (f'<span class="card-meta">{meta}</span>' if meta else "") + "</span>" + extra)
    klass = f"card {cls}".strip()
    if href:
        return f'<a class="{klass}" href="{esc(href)}">{body}</a>'
    return f'<div class="{klass}">{body}</div>'


def _host_of(url: str) -> str:
    from urllib.parse import urlsplit

    try:
        return (urlsplit(url).hostname or "").removeprefix("www.")
    except ValueError:
        return ""


def _leaf_html(b: Block, pc: PageCtx, md) -> str:
    a = b.attrs
    if b.name in ("markdrop", "page"):
        slug = pages.slug_of_src(a.get("src"))
        e = pc.embeds.get(slug or "") or {"state": "missing"}
        if e.get("state") != "ok":
            return _card("🔒", LOCKED, "You can't open this item, so it isn't part of this export.", None, cls="locked")
        href = pc.links.get(slug or "") or e.get("url") or ""
        meta = ("Page" if b.name == "page" else _item_kind(e)) + " · " + esc(_host_of(e.get("url") or "") or "markdrop.in")
        return _card(_item_icon(e), esc(e.get("title") or slug), meta, href)
    if b.name == "bookmark":
        url = a.get("url") or ""
        if not is_web(url):
            return f"<p>{esc(a.get('title') or url)}</p>"
        meta = esc(a.get("description") or "")
        site = esc(a.get("site") or _host_of(url))
        img = a.get("image")
        extra = f'<img class="card-img" src="{esc(img)}" alt="">' if is_https(img) else ""
        return _card("🔗", esc(a.get("title") or url), (meta + "<br>" if meta else "") + f'<span class="card-site">{site}</span>',
                     url, extra, "bookmark")
    if b.name == "embed":
        url = a.get("src") or ""
        if not is_web(url):
            return ""
        from app.services import web_embeds

        w = web_embeds.resolve(url)
        return _card("▶️", esc(a.get("title") or (w["name"] if w else _host_of(url))), esc(url), url, cls="webembed")
    if b.name == "toc":
        return "\ue000TOC\ue001"
    if b.name == "breadcrumb":
        names = [c.get("title") or "Untitled" for c in pc.crumbs] + [pc.title]
        if len(names) < 2:
            return ""
        return '<p class="crumbs">' + ' <span aria-hidden="true">/</span> '.join(esc(n) for n in names) + "</p>"
    return f"<p>{esc(b.text)}</p>"


_H = re.compile(r'<h([1-3])[^>]*\bid="([^"]+)"[^>]*>(.*?)</h\1>', re.S)


def _toc_html(body: str) -> str:
    rows = []
    for m in _H.finditer(body):
        text = re.sub(r"<[^>]+>", "", m.group(3)).strip()
        if text:
            rows.append(f'<li class="toc-{m.group(1)}"><a href="#{m.group(2)}">{text}</a></li>')
    return f'<nav class="toc" aria-label="Contents"><ul>{"".join(rows)}</ul></nav>' if rows else ""


def to_html_body(markdown: str, pc: PageCtx) -> str:
    _front, body = page_props.split(_clean(markdown))
    md = _markdown_it()
    out = blocks_to_html(parse_blocks(body), pc, md)
    if "\ue000TOC\ue001" in out:
        out = out.replace("\ue000TOC\ue001", _toc_html(out))
    return out


CSS = """
:root{--text:#1d1f23;--muted:#5f6670;--faint:#8a919b;--border:#e3e6ea;--soft:#f3f5f7;--accent:#2563eb;
--c-gray:#787774;--c-brown:#9f6b53;--c-orange:#c4660a;--c-yellow:#a77b23;--c-green:#3f7a5a;--c-blue:#2f74a0;
--c-purple:#8458a6;--c-pink:#b4437f;--c-red:#c8413c;color-scheme:light}
*{box-sizing:border-box}
html{background:#fff}
body{margin:0;color:var(--text);background:#fff;font:16px/1.65 Manrope,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
.page{max-width:768px;margin:0 auto;padding:0 24px 64px}
.page.wide{max-width:none;padding:0 48px 64px}
.page.small{font-size:14px}
.page.serif{font-family:"Iowan Old Style","Palatino Linotype",Georgia,serif}
.page.mono{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
.cover{display:block;width:100%;height:clamp(150px,30vh,280px);background:var(--soft) center/cover no-repeat}
.head{padding-top:64px}
.has-cover .head{padding-top:12px}
.icon-box{position:relative;display:grid;place-items:center;width:84px;height:84px;margin:0 0 0 -6px}
.has-cover .icon-box{margin-top:-54px}
.icon{display:block;font-size:65px;line-height:1}
img.icon{width:72px;height:72px;object-fit:cover;border-radius:8px}
h1.title{position:relative;font-size:40px;line-height:1.2;font-weight:800;letter-spacing:-.025em;margin:34px 0 6px;padding:2px 0;overflow-wrap:anywhere}
.body{padding-top:6px}
.body h1{font-size:30px;line-height:1.3;font-weight:700;letter-spacing:-.01em;margin:32px 0 6px}
.body h2{font-size:24px;line-height:1.35;font-weight:700;letter-spacing:-.01em;margin:28px 0 4px}
.body h3{font-size:20px;line-height:1.4;font-weight:700;letter-spacing:-.01em;margin:22px 0 2px}
.body h4,.body h5,.body h6{font-size:16px;font-weight:700;margin:18px 0 2px}
.body p{margin:6px 0}
.body a{color:var(--accent);text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}
.body a.card,.body a.chip{text-decoration:none}
.body a.card strong{color:var(--accent)}
.body ul,.body ol{margin:6px 0;padding-left:26px}
.body li{margin:2px 0}
.body li>p{margin:2px 0}
.body ul.contains-task-list{list-style:none;padding-left:4px}
.body .task-list-item input{margin:0 8px 0 0;vertical-align:-1px;accent-color:var(--accent)}
.body .task-list-item:has(input:checked){color:var(--muted);text-decoration:line-through}
.body blockquote{margin:10px 0;padding:2px 0 2px 16px;border-left:3px solid var(--text)}
.body hr{border:0;border-top:1px solid var(--border);margin:20px 0}
.body code{font:0.875em/1.5 "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);border:1px solid var(--border);border-radius:4px;padding:1px 5px;color:#c4331f}
.code{position:relative;margin:12px 0;background:#f7f8fa;border:1px solid var(--border);border-radius:8px}
.code pre{margin:0;padding:14px 16px;overflow-x:auto;white-space:pre-wrap;word-break:break-word}
.code code{background:none;border:0;padding:0;color:var(--text);font-size:13.5px}
.code-lang{position:absolute;top:6px;right:10px;font:600 11px/1 "JetBrains Mono",ui-monospace,monospace;color:var(--faint);text-transform:lowercase}
pre.mermaid{margin:12px 0;padding:14px 16px;background:#f7f8fa;border:1px solid var(--border);border-radius:8px;white-space:pre-wrap;font:13px/1.5 "JetBrains Mono",ui-monospace,monospace;text-align:center}
pre.mermaid[data-processed]{background:none;border:0}
.caption{margin:-4px 0 12px;font-size:14px;color:var(--muted);text-align:center}
.table{margin:12px 0;overflow-x:auto;border:1px solid var(--border);border-radius:10px}
table{border-collapse:collapse;min-width:100%;font-size:15px}
th,td{border:1px solid var(--border);padding:7px 10px;text-align:left;vertical-align:top}
.table table{border-style:hidden}
th{background:var(--soft);font-weight:600}
.figure{--w:100%;width:min(var(--w),100%);margin:20px auto;display:flex;flex-direction:column}
.figure[data-align=left]{margin-left:0}
.figure[data-align=right]{margin-right:0}
.figure img{display:block;max-width:100%;height:auto;border-radius:6px}
.figure figcaption{margin-top:8px;font-size:14px;color:var(--muted);text-align:center}
.inline-img{max-width:100%;height:auto;vertical-align:middle}
.img-missing{display:inline-flex;gap:6px;padding:10px 14px;border:1px dashed var(--border);border-radius:8px;color:var(--muted);font-size:14px}
.callout{display:flex;gap:12px;margin:16px 0;padding:14px 16px;border-radius:8px;background:var(--soft)}
.callout[data-kind=note]{background:#eef4fb}
.callout[data-kind=tip]{background:#edf7f1}
.callout[data-kind=warning]{background:#fbf4e6}
.callout[data-kind=danger]{background:#fcefee}
.callout-icon{flex:none;font-size:18px;line-height:1.5}
.callout-body{min-width:0;flex:1;font-size:15px}
.callout-body>:first-child{margin-top:0}
.callout-body>:last-child{margin-bottom:0}
.callout-title{font-weight:700}
.toggle{margin:8px 0}
.toggle summary{cursor:pointer;font-weight:600;list-style-position:outside;margin-left:18px}
.toggle summary .h1{font-size:30px;font-weight:700}
.toggle summary .h2{font-size:24px;font-weight:700}
.toggle summary .h3{font-size:20px;font-weight:700}
.toggle-body{padding-left:18px}
.columns{display:flex;gap:24px;margin:12px 0}
.column{flex:1 1 0;min-width:0}
.indent{margin-left:26px}
.card{display:flex;align-items:center;gap:12px;margin:12px 0;padding:12px 14px;border:1px solid var(--border);border-radius:10px;color:inherit;text-decoration:none}
a.card:hover{background:var(--soft)}
.card-icon{flex:none;font-size:20px}
.card-text{display:flex;flex-direction:column;min-width:0;flex:1}
.card-text strong{font-weight:600;overflow-wrap:anywhere}
.card-meta{font-size:13px;color:var(--muted);overflow-wrap:anywhere}
.card-img{flex:none;width:96px;height:64px;object-fit:cover;border-radius:6px}
.card.locked{color:var(--muted);border-style:dashed}
.chip{display:inline;padding:1px 6px;border-radius:5px;background:var(--soft);color:inherit;text-decoration:none;font-weight:500}
.chip.person{color:var(--accent)}
.chip.locked{color:var(--muted)}
kbd{font:600 0.8em/1 "JetBrains Mono",ui-monospace,monospace;padding:2px 6px;border:1px solid var(--border);border-bottom-width:2px;border-radius:5px;background:#fff}
u{text-decoration-thickness:1px;text-underline-offset:3px}
.toc ul{list-style:none;margin:8px 0;padding:0}
.toc li{margin:2px 0}
.toc a{color:var(--muted);text-decoration:none}
.toc .toc-2{padding-left:16px}
.toc .toc-3{padding-left:32px}
.crumbs{color:var(--muted);font-size:14px}
.math.block{margin:12px 0;overflow-x:auto;text-align:center}
.math:not(.katex-done){font-family:"JetBrains Mono",ui-monospace,monospace;font-size:.9em}
[data-color]{color:var(--fg)}
[data-color] :is(strong,em,a,code){color:inherit}
[data-bg]{background:color-mix(in srgb,var(--bgc) 16%,transparent);border-radius:4px}
:is(p,h1,h2,h3,h4,li,blockquote)[data-bg]{padding-left:4px;padding-right:4px;margin-left:-4px;margin-right:-4px}
span[data-bg]{padding:0 2px}
.callout[data-bg]{background:color-mix(in srgb,var(--bgc) 16%,#fff)}
[data-color=gray]{--fg:var(--c-gray)}[data-bg=gray]{--bgc:var(--c-gray)}
[data-color=brown]{--fg:var(--c-brown)}[data-bg=brown]{--bgc:var(--c-brown)}
[data-color=orange]{--fg:var(--c-orange)}[data-bg=orange]{--bgc:var(--c-orange)}
[data-color=yellow]{--fg:var(--c-yellow)}[data-bg=yellow]{--bgc:var(--c-yellow)}
[data-color=green]{--fg:var(--c-green)}[data-bg=green]{--bgc:var(--c-green)}
[data-color=blue]{--fg:var(--c-blue)}[data-bg=blue]{--bgc:var(--c-blue)}
[data-color=purple]{--fg:var(--c-purple)}[data-bg=purple]{--bgc:var(--c-purple)}
[data-color=pink]{--fg:var(--c-pink)}[data-bg=pink]{--bgc:var(--c-pink)}
[data-color=red]{--fg:var(--c-red)}[data-bg=red]{--bgc:var(--c-red)}
.subpages{margin-top:40px;padding-top:16px;border-top:1px solid var(--border)}
.subpages h2{font-size:14px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 8px}
.colophon{margin-top:48px;padding-top:12px;border-top:1px solid var(--border);font-size:12px;color:var(--faint)}
.colophon a{color:inherit}
@media (max-width:600px){.page{padding:0 16px 48px}.columns{flex-direction:column;gap:0}.cover{height:180px}
 .head{padding-top:28px}.has-cover .head{padding-top:12px}.icon-box{width:72px;height:72px}.has-cover .icon-box{margin-top:-44px}
 h1.title{font-size:32px}}
@media print{
 @page{margin:16mm 16mm 18mm}
 body{font-size:11pt}
 .page,.page.wide{max-width:none;padding:0}
 .cover{height:150px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
 .head{padding-top:0}
 .has-cover .head{padding-top:8px}
 .icon-box{width:72px;height:72px}
 .has-cover .icon-box{margin-top:-44px}
 h1.title{font-size:28pt;margin-top:12px}
 .body h1{break-before:page}
 .body>h1:first-child{break-before:auto}
 h1,h2,h3,h4,summary{break-after:avoid}
 .callout,.code,pre,.figure,.card,table,tr,.columns,blockquote{break-inside:avoid}
 a{color:inherit}
 .body a[href^="http"]:not(.card):not(.chip)::after{content:" (" attr(href) ")";font-size:.8em;color:var(--muted);overflow-wrap:anywhere}
 .callout,[data-bg],th,.chip,.code,pre.mermaid{-webkit-print-color-adjust:exact;print-color-adjust:exact}
 .colophon{break-before:avoid}
}
"""

_SCRIPT = """
const q=(s)=>Array.from(document.querySelectorAll(s));
if(q('.math').length){import('%(katex)s/katex.mjs').then(({default:k})=>{for(const el of q('.math')){try{k.render(el.textContent,el,{displayMode:el.classList.contains('block'),throwOnError:false});el.classList.add('katex-done')}catch(e){}}}).catch(()=>{});}
if(q('pre.mermaid').length){import('%(mermaid)s').then(({default:m})=>{m.initialize({startOnLoad:false,securityLevel:'strict',theme:'neutral'});return m.run({querySelector:'pre.mermaid'})}).catch(()=>{});}
"""


def html_document(body: str, pc: PageCtx, *, exported_at: datetime | None = None) -> str:
    """One self-contained page: the body in the page's own look."""
    props = pc.props
    classes = ["page"]
    if props.get("full_width"):
        classes.append("wide")
    if props.get("small_text"):
        classes.append("small")
    if props.get("font") in ("serif", "mono"):
        classes.append(props["font"])
    cover = _cover_src(pc, "html")
    y = props.get("cover_y", 50)
    # Laid out like the page in the app (components/pages/PageHead): the cover across the whole
    # paper, the icon over the cover's bottom edge, then the title below both, never on the cover.
    cover_html = ""
    if cover:
        classes.append("has-cover")
        # A background, so a cover that can't load (offline, a blocked address) is a calm band, not a broken image.
        cover_html = (f'<div class="cover" role="img" aria-label="Cover" '
                      f'style="background-image:url(&quot;{esc(cover)}&quot;);background-position:50% {esc(y)}%"></div>\n')
    icon = props.get("icon") or ""
    icon_html = ""
    if icon.startswith("asset:"):
        img = pc.images.get(icon[6:])
        src = (img.path if pc.mode == "zip" and img and img.path else (img.data_uri if img else None)) \
            or (pc.public_urls.get(icon[6:]) if pc.public else None)
        if src:
            icon_html = f'<div class="icon-box"><img class="icon" src="{esc(src)}" alt=""></div>'
    elif icon:
        icon_html = f'<div class="icon-box"><span class="icon" aria-hidden="true">{esc(icon)}</span></div>'
    head = f'<header class="head">{icon_html}<h1 class="title">{esc(pc.title)}</h1></header>'
    kids = ""
    if pc.children:
        kids = ('<section class="subpages"><h2>Pages inside</h2>' + "".join(
            _card("📄", esc(c["title"]), "", c["path"]) for c in pc.children) + "</section>")
    when = (exported_at or datetime.now(timezone.utc)).strftime("%-d %b %Y")
    colophon = (f'<footer class="colophon">Exported from Markdrop on {esc(when)} · '
                f'<a href="{esc(pc.url)}">{esc(pc.url)}</a></footer>')
    needs_script = ('class="math' in body) or ('class="mermaid"' in body)
    nonce = secrets.token_urlsafe(12)
    if needs_script:
        csp = (f"default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https://cdn.jsdelivr.net; "
               f"font-src https://cdn.jsdelivr.net data:; script-src 'nonce-{nonce}' https://cdn.jsdelivr.net; "
               "connect-src 'none'; base-uri 'none'; form-action 'none'")
        extra_head = f'<link rel="stylesheet" href="{KATEX}/katex.min.css">' if 'class="math' in body else ""
        script = f'<script type="module" nonce="{nonce}">{_SCRIPT % {"katex": KATEX, "mermaid": MERMAID}}</script>'
    else:
        csp = ("default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; script-src 'none'; "
               "base-uri 'none'; form-action 'none'")
        extra_head = ""
        script = ""
    return (
        "<!doctype html>\n"
        '<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        f'<meta http-equiv="Content-Security-Policy" content="{esc(csp)}">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        '<meta name="generator" content="Markdrop">\n'
        f"<title>{esc(pc.title)}</title>\n<style>{CSS}</style>\n{extra_head}\n</head>\n<body>\n{cover_html}"
        f'<article class="{" ".join(classes)}">\n{head}\n<div class="body">\n{body}\n</div>\n{kids}\n{colophon}\n'
        f"</article>\n{script}\n</body>\n</html>\n"
    )


# ── Gathering: pages, embeds, images ─────────────────────────────────────────


@dataclass
class PagePlan:
    raw: dict
    content: str
    pc: PageCtx
    folder: str               # inside the zip ("" for the single-file formats)
    images: list[Image]


@dataclass
class ExportPlan:
    fmt: str                  # md | html
    zip: bool
    root_name: str
    pages: list[PagePlan]
    notes: list[str]
    image_bytes: int = 0


async def _resolve(db, person: access.Actor, ctx: access.Ctx, content: str) -> dict[str, dict]:
    slugs = [r["slug"] for r in pages.embed_refs(content)]
    for m in re.finditer(r"(?m)^ {0,3}::page\{([^}\n]*)\}", content):
        a = parse_dattrs(m.group(1)) or {}
        s = pages.slug_of_src(a.get("src"))
        if s:
            slugs.append(s)
    if not slugs:
        return {}
    return await pages.resolve_embeds(db, person, ctx, slugs)


async def _crumbs(db, raw: dict, actor: access.Actor, ctx: access.Ctx) -> list[dict]:
    if raw.get("parent_id") is None:
        return []
    fields = await pages.page_fields(db, raw, actor, ctx)
    return fields.get("breadcrumbs") or []


async def _page_plan(db, raw: dict, actor: access.Actor, person: access.Actor, ctx: access.Ctx,
                     folder: str, mode: str) -> PagePlan:
    from app.services import urls

    content = await pages.content_for(actor, raw, ctx) or ""
    props = page_props.parse(content)
    title = (raw.get("title") or "").strip() or "Untitled"
    embeds = await _resolve(db, person, ctx, content)
    ids = pages.asset_ids(content)[:MAX_IMAGES_PER_PAGE]
    rows = await db[page_assets.COLL].find(
        {"doc_id": str(raw["_id"]), "_id": {"$in": ids}}, {"key": 1, "mime": 1, "size": 1}
    ).to_list(length=MAX_IMAGES_PER_PAGE) if ids else []
    images: dict[str, Image] = {}
    for r in rows:
        ext = (r.get("key") or "").rsplit(".", 1)[-1] if "." in (r.get("key") or "") else "png"
        images[r["_id"]] = Image(asset_id=r["_id"], key=r["key"], mime=r.get("mime") or "image/png", ext=ext,
                                 size=int(r.get("size") or 0))
    public = await page_assets.is_public(db, raw) if images else False
    public_urls: dict[str, str] = {}
    if public and images:
        public_urls = {k: v["url"] for k, v in (await page_assets.urls_for(db, raw, list(images))).items()}
    crumbs = await _crumbs(db, raw, person, ctx) if "::breadcrumb" in content else []
    url = await urls.workspace_url(db, raw) or urls.markdrop_url(raw["slug"])
    pc = PageCtx(slug=raw["slug"], title=title, url=url, props=props, embeds=embeds, images=images,
                 public=public, public_urls=public_urls, crumbs=crumbs, mode=mode)
    return PagePlan(raw=raw, content=content, pc=pc, folder=folder, images=list(images.values()))


def _unique(name: str, taken: set[str]) -> str:
    n = name
    i = 2
    while n.lower() in taken:
        n = f"{name} ({i})"
        i += 1
    taken.add(n.lower())
    return n


async def plan(db: AsyncIOMotorDatabase, raw: dict, actor: access.Actor, person: access.Actor,
               ctx: access.Ctx, *, fmt: str, subpages: bool) -> ExportPlan:
    """What the export holds. ``actor`` reads the page (with its password / edit
    secret); ``person`` is who is asking, for embedded items and sub-pages."""
    if fmt not in FORMATS:
        raise ExportError(422, "format must be md, html or zip.", "bad_format")
    as_zip = subpages or fmt == "zip"
    mode = "zip" if as_zip else "single"
    notes: list[str] = []
    root_name = safe_name(raw.get("title"), raw["slug"])
    root = await _page_plan(db, raw, actor, person, ctx, root_name if as_zip else "", mode)
    plans = [root]
    if subpages:
        # Breadth first; a sub-page the exporter can't open is left out with everything below it.
        level = [root]
        skipped = 0
        for _ in range(access.MAX_PAGE_DEPTH):
            nxt: list[PagePlan] = []
            for parent in level:
                taken = {"images"}
                for kid in await pages.children_rows(db, parent.raw["_id"]):
                    d = await access.can(actor, kid, "read", ctx)
                    if not d.allowed or kid.get("encrypted") or kid.get("kind") == "artifact":
                        if d.allowed:
                            skipped += 1
                        continue
                    editor = await is_editor(actor, kid, ctx)
                    if not editor and not allows_readers(kid.get("content")):
                        skipped += 1
                        continue
                    if len(plans) >= MAX_PAGES:
                        raise ExportError(413, f"That's more than {MAX_PAGES} pages. Export a page lower in "
                                               "the tree, or without its sub-pages.", "too_many_pages")
                    name = _unique(safe_name(kid.get("title"), kid["slug"]), taken)
                    child = await _page_plan(db, kid, actor, person, ctx, f"{parent.folder}/{name}", mode)
                    plans.append(child)
                    nxt.append(child)
            level = nxt
            if not level:
                break
        if skipped:
            notes.append(f"{skipped} sub-page{'s' if skipped != 1 else ''} couldn't be exported (encrypted, "
                         f"or exporting turned off) and {'were' if skipped != 1 else 'was'} left out.")
    p = ExportPlan(fmt="html" if fmt == "html" else "md", zip=as_zip, root_name=root_name, pages=plans, notes=notes)
    _link(p)
    _name_images(p)
    return p


def _page_file(pp: PagePlan, fmt: str) -> str:
    return f"{pp.folder}/page.{'html' if fmt == 'html' else 'md'}"


def _link(p: ExportPlan) -> None:
    """Links between pages in the zip become relative; each page lists its included sub-pages."""
    if not p.zip:
        return
    by_slug = {pp.raw["slug"]: pp for pp in p.pages}
    for pp in p.pages:
        here = pp.folder
        for slug, target in by_slug.items():
            if target is pp:
                continue
            pp.pc.links[slug] = posixpath.relpath(_page_file(target, p.fmt), here)
        for kid in p.pages:
            if posixpath.dirname(kid.folder) == pp.folder and kid is not pp:
                pp.pc.children.append({"title": kid.pc.title, "path": posixpath.relpath(_page_file(kid, p.fmt), here)})


def _name_images(p: ExportPlan) -> None:
    if not p.zip:
        return
    total = 0
    for pp in p.pages:
        for n, img in enumerate(pp.images, 1):
            if total + img.size > MAX_ZIP_IMAGE_BYTES:
                img.path = None
                continue
            total += img.size
            img.path = f"images/{n:03d}-{img.asset_id[:8]}.{img.ext}"
    p.image_bytes = total
    if any(img.path is None for pp in p.pages for img in pp.images):
        p.notes.append("Some images were left out: the export holds up to "
                       f"{MAX_ZIP_IMAGE_BYTES // (1024 * 1024)} MB of images.")


def _read(key: str) -> bytes | None:
    return r2.get_bytes(key, page_assets.MAX_BYTES + 1)


async def inline_images(pp: PagePlan) -> None:
    """data: URIs for one HTML file, up to the caps."""
    total = 0
    for img in pp.images:
        if img.size > MAX_INLINE_ONE or total + img.size > MAX_INLINE_IMAGE_BYTES:
            continue
        if not r2.is_configured():
            return
        data = await run_in_threadpool(_read, img.key)
        if not data:
            continue
        total += len(data)
        img.data_uri = f"data:{img.mime};base64," + base64.b64encode(data).decode()


def render(pp: PagePlan, fmt: str) -> str:
    if fmt == "html":
        return html_document(to_html_body(pp.content, pp.pc), pp.pc)
    return to_markdown(pp.content, pp.pc)


# ── The zip ───────────────────────────────────────────────────────────────────


class _Sink(io.RawIOBase):
    def __init__(self) -> None:
        self._buf = bytearray()
        self._pos = 0

    def writable(self) -> bool:
        return True

    def write(self, b) -> int:
        self._buf.extend(b)
        self._pos += len(b)
        return len(b)

    def tell(self) -> int:
        return self._pos

    def flush(self) -> None:
        pass

    def take(self) -> bytes:
        out = bytes(self._buf)
        self._buf.clear()
        return out


def _entry(name: str, stored: bool = False) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=time.gmtime()[:6])
    info.compress_type = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    return info


def zip_stream(p: ExportPlan, texts: dict[str, str], *, get_bytes: Callable[[str], bytes | None] | None = None
               ) -> Iterator[bytes]:
    """The zip, written as it's sent (a sync generator: the bucket reads happen in
    StreamingResponse's thread). Text first, then each image, one at a time."""
    get = get_bytes or _read
    sink = _Sink()
    with zipfile.ZipFile(sink, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        for name in texts:
            zf.writestr(_entry(name), texts[name].encode())
            yield sink.take()
        for pp in p.pages:
            for img in pp.images:
                if not img.path:
                    continue
                data = get(img.key) if r2.is_configured() or get_bytes else None
                if not data:
                    continue
                zf.writestr(_entry(f"{pp.folder}/{img.path}", stored=True), data)
                yield sink.take()
    yield sink.take()


def zip_texts(p: ExportPlan) -> dict[str, str]:
    texts = {_page_file(pp, p.fmt): render(pp, p.fmt) for pp in p.pages}
    if p.notes:
        texts[f"{p.root_name}/EXPORT-NOTES.txt"] = "\n".join(p.notes) + "\n"
    return texts


def filename(p: ExportPlan) -> str:
    if p.zip:
        return f"{p.root_name}.zip"
    return f"{p.root_name}.{'html' if p.fmt == 'html' else 'md'}"


# ── Links for AI apps (MCP): a short-lived signed download ───────────────────


def _key() -> str:
    return "page-export|" + get_settings().auth_secret


def sign(slug: str, user_id: str, fmt: str, subpages: bool) -> tuple[str, int]:
    from app.services import docs_site_access

    exp = int(time.time()) + TOKEN_TTL
    return docs_site_access.sign(TOKEN_PURPOSE, {"s": slug, "u": user_id, "f": fmt, "sp": int(bool(subpages)),
                                                 "exp": exp}, _key()), exp


def redeem(slug: str, token: str) -> dict | None:
    from app.services import docs_site_access

    data = docs_site_access.read(TOKEN_PURPOSE, token or "", _key())
    if not data or data.get("s") != slug or data.get("f") not in FORMATS or not data.get("u"):
        return None
    return data


def download_url(slug: str, token: str) -> str:
    from urllib.parse import quote

    base = get_settings().api_base_url.rstrip("/")
    return f"{base}/api/v1/documents/{quote(slug)}/export/download?token={quote(token)}"


def summary(p: ExportPlan) -> dict:
    return {"pages": len(p.pages), "images": sum(1 for pp in p.pages for i in pp.images if (i.path or not p.zip)),
            "notes": p.notes, "filename": filename(p)}


