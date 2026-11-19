"""MCP tools for Import from Notion (services/notion_import/).

* ``import_notion``: without ``import_id``, opens an import of a Notion export zip ("Markdown & CSV", with
  subpages) into My files or a team's space (a new folder named after the export by default) and answers
  with a URL to PUT the zip to (a curl command); with ``import_id``, starts it once the zip is up. The
  import then runs in the background.
* ``get_notion_import``: one import's progress (N of M pages) and, when done, its report (pages,
  databases, rows, images, files, updated / unchanged / kept because edited in Markdrop, what was skipped
  and why, errors per page) and where it went; without ``import_id``, the user's recent imports.

Connect Notion (services/notion_import/connect.py, sync.py):

* ``import_notion`` with ``source: "api"`` imports pages the user shared with Markdrop in Notion (Settings ›
  Integrations › Notion connects it), optionally kept in sync (one way, Notion → Markdrop).
* ``notion_status``: whether Notion is connected, the synced roots (last sync, Edited in Markdrop pages), and
  with ``list_pages`` the pages and databases shared with Markdrop (their ids, for import_notion).
* ``notion_sync``: Sync now, turn Keep in sync on or off, or stop following a root.

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


def _dest_args(args: dict) -> dict:
    dest: dict = {"new_folder": args.get("new_folder", True), "folder_name": args.get("folder_name")}
    if args.get("workspace"):
        dest.update(team=args.get("team"), folder=args.get("folder"))
    elif args.get("team") or args.get("folder"):
        raise ToolError("team and folder need workspace.")
    return dest


async def _import_api(ctx: Context, args: dict) -> tuple[str, dict]:
    pages = args.get("pages") or []
    if not pages:
        raise ToolError("Pass pages: the Notion page or database ids to import (notion_status with list_pages "
                        "lists the ones shared with Markdrop).")
    dest = _dest_args(args)
    if args.get("workspace"):
        ws_id, _ws, _role = await resolve_workspace(ctx, args["workspace"])
        dest["workspace"] = ws_id
    try:
        job = await jobs.create_api(ctx.db, ctx.user, connection_id=args.get("connection"),
                                    roots=[{"id": p} if isinstance(p, str) else p for p in pages], destination=dest,
                                    keep_in_sync=bool(args.get("keep_in_sync")), exclude=args.get("exclude") or [])
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    out = jobs.out(job)
    text = (f"Import {out['id']} of {out['file_name']} from Notion has started"
            + (" and will be kept in sync (about every 15 minutes, Notion → Markdrop)" if args.get("keep_in_sync") else "")
            + ". Follow it with get_notion_import.")
    return text, {"import_id": out["id"], "state": out["state"], "import": out}


async def import_notion(ctx: Context, args: dict) -> tuple[str, dict]:
    if (args.get("source") or "zip") == "api":
        return await _import_api(ctx, args)
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


async def notion_status(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services.notion_import import connect
    from app.services.notion_import import sync as S

    if not connect.configured():
        return ("Connect Notion isn't available on this Markdrop; import a Notion export zip instead "
                "(import_notion)."), {"configured": False, "connections": [], "syncs": []}
    conns = [connect.out(r) for r in await connect.list_for(ctx.db, ctx.user)]
    syncs = await S.list_for(ctx.db, ctx.user)
    data: dict = {"configured": True, "connections": conns, "syncs": syncs}
    if not conns:
        return ("Notion isn't connected. The user connects it at https://markdrop.in/settings/integrations/notion "
                "(choosing which Notion pages Markdrop may read)."), data
    lines = ["Connected Notion workspaces: " + ", ".join(
        f"{c['workspace_name']} ({c['id']}{', needs reconnecting' if c['broken'] else ''})" for c in conns)]
    for s_ in syncs:
        bits = [s_["state"], "kept in sync" if s_["keep_in_sync"] else "not kept in sync"]
        if s_.get("paused"):
            bits.append(f"paused ({s_['paused']})")
        if s_.get("last_synced_at"):
            bits.append(f"last synced {s_['last_synced_at']}")
        if s_["edited_in_markdrop"]:
            bits.append(f"{len(s_['edited_in_markdrop'])} edited in Markdrop (no longer synced)")
        lines.append(f"- {s_['title']} [{s_['id']}]: " + ", ".join(bits))
    if args.get("list_pages"):
        try:
            conn = await connect.get_own(ctx.db, ctx.user, args.get("connection"))
            listing = await jobs.shared_listing(ctx.db, conn)
        except HTTPException as exc:
            raise ToolError(http_message(exc))
        data["pages"] = listing["items"]
        lines.append(f"Shared with Markdrop ({len(listing['items'])}):")
        for it in listing["items"][:200]:
            where = ""
            if it["parent_id"]:
                where = f" (in {'database row ' if it.get('parent_kind') == 'row' else ''}{it['parent_id']})"
            rows = f", {it['row_count']} rows" if it["kind"] == "database" and it.get("row_count") else ""
            lines.append(f"- {it['kind']} {it['id']}: {it['title']}{rows}{where}")
        if args.get("database"):
            try:
                got = await jobs.database_rows(ctx.db, conn, str(args["database"]).replace("-", "").lower(),
                                               args.get("cursor"))
            except HTTPException as exc:
                raise ToolError(http_message(exc))
            data["rows"], data["next_cursor"] = got["items"], got["next_cursor"]
            lines.append(f"Rows of {args['database']} ({len(got['items'])}"
                         + (", more: pass cursor " + got["next_cursor"] if got["next_cursor"] else "") + "):")
            lines += [f"- row {r['id']}: {r['title']}" for r in got["items"]]
    return "\n".join(lines), data


async def notion_sync(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services.notion_import import sync as S

    sid = (args.get("sync_id") or "").strip()
    action = args.get("action") or "run"
    try:
        if action == "run":
            job = await S.run_now(ctx.db, ctx.user, sid)
            out = jobs.out(job)
            return (f"Syncing from Notion now (import {out['id']}); follow it with get_notion_import.",
                    {"sync": await S.list_one(ctx.db, ctx.user, sid), "import": out})
        if action in ("keep", "stop_keeping"):
            row = await S.set_keep(ctx.db, ctx.user, sid, action == "keep")
            return ("Kept in sync with Notion." if action == "keep" else "No longer kept in sync."), {"sync": row}
        if action == "remove":
            await S.remove(ctx.db, ctx.user, sid)
            return "Stopped following it; the imported pages stay.", {}
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    raise ToolError("action is run, keep, stop_keeping or remove.")


NOTION_TOOLS: list[Tool] = [
    Tool(
        name="import_notion",
        title="Import from Notion",
        description=(
            "Import a Notion export into Markdrop: its pages and sub-pages (with images, files, callouts, toggles, "
            "to-dos, code, equations, tables, bookmarks; links between pages rewritten), and its databases as "
            "folders with typed properties (each row a page). The export is Notion's ••• › Export (or Settings › "
            "Export all workspace content) with Format \"Markdown & CSV\" and Include subpages on: a .zip, up to "
            "2 GB, or (source \"api\") straight from Notion for pages the user shared with Markdrop through "
            "Connect Notion, optionally kept in sync. For a zip, two calls: first with file_name and size_bytes (and where it goes: My files when workspace is "
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
            "source": {"type": "string", "enum": ["zip", "api"], "default": "zip", "description": (
                "zip (default): a Notion export file. api: pages the user shared with Markdrop through Connect "
                "Notion (see notion_status); pass pages.")},
            "pages": {"type": "array", "maxItems": 50, "items": {"type": "string", "minLength": 32, "maxLength": 36},
                      "description": "source api: Notion page or database ids (sub-pages come with them)."},
            "exclude": {"type": "array", "maxItems": 2000, "items": {"type": "string", "minLength": 32, "maxLength": 36},
                        "description": (
                            "source api: Notion ids under the chosen pages / databases to leave out (sub-pages, "
                            "child databases or database rows), with everything under them. Keep in sync "
                            "remembers them; pages added in Notion later still come.")},
            "connection": {"type": "string", "maxLength": 64,
                           "description": "source api: the Notion connection id (default: the only one)."},
            "keep_in_sync": {"type": "boolean", "default": False, "description": (
                "source api: import again about every 15 minutes (one way, Notion → Markdrop, only what changed; "
                "pages edited in Markdrop are kept and stop syncing).")},
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
    Tool(
        name="notion_status",
        title="Notion connection status",
        description=(
            "Whether the user connected Notion (Connect Notion: read-only, the pages they chose to share with "
            "Markdrop), their imports kept in sync with Notion (each root's last sync, whether it's kept in sync, "
            "paused, and the pages edited in Markdrop that no longer sync), and with list_pages the Notion pages and "
            "databases shared with Markdrop with their ids, each under its real parent (to import with import_notion source "
            "\"api\"); with database, that database's rows (to leave some out with import_notion's exclude)."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "list_pages": {"type": "boolean", "default": False,
                           "description": "Also list the pages and databases shared with Markdrop."},
            "connection": {"type": "string", "maxLength": 64,
                           "description": "With list_pages: which Notion connection (default: the only one)."},
            "database": {"type": "string", "minLength": 32, "maxLength": 36, "description": (
                "With list_pages: also list this database's rows (50 at a time; their ids can go in "
                "import_notion's exclude).")},
            "cursor": {"type": "string", "maxLength": 200,
                       "description": "With database: the next_cursor of the previous rows listing."}}},
        output_schema=_out({"configured": {"type": "boolean"}, "connections": {"type": "array"},
                            "syncs": {"type": "array"}, "pages": {"type": "array"}, "rows": {"type": "array"},
                            "next_cursor": {"type": ["string", "null"]}}, ["configured"]),
        annotations=_ann(True, False, True),
        handler=notion_status,
    ),
    Tool(
        name="notion_sync",
        title="Sync from Notion",
        description=(
            "For an import kept in sync with Notion (sync_id from notion_status): run (default) syncs it now "
            "(one way, Notion → Markdrop; only what changed; pages edited in Markdrop are never overwritten), "
            "keep / stop_keeping turns the 15-minute Keep in sync on or off, remove stops following it (the "
            "imported pages stay)."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "required": ["sync_id"], "properties": {
            "sync_id": {"type": "string", "pattern": "^ns_[a-f0-9]+$", "maxLength": 40},
            "action": {"type": "string", "enum": ["run", "keep", "stop_keeping", "remove"], "default": "run"}}},
        output_schema=_out({"sync": {"type": "object"}, "import": _JOB}, []),
        annotations=_ann(False, False, True),
        handler=notion_sync,
    ),
]
