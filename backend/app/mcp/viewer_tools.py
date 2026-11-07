"""MCP tools for viewer analytics (services/doc_views.py): ``get_document_viewers`` and
``get_view_timeline``.

READ scope. The web Viewers tab's rules exactly (doc_views.access_level): the item's owner, and for
an item filed in a workspace its admins and editors, see who viewed and what they did; someone who
can only view a workspace item gets the counts. Anonymous viewers stay anonymous ("Visitor 3F2A").
"""

from __future__ import annotations

from app.config import get_settings
from app.mcp.auth import READ, WRITE
from app.mcp.tools import (Context, Tool, ToolError, _ann, _out, actor_of, load_for, resolve_folder,
                           resolve_workspace)
from app.services import analytics_prefs as ap
from app.services import creator_analytics as ca
from app.services import doc_views as dv

_STR = {"type": "string"}
_NSTR = {"type": ["string", "null"]}
_NUM = {"type": "number"}
_NNUM = {"type": ["number", "null"]}


def _link(slug: str, view_id: str | None = None) -> str:
    base = get_settings().frontend_url.rstrip("/")
    q = f"&view={view_id}" if view_id else ""
    return f"{base}/dashboard/analytics/{slug}?tab=viewers{q}"


async def _doc(ctx: Context, args: dict, *, full: bool) -> tuple[dict, str]:
    raw = await load_for(ctx, args["document"], "read", "see the viewers of")
    level = await dv.access_level(ctx.db, actor_of(ctx), raw)
    if level is None or (full and level != "full"):
        if level == "counts":
            raise ToolError("You can see how many people viewed this, not who: get_document_viewers gives the "
                            "counts. The owner and the workspace's admins and editors see the people.")
        raise ToolError("Only the document's owner (or, in a workspace, its admins and editors) can see who "
                        "viewed it.")
    return raw, level


def _line(v: dict) -> str:
    who = v["viewer"]
    name = who.get("name") or who.get("email") or "Someone"
    if who.get("email") and who.get("name"):
        name = f"{who['name']} <{who['email']}>"
    bits = [name, v["started_at"][:16].replace("T", " ") + " UTC", f"{dv.span(v['active_s'])} active"]
    if v.get("completion") is not None:
        bits.append(f"{v['completion']:g}% through")
    if v["location"].get("label"):
        bits.append(v["location"]["label"])
    bits.append(v["system"]["label"])
    if v.get("source") and v["source"] != "Direct":
        bits.append(f"from {v['source']}")
    if v.get("own"):
        bits.append("(you)")
    return " · ".join(bits) + f" [view {v['id']}]"


async def get_document_viewers(ctx: Context, args: dict) -> tuple[str, dict]:
    raw, level = await _doc(ctx, args, full=False)
    rng = args.get("range") or "30d"
    if rng not in ca.RANGES:
        raise ToolError("range must be one of 7d, 30d, 90d or all.")
    who = args.get("who") or "all"
    if who not in dv.WHO:
        raise ToolError("who must be all, signed_in or anonymous.")
    w = ca.window(rng)
    limit = max(1, min(100, int(args.get("limit") or 25)))
    res = await dv.listing(ctx.db, raw, w.start, w.end, who=who, own=bool(args.get("include_own")),
                           internal=True, offset=0, limit=limit)
    t = res["totals"]
    head = (f"{t['views']} view{'s' if t['views'] != 1 else ''} by {t['people']} "
            f"{'person' if t['people'] == 1 else 'people'} ({t['signed_in']} signed in, {t['anonymous']} anonymous) "
            f"in {rng}.")
    out = {"slug": raw["slug"], "range": rng, "access": level,
           "totals": {k: t[k] for k in ("views", "people", "signed_in", "anonymous")},
           "url": _link(raw["slug"]), "views": [], "breakdowns": None, "people": []}
    if level != "full":
        return head + " (You can see the counts, not who.)", out
    out["totals"].update(avg_active_s=t["avg_active_s"], avg_completion=t["avg_completion"])
    out["views"] = [{**v, "url": _link(raw["slug"], v["id"])} for v in res["views"]]
    out["breakdowns"] = res["breakdowns"]
    if args.get("by_person"):
        out["people"] = (await dv.people_rollup(ctx.db, raw, w.start, w.end, who=who,
                                                own=bool(args.get("include_own")), limit=limit))["people"]
    lines = [head] + [f"- {_line(v)}" for v in res["views"]]
    if res["next"] is not None:
        lines.append(f"…and {res['total'] - limit} more (raise limit, or open {out['url']}).")
    lines.append("Call get_view_timeline with a view id for what that person did.")
    return "\n".join(lines), out


async def get_view_timeline(ctx: Context, args: dict) -> tuple[str, dict]:
    raw, _level = await _doc(ctx, args, full=True)
    res = await dv.timeline(ctx.db, raw, str(args.get("view_id") or ""))
    if res is None:
        raise ToolError(f"No view {args.get('view_id')!r} on this document (views are kept "
                        f"{dv.detail_days()} days). get_document_viewers lists them.")
    res["url"] = _link(raw["slug"], res["id"])
    text = _line(res) + "\n" + "\n".join(f"- {s['at'][11:16]} {s['text']}" for s in res["steps"])
    return text, res


# ── What's tracked (services/analytics_prefs.py) ─────────────────────────────


def _types_arg(v, name: str) -> list[str]:
    if v is None:
        return []
    if not isinstance(v, list) or any(t not in ap.KEYS for t in v):
        raise ToolError(f"{name} must be a list of: {', '.join(ap.KEYS)}.")
    return v


def _settings_arg(v) -> dict | None:
    if v is None:
        return None
    if not isinstance(v, dict) or any(k not in ap.KEYS or not isinstance(x, bool) for k, x in v.items()):
        raise ToolError(f"settings maps types ({', '.join(ap.KEYS)}) to true or false.")
    return v


def _target(args: dict) -> str:
    given = [k for k in ("document", "documents", "folder", "workspace") if args.get(k)]
    if args.get("account"):
        given.append("account")
    if "folder" in given and "workspace" in given:
        given.remove("workspace")  # a folder is named within its workspace
    if len(given) != 1:
        raise ToolError("Name exactly one target: document, documents, folder (with workspace), workspace, "
                        "or account: true.")
    return given[0]


def _types_text(types: list[dict]) -> str:
    return "\n".join(f"- {t['label']}: {'on' if t['on'] else 'off'} ({t['from']}{', locked' if t['locked'] else ''})"
                      for t in types)


async def get_analytics_settings(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.routers import analytics_settings as rs

    target = _target(args)
    if target == "account":
        s = await ap.get_account(ctx.db, ctx.user.id)
        return f"Your defaults: {ap.summary(s)}.", {"target": "account", "settings": s, "summary": ap.summary(s)}
    if target in ("document", "documents"):
        if target == "documents":
            raise ToolError("get_analytics_settings takes one document.")
        raw = await load_for(ctx, args["document"], "read", "see the analytics settings of")
        if await dv.access_level(ctx.db, actor_of(ctx), raw) != "full" and not await rs.can_manage_item(ctx.db, ctx.user.id, raw):
            raise ToolError("Only the item's owner (or, in a workspace, its admins and editors) can see this.")
        out = await rs.item_settings(ctx.db, raw, ctx.user.id)
        return f"{out['summary']}.\n{_types_text(out['types'])}", {"target": "document", **out}
    ws_id, _ws, _role = await resolve_workspace(ctx, args["workspace"])
    w = await ctx.db["workspaces"].find_one({"_id": __import__("bson").ObjectId(ws_id)})
    if target == "folder":
        fid = await resolve_folder(ctx, ws_id, args["folder"])
        if not fid:
            raise ToolError("Name a folder of the workspace.")
        f = await ctx.db["folders"].find_one({"_id": __import__("bson").ObjectId(fid)})
        p = ap.clean((f or {}).get("analytics_prefs"))
        return (f"Folder defaults: {p or 'none (inherits the workspace)'}.",
                {"target": "folder", "folder_id": fid, "settings": p})
    p = ap.clean((w or {}).get("analytics_prefs"))
    return (f"Workspace defaults: {p or 'none (each owner decides)'}; enforced: {bool((w or {}).get('analytics_enforce'))}.",
            {"target": "workspace", "workspace_id": ws_id, "settings": p, "enforce": bool((w or {}).get("analytics_enforce"))})


async def set_analytics_settings(ctx: Context, args: dict) -> tuple[str, dict]:
    from bson import ObjectId

    from app.routers import analytics_settings as rs
    from app.services import workspace as ws_service

    target = _target(args)
    settings = _settings_arg(args.get("settings"))
    use_defaults = bool(args.get("use_defaults"))
    delete = _types_arg(args.get("delete"), "delete")
    if target == "account":
        if settings is None:
            raise ToolError("settings is required for your defaults.")
        current = await ap.get_account(ctx.db, ctx.user.id)
        await ap.set_account(ctx.db, ctx.user.id, {**current, **settings})
        deleted = {}
        if delete:
            docs = await ctx.db["documents"].find({"owner_id": ctx.user.id}).limit(5000).to_list(length=5000)
            deleted = await rs._delete_for(ctx.db, docs, delete)
        s = await ap.get_account(ctx.db, ctx.user.id)
        return f"Your defaults: {ap.summary(s)}.", {"target": "account", "settings": s, "deleted": deleted}
    if target in ("document", "documents"):
        refs = [args["document"]] if target == "document" else list(args["documents"])[:200]
        docs, skipped = [], []
        for ref in refs:
            raw = await load_for(ctx, ref, "read", "change the analytics settings of")
            (docs if await rs.can_manage_item(ctx.db, ctx.user.id, raw) else skipped).append(raw)
        if not docs:
            raise ToolError("Only an item's owner (or its workspace's admins) can change what it tracks.")
        await ap.set_item(ctx.db, [d["_id"] for d in docs], None if use_defaults else (settings or {}))
        fresh = await ctx.db["documents"].find({"_id": {"$in": [d["_id"] for d in docs]}}).to_list(length=len(docs))
        deleted = await rs._delete_for(ctx.db, fresh, delete) if delete else {}
        first = await rs.item_settings(ctx.db, fresh[0], ctx.user.id)
        out = {"target": target, "updated": [d["slug"] for d in docs], "skipped": [d["slug"] for d in skipped],
               "summary": first["summary"], "types": first["types"], "deleted": deleted}
        return f"{len(docs)} item(s) now: {first['summary']}." + (f" Skipped {len(skipped)}." if skipped else ""), out
    ws_id, _ws, _role = await resolve_workspace(ctx, args["workspace"])
    if await ws_service.role_for(ctx.db, ws_id, ctx.user.id) not in ("owner", "admin"):
        raise ToolError("Only the workspace's owner and admins can change its analytics defaults.")
    docs = await ctx.db["documents"].find({"workspace_id": ws_id}).limit(5000).to_list(length=5000)
    if target == "folder":
        fid = await resolve_folder(ctx, ws_id, args["folder"])
        if not fid:
            raise ToolError("Name a folder of the workspace.")
        await ap.set_folder(ctx.db, fid, None if use_defaults else settings)
        inside = []
        for d in docs:
            if any(c["id"] == fid for c in await ap._folder_chain(ctx.db, ws_id, d.get("folder_id"))):
                inside.append(d)
        deleted = await rs._delete_for(ctx.db, inside, delete) if delete else {}
        f = await ctx.db["folders"].find_one({"_id": ObjectId(fid)})
        p = ap.clean((f or {}).get("analytics_prefs"))
        return f"Folder defaults: {p or 'none'}.", {"target": "folder", "folder_id": fid, "settings": p, "deleted": deleted}
    enforce = args.get("enforce")
    if enforce is not None and not isinstance(enforce, bool):
        raise ToolError("enforce is true or false.")
    # use_defaults clears the workspace's defaults (each owner decides again); settings replaces them.
    await ap.set_workspace(ctx.db, ws_id, {} if use_defaults else settings, enforce)
    deleted = await rs._delete_for(ctx.db, docs, delete) if delete else {}
    w = await ctx.db["workspaces"].find_one({"_id": ObjectId(ws_id)})
    p = ap.clean((w or {}).get("analytics_prefs"))
    return (f"Workspace defaults: {p or 'none'}; enforced: {bool(w.get('analytics_enforce'))}.",
            {"target": "workspace", "workspace_id": ws_id, "settings": p, "enforce": bool(w.get("analytics_enforce")),
             "deleted": deleted})


_TARGET_PROPS = {
    "document": {"type": "string", "description": "An item's link or slug."},
    "folder": {"type": "string", "description": "A folder (id or slug path) of `workspace`."},
    "workspace": {"type": "string", "description": "A workspace (id, name or domain)."},
    "account": {"type": "boolean", "description": "true: your own defaults for the items you own."},
}
_SETTINGS = {"type": "object", "properties": {k: {"type": "boolean"} for k in ap.KEYS}, "additionalProperties": False}

_VIEW = {"type": "object"}

SETTINGS_TOOLS: list[Tool] = [
    Tool(
        name="get_analytics_settings",
        title="What an item's analytics track",
        description=("Which kinds of analytics are collected: " + ", ".join(ap.KEYS) + ". For a document: each "
                     "type on or off, where the value comes from (the item itself, its folder, the workspace's "
                     "defaults or enforced settings, or the owner's defaults) and whether the workspace locks "
                     "it, plus a one-line summary. Or a folder's or workspace's defaults, or your own "
                     "(account: true). Name exactly one target."),
        scope=READ,
        input_schema={"type": "object", "properties": dict(_TARGET_PROPS)},
        output_schema=_out({"target": _STR}, ["target"]),
        annotations=_ann(True, False, True),
        handler=get_analytics_settings,
    ),
    Tool(
        name="set_analytics_settings",
        title="Choose what an item's analytics track",
        description=("Turn kinds of analytics on or off: " + ", ".join(f"{k} ({ap.LABELS[k].lower()})" for k in ap.KEYS)
                     + ". For one document, several (documents), a folder's defaults (folder + workspace), a "
                     "workspace's defaults (with enforce: a type it has off is off for every item in it), or "
                     "your own defaults (account: true). Types left out of settings are inherited; "
                     "use_defaults=true clears an item's or folder's own settings. Precedence: workspace "
                     "enforced > item > folder > workspace default > owner default. Turning a type off stops "
                     "collecting it from then on; delete lists types whose already collected data should be "
                     "deleted too (only where the type is now off). Owners (and workspace admins for items, "
                     "folders and the workspace) only."),
        scope=WRITE,
        input_schema={"type": "object", "properties": {
            **_TARGET_PROPS,
            "documents": {"type": "array", "items": {"type": "string"}, "maxItems": 200,
                          "description": "Several items' links or slugs: the same settings for each."},
            "settings": _SETTINGS,
            "use_defaults": {"type": "boolean", "default": False},
            "enforce": {"type": "boolean", "description": "workspace only"},
            "delete": {"type": "array", "items": {"type": "string", "enum": list(ap.KEYS)}}}},
        output_schema=_out({"target": _STR}, ["target"]),
        annotations=_ann(False, True, True),
        handler=set_analytics_settings,
        writes=True,
    ),
]

VIEWER_TOOLS: list[Tool] = [
    Tool(
        name="get_document_viewers",
        title="Who viewed a document",
        description=("Every view of one of the user's documents or files in a period, newest first: who (a "
                     "signed-in viewer's name and email, or an anonymous 'Visitor' with a short code that stays "
                     "the same for one browser), when, active time, how far they got (percent read, PDF pages, "
                     "video watched, slides), where from (city, region, country, timezone) and on what (device, "
                     "OS and browser with versions, in-app browsers like Slack or LinkedIn, installed app or "
                     "embedded), and the source (Slack, email, LinkedIn, Google, direct, a Markdrop page). Plus "
                     "totals and breakdowns; by_person=true adds one row per person. The owner's own views are "
                     "left out unless include_own. For an item in a workspace, its admins and editors see the "
                     "same; viewers get the counts only."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "document": {"type": "string", "description": "The document's link or slug."},
            "range": {"type": "string", "enum": list(ca.RANGES), "default": "30d"},
            "who": {"type": "string", "enum": list(dv.WHO), "default": "all"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 25},
            "include_own": {"type": "boolean", "default": False},
            "by_person": {"type": "boolean", "default": False}},
            "required": ["document"]},
        output_schema=_out({
            "slug": _STR, "range": _STR, "access": {"type": "string", "enum": ["full", "counts"]},
            "totals": {"type": "object"}, "url": _STR,
            "views": {"type": "array", "items": _VIEW}, "breakdowns": {"type": ["object", "null"]},
            "people": {"type": "array", "items": {"type": "object"}}},
            ["slug", "range", "access", "totals", "views"]),
        annotations=_ann(True, False, True),
        handler=get_document_viewers,
    ),
    Tool(
        name="get_view_timeline",
        title="What one viewer did",
        description=("The activity timeline of one view (a view id from get_document_viewers): opened, "
                     "sections read and for how long, jumps, PDF pages, slides, spreadsheet tabs, video "
                     "watched / paused / skipped, scroll depth, links opened, code copied, downloads, prints, "
                     "full screen, questions asked with Ask AI, sign-offs, when they left; with the view's "
                     "header (who, where from, on what, completion) and their other views of the item. Owner, "
                     "or a workspace item's admins and editors, only."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "document": {"type": "string", "description": "The document's link or slug."},
            "view_id": {"type": "string", "minLength": 24, "maxLength": 24}},
            "required": ["document", "view_id"]},
        output_schema=_out({"id": _STR, "viewer": {"type": "object"}, "started_at": _STR,
                            "active_s": _NUM, "completion": _NNUM, "steps": {"type": "array", "items": {"type": "object"}},
                            "text": _STR, "url": _STR},
                           ["id", "viewer", "started_at", "steps"]),
        annotations=_ann(True, False, True),
        handler=get_view_timeline,
    ),
]

VIEWER_TOOLS += SETTINGS_TOOLS
