"""MCP tools for viewer analytics (services/doc_views.py): ``get_document_viewers`` and
``get_view_timeline``.

READ scope. The web Viewers tab's rules exactly (doc_views.access_level): the item's owner, and for
an item filed in a workspace its admins and editors, see who viewed and what they did; someone who
can only view a workspace item gets the counts. Anonymous viewers stay anonymous ("Visitor 3F2A").
"""

from __future__ import annotations

from app.config import get_settings
from app.mcp.auth import READ
from app.mcp.tools import Context, Tool, ToolError, _ann, _out, actor_of, load_for
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


_VIEW = {"type": "object"}

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
