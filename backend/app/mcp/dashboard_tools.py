"""MCP tools for the customizable Home (services/dashboards.py).

READ: ``get_dashboard`` (your Home in a workspace: both columns, the widget catalog and templates).
WRITE: ``set_dashboard`` (both columns, or a template; ``reset`` forgets your layout).

The same rules as the website (routers/dashboards.py): the registry validates every widget and setting.
"""

from __future__ import annotations

from fastapi import HTTPException

from app.mcp.auth import READ, WRITE
from app.mcp.tools import Context, Tool, ToolError, _ann, _out, actor_of, http_message
from app.services import dashboards as D

_O = {"type": "object"}
_WS = {"type": "string", "description": "Workspace id or name (list_workspaces). Leave out for the Home without a workspace."}
_WIDGET = {"type": "object", "properties": {
    "type": {"type": "string", "enum": list(D.WIDGETS)},
    "settings": {"type": "object", "description": "team (id), folder (id), page (slug), count, category, status, range — per type (get_dashboard's catalog)."},
    "id": {"type": "string", "description": "Keep a widget's id from get_dashboard when moving it."}}, "required": ["type"]}
_COL = {"type": "array", "items": _WIDGET, "maxItems": D.MAX_WIDGETS}


async def _where(ctx: Context, args: dict) -> str | None:
    from app.mcp.tools import resolve_workspace

    ref = (args.get("workspace") or "").strip()
    if not ref:
        return None
    try:
        return (await resolve_workspace(ctx, ref))[0]
    except HTTPException as exc:
        raise ToolError(http_message(exc))


def _actx(ctx: Context):
    from app.services import access

    return actor_of(ctx), access.Ctx(ctx.db, surface="mcp")


def _text(d: dict) -> str:
    labels = {k: v["label"] for k, v in D.WIDGETS.items()}

    def col(rows: list[dict]) -> list[str]:
        out = []
        for w in rows:
            bits = [f"{k}={v}" for k, v in (w.get("settings") or {}).items() if v not in (None, "")]
            line = f"  - {labels.get(w['type'], w['type'])} [{w['type']}, id {w['id']}]" + (f" ({', '.join(bits)})" if bits else "")
            if not w.get("available", True):
                line += f" — not available: {w.get('note') or ''}".rstrip(": ")
            out.append(line)
        return out or ["  (empty)"]

    where = (d.get("workspace") or {}).get("name") or "No workspace"
    src = {"mine": "customized", "workspace": "the workspace's default", "default": "Default"}[d["source"]]
    n = len(d["main"]) + len(d["side"])
    lines = [f"Home in {where} ({src}; {n} of {d['max']} widgets)", "Main column:", *col(d["main"]), "Side column:", *col(d["side"])]
    return "\n".join(lines)


async def get_dashboard(ctx: Context, args: dict) -> tuple[str, dict]:
    ws = await _where(ctx, args)
    actor, actx = _actx(ctx)
    d = await D.resolve(ctx.db, actor, actx, ws)
    text = _text(d) + "\nWidgets: " + ", ".join(f"{c['type']}" + ("" if c["available"] else " (n/a here)") for c in d["catalog"])
    text += "\nTemplates: " + ", ".join(p["id"] for p in d["presets"])
    return text, d


async def set_dashboard(ctx: Context, args: dict) -> tuple[str, dict]:
    ws = await _where(ctx, args)
    actor, actx = _actx(ctx)
    try:
        if args.get("reset"):
            d = await D.reset(ctx.db, actor, actx, ws)
        else:
            if not args.get("preset") and args.get("main") is None and args.get("side") is None:
                raise ToolError("Pass main and side (lists of widgets), a preset, or reset: true.")
            d = await D.save(ctx.db, actor, actx, ws, main=args.get("main"), side=args.get("side"), preset=args.get("preset"))
    except D.Invalid as exc:
        raise ToolError(str(exc))
    return "Saved. " + _text(d), {k: v for k, v in d.items() if k not in ("catalog", "presets")}


_RESULT = {"workspace": {"type": ["object", "null"]}, "source": {"type": "string"}, "main": {"type": "array", "items": _O},
           "side": {"type": "array", "items": _O}, "updated_at": {"type": ["string", "null"]}, "can_set_default": {"type": "boolean"},
           "has_workspace_default": {"type": "boolean"}, "max": {"type": "integer"}}

DASHBOARD_TOOLS = [
    Tool(name="get_dashboard", title="Your Home layout",
         description=("Your Markdrop Home (the signed-in start screen) in a workspace: the widgets in its wide main column and narrow "
                      "side column, top to bottom, with their settings; whether you customized it, see the workspace's default or "
                      "Default; the widget catalog (types, what each shows, its settings) and the templates (default, writer, "
                      "meetings, sales, manager)."),
         scope=READ, input_schema={"type": "object", "properties": {"workspace": _WS}},
         output_schema=_out({**_RESULT, "catalog": {"type": "array", "items": _O}, "presets": {"type": "array", "items": _O}}),
         annotations=_ann(True, False, True), handler=get_dashboard),
    Tool(name="set_dashboard", title="Change your Home layout", writes=True, scope=WRITE,
         description=("Set your Home in a workspace: main and side (lists of {type, settings}, at most 16 widgets in all; keep ids from "
                      "get_dashboard), or start from a template with preset (default, writer, meetings, sales, manager — filled in "
                      "with your first team and newest page), or reset: true to go back to the workspace's default. A team, folder "
                      "or page must be one you can open in that workspace. Only your own Home changes."),
         input_schema={"type": "object", "properties": {
             "workspace": _WS, "main": _COL, "side": _COL,
             "preset": {"type": "string", "enum": list(D.PRESETS)}, "reset": {"type": "boolean"}}},
         output_schema=_out(_RESULT),
         annotations=_ann(False, False, True), handler=set_dashboard),
]
