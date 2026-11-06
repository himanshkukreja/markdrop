"""MCP tools for Team memory (services/workspace_memory.py): ``list_team``, ``get_person_profile`` and
``get_project_status``.

READ scope. The same per-viewer composition as the Team pages: every line comes from a meeting or page
the caller can open now (a restricted meeting's facts never reach anyone outside it), with links to
where it was said. Workspace members only; nothing when the workspace has Team memory off. No model
call (the facts are read in the background), so these cost nothing.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from app.config import get_settings
from app.mcp.auth import READ
from app.mcp.tools import Context, Tool, ToolError, _ann, _out, actor_of, http_message, resolve_workspace
from app.services import access as access_service
from app.services import workspace_memory as wm

_STR = {"type": "string"}
_NSTR = {"type": ["string", "null"]}


def _abs(href: str | None) -> str | None:
    if not href:
        return href
    return get_settings().frontend_url.rstrip("/") + href if href.startswith("/") else href


async def _ws(ctx: Context, value: str) -> tuple[wm.WsInfo, str]:
    try:
        ws_id, _w, role = await resolve_workspace(ctx, value)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    ws = await wm.ws_info(ctx.db, ws_id)
    if ws is None:
        raise ToolError("Workspace not found.")
    if not ws.on:
        raise ToolError(f"Team memory is off in {ws.name}. A workspace admin can turn it on in the "
                        "workspace's settings (Advanced › Team memory).")
    return ws, role


def _lines(items: list[dict]) -> list[dict[str, Any]]:
    out = []
    for x in items:
        src = [{"title": s["title"], "kind": s["kind"], "date": s.get("date"),
                "url": (s.get("moment") or {}).get("url") or s["url"]} for s in x.get("sources") or []]
        out.append({"kind": x["kind"], "text": x["text"], "date": x.get("day"), "due": x.get("due"),
                    "project": (x.get("project") or {}).get("name"), "corrected": bool(x.get("corrected")),
                    "person": (x.get("person") or {}).get("name"), "sources": src})
    return out


def _bullets(title: str, items: list[dict]) -> str:
    if not items:
        return ""
    rows = []
    for x in items:
        bits = [x["text"]]
        if x.get("due"):
            bits.append(f"due {x['due']}")
        if x.get("person"):
            bits.insert(0, x["person"] + ":")
        if x.get("sources"):
            s = x["sources"][0]
            bits.append(f"({s['title']}, {s.get('date') or ''} {s['url']})")
        rows.append("- " + " ".join(b for b in bits if b))
    return f"{title}:\n" + "\n".join(rows)


async def list_team(ctx: Context, args: dict) -> tuple[str, dict]:
    ws, role = await _ws(ctx, args["workspace"])
    got = await wm.team(ctx.db, actor_of(ctx), access_service.Ctx(ctx.db, surface="mcp"), ws, role)
    people = [{"id": p["id"], "name": p["name"], "role": p.get("role"), "status": p["status"]["label"],
               "status_state": p["status"]["state"], "reason": p["status"].get("reason"),
               "now": (p.get("now") or {}).get("text"), "open_items": p["open_items"], "overdue": p["overdue"],
               "targets": [{"text": t["text"], "due": t["due"], "state": t["state"]} for t in p["targets"]],
               "updated_at": p.get("updated_at"),
               "url": _abs(f"/team/{ws.id}/people/{p['id']}")} for p in got["people"]]
    projects = [{"key": p["key"], "name": p["name"], "status": p.get("status"), "people": [x["name"] for x in p["people"]],
                 "url": _abs(f"/team/{ws.id}/projects/{p['key']}")} for p in got["projects"]]
    from app.services import team_extras

    groups = await team_extras.list_groups(ctx.db, ws.id)
    for p in people:
        p["groups"] = [g["name"] for g in groups if p["id"] in g["member_ids"]]
    week = await team_extras.this_week(ctx.db, ws)
    out = {"workspace": ws.name, "people": people, "projects": projects, "groups": [g["name"] for g in groups],
           "this_week": ({"from": week["from"], "to": week["to"],
                          "highlights": [team_extras.highlight_line(h) for h in week["highlights"]],
                          "due": [f"{team_extras.pname(x)}: {x['text']} (due {x['due']})" for x in week["due"]],
                          "overdue": [f"{team_extras.pname(x)}: {x['text']} (due {x['due']})" for x in week["overdue"]]} if week else None),
           "blockers": [{"person": b["person"]["name"], "text": b["text"], "since": b.get("since"),
                         "waiting_on": (b.get("waiting_on") or {}).get("name")} for b in got["blockers"]],
           "url": _abs(f"/team/{ws.id}")}
    lines = [f"Team in {ws.name} ({len(people)} people):"]
    for p in people:
        lines.append(f"- {p['name']}: {p['status']}" + (f" — {p['reason']}" if p.get("reason") else "")
                     + (f". Now: {p['now']}" if p.get("now") else "") + (f". {p['open_items']} open item(s)" if p["open_items"] else ""))
    if projects:
        lines.append("Projects: " + "; ".join(f"{p['name']}" + (f" ({p['status']})" if p.get("status") else "") for p in projects))
    return "\n".join(lines), out


async def _person_id(ctx: Context, ws: wm.WsInfo, value: str) -> str:
    members = await wm.members_of(ctx.db, ws.id)
    v = (value or "").strip()
    if v.lower() in ("me", "myself", "i"):
        return ctx.user.id
    for m in members:
        if m["id"] == v or (m.get("email") or "").lower() == v.lower():
            return m["id"]
    hit = wm.match_people(v, members, None) or []
    if len(hit) == 1:
        return hit[0]["id"]
    if len(hit) > 1:
        raise ToolError("More than one member matches: " + ", ".join(f"{m['name']} (id {m['id']})" for m in hit)
                        + ". Pass the id.")
    raise ToolError(f"No member of {ws.name} matches “{v}”. list_team shows who is in it.")


async def get_person_profile(ctx: Context, args: dict) -> tuple[str, dict]:
    ws, role = await _ws(ctx, args["workspace"])
    uid = await _person_id(ctx, ws, args["person"])
    got = await wm.person_profile(ctx.db, actor_of(ctx), access_service.Ctx(ctx.db, surface="mcp"), ws, uid, role=role)
    if got is None:
        raise ToolError("Nothing known about that person yet.")
    p = got["person"]
    out = {"name": p["name"], "role": p.get("role"), "title": p.get("title"), "status": got["status"]["label"],
           "status_reason": got["status"].get("reason"), "focus": (got.get("focus") or {}).get("text"),
           "now": (got.get("now") or {}).get("text"),
           "working_on": _lines(got["working_on"]), "targets": _lines(got["targets"]), "updates": _lines(got["updates"]),
           "action_items": _lines(got["action_items"]), "decisions": _lines(got["decisions"]),
           "documents": [{"title": d["title"], "url": _abs(d["href"]), "updated_at": d.get("updated_at")} for d in got["documents"]],
           "meetings": [{"title": m["title"], "date": m.get("date"), "url": _abs(m["href"])} for m in got["meetings"]],
           "url": _abs(f"/team/{ws.id}/people/{uid}"), "updated_at": got.get("updated_at")}
    head = f"{p['name']} — {out['status']}" + (f": {out['status_reason']}" if out.get("status_reason") else "")
    parts = [head]
    if out.get("focus"):
        parts.append(f"In their own words: {out['focus']}")
    for title, key in (("Working on now", "working_on"), ("Targets", "targets"), ("Recent updates", "updates"),
                       ("Open action items", "action_items"), ("Decisions they own", "decisions")):
        b = _bullets(title, out[key])
        if b:
            parts.append(b)
    if len(parts) == 1:
        parts.append("Nothing recorded about them in meetings or pages the user can open yet.")
    parts.append(f"Profile: {out['url']}")
    return "\n\n".join(parts), out


async def get_project_status(ctx: Context, args: dict) -> tuple[str, dict]:
    ws, role = await _ws(ctx, args["workspace"])
    actor, actx = actor_of(ctx), access_service.Ctx(ctx.db, surface="mcp")
    q = (args.get("project") or "").strip()
    key = wm.project_key(q) or ""
    got = await wm.project_profile(ctx.db, actor, actx, ws, key, role=role)
    if got is None:
        hits = await wm.match_projects(ctx.db, ws.id, q)
        for h in hits:
            got = await wm.project_profile(ctx.db, actor, actx, ws, h["key"], role=role)
            if got is not None:
                break
    if got is None:
        names = [p["name"] for p in await wm.projects(ctx.db, actor, actx, ws)]
        raise ToolError(f"No project “{q}” in {ws.name}." + (f" Known: {', '.join(names[:20])}." if names else ""))
    pr = got["project"]
    out = {"name": pr["name"], "status": (got.get("status") or {}).get("text"),
           "people": [{"name": p["name"], "facts": p["facts"]} for p in got["people"]],
           "working_on": _lines(got["working_on"]), "decisions": _lines(got["decisions"]),
           "open_items": _lines(got["open_items"]), "updates": _lines(got["updates"]),
           "url": _abs(f"/team/{ws.id}/projects/{pr['key']}"), "updated_at": pr.get("updated_at")}
    parts = [f"{pr['name']}" + (f" — {out['status']}" if out.get("status") else ""),
             "People: " + ", ".join(p["name"] for p in out["people"])]
    for title, k in (("Being worked on", "working_on"), ("Decisions", "decisions"), ("Open items and blockers", "open_items"),
                     ("Recent updates", "updates")):
        b = _bullets(title, out[k])
        if b:
            parts.append(b)
    parts.append(f"Project page: {out['url']}")
    return "\n\n".join(parts), out


_LINE = _out({"kind": _STR, "text": _STR, "date": _NSTR, "due": _NSTR, "project": _NSTR, "person": _NSTR,
              "corrected": {"type": "boolean"},
              "sources": {"type": "array", "items": _out({"title": _STR, "kind": _STR, "date": _NSTR, "url": _STR})}})
_LINES = {"type": "array", "items": _LINE}
_WS = {"type": "string", "maxLength": 200, "description": "The workspace: its id, name or domain (list_workspaces)."}

TEAM_TOOLS = [
    Tool(
        name="list_team",
        title="Who is doing what (Team)",
        description=("The Team board of a workspace: every member with their status (On track, Blocked, Waiting "
                     "on someone, Quiet lately, or the status they set themselves), what they're on now, targets "
                     "with due dates, open items, their groups; current blockers; recurring projects; this week's "
                     "summary (highlights, due this week, overdue). Built from the "
                     "workspace's meetings and pages by Team memory, filtered to what the user can open. "
                     "Workspace members only; the workspace must have Team memory on."),
        scope=READ,
        input_schema={"type": "object", "properties": {"workspace": _WS}, "required": ["workspace"]},
        output_schema=_out({"workspace": _STR, "url": _STR,
                            "people": {"type": "array", "items": {"type": "object"}},
                            "projects": {"type": "array", "items": {"type": "object"}},
                            "blockers": {"type": "array", "items": {"type": "object"}},
                            "groups": {"type": "array", "items": _STR},
                            "this_week": {"type": ["object", "null"]}},
                           ["workspace", "people", "projects"]),
        annotations=_ann(True, False, True),
        handler=list_team,
    ),
    Tool(
        name="get_person_profile",
        title="What is someone working on (Team)",
        description=("A workspace member's Team profile: status, their own focus note, what they're working on "
                     "now, targets with due dates, recent updates, open action items, decisions they own, their "
                     "recent documents and meetings — every line with a link to the meeting or page it came "
                     "from, and only from ones the user can open. Use it for \"what is Abhishek working on?\" or "
                     "\"what's Priya's status?\". person: a name (first name is fine when unique), email, id or "
                     "\"me\"."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "workspace": _WS,
            "person": {"type": "string", "minLength": 1, "maxLength": 200}},
            "required": ["workspace", "person"]},
        output_schema=_out({"name": _STR, "role": _NSTR, "title": _NSTR, "status": _STR, "status_reason": _NSTR,
                            "focus": _NSTR, "now": _NSTR, "working_on": _LINES, "targets": _LINES, "updates": _LINES,
                            "action_items": _LINES, "decisions": _LINES,
                            "documents": {"type": "array", "items": {"type": "object"}},
                            "meetings": {"type": "array", "items": {"type": "object"}},
                            "url": _STR, "updated_at": _NSTR}, ["name", "status", "url"]),
        annotations=_ann(True, False, True),
        handler=get_person_profile,
    ),
    Tool(
        name="get_project_status",
        title="Where a project stands (Team)",
        description=("A recurring project's status as Team memory has it: the latest status, who is on it, what's "
                     "being worked on, decisions, open items and blockers, recent updates — each with a link to "
                     "its meeting or page, only from ones the user can open. project: its name (list_team lists "
                     "them)."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "workspace": _WS,
            "project": {"type": "string", "minLength": 1, "maxLength": 120}},
            "required": ["workspace", "project"]},
        output_schema=_out({"name": _STR, "status": _NSTR, "people": {"type": "array", "items": {"type": "object"}},
                            "working_on": _LINES, "decisions": _LINES, "open_items": _LINES, "updates": _LINES,
                            "url": _STR, "updated_at": _NSTR}, ["name", "url"]),
        annotations=_ann(True, False, True),
        handler=get_project_status,
    ),
]
