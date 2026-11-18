"""The intermediate tree every Notion source yields and the writer consumes.

A source (an export zip today, the Notion API in Phase B) produces a :class:`SourceTree`: one
:class:`SourceNode` per page, database and database row, each with its Notion id, title, icon/cover,
parent, blocks (``blocks.py``), property values (rows) or columns (databases), the assets it refers to,
and Notion's ``last_edited`` when the source knows it.

Blocks hold inline Markdown text. A link to another Notion page is ``notion://<id>``; a link to a file
the source holds (an image, an attachment) is ``notion-asset://<source path>`` — the writer resolves both
(to the Markdrop page, to an uploaded page image or file), so a source never needs to know Markdrop.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator

PAGE = "page"
DATABASE = "database"
ROW = "row"


@dataclass
class Column:
    name: str
    # A Notion type when the source knows it (the API does; an export's CSV doesn't: props.py infers).
    notion_type: str | None = None


@dataclass
class SourceNode:
    notion_id: str
    kind: str                                   # page | database | row
    title: str
    parent_id: str | None = None                # None: a top-level item of the source
    icon: str | None = None                     # an emoji, or notion-asset://… / https:// image
    cover: str | None = None                    # notion-asset://… or https://
    blocks: list[dict] = field(default_factory=list)
    # A row's values by column name, as Notion shows them (text); a database's columns in order.
    values: dict[str, str] = field(default_factory=dict)
    columns: list[Column] = field(default_factory=list)
    last_edited: str | None = None
    path: str = ""                              # where it came from (for the report)
    order: int = 0
    raw: bytes = b""                            # the source's own bytes for it (the change hash)

    def source_hash(self) -> str:
        h = hashlib.sha256()
        h.update(self.raw)
        h.update(json.dumps([self.title, self.icon, self.cover, self.values,
                             [c.name for c in self.columns]], sort_keys=True, ensure_ascii=False).encode())
        return h.hexdigest()[:32]


@dataclass
class SourceTree:
    name: str                                   # the export's name (the default folder name)
    nodes: dict[str, SourceNode] = field(default_factory=dict)
    # path → bytes reader for the files pages refer to (images, attachments)
    read_asset: Callable[[str], bytes | None] = lambda _p: None
    asset_size: Callable[[str], int | None] = lambda _p: None
    skipped: list[dict] = field(default_factory=list)   # {path, title, reason}

    def add(self, node: SourceNode) -> None:
        node.order = len(self.nodes)
        self.nodes[node.notion_id] = node

    def children(self, notion_id: str | None) -> list[SourceNode]:
        return sorted((n for n in self.nodes.values() if n.parent_id == notion_id), key=lambda n: n.order)

    def walk(self) -> Iterator[tuple[SourceNode, int]]:
        """Parents before children, in the source's order: (node, depth)."""
        def rec(pid: str | None, depth: int) -> Iterator[tuple[SourceNode, int]]:
            for n in self.children(pid):
                yield n, depth
                yield from rec(n.notion_id, depth + 1)
        yield from rec(None, 0)

    def roots(self) -> list[SourceNode]:
        return self.children(None)


def walk_blocks(blocks: list[dict]) -> Iterator[dict]:
    for b in blocks:
        yield b
        for k in ("children",):
            if isinstance(b.get(k), list):
                yield from walk_blocks(b[k])
        for col in b.get("columns") or []:
            yield from walk_blocks(col)


def asset_refs(node: SourceNode) -> list[str]:
    """Every notion-asset:// path the node's blocks, icon and cover refer to, in order, once each."""
    import re
    from urllib.parse import unquote

    seen: list[str] = []

    def add(p: str | None) -> None:
        p = unquote(p) if p else p
        if p and p not in seen:
            seen.append(p)

    for v in (node.icon, node.cover):
        if v and v.startswith("notion-asset://"):
            add(v[len("notion-asset://"):])
    rx = re.compile(r"notion-asset://([^)\s\"]+)")
    for b in walk_blocks(node.blocks):
        src = b.get("src")
        if isinstance(src, str) and src.startswith("notion-asset://"):
            add(src[len("notion-asset://"):])
        for k in ("text", "caption"):
            if isinstance(b.get(k), str):
                for m in rx.finditer(b[k]):
                    add(m.group(1))
        for row in b.get("rows") or []:
            for cell in row:
                for m in rx.finditer(cell or ""):
                    add(m.group(1))
    return seen


def asset_url(path: str) -> str:
    """notion-asset://<path>, quoted so it sits in a Markdown link (no spaces or brackets)."""
    from urllib.parse import quote

    return "notion-asset://" + quote(path, safe="/")


def jsonable(v: Any) -> Any:
    return json.loads(json.dumps(v, default=str))
