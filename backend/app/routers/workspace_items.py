"""Workspace folder views and batch filing (workspaces v2 contracts).

    GET    /api/v1/workspaces/{id}/tree
    GET    /api/v1/workspaces/{id}/items?folder=<id|root|unfiled|all>&q=&kind=&cursor=&limit=
    POST   /api/v1/workspaces/{id}/items/move    {slugs, folder_id|null}
    POST   /api/v1/workspaces/{id}/items/add     {slugs, folder_id|null, access?}
    POST   /api/v1/workspaces/{id}/items/remove  {slugs?, handles?}
    PATCH  /api/v1/workspaces/{id}/folders/{fid} {name?, slug?, parent_id?}
    PUT    /api/v1/workspaces/{id}/folders/{fid}/share {level}
    DELETE /api/v1/workspaces/{id}/folders/{fid}/share
    POST   /api/v1/workspaces/{id}/transfer      {user_id}

Every document decision goes through access.can (services/access.py).
"""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.models.workspace import role_allows
from app.routers.auth import require_user
from app.services import access, revalidate
from app.services import library as lib_service
from app.services import folder as folder_service
from app.services import workspace as ws_service
from app.services import workspace_items as items_service
from app.utils.net import get_client_ip

router = APIRouter(prefix="/api/v1/workspaces", tags=["workspace-items"])
MAX_BATCH = 200


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _ac(request: Request, db, user: User):
    return (access.actor_from_request(request, user),
            access.Ctx(db, surface="rest", ip=get_client_ip(request)))


class ItemsMove(BaseModel):
    slugs: list[str] = Field(..., min_length=1, max_length=MAX_BATCH)
    folder_id: str | None = None


class ItemsAdd(BaseModel):
    slugs: list[str] = Field(..., min_length=1, max_length=MAX_BATCH)
    folder_id: str | None = None
    access: Literal["link", "private", "workspace"] | None = None


class ItemsRemove(BaseModel):
    slugs: list[str] = Field(default_factory=list, max_length=MAX_BATCH)
    handles: list[str] = Field(default_factory=list, max_length=MAX_BATCH)


class FolderPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=80)
    slug: str | None = Field(None, min_length=1, max_length=40)
    parent_id: str | None = None


class FolderShare(BaseModel):
    level: Literal["link", "workspace"]


class OwnershipTransfer(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=64)


@router.get("/{workspace_id}/tree")
@limiter.limit("120/minute")
async def workspace_tree(request: Request, workspace_id: str,
                         db: AsyncIOMotorDatabase = Depends(get_db),
                         user: User = Depends(require_user)):
    role = await ws_service.require_role(db, workspace_id, user.id, "viewer")
    actor, ctx = _ac(request, db, user)
    return jsonable_encoder(await items_service.tree(db, actor, ctx, workspace_id, role))


@router.get("/{workspace_id}/items")
@limiter.limit("120/minute")
async def workspace_items(
    request: Request, workspace_id: str,
    folder: str = Query("all", max_length=64),
    q: str | None = Query(None, max_length=200),
    kind: str | None = Query(None, pattern="^(markdown|document|artifact)$"),
    cursor: str | None = Query(None, max_length=200),
    limit: int = Query(50, ge=1, le=100),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    await ws_service.require_role(db, workspace_id, user.id, "viewer")
    actor, ctx = _ac(request, db, user)
    return jsonable_encoder(await items_service.items(
        db, actor, ctx, workspace_id, folder=folder, q=q, kind=kind, cursor=cursor, limit=limit))


@router.post("/{workspace_id}/items/move")
@limiter.limit("120/minute")
async def items_move(request: Request, workspace_id: str, data: ItemsMove,
                     db: AsyncIOMotorDatabase = Depends(get_db),
                     user: User = Depends(require_user)):
    """Batch refile (drag-and-drop): member+ for documents they can read. All
    are checked before any moves; one refusal refuses the batch."""
    await ws_service.require_role(db, workspace_id, user.id, "viewer")
    actor, ctx = _ac(request, db, user)
    if data.folder_id:
        await folder_service._get_owned(db, workspace_id, data.folder_id)
    slugs = list(dict.fromkeys(data.slugs))
    rows = []
    for slug in slugs:
        raw = await db["documents"].find_one({"slug": slug, "workspace_id": workspace_id})
        d = await access.can(actor, raw, "move_in_workspace", ctx)
        if not d.allowed:
            if d.status in (401, 404):
                raise HTTPException(status_code=404, detail=f"There's no document {slug} in this workspace.")
            raise d.exception()
        rows.append(raw)
    for raw in rows:  # B5: a clash refuses the batch before anything moves
        if (raw.get("folder_id") or None) != (data.folder_id or None):
            await folder_service.assert_doc_fits(db, workspace_id, data.folder_id, raw.get("slug"))
    async with revalidate.batch(db):  # B-R1: one bounded wait for the batch
        for raw in rows:
            await folder_service.file_document(db, raw, workspace_id, data.folder_id)
    return jsonable_encoder({"items": await items_service.items_by_slug(db, actor, ctx, workspace_id, slugs)})


@router.post("/{workspace_id}/items/add")
@limiter.limit("60/minute")
async def items_add(request: Request, workspace_id: str, data: ItemsAdd,
                    db: AsyncIOMotorDatabase = Depends(get_db),
                    user: User = Depends(require_user)):
    """The owner files their own documents (D1); level unchanged unless
    ``access`` is given."""
    actor, ctx = _ac(request, db, user)
    ctx.target_workspace = workspace_id
    if data.folder_id:
        await ws_service.require_role(db, workspace_id, user.id, "member")
        await folder_service._get_owned(db, workspace_id, data.folder_id)
    slugs = list(dict.fromkeys(data.slugs))
    rows = []
    for slug in slugs:
        raw = await db["documents"].find_one({"slug": slug})
        d = await access.can(actor, raw, "file_into_workspace", ctx)
        if not d.allowed:
            if d.status in (401,) or (d.status == 404 and d.detail == "Document not found"):
                raise HTTPException(status_code=404, detail=f"There's no document {slug} of yours.")
            raise d.exception()
        rows.append(raw)
    for raw in rows:  # B5: a clash refuses the batch before anything is filed
        await folder_service.assert_doc_fits(db, workspace_id, data.folder_id, raw.get("slug"))
    async with revalidate.batch(db):  # B-R1
        for raw in rows:
            await lib_service.add_document(db, workspace_id, str(raw["_id"]), user, data.folder_id,
                                           level=data.access)
    return jsonable_encoder({"items": await items_service.items_by_slug(db, actor, ctx, workspace_id, slugs)})


@router.post("/{workspace_id}/items/remove")
@limiter.limit("60/minute")
async def items_remove(request: Request, workspace_id: str, data: ItemsRemove,
                       db: AsyncIOMotorDatabase = Depends(get_db),
                       user: User = Depends(require_user)):
    """Unshare (D2/D4): the owner always (even after leaving), or an admin —
    including redacted rows, by ``handles`` (``id_token`` from /items).
    ``workspace`` level becomes ``private``; a link document leaving a sign-in
    workspace becomes private (Q2). Returns ``{items:[{slug, access_after}]}``
    (``slug`` is null for a handle the caller can't read)."""
    if not data.slugs and not data.handles:
        raise HTTPException(status_code=422, detail="Name at least one document.")
    targets: list[tuple[dict | None, str | None]] = []
    for slug in dict.fromkeys(data.slugs):
        targets.append((await db["documents"].find_one({"slug": slug}), slug))
    for handle in dict.fromkeys(data.handles):
        doc_id = items_service.read_handle(handle, workspace_id)
        raw = await lib_service._load(db, doc_id) if doc_id else None
        if raw is None:
            raise HTTPException(status_code=404, detail="That document isn't in this workspace.")
        targets.append((raw, None))
    actor, ctx = _ac(request, db, user)
    for raw, _slug in targets:
        if raw is None or raw.get("workspace_id") != workspace_id:
            raise HTTPException(status_code=404, detail="That document isn't in this workspace.")
        d = await access.can(actor, raw, "unshare", ctx)
        if not d.allowed:
            if d.status in (401, 404):
                raise HTTPException(status_code=404, detail="That document isn't in this workspace.")
            raise d.exception()
    removed = []
    async with revalidate.batch(db):  # B-R1
        for raw, slug in targets:
            readable = (await access.can(actor, raw, "read", ctx)).allowed
            res = await lib_service.remove_raw(db, workspace_id, raw, user)
            removed.append({"slug": res["slug"] if (slug or readable) else None,
                            "access_after": res["access_after"]})
    return {"items": removed}


@router.patch("/{workspace_id}/folders/{folder_id}")
@limiter.limit("60/minute")
async def patch_folder(request: Request, workspace_id: str, folder_id: str, data: FolderPatch,
                       db: AsyncIOMotorDatabase = Depends(get_db),
                       user: User = Depends(require_user)):
    """Rename and/or move (``parent_id`` present; null = top level). Admin+
    (A10). The subtree's depth is validated, every document below gets its new
    path, and all of them are purged."""
    await ws_service.require_role(db, workspace_id, user.id, "admin")
    reparent = "parent_id" in data.model_fields_set
    async with revalidate.batch(db):  # B-R1
        folder = await folder_service.update_folder(
            db, workspace_id, folder_id, name=data.name, slug=data.slug,
            parent_id=data.parent_id, reparent=reparent)
    path = await folder_service.path_of(db, workspace_id, folder.id)
    return jsonable_encoder({
        "id": folder.id, "workspace_id": folder.workspace_id, "name": folder.name,
        "slug": folder.slug, "parent_id": folder.parent_id, "path": path,
        "created_at": folder.created_at, "updated_at": folder.updated_at,
    })


async def _require_share_role(db, workspace_id: str, user_id: str) -> None:
    role = await ws_service.require_role(db, workspace_id, user_id, "viewer")
    if role_allows(role, "admin"):
        return
    ws = await ws_service.get_workspace(db, workspace_id)
    if role_allows(role, "member") and ws is not None and ws.settings.members_can_share_folders:
        return
    raise HTTPException(status_code=403, detail="You can't share folders in this workspace.")


def share_url(share_id: str) -> str:
    from app.services import urls

    return urls.markdrop_url(f"f/{share_id}")


@router.put("/{workspace_id}/folders/{folder_id}/share")
@limiter.limit("60/minute")
async def share_folder(request: Request, workspace_id: str, folder_id: str, data: FolderShare,
                       db: AsyncIOMotorDatabase = Depends(get_db),
                       user: User = Depends(require_user)):
    """D2: a folder link shows each visitor only what they could already open.
    It never changes any document's access. ``hidden`` lists the items the
    caller can read that the link's audience couldn't."""
    await _require_share_role(db, workspace_id, user.id)
    share = await folder_service.set_share(db, workspace_id, folder_id, data.level, user.id)
    actor, ctx = _ac(request, db, user)
    return await items_service.share_summary(db, actor, ctx, workspace_id, folder_id, share)


@router.get("/{workspace_id}/folders/{folder_id}/share")
@limiter.limit("120/minute")
async def get_folder_share(request: Request, workspace_id: str, folder_id: str,
                           db: AsyncIOMotorDatabase = Depends(get_db),
                           user: User = Depends(require_user)):
    """The folder's share (same shape as the PUT), or 404 when not shared."""
    await ws_service.require_role(db, workspace_id, user.id, "viewer")
    raw = await folder_service._get_owned(db, workspace_id, folder_id)
    share = raw.get("share")
    if not share or not share.get("id"):
        raise HTTPException(status_code=404, detail="This folder isn't shared.")
    actor, ctx = _ac(request, db, user)
    return await items_service.share_summary(db, actor, ctx, workspace_id, folder_id, share)


@router.delete("/{workspace_id}/folders/{folder_id}/share", status_code=204)
@limiter.limit("60/minute")
async def unshare_folder(request: Request, workspace_id: str, folder_id: str,
                         db: AsyncIOMotorDatabase = Depends(get_db),
                         user: User = Depends(require_user)):
    await _require_share_role(db, workspace_id, user.id)
    await folder_service.clear_share(db, workspace_id, folder_id)


@router.post("/{workspace_id}/transfer")
@limiter.limit("10/hour")
async def transfer_ownership(request: Request, workspace_id: str, data: OwnershipTransfer,
                             db: AsyncIOMotorDatabase = Depends(get_db),
                             user: User = Depends(require_user)):
    """M5: owner → any existing member — viewers included: it is the owner's
    explicit choice, and the new owner can change their own standing. The old
    owner becomes admin. Docs, grants and domains are unchanged."""
    await ws_service.transfer_ownership(db, workspace_id, user.id, data.user_id)
    return {"workspace_id": workspace_id, "owner_id": data.user_id}
