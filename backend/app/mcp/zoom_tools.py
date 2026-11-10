"""MCP tools for Zoom (services/zoom.py).

* ``zoom_status``: whether a workspace is connected to a Zoom account, which team Zoom meetings go to,
  and how imports are going (the last ones, meetings that had no transcript).
* ``import_zoom_meetings``: ``action: "list"`` lists the team members' recorded Zoom meetings for a
  range (with host, date, duration, whether there's a transcript, already imported?); ``action:
  "import"`` imports the chosen ones (by uuid) into the team, as past meetings (nobody is notified).

Same rules as the website: workspace admins and the Zoom team's leads import; connecting is done on the
website (Workspace settings › Integrations › Zoom). The imported meetings are ordinary meetings: the
meeting tools (list_meetings, get_meeting, ask_meetings, …) work on them as on any other.
"""

from __future__ import annotations

from fastapi import HTTPException

from app.mcp.auth import READ, WRITE
from app.mcp.tools import _WORKSPACE_ARG, Context, Tool, ToolError, _ann, _out, http_message, resolve_workspace
from app.services import urls, zoom

_SETUP = "Workspace settings › Integrations › Zoom"


async def zoom_status(ctx: Context, args: dict) -> tuple[str, dict]:
    ws_id, ws_obj, _role = await resolve_workspace(ctx, args["workspace"])
    try:
        st = await zoom.status(ctx.db, ctx.user, ws_id)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    name = getattr(ws_obj, "name", None) or "This workspace"
    c = st.get("connection") or {}
    team = st.get("team")
    out = {"workspace_id": ws_id, "connected": bool(st["connected"]), "can_manage": bool(st["can_manage"]),
           "can_import": bool(st["can_import"]), "team": team, "broken": c.get("broken"),
           "missing_scopes": [m["scope"] for m in c.get("missing_scopes") or []],
           "imported": c.get("imported", 0), "no_transcript": c.get("no_transcript", 0),
           "last_import_at": c.get("last_import_at"), "last_event_at": c.get("last_event_at"),
           "recent": [{**r, "url": urls.markdrop_url(r["slug"]) if r.get("slug") else None} for r in st.get("recent") or []]}
    out["mode"] = st.get("mode") if st["connected"] else None
    out["one_click_available"] = bool(st.get("app_available"))
    if not st["connected"]:
        if st["can_manage"] and st.get("app_available"):
            try:
                out["connect_url"] = await zoom.start(ctx.db, ctx.user, ws_id)
            except HTTPException:
                out["connect_url"] = None
        if out.get("connect_url"):
            return (f"{name} isn't connected to Zoom. Open this link in the browser where you're signed in to Markdrop and "
                    f"approve the Markdrop app as a Zoom admin (it works for 15 minutes): {out['connect_url']}"), out
        return (f"{name} isn't connected to Zoom. " + (f"Connect it on the website: {_SETUP}." if st["can_manage"]
                                                       else f"A workspace admin connects it in {_SETUP}.")), out
    lines = [f"{name} is connected to Zoom" + (" with the Markdrop app for Zoom." if out["mode"] == "oauth"
                                               else " with its own Server-to-Server app.")]
    if team:
        lines.append(f"Recorded Zoom meetings hosted by members of the {team['name']} team come in on their own, "
                     f"visible to that team{' (the team is open: everyone in the workspace can read them)' if team.get('visibility') == 'open' else ''}.")
    else:
        lines.append(f"No team is picked yet, so nothing comes in: an admin picks one in {_SETUP}.")
    if c.get("broken"):
        lines.append(f"The connection needs attention ({c['broken']}): an admin checks it in {_SETUP}.")
    if out["missing_scopes"]:
        lines.append("The Zoom app is missing scopes: " + ", ".join(out["missing_scopes"]) + ".")
    lines.append(f"Imported so far: {out['imported']}; without a transcript: {out['no_transcript']}.")
    return "\n".join(lines), out


async def import_zoom_meetings(ctx: Context, args: dict) -> tuple[str, dict]:
    ws_id, _ws, _role = await resolve_workspace(ctx, args["workspace"])
    action = args.get("action") or "list"
    try:
        if action == "list":
            got = await zoom.list_recordings(ctx.db, ctx.user, ws_id, days=args.get("days") or 30,
                                             from_=args.get("from"), to=args.get("to"))
            ms = got["meetings"]
            for m in ms:
                m["url"] = urls.markdrop_url(m["slug"]) if m.get("slug") else None
            ready = [m for m in ms if m["transcript"] and not m["imported"]]
            text = (f"{got['total']} recorded Zoom meetings from {got['from']} to {got['to']}: {len(ready)} ready to import"
                    f"{', ' + str(sum(1 for m in ms if not m['transcript'])) + ' without a transcript' if any(not m['transcript'] for m in ms) else ''}"
                    f"{', ' + str(sum(1 for m in ms if m['imported'])) + ' already imported' if any(m['imported'] for m in ms) else ''}. "
                    "Import with action 'import' and their uuids.")
            if any(not m["transcript"] for m in ms):
                text += " " + got["no_transcript_help"]
            return text, {"action": "list", "from": got["from"], "to": got["to"], "meetings": ms, "total": got["total"],
                          "not_in_zoom": got["not_in_zoom"], "results": [], "counts": {}}
        uuids = [str(u) for u in args.get("uuids") or []]
        if not uuids:
            raise ToolError("Pass the uuids of the meetings to import (from action 'list').")
        got = await zoom.import_recordings(ctx.db, ctx.user, ws_id, uuids)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    c = got["counts"]
    parts = [f"{n} {k.replace('_', ' ')}" for k, n in c.items()]
    return "Zoom import: " + ", ".join(parts) + ".", {"action": "import", "meetings": [], "results": got["results"],
                                                     "counts": c, "total": len(got["results"])}


ZOOM_TOOLS: list[Tool] = [
    Tool(
        name="zoom_status",
        title="Zoom connection",
        description=("Whether a workspace is connected to its Zoom account, which team recorded Zoom meetings go to (only "
                     "meetings hosted by that team's members come in, visible to that team), and how imports are going: "
                     "the latest ones and meetings that had no transcript. Read-only: connecting is done on the website "
                     f"({_SETUP}); for an admin of a workspace that isn't connected, it also returns connect_url, a "
                     "one-click link to approve the Markdrop app for Zoom (opened in the person's browser)."),
        scope=READ,
        input_schema={"type": "object", "properties": {"workspace": _WORKSPACE_ARG}, "required": ["workspace"]},
        output_schema=_out({"workspace_id": {"type": "string"}, "connected": {"type": "boolean"},
                            "can_manage": {"type": "boolean"}, "can_import": {"type": "boolean"},
                            "mode": {"type": ["string", "null"]}, "one_click_available": {"type": "boolean"},
                            "connect_url": {"type": ["string", "null"]},
                            "team": {"type": ["object", "null"]}, "broken": {"type": ["string", "null"]},
                            "missing_scopes": {"type": "array", "items": {"type": "string"}},
                            "imported": {"type": "integer"}, "no_transcript": {"type": "integer"},
                            "last_import_at": {"type": ["string", "null"]}, "last_event_at": {"type": ["string", "null"]},
                            "recent": {"type": "array", "items": {"type": "object"}}},
                           ["workspace_id", "connected"]),
        annotations=_ann(True, False, True),
        handler=zoom_status,
    ),
    Tool(
        name="import_zoom_meetings",
        title="Import past Zoom meetings",
        description=("Bring past recorded Zoom meetings into the workspace's Zoom team. action 'list' (default): the team "
                     "members' recorded meetings in a range (days: 30 or 90, or from/to YYYY-MM-DD) with host, date, "
                     "duration, whether Zoom made a transcript, and whether it's already imported. action 'import': "
                     "import the chosen uuids (up to 50; each needs a transcript) as past meetings with a summary, "
                     "decisions and action items; nobody is notified. Workspace admins and the team's leads only."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "workspace": _WORKSPACE_ARG,
            "action": {"type": "string", "enum": ["list", "import"], "default": "list"},
            "days": {"type": "integer", "minimum": 1, "maximum": zoom.MAX_RANGE_DAYS, "default": 30},
            "from": {"type": "string", "description": "YYYY-MM-DD"},
            "to": {"type": "string", "description": "YYYY-MM-DD"},
            "uuids": {"type": "array", "items": {"type": "string", "maxLength": 128}, "maxItems": zoom.MAX_IMPORT,
                      "description": "action 'import': the meetings' uuids from action 'list'."}},
            "required": ["workspace"]},
        output_schema=_out({"action": {"type": "string"}, "meetings": {"type": "array", "items": {"type": "object"}},
                            "results": {"type": "array", "items": {"type": "object"}}, "counts": {"type": "object"},
                            "total": {"type": "integer"}}, ["action", "meetings", "results", "counts", "total"]),
        annotations=_ann(False, False, True),
        handler=import_zoom_meetings,
    ),
]
