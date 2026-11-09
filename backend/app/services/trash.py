"""Trash: a deleted item waits 30 days before it is destroyed.

Deleting a document, page or file (the web app, the API, MCP's
``delete_document``) moves its row out of ``documents`` into ``trash``; nothing
that hangs off it (grants, versions, page images, history, analytics, R2
objects) is touched. Because the row is no longer in ``documents``, every
listing, search, tree, folder page, sitemap, OG card and MCP list stops seeing
it without each of them having to filter, and its link 404s like any missing
document. ``GET /trash/lookup/{slug}`` tells someone who could edit it that it
is in the trash instead (the 404 page asks).

* **Bytes.** Before the row moves, its R2 objects (the blob or a zipped site's
  prefix, the poster, the page images) are closed under a bumped access epoch,
  exactly as :func:`lifecycle.destroy` closes them before deleting: the Worker
  then serves them to nobody (no public flag, every signed link handed out so
  far refused). Restoring re-derives them from the row (the reconciler's
  ``reconcile_document``), so a public file is public again.
* **Slug.** The trash row keeps the slug and the former slugs reserved for
  everyone, the owner included (``lifecycle.slug_unavailable``), so a restore
  never finds its address taken. Deleting forever leaves the usual 30-day
  tombstone.
* **Sub-pages.** A delete with ``children=delete`` puts the page and every page
  below it in one *batch* (``batch`` = the page's id); the batch is listed
  once (its root, "+N sub-pages"), restored together and deleted forever
  together. ``children=lift`` moves the sub-pages up first, as before; only the
  page itself goes to the trash.
* **Folders.** Deleting a folder (a workspace admin's call) moves the folder,
  every folder below it and every item filed in them to the trash as one batch
  (``batch`` = the folder's id). A workspace admin restores the whole folder,
  with its structure and contents (renamed ``-2``… if something took its
  address meanwhile; at the top when its parent folder is gone). An item's own
  owner who isn't an admin sees their own items from it and can restore one
  (with the sub-pages deleted with it) on its own, to the top of the workspace.
* **Restore** puts it back where it was: the same parent page, workspace,
  folder, access level, password and grants. When the parent page is gone it
  goes to the top level (its access becomes its own, what it had); when the
  folder is gone, to the top of the workspace; when the workspace is gone, to
  the owner's own files with the conversion leaving a workspace makes
  (``workspace`` ⇒ private, never wider).
* **Who.** Whoever could delete it (its owner, or the edit secret) sees it in
  their trash, restores it and deletes it forever; so do the admins and owner
  of the workspace it was in, for anything deleted there (an item they can't
  read is listed without its title). Never on a workspace's own domain
  (tenant sessions only read).
* **Purge.** ``purge_due`` (services/background.py, every 15 minutes) destroys
  what has been in the trash for 30 days, and anything whose own expiry passed
  meanwhile, through ``lifecycle.destroy``; a folder row is simply dropped.
* Page templates (services/page_user_templates.py) and the admin panel's
  delete stay permanent.

Rows (documents): ``{_id (the document's id), doc (the row as it was, epoch
bumped), slug, old_slugs, owner_id, workspace_id, batch, root, depth, unit,
unit_top, deleted_at, deleted_by, via, purge_at, was}``. Rows (folders):
``{_id (the folder's id), type: "folder", folder (the row), workspace_id,
batch, root, depth, …}`` — no ``slug`` (folder addresses aren't global).
"""

from __future__ import annotations

import logging
import math
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.services import access, live, publicity, revalidate

log = logging.getLogger(__name__)

COLL = "trash"
DAYS = 30
FOLDER = "folder"
NOT_IN_TRASH = "That isn't in the trash (it may have been restored or deleted forever)."
# Document rows in a folder batch sort after its folders (restored first).
_DOC_DEPTH = 100


def _now() -> datetime:
    return datetime.now(timezone.utc)


def aware(dt: datetime | None) -> datetime | None:
    return publicity.aware(dt)


def iso(dt: datetime | None) -> str | None:
    dt = aware(dt)
    return dt.isoformat().replace("+00:00", "Z") if dt else None


def is_folder(row: dict | None) -> bool:
    return bool(row) and row.get("type") == FOLDER


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    # Only document rows carry a slug (folder rows have none).
    await db[COLL].create_index("slug", unique=True, partialFilterExpression={"slug": {"$type": "string"}})
    await db[COLL].create_index("old_slugs", sparse=True)
    await db[COLL].create_index([("owner_id", 1), ("deleted_at", -1)])
    await db[COLL].create_index([("workspace_id", 1), ("deleted_at", -1)])
    await db[COLL].create_index("batch")
    await db[COLL].create_index("purge_at")
    await db[COLL].create_index("doc.blob_key", sparse=True)
    await db[COLL].create_index("doc.poster_key", sparse=True)


# ── Lookups other services use ───────────────────────────────────────────────


async def holds_slug(db: AsyncIOMotorDatabase, slug: str) -> bool:
    """Something in the trash answers (or answered) at ``slug``: reserved."""
    if not slug:
        return False
    return bool(await db[COLL].find_one({"$or": [{"slug": slug}, {"old_slugs": slug}]}, {"_id": 1}))


async def trashed_ids(db: AsyncIOMotorDatabase, ids) -> set[str]:
    """Those of ``ids`` (str or ObjectId) that are in the trash, as strings.
    Clean-ups that drop what belongs to a missing document call this first:
    a trashed document is not gone."""
    oids = [access.as_oid(i) for i in ids]
    oids = [o for o in oids if o is not None]
    if not oids:
        return set()
    rows = await db[COLL].find({"_id": {"$in": oids}}, {"_id": 1}).to_list(length=len(oids))
    return {str(r["_id"]) for r in rows}


async def trashed_doc(db: AsyncIOMotorDatabase, doc_id, projection: dict | None = None) -> dict | None:
    """The trashed document row with this id (``doc``), or None."""
    oid = access.as_oid(doc_id)
    if oid is None:
        return None
    row = await db[COLL].find_one({"_id": oid, "type": {"$ne": FOLDER}}, {"doc": 1})
    if row is None:
        return None
    doc = row["doc"]
    if projection:
        keep = {k for k, v in projection.items() if v}
        if keep:
            return {k: v for k, v in doc.items() if k in keep or k == "_id"}
        drop = {k for k, v in projection.items() if not v}
        return {k: v for k, v in doc.items() if k not in drop}
    return doc


async def find(db: AsyncIOMotorDatabase, key: str) -> dict | None:
    """The trash row at ``key``: a slug (or a former slug) of a document, or
    the id of a folder."""
    if not key:
        return None
    row = await db[COLL].find_one({"slug": key})
    if row is None:
        row = await db[COLL].find_one({"old_slugs": key})
    if row is None and ObjectId.is_valid(key):
        row = await db[COLL].find_one({"_id": ObjectId(key), "type": FOLDER})
    return row


def key_of(row: dict) -> str:
    """What the API and the tools name a trash item by: a document's slug, a
    folder's id."""
    return str(row["_id"]) if is_folder(row) else row.get("slug")


async def _root_of(db: AsyncIOMotorDatabase, row: dict) -> dict:
    if row.get("root"):
        return row
    root = await db[COLL].find_one({"_id": access.as_oid(row.get("batch"))})
    return root or row


async def batch_rows(db: AsyncIOMotorDatabase, root: dict) -> list[dict]:
    """The batch, root first then by depth."""
    rows = await db[COLL].find({"batch": root.get("batch")}).to_list(length=20_000)
    if not any(r["_id"] == root["_id"] for r in rows):
        rows.append(root)
    return sorted(rows, key=lambda r: (int(r.get("depth") or 0), str(r["_id"])))


async def unit_rows(db: AsyncIOMotorDatabase, row: dict) -> list[dict]:
    """A document from a folder batch and the sub-pages deleted with it."""
    rows = await db[COLL].find({"batch": row.get("batch"), "unit": row.get("unit")}).to_list(length=5000)
    return sorted(rows, key=lambda r: (int(r.get("depth") or 0), str(r["_id"])))


# ── Who ───────────────────────────────────────────────────────────────────────


async def manage_role(actor: access.Actor, row: dict, ctx: access.Ctx) -> str | None:
    """``owner`` (its owner, or its edit secret) or ``admin`` (an admin or the
    owner of the workspace it was in) — who may see it in the trash, restore it
    and delete it forever. A folder: admins only. None for anyone else, and
    always on a workspace's own domain (a tenant session only reads)."""
    if actor.cred == "tenant":
        return None
    uid = actor.user_id
    if is_folder(row):
        ws_id = row.get("workspace_id")
        if uid and ws_id and await ctx.role(ws_id, uid) in ("owner", "admin"):
            return "admin"
        return None
    doc = row.get("doc") or {}
    if uid and doc.get("owner_id") == uid:
        return "owner"
    if actor.edit_secret and await access._secret_ok(actor.edit_secret, doc.get("edit_secret_hash")):
        return "owner"
    ws_id = doc.get("workspace_id")
    if uid and ws_id and await ctx.role(ws_id, uid) in ("owner", "admin"):
        return "admin"
    return None


async def could_edit(actor: access.Actor, row: dict, ctx: access.Ctx) -> bool:
    """Who sees "this page is in the trash" at its link: anyone who could edit
    it (editors by grant or workspace role, too), never anyone else."""
    if is_folder(row):
        return False
    if await manage_role(actor, row, ctx):
        return True
    root = await _root_of(ctx.db, row)
    docs = [row["doc"]]
    if root["_id"] != row["_id"] and not is_folder(root):
        docs.append(root["doc"])
    for doc in docs:
        if (await access.can(actor, doc, "edit_content", ctx)).allowed:
            return True
    return False


def _refuse(actor: access.Actor) -> HTTPException:
    if actor.cred == "tenant":
        return HTTPException(status_code=401, detail="This session only works for reading documents on that "
                                                     "workspace's domain.")
    return HTTPException(status_code=404, detail=NOT_IN_TRASH)


async def _scope(db: AsyncIOMotorDatabase, actor: access.Actor, key: str,
                 ctx: access.Ctx) -> tuple[dict, list[dict], str]:
    """What restoring or deleting ``key`` forever acts on: ``(root, rows,
    "batch" | "unit")``. A folder batch as a whole is a workspace admin's; an
    item's owner may take their own item (and the sub-pages deleted with it)
    out of it alone. Otherwise the whole batch."""
    row = await find(db, key)
    if row is None:
        raise HTTPException(status_code=404, detail=NOT_IN_TRASH)
    root = await _root_of(db, row)
    if is_folder(root):
        if await manage_role(actor, root, ctx) is not None:
            return root, await batch_rows(db, root), "batch"
        if not is_folder(row) and await manage_role(actor, row, ctx) is not None:
            rows = await unit_rows(db, row)
            return rows[0], rows, "unit"
        raise _refuse(actor)
    if await manage_role(actor, root, ctx) is None:
        raise _refuse(actor)
    return root, await batch_rows(db, root), "batch"


# ── Moving to the trash ───────────────────────────────────────────────────────


def public_url(slug: str | None) -> str:
    """markdrop.in/<slug> (a local sandbox: its own frontend), as the MCP tools link."""
    from urllib.parse import urlsplit

    from app.config import get_settings

    front = get_settings().frontend_url.rstrip("/")
    if (urlsplit(front).hostname or "") in ("localhost", "127.0.0.1"):
        return f"{front}/{slug}"
    return f"https://markdrop.in/{slug}"


def via_of(actor: access.Actor) -> str:
    if actor.cred == "mcp":
        return "mcp"
    if actor.cred == "api_token":
        return "api"
    if actor.user_id:
        return "web"
    return "edit secret"


async def _was(db: AsyncIOMotorDatabase, raw: dict, *, folder_key: str = "folder_id") -> dict:
    """Where it was, by name, for the trash list after those things change."""
    out: dict = {"workspace": None, "folder": None, "parent": None}
    ws_id = raw.get("workspace_id")
    if ws_id:
        from app.services import workspace as ws_service

        ws = await ws_service.get_workspace(db, ws_id)
        out["workspace"] = ws.name if ws else None
    fid = raw.get(folder_key)
    if fid:
        f = await db["folders"].find_one({"_id": access.as_oid(fid)}, {"name": 1})
        out["folder"] = (f or {}).get("name")
    pid = raw.get("parent_id") if folder_key == "folder_id" else None
    if pid:
        p = await db["documents"].find_one({"_id": access.as_oid(pid)}, {"slug": 1, "title": 1, "encrypted": 1})
        if p:
            out["parent"] = {"slug": p.get("slug"), "title": None if p.get("encrypted") else p.get("title")}
    return out


async def _close(db: AsyncIOMotorDatabase, raw: dict, epoch: int) -> bool:
    """Close the bytes and the page images under ``epoch`` (never raises)."""
    from app.services import page_assets

    ok = True
    if publicity._has_bytes(raw):
        ok = await publicity.apply(raw, False, epoch=epoch)
    try:
        ok = await page_assets._set(db, raw, False, epoch) and ok
    except Exception:  # pragma: no cover - _set swallows its own
        log.warning("closing the images of %s failed", raw.get("slug"), exc_info=True)
        ok = False
    return ok


async def _close_all(db: AsyncIOMotorDatabase, rows: list[dict]) -> None:
    """Close every row's bytes before anything is written; when that fails
    nothing is moved (502) and the rows are left dirty so the reconciler
    re-opens what was closed."""
    closed: list[dict] = []
    for d in rows:
        if not await _close(db, d, publicity.epoch_of(d) + 1):
            for c in [*closed, d]:
                await db["documents"].update_one({"_id": c["_id"]}, {"$set": {"access_dirty": True}})
            raise HTTPException(status_code=502, detail="Couldn't secure the stored file before moving it to the "
                                                        "trash. Nothing was deleted — try again.")
        closed.append(d)


def _units(rows: list[dict]) -> dict[str, str]:
    """For each row, the top of its page tree among ``rows`` (its *unit*)."""
    by_id = {str(d["_id"]): d for d in rows}
    out: dict[str, str] = {}
    for d in rows:
        cur, hops = d, 0
        while str(cur.get("parent_id")) in by_id and hops <= access.MAX_PAGE_DEPTH + 1:
            cur = by_id[str(cur.get("parent_id"))]
            hops += 1
        out[str(d["_id"])] = str(cur["_id"])
    return out


async def _move_docs(db: AsyncIOMotorDatabase, rows: list[dict], actor: access.Actor, *, batch: str,
                     root_id, depth_of: dict[str, int], was_root: dict | None, units: dict[str, str] | None,
                     now: datetime) -> list[dict]:
    moved: list[dict] = []
    for d in rows:
        key = str(d["_id"])
        is_root = d["_id"] == root_id
        epoch = publicity.epoch_of(d) + 1
        row = {
            "_id": d["_id"], "doc": {**d, "access_epoch": epoch},
            "slug": d.get("slug"), "old_slugs": [s for s in (d.get("old_slugs") or []) if isinstance(s, str)],
            "owner_id": d.get("owner_id"), "workspace_id": d.get("workspace_id"),
            "batch": batch, "root": is_root, "depth": depth_of.get(key, 1),
            "deleted_at": now, "deleted_by": actor.user_id, "via": via_of(actor),
            "purge_at": now + timedelta(days=DAYS),
            "was": was_root if is_root else None,
        }
        if units is not None:
            row["unit"] = units.get(key, key)
            row["unit_top"] = row["unit"] == key
        # The trash row first: from this moment it holds the slug (the unique
        # index on documents holds it until the row below goes), so there is
        # never a moment in which someone else could take it.
        try:
            await db[COLL].insert_one(row)
        except DuplicateKeyError:
            # A leftover row for this id (a move that died half way): the
            # document is still live, so this one replaces it.
            await db[COLL].replace_one({"_id": d["_id"]}, row)
        gone = await db["documents"].find_one_and_delete({"_id": d["_id"]})
        if gone is None:  # someone else deleted it meanwhile
            await db[COLL].delete_one({"_id": d["_id"]})
            continue
        if gone != d:  # written meanwhile: keep what it is now
            await db[COLL].update_one({"_id": d["_id"]}, {"$set": {
                "doc": {**gone, "access_epoch": max(epoch, publicity.epoch_of(gone))}}})
        moved.append(gone)
        await _after_leaving(db, gone)
    return moved


async def move(db: AsyncIOMotorDatabase, rows: list[dict], root: dict, actor: access.Actor) -> list[dict]:
    """Move ``rows`` (deepest first, ``root`` last) to the trash as one batch.
    Returns the rows moved (as they were)."""
    await _close_all(db, rows)
    depth_of = {str(root["_id"]): 0}
    # Depth below the root, from the parent links (rows arrive deepest first).
    for d in reversed(rows):
        if str(d["_id"]) not in depth_of:
            depth_of[str(d["_id"])] = depth_of.get(str(d.get("parent_id")), 0) + 1
    return await _move_docs(db, rows, actor, batch=str(root["_id"]), root_id=root["_id"], depth_of=depth_of,
                            was_root=await _was(db, root), units=None, now=_now())


async def move_folder(db: AsyncIOMotorDatabase, workspace_id: str, folder_id: str,
                      actor: access.Actor) -> dict:
    """Delete a folder: it, every folder below it and everything filed in them
    go to the trash as one batch. The caller has checked the admin role.
    Returns ``{folders, documents, slugs}``."""
    from app.services import folder as folder_service

    raw = await folder_service._get_owned(db, workspace_id, folder_id)
    current = await folder_service.list_folders(db, workspace_id)
    ids = folder_service.subtree_ids(current, str(raw["_id"]))
    frows = await db["folders"].find({"_id": {"$in": [ObjectId(i) for i in ids]},
                                      "workspace_id": workspace_id}).to_list(length=len(ids))
    by_id = {str(f["_id"]): f for f in frows}
    fdepth: dict[str, int] = {}
    for f in frows:
        cur, n = f, 0
        while str(cur["_id"]) != str(raw["_id"]) and cur.get("parent_id") in by_id and n <= 50:
            cur, n = by_id[cur["parent_id"]], n + 1
        fdepth[str(f["_id"])] = n
    batch = str(raw["_id"])
    now = _now()
    await folder_service._lock(db, workspace_id, await folder_service.folders_rev(db, workspace_id))
    docs = await db["documents"].find({"workspace_id": workspace_id, "folder_id": {"$in": ids}}).to_list(length=20_000)
    docs.sort(key=lambda d: -len(d.get("page_path") or []))  # sub-pages before their pages
    await _close_all(db, docs)
    units = _units(docs)
    moved = await _move_docs(db, docs, actor, batch=batch, root_id=None,
                             depth_of={str(d["_id"]): _DOC_DEPTH + len(d.get("page_path") or []) for d in docs},
                             was_root=None, units=units, now=now)
    for d in moved:
        await db[COLL].update_one({"_id": d["_id"]}, {"$set": {"was": await _was(db, d)}})
    was = await _was(db, {"workspace_id": workspace_id, "parent_folder": raw.get("parent_id")},
                      folder_key="parent_folder")
    for f in sorted(frows, key=lambda f: -fdepth[str(f["_id"])]):
        is_root = f["_id"] == raw["_id"]
        row = {"_id": f["_id"], "type": FOLDER, "folder": f, "workspace_id": workspace_id, "owner_id": None,
               "batch": batch, "root": is_root, "depth": fdepth[str(f["_id"])], "deleted_at": now,
               "deleted_by": actor.user_id, "via": via_of(actor), "purge_at": now + timedelta(days=DAYS),
               "was": was if is_root else None}
        try:
            await db[COLL].insert_one(row)
        except DuplicateKeyError:
            await db[COLL].replace_one({"_id": f["_id"]}, row)
        await db["folders"].delete_one({"_id": f["_id"]})
    # C8: anything filed into them meanwhile goes with them.
    late = await db["documents"].find({"workspace_id": workspace_id, "folder_id": {"$in": ids}}).to_list(length=20_000)
    if late:
        late.sort(key=lambda d: -len(d.get("page_path") or []))
        await _close_all(db, late)
        moved += await _move_docs(db, late, actor, batch=batch, root_id=None,
                                  depth_of={str(d["_id"]): _DOC_DEPTH + len(d.get("page_path") or []) for d in late},
                                  was_root=None, units=_units(late), now=now)
    shares = [(f.get("share") or {}).get("id") for f in frows]
    slugs = [d["slug"] for d in moved]
    await folder_service._purge(db, workspace_id, slugs, [s for s in shares if s])
    return {"folders": len(frows), "documents": len(moved), "slugs": slugs}


async def _after_leaving(db: AsyncIOMotorDatabase, raw: dict) -> None:
    """Caches, sockets and in-memory state of a row that left ``documents``."""
    from app.services import engage, presence

    doc_id = str(raw["_id"])
    try:
        await revalidate.purge_doc(db, raw, extra_slugs=raw.get("old_slugs") or [], inline=True)
    except Exception:  # pragma: no cover - the outbox retries
        log.warning("purging %s after the trash move failed", raw.get("slug"), exc_info=True)
    live.gone(raw.get("slug"))
    engage.forget_doc(doc_id)
    presence.forget_doc(doc_id)


def restore_until(row: dict) -> datetime | None:
    """When it leaves the trash for good: 30 days after the delete, or its own
    expiry if that comes first."""
    until = aware(row.get("purge_at"))
    exp = aware((row.get("doc") or {}).get("expires_at"))
    if exp is not None and (until is None or exp < until):
        return exp
    return until


def days_left(row: dict, now: datetime | None = None) -> int:
    until = restore_until(row)
    if until is None:
        return 0
    return max(0, math.ceil((until - (now or _now())).total_seconds() / 86400))


# ── Listing ───────────────────────────────────────────────────────────────────


def kind_of(row_or_doc: dict) -> str:
    from app.services import pages

    if is_folder(row_or_doc):
        return FOLDER
    return pages.deleted_item(row_or_doc.get("doc", row_or_doc))["kind"]


async def _names(db: AsyncIOMotorDatabase, user_ids) -> dict[str, dict]:
    oids = [access.as_oid(u) for u in {u for u in user_ids if u}]
    oids = [o for o in oids if o is not None]
    if not oids:
        return {}
    rows = await db["users"].find({"_id": {"$in": oids}}, {"name": 1, "email": 1}).to_list(length=len(oids))
    return {str(r["_id"]): r for r in rows}


async def _ws_ref(db: AsyncIOMotorDatabase, ws_id: str | None, was: dict) -> dict | None:
    if not ws_id:
        return None
    from app.services import workspace as ws_service

    w = await ws_service.get_workspace(db, ws_id)
    return {"id": ws_id, "name": w.name if w else (was.get("workspace") or None), "exists": w is not None}


async def _folder_ref(db: AsyncIOMotorDatabase, fid: str | None, path: list | None, was: dict) -> dict | None:
    if not fid:
        return None
    f = await db["folders"].find_one({"_id": access.as_oid(fid)}, {"name": 1})
    in_trash = None if f else await db[COLL].find_one({"_id": access.as_oid(fid), "type": FOLDER}, {"folder.name": 1})
    name = (f or {}).get("name") or ((in_trash or {}).get("folder") or {}).get("name") or was.get("folder")
    return {"id": fid, "name": name, "path": "/".join(path or []), "exists": f is not None,
            "in_trash": in_trash is not None}


async def describe(db: AsyncIOMotorDatabase, row: dict, actor: access.Actor, role: str | None, *,
                   names: dict | None = None, ctx: access.Ctx | None = None) -> dict:
    """One trash item for the list (and for the link's trash notice)."""
    from app.services import artifact as art_service
    from app.services.workspace_items import display_title

    was = row.get("was") or {}
    names = names if names is not None else await _names(db, [row.get("deleted_by")])
    by = None
    if row.get("deleted_by"):
        u = names.get(row["deleted_by"]) or {}
        by = {"id": row["deleted_by"], "name": u.get("name") or u.get("email") or None,
              "is_you": row["deleted_by"] == actor.user_id}
    common = {"deleted_at": iso(row.get("deleted_at")), "deleted_by": by, "via": row.get("via"),
              "restore_until": iso(restore_until(row)), "days_left": days_left(row),
              "can": {"restore": role is not None, "delete_forever": role is not None}}
    if is_folder(row):
        f = row.get("folder") or {}
        batch_docs = await db[COLL].count_documents({"batch": row.get("batch"), "type": {"$ne": FOLDER}})
        batch_folders = await db[COLL].count_documents({"batch": row.get("batch"), "type": FOLDER})
        parent = None
        if f.get("parent_id"):
            parent = await _folder_ref(db, f["parent_id"], None, {"folder": was.get("folder")})
        return {
            "key": str(row["_id"]), "id": str(row["_id"]), "slug": None, "title": f.get("name"), "kind": FOLDER,
            "type_label": None, "encrypted": False, "url": None, "hidden": False,
            "where": {"workspace": await _ws_ref(db, row.get("workspace_id"), was), "folder": parent, "parent": None},
            "sub_pages": 0, "contents": {"items": batch_docs, "folders": max(0, batch_folders - 1)},
            "is_mine": False, **common,
        }
    doc = row.get("doc") or {}
    parent = None
    if doc.get("parent_id"):
        p = await db["documents"].find_one({"_id": access.as_oid(doc["parent_id"])},
                                           {"slug": 1, "title": 1, "encrypted": 1})
        if p is not None:
            parent = {"slug": p.get("slug"), "title": None if p.get("encrypted") else p.get("title"), "exists": True}
        elif was.get("parent"):
            parent = {**was["parent"], "exists": False}
        else:
            parent = {"slug": None, "title": None, "exists": False}
    if row.get("unit") is not None:
        subs = await db[COLL].count_documents({"batch": row.get("batch"), "unit": row.get("unit"),
                                               "_id": {"$ne": row["_id"]}})
    else:
        subs = await db[COLL].count_documents({"batch": row.get("batch"), "_id": {"$ne": row["_id"]}})
    title = display_title(doc)
    hidden = False
    if role == "admin" and title:
        # An admin may restore what was deleted from their workspace, but a title
        # they couldn't read stays hidden.
        if not (await access.can(actor, doc, "read", ctx or access.Ctx(db))).allowed:
            title, hidden = None, True
    deleted_with = None
    if row.get("unit") is not None:
        froot = await db[COLL].find_one({"_id": access.as_oid(row.get("batch")), "type": FOLDER}, {"folder.name": 1})
        if froot is not None:
            deleted_with = {"folder": (froot.get("folder") or {}).get("name"), "key": row.get("batch")}
    return {
        "key": doc.get("slug"), "id": None, "slug": doc.get("slug"), "title": title, "kind": kind_of(doc),
        "type_label": art_service.label_for(doc.get("mime") or "") if doc.get("kind") == "artifact" else None,
        "encrypted": bool(doc.get("encrypted")), "url": public_url(doc.get("slug")), "hidden": hidden,
        "where": {"workspace": await _ws_ref(db, doc.get("workspace_id"), was),
                  "folder": await _folder_ref(db, doc.get("folder_id"), doc.get("folder_path"), was),
                  "parent": parent},
        "sub_pages": subs, "contents": None, "deleted_with": deleted_with,
        "is_mine": bool(actor.user_id) and doc.get("owner_id") == actor.user_id, **common,
    }


async def list_for(db: AsyncIOMotorDatabase, actor: access.Actor, *, workspace_id: str | None = None,
                   limit: int = 500) -> list[dict]:
    """What this person may restore: their own items, and everything deleted
    from a workspace they administer (folders included). Newest first; one row
    per batch (a folder with its contents is one row for its admins; its other
    members see their own items from it)."""
    from app.services import workspace as ws_service

    uid = actor.user_id
    if not uid or actor.cred == "tenant":
        return []
    admin_of = [ws.id for ws, role in await ws_service.list_for_user(db, uid) if role in ("owner", "admin")]
    if workspace_id:
        if await ws_service.role_for(db, workspace_id, uid) is None:
            raise HTTPException(status_code=404, detail="Workspace not found")
        mine: dict = {"workspace_id": workspace_id, "owner_id": uid}
        admin_q: list[dict] = [{"workspace_id": workspace_id}] if workspace_id in admin_of else []
    else:
        mine = {"owner_id": uid}
        admin_q = [{"workspace_id": {"$in": admin_of}}] if admin_of else []
    query = {"$or": [{**mine, "root": True}, *[{**q, "root": True} for q in admin_q],
                     # Their own items from a folder someone deleted (where they aren't an admin).
                     {**mine, "unit_top": True, "workspace_id": {"$nin": admin_of}}
                     if not workspace_id else {**mine, "unit_top": True}]}
    rows = await db[COLL].find(query).sort("deleted_at", -1).to_list(length=limit)
    names = await _names(db, [r.get("deleted_by") for r in rows])
    ctx = access.Ctx(db)
    out = []
    for r in rows:
        if r.get("unit_top") and r.get("workspace_id") in admin_of:
            continue  # its admins see the folder
        role = await manage_role(actor, r, ctx)
        if role is None:
            continue
        out.append(await describe(db, r, actor, role, names=names, ctx=ctx))
    return out


async def notice(db: AsyncIOMotorDatabase, actor: access.Actor, slug: str) -> dict:
    """For the link of a trashed item: what it was and whether this person can
    restore it — only to someone who could edit it (404 for anyone else, the
    same as a missing document)."""
    row = await db[COLL].find_one({"slug": slug}) or await db[COLL].find_one({"old_slugs": slug})
    ctx = access.Ctx(db)
    if row is None or not await could_edit(actor, row, ctx):
        raise HTTPException(status_code=404, detail="Document not found")
    try:
        root, _rows, _scope_kind = await _scope(db, actor, row["slug"], ctx)
        role = await manage_role(actor, root, ctx) or await manage_role(actor, row, ctx)
    except HTTPException:
        root, role = await _root_of(db, row), None
    out = await describe(db, row, actor, role, ctx=ctx)
    if root["_id"] != row["_id"]:
        if is_folder(root):
            out["deleted_with"] = {"folder": (root.get("folder") or {}).get("name"), "key": str(root["_id"])}
        else:
            out["deleted_with"] = {"slug": root.get("slug"), "title": (await describe(db, root, actor, role, ctx=ctx))["title"],
                                   "key": root.get("slug")}
    return out


# ── Restore ───────────────────────────────────────────────────────────────────


async def _place(db: AsyncIOMotorDatabase, doc: dict, notes: list[str], *, in_batch: set[str]) -> dict:
    """Where a restored row goes: back where it was when that still exists."""
    from app.services import folder as folder_service
    from app.services import lifecycle, pages
    from app.services import workspace as ws_service

    pid = doc.get("parent_id")
    if pid is not None:
        parent = await db["documents"].find_one({"_id": access.as_oid(pid)}, {"content": 0})
        if parent is not None:
            # Under its page again: placement (and inherited access) follow it.
            for k in pages._PLACEMENT:
                doc[k] = list(parent.get(k) or []) if k == "folder_path" else parent.get(k)
            doc["page_path"] = [*(parent.get("page_path") or []), parent["slug"]]
            if access.inherits(doc):
                doc["access_level"] = parent.get("access_level") or "link"
                doc["read_password_hash"] = parent.get("read_password_hash")
            return doc
        # The page it was in is gone: top level, with the access it had as its own.
        doc["parent_id"] = None
        doc["page_path"] = []
        if doc.get("access_inherit") is not None:
            doc["access_inherit"] = None
        if str(pid) not in in_batch:
            notes.append("The page it was inside is gone, so it's back at the top level.")
    ws_id = doc.get("workspace_id")
    if ws_id:
        ws = await ws_service.get_workspace(db, ws_id)
        if ws is None or ws.deleting:
            level = lifecycle.level_after_leaving(doc, True)
            if level != (doc.get("access_level") or "link"):
                doc["access_epoch"] = publicity.epoch_of(doc) + 1
            doc.update(workspace_id=None, folder_id=None, folder_path=[], access_level=level)
            await db["document_grants"].delete_many({"document_id": str(doc["_id"]), "granted_via": ws_id})
            notes.append("Its workspace was deleted, so it's back in your own files"
                         + (" and only people added can open it." if level == "private" else "."))
            return doc
        fid = doc.get("folder_id")
        if fid:
            exists = await db["folders"].find_one({"_id": access.as_oid(fid), "workspace_id": ws_id}, {"_id": 1})
            if exists is None:
                trashed = await db[COLL].find_one({"_id": access.as_oid(fid), "type": FOLDER}, {"_id": 1})
                doc["folder_id"], doc["folder_path"] = None, []
                notes.append("Its folder is in the trash, so it's at the top of the workspace." if trashed
                             else "Its folder was deleted, so it's at the top of the workspace.")
            else:
                try:
                    doc["folder_path"] = await folder_service.path_of(db, ws_id, fid)
                except HTTPException:
                    doc["folder_id"], doc["folder_path"] = None, []
        if doc.get("parent_id") is None and await folder_service.folder_slug_taken(
                db, ws_id, doc.get("folder_id"), doc.get("slug")):
            # A folder took its address there meanwhile (B5): the top of the workspace.
            if doc.get("folder_id"):
                doc["folder_id"], doc["folder_path"] = None, []
                notes.append("A folder there now has its address, so it's at the top of the workspace.")
    return doc


async def _restore_docs(db: AsyncIOMotorDatabase, rows: list[dict], notes: list[str]) -> list[dict]:
    from app.services import lifecycle, page_links, pages

    in_batch = {str(r["_id"]) for r in rows}
    restored: list[dict] = []
    for r in rows:
        doc = dict(r["doc"])
        if publicity.is_expired(doc):
            continue  # its own expiry passed: the purge takes it
        doc = await _place(db, doc, notes, in_batch=in_batch)
        doc["access_dirty"] = True  # bytes, images and caches re-derived below
        try:
            await db["documents"].insert_one(doc)
        except DuplicateKeyError:
            if await db["documents"].find_one({"_id": doc["_id"]}, {"_id": 1}):
                await db[COLL].delete_one({"_id": r["_id"]})  # restored already
                continue
            raise HTTPException(status_code=409, detail="Another document has its address now, so it can't be "
                                                        "restored.")
        await db[COLL].delete_one({"_id": r["_id"]})
        restored.append(doc)
    for doc in restored:
        try:
            await access.settle_document_grants(db, str(doc["_id"]))
            await lifecycle.reconcile_document(db, doc)
        except Exception:  # left dirty: the reconciler finishes it
            log.warning("re-deriving %s after a restore failed", doc.get("slug"), exc_info=True)
        await page_links.reindex(db, doc)
        try:
            await revalidate.purge_doc(db, doc, extra_slugs=doc.get("old_slugs") or [])
        except Exception:  # pragma: no cover
            log.warning("purging %s after a restore failed", doc.get("slug"), exc_info=True)
        live.publish(doc.get("slug"), int(doc.get("rev") or 1))
    for doc in restored:
        if doc.get("parent_id") is None or str(doc.get("parent_id")) not in in_batch:
            await pages.refresh_page_paths(db, doc)
    return restored


async def _restore_folders(db: AsyncIOMotorDatabase, root: dict, frows: list[dict], notes: list[str]) -> str | None:
    """Put a folder batch's folders back (root first). Returns the root's id,
    or None when its workspace is gone (the items then go to their owners'
    own files)."""
    from app.services import folder as folder_service
    from app.services import workspace as ws_service

    ws_id = root.get("workspace_id")
    ws = await ws_service.get_workspace(db, ws_id) if ws_id else None
    if ws is None or ws.deleting:
        await db[COLL].delete_many({"_id": {"$in": [r["_id"] for r in frows]}})
        return None
    await folder_service._lock(db, ws_id, await folder_service.folders_rev(db, ws_id))
    for r in frows:
        f = dict(r["folder"])
        if r["_id"] == root["_id"]:
            parent = f.get("parent_id")
            if parent and not await db["folders"].find_one({"_id": access.as_oid(parent), "workspace_id": ws_id},
                                                           {"_id": 1}):
                f["parent_id"] = parent = None
                notes.append("The folder it was in is gone, so it's back at the top of the workspace.")
            base, n = f.get("slug") or str(f["_id"]), 1
            candidate = base
            while await folder_service.folder_slug_taken(db, ws_id, parent, candidate, exclude_id=f["_id"]) or \
                    await folder_service.doc_slug_taken(db, ws_id, parent, candidate):
                n += 1
                candidate = f"{base}-{n}"
                if n > 200:
                    candidate = str(f["_id"])
                    break
            if candidate != f.get("slug"):
                f["slug"] = candidate
                notes.append(f"Something else there has its old address now, so its address is /{candidate}.")
        try:
            await db["folders"].insert_one(f)
        except DuplicateKeyError:
            pass  # restored already
        await db[COLL].delete_one({"_id": r["_id"]})
    return str(root["_id"])


async def restore(db: AsyncIOMotorDatabase, actor: access.Actor, key: str) -> dict:
    """Put a trashed item back: a document with the sub-pages deleted with it,
    or a folder with its folders and items. Returns ``{key, kind, slug,
    restored: [{slug, title, kind}], folders, notes, row}``."""
    from app.services import folder as folder_service
    from app.services import pages

    ctx = access.Ctx(db)
    root, rows, scope = await _scope(db, actor, key, ctx)
    notes: list[str] = []
    if is_folder(root) and scope == "batch":
        frows = [r for r in rows if is_folder(r)]
        drows = sorted([r for r in rows if not is_folder(r)], key=lambda r: int(r.get("depth") or 0))
        fid = await _restore_folders(db, root, frows, notes)
        if fid is None:
            notes.append("Its workspace was deleted, so the folder is gone; its items are back in their owners' "
                         "own files.")
        restored = await _restore_docs(db, drows, notes)
        if fid is not None:
            ws_id = root["workspace_id"]
            slugs = await folder_service._reindex_subtree(db, ws_id, fid)
            await folder_service._purge(db, ws_id, slugs)
        return {"key": str(root["_id"]), "kind": FOLDER, "slug": None, "title": (root.get("folder") or {}).get("name"),
                "restored": [pages.deleted_item(d) for d in restored], "folders": len(frows) if fid else 0,
                "notes": list(dict.fromkeys(notes)), "row": None}
    if publicity.is_expired(root.get("doc") or {}):
        raise HTTPException(status_code=410, detail="It reached its own expiry date while in the trash, so it "
                                                    "can't be restored.")
    restored = await _restore_docs(db, rows, notes)
    return {"key": root.get("slug"), "kind": kind_of(root), "slug": root.get("slug"),
            "title": (pages.deleted_item(root["doc"]) or {}).get("title"),
            "restored": [pages.deleted_item(d) for d in restored], "folders": 0,
            "notes": list(dict.fromkeys(notes)), "row": restored[0] if restored else None}


# ── Deleting forever ──────────────────────────────────────────────────────────


async def destroy_batch(db: AsyncIOMotorDatabase, rows: list[dict], *, reason: str) -> list[dict]:
    """``lifecycle.destroy`` every document row, deepest first; folder rows
    are dropped. Returns the documents that went."""
    from app.services import lifecycle, pages

    gone: list[dict] = []
    for r in sorted(rows, key=lambda r: -int(r.get("depth") or 0)):
        if is_folder(r):
            await db[COLL].delete_one({"_id": r["_id"]})
            continue
        try:
            if await lifecycle.destroy(db, r["doc"], reason=reason, trashed=True):
                gone.append(pages.deleted_item(r["doc"]))
        except Exception:
            log.warning("destroying trashed %s failed", r.get("slug"), exc_info=True)
    return gone


async def delete_forever(db: AsyncIOMotorDatabase, actor: access.Actor, key: str) -> list[dict]:
    """"Delete forever" from the trash: the item and its batch (an item's
    owner who isn't an admin: their item from a deleted folder)."""
    ctx = access.Ctx(db)
    _root, rows, _scope_kind = await _scope(db, actor, key, ctx)
    if actor.cred == "mcp" and access.MCP_WRITE not in actor.scopes:
        raise HTTPException(status_code=403, detail="insufficient_scope")
    return await destroy_batch(db, rows, reason="delete forever")


async def purge_due(db: AsyncIOMotorDatabase, *, limit: int = 500) -> int:
    """The background job: destroy what has been in the trash 30 days (or
    reached its own expiry). A row whose document is live again (a move that
    died half way) is dropped, never destroyed. Returns the documents destroyed."""
    now = _now()
    rows = await db[COLL].find({"$or": [{"purge_at": {"$lte": now}},
                                        {"doc.expires_at": {"$ne": None, "$lte": now}}]}).limit(limit).to_list(length=limit)
    batches: dict[str, list[dict]] = {}
    for r in rows:
        batches.setdefault(str(r.get("batch")), []).append(r)
    n = 0
    async with revalidate.batch(db):
        for group in batches.values():
            n += len(await destroy_batch(db, group, reason="trash purge"))
    return n
