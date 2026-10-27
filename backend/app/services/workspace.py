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
        deleting=bool(raw.get("deleting")),
    )


DELETING = "This workspace is being deleted."


async def assert_open(db: AsyncIOMotorDatabase, workspace_id: str) -> None:
    """404 for a workspace that is gone, 409 for one being deleted (C-N5):
    nothing may be filed, moved or created in it any more."""
    try:
        oid = ObjectId(workspace_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Workspace not found")
    raw = await db["workspaces"].find_one({"_id": oid}, {"deleting": 1})
    if raw is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    if raw.get("deleting"):
        raise HTTPException(status_code=409, detail=DELETING)


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
        # What the documents' bytes and epochs currently reflect (C-N8).
        "require_auth_applied": False,
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
    # Merged per field, never replaced whole: ``branding`` / ``settings`` hold
    # only the keys the caller sent (explicit null clears a field). A partial
    # PUT that replaced the object would reset every omitted setting to its
    # default — ``require_auth_to_view`` off, i.e. every document of a
    # sign-in workspace public (C3). Written as dotted keys so a concurrent
    # update of another field isn't overwritten either.
    if settings and "require_auth_to_view" in settings:
        # A workspace from before C-N8 has no record of what its documents
        # reflect: it is whatever the setting was until this write.
        row = await db["workspaces"].find_one({"_id": ObjectId(workspace_id)}, {"settings": 1})
        if row is not None:
            await db["workspaces"].update_one(
                {"_id": ObjectId(workspace_id), "require_auth_applied": {"$exists": False}},
                {"$set": {"require_auth_applied": bool((row.get("settings") or {}).get("require_auth_to_view"))}})
    for group, values in (("branding", branding), ("settings", settings)):
        if values:
            # A legacy row may hold null here; dotted keys need an object.
            await db["workspaces"].update_one(
                {"_id": ObjectId(workspace_id), group: {"$not": {"$type": "object"}}},
                {"$set": {group: {}}})
        for key, value in (values or {}).items():
            updates[f"{group}.{key}"] = value

    # Never while the workspace is being deleted (R3-1): the release reads require-sign-in once the
    # doors are shut, so a settings write landing after that could widen what it releases.
    res = await db["workspaces"].update_one(
        {"_id": ObjectId(workspace_id), "deleting": {"$ne": True}}, {"$set": updates})
    if res.matched_count == 0:
        await assert_open(db, workspace_id)  # 404 gone / 409 being deleted
    workspace = await get_workspace(db, workspace_id)
    if workspace is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return workspace


async def set_member_role(
    db: AsyncIOMotorDatabase, workspace_id: str, user_id: str, role: Role,
    actor_id: str | None = None,
) -> None:
    """Admins change members and viewers; only the workspace **owner** may
    promote to, demote from, or touch an admin (Q5). Demotion to viewer turns
    the editor grants this person made through the workspace into viewer
    grants (M2)."""
    from app.services import lifecycle

    workspace = await get_workspace(db, workspace_id)
    if workspace is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    if user_id == workspace.owner_id:
        raise HTTPException(status_code=422, detail="The owner's role can't be changed.")
    if role == "owner":
        raise HTTPException(status_code=422, detail="Transfer ownership instead.")
    current = await role_for(db, workspace_id, user_id)
    if current is None:
        raise HTTPException(status_code=404, detail="That person isn't in this workspace.")
    if actor_id is not None and actor_id != workspace.owner_id and (role == "admin" or current == "admin"):
        raise HTTPException(status_code=403, detail="Only the workspace owner can change an admin's role.")
    result = await db["memberships"].update_one(
        {"workspace_id": workspace_id, "user_id": user_id, "role": current}, {"$set": {"role": role}}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="That person isn't in this workspace.")
    await lifecycle.member_demoted(db, workspace_id, user_id, role)


async def remove_member(db: AsyncIOMotorDatabase, workspace_id: str, user_id: str,
                        actor_id: str | None = None) -> None:
    """Remove (or leave). Removing an admin is the owner's call (Q5). Grants
    this person made through the workspace die with the membership (M1)."""
    from app.services import lifecycle

    workspace = await get_workspace(db, workspace_id)
    if workspace is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    if user_id == workspace.owner_id:
        raise HTTPException(
            status_code=422,
            detail="The owner can't be removed. Transfer ownership or delete the workspace.",
        )
    if actor_id is not None and actor_id != user_id and actor_id != workspace.owner_id:
        if await role_for(db, workspace_id, user_id) == "admin":
            raise HTTPException(status_code=403, detail="Only the workspace owner can remove an admin.")
    res = await db["memberships"].delete_one({"workspace_id": workspace_id, "user_id": user_id})
    if res.deleted_count:
        await lifecycle.member_left(db, workspace_id, user_id)


async def transfer_ownership(db: AsyncIOMotorDatabase, workspace_id: str, actor_id: str,
                             target_id: str) -> None:
    """M5: the owner hands the workspace to an existing member of any role
    (viewers included — the owner's explicit choice); the old owner becomes
    an admin. One CAS on ``{_id, owner_id: old}``, conditioned on the
    target's membership still existing (§3.8)."""
    workspace = await get_workspace(db, workspace_id)
    if workspace is None or await role_for(db, workspace_id, actor_id) is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    if workspace.owner_id != actor_id:
        raise HTTPException(status_code=403, detail="Only the workspace owner can transfer it.")
    if target_id == actor_id:
        raise HTTPException(status_code=422, detail="You already own this workspace.")
    target = await db["memberships"].find_one({"workspace_id": workspace_id, "user_id": target_id})
    if target is None:
        raise HTTPException(status_code=404, detail="That person isn't in this workspace.")
    promoted = await db["memberships"].update_one(
        {"workspace_id": workspace_id, "user_id": target_id, "role": target["role"]},
        {"$set": {"role": "owner"}})
    if promoted.matched_count == 0:
        raise HTTPException(status_code=404, detail="That person isn't in this workspace.")
    moved = await db["workspaces"].update_one(
        {"_id": ObjectId(workspace_id), "owner_id": actor_id},
        {"$set": {"owner_id": target_id, "updated_at": datetime.now(timezone.utc)}})
    if moved.matched_count == 0:
        await db["memberships"].update_one(
            {"workspace_id": workspace_id, "user_id": target_id}, {"$set": {"role": target["role"]}})
        raise HTTPException(status_code=409, detail="The workspace changed meanwhile. Try again.")
    await db["memberships"].update_one(
        {"workspace_id": workspace_id, "user_id": actor_id}, {"$set": {"role": "admin"}})


async def delete_workspace(
    db: AsyncIOMotorDatabase, workspace_id: str, user_id: str, confirm_name: str
) -> dict:
    """Delete a workspace. Owner only. Returns a summary of what was released.

    The thing this must never do is destroy other people's work. A workspace's
    shared library is full of documents owned by its members, not by the
    workspace -- so deleting one *unshares* every document rather than deleting
    any. Each returns to its owner's private library with its slug, links and
    analytics intact, exactly as if it had been unshared one at a time.

    Domains are detached from the hosting project first. Skipping that would
    leave the host registered to our Vercel project with no Markdrop record
    pointing at it, which makes it impossible for its actual owner to ever add
    it again, anywhere.
    """
    workspace = await get_workspace(db, workspace_id)
    if workspace is None:
        raise HTTPException(status_code=404, detail="Workspace not found")

    # Owner, not admin. An admin can run a workspace; only the owner can end it.
    role = await role_for(db, workspace_id, user_id)
    if role is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    if user_id != workspace.owner_id:
        raise HTTPException(
            status_code=403, detail="Only the workspace owner can delete it."
        )

    # Typing the name is a guard against a mis-aimed script or a stray click on
    # a request that cannot be undone. The UI asks for it too; this is the copy
    # that actually enforces it.
    if (confirm_name or "").strip() != workspace.name.strip():
        raise HTTPException(
            status_code=422,
            detail="Type the workspace name exactly to confirm deletion.",
        )

    from app.services import domain as domain_service
    from app.services import lifecycle, revalidate

    # C-N5: close the doors first. From here on nothing can be filed, moved
    # or created in it (can(file_into_workspace), folder create, uploads), so
    # the release below can't be outrun by a member filing as fast as it goes.
    await db["workspaces"].update_one(
        {"_id": ObjectId(workspace_id), "owner_id": user_id},
        {"$set": {"deleting": True, "deleting_at": datetime.now(timezone.utc)}})
    # Read require-sign-in from the stored row *after* the doors are shut (R3-1): settings writes
    # are refused from here on (update_workspace), so this value is final. Either value being on
    # counts as on, so a toggle racing the flag can never make the release widen anything.
    stored = await db["workspaces"].find_one({"_id": ObjectId(workspace_id)}, {"settings": 1}) or {}
    stored_auth = bool(((stored.get("settings") or {}) if isinstance(stored.get("settings"), dict) else {})
                       .get("require_auth_to_view"))
    require_auth = bool(workspace.settings.require_auth_to_view) or stored_auth

    # W3: every document is released with the D2 conversion (workspace-only
    # ⇒ private; link documents of a sign-in workspace ⇒ private), grants made
    # through the workspace die, caches are purged. First, and database
    # first: the workspace row must never disappear while a document still
    # points at it, or nothing would remember that it required sign-in (C1).
    doc_keys: list[str] = []
    released, remaining = await lifecycle.release_workspace_documents(
        db, workspace_id, require_auth, purge_keys=doc_keys)
    if remaining:
        # Say exactly what happened (C-N6): what was released stays released,
        # the workspace stays closed to new documents, a retry finishes it.
        if doc_keys:
            await revalidate.flush(db, doc_keys)
        raise HTTPException(
            status_code=409,
            detail=(f"{released} document{'s' if released != 1 else ''} were taken out of this "
                    f"workspace, but {remaining} couldn't be yet. The workspace is closed to new "
                    "documents and wasn't deleted — try again to finish."),
        )

    domains = await db["domains"].find({"workspace_id": workspace_id}).to_list(length=200)
    for d in domains:
        if d.get("attached"):
            await domain_service.detach_from_hosting(d["host"])
    host_tags = [f"host:{d['host']}" for d in domains if d.get("host")]
    await db["domains"].delete_many({"workspace_id": workspace_id})
    await domain_service.forget_hosts(db, [d.get("host") for d in domains])
    # Closing: the hosts stop serving and every document left them. Answer once
    # the host resolutions, listings and released pages are purged (bounded, B2).
    keys = await revalidate.enqueue(db, tags=[f"wsl:{workspace_id}", *host_tags], attempt_now=False)
    await revalidate.flush(db, [*keys, *doc_keys])
    await db["folders"].delete_many({"workspace_id": workspace_id})
    await db["invitations"].delete_many({"workspace_id": workspace_id})
    members = await db["memberships"].delete_many({"workspace_id": workspace_id})
    await db["workspaces"].delete_one({"_id": ObjectId(workspace_id)})
    # C-N6: a filing that passed its checks before ``deleting`` was set can
    # still land after the release pass. Sweep again, database first: out of
    # the (now gone) workspace, level converted, marked dirty for the bytes.
    late_keys: list[str] = []
    late, _left = await lifecycle.release_workspace_documents(
        db, workspace_id, require_auth, passes=2, purge_keys=late_keys)
    if late_keys:
        await revalidate.flush(db, late_keys)
    released += late

    return {
        "documents_released": released,
        "domains_removed": len(domains),
        "members_removed": members.deleted_count,
    }


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
