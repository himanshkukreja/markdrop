"""MCP: import many past meetings at once (services/meeting_backfill.py).

``import_meetings_bulk`` takes several transcripts / Gemini notes (text or a file's base64), each
with an optional date, title and series, and reviews them like the website's "Import past
meetings": dates from the names or the text, the notes and the transcript of one call paired,
series detected, duplicates of meetings already in the workspace skipped. ``dry_run`` returns only
the review. Otherwise what is ready imports in the background, oldest first, notifying nobody about
their @mentions (no meeting import does; ``notify`` lets meetings from the last day be posted to the
Slack meetings channel); call again with ``job`` to see how far it got.
"""

from __future__ import annotations

import base64
from typing import Any

from fastapi import HTTPException

from app.mcp.auth import WRITE
from app.mcp.tools import _WORKSPACE_ARG, Context, Tool, ToolError, _ann, _out, http_message, resolve_workspace
from app.services import meeting_backfill as bf
from app.services import meetings, urls

MAX_ITEMS = 25

_STATUS = {
    "duplicate": "already in the workspace (skipped)",
    "attach": "adds the missing half (notes or transcript) to a meeting already there",
    "needs_date": "no date found: pass date for it (YYYY-MM-DD)",
    "queued": "queued",
    "skipped": "left out",
}


def _item_status(row: dict, started: bool) -> str:
    if row["dup"]["status"] == "duplicate":
        return "duplicate"
    if not row.get("date"):
        return "needs_date"
    if not row.get("include"):
        return "skipped"
    if started and row["state"] not in ("pending", "importing"):
        return row["state"]
    return "attach" if row["dup"]["status"] == "attach" else "queued"


def _rows_out(v: dict, started: bool) -> list[dict[str, Any]]:
    out = []
    for r in v["rows"]:
        out.append({"title": r["title"], "date": r["date"], "series": r["series"], "files": r["names"],
                    "kinds": r["kinds"], "status": _item_status(r, started), "state": r["state"],
                    "error": r.get("error"), "meeting_id": r.get("meeting_id"),
                    "url": urls.markdrop_url(r["slug"]) if r.get("slug") else None,
                    "existing_meeting_id": r["dup"].get("meeting_id")})
    return out


def _summary(v: dict, rows: list[dict]) -> str:
    c = v["counts"]
    lines = [f"Import {v['id']} ({v['state']}): {c['included']} to import, {c['duplicate']} already here, "
             f"{c['done']} of {c['included']} done ({c['imported']} imported, {c['attached']} paired with an existing "
             f"meeting, {c['failed']} failed)."]
    if v.get("wait"):
        lines.append(f"Waiting: {v['wait'].get('message') or v['wait'].get('reason')} (until {v['wait'].get('until')}).")
    est = v.get("estimate")
    if est and est.get("meetings"):
        lines.append(f"AI summaries for what's left: {est['meetings']} meeting{'' if est['meetings'] == 1 else 's'}" +
                     (" — more than AI can write today, so the rest will be summarized tomorrow."
                      if est.get("may_wait") else ", within today's fair-use limit."))
    for r in rows:
        when = r["date"] or "no date"
        extra = f" · {r['series']}" if r["series"] else ""
        link = f" {r['url']}" if r.get("url") else ""
        err = f" ({r['error']})" if r.get("error") else ""
        lines.append(f"- {when} {r['title'] or '(no title)'}{extra}: {_STATUS.get(r['status'], r['status'])}{err}{link}")
    return "\n".join(lines)


async def import_meetings_bulk(ctx: Context, args: dict) -> tuple[str, dict]:
    if args.get("job"):
        try:
            job = await bf.get_job(ctx.db, str(args["job"]), ctx.user.id)
        except HTTPException as exc:
            raise ToolError(http_message(exc))
        job = await bf.wake(ctx.db, job)
        v = await bf.view(ctx.db, job)
        rows = _rows_out(v, True)
        return _summary(v, rows), {"job": v["id"], "state": v["state"], "counts": v["counts"], "items": rows}
    if not args.get("workspace"):
        raise ToolError("Pass workspace (and items), or job to see an import's progress.")
    ws_id, _w, _r = await resolve_workspace(ctx, args["workspace"])
    items = args.get("items") or []
    if not items:
        raise ToolError("Pass items: [{text | file_name + content_base64, notes_text?, date?, title?, series?}].")
    if len(items) > MAX_ITEMS:
        raise ToolError(f"At most {MAX_ITEMS} items per call: call again for the rest.")
    try:
        job, _made = await bf.create_job(ctx.db, ctx.user, ws_id, quiet=not args.get("notify"), origin="mcp")
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    sources: list[dict] = []
    wanted: list[dict] = []          # per item: what the caller said about it
    try:
        for n, it in enumerate(items):
            given = {k: it.get(k) for k in ("title", "date", "series") if it.get(k) is not None}
            if it.get("content_base64"):
                inc = meetings.incoming_from({"name": it.get("file_name") or f"Meeting {n + 1}",
                                              "data_b64": it["content_base64"]}, "mcp")
                sources.append({"name": inc.name, "text": inc.text, "origin": "mcp", "_item": n})
            if it.get("text"):
                sources.append({"name": it.get("file_name") or it.get("title") or f"Transcript {n + 1}",
                                "text": str(it["text"]), "origin": "mcp", "_item": n})
            if it.get("notes_text"):
                sources.append({"name": (it.get("title") or f"Meeting {n + 1}") + " - Notes by Gemini",
                                "text": str(it["notes_text"]), "origin": "mcp", "_item": n})
            wanted.append(given)
    except ValueError as exc:
        await bf.discard(ctx.db, job)
        raise ToolError(str(exc))
    if not sources:
        await bf.discard(ctx.db, job)
        raise ToolError("Each item needs text, notes_text, or file_name with content_base64.")
    try:
        job = await bf.add_sources(ctx.db, job, [{k: v for k, v in s.items() if k != "_item"} for s in sources])
        # The caller's dates, titles and series win over what was detected.
        by_name: dict[str, int] = {s["name"]: s["_item"] for s in sources}
        edits = []
        for r in job["rows"]:
            n = next((by_name[x] for x in r["names"] if x in by_name), None)
            if n is None or not wanted[n]:
                continue
            edits.append({"id": r["id"], **wanted[n]})
        if edits:
            job = await bf.edit(ctx.db, job, rows=edits)
        if args.get("dry_run"):
            v = await bf.view(ctx.db, job)
            rows = _rows_out(v, False)
            await bf.discard(ctx.db, job)
            text = _summary(v, rows).replace(f"Import {v['id']} (draft)", "Review (nothing imported: dry_run)")
            return text, {"job": None, "state": "review", "counts": v["counts"], "items": rows}
        ready = [r for r in job["rows"] if r["include"] and r["date"]]
        undated = [{"id": r["id"], "include": False} for r in job["rows"] if r["include"] and not r["date"]]
        if not ready:
            v = await bf.view(ctx.db, job)
            rows = _rows_out(v, False)
            await bf.discard(ctx.db, job)
            return ("Nothing imported.\n" + _summary(v, rows).split("\n", 1)[-1],
                    {"job": None, "state": "nothing", "counts": v["counts"], "items": rows})
        if undated:
            # Started without them (they come back as needs_date): the caller can send them again with a date.
            job = await bf.edit(ctx.db, job, rows=undated)
        job = await bf.start(ctx.db, job)
    except HTTPException as exc:
        left = await ctx.db[bf.JOBS].find_one({"_id": job["_id"]})
        if left is not None and left["state"] == "draft":
            await bf.discard(ctx.db, left)
        raise ToolError(http_message(exc))
    v = await bf.view(ctx.db, job)
    rows = _rows_out(v, False)
    text = (_summary(v, rows) + "\nThe meetings import in the background, oldest first. Call import_meetings_bulk "
            f"with job=\"{v['id']}\" to see progress.")
    return text, {"job": v["id"], "state": v["state"], "counts": v["counts"], "items": rows}


ORGANIZE_WAIT_S = 50.0


async def organize_meetings(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import meeting_organize as mo

    ws_id, _w, _r = await resolve_workspace(ctx, args["workspace"])
    try:
        job = await mo.start(ctx.db, ws_id, ctx.user)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    job = await mo.wait(ctx.db, ws_id, job["run"], ORGANIZE_WAIT_S) or job
    v = mo.view(job)
    if v["state"] == "running":
        text = (f"Organizing meetings in the background: {v['done']} of {v['total']} done so far "
                f"({v['filed']} moved, {v['series_set']} put in a series). Call organize_meetings again with the same "
                f"workspace to check on it (it joins this run, job {v['id']}, rather than starting another).")
    elif v["state"] == "failed":
        raise ToolError(v.get("message") or "Organizing the meetings stopped. Try again.")
    else:
        text = (f"Organized {v['total']} meetings: {v['filed']} moved, {v['series_set']} put in a series, "
                f"{v['folders']} folders in use (Meetings/<series>, Meetings/Other meetings), {v['series']} series, "
                f"{v['covers']} covers set.")
        if v["errors"]:
            text += f" {v['errors']} couldn't be organized: " + "; ".join(
                f"{e['title']} ({e['error']})" for e in v["error_samples"])
    return text, v


_ITEM = {"type": "object", "properties": {
    "text": {"type": "string", "maxLength": meetings.MAX_PASTE_CHARS, "description": "A transcript (or Google's notes) as text."},
    "notes_text": {"type": "string", "maxLength": 200_000, "description": "Google Meet's Gemini notes for the same call."},
    "file_name": {"type": "string", "maxLength": 200, "description": "The file's name (Google's names carry the date: 'Daily Standup – 2026/10/28 10:00 IST – Transcript')."},
    "content_base64": {"type": "string", "description": "A file's bytes, base64 (.txt .vtt .srt .sbv .docx .md, at most 4 MB)."},
    "date": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$", "description": "The meeting's date, when the name and text don't say it."},
    "title": {"type": "string", "maxLength": 150},
    "series": {"type": "string", "maxLength": 60, "description": "The recurring meeting it belongs to (e.g. 'Daily Standup'); detected when left out."},
}}

BACKFILL_TOOLS: list[Tool] = [
    Tool(
        name="import_meetings_bulk",
        title="Import past meetings",
        description=("Import many past meetings at once into a workspace's Meetings folder (the website's 'Import past "
                     "meetings'): up to 25 transcripts or Gemini notes per call, as text or files. Each gets its real "
                     "date (from Google's file name, else the text; or pass date), Google's notes and the transcript of "
                     "one call are paired into one meeting, recurring meetings get a series ('Daily Standup'), and "
                     "meetings already in the workspace are skipped (status 'duplicate'). Items without a date come back "
                     "as 'needs_date' and aren't imported. dry_run=true only reviews. Otherwise the rest imports in the "
                     "background, oldest first, with AI summaries (AI has fair-use limits; a big backlog may wait "
                     "until tomorrow). Nobody is notified about their @mentions (no meeting import notifies); "
                     "notify=true lets meetings from the last day be posted to the Slack meetings channel. Returns a job id: call again with job to see progress."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "workspace": _WORKSPACE_ARG,
            "items": {"type": "array", "maxItems": MAX_ITEMS, "items": _ITEM},
            "dry_run": {"type": "boolean", "default": False},
            "notify": {"type": "boolean", "default": False},
            "job": {"type": "string", "maxLength": 40, "description": "A job id from an earlier call: its progress (other arguments are ignored)."},
        }},
        output_schema=_out({"job": {"type": ["string", "null"]}, "state": {"type": "string"}, "counts": {"type": "object"},
                            "items": {"type": "array", "items": {"type": "object"}}}),
        annotations=_ann(False, False, False),
        handler=import_meetings_bulk,
    ),
    Tool(
        name="organize_meetings",
        title="Organize meetings",
        description=("Workspace admins: files every meeting in a workspace by the rule new meetings follow — a recurring "
                     "call (a name seen on two or more days) in Meetings/<series>, anything else in Meetings/Other "
                     "meetings — setting the series where a person hasn't. Safe to run again. It runs in the "
                     "background: this waits up to ~50 s and returns the result, or, for a big workspace, the job id "
                     "and progress so far (state 'running'); call it again with the same workspace to check on it "
                     "(it joins the running job instead of starting another)."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {"workspace": _WORKSPACE_ARG}, "required": ["workspace"]},
        output_schema=_out({"id": {"type": ["string", "null"]}, "state": {"type": "string"},
                            "done": {"type": "integer"}, "total": {"type": "integer"}, "filed": {"type": "integer"},
                            "meetings": {"type": "integer"}, "moved": {"type": "integer"}, "series_set": {"type": "integer"},
                            "series": {"type": "integer"}, "covers": {"type": "integer"}, "folders": {"type": "integer"},
                            "errors": {"type": "integer"}}),
        annotations=_ann(False, False, True),
        handler=organize_meetings,
    ),
]
