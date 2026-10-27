"""The shared workspace library — documents and artifacts a team can see.

**A document is private to its owner's account until its owner files it in a
workspace**, and filing never changes who can read it on its own: the
document's one access level (D1) decides, on markdrop.in and on every domain of
its workspace alike. What membership adds is a *role* on non-private filed
documents (members edit, viewers read); a private filed document stays the
owner's and their named people's.

Every listing here is filtered per caller through ``access.readable_filter`` —
search, kind and folder filters are applied *inside* it, so totals and counts
never include a row the caller can't read (A1).

Ownership never moves. Filing is the owner's act (an admin can never pull
someone else's document in); unfiling is the owner's — always, even after
leaving — or a workspace admin's (D4), and leaving never widens (I8).
"""

from datetime import datetime, timezone

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.models.document import Document
from app.models.user import User
from app.services import access, publicity
from app.services.document import _doc_from_mongo, search_clause


def kind_clause(kind: str | None) -> dict | None:
    if kind in ("markdown", "document"):
        return {"kind": {"$ne": "artifact"}}
    if kind == "artifact":
        return {"kind": "artifact"}
    return None


def search_filter(q: str | None) -> dict | None:
    clause = search_clause(q)
    return {"$or": clause} if clause else None


async def _load(db: AsyncIOMotorDatabase, document_id: str) -> dict | None:
    try:
        oid = ObjectId(document_id)
    except Exception:
        return None
    return await db["documents"].find_one({"_id": oid})


async def list_documents(
    db: AsyncIOMotorDatabase,
    actor: access.Actor,
    ctx: access.Ctx,
    workspace_id: str,
    page: int,
    limit: int,
    q: str | None = None,
    kind: str | None = None,
    folder_id: str | None = None,
    unfiled: bool = False,
) -> tuple[list[Document], int]:
    """The rows of this workspace the caller can read, newest edit first."""
    rf = await access.readable_filter(actor, workspace_id, ctx)
    extra = [kind_clause(kind), search_filter(q)]
    if unfiled:
        extra.append({"folder_id": None})
    elif folder_id:
        extra.append({"folder_id": folder_id})
    query = rf.query(*extra)
    total = await db["documents"].count_documents(query)
    cursor = (
        db["documents"]
        .find(query)
        .sort("updated_at", -1)
        .skip((page - 1) * limit)
        .limit(limit)
    )
    return [_doc_from_mongo(d) for d in await cursor.to_list(length=limit)], total


async def counts_by_folder(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx,
                           workspace_id: str) -> dict[str, int]:
    """How many documents the caller can read sit directly in each folder."""
    rf = await access.readable_filter(actor, workspace_id, ctx)
    rows = await db["documents"].find(rf.query(), {"folder_id": 1}).to_list(length=50_000)
    out: dict[str, int] = {}
    for r in rows:
        key = r.get("folder_id") or "unfiled"
        out[key] = out.get(key, 0) + 1
    return out


async def add_document(
    db: AsyncIOMotorDatabase,
    workspace_id: str,
    document_id: str,
    user: User,
    folder_id: str | None = None,
    level: str | None = None,
) -> Document:
    """D1: file the caller's own document into a workspace (member+ there).

    CAS on ``{_id, owner_id, workspace_id ∈ {null, W}}``; resharing switches off
    (A2); the level only changes when ``level`` is given. Filing a link
    document into a sign-in-required workspace guards its bytes (epoch bump).
    """
    from app.services import folder as folder_service
    from app.services import lifecycle, transitions

    actor = access.Actor.of(user)
    ctx = access.Ctx(db, target_workspace=workspace_id)
    raw = await _load(db, document_id)
    await access.require(actor, raw, "file_into_workspace", ctx)
    f = await access.facts(actor, raw, ctx)
    existing = f.ws_id  # dangling refs count as unfiled
    if existing and existing != workspace_id:
        raise HTTPException(
            status_code=409,
            detail="This document is already in another workspace. Remove it from that one first.",
        )
    if level is not None and level not in access.LEVEL_RANK:
        raise HTTPException(status_code=422, detail="Unknown access level.")

    if folder_id:
        await folder_service._get_owned(db, workspace_id, folder_id)
    path = await folder_service.path_of(db, workspace_id, folder_id) if folder_id else []
    ws = await ctx.workspace(workspace_id)
    require_auth = bool(ws is not None and ws.settings.require_auth_to_view)

    current = raw.get("access_level") or "link"
    new_level = level or current
    sets = {"workspace_id": workspace_id, "folder_id": folder_id or None, "folder_path": path,
            "allow_resharing": False, "updated_at": datetime.now(timezone.utc),
            "access_level": new_level}
    narrows = (access.LEVEL_RANK[new_level] < access.LEVEL_RANK[current]
               or (require_auth and new_level == "link" and existing != workspace_id))
    after = await transitions.change(
        db, raw, sets=sets, cas={"owner_id": user.id, "workspace_id": raw.get("workspace_id")},
        narrows=narrows, require_auth_after=require_auth,
    )
    # W4: the workspace may have been deleted while we wrote. A dangling row is
    # treated as unfiled everywhere; release it now rather than wait.
    if await ctx.workspace(workspace_id) is None or not await db["workspaces"].find_one(
            {"_id": ObjectId(workspace_id)}, {"_id": 1}):
        after = await lifecycle.release_from_workspace(db, after, workspace_id, require_auth=require_auth)
        raise HTTPException(status_code=404, detail="Workspace not found")
    return _doc_from_mongo(after)


async def remove_document(
    db: AsyncIOMotorDatabase, workspace_id: str, document_id: str, user: User
) -> dict:
    """D2: unshare. The owner always may (even after leaving, D4); a workspace
    admin may (even a private document they can't read — the redacted row).
    The level converts so leaving never widens: ``workspace`` ⇒ ``private``,
    and a link document leaving a sign-in workspace ⇒ ``private`` (Q2)."""
    raw = await _load(db, document_id)
    return await remove_raw(db, workspace_id, raw, user)


async def remove_raw(db: AsyncIOMotorDatabase, workspace_id: str, raw: dict | None,
                     user: User) -> dict:
    from app.services import lifecycle

    if raw is None or raw.get("workspace_id") != workspace_id or publicity.is_expired(raw):
        raise HTTPException(status_code=404, detail="That document isn't in this workspace.")
    actor = access.Actor.of(user)
    d = await access.can(actor, raw, "unshare", access.Ctx(db))
    if not d.allowed:
        if d.status in (401, 404):
            raise HTTPException(status_code=404, detail="That document isn't in this workspace.")
        raise d.exception()
    after = await lifecycle.release_from_workspace(db, raw, workspace_id)
    return {"slug": after["slug"], "access_after": after.get("access_level") or "link"}


async def set_folder(
    db: AsyncIOMotorDatabase,
    workspace_id: str,
    document_id: str,
    folder_id: str | None,
    user: User,
) -> None:
    """Refile (D3): can(move_in_workspace) — read + member+."""
    from app.services import folder as folder_service

    raw = await _load(db, document_id)
    if raw is None or raw.get("workspace_id") != workspace_id:
        raise HTTPException(status_code=404, detail="That document isn't in this workspace.")
    d = await access.can(access.Actor.of(user), raw, "move_in_workspace", access.Ctx(db))
    if not d.allowed:
        if d.status in (401, 404):
            raise HTTPException(status_code=404, detail="That document isn't in this workspace.")
        raise d.exception()
    await folder_service.file_document(db, raw, workspace_id, folder_id)
