"""What a link preview may say about a workspace or a folder.

Link crawlers (Slackbot, WhatsApp, iMessage…) are never signed in, so a
preview of ``markdrop.in/w/<ws>[/f/<folder>]`` or ``markdrop.in/f/<share>``
names only what a **signed-out visitor** could already learn. Folders never
grant (D2), so "could already learn" means one of the anonymous doors that
show a folder's or a workspace's name:

- the folder is shared with *anyone with the link* (``share.level == "link"``):
  its share page shows its name and the workspace's to anyone;
- a subfolder of such a share that holds at least one item an anonymous
  reader can open (the share page lists it);
- a folder of a workspace with a live custom domain that holds at least one
  item an anonymous reader can open (the domain's folder index lists it);
- a workspace's top level, when it has a live custom domain (the index of
  that domain shows it to anyone).

Everything else — a workspace that requires sign-in, a members-only share, a
folder holding only private, workspace-only or password-protected items, no
public door at all — is ``visible=False``: the caller draws a content-free
card and names nothing. A folder or workspace that doesn't exist is ``None``.
The decision mirrors ``routers/folder_pages.py`` (the doors themselves) and
uses the same readable filter, so the two cannot disagree about who sees what.
"""

from __future__ import annotations

from dataclasses import dataclass

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.models.folder import Folder
from app.services import access
from app.services import domain as domain_service
from app.services import folder as folder_service
from app.services import workspace as ws_service
from app.services import workspace_items as items_service


@dataclass
class Preview:
    visible: bool
    workspace: object | None = None   # models.workspace.Workspace, only when visible
    workspace_name: str | None = None
    folder_name: str | None = None
    items: int = 0
    host: str | None = None


HIDDEN = Preview(visible=False)


def display_name(ws) -> str:
    """The name a workspace shows the public: its site name, else its name."""
    return ((ws.branding.site_name or "").strip() or (ws.name or "").strip() or "Workspace")


async def _open_workspace(db: AsyncIOMotorDatabase, workspace_id: str):
    ws = await ws_service.get_workspace(db, workspace_id)
    if ws is None:
        return None
    raw = await db["workspaces"].find_one({"_id": ObjectId(ws.id)}, {"deleting": 1})
    if raw is None or raw.get("deleting"):
        return None
    return ws


async def _anonymous_totals(db: AsyncIOMotorDatabase, ws_id: str,
                            folders: list[Folder]) -> tuple[dict[str, int], int]:
    """(recursive readable count per folder, readable count in the workspace)
    for an anonymous reader — the exact filter the public folder pages use."""
    rows = await items_service.readable_rows(db, access.Actor(), access.Ctx(db), ws_id,
                                             projection={"folder_id": 1})
    _direct, total, _root = items_service.counts(rows, folders)
    return total, len(rows)


def _link_shared(f: Folder | None) -> bool:
    return bool(f and f.share and (f.share.get("level") or "link") == "link")


async def _folder(db: AsyncIOMotorDatabase, ws, folders: list[Folder], folder: Folder) -> Preview:
    if ws.settings.require_auth_to_view:
        return HIDDEN
    by_id = {f.id: f for f in folders}
    ancestors, cur = [], by_id.get(folder.parent_id) if folder.parent_id else None
    while cur is not None and len(ancestors) <= folder_service.MAX_DEPTH + 1:
        ancestors.append(cur)
        cur = by_id.get(cur.parent_id) if cur.parent_id else None
    total, _ = await _anonymous_totals(db, ws.id, folders)
    here = total.get(folder.id, 0)
    host = await domain_service.primary_host(db, ws.id)
    visible = _link_shared(folder) or (
        here > 0 and (host is not None or any(_link_shared(a) for a in ancestors)))
    if not visible:
        return HIDDEN
    return Preview(visible=True, workspace=ws, workspace_name=display_name(ws),
                   folder_name=folder.name, items=here, host=host)


async def for_folder(db: AsyncIOMotorDatabase, workspace_id: str, folder_id: str) -> Preview | None:
    ws = await _open_workspace(db, workspace_id)
    if ws is None:
        return None
    folders = await folder_service.list_folders(db, ws.id)
    folder = next((f for f in folders if f.id == folder_id), None)
    if folder is None:
        return None
    return await _folder(db, ws, folders, folder)


async def for_workspace(db: AsyncIOMotorDatabase, workspace_id: str) -> Preview | None:
    ws = await _open_workspace(db, workspace_id)
    if ws is None:
        return None
    if ws.settings.require_auth_to_view:
        return HIDDEN
    host = await domain_service.primary_host(db, ws.id)
    if host is None:
        return HIDDEN
    folders = await folder_service.list_folders(db, ws.id)
    _total, count = await _anonymous_totals(db, ws.id, folders)
    return Preview(visible=True, workspace=ws, workspace_name=display_name(ws), items=count, host=host)


async def for_share(db: AsyncIOMotorDatabase, share_id: str, path: str = "") -> Preview | None:
    """``markdrop.in/f/<share_id>[/<sub/path>]``: walked exactly as the share page walks it."""
    raw = await folder_service.find_share(db, share_id)
    if raw is None:
        return None
    ws = await _open_workspace(db, raw["workspace_id"])
    if ws is None:
        return None
    folders = await folder_service.list_folders(db, ws.id)
    target = next((f for f in folders if f.id == str(raw["_id"])), None)
    if target is None:
        return None
    for seg in [s for s in (path or "").strip("/").split("/") if s]:
        target = next((f for f in folders if f.parent_id == target.id and f.slug == seg), None)
        if target is None:
            return None
    if ((raw.get("share") or {}).get("level") or "link") != "link":
        return HIDDEN
    return await _folder(db, ws, folders, target)
