"""Small edits to a page's Markdown (MCP replace_block, insert_after_block, delete_block,
update_table_row, replace_section's preamble, get_page's outline and sections): the page as
blocks with their line ranges and anchors, headings by the text a reader sees.

A block is what the editor writes as one (frontend docs-editor core/markdown.mjs): a heading, a
paragraph, a list, a quote, a table, a fenced code block or equation, a divider, a leaf directive
(``::embed{…}``) or a container (``:::note … :::``, holding blocks of its own). A block's anchor is
its ``{#b-…}`` (core/attrs.mjs): at the end of a heading or paragraph, on a container's opening
line, or on the line of attributes after a table (a blank line between), a code block, an
equation or a divider. Other attributes (``{bg=yellow}``, ``{color=red}``, ``{widths=…}``) are
never part of the text a heading is matched by.

Pure: no database. Line numbers are indexes into ``markdown.split("\\n")``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.services.md_outline import inline_text

ANCHOR = re.compile(r"^#?(b-[a-z0-9]{4,12})$")
_BID = re.compile(r"\{#(b-[a-z0-9]{4,12})(?=[\s}])[^}\n]*\}")
_ATTR_ONLY = re.compile(r"^[ \t]*\{([^{}\n]*)\}[ \t]*$")
_TRAIL = re.compile(r"[ \t]*\{([^{}\n]*)\}[ \t]*$")
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
_MATH = re.compile(r"^ {0,3}\$\$[ \t]*$")
_OPEN = re.compile(r"^ {0,3}(:{3,})([A-Za-z][\w-]*)")
_CLOSE = re.compile(r"^ {0,3}(:{3,})[ \t]*$")
_LEAF = re.compile(r"^ {0,3}::[A-Za-z][\w-]*(?:\[[^\]\n]*\])?(?:\{[^}\n]*\})?[ \t]*$")
_HEADING = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$")
_HR = re.compile(r"^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$")
_ITEM = re.compile(r"^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)")
_QUOTE = re.compile(r"^ {0,3}>")
_ROW = re.compile(r"^ {0,3}\|")
_RULE = re.compile(r"^ {0,3}\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$")
_INLINE_DIR = re.compile(r"(?<![\w:]):([A-Za-z][\w-]*)\[([^\]\n]*)\](?:\{[^}\n]*\})?")
_LEAF_INLINE = re.compile(r"(?<![\w:])::?[A-Za-z][\w-]*\{[^}\n]*\}")
_PIPE = re.compile(r"(?<!\\)\|")
# Blocks a line of attributes after them belongs to.
_TAKES_ATTR_LINE = {"table", "code", "math", "hr"}


@dataclass
class Block:
    start: int
    end: int  # exclusive
    kind: str
    bid: str | None = None
    level: int = 0  # headings
    children: list["Block"] = field(default_factory=list)

    def walk(self):
        yield self
        for c in self.children:
            yield from c.walk()


# ── Text a reader sees ────────────────────────────────────────────────────────


def visible(src: str) -> str:
    """Inline Markdown → its text: anchors and attribute lists go, ``:span[text]{bg=…}`` and
    ``:person[Name]{…}`` read as their text, emphasis and links as their words."""
    s = _BID.sub("", src or "")
    s = _TRAIL.sub("", s)
    s = _INLINE_DIR.sub(lambda m: m.group(2), s)
    s = _LEAF_INLINE.sub("", s)
    return inline_text(s)


def heading_text(line: str) -> str:
    """A heading line (or what someone typed for one: '## Rollout {bg=blue}') → its text."""
    s = re.sub(r"^\s{0,3}#{1,6}(?=\s|$)", "", line or "")
    s = _BID.sub("", s)
    s = _TRAIL.sub("", s)
    s = re.sub(r"(?:^|[ \t]+)#+[ \t]*$", "", s)
    return visible(s)


def norm(text: str) -> str:
    return " ".join((text or "").split()).casefold()


def anchor_of(ref: str | None) -> str | None:
    """``b-k3x9a1`` or ``#b-k3x9a1`` → the anchor; anything else None."""
    m = ANCHOR.match((ref or "").strip())
    return m.group(1) if m else None


# ── Splitting ─────────────────────────────────────────────────────────────────


def front_matter_end(lines: list[str]) -> int:
    """The first line after the front matter (0 when there is none)."""
    if not lines or lines[0].rstrip() != "---":
        return 0
    for i in range(1, len(lines)):
        if lines[i].rstrip() in ("---", "..."):
            return i + 1
    return 0


def _fence_end(lines: list[str], i: int, hi: int) -> int:
    mark = _FENCE.match(lines[i]).group(1)
    close = re.compile(rf"^ {{0,3}}{re.escape(mark[0])}{{{len(mark)},}}[ \t]*$")
    j = i + 1
    while j < hi and not close.match(lines[j]):
        j += 1
    return min(j + 1, hi)


def _container_end(lines: list[str], i: int, hi: int) -> tuple[int, bool]:
    """(the line after the container opened at ``i``, whether a closing line was found)."""
    stack = [len(_OPEN.match(lines[i]).group(1))]
    j = i + 1
    while j < hi and stack:
        line = lines[j]
        if _FENCE.match(line):
            j = _fence_end(lines, j, hi)
            continue
        c = _CLOSE.match(line)
        if c:
            n = len(c.group(1))
            while stack:
                if stack.pop() <= n:
                    break
        elif _OPEN.match(line):
            stack.append(len(_OPEN.match(line).group(1)))
        j += 1
    return j, not stack


def _interrupts(line: str) -> bool:
    return bool(_FENCE.match(line) or _OPEN.match(line) or _HEADING.match(line) or _MATH.match(line)
                or _CLOSE.match(line))


def _bid(lines: list[str], idx: list[int]) -> str | None:
    for k in idx:
        m = _BID.search(lines[k])
        if m:
            return m.group(1)
    return None


def split(lines: list[str], lo: int = 0, hi: int | None = None) -> list[Block]:
    """The blocks between lines ``lo`` and ``hi`` (front matter excluded at the top)."""
    hi = len(lines) if hi is None else hi
    if lo == 0:
        lo = front_matter_end(lines)
    out: list[Block] = []
    i = lo
    while i < hi:
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        if _FENCE.match(line) or _MATH.match(line):
            if _FENCE.match(line):
                end = _fence_end(lines, i, hi)
                kind = "code"
            else:
                end = i + 1
                while end < hi and not _MATH.match(lines[end]):
                    end += 1
                end = min(end + 1, hi)
                kind = "math"
            out.append(Block(i, end, kind))
            i = end
            continue
        if _OPEN.match(line):
            end, closed = _container_end(lines, i, hi)
            b = Block(i, end, "container", _bid(lines, [i]))
            b.children = split(lines, i + 1, end - 1 if closed else end) if end - i > 1 else []
            out.append(b)
            i = end
            continue
        if _CLOSE.match(line):  # a stray closing line: its own block, so nothing swallows it
            out.append(Block(i, i + 1, "other"))
            i += 1
            continue
        h = _HEADING.match(line)
        if h:
            out.append(Block(i, i + 1, "heading", _bid(lines, [i]), level=len(h.group(1))))
            i += 1
            continue
        if _LEAF.match(line):
            out.append(Block(i, i + 1, "leaf", _bid(lines, [i])))
            i += 1
            continue
        if _HR.match(line):
            out.append(Block(i, i + 1, "hr"))
            i += 1
            continue
        j = i + 1
        while j < hi and lines[j].strip() and not _interrupts(lines[j]):
            j += 1
        if _ROW.match(line) and j - i >= 2 and _RULE.match(lines[i + 1]):
            kind = "table"
        elif _ITEM.match(line):
            kind = "list"
        elif _QUOTE.match(line):
            kind = "quote"
        elif line.lstrip().startswith("<"):
            kind = "html"
        else:
            kind = "paragraph"
        # A line of attributes after a table (blank line between), a code block, an equation or a
        # divider (right after it) is that block's.
        if kind == "paragraph" and j - i == 1 and _ATTR_ONLY.match(line) and out \
                and out[-1].kind in _TAKES_ATTR_LINE:
            prev = out[-1]
            gap = i - prev.end
            if (prev.kind == "table" and gap <= 1) or (prev.kind != "table" and gap == 0):
                prev.end = i + 1
                prev.bid = prev.bid or _bid(lines, [i])
                i = j
                continue
        out.append(Block(i, j, kind, _bid(lines, list(range(i, j))) if kind != "list" else None))
        i = j
    return out


def parse(markdown: str) -> tuple[list[str], list[Block]]:
    lines = (markdown or "").split("\n")
    return lines, split(lines)


def all_blocks(blocks: list[Block]):
    for b in blocks:
        yield from b.walk()


def find_block(blocks: list[Block], bid: str) -> tuple[Block, list[Block]] | None:
    """(the block anchored ``bid``, the list it is in) — top level or inside a container."""
    for b in blocks:
        if b.bid == bid:
            return b, blocks
        if b.children:
            hit = find_block(b.children, bid)
            if hit:
                return hit
    return None


def anchored(blocks: list[Block]) -> list[Block]:
    return [b for b in all_blocks(blocks) if b.bid]


# ── Headings and sections ─────────────────────────────────────────────────────


def heading_blocks(blocks: list[Block]) -> list[Block]:
    """The top-level headings (a heading inside a callout doesn't start a section)."""
    return [b for b in blocks if b.kind == "heading"]


def find_heading(lines: list[str], blocks: list[Block], ref: str) -> Block | None:
    """The first top-level heading whose text is ``ref`` (case, #s, anchors and attributes
    ignored), or whose anchor it is."""
    bid = anchor_of(ref)
    hs = heading_blocks(blocks)
    if bid:
        for b in hs:
            if b.bid == bid:
                return b
    want = norm(heading_text(ref))
    if not want:
        return None
    for b in hs:
        if norm(heading_text(lines[b.start])) == want:
            return b
    return None


def section_range(lines: list[str], blocks: list[Block], ref: str | None) -> tuple[int, int, Block | None] | None:
    """(first line, end line exclusive, heading) of a section: from the heading named (text or
    anchor) to the next heading of the same or a higher level. ``ref`` None or "": the preamble,
    from after the front matter to the first heading (heading None)."""
    hs = heading_blocks(blocks)
    if not (ref or "").strip():
        start = front_matter_end(lines)
        end = hs[0].start if hs else len(lines)
        return start, end, None
    h = find_heading(lines, blocks, ref)
    if h is None:
        return None
    end = len(lines)
    for b in hs:
        if b.start > h.start and b.level <= h.level:
            end = b.start
            break
    return h.start, end, h


def join(parts: list[str]) -> str:
    chunks = [p.strip("\n") for p in parts if p is not None and p.strip("\n") != ""]
    return "\n\n".join(chunks) + "\n"


def splice(lines: list[str], start: int, end: int, new: str | None) -> str:
    """The page with lines [start, end) replaced by ``new`` (None or "": removed), blocks kept
    apart by one blank line and the front matter left as it was."""
    fm = front_matter_end(lines)
    head = "\n".join(lines[:start])
    if start < fm:
        raise ValueError("front matter")
    return join([head, new or "", "\n".join(lines[end:])])


def replace_preamble(markdown: str, new: str) -> str:
    """Everything before the first heading (after the front matter) replaced by ``new``."""
    lines, blocks = parse(markdown)
    start, end, _h = section_range(lines, blocks, None)
    if start == 0:
        return join([new, "\n".join(lines[end:])])
    return join(["\n".join(lines[:start]), new, "\n".join(lines[end:])])


_ATTR_LIST = re.compile(r"""^\s*(?:(?:#[\w-]+|[a-z][a-z-]*(?:=(?:"[^"\n]*"|[^\s"'=<>`{}]+))?)\s*)+$""")


def _with_anchor(line: str, bid: str, *, space: bool = True) -> str:
    """``line`` with ``#bid`` first in its trailing attribute list, or a new list after it."""
    m = _TRAIL.search(line)
    if m and _ATTR_LIST.match(m.group(1)):
        return f"{line[:m.start()]}{m.group(0)[:m.group(0).index('{')]}{{#{bid} {m.group(1).strip()}}}"
    return f"{line.rstrip()}{' ' if space else ''}{{#{bid}}}"


def attach_id(markdown: str, bid: str) -> str | None:
    """``markdown`` — one block — with the anchor ``bid`` where that kind of block keeps it (so
    links and comments on the block it replaces still find it). None when it isn't one block that
    can carry one, or already has an anchor."""
    if _BID.search(markdown or ""):
        return None
    lines, blocks = parse((markdown or "").strip("\n"))
    if len(blocks) != 1:
        return None
    b = blocks[0]
    if b.kind in ("heading", "paragraph"):
        k = b.end - 1
        lines[k] = _with_anchor(lines[k], bid)
    elif b.kind in ("container", "leaf"):
        lines[b.start] = _with_anchor(lines[b.start], bid, space=False)
    elif b.kind in _TAKES_ATTR_LINE:
        last = b.end - 1
        if last > b.start and _ATTR_ONLY.match(lines[last]) and _ATTR_LIST.match(_ATTR_ONLY.match(lines[last]).group(1)):
            lines[last] = "{#" + bid + " " + _ATTR_ONLY.match(lines[last]).group(1).strip() + "}"
        else:
            lines[b.end:b.end] = (["", "{#" + bid + "}"] if b.kind == "table" else ["{#" + bid + "}"])
    else:
        return None
    return "\n".join(lines)


# ── Outline ───────────────────────────────────────────────────────────────────


def _preview(lines: list[str], b: Block, n: int = 80) -> str:
    if b.kind == "heading":
        t = heading_text(lines[b.start])
    elif b.kind in ("code", "math"):
        first = lines[b.start].strip()
        body = [ln for ln in lines[b.start + 1:b.end] if ln.strip()][:1]
        t = first + (" " + body[0].strip() if body else "")
    elif b.kind == "container":
        t = lines[b.start].strip()
    elif b.kind == "table":
        t = " | ".join(visible(c) for c in cells(lines[b.start]))
    else:
        t = visible(" ".join(ln.strip() for ln in lines[b.start:b.end]))
    return t if len(t) <= n else t[: n - 1].rstrip() + "…"


def outline(markdown: str) -> dict:
    """The page's shape, small: its headings (level, text, anchor, size), anchored blocks and
    tables, each with the section it is in (None = the preamble)."""
    lines, blocks = parse(markdown)
    hs = heading_blocks(blocks)
    pre = section_range(lines, blocks, None)
    sections = []
    for n, h in enumerate(hs):
        end = len(lines)
        for b in hs[n + 1:]:
            if b.level <= h.level:
                end = b.start
                break
        sections.append({"level": h.level, "text": heading_text(lines[h.start]), "id": h.bid,
                         "line": h.start + 1, "chars": len("\n".join(lines[h.start:end]))})

    def section_of(line: int) -> str | None:
        name = None
        for h in hs:
            if h.start <= line:
                name = heading_text(lines[h.start])
            else:
                break
        return name

    blocks_out = [{"id": b.bid, "kind": b.kind, "section": section_of(b.start), "line": b.start + 1,
                   "preview": _preview(lines, b)} for b in anchored(blocks) if b.kind != "heading"]
    tables = []
    for n, t in enumerate([b for b in all_blocks(blocks) if b.kind == "table"], start=1):
        rows = table_rows(lines, t)
        tables.append({"index": n, "id": t.bid, "section": section_of(t.start), "line": t.start + 1,
                       "columns": [visible(c) for c in cells(lines[t.start])], "rows": len(rows)})
    pre_chars = len("\n".join(lines[pre[0]:pre[1]]).strip())
    return {"preamble_chars": pre_chars, "headings": sections, "blocks": blocks_out, "tables": tables}


def sections_markdown(markdown: str, refs: list[str | None]) -> tuple[str, list[str]]:
    """The sections named (text or anchor; None or "" = the preamble), in the order asked, and the
    names that matched nothing."""
    lines, blocks = parse(markdown)
    parts, missing = [], []
    for ref in refs:
        r = section_range(lines, blocks, ref)
        if r is None:
            missing.append(str(ref))
            continue
        parts.append("\n".join(lines[r[0]:r[1]]).strip("\n"))
    return ("\n\n".join(p for p in parts if p) + "\n") if any(parts) else "", missing


# ── Tables ────────────────────────────────────────────────────────────────────


def cells(line: str) -> list[str]:
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|") and not s.endswith("\\|"):
        s = s[:-1]
    return [c.strip() for c in _PIPE.split(s)]


def table_rows(lines: list[str], t: Block) -> list[int]:
    """The line numbers of a table's body rows (not the header, the rule or its attributes)."""
    out = []
    for k in range(t.start + 2, t.end):
        line = lines[k]
        if not line.strip() or _ATTR_ONLY.match(line):
            break
        out.append(k)
    return out


def cell_text(cell: str) -> str:
    return visible(cell)


def cell_attrs(cell: str) -> str:
    """A cell's trailing attribute list (``{bg="blue"}``), kept when only its text changes."""
    m = _TRAIL.search(cell)
    if not m or _BID.search(cell[m.start():]):
        return "" if not m else m.group(0).strip()
    return m.group(0).strip()


def cell_source(value) -> str:
    """A value as one cell's Markdown: one line, its pipes escaped."""
    s = "" if value is None else str(value)
    s = " ".join(s.replace("\r", "").split("\n")).strip()
    return _PIPE.sub(r"\\|", s)


def row_line(values: list[str]) -> str:
    return "| " + " | ".join(values) + " |"


def find_table(lines: list[str], blocks: list[Block], ref) -> tuple[Block | None, list[Block]]:
    """A table by anchor, by number (1 = the first on the page) or by the heading of the section
    it is in (its first table). (the table or None, every table)."""
    tables = [b for b in all_blocks(blocks) if b.kind == "table"]
    if ref is None or (isinstance(ref, str) and not ref.strip()):
        return (tables[0] if len(tables) == 1 else None), tables
    if isinstance(ref, int) or (isinstance(ref, str) and ref.strip().isdigit()):
        n = int(ref)
        return (tables[n - 1] if 1 <= n <= len(tables) else None), tables
    bid = anchor_of(ref)
    if bid:
        return next((t for t in tables if t.bid == bid), None), tables
    r = section_range(lines, blocks, ref)
    if r is None:
        return None, tables
    return next((t for t in tables if r[0] <= t.start < r[1]), None), tables
