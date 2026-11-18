"""Notion's exported Markdown → blocks (tree.py's block dicts).

What a "Markdown & CSV" export writes, and what each becomes:

    # Title                                  the page's title (first line; taken out)
    Status: Done                             a database row's properties (after the title; taken out —
                                             the CSV has them)
    ## Heading / ### Heading                 heading (levels 1-3)
    - item / 1. item / - [ ] to-do           lists, nested by indentation (children indented under them)
    <details><summary>T</summary>…</details> toggle (a toggle heading when the summary is a heading)
    <aside>💡 text …</aside>                 callout (its emoji or <img> icon)
    > quote                                  quote
    ```lang                                  code with its language
    $$ … $$                                  equation (KaTeX); inline $x$ is kept as it is
    | a | b |                                table
    ---                                      divider
    ![name](Page%20abc…/image.png)           image (a file in the export: URL-encoded, relative)
    [Child](Page%20abc…/Child%20def….md)     a sub-page (alone on its line) or a link to a page
    [Tasks](Tasks%20123….csv)                a database
    [file.pdf](Page%20abc…/file.pdf)         an attachment
    https://… / [https://…](https://…)       a bookmark, or an embed for the hosts pages embed

Links inside text are rewritten through ``resolve`` (the source adapter's: page / database / asset /
url), to ``notion://<id>`` and ``notion-asset://<path>``. Anything the parser doesn't know stays text.
"""

from __future__ import annotations

import html
import re
from typing import Callable

from app.services.notion_import.tree import asset_url

# resolve(href) → ("page" | "database", notion_id) | ("asset", path) | ("url", href) | None (a dead link)
Resolve = Callable[[str], "tuple[str, str] | None"]

_FENCE = re.compile(r"^(\s*)(`{3,}|~{3,})\s*([^`\s]*)?.*$")
_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_LIST = re.compile(r"^(\s*)([-*+]|\d{1,9}[.)])\s+(?:\[([ xX])\]\s+)?(.*)$")
_DIVIDER = re.compile(r"^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$")
_IMAGE_LINE = re.compile(r"^\s*!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(?:\s+\"([^\"]*)\")?\)\s*$")
_LINK_LINE = re.compile(r"^\s*\[([^\]]+)\]\((<[^>]+>|[^)\s]+)\)\s*$")
_URL_LINE = re.compile(r"^\s*<?(https?://[^\s<>]+)>?\s*$")
_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")
_LINK = re.compile(r"(!?)\[((?:[^\[\]]|\[[^\]]*\])*)\]\((<[^>]+>|[^)\s]+)(?:\s+\"[^\"]*\")?\)")
_IMG_TAG = re.compile(r"<img\s[^>]*src=\"([^\"]+)\"[^>]*>", re.I)
_TAG_LINE = re.compile(r"^\s*</?(div|span|columns?|column-list|p|br)\b[^>]*>\s*$", re.I)
_PROP_LINE = re.compile(r"^([^:\n]{1,100}):\s?(.*)$")
_EMOJI_START = re.compile(r"^\s*([\U0001F000-\U0001FAFF☀-➿⬀-⯿⌀-⏿][️‍"
                          r"\U0001F3FB-\U0001F3FF\U0001F000-\U0001FAFF☀-➿]*)\s*(.*)$", re.S)
_IMAGE_EXT = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".heic", ".bmp", ".tif", ".tiff", ".avif")
EMBED_HOSTS = ("youtube.com", "youtu.be", "vimeo.com", "loom.com", "figma.com", "google.com/maps",
               "maps.google.", "goo.gl/maps", "codepen.io")


def is_image_path(path: str) -> bool:
    return path.lower().split("?", 1)[0].endswith(_IMAGE_EXT)


def embeddable(url: str) -> bool:
    u = url.lower()
    return any(h in u for h in EMBED_HOSTS)


def _strip_angle(href: str) -> str:
    return href[1:-1] if href.startswith("<") and href.endswith(">") else href


class Parser:
    def __init__(self, resolve: Resolve):
        self.resolve = resolve

    # ── inline ──

    def inline(self, text: str) -> str:
        """Links and images in running text, through ``resolve``; <img> tags as images; HTML entities and
        Notion's line-break tags read."""
        text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)

        def img_tag(m: re.Match) -> str:
            return f"![]({m.group(1)})"

        text = _IMG_TAG.sub(img_tag, text)

        def link(m: re.Match) -> str:
            bang, label, href = m.group(1), m.group(2), _strip_angle(m.group(3))
            got = self.resolve(href)
            if got is None:
                return label if not bang else ""
            kind, val = got
            if kind in ("page", "database"):
                return f"{bang}[{label}](notion://{val})"
            if kind == "asset":
                return f"{bang}[{label}]({asset_url(val)})"
            return f"{bang}[{label}]({val})"

        return _LINK.sub(link, text)

    # ── blocks ──

    def parse(self, lines: list[str]) -> list[dict]:
        out: list[dict] = []
        i, n = 0, len(lines)
        while i < n:
            line = lines[i]
            s = line.strip()
            if not s or _TAG_LINE.match(line):
                i += 1
                continue
            m = _FENCE.match(line)
            if m:
                fence = m.group(2)
                lang = (m.group(3) or "").strip()
                body: list[str] = []
                i += 1
                while i < n and not lines[i].strip().startswith(fence[0] * len(fence)):
                    body.append(lines[i][len(m.group(1)):] if lines[i].startswith(m.group(1)) else lines[i])
                    i += 1
                i += 1
                out.append({"type": "code", "language": lang, "text": "\n".join(body)})
                continue
            if s.startswith("$$"):
                if len(s) > 4 and s.endswith("$$"):
                    out.append({"type": "equation", "expression": s[2:-2].strip()})
                    i += 1
                    continue
                body = [s[2:]] if s[2:].strip() else []
                i += 1
                while i < n and not lines[i].strip().endswith("$$"):
                    body.append(lines[i].strip())
                    i += 1
                if i < n:
                    last = lines[i].strip()[:-2]
                    if last.strip():
                        body.append(last)
                i += 1
                out.append({"type": "equation", "expression": "\n".join(body).strip()})
                continue
            low = s.lower()
            if low.startswith("<aside"):
                inner, i = self._html_block(lines, i, "aside")
                out.append(self._callout(inner))
                continue
            if low.startswith("<details"):
                inner, i = self._html_block(lines, i, "details")
                out.append(self._toggle(inner))
                continue
            m = _HEADING.match(line)
            if m and not line.startswith(" "):
                out.append({"type": "heading", "level": min(3, len(m.group(1))), "text": self.inline(m.group(2))})
                i += 1
                continue
            if _DIVIDER.match(line):
                out.append({"type": "divider"})
                i += 1
                continue
            if s.startswith(">"):
                body = []
                while i < n and lines[i].strip().startswith(">"):
                    body.append(re.sub(r"^\s*>\s?", "", lines[i]))
                    i += 1
                out.append({"type": "quote", "text": self.inline("\n".join(body).strip())})
                continue
            if s.startswith("|") and i + 1 < n and _TABLE_SEP.match(lines[i + 1]):
                rows = [self._cells(lines[i])]
                i += 2
                while i < n and lines[i].strip().startswith("|"):
                    rows.append(self._cells(lines[i]))
                    i += 1
                out.append({"type": "table", "rows": rows, "header_row": True})
                continue
            m = _LIST.match(line)
            if m:
                block, i = self._list_item(lines, i, m)
                out.append(block)
                continue
            m = _IMAGE_LINE.match(line)
            if m:
                out.append(self._image(_strip_angle(m.group(2)), m.group(1), m.group(3)))
                i += 1
                continue
            m = _LINK_LINE.match(line)
            if m:
                b = self._link_line(m.group(1), _strip_angle(m.group(2)))
                if b is not None:
                    out.append(b)
                    i += 1
                    continue
            m = _URL_LINE.match(line)
            if m:
                url = m.group(1)
                got = self.resolve(url)
                if got and got[0] in ("page", "database"):
                    out.append({"type": "link_to_page", "id": got[1], "title": None})
                else:
                    out.append({"type": "embed" if embeddable(url) else "bookmark", "url": url})
                i += 1
                continue
            # A paragraph: consecutive lines that don't start another block.
            body = [line.strip()]
            i += 1
            while i < n and lines[i].strip() and not self._starts_block(lines, i):
                body.append(lines[i].strip())
                i += 1
            out.append({"type": "paragraph", "text": self.inline("\n".join(body))})
        return out

    def _starts_block(self, lines: list[str], i: int) -> bool:
        line = lines[i]
        s = line.strip()
        return bool(_FENCE.match(line) or s.startswith(("$$", "<aside", "<details", ">", "|"))
                    or _HEADING.match(line) or _LIST.match(line) or _IMAGE_LINE.match(line)
                    or _TAG_LINE.match(line) or _DIVIDER.match(line))

    @staticmethod
    def _cells(line: str) -> list[str]:
        s = line.strip()
        if s.startswith("|"):
            s = s[1:]
        if s.endswith("|") and not s.endswith("\\|"):
            s = s[:-1]
        cells, cur, esc = [], [], False
        for ch in s:
            if esc:
                cur.append(ch)
                esc = False
            elif ch == "\\":
                cur.append(ch)
                esc = True
            elif ch == "|":
                cells.append("".join(cur).strip())
                cur = []
            else:
                cur.append(ch)
        cells.append("".join(cur).strip())
        return cells

    def table_cells(self, rows: list[list[str]]) -> list[list[str]]:
        return [[self.inline(c) for c in r] for r in rows]

    def _image(self, href: str, alt: str, title: str | None) -> dict:
        got = self.resolve(href)
        caption = (title or "").strip() or None
        alt = (alt or "").strip()
        if got is None:
            return {"type": "unsupported", "notion_type": "image", "text": alt or href}
        kind, val = got
        if kind == "asset":
            return {"type": "image", "src": asset_url(val), "alt": alt, "caption": caption}
        if kind == "url":
            return {"type": "image", "src": val, "alt": alt, "caption": caption}
        return {"type": "link_to_page", "id": val, "title": alt or None}

    def _link_line(self, label: str, href: str) -> dict | None:
        got = self.resolve(href)
        if got is None:
            return None
        kind, val = got
        label = html.unescape(label).strip()
        if kind == "page":
            return {"type": "page_link", "id": val, "title": label}
        if kind == "database":
            return {"type": "child_database", "id": val, "title": label}
        if kind == "asset":
            if is_image_path(val):
                return {"type": "image", "src": asset_url(val), "alt": label, "caption": None}
            return {"type": "file", "src": asset_url(val), "name": label}
        if label == val or label.rstrip("/") == val.rstrip("/"):
            return {"type": "embed" if embeddable(val) else "bookmark", "url": val}
        return None  # a link with its own words: a paragraph

    # ── containers ──

    @staticmethod
    def _html_block(lines: list[str], i: int, tag: str) -> tuple[list[str], int]:
        """The lines inside <tag>…</tag> starting at ``i`` (nested ones counted), and the index after it."""
        depth, body, n = 0, [], len(lines)
        open_rx = re.compile(rf"<{tag}\b[^>]*>", re.I)
        close_rx = re.compile(rf"</{tag}\s*>", re.I)
        while i < n:
            line = lines[i]
            opens = len(open_rx.findall(line))
            closes = len(close_rx.findall(line))
            if depth == 0:
                line = open_rx.sub("", line, count=1)
                depth += opens
                opens = 0
            depth += opens - closes
            if depth <= 0:
                last = close_rx.split(line)
                if last and last[0].strip():
                    body.append(last[0])
                i += 1
                break
            body.append(line)
            i += 1
        # Common indentation goes (Notion indents the inside of <details>).
        pad = min((len(x) - len(x.lstrip()) for x in body if x.strip()), default=0)
        return [x[pad:] if len(x) >= pad else x.strip() for x in body], i

    def _callout(self, inner: list[str]) -> dict:
        icon = None
        # An <img> icon (a custom one) on the first line, or an emoji starting the text.
        while inner and not inner[0].strip():
            inner = inner[1:]
        if inner:
            first = inner[0]
            m = _IMG_TAG.match(first.strip())
            if m:
                got = self.resolve(m.group(1))
                icon = asset_url(got[1]) if got and got[0] == "asset" else None
                inner = [_IMG_TAG.sub("", first, count=1)] + inner[1:]
            else:
                m = _EMOJI_START.match(first)
                if m:
                    icon = m.group(1)
                    inner = [m.group(2)] + inner[1:]
        return {"type": "callout", "icon": icon, "children": self.parse(inner)}

    def _toggle(self, inner: list[str]) -> dict:
        text = "\n".join(inner)
        summary, level = "", 0
        m = re.search(r"<summary>(.*?)</summary>", text, re.S | re.I)
        if m:
            raw = m.group(1).strip()
            h = re.match(r"^<h([1-6])>(.*?)</h\1>$", raw, re.S | re.I) or re.match(r"^(#{1,3})\s+(.*)$", raw, re.S)
            if h:
                level = min(3, int(h.group(1)) if h.group(1).isdigit() else len(h.group(1)))
                raw = h.group(2)
            summary = re.sub(r"<[^>]+>", "", raw).strip()
            text = text[:m.start()] + text[m.end():]
        body = text.split("\n")
        return {"type": "toggle", "text": self.inline(html.unescape(summary)), "heading": level,
                "children": self.parse(body)}

    def _list_item(self, lines: list[str], i: int, m: re.Match) -> tuple[dict, int]:
        indent = len(m.group(1).replace("\t", "    "))
        marker, check, text = m.group(2), m.group(3), m.group(4)
        n = len(lines)
        i += 1
        child: list[str] = []
        while i < n:
            line = lines[i]
            if not line.strip():
                # A blank line: the item goes on only if an indented line follows.
                j = i + 1
                while j < n and not lines[j].strip():
                    j += 1
                if j < n and len(lines[j]) - len(lines[j].lstrip()) > indent:
                    child.extend(lines[i:j])
                    i = j
                    continue
                break
            lead = len(line.replace("\t", "    ")) - len(line.replace("\t", "    ").lstrip())
            if lead <= indent:
                break
            child.append(line)
            i += 1
        pad = min((len(x) - len(x.lstrip()) for x in child if x.strip()), default=0)
        children = self.parse([x[pad:] if x.strip() else "" for x in child]) if child else []
        if check is not None:
            typ = "todo"
        elif marker[0].isdigit():
            typ = "numbered"
        else:
            typ = "bulleted"
        block = {"type": typ, "text": self.inline(text), "children": children}
        if typ == "todo":
            block["checked"] = check.lower() == "x"
        return block, i


def split_page(text: str, prop_names: set[str] | None = None) -> tuple[str | None, dict[str, str], list[str]]:
    """(title, the property lines under it, the body's lines) of an exported page."""
    text = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    title = None
    i = 0
    while i < len(lines) and not lines[i].strip():
        i += 1
    if i < len(lines) and lines[i].startswith("# "):
        title = lines[i][2:].strip()
        i += 1
    props: dict[str, str] = {}
    if prop_names is not None:
        j = i
        while j < len(lines) and not lines[j].strip():
            j += 1
        k = j
        while k < len(lines) and lines[k].strip():
            pm = _PROP_LINE.match(lines[k])
            if not pm or pm.group(1).strip() not in prop_names:
                break
            props[pm.group(1).strip()] = pm.group(2).strip()
            k += 1
        if props and (k >= len(lines) or not lines[k].strip()):
            i = k
        else:
            props = {}
    return title, props, lines[i:]


def parse_page(text: str, resolve: Resolve, prop_names: set[str] | None = None) -> tuple[str | None, list[dict]]:
    title, _props, body = split_page(text, prop_names)
    p = Parser(resolve)
    blocks = p.parse(body)
    # Table cells' links too (rows were kept raw while parsing).
    for b in _walk(blocks):
        if b.get("type") == "table":
            b["rows"] = p.table_cells(b["rows"])
    return (html.unescape(title) if title else None), blocks


def _walk(blocks: list[dict]):
    for b in blocks:
        yield b
        if isinstance(b.get("children"), list):
            yield from _walk(b["children"])
        for col in b.get("columns") or []:
            yield from _walk(col)
