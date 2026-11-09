"""MCP tools for suggested edits and AI on comment threads (Track B): suggest_edit, accept_suggestion,
summarize_discussion.

The website's rules, through the same services: anyone who can comment on a page or document suggests an
edit (on an existing thread, or a new one on a quote); people who can edit it accept one (the page then says
it, as its own version in the history, and the thread is resolved). While someone has the page open in the
editor an accepted suggestion waits for them instead (they apply it from their comments panel). Writes need
the documents:write scope. Files in comments are uploaded from the app; tools see them in list_comments.
"""

from __future__ import annotations

import re

from fastapi import HTTPException

from app.mcp.auth import READ, WRITE
from app.mcp.tools import (
    _DOC_REF,
    _URL_PROPS,
    ENCRYPTED_READ,
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
from app.services.comments import ai, suggestions

_THREAD = {"type": "string", "minLength": 1, "maxLength": 300,
           "description": "The thread's id (from list_comments / get_thread), or its link ending in #c-<id>."}
_ID = re.compile(r"([0-9a-f]{24})\s*$")


def _actx(ctx: Context) -> access_service.Ctx:
    return access_service.Ctx(ctx.db, surface="mcp")


def _thread_id(value: str) -> str:
    m = _ID.search(str(value or "").strip())
    if not m:
        raise ToolError("That isn't a thread id. list_comments gives each thread's id.")
    return m.group(1)


async def _item(ctx: Context, document: str) -> dict:
    raw = await load_for(ctx, document, "read", "read")
    if raw.get("encrypted"):
        raise ToolError(ENCRYPTED_READ + " End-to-end encrypted documents have no comments.")
    if raw.get("kind") == "artifact":
        raise ToolError("That's a file: comments work on pages and Markdown documents.")
    return raw


def _excerpt(text: str | None, n: int = 120) -> str:
    t = re.sub(r"\s+", " ", text or "").strip()
    return t if len(t) <= n else t[: n - 1] + "…"


async def suggest_edit(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await _item(ctx, args["document"])
    actor, actx = actor_of(ctx), _actx(ctx)
    text = str(args.get("text") or "")
    try:
        if args.get("thread"):
            thread = await suggestions.propose(ctx.db, actor, raw, actx, _thread_id(args["thread"]), text)
        else:
            quote = str(args.get("quote") or "").strip()
            if not quote:
                raise ToolError("Give the exact text to replace (quote), or an existing thread.")
            from app.services.comments import service

            anchor = {"type": "text", "quote": {"exact": quote}}
            if args.get("block"):
                anchor["block_id"] = str(args["block"])
            body = str(args.get("comment") or "").strip() or "Suggested edit"
            thread = await service.create_thread(ctx.db, actor, raw, actx, anchor=anchor, body=body,
                                                 via="mcp", suggestion=text)
            if not (thread.get("suggestion") or {}).get("text"):
                raise ToolError("The thread was started, but the suggestion couldn't be attached to it.")
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    out = {**await url_pair(ctx, raw), "slug": raw["slug"], "thread_id": thread["id"],
           "suggestion": thread.get("suggestion"), "thread_url": f"{(await url_pair(ctx, raw))['url']}#c-{thread['id']}"}
    return (f"Suggested replacing “{_excerpt(((thread.get('anchor') or {}).get('quote') or {}).get('exact'))}” with "
            f"“{_excerpt(text)}” on {out['url']} (thread {thread['id']}). Someone who can edit the page accepts it "
            "(accept_suggestion)."), out


async def accept_suggestion(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await _item(ctx, args["document"])
    tid = _thread_id(args["thread"])
    try:
        res = await suggestions.accept(ctx.db, actor_of(ctx), raw, _actx(ctx), tid,
                                       resolve=bool(args.get("resolve", True)))
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    urls = await url_pair(ctx, raw)
    out = {**urls, "slug": raw["slug"], "thread_id": tid, "applied": res["applied"], "offered": res["offered"],
           "holder": res["holder"], "version": int(res["version_id"]) if res.get("version_id") else None,
           "rev": res.get("rev")}
    if res["applied"]:
        v = f", saved as version {out['version']} in its history" if out["version"] else ""
        return f"Accepted: {urls['url']} now says it (revision {out['rev']}{v}); the thread is resolved.", out
    return (f"{res['holder']} is editing {urls['url']} right now, so the suggestion waits for them: it shows in "
            "their comments panel with Apply. Nothing was changed yet."), out


async def summarize_discussion(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await _item(ctx, args["document"])
    try:
        s = await ai.summarize(ctx.db, actor_of(ctx), raw, _actx(ctx), refresh=bool(args.get("refresh")))
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    urls = await url_pair(ctx, raw)
    out = {**urls, "slug": raw["slug"], "decided": s["decided"], "open": s["open"], "waiting": s["waiting"],
           "counts": s["counts"], "generated_at": s.get("generated_at")}
    if s.get("empty"):
        return f"There's no discussion on {urls['url']} yet (no open threads, none resolved in 30 days).", out

    def lines(rows: list[dict], person: bool = False) -> str:
        return "\n".join(f"- {(r['person'] + ': ') if person else ''}{r['text']} (threads: "
                         f"{', '.join(r['threads']) or '—'})" for r in rows) or "- (none)"

    text = (f"Discussion on {urls['url']} ({s['counts']['open']} open, {s['counts']['resolved']} resolved "
            f"recently):\nDecided:\n{lines(s['decided'])}\nStill open:\n{lines(s['open'])}\nWaiting on:\n"
            f"{lines(s['waiting'], True)}")
    return text, out


_LINE = {"type": "array", "items": {"type": "object"}}

REVIEW_TOOLS: list[Tool] = [
    Tool(
        name="suggest_edit",
        title="Suggest an edit in a comment",
        description=("Suggest replacement text for a passage of a page or Markdown document, as a comment "
                     "thread its editors can accept in one click (the page itself doesn't change until then). "
                     "Either on an existing thread anchored to text (thread), or a new thread on the exact text "
                     "to replace (quote, as it reads on the page; block: its block id when the same words "
                     "appear more than once), with an optional comment explaining why. Replaces your own open "
                     "suggestion on that thread."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF,
            "thread": _THREAD,
            "quote": {"type": "string", "minLength": 1, "maxLength": 1000,
                      "description": "The exact text to replace, for a new thread."},
            "block": {"type": "string", "maxLength": 40, "description": "Optional block id (b-…) of the quote."},
            "text": {"type": "string", "minLength": 1, "maxLength": 5000, "description": "The replacement text."},
            "comment": {"type": "string", "maxLength": 5000, "description": "Why (a new thread's first message)."},
        }, "required": ["document", "text"]},
        output_schema=_out({**_URL_PROPS, "slug": {"type": "string"}, "thread_id": {"type": "string"},
                            "thread_url": {"type": "string"}, "suggestion": {"type": ["object", "null"]}},
                           ["url", "slug", "thread_id", "suggestion"]),
        annotations=_ann(False, False, False),
        handler=suggest_edit,
    ),
    Tool(
        name="accept_suggestion",
        title="Accept a suggested edit",
        description=("Accept the open suggested edit on a comment thread (people who can edit the page): the "
                     "quoted text is replaced, saved as its own version in the page's history, and the thread is "
                     "resolved (resolve: false keeps it open). When someone has the page open in the editor it "
                     "waits for them instead (applied: false, offered: true). Fails when the text it replaces "
                     "has changed since (the suggestion is then marked stale). Confirm with the user first."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF, "thread": _THREAD,
            "resolve": {"type": "boolean", "default": True, "description": "Resolve the thread once applied."},
        }, "required": ["document", "thread"]},
        output_schema=_out({**_URL_PROPS, "slug": {"type": "string"}, "thread_id": {"type": "string"},
                            "applied": {"type": "boolean"}, "offered": {"type": "boolean"},
                            "holder": {"type": ["string", "null"]}, "version": {"type": ["integer", "null"]},
                            "rev": {"type": ["integer", "null"]}},
                           ["url", "slug", "thread_id", "applied", "offered"]),
        annotations=_ann(False, True, False),
        handler=accept_suggestion,
    ),
    Tool(
        name="summarize_discussion",
        title="Summarize a page's comments",
        description=("A short summary of the comment threads on a page or Markdown document (open ones and "
                     "those resolved in the last 30 days): what was decided, what is still open, and who the "
                     "discussion is waiting on, each with its thread ids. Uses AI within fair-use limits; the "
                     "same summary comes back until the discussion changes (refresh: true asks again)."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF,
            "refresh": {"type": "boolean", "default": False},
        }, "required": ["document"]},
        output_schema=_out({**_URL_PROPS, "slug": {"type": "string"}, "decided": _LINE, "open": _LINE,
                            "waiting": _LINE, "counts": {"type": "object"},
                            "generated_at": {"type": ["string", "null"]}},
                           ["url", "slug", "decided", "open", "waiting", "counts"]),
        annotations=_ann(True, False, True),
        handler=summarize_discussion,
    ),
]
