"""Folders — filing for a workspace's documents, and the path in their URLs.

A document filed under Data/Reports is served at ``/data/reports/<slug>`` on the
workspace's own domain. Each folder therefore carries a `slug` as well as a
display name.

Still deliberately **not** an access-control boundary. A folder decides where a
document appears and what its address is; read access still comes from the
document's own password, expiry and workspace. Anything else would mean two
systems deciding who can read a document, and the quieter one winning by
accident.

Two rules keep folder slugs safe to put in a path:

* Siblings must differ. Two folders called "Reports" under the same parent would
  produce the same URL, and the loser would be unreachable.
* A top-level slug may not be a reserved word. ``/settings/<doc>`` on a host
  that also serves the app would shadow a real route, and the folder would win
  or lose depending on routing order rather than on anything anyone intended.
"""

from datetime import datetime, timezone

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.models.folder import Folder
from app.utils.slug import is_reserved_slug, slugify

MAX_FOLDERS_PER_WORKSPACE = 500
# Deep enough for any filing anyone actually does, bounded because every level
# is another segment every URL carries and another hop every path walk makes.
MAX_DEPTH = 8
MAX_NAME = 80
MAX_SLUG = 40


def _to_folder(raw: dict) -> Folder:
    return Folder(
        id=str(raw["_id"]),
        workspace_id=raw["workspace_id"],
        name=raw["name"],
        parent_id=raw.get("parent_id"),
        created_at=raw["created_at"],
        updated_at=raw["updated_at"],
        # Folders predating slugs fall back to their id, which is unique and
        # ugly rather than absent — a missing segment would break a path.
        slug=raw.get("slug") or str(raw["_id"]),
    )


def _oid(value: str, what: str = "Folder") -> ObjectId:
    try:
        return ObjectId(value)
    except Exception:
        raise HTTPException(status_code=404, detail=f"{what} not found")


def _clean_name(name: str) -> str:
    name = (name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="Give the folder a name.")
    if len(name) > MAX_NAME:
        raise HTTPException(status_code=422, detail=f"Folder names are limited to {MAX_NAME} characters.")
    # Control characters would corrupt any list they're rendered into.
    if any(ord(c) < 32 for c in name):
        raise HTTPException(status_code=422, detail="Folder names can't contain control characters.")
    return name


async def _unique_slug(
    db: AsyncIOMotorDatabase,
    workspace_id: str,
    name: str,
    parent_id: str | None,
    exclude_id: ObjectId | None = None,
) -> str:
    """A URL-safe segment for this folder, unique among its siblings.

    Reserved words are refused outright at the top level rather than quietly
    suffixed: someone naming a folder "settings" should be told why it can't be
    that, not handed a folder silently called "settings-2".
    """
    base = slugify(name)[:MAX_SLUG].strip("-") or "folder"
    if parent_id is None and is_reserved_slug(base):
        raise HTTPException(
            status_code=422,
            detail=f"“{name}” can't be a top-level folder name — it clashes with a Markdrop URL.",
        )

    candidate, n = base, 1
    while True:
        query: dict = {
            "workspace_id": workspace_id,
            "parent_id": parent_id or None,
            "slug": candidate,
        }
        if exclude_id is not None:
            query["_id"] = {"$ne": exclude_id}
        if not await db["folders"].find_one(query, {"_id": 1}):
            return candidate
        n += 1
        candidate = f"{base}-{n}"
        if n > 200:  # pathological; stop rather than loop
            raise HTTPException(
                status_code=409, detail="Too many folders with a similar name."
            )


async def backfill_slugs(db: AsyncIOMotorDatabase) -> dict:
    """Give a slug to every folder created before slugs existed.

    Folders predate this feature, and `_to_folder` falls back to the ObjectId so
    a path always has a segment. That fallback keeps URLs *working*, but it makes
    them look like ``/6aa72082ae17a8a365f50a7b/video-test`` — which is not what
    anyone filed a folder called "Data" expecting to get.

    Idempotent, so it is safe to run on every start: it only touches folders with
    no slug, and only reindexes workspaces that actually changed.

    Unlike `_unique_slug`, a reserved top-level name is suffixed rather than
    refused. Refusing is right when someone is typing a name and can pick
    another; at startup there is nobody to tell, and failing would leave the
    folder with an ObjectId for a slug forever.
    """
    rows = await db["folders"].find(
        {"$or": [{"slug": {"$exists": False}}, {"slug": None}, {"slug": ""}]},
        {"name": 1, "workspace_id": 1, "parent_id": 1},
    ).to_list(length=10_000)
    if not rows:
        return {"folders": 0, "workspaces": 0}

    touched: set[str] = set()
    for raw in rows:
        workspace_id = raw["workspace_id"]
        parent_id = raw.get("parent_id")
        base = slugify(raw.get("name") or "")[:MAX_SLUG].strip("-") or "folder"
        if parent_id is None and is_reserved_slug(base):
            base = f"{base}-folder"

        candidate, n = base, 1
        while await db["folders"].find_one(
            {"workspace_id": workspace_id, "parent_id": parent_id,
             "slug": candidate, "_id": {"$ne": raw["_id"]}},
            {"_id": 1},
        ):
            n += 1
            candidate = f"{base}-{n}"
            if n > 200:
                candidate = str(raw["_id"])  # give up gracefully rather than spin
                break

        await db["folders"].update_one({"_id": raw["_id"]}, {"$set": {"slug": candidate}})
        touched.add(workspace_id)

    # Documents carry a denormalised copy of the path, so it has to be rewritten
    # too — otherwise the folders look right and the URLs stay wrong.
    for workspace_id in touched:
        for root in await db["folders"].find(
            {"workspace_id": workspace_id, "parent_id": None}, {"_id": 1}
        ).to_list(length=MAX_FOLDERS_PER_WORKSPACE):
            await _reindex_subtree(db, workspace_id, str(root["_id"]))

    return {"folders": len(rows), "workspaces": len(touched)}


async def path_of(db: AsyncIOMotorDatabase, workspace_id: str, folder_id: str | None) -> list[str]:
    """Folder slugs from the root down, e.g. ``["data", "reports"]``.

    Walks up and reverses. Bounded by MAX_DEPTH so a cycle that somehow reached
    the database cannot spin here — the same guard `_depth_of` uses, for the
    same reason.
    """
    out: list[str] = []
    cursor, hops = folder_id, 0
    while cursor and hops <= MAX_DEPTH + 1:
        raw = await db["folders"].find_one(
            {"_id": _oid(cursor), "workspace_id": workspace_id},
            {"parent_id": 1, "slug": 1},
        )
        if not raw:
            break
        out.append(raw.get("slug") or str(raw["_id"]))
        cursor = raw.get("parent_id")
        hops += 1
    return list(reversed(out))


async def resolve_path(
    db: AsyncIOMotorDatabase, workspace_id: str, segments: list[str]
) -> str | None:
    """The folder id at the end of a slug path, or None if it doesn't resolve.

    Walks down from the root one segment at a time, each step scoped to the
    workspace *and* the previous segment's id — so a path only resolves if every
    link in it really is where the URL claims.
    """
    parent: str | None = None
    for segment in segments:
        raw = await db["folders"].find_one(
            {"workspace_id": workspace_id, "parent_id": parent, "slug": segment},
            {"_id": 1},
        )
        if not raw:
            return None
        parent = str(raw["_id"])
    return parent


async def _get_owned(db: AsyncIOMotorDatabase, workspace_id: str, folder_id: str) -> dict:
    """Fetch a folder, scoped to the workspace.

    Scoped in the query rather than fetched-then-checked: a folder id from
    another workspace must be indistinguishable from one that doesn't exist, or
    the API confirms the existence of other tenants' folders.
    """
    raw = await db["folders"].find_one({"_id": _oid(folder_id), "workspace_id": workspace_id})
    if not raw:
        raise HTTPException(status_code=404, detail="Folder not found")
    return raw


async def _depth_of(db: AsyncIOMotorDatabase, workspace_id: str, folder_id: str | None) -> int:
    """How deep a folder sits. Walks up, bounded by MAX_DEPTH so a cycle that
    somehow reached the database can't spin here forever."""
    depth = 0
    cursor = folder_id
    while cursor and depth <= MAX_DEPTH + 1:
        raw = await db["folders"].find_one({"_id": _oid(cursor), "workspace_id": workspace_id}, {"parent_id": 1})
        if not raw:
            break
        cursor = raw.get("parent_id")
        depth += 1
    return depth


async def _reindex_subtree(db: AsyncIOMotorDatabase, workspace_id: str, root_id: str) -> None:
    """Rewrite `folder_path` on every document at or below this folder.

    The path is denormalised onto documents so a page view costs one query
    instead of walking up to MAX_DEPTH parents. That trade is only sound if the
    copy is maintained, so every folder rename, move and delete ends here.

    Breadth-first from the changed folder down: a rename at the root rewrites
    the whole subtree, and nothing below it keeps a stale prefix.
    """
    frontier = [(root_id, await path_of(db, workspace_id, root_id))]
    seen, hops = set(), 0
    while frontier and hops <= MAX_FOLDERS_PER_WORKSPACE:
        folder_id, path = frontier.pop()
        if folder_id in seen:
            continue
        seen.add(folder_id)
        hops += 1
        await db["documents"].update_many(
            {"workspace_id": workspace_id, "folder_id": folder_id},
            {"$set": {"folder_path": path}},
        )
        children = await db["folders"].find(
            {"workspace_id": workspace_id, "parent_id": folder_id}, {"slug": 1}
        ).to_list(length=MAX_FOLDERS_PER_WORKSPACE)
        for child in children:
            frontier.append((str(child["_id"]), path + [child.get("slug") or str(child["_id"])]))


async def list_folders(db: AsyncIOMotorDatabase, workspace_id: str) -> list[Folder]:
    rows = await db["folders"].find({"workspace_id": workspace_id}).to_list(length=MAX_FOLDERS_PER_WORKSPACE)
    rows.sort(key=lambda r: (r.get("parent_id") or "", r["name"].lower()))
    return [_to_folder(r) for r in rows]


async def create_folder(
    db: AsyncIOMotorDatabase, workspace_id: str, name: str, parent_id: str | None
) -> Folder:
    name = _clean_name(name)
    count = await db["folders"].count_documents({"workspace_id": workspace_id})
    if count >= MAX_FOLDERS_PER_WORKSPACE:
        raise HTTPException(status_code=429, detail="This workspace has reached its folder limit.")

    if parent_id:
        await _get_owned(db, workspace_id, parent_id)  # must exist, and be ours
        if await _depth_of(db, workspace_id, parent_id) >= MAX_DEPTH:
            raise HTTPException(status_code=422, detail=f"Folders can nest at most {MAX_DEPTH} deep.")

    now = datetime.now(timezone.utc)
    doc = {
        "workspace_id": workspace_id,
        "name": name,
        "slug": await _unique_slug(db, workspace_id, name, parent_id),
        "parent_id": parent_id or None,
        "created_at": now,
        "updated_at": now,
    }
    result = await db["folders"].insert_one(doc)
    doc["_id"] = result.inserted_id
    return _to_folder(doc)


async def update_folder(
    db: AsyncIOMotorDatabase,
    workspace_id: str,
    folder_id: str,
    *,
    name: str | None = None,
    parent_id: str | None = None,
    reparent: bool = False,
) -> Folder:
    raw = await _get_owned(db, workspace_id, folder_id)
    updates: dict = {"updated_at": datetime.now(timezone.utc)}

    if name is not None:
        updates["name"] = _clean_name(name)
        # Renaming changes the URL of everything filed here. That is the point --
        # the folder name *is* the path segment -- but it is worth knowing that
        # old links stop resolving, which is why the UI says so.
        updates["slug"] = await _unique_slug(
            db, workspace_id, updates["name"],
            parent_id if reparent else raw.get("parent_id"), exclude_id=raw["_id"],
        )

    if reparent:
        if parent_id:
            if parent_id == folder_id:
                raise HTTPException(status_code=422, detail="A folder can't contain itself.")
            await _get_owned(db, workspace_id, parent_id)
            # Walk up from the proposed parent: if we meet this folder, the move
            # would detach a whole subtree into a loop that no listing can render
            # and no walk can terminate on.
            cursor, hops = parent_id, 0
            while cursor and hops <= MAX_DEPTH + 1:
                if cursor == folder_id:
                    raise HTTPException(status_code=422, detail="That would put a folder inside itself.")
                node = await db["folders"].find_one(
                    {"_id": _oid(cursor), "workspace_id": workspace_id}, {"parent_id": 1}
                )
                if not node:
                    break
                cursor = node.get("parent_id")
                hops += 1
            if await _depth_of(db, workspace_id, parent_id) >= MAX_DEPTH:
                raise HTTPException(status_code=422, detail=f"Folders can nest at most {MAX_DEPTH} deep.")
        updates["parent_id"] = parent_id or None
        # The destination may already hold a sibling with this slug.
        updates["slug"] = await _unique_slug(
            db, workspace_id, updates.get("name", raw["name"]), parent_id or None,
            exclude_id=raw["_id"],
        )

    await db["folders"].update_one({"_id": raw["_id"]}, {"$set": updates})
    raw.update(updates)
    # A new slug or a new parent changes the URL of everything filed at or below
    # this folder. The denormalised copy has to follow, or those documents keep
    # answering on an address that no longer describes where they are.
    if "slug" in updates or "parent_id" in updates:
        await _reindex_subtree(db, workspace_id, folder_id)
    return _to_folder(raw)


async def delete_folder(db: AsyncIOMotorDatabase, workspace_id: str, folder_id: str) -> int:
    """Remove a folder. Documents inside are unfiled, never deleted.

    Returns how many documents were unfiled. Deleting a container must not
    delete its contents — the two are not the same request, and one of them is
    not reversible.
    """
    raw = await _get_owned(db, workspace_id, folder_id)
    fid = str(raw["_id"])

    # Children move up rather than being orphaned into an unreachable subtree.
    await db["folders"].update_many(
        {"workspace_id": workspace_id, "parent_id": fid},
        {"$set": {"parent_id": raw.get("parent_id")}},
    )
    result = await db["documents"].update_many(
        {"workspace_id": workspace_id, "folder_id": fid},
        {"$unset": {"folder_id": "", "folder_path": ""}},
    )
    await db["folders"].delete_one({"_id": raw["_id"]})
    # Promoted children sit one level higher now, so everything under them
    # answers on a shorter path.
    for child in await db["folders"].find(
        {"workspace_id": workspace_id, "parent_id": raw.get("parent_id")}, {"_id": 1}
    ).to_list(length=MAX_FOLDERS_PER_WORKSPACE):
        await _reindex_subtree(db, workspace_id, str(child["_id"]))
    return result.modified_count


async def move_document(
    db: AsyncIOMotorDatabase, workspace_id: str, slug: str, folder_id: str | None
) -> None:
    """File a document. Both sides are checked against the workspace.

    The document query is scoped too: without it, a member of workspace A could
    file workspace B's document into their own tree simply by knowing its slug —
    which would also hand them its title in every listing afterwards.
    """
    if folder_id:
        await _get_owned(db, workspace_id, folder_id)

    update = (
        {"$set": {"folder_id": folder_id,
                  "folder_path": await path_of(db, workspace_id, folder_id)}}
        if folder_id
        else {"$unset": {"folder_id": "", "folder_path": ""}}
    )
    result = await db["documents"].update_one(
        {"slug": slug, "workspace_id": workspace_id}, update
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Document not found in this workspace")
