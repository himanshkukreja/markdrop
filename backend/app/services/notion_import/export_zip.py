"""The Phase A source adapter: a Notion "Markdown & CSV" export zip → the intermediate tree (tree.py).

What a Notion export looks like (Export › Markdown & CSV, Include subpages, Create folders for subpages):

    Projects 1f2e….md                       a page: "<Title> <32-hex id>.md"
    Projects 1f2e…/                         its sub-pages and files, in a folder of the same name
        Roadmap 9a8b….md
        Tasks 77c1….csv                     a database: its rows as CSV (the current view)…
        Tasks 77c1…_all.csv                 …and every row (newer exports; preferred)
        Tasks 77c1…/                        one page per row: "<Row title> <id>.md"
            Ship v2 3c4d….md
        diagram.png                         an image or attachment of Projects (linked URL-encoded)

"Export all workspace content" sends a zip of zips (``Export-<uuid>-Part-1.zip``…): the inner ones are
opened as one export. Without "Create folders for subpages" everything sits at the top: a page's parent
is then the page that links to it on a line of its own. An HTML export is refused with how to export
again. Everything is read from the zip on disk, one entry at a time (a large export never sits in memory).
"""

from __future__ import annotations

import csv
import hashlib
import io
import os
import posixpath
import re
import shutil
import unicodedata
import zipfile
from urllib.parse import unquote, urlsplit

from app.services.notion_import import notion_md
from app.services.notion_import.tree import DATABASE, PAGE, ROW, Column, SourceNode, SourceTree

MAX_ENTRIES = 200_000
MAX_UNCOMPRESSED = 40 * 1024 ** 3        # a zip claiming more than this is refused (a zip bomb)
MAX_TEXT_BYTES = 8 * 1024 * 1024         # one page's Markdown or one database's CSV
MAX_NESTED = 50                          # inner zips of a workspace export
_ID = re.compile(r"^(.*?)\s*([0-9a-f]{32})$", re.I)
_UUID = re.compile(r"([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})", re.I)
_JUNK = re.compile(r"(^|/)(__MACOSX/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)")
_EXPORT_NAME = re.compile(r"^(Export-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-Part-\d+)?$", re.I)

HTML_EXPORT = ("This is an HTML export. In Notion, export again with Format \"Markdown & CSV\" (Include subpages "
               "on, Create folders for subpages on) and import that zip.")
NOT_ZIP = "That file isn't a zip Markdrop can open. Import the .zip file Notion's export gave you, as it is."
EMPTY = ("There are no Notion pages in this zip. Export from Notion with Format \"Markdown & CSV\" and Include "
         "subpages on, then import that zip.")


class ExportError(Exception):
    """The zip can't be imported at all; the message says why, for the person."""


def _nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def split_id(stem: str) -> tuple[str, str | None]:
    """("Title", id) from Notion's "Title <32-hex>"; (stem, None) without one."""
    m = _ID.match(stem)
    if m:
        return m.group(1).strip(), m.group(2).lower()
    return stem.strip(), None


def notion_url_id(url: str) -> str | None:
    """The page id in a notion.so / notion.site link, else None."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    host = (parts.hostname or "").lower()
    if not (host.endswith("notion.so") or host.endswith("notion.site") or host.endswith("notion.com")):
        return None
    m = None
    for m in _UUID.finditer(parts.path):
        pass
    if m is None:
        return None
    return "".join(m.groups()).lower()


def clean_name(file_name: str | None) -> str | None:
    stem = (file_name or "").rsplit("/", 1)[-1]
    if stem.lower().endswith(".zip"):
        stem = stem[:-4]
    stem = stem.strip()
    if not stem or _EXPORT_NAME.match(stem):
        return None
    return stem[:80]


class ExportZip:
    """An opened export: every entry of the zip (and of the zips inside it) by its path."""

    def __init__(self, path: str, tmpdir: str):
        self.tmpdir = tmpdir
        self._zips: list[zipfile.ZipFile] = []
        self.entries: dict[str, tuple[zipfile.ZipFile, zipfile.ZipInfo]] = {}
        self._open(path, depth=0, prefix="")

    def close(self) -> None:
        for z in self._zips:
            try:
                z.close()
            except Exception:
                pass

    def _open(self, path: str, depth: int, prefix: str) -> None:
        try:
            zf = zipfile.ZipFile(path)
        except (zipfile.BadZipFile, OSError):
            if depth == 0:
                raise ExportError(NOT_ZIP)
            return
        self._zips.append(zf)
        infos = [i for i in zf.infolist() if not i.is_dir() and not _JUNK.search(i.filename)]
        if len(infos) + len(self.entries) > MAX_ENTRIES:
            raise ExportError(f"This export has more than {MAX_ENTRIES:,} files; export it in parts "
                              "(a few top-level pages at a time).")
        if sum(i.file_size for i in infos) > MAX_UNCOMPRESSED:
            raise ExportError("This zip unpacks to more than 40 GB; export it in parts.")
        inner = [i for i in infos if i.filename.lower().endswith(".zip")]
        if inner and depth < 2:
            if len(inner) > MAX_NESTED:
                raise ExportError("This export holds too many zips; export it in parts.")
            for k, info in enumerate(inner):
                dest = os.path.join(self.tmpdir, f"inner-{depth}-{len(self._zips)}-{k}.zip")
                with zf.open(info) as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out, 1024 * 1024)
                self._open(dest, depth + 1, prefix)
        for info in infos:
            if info.filename.lower().endswith(".zip") and depth < 2:
                continue
            name = _nfc(info.filename.replace("\\", "/")).lstrip("/")
            self.entries.setdefault(prefix + name, (zf, info))

    def size(self, path: str) -> int | None:
        e = self.entries.get(path)
        return e[1].file_size if e else None

    def read(self, path: str, max_bytes: int | None = None) -> bytes | None:
        e = self.entries.get(path)
        if e is None:
            return None
        zf, info = e
        # With max_bytes: at most max_bytes + 1 bytes (so a caller can tell "too big" from "just fits").
        with zf.open(info) as f:
            return f.read() if max_bytes is None else f.read(max_bytes + 1)


def _stem_path(path: str) -> str:
    base = path[: path.rfind(".")] if "." in path.rsplit("/", 1)[-1] else path
    return base[:-4] if base.endswith("_all") else base


def _text(data: bytes) -> str:
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return data.decode("latin-1")


def _norm_title(s: str) -> str:
    return re.sub(r"[^0-9a-z]+", "", unicodedata.normalize("NFKD", s or "").lower())


def build_tree(ez: ExportZip, file_name: str | None = None) -> SourceTree:
    paths = sorted(ez.entries)
    md = [p for p in paths if p.lower().endswith(".md")]
    csvs = [p for p in paths if p.lower().endswith(".csv")]
    if not md and not csvs:
        if any(p.lower().endswith(".html") for p in paths):
            raise ExportError(HTML_EXPORT)
        raise ExportError(EMPTY)

    tree = SourceTree(name="Notion import")
    # 1. Every page and database gets its id (Notion's, or one made from its path).
    by_stem: dict[str, str] = {}          # "dir/Title id" → node id (the folder of its children)
    path_id: dict[str, str] = {}          # file path → node id
    kind_of: dict[str, str] = {}
    db_csv: dict[str, str] = {}           # database id → the CSV to read (…_all.csv preferred)
    taken: set[str] = set()

    def make_id(path: str, nid: str | None) -> str:
        if nid and nid not in taken:
            return nid
        return hashlib.sha1(path.encode()).hexdigest()[:32]

    for p in csvs:
        stem = _stem_path(p)
        _title, nid = split_id(stem.rsplit("/", 1)[-1])
        node_id = by_stem.get(stem) or make_id(stem, nid)
        by_stem[stem] = node_id
        taken.add(node_id)
        path_id[p] = node_id
        kind_of[node_id] = DATABASE
        if p.lower().endswith("_all.csv") or node_id not in db_csv:
            db_csv[node_id] = p
    for p in md:
        stem = _stem_path(p)
        _title, nid = split_id(stem.rsplit("/", 1)[-1])
        node_id = make_id(p, nid)
        taken.add(node_id)
        path_id[p] = node_id
        by_stem.setdefault(stem, node_id)
        kind_of[node_id] = PAGE

    def parent_of(path: str) -> str | None:
        d = posixpath.dirname(path)
        while d:
            if d in by_stem:
                return by_stem[d]
            d = posixpath.dirname(d)
        return None

    known = set(path_id.values())

    def resolver(base: str):
        def resolve(href: str):
            href = href.strip()
            if not href:
                return None
            low = href.lower()
            if low.startswith(("http://", "https://")):
                nid = notion_url_id(href)
                if nid and nid in known:
                    return ("database" if kind_of.get(nid) == DATABASE else "page"), nid
                return "url", href
            if re.match(r"^[a-z][a-z0-9+.-]*:", low):
                return "url", href
            if href.startswith("#"):
                return None
            rel = unquote(href.split("#", 1)[0].split("?", 1)[0])
            p = _nfc(posixpath.normpath(posixpath.join(base, rel))) if base else _nfc(posixpath.normpath(rel))
            for cand in (p, p.lstrip("./")):
                if cand in path_id:
                    nid = path_id[cand]
                    return ("database" if kind_of[nid] == DATABASE else "page"), nid
                if cand in ez.entries:
                    return "asset", cand
            return None
        return resolve

    # 2. Databases: columns and rows from the CSV.
    rows_of: dict[str, list[dict[str, str]]] = {}
    for nid, p in db_csv.items():
        data = ez.read(p, MAX_TEXT_BYTES)
        stem = _stem_path(p)
        title, _ = split_id(stem.rsplit("/", 1)[-1])
        node = SourceNode(notion_id=nid, kind=DATABASE, title=title or "Untitled database", path=p,
                          parent_id=parent_of(stem))
        if data is None or len(data) > MAX_TEXT_BYTES:
            tree.skipped.append({"path": p, "title": title, "reason": "The database's CSV is larger than 8 MB."})
            rows: list[dict[str, str]] = []
            header: list[str] = []
        else:
            node.raw = data
            reader = csv.reader(io.StringIO(_text(data)))
            all_rows = [r for r in reader]
            header = [h.strip() for h in (all_rows[0] if all_rows else [])]
            rows = []
            for r in all_rows[1:]:
                if not any((c or "").strip() for c in r):
                    continue
                rows.append({header[k] if k < len(header) else f"Column {k + 1}": (r[k] if k < len(r) else "")
                             for k in range(max(len(header), len(r)))})
        node.columns = [Column(name=h or f"Column {k + 1}") for k, h in enumerate(header)]
        rows_of[nid] = rows
        tree.add(node)

    # 3. Pages (and database rows), parsed.
    pending_rows: dict[str, list[SourceNode]] = {}
    for p in md:
        nid = path_id[p]
        stem = _stem_path(p)
        fallback, _ = split_id(stem.rsplit("/", 1)[-1])
        parent = parent_of(p)
        is_row = parent is not None and kind_of.get(parent) == DATABASE
        data = ez.read(p, MAX_TEXT_BYTES)
        if data is None or len(data) > MAX_TEXT_BYTES:
            tree.skipped.append({"path": p, "title": fallback, "reason": "The page is larger than 8 MB of text."})
            data = b""
        cols = {c.name for c in tree.nodes[parent].columns} if is_row else None
        title, blocks = notion_md.parse_page(_text(data), resolver(posixpath.dirname(p)), cols)
        node = SourceNode(notion_id=nid, kind=ROW if is_row else PAGE, title=(title or fallback or "Untitled")[:200],
                          parent_id=parent, blocks=blocks, path=p, raw=data)
        tree.add(node)
        if is_row:
            pending_rows.setdefault(parent, []).append(node)

    # 4. Rows: each CSV row matched to its page by title (in order, for repeated titles).
    for db_id, rows in rows_of.items():
        db = tree.nodes[db_id]
        title_col = db.columns[0].name if db.columns else None
        pages = pending_rows.get(db_id, [])
        free = {id(pg): pg for pg in pages}
        for k, row in enumerate(rows):
            t = (row.get(title_col) or "").strip() if title_col else ""
            match = next((pg for pg in pages if id(pg) in free and pg.title.strip() == t), None)
            if match is None and t:
                nt = _norm_title(t)
                match = next((pg for pg in pages if id(pg) in free and nt and (
                    _norm_title(pg.title) == nt or (len(_norm_title(pg.title)) >= 20 and nt.startswith(_norm_title(pg.title))))), None)
            values = {c: v for c, v in row.items() if c != title_col}
            if match is not None:
                free.pop(id(match))
                match.values = values
                match.title = (t or match.title)[:200]
                match.raw = match.raw + repr(sorted(values.items())).encode()
                # Keep the CSV's order.
                match.order = len(tree.nodes) + k
            else:
                rid = hashlib.sha1(f"{db_id}:{k}:{t}".encode()).hexdigest()[:32]
                node = SourceNode(notion_id=rid, kind=ROW, title=(t or "Untitled")[:200], parent_id=db_id,
                                  values=values, path=f"{db.path}#{k + 2}", raw=repr(sorted(row.items())).encode())
                tree.add(node)
        base = len(tree.nodes) + len(rows)
        for pg in pages:
            if id(pg) in free:
                pg.order = base + pg.order   # rows the CSV didn't list: after the rest

    # 5. A flat export (no folders for sub-pages): a page's parent is the page linking to it on its own line.
    linked_from: dict[str, str] = {}
    for node in tree.nodes.values():
        if node.kind == DATABASE:
            continue
        for b in notion_md._walk(node.blocks):
            if b.get("type") in ("page_link", "child_database") and b.get("id") in tree.nodes:
                linked_from.setdefault(b["id"], node.notion_id)
    for nid, src in linked_from.items():
        node = tree.nodes[nid]
        if node.parent_id is not None or src == nid:
            continue
        a, ok = src, True
        for _ in range(64):
            if a is None:
                break
            if a == nid:
                ok = False
                break
            a = tree.nodes[a].parent_id if a in tree.nodes else None
        if ok:
            node.parent_id = src

    # 6. A page link on its own line: the sub-page's place in its parent, or a link to another page.
    for node in tree.nodes.values():
        for b in notion_md._walk(node.blocks):
            if b.get("type") == "page_link":
                target = tree.nodes.get(b["id"])
                b["type"] = "child_page" if target is not None and target.parent_id == node.notion_id else "link_to_page"

    # 7. Sub-pages and databases in the order their parent shows them (rows keep the CSV's order).
    for node in tree.nodes.values():
        k = 0
        for b in notion_md._walk(node.blocks):
            if b.get("type") in ("child_page", "child_database"):
                child = tree.nodes.get(b.get("id"))
                if child is not None and child.parent_id == node.notion_id and child.order >= 0:
                    child.order = -1_000_000 + k
                    k += 1

    roots = tree.roots()
    name = clean_name(file_name)
    if len(roots) == 1 and (not name or name.lower().startswith("export")):
        name = roots[0].title
    tree.name = (name or "Notion import")[:80]
    tree.read_asset = lambda path, max_bytes=None: ez.read(path, max_bytes)
    tree.asset_size = ez.size
    return tree
