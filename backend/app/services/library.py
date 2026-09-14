"""The shared workspace library — documents and artifacts a team can see.

The boundary this module draws is the important part, so it is worth stating
plainly: **a document is private until its owner puts it in a workspace.**

Markdrop's whole history is personal documents, and people are using it that way
right now. Joining a workspace must not retroactively expose a single thing they
wrote. So sharing is opt-in, per document, by the person who owns it — and the
query that lists a workspace's library filters on `workspace_id`, which a private
document simply does not have. There is no filter to get wrong and no flag to
forget: a private document cannot appear in a shared list because it does not
match the query that produces one.

What sharing *does* mean is not softened anywhere in the product: everyone in the
workspace can read it, and members and admins can edit it. That is the trade, and
the UI says so before the click.

Ownership never moves. `owner_id` still points at the person who created it, so
the document stays in their own library, they can always delete it, and removing
it from the workspace hands it straight back.
"""

from datetime import datetime, timezone

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.models.document import Document
from app.models.user import User
from app.services import workspace as ws_service
from app.services.document import _doc_from_mongo


async def _load(db: AsyncIOMotorDatabase, document_id: str) -> dict:
    try:
        oid = ObjectId(document_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Document not found")
    raw = await db["documents"].find_one({"_id": oid})
    if not raw:
        raise HTTPException(status_code=404, detail="Document not found")
    return raw


async def list_documents(
    db: AsyncIOMotorDatabase,
    workspace_id: str,
    page: int,
    limit: int,
    q: str | None = None,
    kind: str | None = None,
    folder_id: str | None = None,
    unfiled: bool = False,
) -> tuple[list[Document], int]:
    """Everything shared into this workspace, newest first.

    `workspace_id` is matched exactly, so nothing private can be returned even if
    every other argument is hostile. The caller is responsible for having checked
    the reader's role first.
    """
    query: dict = {"workspace_id": workspace_id}
    if kind == "markdown":
        query["kind"] = {"$ne": "artifact"}
    elif kind == "artifact":
        query["kind"] = "artifact"
    if unfiled:
        query["folder_id"] = None
    elif folder_id:
        query["folder_id"] = folder_id
    if q:
        query["$or"] = [
            {"slug": {"$regex": q, "$options": "i"}},
            {"title": {"$regex": q, "$options": "i"}},
        ]

    total = await db["documents"].count_documents(query)
    cursor = (
        db["documents"]
        .find(query)
        .sort("updated_at", -1)
        .skip((page - 1) * limit)
        .limit(limit)
    )
    return [_doc_from_mongo(d) for d in await cursor.to_list(length=limit)], total


async def add_document(
    db: AsyncIOMotorDatabase,
    workspace_id: str,
    document_id: str,
    user: User,
    folder_id: str | None = None,
) -> Document:
    """Share a document into a workspace.

    Only its owner may do this, even if the caller is the workspace owner. The
    decision to expose a document belongs to the person whose document it is —
    an admin being able to reach into someone's private library and publish from
    it would defeat the entire boundary this module exists to hold.
    """
    raw = await _load(db, document_id)
    if raw.get("owner_id") != user.id:
        # 404 rather than 403: confirming that a document id exists is itself a
        # disclosure to someone who has no relationship with it.
        raise HTTPException(status_code=404, detail="Document not found")

    # The sharer must be in the workspace, and at member level -- a viewer is
    # someone who reads the library, not someone who fills it.
    await ws_service.require_role(db, workspace_id, user.id, "member")

    existing = raw.get("workspace_id")
    if existing and existing != workspace_id:
        raise HTTPException(
            status_code=409,
            detail="This document is already in another workspace. Remove it from that one first.",
        )

    if folder_id:
        await _require_folder(db, workspace_id, folder_id)

    # `folder_path` is the denormalised copy the read path serves URLs from —
    # see `services.folder._reindex_subtree`. Every write of `folder_id`
    # anywhere must set it too, or a document answers on a stale address.
    from app.services import folder as folder_service

    path = await folder_service.path_of(db, workspace_id, folder_id) if folder_id else []
    await db["documents"].update_one(
        {"_id": raw["_id"]},
        {"$set": {
            "workspace_id": workspace_id,
            "folder_id": folder_id,
            "folder_path": path,
            "updated_at": datetime.now(timezone.utc),
        }},
    )
    raw["workspace_id"] = workspace_id
    raw["folder_id"] = folder_id
    raw["folder_path"] = path
    return _doc_from_mongo(raw)


async def remove_document(
    db: AsyncIOMotorDatabase, workspace_id: str, document_id: str, user: User
) -> None:
    """Take a document back out of the shared library.

    Either the owner (it was always theirs) or a workspace admin (tidying up, or
    removing something that shouldn't be there). The document itself is
    untouched — it returns to the owner's private library with its slug, its
    links and its analytics intact. This is unsharing, not deleting.
    """
    raw = await _load(db, document_id)
    if raw.get("workspace_id") != workspace_id:
        raise HTTPException(status_code=404, detail="That document isn't in this workspace.")

    if raw.get("owner_id") != user.id:
        await ws_service.require_role(db, workspace_id, user.id, "admin")
    else:
        await ws_service.require_role(db, workspace_id, user.id, "viewer")

    await db["documents"].update_one(
        {"_id": raw["_id"]},
        {"$set": {"workspace_id": None, "folder_id": None, "folder_path": [],
                  "updated_at": datetime.now(timezone.utc)}},
    )


async def _require_folder(db: AsyncIOMotorDatabase, workspace_id: str, folder_id: str) -> None:
    """A folder must belong to this workspace. Scoped in the query itself, so a
    folder id borrowed from another tenant simply does not resolve."""
    try:
        oid = ObjectId(folder_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Folder not found")
    found = await db["folders"].find_one({"_id": oid, "workspace_id": workspace_id}, {"_id": 1})
    if not found:
        raise HTTPException(status_code=404, detail="Folder not found")


async def set_folder(
    db: AsyncIOMotorDatabase,
    workspace_id: str,
    document_id: str,
    folder_id: str | None,
    user: User,
) -> None:
    """File a shared document into a folder, or out of one with None.

    Member-level, like editing: filing is housekeeping on a document the
    workspace already shares, and it changes nothing about who can read it.
    """
    raw = await _load(db, document_id)
    if raw.get("workspace_id") != workspace_id:
        raise HTTPException(status_code=404, detail="That document isn't in this workspace.")
    await ws_service.require_role(db, workspace_id, user.id, "member")
    if folder_id:
        await _require_folder(db, workspace_id, folder_id)
    from app.services import folder as folder_service

    path = await folder_service.path_of(db, workspace_id, folder_id) if folder_id else []
    await db["documents"].update_one(
        {"_id": raw["_id"]},
        {"$set": {"folder_id": folder_id, "folder_path": path,
                  "updated_at": datetime.now(timezone.utc)}},
    )


async def counts_by_folder(db: AsyncIOMotorDatabase, workspace_id: str) -> dict[str, int]:
    """How many shared documents sit in each folder, for the sidebar."""
    pipeline = [
        {"$match": {"workspace_id": workspace_id}},
        {"$group": {"_id": "$folder_id", "n": {"$sum": 1}}},
    ]
    rows = await db["documents"].aggregate(pipeline).to_list(length=500)
    return {(r["_id"] or "unfiled"): r["n"] for r in rows}
