"""MCP tools for comment analytics (Track C; CONTRACT §12): ``comment_insights``.

The same numbers as the item's analytics panel (services/comments/analytics.py), for anyone who may see the
item's comments. Exports with comments are an option on ``export_page`` (mcp/page_tools.py); one item's comment
counts also come back in ``get_document_analytics`` (``comments``).
"""

from __future__ import annotations

from typing import Any

from app.mcp.auth import READ
from app.mcp.tools import _DOC_REF, Context, Tool, ToolError, _ann, _out, actor_of, http_message, load_for
from app.services import access as access_service

_NULL_NUM = {"type": ["number", "null"]}


async def comment_insights(ctx: Context, args: dict) -> tuple[str, dict]:
    from fastapi import HTTPException

    from app.services import md_outline
    from app.services.comments import analytics, perms

    raw = await load_for(ctx, args["document"], "read", "read")
    rng = args.get("range") or "30d"
    if rng not in analytics.RANGES:
        raise ToolError("range must be one of 7d, 30d, 90d or all.")
    try:
        await perms.require(ctx.db, actor_of(ctx), raw, access_service.Ctx(ctx.db, surface="mcp"), "view")
    except HTTPException as exc:
        raise ToolError(http_message(exc)) from exc
    stats = analytics.item_stats
    out: dict[str, Any] = await stats(ctx.db, raw, range_=rng)
    title = md_outline.display_title(raw)
    text = analytics.summary_line(out, title)
    result = {
        "slug": raw["slug"], "title": title, "range": out["range"], "counts": out["counts"],
        "first_reply": out["first_reply"], "resolve": out["resolve"],
        "sections": [{"title": s["title"], "threads": s["threads"], "open": s["open"], "messages": s["messages"]}
                     for s in out["sections"]],
        "people": [{"name": p["name"], "messages": p["messages"]} for p in out["people"]],
        "summary": text,
    }
    return text, result


INSIGHTS_TOOLS: list[Tool] = [
    Tool(
        name="comment_insights",
        title="Comment insights",
        description=("How the discussion on a page or Markdown document is going: open and resolved comment "
                     "threads, how long a first reply takes (median, in seconds) and how many open threads still "
                     "wait for one, how long threads take to resolve, which sections are discussed most, and who "
                     "comments most. For anyone who can see the item's comments. The text result is a short "
                     "summary you can quote."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF,
            "range": {"type": "string", "enum": ["7d", "30d", "90d", "all"], "default": "30d",
                      "description": "The period for the daily series; counts and times cover every thread."},
        }, "required": ["document"]},
        output_schema=_out({
            "slug": {"type": "string"}, "title": {"type": "string"}, "range": {"type": "string"},
            "counts": _out({"total": {"type": "integer"}, "open": {"type": "integer"}, "resolved": {"type": "integer"},
                            "messages": {"type": "integer"}, "participants": {"type": "integer"},
                            "changed": {"type": "integer"}}),
            "first_reply": _out({"median_s": _NULL_NUM, "avg_s": _NULL_NUM, "replied": {"type": "integer"},
                                 "waiting": {"type": "integer"}}),
            "resolve": _out({"median_s": _NULL_NUM, "resolved": {"type": "integer"}}),
            "sections": {"type": "array", "items": _out({"title": {"type": "string"}, "threads": {"type": "integer"},
                                                         "open": {"type": "integer"}, "messages": {"type": "integer"}})},
            "people": {"type": "array", "items": _out({"name": {"type": "string"}, "messages": {"type": "integer"}})},
            "summary": {"type": "string"},
        }),
        annotations=_ann(True, False, True),
        handler=comment_insights,
    ),
]
