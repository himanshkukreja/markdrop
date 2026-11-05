"""MCP tools for a page's version history (services/page_history.py): list the
versions, read one, restore one.

People who can edit the page only (``list_versions`` / ``restore_version``:
the owner and editors), as on the website. Listing and reading work with a
read-only token; a restore needs documents:write and is refused while someone
has the page open in the editor. Encrypted documents have no history.
"""

from __future__ import annotations

from fastapi import HTTPException

from app.mcp.auth import READ, WRITE
from app.mcp.tools import (
    _DOC_REF,
    TAKE_OVER_ARG,
    _NULLABLE_STR,
    _URL_PROPS,
    ENCRYPTED_READ,
    MAX_RETURNED_CHARS,
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
from app.services import page_history

NO_HISTORY_FILE = ("That's a file: files keep their own versions (list_file_versions, restore_file_version), "
                   "not page history.")


def _actx(ctx: Context) -> access_service.Ctx:
    return access_service.Ctx(ctx.db, surface="mcp")


async def _page(ctx: Context, document: str, perm: str, action: str) -> dict:
    raw = await load_for(ctx, document, perm, action)
    if raw.get("encrypted"):
        raise ToolError(ENCRYPTED_READ + " End-to-end encrypted documents have no version history.")
    if raw.get("kind") == "artifact":
        raise ToolError(NO_HISTORY_FILE)
    return raw


def _who(v: dict) -> str:
    a = v["author"]
    if a["kind"] == "restore":
        return f"{a.get('name') or 'Someone'} (restored version {v.get('restored_from')})"
    return a["label"]


async def list_page_versions(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await _page(ctx, args["document"], "list_versions", "see the versions of")
    out = await page_history.listing(ctx.db, raw, args.get("cursor"), int(args.get("limit") or 50))
    out.pop("available", None)
    out.pop("reason", None)
    url = (await url_pair(ctx, raw))["url"]
    out = {"slug": raw["slug"], "url": url, **out}
    if not out["versions"]:
        return f"{url} has no saved versions yet (they're made as the page is edited).", out
    lines = [f"- v{v['n']}{' (current)' if v['current'] else ''}: {v['ts']}, {_who(v)}, "
             f"{v['title'] or 'Untitled'} ({v['bytes']:,} bytes)" for v in out["versions"]]
    more = f"\nOlder ones: call again with cursor {out['next_cursor']}." if out["next_cursor"] else ""
    return (f"{len(lines)} version(s) of {url}, newest first (read one with get_page_version, bring one back "
            "with restore_page_version):\n" + "\n".join(lines) + more), out


async def get_page_version(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await _page(ctx, args["document"], "list_versions", "see the versions of")
    row = await page_history.get_version(ctx.db, raw, int(args["version"]))
    if row is None:
        raise ToolError(f"{raw['slug']} has no version {args['version']}: list them with list_page_versions.")
    d = await page_history.detail(ctx.db, raw, row, actor_of(ctx), _actx(ctx))
    markdown = d["markdown"]
    note = None
    if len(markdown) > MAX_RETURNED_CHARS:
        markdown = markdown[:MAX_RETURNED_CHARS]
        note = f"Only the first {MAX_RETURNED_CHARS:,} characters are included."
    out = {"slug": raw["slug"], "url": (await url_pair(ctx, raw))["url"], "version": d["n"], "ts": d["ts"],
           "author": d["author"], "title": d["title"], "markdown": markdown, "current": d["current"],
           "restored_from": d["restored_from"], "current_rev": d["current_doc"]["rev"]}
    if note:
        out["note"] = note
    head = (f"Version {d['n']} of {out['url']} ({d['ts']}, {_who(d)})"
            + (", the page as it is now" if d["current"] else "") + ":")
    return f"{head}\n\n{markdown}", out


async def restore_page_version(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await _page(ctx, args["document"], "restore_version", "restore versions of")
    n = int(args["version"])
    try:
        after, version = await page_history.restore(ctx.db, raw, n, actor_of(ctx), _actx(ctx))
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    out = {**await url_pair(ctx, after), "slug": after["slug"], "rev": int(after.get("rev") or 1),
           "restored_from": n, "version": version.get("n")}
    return (f"Restored version {n} of {out['url']}: it is the page again (revision {out['rev']}), saved as "
            f"version {out['version']}. The page as it was is kept in the history, so this can be undone."), out


_VERSION = {"type": "integer", "minimum": 1, "description": "A version number from list_page_versions."}

HISTORY_TOOLS: list[Tool] = [
    Tool(
        name="list_page_versions",
        title="List a page's versions",
        description=("The saved versions of a page, newest first: when, who (a person, an AI app via MCP, or a "
                     "restore) and the title, marking the one that matches the page now. Versions are kept "
                     "as the page is edited (one per editing session per 10 minutes, and before and after every "
                     "AI edit): all of them for 30 days, then one a day for a year. Only people who can edit "
                     "the page can see them."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF,
            "cursor": {"type": "integer", "minimum": 1, "description": "next_cursor from a previous call."},
            "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 50},
        }, "required": ["document"]},
        output_schema=_out({"slug": {"type": "string"}, "url": {"type": "string"},
                            "versions": {"type": "array"}, "next_cursor": {"type": ["integer", "null"]}},
                           ["slug", "url", "versions", "next_cursor"]),
        annotations=_ann(True, False, True),
        handler=list_page_versions,
    ),
    Tool(
        name="get_page_version",
        title="Read a page version",
        description="One saved version of a page (see list_page_versions): its Markdown, when and who.",
        scope=READ,
        input_schema={"type": "object", "properties": {"document": _DOC_REF, "version": _VERSION,
                                                       "take_over": TAKE_OVER_ARG},
                      "required": ["document", "version"]},
        output_schema=_out({"slug": {"type": "string"}, "url": {"type": "string"}, "version": {"type": "integer"},
                            "ts": _NULLABLE_STR, "author": {"type": "object"}, "title": _NULLABLE_STR,
                            "markdown": {"type": "string"}, "current": {"type": "boolean"},
                            "restored_from": {"type": ["integer", "null"]}, "current_rev": {"type": "integer"},
                            "note": {"type": "string"}},
                           ["slug", "url", "version", "markdown", "current"]),
        annotations=_ann(True, False, True),
        handler=get_page_version,
    ),
    Tool(
        name="restore_page_version",
        title="Restore a page version",
        description=("Make an earlier version of a page the page again. The page as it is now is kept in the "
                     "history first, so a restore can be undone by restoring that one. Refused while someone "
                     "is editing the page (error 'locked'; its owner or a workspace admin may pass take_over: "
                     "true). Confirm with the user first."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {"document": _DOC_REF, "version": _VERSION,
                                                       "take_over": TAKE_OVER_ARG},
                      "required": ["document", "version"]},
        output_schema=_out({**_URL_PROPS, "slug": {"type": "string"}, "rev": {"type": "integer"},
                            "restored_from": {"type": "integer"}, "version": {"type": ["integer", "null"]}},
                           ["url", "markdrop_url", "slug", "rev", "restored_from"]),
        annotations=_ann(False, True, True),
        handler=restore_page_version,
    ),
]
