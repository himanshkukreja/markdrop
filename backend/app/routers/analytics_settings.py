"""What analytics items collect (services/analytics_prefs.py): the account's defaults, an item's
own settings (one or many at once), a folder's and a workspace's defaults, and the workspace's
"enforce" switch. Every write can also delete what was already collected for the types it turns
off (``delete``).

Who may change what: your account defaults, yours; an item's settings, its owner (and, for an item
in a workspace, the workspace's owner and admins); a folder's or workspace's defaults and enforce,
the workspace's owner and admins. Reading an item's settings needs the Viewers tab's full access
(services/doc_views.access_level).
"""


from typing import Optional

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import is_tenant_request, require_user
from app.services import access
from app.services import analytics_prefs as ap
from app.services import doc_views as dv

router = APIRouter(prefix="/api/v1", tags=["analytics-settings"])

TypeName = str


class Settings(BaseModel):
    """Per-type switches; types left out fall through to the level below. ``null`` (item, folder)
    goes back to inheriting everything."""
    settings: Optional[dict[str, bool]] = None
    # Also delete what was already collected for these types (of the items this change covers).
    delete: list[TypeName] = Field(default_factory=list, max_length=len(ap.KEYS))


class WorkspaceSettings(Settings):
    enforce: Optional[bool] = None


class BulkSettings(Settings):
    slugs: list[str] = Field(..., min_length=1, max_length=200)
    # true: go back to the defaults (settings is ignored).
    use_defaults: bool = False


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _no_tenant(request: Request) -> None:
    if is_tenant_request(request):
        raise HTTPException(status_code=403, detail="Change this on markdrop.in.")


def _bad_types(types: list[str]) -> None:
    bad = [t for t in types if t not in ap.KEYS]
    if bad:
        raise HTTPException(status_code=422, detail=f"Unknown analytics types: {', '.join(bad)}. "
                            f"Use: {', '.join(ap.KEYS)}.")


def _check(body: Settings) -> None:
    _bad_types(list((body.settings or {}).keys()))
    _bad_types(body.delete)


async def can_manage_item(db: AsyncIOMotorDatabase, user_id: str, raw: dict | None) -> bool:
    """The item's owner, or the owner / an admin of the workspace it's filed in."""
    if raw is None:
        return False
    if raw.get("owner_id") == user_id:
        return True
    if raw.get("workspace_id"):
        from app.services import workspace as ws_service

        return await ws_service.role_for(db, raw["workspace_id"], user_id) in ("owner", "admin")
    return False


async def _item(request: Request, db: AsyncIOMotorDatabase, slug: str, user: User, *, manage: bool) -> dict:
    _no_tenant(request)
    raw = await db["documents"].find_one({"slug": slug})
    actor = access.actor_from_request(request, user)
    if manage:
        if not await can_manage_item(db, user.id, raw):
            await access.require(actor, raw, "read", access.Ctx(db))
            raise HTTPException(status_code=403, detail="Only the item's owner (or its workspace's admins) can "
                                "change what it tracks.")
        return raw
    if await dv.access_level(db, actor, raw) != "full" and not await can_manage_item(db, user.id, raw):
        await access.require(actor, raw, "view_stats", access.Ctx(db))
        raise HTTPException(status_code=403, detail="Only the document's owner can do that.")
    return raw


async def item_settings(db: AsyncIOMotorDatabase, raw: dict, user_id: str | None = None) -> dict:
    lay = await ap.layers(db, raw)
    out = ap.describe(ap.combine(lay), lay)
    out["slug"] = raw["slug"]
    if user_id is not None:
        out["can_change"] = await can_manage_item(db, user_id, raw)
    return out


async def _delete_for(db: AsyncIOMotorDatabase, docs: list[dict], types: list[str]) -> dict:
    """Delete already collected data of ``types`` for those of ``docs`` where the type is now off."""
    total: dict[str, int] = {}
    for t in types:
        ids = []
        for d in docs:
            if not (await ap.resolve(db, d))["effective"][t]:
                ids.append(str(d["_id"]))
        for k, v in (await ap.delete_collected(db, ids, [t])).items():
            total[k] = total.get(k, 0) + v
    return total


# ── Account defaults ──────────────────────────────────────────────────────────


@router.get("/me/analytics-settings")
@limiter.limit("120/minute")
async def get_my_settings(request: Request, db: AsyncIOMotorDatabase = Depends(get_db),
                          user: User = Depends(require_user)):
    """Your defaults for the items you own (each type on unless you turned it off)."""
    s = await ap.get_account(db, user.id)
    return {"settings": s, "types": [{"key": k, "label": ap.LABELS[k], "on": s[k]} for k in ap.KEYS],
            "summary": ap.summary(s)}


@router.put("/me/analytics-settings")
@limiter.limit("30/minute")
async def put_my_settings(request: Request, body: Settings, db: AsyncIOMotorDatabase = Depends(get_db),
                          user: User = Depends(require_user)):
    """Change your defaults. ``delete``: also delete what was already collected for those types on
    your items where they're now off (an item with its own setting turned on keeps its data)."""
    _no_tenant(request)
    _check(body)
    current = await ap.get_account(db, user.id)
    await ap.set_account(db, user.id, {**current, **(body.settings or {})})
    deleted = {}
    if body.delete:
        docs = await db["documents"].find({"owner_id": user.id}, {"_id": 1, "owner_id": 1, "workspace_id": 1,
                                                                 "folder_id": 1, "analytics_prefs": 1}) \
            .limit(5000).to_list(length=5000)
        deleted = await _delete_for(db, docs, body.delete)
    s = await ap.get_account(db, user.id)
    return {"settings": s, "summary": ap.summary(s), "deleted": deleted}


# ── One item, or many ─────────────────────────────────────────────────────────


@router.get("/me/documents/{slug}/analytics/settings")
@limiter.limit("120/minute")
async def get_item_settings(request: Request, slug: str, db: AsyncIOMotorDatabase = Depends(get_db),
                            user: User = Depends(require_user)):
    """What this item collects, each type with where its value comes from (this item, a folder,
    the workspace, your defaults) and whether the workspace enforces it."""
    raw = await _item(request, db, slug, user, manage=False)
    return await item_settings(db, raw, user.id)


@router.put("/me/documents/{slug}/analytics/settings")
@limiter.limit("60/minute")
async def put_item_settings(request: Request, slug: str, body: Settings,
                            db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """This item's own settings (``settings: null``: use the defaults). A type the workspace
    enforces off stays off. ``delete``: also delete its already collected data for those types."""
    _check(body)
    raw = await _item(request, db, slug, user, manage=True)
    await ap.set_item(db, [raw["_id"]], body.settings)
    raw = await db["documents"].find_one({"_id": raw["_id"]})
    deleted = await _delete_for(db, [raw], body.delete) if body.delete else {}
    out = await item_settings(db, raw, user.id)
    out["deleted"] = deleted
    return out


@router.post("/me/analytics-settings/items")
@limiter.limit("20/minute")
async def put_many_items(request: Request, body: BulkSettings, db: AsyncIOMotorDatabase = Depends(get_db),
                         user: User = Depends(require_user)):
    """The same settings for several items at once (My files, a folder). Items you can't change
    are skipped and listed."""
    _no_tenant(request)
    _check(body)
    docs, skipped = [], []
    for slug in dict.fromkeys(body.slugs):
        raw = await db["documents"].find_one({"slug": slug})
        if await can_manage_item(db, user.id, raw):
            docs.append(raw)
        else:
            skipped.append(slug)
    if docs:
        await ap.set_item(db, [d["_id"] for d in docs], None if body.use_defaults else (body.settings or {}))
    fresh = await db["documents"].find({"_id": {"$in": [d["_id"] for d in docs]}}).to_list(length=len(docs) or 1)
    deleted = await _delete_for(db, fresh, body.delete) if body.delete and fresh else {}
    return {"updated": [d["slug"] for d in docs], "skipped": skipped, "deleted": deleted}


# ── Workspace and folder defaults ─────────────────────────────────────────────


async def _ws_admin(db: AsyncIOMotorDatabase, workspace_id: str, user: User, *, write: bool) -> dict:
    from app.services import workspace as ws_service

    if not ObjectId.is_valid(workspace_id):
        raise HTTPException(status_code=404, detail="Workspace not found")
    await ws_service.require_role(db, workspace_id, user.id, "admin" if write else "viewer")
    w = await db["workspaces"].find_one({"_id": ObjectId(workspace_id)})
    if not w:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return w


def _ws_out(w: dict) -> dict:
    p = ap.clean(w.get("analytics_prefs"))
    return {"settings": p, "enforce": bool(w.get("analytics_enforce")),
            "types": [{"key": k, "label": ap.LABELS[k], "on": p.get(k), "set": k in p} for k in ap.KEYS]}


@router.get("/workspaces/{workspace_id}/analytics-settings")
@limiter.limit("120/minute")
async def get_workspace_settings(request: Request, workspace_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                                 user: User = Depends(require_user)):
    """The workspace's defaults (types it doesn't set fall through to each owner's) and whether
    they're enforced (a type it has off is off for every item in it)."""
    return _ws_out(await _ws_admin(db, workspace_id, user, write=False))


@router.put("/workspaces/{workspace_id}/analytics-settings")
@limiter.limit("30/minute")
async def put_workspace_settings(request: Request, workspace_id: str, body: WorkspaceSettings,
                                 db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """Owners and admins. ``settings`` replaces the workspace's defaults (omit a type to leave it
    to each owner); ``enforce`` locks the types it has off. ``delete``: also delete already
    collected data of those types on the workspace's items where they're now off."""
    _no_tenant(request)
    _check(body)
    await _ws_admin(db, workspace_id, user, write=True)
    await ap.set_workspace(db, workspace_id, body.settings, body.enforce)
    deleted = {}
    if body.delete:
        docs = await db["documents"].find({"workspace_id": workspace_id}).limit(5000).to_list(length=5000)
        deleted = await _delete_for(db, docs, body.delete)
    out = _ws_out(await db["workspaces"].find_one({"_id": ObjectId(workspace_id)}))
    out["deleted"] = deleted
    return out


async def _folder(db: AsyncIOMotorDatabase, workspace_id: str, folder_id: str) -> dict:
    if not ObjectId.is_valid(folder_id):
        raise HTTPException(status_code=404, detail="Folder not found")
    f = await db["folders"].find_one({"_id": ObjectId(folder_id), "workspace_id": workspace_id})
    if not f:
        raise HTTPException(status_code=404, detail="Folder not found")
    return f


@router.get("/workspaces/{workspace_id}/folders/{folder_id}/analytics-settings")
@limiter.limit("120/minute")
async def get_folder_settings(request: Request, workspace_id: str, folder_id: str,
                              db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    await _ws_admin(db, workspace_id, user, write=False)
    f = await _folder(db, workspace_id, folder_id)
    p = ap.clean(f.get("analytics_prefs"))
    return {"settings": p, "types": [{"key": k, "label": ap.LABELS[k], "on": p.get(k), "set": k in p} for k in ap.KEYS]}


@router.put("/workspaces/{workspace_id}/folders/{folder_id}/analytics-settings")
@limiter.limit("30/minute")
async def put_folder_settings(request: Request, workspace_id: str, folder_id: str, body: Settings,
                              db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """Owners and admins: defaults for the items in this folder and the folders inside it (an item's
    own settings still win; the workspace's enforced ones win over both). ``settings: null`` clears."""
    _no_tenant(request)
    _check(body)
    await _ws_admin(db, workspace_id, user, write=True)
    await _folder(db, workspace_id, folder_id)
    await ap.set_folder(db, folder_id, body.settings)
    deleted = {}
    if body.delete:
        docs = await db["documents"].find({"workspace_id": workspace_id}).limit(5000).to_list(length=5000)
        inside = []
        for d in docs:
            chain = await ap._folder_chain(db, workspace_id, d.get("folder_id"))
            if any(c["id"] == folder_id for c in chain):
                inside.append(d)
        deleted = await _delete_for(db, inside, body.delete)
    f = await _folder(db, workspace_id, folder_id)
    p = ap.clean(f.get("analytics_prefs"))
    return {"settings": p, "deleted": deleted,
            "types": [{"key": k, "label": ap.LABELS[k], "on": p.get(k), "set": k in p} for k in ap.KEYS]}
