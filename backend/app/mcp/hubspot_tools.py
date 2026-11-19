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

* ``hubspot_suggestions`` (Phase 2): the deal updates suggested after the call (stage, close date, amount,
  next step, the portal's competitor / budget / decision-maker fields) with their evidence; ``"suggest"``
  asks again, ``"apply"`` applies one (``id``; a person's choice, never automatic), ``"dismiss"`` hides one.
* ``hubspot_list_deals`` / ``hubspot_deal_folder`` / ``hubspot_sync_deals``: the HubSpot team's deal folders
  (services/hubspot_folders.py; read-only in HubSpot).
* ``hubspot_account``: the company's existing (archived) account page (deals, calls, decisions, objections
  and risks, open questions and tasks); ``"refresh"`` updates it. No new ones are made: Deals replaced them.
* ``hubspot_pipeline``: the workspace's deals with stage, amount, close date, the team's last call and why
  they're at risk (no call in 14 days, close date passed).
* ``hubspot_notifications``: your own pre-call briefs and Slack messages after calls (on or off).

Same rules as the website: only meetings of the workspace's HubSpot team, for people who can read the
meeting and are in that team (or workspace admins). Connecting is on the website.
"""

from __future__ import annotations

from fastapi import HTTPException

from app.mcp.auth import READ, WRITE
from app.mcp.meeting_tools import _actx, _row
from app.mcp.tools import _WORKSPACE_ARG, Context, Tool, ToolError, _ann, _out, actor_of, http_message, resolve_workspace
from app.services import hubspot, hubspot_accounts, hubspot_deals, hubspot_folders, hubspot_notify

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


def _sug_text(p: dict) -> str:
    s = p.get("suggestions") or {}
    items = s.get("items") or []
    if not items:
        why = {"no_deal": "the meeting isn't matched to a deal", "no_notes": "the meeting has no notes yet"}.get(s.get("reason") or "")
        return ("No suggested deal updates" + (f": {why}" if why else (f": {s['message']}" if s.get("message") else "")) + ".")
    lines = []
    for i in items:
        ev = "; ".join(f"“{e.get('quote')}”" + (f" ({e['at']})" if e.get("at") else "") for e in i.get("evidence") or [])
        lines.append(f"- [{i['id']}] {i['label']}: {i.get('current') or 'none'} → {i['display']} · {i['state']}"
                     + (f" · {i['why']}" if i.get("why") else "") + (f" · evidence: {ev}" if ev else ""))
    return "Suggested deal updates (apply with action 'apply' and the id; nothing is applied on its own):\n" + "\n".join(lines)


async def hubspot_suggestions(ctx: Context, args: dict) -> tuple[str, dict]:
    row, _raw = await _row(ctx, args.get("meeting") or "")
    mid = str(row["_id"])
    action = args.get("action") or "list"
    actor, actx = actor_of(ctx), _actx(ctx)
    try:
        if action == "suggest":
            p = await hubspot_deals.request(ctx.db, ctx.user, actor, actx, mid)
        elif action in ("apply", "dismiss"):
            sid = str(args.get("id") or "")
            if not sid:
                raise ToolError("Pass the suggestion's id (from action 'list').")
            fn = hubspot_deals.apply if action == "apply" else hubspot_deals.dismiss
            p = await fn(ctx.db, ctx.user, actor, actx, mid, sid)
        else:
            p = await hubspot.panel(ctx.db, ctx.user, actor, actx, mid)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    if not p.get("available"):
        return _summary(p), {"action": action, "suggestions": []}
    items = (p.get("suggestions") or {}).get("items") or []
    text = _sug_text(p)
    if action == "apply":
        text = f"Applied to the HubSpot deal.\n{text}"
    return text, {"action": action, "suggestions": items, "deals_write": p.get("deals_write")}


async def hubspot_account(ctx: Context, args: dict) -> tuple[str, dict]:
    row, _raw = await _row(ctx, args.get("meeting") or "")
    try:
        out = await hubspot_accounts.account(ctx.db, ctx.user, actor_of(ctx), _actx(ctx), str(row["_id"]),
                                             refresh_now=(args.get("action") == "refresh"))
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    from app.services import urls

    url = urls.markdrop_url(out["slug"])
    return (f"Account page of {out.get('name')}: {url}\n\n{out['content'][:8000]}",
            {"name": out.get("name"), "slug": out["slug"], "url": url, "content": out["content"]})


async def hubspot_pipeline(ctx: Context, args: dict) -> tuple[str, dict]:
    ws_id, _ws, _r = await resolve_workspace(ctx, args["workspace"])
    try:
        got = await hubspot_deals.pipeline_for(ctx.db, ctx.user, ws_id, fresh=bool(args.get("fresh")))
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    deals = got["deals"]
    if args.get("at_risk_only"):
        deals = [d for d in deals if d["risks"]]
    lines = [hubspot_deals.deal_line(d) for d in deals[:100]]
    head = f"{len(deals)} deal{'s' if len(deals) != 1 else ''}" + (f", {got['at_risk']} at risk" if got["at_risk"] else "") + ":"
    return (head + "\n" + "\n".join(lines)) if lines else "No deals.", {"workspace_id": ws_id, "deals": deals, "at_risk": got["at_risk"]}


def _card_line(d: dict) -> str:
    bits = [d.get("title") or d.get("name") or "Deal", d.get("closed_label") or d.get("stage") or "no stage"]
    if d.get("amount") is not None:
        bits.append(f"{d['amount']:,.0f} {d.get('currency') or ''}".strip())
    if d.get("owner"):
        bits.append(f"owner {d['owner']}")
    if d.get("close_date"):
        bits.append(f"closes {d['close_date']}")
    bits.append(f"{d.get('calls') or 0} call{'s' if d.get('calls') != 1 else ''}")
    if d.get("last_call"):
        bits.append(f"last call {d['last_call'].get('date')}")
    if d.get("quiet"):
        bits.append("no call in 14 days")
    if d.get("pick"):
        bits.append(f"{d['pick']} call(s) to pick the deal for")
    return f"- [{d['id']}] " + " · ".join(bits)


async def hubspot_list_deals(ctx: Context, args: dict) -> tuple[str, dict]:
    ws_id, _ws, _r = await resolve_workspace(ctx, args["workspace"])
    try:
        got = await hubspot_folders.board(ctx.db, ctx.user, ws_id)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    deals = got["deals"]
    if not args.get("include_closed"):
        deals = [d for d in deals if not d["closed"]]
    q = (args.get("q") or "").strip().casefold()
    if q:
        deals = [d for d in deals if q in (d.get("title") or "").casefold() or q in (d.get("owner") or "").casefold()]
    if args.get("quiet_only"):
        deals = [d for d in deals if d["quiet"]]
    sync = got["sync"]
    head = f"{len(deals)} deal{'s' if len(deals) != 1 else ''}" + (f" (synced {sync['at']})" if sync.get("at") else "") + ":"
    return (head + "\n" + "\n".join(_card_line(d) for d in deals[:150])) if deals else "No deals.", \
        {"workspace_id": ws_id, "deals": deals, "sync": sync}


async def hubspot_deal_folder(ctx: Context, args: dict) -> tuple[str, dict]:
    ws_id, _ws, _r = await resolve_workspace(ctx, args["workspace"])
    try:
        got = await hubspot_folders.detail(ctx.db, ctx.user, ws_id, str(args.get("deal") or ""), fresh=bool(args.get("fresh")))
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    from app.services import urls

    d = got["deal"]
    lines = [_card_line(d).removeprefix(f"- [{d['id']}] "), f"HubSpot: {d['url']}"]
    if got.get("overview"):
        lines.append(f"Deal overview page: {urls.markdrop_url(got['overview']['slug'])}")
    if d.get("contacts"):
        lines.append("Contacts: " + "; ".join(" · ".join(x for x in (c.get("name"), c.get("title"), c.get("email")) if x)
                                              for c in d["contacts"]))
    r = got["rollup"]
    for head, key in (("Decisions", "decisions"), ("Objections and risks", "risks"), ("Open questions", "questions"),
                      ("Next steps", "next_steps")):
        if r.get(key):
            lines.append(f"{head}:\n" + "\n".join(f"- {x['text']} ({x.get('date')})" for x in r[key]))
    if got["calls"]:
        lines.append("Calls:\n" + "\n".join(f"- {c['date']} {c['title']} (meeting {c['meeting_id']})"
                                            + (" · logged to HubSpot" if c.get("logged") else "") for c in got["calls"]))
    if got["pick"]:
        lines.append("Waiting for someone to pick the deal (file one here with hubspot_match, action 'set' and this deal):\n"
                     + "\n".join(f"- {c['date']} {c['title']} (meeting {c['meeting_id']})" for c in got["pick"]))
    act = got["activity"]
    if act["items"]:
        lines.append("HubSpot activity (newest first):\n" + "\n".join(
            f"- {(a.get('at') or '')[:10]} {a['kind']}: {a.get('title') or ''}" + (f" — {a['preview']}" if a.get("preview") else "")
            for a in act["items"][:30]))
    for mi in [*(act.get("missing") or []), *((got.get("attachments") or {}).get("missing") or [])]:
        lines.append(f"(The HubSpot key needs {mi['scope']} to show {mi['what']}.)")
    return "\n".join(lines), got


async def hubspot_sync_deals(ctx: Context, args: dict) -> tuple[str, dict]:
    ws_id, _ws, _r = await resolve_workspace(ctx, args["workspace"])
    try:
        got = await hubspot_folders.request_sync(ctx.db, ctx.user, ws_id)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    return ("Syncing the HubSpot deals now (reads HubSpot only; new open deals get their folders, renames and stages "
            "follow). hubspot_list_deals shows the result in a minute."), {"workspace_id": ws_id, "sync": got}


async def hubspot_notifications(ctx: Context, args: dict) -> tuple[str, dict]:
    if (args.get("action") or "get") == "set":
        got = await hubspot_notify.set_me(ctx.db, ctx.user, {"precall": args.get("precall"), "approve": args.get("approve")})
    else:
        got = await hubspot_notify.me(ctx.db, ctx.user)
    on = lambda b: "on" if b else "off"  # noqa: E731
    teams = ", ".join(f"{t['team']} ({t['workspace']})" for t in got["teams"]) or "none"
    return (f"Pre-call briefs: {on(got['precall'])}. Slack messages after your calls: {on(got['approve'])}. "
            f"HubSpot teams you're in: {teams}."), got


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
    Tool(
        name="hubspot_suggestions",
        title="Suggested HubSpot deal updates",
        description=("The HubSpot deal updates suggested after a HubSpot-team call: stage (only stages of the deal's pipeline), "
                     "close date, amount, next step and the portal's competitor, budget or decision-maker fields, each with "
                     "its evidence (quoted line and transcript time) and state (open, applied, dismissed). action 'list' "
                     "(default); 'suggest' asks again (one AI request); 'apply' applies one to the HubSpot deal (id); "
                     "'dismiss' hides one (id). Nothing is ever applied automatically."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "meeting": _MEETING_ARG,
            "action": {"type": "string", "enum": ["list", "suggest", "apply", "dismiss"], "default": "list"},
            "id": {"type": "string", "maxLength": 12, "description": "action 'apply' or 'dismiss': the suggestion's id."}},
            "required": ["meeting"]},
        output_schema=_out({"action": {"type": "string"}, "suggestions": {"type": "array", "items": {"type": "object"}},
                            "deals_write": {"type": ["string", "null"]}}, ["action", "suggestions"]),
        annotations=_ann(False, False, False),
        handler=hubspot_suggestions,
    ),
    Tool(
        name="hubspot_account",
        title="A HubSpot company's account page",
        description=("The account page of the HubSpot company a meeting is matched to: a Markdrop page in the HubSpot team "
                     "with the company's deals, the team's calls with it, decisions, objections and risks, open questions "
                     "and open tasks (a section Markdrop keeps up to date; people's own notes around it stay). action 'get' "
                     "(default) or 'refresh' (rewritten now). No new account pages are made: Deals replaced them (hubspot_list_deals)."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "meeting": _MEETING_ARG,
            "action": {"type": "string", "enum": ["get", "refresh"], "default": "get"}}, "required": ["meeting"]},
        output_schema=_out({"name": {"type": ["string", "null"]}, "slug": {"type": "string"}, "url": {"type": "string"},
                            "content": {"type": "string"}}, ["slug", "url"]),
        annotations=_ann(False, False, True),
        handler=hubspot_account,
    ),
    Tool(
        name="hubspot_pipeline",
        title="HubSpot pipeline",
        description=("A workspace's HubSpot deals (open ones, and those closed in the last two weeks): stage, amount, close "
                     "date, owner, next step, the HubSpot team's last call with the deal in Markdrop, the last contact, and "
                     "why it's at risk (no call in 14 days, close date passed). at_risk_only: just those. The HubSpot team's "
                     "members and workspace admins."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "workspace": _WORKSPACE_ARG,
            "at_risk_only": {"type": "boolean", "default": False},
            "fresh": {"type": "boolean", "default": False, "description": "Read HubSpot now instead of the last 10 minutes' copy."}},
            "required": ["workspace"]},
        output_schema=_out({"workspace_id": {"type": "string"}, "deals": {"type": "array", "items": {"type": "object"}},
                            "at_risk": {"type": "integer"}}, ["workspace_id", "deals"]),
        annotations=_ann(True, False, True),
        handler=hubspot_pipeline,
    ),
    Tool(
        name="hubspot_list_deals",
        title="HubSpot deals (deal folders)",
        description=("The HubSpot team's deal folders: every open deal in the connected HubSpot account (closed ones too with "
                     "include_closed, marked Closed won / Closed lost), with stage, amount, owner, close date, how many of the "
                     "team's calls are filed in it, the last call, whether it's quiet (no call in 14 days) and calls waiting "
                     "for someone to pick the deal. q: filter by deal, company or owner. The HubSpot team's members and "
                     "workspace admins."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "workspace": _WORKSPACE_ARG,
            "q": {"type": "string", "maxLength": 100},
            "include_closed": {"type": "boolean", "default": False},
            "quiet_only": {"type": "boolean", "default": False}}, "required": ["workspace"]},
        output_schema=_out({"workspace_id": {"type": "string"}, "deals": {"type": "array", "items": {"type": "object"}},
                            "sync": {"type": "object"}}, ["workspace_id", "deals"]),
        annotations=_ann(True, False, True),
        handler=hubspot_list_deals,
    ),
    Tool(
        name="hubspot_deal_folder",
        title="A HubSpot deal's folder",
        description=("One deal's folder (deal: the HubSpot deal id from hubspot_list_deals): its facts and contacts, the team's "
                     "calls filed in it rolled up (decisions, objections and risks, open questions, next steps), the calls, "
                     "the calls waiting for someone to pick the deal, open suggested deal updates, and HubSpot's activity on "
                     "it (notes, emails, meetings, tasks) and attachments. fresh: read HubSpot's activity now."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "workspace": _WORKSPACE_ARG,
            "deal": {"type": "string", "pattern": "^[0-9]{1,20}$", "description": "The HubSpot deal id."},
            "fresh": {"type": "boolean", "default": False}}, "required": ["workspace", "deal"]},
        output_schema=_out({"deal": {"type": "object"}, "calls": {"type": "array", "items": {"type": "object"}},
                            "pick": {"type": "array", "items": {"type": "object"}}, "rollup": {"type": "object"},
                            "activity": {"type": "object"}}, ["deal", "calls"]),
        annotations=_ann(True, False, True),
        handler=hubspot_deal_folder,
    ),
    Tool(
        name="hubspot_sync_deals",
        title="Sync HubSpot deals now",
        description=("Workspace admins: sync the HubSpot deals now instead of waiting for the next pass (every 20 minutes). "
                     "Reads HubSpot only: new open deals get a folder, renames and stages follow, closed deals are marked."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {"workspace": _WORKSPACE_ARG}, "required": ["workspace"]},
        output_schema=_out({"workspace_id": {"type": "string"}, "sync": {"type": "object"}}, ["workspace_id", "sync"]),
        annotations=_ann(False, False, True),
        handler=hubspot_sync_deals,
    ),
    Tool(
        name="hubspot_notifications",
        title="Your HubSpot messages",
        description=("Your own HubSpot messages: pre-call briefs before your HubSpot meetings (precall) and the Slack message "
                     "after your calls with Log to HubSpot and Create tasks buttons (approve). action 'get' (default) or "
                     "'set' with precall and/or approve (true or false)."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "action": {"type": "string", "enum": ["get", "set"], "default": "get"},
            "precall": {"type": "boolean"}, "approve": {"type": "boolean"}}, "required": []},
        output_schema=_out({"teams": {"type": "array", "items": {"type": "object"}}, "precall": {"type": "boolean"},
                            "approve": {"type": "boolean"}}, ["teams", "precall", "approve"]),
        annotations=_ann(False, False, True),
        handler=hubspot_notifications,
    ),
]
