"""Preview a workspace folder as someone else (simpler workspaces UI).

``GET /api/v1/workspaces/{id}/preview?folder=&as=anyone|member|email&email=``

Presents access, never changes it: every "would they see it?" is
``access.can(target, doc, "read")`` for a *synthetic* actor —

* ``anyone`` — the anonymous visitor (a link, signed out);
* ``member`` — a generic **viewer** member of the workspace: no grants, owns
  nothing (the least a member can be);
* ``email``  — the account with that address, or, when there is none, a
  signed-in nobody holding only that address's grants (what they would see
  after signing up with it). Admin+ only: it reveals someone's grants.

Leak rules: only rows the **caller** can list are ever considered (their
readable rows, plus the redacted rows a workspace admin gets per Q1, which stay
redacted: no slug, no title). A document the target could open but the caller
can't is simply absent. Subfolders count only items both can open.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone

from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.models.user import User
from app.services import access
from app.services import folder as folder_service
from app.services.workspace_items import display_title

AS_VALUES = ("anyone", "member", "email")


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def target_actor(db: AsyncIOMotorDatabase, workspace_id: str, as_: str,
                       email: str | None) -> tuple[access.Actor, access.Ctx]:
    """The synthetic actor (and a context of its own, so nothing cached for the
    caller leaks into its decisions)."""
    tctx = access.Ctx(db, surface="preview")
    if as_ == "anyone":
        return access.Actor(), tctx
    if as_ == "member":
        uid = f"preview-member-{secrets.token_hex(6)}"
        user = User(id=uid, email="", created_at=_now(), updated_at=_now())
        tctx._roles[(workspace_id, uid)] = "viewer"
        return access.Actor.of(user), tctx
    address = access.normalize_email(email)
    row = await db["users"].find_one({"email": {"$in": list({address, (email or "").strip().lower()})}})
    if row is not None:
        from app.services.user import _user_from_mongo

        return access.Actor.of(_user_from_mongo(row)), tctx
    uid = f"preview-email-{secrets.token_hex(6)}"
    return access.Actor.of(User(id=uid, email=address, created_at=_now(), updated_at=_now())), tctx


def _reason(raw: dict, decision: access.Decision, target: access.Actor, require_auth: bool) -> str:
    if decision.gate == "password":
        return "password"
    level = raw.get("access_level") or "link"
    if level == "private":
        return "people"
    if level == "workspace":
        return "team"
    if require_auth:
        # A link item in a sign-in workspace: signing in is what an anonymous
        # visitor lacks; a signed-in outsider still isn't on the team.
        return "signin" if target.user is None else "team"
    if raw.get("read_password_hash"):
        return "password"
    return "people"


async def preview(db: AsyncIOMotorDatabase, caller: access.Actor, ctx: access.Ctx,
                  workspace_id: str, folder_ref: str | None, as_: str,
                  email: str | None) -> dict:
    ws = await ctx.workspace(workspace_id)
    if ws is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    folders = await folder_service.list_folders(db, workspace_id)
    paths = folder_service.paths_by_id(folders)
    if folder_ref in (None, "", "root"):
        folder_id = None
        folder_out = {"id": None, "name": ws.name, "path": ""}
    else:
        raw_folder = await folder_service._get_owned(db, workspace_id, folder_ref)
        folder_id = str(raw_folder["_id"])
        folder_out = {"id": folder_id, "name": raw_folder["name"],
                      "path": "/".join(paths.get(folder_id) or [])}

    target, tctx = await target_actor(db, workspace_id, as_, email)
    require_auth = bool(ws.settings.require_auth_to_view)

    # The caller's own readable rows below this folder (never anything else).
    rf = await access.readable_filter(caller, workspace_id, ctx)
    if folder_id is None:
        scope_ids = None
        below: dict = {}
    else:
        scope_ids = folder_service.subtree_ids(folders, folder_id)
        below = {"folder_id": {"$in": scope_ids}}
    rows = await db["documents"].find(rf.query(below)).to_list(length=50_000)

    async def opens(raw: dict) -> access.Decision:
        return await access.can(target, raw, "read", tctx)

    visible_ids: set = set()
    decisions: dict = {}
    for r in rows:
        d = await opens(r)
        decisions[r["_id"]] = d
        if d.allowed:
            visible_ids.add(r["_id"])

    # ── Items directly in this folder ──
    here = [r for r in rows if (r.get("folder_id") or None) == folder_id]
    here.sort(key=lambda r: r.get("updated_at") or _now(), reverse=True)
    visible_items: list[dict] = []
    hidden: list[dict] = []
    # "Would switching it to link let them in?" — asked of the same synthetic
    # target in a context of its own: cached facts are per document, and the
    # widened copy must not reuse (or poison) the real one's.
    wctx = access.Ctx(db, surface="preview")
    wctx._roles = dict(tctx._roles)
    for r in here:
        mine = bool(caller.user_id) and r.get("owner_id") == caller.user_id
        if r["_id"] in visible_ids:
            visible_items.append({"slug": r["slug"], "title": display_title(r),
                                  "kind": r.get("kind") or "markdown", "mime": r.get("mime"),
                                  "redacted": False})
            continue
        can_open_up = False
        if (await access.can(caller, r, "change_access", ctx)).allowed:
            widened = {**r, "access_level": "link"}
            can_open_up = (await access.can(target, widened, "read", wctx)).allowed
        hidden.append({"slug": r["slug"], "title": display_title(r),
                       "kind": r.get("kind") or "markdown", "mime": r.get("mime"),
                       "reason": _reason(r, decisions[r["_id"]], target, require_auth),
                       "yours": mine, "can_open_up": can_open_up, "folder_id": None})

    # Q1: an admin's redacted rows stay redacted (no slug, no title).
    redacted_total = 0
    rq = rf.redacted_query({"folder_id": folder_id})
    if rq is not None:
        for r in await db["documents"].find(rq).to_list(length=5000):
            redacted_total += 1
            if (await opens(r)).allowed:
                visible_items.append({"slug": None, "title": None,
                                      "kind": r.get("kind") or "markdown", "mime": None,
                                      "redacted": True})
            else:
                hidden.append({"slug": None, "title": None, "kind": r.get("kind") or "markdown",
                               "mime": None, "reason": "people", "yours": False,
                               "can_open_up": False, "folder_id": None})

    # ── Subfolders: shown when they hold ≥1 item both can open ──
    visible_folders: list[dict] = []
    children = sorted([f for f in folders if f.parent_id == folder_id], key=lambda f: f.name.lower())
    for f in children:
        sub = set(folder_service.subtree_ids(folders, f.id))
        n = sum(1 for r in rows if r.get("folder_id") in sub and r["_id"] in visible_ids)
        if n > 0:
            visible_folders.append({"id": f.id, "name": f.name,
                                    "path": "/".join(paths.get(f.id) or []), "item_count": n})
        else:
            hidden.append({"slug": None, "title": f.name, "kind": "folder", "mime": None,
                           "reason": "folder_empty", "yours": False, "can_open_up": False,
                           "folder_id": f.id})

    return {
        "as": as_,
        "folder": folder_out,
        "visible": {"folders": visible_folders, "items": visible_items},
        "hidden": hidden,
        "counts": {"visible": len(visible_items), "total": len(here) + redacted_total,
                   "folders_visible": len(visible_folders), "folders_total": len(children)},
    }
