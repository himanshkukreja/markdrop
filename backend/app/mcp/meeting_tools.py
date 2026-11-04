"""MCP tools for Meetings (services/meetings.py, services/meetings_ai.py).

* ``import_meeting``: a transcript (and/or Google's Gemini meeting notes) as text or a file's
  base64, into the workspace's Meetings folder; waits for the AI summary and returns the page.
* ``list_meetings`` / ``get_meeting``: the meetings of a workspace the user can open, and one of
  them (its page's Markdown, and the transcript when asked).
* ``ask_meetings``: a question about one meeting, or every meeting in a workspace the user can
  open; the answer cites transcript moments.

Same rules as the website: members import, everything is decided on the meeting page with
``access.can`` (a meeting restricted to its attendees doesn't exist for anyone else), and the AI
counts towards the user's limits under "Meetings AI".
"""

from __future__ import annotations

import base64
from typing import Any

from fastapi import HTTPException

from app.mcp.auth import READ, WRITE
from app.mcp.tools import (
    _NULLABLE_STR,
    _WORKSPACE_ARG,
    Context,
    Tool,
    ToolError,
    _ann,
    _out,
    actor_of,
    http_message,
    resolve_workspace,
)
from app.services import access as access_service
from app.services import meetings, meetings_ai, urls
from app.services import meeting_parse as mp

MAX_TRANSCRIPT_RETURN = 400


def _actx(ctx: Context) -> access_service.Ctx:
    return access_service.Ctx(ctx.db, surface="mcp")


def _meeting_out(m: dict) -> dict[str, Any]:
    return {
        "id": m["id"], "title": m.get("title"), "date": m.get("date"), "type": m.get("type"),
        "url": urls.markdrop_url(m["slug"]), "slug": m["slug"],
        "transcript_url": urls.markdrop_url(m["transcript_slug"]) if m.get("transcript_slug") else None,
        "attendees": [a["name"] for a in m.get("attendees") or []], "restricted": m.get("restricted"),
        "action_items": m.get("action_items"), "has_notes": m.get("has_notes"),
        "segments": m.get("segments"), "ai": m.get("ai"),
    }


def _line(m: dict) -> str:
    bits = [m.get("date") or "", m.get("type") or "", f"{m.get('action_items') or 0} action items"]
    if m.get("restricted"):
        bits.append("restricted to attendees")
    return f"- {m.get('title')} ({', '.join(b for b in bits if b)}): {m['url']}  [id {m['id']}]"


async def _ws(ctx: Context, value: str) -> str:
    ws_id, _ws_obj, _role = await resolve_workspace(ctx, value)
    return ws_id


async def import_meeting(ctx: Context, args: dict) -> tuple[str, dict]:
    ws_id = await _ws(ctx, args["workspace"])
    incoming: list[meetings.Incoming] = []
    try:
        if args.get("content_base64"):
            incoming.append(meetings.incoming_from({"name": args.get("file_name") or "Meeting",
                                                    "data_b64": args["content_base64"]}, "mcp"))
        if args.get("text"):
            incoming.append(meetings.incoming_from({"name": args.get("file_name") or args.get("title") or "Transcript",
                                                    "text": args["text"]}, "mcp"))
        if args.get("notes_text"):
            incoming.append(meetings.incoming_from({"name": "Google Meet notes", "text": args["notes_text"]}, "mcp"))
    except ValueError as exc:
        raise ToolError(str(exc))
    if not incoming:
        raise ToolError("Pass text (the transcript), notes_text (Google's meeting notes), or file_name with "
                        "content_base64 (.txt, .vtt, .srt, .sbv, .docx).")
    try:
        rows = await meetings.import_meetings(ctx.db, ctx.user, ws_id, incoming, title=args.get("title"),
                                              date_=args.get("date"), type_=args.get("type"),
                                              restricted=bool(args.get("restricted")), wait=True, via="mcp")
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    actor, actx = actor_of(ctx), _actx(ctx)
    out = []
    for row in rows:
        raw = await meetings.page_of(ctx.db, row)
        if raw is not None:
            out.append(_meeting_out(await meetings.shape(ctx.db, row, raw, actor, actx)))
    lines = [f"Imported {len(out)} meeting(s):", *(_line(m) for m in out)]
    for m in out:
        if m["ai"]["state"] != "done":
            lines.append(f"{m['title']}: no AI summary ({m['ai'].get('message') or m['ai']['state']}).")
    lines.append("Always give the user the page url.")
    return "\n".join(lines), {"meetings": out}


async def list_meetings(ctx: Context, args: dict) -> tuple[str, dict]:
    ws_id = await _ws(ctx, args["workspace"])
    try:
        got = await meetings.list_meetings(ctx.db, ws_id, actor_of(ctx), _actx(ctx), limit=int(args.get("limit") or 50),
                                           q=args.get("query"))
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    out = [_meeting_out(m) for m in got["meetings"]]
    if not out:
        return "No meetings the user can open in that workspace yet (import one with import_meeting).", {"meetings": []}
    return "\n".join([f"{len(out)} meeting(s), newest first:", *(_line(m) for m in out)]), {"meetings": out}


async def _row(ctx: Context, ref: str) -> tuple[dict, dict]:
    ref = (ref or "").strip()
    row = await meetings.get_row(ctx.db, ref)
    if row is None:
        # A meeting page's (or its transcript's) slug or link.
        slug = ref.rstrip("/").rsplit("/", 1)[-1].split("#", 1)[0].split("?", 1)[0]
        doc = await ctx.db["documents"].find_one({"slug": slug}, {"meeting_id": 1})
        if doc and doc.get("meeting_id"):
            row = await meetings.get_row(ctx.db, doc["meeting_id"])
    raw = await meetings.readable(ctx.db, row, actor_of(ctx), _actx(ctx))
    if row is None or raw is None:
        raise ToolError("Meeting not found (or the user can't open it). See list_meetings.")
    return row, raw


async def get_meeting(ctx: Context, args: dict) -> tuple[str, dict]:
    row, raw = await _row(ctx, args["meeting"])
    actor, actx = actor_of(ctx), _actx(ctx)
    m = _meeting_out(await meetings.shape(ctx.db, row, raw, actor, actx))
    from app.services import pages

    md = await pages.content_for(actor, raw, actx) or ""
    out: dict[str, Any] = {**m, "markdown": md, "transcript": None, "transcript_total": len(row.get("segments") or [])}
    if args.get("transcript"):
        traw = await ctx.db["documents"].find_one({"_id": meetings.oid(row.get("transcript_doc_id"))}) if row.get("transcript_doc_id") else None
        if traw is not None and (await access_service.can(actor, traw, "read", actx)).allowed:
            start = max(1, int(args.get("from_segment") or 1))
            segs = (row.get("segments") or [])[start - 1:start - 1 + MAX_TRANSCRIPT_RETURN]
            out["transcript"] = [{"n": start + i, "speaker": s.get("speaker"), "time": mp.clock(s.get("t")) if s.get("t") is not None else None,
                                  "text": s.get("text"), "url": urls.markdrop_url(row["transcript_slug"]) + f"#{meetings.anchor(start + i)}"}
                                 for i, s in enumerate(segs)]
    text = f"{m['title']} ({m['date']}): {m['url']}\n\n{md}"
    if out["transcript"]:
        text += "\n\nTranscript:\n" + "\n".join(f"[{t['n']}] {t['time'] or ''} {t['speaker'] or ''}: {t['text']}" for t in out["transcript"])
        if out["transcript_total"] > out["transcript"][-1]["n"]:
            text += f"\n… {out['transcript_total'] - out['transcript'][-1]['n']} more (from_segment={out['transcript'][-1]['n'] + 1})."
    return text, out


async def ask_meetings(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import pages_ai

    actor, actx = actor_of(ctx), _actx(ctx)
    if args.get("meeting"):
        row, _raw = await _row(ctx, args["meeting"])
        gen = meetings_ai.ask_meeting(ctx.db, actor, actx, str(row["_id"]), args["question"], via="mcp")
    elif args.get("workspace"):
        ws_id = await _ws(ctx, args["workspace"])
        gen = meetings_ai.ask_meetings(ctx.db, actor, actx, ws_id, args["question"], via="mcp")
    else:
        raise ToolError("Pass meeting (one meeting) or workspace (every meeting there the user can open).")
    try:
        done = await meetings_ai.collect(gen)
    except pages_ai.AIError as exc:
        raise ToolError(exc.detail)
    cites = [{"label": c["label"], "text": c.get("text"), "url": urls.markdrop_url(c["href"].lstrip("/").split("#")[0])
              + ("#" + c["href"].split("#", 1)[1] if "#" in c["href"] else "")} for c in done.get("citations") or []]
    out = {"answer": done.get("answer") or "", "citations": cites,
           "meetings": [{"id": r["id"], "title": r.get("title"), "date": r.get("date"), "url": urls.markdrop_url(r["slug"])}
                        for r in done.get("ranked") or []]}
    text = out["answer"]
    if cites:
        text += "\n\nSources:\n" + "\n".join(f"[{c['label']}] {c['text']} — {c['url']}" for c in cites)
    return text, out


_MEETING_OUT = {"type": "object", "properties": {
    "id": {"type": "string"}, "title": _NULLABLE_STR, "date": _NULLABLE_STR, "type": _NULLABLE_STR,
    "url": {"type": "string"}, "slug": {"type": "string"}, "transcript_url": _NULLABLE_STR,
    "attendees": {"type": "array", "items": {"type": "string"}}, "restricted": {"type": "boolean"},
    "action_items": {"type": "integer"}, "has_notes": {"type": "boolean"}, "segments": {"type": "integer"},
    "ai": {"type": "object"},
}}
_MEETING_REF = {"type": "string", "minLength": 1, "maxLength": 300,
                "description": "A meeting's id (from list_meetings), or its page's slug or link."}

MEETING_TOOLS: list[Tool] = [
    Tool(
        name="import_meeting",
        title="Import a meeting",
        description=("Turn a meeting into a Markdrop page in the workspace's Meetings folder (made on first use): "
                     "an AI summary, decisions, action items (@mentions that notify workspace members), open "
                     "questions, topics and the transcript as a sub-page whose lines answers cite. Give the "
                     "transcript as text (Google Meet's transcript Doc, Zoom/Teams captions, 'Name: words' "
                     "lines…), or a file as file_name + content_base64 (.txt .vtt .srt .sbv .docx), and/or "
                     "Google Meet's Gemini notes (Summary / Details / Suggested next steps) as notes_text: "
                     "Google's notes are used as written and the AI only fills the gaps. Everything the AI "
                     "writes is in English. Default visibility: the workspace's team; restricted=true limits it "
                     "to attendees who are members. Waits for the summary (a few seconds); counts towards the "
                     "user's 'Meetings AI' limit. Always give the user the returned url."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "workspace": _WORKSPACE_ARG,
            "text": {"type": "string", "maxLength": meetings.MAX_PASTE_CHARS, "description": "The transcript as text."},
            "notes_text": {"type": "string", "maxLength": 200_000, "description": "Google Meet's Gemini notes as text."},
            "file_name": {"type": "string", "maxLength": 200, "description": "The file's name, with its extension."},
            "content_base64": {"type": "string", "description": "The file's bytes, base64 (at most 4 MB)."},
            "title": {"type": "string", "maxLength": 150, "description": "Optional: the meeting's name."},
            "date": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$", "description": "Optional: YYYY-MM-DD."},
            "type": {"type": "string", "enum": list(meetings.TYPES)},
            "restricted": {"type": "boolean", "default": False},
        }, "required": ["workspace"]},
        output_schema=_out({"meetings": {"type": "array", "items": _MEETING_OUT}}),
        annotations=_ann(False, False, False),
        handler=import_meeting,
    ),
    Tool(
        name="list_meetings",
        title="List meetings",
        description="The meetings of a workspace the user can open, newest first (title, date, type, attendees, action items, link).",
        scope=READ,
        input_schema={"type": "object", "properties": {
            "workspace": _WORKSPACE_ARG,
            "query": {"type": "string", "maxLength": 100, "description": "Optional: only titles containing this."},
            "limit": {"type": "integer", "minimum": 1, "maximum": 300, "default": 50},
        }, "required": ["workspace"]},
        output_schema=_out({"meetings": {"type": "array", "items": _MEETING_OUT}}),
        annotations=_ann(True, False, True),
        handler=list_meetings,
    ),
    Tool(
        name="get_meeting",
        title="Read a meeting",
        description=("One meeting: its page's Markdown (summary, decisions, action items…) and, with transcript=true, "
                     f"its transcript lines ({MAX_TRANSCRIPT_RETURN} at a time from from_segment), each with a link to that moment."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "meeting": _MEETING_REF,
            "transcript": {"type": "boolean", "default": False},
            "from_segment": {"type": "integer", "minimum": 1, "default": 1},
        }, "required": ["meeting"]},
        output_schema=_out({**_MEETING_OUT["properties"], "markdown": {"type": "string"},
                            "transcript": {"type": ["array", "null"]}, "transcript_total": {"type": "integer"}},
                           ["id", "url", "markdown"]),
        annotations=_ann(True, False, True),
        handler=get_meeting,
    ),
    Tool(
        name="ask_meetings",
        title="Ask meetings",
        description=("Ask a question about one meeting (meeting) or every meeting in a workspace the user can open "
                     "(workspace). Claude Haiku answers in English from the meetings only and cites the moments "
                     "([s12] a transcript line, [M2-s14] a line of the 2nd meeting, [M2] its page); citations "
                     "carry links. Counts towards the user's 'Meetings AI' limit."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "question": {"type": "string", "minLength": 1, "maxLength": meetings_ai.MAX_QUESTION},
            "meeting": _MEETING_REF,
            "workspace": _WORKSPACE_ARG,
        }, "required": ["question"]},
        output_schema=_out({"answer": {"type": "string"}, "citations": {"type": "array"}, "meetings": {"type": "array"}}),
        annotations=_ann(True, False, False),
        handler=ask_meetings,
    ),
]
