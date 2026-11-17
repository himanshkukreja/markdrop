"""MCP tools for HubSpot (services/hubspot.py).

* ``hubspot_status``: whether a workspace is connected to a HubSpot account, the team whose calls go there,
  whether *Log calls automatically* is on, missing scopes (admins), and how many calls and tasks were logged.
* ``hubspot_match``: a meeting's match in HubSpot (the deal with its stage, amount, owner and close date,
  contacts, company, how it was found and how sure); ``action: "rematch"`` matches again, ``"search"``
  searches deals by name, ``"set"`` picks the deal (``deal_id``, or null for none).
* ``log_to_hubspot``: writes the meeting's summary, next steps and decisions into the HubSpot meeting's
  internal notes (the booked one, or a new one on the deal); running it again updates the same meeting.
* ``hubspot_tasks``: ``action: "list"`` the meeting's action items as proposed HubSpot tasks (due date,
  owner, already created?); ``"create"`` creates the ones chosen by key, once each.

Same rules as the website: only meetings of the workspace's HubSpot team, for people who can read the
meeting and are in that team (or workspace admins). Connecting is on the website.
"""

from __future__ import annotations

from fastapi import HTTPException

from app.mcp.auth import READ, WRITE
from app.mcp.meeting_tools import _actx, _row
from app.mcp.tools import _WORKSPACE_ARG, Context, Tool, ToolError, _ann, _out, actor_of, http_message, resolve_workspace
from app.services import hubspot

_SETUP = "Workspace settings › Integrations › HubSpot"
_MEETING_ARG = {"type": "string", "minLength": 1, "maxLength": 300,
                "description": "The meeting: its id (list_meetings), or its page's link or slug."}


async def hubspot_status(ctx: Context, args: dict) -> tuple[str, dict]:
    ws_id, ws_obj, _role = await resolve_workspace(ctx, args["workspace"])
    try:
        st = await hubspot.status(ctx.db, ctx.user, ws_id)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    name = getattr(ws_obj, "name", None) or "This workspace"
    c = st.get("connection") or {}
    out = {"workspace_id": ws_id, "connected": bool(st["connected"]), "can_manage": bool(st["can_manage"]),
           "can_use": bool(st["can_use"]), "team": st.get("team"), "auto_log": bool(st.get("auto_log")),
           "broken": c.get("broken"), "portal_id": c.get("portal_id"),
           "missing_scopes": [m["scope"] for m in c.get("missing_scopes") or []],
           "logged": c.get("logged", 0), "tasks": c.get("tasks", 0), "last_log_at": c.get("last_log_at")}
    if not st["connected"]:
        return (f"{name} isn't connected to HubSpot. " + (f"Connect it on the website: {_SETUP}." if st["can_manage"]
                                                          else f"A workspace admin connects it in {_SETUP}.")), out
    lines = [f"{name} is connected to HubSpot (account {c.get('portal_id')})."]
    team = st.get("team")
    lines.append(f"Calls of the {team['name']} team can be logged to HubSpot." if team
                 else f"No team is picked yet: an admin picks one in {_SETUP}.")
    lines.append("Log calls automatically is on: confident matches are logged after their summary is written."
                 if out["auto_log"] else "Calls are logged with one click (Log calls automatically is off).")
    if out["broken"]:
        lines.append(f"The connection needs attention ({out['broken']}): an admin checks it in {_SETUP}.")
    if out["missing_scopes"]:
        lines.append("The HubSpot key is missing scopes: " + ", ".join(out["missing_scopes"]) + ".")
    lines.append(f"Logged so far: {out['logged']} calls, {out['tasks']} tasks.")
    return "\n".join(lines), out


def _summary(p: dict) -> str:
    m = p.get("match") or {}
    d = p.get("deal")
    if not p.get("available"):
        why = {"not_connected": "the workspace isn't connected to HubSpot", "not_team": "it isn't the HubSpot team's meeting",
               "not_member": "only the HubSpot team's members and workspace admins use HubSpot"}.get(p.get("reason") or "", p.get("reason"))
        return f"HubSpot isn't available for this meeting: {why}."
    parts = []
    if d:
        bits = [x for x in (d.get("stage"), f"{d['amount']:g} {d.get('currency') or ''}".strip() if d.get("amount") is not None else None,
                            f"owner {d['owner']}" if d.get("owner") else None, f"closes {d['close_date']}" if d.get("close_date") else None) if x]
        parts.append(f"Deal: {d['name']} ({', '.join(bits)}) {d.get('url') or ''}".strip())
    else:
        parts.append("No deal matched: pick one (action 'search', then 'set').")
    if p.get("contacts"):
        parts.append("Contacts: " + ", ".join(c["name"] or c.get("email") or c["id"] for c in p["contacts"]))
    if p.get("companies"):
        parts.append("Company: " + ", ".join(c["name"] or c["id"] for c in p["companies"]))
    parts.append(f"Matched by {m.get('how')} ({m.get('confidence')} confidence)" + (f": {m['detail']}" if m.get("detail") else "") + ".")
    if p.get("logged"):
        parts.append(f"Logged to HubSpot {p['logged']['at']}" + (f" by {p['logged']['by']}" if p['logged'].get('by') else " automatically") + ".")
    if p.get("error"):
        parts.append(p["error"])
    return "\n".join(parts)


async def hubspot_match(ctx: Context, args: dict) -> tuple[str, dict]:
    action = args.get("action") or "get"
    actor, actx = actor_of(ctx), _actx(ctx)
    try:
        if action == "search":
            if not args.get("workspace"):
                row, _raw = await _row(ctx, args.get("meeting") or "")
                ws_id = row["workspace_id"]
            else:
                ws_id, _ws, _r = await resolve_workspace(ctx, args["workspace"])
            got = await hubspot.search_deals(ctx.db, ctx.user, ws_id, args.get("query") or "")
            lines = [f"{d['name']} (id {d['id']}; {d.get('stage') or 'no stage'}{'; closed' if d['closed'] else ''})" for d in got["deals"]]
            return ("Deals:\n" + "\n".join(lines)) if lines else "No deals found.", {"action": "search", "deals": got["deals"], "panel": None}
        row, _raw = await _row(ctx, args.get("meeting") or "")
        mid = str(row["_id"])
        if action == "rematch":
            p = await hubspot.rematch(ctx.db, ctx.user, actor, actx, mid)
        elif action == "set":
            p = await hubspot.set_match(ctx.db, ctx.user, actor, actx, mid, args.get("deal_id") or None)
        else:
            p = await hubspot.panel(ctx.db, ctx.user, actor, actx, mid)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    return _summary(p), {"action": action, "deals": [], "panel": p}


async def log_to_hubspot(ctx: Context, args: dict) -> tuple[str, dict]:
    row, _raw = await _row(ctx, args.get("meeting") or "")
    try:
        p = await hubspot.log_meeting(ctx.db, ctx.user, actor_of(ctx), _actx(ctx), str(row["_id"]))
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    lg = p.get("logged") or {}
    text = ("Logged to HubSpot: the summary, next steps and decisions are in the HubSpot meeting's internal notes"
            + (" (a new meeting on the deal)" if lg.get("created") else " (the meeting HubSpot booked)") + ".")
    if lg.get("url"):
        text += f" {lg['url']}"
    return text, {"logged": lg, "panel": p}


async def hubspot_tasks(ctx: Context, args: dict) -> tuple[str, dict]:
    row, _raw = await _row(ctx, args.get("meeting") or "")
    action = args.get("action") or "list"
    actor, actx = actor_of(ctx), _actx(ctx)
    try:
        if action == "create":
            keys = [str(k) for k in args.get("keys") or []]
            if not keys:
                raise ToolError("Pass the keys of the tasks to create (from action 'list').")
            p = await hubspot.create_tasks(ctx.db, ctx.user, actor, actx, str(row["_id"]), keys)
        else:
            p = await hubspot.panel(ctx.db, ctx.user, actor, actx, str(row["_id"]))
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    if not p.get("available"):
        return _summary(p), {"action": action, "tasks": [], "results": []}
    tasks = p.get("tasks") or []
    if action == "create":
        res = p.get("results") or []
        made = sum(1 for r in res if r["status"] == "created")
        text = f"Created {made} HubSpot task{'s' if made != 1 else ''}" + (
            f"; {sum(1 for r in res if r['status'] == 'exists')} already there" if any(r["status"] == "exists" for r in res) else "") + (
            f"; {sum(1 for r in res if r['status'] == 'failed')} failed" if any(r["status"] == "failed" for r in res) else "") + "."
        return text, {"action": action, "tasks": tasks, "results": res}
    lines = [f"- [{t['key']}] {t['text']} · due {t['due']}" + (f" · {t['assignee']['name']}" if t.get("assignee") else "")
             + (" · already in HubSpot" if t.get("created") else "") for t in tasks]
    return (("Proposed HubSpot tasks (create with action 'create' and their keys):\n" + "\n".join(lines)) if lines
            else "This meeting has no action items."), {"action": action, "tasks": tasks, "results": []}


HUBSPOT_TOOLS: list[Tool] = [
    Tool(
        name="hubspot_status",
        title="HubSpot connection",
        description=("Whether a workspace is connected to its HubSpot account, the team whose calls go to HubSpot (only that "
                     "team's meetings), whether Log calls automatically is on, scopes the HubSpot key is missing, and how many "
                     f"calls and tasks were logged. Read-only: connecting is on the website ({_SETUP})."),
        scope=READ,
        input_schema={"type": "object", "properties": {"workspace": _WORKSPACE_ARG}, "required": ["workspace"]},
        output_schema=_out({"workspace_id": {"type": "string"}, "connected": {"type": "boolean"},
                            "can_manage": {"type": "boolean"}, "can_use": {"type": "boolean"},
                            "team": {"type": ["object", "null"]}, "auto_log": {"type": "boolean"},
                            "broken": {"type": ["string", "null"]}, "portal_id": {"type": ["string", "null"]},
                            "missing_scopes": {"type": "array", "items": {"type": "string"}},
                            "logged": {"type": "integer"}, "tasks": {"type": "integer"},
                            "last_log_at": {"type": ["string", "null"]}}, ["workspace_id", "connected"]),
        annotations=_ann(True, False, True),
        handler=hubspot_status,
    ),
    Tool(
        name="hubspot_match",
        title="A meeting's HubSpot deal",
        description=("The HubSpot deal, contacts and company a meeting of the HubSpot team matches: the deal's stage, amount, "
                     "owner and close date with links, how it was found ('meeting': the HubSpot meeting booked for the call; "
                     "'contacts' or 'names': its attendees; 'user': picked by a person; 'none') and how sure (high, medium, "
                     "low), whether it's logged, and the action items proposed as tasks. action 'get' (default); 'rematch' "
                     "matches again; 'search' finds deals by name (query); 'set' picks the deal (deal_id; null: none)."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "meeting": _MEETING_ARG,
            "action": {"type": "string", "enum": ["get", "rematch", "search", "set"], "default": "get"},
            "query": {"type": "string", "maxLength": 100, "description": "action 'search': words in the deal's name."},
            "deal_id": {"type": ["string", "null"], "maxLength": 20, "description": "action 'set': the deal's id (from 'search')."},
            "workspace": {**_WORKSPACE_ARG, "description": "action 'search' without a meeting: the workspace."}},
            "required": []},
        output_schema=_out({"action": {"type": "string"}, "deals": {"type": "array", "items": {"type": "object"}},
                            "panel": {"type": ["object", "null"]}}, ["action", "deals", "panel"]),
        annotations=_ann(False, False, True),
        handler=hubspot_match,
    ),
    Tool(
        name="log_to_hubspot",
        title="Log a meeting to HubSpot",
        description=("Write a meeting's summary, next steps and decisions (with a link to the Markdrop page) into the internal "
                     "notes of its HubSpot meeting: the one HubSpot booked for the call, else a new meeting on the matched "
                     "deal and contacts. The attendee-facing description is never changed. Running it again updates the same "
                     "HubSpot meeting (never a duplicate). The HubSpot team's members and workspace admins."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {"meeting": _MEETING_ARG}, "required": ["meeting"]},
        output_schema=_out({"logged": {"type": "object"}, "panel": {"type": "object"}}, ["logged", "panel"]),
        annotations=_ann(False, False, True),
        handler=log_to_hubspot,
    ),
    Tool(
        name="hubspot_tasks",
        title="Meeting action items as HubSpot tasks",
        description=("A meeting's action items as HubSpot tasks. action 'list' (default): each with its key, due date (said in "
                     "the call, else three days later), owner (the person named, else the deal's owner) and whether it's "
                     "already in HubSpot. action 'create': create the chosen keys, associated to the deal and contacts; each "
                     "is created once (asking again never duplicates)."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "meeting": _MEETING_ARG,
            "action": {"type": "string", "enum": ["list", "create"], "default": "list"},
            "keys": {"type": "array", "items": {"type": "string", "maxLength": 32}, "maxItems": 50,
                     "description": "action 'create': the tasks' keys from action 'list'."}},
            "required": ["meeting"]},
        output_schema=_out({"action": {"type": "string"}, "tasks": {"type": "array", "items": {"type": "object"}},
                            "results": {"type": "array", "items": {"type": "object"}}}, ["action", "tasks", "results"]),
        annotations=_ann(False, False, True),
        handler=hubspot_tasks,
    ),
]
