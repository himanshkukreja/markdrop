"""MCP tools for personal to-do pages (services/todo_pages.py): one page per person per team, from the team's calls.

READ: ``my_todos`` (yours, across your teams), ``team_todos`` (a team's leads: every member's open items).
WRITE: ``tick_todo`` (yours; the call's action item follows).

The same rules as the website (routers/todos.py): a to-do page is its owner's; the team's leads read every member's.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from app.mcp.auth import READ, WRITE
from app.mcp.tools import Context, Tool, ToolError, _ann, _out, http_message, public_url
from app.services import todo_pages

_O = {"type": "object"}
_WS = {"type": "string", "description": "Workspace id or name (list_workspaces)."}
_TEAM = {"type": "string", "description": "Team id, slug or name (list_teams)."}


def _page_out(card: dict, items: list[dict]) -> dict:
    return {"team": card["team"]["name"], "team_id": card["team"]["id"], "person": card["user"]["name"],
            "url": public_url(card["slug"]) if card.get("slug") else None, "slug": card.get("slug"), "open": card["open"],
            "companies": card.get("sections") or [], "items": items}


def _lines(items: list[dict]) -> list[str]:
    out = []
    for it in items:
        call = f" — {it['call']['title']}" if it.get("call") else ""
        out.append(f"  - [{'x' if it['done'] else ' '}] {it['text']}" + (f" (due {it['due']})" if it.get("due") else "")
                   + (f" · {it['company']}" if it.get("company") else "") + call + f" [{it['block']}]")
    return out


async def _workspace_id(ctx: Context, ref: str | None) -> str | None:
    if not ref:
        return None
    from app.mcp.tools import resolve_workspace

    try:
        ws_id, _w, _role = await resolve_workspace(ctx, ref)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    return ws_id


async def my_todos(ctx: Context, args: dict) -> tuple[str, dict]:
    ws = await _workspace_id(ctx, args.get("workspace"))
    cards = await todo_pages.mine(ctx.db, ctx.user, workspace_id=ws)
    team = (args.get("team") or "").strip().casefold()
    if team:
        cards = [c for c in cards if team in ((c["team"]["name"] or "").casefold(), c["team"]["id"])]
    open_only = args.get("include_done") is not True
    pages = [_page_out(c, await todo_pages.items_of(ctx.db, c["slug"], open_only=open_only)) for c in cards if c.get("slug")]
    if not pages:
        return "You're not in any team with to-dos (General has none).", {"pages": []}
    text = []
    for p in pages:
        text.append(f"{p['team']}: {p['open']} open — {p['url']}")
        text += _lines(p["items"]) or ["  No open action items yet."]
    return "\n".join(text), {"pages": pages}


async def team_todos(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import access
    from app.services import teams as T

    ws = await _workspace_id(ctx, args["workspace"])
    actx = access.Ctx(ctx.db, surface="mcp")
    view = await actx.team_view(ws, ctx.user.id)
    row = await T.get_team(ctx.db, ws, (args.get("team") or "").strip())
    if row is None or str(row["_id"]) not in view.readable_teams:
        raise ToolError(f"No team “{args.get('team')}” you can open. list_teams shows them.")
    if not view.lead_of(str(row["_id"])):
        raise ToolError(f"Only {row.get('name')}'s leads see every member's to-dos. my_todos shows yours.")
    got = await todo_pages.team(ctx.db, ctx.user, view, row)
    person = (args.get("person") or "").strip().casefold()
    cards = [c for c in got["pages"] if not person or person in c["user"]["name"].casefold() or person == c["user"]["id"]]
    pages = [_page_out(c, await todo_pages.items_of(ctx.db, c["slug"])) for c in cards if c.get("slug")]
    text = [f"{row.get('name')}: {len(pages)} to-do page(s)."]
    for p in pages:
        text.append(f"{p['person']}: {p['open']} open — {p['url']}")
        text += _lines(p["items"])
    return "\n".join(text), {"team": row.get("name"), "pages": pages}


async def tick_todo(ctx: Context, args: dict) -> tuple[str, dict]:
    ref = (args.get("item") or "").strip()
    done = args.get("done") is not False
    block = ref if ref.startswith("b-") else None
    if block is None:
        hits: list[dict[str, Any]] = []
        for c in await todo_pages.mine(ctx.db, ctx.user):
            for it in await todo_pages.items_of(ctx.db, c["slug"], open_only=False):
                if ref.casefold() in it["text"].casefold() and it["done"] != done:
                    hits.append(it)
        if not hits:
            raise ToolError(f"None of your {'open ' if done else 'done '}to-dos says “{ref}”. my_todos lists them.")
        if len(hits) > 1:
            raise ToolError("Several of your to-dos match: " + "; ".join(f"{h['text']} [{h['block']}]" for h in hits[:8])
                            + ". Pass the block id.")
        block = hits[0]["block"]
    try:
        got = await todo_pages.tick(ctx.db, ctx.user, block, done)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    return (f"{'Ticked' if done else 'Opened again'}: {block} on your to-do page (its call follows).",
            {"done": got["done"], "block": block, "url": public_url(got["slug"])})


TODO_TOOLS = [
    Tool(name="my_todos", title="Your to-dos from the team's calls",
         description=("Your personal to-do pages, one per team (never General): your action items from the team's calls, "
                      "by company (HubSpot company or the attendees' company; Internal otherwise), with due dates and the call "
                      "each came from. Open items only unless include_done. Filter by workspace and team."),
         scope=READ, input_schema={"type": "object", "properties": {
             "workspace": _WS, "team": _TEAM, "include_done": {"type": "boolean"}}},
         output_schema=_out({"pages": {"type": "array", "items": _O}}), annotations=_ann(True, False, True), handler=my_todos),
    Tool(name="team_todos", title="A team's to-dos (leads)",
         description=("Team leads: every member's to-do page in the team — their open action items from the team's calls, by "
                      "company. person: narrow to one member (name or id). Members who aren't leads use my_todos."),
         scope=READ, input_schema={"type": "object", "properties": {
             "workspace": _WS, "team": _TEAM, "person": {"type": "string", "maxLength": 120}}, "required": ["workspace", "team"]},
         output_schema=_out({"team": {"type": ["string", "null"]}, "pages": {"type": "array", "items": _O}}),
         annotations=_ann(True, False, True), handler=team_todos),
    Tool(name="tick_todo", title="Tick one of your to-dos", writes=True, scope=WRITE,
         description=("Mark one of your to-dos done (done: false opens it again). item: its block id (\"b-…\", from my_todos) "
                      "or words of it. The call's action item is ticked too, and anyone with either page open sees it."),
         input_schema={"type": "object", "properties": {"item": {"type": "string", "minLength": 1, "maxLength": 300},
                                                        "done": {"type": "boolean"}}, "required": ["item"]},
         output_schema=_out({"done": {"type": "boolean"}, "block": {"type": "string"}, "url": {"type": "string"}}),
         annotations=_ann(False, False, True), handler=tick_todo),
]
