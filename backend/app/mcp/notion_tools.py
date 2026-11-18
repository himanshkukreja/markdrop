"""MCP tools for Import from Notion (services/notion_import/).

* ``import_notion``: without ``import_id``, opens an import of a Notion export zip ("Markdown & CSV", with
  subpages) into My files or a team's space (a new folder named after the export by default) and answers
  with a URL to PUT the zip to (a curl command); with ``import_id``, starts it once the zip is up. The
  import then runs in the background.
* ``get_notion_import``: one import's progress (N of M pages) and, when done, its report (pages,
  databases, rows, images, files, updated / unchanged / kept because edited in Markdrop, what was skipped
  and why, errors per page) and where it went; without ``import_id``, the user's recent imports.

Same rules as the website (routers/notion_import.py): members import into their workspace's team spaces
(their own teams; admins any); imported items get the destination's default access, never public.
"""

from __future__ import annotations

from fastapi import HTTPException

from app.mcp.auth import READ, WRITE
from app.mcp.tools import _WORKSPACE_ARG, Context, Tool, ToolError, _ann, _out, http_message, resolve_workspace
from app.services.notion_import import jobs

_ID = {"type": "string", "minLength": 4, "maxLength": 64, "pattern": "^ni_[A-Za-z0-9_-]+$",
       "description": "The import's id (import_id from import_notion)."}
_JOB = {"type": "object", "description": (
    "{id, state (uploading|queued|running|done|failed|cancelled), file_name, size_bytes, destination, "
    "progress {phase, done, total, current}, counts {pages, databases, rows, images, files, updated, unchanged, "
    "kept_edited, skipped, errors}, skipped [{path, title, reason}], errors [{path, title, error}], "
    "result {folder_id, folder_url, url, pages [{title, slug, url}]}, error}")}


def _summary(j: dict) -> str:
    c = j["counts"]
    st = j["state"]
    if st == "uploading":
        return "Waiting for the zip: PUT it to the upload URL, then call import_notion with import_id to start."
    if st in ("queued", "running"):
        p = j["progress"]
        step = {"reading": "reading the export", "pages": "creating pages", "content": "filling in content"}.get(
            p.get("phase"), p.get("phase") or "starting")
        return (f"Importing ({step}" + (f", {p['done']} of {p['total']}" if p.get("total") else "") + "). "
                "Check again with get_notion_import in a little while.")
    if st == "failed":
        return f"The import failed: {j.get('error')}"
    if st == "cancelled":
        return "The import was cancelled; what was imported before stays."
    parts = [f"{c['pages']} pages", f"{c['databases']} databases", f"{c['rows']} database rows",
             f"{c['images']} images", f"{c['files']} files"]
    line = "Imported " + ", ".join(parts) + "."
    if c.get("updated") or c.get("unchanged") or c.get("kept_edited"):
        line += (f" From an earlier import: {c['updated']} updated, {c['unchanged']} unchanged, {c['kept_edited']} "
                 "kept because they were edited in Markdrop.")
    if c.get("skipped"):
        line += f" Skipped {c['skipped']} (see skipped for why)."
    if c.get("errors"):
        line += f" {c['errors']} couldn't be imported (see errors)."
    url = (j.get("result") or {}).get("url")
    if url:
        line += f" Open it: {url if url.startswith('http') else 'https://markdrop.in' + url}"
    return line


async def import_notion(ctx: Context, args: dict) -> tuple[str, dict]:
    jid = (args.get("import_id") or "").strip()
    if jid:
        try:
            job = await jobs.start(ctx.db, ctx.user, jid)
        except HTTPException as exc:
            raise ToolError(http_message(exc))
        out = jobs.out(job)
        return _summary(out), {"import_id": out["id"], "state": out["state"], "import": out}
    if not args.get("file_name") or not args.get("size_bytes"):
        raise ToolError("Pass file_name and size_bytes of the Notion export zip (or import_id to start one).")
    dest: dict = {"new_folder": args.get("new_folder", True), "folder_name": args.get("folder_name")}
    if args.get("workspace"):
        ws_id, _ws, _role = await resolve_workspace(ctx, args["workspace"])
        dest.update(workspace=ws_id, team=args.get("team"), folder=args.get("folder"))
    elif args.get("team") or args.get("folder"):
        raise ToolError("team and folder need workspace.")
    try:
        job, upload = await jobs.create(ctx.db, ctx.user, file_name=args["file_name"],
                                        size_bytes=int(args["size_bytes"]), destination=dest)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    out = jobs.out(job)
    name = out["file_name"].replace('"', "")
    curl = f'curl -sS -X PUT -H "Content-Type: {upload["headers"]["Content-Type"]}" --upload-file "{name}" "{upload["url"]}"'
    text = (f"Import {out['id']} is open. Upload the zip (the URL works for {jobs.UPLOAD_HOURS} hours):\n\n{curl}\n\n"
            f"Then call import_notion with import_id \"{out['id']}\" to start it, and get_notion_import to follow it.")
    return text, {"import_id": out["id"], "state": out["state"], "upload": upload, "curl": curl, "import": out}


async def get_notion_import(ctx: Context, args: dict) -> tuple[str, dict]:
    jid = (args.get("import_id") or "").strip()
    if not jid:
        rows = [jobs.out(j) for j in await jobs.recent(ctx.db, ctx.user, 10)]
        if not rows:
            return "No Notion imports yet.", {"imports": []}
        lines = [f"- {r['id']} {r['file_name']}: {r['state']}" for r in rows]
        return "Recent Notion imports:\n" + "\n".join(lines), {"imports": rows}
    try:
        job = await jobs.get(ctx.db, ctx.user, jid)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    out = jobs.out(job)
    return _summary(out), {"import": out}


NOTION_TOOLS: list[Tool] = [
    Tool(
        name="import_notion",
        title="Import from Notion",
        description=(
            "Import a Notion export into Markdrop: its pages and sub-pages (with images, files, callouts, toggles, "
            "to-dos, code, equations, tables, bookmarks; links between pages rewritten), and its databases as "
            "folders with typed properties (each row a page). The export is Notion's ••• › Export (or Settings › "
            "Export all workspace content) with Format \"Markdown & CSV\" and Include subpages on: a .zip, up to "
            "2 GB. Two calls: first with file_name and size_bytes (and where it goes: My files when workspace is "
            "left out, else a team's space — team omitted: company-wide) → an upload URL and a curl command to "
            "PUT the zip; run it, then call again with import_id to start. It runs in the background: follow "
            "it with get_notion_import. Importing the same export into the same place again updates what "
            "changed and keeps pages edited in Markdrop. Imported items get the destination's default access "
            "(never public)."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "file_name": {"type": "string", "minLength": 1, "maxLength": 255,
                          "description": "The zip's file name (ends in .zip)."},
            "size_bytes": {"type": "integer", "minimum": 1, "description": "The zip's size in bytes."},
            "workspace": {**_WORKSPACE_ARG, "description": "Optional: import into this workspace (a team's space). "
                                                           "Left out: the user's My files."},
            "team": {"type": "string", "maxLength": 100, "description": (
                "Optional (with workspace): the team (id, slug or name; see list_teams) whose space it goes "
                "to. Left out: company-wide (General).")},
            "folder": {"type": "string", "maxLength": 400, "description": (
                "Optional (with workspace): an existing folder (path or id) to put it in.")},
            "new_folder": {"type": "boolean", "default": True, "description": (
                "Default true: everything goes in a new folder (in My files: a page) named folder_name. "
                "Importing again with the same name updates that folder.")},
            "folder_name": {"type": "string", "maxLength": 100,
                            "description": "Optional: the new folder's name (default: the export's name)."},
            "import_id": _ID,
        }},
        output_schema=_out({"import_id": {"type": "string"}, "state": {"type": "string"},
                            "upload": {"type": "object"}, "curl": {"type": "string"}, "import": _JOB},
                           ["import_id", "state", "import"]),
        annotations=_ann(False, False, False),
        handler=import_notion,
    ),
    Tool(
        name="get_notion_import",
        title="Follow a Notion import",
        description=(
            "A Notion import's progress (reading the export, creating pages N of M, filling in content) and, "
            "when it's done, its report: how many pages, databases, rows, images and files; on a re-import "
            "how many were updated, unchanged or kept because they were edited in Markdrop; what was skipped "
            "and why; errors per page; and the link to where it went. Without import_id: the user's recent "
            "imports."),
        scope=READ,
        input_schema={"type": "object", "properties": {"import_id": _ID}},
        output_schema=_out({"import": _JOB, "imports": {"type": "array", "items": _JOB}}, []),
        annotations=_ann(True, False, True),
        handler=get_notion_import,
    ),
]
