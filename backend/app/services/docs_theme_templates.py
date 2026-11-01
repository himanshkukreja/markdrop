"""Saved designs ("Your templates"): a guide's design kept under a name, to apply to any guide.

A template is a theme without the guide's brand: preset, fonts, colour mode, corners, custom CSS
and the custom theme (the theme builder's colours, type, shape and styles). It belongs to a
workspace, where every guide of that workspace can use it, or to one person (their personal
guides). Applying one is the Design panel's business: it loads the template into the draft and
the owner saves the design as usual (PATCH /api/v1/docs-sites/{id}, studio admins), so nothing
changes on a guide without its own save and publish.

Who may do what (services/docs_studio_roles.py):

    list      anyone with a Guides role in the workspace (or on one of its guides)
    create, rename, change, duplicate, delete
              the workspace's Guides admins; a personal template, its owner

Validation is the site settings' own (docs_site_settings.validate_theme), so a template can
never hold a design a guide would refuse. At most :data:`LIMIT` per workspace (or person).
"""

from __future__ import annotations

from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.models.user import User
from app.services import docs_site_settings as site_settings
from app.services import docs_studio_roles as roles
from app.services import workspace as ws_service

COLLECTION = "docs_theme_templates"
LIMIT = 50
NAME_MAX = 60


def now() -> datetime:
    return datetime.now(timezone.utc)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLLECTION].create_index([("workspace_id", 1), ("owner_id", 1), ("name_key", 1)])
    await db[COLLECTION].create_index([("workspace_id", 1), ("updated_at", -1)])


# ── Who may ───────────────────────────────────────────────────────────────────


async def access(db: AsyncIOMotorDatabase, workspace_id: str | None, user: User) -> tuple[dict, bool]:
    """The scope's filter and whether the caller may change its templates. 404 for a workspace
    the caller isn't in (or has no Guides access to)."""
    if not workspace_id:
        return {"workspace_id": None, "owner_id": user.id}, True
    workspace = await ws_service.get_workspace(db, workspace_id)
    ws_role = await ws_service.role_for(db, workspace_id, user.id) if workspace else None
    if workspace is None or ws_role is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    role = (await roles.workspace_role(db, workspace_id, user.id, ws_role)).role
    if role is None:
        # A per-site role (an admin of one guide only) still sees the workspace's templates.
        site_grant = await db[roles.SITE_MEMBERS].find_one(
            {"workspace_id": workspace_id, "user_id": user.id, "role": {"$in": list(roles.ROLES)}}, {"_id": 1})
        if site_grant is None:
            raise HTTPException(status_code=404, detail="Workspace not found")
    return {"workspace_id": workspace_id}, roles.role_at_least(role, "admin")


def _require_edit(can_edit: bool) -> None:
    if not can_edit:
        raise HTTPException(status_code=403, detail="Only Guides admins of this workspace can change its templates.")


# ── Shapes ────────────────────────────────────────────────────────────────────


def _name(raw: str | None) -> str:
    name = " ".join((raw or "").split())
    if not name:
        raise HTTPException(status_code=422, detail="Give the template a name.")
    if len(name) > NAME_MAX:
        raise HTTPException(status_code=422, detail=f"Use a name of at most {NAME_MAX} characters.")
    return name


def _theme(raw) -> dict:
    try:
        return site_settings.validate_theme(raw)
    except site_settings.SettingsError as exc:
        raise HTTPException(status_code=422, detail=exc.errors) from None


def view(row: dict) -> dict:
    return {
        "id": str(row["_id"]),
        "name": row["name"],
        "workspace_id": row.get("workspace_id"),
        "theme": row["theme"],
        "created_by": row.get("created_by"),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


def _oid(template_id: str) -> ObjectId:
    try:
        return ObjectId(template_id)
    except (InvalidId, TypeError):
        raise HTTPException(status_code=404, detail="Template not found") from None


# ── CRUD ──────────────────────────────────────────────────────────────────────


async def list_templates(db: AsyncIOMotorDatabase, workspace_id: str | None, user: User) -> dict:
    scope, can_edit = await access(db, workspace_id, user)
    rows = await db[COLLECTION].find(scope).sort([("updated_at", -1)]).to_list(length=LIMIT * 2)
    return {"templates": [view(r) for r in rows], "can_edit": can_edit, "limit": LIMIT}


async def _name_free(db: AsyncIOMotorDatabase, scope: dict, name: str, exclude: ObjectId | None = None) -> None:
    q = {**scope, "name_key": name.casefold()}
    if exclude is not None:
        q["_id"] = {"$ne": exclude}
    if await db[COLLECTION].find_one(q, {"_id": 1}):
        raise HTTPException(status_code=409, detail=f"There's already a template called \"{name}\". Pick another name.")


async def _room(db: AsyncIOMotorDatabase, scope: dict) -> None:
    if await db[COLLECTION].count_documents(scope) >= LIMIT:
        where = "this workspace" if scope.get("workspace_id") else "you"
        raise HTTPException(status_code=409, detail=f"{LIMIT} templates is the most for {where}. Delete one you don't use first.")


async def create(db: AsyncIOMotorDatabase, user: User, *, workspace_id: str | None, name: str, theme) -> dict:
    scope, can_edit = await access(db, workspace_id, user)
    _require_edit(can_edit)
    clean_name = _name(name)
    clean = _theme(theme)
    await _room(db, scope)
    await _name_free(db, scope, clean_name)
    t = now()
    row = {
        "workspace_id": workspace_id or None,
        "owner_id": user.id,
        "name": clean_name,
        "name_key": clean_name.casefold(),
        "theme": clean,
        "created_by": user.id,
        "created_at": t,
        "updated_by": user.id,
        "updated_at": t,
    }
    res = await db[COLLECTION].insert_one(row)
    row["_id"] = res.inserted_id
    return view(row)


async def _load(db: AsyncIOMotorDatabase, template_id: str, user: User) -> tuple[dict, dict, bool]:
    row = await db[COLLECTION].find_one({"_id": _oid(template_id)})
    if row is None:
        raise HTTPException(status_code=404, detail="Template not found")
    if row.get("workspace_id"):
        scope, can_edit = await access(db, row["workspace_id"], user)
    elif row.get("owner_id") == user.id:
        scope, can_edit = {"workspace_id": None, "owner_id": user.id}, True
    else:
        raise HTTPException(status_code=404, detail="Template not found")
    return row, scope, can_edit


async def update(db: AsyncIOMotorDatabase, user: User, template_id: str, *, name: str | None, theme) -> dict:
    row, scope, can_edit = await _load(db, template_id, user)
    _require_edit(can_edit)
    changes: dict = {}
    if name is not None:
        clean_name = _name(name)
        await _name_free(db, scope, clean_name, exclude=row["_id"])
        changes.update(name=clean_name, name_key=clean_name.casefold())
    if theme is not None:
        changes["theme"] = _theme(theme)
    if changes:
        changes.update(updated_by=user.id, updated_at=now())
        await db[COLLECTION].update_one({"_id": row["_id"]}, {"$set": changes})
        row.update(changes)
    return view(row)


async def duplicate(db: AsyncIOMotorDatabase, user: User, template_id: str, *, name: str | None) -> dict:
    row, scope, can_edit = await _load(db, template_id, user)
    _require_edit(can_edit)
    if name is None:
        # "Docs" → "Docs copy", then "Docs copy 2", …
        base = f"{row['name']} copy"[:NAME_MAX]
        name, n = base, 2
        while await db[COLLECTION].find_one({**scope, "name_key": name.casefold()}, {"_id": 1}):
            suffix = f" {n}"
            name, n = base[: NAME_MAX - len(suffix)] + suffix, n + 1
    return await create(db, user, workspace_id=row.get("workspace_id"), name=name, theme=row["theme"])


async def delete(db: AsyncIOMotorDatabase, user: User, template_id: str) -> dict:
    row, _scope, can_edit = await _load(db, template_id, user)
    _require_edit(can_edit)
    await db[COLLECTION].delete_one({"_id": row["_id"]})
    return {"deleted": True, "id": str(row["_id"])}
