"""Favorites: a person's starred pages, files, projects and teams, shown at the top of the sidebar (nav redesign
2026-11-10). Per user and workspace; listing re-checks access every time (a favorite you can no longer read
simply disappears from the list, it isn't revealed).

Collection ``favorites``: ``{user_id, workspace_id, kind: "doc"|"project"|"team", ref (slug | id), at}``.
"""

from __future__ import annotations

from datetime import datetime, timezone

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import access

COLL = "favorites"
MAX = 50
KINDS = ("doc", "project", "team")


class Refused(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status, self.detail = status, detail


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index([("user_id", 1), ("workspace_id", 1), ("kind", 1), ("ref", 1)], unique=True)
    await db[COLL].create_index([("user_id", 1), ("workspace_id", 1), ("at", -1)])


async def _doc(db: AsyncIOMotorDatabase, workspace_id: str, ref: str) -> dict | None:
    return await db["documents"].find_one({"slug": ref, "workspace_id": workspace_id, "deleted_at": None})


async def _visible(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, workspace_id: str, kind: str, ref: str) -> dict | None:
    """The row behind a favorite when the person may still see it (else None)."""
    from app.services import teams as T

    if kind == "doc":
        raw = await _doc(db, workspace_id, ref)
        if raw is None or not (await access.can(actor, raw, "read", ctx)).allowed or not await access.discoverable(actor, raw, ctx):
            return None
        return raw
    view = await ctx.team_view(workspace_id, actor.user_id)
    if kind == "team":
        t = view.teams.get(ref)
        return t if t is not None and ref in view.readable_teams else None
    p = view.projects.get(ref)
    return p if p is not None and ref in view.readable_projects else None


async def set_favorite(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, workspace_id: str,
                       kind: str, ref: str, on: bool) -> None:
    if kind not in KINDS:
        raise Refused(422, "kind must be doc, project or team")
    key = {"user_id": actor.user_id, "workspace_id": workspace_id, "kind": kind, "ref": ref}
    if not on:
        await db[COLL].delete_one(key)
        return
    if await _visible(db, actor, ctx, workspace_id, kind, ref) is None:
        raise Refused(404, "Not found.")
    if await db[COLL].count_documents({"user_id": actor.user_id, "workspace_id": workspace_id}) >= MAX:
        raise Refused(409, f"You can have {MAX} favorites in a workspace. Remove one first.")
    await db[COLL].update_one(key, {"$setOnInsert": {**key, "at": datetime.now(timezone.utc)}}, upsert=True)


async def list_favorites(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, workspace_id: str) -> list[dict]:
    """``[{kind, ref, title, href, icon, color?, editor?, kind_detail}]`` oldest first (the order they were starred)."""
    from app.services import artifact as art_service
    from app.services import teams as T
    from app.services.workspace_items import display_title

    out = []
    rows = await db[COLL].find({"user_id": actor.user_id, "workspace_id": workspace_id}).sort("at", 1).to_list(length=MAX)
    for f in rows:
        row = await _visible(db, actor, ctx, workspace_id, f["kind"], f["ref"])
        if row is None:
            continue
        if f["kind"] == "doc":
            is_art = row.get("kind") == "artifact"
            out.append({"kind": "doc", "ref": f["ref"], "title": display_title(row), "href": f"/{row['slug']}",
                        "icon": row.get("page_icon"), "editor": row.get("editor"), "doc_kind": row.get("kind") or "markdown",
                        "mime": row.get("mime") if is_art else None, "filename": row.get("original_filename") if is_art else None,
                        "renderer": art_service.renderer_for(row.get("mime") or "") if is_art else None})
        else:
            base = "teams" if f["kind"] == "team" else "projects"
            out.append({"kind": f["kind"], "ref": f["ref"], "title": row.get("name"), "icon": row.get("icon"),
                        "color": row.get("color"), "href": f"/w/{workspace_id}/{base}/{row.get('slug')}",
                        "general": T.is_general(row) if f["kind"] == "team" else False})
    return out
