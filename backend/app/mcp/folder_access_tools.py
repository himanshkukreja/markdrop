"""MCP tools for who can open what's in a folder (services/folder_access.py):

* ``get_folder_access``: a folder's people and teams (and the folder above that names them), whether it is
  restricted, what new items start as, and the last changes.
* ``set_folder_access``: restrict a folder, set its people / teams, and what new items start as.
* ``share_folder``: give people and/or teams access to everything in a folder — one notification per person.

"Groups" are Markdrop **teams** (list_teams, create_team, add_team_members). Every rule is the app's own;
nothing here re-implements one.
"""

from __future__ import annotations

from fastapi import HTTPException

from app.mcp.auth import READ, WRITE
from app.mcp.tools import (
    _NULLABLE_STR,
    _WORKSPACE_ARG,
    Context,
    Tool,
    ToolError,
    _ann,
    _out,
    actor_of,
    audit_result,
    http_message,
    resolve_workspace,
)
from app.services import access as access_service
from app.services import folder_access as svc

_FOLDER_REF = {"type": "string", "minLength": 1, "maxLength": 400,
               "description": "The folder: its path like 'sales' or 'sales/q4' (see list_folders) or its id."}
_ROLE = {"type": "string", "enum": ["viewer", "editor"]}
_PEOPLE_ARG = {
    "type": "array", "maxItems": svc.MAX_PEOPLE,
    "items": {"type": "object", "properties": {
        "email": {"type": "string", "format": "email", "maxLength": 254},
        "role": {**_ROLE, "description": "Default viewer."}}, "required": ["email"]},
}
_TEAMS_ARG = {
    "type": "array", "maxItems": svc.MAX_TEAMS,
    "items": {"type": "object", "properties": {
        "team": {"type": "string", "maxLength": 80, "description": "The team's name, slug or id (see list_teams)."},
        "role": {**_ROLE, "description": "Default editor."}}, "required": ["team"]},
}
_DEFAULT_ARG = {"type": ["string", "null"], "enum": ["private", "folder", "workspace", "link", None],
                "description": ("What new items here start as: private (only the person who adds it and people "
                                "they add), folder (the folder's people and teams), workspace (everyone in the "
                                "workspace), link (anyone with the link). null: the workspace's default.")}

_ACCESS_OUT = _out({
    "workspace_id": {"type": "string"}, "folder_id": {"type": "string"}, "name": {"type": "string"},
    "path": {"type": "string"},
    "restricted": {"type": "boolean", "description": "Only its people and teams (plus item owners, people an item "
                                                     "is shared with, workspace admins) open what's inside."},
    "restricted_by": {**_NULLABLE_STR, "description": "The folder above that restricts it, when not itself."},
    "people": {"type": "array", "items": {"type": "object", "properties": {
        "email": {"type": "string"}, "name": _NULLABLE_STR, "role": {"type": "string"},
        "inherited_from": {**_NULLABLE_STR, "description": "The folder above that names them, if not this one."}}}},
    "teams": {"type": "array", "items": {"type": "object", "properties": {
        "id": {"type": "string"}, "name": {"type": "string"}, "role": {"type": "string"},
        "members": {"type": "integer"}, "inherited_from": _NULLABLE_STR}}},
    "default_access": _NULLABLE_STR,
    "effective_default_access": {"type": "string", "description": "What a new item filed here starts as."},
    "summary": {"type": "string"}, "can_manage": {"type": "boolean"},
    "job": {"type": ["object", "null"], "description": "Re-applying the change to a big folder's files: "
                                                       "{state, done, total}."},
}, ["workspace_id", "folder_id", "name", "path", "restricted", "people", "teams", "default_access",
    "effective_default_access", "summary", "can_manage"])


async def _ws_folder(ctx: Context, args: dict) -> tuple[str, object, str]:
    from app.services import folder as folder_service

    ws_id, ws, _role = await resolve_workspace(ctx, args["workspace"])
    ref = args.get("folder") or args.get("path")
    if not ref or str(ref).strip() in ("", "/"):
        raise ToolError("Name a folder: its path like 'sales' or its id (see list_folders). The top of a "
                        "workspace has no folder access of its own.")
    try:
        fid = await folder_service.resolve_ref(ctx.db, ws_id, ref)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    audit_result(folder_id=fid)
    return ws_id, ws, fid


def _strip(d: dict) -> dict:
    return {k: v for k, v in d.items() if k not in ("team_options", "log", "restricted_here")}


def _text(d: dict) -> str:
    lines = [f"{d['path'] or d['name']}: {d['summary']}"]
    for p in d["people"]:
        lines.append(f"- {p['email'] or p['name'] or 'Someone'}: can {'edit' if p['role'] == 'editor' else 'view'}"
                     + (f" (from {p['inherited_from']})" if p.get("inherited_from") else ""))
    for t in d["teams"]:
        lines.append(f"- {t['name']} team ({t['members']} people): can {'edit' if t['role'] == 'editor' else 'view'}"
                     + (f" (from {t['inherited_from']})" if t.get("inherited_from") else ""))
    lines.append(f"New items here start as: {d['effective_default_access']}"
                 + ("" if d.get("default_access") else " (the workspace's default)") + ".")
    if d.get("job") and d["job"]["state"] == "running":
        lines.append(f"Applying to files: {d['job']['done']} of {d['job']['total']} done.")
    return "\n".join(lines)


async def get_folder_access(ctx: Context, args: dict) -> tuple[str, dict]:
    ws_id, _ws, fid = await _ws_folder(ctx, args)
    actx = access_service.Ctx(ctx.db, surface="mcp")
    try:
        d = await svc.describe(ctx.db, actor_of(ctx), actx, ws_id, fid)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    return _text(d), _strip(d)


async def set_folder_access(ctx: Context, args: dict) -> tuple[str, dict]:
    ws_id, _ws, fid = await _ws_folder(ctx, args)
    keys = ("restricted", "people", "teams", "default_access", "add_people", "add_teams", "remove_people",
            "remove_teams")
    if not any(k in args for k in keys):
        raise ToolError("Give at least one of: restricted, people, teams, add_people, add_teams, remove_people, "
                        "remove_teams, default_access.")
    actor, actx = actor_of(ctx), access_service.Ctx(ctx.db, surface="mcp")
    kw: dict = {}
    for k in ("restricted", "people", "teams", "default_access"):
        if k in args:
            kw[k] = args[k]
    for k in ("add_people", "add_teams", "remove_people", "remove_teams"):
        if args.get(k):
            kw[k] = args[k]
    try:
        res = await svc.update(ctx.db, actor, actx, ws_id, fid, **kw)
        notified = {}
        if args.get("notify") and (res["added_people"] or res["added_teams"]):
            notified = await svc.notify_people(ctx.db, actor, actx, ws_id, fid, res["added_people"],
                                               res["added_teams"], message=args.get("message"),
                                               role=next((res["role_of"].get(e) for e in res["added_people"]), "editor"))
        actx.forget()
        d = await svc.describe(ctx.db, actor, actx, ws_id, fid)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    out = {**_strip(d), "notified": sorted(notified)}
    head = "Saved. " if res["changed"] or "default_access" in kw else "Nothing changed. "
    return head + _text(d) + (f"\nTold {len(notified)} people." if notified else ""), out


async def share_folder(ctx: Context, args: dict) -> tuple[str, dict]:
    ws_id, _ws, fid = await _ws_folder(ctx, args)
    emails = [e.strip() for e in args.get("people") or args.get("emails") or [] if isinstance(e, str) and e.strip()]
    teams = [t.strip() for t in args.get("teams") or [] if isinstance(t, str) and t.strip()]
    if not emails and not teams:
        raise ToolError("Give people (email addresses) and/or teams (names from list_teams).")
    actor, actx = actor_of(ctx), access_service.Ctx(ctx.db, surface="mcp")
    try:
        res = await svc.share(ctx.db, actor, actx, ws_id, fid, emails=emails, teams=teams,
                              role=args.get("role") or "viewer", notify=args.get("notify", True) is not False,
                              message=(args.get("message") or "").strip() or None,
                              restrict=args.get("restrict"))
        actx.forget()
        d = await svc.describe(ctx.db, actor, actx, ws_id, fid)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    told = res["notified"]
    out = {**_strip(d), "added_people": res["added_people"], "added_teams": res["added_teams"],
           "notified": sorted(told)}
    added = len(res["added_people"]) + len(res["added_teams"])
    head = (f"Shared {d['path']} with {added} new {'person or team' if added == 1 else 'people and teams'}"
            + (f"; told {len(told)} people (one message each, not one per item)." if told else ".")
            if added else "Everyone named already had that access; nothing was sent.")
    return head + "\n" + _text(d), out


FOLDER_ACCESS_TOOLS: list[Tool] = [
    Tool(
        name="get_folder_access",
        title="Who can access a folder",
        description=("Who can open what's in a workspace folder: its people and teams (each with viewer or editor "
                     "role, and the folder above that names them when inherited), whether it is restricted, what "
                     "new items filed there start as, and a summary sentence. A folder's people and teams reach "
                     "every item inside that isn't private — pages, documents, files and subfolders, including "
                     "what is added later. Restricted: nobody else in the workspace (except admins) and no public "
                     "link opens anything inside. Workspace members."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "workspace": _WORKSPACE_ARG, "folder": _FOLDER_REF,
        }, "required": ["workspace", "folder"]},
        output_schema=_ACCESS_OUT,
        annotations=_ann(True, False, True),
        handler=get_folder_access,
    ),
    Tool(
        name="set_folder_access",
        title="Set who can access a folder",
        description=("Change who can open what's in a workspace folder; everything inside (and added later) "
                     "follows at once. restricted: true limits it to the folder's people and teams (item owners, "
                     "people an item was shared with by name, and workspace admins still open their items; no "
                     "public link works inside) — an item can then only be opened more widely by an editor's "
                     "logged override. people / teams REPLACE the folder's own lists (people and teams named on "
                     "folders above still reach it); add_people / add_teams / remove_people / remove_teams change "
                     "them. default_access sets what new items start as (\"folder\" = the folder's people and "
                     "teams). Teams are Markdrop teams (list_teams, create_team, add_team_members): adding someone "
                     "to the team gives them everything shared with it. Workspace admins, the folder's creator "
                     "and its editors. notify (default false) tells people newly given access, one message each."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "workspace": _WORKSPACE_ARG, "folder": _FOLDER_REF,
            "restricted": {"type": "boolean"},
            "people": {**_PEOPLE_ARG, "description": "Replaces the folder's own people."},
            "teams": {**_TEAMS_ARG, "description": "Replaces the folder's own teams."},
            "add_people": _PEOPLE_ARG, "add_teams": _TEAMS_ARG,
            "remove_people": {"type": "array", "items": {"type": "string", "maxLength": 254}, "maxItems": 200},
            "remove_teams": {"type": "array", "items": {"type": "string", "maxLength": 80}, "maxItems": 50},
            "default_access": _DEFAULT_ARG,
            "notify": {"type": "boolean", "description": "Tell people newly given access. Default false."},
            "message": {"type": "string", "maxLength": 500},
        }, "required": ["workspace", "folder"]},
        output_schema=_ACCESS_OUT,
        annotations=_ann(False, False, True),
        handler=set_folder_access,
    ),
    Tool(
        name="share_folder",
        title="Share a folder with people or teams",
        description=("Give people (by email) and/or teams access to everything in a workspace folder — its "
                     "pages, documents, files and subfolders that aren't private, including what is added later — "
                     "with one role (viewer, the default, or editor). With notify (default true) each person newly "
                     "given access gets ONE email and one notification for the whole folder (a team's members "
                     "too), never one per item. restrict: true also limits the folder to its people and teams. "
                     "Workspace admins, the folder's creator and its editors."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "workspace": _WORKSPACE_ARG, "folder": _FOLDER_REF,
            "people": {"type": "array", "items": {"type": "string", "format": "email", "maxLength": 254},
                       "maxItems": 50, "description": "Email addresses."},
            "teams": {"type": "array", "items": {"type": "string", "maxLength": 80}, "maxItems": 20,
                      "description": "Team names, slugs or ids (list_teams)."},
            "role": {**_ROLE, "description": "Default viewer."},
            "notify": {"type": "boolean", "description": "Default true."},
            "message": {"type": "string", "maxLength": 500, "description": "Included in the email and notification."},
            "restrict": {"type": "boolean", "description": "Also restrict the folder (true) or lift it (false)."},
        }, "required": ["workspace", "folder"]},
        output_schema=_ACCESS_OUT,
        annotations=_ann(False, False, True),
        handler=share_folder,
    ),
]
