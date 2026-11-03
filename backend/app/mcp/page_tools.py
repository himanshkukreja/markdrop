"""MCP tools for pages (services/pages.py): create from a template, read with
embeds and images resolved for the caller, edit (whole page, a section, or an
append that works even while someone has the page open in the editor), embed
or mention other Markdrop items, sub-pages, and page images.

Every rule is the website's: ``access.can`` decides, ``doc_service.update_document``
saves (and refuses with 423 while someone holds the page's edit lock), and
``pages`` / ``page_assets`` do the rest. Errors come back as tool errors.
"""

from __future__ import annotations

import base64
import binascii
from typing import Any

from fastapi import HTTPException

from app.config import get_settings
from app.mcp.auth import READ, WRITE
from app.mcp.tools import (
    _DOC_REF,
    _FOLDER_ARG,
    _NULLABLE_STR,
    _URL_PROPS,
    _WORKSPACE_ARG,
    ENCRYPTED_READ,
    ENCRYPTED_WRITE,
    MAX_RETURNED_CHARS,
    Context,
    Tool,
    ToolError,
    _ann,
    _out,
    actor_of,
    http_message,
    load_for,
    precheck_workspace,
    resolve_doc,
    url_pair,
)
from app.services import access as access_service
from app.services import live, page_assets, page_props, page_templates, pages, revalidate

settings = get_settings()

MAX_IMAGE_B64 = (page_assets.MAX_BYTES * 4) // 3 + 8
NOT_A_PAGE = ("That's a file, not a Markdown document, so it can't be edited as a page. "
              "Use get_document / get_file_info for files.")


def _actx(ctx: Context) -> access_service.Ctx:
    return access_service.Ctx(ctx.db, surface="mcp")


def _editable_page(raw: dict) -> None:
    if raw.get("encrypted"):
        raise ToolError(ENCRYPTED_WRITE)
    if raw.get("kind") == "artifact":
        raise ToolError(NOT_A_PAGE)


async def _slug_of(ctx: Context, value: str) -> str:
    return (await resolve_doc(ctx, value)).slug


async def _save(ctx: Context, raw: dict, content: str, base_rev: int | None) -> dict:
    """Save through the website's own path (lock 423, base_rev 409, limits)."""
    from pydantic import ValidationError

    from app.schemas.document import DocumentUpdate
    from app.services import document as doc_service

    if len(content) > settings.max_content_chars:
        raise ToolError(f"Pages are limited to {settings.max_content_chars:,} characters.")
    _check_embeds(content, raw.get("content"))
    try:
        data = DocumentUpdate(title=raw.get("title"), content=content or "\n", base_rev=base_rev)
    except ValidationError:
        raise ToolError("That content isn't valid.")
    try:
        return await doc_service.update_document(ctx.db, raw["slug"], data, actor_of(ctx), _actx(ctx))
    except HTTPException as exc:
        if exc.status_code == 409 and base_rev is not None:
            raise ToolError(f"The page changed since revision {base_rev} (it is at revision "
                            f"{(exc.headers or {}).get('X-Markdrop-Rev', 'newer')}). Read it again with "
                            "get_page and redo the change.")
        raise ToolError(http_message(exc))


def _check_embeds(new: str, old: str | None = None) -> None:
    """Refuse web embeds (``::embed{src}``) from providers outside the allowlist
    (ones already on the page are left alone)."""
    from app.services import web_embeds

    bad = [b for b in web_embeds.check_markdown(new) if b not in set(web_embeds.check_markdown(old or ""))]
    if bad:
        raise ToolError(f"Only links from {web_embeds.providers_text()} can be web embeds (::embed); "
                        f"{bad[0]!r} isn't one. Use '::bookmark{{url=\"…\"}}' or a plain link for other sites.")


def _lock_check(raw: dict, ctx: Context) -> None:
    try:
        pages.check_write_lock(raw, actor_of(ctx))
    except HTTPException as exc:
        raise ToolError(http_message(exc))


async def _append(ctx: Context, raw: dict, block: str) -> dict:
    """Add ``block`` at the end of the page, even while someone holds its edit
    lock (their editor inserts it live: the socket gets ``appended``)."""
    from datetime import datetime, timezone

    _check_embeds(block)
    for _ in range(5):
        cur = await ctx.db["documents"].find_one({"_id": raw["_id"]})
        if cur is None:
            raise ToolError("That page was deleted meanwhile.")
        try:
            await pages.check_page_lock(cur, actor_of(ctx), _actx(ctx), pages.appended(cur.get("content") or "", block))
        except HTTPException as exc:
            raise ToolError(http_message(exc))
        content = pages.appended(cur.get("content") or "", block)
        if len(content) > settings.max_content_chars:
            raise ToolError(f"Pages are limited to {settings.max_content_chars:,} characters.")
        rev = int(cur.get("rev") or 1)
        q: dict = {"_id": cur["_id"]}
        q["rev"] = rev if "rev" in cur else {"$exists": False}
        after = await ctx.db["documents"].find_one_and_update(
            q, {"$set": {"content": content, "updated_at": datetime.now(timezone.utc)}, "$inc": {"rev": 1}},
            return_document=True)
        if after is not None:
            from app.services import page_history

            await page_history.on_save(ctx.db, cur, after, actor_of(ctx))
            new_rev = int(after.get("rev") or 1)
            live.notify(after["slug"], {"type": "appended", "rev": new_rev, "markdown": block.strip("\n")})
            live.publish(after["slug"], new_rev)
            await revalidate.purge_doc(ctx.db, after)
            from app.services import page_links

            await page_links.reindex(ctx.db, after)
            return after
    raise ToolError("The page kept changing while this was being added. Try again.")


async def _result(ctx: Context, after: dict) -> dict:
    return {**await url_pair(ctx, after), "slug": after["slug"], "rev": int(after.get("rev") or 1)}


# ── Handlers ──────────────────────────────────────────────────────────────────


async def create_page(ctx: Context, args: dict) -> tuple[str, dict]:
    parent = args.get("parent")
    if parent and (args.get("workspace") or args.get("folder")):
        raise ToolError("A sub-page lives in its parent's workspace and folder: pass parent alone.")
    ws_id = None
    if not parent:
        ws_id, _folder_id = await precheck_workspace(ctx, args)
    parent_slug = None
    if parent:
        parent_raw = await load_for(ctx, parent, "edit_content", "add pages to")
        parent_slug = parent_raw["slug"]
    content = args.get("content")
    if content:
        _check_embeds(content)
    if args.get("properties"):
        props = {k: v for k, v in args["properties"].items() if k in page_props.KEYS}
        if any(str(v or "").startswith("asset:") for v in props.values()):
            raise ToolError("A new page has no images yet: create it, upload_page_image, then "
                            "set_page_properties with icon or cover asset:<id>.")
        if content is None and args.get("template"):
            tpl = page_templates.get(args["template"])
            content = page_templates.fill(tpl["content"], title=args["title"]) if tpl else None
        try:
            content = page_props.apply(content or "", props)
        except ValueError as exc:
            raise ToolError(str(exc))
    try:
        raw, _secret, error = await pages.create_page(
            ctx.db, ctx.user, actor_of(ctx), _actx(ctx), title=args["title"], workspace=ws_id,
            folder=args.get("folder") if ws_id else None, parent=parent_slug,
            template=args.get("template"), content=content)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    out = {**await url_pair(ctx, raw), "slug": raw["slug"], "title": raw.get("title"),
           "editor": "blocks", "parent": parent_slug, "workspace_error": error}
    where = f" inside {parent_slug}" if parent_slug else ""
    text = f"Created the page {out['title']!r}{where}: {out['url']}"
    if error:
        text += f"\n{error}"
    return text, out


async def get_page(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await load_for(ctx, args["document"], "read", "read")
    if raw.get("encrypted"):
        raise ToolError(ENCRYPTED_READ)
    if raw.get("kind") == "artifact":
        raise ToolError(NOT_A_PAGE)
    actor = actor_of(ctx)
    actx = _actx(ctx)
    fields = await pages.page_fields(ctx.db, raw, actor, actx)
    kids = await pages.children_listing(ctx.db, raw, actor, actx)
    refs = pages.embed_refs(raw.get("content"))
    resolved = await pages.resolve_embeds(ctx.db, actor, actx, [r["slug"] for r in refs])
    embeds = []
    for r in refs:
        e = resolved.get(r["slug"]) or {"state": "missing"}
        item: dict[str, Any] = {"slug": r["slug"], "as": "link" if r["mention"] else "embed", "state": e["state"]}
        if e["state"] == "ok":
            item.update(title=e.get("title"), kind=e.get("kind"), url=e.get("url"))
        embeds.append(item)
    content = await pages.content_for(actor, raw, actx) or ""
    note = None
    if len(content) > MAX_RETURNED_CHARS:
        content = content[:MAX_RETURNED_CHARS]
        note = f"Only the first {MAX_RETURNED_CHARS:,} characters are included."
    out: dict[str, Any] = {
        **await url_pair(ctx, raw),
        "slug": raw["slug"],
        "title": raw.get("title"),
        "markdown": content,
        "rev": int(raw.get("rev") or 1),
        "editor": raw.get("editor") or "classic",
        "parent": fields["parent"],
        "properties": {k: v for k, v in fields["page"].items() if k not in ("icon_url", "cover_url")},
        "children": [{"slug": k["slug"], "title": k["title"]} for k in kids],
        "embeds": embeds,
        "assets": [{"id": i, "url": a["url"]} for i, a in fields["assets"].items()],
    }
    if note:
        out["note"] = note
    lock = pages.lock_view(raw.get("edit_lock"))
    if lock:
        out["editing"] = lock["name"]
    head = f"{raw.get('title') or raw['slug']} ({out['url']}), revision {out['rev']}"
    if lock:
        head += (f". {lock['name']} is editing it right now: update_page, replace_section and "
                 "insert_embed after a heading will be refused until they stop; append_blocks still works")
    return f"{head}\n\n{content}", out


async def update_page(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await load_for(ctx, args["document"], "edit_content", "update")
    _editable_page(raw)
    after = await _save(ctx, raw, args["markdown"], int(args["base_rev"]))
    out = await _result(ctx, after)
    return f"Updated {out['url']} (revision {out['rev']}).", out


async def append_blocks(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await load_for(ctx, args["document"], "edit_content", "update")
    _editable_page(raw)
    if not (args.get("markdown") or "").strip():
        raise ToolError("Nothing to add.")
    after = await _append(ctx, raw, args["markdown"])
    out = await _result(ctx, after)
    return f"Added to the end of {out['url']} (revision {out['rev']}).", out


async def replace_section(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await load_for(ctx, args["document"], "edit_content", "update")
    _editable_page(raw)
    _lock_check(raw, ctx)
    content = pages.replace_section(raw.get("content") or "", args["heading"], args["markdown"])
    if content is None:
        names = [t for _i, _l, t in pages.headings(raw.get("content") or "")][:40]
        raise ToolError(f"There's no heading {args['heading']!r} on that page."
                        + (f" Its headings: {', '.join(names)}." if names else " It has no headings."))
    after = await _save(ctx, raw, content, int(raw.get("rev") or 1))
    out = await _result(ctx, after)
    return f"Replaced the section {args['heading']!r} on {out['url']} (revision {out['rev']}).", out


async def insert_embed(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await load_for(ctx, args["document"], "edit_content", "update")
    _editable_page(raw)
    item = await load_for(ctx, args["item"], "read", "embed")
    as_ = args.get("as") or "embed"
    if as_ == "link":
        from app.services.doc_ref import heading_title

        title = item.get("title") or item.get("original_filename") or (
            heading_title((item.get("content") or "")[:400]) if item.get("kind") != "artifact" else None)
        block = pages.mention(item["slug"], title)
    else:
        mode = args.get("mode") or ("live" if item.get("kind") == "artifact" else "card")
        block = pages.embed_block(item["slug"], mode)
    heading = args.get("after_heading")
    if heading:
        _lock_check(raw, ctx)
        content = pages.insert_after_section(raw.get("content") or "", heading, block)
        if content is None:
            raise ToolError(f"There's no heading {heading!r} on that page.")
        after = await _save(ctx, raw, content, int(raw.get("rev") or 1))
    else:
        after = await _append(ctx, raw, block)
    out = {**await _result(ctx, after), "item": item["slug"], "as": as_, "markdown": block}
    note = ""
    d = await access_service.can(access_service.Actor(), item, "read", access_service.Ctx(ctx.db))
    if not d.allowed:
        note = (" People who can read the page but not that item see a locked placeholder instead "
                "(no title).")
    return f"Inserted {item['slug']} into {out['url']} as {'a link' if as_ == 'link' else 'an embed'}.{note}", out


async def list_page_templates(ctx: Context, args: dict) -> tuple[str, dict]:
    items = [{k: t[k] for k in ("id", "name", "description", "category")} for t in page_templates.all_templates()]
    return "Page templates:\n" + "\n".join(f"- {t['id']}: {t['name']} — {t['description']}" for t in items), \
        {"templates": items}


async def list_subpages(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import urls as urls_service

    raw = await load_for(ctx, args["document"], "read", "read")
    kids = await pages.children_listing(ctx.db, raw, actor_of(ctx), _actx(ctx))
    rows = []
    for k in kids:
        child = await ctx.db["documents"].find_one({"slug": k["slug"]}, {"content": 0})
        url = (await urls_service.workspace_url(ctx.db, child)) if child else None
        rows.append({**k, "url": url or urls_service.markdrop_url(k["slug"])})
    out = {"slug": raw["slug"], "children": rows}
    if not rows:
        return f"{raw['slug']} has no sub-pages you can open.", out
    return f"Pages inside {raw['slug']}:\n" + "\n".join(f"- {r['title']}: {r['url']}" for r in rows), out


async def move_page(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await load_for(ctx, args["document"], "edit_content", "move")
    parent = args.get("parent")
    parent_slug = None
    if parent:
        parent_slug = (await load_for(ctx, parent, "edit_content", "add pages to"))["slug"]
    try:
        after = await pages.move(ctx.db, raw, parent_slug, actor_of(ctx), _actx(ctx),
                                 confirm=bool(args.get("confirm_access_change")))
    except pages.PageError as exc:
        if exc.body.get("code") == "access_change":
            raise ToolError(f"Moving it there changes who can read it: now {exc.body['readers_before']}; "
                            f"after the move {exc.body['readers_after']}. Ask the user, then call move_page "
                            "again with confirm_access_change: true.")
        raise ToolError(http_message(exc))
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    out = {**await url_pair(ctx, after), "slug": after["slug"], "parent": parent_slug}
    return (f"Moved {after['slug']} " + (f"inside {parent_slug}" if parent_slug else "to the top level")
            + f": {out['url']}"), out


async def set_page_properties(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await load_for(ctx, args["document"], "edit_content", "update")
    _editable_page(raw)
    changes = {k: args[k] for k in page_props.KEYS if k in args}
    if not changes:
        raise ToolError(f"Nothing to change: pass one of {', '.join(page_props.KEYS)} (null clears it).")
    for k in ("icon", "cover"):
        v = changes.get(k)
        if isinstance(v, str) and v.startswith("asset:"):
            if not await ctx.db["page_assets"].find_one({"_id": v[6:], "doc_id": str(raw["_id"])}, {"_id": 1}):
                raise ToolError(f"{v} isn't an image of this page: upload it with upload_page_image first.")
    try:
        content = page_props.apply(raw.get("content") or "", changes)
    except ValueError as exc:
        raise ToolError(str(exc))
    after = await _save(ctx, raw, content, int(raw.get("rev") or 1))
    props = page_props.parse(after.get("content"))
    out = {**await _result(ctx, after), "properties": props}
    return f"Updated the page properties of {out['url']}: " + ", ".join(
        f"{k}={props[k]}" for k in changes), out


async def upload_page_image(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await load_for(ctx, args["document"], "edit_content", "add images to")
    _editable_page(raw)
    try:
        await pages.check_page_lock(raw, actor_of(ctx), _actx(ctx))
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    text = (args.get("content_base64") or "").strip()
    if text.startswith("data:") and "," in text:
        text = text.split(",", 1)[1]
    if len(text) > MAX_IMAGE_B64:
        raise ToolError("Images in a page can be up to 10 MB.")
    try:
        data = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        raise ToolError("content_base64 isn't valid base64.")
    try:
        info = await page_assets.upload(ctx.db, raw, data, user_id=ctx.user.id)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    name = (args.get("filename") or "image").replace("\\", "/").rsplit("/", 1)[-1]
    alt = name.rsplit(".", 1)[0].replace("[", " ").replace("]", " ").strip() or "image"
    markdown = f"![{alt}](asset:{info['id']})"
    out = {**info, "slug": raw["slug"], "markdown": markdown}
    return (f"Uploaded {name} to {raw['slug']}. Put this in the page where it belongs (update_page, "
            f"replace_section or append_blocks): {markdown}"), out


# ── Schemas ───────────────────────────────────────────────────────────────────

_PAGE_RESULT = _out({**_URL_PROPS, "slug": {"type": "string"}, "rev": {"type": "integer"}},
                    ["url", "markdrop_url", "slug", "rev"])
_MARKDOWN = {"type": "string", "minLength": 1, "maxLength": settings.max_content_chars}
# What AI apps may write in a page (the block editor round-trips all of it). Kept in one place;
# the docs page "Page Markdown reference" (frontend/content/docs/pages/markdown-reference.md) spells
# out every block. Exactly what the editor reads and writes: nothing it doesn't.
PAGE_SYNTAX = (
    "Page Markdown: GitHub Markdown (# ## ### headings, **bold** *italic* ~~strike~~ `code`, links, > quotes, "
    "---, nested - and 1. lists, '- [ ]' / '- [x]' to-dos, tables, ``` code; ```mermaid draws a diagram; "
    "$math$ and $$ blocks) plus directives. Callout: ':::note' … ':::' (also tip, warning, danger), with an "
    "optional '[Title]' and '{icon=\"💡\" color=\"blue\"}'. Toggle: ':::details{summary=\"Title\"}' … ':::'; "
    "toggle heading: ':::details{summary=\"Title\" heading=2}' (1-3). Colours (gray, brown, orange, yellow, "
    "green, blue, purple, pink, red): inline ':span[text]{color=\"red\"}' or ':span[text]{bg=\"yellow\"}' "
    "(one, not both), underline ':u[text]'. Block options go in braces at the end of a block's line: "
    "'A paragraph. {#b-k3x9a1 color=\"green\"}' (a link name '#b-' plus 4-12 lowercase letters or digits "
    "first, then color or bg), '## Title {bg=\"blue\"}', '- Item {bg=\"pink\"}', a table cell "
    "'| Ada {bg=\"yellow\"} |'; after a code block, divider or equation they go on the next line "
    "('{caption=\"…\"}' after a code fence), and after a table on a line of their own after a blank line "
    "('{header-column widths=\"120,240,\" header-row=\"off\"}'). Columns: "
    "'::::columns' then ':::column{width=\"40%\"}' … ':::' per column (2-5), closed by '::::' (an outer fence "
    "has more colons than the ones inside). Nesting: ':::indent' … ':::' after a block. A button that "
    "inserts its blocks when clicked (readers don't see it): ':::button{label=\"Add a task\"}' … ':::'. Image: "
    "'![alt](asset:<id>)' (upload_page_image) or '![alt](https://… \"caption\")', optionally "
    "'{width=\"60%\" align=\"left\"}' after it. Markdrop item: '::markdrop{src=\"<slug>\" "
    "mode=\"live|preview|card\"}'; mention: ':markdrop[Title]{src=\"<slug>\"}'. Sub-page link: "
    "'::page{src=\"<slug>\"}'; '::toc'; '::breadcrumb'. Bookmark: '::bookmark{url=\"https://…\" "
    "title=\"…\" description=\"…\"}'. Web embed (YouTube, Vimeo, Loom, Figma, Google Maps, CodePen only): "
    "'::embed{src=\"https://…\"}'. Person: ':person[Name]{id=\"<user id>\"}'; date: ':date[YYYY-MM-DD]'; "
    "key: ':kbd[⌘ K]'. Page properties go in front matter (icon, cover, cover_y, full_width, small_text, "
    "font, locked): use set_page_properties."
)
_SYNTAX = PAGE_SYNTAX

PAGE_TOOLS: list[Tool] = [
    Tool(
        name="create_page",
        title="Create a page",
        description=("Create a Markdrop page (a document that opens in the block editor), optionally from a "
                     "template (see list_page_templates), in a workspace folder, or inside another page "
                     "(parent: it then lives in that page's workspace and folder and has the same access). "
                     "Always give the user the returned url. " + _SYNTAX),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "title": {"type": "string", "minLength": 1, "maxLength": 200},
            "workspace": {**_WORKSPACE_ARG, "description": "Optional: create it in this workspace (id, name or domain)."},
            "folder": {**_FOLDER_ARG, "description": "Optional: an existing folder of that workspace."},
            "parent": {**_DOC_REF, "description": "Optional: the page to put it inside (slug or link). The user "
                                                  "must be able to edit it."},
            "template": {"type": "string", "enum": [t["id"] for t in page_templates.TEMPLATES]},
            "content": {"type": "string", "maxLength": settings.max_content_chars,
                        "description": "Optional Markdown for the page (instead of a template)."},
            "properties": {"type": "object", "description": (
                "Optional page properties: icon (an emoji), cover (gallery:<name>, one of "
                f"{', '.join(page_props.GALLERY)}; or an https:// image), cover_y, full_width, "
                "small_text, font (default, serif, mono), locked.")},
        }, "required": ["title"]},
        output_schema=_out({**_URL_PROPS, "slug": {"type": "string"}, "title": _NULLABLE_STR,
                            "editor": {"type": "string"}, "parent": _NULLABLE_STR,
                            "workspace_error": _NULLABLE_STR},
                           ["url", "markdrop_url", "slug", "title", "editor"]),
        annotations=_ann(False, False, False),
        handler=create_page,
    ),
    Tool(
        name="get_page",
        title="Read a page",
        description=("Read a page (or any Markdown document) for editing: its Markdown, revision (pass it to "
                     "update_page as base_rev), parent and sub-pages, the Markdrop items it embeds or mentions "
                     "(each with whether the user can open it) and its images. " + _SYNTAX),
        scope=READ,
        input_schema={"type": "object", "properties": {"document": _DOC_REF}, "required": ["document"]},
        output_schema=_out({
            **_URL_PROPS, "slug": {"type": "string"}, "title": _NULLABLE_STR, "markdown": {"type": "string"},
            "rev": {"type": "integer"}, "editor": {"type": "string"}, "parent": {"type": ["object", "null"]},
            "children": {"type": "array"}, "embeds": {"type": "array"}, "assets": {"type": "array"},
            "editing": {"type": "string"}, "note": {"type": "string"}, "properties": {"type": "object"},
        }, ["url", "markdrop_url", "slug", "title", "markdown", "rev", "editor", "parent", "children",
            "embeds", "assets"]),
        annotations=_ann(True, False, True),
        handler=get_page,
    ),
    Tool(
        name="update_page",
        title="Replace a page",
        description=("Replace a page's whole Markdown. base_rev is the rev get_page returned: if the page "
                     "changed since, nothing is saved. Refused while someone has the page open in the editor "
                     "(try again in a minute, or use append_blocks). Keep the front matter get_page "
                     "returned at the top. " + PAGE_SYNTAX),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF, "markdown": _MARKDOWN,
            "base_rev": {"type": "integer", "minimum": 1},
        }, "required": ["document", "markdown", "base_rev"]},
        output_schema=_PAGE_RESULT,
        annotations=_ann(False, True, True),
        handler=update_page,
    ),
    Tool(
        name="append_blocks",
        title="Add to the end of a page",
        description=("Add Markdown blocks at the end of a page. Works even while someone is editing it: "
                     "their editor shows the new blocks at once. " + PAGE_SYNTAX),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {"document": _DOC_REF, "markdown": _MARKDOWN},
                      "required": ["document", "markdown"]},
        output_schema=_PAGE_RESULT,
        annotations=_ann(False, False, False),
        handler=append_blocks,
    ),
    Tool(
        name="replace_section",
        title="Replace a section of a page",
        description=("Replace one section of a page: from the heading named (matched ignoring case) to the "
                     "next heading of the same or a higher level. The heading is kept unless the new Markdown "
                     "starts with a heading of its own. Refused while someone is editing the page. "
                     + PAGE_SYNTAX),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF,
            "heading": {"type": "string", "minLength": 1, "maxLength": 300,
                        "description": "The section's heading text, e.g. 'Rollout'."},
            "markdown": {"type": "string", "maxLength": settings.max_content_chars},
        }, "required": ["document", "heading", "markdown"]},
        output_schema=_PAGE_RESULT,
        annotations=_ann(False, True, True),
        handler=replace_section,
    ),
    Tool(
        name="insert_embed",
        title="Embed or mention an item in a page",
        description=("Put an existing Markdrop item (document, PDF, video, image, HTML page, spreadsheet…) "
                     "into a page, as an embedded block or as an inline link (mention). The user must be able "
                     "to open the item; readers of the page who can't open it see a locked placeholder. "
                     "Added at the end, or at the end of the section after_heading names (refused while "
                     "someone is editing the page; at the end it always works)."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": {**_DOC_REF, "description": "The page to add it to (slug or link)."},
            "item": {**_DOC_REF, "description": "The item to embed or mention (slug or link)."},
            "as": {"type": "string", "enum": ["embed", "link"], "default": "embed"},
            "mode": {"type": "string", "enum": ["live", "preview", "card"],
                     "description": "For an embed: live (the item itself), preview, or a card. Default: live "
                                    "for files, card for documents."},
            "after_heading": {"type": "string", "minLength": 1, "maxLength": 300},
        }, "required": ["document", "item"]},
        output_schema=_out({**_URL_PROPS, "slug": {"type": "string"}, "rev": {"type": "integer"},
                            "item": {"type": "string"}, "as": {"type": "string"}, "markdown": {"type": "string"}},
                           ["url", "markdrop_url", "slug", "rev", "item", "as", "markdown"]),
        annotations=_ann(False, False, False),
        handler=insert_embed,
    ),
    Tool(
        name="list_page_templates",
        title="List page templates",
        description="The built-in page templates create_page accepts (feature guide, how-to, QA plan, spec, "
                    "meeting notes, runbook, blank).",
        scope=READ,
        input_schema={"type": "object", "properties": {}},
        output_schema=_out({"templates": {"type": "array"}}),
        annotations=_ann(True, False, True),
        handler=list_page_templates,
    ),
    Tool(
        name="list_subpages",
        title="List a page's sub-pages",
        description="The pages inside a page that the user can open, with their links.",
        scope=READ,
        input_schema={"type": "object", "properties": {"document": _DOC_REF}, "required": ["document"]},
        output_schema=_out({"slug": {"type": "string"}, "children": {"type": "array"}}),
        annotations=_ann(True, False, True),
        handler=list_subpages,
    ),
    Tool(
        name="move_page",
        title="Move a page",
        description=("Put a page inside another page (parent), or at the top level (parent null). Pages move "
                     "within their workspace. If that changes who can read the page, the result says how and "
                     "asks for confirm_access_change: true — confirm with the user first."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF,
            "parent": {"type": ["string", "null"], "maxLength": 2048,
                       "description": "The new parent page (slug or link), or null for the top level."},
            "confirm_access_change": {"type": "boolean", "default": False},
        }, "required": ["document"]},
        output_schema=_out({**_URL_PROPS, "slug": {"type": "string"}, "parent": _NULLABLE_STR},
                           ["url", "markdrop_url", "slug", "parent"]),
        annotations=_ann(False, False, True),
        handler=move_page,
    ),
    Tool(
        name="set_page_properties",
        title="Set a page's properties",
        description=("Set a page's icon (an emoji, or asset:<id> of an image uploaded with upload_page_image), "
                     "cover (asset:<id>, an https:// image, or gallery:<name>, a built-in cover: "
                     f"{', '.join(page_props.GALLERY)}) and its focal point cover_y (0 top .. 100 bottom), "
                     "full_width, small_text, font (default, serif, mono) and locked (only the owner or a "
                     "workspace admin may edit a locked page, or lock / unlock one). Pass null to clear one. "
                     "They live in the page's front matter. Refused while someone is editing the page."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF,
            "icon": {"type": ["string", "null"], "maxLength": 80},
            "cover": {"type": ["string", "null"], "maxLength": 80},
            "cover_y": {"type": ["number", "null"], "minimum": 0, "maximum": 100},
            "full_width": {"type": ["boolean", "null"]},
            "small_text": {"type": ["boolean", "null"]},
            "font": {"type": ["string", "null"], "enum": ["default", "serif", "mono", None]},
            "locked": {"type": ["boolean", "null"]},
        }, "required": ["document"]},
        output_schema=_out({**_URL_PROPS, "slug": {"type": "string"}, "rev": {"type": "integer"},
                            "properties": {"type": "object"}}, ["url", "markdrop_url", "slug", "rev", "properties"]),
        annotations=_ann(False, False, True),
        handler=set_page_properties,
    ),
    Tool(
        name="upload_page_image",
        title="Add an image to a page",
        description=("Upload a PNG, JPEG, GIF or WebP image (base64, up to 10 MB) to a page. Returns the "
                     "Markdown to put in the page: ![alt](asset:<id>). Anyone who can read the page sees it, "
                     "nobody else."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF,
            "filename": {"type": "string", "minLength": 1, "maxLength": 200},
            "content_base64": {"type": "string", "minLength": 4, "maxLength": MAX_IMAGE_B64 + 64},
        }, "required": ["document", "filename", "content_base64"]},
        output_schema=_out({"id": {"type": "string"}, "mime": {"type": "string"}, "size": {"type": "integer"},
                            "width": {"type": ["integer", "null"]}, "height": {"type": ["integer", "null"]},
                            "slug": {"type": "string"}, "markdown": {"type": "string"}},
                           ["id", "mime", "size", "slug", "markdown"]),
        annotations=_ann(False, False, False),
        handler=upload_page_image,
    ),
]
