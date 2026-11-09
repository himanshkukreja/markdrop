"""MCP tools for Jira inside pages (services/jira_pages.py).

* ``insert_jira``: put a Jira issue on a page as an inline chip or a card, or a live list (JQL, a
  project, or a saved filter), at the end or after a heading. Readers who can open the issue in their own
  Jira see it live; everyone else sees "KEY · title".
* ``update_jira_issue``: change an issue as the user — a workflow step by name ("In Review", "Done"…, with
  the step's required fields), the assignee, a Jira comment, the title, priority or due date.
* ``list_jira_transitions``: the steps the user can take on an issue now, with each step's fields.
* ``thread_to_jira``: a Jira issue from a comment thread (draft first, then create as the user; the
  discussion is linked to it), optionally with the issue's chip right after the quoted text.

Everything runs with the user's own Atlassian connection (Jira's permissions decide). Reading a page
(``get_page``) lists its chips, cards and lists as plain links ("KEY · title" + URL).
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import HTTPException

from app.mcp.auth import READ, WRITE
from app.mcp.tools import _DOC_REF, Context, Tool, ToolError, _ann, _out, actor_of, http_message, load_for
from app.services import access, jira, jira_pages

_CONNECT = "Settings › Account › Jira"


def _err(exc: Exception) -> ToolError:
    if isinstance(exc, jira_pages.NeedJira):
        return ToolError(f"{exc.detail} Connect it on the website ({_CONNECT}).")
    if isinstance(exc, HTTPException):
        return ToolError(http_message(exc))
    return ToolError(str(exc))


def _actx(ctx: Context) -> access.Ctx:
    return access.Ctx(ctx.db, surface="mcp")


async def _host(ctx: Context, issue: str | None, site: str | None, page: dict | None) -> str:
    """Which Jira site: ``site``, the host of an issue link, the page's workspace's site, or the only site
    the user's connection reaches."""
    h = jira_pages.host_of(site) or (jira_pages.host_of(issue) if issue and "/" in issue else None)
    if not h and page is not None:
        h = await jira_pages.default_host(ctx.db, page)
    if not h:
        row = await jira.account(ctx.db, ctx.user.id)
        sites = sorted(jira_pages.account_sites(row))
        if len(sites) == 1:
            h = sites[0]
        elif sites:
            raise ToolError("Say which Jira site (site: " + " or ".join(sites) + ").")
        else:
            raise ToolError(f"Connect your Atlassian account first, on the website ({_CONNECT}).")
    return h


def _key(issue: str) -> str:
    k = jira_pages.norm_key(issue)
    if not k:
        raise ToolError("Give an issue key like PAY-123 (or its Jira link).")
    return k


async def _page(ctx: Context, value: str | None, perm: str = "read") -> dict | None:
    if not value:
        return None
    return await load_for(ctx, value, perm, "update" if perm != "read" else "read")


def _issue_line(it: dict | None) -> str:
    if not it:
        return ""
    bits = [it["status"]["name"]]
    if it.get("assignee"):
        bits.append(it["assignee"]["name"])
    if it.get("priority"):
        bits.append(it["priority"])
    if it.get("due"):
        bits.append(f"due {it['due']}")
    return f"{it['key']} {it.get('summary') or ''} — {', '.join(bits)}"


async def place(ctx: Context, raw: dict, block: str, heading: str | None) -> dict:
    """Put a Markdown block on the page: after ``heading``'s section, else at the end."""
    from app.mcp import page_tools
    from app.services import pages

    page_tools._editable_page(raw)
    if heading:
        await page_tools._lock_check(raw, ctx)
        content = pages.insert_after_section(raw.get("content") or "", heading, block)
        if content is None:
            raise ToolError(f"There's no heading {heading!r} on that page.")
        return await page_tools._save(ctx, raw, content, int(raw.get("rev") or 1))
    return await page_tools._append(ctx, raw, block)


async def insert_jira(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.mcp import page_tools

    raw = await load_for(ctx, args["document"], "edit_content", "update")
    as_ = args.get("as") or ("list" if any(args.get(k) for k in ("jql", "project", "filter")) else "chip")
    host = await _host(ctx, args.get("issue"), args.get("site"), raw)
    title = None
    if as_ == "list":
        spec = jira_pages.list_spec({k: args.get(k) for k in ("jql", "project", "filter", "cols", "limit", "title")})
        if spec is None:
            raise ToolError(f"A list needs jql (up to {jira_pages.MAX_JQL} characters), a project key or a filter id.")
        block = jira_pages.list_md(spec, None if host == await jira_pages.default_host(ctx.db, raw) else host)
    else:
        key = _key(str(args.get("issue") or ""))
        try:
            snap = await jira_pages.remember(ctx.db, actor_of(ctx), _actx(ctx), raw, host, key)
            title = snap.get("title")
        except HTTPException as exc:
            if exc.status_code not in (404, 409):
                raise _err(exc)
        site_attr = None if host == await jira_pages.default_host(ctx.db, raw) else host
        block = jira_pages.card_md(key, site_attr) if as_ == "card" else jira_pages.chip_md(key, site_attr)
    after = await place(ctx, raw, block, args.get("after_heading"))
    out = {**await page_tools._result(ctx, after), "as": as_, "markdown": block, "site": host, "title": title}
    what = {"chip": "an inline chip", "card": "a card", "list": "a live list"}[as_]
    note = (" Readers who can open it in their own Jira see it live; everyone else sees its key"
            + (" and title." if as_ != "list" else ".") if as_ != "list" else
            " Each reader sees only the issues their own Jira shows them; people without Jira see a sign-in prompt.")
    return f"Inserted {what} into {out['url']}.{note}", out


async def _assignee_id(ctx: Context, host: str, key: str, value: Any) -> str | None:
    if value is None or str(value).strip().lower() in ("", "none", "unassigned", "nobody"):
        return None
    v = str(value).strip()
    if v.lower() == "me":
        row = await jira.account(ctx.db, ctx.user.id)
        if not row or not row.get("account_id"):
            raise ToolError(f"Connect your Atlassian account first ({_CONNECT}).")
        return row["account_id"]
    people = (await jira_pages.assignable(ctx.db, ctx.user.id, host, key, v))["people"]
    exact = [p for p in people if p["name"].lower() == v.lower() or p["account_id"] == v]
    pick = exact or (people if len(people) == 1 else [])
    if len(pick) != 1:
        if not people:
            raise ToolError(f"Nobody called {v!r} can be assigned {key} in Jira.")
        raise ToolError(f"More than one person matches {v!r}: " + ", ".join(p["name"] for p in people[:8]) + ".")
    return pick[0]["account_id"]


async def update_jira_issue(ctx: Context, args: dict) -> tuple[str, dict]:
    key = _key(str(args["issue"]))
    page = await _page(ctx, args.get("page"))
    host = await _host(ctx, args.get("issue"), args.get("site"), page)
    slug = (page or {}).get("slug")
    uid = ctx.user.id
    done: list[str] = []
    it = None
    try:
        changes = {k: args[k] for k in ("summary", "priority", "due") if k in args}
        if changes:
            it = (await jira_pages.edit(ctx.db, uid, host, key, changes, slug=slug))["issue"]
            done.append("edited " + ", ".join(changes))
        if args.get("transition"):
            r = await jira_pages.transition(ctx.db, uid, host, key, str(args["transition"]), fields=args.get("fields"), slug=slug)
            it = r["issue"]
            done.append(f"moved it ({r['transition']})")
        if "assignee" in args:
            acc = await _assignee_id(ctx, host, key, args["assignee"])
            it = (await jira_pages.assign(ctx.db, uid, host, key, acc, slug=slug))["issue"]
            done.append("assigned it" if acc else "unassigned it")
        if args.get("comment"):
            it = (await jira_pages.comment(ctx.db, uid, host, key, str(args["comment"]), slug=slug))["issue"]
            done.append("commented")
    except HTTPException as exc:
        msg = _err(exc)
        if done:
            raise ToolError(f"{key}: {'; '.join(done)}, then: {msg}")
        raise msg
    if not done:
        raise ToolError("Nothing to change: pass transition, assignee, comment, summary, priority or due.")
    return f"{key}: {'; '.join(done)} (as you). Now: {_issue_line(it)}", {"key": key, "site": host, "issue": it,
                                                                           "url": jira_pages.browse(host, key)}


async def list_jira_transitions(ctx: Context, args: dict) -> tuple[str, dict]:
    key = _key(str(args["issue"]))
    page = await _page(ctx, args.get("page"))
    host = await _host(ctx, args.get("issue"), args.get("site"), page)
    try:
        got = await jira_pages.transitions(ctx.db, ctx.user.id, host, key)
    except HTTPException as exc:
        raise _err(exc)
    rows = got["transitions"]
    if not rows:
        return f"You can't move {key} anywhere right now (Jira's workflow offers you no step).", {"key": key, "transitions": []}
    lines = [f"Steps you can take on {key}:"]
    for t in rows:
        req = [f["name"] + (" (" + ", ".join(o["name"] for o in f["options"][:8]) + ")" if f["options"] else "")
               for f in t["fields"] if f["required"]]
        keys = [f["key"] for f in t["fields"] if f["required"]]
        need = f"; needs {', '.join(req)} (pass fields with: {', '.join(keys)})" if req else ""
        lines.append(f"- {t['name']} → {t['to']['name']}{need}")
    return "\n".join(lines), {"key": key, "site": host, "transitions": rows}


async def thread_to_jira(ctx: Context, args: dict) -> tuple[str, dict]:
    """As POST /pages/{slug}/threads/{thread}/draft, then …/issue (services/jira_pages.thread_draft /
    thread_create): the same access checks; the fields map as create_jira_issue's do."""
    from app.mcp import jira_tools
    from app.mcp.comment_review_tools import _thread_id

    raw = await load_for(ctx, args["document"], "read", "read")
    tid = _thread_id(args["thread"])
    actor, actx = actor_of(ctx), _actx(ctx)
    try:
        d = await jira_pages.thread_draft(ctx.db, actor, actx, raw, tid, args.get("project"))
    except (HTTPException, jira.NotConnected) as exc:
        raise jira_tools._err(exc)
    out = jira_tools._draft_out(d)
    if args.get("draft", True):
        lines = ["Draft — nothing was created:", f"Summary: {out['summary']}",
                 f"Project / type: {out['project']} / {out['issue_type']}"]
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
        lines.append("Markdrop adds the discussion quoted and a link back to the thread.")
        if out["notice"]:
            lines.append(out["notice"])
        lines.append("Show it to the user; call again with draft: false (and any fields they changed) to create it "
                     "as them and link the discussion.")
        return "\n".join(lines), {"created": False, "thread_id": tid, "draft": out}
    who = (await jira_tools._assignee(ctx, raw.get("workspace_id"), args.get("assignee")) if args.get("assignee")
           else out.get("assignee_user_id"))
    fields = {"project": (args.get("project") or out["project"] or "").upper(),
              "issue_type": args.get("issue_type") or out["issue_type"],
              "summary": args.get("summary") or out["summary"], "description": args.get("description", out["description"]),
              "priority": args.get("priority", out["priority"]), "assignee_user_id": who,
              "due": args.get("due", out["due"]), "labels": args.get("labels", out["labels"])}
    try:
        made = await jira_pages.thread_create(ctx.db, actor, actx, raw, tid, fields)
    except (HTTPException, jira.NotConnected) as exc:
        raise jira_tools._err(exc)
    data = {"created": True, "thread_id": tid, "key": made["key"], "url": made.get("url"), "site": made.get("site"),
            "title": made.get("title"), "issue": made.get("issue"), "draft": out, "chip": False}
    note = None
    if args.get("put_chip"):
        data["chip"], note = await _chip_after_quote(ctx, raw, tid, made)
    return (f"Created {made['key']}" + (f" ({made['url']})" if made.get("url") else "") + " as you and linked the "
            "discussion to it: everyone who sees the thread sees the issue." + (f" {note}" if note else "")), data


async def _chip_after_quote(ctx: Context, raw: dict, tid: str, made: dict) -> tuple[bool, str]:
    """The issue's inline chip right after the thread's quoted text (the quote stays, so the comment stays
    anchored). Never fails the creation: says why not instead."""
    from bson import ObjectId

    from app.mcp import page_tools
    from app.services.comments import suggestions

    skipped = "The issue was created, but its chip wasn't put on the page: "
    try:
        cur = await ctx.db["documents"].find_one({"_id": raw["_id"], "deleted_at": None})
        if cur is None or cur.get("encrypted") or cur.get("kind") == "artifact":
            return False, skipped + "the page can't take one."
        if not (await access.can(actor_of(ctx), cur, "edit_content", _actx(ctx))).allowed:
            return False, skipped + "you can't edit the page."
        t = await ctx.db["comment_threads"].find_one({"_id": ObjectId(tid), "doc_id": str(cur["_id"])})
        anchor = (t or {}).get("anchor") or {}
        if anchor.get("type") != "text" or not (anchor.get("quote") or {}).get("exact"):
            return False, skipped + "the thread isn't on quoted text."
        md = cur.get("content") or ""
        at = suggestions.locate(md, anchor)
        if isinstance(at, str):
            return False, skipped + "the quoted text isn't on the page as it was."
        end = at[1]
        # Past the quote's closing emphasis / code marks and a link's "](…)", so the chip sits outside them.
        while end < len(md) and md[end] in "*~`":
            end += 1
        if md.startswith("](", end):
            close = md.find(")", end)
            if 0 < close and "\n" not in md[end:close]:
                end = close + 1
        host = made.get("site")
        chip = jira_pages.chip_md(made["key"], None if host == await jira_pages.default_host(ctx.db, cur) else host)
        tail = " " if end < len(md) and (md[end].isalnum() or md[end] == "_") else ""
        new = md[:end] + " " + chip + tail + md[end:]
        await page_tools._lock_check(cur, ctx)
        await page_tools._save(ctx, cur, new, int(cur.get("rev") or 1))
        return True, "Its chip is on the page right after the quoted text."
    except ToolError as exc:
        return False, skipped + str(exc)
    except Exception:  # noqa: BLE001  (the issue exists either way)
        import logging

        logging.getLogger(__name__).warning("thread_to_jira: chip not placed", exc_info=True)
        return False, skipped + "the page couldn't be saved just now."


async def page_listing(ctx: Context, raw: dict) -> list[dict]:
    """``get_page``'s ``jira``: every chip, card and list as a plain link."""
    snaps, default = await jira_pages.snapshots(ctx.db, raw)
    return [{k: v for k, v in jira_pages.plain(r, snaps, default).items() if k != "markdown"}
            for r in jira_pages.refs(raw.get("content"))]


def listing_text(items: list[dict]) -> str:
    if not items:
        return ""
    lines = ["Jira on this page (as plain links):"]
    for i in items:
        lines.append(f"- {i['text']}" + (f" ({i['url']})" if i.get("url") else "") + ("" if i["as"] == "chip" else f" [{i['as']}]"))
    return "\n".join(lines)


_ISSUE = {"type": "string", "maxLength": 300, "description": "Issue key (PAY-123) or its Jira link."}
_SITE = {"type": "string", "maxLength": 200,
         "description": "The Jira site's host (acme.atlassian.net). Default: from the link, the page's workspace, or your only site."}

JIRA_PAGE_TOOLS: list[Tool] = [
    Tool(
        name="insert_jira",
        title="Put Jira on a page",
        description=("Insert a Jira issue into a page as an inline chip (as: chip, the default) or an issue card "
                     "(as: card: title, status, assignee, priority, type, due, sprint), or a live list of issues "
                     "(as: list, with jql, project or filter; cols and limit optional), at the end of the page or after "
                     "a heading. Readers see live details only through their own Jira connection; everyone else sees "
                     "\"KEY · title\" (lists: nothing without Jira). In Markdown these are :jira[KEY]{site=…}, "
                     "::jira{key=… site=…} and ::jira-list{jql=\"…\"} — get_page shows them as plain links too. Needs "
                     "edit access to the page."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": {**_DOC_REF, "description": "The page: slug or link."},
            "issue": _ISSUE,
            "as": {"type": "string", "enum": ["chip", "card", "list"]},
            "jql": {"type": "string", "maxLength": jira_pages.MAX_JQL, "description": "A list's JQL (runs as each reader)."},
            "project": {"type": "string", "maxLength": 20, "description": "A list of a project's issues (newest first)."},
            "filter": {"type": "string", "maxLength": 12, "description": "A list from a saved Jira filter (its id)."},
            "cols": {"type": "array", "items": {"type": "string", "enum": list(jira_pages.COLS)}, "maxItems": 7},
            "limit": {"type": "integer", "minimum": 1, "maximum": jira_pages.LIST_MAX},
            "title": {"type": "string", "maxLength": 120, "description": "A list's heading."},
            "site": _SITE,
            "after_heading": {"type": "string", "maxLength": 300, "description": "Put it at the end of this heading's section."},
        }, "required": ["document"]},
        output_schema=_out({"url": {"type": "string"}, "as": {"type": "string"}, "markdown": {"type": "string"},
                            "site": {"type": "string"}, "title": {"type": ["string", "null"]}, "rev": {"type": "integer"}},
                           ["url", "as", "markdown"]),
        annotations=_ann(False, False, False),
        handler=insert_jira,
    ),
    Tool(
        name="update_jira_issue",
        title="Change a Jira issue",
        description=("Change a Jira issue as the user (their own Atlassian connection; Jira's permissions decide, and "
                     "its refusal is returned as it is): transition (any step of the issue's workflow, by its name or the "
                     "status it leads to — list_jira_transitions shows them and the fields a step needs, passed in "
                     "fields), assignee (a name, 'me', or null to unassign), comment (added in Jira), summary, priority, "
                     "due (YYYY-MM-DD, null clears it). Pages showing the issue update live for their readers."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "issue": _ISSUE, "site": _SITE,
            "page": {**_DOC_REF, "description": "Optional: the page it's on (its Jira site, and a live update there)."},
            "transition": {"type": "string", "maxLength": 80},
            "fields": {"type": "object", "description": "A step's fields by id, e.g. {\"resolution\": \"Done\"}."},
            "assignee": {"type": ["string", "null"], "maxLength": 200},
            "comment": {"type": "string", "maxLength": jira_pages.COMMENT_MAX},
            "summary": {"type": "string", "maxLength": 255},
            "priority": {"type": "string", "maxLength": 40},
            "due": {"type": ["string", "null"], "maxLength": 10},
        }, "required": ["issue"]},
        output_schema=_out({"key": {"type": "string"}, "site": {"type": "string"}, "url": {"type": "string"},
                            "issue": {"type": ["object", "null"]}}, ["key"]),
        annotations=_ann(False, False, False),
        handler=update_jira_issue,
    ),
    Tool(
        name="list_jira_transitions",
        title="Jira workflow steps",
        description=("The workflow steps the user can take on a Jira issue now (name → the status it leads to), each with "
                     "the fields its screen needs (required ones first, with their allowed values). Use a step's name "
                     "with update_jira_issue."),
        scope=READ,
        input_schema={"type": "object", "properties": {"issue": _ISSUE, "site": _SITE,
                                                       "page": {**_DOC_REF, "description": "Optional: the page it's on."}},
                      "required": ["issue"]},
        output_schema=_out({"key": {"type": "string"}, "transitions": {"type": "array", "items": {"type": "object"}}},
                           ["key", "transitions"]),
        annotations=_ann(True, False, True),
        handler=list_jira_transitions,
    ),
    Tool(
        name="thread_to_jira",
        title="Make a Jira issue from a comment thread",
        description=("Turn a comment discussion into a Jira issue. draft: true (the default) returns a draft — "
                     "summary, description, project, issue type, priority, assignee (a member), due date, labels — "
                     "from the thread's messages and creates nothing: show it to the user. draft: false creates the "
                     "issue as the user (their own Atlassian connection) with any fields given here over the draft; "
                     "the description quotes the discussion and links back to the thread, and the thread is linked to "
                     "the issue (everyone who sees it sees \"KEY · title\"). A thread can have one issue. put_chip: "
                     "true also puts the issue's inline chip on the page right after the quoted text (the text stays, "
                     "so the comment stays where it is; needs edit access). Needs the user to be able to comment on "
                     "the page, its workspace connected to Jira, and their Atlassian account connected."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": {**_DOC_REF, "description": "The page or document the thread is on: slug or link."},
            "thread": {"type": "string", "minLength": 1, "maxLength": 300,
                       "description": "The thread's id (from list_comments), or its link ending in #c-<id>."},
            "draft": {"type": "boolean", "default": True, "description": "true: return the draft only; false: create it."},
            "project": {"type": "string", "maxLength": 20, "description": "Jira project key (default: the workspace's)."},
            "issue_type": {"type": "string", "maxLength": 60},
            "summary": {"type": "string", "maxLength": 255},
            "description": {"type": "string", "maxLength": 4000},
            "priority": {"type": ["string", "null"], "maxLength": 40},
            "assignee": {"type": ["string", "null"], "maxLength": 200, "description": "A member: name, email, id, or 'me'."},
            "due": {"type": ["string", "null"], "description": "YYYY-MM-DD"},
            "labels": {"type": "array", "items": {"type": "string", "maxLength": 40}, "maxItems": 10},
            "put_chip": {"type": "boolean", "default": False,
                         "description": "Also put the issue's chip on the page right after the quoted text."},
        }, "required": ["document", "thread"]},
        output_schema=_out({"created": {"type": "boolean"}, "thread_id": {"type": "string"}, "key": {"type": "string"},
                            "url": {"type": ["string", "null"]}, "site": {"type": ["string", "null"]},
                            "title": {"type": ["string", "null"]}, "issue": {"type": ["object", "null"]},
                            "draft": {"type": "object"}, "chip": {"type": "boolean"}},
                           ["created", "thread_id", "draft"]),
        annotations=_ann(False, False, False),
        handler=thread_to_jira,
    ),
]


def chip_for_selection(content: str, selection: str, key: str, host: str | None) -> str | None:
    """The page with the first line-local occurrence of ``selection`` replaced by the issue's chip
    (create_jira_issue from selected text: the text becomes the chip). None when it isn't on one line."""
    sel = re.sub(r"\s+", " ", selection or "").strip()
    if not sel or "\n" in sel:
        return None
    at = content.find(sel)
    if at < 0:
        return None
    return content[:at] + jira_pages.chip_md(key, host) + content[at + len(sel):]
