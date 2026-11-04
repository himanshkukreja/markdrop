"""MCP tools for typed page properties and folder databases (services/page_db.py):
``set_folder_properties`` defines a folder's schema (and saved views),
``list_folder_pages`` lists its pages with their values. Values are set with
``set_page_properties(properties={...})`` (page_tools.py) and read back by
``get_page``."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from app.mcp.auth import READ, WRITE
from app.mcp.tools import (
    _FOLDER_ARG,
    _WORKSPACE_ARG,
    Context,
    Tool,
    ToolError,
    _ann,
    _out,
    actor_of,
    http_message,
    resolve_folder,
    resolve_workspace,
)
from app.services import access as access_service
from app.services import page_db

DEFAULT_LIMIT = 100
MAX_LIMIT = page_db.MAX_ROWS


def _actx(ctx: Context) -> access_service.Ctx:
    return access_service.Ctx(ctx.db, surface="mcp")


async def _folder(ctx: Context, args: dict) -> tuple[str, str, str]:
    ws_id, _ws, role = await resolve_workspace(ctx, args["workspace"])
    folder_id = await resolve_folder(ctx, ws_id, args.get("folder"))
    if not folder_id:
        raise ToolError("Name a folder of that workspace (a path like 'product-hub/02-prds').")
    return ws_id, folder_id, role


def _schema_line(p: dict) -> str:
    opts = f": {', '.join(o['name'] for o in p.get('options') or [])}" if p.get("options") else ""
    return f"- {p['name']} (key {p['key']}, {page_db.TYPE_LABELS[p['type']]}{opts})"


async def set_folder_properties(ctx: Context, args: dict) -> tuple[str, dict]:
    ws_id, folder_id, _role = await _folder(ctx, args)
    try:
        out = await page_db.set_schema(ctx.db, ws_id, folder_id, ctx.user.id, args["properties"],
                                       views=args.get("views"))
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    props = out["properties"]
    text = (f"The folder now has {len(props)} propert{'y' if len(props) == 1 else 'ies'}:\n"
            + "\n".join(_schema_line(p) for p in props)) if props else "The folder has no properties now."
    if out["views"]:
        text += "\nViews: " + ", ".join(f"{v['name']} ({v['type']}"
                                         + (f", grouped by {v['group']}" if v.get("group") else "") + ")"
                                         for v in out["views"])
    text += ("\nSet a page's values with set_page_properties(document, properties={key: value}); "
             "list them with list_folder_pages.")
    return text, out


def _filters(raw: Any, schema: list[dict]) -> list[dict]:
    """``{key or name: value}`` (is / contains-one for lists) or
    ``[{property, op, value}]``."""
    if raw is None:
        return []
    items = [{"key": k, "op": "is", "value": v} for k, v in raw.items()] if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        raise ToolError("filter is {property: value} or a list of {property, op, value}.")
    out = []
    for f in items[:page_db.MAX_VIEW_RULES]:
        if not isinstance(f, dict):
            raise ToolError("Each filter is {property, op, value}.")
        ref = f.get("property") or f.get("key")
        if ref in page_db.SPECIAL_SORT:
            key = ref
        else:
            p = page_db.find_prop(schema, str(ref or ""))
            if p is None:
                raise ToolError(f"No property {ref!r} in this folder. Its properties: "
                                + ", ".join(f"{q['name']} ({q['key']})" for q in schema) + ".")
            key = p["key"]
        op = f.get("op") or "is"
        if op not in page_db.FILTER_OPS:
            raise ToolError(f"Filter operators: {', '.join(page_db.FILTER_OPS)}.")
        out.append({"key": key, "op": op, "value": f.get("value")})
    return out


def _sorts(raw: Any, schema: list[dict]) -> list[dict]:
    if raw is None:
        return []
    items = [raw] if isinstance(raw, (str, dict)) else raw
    if not isinstance(items, list):
        raise ToolError("sort is 'key', '-key' (descending) or a list of them.")
    out = []
    for s in items[:page_db.MAX_VIEW_RULES]:
        if isinstance(s, dict):
            ref, desc = s.get("property") or s.get("key"), s.get("direction") in ("desc", "descending")
        else:
            ref, desc = str(s), str(s).startswith("-")
            ref = ref.lstrip("-")
        if ref in page_db.SPECIAL_SORT:
            key = ref
        else:
            p = page_db.find_prop(schema, str(ref or ""))
            if p is None:
                raise ToolError(f"Can't sort by {ref!r}: not a property of this folder (or title, "
                                "updated_at, created_at).")
            key = p["key"]
        out.append({"key": key, "dir": "desc" if desc else "asc"})
    return out


def _display(p: dict, v: Any, people: dict, links: dict) -> str:
    return page_db.display_text(p, v, people, links)


def _cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")[:80]


async def list_folder_pages(ctx: Context, args: dict) -> tuple[str, dict]:
    ws_id, folder_id, _role = await _folder(ctx, args)
    actx = _actx(ctx)
    actor = actor_of(ctx)
    try:
        data = await page_db.database(ctx.db, actor, actx, ws_id, folder_id)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    schema = data["properties"]
    filt = _filters(args.get("filter"), schema)
    sort = _sorts(args.get("sort"), schema)
    rows = [r for r in data["rows"] if all(page_db.matches(r, f, schema) for f in filt)]
    if sort:
        rows = page_db.sort_rows(rows, sort, schema, data["people"])
    limit = max(1, min(MAX_LIMIT, int(args.get("limit") or DEFAULT_LIMIT)))
    total = len(rows)
    rows = rows[:limit]
    links = data["links"]
    pages = []
    for r in rows:
        item = {"slug": r["slug"], "title": r["title"], "url": r["url"], "markdrop_url": r["markdrop_url"],
                "updated_at": r["updated_at"], "properties": r["values"], "can_edit": r["can_edit"]}
        shown = {}
        for p in schema:
            if p["key"] in r["values"]:
                shown[p["name"]] = _display(p, r["values"][p["key"]], data["people"], links)
        item["display"] = shown
        pages.append(item)
    out = {"folder": data["folder"], "properties": schema, "views": data["views"], "pages": pages,
           "total": total, "truncated": data["truncated"] or total > len(pages),
           "people": {k: v["name"] for k, v in data["people"].items()},
           "links": {k: {kk: vv for kk, vv in v.items() if kk in ("state", "title", "url")}
                     for k, v in links.items()}}
    name = data["folder"]["name"]
    if not pages:
        text = f"No pages you can open in {name!r}" + (" match that filter." if filt else ".")
        if schema:
            text += "\nProperties:\n" + "\n".join(_schema_line(p) for p in schema)
        return text, out
    cols = schema[:8]
    head = "| Page | " + " | ".join(_cell(p["name"]) for p in cols) + " |"
    lines = [f"{len(pages)} of {total} page{'s' if total != 1 else ''} in {name!r}:", "", head,
             "|" + " --- |" * (len(cols) + 1)]
    for it, r in zip(pages, rows):
        lines.append(f"| [{_cell(r['title'])}]({r['url']}) | "
                     + " | ".join(_cell(_display(p, r["values"].get(p["key"]), data["people"], links))
                                  for p in cols) + " |")
    if not schema:
        lines.append("\nThis folder has no properties yet: define them with set_folder_properties.")
    return "\n".join(lines), out


# ── Schemas ───────────────────────────────────────────────────────────────────

_OPTION = {"oneOf": [{"type": "string", "maxLength": page_db.OPTION_MAX}, {
    "type": "object", "properties": {"name": {"type": "string", "maxLength": page_db.OPTION_MAX},
                                     "color": {"type": "string", "enum": list(page_db.COLORS)}},
    "required": ["name"]}]}
_PROPERTY = {"type": "object", "properties": {
    "key": {"type": "string", "pattern": "^[a-z][a-z0-9_]{0,39}$", "description": (
        "Optional stable key (lowercase, digits, _). Made from the name when left out; an existing "
        "property with the same name keeps its key.")},
    "name": {"type": "string", "minLength": 1, "maxLength": page_db.NAME_MAX},
    "type": {"type": "string", "enum": list(page_db.TYPES)},
    "options": {"type": "array", "maxItems": page_db.MAX_OPTIONS, "items": _OPTION,
                "description": "select / multi_select: the options, in order (names, or {name, color})."},
}, "required": ["name", "type"]}
_RULE = {"type": "object", "properties": {"property": {"type": "string"}, "op": {"type": "string"},
                                          "value": {}}}
_VIEW = {"type": "object", "properties": {
    "name": {"type": "string", "minLength": 1, "maxLength": page_db.NAME_MAX},
    "type": {"type": "string", "enum": list(page_db.VIEW_TYPES)},
    "group": {"type": ["string", "null"], "description": "A property key: a board's columns (a Select)."},
    "sort": {"type": "array", "items": {"type": "object", "properties": {
        "key": {"type": "string"}, "dir": {"type": "string", "enum": ["asc", "desc"]}}}},
    "filter": {"type": "array", "items": {"type": "object", "properties": {
        "key": {"type": "string"}, "op": {"type": "string", "enum": list(page_db.FILTER_OPS)}, "value": {}}}},
    "hidden": {"type": "array", "items": {"type": "string"}},
}, "required": ["name", "type"]}

PROPS_TOOLS: list[Tool] = [
    Tool(
        name="set_folder_properties",
        title="Define a folder's page properties",
        description=(
            "Make a workspace folder a database: define the typed properties its pages have (workspace "
            "members and admins). properties is the FULL list, in order — each {name, type, key?, options?}; "
            "types: select and multi_select (options with colours: "
            f"{', '.join(page_db.COLORS)}), person (a workspace member), date (YYYY-MM-DD), text, link (an "
            "https:// address or a Markdrop page's slug), number, checkbox. Keys are kept when you resend a "
            "property (by key or by the same name). A property left out is hidden, never deleted: pages keep "
            "their values. Optional views (at most 20) replace the folder's saved views: {name, type: table|"
            "board, group (a board's Select), sort, filter}. Top-level pages filed directly in the folder are "
            "its rows: set values with set_page_properties(properties=…), list them with list_folder_pages. "
            f"Limits: {page_db.MAX_PROPERTIES} properties, {page_db.MAX_OPTIONS} options each."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "workspace": _WORKSPACE_ARG,
            "folder": {**_FOLDER_ARG, "description": "The folder (path like 'product-hub/02-prds', or id)."},
            "properties": {"type": "array", "maxItems": page_db.MAX_PROPERTIES, "items": _PROPERTY},
            "views": {"type": "array", "maxItems": page_db.MAX_VIEWS, "items": _VIEW,
                      "description": "Optional: the saved views (replaces them; left out = kept)."},
        }, "required": ["workspace", "folder", "properties"]},
        output_schema=_out({"folder_id": {"type": "string"}, "properties": {"type": "array"},
                            "views": {"type": "array"}, "rev": {"type": "integer"}},
                           ["folder_id", "properties", "views"]),
        annotations=_ann(False, False, True),
        handler=set_folder_properties,
    ),
    Tool(
        name="list_folder_pages",
        title="List a folder's pages with their properties",
        description=(
            "The pages filed directly in a workspace folder (top-level pages; not sub-pages or files) that "
            "the user can open, with their property values and links — a folder database's rows. "
            "properties in each page are by key (person = user id, link = slug or URL); display has them "
            "by property name as text (people's names, linked pages' titles only when the user can open "
            "them). filter: {property: value} (multi_select / link: contains it), or a list of {property, "
            "op, value} with op " + ", ".join(page_db.FILTER_OPS) + ". sort: 'key' or '-key' (descending), "
            "or a list; title, updated_at and created_at work too. Default newest first; limit "
            f"{DEFAULT_LIMIT} (at most {MAX_LIMIT})."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "workspace": _WORKSPACE_ARG,
            "folder": {**_FOLDER_ARG, "description": "The folder (path like 'product-hub/02-prds', or id)."},
            "filter": {"type": ["object", "array"], "description": (
                "Optional: {property: value} or [{property, op, value}].")},
            "sort": {"type": ["string", "array"], "description": "Optional: 'key', '-key', or a list."},
            "limit": {"type": "integer", "minimum": 1, "maximum": MAX_LIMIT},
        }, "required": ["workspace", "folder"]},
        output_schema=_out({"folder": {"type": "object"}, "properties": {"type": "array"},
                            "views": {"type": "array"}, "pages": {"type": "array"},
                            "total": {"type": "integer"}, "truncated": {"type": "boolean"},
                            "people": {"type": "object"}, "links": {"type": "object"}},
                           ["folder", "properties", "pages", "total"]),
        annotations=_ann(True, False, True),
        handler=list_folder_pages,
    ),
]
