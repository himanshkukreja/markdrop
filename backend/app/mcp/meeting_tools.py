"""MCP tools for Meetings (services/meetings.py, services/meetings_ai.py).

* ``import_meeting``: a transcript (and/or Google's Gemini meeting notes) as text or a file's
  base64, into the workspace's Meetings folder; waits for the AI summary and returns the page.
* ``list_meetings`` / ``get_meeting``: the meetings of a workspace the user can open, and one of
  them (its page's Markdown, and the transcript when asked).
* ``ask_meetings``: a question about one meeting, or every meeting in a workspace the user can
  open; the answer cites transcript moments.
* ``meeting_context``: meeting memory for writing (services/meeting_memory.py): the decisions, action
  items, open questions and topics recorded in the workspace's meetings that relate to a topic or a
  page, with dates, meetings, links to the moment and a cited line ready to paste. No model call.
* ``meetings_connection``: whether meetings are imported automatically into a workspace ("Connect
  Google Meet", services/meetings_inbox.py): who connected it, when it last imported, how many.
  Read-only: never the token or the script (connecting is done on the website).
* ``check_meetings_now``: "Check for new meetings": the workspace's connected scripts (with Check now
  turned on) run now instead of at their next scheduled run; says what arrived.

``import_meeting`` dedupes like the Google Meet script's inbox: the same call (name, date, start
time) already in the workspace with that half is returned as a duplicate, and the other half of a
call that is already there is added to it.

Same rules as the website: members import, everything is decided on the meeting page with
``access.can`` (a meeting restricted to its attendees doesn't exist for anyone else), and the AI
counts towards the user's limits under "Meetings AI".
"""

from __future__ import annotations

import base64
import re
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
from app.services import meetings, meetings_ai, meetings_inbox, urls
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
        # The calendar invite (Gemini notes' "Invited"), joined or not; never the attendees.
        "invited": [a["name"] for a in m.get("invited") or []],
        "action_items": m.get("action_items"), "has_notes": m.get("has_notes"),
        "segments": m.get("segments"), "ai": m.get("ai"), "source": m.get("source"), "series": m.get("series"),
        # What it was about at a glance (the Meetings page's cards): a line of the summary and the counts.
        "summary": m.get("summary"), "decisions": m.get("decisions"), "open_questions": m.get("open_questions"),
    }


def _line(m: dict) -> str:
    bits = [m.get("date") or "", m.get("series") or m.get("type") or "", f"{m.get('action_items') or 0} action items"]
    if m.get("restricted"):
        bits.append("restricted to attendees")
    line = f"- {m.get('title')} ({', '.join(b for b in bits if b)}): {m['url']}  [id {m['id']}]"
    return f"{line}\n  {m['summary']}" if m.get("summary") else line


async def _ws(ctx: Context, value: str) -> str:
    ws_id, _ws_obj, _role = await resolve_workspace(ctx, value)
    return ws_id


async def _import_link(ctx: Context, ws_id: str, args: dict) -> tuple[str, dict]:
    from app.services import meeting_links

    try:
        got = await meeting_links.import_link(ctx.db, ctx.user, ws_id, str(args["drive_url"]),
                                              restricted=args.get("restricted"), via="mcp", wait=True)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    row = got.pop("row", None)
    if row is None:
        # queued (the user's Google Meet script fetches it) or needs_access: say what happens next.
        return got.get("message") or got["status"], {"meetings": [], "link": {k: got.get(k) for k in ("status", "file_id", "message")}}
    actor, actx = actor_of(ctx), _actx(ctx)
    raw = await meetings.readable(ctx.db, row, actor, actx)
    if raw is None:
        return "That Doc is already a meeting in this workspace, restricted to attendees the user isn't one of.", {"meetings": []}
    m = {**_meeting_out(await meetings.shape(ctx.db, row, raw, actor, actx)), "status": got["status"]}
    return f"1 meeting:\n{_line(m)} — {m['status']}\nAlways give the user the page url.", {"meetings": [m]}


async def import_meeting(ctx: Context, args: dict) -> tuple[str, dict]:
    ws_id = await _ws(ctx, args["workspace"])
    if args.get("drive_url"):
        if args.get("text") or args.get("notes_text") or args.get("content_base64"):
            raise ToolError("Pass drive_url on its own (not with text, notes_text or content_base64).")
        return await _import_link(ctx, ws_id, args)
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
                                              restricted=args.get("restricted"), wait=True, via="mcp",
                                              dedupe="all")
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    actor, actx = actor_of(ctx), _actx(ctx)
    out = []
    hidden = 0
    for row in rows:
        raw = await meetings.readable(ctx.db, row, actor, actx)
        if raw is not None:
            out.append({**_meeting_out(await meetings.shape(ctx.db, row, raw, actor, actx)),
                        "status": row.get("_status") or "imported"})
        else:
            hidden += 1
    said = {"imported": "imported", "attached": "added to the meeting that was already there",
            "duplicate": "already imported (nothing changed)"}
    lines = [f"{len(out)} meeting(s):", *(f"{_line(m)} — {said.get(m['status'], m['status'])}" for m in out)]
    if hidden:
        lines.append(f"{hidden} already in the workspace, restricted to attendees the user isn't one of.")
    for m in out:
        if m["status"] != "duplicate" and m["ai"]["state"] != "done":
            lines.append(f"{m['title']}: no AI summary ({m['ai'].get('message') or m['ai']['state']}).")
    lines.append("Always give the user the page url.")
    return "\n".join(lines), {"meetings": out}


async def list_meetings(ctx: Context, args: dict) -> tuple[str, dict]:
    ws_id = await _ws(ctx, args["workspace"])
    try:
        got = await meetings.list_meetings(ctx.db, ws_id, actor_of(ctx), _actx(ctx), limit=int(args.get("limit") or 50),
                                           q=args.get("query"), source=args.get("source"), since=args.get("since"),
                                           until=args.get("until"), series=args.get("series"))
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    out = [_meeting_out(m) for m in got["meetings"]]
    if not out:
        return "No meetings the user can open in that workspace yet (import one with import_meeting).", {"meetings": []}
    return "\n".join([f"{len(out)} meeting(s), newest first:", *(_line(m) for m in out)]), {"meetings": out}


async def meetings_connection(ctx: Context, args: dict) -> tuple[str, dict]:
    ws_id = await _ws(ctx, args["workspace"])
    try:
        await meetings.require_member(ctx.db, ws_id, ctx.user.id, write=False)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    conns = await meetings_inbox.for_workspace(ctx.db, ws_id)
    out = [{k: c[k] for k in ("connected_by", "created_at", "last_received_at", "last_imported_at", "imported",
                              "attached", "duplicates", "restricted", "last_error", "include_shared", "script",
                              "needs_update")} | {"mine": c["connected_by"]["id"] == ctx.user.id}
           for c in conns]
    if not out:
        return ("Automatic import isn't connected for this workspace. Anyone who can import meetings can "
                "connect it on the website: Meetings › Connect Google Meet. Meanwhile import_meeting imports "
                "a meeting by hand."), {"connected": False, "connections": []}
    lines = [f"Automatic import (Google Meet) is connected for this workspace by {len(out)} "
             f"{'person' if len(out) == 1 else 'people'}:"]
    for c in out:
        who = (c["connected_by"].get("name") or "Someone") + (" (the user)" if c["mine"] else "")
        last = c["last_imported_at"] or "nothing yet"
        lines.append(f"- {who}, since {c['created_at']}: {c['imported']} imported, {c['attached']} paired with an "
                     f"existing meeting; last import {last}" + (f"; last problem: {c['last_error']}" if c["last_error"] else ""))
        sc = c.get("script")
        if sc:
            skipped = ", ".join(f"{v} {k.replace('_', ' ')}" for k, v in (sc.get("skipped") or {}).items() if v)
            lines.append(f"  script last ran {sc.get('ran_at') or sc.get('started_at')}: found {sc.get('found')} meeting Docs, "
                         f"sent {sc.get('sent')}" + (f"; skipped {skipped}" if skipped else ""))
        if c.get("needs_update"):
            lines.append("  their script is out of date: Meetings › Connect Google Meet › Get the new script "
                         "(the new one also imports meetings shared with them)")
    return "\n".join(lines), {"connected": True, "connections": out}


async def check_meetings_now(ctx: Context, args: dict) -> tuple[str, dict]:
    ws_id = await _ws(ctx, args["workspace"])
    try:
        out = await meetings_inbox.check_now(ctx.db, ctx.user, ws_id)
    except HTTPException as exc:
        d = exc.detail
        raise ToolError(d.get("message") if isinstance(d, dict) else http_message(exc))
    lines = [out["message"]]
    for c in out["connections"]:
        who = c["connected_by"].get("name") or "Someone"
        lines.append(f"- {who}'s script: " + (f"found {c['found']} meeting Doc(s), sent {c['sent']}" if c["ok"] else c["message"]))
    if out["not_set_up"]:
        lines.append(f"{out['not_set_up']} other connected script(s) don't have Check now on; they send at their next run.")
    if out["imported"] or out["attached"]:
        lines.append("list_meetings shows them.")
    return "\n".join(lines), out


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
        gen = meetings_ai.ask_meetings(ctx.db, actor, actx, ws_id, args["question"], via="mcp",
                                       series=args.get("series"), since=args.get("since"), until=args.get("until"))
    else:
        raise ToolError("Pass meeting (one meeting) or workspace (every meeting there the user can open).")
    try:
        done = await meetings_ai.collect(gen)
    except pages_ai.AIError as exc:
        raise ToolError(exc.detail)
    cites = [{"label": c["label"], "text": c.get("text"), "url": urls.markdrop_url(c["href"].lstrip("/").split("#")[0])
              + ("#" + c["href"].split("#", 1)[1] if "#" in c["href"] else "")} for c in done.get("citations") or []]
    out = {"answer": done.get("answer") or "", "citations": cites,
           "meetings": [{"id": r["id"], "title": r.get("title"), "date": r.get("date"), "series": r.get("series"),
                         "url": urls.markdrop_url(r["slug"])} for r in done.get("ranked") or []],
           "scope": done.get("scope")}
    text = out["answer"]
    if done.get("scope"):
        text = f"(Meetings in {done['scope']['label']})\n" + text
    if cites:
        text += "\n\nSources:\n" + "\n".join(f"[{c['label']}] {c['text']} — {c['url']}" for c in cites)
    return text, out


async def meeting_context(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import meeting_memory

    actor, actx = actor_of(ctx), _actx(ctx)
    topic = (args.get("topic") or "").strip()
    title = heading = None
    exclude = None
    ws_id = None
    if args.get("page"):
        slug = str(args["page"]).strip().rstrip("/").rsplit("/", 1)[-1].split("#", 1)[0].split("?", 1)[0]
        raw = await ctx.db["documents"].find_one({"slug": slug})
        if raw is None or not (await access_service.can(actor, raw, "read", actx)).allowed:
            raise ToolError("Page not found (or the user can't open it).")
        if raw.get("encrypted"):
            raise ToolError("That page is encrypted: its text can't be read.")
        ws_id, title, exclude = raw.get("workspace_id"), raw.get("title"), raw.get("meeting_id")
        if not ws_id:
            raise ToolError("That page isn't in a workspace, so it has no meetings. Pass workspace and topic.")
        from app.services import page_props

        _l, body = page_props.split(raw.get("content") or "")
        heads = [m.group(1) for m in re.finditer(r"^#{1,3}\s+(.+?)\s*(?:\{#[^}]*\})?$", body, re.M)]
        heading = " ".join(heads[:12]) or None
    if args.get("workspace"):
        ws_id = await _ws(ctx, args["workspace"])
    if not ws_id:
        raise ToolError("Pass workspace (and topic), or page.")
    if not topic and not title:
        raise ToolError("Pass topic (what the document is about), or page.")
    try:
        await meetings.require_member(ctx.db, ws_id, ctx.user.id, write=False)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    kinds = [k for k in (args.get("kinds") or []) if k in meeting_memory.KINDS] or None
    got = await meeting_memory.related(ctx.db, actor, actx, ws_id, q=topic or None, title=title, heading=heading,
                                       kinds=kinds, limit=int(args.get("limit") or 15), exclude_meeting=exclude)
    facts = []
    for f in got["facts"]:
        m = f["meeting"]
        facts.append({"kind": f["kind"], "text": f["text"], "owner": f.get("owner"), "due": f.get("due"),
                      "status": f.get("status"), "date": m.get("date"),
                      "meeting": {"id": m["id"], "title": m.get("title"), "series": m.get("series"), "url": m.get("url")},
                      "moment_url": (f.get("moment") or {}).get("url"), "moment": (f.get("moment") or {}).get("label"),
                      "markdown": f["markdown"], "cite": f["cite"]})
    if not facts:
        msg = ("No meetings the user can open in that workspace yet." if not got["meetings"] else
               "Nothing recorded in the user's meetings matches that. Try other words (a feature's name, a customer…).")
        return msg, {"facts": [], "meetings": got["meetings"]}
    names = {"decision": "Decision", "action_item": "Action item", "open_question": "Open question", "topic": "Discussed"}
    lines = [f"{len(facts)} related item(s) from {got['meetings']} meeting(s) the user can open, best first:"]
    for f in facts:
        extra = ", ".join(x for x in (f.get("owner"), f"due {f['due']}" if f.get("due") else None, f.get("status")) if x)
        where = f["meeting"].get("series") or f["meeting"].get("title")
        lines.append(f"- {names.get(f['kind'], f['kind'])} ({f['date']}, {where}){f' [{extra}]' if extra else ''}: "
                     f"{f['text']} — {f['moment_url'] or f['meeting']['url']}")
    lines.append("\nTo cite one in a page, paste its `markdown` (a dated line with a mention of the meeting).")
    return "\n".join(lines), {"facts": facts, "meetings": got["meetings"]}


_MEETING_OUT = {"type": "object", "properties": {
    "id": {"type": "string"}, "title": _NULLABLE_STR, "date": _NULLABLE_STR, "type": _NULLABLE_STR,
    "url": {"type": "string"}, "slug": {"type": "string"}, "transcript_url": _NULLABLE_STR,
    "attendees": {"type": "array", "items": {"type": "string"}, "description": "Who joined the call."},
    "invited": {"type": "array", "items": {"type": "string"}, "description": "Everyone on the calendar invite, joined or not."},
    "restricted": {"type": "boolean"},
    "action_items": {"type": "integer"}, "has_notes": {"type": "boolean"}, "segments": {"type": "integer"},
    "ai": {"type": "object"}, "source": {"type": "string", "enum": list(meetings.SOURCES)},
    "series": _NULLABLE_STR,
}}
_MEETING_REF = {"type": "string", "minLength": 1, "maxLength": 300,
                "description": "A meeting's id (from list_meetings), or its page's slug or link."}

MEETING_TOOLS: list[Tool] = [
    Tool(
        name="import_meeting",
        title="Import a meeting",
        description=("Turn a meeting into a Markdrop page in the workspace's Meetings folder (made on first use): "
                     "an AI summary, decisions, action items (@mentions of workspace members, as links: meeting imports notify nobody), open "
                     "questions, topics and the transcript as a sub-page whose lines answers cite. Give the "
                     "transcript as text (Google Meet's transcript Doc, Zoom/Teams captions, 'Name: words' "
                     "lines…), or a file as file_name + content_base64 (.txt .vtt .srt .sbv .docx), and/or "
                     "Google Meet's Gemini notes (Summary / Details / Suggested next steps) as notes_text: "
                     "Google's notes are used as written and the AI only fills the gaps. Everything the AI "
                     "writes is in English. It's filed in Meetings/<series> for a recurring call (a name seen on 2+ "
                     "days), else Meetings/Other meetings. Visibility: a 1:1 or two-person call is restricted to its "
                     "attendees, 3+ people the workspace's team; restricted=true/false decides it yourself. No duplicates: a call already in the workspace (same name, "
                     "date and start time) is returned with status 'duplicate', and Google's notes for a call whose "
                     "transcript is already there (or the other way round) are added to it (status 'attached'). "
                     "Waits for the summary (a few seconds); counts towards the "
                     "user's 'Meetings AI' limit. Or pass drive_url, a Google Docs/Drive link: Markdrop reads a Doc "
                     "shared with 'anyone with the link' itself; otherwise, when the user's Google Meet script is "
                     "connected to this workspace, it is queued for that script (status 'queued', imported within "
                     "15 minutes), else the answer says how to give access. Always give the user the returned url."),
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
            "restricted": {"type": "boolean", "description": "Optional: true = only attendees who are members, false = the team. Left out: decided by the number of attendees."},
            "drive_url": {"type": "string", "maxLength": 2000,
                          "description": "A Google Docs or Drive link to the transcript or Gemini notes (docs.google.com/document/d/…, drive.google.com/file/d/…)."},
        }, "required": ["workspace"]},
        output_schema=_out({"meetings": {"type": "array", "items": {**_MEETING_OUT, "properties": {
            **_MEETING_OUT["properties"], "status": {"type": "string", "enum": ["imported", "attached", "duplicate"]}}}},
            "link": {"type": "object", "properties": {"status": {"type": "string", "enum": ["queued", "needs_access"]},
                                                      "file_id": {"type": "string"}, "message": {"type": "string"}}}}),
        annotations=_ann(False, False, False),
        handler=import_meeting,
    ),
    Tool(
        name="list_meetings",
        title="List meetings",
        description=("The meetings of a workspace the user can open, newest first (title, date, series, type, attendees, "
                     "action items, link, and source: manual, auto or mcp). Filter by series (a recurring meeting such as "
                     "'Daily Standup'; 'none' for one-offs), a date range (since / until) and source."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "workspace": _WORKSPACE_ARG,
            "query": {"type": "string", "maxLength": 100, "description": "Optional: only titles containing this."},
            "source": {"type": "string", "enum": list(meetings.SOURCES),
                       "description": "Optional: only meetings imported by hand on the website (manual), by the Google Meet script (auto) or over MCP (mcp)."},
            "since": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$", "description": "Optional: only meetings on or after this date (YYYY-MM-DD)."},
            "until": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$", "description": "Optional: only meetings on or before this date (YYYY-MM-DD)."},
            "series": {"type": "string", "maxLength": 60, "description": "Optional: only this series (any case), or 'none'."},
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
                     "(workspace). Claude Haiku answers in English from the meetings only, says when and in which "
                     "meeting each point was made, and cites the moments ([s12] a transcript line, [M2-s14] a line of "
                     "the 2nd meeting, [M2] its page); citations carry links. Across meetings, scope it with series "
                     "and/or since/until (otherwise a series or period named in the question is used, e.g. 'in Daily "
                     "Standups last month'); questions about the latest state prefer recent meetings. It knows who "
                     "is asking (the signed-in user and the names they appear under in transcripts), so 'what did I "
                     "say in the last standup' quotes the user's own lines, or says they attended but didn't speak. "
                     "Counts towards the user's 'Meetings AI' limit."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "question": {"type": "string", "minLength": 1, "maxLength": meetings_ai.MAX_QUESTION},
            "meeting": _MEETING_REF,
            "workspace": _WORKSPACE_ARG,
            "series": {"type": "string", "maxLength": 60, "description": "Across meetings: only this series."},
            "since": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$", "description": "Across meetings: on or after this date."},
            "until": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$", "description": "Across meetings: on or before this date."},
        }, "required": ["question"]},
        output_schema=_out({"answer": {"type": "string"}, "citations": {"type": "array"}, "meetings": {"type": "array"},
                            "scope": {"type": ["object", "null"]}}),
        annotations=_ann(True, False, False),
        handler=ask_meetings,
    ),
    Tool(
        name="meeting_context",
        title="Meeting memory for a document",
        description=("What the team decided and discussed in meetings about a topic, for writing a PRD, spec or "
                     "feature document: decisions, action items (owner, due, open/done), open questions and "
                     "topics recorded in the workspace's meetings the user can open, best match first, each with "
                     "its date, meeting (and series), a link to the moment in the transcript and `markdown`, a "
                     "dated, cited line ready to paste into a page (\"Decided on Oct 28, 2026 (Daily Standup): "
                     "…\"). Give topic (a feature, a customer, a question) and workspace, or page (a page's slug "
                     "or link: its title and headings are the topic). Search only, no AI call; meetings "
                     "restricted to their attendees count only for them. Cite what you use."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "topic": {"type": "string", "maxLength": 200, "description": "What the document is about, e.g. 'checkout redesign' or 'SSO for Senseloaf'."},
            "workspace": _WORKSPACE_ARG,
            "page": {"type": "string", "maxLength": 300, "description": "Optional: the page being written (slug or link); its title and headings are used."},
            "kinds": {"type": "array", "items": {"type": "string", "enum": ["decision", "action_item", "open_question", "topic"]},
                      "description": "Optional: only these kinds."},
            "limit": {"type": "integer", "minimum": 1, "maximum": 40, "default": 15},
        }},
        output_schema=_out({"facts": {"type": "array", "items": {"type": "object"}}, "meetings": {"type": "integer"}}),
        annotations=_ann(True, False, True),
        handler=meeting_context,
    ),
    Tool(
        name="meetings_connection",
        title="Automatic meeting import",
        description=("Whether meetings are imported automatically into a workspace (Connect Google Meet: a Google "
                     "Apps Script in a member's Google account sends their Meet transcripts and Gemini notes): who "
                     "connected it, since when, how many meetings it imported and when it last did. Read-only; "
                     "connecting and disconnecting are done on the website (Meetings › Connect Google Meet)."),
        scope=READ,
        input_schema={"type": "object", "properties": {"workspace": _WORKSPACE_ARG}, "required": ["workspace"]},
        output_schema=_out({"connected": {"type": "boolean"}, "connections": {"type": "array", "items": {"type": "object"}}}),
        annotations=_ann(True, False, True),
        handler=meetings_connection,
    ),
    Tool(
        name="check_meetings_now",
        title="Check for new meetings now",
        description=("Check for new meetings in a workspace now (\"Check for new meetings\" on the Meetings page): the "
                     "Google Meet scripts connected to it run right away instead of at their next scheduled run, "
                     "and the transcripts and Gemini notes Google has finished arrive as meeting pages. Takes up to "
                     "about 50 seconds. Members only; once a minute per workspace. Works when whoever connected "
                     "Google Meet turned Check now on (Meetings › Turn on Check now); otherwise says so."),
        scope=WRITE,
        input_schema={"type": "object", "properties": {"workspace": _WORKSPACE_ARG}, "required": ["workspace"]},
        output_schema=_out({"ok": {"type": "boolean"}, "message": {"type": "string"}, "imported": {"type": "integer"},
                            "attached": {"type": "integer"}, "checked": {"type": "integer"},
                            "connections": {"type": "array", "items": {"type": "object"}}}),
        annotations=_ann(False, False, False),
        handler=check_meetings_now,
    ),
]
