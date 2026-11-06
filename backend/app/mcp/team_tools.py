"""MCP tools for Team memory (services/workspace_memory.py, services/team_extras.py).

READ: ``list_team``, ``get_person_profile``, ``get_project_status``, ``list_team_groups``.
WRITE, the user's own lines only (the same rules as the Team pages, routers/team.py):
``set_my_status``, ``set_focus_note``, ``hide_team_line``, ``correct_team_line``,
``mark_team_item_done``. WRITE, workspace admins only (as on the website): ``save_team_group``,
``delete_team_group``, ``send_weekly_summary_now``.

READ scope. The same per-viewer composition as the Team pages: every line comes from a meeting or page
the caller can open now (a restricted meeting's facts never reach anyone outside it), with links to
where it was said. Workspace members only; nothing when the workspace has Team memory off. No model
call (the facts are read in the background), so these cost nothing.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from app.config import get_settings
from app.mcp.auth import READ, WRITE
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
    if ws is None or ws.deleting:
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
        out.append({"id": x["id"], "kind": x["kind"], "text": x["text"], "date": x.get("day"), "due": x.get("due"),
                    "project": (x.get("project") or {}).get("name"), "corrected": bool(x.get("corrected")),
                    "person": (x.get("person") or {}).get("name"), "sources": src,
                    "can_correct": bool(x.get("can_correct"))})
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
           "url": _abs(f"/team/{ws.id}/people/{uid}"), "updated_at": got.get("updated_at"),
           "you": bool(p.get("you")), "own_status": _own_status_out(got.get("own_status")),
           "hidden": _lines(got.get("hidden") or [])}
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
    if out["you"]:
        parts.append("These are the user's own lines: each has an id for hide_team_line, correct_team_line and "
                     "mark_team_item_done (action items and targets)."
                     + (f" Hidden by them: {len(out['hidden'])}." if out["hidden"] else ""))
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


def _own_status_out(st: dict | None) -> dict | None:
    if not st:
        return None
    return {"text": st.get("text"), "emoji": st.get("emoji"),
            "until": (st["until"].isoformat() if hasattr(st.get("until"), "isoformat") else st.get("until"))}


def _refused(exc: wm.Refused) -> ToolError:
    return ToolError(exc.detail)


async def set_my_status(ctx: Context, args: dict) -> tuple[str, dict]:
    """The user's own status on Team (wins over what Team memory reads), like Set status on their card."""
    from datetime import datetime

    ws, _role = await _ws(ctx, args["workspace"])
    text = args.get("status") or ""
    until = None
    if args.get("until"):
        try:
            until = datetime.fromisoformat(str(args["until"]).replace("Z", "+00:00"))
        except ValueError:
            raise ToolError("until: an ISO date-time like 2026-11-10T09:00:00+05:30 (or leave it out: until cleared).")
    try:
        st = await wm.set_status(ctx.db, ws.id, ctx.user.id, text, args.get("emoji"), until)
    except wm.Refused as exc:
        raise _refused(exc)
    out = {"status": _own_status_out(st), "url": _abs(f"/team/{ws.id}/people/{ctx.user.id}")}
    if st is None:
        return f"Cleared the user's status in {ws.name}: Team shows what it reads from meetings and pages again.", out
    when = f" until {out['status']['until']}" if out["status"].get("until") else " until they clear it"
    return (f"Status set in {ws.name}: {(st.get('emoji') + ' ') if st.get('emoji') else ''}{st.get('text')}{when}. "
            "It shows on their Team card instead of what Team memory reads."), out


async def set_focus_note(ctx: Context, args: dict) -> tuple[str, dict]:
    """The user's "What I'm focused on" note: it tops their Team card and profile ("" clears it)."""
    ws, _role = await _ws(ctx, args["workspace"])
    got = await wm.set_focus(ctx.db, ws.id, ctx.user.id, args.get("text") or "")
    out = {"focus": got, "url": _abs(f"/team/{ws.id}/people/{ctx.user.id}")}
    if got is None:
        return f"Cleared the user's focus note in {ws.name}.", out
    return f"Focus note set in {ws.name}: “{got['text']}”. It tops their Team card.", out


async def _line_op(ctx: Context, args: dict, op) -> tuple[wm.WsInfo, dict]:
    ws, role = await _ws(ctx, args["workspace"])
    try:
        return ws, await op(ctx.db, actor_of(ctx), access_service.Ctx(ctx.db, surface="mcp"), ws,
                            str(args["line_id"]).strip(), role)
    except wm.Refused as exc:
        raise _refused(exc)


async def hide_team_line(ctx: Context, args: dict) -> tuple[str, dict]:
    on = args.get("hidden", True) is not False

    async def op(db, actor, actx, ws, fid, role):
        return await wm.hide(db, actor, actx, ws, fid, role, on=on)

    ws, got = await _line_op(ctx, args, op)
    return (("Hidden from Team for everyone (it stays hidden when its meeting or page is read again; "
             "hidden: false undoes it).") if on else "Shown on Team again."), got


async def correct_team_line(ctx: Context, args: dict) -> tuple[str, dict]:
    clear = bool(args.get("clear"))
    text = None if clear else (args.get("text") or "")

    async def op(db, actor, actx, ws, fid, role):
        return await wm.correct(db, actor, actx, ws, fid, role, text)

    ws, got = await _line_op(ctx, args, op)
    if clear:
        return "Correction removed: the line shows as Team memory read it again.", got
    if text:
        return (f"Corrected: Team shows “{got['correction']['text']}” instead, and later reads of the same meeting "
                "or page won't say the old version again."), got
    return "Marked wrong: the line no longer shows to anyone else, and later reads won't say it again.", got


async def mark_team_item_done(ctx: Context, args: dict) -> tuple[str, dict]:
    on = args.get("done", True) is not False

    async def op(db, actor, actx, ws, fid, role):
        return await wm.mark_done(db, actor, actx, ws, fid, role, on=on)

    ws, got = await _line_op(ctx, args, op)
    return (("Marked done: it leaves the user's open items, the Team board and This week (and stays done when its "
             "source is read again).") if on else "Not done after all: it's an open item again."), got


async def _admin_ws(ctx: Context, value: str) -> wm.WsInfo:
    from app.models.workspace import role_allows

    ws, role = await _ws(ctx, value)
    if not role_allows(role, "admin"):
        raise ToolError("Only workspace admins can do this.")
    return ws


async def list_team_groups(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.models.workspace import role_allows
    from app.services import team_extras

    ws, role = await _ws(ctx, args["workspace"])
    names = {m["id"]: m["name"] for m in await wm.members_of(ctx.db, ws.id)}

    def shape(g: dict) -> dict:
        return {**({"id": g["id"]} if g.get("id") else {}), "name": g["name"], "member_ids": g["member_ids"],
                "members": [names.get(u, "Former member") for u in g["member_ids"]]}

    groups = [shape(g) for g in await team_extras.list_groups(ctx.db, ws.id)]
    admin = role_allows(role, "admin")
    sugg = [shape(g) for g in await team_extras.suggest_groups(
        ctx.db, actor_of(ctx), access_service.Ctx(ctx.db, surface="mcp"), ws.id)] if admin else []
    out = {"workspace": ws.name, "groups": groups, "suggestions": sugg, "can_manage": admin,
           "url": _abs(f"/team/{ws.id}")}
    lines = [f"Team groups in {ws.name}: " + ("none yet." if not groups else "")]
    for g in groups:
        lines.append(f"- {g['name']} (id {g['id']}): {', '.join(g['members']) or 'nobody'}")
    if sugg:
        lines.append("Suggested from meeting series (save_team_group creates one):")
        for g in sugg:
            lines.append(f"- {g['name']}: {', '.join(g['members'])}")
    return "\n".join(lines), out


async def _member_ids(ctx: Context, ws: wm.WsInfo, people: list[str]) -> list[str]:
    return [await _person_id(ctx, ws, p) for p in people]


async def save_team_group(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import team_extras

    ws = await _admin_ws(ctx, args["workspace"])
    gid = (args.get("group_id") or "").strip() or None
    current = None
    if gid:
        current = next((g for g in await team_extras.list_groups(ctx.db, ws.id) if g["id"] == gid), None)
        if current is None:
            raise ToolError("Group not found. list_team_groups shows the groups and their ids.")
    name = args.get("name") or (current or {}).get("name") or ""
    if args.get("members") is not None:
        ids = await _member_ids(ctx, ws, args["members"])
    else:
        ids = list((current or {}).get("member_ids") or [])
    try:
        g = await team_extras.save_group(ctx.db, ws.id, ctx.user.id, name, ids, gid)
    except wm.Refused as exc:
        raise _refused(exc)
    names = {m["id"]: m["name"] for m in await wm.members_of(ctx.db, ws.id)}
    out = {**g, "members": [names.get(u, "Former member") for u in g["member_ids"]], "created": gid is None}
    return (f"{'Created' if gid is None else 'Saved'} the group “{g['name']}” in {ws.name} "
            f"({', '.join(out['members']) or 'nobody yet'}). The Team board can be filtered by it."), out


async def delete_team_group(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import team_extras

    ws = await _admin_ws(ctx, args["workspace"])
    if not await team_extras.delete_group(ctx.db, ws.id, str(args["group_id"]).strip()):
        raise ToolError("Group not found. list_team_groups shows the groups and their ids.")
    return "Group deleted (its members stay in the workspace).", {"deleted": True}


def _weekly_limited(workspace_id: str) -> bool:
    """6 an hour per workspace, like POST /team/{ws}/weekly/send (fails open, like the MCP limiter)."""
    try:
        from limits import parse

        from app.limiter import limiter

        return not limiter.limiter.hit(parse("6/hour"), "mcp", "team_weekly", workspace_id)
    except Exception:  # pragma: no cover - depends on the limiter backend
        return False


async def send_weekly_summary_now(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import team_extras

    ws = await _admin_ws(ctx, args["workspace"])
    if _weekly_limited(ws.id):
        raise ToolError("This week's summary was sent several times in the last hour; try again later.")
    got = await team_extras.send_weekly(ctx.db, ws, force=True)
    d = got["delivery"]
    out = {"week": got["week"], "from": got.get("from"), "to": got.get("to"), "highlights": len(got["highlights"]),
           "due": len(got["due"]), "overdue": len(got["overdue"]), "blockers": len(got["blockers"]),
           "slack": d.get("slack"), "emails": d.get("emails", 0), "url": _abs(f"/team/{ws.id}")}
    if not (got["highlights"] or got["blockers"] or got["due"] or got["overdue"]):
        return f"Nothing to summarise in {ws.name} this week ({got['week']}), so nothing was sent.", out
    where = []
    if d.get("slack") == "posted":
        where.append("posted to the Slack meetings channel")
    elif d.get("slack"):
        where.append(f"Slack post failed ({d['slack']})")
    where.append(f"emailed to {d.get('emails', 0)} admin(s)")
    return (f"This week's summary for {ws.name} ({got['week']}: {out['highlights']} highlights, {out['due']} due, "
            f"{out['overdue']} overdue, {out['blockers']} blockers): " + "; ".join(where)
            + ". It's also Team's This week card."), out


_LINE = _out({"kind": _STR, "text": _STR, "date": _NSTR, "due": _NSTR, "project": _NSTR, "person": _NSTR,
              "corrected": {"type": "boolean"}, "id": _STR, "can_correct": {"type": "boolean"},
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
                            "url": _STR, "updated_at": _NSTR, "you": {"type": "boolean"},
                            "own_status": {"type": ["object", "null"]}, "hidden": _LINES},
                           ["name", "status", "url"]),
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

_LINE_ID = {"type": "string", "minLength": 1, "maxLength": 40,
            "description": "The line's id, from get_person_profile with person \"me\" (each line has an id)."}
_GROUP = _out({"id": _STR, "name": _STR, "member_ids": {"type": "array", "items": _STR},
               "members": {"type": "array", "items": _STR}}, ["name", "member_ids", "members"])
_OWN = ("Only the user's own lines: Team memory's lines about them (a project's own lines too, for "
        "workspace admins), never someone else's — as on the website.")

TEAM_TOOLS += [
    Tool(
        name="set_my_status",
        title="Set my Team status",
        description=("Set the user's own status on Team (\"On leave till Monday\", \"Heads down on the launch\"), with "
                     "an optional emoji and end time. It shows on their Team card and profile instead of the status "
                     "Team memory reads from meetings and pages (On track, Blocked, Quiet lately…) until it ends or "
                     "is cleared. status \"\" (and no emoji) clears it. Up to 80 characters. Workspace members only; "
                     "Team memory must be on."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "workspace": _WS,
            "status": {"type": "string", "maxLength": 180, "description": "The status text; \"\" clears it."},
            "emoji": {"type": ["string", "null"], "maxLength": 16},
            "until": {"type": ["string", "null"], "maxLength": 40,
                      "description": "When it stops applying, an ISO date-time in the future; leave out to keep it until cleared."}},
            "required": ["workspace", "status"]},
        output_schema=_out({"status": {"type": ["object", "null"]}, "url": _STR}),
        annotations=_ann(False, False, True),
        handler=set_my_status,
    ),
    Tool(
        name="set_focus_note",
        title="Set my focus note (Team)",
        description=("Set the user's \"What I'm focused on\" note on Team, in their own words (up to 280 "
                     "characters): it tops their Team card and profile above what Team memory reads. text \"\" "
                     "clears it. Workspace members only; Team memory must be on."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "workspace": _WS, "text": {"type": "string", "maxLength": 480}}, "required": ["workspace", "text"]},
        output_schema=_out({"focus": {"type": ["object", "null"]}, "url": _STR}),
        annotations=_ann(False, False, True),
        handler=set_focus_note,
    ),
    Tool(
        name="hide_team_line",
        title="Hide a line about me (Team)",
        description=("Hide one of Team memory's lines about the user, for everyone (\"Hide\" on the website); it "
                     "stays hidden when its meeting or page is read again. hidden: false shows it again (hidden "
                     "lines are listed under hidden in get_person_profile for \"me\"). " + _OWN),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "workspace": _WS, "line_id": _LINE_ID, "hidden": {"type": "boolean", "default": True}},
            "required": ["workspace", "line_id"]},
        output_schema=_out({"id": _STR, "hidden": {"type": "boolean"}}),
        annotations=_ann(False, False, True),
        handler=hide_team_line,
    ),
    Tool(
        name="correct_team_line",
        title="Correct a line about me (Team)",
        description=("\"This is wrong\" on one of Team memory's lines about the user, with the right version "
                     "(optional): others see the right version instead (or, with no text, nothing), and later "
                     "reads of the same meeting or page are told not to say it again. clear: true removes the "
                     "correction. " + _OWN),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "workspace": _WS, "line_id": _LINE_ID,
            "text": {"type": ["string", "null"], "maxLength": 500, "description": "The right version (optional)."},
            "clear": {"type": "boolean", "default": False}},
            "required": ["workspace", "line_id"]},
        output_schema=_out({"id": _STR, "correction": {"type": ["object", "null"]}}),
        annotations=_ann(False, False, True),
        handler=correct_team_line,
    ),
    Tool(
        name="mark_team_item_done",
        title="Mark my action item done (Team)",
        description=("Mark one of the user's action items or targets done (\"Mark done\" on the website): it "
                     "leaves their open items, the Team board and This week, and stays done when its meeting or "
                     "page is read again. done: false makes it open again. Action items and targets only. " + _OWN),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "workspace": _WS, "line_id": _LINE_ID, "done": {"type": "boolean", "default": True}},
            "required": ["workspace", "line_id"]},
        output_schema=_out({"id": _STR, "done": {"type": "boolean"}}),
        annotations=_ann(False, False, True),
        handler=mark_team_item_done,
    ),
    Tool(
        name="list_team_groups",
        title="Team groups",
        description=("The workspace's Team groups (the board's filters: \"Sourcing team\", \"Design\"…) with their "
                     "members; for workspace admins also suggested groups, one per recurring meeting series, of the "
                     "members at half or more of its meetings in the last 60 days. Workspace members only; Team "
                     "memory must be on."),
        scope=READ,
        input_schema={"type": "object", "properties": {"workspace": _WS}, "required": ["workspace"]},
        output_schema=_out({"workspace": _STR, "groups": {"type": "array", "items": _GROUP},
                            "suggestions": {"type": "array", "items": _GROUP}, "can_manage": {"type": "boolean"},
                            "url": _STR}),
        annotations=_ann(True, False, True),
        handler=list_team_groups,
    ),
    Tool(
        name="save_team_group",
        title="Create or edit a Team group",
        description=("Create a Team group (no group_id) or rename it / change its members (group_id from "
                     "list_team_groups). members: names (first name is fine when unique), emails or ids of "
                     "workspace members; it replaces the list (leave it out to keep the members when renaming). "
                     "Workspace admins only, as on the website."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "workspace": _WS,
            "group_id": {"type": ["string", "null"], "maxLength": 40},
            "name": {"type": "string", "minLength": 1, "maxLength": 80},
            "members": {"type": ["array", "null"], "maxItems": 500, "items": {"type": "string", "maxLength": 200}}},
            "required": ["workspace"]},
        output_schema=_out({"id": _STR, "name": _STR, "member_ids": {"type": "array", "items": _STR},
                            "members": {"type": "array", "items": _STR}, "created": {"type": "boolean"}}),
        annotations=_ann(False, False, False),
        handler=save_team_group,
    ),
    Tool(
        name="delete_team_group",
        title="Delete a Team group",
        description=("Delete a Team group (its members stay in the workspace; the board loses that filter). "
                     "Workspace admins only."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "workspace": _WS, "group_id": {"type": "string", "minLength": 1, "maxLength": 40}},
            "required": ["workspace", "group_id"]},
        output_schema=_out({"deleted": {"type": "boolean"}}),
        annotations=_ann(False, True, True),
        handler=delete_team_group,
    ),
    Tool(
        name="send_weekly_summary_now",
        title="Send this week's Team summary now",
        description=("Send this week's Team summary now (it goes out on its own on Mondays at 9 am, workspace "
                     "time): highlights, what's due this week, overdue items and blockers — only from meetings and "
                     "pages the whole team can open — posted to the Slack meetings channel when Slack is connected, "
                     "emailed to the workspace's admins, and kept as Team's This week card. Nothing is sent when "
                     "there's nothing to say. Workspace admins only; a few times an hour at most."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {"workspace": _WS}, "required": ["workspace"]},
        output_schema=_out({"week": _STR, "from": _NSTR, "to": _NSTR, "highlights": {"type": "integer"},
                            "due": {"type": "integer"}, "overdue": {"type": "integer"}, "blockers": {"type": "integer"},
                            "slack": _NSTR, "emails": {"type": "integer"}, "url": _STR}),
        annotations=_ann(False, False, False),
        handler=send_weekly_summary_now,
    ),
]
