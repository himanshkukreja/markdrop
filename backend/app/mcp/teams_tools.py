"""MCP tools for Teams inside a workspace (services/teams.py; contract .work/teams/CONTRACT.md §8).

READ: ``list_teams``, ``get_team``, ``get_team_brief``, ``list_projects``.
WRITE: ``create_team`` (workspace admins), ``update_team`` (leads/admins; visibility: admins),
``add_team_members`` / ``remove_team_members`` (leads/admins; anyone may remove themselves),
``move_to_team`` / ``share_to_team`` (edit on the item; membership of the team), ``edit_team_brief``
(leads/admins), ``create_project`` (admins, leads of a linked team), ``route_meeting``.

The same rules as the website (routers/teams.py): a private team's members, items and settings only for
its members and workspace admins; its brief for every workspace member. ``space`` on search,
ask_documents, ask_meetings, list_team, get_person_profile, get_project_status, list_workspace_items and
list_meetings narrows them to a team, a project or company-wide items (mcp/protocol.py).
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from app.config import get_settings
from app.mcp.auth import READ, WRITE
from app.mcp.tools import Context, Tool, ToolError, _ann, _out, actor_of, http_message, resolve_doc, resolve_workspace
from app.services import access as access_service
from app.services import team_briefs as briefs
from app.services import team_routing as routing
from app.services import teams as T

_STR = {"type": "string"}
_WS = {"type": "string", "description": "Workspace id or name (list_workspaces)."}
_TEAM = {"type": "string", "description": "Team id, slug or name (list_teams)."}
_LIST = {"type": "array", "items": {"type": "string"}, "maxItems": 200}
SPACE = {"type": "string", "maxLength": 40,
         "description": "Teams: narrow to one space — \"team:<team id>\", \"project:<project id>\", \"company\" "
                        "(company-wide items only) or \"all\" (default: everything the user can read)."}


def _abs(path: str) -> str:
    return get_settings().frontend_url.rstrip("/") + path


async def _view(ctx: Context, workspace: str) -> tuple[T.TeamView, access_service.Ctx, str]:
    try:
        ws_id, _w, role = await resolve_workspace(ctx, workspace)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    actx = access_service.Ctx(ctx.db, surface="mcp")
    return await actx.team_view(ws_id, ctx.user.id), actx, role


async def _team(ctx: Context, view: T.TeamView, ref: str, *, readable: bool = True) -> dict:
    row = await T.get_team(ctx.db, view.workspace_id, (ref or "").strip())
    if row is None or (readable and str(row["_id"]) not in view.readable_teams):
        raise ToolError(f"No team “{ref}” you can open. list_teams shows them.")
    return row


async def _people(ctx: Context, view: T.TeamView, values: list[str]) -> list[str]:
    from app.mcp.team_tools import _person_id
    from app.services import workspace_memory as wm

    ws = await wm.ws_info(ctx.db, view.workspace_id)
    if ws is None:
        raise ToolError("Workspace not found.")
    return [await _person_id(ctx, ws, v) for v in values]


def _refused(exc: T.Refused) -> ToolError:
    return ToolError(exc.detail)


def _card(c: dict) -> dict:
    return {k: c.get(k) for k in ("id", "name", "slug", "visibility", "description", "member_count", "my_role", "can_read",
                                  "can_manage", "project_ids")}


def _team_url(view: T.TeamView, t: dict) -> str:
    return _abs(f"/w/{view.workspace_id}/teams/{t.get('slug')}")


async def list_teams(ctx: Context, args: dict) -> tuple[str, dict]:
    view, _actx, _role = await _view(ctx, args["workspace"])
    teams = sorted((T.team_card(view, t) for t in view.teams.values()), key=lambda c: (c["name"] or "").casefold())
    out = {"teams": [{**_card(c), "url": _team_url(view, view.teams[c["id"]])} for c in teams],
           "can_create": view.admin}
    if not teams:
        return "No teams in this workspace yet." + (" As an admin you can create_team." if view.admin else ""), out
    lines = [f"- {c['name']} ({c['visibility']}, {c['member_count']} people)"
             + (f" — you're {c['my_role']}" if c["my_role"] else "") + (" — private, only its brief is visible to you" if not c["can_read"] else "")
             for c in teams]
    return "Teams:\n" + "\n".join(lines), out


async def get_team(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.routers.teams import team_home

    view, actx, _role = await _view(ctx, args["workspace"])
    row = await _team(ctx, view, args["team"], readable=False)
    home = await team_home(ctx.db, actor_of(ctx), actx, view, row)
    t = home["team"]
    out: dict[str, Any] = {"team": _card(t), "url": _team_url(view, row), "can_read": home.get("can_read", True),
                           "brief": _brief(home.get("brief"))}
    if home.get("can_read", True):
        out.update(members=[{"name": m["name"], "role": m["role"]} for m in t.get("members") or []],
                   recent=[{"title": i["title"], "url": i["url"], "kind": i["kind"]} for i in home.get("recent") or []],
                   meetings=[{"title": m.get("title"), "date": m.get("date"), "id": m.get("id")} for m in home.get("meetings") or []],
                   projects=[p["name"] for p in home.get("projects") or []],
                   slack_channel=(t.get("slack_channel") or {}).get("name"), jira_projects=t.get("jira_projects") or [])
    text = f"{t['name']} ({t['visibility']}, {t['member_count']} people)."
    if out["brief"]:
        text += f"\n{out['brief']['label']}:\n" + "\n".join(f"- {ln['text']}" for ln in out["brief"]["lines"])
    if not out["can_read"]:
        text += "\nPrivate team: only its members and workspace admins can open its pages, meetings and memory."
    return text, out


def _brief(b: dict | None) -> dict | None:
    if not b:
        return None
    return {"id": b["id"], "week": b["week"], "label": b["label"], "can_edit": b["can_edit"],
            "lines": [{"id": ln["id"], "kind": ln["kind"], "text": ln["text"], "hidden": ln.get("hidden", False),
                       "person": (ln.get("person") or {}).get("name"),
                       "sources": [{"title": s["title"], "url": _abs(s["href"])} for s in ln.get("sources") or []]}
                      for ln in b["lines"]]}


async def create_team(ctx: Context, args: dict) -> tuple[str, dict]:
    view, _actx, role = await _view(ctx, args["workspace"])
    body = {"name": args["name"], "visibility": args.get("visibility") or "open", "description": args.get("description"),
            "lead_ids": await _people(ctx, view, args.get("leads") or []),
            "member_ids": await _people(ctx, view, args.get("members") or [])}
    try:
        row = await T.create_team(ctx.db, view, body)
    except T.Refused as exc:
        raise _refused(exc)
    view = await T.load_view(ctx.db, view.workspace_id, ctx.user.id, role)
    c = T.team_card(view, row)
    return f"Created the team {row['name']} ({row['visibility']}).", {"team": _card(c), "url": _team_url(view, row)}


async def update_team(ctx: Context, args: dict) -> tuple[str, dict]:
    view, _actx, role = await _view(ctx, args["workspace"])
    row = await _team(ctx, view, args["team"])
    body = {k: args[k] for k in ("name", "description", "visibility", "jira_projects") if args.get(k) is not None}
    if "slack_channel_id" in args:
        body["slack_channel"] = ({"id": args["slack_channel_id"], "name": args.get("slack_channel_name")}
                                 if args.get("slack_channel_id") else None)
    if args.get("digest") is not None:
        body["digest"] = {"enabled": bool(args["digest"]), "email": bool(args["digest"]), "slack": bool(args["digest"])}
    try:
        row = await T.update_team(ctx.db, view, row, body)
    except T.Refused as exc:
        raise _refused(exc)
    view = await T.load_view(ctx.db, view.workspace_id, ctx.user.id, role)
    return f"Updated {row['name']}.", {"team": _card(T.team_card(view, row))}


async def add_team_members(ctx: Context, args: dict) -> tuple[str, dict]:
    view, _actx, role = await _view(ctx, args["workspace"])
    row = await _team(ctx, view, args["team"])
    try:
        row = await T.add_members(ctx.db, view, row, await _people(ctx, view, args["people"]))
    except T.Refused as exc:
        raise _refused(exc)
    return f"{row['name']} has {len(row.get('member_ids') or [])} people now.", {"member_count": len(row.get("member_ids") or [])}


async def remove_team_members(ctx: Context, args: dict) -> tuple[str, dict]:
    view, _actx, role = await _view(ctx, args["workspace"])
    row = await _team(ctx, view, args["team"])
    try:
        for uid in await _people(ctx, view, args["people"]):
            row = await T.remove_member(ctx.db, view, row, uid)
    except T.Refused as exc:
        raise _refused(exc)
    return f"{row['name']} has {len(row.get('member_ids') or [])} people now.", {"member_count": len(row.get("member_ids") or [])}


async def _doc(ctx: Context, value: str) -> dict:
    ref = await resolve_doc(ctx, value)
    raw = await ctx.db["documents"].find_one({"slug": ref.slug, "deleted_at": None})
    if raw is None or (ref.scope and raw.get("workspace_id") != ref.scope):
        raise ToolError("Document not found.")
    if not (await access_service.can(actor_of(ctx), raw, "read", access_service.Ctx(ctx.db, surface="mcp"))).allowed:
        raise ToolError("Document not found.")
    if not raw.get("workspace_id"):
        raise ToolError("That item isn't in a workspace; add_to_workspace first.")
    return raw


async def _set(ctx: Context, raw: dict, tids: list[str], pids: list[str]) -> tuple[str, dict]:
    actx = access_service.Ctx(ctx.db, surface="mcp")
    try:
        got = await T.set_item_teams(ctx.db, actor_of(ctx), actx, raw, tids, pids)
    except T.Refused as exc:
        raise _refused(exc)
    names = [x["name"] for x in got["teams"] + got["projects"]]
    where = ", ".join(names) if names else "company-wide"
    return f"“{raw.get('title') or raw['slug']}” is now in: {where}.", {"slug": raw["slug"], "teams": names,
                                                                      "team_ids": got["team_ids"], "project_ids": got["project_ids"]}


async def move_to_team(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await _doc(ctx, args["document"])
    target = (args.get("team") or "").strip()
    if target.lower() in ("company", "company-wide", ""):
        return await _set(ctx, raw, [], [])
    view = await access_service.Ctx(ctx.db).team_view(raw["workspace_id"], ctx.user.id)
    t = await _team(ctx, view, target)
    return await _set(ctx, raw, [str(t["_id"])], [])


async def share_to_team(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await _doc(ctx, args["document"])
    view = await access_service.Ctx(ctx.db).team_view(raw["workspace_id"], ctx.user.id)
    t = await _team(ctx, view, args["team"])
    tids = T.ids_of(raw, "team_ids")
    tid = str(t["_id"])
    tids = [x for x in tids if x != tid] if args.get("remove") else list(dict.fromkeys([*tids, tid]))
    return await _set(ctx, raw, tids, T.ids_of(raw, "project_ids"))


async def get_team_brief(ctx: Context, args: dict) -> tuple[str, dict]:
    view, actx, _role = await _view(ctx, args["workspace"])
    row = await _team(ctx, view, args["team"], readable=False)
    b = await briefs.get_brief(ctx.db, str(row["_id"]), args.get("week") or "latest")
    if b is None:
        return f"{row['name']} has no brief yet (they're written every Monday from the team's memory).", {"brief": None}
    out = _brief(await briefs.brief_out(ctx.db, actor_of(ctx), actx, view, b))
    return f"{row['name']} — {out['label']}:\n" + "\n".join(f"- {ln['text']}" for ln in out["lines"] if not ln["hidden"]), {"brief": out}


async def edit_team_brief(ctx: Context, args: dict) -> tuple[str, dict]:
    view, actx, _role = await _view(ctx, args["workspace"])
    row = await _team(ctx, view, args["team"])
    b = await briefs.get_brief(ctx.db, str(row["_id"]), args.get("week") or "latest")
    if b is None:
        raise ToolError("That team has no brief yet.")
    try:
        if args.get("add"):
            b = await briefs.add_line(ctx.db, view, b, args["add"])
        elif args.get("line_id"):
            b = await briefs.edit_line(ctx.db, view, b, args["line_id"], text=args.get("text"), hidden=args.get("hidden"))
        else:
            raise ToolError("Pass line_id (with text and/or hidden) or add.")
    except T.Refused as exc:
        raise _refused(exc)
    return "Brief updated.", {"brief": _brief(await briefs.brief_out(ctx.db, actor_of(ctx), actx, view, b))}


async def list_projects(ctx: Context, args: dict) -> tuple[str, dict]:
    view, _actx, _role = await _view(ctx, args["workspace"])
    rows = [p for pid, p in view.projects.items() if pid in view.readable_projects]
    if args.get("team"):
        t = await _team(ctx, view, args["team"])
        rows = [p for p in rows if str(t["_id"]) in [str(x) for x in p.get("team_ids") or []]]
    cards = [T.project_card(view, p) for p in rows]
    out = {"projects": [{k: c[k] for k in ("id", "name", "slug", "team_ids", "visibility", "status", "member_count", "my_role")}
                        for c in cards]}
    if not cards:
        return "No projects.", out
    return "Projects:\n" + "\n".join(f"- {c['name']} ({c['status']}, {c['member_count']} people)" for c in cards), out


async def create_project(ctx: Context, args: dict) -> tuple[str, dict]:
    view, _actx, role = await _view(ctx, args["workspace"])
    tids = [str((await _team(ctx, view, t))["_id"]) for t in args["teams"]]
    try:
        p = await T.create_project(ctx.db, view, {"name": args["name"], "team_ids": tids, "description": args.get("description")})
    except T.Refused as exc:
        raise _refused(exc)
    view = await T.load_view(ctx.db, view.workspace_id, ctx.user.id, role)
    c = T.project_card(view, p)
    return f"Created the project {p['name']}.", {"project": {k: c[k] for k in ("id", "name", "slug", "team_ids", "visibility")}}


async def route_meeting(ctx: Context, args: dict) -> tuple[str, dict]:
    row = await ctx.db["meetings"].find_one({"_id": T.oid(args["meeting"])}, {"segments": 0}) if T.oid(args["meeting"]) else None
    if row is None:
        raise ToolError("Meeting not found.")
    actx = access_service.Ctx(ctx.db, surface="mcp")
    raw = await ctx.db["documents"].find_one({"_id": row.get("doc_id")}, {"content": 0})
    if raw is None or not (await access_service.can(actor_of(ctx), raw, "read", actx)).allowed:
        raise ToolError("Meeting not found.")
    view = await actx.team_view(row["workspace_id"], ctx.user.id)
    tids = [] if [t for t in args["teams"] if t.lower() in ("company", "company-wide")] else \
        [str((await _team(ctx, view, t))["_id"]) for t in args["teams"]]
    try:
        got = await routing.set_meeting_teams(ctx.db, actor_of(ctx), actx, row, tids, [])
    except T.Refused as exc:
        raise _refused(exc)
    names = [x["name"] for x in got["teams"]]
    return f"“{row.get('title')}” is in: {', '.join(names) or 'company-wide'}.", {"teams": names, "state": got["state"]}


_O = {"type": "object"}
TEAMS_TOOLS = [
    Tool(name="list_teams", title="Teams in a workspace",
         description=("The teams of a workspace (Sales, Marketing, Engineering…): name, open or private, size, whether "
                      "the user is a lead or member. A private team the user isn't in shows only its name (and its "
                      "brief via get_team_brief). Workspace members only."),
         scope=READ, input_schema={"type": "object", "properties": {"workspace": _WS}, "required": ["workspace"]},
         output_schema=_out({"teams": {"type": "array", "items": _O}, "can_create": {"type": "boolean"}}),
         annotations=_ann(True, False, True), handler=list_teams),
    Tool(name="get_team", title="A team's home",
         description=("A team's home: its latest brief, members, recent pages and files, latest meetings, projects, "
                      "Slack channel and Jira projects. A private team the user isn't in: its brief only."),
         scope=READ, input_schema={"type": "object", "properties": {"workspace": _WS, "team": _TEAM},
                                   "required": ["workspace", "team"]},
         output_schema=_out({"team": _O, "url": _STR, "can_read": {"type": "boolean"}, "brief": {"type": ["object", "null"]}},
                            ["team", "can_read"]),
         annotations=_ann(True, False, True), handler=get_team),
    Tool(name="get_team_brief", title="A team's weekly brief",
         description=("A team's weekly brief (written every Monday from its memory; its leads can edit it). Every "
                      "workspace member can read every team's brief; sources only when the user can open them. "
                      "week: \"2026-W45\" or leave out for the latest."),
         scope=READ, input_schema={"type": "object", "properties": {"workspace": _WS, "team": _TEAM,
                                                                     "week": {"type": "string", "maxLength": 10}},
                                   "required": ["workspace", "team"]},
         output_schema=_out({"brief": {"type": ["object", "null"]}}),
         annotations=_ann(True, False, True), handler=get_team_brief),
    Tool(name="list_projects", title="Cross-team projects",
         description="Projects shared by several teams (e.g. \"Q4 launch\") the user can open; team: only that team's.",
         scope=READ, input_schema={"type": "object", "properties": {"workspace": _WS, "team": _TEAM}, "required": ["workspace"]},
         output_schema=_out({"projects": {"type": "array", "items": _O}}),
         annotations=_ann(True, False, True), handler=list_projects),
    Tool(name="create_team", title="Create a team", writes=True, scope=WRITE,
         description=("Create a team in a workspace (workspace admins only): open (anyone in the workspace can browse "
                      "and search it) or private (members only; workspace admins can still see it). leads and members: "
                      "names, emails or ids of workspace members."),
         input_schema={"type": "object", "properties": {
             "workspace": _WS, "name": {"type": "string", "maxLength": 60},
             "visibility": {"type": "string", "enum": ["open", "private"]},
             "description": {"type": "string", "maxLength": 280}, "leads": _LIST, "members": _LIST},
             "required": ["workspace", "name"]},
         output_schema=_out({"team": _O, "url": _STR}), annotations=_ann(False, False, False), handler=create_team),
    Tool(name="update_team", title="Change a team", writes=True, scope=WRITE,
         description=("Change a team's name, description, Slack channel (slack_channel_id; \"\" clears), Jira projects "
                      "(keys), weekly digest on/off (leads and admins), or visibility (admins only)."),
         input_schema={"type": "object", "properties": {
             "workspace": _WS, "team": _TEAM, "name": {"type": "string", "maxLength": 60},
             "description": {"type": "string", "maxLength": 280}, "visibility": {"type": "string", "enum": ["open", "private"]},
             "slack_channel_id": {"type": "string", "maxLength": 40}, "slack_channel_name": {"type": "string", "maxLength": 80},
             "jira_projects": {"type": "array", "items": _STR, "maxItems": 10}, "digest": {"type": "boolean"}},
             "required": ["workspace", "team"]},
         output_schema=_out({"team": _O}), annotations=_ann(False, False, True), handler=update_team),
    Tool(name="add_team_members", title="Add people to a team", writes=True, scope=WRITE,
         description="Add workspace members to a team (its leads and workspace admins). people: names, emails or ids.",
         input_schema={"type": "object", "properties": {"workspace": _WS, "team": _TEAM, "people": _LIST},
                       "required": ["workspace", "team", "people"]},
         output_schema=_out({"member_count": {"type": "integer"}}), annotations=_ann(False, False, True), handler=add_team_members),
    Tool(name="remove_team_members", title="Remove people from a team", writes=True, scope=WRITE,
         description="Remove people from a team (its leads and workspace admins; anyone may remove themselves: \"me\").",
         input_schema={"type": "object", "properties": {"workspace": _WS, "team": _TEAM, "people": _LIST},
                       "required": ["workspace", "team", "people"]},
         output_schema=_out({"member_count": {"type": "integer"}}), annotations=_ann(False, True, True), handler=remove_team_members),
    Tool(name="move_to_team", title="Move an item into a team", writes=True, scope=WRITE,
         description=("Put a document, page or file into one team's space (team: id, slug or name), or back to "
                      "company-wide (team \"company\"). A private team's items are visible to its members and "
                      "workspace admins only (a link or people share keeps working). Needs edit on the item and "
                      "membership of the team."),
         input_schema={"type": "object", "properties": {"document": {"type": "string", "description": "Slug or link."},
                                                        "team": {"type": "string"}}, "required": ["document", "team"]},
         output_schema=_out({"slug": _STR, "teams": {"type": "array", "items": _STR}, "team_ids": {"type": "array", "items": _STR},
                             "project_ids": {"type": "array", "items": _STR}}),
         annotations=_ann(False, False, True), handler=move_to_team),
    Tool(name="share_to_team", title="Share an item with another team", writes=True, scope=WRITE,
         description="Add a team to an item's teams (it then belongs to several), or take one off (remove: true).",
         input_schema={"type": "object", "properties": {"document": {"type": "string"}, "team": _TEAM,
                                                        "remove": {"type": "boolean"}}, "required": ["document", "team"]},
         output_schema=_out({"slug": _STR, "teams": {"type": "array", "items": _STR}, "team_ids": {"type": "array", "items": _STR},
                             "project_ids": {"type": "array", "items": _STR}}),
         annotations=_ann(False, False, True), handler=share_to_team),
    Tool(name="edit_team_brief", title="Edit a team's brief", writes=True, scope=WRITE,
         description="Leads and admins: change a brief line's text, hide/show it (line_id + text/hidden), or add a line (add).",
         input_schema={"type": "object", "properties": {
             "workspace": _WS, "team": _TEAM, "week": {"type": "string", "maxLength": 10},
             "line_id": {"type": "string", "maxLength": 40}, "text": {"type": "string", "maxLength": 300},
             "hidden": {"type": "boolean"}, "add": {"type": "string", "maxLength": 300}}, "required": ["workspace", "team"]},
         output_schema=_out({"brief": {"type": ["object", "null"]}}), annotations=_ann(False, False, False), handler=edit_team_brief),
    Tool(name="create_project", title="Create a cross-team project", writes=True, scope=WRITE,
         description=("A project space shared by several teams (\"Q4 launch\"): its own pages and meetings, combined memory; "
                      "members of every linked team contribute. Workspace admins and leads of a linked team."),
         input_schema={"type": "object", "properties": {"workspace": _WS, "name": {"type": "string", "maxLength": 60},
                                                        "teams": {"type": "array", "items": _STR, "minItems": 1, "maxItems": 20},
                                                        "description": {"type": "string", "maxLength": 280}},
                       "required": ["workspace", "name", "teams"]},
         output_schema=_out({"project": _O}), annotations=_ann(False, False, False), handler=create_project),
    Tool(name="route_meeting", title="Put a meeting into teams", writes=True, scope=WRITE,
         description=("Say which team(s) a meeting belongs to (it was suggested from its attendees on import); "
                      "[\"company\"] makes it company-wide. meeting: its id (list_meetings)."),
         input_schema={"type": "object", "properties": {"meeting": {"type": "string", "maxLength": 40},
                                                        "teams": {"type": "array", "items": _STR, "maxItems": 20}},
                       "required": ["meeting", "teams"]},
         output_schema=_out({"teams": {"type": "array", "items": _STR}, "state": {"type": ["string", "null"]}}),
         annotations=_ann(False, False, True), handler=route_meeting),
]

# ``space`` on the tools that read across a workspace (mcp/protocol.py applies it).
SPACE_TOOLS = ("search", "ask_documents", "ask_meetings", "list_team", "get_person_profile", "get_project_status",
               "list_workspace_items", "list_meetings")


def add_space(tools: list[Tool]) -> None:
    for t in tools:
        if t.name in SPACE_TOOLS and isinstance(t.input_schema.get("properties"), dict):
            t.input_schema["properties"].setdefault("space", SPACE)
