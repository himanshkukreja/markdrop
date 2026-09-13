"""Folders — filing for a workspace's documents.

Deliberately not an access-control boundary. A folder changes where a document
appears in a list and nothing else; read access still comes from the document's
own password, expiry and workspace. Anything else would mean two systems
deciding who can read a document, and the quieter one winning by accident.
"""

from datetime import datetime, timezone

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.models.folder import Folder

MAX_FOLDERS_PER_WORKSPACE = 500
MAX_DEPTH = 5
MAX_NAME = 80


def _to_folder(raw: dict) -> Folder:
    return Folder(
        id=str(raw["_id"]),
        workspace_id=raw["workspace_id"],
        name=raw["name"],
        parent_id=raw.get("parent_id"),
        created_at=raw["created_at"],
        updated_at=raw["updated_at"],
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

    await db["folders"].update_one({"_id": raw["_id"]}, {"$set": updates})
    raw.update(updates)
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
        {"workspace_id": workspace_id, "folder_id": fid}, {"$unset": {"folder_id": ""}}
    )
    await db["folders"].delete_one({"_id": raw["_id"]})
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

    result = await db["documents"].update_one(
        {"slug": slug, "workspace_id": workspace_id},
        {"$set": {"folder_id": folder_id}} if folder_id else {"$unset": {"folder_id": ""}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Document not found in this workspace")
