"""MCP tools for Jira Cloud (services/jira.py, jira_links.py, jira_team.py).

* ``jira_status``: whether a workspace is connected to a Jira site (which site, the default project
  and the projects that feed Team), and whether the user's own Atlassian account is connected.
* ``create_jira_issue``: from an item on a page or meeting (a block id or the item's words) or
  selected text: ``draft: true`` (the default) returns the AI draft (summary, description, type,
  priority, assignee, due date, labels) and creates nothing; ``draft: false`` creates it **as the
  user** (their own Atlassian connection) with the fields given over the draft, and links it to the item.
* ``link_jira_issue``: link an existing issue (key or URL) to an item.
* ``list_jira_issues``: the workspace's issues (members' issues in the Team projects, last 30 days),
  by person / project / status — only what the user's own connection can open.
* ``transition_jira_issue``: move an issue to done / to do / in progress, as the user; linked to-dos
  follow.

Same rules as the website: the user must be able to read the page; issue details only through their
own Atlassian connection; connecting is done on the website (Atlassian's consent screen).
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from app.mcp.auth import READ, WRITE
from app.mcp.meeting_tools import _actx
from app.mcp.tools import (_DOC_REF, _WORKSPACE_ARG, Context, Tool, ToolError, _ann, _out, actor_of, http_message,
                           resolve_doc, resolve_workspace)
from app.services import jira, jira_api, jira_links, jira_team

_SETUP = "Workspace settings › Integrations › Jira"
_CONNECT = "Settings › Account › Jira"


def _err(exc: Exception) -> ToolError:
    if isinstance(exc, HTTPException):
        return ToolError(http_message(exc))
    if isinstance(exc, jira.NotConnected):
        return ToolError(http_message(jira.not_connected(exc)))
    return ToolError(str(exc))


async def jira_status(ctx: Context, args: dict) -> tuple[str, dict]:
    ws_id, ws_obj, _role = await resolve_workspace(ctx, args["workspace"])
    try:
        st = await jira.status(ctx.db, ctx.user, ws_id)
    except HTTPException as exc:
        raise _err(exc)
    name = getattr(ws_obj, "name", None) or "This workspace"
    site = st.get("site")
    me = st["me"]
    out = {"workspace_id": ws_id, "available": bool(st["configured"]), "connected": site is not None,
           "can_manage": bool(st["can_manage"]),
           "site": ({"name": site.get("name"), "url": site.get("url")} if site else None),
           "default_project": (site or {}).get("default_project"), "default_issue_type": (site or {}).get("default_issue_type"),
           "team_projects": (site or {}).get("projects") or [],
           "me": {"connected": bool(me["connected"]), "name": me.get("name"), "reaches_site": bool(me.get("reaches_site")),
                  "needs_reconnect": bool(me.get("broken"))}}
    if not st["configured"]:
        return "Jira isn't available on this Markdrop server yet (the Atlassian app isn't set up).", out
    lines = []
    if site is None:
        lines.append(f"{name} isn't connected to Jira. " + (f"You can connect it on the website: {_SETUP}." if st["can_manage"]
                                                             else f"A workspace admin connects it in {_SETUP}."))
    else:
        lines.append(f"{name} is connected to the Jira site {site.get('name')} ({site.get('url')}). New issues go to "
                     f"{site.get('default_project')} as {site.get('default_issue_type') or 'Task'} by default.")
        lines.append("Team shows issues from: " + (", ".join(site["projects"]) if site.get("projects")
                                                  else "no project yet (an admin picks them in " + _SETUP + ")") + ".")
        if not site.get("connector_ok"):
            lines.append(f"The admin connection that keeps the webhooks alive stopped working: an admin reconnects it in {_SETUP}.")
    if not me["connected"]:
        lines.append(f"Your Atlassian account isn't connected: connect it on the website ({_CONNECT}) to create, move "
                     "and see issues.")
    elif me.get("broken"):
        lines.append(f"Your Atlassian connection stopped working: reconnect it in {_CONNECT}.")
    elif site is not None and not me.get("reaches_site"):
        lines.append("Your Atlassian account doesn't reach this workspace's Jira site.")
    else:
        lines.append(f"Your Atlassian account is connected{' as ' + me['name'] if me.get('name') else ''}.")
    return "\n".join(lines), out


async def _item(ctx: Context, args: dict) -> dict:
    ref = await resolve_doc(ctx, args["page"])
    raw = await ctx.db["documents"].find_one({"slug": ref.slug, "deleted_at": None})
    if raw is None:
        raise ToolError("That page isn't there, or you can't open it.")
    kw: dict[str, Any] = {"slug": ref.slug, "block": None, "offset": None, "selection": None}
    if args.get("selection"):
        kw["selection"] = str(args["selection"])
        return kw
    item = str(args.get("item") or "").strip()
    if not item:
        raise ToolError("Say which item: its block id (b-…) or a few of its words, or pass selection.")
    from app.services import access

    if not (await access.can(actor_of(ctx), raw, "read", _actx(ctx))).allowed:
        raise ToolError("That page isn't there, or you can't open it.")
    block, offset, cands = jira_links.find_item(raw.get("content") or "", item)
    if not block and offset is None:
        if cands:
            raise ToolError("More than one item matches: " + "; ".join(f"“{c[:80]}”" for c in cands) + ". Use more words.")
        raise ToolError("No item on that page matches. Use a few words from the item, or its block id.")
    kw.update(block=block, offset=offset)
    return kw


def _draft_out(d: dict) -> dict:
    dr = d["draft"]
    return {"summary": dr["summary"], "description": dr["description"], "project": dr["project"],
            "issue_type": dr["issue_type"], "priority": dr.get("priority"),
            "assignee": (dr.get("assignee") or {}).get("name"), "assignee_user_id": (dr.get("assignee") or {}).get("user_id"),
            "due": dr.get("due"), "labels": dr.get("labels") or [], "ai": d["ai"], "note": d.get("note"),
            "notice": d.get("notice"), "backlink": d["meta"]["backlink"], "item": d["source"]["text"]}


async def _assignee(ctx: Context, ws_id: str, value: str | None) -> str | None:
    if not value:
        return None
    from app.mcp.team_tools import _person_id
    from app.services import workspace_memory as wm

    ws = await wm.ws_info(ctx.db, ws_id)
    if ws is None:
        return None
    return await _person_id(ctx, ws, value)


async def create_jira_issue(ctx: Context, args: dict) -> tuple[str, dict]:
    actor, actx = actor_of(ctx), _actx(ctx)
    kw = await _item(ctx, args)
    try:
        d = await jira_links.draft(ctx.db, actor, actx, project=args.get("project"), **kw)
    except (HTTPException, jira.NotConnected) as exc:
        raise _err(exc)
    out = _draft_out(d)
    if args.get("draft", True):
        lines = [("AI draft" if d["ai"] else "Draft (" + (d.get("note") or "without AI") + ")") + " — nothing was created:",
                 f"Summary: {out['summary']}", f"Project / type: {out['project']} / {out['issue_type']}"]
        if out["priority"]:
            lines.append(f"Priority: {out['priority']}")
        if out["assignee"]:
            lines.append(f"Assignee: {out['assignee']}")
        if out["due"]:
            lines.append(f"Due: {out['due']}")
        if out["labels"]:
            lines.append("Labels: " + ", ".join(out["labels"]))
        if out["description"]:
            lines.append("Description:\n" + out["description"])
        lines.append(f"Markdrop adds the item quoted and “{out['backlink']}” as a link back.")
        if out["notice"]:
            lines.append(out["notice"])
        lines.append("Show it to the user; call again with draft: false (and any fields they changed) to create it as them.")
        return "\n".join(lines), {"created": False, "draft": out}
    ws_id = (await ctx.db["documents"].find_one({"slug": kw["slug"]}, {"workspace_id": 1}) or {}).get("workspace_id")
    who = await _assignee(ctx, ws_id, args.get("assignee")) if args.get("assignee") else out.get("assignee_user_id")
    fields = {"project": (args.get("project") or out["project"] or "").upper(), "issue_type": args.get("issue_type") or out["issue_type"],
              "summary": args.get("summary") or out["summary"], "description": args.get("description", out["description"]),
              "priority": args.get("priority", out["priority"]), "assignee_user_id": who,
              "due": args.get("due", out["due"]), "labels": args.get("labels", out["labels"])}
    try:
        made = await jira_links.create(ctx.db, actor, actx, fields=fields, **kw)
    except (HTTPException, jira.NotConnected) as exc:
        raise _err(exc)
    data = {"created": True, "key": made["key"], "url": made["url"], "linked": made.get("link") is not None,
            "issue": made.get("issue"), "draft": out}
    return (f"Created {made['key']} ({made['url']}) as you" + (", linked to the item on the page" if data["linked"] else "")
            + "."), data


async def link_jira_issue(ctx: Context, args: dict) -> tuple[str, dict]:
    actor, actx = actor_of(ctx), _actx(ctx)
    kw = await _item(ctx, {**args, "selection": None})
    kw.pop("selection", None)
    try:
        made = await jira_links.link_existing(ctx.db, actor, actx, key=str(args["issue"]), **kw)
    except (HTTPException, jira.NotConnected) as exc:
        raise _err(exc)
    st = ((made.get("issue") or {}).get("status") or {}).get("name")
    return (f"Linked {made['key']}" + (f" ({st})" if st else "") + " to the item. Ticking it on the page now moves the "
            "issue to Done, and the reverse."), {"linked": True, "key": made["key"], "url": made["url"], "issue": made.get("issue")}


async def list_jira_issues(ctx: Context, args: dict) -> tuple[str, dict]:
    ws_id, ws_obj, _role = await resolve_workspace(ctx, args["workspace"])
    person = None
    if args.get("person"):
        person = await _assignee(ctx, ws_id, args["person"])
    got = await jira_team.list_issues(ctx.db, actor_of(ctx), ws_id, person_id=person, project=args.get("project"),
                                      status=args.get("status"), limit=int(args.get("limit") or 50))
    name = getattr(ws_obj, "name", None) or "This workspace"
    if got["mode"] == "off":
        return f"{name} isn't connected to Jira.", {"issues": [], "total": 0, "connected": False}
    if got["mode"] == "counts":
        raise ToolError(f"Connect your Atlassian account first ({_CONNECT}): issues are only shown through your own "
                        "Jira access.")
    rows = got["issues"]
    data = {"issues": rows, "total": got.get("total", len(rows)), "connected": True, "site": got.get("site")}
    if not rows:
        return "No issues match.", data
    lines = [f"{got.get('total', len(rows))} issue(s):"]
    for i in rows:
        bits = [i["status"]["name"]]
        if i.get("assignee"):
            bits.append(i["assignee"]["name"])
        if i.get("due"):
            bits.append(f"due {i['due']}" + (" (overdue)" if i.get("overdue") else ""))
        if i.get("blocked"):
            bits.append("blocked")
        lines.append(f"- {i['key']} {i['summary']} — {', '.join(bits)} ({i['url']})")
    return "\n".join(lines), data


async def transition_jira_issue(ctx: Context, args: dict) -> tuple[str, dict]:
    ws_id, _w, _role = await resolve_workspace(ctx, args["workspace"])
    site = await jira.site_for(ctx.db, ws_id)
    if site is None:
        raise ToolError(f"This workspace isn't connected to Jira ({_SETUP}).")
    import re

    m = re.search(r"([A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,8})\s*$", str(args["issue"]).strip().upper().rstrip("/"))
    if not m:
        raise ToolError("Give an issue key like PAY-123 (or its Jira link).")
    key = m.group(1)
    to = str(args["to"]).strip().lower()
    want = {"done": "done", "todo": "new", "to do": "new", "in_progress": "indeterminate", "in progress": "indeterminate"}.get(to)
    if want is None:
        raise ToolError("to must be done, todo or in_progress.")
    uid = ctx.user.id
    try:
        tr = await jira.call_as(ctx.db, uid, site["cloud_id"], "GET", f"issue/{key}/transitions")
        pick = next((t for t in (tr or {}).get("transitions") or []
                     if (((t.get("to") or {}).get("statusCategory") or {}).get("key")) == want), None)
        if pick is None:
            raise ToolError(f"You can't move {key} to {to} in Jira (no such step for you in its workflow).")
        await jira.call_as(ctx.db, uid, site["cloud_id"], "POST", f"issue/{key}/transitions",
                           body={"transition": {"id": str(pick.get("id"))}})
    except jira.NotConnected as exc:
        raise _err(exc)
    except jira_api.JiraError as exc:
        raise _err(jira._http(exc))
    issue = await jira_links._fetch(ctx.db, uid, site, key)
    # Linked to-dos follow now (the webhook would too, a moment later; it then finds nothing to do).
    done = want == "done"
    me = await jira.account(ctx.db, uid)
    async for ln in ctx.db[jira_links.LINKS].find({"cloud_id": site["cloud_id"], "key": key, "workspace_id": ws_id}):
        if ln.get("jira_done") != done:
            await ctx.db[jira_links.LINKS].update_one({"_id": ln["_id"]}, {"$set": {"jira_done": done}})
            if ln.get("block") and ln.get("done") is not None and ln["done"] != done:
                await jira_links._follow_jira(ctx.db, ln, done, (me or {}).get("account_id"))
    st = ((issue or {}).get("status") or {}).get("name") or pick.get("name")
    return f"Moved {key} to {st}.", {"key": key, "status": st, "url": jira.browse_url(site.get("url"), key)}


_ITEM_PROPS = {
    "page": {**_DOC_REF, "description": "The page or meeting page the item is on: its slug or link."},
    "item": {"type": "string", "maxLength": 500,
             "description": "Which item: its block id (b-…) or a few of its words (one item must match)."},
}

JIRA_TOOLS: list[Tool] = [
    Tool(
        name="jira_status",
        title="Jira connection",
        description=("Whether a workspace is connected to a Jira Cloud site: which site, the default project and issue "
                     "type for new issues, the projects whose issues show on Team, and whether the user's own Atlassian "
                     "account is connected (needed to create, move or see issues: everything runs as them). Read-only: "
                     f"connecting is done on the website ({_SETUP}; {_CONNECT})."),
        scope=READ,
        input_schema={"type": "object", "properties": {"workspace": _WORKSPACE_ARG}, "required": ["workspace"]},
        output_schema=_out({"workspace_id": {"type": "string"}, "available": {"type": "boolean"}, "connected": {"type": "boolean"},
                            "can_manage": {"type": "boolean"}, "site": {"type": ["object", "null"]},
                            "default_project": {"type": ["string", "null"]}, "default_issue_type": {"type": ["string", "null"]},
                            "team_projects": {"type": "array", "items": {"type": "string"}}, "me": {"type": "object"}},
                           ["workspace_id", "available", "connected"]),
        annotations=_ann(True, False, True),
        handler=jira_status,
    ),
    Tool(
        name="create_jira_issue",
        title="Create a Jira issue from an item",
        description=("Draft or create a Jira issue from an item on a page or meeting page (an action item, decision, open "
                     "question, any list item or paragraph) or from selected text. draft: true (the default) returns "
                     "Markdrop AI's draft — summary, description, project, issue type, priority, assignee (a member), due "
                     "date, labels — and creates nothing: show it to the user. draft: false creates the issue as the user "
                     "(their own Atlassian connection: they are the reporter) with any fields given here over the draft; "
                     "the description gets the item quoted and a link back to the page (to the exact moment of a meeting), "
                     "and the item shows a live Jira chip; ticking a linked to-do then moves the issue to Done and the "
                     "reverse. Needs read access to the page and the user's Atlassian account connected."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            **_ITEM_PROPS,
            "selection": {"type": "string", "maxLength": 4000, "description": "Text from the page to make the issue from, instead of item."},
            "draft": {"type": "boolean", "default": True, "description": "true: return the draft only; false: create it."},
            "project": {"type": "string", "maxLength": 20, "description": "Jira project key (default: the workspace's)."},
            "issue_type": {"type": "string", "maxLength": 60},
            "summary": {"type": "string", "maxLength": 255},
            "description": {"type": "string", "maxLength": 4000},
            "priority": {"type": ["string", "null"], "maxLength": 40},
            "assignee": {"type": ["string", "null"], "maxLength": 200, "description": "A member: name, email, id, or 'me'."},
            "due": {"type": ["string", "null"], "description": "YYYY-MM-DD"},
            "labels": {"type": "array", "items": {"type": "string", "maxLength": 40}, "maxItems": 10},
        }, "required": ["page"]},
        output_schema=_out({"created": {"type": "boolean"}, "key": {"type": "string"}, "url": {"type": "string"},
                            "linked": {"type": "boolean"}, "issue": {"type": ["object", "null"]}, "draft": {"type": "object"}},
                           ["created", "draft"]),
        annotations=_ann(False, False, False),
        handler=create_jira_issue,
    ),
    Tool(
        name="link_jira_issue",
        title="Link a Jira issue to an item",
        description=("Link an existing Jira issue (key like PAY-123, or its URL) to an item on a page or meeting page: the "
                     "item shows a live chip, and a linked to-do and the issue stay in step (ticked ↔ Done). Needs edit "
                     "access to the page and the user's Atlassian account able to open the issue."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            **_ITEM_PROPS, "issue": {"type": "string", "maxLength": 300, "description": "Issue key or URL."}},
            "required": ["page", "item", "issue"]},
        output_schema=_out({"linked": {"type": "boolean"}, "key": {"type": "string"}, "url": {"type": ["string", "null"]},
                            "issue": {"type": ["object", "null"]}}, ["linked", "key"]),
        annotations=_ann(False, False, True),
        handler=link_jira_issue,
    ),
    Tool(
        name="list_jira_issues",
        title="List Jira issues",
        description=("Jira issues of a workspace's members in the projects that feed Team (updated in the last 30 days), "
                     "optionally for one person, one project, or a status: todo, in_progress, done, overdue, blocked. "
                     "Only issues the user's own Atlassian connection can open (they must be connected)."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "workspace": _WORKSPACE_ARG,
            "person": {"type": "string", "maxLength": 200, "description": "A member: name, email, id, or 'me'."},
            "project": {"type": "string", "maxLength": 20},
            "status": {"type": "string", "enum": ["todo", "in_progress", "done", "overdue", "blocked"]},
            "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 50}}, "required": ["workspace"]},
        output_schema=_out({"issues": {"type": "array", "items": {"type": "object"}}, "total": {"type": "integer"},
                            "connected": {"type": "boolean"}, "site": {"type": ["object", "null"]}},
                           ["issues", "total", "connected"]),
        annotations=_ann(True, False, True),
        handler=list_jira_issues,
    ),
    Tool(
        name="transition_jira_issue",
        title="Move a Jira issue",
        description=("Move a Jira issue to done, todo or in_progress (the first matching step of its workflow), as the "
                     "user. To-dos linked to it in Markdrop follow (ticked when done, unticked otherwise)."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "workspace": _WORKSPACE_ARG, "issue": {"type": "string", "maxLength": 300, "description": "Issue key or URL."},
            "to": {"type": "string", "enum": ["done", "todo", "in_progress"]}}, "required": ["workspace", "issue", "to"]},
        output_schema=_out({"key": {"type": "string"}, "status": {"type": ["string", "null"]}, "url": {"type": "string"}}),
        annotations=_ann(False, False, True),
        handler=transition_jira_issue,
    ),
]
