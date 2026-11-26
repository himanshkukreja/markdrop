"""MCP tools for team backlogs (services/team_backlog.py): one shared page per team, filled from the team's calls.

READ: ``team_backlog`` (a team's items by category, status, company, priority, date; as you may read them).
WRITE: ``update_backlog_item`` (category, status, owner, text, priority: a human edit that wins; Done ticks the
call's action item), ``set_backlog_priorities`` (several priorities at once), ``refresh_team_backlog`` (leads:
re-read every call in the team now).

The same rules as the website (routers/backlog.py). Changes go through the collection and the page follows.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from app.mcp.auth import READ, WRITE
from app.mcp.tools import Context, Tool, ToolError, _ann, _out, http_message, public_url
from app.services import team_backlog as TB

_O = {"type": "object"}
_WS = {"type": "string", "description": "Workspace id or name (list_workspaces). Optional when the team name is unique."}
_TEAM = {"type": "string", "description": "Team id, slug or name (list_teams)."}
_CATS = [k for k, _l in TB.CATEGORIES]
_STATS = [k for k, _l in TB.STATUSES]
_PRIOS = [k for k, _l in TB.PRIORITIES]
_SORTS = ["category", "priority", "newest", "oldest", "mentions"]


async def _team(ctx: Context, args: dict) -> tuple[dict, Any]:
    """(team row, its TeamView) — one you can open, not General."""
    from app.mcp.tools import resolve_workspace
    from app.services import access
    from app.services import teams as T

    ref = (args.get("team") or "").strip()
    if args.get("workspace"):
        try:
            ws_ids = [(await resolve_workspace(ctx, args["workspace"]))[0]]
        except HTTPException as exc:
            raise ToolError(http_message(exc))
    else:
        ws_ids = [m["workspace_id"] for m in await ctx.db["memberships"].find({"user_id": ctx.user.id}, {"workspace_id": 1}).to_list(length=500)]
    hits = []
    for ws in ws_ids:
        row = await T.get_team(ctx.db, ws, ref)
        if row is None:
            continue
        view = await access.Ctx(ctx.db, surface="mcp").team_view(ws, ctx.user.id)
        if str(row["_id"]) in view.readable_teams:
            hits.append((row, view))
    if not hits:
        raise ToolError(f"No team “{ref}” you can open. list_teams shows them.")
    if len(hits) > 1:
        raise ToolError(f"“{ref}” is a team in several of your workspaces. Pass workspace.")
    row, view = hits[0]
    if T.is_general(row):
        raise ToolError("General has no backlog. Pick one of your other teams.")
    return row, view


def _line(it: dict) -> str:
    bits = [it["status_label"]] if it["status"] != "open" else []
    if it.get("priority") and it["priority"] != TB.DEFAULT_PRIORITY:
        bits.insert(0, it["priority_label"])
    if it.get("company"):
        bits.append(it["company"])
    if it.get("owner"):
        bits.append(f"@{it['owner']['name']}")
    if it["mentions"] > 1:
        bits.append(f"{it['mentions']} calls")
    return f"  - [{'x' if it['status'] == 'done' else ' '}] {it['text']}" + (f" ({', '.join(bits)})" if bits else "") + f" [{it['id']}]"


async def team_backlog(ctx: Context, args: dict) -> tuple[str, dict]:
    row, view = await _team(ctx, args)
    lead = view.can_manage(str(row["_id"]))
    cat = args.get("category")
    if cat and cat not in TB.CATEGORY_LABEL:
        cat = TB._label_key(cat) or cat
        if cat not in TB.CATEGORY_LABEL:
            raise ToolError("category: one of " + ", ".join(_CATS))
    st = args.get("status")
    if st and st not in TB.STATUS_LABEL:
        st = TB._status_key(st)
        if st is None:
            raise ToolError("status: one of " + ", ".join(_STATS))
    prios = args.get("priority")
    if isinstance(prios, str):
        prios = [p for p in prios.split(",") if p.strip()]
    if prios:
        keys = [TB._priority_key(str(p)) for p in prios]
        if None in keys:
            raise ToolError("priority: any of " + ", ".join(_PRIOS))
        prios = keys
    try:
        since, until = TB.parse_since(args.get("since")), TB.parse_since(args.get("until"))
    except ValueError:
        raise ToolError("since / until: 7d, 30d, 90d, month, or a day like 2026-11-01.")
    sort = args.get("sort") or None
    if sort and sort not in _SORTS:
        raise ToolError("sort: one of " + ", ".join(_SORTS))
    got = await TB.items_for(ctx.db, row, ctx.user, lead, category=cat, status=st, company=args.get("company") or None,
                             include_done=args.get("include_done") is True, priority=prios or None, since=since,
                             until=until, date_by="last" if args.get("date_by") == "last" else "first", sort=sort)
    status = await TB.status_of(ctx.db, row, lead)
    url = public_url(status["slug"]) if status.get("slug") else None
    items = got["items"]
    text = [f"{row.get('name')} backlog: {len(items)} item(s)" + (f" — {url}" if url else " (no page yet: it appears after the team's first call)")]
    if sort and sort != "category":
        text += [_line(it) for it in items]
    else:
        for key, label in TB.CATEGORIES:
            mine = [it for it in items if it["category"] == key]
            if mine:
                text.append(f"{label} ({len(mine)}):")
                text += [_line(it) for it in mine]
    if got.get("private"):
        text.append(f"{got['private']} open item(s) from private calls are not shown.")
    if not items:
        text.append("  Nothing matches." if (cat or st or args.get("company") or prios or since or until) else "  No items yet.")
    return "\n".join(text), {"team": row.get("name"), "team_id": str(row["_id"]), "url": url, "items": items,
                             "counts": status["counts"], "private": got.get("private")}


async def update_backlog_item(ctx: Context, args: dict) -> tuple[str, dict]:
    ref = (args.get("id") or "").strip()
    if not any(k in args for k in ("category", "status", "owner", "text", "priority")):
        raise ToolError("Pass at least one of category, status, owner, text or priority.")
    item_id = ref
    if ref.startswith("b-") and args.get("team"):
        row, _v = await _team(ctx, args)
        it = await TB.find_item(ctx.db, row, ref)
        if it is None:
            raise ToolError(f"No item {ref} in {row.get('name')}'s backlog. team_backlog lists them.")
        item_id = str(it["_id"])
    owner = args.get("owner")
    owner_set = "owner" in args
    if owner_set and owner and not str(owner).isalnum():
        raise ToolError("owner: a workspace member's id (list_workspace_members), or null to clear it.")
    try:
        got = await TB.update_item(ctx.db, ctx.user, item_id, category=args.get("category"), status=args.get("status"),
                                   owner=owner or None, owner_set=owner_set, text=args.get("text"),
                                   priority=args.get("priority"))
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    url = public_url(got["href"].lstrip("/")) if got.get("href") else None
    return (f"Updated: {got['text']} — {got['category_label']} · {got['status_label']} · {got['priority_label']}"
            + (f" · @{got['owner']['name']}" if got.get("owner") else "") + (f" — {url}" if url else ""),
            {"item": got, "url": url})


async def set_backlog_priorities(ctx: Context, args: dict) -> tuple[str, dict]:
    row, _view = await _team(ctx, args)
    changes = args.get("changes")
    if not isinstance(changes, list) or not changes:
        raise ToolError("changes: a list of {id, priority} (ids from team_backlog).")
    try:
        got = await TB.set_priorities(ctx.db, row, ctx.user, [c if isinstance(c, dict) else {} for c in changes])
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    lines = [f"Set {len(got['changed'])} priorit{'y' if len(got['changed']) == 1 else 'ies'} in {row.get('name')}'s backlog."]
    lines += [f"  - {it['text']} → {it['priority_label']}" for it in got["changed"]]
    lines += [f"  - {f['id'] or '(no id)'}: {f['error']}" for f in got["failed"]]
    return "\n".join(lines), {"team": row.get("name"), "changed": got["changed"], "failed": got["failed"]}


async def refresh_team_backlog(ctx: Context, args: dict) -> tuple[str, dict]:
    row, view = await _team(ctx, args)
    if not view.can_manage(str(row["_id"])):
        raise ToolError(f"Only {row.get('name')}'s leads can refresh its backlog. team_backlog reads it.")
    try:
        got = await TB.refresh(ctx.db, row)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    url = public_url(got["slug"]) if got.get("slug") else None
    news = f"added {got['added']} new" if got["added"] else "nothing new"
    return (f"Refreshed {row.get('name')}'s backlog from {got['meetings']} call(s): {news} · {got['open']} open"
            + (f" — {url}" if url else ""), {**got, "team": row.get("name"), "url": url})


BACKLOG_TOOLS = [
    Tool(name="team_backlog", title="A team's backlog",
         description=("A team's shared backlog (not General): every action item and customer ask from the team's calls — "
                      "feature requests, bugs, improvements, tasks, follow-ups, questions — with status, priority (urgent, high, "
                      "medium, low; who set it: ai, call, person; and why), owner, company, how many calls mentioned it and where "
                      "it came from. Filter by category, status (open, in_progress, done, wont_do), company, priority (any of), and "
                      "date (since / until: 7d, 30d, 90d, month or a day; on first seen, or last mentioned with date_by=last); "
                      "sort by category (default), priority, newest, oldest or mentions. Open and in-progress items only unless "
                      "include_done. Only items from calls you can open."),
         scope=READ, input_schema={"type": "object", "properties": {
             "team": _TEAM, "workspace": _WS, "category": {"type": "string", "enum": _CATS},
             "status": {"type": "string", "enum": _STATS}, "company": {"type": "string", "maxLength": 120},
             "priority": {"type": "array", "items": {"type": "string", "enum": _PRIOS}, "maxItems": 4},
             "since": {"type": "string", "maxLength": 10}, "until": {"type": "string", "maxLength": 10},
             "date_by": {"type": "string", "enum": ["first", "last"]}, "sort": {"type": "string", "enum": _SORTS},
             "include_done": {"type": "boolean"}}, "required": ["team"]},
         output_schema=_out({"team": {"type": ["string", "null"]}, "team_id": {"type": "string"}, "url": {"type": ["string", "null"]},
                             "items": {"type": "array", "items": _O}, "counts": _O, "private": {"type": ["integer", "null"]}}),
         annotations=_ann(True, False, True), handler=team_backlog),
    Tool(name="update_backlog_item", title="Change a backlog item", writes=True, scope=WRITE,
         description=("Change one backlog item (members of its team): category, status (done also ticks the call's action item), "
                      "owner (a member's id; null clears), text or priority (urgent, high, medium, low). Your change wins over the "
                      "automatic sorting and is never changed back by it (a later call that decides its priority again does). "
                      "id: the item's id from team_backlog (or its block id \"b-…\" with team)."),
         input_schema={"type": "object", "properties": {
             "id": {"type": "string", "minLength": 1, "maxLength": 40}, "team": _TEAM, "workspace": _WS,
             "category": {"type": "string", "enum": _CATS}, "status": {"type": "string", "enum": _STATS},
             "priority": {"type": "string", "enum": _PRIOS},
             "owner": {"type": ["string", "null"], "maxLength": 64}, "text": {"type": "string", "minLength": 1, "maxLength": 300}},
             "required": ["id"]},
         output_schema=_out({"item": _O, "url": {"type": ["string", "null"]}}),
         annotations=_ann(False, False, True), handler=update_backlog_item),
    Tool(name="set_backlog_priorities", title="Set backlog priorities", writes=True, scope=WRITE,
         description=("Set several backlog items' priorities at once (members of the team) — e.g. after a prioritization "
                      "meeting: changes is a list of {id, priority} with ids from team_backlog (or block ids \"b-…\") and priority "
                      "urgent, high, medium or low. Each is your decision and wins over the automatic priorities. Returns what "
                      "changed and what failed."),
         input_schema={"type": "object", "properties": {
             "team": _TEAM, "workspace": _WS,
             "changes": {"type": "array", "minItems": 1, "maxItems": TB.MAX_CHANGES, "items": {
                 "type": "object", "properties": {"id": {"type": "string", "minLength": 1, "maxLength": 40},
                                                  "priority": {"type": "string", "enum": _PRIOS}},
                 "required": ["id", "priority"]}}}, "required": ["team", "changes"]},
         output_schema=_out({"team": {"type": ["string", "null"]}, "changed": {"type": "array", "items": _O},
                             "failed": {"type": "array", "items": _O}}),
         annotations=_ann(False, False, True), handler=set_backlog_priorities),
    Tool(name="refresh_team_backlog", title="Refresh a team's backlog", writes=True, scope=WRITE,
         description=("Team leads and workspace admins: re-read every call in the team into its backlog now — new items, repeats "
                      "merged, categories for items still waiting — and rewrite the backlog page. Returns how many items are new "
                      "and open. Safe to repeat."),
         input_schema={"type": "object", "properties": {"team": _TEAM, "workspace": _WS}, "required": ["team"]},
         output_schema=_out({"team": {"type": ["string", "null"]}, "slug": {"type": ["string", "null"]}, "url": {"type": ["string", "null"]},
                             "meetings": {"type": "integer"}, "added": {"type": "integer"}, "merged": {"type": "integer"},
                             "open": {"type": "integer"}}),
         annotations=_ann(False, False, True), handler=refresh_team_backlog),
]
