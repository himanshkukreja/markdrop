"""MCP tools for comments (Track A; CONTRACT §12; services/comments).

    list_comments        the threads on a page or document (open / resolved / all)
    get_thread           one thread with every message
    add_comment          start a thread on quoted text, a block (b-…), or the page
    reply_comment        reply to a thread
    resolve_comment      resolve a thread
    reopen_comment       reopen a resolved thread
    assign_thread        assign a thread to someone as a task (or clear it)
    react_comment        add or remove an emoji reaction on a message
    set_comment_settings the owner's switches: comments on/off, show comments publicly

Same rules as the website: the user must be able to read the item; writing needs documents:write;
encrypted, file and owner-less items have no comments.
"""

from __future__ import annotations

from typing import Any

from bson import ObjectId
from fastapi import HTTPException

from app.mcp.auth import READ, WRITE
from app.mcp.tools import (
    _DOC_REF,
    _URL_PROPS,
    Context,
    Tool,
    ToolError,
    _ann,
    _out,
    actor_of,
    http_message,
    load_for,
    url_pair,
)
from app.services import access as access_service
from app.services.comments import anchoring, perms as perms_mod, service

_THREAD_ID = {"type": "string", "pattern": "^[0-9a-f]{24}$", "description": "The thread's id (from list_comments)."}
_MESSAGE_ID = {"type": "string", "pattern": "^[0-9a-f]{24}$", "description": "The message's id (from get_thread)."}
_BODY = {"type": "string", "minLength": 1, "maxLength": 5000,
         "description": "The comment, plain text or light Markdown (bold, italics, links, code)."}
_MENTIONS = {"type": "array", "maxItems": 20, "items": {"type": "string", "maxLength": 320},
             "description": ("People to @mention: user ids (list_workspace_members) or email addresses. Only "
                             "people who can open the item are mentioned (and notified); others are skipped.")}

_PERSON = {"type": ["object", "null"], "properties": {"id": {"type": ["string", "null"]}, "name": {"type": "string"}}}
_MESSAGE = {"type": "object", "properties": {
    "id": {"type": "string"}, "author": _PERSON, "body": {"type": "string"}, "created_at": {"type": ["string", "null"]},
    "edited_at": {"type": ["string", "null"]}, "deleted": {"type": "boolean"},
    "reactions": {"type": "array"}, "mentions": {"type": "array"}}}
_THREAD = {"type": "object", "properties": {
    "id": {"type": "string"}, "status": {"type": "string"}, "anchor_status": {"type": "string"},
    "anchor": {"type": "object"}, "quote": {"type": ["string", "null"]}, "original_quote": {"type": ["string", "null"]},
    "created_by": _PERSON, "created_at": {"type": ["string", "null"]}, "assignee": _PERSON,
    "resolved_by": _PERSON, "message_count": {"type": "integer"},
    "messages": {"type": "array", "items": _MESSAGE}, "suggestion": {"type": ["object", "null"]}}}


def _actx(ctx: Context) -> access_service.Ctx:
    return access_service.Ctx(ctx.db, surface="mcp")


def _slim_person(p: dict | None) -> dict | None:
    return {"id": p.get("id"), "name": p.get("name")} if p else None


def _slim(t: dict) -> dict:
    a = t.get("anchor") or {}
    return {
        "id": t["id"], "status": t["status"], "anchor_status": t["anchor_status"],
        "anchor": {"type": a.get("type"), "block_id": a.get("block_id")},
        "quote": (a.get("quote") or {}).get("exact") if a.get("quote") else None,
        "original_quote": (t.get("original") or {}).get("exact"),
        "created_by": _slim_person(t.get("created_by")), "created_at": t.get("created_at"),
        "assignee": _slim_person(t.get("assignee")), "resolved_by": _slim_person(t.get("resolved_by")),
        "message_count": t.get("message_count") or 0,
        "messages": [{"id": m["id"], "author": _slim_person(m.get("author")), "body": m.get("body") or "",
                      "created_at": m.get("created_at"), "edited_at": m.get("edited_at"),
                      "deleted": bool(m.get("deleted")),
                      "reactions": [{"emoji": r["emoji"], "count": r["count"]} for r in m.get("reactions") or []],
                      "mentions": [_slim_person(p) for p in m.get("mentions") or []]}
                     for m in t.get("messages") or []],
        "suggestion": t.get("suggestion"),
    }


def _where(t: dict) -> str:
    a = t.get("anchor") or {}
    if a.get("type") == "text" and a.get("quote"):
        q = (a["quote"].get("exact") or "")[:80]
        changed = " (text was changed)" if t.get("anchor_status") == "changed" else ""
        return f"on “{q}”{changed}"
    if a.get("type") == "block":
        return f"on block {a.get('block_id') or ''}".rstrip()
    return "on the page"


def _line(t: dict) -> str:
    first = (t.get("messages") or [{}])[0]
    who = (first.get("author") or {}).get("name") or "Someone"
    more = t.get("message_count", 1) - 1
    tail = f" (+{more} repl{'y' if more == 1 else 'ies'})" if more > 0 else ""
    assignee = f" — assigned to {t['assignee']['name']}" if t.get("assignee") else ""
    return f"- [{t['id']}] {t['status']} {_where(t)}: {who}: {(first.get('body') or '')[:160]}{tail}{assignee}"


async def _load(ctx: Context, document: str, perm: str = "read", action: str = "read") -> dict:
    raw = await load_for(ctx, document, perm, action)
    if not perms_mod.eligible(raw):
        reason = perms_mod.ineligible_reason(raw)
        msg = {"encrypted": "That document is end-to-end encrypted, so it has no comments.",
               "ownerless": "That document has no owner account, so it has no comments.",
               }.get(reason, "Files have no comments yet; only pages and markdown documents do.")
        raise ToolError(msg)
    return raw


async def _mention_ids(ctx: Context, values: list[str] | None) -> list[str]:
    out: list[str] = []
    for v in values or []:
        v = (v or "").strip()
        if ObjectId.is_valid(v):
            out.append(v)
        elif "@" in v:
            u = await ctx.db["users"].find_one({"email": access_service.normalize_email(v)}, {"_id": 1})
            if u is not None:
                out.append(str(u["_id"]))
    return out


async def _call(fn, *a, **kw):
    try:
        return await fn(*a, **kw)
    except HTTPException as exc:
        raise ToolError(http_message(exc))


async def list_comments(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await _load(ctx, args["document"])
    status = args.get("status") or "open"
    got = await _call(service.list_threads, ctx.db, actor_of(ctx), raw, _actx(ctx), status=status)
    threads = [_slim(t) for t in got["threads"]]
    out = {**await url_pair(ctx, raw), "slug": raw["slug"], "counts": got["counts"], "threads": threads}
    if not threads:
        return f"No {'' if status == 'all' else status + ' '}comments on {out['url']}.", out
    return "\n".join([f"Comments on {out['url']} ({got['counts']['open']} open, {got['counts']['resolved']} resolved):",
                      *(_line(t) for t in got["threads"])]), out


async def get_thread(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await _load(ctx, args["document"])
    t = await _call(service.get_thread, ctx.db, actor_of(ctx), raw, _actx(ctx), args["thread_id"])
    out = {**await url_pair(ctx, raw), "slug": raw["slug"], "thread": _slim(t)}
    lines = [f"Thread {t['id']} ({t['status']}) {_where(t)} on {out['url']}:"]
    for m in t["messages"]:
        lines.append(f"- {(m.get('author') or {}).get('name')}: {'(deleted)' if m['deleted'] else m['body']}")
    return "\n".join(lines), out


async def add_comment(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await _load(ctx, args["document"], "read", "comment on")
    quote, block = args.get("quote"), args.get("block")
    rev = int(raw.get("rev") or 1)
    try:
        if quote:
            anchor = anchoring.anchor_from_quote(raw.get("content") or "", quote, rev, block_id=block,
                                                 occurrence=int(args.get("occurrence") or 1))
            anchor_in = {"type": "text", "block_id": anchor.get("block_id"), "block_text": anchor.get("block_text"),
                         "quote": anchor["quote"], "start": anchor.get("start")}
        elif block:
            anchor_in = {"type": "block", "block_id": block}
        else:
            anchor_in = {"type": "page"}
    except anchoring.AnchorError as exc:
        raise ToolError(str(exc))
    assignee = (await _mention_ids(ctx, [args["assignee"]]))[0] if args.get("assignee") else None
    if args.get("assignee") and not assignee:
        raise ToolError("Nobody with that id or email can be assigned.")
    t = await _call(service.create_thread, ctx.db, actor_of(ctx), raw, _actx(ctx), anchor=anchor_in,
                    body=args["body"], mentions=await _mention_ids(ctx, args.get("mentions")), via="mcp",
                    assignee=assignee)
    out = {**await url_pair(ctx, raw), "slug": raw["slug"], "thread": _slim(t),
           "thread_url": f"{(await url_pair(ctx, raw))['url']}#c-{t['id']}"}
    return f"Commented {_where(t)} on {out['url']} (thread {t['id']}).", out


async def reply_comment(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await _load(ctx, args["document"], "read", "comment on")
    t, _m = await _call(service.reply, ctx.db, actor_of(ctx), raw, _actx(ctx), args["thread_id"], body=args["body"],
                        mentions=await _mention_ids(ctx, args.get("mentions")), via="mcp")
    out = {**await url_pair(ctx, raw), "slug": raw["slug"], "thread": _slim(t)}
    return f"Replied to thread {t['id']} on {out['url']}.", out


async def resolve_comment(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await _load(ctx, args["document"], "read", "resolve comments on")
    t = await _call(service.resolve, ctx.db, actor_of(ctx), raw, _actx(ctx), args["thread_id"], via="mcp")
    out = {**await url_pair(ctx, raw), "slug": raw["slug"], "thread": _slim(t)}
    return f"Resolved thread {t['id']} on {out['url']}.", out


async def reopen_comment(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await _load(ctx, args["document"], "read", "reopen comments on")
    t = await _call(service.reopen, ctx.db, actor_of(ctx), raw, _actx(ctx), args["thread_id"], via="mcp")
    out = {**await url_pair(ctx, raw), "slug": raw["slug"], "thread": _slim(t)}
    return f"Reopened thread {t['id']} on {out['url']}.", out


async def assign_thread(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await _load(ctx, args["document"], "read", "assign comments on")
    who = args.get("assignee")
    uid = None
    if who:
        ids = await _mention_ids(ctx, [who])
        if not ids:
            raise ToolError("Nobody with that id or email can be assigned.")
        uid = ids[0]
    t = await _call(service.assign, ctx.db, actor_of(ctx), raw, _actx(ctx), args["thread_id"], uid)
    out = {**await url_pair(ctx, raw), "slug": raw["slug"], "thread": _slim(t)}
    if t.get("assignee"):
        return f"Assigned thread {t['id']} to {t['assignee']['name']}.", out
    return f"Thread {t['id']} has no assignee now.", out


async def react_comment(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await _load(ctx, args["document"], "read", "react on")
    on = args.get("on")
    m = await _call(service.react, ctx.db, actor_of(ctx), raw, _actx(ctx), args["thread_id"], args["message_id"],
                    args["emoji"], on=on if isinstance(on, bool) else None)
    out = {**await url_pair(ctx, raw), "slug": raw["slug"], "message_id": m["id"],
           "reactions": [{"emoji": r["emoji"], "count": r["count"], "mine": r["mine"]} for r in m["reactions"]]}
    mine = any(r["emoji"] == args["emoji"] and r["mine"] for r in m["reactions"])
    return (f"Reacted {args['emoji']}." if mine else f"Removed your {args['emoji']}."), out


async def set_comment_settings(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await _load(ctx, args["document"], "read", "change comment settings on")
    got = await _call(service.update_settings, ctx.db, actor_of(ctx), raw, _actx(ctx),
                      enabled=args.get("enabled"), public=args.get("public"))
    out = {**await url_pair(ctx, raw), "slug": raw["slug"], **got}
    state = "on" if got["enabled"] else "off"
    pub = "shown to anyone who can read it" if got["public"] else "shown only to signed-in people"
    return f"Comments are {state} on {out['url']}, {pub}.", out


_THREAD_OUT = _out({**_URL_PROPS, "slug": {"type": "string"}, "thread": _THREAD}, ["url", "markdrop_url", "slug", "thread"])

COMMENT_TOOLS: list[Tool] = [
    Tool(
        name="list_comments",
        title="List comments on a page",
        description=(
            "The comment threads on a page or markdown document, oldest first: for each, its id, status (open or "
            "resolved), where it points (quote: the commented text; anchor.block_id; or the page), anchor_status "
            "('changed' when the commented text was edited away: original_quote shows what it was), who started "
            "it, the assignee, and every message (author, body, reactions). status: open (default), resolved or "
            "all. Encrypted documents and files have no comments."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF,
            "status": {"type": "string", "enum": ["open", "resolved", "all"], "default": "open"},
        }, "required": ["document"]},
        output_schema=_out({**_URL_PROPS, "slug": {"type": "string"}, "counts": {"type": "object"},
                            "threads": {"type": "array", "items": _THREAD}},
                           ["url", "markdrop_url", "slug", "counts", "threads"]),
        annotations=_ann(True, False, True),
        handler=list_comments,
    ),
    Tool(
        name="get_thread",
        title="Read one comment thread",
        description="One comment thread with every message (see list_comments for the fields).",
        scope=READ,
        input_schema={"type": "object", "properties": {"document": _DOC_REF, "thread_id": _THREAD_ID},
                      "required": ["document", "thread_id"]},
        output_schema=_THREAD_OUT,
        annotations=_ann(True, False, True),
        handler=get_thread,
    ),
    Tool(
        name="add_comment",
        title="Comment on a page",
        description=(
            "Start a comment thread on a page or markdown document, as the user. Point it at text with quote "
            "(the exact words as the page shows them; occurrence picks the n-th match when they repeat), at a "
            "whole block with block (its id, b-…, from get_page), or at neither for a comment on the page as a "
            "whole. The page's text never changes. People in mentions are notified; assignee makes it a task "
            "on their Home. Returns the thread and its link."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF,
            "body": _BODY,
            "quote": {"type": "string", "minLength": 1, "maxLength": 1000,
                      "description": "The text to comment on, exactly as it reads on the page."},
            "occurrence": {"type": "integer", "minimum": 1, "default": 1,
                           "description": "Which match of quote, when it appears more than once."},
            "block": {"type": "string", "pattern": "^b-[a-z0-9]{4,12}$",
                      "description": "A block's id: the whole block, or (with quote) where to look for the quote."},
            "mentions": _MENTIONS,
            "assignee": {"type": "string", "maxLength": 320,
                         "description": "Assign the thread to this person (user id or email) as a task."},
        }, "required": ["document", "body"]},
        output_schema=_out({**_URL_PROPS, "slug": {"type": "string"}, "thread": _THREAD,
                            "thread_url": {"type": "string"}}, ["url", "markdrop_url", "slug", "thread", "thread_url"]),
        annotations=_ann(False, False, False),
        handler=add_comment,
    ),
    Tool(
        name="reply_comment",
        title="Reply to a comment thread",
        description=("Reply to a comment thread as the user. Replying to a resolved thread reopens it. People in "
                     "mentions are notified, and so is everyone already in the thread."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {"document": _DOC_REF, "thread_id": _THREAD_ID,
                                                       "body": _BODY, "mentions": _MENTIONS},
                      "required": ["document", "thread_id", "body"]},
        output_schema=_THREAD_OUT,
        annotations=_ann(False, False, False),
        handler=reply_comment,
    ),
    Tool(
        name="resolve_comment",
        title="Resolve a comment thread",
        description=("Mark a thread resolved (its history is kept and it can be reopened). The person who started "
                     "it and anyone who can edit the item may resolve it; resolving an assigned thread completes "
                     "that task."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {"document": _DOC_REF, "thread_id": _THREAD_ID},
                      "required": ["document", "thread_id"]},
        output_schema=_THREAD_OUT,
        annotations=_ann(False, False, True),
        handler=resolve_comment,
    ),
    Tool(
        name="reopen_comment",
        title="Reopen a comment thread",
        description="Reopen a resolved thread (same people who may resolve it).",
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {"document": _DOC_REF, "thread_id": _THREAD_ID},
                      "required": ["document", "thread_id"]},
        output_schema=_THREAD_OUT,
        annotations=_ann(False, False, True),
        handler=reopen_comment,
    ),
    Tool(
        name="assign_thread",
        title="Assign a comment thread",
        description=("Assign a thread to someone who can open the item, as a task: it shows in their Home's "
                     "action items and on the Team page until the thread is resolved. assignee null (or left out) "
                     "clears it. Editors and the thread's author may assign."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF, "thread_id": _THREAD_ID,
            "assignee": {"type": ["string", "null"], "maxLength": 320, "description": "User id or email; null clears."},
        }, "required": ["document", "thread_id"]},
        output_schema=_THREAD_OUT,
        annotations=_ann(False, False, True),
        handler=assign_thread,
    ),
    Tool(
        name="react_comment",
        title="React to a comment",
        description="Add (on: true) or remove (on: false) the user's emoji reaction on one message; toggles when on is left out.",
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF, "thread_id": _THREAD_ID, "message_id": _MESSAGE_ID,
            "emoji": {"type": "string", "minLength": 1, "maxLength": 16}, "on": {"type": "boolean"},
        }, "required": ["document", "thread_id", "message_id", "emoji"]},
        output_schema=_out({**_URL_PROPS, "slug": {"type": "string"}, "message_id": {"type": "string"},
                            "reactions": {"type": "array"}}, ["url", "markdrop_url", "slug", "message_id", "reactions"]),
        annotations=_ann(False, False, True),
        handler=react_comment,
    ),
    Tool(
        name="set_comment_settings",
        title="Turn comments on or off",
        description=("The owner's switches for one item: enabled (comments on or off; on by default) and public "
                     "(show comments to anyone who can read it, including people who aren't signed in; off by "
                     "default). Only the owner can change them."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF, "enabled": {"type": "boolean"}, "public": {"type": "boolean"},
        }, "required": ["document"]},
        output_schema=_out({**_URL_PROPS, "slug": {"type": "string"}, "enabled": {"type": "boolean"},
                            "public": {"type": "boolean"}, "workspace_enabled": {"type": "boolean"}},
                           ["url", "markdrop_url", "slug", "enabled", "public"]),
        annotations=_ann(False, False, True),
        handler=set_comment_settings,
    ),
]

_ = Any
