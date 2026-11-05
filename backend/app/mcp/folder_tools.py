"""MCP tools that change a folder: ``rename_folder``, ``move_folder`` and
``delete_folder`` (create_folder and list_folders live in tools.py).

Each one is the app's own folder action (services/folder.update_folder, the
REST ``DELETE …/folders/{id}`` modes, services/trash.move_folder) with the
app's permission: a workspace admin or its owner. Nothing here re-implements a
rule.

* Renaming or moving re-addresses everything inside on the workspace's domain.
  Old addresses keep working: an item's old address redirects (its slug is its
  identity), and so does the folder's own (``old_paths``, services/folder.py).
  An address that something already holds where the folder would go is refused
  with what holds it, unless the caller asks for ``on_conflict: "suffix"``.
* Deleting a folder that holds anything is refused unless the caller says what
  happens to its contents; the refusal lists them (structuredContent). Only
  items the caller can open are named; the rest are counted (an admin sees
  them in the trash the same way).
"""

from __future__ import annotations

from fastapi import HTTPException

from app.mcp.auth import WRITE
from app.mcp.tools import (
    _NULLABLE_STR,
    _ON_CONFLICT_ARG,
    _WORKSPACE_ARG,
    Context,
    Tool,
    ToolError,
    _ann,
    _out,
    actor_of,
    audit_result,
    http_message,
    iso,
    resolve_workspace,
)
from app.services import access as access_service

SAMPLE = 10  # items and subfolders named in a refusal

_FOLDER_REF = {"type": "string", "minLength": 1, "maxLength": 400,
               "description": "The folder: its path like 'guides/setup' (see list_folders) or its id."}


async def _admin_workspace(ctx: Context, workspace: str, verb: str) -> tuple[str, object]:
    """The workspace, when the user administers it (the app's rule for
    renaming, moving and deleting folders)."""
    from app.models.workspace import role_allows

    ws_id, ws, role = await resolve_workspace(ctx, workspace)
    if not role_allows(role, "admin"):
        raise ToolError(f"Only the admins and the owner of {ws.name} can {verb} folders; the user is a "
                        f"{role} there.")
    return ws_id, ws


async def _folder(ctx: Context, ws_id: str, ref: str | None, *, target: bool = True) -> str:
    from app.services import folder as folder_service

    if not ref or ref.strip() in ("", "/"):
        raise ToolError("Name a folder: its path like 'guides/setup' or its id (see list_folders).")
    try:
        fid = await folder_service.resolve_ref(ctx.db, ws_id, ref)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    if target:
        audit_result(folder_id=fid)  # the audit row names the folder by id, never by name
    return fid


async def _folder_url(ctx: Context, ws_id: str, path: list[str]) -> str | None:
    from app.services import urls

    host = await urls.live_primary_host(ctx.db, ws_id)
    return f"https://{host}/{'/'.join(path)}" if host and path else None


def _clash(exc: HTTPException, on_conflict: str, what: str) -> ToolError:
    if exc.status_code == 409 and on_conflict == "error" and "Folders changed meanwhile" not in str(exc.detail):
        return ToolError(f"{http_message(exc)} Nothing was {what}. To use the next free address instead "
                         "(…-2), call again with on_conflict: \"suffix\".")
    return ToolError(http_message(exc))


async def _changed(ctx: Context, ws_id: str, fid: str, before: list[str], text: str,
                   asked: str | None = None) -> tuple[str, dict]:
    from app.services import folder as folder_service

    raw = await ctx.db["folders"].find_one({"_id": access_service.as_oid(fid)},
                                           {"name": 1, "slug": 1, "parent_id": 1, "old_paths": 1})
    after = await folder_service.path_of(ctx.db, ws_id, fid)
    out = {"workspace_id": ws_id, "folder_id": fid, "name": raw["name"], "slug": raw.get("slug") or fid,
           "path": "/".join(after), "previous_path": "/".join(before),
           "url": await _folder_url(ctx, ws_id, after),
           "redirects_from": [p for p in (raw.get("old_paths") or []) if isinstance(p, str)]}
    if after == before:
        return f"Nothing changed: the folder is already at {out['path']}.", out
    note = folder_service.suffixed_note(asked, out["slug"]) if asked else None
    if note:
        out["note"] = note
        text = f"{text} {note}"
    where = out["url"] or out["path"]
    return (f"{text} It is now at {where}. Its old address ({out['previous_path']}) and the old addresses of "
            "everything in it redirect to the new ones; markdrop.in links don't change."), out


async def rename_folder(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import folder as folder_service
    from app.services import revalidate

    ws_id, _ws = await _admin_workspace(ctx, args["workspace"], "rename")
    fid = await _folder(ctx, ws_id, args["path"])
    before = await folder_service.path_of(ctx.db, ws_id, fid)
    on_conflict = args.get("on_conflict") or "error"
    wanted = args.get("slug") or args["new_name"]
    # The address asked for, unless the rename keeps the current one (update_folder's rule).
    asked = (folder_service.base_slug(wanted) if on_conflict == "error" and before
             and not folder_service._same_address(wanted, before[-1]) else None)
    try:
        async with revalidate.batch(ctx.db):
            await folder_service.update_folder(
                ctx.db, ws_id, fid, name=args["new_name"], slug=args.get("slug") or None,
                on_conflict=on_conflict, actor=actor_of(ctx),
                ctx=access_service.Ctx(ctx.db, surface="mcp"))
    except HTTPException as exc:
        raise _clash(exc, on_conflict, "renamed")
    return await _changed(ctx, ws_id, fid, before, f"Renamed the folder to {args['new_name']!r}.", asked)


async def move_folder(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import folder as folder_service
    from app.services import revalidate

    ws_id, _ws = await _admin_workspace(ctx, args["workspace"], "move")
    fid = await _folder(ctx, ws_id, args["path"])
    target = (args.get("new_parent") or "").strip()
    parent_id = None if target in ("", "/") else await _folder(ctx, ws_id, target, target=False)
    before = await folder_service.path_of(ctx.db, ws_id, fid)
    on_conflict = args.get("on_conflict") or "error"
    try:
        async with revalidate.batch(ctx.db):
            await folder_service.update_folder(
                ctx.db, ws_id, fid, parent_id=parent_id, reparent=True, on_conflict=on_conflict,
                actor=actor_of(ctx), ctx=access_service.Ctx(ctx.db, surface="mcp"))
    except HTTPException as exc:
        raise _clash(exc, on_conflict, "moved")
    dest = "/".join(await folder_service.path_of(ctx.db, ws_id, parent_id)) if parent_id else None
    return await _changed(ctx, ws_id, fid, before,
                          f"Moved the folder {'into ' + dest if dest else 'to the top of the workspace'}.",
                          before[-1] if on_conflict == "error" and before else None)


async def _contents(ctx: Context, ws_id: str, fid: str) -> dict:
    """What a folder holds, at any depth: subfolders by path, items the user
    can open by title, the rest only counted."""
    from app.services import folder as folder_service
    from app.services import pages

    folders = await folder_service.list_folders(ctx.db, ws_id)
    ids = folder_service.subtree_ids(folders, fid)
    paths = folder_service.paths_by_id(folders)
    sub = sorted("/".join(paths.get(i) or []) for i in ids if i != fid)
    from app.services import workspace_items

    actor, actx = actor_of(ctx), access_service.Ctx(ctx.db, surface="mcp")
    every = await ctx.db["documents"].count_documents({"workspace_id": ws_id, "folder_id": {"$in": ids}})
    readable = await workspace_items.readable_rows(
        ctx.db, actor, actx, ws_id, {"folder_id": {"$in": ids}},
        projection={"slug": 1, "title": 1, "kind": 1, "editor": 1, "original_filename": 1,
                    "folder_path": 1, "updated_at": 1})
    readable.sort(key=lambda r: (r.get("updated_at") is not None, r.get("updated_at")), reverse=True)
    sample = [{**pages.deleted_item(r), "folder": "/".join(r.get("folder_path") or []) or None,
               "updated_at": iso(r.get("updated_at"))} for r in readable[:SAMPLE]]
    return {"folders": len(sub), "items": len(readable), "hidden_items": max(0, every - len(readable)),
            "subfolders": sub[:SAMPLE], "sample": sample, "total": every + len(sub)}


async def delete_folder(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import folder as folder_service
    from app.services import revalidate, trash

    ws_id, _ws = await _admin_workspace(ctx, args["workspace"], "delete")
    fid = await _folder(ctx, ws_id, args["path"])
    path = "/".join(await folder_service.path_of(ctx.db, ws_id, fid))
    mode = args.get("contents") or "refuse"
    inside = await _contents(ctx, ws_id, fid)
    total = inside.pop("total")
    base = {"workspace_id": ws_id, "folder_id": fid, "path": path}

    if total and mode == "refuse":
        parts = []
        if inside["folders"]:
            parts.append(f"{inside['folders']} folder(s): " + ", ".join(inside["subfolders"])
                         + (" …" if inside["folders"] > SAMPLE else ""))
        if inside["items"]:
            parts.append(f"{inside['items']} item(s) the user can open: "
                         + ", ".join(f"{i['title'] or i['slug']} ({i['kind']}, {i['slug']})" for i in inside["sample"])
                         + (" …" if inside["items"] > SAMPLE else ""))
        if inside["hidden_items"]:
            parts.append(f"{inside['hidden_items']} item(s) the user can't open")
        raise ToolError(
            f"The folder {path} isn't empty, so nothing was deleted. It holds " + "; ".join(parts) + ". "
            "Call again with contents: \"move_to_parent\" to move everything up into the folder above "
            "(or to the top of the workspace) and then delete the folder, or contents: \"trash\" to move the "
            "folder with everything in it to the trash (restorable for 30 days with restore_document).",
            data={**base, "deleted": False, "contents": inside, "result": None},
        )

    if mode == "move_to_parent" and total:
        parent = await ctx.db["folders"].find_one({"_id": access_service.as_oid(fid)}, {"parent_id": 1})
        parent_id = (parent or {}).get("parent_id")
        dest = "/".join(await folder_service.path_of(ctx.db, ws_id, parent_id)) if parent_id else None
        try:
            async with revalidate.batch(ctx.db):
                await folder_service.delete_folder(ctx.db, ws_id, fid, "move_up", actor=actor_of(ctx),
                                                   ctx=access_service.Ctx(ctx.db, surface="mcp"))
        except HTTPException as exc:
            raise ToolError(f"{http_message(exc)} Nothing was deleted.")
        out = {**base, "deleted": True, "contents": inside,
               "result": {"mode": "move_to_parent", "moved_to": dest, "trashed": False,
                          "restore_key": None}}
        return (f"Moved everything in {path} up into {dest or 'the top of the workspace'} and deleted the folder: "
                f"{inside['items'] + inside['hidden_items']} item(s) and {inside['folders']} folder(s) moved. Old "
                "addresses of the items redirect to their new ones."), out

    # Empty, or contents="trash": the app's Delete folder (to the trash for 30 days, restorable).
    try:
        res = await trash.move_folder(ctx.db, ws_id, fid, actor_of(ctx))
    except HTTPException as exc:
        raise ToolError(f"{http_message(exc)} Nothing was deleted.")
    out = {**base, "deleted": True, "contents": inside,
           "result": {"mode": "trash", "moved_to": None, "trashed": True, "restore_key": fid,
                      "trashed_documents": res["documents"], "trashed_folders": res["folders"]}}
    what = ("it was empty" if not total else
            f"with {inside['items'] + inside['hidden_items']} item(s) and {inside['folders']} folder(s) inside")
    return (f"Moved the folder {path} to the trash ({what}). It can be restored for 30 days: "
            f"restore_document with document \"{fid}\" brings it back with everything in it."), out


_FOLDER_CHANGE_OUT = _out({
    "workspace_id": {"type": "string"}, "folder_id": {"type": "string"}, "name": {"type": "string"},
    "slug": {"type": "string"}, "path": {"type": "string"}, "previous_path": {"type": "string"},
    "url": {**_NULLABLE_STR, "description": "The folder's address on the workspace's live domain, if any."},
    "redirects_from": {"type": "array", "items": {"type": "string"},
                       "description": "Former paths of this folder that redirect to it."},
    "note": {"type": "string", "description": "Set when the address had to be suffixed (an item the user "
                                              "can't open has it there)."},
}, ["workspace_id", "folder_id", "name", "slug", "path", "previous_path", "url", "redirects_from"])

FOLDER_TOOLS: list[Tool] = [
    Tool(
        name="rename_folder",
        title="Rename a folder",
        description=("Rename a workspace folder (workspace admins and the owner). The folder's address on the "
                     "workspace's domain follows the new name (or `slug` when given); its old address and the "
                     "old addresses of everything inside redirect to the new ones, and markdrop.in links don't "
                     "change. If the new address is already taken there (a page, document, file or another "
                     "folder), nothing changes and the error says what holds it; on_conflict: \"suffix\" takes "
                     "the next free address instead."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "workspace": _WORKSPACE_ARG,
            "path": _FOLDER_REF,
            "new_name": {"type": "string", "minLength": 1, "maxLength": 80, "description": "The new display name."},
            "slug": {"type": "string", "minLength": 1, "maxLength": 40,
                     "description": "Optional: the folder's address segment; by default made from the name."},
            "on_conflict": _ON_CONFLICT_ARG,
        }, "required": ["workspace", "path", "new_name"]},
        output_schema=_FOLDER_CHANGE_OUT,
        annotations=_ann(False, False, True),
        handler=rename_folder,
    ),
    Tool(
        name="move_folder",
        title="Move a folder",
        description=("Move a workspace folder, with everything in it, into another folder of the same workspace, "
                     "or to the top with new_parent \"/\" (workspace admins and the owner). Refused if it would "
                     "nest anything deeper than 8 levels or put a folder inside itself. Old addresses of the "
                     "folder and everything inside redirect to the new ones. If a folder or item in the "
                     "destination already has its address, nothing moves and the error says what holds it; "
                     "on_conflict: \"suffix\" takes the next free address instead."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "workspace": _WORKSPACE_ARG,
            "path": _FOLDER_REF,
            "new_parent": {"type": "string", "maxLength": 400,
                           "description": "The destination folder (path or id), or \"/\" for the top of the workspace."},
            "on_conflict": _ON_CONFLICT_ARG,
        }, "required": ["workspace", "path", "new_parent"]},
        output_schema=_FOLDER_CHANGE_OUT,
        annotations=_ann(False, False, True),
        handler=move_folder,
    ),
    Tool(
        name="delete_folder",
        title="Delete a folder",
        description=("Delete a workspace folder (workspace admins and the owner). An empty folder goes to the "
                     "trash (restorable for 30 days with restore_document, document = the folder id). A folder "
                     "that holds anything is refused unless `contents` says what to do, and the error lists what "
                     "is inside (subfolders, the items the user can open, and how many others there are): "
                     "\"move_to_parent\" moves its items and subfolders up into the folder above (or the top of "
                     "the workspace) and then deletes the folder; \"trash\" moves the folder with everything in it "
                     "to the trash, like the app's Delete folder, restorable together for 30 days."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "workspace": _WORKSPACE_ARG,
            "path": _FOLDER_REF,
            "contents": {"type": "string", "enum": ["refuse", "move_to_parent", "trash"], "default": "refuse",
                         "description": ("What happens to what's inside: \"refuse\" (default) deletes only an "
                                         "empty folder; \"move_to_parent\" or \"trash\".")},
        }, "required": ["workspace", "path"]},
        output_schema=_out({
            "workspace_id": {"type": "string"}, "folder_id": {"type": "string"}, "path": {"type": "string"},
            "deleted": {"type": "boolean"},
            "contents": _out({
                "folders": {"type": "integer"}, "items": {"type": "integer"},
                "hidden_items": {"type": "integer", "description": "Items inside the user can't open (not named)."},
                "subfolders": {"type": "array", "items": {"type": "string"}},
                "sample": {"type": "array", "items": {"type": "object"}},
            }),
            "result": {"type": ["object", "null"], "properties": {
                "mode": {"type": "string", "enum": ["move_to_parent", "trash"]},
                "moved_to": _NULLABLE_STR, "trashed": {"type": "boolean"},
                "restore_key": {**_NULLABLE_STR, "description": "restore_document's `document` for this folder."},
                "trashed_documents": {"type": "integer"}, "trashed_folders": {"type": "integer"},
            }},
        }),
        annotations=_ann(False, True, False),
        handler=delete_folder,
    ),
]
