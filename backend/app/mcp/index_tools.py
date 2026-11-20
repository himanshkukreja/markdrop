"""MCP tools over Ask's index (AI quality stage 2; services/ai_index.py, ask_route.py).

READ: ``list_items`` (exact lists and counts from Markdrop's records: documents someone created or edited,
meetings someone attended or held in a period, action items by owner, comment threads, a team's backlog),
``person_card`` (one person: teams, what they created, recent meetings, open action items, what Team memory says
they are working on), ``team_overview`` (a team: roster and lead, who is working on what, latest brief, open
backlog by category, the last two weeks of meetings, recent documents), ``likely_done`` (open action items that look
done but aren't ticked, with the evidence — services/likely_done.py). WRITE: ``dismiss_likely_done`` (it isn't done:
the note goes for everyone; ticking stays ``tick_todo`` / the page's checkbox — Markdrop never ticks on its own).

The same rows Ask reads, decided per caller the same way (access.discoverable per item, comment permissions,
teams only those the caller can read, names only where the caller may see people on the item).
"""

from __future__ import annotations

from datetime import date

from fastapi import HTTPException

from app.mcp.auth import READ, WRITE
from app.mcp.tools import Context, Tool, ToolError, _ann, _out, actor_of, http_message, public_url
from app.services import access, ai_index, ai_summaries, ask_context, ask_route, likely_done

_O = {"type": "object"}
_WS = {"type": "string", "description": "Workspace id or name (list_workspaces)."}
_TEAM = {"type": "string", "description": "Team id, slug or name (list_teams). Only teams you can open."}
_PERSON = {"type": "string", "maxLength": 120, "description": "A member: name, email or user id (list_workspace_members)."}
_DATE = {"type": "string", "description": "YYYY-MM-DD."}
KINDS = {"documents": "doc", "meetings": "meeting", "action_items": "action", "comments": "comment", "backlog": "backlog"}


async def _ws(ctx: Context, ref: str) -> str:
    from app.mcp.tools import resolve_workspace

    try:
        ws_id, _w, _role = await resolve_workspace(ctx, ref)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    return ws_id


async def _person(ctx: Context, ws: str, ref: str | None) -> dict | None:
    from app.services import workspace_memory

    if not ref:
        return None
    r = ref.strip().casefold()
    members = await workspace_memory.members_of(ctx.db, ws)
    exact = [m for m in members if r in (m["id"].casefold(), (m.get("name") or "").casefold(), (m.get("email") or "").casefold())]
    if len(exact) == 1:
        return exact[0]
    sure, unclear = ask_context.resolve_names(ref, members)
    if len(sure) == 1 and not unclear:
        return sure[0]
    many = exact or sure or [m for _w, ms, _n in unclear for m in ms]
    if many:
        raise ToolError(f"“{ref}” fits {len(many)} members: " + "; ".join(m["name"] for m in many[:6]) + ". Pass a full name or id.")
    raise ToolError(f"No member “{ref}” in this workspace. list_workspace_members shows them.")


async def _team(ctx: Context, actx: access.Ctx, ws: str, ref: str | None) -> dict | None:
    from app.services import teams as T

    if not ref:
        return None
    row = await T.get_team(ctx.db, ws, ref.strip())
    view = await actx.team_view(ws, ctx.user.id)
    if row is None or str(row["_id"]) not in view.readable_teams:
        raise ToolError(f"No team “{ref}” you can open. list_teams shows them.")
    return row


def _day(v: str | None, name: str) -> date | None:
    if not v:
        return None
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        raise ToolError(f"{name}: a date as YYYY-MM-DD.")


def _iso(v) -> str | None:
    return v.isoformat() if hasattr(v, "isoformat") else (str(v) if v else None)


async def list_items(ctx: Context, args: dict) -> tuple[str, dict]:
    kind = KINDS.get(str(args.get("kind") or "documents"))
    if kind is None:
        raise ToolError("kind: one of " + ", ".join(KINDS))
    ws = await _ws(ctx, args["workspace"])
    actor, actx = actor_of(ctx), access.Ctx(ctx.db, surface="mcp")
    p = await _person(ctx, ws, args.get("person"))
    team = await _team(ctx, actx, ws, args.get("team"))
    status = args.get("status")
    f = ai_index.Filter(kind=kind, workspaces=[ws], since=_day(args.get("since"), "since"), until=_day(args.get("until"), "until"),
                        on="created" if args.get("date_field") == "created" else "updated",
                        title=(args.get("title") or None), team=str(team["_id"]) if team else None,
                        limit=max(1, min(int(args.get("limit") or 50), 200)))
    pid = p["id"] if p else None
    if kind == "doc":
        f.creator = pid if args.get("role") != "editor" else None
        f.editor = pid if args.get("role") == "editor" else None
    elif kind == "meeting":
        f.attendee, f.series = pid, args.get("title") or None
    elif kind == "action":
        f.owner = pid
        f.done = {"open": False, "done": True}.get(str(status or "open"))
    elif kind == "comment":
        f.author, f.status = pid, status if status in ("open", "resolved") else None
    else:
        f.owner, f.status = pid, status or "open"
        if team is None:
            raise ToolError("backlog: pass team.")
    res = await ai_index.query(ctx.db, actor, actx, f)
    names = ask_route._Names(ctx.db, actor, actx)
    await names.load([ws])
    teams_ = await ask_route._team_names(actx, ctx.user.id, [ws])
    sums = await ai_summaries.get(ctx.db, [r["doc"] for r in res.rows if r.get("doc") is not None]) if kind in ("doc", "meeting") else {}
    evs = await ask_route._likely(ctx.db, actor, actx, res.rows) if kind == "action" else {}
    items, lines = [], []
    for r in res.rows:
        raw = r.get("_doc") or {}
        sees = await names.sees(raw) if raw else False
        it = {"title": r.get("title") or raw.get("title"), "slug": raw.get("slug"),
              "url": public_url(raw["slug"]) if raw.get("slug") else None}
        if kind == "doc":
            it.update(kind=r.get("kind"), created_at=_iso(r.get("created")), updated_at=_iso(r.get("updated")),
                      status=r.get("status"), creator=names.names.get(r.get("creator") or "") if sees else None,
                      teams=[teams_[t]["name"] for t in r.get("teams") or [] if t in teams_], open_comments=r.get("c_open") or 0,
                      summary=sums.get(r["doc"]))
            lines.append(f"- {it['title']} — created {(_iso(r.get('created')) or '')[:10]}"
                         + (f" by {it['creator']}" if it["creator"] else "") + f", updated {(_iso(r.get('updated')) or '')[:10]}"
                         + (f", {it['status']}" if it["status"] else "") + f" · {it['url']}")
        elif kind == "meeting":
            it.update(date=r.get("date"), series=r.get("series"), title=r.get("mtitle") or it["title"],
                      attendees=(r.get("attendee_names") or []) if sees else [], summary=sums.get(r["doc"]))
            lines.append(f"- {it['date']} · {it['title']}" + (f" ({', '.join(it['attendees'][:8])})" if it["attendees"] else "")
                         + f" · {it['url']}")
        elif kind == "action":
            ev = evs.get(r["_id"])
            it.update(text=r.get("text"), done=bool(r.get("done")), owner=(r.get("owner_name") if sees else None),
                      due=r.get("due"), date=r.get("date"), on=r.get("title"), block=r.get("block"),
                      likely_done=_ev_out(ev) if ev else None)
            lines.append(f"- [{'x' if it['done'] else ' '}] {it['text']} — {it['on']}, {it['date'] or ''}"
                         + (f" (due {it['due']})" if it["due"] else "") + (f" · {likely_done.note(ev)}" if ev else ""))
        elif kind == "comment":
            it.update(status=r.get("status"), text=r.get("text"), updated_at=_iso(r.get("updated")),
                      author=names.names.get(r.get("author") or "") if sees else None, on=raw.get("title"))
            lines.append(f"- [{it['status']}] on “{it['on']}”" + (f" by {it['author']}" if it["author"] else "") + f": {it['text']}")
        else:
            it = {"text": r.get("text"), "category": r.get("category"), "status": r.get("status"),
                  "owner": names.names.get(r.get("owner") or "")}
            lines.append(f"- [{it['status']}] {it['category']}: {it['text']}" + (f" — {it['owner']}" if it["owner"] else ""))
        items.append(it)
    head = f"{res.total}{'+' if res.capped else ''} {args.get('kind') or 'documents'}" + (f" ({p['name']})" if p else "") + "."
    more = f"\n(+{res.total - len(items)} more; raise limit to see them)" if res.total > len(items) else ""
    return head + ("\n" + "\n".join(lines) if lines else "") + more, {"count": res.total, "capped": res.capped, "items": items}


def _ev_out(ev: dict) -> dict:
    return {"evidence": ev.get("text"), "source": ev.get("title"), "date": ev.get("date")}


async def likely_done_tool(ctx: Context, args: dict) -> tuple[str, dict]:
    ws = await _ws(ctx, args["workspace"])
    actor, actx = actor_of(ctx), access.Ctx(ctx.db, surface="mcp")
    p = await _person(ctx, ws, args.get("person"))
    team = await _team(ctx, actx, ws, args.get("team"))
    f = ai_index.Filter(kind="action", workspaces=[ws], owner=p["id"] if p else None, done=False,
                        team=str(team["_id"]) if team else None, limit=ai_index.QUERY_MAX)
    res = await ai_index.query(ctx.db, actor, actx, f)
    evs = await ask_route._likely(ctx.db, actor, actx, res.rows)
    names = ask_route._Names(ctx.db, actor, actx)
    await names.load([ws])
    items, lines = [], []
    for r in res.rows:
        ev = evs.get(r["_id"])
        if not ev:
            continue
        raw = r.get("_doc") or {}
        owner = names.names.get(r.get("owner") or "") if await names.sees(raw) else None
        items.append({"key": likely_done.key_of(r["doc"], r.get("block"), r.get("text")), "text": r.get("text"),
                      "owner": owner, "on": r.get("title"), "block": r.get("block"),
                      "url": public_url(raw["slug"]) + (f"#{r['block']}" if r.get("block") else "") if raw.get("slug") else None,
                      **_ev_out(ev)})
        lines.append(f"- {r.get('text')}" + (f" ({owner})" if owner else "") + f" — {r.get('title')} · {likely_done.note(ev)}")
    head = f"{len(items)} open action item{'s' if len(items) != 1 else ''} look done but aren't ticked."
    tip = "\nTick one with tick_todo (block) or its checkbox; dismiss_likely_done if it isn't done." if items else ""
    return head + ("\n" + "\n".join(lines) if lines else "") + tip, {"count": len(items), "items": items}


async def dismiss_likely_done(ctx: Context, args: dict) -> tuple[str, dict]:
    key = str(args.get("key") or "").strip()
    row = await ctx.db[likely_done.COLL].find_one({"_id": key}) if key else None
    if row is None:
        raise ToolError("No such likely-done item. likely_done lists them with their key.")
    actor, actx = actor_of(ctx), access.Ctx(ctx.db, surface="mcp")
    raw = await ctx.db["documents"].find_one({"_id": row.get("doc"), "deleted_at": None})
    # Only someone who can edit the page holding the item, or the item's owner, may say it isn't done.
    if raw is None or not ((await access.can(actor, raw, "edit_content", actx)).allowed or row.get("owner") == ctx.user.id):
        raise ToolError("You can't change that item.")
    ok = await likely_done.dismiss(ctx.db, key, ctx.user.id)
    return ("Dismissed: it won't be shown as likely done again." if ok else "Already dismissed."), {"dismissed": ok}


async def person_card(ctx: Context, args: dict) -> tuple[str, dict]:
    ws = await _ws(ctx, args["workspace"])
    actor, actx = actor_of(ctx), access.Ctx(ctx.db, surface="mcp")
    p = await _person(ctx, ws, args.get("person"))
    names = ask_route._Names(ctx.db, actor, actx)
    await names.load([ws])
    teams = await ask_route._team_names(actx, ctx.user.id, [ws])
    sec = await ask_route._person_card(ctx.db, actor, actx, {"id": p["id"], "name": p["name"]}, [ws], teams, names)
    lines = [sec.head] + [f"- {r.text}" for r in sec.rows]
    return "\n".join(lines), {"person": {"id": p["id"], "name": p["name"]}, "lines": [r.text for r in sec.rows]}


async def team_overview(ctx: Context, args: dict) -> tuple[str, dict]:
    ws = await _ws(ctx, args["workspace"])
    actor, actx = actor_of(ctx), access.Ctx(ctx.db, surface="mcp")
    team = await _team(ctx, actx, ws, args.get("team"))
    names = ask_route._Names(ctx.db, actor, actx)
    await names.load([ws])
    teams = await ask_route._team_names(actx, ctx.user.id, [ws])
    secs, _raws = await ask_route._team_overview(ctx.db, actor, actx, str(team["_id"]), teams, names, [ws])
    text = "\n\n".join("\n".join([s.head] + [f"- {r.text}" for r in s.rows] + ([s.tail] if s.tail else [])) for s in secs)
    return text, {"team": team.get("name"), "team_id": str(team["_id"]),
                  "sections": [{"head": s.head, "lines": [r.text for r in s.rows]} for s in secs]}


INDEX_TOOLS = [
    Tool(name="list_items", title="Exact lists and counts from Markdrop's records",
         description=("Exact lists and counts, newest first, of what you can open in a workspace: kind documents (who created "
                      "them — role editor: who edited them; the backlog and to-do pages Markdrop keeps never count as created "
                      "by someone; created or updated in a period with date_field; title words like \"PRD\"), meetings (who "
                      "attended, a series or title, held in a period), action_items (by owner; status open or done), comments "
                      "(threads someone started or replied to; status open or resolved), backlog (a team's items; status open, "
                      "in_progress, done or wont_do). Filter by person (name, email or id), team, since / until. Returns the exact "
                      "count and up to limit items with links, dates, status and summaries."),
         scope=READ, input_schema={"type": "object", "properties": {
             "workspace": _WS, "kind": {"type": "string", "enum": list(KINDS)}, "person": _PERSON,
             "role": {"type": "string", "enum": ["creator", "editor"], "description": "documents: created (default) or edited by person."},
             "team": _TEAM, "since": _DATE, "until": _DATE,
             "date_field": {"type": "string", "enum": ["created", "updated"], "description": "documents: which date since / until apply to."},
             "title": {"type": "string", "maxLength": 80, "description": "Words in the title (documents) or a meeting series / title."},
             "status": {"type": "string", "maxLength": 20}, "limit": {"type": "integer", "minimum": 1, "maximum": 200}},
             "required": ["workspace"]},
         output_schema=_out({"count": {"type": "integer"}, "capped": {"type": "boolean"}, "items": {"type": "array", "items": _O}}),
         annotations=_ann(True, False, True), handler=list_items),
    Tool(name="person_card", title="One person at a glance",
         description=("A member as you can see them: their teams (only teams you can open), how many documents they created and "
                      "the newest, meetings they attended in the last two weeks, their open action items, and what Team memory "
                      "says they are working on. person: name, email or id; two members sharing a name → pass the full name."),
         scope=READ, input_schema={"type": "object", "properties": {"workspace": _WS, "person": _PERSON},
                                   "required": ["workspace", "person"]},
         output_schema=_out({"person": _O, "lines": {"type": "array", "items": {"type": "string"}}}),
         annotations=_ann(True, False, True), handler=person_card),
    Tool(name="team_overview", title="A team at a glance",
         description=("A team you can open: roster and lead, what each member is working on (Team memory), the latest weekly "
                      "brief, open backlog items by category, the team's meetings in the last two weeks with their summaries, "
                      "and its newest documents."),
         scope=READ, input_schema={"type": "object", "properties": {"workspace": _WS, "team": _TEAM},
                                   "required": ["workspace", "team"]},
         output_schema=_out({"team": {"type": ["string", "null"]}, "team_id": {"type": "string"},
                             "sections": {"type": "array", "items": _O}}),
         annotations=_ann(True, False, True), handler=team_overview),
    Tool(name="likely_done", title="Action items that look done but aren't ticked",
         description=("Open (unticked) action items that something later shows were probably done — a meeting where it was "
                      "reported done, the document it asked for, a published page — each with that evidence, its source and "
                      "date, and its key. Only evidence you can open. Filter by person (owner) or team. Markdrop never ticks "
                      "them: tick with tick_todo or the checkbox; dismiss_likely_done when it isn't done."),
         scope=READ, input_schema={"type": "object", "properties": {"workspace": _WS, "person": _PERSON, "team": _TEAM},
                                   "required": ["workspace"]},
         output_schema=_out({"count": {"type": "integer"}, "items": {"type": "array", "items": _O}}),
         annotations=_ann(True, False, True), handler=likely_done_tool),
    Tool(name="dismiss_likely_done", title="Say a likely-done item isn't done",
         description=("Remove the \"likely done\" note from an action item (key from likely_done) for everyone; it won't be "
                      "suggested again. For the item's owner or someone who can edit its page."),
         scope=WRITE, input_schema={"type": "object", "properties": {"key": {"type": "string", "maxLength": 120}},
                                    "required": ["key"]},
         output_schema=_out({"dismissed": {"type": "boolean"}}),
         annotations=_ann(False, False, True), handler=dismiss_likely_done),
]
