"""Blocks (tree.py) → Markdrop page Markdown (the page builder's syntax: app/mcp/page_tools.py PAGE_SYNTAX).

    heading / paragraph / quote / divider      # / text / > / ---
    bulleted / numbered / to-do                - / 1. / - [ ] (children nested under them)
    toggle (heading)                           :::details{summary="…" heading=2} … :::
    callout                                    :::note{icon="💡"} … :::
    columns                                    ::::columns  :::column … :::  ::::
    code / equation / table                    ```lang / $$ … $$ / | a | b |
    image                                      ![alt](asset:<id> "caption")   (or the https:// image)
    file                                       ::markdrop{src="<slug>" mode="card"}  (a Markdrop file)
    bookmark / embed                           ::bookmark{url=…} / ::embed{src=…} (YouTube, Loom, Figma…)
    sub-page / link to a page                  ::page{src="<slug>"} / :markdrop[Title]{src="<slug>"}
    database                                   a link to its folder (or its page, in My files)
    anything else                              its text, with "(from Notion: <type>)"

A container fence has more colons than the fences inside it (the page builder's rule).
"""

from __future__ import annotations

import re
from typing import Protocol

_LINK = re.compile(r"(!?)\[((?:[^\[\]]|\[[^\]]*\])*)\]\((notion://[0-9a-zA-Z]+|notion-asset://[^)\s]+)\)")
_FENCE_RUN = re.compile(r"^\s*(:{3,})", re.M)
_LANGS = {"plain text": "text", "plaintext": "text", "c++": "cpp", "c#": "csharp", "f#": "fsharp",
          "objective-c": "objectivec", "shell": "bash", "visual basic": "vb", "markdown": "markdown",
          "javascript": "javascript", "typescript": "typescript", "python": "python", "json": "json"}


class Resolver(Protocol):
    def page(self, notion_id: str) -> dict | None:
        """{"slug", "title"} of an imported page, or {"url", "title"} of a database folder; None: unknown."""

    def asset(self, path: str) -> dict | None:
        """{"image": asset_id} / {"file": slug} / {"skipped": reason}; None: not in the export."""


def attr(v: str) -> str:
    return (v or "").replace("&", "&amp;").replace('"', "&quot;").replace("\n", "&#xA;")


def _label(s: str) -> str:
    return re.sub(r"[\[\]\\\n\r]", " ", s or "").strip()


class Renderer:
    def __init__(self, r: Resolver):
        self.r = r

    # ── inline ──

    def inline(self, text: str) -> str:
        from urllib.parse import unquote

        def sub(m: re.Match) -> str:
            bang, label, href = m.group(1), m.group(2), m.group(3)
            if href.startswith("notion://"):
                got = self.r.page(href[len("notion://"):])
                if not got:
                    return label
                if got.get("slug"):
                    return f':markdrop[{_label(label) or _label(got.get("title") or "") or got["slug"]}]{{src="{attr(got["slug"])}"}}'
                if got.get("url"):
                    return f"[{label}]({got['url']})"
                return label
            got = self.r.asset(unquote(href[len("notion-asset://"):]))
            if not got:
                return label
            if got.get("image"):
                return f"![{_label(label)}](asset:{got['image']})"
            if got.get("file"):
                return f':markdrop[{_label(label) or got["file"]}]{{src="{attr(got["file"])}"}}'
            return f"{label} (from Notion: file not imported)" if label else ""

        return _LINK.sub(sub, text or "")

    # ── blocks ──

    def blocks(self, blocks: list[dict]) -> str:
        parts: list[str] = []
        prev_list = None
        for b in blocks:
            out = self.block(b)
            if out is None:
                continue
            kind = b.get("type")
            is_list = kind in ("bulleted", "numbered", "todo")
            # Items of one list stay together (one blank line between other blocks).
            if parts and is_list and prev_list == kind:
                parts[-1] = parts[-1] + "\n" + out
            else:
                parts.append(out)
            prev_list = kind if is_list else None
        return "\n\n".join(p for p in parts if p is not None)

    def _container(self, open_: str, inner: str, close_extra: str = "") -> str:
        depth = max((len(m) for m in _FENCE_RUN.findall(inner)), default=2)
        fence = ":" * max(3, depth + 1)
        return f"{fence}{open_}\n{inner}\n{fence}{close_extra}"

    def block(self, b: dict) -> str | None:
        t = b.get("type")
        if t == "paragraph":
            return self.inline(b.get("text", "")).strip() or None
        if t == "heading":
            text = self.inline(b.get("text", "")).replace("\n", " ").strip()
            return f"{'#' * int(b.get('level') or 1)} {text}" if text else None
        if t in ("bulleted", "numbered", "todo"):
            return self._item(b)
        if t == "quote":
            text = self.inline(b.get("text", "")).strip()
            inner = self.blocks(b.get("children") or [])
            body = "\n\n".join(x for x in (text, inner) if x)
            return "\n".join("> " + ln if ln else ">" for ln in body.split("\n")) if body else None
        if t == "divider":
            return "---"
        if t == "code":
            lang = (b.get("language") or "").strip().lower()
            lang = _LANGS.get(lang, re.sub(r"[^a-z0-9+#_-]", "", lang))
            text = b.get("text") or ""
            ticks = "```"
            while ticks in text:
                ticks += "`"
            return f"{ticks}{lang}\n{text}\n{ticks}"
        if t == "equation":
            expr = (b.get("expression") or "").strip()
            return f"$$\n{expr}\n$$" if expr else None
        if t == "table":
            return self._table(b)
        if t == "callout":
            icon = b.get("icon")
            attrs = ""
            if icon and not icon.startswith(("notion-asset://", "http")):
                attrs = f'{{icon="{attr(icon)}"}}'
            inner = self.blocks(b.get("children") or []) or " "
            return self._container(f"note{attrs}", inner)
        if t == "toggle":
            summary = _label(self.inline(b.get("text", "")).replace("\n", " ")) or "Details"
            heading = int(b.get("heading") or 0)
            extra = f" heading={heading}" if heading in (1, 2, 3) else ""
            inner = self.blocks(b.get("children") or []) or " "
            return self._container(f'details{{summary="{attr(summary)}"{extra}}}', inner)
        if t == "columns":
            cols = [c for c in (b.get("columns") or []) if c][:5]
            if len(cols) < 2:
                return self.blocks(cols[0]) if cols else None
            rendered = [self.blocks(c) or " " for c in cols]
            depth = max((len(m) for r in rendered for m in _FENCE_RUN.findall(r)), default=2)
            inner_f = ":" * max(3, depth + 1)
            outer_f = inner_f + ":"
            body = "\n".join(f"{inner_f}column\n{r}\n{inner_f}" for r in rendered)
            return f"{outer_f}columns\n{body}\n{outer_f}"
        if t == "image":
            return self._image(b)
        if t == "file":
            src = b.get("src") or ""
            name = _label(b.get("name") or "") or "File"
            if src.startswith("notion-asset://"):
                from urllib.parse import unquote

                got = self.r.asset(unquote(src[len("notion-asset://"):]))
                if got and got.get("file"):
                    return f'::markdrop{{src="{attr(got["file"])}" mode="card"}}'
                if got and got.get("image"):
                    return f"![{name}](asset:{got['image']})"
                return f"{name} *(from Notion: file not imported)*"
            return f"[{name}]({src})" if src.startswith("http") else name
        if t == "bookmark":
            url = b.get("url") or ""
            title = b.get("title")
            return f'::bookmark{{url="{attr(url)}"' + (f' title="{attr(title)}"' if title else "") + "}"
        if t == "embed":
            return f'::embed{{src="{attr(b.get("url") or "")}"}}'
        if t in ("child_page", "link_to_page", "page_link"):
            got = self.r.page(b.get("id") or "")
            title = b.get("title") or (got or {}).get("title") or "Untitled"
            if not got:
                return _label(title) or None
            if got.get("slug"):
                if t == "child_page":
                    return f'::page{{src="{attr(got["slug"])}"}}'
                return f':markdrop[{_label(title) or got["slug"]}]{{src="{attr(got["slug"])}"}}'
            if got.get("url"):
                return f"[{_label(title)}]({got['url']})"
            return _label(title)
        if t == "child_database":
            got = self.r.page(b.get("id") or "")
            title = _label(b.get("title") or (got or {}).get("title") or "Database")
            if got and got.get("slug"):
                return f'::page{{src="{attr(got["slug"])}"}}'
            if got and got.get("url"):
                return f"[{title}]({got['url']}) *(database)*"
            return title
        # Unknown: its text, said where it came from.
        text = self.inline(b.get("text") or "").strip()
        note = f"*(from Notion: {b.get('notion_type') or t or 'block'})*"
        return f"{text} {note}" if text else note

    def _item(self, b: dict) -> str:
        t = b["type"]
        text = self.inline(b.get("text", "")).replace("\n", " ").strip()
        if t == "todo":
            head = f"- [{'x' if b.get('checked') else ' '}] {text}".rstrip()
            pad = "  "
        elif t == "numbered":
            head = f"1. {text}".rstrip()
            pad = "   "
        else:
            head = f"- {text}".rstrip()
            pad = "  "
        kids = b.get("children") or []
        nested = [k for k in kids if k.get("type") in ("bulleted", "numbered", "todo", "paragraph", "image", "code",
                                                      "quote", "equation")]
        after = [k for k in kids if k not in nested]
        out = head
        if nested:
            inner = self.blocks(nested)
            out += "\n" + "\n".join((pad + ln) if ln.strip() else "" for ln in inner.split("\n"))
        if after:
            # Toggles, callouts, tables… can't sit inside a list item: right after it, as an indented block.
            out += "\n\n" + self._container("indent", self.blocks(after) or " ")
        return out

    def _image(self, b: dict) -> str | None:
        src = b.get("src") or ""
        alt = _label(b.get("alt") or "")
        cap = (b.get("caption") or "").replace('"', "'")
        title = f' "{cap}"' if cap else ""
        if src.startswith("notion-asset://"):
            from urllib.parse import unquote

            got = self.r.asset(unquote(src[len("notion-asset://"):]))
            if got and got.get("image"):
                return f"![{alt}](asset:{got['image']}{title})"
            if got and got.get("file"):
                return f'::markdrop{{src="{attr(got["file"])}" mode="card"}}'
            reason = (got or {}).get("skipped") or "image not imported"
            return f"{alt or 'Image'} *(from Notion: {reason})*"
        if src.startswith("https://"):
            return f"![{alt}]({src}{title})"
        return f"{alt or 'Image'} *(from Notion: image)*"

    def _table(self, b: dict) -> str | None:
        rows = [r for r in (b.get("rows") or []) if r is not None]
        if not rows:
            return None
        width = max(len(r) for r in rows)

        def cell(c: str) -> str:
            v = self.inline(c or "").replace("\n", " ").replace("|", "\\|")
            v = v.replace("\\\\|", "\\|")
            return v.strip() or " "

        lines = []
        for k, r in enumerate(rows):
            cells = [cell(r[j] if j < len(r) else "") for j in range(width)]
            lines.append("| " + " | ".join(cells) + " |")
            if k == 0:
                lines.append("|" + "|".join([" --- "] * width) + "|")
        out = "\n".join(lines)
        if not b.get("header_row", True):
            out += '\n\n{header-row="off"}'
        return out


def render(blocks: list[dict], r: Resolver) -> str:
    return Renderer(r).blocks(blocks)
