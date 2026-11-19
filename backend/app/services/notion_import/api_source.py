"""The Notion API source: the pages a person shared with Markdrop → the same intermediate tree (tree.py)
the export adapter makes, so the writer (writer.py) is the same.

    shared(client)            what Markdrop can read (``POST /v1/search``: pages and data sources), for the
                              picker: pages and databases, each with its parent when that is shared too
                              (database rows aren't listed: they come with their database)
    Builder.build(roots)      the tree under the chosen pages / databases:
        page                  ``GET /v1/pages/{id}`` (title, icon, cover, last_edited_time) and its blocks
                              (``GET /v1/blocks/{id}/children``, paginated, nested blocks fetched too);
                              child pages and child databases become nodes of their own
        database              ``GET /v1/databases/{id}`` → its data source (``GET /v1/data_sources/{id}``:
                              the columns, typed) → its rows (``POST /v1/data_sources/{id}/query``), each a
                              row node with its values as text (props.py reads them like an export's CSV)

Only what changed: a page whose ``last_edited_time`` is the one Markdrop last wrote (and was written well
after it: Notion rounds it to the minute) isn't fetched again: it comes back ``unchanged`` with the
sub-pages its link remembers. A scheduled sync first asks search which pages were edited since the last
one, and doesn't even read the rest.

Files Notion hosts have signed URLs that expire after an hour: each one is downloaded as soon as its
block is read (into the job's temporary folder), and if the link has expired anyway the block (or page)
is read again for a fresh one. External files and images stay links.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import posixpath
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable
from urllib.parse import unquote, urlsplit

from app.services.notion_import import api, notion_md
from app.services.notion_import.export_zip import notion_url_id
from app.services.notion_import.tree import DATABASE, PAGE, ROW, Column, SourceNode, SourceTree, asset_url

log = logging.getLogger("markdrop.notion")

MAX_NODES = 5000
MAX_DEPTH = 12                      # nested blocks
MAX_LIST = 2000                     # the picker
MAX_FILE = 50 * 1024 * 1024         # writer.MAX_FILE_BYTES
MAX_TOTAL_FILES = 2 * 1024 ** 3     # one run's downloads
SETTLE = timedelta(minutes=2)       # last_edited_time is rounded to the minute
_HEX = re.compile(r"^[0-9a-f]{32}$")
_REL_HREF = re.compile(r"^/(?:[^/?#]*-)?([0-9a-f]{32})(?:[?#].*)?$", re.I)


def hexid(v: str | None) -> str:
    return (v or "").replace("-", "").lower()


def dashed(v: str) -> str:
    h = hexid(v)
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}" if len(h) == 32 else v


def _ts(v: str | None) -> datetime | None:
    if not v:
        return None
    try:
        d = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _aware(d: Any) -> datetime | None:
    if not isinstance(d, datetime):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


# ── Rich text ─────────────────────────────────────────────────────────────────


def plain(rich: list | None) -> str:
    return "".join(str(t.get("plain_text") or "") for t in rich or [])


def _page_href(href: str) -> str | None:
    """A Notion page id when ``href`` links to a Notion page ("/<id>", notion.so/…), else None."""
    m = _REL_HREF.match(href or "")
    if m:
        return m.group(1).lower()
    return notion_url_id(href) if href.startswith("http") else None


def _wrap(s: str, a: dict) -> str:
    core = s.strip()
    if not core:
        return s
    lead, trail = s[: len(s) - len(s.lstrip())], s[len(s.rstrip()):]
    if a.get("code"):
        core = f"`{core}`"
    if a.get("bold"):
        core = f"**{core}**"
    if a.get("italic"):
        core = f"*{core}*"
    if a.get("strikethrough"):
        core = f"~~{core}~~"
    return lead + core + trail


def md(rich: list | None) -> str:
    """Notion rich text → the tree's inline Markdown (links to Notion pages: notion://<id>)."""
    out: list[str] = []
    for t in rich or []:
        typ = t.get("type")
        text = str(t.get("plain_text") or "")
        if typ == "equation":
            out.append(f"${(t.get('equation') or {}).get('expression', '')}$")
            continue
        if typ == "mention":
            m = t.get("mention") or {}
            mt = m.get("type")
            if mt in ("page", "database", "data_source"):
                pid = hexid((m.get(mt) or {}).get("id"))
                out.append(f"[{text or 'Untitled'}](notion://{pid})" if pid else text)
            elif mt in ("link_preview", "link_mention"):
                url = (m.get(mt) or {}).get("url") or t.get("href")
                out.append(f"[{text or url}]({url})" if url else text)
            else:
                out.append(text)
            continue
        s = _wrap(text, t.get("annotations") or {})
        href = t.get("href") or ((t.get("text") or {}).get("link") or {}).get("url")
        if href:
            pid = _page_href(href)
            label = s.strip() or href
            s = f"[{label}](notion://{pid})" if pid else f"[{label}]({href})"
        out.append(s)
    return "".join(out)


# ── Property values → text (what an export's CSV would say) ───────────────────


def _user(u: dict) -> str:
    return str(((u.get("person") or {}).get("email")) or u.get("name") or "").strip()


def prop_text(p: dict) -> str:
    t = p.get("type")
    v = p.get(t)
    if v is None:
        return ""
    if t in ("title", "rich_text"):
        return plain(v)
    if t == "checkbox":
        return "Yes" if v else "No"
    if t == "number":
        return "" if v is None else (str(int(v)) if isinstance(v, float) and v.is_integer() else str(v))
    if t in ("select", "status"):
        return str(v.get("name") or "") if isinstance(v, dict) else ""
    if t == "multi_select":
        return ", ".join(str(o.get("name") or "").replace(",", " ") for o in v)
    if t == "date":
        start, end = v.get("start"), v.get("end")
        return f"{start} → {end}" if start and end else (start or "")
    if t == "people":
        return ", ".join(x for x in (_user(u) for u in v) if x)
    if t in ("created_by", "last_edited_by"):
        return _user(v)
    if t == "relation":
        return ", ".join(f"Page (Page%20{hexid(r.get('id'))}.md)" for r in v if r.get("id"))
    if t in ("url", "email", "phone_number", "created_time", "last_edited_time"):
        return str(v)
    if t == "files":
        return ", ".join(str(f.get("name") or "") for f in v)
    if t == "unique_id":
        n = v.get("number")
        return "" if n is None else (f"{v['prefix']}-{n}" if v.get("prefix") else str(n))
    if t == "formula":
        ft = v.get("type")
        fv = v.get(ft)
        if ft == "boolean":
            return "Yes" if fv else "No"
        if ft == "date":
            return (fv or {}).get("start") or ""
        return "" if fv is None else str(fv)
    if t == "rollup":
        rt = v.get("type")
        rv = v.get(rt)
        if rt == "array":
            return ", ".join(x for x in (prop_text(i) for i in rv or []) if x)
        if rt == "date":
            return (rv or {}).get("start") or ""
        return "" if rv is None else str(rv)
    return ""


def title_of(obj: dict) -> str:
    """A page's title (its title property) or a database's / data source's."""
    if isinstance(obj.get("title"), list):
        return plain(obj["title"]).strip()
    for p in (obj.get("properties") or {}).values():
        if p.get("type") == "title":
            return plain(p.get("title")).strip()
    return ""


def emoji_of(icon: dict | None) -> str | None:
    if icon and icon.get("type") == "emoji":
        return icon.get("emoji")
    return None


# ── The picker ────────────────────────────────────────────────────────────────

BLOCK_LOOKUPS = 80                  # the picker: blocks read to find the page a page sits in
ROWS_PAGE = 50                      # the picker: a database's rows, a page at a time


def _parent_ref(obj: dict) -> tuple[str | None, str | None]:
    """(kind, hex id) of what an object sits in: ("page", id), ("database", id), ("block", id) or (None, None)."""
    par = obj.get("parent") or {}
    t = par.get("type")
    if t == "page_id":
        return "page", hexid(par.get("page_id"))
    if t in ("database_id", "data_source_id"):
        return "database", hexid(par.get("database_id") or par.get("data_source_id"))
    if t == "block_id":
        return "block", hexid(par.get("block_id"))
    return None, None


class _Blocks:
    """The page (or database) a block sits in, read up through its parent blocks (a page in a column, a
    toggle, a synced block). Cached, and at most ``BLOCK_LOOKUPS`` reads per listing: past that (or when a
    block can't be read) the item stays at the top level."""

    def __init__(self, client: api.Client, budget: int = BLOCK_LOOKUPS):
        self.c = client
        self.budget = budget
        self.cache: dict[str, tuple[str | None, str | None]] = {}

    async def owner(self, bid: str) -> tuple[str | None, str | None]:
        seen: list[str] = []
        cur = bid
        res: tuple[str | None, str | None] = (None, None)
        for _ in range(16):
            if cur in self.cache:
                res = self.cache[cur]
                break
            if self.budget <= 0:
                break
            self.budget -= 1
            try:
                b = await self.c.call("GET", f"/v1/blocks/{dashed(cur)}")
            except api.NotionError as exc:
                if exc.auth:
                    raise
                break
            seen.append(cur)
            k, pid = _parent_ref(b)
            if k == "block" and pid:
                cur = pid
                continue
            res = (k, pid)
            break
        for s in seen:
            self.cache[s] = res
        return res


async def shared(client: api.Client) -> dict:
    """What Markdrop can read, as Notion nests it, for the picker::

        {items: [{id, kind (page|database), title, icon, parent_id, parent_kind, url, last_edited,
                  row_count (databases)}],
         row_parents: {row id: database id}, truncated}

    Every item names its real parent: a page (``parent_kind`` "page"), a database row ("row": the row comes
    with its database, see :func:`database_rows`) or, for a page inside a block (a column, a toggle), the
    page that block is in. Nothing is listed twice. Database rows aren't items: they're counted on their
    database (``row_count``, what search returned) and listed when the database is opened; a row whose
    database isn't shared with Markdrop is an item of its own (a page). An item whose parent isn't shared
    sits at the top level (``parent_id`` null). ``row_parents``: the database of each row that has shared
    sub-pages listed here."""
    pages: dict[str, dict] = {}
    dbs: dict[str, dict] = {}
    n = 0
    truncated = False
    async for obj in client.pages("POST", "/v1/search", json={
            "sort": {"timestamp": "last_edited_time", "direction": "descending"}}):
        n += 1
        if n > MAX_LIST:
            truncated = True
            break
        if obj.get("in_trash") or obj.get("archived"):
            continue
        kind = obj.get("object")
        if kind == "page":
            pages.setdefault(hexid(obj.get("id")), obj)
        elif kind in ("data_source", "database"):
            par = obj.get("parent") or {}
            dbid = hexid(par.get("database_id")) if par.get("type") == "database_id" else hexid(obj.get("id"))
            if dbid and dbid not in dbs:
                dpar = obj.get("database_parent") or (obj.get("parent") if kind == "database" else None) or {}
                dbs[dbid] = {"obj": obj, "parent": _parent_ref({"parent": dpar})}
    blocks = _Blocks(client)

    async def where(ref: tuple[str | None, str | None]) -> tuple[str | None, str | None]:
        k, pid = ref
        if k == "block" and pid:
            return await blocks.owner(pid)
        return k, pid

    items: dict[str, dict] = {}
    parents: dict[str, tuple[str | None, str | None]] = {}
    rows: dict[str, str] = {}                 # row id → its (shared) database
    row_count: dict[str, int] = {}
    for pid_, obj in pages.items():
        k, p = await where(_parent_ref(obj))
        if k == "database" and p in dbs:
            rows[pid_] = p
            row_count[p] = row_count.get(p, 0) + 1
            continue
        items[pid_] = {"id": pid_, "kind": "page", "title": title_of(obj) or "Untitled",
                       "icon": emoji_of(obj.get("icon")), "url": obj.get("url"),
                       "last_edited": obj.get("last_edited_time")}
        parents[pid_] = (k, p) if k == "page" else (None, None)
    for dbid, d in dbs.items():
        obj = d["obj"]
        k, p = await where(d["parent"])
        items[dbid] = {"id": dbid, "kind": "database", "title": title_of(obj) or "Untitled database",
                       "icon": emoji_of(obj.get("icon")), "url": obj.get("url"),
                       "last_edited": obj.get("last_edited_time")}
        parents[dbid] = (k, p) if k == "page" else (None, None)
    row_parents: dict[str, str] = {}
    for iid, it in items.items():
        _k, p = parents[iid]
        if p and p != iid and p in rows:
            it["parent_id"], it["parent_kind"] = p, "row"
            row_parents[p] = rows[p]
        elif p and p != iid and p in items:
            it["parent_id"], it["parent_kind"] = p, "page" if items[p]["kind"] == "page" else "database"
        else:
            it["parent_id"], it["parent_kind"] = None, None
        if it["kind"] == "database":
            it["row_count"] = row_count.get(iid, 0)
    out = sorted(items.values(), key=lambda x: (x["title"] or "").casefold())
    return {"items": out, "row_parents": row_parents, "truncated": truncated}


async def database_rows(client: api.Client, db_id: str, cursor: str | None = None,
                        size: int = ROWS_PAGE) -> dict:
    """One page of a database's rows, for the picker: {items: [{id, kind: "row", title, icon, parent_id
    (the database), parent_kind, url, last_edited}], next_cursor}."""
    nid = hexid(db_id)
    d = await client.call("GET", f"/v1/databases/{dashed(nid)}")
    sources = d.get("data_sources") or []
    if not sources or d.get("in_trash") or d.get("archived"):
        return {"items": [], "next_cursor": None}
    body: dict[str, Any] = {"page_size": max(1, min(100, int(size)))}
    if cursor:
        body["start_cursor"] = cursor
    res = await client.call("POST", f"/v1/data_sources/{sources[0]['id']}/query", json=body)
    out = []
    for r in res.get("results") or []:
        if r.get("in_trash") or r.get("archived") or r.get("object") != "page":
            continue
        out.append({"id": hexid(r.get("id")), "kind": "row", "title": title_of(r) or "Untitled",
                    "icon": emoji_of(r.get("icon")), "parent_id": nid, "parent_kind": "database",
                    "url": r.get("url"), "last_edited": r.get("last_edited_time")})
    more = bool(res.get("has_more")) and bool(res.get("next_cursor"))
    return {"items": out, "next_cursor": res.get("next_cursor") if more else None}


async def edited_since(client: api.Client, since: datetime) -> set[str]:
    """Ids of the pages (and data sources' databases) edited at or after ``since`` (search, newest first)."""
    out: set[str] = set()
    async for obj in client.pages("POST", "/v1/search", json={
            "sort": {"timestamp": "last_edited_time", "direction": "descending"}}, limit=20_000):
        t = _ts(obj.get("last_edited_time"))
        if t is not None and t < since:
            break
        out.add(hexid(obj.get("id")))
        par = obj.get("parent") or {}
        if obj.get("object") == "data_source" and par.get("database_id"):
            out.add(hexid(par["database_id"]))
    return out


# ── The tree ──────────────────────────────────────────────────────────────────


Progress = Callable[[str, int, int, str | None], Awaitable[bool]]


class Stop(Exception):
    """The job was cancelled while reading."""


class Builder:
    """Reads the chosen roots into a :class:`SourceTree`. ``known``: the writer's links for the destination
    (notion id → row), so unchanged pages aren't read again. ``changed``: from :func:`edited_since` (a
    scheduled sync), or None (read every page's ``last_edited_time``). ``exclude``: pages, databases and rows
    left out in the picker (unticked under a ticked parent): neither they nor anything under them is read,
    now or on a later sync."""

    def __init__(self, client: api.Client, tmpdir: str, *, known: dict[str, dict] | None = None,
                 changed: set[str] | None = None, progress: Progress | None = None,
                 exclude: set[str] | None = None):
        self.c = client
        self.exclude = {hexid(x) for x in exclude or ()}
        self.left_out = 0
        self.tmp = tmpdir
        self.known = known or {}
        self.changed = changed
        self.progress = progress
        self.tree = SourceTree(name="Notion")
        self.files: dict[str, dict] = {}       # asset path → {file, size}
        self.downloaded = 0
        self.fetched = 0

    # ── assets ──

    def _asset_path(self, owner: str, slot: str, url: str, name: str | None) -> str:
        p = urlsplit(url)
        key = hashlib.sha1(p.path.encode()).hexdigest()[:10]
        nm = (name or unquote(posixpath.basename(p.path)) or "file").replace("/", "_")[:120]
        return f"{owner}/{slot}/{key}/{nm}"

    async def _download(self, path: str, url: str, refetch: Callable[[], Awaitable[str | None]] | None) -> None:
        if path in self.files:
            return
        if self.downloaded >= MAX_TOTAL_FILES:
            self.tree.skipped.append({"path": path, "title": posixpath.basename(path),
                                      "reason": "This import already brought in 2 GB of files: the rest were left out."})
            return
        local = os.path.join(self.tmp, hashlib.sha1(path.encode()).hexdigest())
        size = await self.c.download(url, local, MAX_FILE)
        if size is None and refetch is not None:
            fresh = await refetch()        # the signed link expired: ask Notion for a new one
            if fresh:
                size = await self.c.download(fresh, local, MAX_FILE)
        if size is None:
            self.tree.skipped.append({"path": path, "title": posixpath.basename(path),
                                      "reason": "Notion's link to this file didn't work."})
            return
        if size < 0:
            self.files[path] = {"file": None, "size": MAX_FILE + 1}
            return
        self.downloaded += size
        self.files[path] = {"file": local, "size": size}

    async def file_ref(self, fobj: dict | None, owner: str, slot: str,
                       refetch: Callable[[], Awaitable[dict | None]] | None = None) -> str | None:
        """A Notion file object → notion-asset://… (downloaded now) or its external https:// link."""
        if not fobj:
            return None
        t = fobj.get("type")
        if t == "external":
            url = (fobj.get("external") or {}).get("url") or ""
            return url if url.startswith(("https://", "http://")) else None
        if t != "file":
            return None
        url = (fobj.get("file") or {}).get("url") or ""
        if not url:
            return None
        path = self._asset_path(owner, slot, url, fobj.get("name"))

        async def again() -> str | None:
            if refetch is None:
                return None
            fresh = await refetch()
            return ((fresh or {}).get("file") or {}).get("url") if fresh else None

        await self._download(path, url, again if refetch else None)
        return asset_url(path)

    def read_asset(self, path: str, max_bytes: int | None = None) -> bytes | None:
        f = self.files.get(path)
        if not f or not f.get("file"):
            return None
        with open(f["file"], "rb") as fh:
            return fh.read(max_bytes) if max_bytes else fh.read()

    def asset_size(self, path: str) -> int | None:
        f = self.files.get(path)
        return f["size"] if f else None

    # ── blocks ──

    async def _children(self, block_id: str) -> list[dict]:
        return [b async for b in self.c.pages("GET", f"/v1/blocks/{dashed(block_id)}/children")]

    async def blocks(self, block_id: str, node: SourceNode, depth: int = 0) -> list[dict]:
        out: list[dict] = []
        for b in await self._children(block_id):
            if b.get("in_trash") or b.get("archived"):
                continue
            out.extend(await self.block(b, node, depth))
        return out

    async def _kids(self, b: dict, node: SourceNode, depth: int) -> list[dict]:
        if not b.get("has_children") or depth >= MAX_DEPTH:
            return []
        return await self.blocks(b["id"], node, depth + 1)

    async def _media(self, b: dict, node: SourceNode, t: str) -> dict | None:
        v = b.get(t) or {}
        bid = hexid(b.get("id"))

        async def refetch() -> dict | None:
            got = await self.c.call("GET", f"/v1/blocks/{dashed(bid)}")
            return got.get(t)

        ref = await self.file_ref(v, node.notion_id, bid, refetch)
        caption = plain(v.get("caption")).strip() or None
        if not ref:
            return {"type": "unsupported", "notion_type": t, "text": caption or ""}
        if t == "image":
            return {"type": "image", "src": ref, "alt": caption or "", "caption": caption}
        name = v.get("name") or (unquote(posixpath.basename(urlsplit(ref).path)) if ref.startswith("http") else
                                 posixpath.basename(unquote(ref)))
        if ref.startswith("http") and t in ("video", "audio", "pdf") and notion_md.embeddable(ref):
            return {"type": "embed", "url": ref}
        return {"type": "file", "src": ref, "name": caption or name or "File"}

    async def block(self, b: dict, node: SourceNode, depth: int) -> list[dict]:
        t = b.get("type") or ""
        v = b.get(t) or {}
        rich = v.get("rich_text")
        if t == "paragraph":
            kids = await self._kids(b, node, depth)
            return [{"type": "paragraph", "text": md(rich)}, *kids]
        if t in ("heading_1", "heading_2", "heading_3", "heading_4"):
            level = min(3, int(t[-1]))
            if v.get("is_toggleable"):
                return [{"type": "toggle", "text": md(rich), "heading": level,
                         "children": await self._kids(b, node, depth)}]
            return [{"type": "heading", "level": level, "text": md(rich)}]
        if t in ("bulleted_list_item", "numbered_list_item", "to_do"):
            typ = {"bulleted_list_item": "bulleted", "numbered_list_item": "numbered", "to_do": "todo"}[t]
            out = {"type": typ, "text": md(rich), "children": await self._kids(b, node, depth)}
            if t == "to_do":
                out["checked"] = bool(v.get("checked"))
            return [out]
        if t == "toggle":
            return [{"type": "toggle", "text": md(rich), "children": await self._kids(b, node, depth)}]
        if t == "quote":
            return [{"type": "quote", "text": md(rich), "children": await self._kids(b, node, depth)}]
        if t == "callout":
            kids = await self._kids(b, node, depth)
            first = md(rich)
            return [{"type": "callout", "icon": emoji_of(v.get("icon")),
                     "children": ([{"type": "paragraph", "text": first}] if first.strip() else []) + kids}]
        if t == "code":
            return [{"type": "code", "language": v.get("language") or "", "text": plain(rich)}]
        if t == "equation":
            return [{"type": "equation", "expression": v.get("expression") or ""}]
        if t == "divider":
            return [{"type": "divider"}]
        if t == "table":
            rows = []
            if b.get("has_children"):
                for r in await self._children(b["id"]):
                    if r.get("type") == "table_row":
                        rows.append([md(c) for c in (r.get("table_row") or {}).get("cells") or []])
            return [{"type": "table", "rows": rows, "header_row": bool(v.get("has_column_header", True))}]
        if t == "column_list":
            cols = []
            if b.get("has_children"):
                for col in await self._children(b["id"]):
                    if col.get("type") == "column":
                        cols.append(await self._kids(col, node, depth + 1) if col.get("has_children") else [])
            return [{"type": "columns", "columns": cols}]
        if t in ("image", "file", "pdf", "video", "audio"):
            got = await self._media(b, node, t)
            return [got] if got else []
        if t in ("bookmark", "embed", "link_preview"):
            url = v.get("url") or ""
            if not url:
                return []
            pid = _page_href(url)
            if pid:
                return [{"type": "link_to_page", "id": pid, "title": None}]
            kind = "embed" if (t == "embed" or notion_md.embeddable(url)) else "bookmark"
            out = {"type": kind, "url": url}
            if kind == "bookmark" and plain(v.get("caption")).strip():
                out["title"] = plain(v.get("caption")).strip()
            return [out]
        if t == "child_page":
            cid = hexid(b.get("id"))
            node.child_ids.append(["page", cid])
            return [{"type": "child_page", "id": cid, "title": v.get("title")}]
        if t == "child_database":
            cid = hexid(b.get("id"))
            node.child_ids.append(["database", cid])
            return [{"type": "child_database", "id": cid, "title": v.get("title")}]
        if t == "link_to_page":
            target = v.get(v.get("type") or "") if isinstance(v, dict) else None
            return [{"type": "link_to_page", "id": hexid(target), "title": None}] if target else []
        if t == "synced_block":
            src = (v.get("synced_from") or {}).get("block_id")
            if src:
                try:
                    return await self.blocks(src, node, depth + 1) if depth < MAX_DEPTH else []
                except api.NotionError as exc:
                    if exc.missing:
                        return [{"type": "unsupported", "notion_type": "synced block (its original isn't shared "
                                                                       "with Markdrop)", "text": ""}]
                    raise
            return await self._kids(b, node, depth)
        if t in ("table_of_contents", "breadcrumb", "column", "table_row"):
            return []
        if t == "template":
            return []
        text = md(rich) if isinstance(rich, list) else ""
        kids = await self._kids(b, node, depth)
        return [{"type": "unsupported", "notion_type": t.replace("_", " ") or "block", "text": text}, *kids]

    # ── pages, databases, rows ──

    def _fresh(self, nid: str, last_edited: str | None) -> bool:
        """Notion says it wasn't edited since Markdrop wrote it (and the writer has its children)."""
        link = self.known.get(nid)
        if not link or not link.get("source_hash") or link.get("child_ids") is None or link.get("title") is None:
            return False
        if last_edited is None:
            return False
        if link.get("last_edited") != last_edited:
            return False
        at, synced = _ts(last_edited), _aware(link.get("synced_at"))
        return bool(at and synced and synced >= at + SETTLE)

    async def _tick(self, title: str | None) -> None:
        self.fetched += 1
        if self.progress is not None and not await self.progress("reading", self.fetched, 0, title):
            raise Stop()

    def _add(self, node: SourceNode) -> bool:
        if len(self.tree.nodes) >= MAX_NODES:
            self.tree.skipped.append({"path": node.notion_id, "title": node.title,
                                      "reason": f"Past the {MAX_NODES:,} pages one import takes."})
            return False
        self.tree.add(node)
        return True

    async def _reuse(self, nid: str, kind: str, parent_id: str | None) -> None:
        link = self.known[nid]
        node = SourceNode(notion_id=nid, kind=kind, title=link["title"], parent_id=parent_id, unchanged=True,
                          last_edited=link.get("last_edited"), child_ids=list(link.get("child_ids") or []), path=nid)
        if not self._add(node):
            return
        for k, cid in node.child_ids:
            await self.visit(k, cid, nid)

    async def visit(self, kind: str, nid: str, parent_id: str | None) -> None:
        nid = hexid(nid)
        if not _HEX.match(nid):
            return
        if nid in self.exclude and parent_id is not None:
            self.left_out += 1
            return
        if nid in self.tree.nodes:
            n = self.tree.nodes[nid]
            # Picked on its own and found again under another picked page: it belongs there.
            if n.parent_id is None and parent_id is not None and parent_id != nid:
                n.parent_id = parent_id
            return
        try:
            if kind == "database":
                await self.database(nid, parent_id)
            else:
                await self.page(nid, parent_id)
        except Stop:
            raise
        except api.NotionError as exc:
            if exc.auth:
                raise
            title = (self.known.get(nid) or {}).get("title")
            why = ("It isn't shared with Markdrop any more (or it was deleted)." if exc.missing
                   else f"Notion answered {exc.status}: {exc.message or exc.code}")
            self.tree.skipped.append({"path": nid, "title": title, "reason": why})

    async def page(self, nid: str, parent_id: str | None, *, raw: dict | None = None, kind: str = PAGE,
                   values: dict[str, str] | None = None) -> None:
        link = self.known.get(nid)
        if raw is None and self.changed is not None and nid not in self.changed and link and kind == PAGE \
                and link.get("source_hash") and link.get("child_ids") is not None and link.get("title") is not None:
            await self._reuse(nid, kind, parent_id)
            return
        if raw is None:
            raw = await self.c.call("GET", f"/v1/pages/{dashed(nid)}")
        if raw.get("in_trash") or raw.get("archived"):
            self.tree.skipped.append({"path": nid, "title": title_of(raw), "reason": "It's in Notion's trash."})
            return
        title = (title_of(raw) or "Untitled")[:200]
        await self._tick(title)
        last = raw.get("last_edited_time")
        if self._fresh(nid, last) and kind == PAGE:
            await self._reuse(nid, kind, parent_id)
            return
        node = SourceNode(notion_id=nid, kind=kind, title=title, parent_id=parent_id, last_edited=last, path=nid,
                          child_ids=[], values=values or {}, url=raw.get("url"))
        if kind == ROW and self._fresh(nid, last):
            node.unchanged = True
            node.child_ids = list((link or {}).get("child_ids") or [])
            if not self._add(node):
                return
            for k, cid in node.child_ids:
                await self.visit(k, cid, nid)
            return
        node.icon = emoji_of(raw.get("icon"))

        async def page_again(field: str):
            async def f():
                got = await self.c.call("GET", f"/v1/pages/{dashed(nid)}")
                return got.get(field)
            return f

        if not node.icon and (raw.get("icon") or {}).get("type") == "file":
            node.icon = await self.file_ref(raw["icon"], nid, "icon", await page_again("icon"))
        node.cover = await self.file_ref(raw.get("cover"), nid, "cover", await page_again("cover"))
        node.blocks = await self.blocks(nid, node)
        node.raw = json.dumps([node.blocks, node.values], sort_keys=True, ensure_ascii=False).encode()
        if not self._add(node):
            return
        for k, cid in list(node.child_ids):
            await self.visit(k, cid, nid)

    async def database(self, nid: str, parent_id: str | None) -> None:
        d = await self.c.call("GET", f"/v1/databases/{dashed(nid)}")
        if d.get("in_trash") or d.get("archived"):
            self.tree.skipped.append({"path": nid, "title": title_of(d), "reason": "It's in Notion's trash."})
            return
        sources = d.get("data_sources") or []
        title = (title_of(d) or "Untitled database")[:200]
        await self._tick(title)
        if not sources:
            self.tree.skipped.append({"path": nid, "title": title, "reason": "The database has no data in it."})
            return
        if len(sources) > 1:
            self.tree.skipped.append({"path": nid, "title": title, "reason": (
                f"It has {len(sources)} data sources: only the first ({sources[0].get('name') or 'unnamed'}) "
                "was imported.")})
        ds = await self.c.call("GET", f"/v1/data_sources/{sources[0]['id']}")
        schema = ds.get("properties") or {}
        title_col = next((k for k, p in schema.items() if p.get("type") == "title"), "Name")
        cols = [Column(name=title_col, notion_type="title")]
        cols += [Column(name=k, notion_type=p.get("type")) for k, p in schema.items() if k != title_col]
        node = SourceNode(notion_id=nid, kind=DATABASE, title=title, parent_id=parent_id, columns=cols, path=nid,
                          icon=emoji_of(d.get("icon")), last_edited=d.get("last_edited_time"), child_ids=[])
        rows: list[dict] = []
        async for r in self.c.pages("POST", f"/v1/data_sources/{sources[0]['id']}/query", json={},
                                    limit=MAX_NODES):
            if r.get("in_trash") or r.get("archived"):
                continue
            if hexid(r.get("id")) in self.exclude:
                self.left_out += 1          # unticked in the picker: not this database's row here
                continue
            rows.append(r)
        node.raw = json.dumps([[c.name, c.notion_type] for c in cols] + [
            [hexid(r["id"]), r.get("last_edited_time"), {k: prop_text(v) for k, v in (r.get("properties") or {}).items()}]
            for r in rows], sort_keys=True, ensure_ascii=False).encode()
        if not self._add(node):
            return
        for r in rows:
            rid = hexid(r["id"])
            if rid in self.tree.nodes:
                continue
            values = {k: prop_text(v) for k, v in (r.get("properties") or {}).items() if k != title_col}
            try:
                await self.page(rid, nid, raw=r, kind=ROW, values=values)
            except api.NotionError as exc:
                if exc.auth:
                    raise
                self.tree.skipped.append({"path": rid, "title": title_of(r), "reason": f"Notion answered {exc.status}."})

    async def build(self, roots: list[dict], name: str | None = None) -> SourceTree:
        self.exclude -= {hexid(r["id"]) for r in roots}      # a picked root is never left out
        for r in roots:
            await self.visit(r.get("kind") or "page", r["id"], None)
        tops = self.tree.roots()
        self.tree.name = (name or (tops[0].title if len(tops) == 1 else "Notion"))[:80]
        self.tree.read_asset = self.read_asset
        self.tree.asset_size = self.asset_size
        return self.tree
