"""The writer: an intermediate tree (tree.py) → Markdrop pages, sub-pages, database folders, images, files.

Source-agnostic: the export adapter (Phase A) and a Notion API adapter (Phase B, one-way sync) feed it the
same tree. Two passes, so links between pages can be written:

1. **Structure** (parents first): every page, row and database gets its Markdrop item — made, or found
   again from an earlier import into the same place (``notion_links``, by Notion id). A database in a
   workspace is a folder with typed properties (services/page_db.py: its schema and views) and its rows
   are the pages filed in it; in My files (no folders) it is a page with a table of its rows, each row a
   sub-page.
2. **Content**: each page's blocks are rendered (render.py) with its images uploaded as page images and
   its attachments as Markdrop files, and saved through the website's save path (edit lock, revisions,
   search; mentions notify nobody).

``notion_links`` {_id: "<dest>|<notion id>", dest, notion_id, kind, doc_id, slug, folder_id, source_hash,
last_edited, synced_rev, synced_at, detached, assets: {path: {image|file}}} makes it idempotent and
resumable: a page whose source hash is unchanged is left alone; one whose Markdrop revision moved since
Markdrop wrote it was edited in Markdrop and is kept (``detached``: Phase B's sync stops updating it).

Provenance: every page written gets ``source: {kind: "notion", via: "api" | "zip", notion_id, url, sync_id,
imported_at}`` (services/notion_import/source.py reads it for the "Imported from Notion" strip). Set without
touching the page's revision, so it never counts as an edit.

Access: what the destination gives new items (the team's, the folder's "new items start as", private in
My files) — never "anyone with the link": that default becomes "workspace".
"""

from __future__ import annotations

import logging
import posixpath
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable
from urllib.parse import unquote

from bson import ObjectId
from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services.notion_import import props as P
from app.services.notion_import import render as R
from app.services.notion_import.export_zip import split_id
from app.services.notion_import.tree import DATABASE, PAGE, ROW, SourceNode, SourceTree, asset_refs

log = logging.getLogger(__name__)

LINKS = "notion_links"
MAX_PAGES = 5000
MAX_FILE_BYTES = 50 * 1024 * 1024        # an attachment (read into memory to store it)
IMAGE_MAX = 20 * 1024 * 1024             # page_assets.FILE_MAX_BYTES
_EMOJI = re.compile(r"^[^\w\s<>\"'`]{1,8}$")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[LINKS].create_index([("dest", 1), ("notion_id", 1)])
    await db[LINKS].create_index("doc_id")


@dataclass
class Destination:
    user: Any                                  # app.models.user.User
    workspace_id: str | None = None
    team_id: str | None = None                 # None: company-wide (General) or My files
    folder_id: str | None = None               # the import's folder (workspace), None: the root
    root_page_slug: str | None = None          # My files: the page everything goes under (None: top level)
    level: str = "private"                     # new top-level items' access
    key: str = ""                              # notion_links' dest

    @property
    def personal(self) -> bool:
        return not self.workspace_id


@dataclass
class Report:
    counts: dict = field(default_factory=lambda: {k: 0 for k in (
        "pages", "databases", "rows", "images", "files", "updated", "unchanged", "kept_edited", "skipped",
        "errors")})
    skipped: list = field(default_factory=list)
    errors: list = field(default_factory=list)
    roots: list = field(default_factory=list)  # [{title, slug|None, folder_id|None}]

    def skip(self, path: str, title: str | None, reason: str) -> None:
        self.counts["skipped"] += 1
        if len(self.skipped) < 200:
            self.skipped.append({"path": path[-300:], "title": (title or None) and title[:200], "reason": reason[:300]})

    def error(self, path: str, title: str | None, msg: str) -> None:
        self.counts["errors"] += 1
        if len(self.errors) < 200:
            self.errors.append({"path": path[-300:], "title": (title or None) and title[:200], "error": msg[:300]})


Progress = Callable[[str, int, int, str | None], Awaitable[bool]]   # (phase, done, total, current) → keep going?


def _detail(exc: Exception) -> str:
    if isinstance(exc, HTTPException):
        return exc.detail if isinstance(exc.detail, str) else "refused"
    return "Something went wrong writing it."


class Writer:
    def __init__(self, db: AsyncIOMotorDatabase, tree: SourceTree, dest: Destination, report: Report,
                 progress: Progress):
        from app.services import access

        self.db, self.tree, self.dest, self.report, self.progress = db, tree, dest, report, progress
        self.actor = access.Actor.of(dest.user)
        self.ctx = access.Ctx(db)
        self.links: dict[str, dict] = {}           # notion id → link row
        self.schemas: dict[str, list[dict]] = {}   # database id → its properties (with "source")
        self.people: P.People | None = None
        self.depth: dict[str, int] = {}            # slug → page depth
        # Provenance (``source`` on each page): how it came ("api": Connect Notion, "zip": an export) and,
        # for Connect Notion, the sync row of each root it was imported under.
        self.via = "zip"
        self.sync_by_root: dict[str, str] = {}

    # ── links ──

    def _lid(self, nid: str) -> str:
        return f"{self.dest.key}|{nid}"

    async def _load_links(self) -> None:
        async for row in self.db[LINKS].find({"dest": self.dest.key}):
            self.links[row["notion_id"]] = row

    async def _save_link(self, nid: str, **sets) -> dict:
        row = self.links.get(nid) or {"_id": self._lid(nid), "dest": self.dest.key, "notion_id": nid,
                                      "created_at": now_utc()}
        row.update(sets)
        await self.db[LINKS].update_one({"_id": row["_id"]}, {"$set": {k: v for k, v in row.items() if k != "_id"}},
                                        upsert=True)
        self.links[nid] = row
        return row

    async def _doc(self, link: dict | None) -> dict | None:
        if not link or not link.get("doc_id"):
            return None
        raw = await self.db["documents"].find_one({"_id": link["doc_id"]}, {"content": 0})
        if raw is None or raw.get("deleted_at"):
            return None
        return raw

    # ── run ──

    async def run(self) -> None:
        from app.services import workspace as ws_service

        await self._load_links()
        if self.dest.workspace_id:
            members = await ws_service.list_members(self.db, self.dest.workspace_id)
            self.people = P.People([{"id": m.user_id, "name": m.name, "email": m.email} for m in members])
        order = [n for n, _d in self.tree.walk()]
        if len(order) > MAX_PAGES:
            for n in order[MAX_PAGES:]:
                self.report.skip(n.path, n.title, f"Past the {MAX_PAGES:,} pages one import takes; import the rest "
                                                  "separately.")
            order = order[:MAX_PAGES]
        for s in self.tree.skipped:
            self.report.skip(s.get("path") or "", s.get("title"), s.get("reason") or "skipped")
        total = len(order)
        for k, node in enumerate(order):
            if not await self.progress("pages", k, total, node.title):
                return
            try:
                await self._structure(node)
            except Exception as exc:  # one page failing never stops the rest
                if not isinstance(exc, HTTPException):
                    log.warning("notion import: structure of %s failed", node.path, exc_info=True)
                self.report.error(node.path, node.title, _detail(exc))
        for k, node in enumerate(order):
            if not await self.progress("content", k, total, node.title):
                return
            if node.notion_id not in self.links:
                continue
            try:
                await self._content(node)
            except Exception as exc:
                if not isinstance(exc, HTTPException):
                    log.warning("notion import: content of %s failed", node.path, exc_info=True)
                self.report.error(node.path, node.title, _detail(exc))
        await self.progress("content", total, total, None)
        for n in self.tree.roots():
            link = self.links.get(n.notion_id)
            if link:
                self.report.roots.append({"title": n.title, "slug": link.get("slug"), "folder_id": link.get("folder_id")})

    # ── pass 1: structure ──

    def _parent_link(self, node: SourceNode) -> dict | None:
        return self.links.get(node.parent_id) if node.parent_id else None

    async def _structure(self, node: SourceNode) -> None:
        link = self.links.get(node.notion_id)
        if node.kind == DATABASE and not self.dest.personal:
            await self._database_folder(node, link)
            return
        raw = await self._doc(link)
        if raw is not None:
            self.depth[raw["slug"]] = len(raw.get("page_path") or [])
            await self._stamp(node, raw)
            return
        if node.unchanged and link is not None:
            # Deleted in Markdrop and not edited in Notion since (the API source didn't read it again): left
            # deleted rather than made again empty.
            self.links.pop(node.notion_id, None)
            self.report.skip(node.path, node.title, "Deleted in Markdrop, so it wasn't brought back.")
            return
        raw = await self._create(node)
        self.depth[raw["slug"]] = len(raw.get("page_path") or [])
        await self._stamp(node, raw)
        await self._save_link(node.notion_id, kind=node.kind, doc_id=raw["_id"], slug=raw["slug"],
                              folder_id=raw.get("folder_id"), synced_rev=int(raw.get("rev", 1)), source_hash=None,
                              detached=False, assets={})
        if node.kind == DATABASE:
            self.report.counts["databases"] += 1
        elif node.kind == ROW:
            self.report.counts["rows"] += 1
        else:
            self.report.counts["pages"] += 1

    async def _create(self, node: SourceNode) -> dict:
        from app.services import access, pages

        parent = self._parent_link(node)
        title = node.title.strip() or "Untitled"
        kw: dict[str, Any] = {"title": title, "content": "\n"}
        parent_slug = None
        if parent is not None and parent.get("slug") and parent.get("kind") != "folder":
            parent_slug = parent["slug"]
        elif parent is not None and parent.get("kind") == "folder":
            kw.update(workspace=self.dest.workspace_id, folder=parent["folder_id"], access_level=self.dest.level)
        elif self.dest.personal and self.dest.root_page_slug:
            parent_slug = self.dest.root_page_slug
        elif self.dest.personal:
            kw.update(access_level="private")
        else:
            kw.update(workspace=self.dest.workspace_id, folder=self.dest.folder_id, access_level=self.dest.level)
        if parent_slug:
            # Pages nest at most access.MAX_PAGE_DEPTH deep: deeper ones go under the deepest that can hold them.
            slug = parent_slug
            raw_p = await self.db["documents"].find_one({"slug": slug}, {"page_path": 1, "slug": 1})
            if raw_p is not None:
                path = [*(raw_p.get("page_path") or []), slug]
                if len(path) >= access.MAX_PAGE_DEPTH:
                    slug = path[access.MAX_PAGE_DEPTH - 2]
                    self.report.skip(node.path, node.title, f"Nested deeper than {access.MAX_PAGE_DEPTH} pages: "
                                                            "put under a page higher up.")
            kw["parent"] = slug
        raw, _secret, err = await pages.create_page(self.db, self.dest.user, self.actor, self.ctx, **kw)
        if err:
            self.report.error(node.path, node.title, err)
        await self._mark(raw)
        return raw

    def source_of(self, node: SourceNode) -> dict:
        """The page's provenance: where it is in Notion and (Connect Notion) the sync it comes with."""
        nid = node.notion_id
        # (url "": the source knows it has no page in Notion, e.g. an export's row that was only a CSV line.)
        url = node.url if isinstance(node.url, str) and node.url.startswith("https://") else (
            f"https://www.notion.so/{nid}" if node.url is None and re.fullmatch(r"[0-9a-f]{32}", nid or "") else None)
        top = node
        for _ in range(64):
            up = self.tree.nodes.get(top.parent_id or "")
            if up is None:
                break
            top = up
        return {"kind": "notion", "via": self.via, "notion_id": nid, "url": url,
                "sync_id": self.sync_by_root.get(top.notion_id)}

    async def _stamp(self, node: SourceNode, raw: dict) -> None:
        """``source`` on the page (only when it changed; never a revision: it isn't an edit)."""
        want = self.source_of(node)
        cur = raw.get("source") if isinstance(raw.get("source"), dict) else {}
        if all(cur.get(k) == v for k, v in want.items()) and cur.get("imported_at"):
            return
        want["imported_at"] = cur.get("imported_at") or now_utc()
        await self.db["documents"].update_one({"_id": raw["_id"]}, {"$set": {"source": want}})

    async def _mark(self, raw: dict) -> None:
        """Into the team (a team's space), and marked as imported."""
        from app.services import teams as T

        sets: dict[str, Any] = {"notion_imported": True}
        upd: dict[str, Any] = {"$set": sets}
        if self.dest.team_id and raw.get("workspace_id"):
            upd["$set"].update(T.team_update([self.dest.team_id], [])["$set"])
        await self.db["documents"].update_one({"_id": raw["_id"]}, upd)
        self.ctx.forget()

    async def _database_folder(self, node: SourceNode, link: dict | None) -> None:
        from app.services import folder as folder_service
        from app.services import page_db
        from app.services import teams as T

        ws = self.dest.workspace_id
        fid = link.get("folder_id") if link else None
        if fid:
            try:
                f = await self.db["folders"].find_one({"_id": ObjectId(fid), "workspace_id": ws})
            except Exception:
                f = None
            if f is None:
                fid = None
        if fid is None:
            # Beside its parent page (in that page's folder), or in the import's folder.
            parent = self._parent_link(node)
            under = self.dest.folder_id
            if parent is not None:
                under = parent.get("folder_id") if parent.get("kind") == "folder" else (parent.get("folder_id") or under)
            made = await folder_service.create_folder(self.db, ws, node.title.strip()[:100] or "Database", under,
                                                      actor=self.actor, ctx=self.ctx)
            fid = made.id
            extra: dict[str, Any] = {"notion_imported": True}
            if self.dest.team_id:
                extra.update(T.team_update([self.dest.team_id], [])["$set"])
            await self.db["folders"].update_one({"_id": ObjectId(fid)}, {"$set": extra})
            self.report.counts["databases"] += 1
        # Its properties, from the CSV (kept in step on a re-import: the schema is set again, by name).
        rows = [n.values for n in self.tree.children(node.notion_id) if n.kind == ROW]
        items, extra_cols = P.schema_for(node.columns, rows, self.people)
        schema_in = []
        for it in items:
            typ = "link" if it["type"] == "relation" else it["type"]
            schema_in.append({"name": it["name"], "type": typ, **({"options": it["options"]} if "options" in it else {})})
        f = await self.db["folders"].find_one({"_id": ObjectId(fid)})
        cur = page_db.view_of(f)
        views = None
        if not cur.get("views"):
            views = [{"name": "Table", "type": "table"}]
            board = next((it for it in items if it["type"] == "select"
                          and it["name"].strip().lower() in ("status", "stage", "state")), None)
            if board is not None:
                views.append({"name": "Board", "type": "board", "group": "__" + board["name"]})
        old_by_name = {p["name"].casefold(): p for p in cur.get("properties") or []}
        # Options already in the folder stay (a re-import adds new ones).
        for s in schema_in:
            old = old_by_name.get(s["name"].casefold())
            if old and old.get("type") == s["type"] and "options" in s:
                names = [o["name"] for o in old.get("options") or []]
                for o in s["options"]:
                    if o.casefold() not in {x.casefold() for x in names}:
                        names.append(o)
                s["options"] = [{"name": x} for x in names[:page_db.MAX_OPTIONS]]
        keep = [p for p in cur.get("properties") or [] if p["name"].casefold() not in {s["name"].casefold() for s in schema_in}]
        merged = [*schema_in, *[{"key": p["key"], "name": p["name"], "type": p["type"],
                                 **({"options": p.get("options")} if p.get("options") is not None else {})} for p in keep]]
        merged = merged[:page_db.MAX_PROPERTIES]
        try:
            res = await page_db.set_schema(self.db, ws, fid, self.dest.user.id, merged)
            if views is not None:
                key_of = {p["name"]: p["key"] for p in res.get("properties") or []}
                for v in views:
                    if str(v.get("group") or "").startswith("__"):
                        v["group"] = key_of.get(v["group"][2:])
                await page_db.set_views(self.db, ws, fid, self.dest.user.id, views)
                res = page_db.view_of(await self.db["folders"].find_one({"_id": ObjectId(fid)}))
        except HTTPException as exc:
            self.report.error(node.path, node.title, f"Its properties couldn't be set: {_detail(exc)}")
            res = page_db.view_of(await self.db["folders"].find_one({"_id": ObjectId(fid)}))
        by_name = {p["name"]: p for p in res.get("properties") or []}
        props = []
        for it in items:
            p = by_name.get(it["name"])
            if p is None:
                continue
            props.append({**p, "source": it["source"], "relation": it["type"] == "relation",
                          "option_names": [o["name"] for o in p.get("options") or []]})
        self.schemas[node.notion_id] = props
        if extra_cols:
            self.report.skip(node.path, node.title, "More than 30 columns: "
                             + ", ".join(extra_cols[:10]) + " went into each row's page instead.")
        await self._save_link(node.notion_id, kind="folder", folder_id=fid, doc_id=None, slug=None,
                              source_hash=node.source_hash(), extra_columns=extra_cols)

    # ── pass 2: content ──

    async def _content(self, node: SourceNode) -> None:
        from app.schemas.document import DocumentUpdate
        from app.services import document as doc_service
        from app.services import notifications

        link = self.links[node.notion_id]
        if link.get("kind") == "folder":
            return
        raw = await self.db["documents"].find_one({"_id": link["doc_id"]})
        if raw is None or raw.get("deleted_at"):
            return
        h = node.source_hash()
        rev = int(raw.get("rev", 1))
        if link.get("source_hash") is not None:
            if link.get("synced_rev") is not None and rev != link["synced_rev"]:
                # Edited in Markdrop since Markdrop wrote it: kept as it is, and not synced again.
                self.report.counts["kept_edited"] += 1
                if not link.get("detached"):
                    await self._save_link(node.notion_id, detached=True, detached_at=now_utc())
                return
            if node.unchanged or link["source_hash"] == h:
                self.report.counts["unchanged"] += 1
                return
            self.report.counts["updated"] += 1
        elif node.unchanged:
            return      # (never happens: the API source only skips pages it wrote before)
        assets = dict(link.get("assets") or {})
        for path in asset_refs(node):
            if path not in assets:
                assets[path] = await self._asset(node, raw, path)
        content = self._compose(node, assets)
        from app.config import get_settings

        limit = get_settings().max_content_chars
        if len(content) > limit:
            content = content[: limit - 200].rsplit("\n", 1)[0] + "\n\n*(from Notion: the rest of this page was too long to import)*\n"
            self.report.skip(node.path, node.title, "The page was longer than a page can hold: cut at the end.")
        data = DocumentUpdate(title=node.title.strip()[:200] or "Untitled", content=content or "\n", base_rev=rev)
        try:
            with notifications.quiet():
                await doc_service.update_document(self.db, raw["slug"], data, self.actor, self.ctx)
        except HTTPException as exc:
            if exc.status_code == 409:
                self.report.counts["kept_edited"] += 1
                await self._save_link(node.notion_id, assets=assets, detached=True, detached_at=now_utc())
                return
            if exc.status_code == 422 and "props" in content:
                # A property value the folder refused: the page without its values, and why.
                self.report.error(node.path, node.title, f"Its properties weren't kept: {_detail(exc)}")
                data.content = self._compose(node, assets, with_values=False)
                with notifications.quiet():
                    await doc_service.update_document(self.db, raw["slug"], data, self.actor, self.ctx)
            else:
                raise
        after = await self.db["documents"].find_one({"_id": raw["_id"]}, {"rev": 1})
        extra: dict[str, Any] = {"title": node.title}
        if node.child_ids is not None:
            extra["child_ids"] = node.child_ids
        await self._save_link(node.notion_id, source_hash=h, last_edited=node.last_edited, assets=assets,
                              synced_rev=int((after or {}).get("rev", rev + 1)), synced_at=now_utc(), detached=False,
                              **extra)

    def _resolver(self, assets: dict[str, dict]) -> R.Resolver:
        writer = self

        class _R:
            def page(self, nid: str) -> dict | None:
                link = writer.links.get(nid)
                node = writer.tree.nodes.get(nid)
                if link is None or node is None:
                    return None
                if link.get("kind") == "folder":
                    return {"url": f"/w/{writer.dest.workspace_id}/f/{link['folder_id']}", "title": node.title}
                return {"slug": link.get("slug"), "title": node.title}

            def asset(self, path: str) -> dict | None:
                return assets.get(path)

        return _R()

    def _compose(self, node: SourceNode, assets: dict[str, dict], *, with_values: bool = True) -> str:
        from app.services import page_db, page_props

        body = R.render(node.blocks, self._resolver(assets))
        notes: list[str] = []
        values: dict[str, Any] = {}
        if node.kind == ROW:
            values, notes = self._row_values(node)
            if self.dest.personal or not with_values:
                table = self._values_table(node)
                body = (table + "\n\n" + body) if table else body
                values = {}
        if node.kind == DATABASE and self.dest.personal:
            body = self._rows_table(node) + ("\n\n" + body if body else "")
        if notes:
            body = body + ("\n\n" if body else "") + "**From Notion**\n\n" + "\n".join(f"- {n}" for n in notes)
        content = body.strip() + "\n"
        if values:
            content = page_db.write_values(content, values)
        icon = (node.icon or "").strip()
        changes: dict[str, Any] = {}
        if icon and _EMOJI.match(icon):
            changes["icon"] = icon
        elif icon.startswith("notion-asset://") and (assets.get(unquote(icon[15:])) or {}).get("image"):
            changes["icon"] = "asset:" + assets[unquote(icon[15:])]["image"]
        cover = (node.cover or "").strip()
        if cover.startswith("notion-asset://") and (assets.get(unquote(cover[15:])) or {}).get("image"):
            changes["cover"] = "asset:" + assets[unquote(cover[15:])]["image"]
        elif cover.startswith("https://"):
            changes["cover"] = cover
        if changes:
            content = page_props.apply(content, changes)
        return content

    def _link_of(self, title: str, path: str) -> str | None:
        stem = unquote(posixpath.basename(path))
        if stem.lower().endswith(".md"):
            stem = stem[:-3]
        _t, nid = split_id(stem)
        link = self.links.get(nid or "")
        return link.get("slug") if link else None

    def _row_values(self, node: SourceNode) -> tuple[dict[str, Any], list[str]]:
        from app.services import page_db

        values: dict[str, Any] = {}
        notes: list[str] = []
        schema = self.schemas.get(node.parent_id or "", [])
        members = {m for m in (self.people.by_email.values() if self.people else [])} | {
            v for v in (self.people.by_name.values() if self.people else []) if v}
        used = set()
        for prop in schema:
            src = prop["source"]
            used.add(src)
            raw = node.values.get(src, "")
            v, note = P.value_for(prop, raw, people=self.people, link_of=self._link_of)
            if v is not None:
                try:
                    v = page_db.check_value({**prop, "type": prop["type"]}, v, members=members or None)
                except page_db.PropsError:
                    note = raw if not note else note
                    v = None
            if v is not None:
                values[prop["key"]] = v
            if note:
                notes.append(f"{prop['name']}: {note}")
        title_col = None
        db = self.tree.nodes.get(node.parent_id or "")
        if db is not None and db.columns:
            title_col = db.columns[0].name
        for col, raw in node.values.items():
            if col in used or col == title_col or not (raw or "").strip():
                continue
            notes.append(f"{col}: {raw.strip()[:500]}")
        return values, notes

    def _values_table(self, node: SourceNode) -> str:
        db = self.tree.nodes.get(node.parent_id or "")
        cols = [c.name for c in (db.columns[1:] if db else [])]
        lines = []
        for c in cols:
            v = (node.values.get(c) or "").strip()
            if v:
                lines.append(f"| {_cell(c)} | {_cell(v)} |")
        if not lines:
            return ""
        return "| Property | Value |\n| --- | --- |\n" + "\n".join(lines)

    def _rows_table(self, node: SourceNode) -> str:
        cols = [c.name for c in node.columns]
        rows = [n for n in self.tree.children(node.notion_id) if n.kind == ROW]
        if not cols:
            cols = ["Name"]
        head = "| " + " | ".join(_cell(c) for c in cols) + " |\n|" + "|".join([" --- "] * len(cols)) + "|"
        lines = []
        for r in rows[:500]:
            link = self.links.get(r.notion_id)
            title = R.attr(r.title)
            first = f':markdrop[{_cell(r.title)}]{{src="{link["slug"]}"}}' if link and link.get("slug") else _cell(title)
            lines.append("| " + " | ".join([first, *[_cell(r.values.get(c, "")) for c in cols[1:]]]) + " |")
        return head + ("\n" + "\n".join(lines) if lines else "")

    async def _asset(self, node: SourceNode, page: dict, path: str) -> dict:
        """Store one file the page refers to: an image as a page image, anything else as a Markdrop file."""
        from app.services import page_assets

        size = self.tree.asset_size(path)
        name = posixpath.basename(path)
        if size is None:
            return {"skipped": "not in the export"}
        head = await run_in_threadpool(self.tree.read_asset, path, 16)
        if head is None:
            self.report.skip(path, node.title, f"{name} couldn't be read.")
            return {"skipped": "couldn't be read"}
        if page_assets.sniff(head) is not None:
            if size > IMAGE_MAX:
                self.report.skip(path, node.title, f"The image {name} is larger than 20 MB.")
                return {"skipped": "image larger than 20 MB"}
            data = await run_in_threadpool(self.tree.read_asset, path, IMAGE_MAX)
            try:
                info = await page_assets.upload(self.db, page, data, user_id=self.dest.user.id, max_bytes=IMAGE_MAX)
            except HTTPException as exc:
                self.report.skip(path, node.title, f"The image {name} wasn't imported: {_detail(exc)}")
                return {"skipped": "image not imported"}
            self.report.counts["images"] += 1
            return {"image": info["id"]}
        return await self._file(node, page, path, name, size)

    async def _file(self, node: SourceNode, page: dict, path: str, name: str, size: int) -> dict:
        import hashlib

        from app.services import access, file_versions, r2
        from app.services import artifact as art_service
        from app.services import library as lib_service

        mime = art_service.normalize_mime(None, name)
        if not mime or mime == "application/zip":
            self.report.skip(path, node.title, f"{name}: Markdrop doesn't hold this type of file.")
            return {"skipped": "file type not supported"}
        if size > min(MAX_FILE_BYTES, art_service.max_bytes_for(mime)):
            self.report.skip(path, node.title, f"{name} is larger than {min(MAX_FILE_BYTES, art_service.max_bytes_for(mime)) // (1024 * 1024)} MB.")
            return {"skipped": "file too large"}
        if not r2.is_configured():
            self.report.skip(path, node.title, f"{name}: file storage isn't available.")
            return {"skipped": "storage unavailable"}
        allowed, _used = await art_service.check_quota(self.db, self.dest.user.id, size)
        if not allowed:
            self.report.skip(path, node.title, f"{name}: your Markdrop storage is full.")
            return {"skipped": "storage full"}
        data = await run_in_threadpool(self.tree.read_asset, path, MAX_FILE_BYTES)
        if not data:
            return {"skipped": "couldn't be read"}
        bad = art_service.check_upload(data, mime)
        if bad:
            self.report.skip(path, node.title, f"{name}: {art_service.refusal_detail(bad)}")
            return {"skipped": "file refused"}
        key = art_service.make_blob_key(self.dest.user.id, mime)
        if not await run_in_threadpool(r2.put_bytes, key, data, mime, False):
            self.report.skip(path, node.title, f"{name}: it couldn't be stored.")
            return {"skipped": "not stored"}
        doc, _secret = await art_service.create_artifact(
            self.db, user_id=self.dest.user.id, blob_key=key, mime=mime, size_bytes=len(data),
            title=name, filename=name, preferred_slug=name, access_level="private")
        raw = await self.db["documents"].find_one({"slug": doc.slug})
        await self.db["documents"].update_one({"_id": raw["_id"]}, {"$set": {
            "sha256": hashlib.sha256(data).hexdigest(), "file_version": 1, "file_updated_at": now_utc()}})
        raw = await self.db["documents"].find_one({"_id": raw["_id"]})
        await file_versions.ensure_current_row(self.db, raw)
        if self.dest.workspace_id:
            raw, err = await lib_service.place_new(self.db, raw, self.dest.user, self.dest.workspace_id,
                                                   page.get("folder_id") or self.dest.folder_id, self.dest.level)
            if err:
                self.report.error(path, name, err)
        await self._mark(raw)
        self.ctx.forget()
        _ = access  # (access rules applied by place_new / set_level)
        self.report.counts["files"] += 1
        return {"file": raw["slug"]}


def _cell(v: str) -> str:
    return (v or "").replace("\n", " ").replace("|", "\\|").strip() or " "
