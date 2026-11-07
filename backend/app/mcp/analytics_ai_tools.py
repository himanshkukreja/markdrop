"""MCP tools for Analytics AI on the analytics home (services/analytics_ai_home.py):
``analytics_story``, ``ask_analytics`` and ``content_gaps``.

READ scope; the same service calls as the web board (``via=mcp``), the same access rules and the
same limits (ledger feature ``analytics_ai``). Links come back absolute (the app's analytics pages).
"""

from __future__ import annotations

from app.config import get_settings
from app.mcp.auth import READ
from app.mcp.tools import Context, Tool, ToolError, _ann, _out
from app.services import analytics_ai_home as aah
from app.services import pages_ai


def _abs(href: str | None) -> str | None:
    if not href:
        return href
    return get_settings().frontend_url.rstrip("/") + href if href.startswith("/") else href


async def analytics_story(ctx: Context, args: dict) -> tuple[str, dict]:
    rng = args.get("range") or "7d"
    if rng not in aah.STORY_RANGES:
        raise ToolError("range must be one of 7d, 30d or 90d.")
    res = await aah.story(ctx.db, ctx.user.id, rng, fresh=bool(args.get("refresh")), via="mcp")
    status = res.get("status")
    if status in ("thin", "limit", "error"):
        out = {"status": status, "range": rng, "headline": "", "bullets": [],
               "message": res.get("message") or ""}
        return out["message"], out
    bullets = [{"text": b["text"], "url": _abs(b["href"]),
                "document": (b.get("doc") or {}).get("slug")} for b in res["bullets"]]
    out = {"status": "ok", "range": rng, "headline": res["headline"], "bullets": bullets,
           "message": "", "cached": bool(res.get("cached"))}
    text = res["headline"] + "\n" + "\n".join(f"- {b['text']} ({b['url']})" for b in bullets)
    return text, out


async def ask_analytics(ctx: Context, args: dict) -> tuple[str, dict]:
    rng = args.get("range")
    if rng is not None and rng not in aah.ASK_RANGES:
        raise ToolError("range must be one of 7d, 30d, 90d or all.")
    gen = aah.ask(ctx.db, ctx.user.id, args["question"], range_key=rng, via="mcp")
    try:
        done = await aah.collect(gen)
    except pages_ai.AIError as exc:
        raise ToolError(exc.detail)
    links = [{"title": lk["title"], "url": _abs(lk["href"])} for lk in done.get("links") or []]
    answer = done.get("answer") or ""
    # Relative links in the answer become absolute for a client outside the app.
    for lk in done.get("links") or []:
        answer = answer.replace(f"]({lk['href']})", f"]({_abs(lk['href'])})")
    out = {"answer": answer, "links": links}
    return answer, out


async def content_gaps(ctx: Context, args: dict) -> tuple[str, dict]:
    scope = args.get("scope") or ""
    try:
        res = await aah.gaps(ctx.db, ctx.user.id, scope, fresh=bool(args.get("refresh")), via="mcp")
    except aah.Forbidden as exc:
        raise ToolError(str(exc))
    except ValueError:
        scopes = await aah.gap_scopes(ctx.db, ctx.user.id)
        names = ", ".join(f"{s['scope']} ({s['label']})" for s in scopes) or "none"
        raise ToolError(f"scope must be workspace:<id> or personal. Yours: {names}.")
    gaps = [{"topic": g["topic"], "count": g["count"], "why": g["why"], "outline": g["outline"],
             "examples": g["examples"], "markdown": g["markdown"]} for g in res.get("gaps") or []]
    out = {"status": res["status"], "scope": res["scope"], "label": res["label"], "gaps": gaps,
           "message": res.get("message") or "",
           "create_in_workspace": (res.get("create") or {}).get("workspace")}
    if res["status"] != "ok":
        return out["message"], out
    text = "\n".join(f"- {g['topic']} ({g['count']}×): {g['why']}" for g in gaps) or "No gaps found."
    text += "\n\nTo write one, call create_page with its markdown (and the workspace)."
    return text, out


_STR = {"type": "string"}

ANALYTICS_AI_TOOLS: list[Tool] = [
    Tool(
        name="analytics_story",
        title="What changed in my analytics (AI)",
        description=("The analytics home's Insights story: 3-5 sentences on what changed in the user's views "
                     "over the range and the likely cause (a document, a referrer, a new version, a device or "
                     "country shift), each with a link to look closer. Markdrop's AI writes it from "
                     "aggregate numbers only (no visitor data). Cached for the day; refresh=true writes it "
                     "again. Counts towards the user's AI limits."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "range": {"type": "string", "enum": list(aah.STORY_RANGES), "default": "7d"},
            "refresh": {"type": "boolean", "default": False}}},
        output_schema=_out({
            "status": {"type": "string", "enum": ["ok", "thin", "limit", "error"]},
            "range": _STR, "headline": _STR, "message": _STR, "cached": {"type": "boolean"},
            "bullets": {"type": "array", "items": _out({"text": _STR, "url": _STR,
                                                         "document": {"type": ["string", "null"]}})}},
            ["status", "range", "headline", "bullets"]),
        annotations=_ann(True, False, True),
        handler=analytics_story,
    ),
    Tool(
        name="ask_analytics",
        title="Ask about my analytics (AI)",
        description=("Ask a question about the user's own analytics in plain words (\"which PDF did people "
                     "read most last month?\", \"where did the spike on Tuesday come from?\"). Markdrop's AI "
                     "picks from a fixed set of server-side queries over the user's own documents and answers "
                     "briefly with links to their analytics pages. Counts towards the user's AI limits. For "
                     "raw numbers on one document, get_document_analytics is cheaper."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "question": {"type": "string", "minLength": 1, "maxLength": aah.MAX_QUESTION},
            "range": {"type": "string", "enum": list(aah.ASK_RANGES),
                      "description": "Optional: the period to use unless the question names one."}},
            "required": ["question"]},
        output_schema=_out({"answer": _STR, "links": {"type": "array", "items": _out({"title": _STR, "url": _STR})}}),
        annotations=_ann(True, False, False),
        handler=ask_analytics,
    ),
    Tool(
        name="content_gaps",
        title="What people couldn't find (AI)",
        description=("Content gaps: what people searched for in a workspace (no results, or results nobody "
                     "opened) and asked a guide's AI assistant without an answer, over the last 30 days, "
                     "grouped by Markdrop's AI into pages worth writing, each with a count, why, an "
                     "outline and ready-to-use markdown for create_page. Workspace owners and admins only "
                     "(scope workspace:<id>), or the user's own personal Guides (scope personal). Only "
                     "anonymous query text is used. Counts towards the user's AI limits."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "scope": {"type": "string", "maxLength": 80, "description": "workspace:<workspace id> or personal"},
            "refresh": {"type": "boolean", "default": False}},
            "required": ["scope"]},
        output_schema=_out({
            "status": {"type": "string", "enum": ["ok", "thin", "limit", "error"]},
            "scope": _STR, "label": _STR, "message": _STR,
            "create_in_workspace": {"type": ["string", "null"]},
            "gaps": {"type": "array", "items": _out({
                "topic": _STR, "count": {"type": "integer"}, "why": _STR,
                "outline": {"type": "array", "items": _STR}, "examples": {"type": "array", "items": _STR},
                "markdown": _STR})}},
            ["status", "scope", "label", "gaps"]),
        annotations=_ann(True, False, True),
        handler=content_gaps,
    ),
]
