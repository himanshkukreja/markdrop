"""Workspaces — the tenant that owns custom domains, branding and members.

Everything in the enterprise surface hangs off this. A document with no
`workspace_id` is an ordinary markdrop.in document and behaves exactly as it did
before workspaces existed; nothing here changes that path.
"""

from datetime import datetime, timezone

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.models.user import User
from app.models.workspace import (
    Branding,
    Membership,
    Role,
    Workspace,
    WorkspaceSettings,
    role_allows,
)

MAX_WORKSPACES_PER_USER = 10


def _to_workspace(raw: dict) -> Workspace:
    return Workspace(
        id=str(raw["_id"]),
        name=raw["name"],
        owner_id=raw["owner_id"],
        created_at=raw["created_at"],
        updated_at=raw["updated_at"],
        branding=Branding.from_dict(raw.get("branding")),
        settings=WorkspaceSettings.from_dict(raw.get("settings")),
    )


def _to_membership(raw: dict) -> Membership:
    return Membership(
        workspace_id=raw["workspace_id"],
        user_id=raw["user_id"],
        role=raw["role"],
        created_at=raw["created_at"],
        email=raw.get("email"),
        name=raw.get("name"),
    )


# ── Reads ─────────────────────────────────────────────────────────────────────


async def get_workspace(db: AsyncIOMotorDatabase, workspace_id: str) -> Workspace | None:
    try:
        oid = ObjectId(workspace_id)
    except Exception:
        return None
    raw = await db["workspaces"].find_one({"_id": oid})
    return _to_workspace(raw) if raw else None


async def role_for(db: AsyncIOMotorDatabase, workspace_id: str, user_id: str | None) -> str | None:
    """The caller's role in this workspace, or None if they aren't a member."""
    if not user_id:
        return None
    raw = await db["memberships"].find_one(
        {"workspace_id": workspace_id, "user_id": user_id}, {"role": 1}
    )
    return raw["role"] if raw else None


async def require_role(
    db: AsyncIOMotorDatabase, workspace_id: str, user_id: str | None, required: Role
) -> str:
    """Authorize, or raise. 404 rather than 403 for non-members, so the API
    doesn't confirm that a workspace exists to someone with no access to it."""
    actual = await role_for(db, workspace_id, user_id)
    if actual is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    if not role_allows(actual, required):
        raise HTTPException(
            status_code=403, detail=f"This action requires the {required} role or higher."
        )
    return actual


async def list_for_user(db: AsyncIOMotorDatabase, user_id: str) -> list[tuple[Workspace, str]]:
    """Every workspace the user belongs to, paired with their role in it."""
    memberships = await db["memberships"].find({"user_id": user_id}).to_list(length=100)
    if not memberships:
        return []
    by_id = {m["workspace_id"]: m["role"] for m in memberships}
    oids = []
    for wid in by_id:
        try:
            oids.append(ObjectId(wid))
        except Exception:
            continue
    rows = await db["workspaces"].find({"_id": {"$in": oids}}).to_list(length=100)
    out = [(_to_workspace(r), by_id[str(r["_id"])]) for r in rows]
    out.sort(key=lambda pair: pair[0].created_at)
    return out


async def list_members(db: AsyncIOMotorDatabase, workspace_id: str) -> list[Membership]:
    rows = await db["memberships"].find({"workspace_id": workspace_id}).to_list(length=500)
    rows.sort(key=lambda r: r["created_at"])
    return [_to_membership(r) for r in rows]


# ── Writes ────────────────────────────────────────────────────────────────────


async def create_workspace(db: AsyncIOMotorDatabase, name: str, owner: User) -> Workspace:
    existing = await db["memberships"].count_documents({"user_id": owner.id, "role": "owner"})
    if existing >= MAX_WORKSPACES_PER_USER:
        raise HTTPException(
            status_code=429,
            detail=f"You can own at most {MAX_WORKSPACES_PER_USER} workspaces.",
        )

    now = datetime.now(timezone.utc)
    doc = {
        "name": name.strip() or "Untitled workspace",
        "owner_id": owner.id,
        "created_at": now,
        "updated_at": now,
        "branding": {},
        "settings": {},
    }
    result = await db["workspaces"].insert_one(doc)
    workspace_id = str(result.inserted_id)

    # The creator's membership is what every later authorization check reads —
    # without it the owner couldn't administer the workspace they just made.
    await db["memberships"].insert_one(
        {
            "workspace_id": workspace_id,
            "user_id": owner.id,
            "role": "owner",
            "created_at": now,
            "email": owner.email,
            "name": owner.name,
        }
    )
    doc["_id"] = result.inserted_id
    return _to_workspace(doc)


async def update_workspace(
    db: AsyncIOMotorDatabase,
    workspace_id: str,
    *,
    name: str | None = None,
    branding: dict | None = None,
    settings: dict | None = None,
) -> Workspace:
    updates: dict = {"updated_at": datetime.now(timezone.utc)}
    if name is not None:
        updates["name"] = name.strip() or "Untitled workspace"
    # Whole-object replacement, not a merge: these come from a settings form that
    # always sends every field, and a merge would make "clear this" impossible.
    if branding is not None:
        updates["branding"] = branding
    if settings is not None:
        updates["settings"] = settings

    await db["workspaces"].update_one({"_id": ObjectId(workspace_id)}, {"$set": updates})
    workspace = await get_workspace(db, workspace_id)
    if workspace is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return workspace


async def add_member(
    db: AsyncIOMotorDatabase, workspace_id: str, email: str, role: Role
) -> Membership:
    if role == "owner":
        raise HTTPException(
            status_code=422,
            detail="A workspace has exactly one owner. Transfer ownership instead.",
        )
    email = email.strip().lower()
    user_raw = await db["users"].find_one({"email": email})
    if not user_raw:
        # Deliberately not an invite flow yet: silently creating an account for a
        # stranger's address, or pretending someone was added when they weren't,
        # are both worse than saying plainly that they need to sign up first.
        raise HTTPException(
            status_code=404,
            detail="No Markdrop account uses that email yet. Ask them to sign in once, then add them.",
        )

    user_id = str(user_raw["_id"])
    now = datetime.now(timezone.utc)
    doc = {
        "workspace_id": workspace_id,
        "user_id": user_id,
        "role": role,
        "created_at": now,
        "email": user_raw.get("email"),
        "name": user_raw.get("name"),
    }
    # Idempotent: re-adding an existing member updates their role rather than
    # failing on the unique index or creating a duplicate row.
    await db["memberships"].update_one(
        {"workspace_id": workspace_id, "user_id": user_id},
        {"$set": doc},
        upsert=True,
    )
    return _to_membership(doc)


async def set_member_role(
    db: AsyncIOMotorDatabase, workspace_id: str, user_id: str, role: Role
) -> None:
    workspace = await get_workspace(db, workspace_id)
    if workspace is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    if user_id == workspace.owner_id:
        raise HTTPException(status_code=422, detail="The owner's role can't be changed.")
    if role == "owner":
        raise HTTPException(status_code=422, detail="Transfer ownership instead.")
    result = await db["memberships"].update_one(
        {"workspace_id": workspace_id, "user_id": user_id}, {"$set": {"role": role}}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="That person isn't in this workspace.")


async def remove_member(db: AsyncIOMotorDatabase, workspace_id: str, user_id: str) -> None:
    workspace = await get_workspace(db, workspace_id)
    if workspace is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    if user_id == workspace.owner_id:
        raise HTTPException(
            status_code=422,
            detail="The owner can't be removed. Transfer ownership or delete the workspace.",
        )
    await db["memberships"].delete_one({"workspace_id": workspace_id, "user_id": user_id})


# ── The safety rule ───────────────────────────────────────────────────────────


def chrome_for(workspace: Workspace | None, *, on_own_domain: bool) -> str:
    """Which viewer chrome to render.

    `viewer_chrome` can hide the control that exits immersive mode — which is
    also the only route an anonymous visitor has to Report. That trade is the
    workspace owner's to make on a domain they are accountable for. It is not
    theirs to make on markdrop.in, where we carry the liability, so the setting
    is ignored entirely off their own domains. This is why the flag lives here
    and not in the view: a caller cannot forget the condition.
    """
    if workspace is None or not on_own_domain:
        return "full"
    return workspace.settings.viewer_chrome
