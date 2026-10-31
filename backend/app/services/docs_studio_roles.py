"""Guides roles: who may do what on a workspace's docs sites.

Markdrop Guides has its own roles, separate from the workspace's:

    admin     site settings, design, domains, people and their studio roles,
              approve reviews, publish, restore, delete
    reviewer  everything an editor can, plus approve / request changes on
              reviews (not their own); no settings
    editor    create, edit and delete pages, upload, publish (or submit for
              review when the site requires one)
    viewer    read drafts, preview, history; no edits
    none      no access: the workspace's sites are invisible (404)

Where a role comes from, in order:

1. The workspace owner and workspace admins are always studio admins (they
   can't be lowered, on the workspace or on any site).
2. A per-site override (``docs_site_members``) for that site, which can raise
   or lower: an editor on the Help center only, or none on an internal site.
3. The person's studio role in the workspace (``docs_studio_members``).
4. Otherwise none.

Only current workspace members have any of this: membership is checked at
read time (a row for someone who left gives nothing) and their rows are
deleted when they leave (:func:`member_left`). A personal site (no workspace)
is its owner's alone, as admin.

Every change to a role is written to ``docs_events`` (docs_role_granted /
docs_role_changed / docs_role_removed, the actor in ``user_id`` and the
person in ``meta.target_user_id``): the Members screen's history.

This module is the one place a role is decided; docs_site_store.load_site and
the listings call :func:`resolve` / :func:`resolve_many`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

log = logging.getLogger("markdrop.docs_studio_roles")

STUDIO_MEMBERS = "docs_studio_members"
SITE_MEMBERS = "docs_site_members"
EVENTS = "docs_events"
MIGRATIONS = "docs_migrations"

ROLES = ("admin", "reviewer", "editor", "viewer")
GRANTABLE = ROLES + ("none",)
# "owner" is the old name of a personal site's / workspace owner's role; it ranks as admin.
ROLE_RANK = {"viewer": 0, "editor": 1, "reviewer": 2, "admin": 3, "owner": 3}

# Where an effective role came from (the Members screen shows it).
SRC_PERSONAL = "personal"          # a personal site's owner
SRC_WS_OWNER = "workspace_owner"   # the workspace owner: always admin
SRC_WS_ADMIN = "workspace_admin"   # a workspace admin: always admin
SRC_SITE = "site"                  # a per-site override
SRC_GRANT = "workspace"            # their studio role in the workspace
SRC_NONE = "none"

EV_GRANTED, EV_CHANGED, EV_REMOVED = "docs_role_granted", "docs_role_changed", "docs_role_removed"
LEGACY_GRANTOR = "system:legacy"
_LEGACY_MARKER = "studio_roles_v1"
_LEGACY_MAP = {"member": "editor", "viewer": "viewer"}


def now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def role_at_least(role: str | None, need: str) -> bool:
    return role is not None and ROLE_RANK.get(role, -1) >= ROLE_RANK[need]


def locked_source(ws_role: str | None) -> str | None:
    """The workspace owner and admins are studio admins whatever is stored."""
    if ws_role == "owner":
        return SRC_WS_OWNER
    if ws_role == "admin":
        return SRC_WS_ADMIN
    return None


@dataclass(frozen=True)
class Resolved:
    role: str | None   # admin / reviewer / editor / viewer, or None (no access)
    source: str


NO_ACCESS = Resolved(None, SRC_NONE)


# ── Indexes ───────────────────────────────────────────────────────────────────


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[STUDIO_MEMBERS].create_index([("workspace_id", 1), ("user_id", 1)], unique=True)
    await db[STUDIO_MEMBERS].create_index([("user_id", 1)])
    await db[SITE_MEMBERS].create_index([("site_id", 1), ("user_id", 1)], unique=True)
    await db[SITE_MEMBERS].create_index([("workspace_id", 1), ("user_id", 1)])
    await db[SITE_MEMBERS].create_index([("user_id", 1)])


# ── Resolution ────────────────────────────────────────────────────────────────


async def _ws_role(db: AsyncIOMotorDatabase, workspace_id: str, user_id: str) -> str | None:
    raw = await db["memberships"].find_one({"workspace_id": workspace_id, "user_id": user_id}, {"role": 1})
    return raw["role"] if raw else None


async def workspace_role(db: AsyncIOMotorDatabase, workspace_id: str, user_id: str | None,
                         ws_role: str | None = None) -> Resolved:
    """The caller's studio role across a workspace (before any site's override)."""
    if not user_id:
        return NO_ACCESS
    ws_role = ws_role if ws_role is not None else await _ws_role(db, workspace_id, user_id)
    if ws_role is None:
        return NO_ACCESS
    src = locked_source(ws_role)
    if src:
        return Resolved("admin", src)
    grant = await db[STUDIO_MEMBERS].find_one({"workspace_id": workspace_id, "user_id": user_id}, {"role": 1})
    if grant and grant.get("role") in ROLES:
        return Resolved(grant["role"], SRC_GRANT)
    return NO_ACCESS


async def resolve(db: AsyncIOMotorDatabase, site: dict, user_id: str | None) -> Resolved:
    """The caller's effective studio role on one site."""
    if not user_id:
        return NO_ACCESS
    wid = site.get("workspace_id")
    if not wid:
        return Resolved("admin", SRC_PERSONAL) if site.get("owner_id") == user_id else NO_ACCESS
    ws_role = await _ws_role(db, wid, user_id)
    if ws_role is None:
        return NO_ACCESS
    src = locked_source(ws_role)
    if src:
        return Resolved("admin", src)
    override = await db[SITE_MEMBERS].find_one({"site_id": site["_id"], "user_id": user_id}, {"role": 1})
    if override is not None:
        role = override.get("role")
        return Resolved(role, SRC_SITE) if role in ROLES else Resolved(None, SRC_SITE)
    return await workspace_role(db, wid, user_id, ws_role)


async def resolve_many(db: AsyncIOMotorDatabase, user_id: str, rows: list[dict],
                       ws_roles: dict[str, str]) -> dict[Any, Resolved]:
    """Effective roles for many sites at once (the listings): ``ws_roles`` is the caller's
    workspace role per workspace id (their current memberships). Keyed by site ``_id``."""
    ws_ids = list({r["workspace_id"] for r in rows if r.get("workspace_id") and r["workspace_id"] in ws_roles})
    grants = {g["workspace_id"]: g.get("role") for g in await db[STUDIO_MEMBERS].find(
        {"user_id": user_id, "workspace_id": {"$in": ws_ids}}, {"workspace_id": 1, "role": 1}).to_list(length=None)}
    site_ids = [r["_id"] for r in rows if r.get("workspace_id")]
    overrides = {o["site_id"]: o.get("role") for o in await db[SITE_MEMBERS].find(
        {"user_id": user_id, "site_id": {"$in": site_ids}}, {"site_id": 1, "role": 1}).to_list(length=None)}
    out: dict[Any, Resolved] = {}
    for r in rows:
        wid = r.get("workspace_id")
        if not wid:
            out[r["_id"]] = Resolved("admin", SRC_PERSONAL) if r.get("owner_id") == user_id else NO_ACCESS
            continue
        ws_role = ws_roles.get(wid)
        if ws_role is None:
            out[r["_id"]] = NO_ACCESS
            continue
        src = locked_source(ws_role)
        if src:
            out[r["_id"]] = Resolved("admin", src)
        elif r["_id"] in overrides:
            role = overrides[r["_id"]]
            out[r["_id"]] = Resolved(role if role in ROLES else None, SRC_SITE)
        elif grants.get(wid) in ROLES:
            out[r["_id"]] = Resolved(grants[wid], SRC_GRANT)
        else:
            out[r["_id"]] = NO_ACCESS
    return out


async def workspace_roles_for(db: AsyncIOMotorDatabase, user_id: str, ws_roles: dict[str, str]) -> dict[str, Resolved]:
    """The caller's studio role in each of their workspaces (``ws_roles``: workspace id → role)."""
    grants = {g["workspace_id"]: g.get("role") for g in await db[STUDIO_MEMBERS].find(
        {"user_id": user_id, "workspace_id": {"$in": list(ws_roles)}}, {"workspace_id": 1, "role": 1}
    ).to_list(length=None)}
    out: dict[str, Resolved] = {}
    for wid, ws_role in ws_roles.items():
        src = locked_source(ws_role)
        if src:
            out[wid] = Resolved("admin", src)
        elif grants.get(wid) in ROLES:
            out[wid] = Resolved(grants[wid], SRC_GRANT)
        else:
            out[wid] = NO_ACCESS
    return out


# ── People (the Members and People screens) ───────────────────────────────────


async def _users(db: AsyncIOMotorDatabase, ids: Iterable[str | None]) -> dict[str, dict]:
    oids = []
    for i in {i for i in ids if i}:
        try:
            oids.append(ObjectId(i))
        except Exception:
            continue
    if not oids:
        return {}
    rows = await db["users"].find({"_id": {"$in": oids}}, {"name": 1, "email": 1, "picture": 1}).to_list(length=None)
    return {str(r["_id"]): r for r in rows}


def _name(users: dict[str, dict], uid: str | None, fallback: str | None = None) -> str | None:
    if not uid:
        return None
    if uid == LEGACY_GRANTOR:
        return "Markdrop"
    u = users.get(uid) or {}
    return u.get("name") or u.get("email") or fallback


def _grantor_ids(*rows: dict | None) -> list[str]:
    return [r.get("granted_by") for r in rows if r and r.get("granted_by")]


async def _memberships(db: AsyncIOMotorDatabase, workspace_id: str) -> list[dict]:
    rows = await db["memberships"].find({"workspace_id": workspace_id}).to_list(length=1000)
    rows.sort(key=lambda r: (0 if r["role"] == "owner" else 1 if r["role"] == "admin" else 2, r.get("created_at") or now()))
    return rows


def _person(m: dict, users: dict[str, dict]) -> dict:
    u = users.get(m["user_id"]) or {}
    return {
        "user_id": m["user_id"],
        "name": u.get("name") or m.get("name") or u.get("email") or m.get("email") or "Someone",
        "email": u.get("email") or m.get("email"),
        "picture": u.get("picture"),
        "workspace_role": m["role"],
    }


async def workspace_members(db: AsyncIOMotorDatabase, workspace_id: str) -> list[dict]:
    """Every current workspace member with their studio role, where it comes from, who granted it
    and when, and their per-site overrides."""
    members = await _memberships(db, workspace_id)
    ids = [m["user_id"] for m in members]
    grants = {g["user_id"]: g for g in await db[STUDIO_MEMBERS].find(
        {"workspace_id": workspace_id, "user_id": {"$in": ids}}).to_list(length=None)}
    sites = {s["_id"]: s.get("name") for s in await db["docs_sites"].find(
        {"workspace_id": workspace_id, "deleted_at": None}, {"name": 1}).to_list(length=None)}
    overrides: dict[str, list[dict]] = {}
    for o in await db[SITE_MEMBERS].find({"workspace_id": workspace_id, "user_id": {"$in": ids},
                                          "site_id": {"$in": list(sites)}}).to_list(length=None):
        overrides.setdefault(o["user_id"], []).append(
            {"site_id": str(o["site_id"]), "site_name": sites.get(o["site_id"]), "role": o.get("role")})
    users = await _users(db, ids + _grantor_ids(*grants.values()))
    out = []
    for m in members:
        g = grants.get(m["user_id"])
        src = locked_source(m["role"])
        if src:
            role = "admin"
        elif g and g.get("role") in ROLES:
            role, src = g["role"], SRC_GRANT
        else:
            role, src = "none", SRC_NONE
        out.append({
            **_person(m, users),
            "role": role,
            "source": src,
            "locked": locked_source(m["role"]) is not None,
            "granted_by": None if locked_source(m["role"]) else (g or {}).get("granted_by"),
            "granted_by_name": None if locked_source(m["role"]) else _name(users, (g or {}).get("granted_by")),
            "granted_at": None if locked_source(m["role"]) else _aware((g or {}).get("granted_at")),
            "site_overrides": sorted(overrides.get(m["user_id"], []), key=lambda o: o["site_name"] or ""),
        })
    return out


async def site_members(db: AsyncIOMotorDatabase, site: dict) -> list[dict]:
    """The site's people: every current workspace member with their workspace-wide studio role,
    the site's override for them (if any) and the role that results."""
    wid = site.get("workspace_id")
    if not wid:
        owner = site.get("owner_id")
        users = await _users(db, [owner])
        p = _person({"user_id": owner, "role": "owner"}, users)
        return [{**p, "workspace_role": None, "studio_role": "admin", "studio_source": SRC_PERSONAL,
                 "override": None, "override_by": None, "override_by_name": None, "override_at": None,
                 "effective_role": "admin", "source": SRC_PERSONAL, "locked": True}]
    members = await _memberships(db, wid)
    ids = [m["user_id"] for m in members]
    grants = {g["user_id"]: g.get("role") for g in await db[STUDIO_MEMBERS].find(
        {"workspace_id": wid, "user_id": {"$in": ids}}).to_list(length=None)}
    overrides = {o["user_id"]: o for o in await db[SITE_MEMBERS].find(
        {"site_id": site["_id"], "user_id": {"$in": ids}}).to_list(length=None)}
    users = await _users(db, ids + _grantor_ids(*overrides.values()))
    out = []
    for m in members:
        lock = locked_source(m["role"])
        if lock:
            studio, studio_src = "admin", lock
        elif grants.get(m["user_id"]) in ROLES:
            studio, studio_src = grants[m["user_id"]], SRC_GRANT
        else:
            studio, studio_src = "none", SRC_NONE
        o = None if lock else overrides.get(m["user_id"])
        if o is not None:
            effective, src = (o.get("role") if o.get("role") in ROLES else "none"), SRC_SITE
        else:
            effective, src = studio, studio_src
        out.append({
            **_person(m, users),
            "studio_role": studio,
            "studio_source": studio_src,
            "override": o.get("role") if o else None,
            "override_by": o.get("granted_by") if o else None,
            "override_by_name": _name(users, o.get("granted_by")) if o else None,
            "override_at": _aware(o.get("granted_at")) if o else None,
            "effective_role": effective,
            "source": src,
            "locked": lock is not None,
        })
    return out


# ── Changes ───────────────────────────────────────────────────────────────────


async def _event(db: AsyncIOMotorDatabase, kind: str, *, actor_id: str | None, workspace_id: str | None,
                 site_id: ObjectId | None, target_user_id: str, role: str | None, previous: str | None,
                 scope: str, **extra: Any) -> None:
    try:
        await db[EVENTS].insert_one({
            "kind": kind, "site_id": site_id, "workspace_id": workspace_id, "user_id": actor_id, "ts": now(),
            "meta": {"scope": scope, "target_user_id": target_user_id, "role": role, "previous": previous, **extra},
        })
    except Exception:  # pragma: no cover - the audit row must not fail the change
        log.warning("docs role event write failed", exc_info=True)


def _check_role(role: str) -> str:
    if role not in GRANTABLE:
        raise HTTPException(status_code=422, detail=f"Choose one of: {', '.join(GRANTABLE)}.")
    return role


async def check_target(db: AsyncIOMotorDatabase, workspace_id: str, user_id: str, actor_id: str) -> str:
    """The target's workspace role, refusing non-members, the locked owner/admins and yourself."""
    ws_role = await _ws_role(db, workspace_id, user_id)
    if ws_role is None:
        raise HTTPException(status_code=404, detail="That person isn't in this workspace. Invite them to the "
                                                    "workspace first, then give them a Guides role.")
    if locked_source(ws_role):
        who = "The workspace owner is" if ws_role == "owner" else "Workspace admins are"
        raise HTTPException(status_code=422, detail=f"{who} always a Guides admin.")
    if user_id == actor_id:
        raise HTTPException(status_code=422, detail="You can't change your own role. Ask another admin.")
    return ws_role


# ── Members-only sites: a reader who loses access is signed out ───────────────
#
# A members-only site's reader holds a 12-hour edge session, minted when their role was checked.
# When someone's effective role on such a site drops to none (they left the workspace, their studio
# role went, a site override hides it, a workspace admin was demoted), the site's policy version is
# bumped (docs_site_access.revoke_sessions): every session of the old version stops working and the
# others sign in again, while this person no longer can.


async def members_sites(db: AsyncIOMotorDatabase, workspace_id: str) -> list[dict]:
    """The workspace's members-only docs sites (the only level whose readers are workspace members)."""
    return await db["docs_sites"].find(
        {"workspace_id": workspace_id, "deleted_at": None, "settings.access.level": "members"},
        {"workspace_id": 1, "owner_id": 1}).to_list(length=None)


async def readable(db: AsyncIOMotorDatabase, sites: list[dict], user_id: str) -> set:
    """Ids of the ``sites`` this person may read now (any studio role)."""
    return {s["_id"] for s in sites if (await resolve(db, s, user_id)).role is not None}


async def revoke_lost(db: AsyncIOMotorDatabase, sites: list[dict], before: set, user_id: str, reason: str) -> list:
    """Sign readers out of every site in ``before`` this person can't read any more."""
    from app.services import docs_site_access

    after = await readable(db, sites, user_id)
    lost = [s["_id"] for s in sites if s["_id"] in before and s["_id"] not in after]
    for sid in lost:
        await docs_site_access.revoke_sessions(db, sid, reason)
    return lost


async def set_workspace_role(db: AsyncIOMotorDatabase, workspace_id: str, user_id: str, role: str,
                             actor_id: str) -> None:
    """Give a workspace member a studio role ("none" removes it). Audited when it changes."""
    _check_role(role)
    await check_target(db, workspace_id, user_id, actor_id)
    sites = await members_sites(db, workspace_id)
    before = await readable(db, sites, user_id)
    await _set_workspace_role(db, workspace_id, user_id, role, actor_id)
    await revoke_lost(db, sites, before, user_id, "role_changed")


async def _set_workspace_role(db: AsyncIOMotorDatabase, workspace_id: str, user_id: str, role: str,
                              actor_id: str) -> None:
    before = await db[STUDIO_MEMBERS].find_one({"workspace_id": workspace_id, "user_id": user_id})
    previous = (before or {}).get("role")
    if role == "none":
        if before is None:
            return
        await db[STUDIO_MEMBERS].delete_one({"_id": before["_id"]})
        await _event(db, EV_REMOVED, actor_id=actor_id, workspace_id=workspace_id, site_id=None,
                     target_user_id=user_id, role=None, previous=previous, scope="workspace")
        return
    if previous == role:
        return
    try:
        await db[STUDIO_MEMBERS].update_one(
            {"workspace_id": workspace_id, "user_id": user_id},
            {"$set": {"role": role, "granted_by": actor_id, "granted_at": now()}}, upsert=True)
    except DuplicateKeyError:  # pragma: no cover - a concurrent first grant; this one wins
        await db[STUDIO_MEMBERS].update_one(
            {"workspace_id": workspace_id, "user_id": user_id},
            {"$set": {"role": role, "granted_by": actor_id, "granted_at": now()}})
    await _event(db, EV_CHANGED if before else EV_GRANTED, actor_id=actor_id, workspace_id=workspace_id,
                 site_id=None, target_user_id=user_id, role=role, previous=previous, scope="workspace")


async def set_site_override(db: AsyncIOMotorDatabase, site: dict, user_id: str, role: str, actor_id: str) -> None:
    """This site's role for a workspace member, whatever their workspace-wide one ("none" hides it)."""
    _check_role(role)
    wid = site.get("workspace_id")
    if not wid:
        raise HTTPException(status_code=422, detail="A personal guide has only its owner.")
    await check_target(db, wid, user_id, actor_id)
    could_read = await readable(db, [site], user_id)
    before = await db[SITE_MEMBERS].find_one({"site_id": site["_id"], "user_id": user_id})
    previous = (before or {}).get("role")
    if before is not None and previous == role:
        return
    await _set_site_override(db, site, wid, user_id, role, actor_id, before, previous)
    await revoke_lost(db, await _members_only(db, site), could_read, user_id, "role_changed")


async def _members_only(db: AsyncIOMotorDatabase, site: dict) -> list[dict]:
    """[site] when it is a members-only site (read fresh), else []."""
    row = await db["docs_sites"].find_one({"_id": site["_id"], "deleted_at": None, "settings.access.level": "members"},
                                          {"workspace_id": 1, "owner_id": 1})
    return [row] if row else []


async def _set_site_override(db: AsyncIOMotorDatabase, site: dict, wid: str, user_id: str, role: str, actor_id: str,
                             before: dict | None, previous: str | None) -> None:
    try:
        await db[SITE_MEMBERS].update_one(
            {"site_id": site["_id"], "user_id": user_id},
            {"$set": {"role": role, "workspace_id": wid, "granted_by": actor_id, "granted_at": now()}}, upsert=True)
    except DuplicateKeyError:  # pragma: no cover
        await db[SITE_MEMBERS].update_one(
            {"site_id": site["_id"], "user_id": user_id},
            {"$set": {"role": role, "workspace_id": wid, "granted_by": actor_id, "granted_at": now()}})
    await _event(db, EV_CHANGED if before else EV_GRANTED, actor_id=actor_id, workspace_id=wid,
                 site_id=site["_id"], target_user_id=user_id, role=role, previous=previous, scope="site")


async def remove_site_override(db: AsyncIOMotorDatabase, site: dict, user_id: str, actor_id: str) -> None:
    """Back to their workspace-wide studio role on this site."""
    wid = site.get("workspace_id")
    if not wid:
        raise HTTPException(status_code=422, detail="A personal guide has only its owner.")
    await check_target(db, wid, user_id, actor_id)
    could_read = await readable(db, [site], user_id)
    before = await db[SITE_MEMBERS].find_one_and_delete({"site_id": site["_id"], "user_id": user_id})
    if before is not None:
        await _event(db, EV_REMOVED, actor_id=actor_id, workspace_id=wid, site_id=site["_id"],
                     target_user_id=user_id, role=None, previous=before.get("role"), scope="site")
        await revoke_lost(db, await _members_only(db, site), could_read, user_id, "role_changed")


# ── History ───────────────────────────────────────────────────────────────────


async def history(db: AsyncIOMotorDatabase, *, workspace_id: str | None = None, site_id: ObjectId | None = None,
                  limit: int = 50) -> list[dict]:
    """Who granted what to whom, and when: newest first."""
    q: dict = {"kind": {"$in": [EV_GRANTED, EV_CHANGED, EV_REMOVED]}}
    if site_id is not None:
        q["site_id"] = site_id
    elif workspace_id is not None:
        q["workspace_id"] = workspace_id
    rows = await db[EVENTS].find(q).sort("ts", -1).to_list(length=limit)
    sids = list({r["site_id"] for r in rows if r.get("site_id")})
    sites = {s["_id"]: s.get("name") for s in await db["docs_sites"].find(
        {"_id": {"$in": sids}}, {"name": 1}).to_list(length=None)} if sids else {}
    users = await _users(db, [r.get("user_id") for r in rows] + [(r.get("meta") or {}).get("target_user_id") for r in rows])
    out = []
    for r in rows:
        meta = r.get("meta") or {}
        out.append({
            "kind": r["kind"],
            "at": _aware(r.get("ts")),
            "actor_id": r.get("user_id"),
            "actor_name": _name(users, r.get("user_id"), "Someone"),
            "target_user_id": meta.get("target_user_id"),
            "target_name": _name(users, meta.get("target_user_id"), "Someone"),
            "scope": meta.get("scope"),
            "site_id": str(r["site_id"]) if r.get("site_id") else None,
            "site_name": sites.get(r.get("site_id")),
            "role": meta.get("role"),
            "previous": meta.get("previous"),
            "reason": meta.get("reason"),
        })
    return out


# ── Lifecycle ─────────────────────────────────────────────────────────────────


async def member_left(db: AsyncIOMotorDatabase, workspace_id: str, user_id: str,
                      actor_id: str | None = None, *, could_read: set | None = None) -> int:
    """Someone left (or was removed from) the workspace: all their studio access there goes.
    (Read time already ignores their rows; this deletes them, audited.) Every members-only site
    they could read signs its readers out (``could_read``: those site ids, taken before the
    membership went; None: every members-only site of the workspace)."""
    sites = await members_sites(db, workspace_id)
    before = could_read if could_read is not None else {s["_id"] for s in sites}
    removed = await _drop_member_rows(db, workspace_id, user_id, actor_id)
    await revoke_lost(db, sites, before, user_id, "member_left")
    return removed


async def _drop_member_rows(db: AsyncIOMotorDatabase, workspace_id: str, user_id: str, actor_id: str | None) -> int:
    removed = 0
    grant = await db[STUDIO_MEMBERS].find_one_and_delete({"workspace_id": workspace_id, "user_id": user_id})
    if grant is not None:
        removed += 1
        await _event(db, EV_REMOVED, actor_id=actor_id, workspace_id=workspace_id, site_id=None,
                     target_user_id=user_id, role=None, previous=grant.get("role"), scope="workspace",
                     reason="left_workspace")
    for o in await db[SITE_MEMBERS].find({"workspace_id": workspace_id, "user_id": user_id}).to_list(length=None):
        await db[SITE_MEMBERS].delete_one({"_id": o["_id"]})
        removed += 1
        await _event(db, EV_REMOVED, actor_id=actor_id, workspace_id=workspace_id, site_id=o["site_id"],
                     target_user_id=user_id, role=None, previous=o.get("role"), scope="site",
                     reason="left_workspace")
    return removed


async def workspace_deleted(db: AsyncIOMotorDatabase, workspace_id: str) -> None:
    await db[STUDIO_MEMBERS].delete_many({"workspace_id": workspace_id})
    await db[SITE_MEMBERS].delete_many({"workspace_id": workspace_id})


async def carry_over_legacy_roles(db: AsyncIOMotorDatabase) -> int:
    """Once, when studio roles arrive: members of a workspace that already has docs sites keep the
    access the old workspace-role mapping gave them (member → editor, viewer → viewer), as studio
    grants by "Markdrop", so nobody loses access on deploy. Idempotent: a marker row stops reruns
    and every grant is insert-only (an existing grant is never touched)."""
    if await db[MIGRATIONS].find_one({"_id": _LEGACY_MARKER}):
        return 0
    granted = 0
    ws_ids = [w for w in await db["docs_sites"].distinct("workspace_id", {"deleted_at": None}) if w]
    at = now()
    for wid in ws_ids:
        async for m in db["memberships"].find({"workspace_id": wid, "role": {"$in": list(_LEGACY_MAP)}}):
            try:
                res = await db[STUDIO_MEMBERS].update_one(
                    {"workspace_id": wid, "user_id": m["user_id"]},
                    {"$setOnInsert": {"role": _LEGACY_MAP[m["role"]], "granted_by": LEGACY_GRANTOR,
                                      "granted_at": at}},
                    upsert=True)
                granted += 1 if res.upserted_id is not None else 0
            except DuplicateKeyError:  # another API worker got there first
                continue
    try:
        await db[MIGRATIONS].insert_one({"_id": _LEGACY_MARKER, "at": at, "granted": granted,
                                         "workspaces": len(ws_ids)})
    except DuplicateKeyError:
        pass
    return granted
