"""MCP tool for a document's link: ``set_slug`` (services/document.change_slug).

The old link keeps working: it joins the document's ``old_slugs``, which only
that document can ever answer at again, and a reader who opens it — on
markdrop.in or on the workspace's own domain, folders and parent pages
included — is redirected to the new one. Embeds and mentions that name the
old slug resolve through it too, so nothing has to be rewritten.

A refused custom link is worded by tools.slug_error (shared with
publish_document and create_page; it always names the slug).
"""

from __future__ import annotations

from fastapi import HTTPException

from app.mcp.auth import WRITE
from app.mcp.tools import (
    _DOC_REF,
    TAKE_OVER_ARG,
    SLUG_ARG,
    _URL_PROPS,
    Context,
    Tool,
    ToolError,
    _ann,
    _out,
    actor_of,
    load_for,
    slug_error,
    url_pair,
)
from app.services import access as access_service


async def set_slug(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import document as doc_service

    raw = await load_for(ctx, args["document"], "rename_slug", "change the link of")
    new = (args.get("slug") or "").strip()
    old = raw["slug"]
    before = await url_pair(ctx, raw)
    if new == old:
        out = {**before, "slug": old, "previous_slug": None,
               "redirects_from": [s for s in (raw.get("old_slugs") or []) if isinstance(s, str)]}
        return f"That is already its link: {out['url']}", out
    try:
        after = await doc_service.change_slug(ctx.db, old, new, actor_of(ctx),
                                              access_service.Ctx(ctx.db, surface="mcp"))
    except HTTPException as exc:
        raise ToolError(slug_error(new, exc))
    out = {**await url_pair(ctx, after), "slug": after["slug"], "previous_slug": old,
           "redirects_from": [s for s in (after.get("old_slugs") or []) if isinstance(s, str)]}
    return (f"Changed the link to {out['url']}. The old link ({before['url']}) now redirects there, and "
            "embeds or mentions of the old slug keep working."), out


SLUG_TOOLS: list[Tool] = [
    Tool(
        name="set_slug",
        title="Change a document's link",
        description=("Change the link (slug) of a page, document or file the user owns: markdrop.in/<slug>, "
                     "and the last part of its address on its workspace's domain "
                     "(/<folders>/<parent pages>/<slug>). The old link keeps working and redirects to the new "
                     "one on markdrop.in and on the workspace's domain; embeds and mentions of the old slug "
                     "keep working too. Slugs: 3-50 letters, digits, - or _. A slug another document has (or "
                     "had), or that was deleted less than 30 days ago, is refused with an error naming it. "
                     "Refused while someone is editing the page (take_over: true for its owner or a workspace "
                     "admin). Always give the user the new url."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": {**_DOC_REF, "description": "The page or document (slug, old slug or link)."},
            "slug": {**SLUG_ARG, "description": "The new slug."},
            "take_over": TAKE_OVER_ARG,
        }, "required": ["document", "slug"]},
        output_schema=_out({**_URL_PROPS, "slug": {"type": "string"},
                            "previous_slug": {"type": ["string", "null"]},
                            "redirects_from": {"type": "array", "items": {"type": "string"}}},
                           ["url", "markdrop_url", "slug", "previous_slug", "redirects_from"]),
        annotations=_ann(False, False, True),
        handler=set_slug,
    ),
]
