"""Workspace folder views for the app, agents and public folder pages.

Contracts (workspaces v2 spec):

* ``tree`` — folders with readable counts, share state, ``unfiled_count``;
* ``items`` — the rows the caller can read (cursor-paged), plus, for workspace
  admins/owner, *redacted* rows for other people's private filed documents (Q1)
  whose only action is "remove from workspace" via an opaque ``id_token``;
* folder listings for ``/host/folder`` and ``/folders/shared/{id}`` — only
  items the caller can read; a folder is shown when it holds at least one
  (recursively), so structure never leaks (D2, §4.2 #46).
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.models.folder import Folder
from app.services import access, artifact as art_service, publicity, urls
from app.services import folder as folder_service
from app.services.library import kind_clause, search_filter

settings = get_settings()
MAX_ITEMS_PAGE = 100
# The rail's outline (``nav``): at most this many items per folder (and at the top level); the
# rest are counted in ``more`` and the rail links to the folder view for them.
NAV_PER_PLACE = 50
# Listing rows never need a document's body.
LIST_PROJECTION = {"content": 0}


# ── Opaque handles for redacted rows ──────────────────────────────────────────


def _handle_key() -> bytes:
    return hashlib.sha256(f"redacted-row:{settings.auth_secret}".encode()).digest()


def make_handle(workspace_id: str, doc_id: str) -> str:
    nonce = os.urandom(12)
    ct = AESGCM(_handle_key()).encrypt(nonce, f"{workspace_id}:{doc_id}".encode(), b"rh1")
    return "rh_" + base64.urlsafe_b64encode(nonce + ct).decode().rstrip("=")


def read_handle(handle: str, workspace_id: str) -> str | None:
    """The document id behind a handle minted for this workspace, else None."""
    if not handle or not handle.startswith("rh_") or len(handle) > 300:
        return None
    try:
        raw = base64.urlsafe_b64decode(handle[3:] + "=" * (-len(handle[3:]) % 4))
        plain = AESGCM(_handle_key()).decrypt(raw[:12], raw[12:], b"rh1").decode()
    except Exception:
        return None
    ws, _, doc_id = plain.partition(":")
    return doc_id if ws == workspace_id else None


# ── Cursors ───────────────────────────────────────────────────────────────────


def encode_cursor(updated_at: datetime, doc_id: Any) -> str:
    u = publicity.aware(updated_at) or datetime.now(timezone.utc)
    return base64.urlsafe_b64encode(json.dumps({"u": u.isoformat(), "i": str(doc_id)}).encode()).decode().rstrip("=")


def decode_cursor(cursor: str | None) -> dict | None:
    if not cursor:
        return None
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        u = datetime.fromisoformat(data["u"])
        i = ObjectId(data["i"])
    except Exception:
        raise HTTPException(status_code=422, detail="That cursor isn't valid; start again without one.")
    # Mongo hands back naive UTC; compare like with like.
    u_naive = u.astimezone(timezone.utc).replace(tzinfo=None)
    return {"$or": [{"updated_at": {"$lt": u_naive}}, {"updated_at": u_naive, "_id": {"$lt": i}}]}


# ── Shared helpers ────────────────────────────────────────────────────────────


def safe_picture(value) -> str | None:
    """A profile photo we may hand to a browser: https only (as presence does)."""
    return value if isinstance(value, str) and value.startswith("https://") and len(value) <= 2048 else None


async def owner_cards(db: AsyncIOMotorDatabase, owner_ids) -> dict[str, dict]:
    """``{user id: {"name", "picture"}}`` for a whole listing in ONE query (no N+1). Callers decide
    who may see them: every listing that uses this is for people with a relationship to the rows
    (workspace members; personal lists check the caller's role per row)."""
    oids = []
    for oid in {o for o in owner_ids if o}:
        try:
            oids.append(ObjectId(oid))
        except Exception:
            continue
    if not oids:
        return {}
    rows = await db["users"].find({"_id": {"$in": oids}}, {"name": 1, "email": 1, "picture": 1}).to_list(length=len(oids))
    return {str(r["_id"]): {"name": (r.get("name") or "").strip() or (r.get("email") or "").split("@")[0] or None,
                            "picture": safe_picture(r.get("picture"))} for r in rows}


async def owner_names(db: AsyncIOMotorDatabase, owner_ids) -> dict[str, str | None]:
    return {k: v["name"] for k, v in (await owner_cards(db, owner_ids)).items()}


def owner_of(raw: dict, people: dict, *, mine: bool) -> dict:
    """A row's ``owner``: name and picture (https) when known, and whether it's the caller."""
    card = people.get(raw.get("owner_id") or "") or {}
    if isinstance(card, str):  # an older caller's names map
        card = {"name": card}
    return {"name": card.get("name"), "picture": card.get("picture"), "is_you": mine}


def folder_index(folders: list[Folder]) -> dict[str, dict]:
    paths = folder_service.paths_by_id(folders)
    return {f.id: {"id": f.id, "name": f.name, "path": "/".join(paths.get(f.id) or [])} for f in folders}


def display_title(raw: dict) -> str | None:
    if raw.get("encrypted"):
        return None
    return raw.get("title") or (raw.get("original_filename") if raw.get("kind") == "artifact" else None)


async def with_children(db: AsyncIOMotorDatabase, ids: list) -> set:
    """Which of ``ids`` have at least one sub-page: one query for a whole listing (it was one
    ``find_one`` per row)."""
    ids = [i for i in ids if i is not None]
    if not ids:
        return set()
    return set(await db["documents"].distinct("parent_id", {"parent_id": {"$in": ids}}))


async def item_for(db: AsyncIOMotorDatabase, raw: dict, actor: access.Actor, ctx: access.Ctx,
                   *, names: dict, folders: dict, hosts: urls.HostCache, kids: set | None = None) -> dict:
    """One readable row (contract shape). ``kids``: the listing's ``with_children`` set."""
    flags = await access.can_flags(actor, raw, ctx)
    mine = bool(actor.user_id) and raw.get("owner_id") == actor.user_id
    folder = folders.get(raw.get("folder_id") or "") if raw.get("folder_id") else None
    workspace_url = await urls.workspace_url(db, raw, hosts)
    out = {
        "slug": raw["slug"],
        "title": display_title(raw),
        "kind": raw.get("kind") or "markdown",
        "mime": raw.get("mime"),
        "renderer": art_service.renderer_for(raw.get("mime") or "") if raw.get("kind") == "artifact" else None,
        "type_label": art_service.label_for(raw.get("mime") or "") if raw.get("kind") == "artifact" else None,
        "original_filename": raw.get("original_filename") if raw.get("kind") == "artifact" else None,
        "url": workspace_url or urls.markdrop_url(raw["slug"]),
        "markdrop_url": urls.markdrop_url(raw["slug"]),
        "access": raw.get("access_level") or "link",
        "has_password": bool(raw.get("read_password_hash")),
        "encrypted": bool(raw.get("encrypted")),
        "folder": folder,
        "owner": owner_of(raw, names, mine=mine),
        "size_bytes": raw.get("size_bytes") if raw.get("kind") == "artifact" else None,
        "updated_at": raw.get("updated_at"),
        "created_at": raw.get("created_at"),
        "views": int(raw.get("views") or 0),
        "redacted": False,
        "can": {"edit": flags["edit"], "move": flags["move"], "unshare": flags["unshare"],
                "delete": flags["delete"], "share": flags["share"]},
        # Pages (services/pages.py): the block editor, its icon, and where it sits
        # in the page tree (a sub-page is listed under its parent, not on its own).
        "editor": raw.get("editor"),
        "is_subpage": raw.get("parent_id") is not None,
        "has_children": (raw["_id"] in kids) if kids is not None
        else await db["documents"].find_one({"parent_id": raw["_id"]}, {"_id": 1}) is not None,
        "icon": raw.get("page_icon"),
    }
    if mine:
        out["id"] = str(raw["_id"])
    return out


def redacted_item(raw: dict, workspace_id: str, *, names: dict, folders: dict) -> dict:
    """Q1: a workspace admin's view of someone else's private filed document."""
    folder = folders.get(raw.get("folder_id") or "") if raw.get("folder_id") else None
    return {
        "redacted": True,
        "id_token": make_handle(workspace_id, str(raw["_id"])),
        "slug": None, "title": None, "url": None, "markdrop_url": None,
        "kind": raw.get("kind") or "markdown", "mime": None,
        "access": "private", "has_password": False, "encrypted": False,
        "folder": folder,
        "owner": owner_of(raw, names, mine=False),
        "size_bytes": None, "views": None,
        "updated_at": raw.get("updated_at"), "created_at": raw.get("created_at"),
        "can": {"edit": False, "move": False, "unshare": True, "delete": False, "share": False},
    }


# ── Tree ──────────────────────────────────────────────────────────────────────


async def readable_rows(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx,
                        workspace_id: str, *extra: dict, projection: dict | None = None) -> list[dict]:
    rf = await access.readable_filter(actor, workspace_id, ctx)
    return await db["documents"].find(rf.query(*extra), projection).to_list(length=50_000)


def counts(rows: list[dict], folders: list[Folder]) -> tuple[dict[str, int], dict[str, int], int]:
    """(direct, recursive) readable counts per folder, and the root count."""
    direct: dict[str, int] = {}
    root = 0
    for r in rows:
        fid = r.get("folder_id")
        if fid:
            direct[fid] = direct.get(fid, 0) + 1
        else:
            root += 1
    total: dict[str, int] = {}
    for f in folders:
        total[f.id] = sum(direct.get(fid, 0) for fid in folder_service.subtree_ids(folders, f.id))
    return direct, total, root


def _empty_exposure() -> dict[str, int]:
    return {"link": 0, "workspace": 0, "private": 0, "password": 0}


def exposure(rows: list[dict]) -> tuple[dict[str, dict[str, int]], dict[str, int]]:
    """Who can open what, per folder (direct items) and at the root, counted
    over ``rows`` — which must be the caller's *readable* rows only, so a count
    never includes something the caller can't open. A password-protected link
    item counts in ``link`` and again in ``password``."""
    per: dict[str, dict[str, int]] = {}
    root = _empty_exposure()
    for r in rows:
        bucket = per.setdefault(r["folder_id"], _empty_exposure()) if r.get("folder_id") else root
        level = r.get("access_level") or "link"
        if level not in ("link", "workspace", "private"):
            level = "private"
        bucket[level] += 1
        if level == "link" and r.get("read_password_hash"):
            bucket["password"] += 1
    return per, root


FOLDER_PEOPLE = 3


def folder_activity(rows: list[dict], folders: list[Folder]) -> dict[str, dict]:
    """Per folder, over its whole subtree and only the caller's readable ``rows``: when anything
    in it last changed, and whose items are in it (owner ids, most recently active first)."""
    direct: dict[str, list[dict]] = {}
    for r in rows:
        if r.get("folder_id"):
            direct.setdefault(r["folder_id"], []).append(r)
    epoch = datetime.min
    out: dict[str, dict] = {}
    for f in folders:
        latest: datetime | None = None
        seen: dict[str, datetime] = {}
        for fid in folder_service.subtree_ids(folders, f.id):
            for r in direct.get(fid, ()):
                u = r.get("updated_at")
                if isinstance(u, datetime):
                    u = u.replace(tzinfo=None) if u.tzinfo else u
                    latest = u if latest is None or u > latest else latest
                o = r.get("owner_id")
                if o:
                    t = u if isinstance(u, datetime) else epoch
                    if o not in seen or t > seen[o]:
                        seen[o] = t
        out[f.id] = {"updated_at": latest, "owners": sorted(seen, key=lambda o: seen[o], reverse=True)}
    return out


async def tree(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx,
               workspace_id: str, role: str) -> dict:
    """The workspace's folders with readable counts, plus, per folder, when its readable contents
    last changed (``updated_at``) and the people whose items are in it (``people``: up to
    :data:`FOLDER_PEOPLE`, most recent first, and ``people_count``). The caller is a workspace
    member (the router requires a role), so names are theirs to see; nothing here counts or names
    an item the caller can't read."""
    ws = await ctx.workspace(workspace_id)
    folders = await folder_service.list_folders(db, workspace_id)
    paths = folder_service.paths_by_id(folders)
    rows = await readable_rows(db, actor, ctx, workspace_id,
                               projection={"folder_id": 1, "access_level": 1, "read_password_hash": 1,
                                           "owner_id": 1, "updated_at": 1})
    direct, total, root = counts(rows, folders)
    per, root_exposure = exposure(rows)
    activity = folder_activity(rows, folders)
    shown = {o for a in activity.values() for o in a["owners"][:FOLDER_PEOPLE]}
    cards = await owner_cards(db, shown)

    def people(fid: str) -> list[dict]:
        out = []
        for o in activity[fid]["owners"][:FOLDER_PEOPLE]:
            card = cards.get(o)
            if card:
                out.append({"name": card["name"], "picture": card["picture"],
                            "is_you": bool(actor.user_id) and o == actor.user_id})
        return out

    ordered = sorted(folders, key=lambda f: [s.lower() for s in (paths.get(f.id) or [])])
    ws_default = ws.settings.default_access if ws else "link"
    return {
        "workspace": {"id": workspace_id, "name": ws.name if ws else None, "role": role,
                      "primary_host": await urls.live_primary_host(db, workspace_id),
                      "default_access": ws_default},
        "folders": [
            {
                "id": f.id, "name": f.name, "slug": f.slug, "parent_id": f.parent_id,
                "path": "/".join(paths.get(f.id) or []), "depth": len(paths.get(f.id) or []),
                "item_count": direct.get(f.id, 0), "total_count": total.get(f.id, 0),
                "share": ({"id": f.share.get("id"), "level": f.share.get("level")}
                          if f.share and f.share.get("id") else None),
                "default_access": f.default_access,
                "effective_default_access": f.default_access or ws_default,
                "exposure": per.get(f.id) or _empty_exposure(),
                "updated_at": activity[f.id]["updated_at"] or f.updated_at,
                "people": people(f.id),
                "people_count": len(activity[f.id]["owners"]),
                **({"meetings": True} if f.meetings else {}),
            }
            for f in ordered
        ],
        "unfiled_count": root,
        "root_exposure": root_exposure,
    }


_NAV_FIELDS = {"slug": 1, "title": 1, "kind": 1, "editor": 1, "original_filename": 1, "encrypted": 1,
               "folder_id": 1, "parent_id": 1, "created_at": 1}


async def nav(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, workspace_id: str) -> dict:
    """The app rail's outline of a workspace, in one request: every readable top-level item
    (pages, documents and files; sub-pages come from ``GET /documents/{slug}/children`` when a
    page is opened), compact, grouped by folder. Per folder (``""`` = the top level): pages first
    in the order they were made (the order sub-pages use), then everything else by title; at most
    ``NAV_PER_PLACE`` of them, the rest counted in ``more``. ``has_children`` counts only
    sub-pages this caller can read. Two queries (the tree's projected scan of readable rows, then
    the rows shown, without their content), a ``can(read)`` per row shown, and a link for each
    image icon."""
    from app.services import pages as pages_service

    rows = await readable_rows(db, actor, ctx, workspace_id, projection=_NAV_FIELDS)
    parents = {r.get("parent_id") for r in rows if r.get("parent_id") is not None}
    places: dict[str, list[dict]] = {}
    for r in rows:
        if r.get("parent_id") is None:
            places.setdefault(r.get("folder_id") or "", []).append(r)
    epoch = datetime.min.replace(tzinfo=timezone.utc)

    def made(r: dict):
        c = r.get("created_at") or epoch
        return (c if c.tzinfo else c.replace(tzinfo=timezone.utc), str(r["_id"]))

    def title_key(r: dict):
        return ((display_title(r) or r["slug"]).lower(), r["slug"])

    order: list[dict] = []
    more: dict[str, int] = {}
    for place, group in places.items():
        ranked = [*sorted((r for r in group if r.get("editor") == "blocks"), key=made),
                  *sorted((r for r in group if r.get("editor") != "blocks"), key=title_key)]
        order.extend(ranked[:NAV_PER_PLACE])
        if len(ranked) > NAV_PER_PLACE:
            more[place or "root"] = len(ranked) - NAV_PER_PLACE
    full = {r["_id"]: r for r in await db["documents"].find(
        {"_id": {"$in": [r["_id"] for r in order]}}, {"content": 0}).to_list(length=len(order) or 1)}
    items: list[dict] = []
    for r in order:
        raw = full.get(r["_id"])
        # The filter is the policy's (A1); can(read) stays the authority for anything we name.
        if raw is None or not (await access.can(actor, raw, "read", ctx)).allowed:
            continue
        page = raw.get("editor") == "blocks"
        artifact = raw.get("kind") == "artifact"
        row = {
            "slug": raw["slug"],
            "title": display_title(raw),
            "kind": "page" if page else ("artifact" if artifact else "markdown"),
            "folder_id": raw.get("folder_id") or None,
            "has_children": raw["_id"] in parents,
            "renderer": art_service.renderer_for(raw.get("mime") or "") if artifact else None,
            "mime": raw.get("mime") if artifact else None,
            "filename": raw.get("original_filename") if artifact else None,
            "icon": None,
            "icon_url": None,
        }
        if page:
            row.update(await pages_service.icon_fields(db, raw))
        # Compact: optional fields only when set.
        items.append({k: v for k, v in row.items() if v is not None or k in ("title", "folder_id")})
    return {"items": items, "more": more}


# ── Items ─────────────────────────────────────────────────────────────────────


async def items(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, workspace_id: str,
                *, folder: str = "all", q: str | None = None, kind: str | None = None,
                cursor: str | None = None, limit: int = 50) -> dict:
    limit = max(1, min(MAX_ITEMS_PAGE, int(limit or 50)))
    rf = await access.readable_filter(actor, workspace_id, ctx)
    extra: list[dict | None] = [kind_clause(kind), search_filter(q), decode_cursor(cursor)]
    if folder in ("root", "unfiled"):
        extra.append({"folder_id": None})
    elif folder and folder != "all":
        await folder_service._get_owned(db, workspace_id, folder)
        extra.append({"folder_id": folder})
    clauses = [e for e in extra if e]
    redacted_q = rf.redacted if (rf.redacted is not None and not q) else None
    who = {"$or": [rf.readable, redacted_q]} if redacted_q is not None else rf.readable
    query = {"$and": [*rf.base, who, *clauses]}
    # Without the body (a document's content can be large and nothing here reads it). The sort is
    # served by the (workspace_id, folder_id, updated_at, _id) index (database.py).
    rows = await db["documents"].find(query, LIST_PROJECTION).sort(
        [("updated_at", -1), ("_id", -1)]).limit(limit + 1).to_list(length=limit + 1)
    more = len(rows) > limit
    rows = rows[:limit]
    folders = folder_index(await folder_service.list_folders(db, workspace_id))
    names = await owner_cards(db, [r.get("owner_id") for r in rows])
    hosts = urls.HostCache(db)
    kids = await with_children(db, [r["_id"] for r in rows])
    out = []
    for raw in rows:
        if (await access.can(actor, raw, "read", ctx)).allowed:
            out.append(await item_for(db, raw, actor, ctx, names=names, folders=folders, hosts=hosts, kids=kids))
        elif redacted_q is not None:
            out.append(redacted_item(raw, workspace_id, names=names, folders=folders))
    next_cursor = encode_cursor(rows[-1].get("updated_at"), rows[-1]["_id"]) if more and rows else None
    return {"items": out, "next_cursor": next_cursor}


async def items_by_slug(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx,
                        workspace_id: str, slugs: list[str]) -> list[dict]:
    rows = await db["documents"].find({"slug": {"$in": slugs}, "workspace_id": workspace_id},
                                      LIST_PROJECTION).to_list(length=len(slugs))
    folders = folder_index(await folder_service.list_folders(db, workspace_id))
    names = await owner_cards(db, [r.get("owner_id") for r in rows])
    hosts = urls.HostCache(db)
    ctx.forget()
    by_slug = {r["slug"]: r for r in rows}
    kids = await with_children(db, [r["_id"] for r in rows])
    return [await item_for(db, by_slug[s], actor, ctx, names=names, folders=folders, hosts=hosts, kids=kids)
            for s in slugs if s in by_slug]


# ── Folder pages (custom domain index, shared folder) ─────────────────────────


def _public_doc(raw: dict, *, url: str) -> dict:
    """A document row on a folder page (folderIndex.ts contract, extended)."""
    is_art = raw.get("kind") == "artifact"
    return {
        "slug": raw["slug"],
        "title": display_title(raw),
        "kind": raw.get("kind") or "markdown",
        "type_label": art_service.label_for(raw.get("mime") or "") if is_art else None,
        "renderer": art_service.renderer_for(raw.get("mime") or "") if is_art else None,
        "mime": raw.get("mime"),
        "original_filename": raw.get("original_filename"),
        "folder_path": raw.get("folder_path") or [],
        "created_at": raw.get("created_at"),
        "updated_at": raw.get("updated_at"),
        "url": url,
        "size_bytes": raw.get("size_bytes") if is_art else None,
    }


async def folder_listing(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx,
                         workspace_id: str, folder_id: str | None, *, root_id: str | None = None,
                         always_show: bool = False) -> dict | None:
    """Subfolders (each with ≥1 readable item below it) and the readable
    documents directly in ``folder_id`` (None = the workspace root). Returns
    None when the folder holds nothing the caller can read (and isn't
    ``always_show``) — the caller then answers 404 so structure never leaks."""
    folders = await folder_service.list_folders(db, workspace_id)
    # Counts need only the folder of each readable row; full rows are fetched
    # for the one folder being shown.
    rows = await readable_rows(db, actor, ctx, workspace_id, projection={"folder_id": 1})
    _direct, total, _root = counts(rows, folders)
    paths = folder_service.paths_by_id(folders)
    in_scope = set(folder_service.subtree_ids(folders, root_id)) if root_id else None

    if folder_id is not None:
        here_total = total.get(folder_id, 0)
    else:
        here_total = len(rows)
    if here_total == 0 and not always_show:
        return None

    subs = [f for f in folders if f.parent_id == folder_id and total.get(f.id, 0) > 0
            and (in_scope is None or f.id in in_scope)]
    subs.sort(key=lambda f: f.name.lower())
    hosts = urls.HostCache(db)
    rf = await access.readable_filter(actor, workspace_id, ctx)
    docs = await db["documents"].find(rf.query({"folder_id": folder_id or None})).sort(
        "updated_at", -1).to_list(length=5000)
    documents = []
    for r in docs:
        documents.append({**_public_doc(r, url=await urls.canonical_url(db, r, hosts)),
                          **_poster(r, publicity.is_public(r, require_auth=rf.require_auth))})
    return {"folders": subs, "paths": paths, "total": total, "documents": documents}


def _poster(raw: dict, public: bool) -> dict:
    if raw.get("kind") != "artifact" or not raw.get("poster_key"):
        return {}
    return {"poster_url": publicity.byte_urls(raw, public=public).get("poster_url")}


async def hidden_for_share(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx,
                           workspace_id: str, folder_id: str, level: str) -> list[dict]:
    """D7: items in the folder's subtree the **caller** can read that the
    share's audience could not (link: anonymous; workspace: a plain member)."""
    folders = await folder_service.list_folders(db, workspace_id)
    ids = folder_service.subtree_ids(folders, folder_id)
    mine = await readable_rows(db, actor, ctx, workspace_id, {"folder_id": {"$in": ids}})
    if level == "link":
        audience = await readable_rows(db, access.Actor(), access.Ctx(db), workspace_id,
                                       {"folder_id": {"$in": ids}}, projection={"_id": 1})
        seen = {r["_id"] for r in audience}
        hidden = [r for r in mine if r["_id"] not in seen]
    else:
        hidden = [r for r in mine if (r.get("access_level") or "link") == "private"]
    return [{"slug": r["slug"], "title": display_title(r),
             "access": r.get("access_level") or "link",
             "has_password": bool(r.get("read_password_hash")),
             "is_yours": bool(actor.user_id) and r.get("owner_id") == actor.user_id} for r in hidden]


async def share_summary(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx,
                        workspace_id: str, folder_id: str, share: dict) -> dict:
    """The PUT/GET …/share response."""
    from app.services import urls as urls_service

    folders = await folder_service.list_folders(db, workspace_id)
    ids = folder_service.subtree_ids(folders, folder_id)
    total = len(await readable_rows(db, actor, ctx, workspace_id, {"folder_id": {"$in": ids}},
                                    projection={"_id": 1}))
    hidden = await hidden_for_share(db, actor, ctx, workspace_id, folder_id, share["level"])
    return {"share_id": share["id"], "url": urls_service.markdrop_url(f"f/{share['id']}"),
            "level": share["level"], "hidden_count": len(hidden), "hidden": hidden,
            "total_count": total}
