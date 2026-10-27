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


async def owner_names(db: AsyncIOMotorDatabase, owner_ids) -> dict[str, str | None]:
    oids = []
    for oid in {o for o in owner_ids if o}:
        try:
            oids.append(ObjectId(oid))
        except Exception:
            continue
    if not oids:
        return {}
    rows = await db["users"].find({"_id": {"$in": oids}}, {"name": 1, "email": 1}).to_list(length=len(oids))
    return {str(r["_id"]): (r.get("name") or (r.get("email") or "").split("@")[0] or None) for r in rows}


def folder_index(folders: list[Folder]) -> dict[str, dict]:
    paths = folder_service.paths_by_id(folders)
    return {f.id: {"id": f.id, "name": f.name, "path": "/".join(paths.get(f.id) or [])} for f in folders}


def display_title(raw: dict) -> str | None:
    if raw.get("encrypted"):
        return None
    return raw.get("title") or (raw.get("original_filename") if raw.get("kind") == "artifact" else None)


async def item_for(db: AsyncIOMotorDatabase, raw: dict, actor: access.Actor, ctx: access.Ctx,
                   *, names: dict, folders: dict, hosts: urls.HostCache) -> dict:
    """One readable row (contract shape)."""
    flags = await access.can_flags(actor, raw, ctx)
    mine = bool(actor.user_id) and raw.get("owner_id") == actor.user_id
    folder = folders.get(raw.get("folder_id") or "") if raw.get("folder_id") else None
    workspace_url = await urls.workspace_url(db, raw, hosts)
    out = {
        "slug": raw["slug"],
        "title": display_title(raw),
        "kind": raw.get("kind") or "markdown",
        "mime": raw.get("mime"),
        "url": workspace_url or urls.markdrop_url(raw["slug"]),
        "markdrop_url": urls.markdrop_url(raw["slug"]),
        "access": raw.get("access_level") or "link",
        "has_password": bool(raw.get("read_password_hash")),
        "encrypted": bool(raw.get("encrypted")),
        "folder": folder,
        "owner": {"name": names.get(raw.get("owner_id") or ""), "is_you": mine},
        "size_bytes": raw.get("size_bytes") if raw.get("kind") == "artifact" else None,
        "updated_at": raw.get("updated_at"),
        "created_at": raw.get("created_at"),
        "views": int(raw.get("views") or 0),
        "redacted": False,
        "can": {"edit": flags["edit"], "move": flags["move"], "unshare": flags["unshare"],
                "delete": flags["delete"], "share": flags["share"]},
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
        "owner": {"name": names.get(raw.get("owner_id") or ""), "is_you": False},
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


async def tree(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx,
               workspace_id: str, role: str) -> dict:
    ws = await ctx.workspace(workspace_id)
    folders = await folder_service.list_folders(db, workspace_id)
    paths = folder_service.paths_by_id(folders)
    rows = await readable_rows(db, actor, ctx, workspace_id, projection={"folder_id": 1})
    direct, total, root = counts(rows, folders)
    ordered = sorted(folders, key=lambda f: [s.lower() for s in (paths.get(f.id) or [])])
    return {
        "workspace": {"id": workspace_id, "name": ws.name if ws else None, "role": role,
                      "primary_host": await urls.live_primary_host(db, workspace_id)},
        "folders": [
            {
                "id": f.id, "name": f.name, "slug": f.slug, "parent_id": f.parent_id,
                "path": "/".join(paths.get(f.id) or []), "depth": len(paths.get(f.id) or []),
                "item_count": direct.get(f.id, 0), "total_count": total.get(f.id, 0),
                "share": ({"id": f.share.get("id"), "level": f.share.get("level")}
                          if f.share and f.share.get("id") else None),
            }
            for f in ordered
        ],
        "unfiled_count": root,
    }


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
    rows = await db["documents"].find(query).sort([("updated_at", -1), ("_id", -1)]).limit(limit + 1).to_list(length=limit + 1)
    more = len(rows) > limit
    rows = rows[:limit]
    folders = folder_index(await folder_service.list_folders(db, workspace_id))
    names = await owner_names(db, [r.get("owner_id") for r in rows])
    hosts = urls.HostCache(db)
    out = []
    for raw in rows:
        if (await access.can(actor, raw, "read", ctx)).allowed:
            out.append(await item_for(db, raw, actor, ctx, names=names, folders=folders, hosts=hosts))
        elif redacted_q is not None:
            out.append(redacted_item(raw, workspace_id, names=names, folders=folders))
    next_cursor = encode_cursor(rows[-1].get("updated_at"), rows[-1]["_id"]) if more and rows else None
    return {"items": out, "next_cursor": next_cursor}


async def items_by_slug(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx,
                        workspace_id: str, slugs: list[str]) -> list[dict]:
    rows = await db["documents"].find({"slug": {"$in": slugs}, "workspace_id": workspace_id}).to_list(length=len(slugs))
    folders = folder_index(await folder_service.list_folders(db, workspace_id))
    names = await owner_names(db, [r.get("owner_id") for r in rows])
    hosts = urls.HostCache(db)
    ctx.forget()
    by_slug = {r["slug"]: r for r in rows}
    return [await item_for(db, by_slug[s], actor, ctx, names=names, folders=folders, hosts=hosts)
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
    rows = await readable_rows(db, actor, ctx, workspace_id)
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
    docs = [r for r in rows if (r.get("folder_id") or None) == folder_id]
    docs.sort(key=lambda r: publicity.aware(r.get("updated_at")) or datetime.min.replace(tzinfo=timezone.utc),
              reverse=True)
    documents = []
    for r in docs:
        documents.append({**_public_doc(r, url=await urls.canonical_url(db, r, hosts)),
                          **_poster(r, await publicity.doc_is_public(db, r))})
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
             "access": "password" if (r.get("read_password_hash") and (r.get("access_level") or "link") == "link")
             else (r.get("access_level") or "link"),
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
