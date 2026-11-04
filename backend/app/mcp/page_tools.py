"""MCP tools for pages (services/pages.py): create from a template, read with
embeds and images resolved for the caller, edit (whole page, a section, or an
append that works even while someone has the page open in the editor), embed
or mention other Markdrop items, sub-pages, and page images (base64, or a file
sent straight to storage: services/page_asset_uploads.py; copied between pages).

Every rule is the website's: ``access.can`` decides, ``doc_service.update_document``
saves (and refuses with 423 while someone holds the page's edit lock), and
``pages`` / ``page_assets`` do the rest. Errors come back as tool errors.
"""

from __future__ import annotations

import base64
import binascii
import re
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
    SLUG_ARG,
    Context,
    Tool,
    ToolError,
    _ann,
    _out,
    actor_of,
    http_message,
    jsonable,
    load_for,
    precheck_workspace,
    resolve_doc,
    resolve_workspace,
    slug_error,
    url_pair,
)
from app.services import access as access_service
from app.services import live, page_asset_uploads, page_assets, page_props, page_templates, pages, revalidate

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
            raise ToolError("A new page has no images yet: create it, add the image with "
                            "create_page_image_upload (a file) or upload_page_image (base64), then "
                            "set_page_properties with icon or cover asset:<id>.")
        try:
            page_props.validate(props)
        except ValueError as exc:
            raise ToolError(str(exc))
        if content is not None:
            content = page_props.apply(content, props)
            props = {}
    else:
        props = {}
    try:
        raw, _secret, error = await pages.create_page(
            ctx.db, ctx.user, actor_of(ctx), _actx(ctx), title=args["title"], workspace=ws_id,
            folder=args.get("folder") if ws_id else None, parent=parent_slug,
            template=args.get("template"), content=content, slug=args.get("slug") or None)
    except HTTPException as exc:
        raise ToolError(slug_error(args.get("slug"), exc))
    if props:
        # Properties on a page made from a template (or a folder's default): written into what it got.
        after = await _save(ctx, raw, page_props.apply(raw.get("content") or "", props), None)
        raw = after or raw
    out = {**await url_pair(ctx, raw), "slug": raw["slug"], "title": raw.get("title"),
           "editor": "blocks", "parent": parent_slug, "workspace_error": error,
           "template_id": raw.get("template_id")}
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
    from app.services import page_user_templates

    items = [{**{k: t[k] for k in ("id", "name", "description", "category")}, "scope": "builtin"}
             for t in page_templates.all_templates()]
    usable = await page_user_templates.all_usable(ctx.db, ctx.user)
    if args.get("workspace"):
        ws_id, _ws, _role = await resolve_workspace(ctx, args["workspace"])
        usable = [t for t in usable if t["workspace_id"] == ws_id]
    for t in usable:
        items.append({"id": t["id"], "name": t["name"], "description": t["description"],
                      "category": t.get("workspace_name") or "Personal", "scope": t["scope"],
                      "workspace_id": t["workspace_id"], "subpages": t["subpages"], "slug": t["slug"]})

    def line(t: dict) -> str:
        where = {"builtin": "built-in", "personal": "your template"}.get(
            t["scope"], f"workspace template in {t['category']}")
        return f"- {t['id']}: {t['name']} ({where})" + (f" — {t['description']}" if t["description"] else "")

    return "Page templates (pass the id to create_page as template):\n" + "\n".join(map(line, items)), \
        {"templates": items}


async def save_page_as_template(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import page_user_templates

    raw = await load_for(ctx, args["document"], "read", "read")
    ws_id = None
    if args.get("workspace"):
        ws_id, _f = await precheck_workspace(ctx, {"workspace": args["workspace"]})
    scope = args.get("scope")
    try:
        t = await page_user_templates.save_as_template(
            ctx.db, ctx.user, actor_of(ctx), _actx(ctx), raw, name=args.get("name"),
            description=args.get("description"), icon=args.get("icon"),
            include_subpages=bool(args.get("include_subpages")), scope=scope, workspace=ws_id)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    out = {k: t[k] for k in ("id", "slug", "name", "description", "scope", "workspace_id", "subpages")}
    where = "the workspace's templates" if t["scope"] == "workspace" else "your personal templates"
    subs = f" with {t['subpages']} sub-page{'s' if t['subpages'] != 1 else ''}" if t["subpages"] else ""
    return (f"Saved {t['name']!r}{subs} to {where} (id {t['id']}). Make a page from it with "
            f"create_page(template={t['id']!r})."), out


async def set_folder_default_template(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import page_user_templates

    ws_id, _ws, _role = await resolve_workspace(ctx, args["workspace"])
    try:
        out = await page_user_templates.set_folder_default(ctx.db, ctx.user, ws_id, args["folder"],
                                                           args.get("template"))
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    if out["default_template"]:
        return f"New pages in {out['folder']} now start from template {out['default_template']}.", out
    return f"New pages in {out['folder']} now start blank.", out


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
    as_template = args.get("template")
    if not changes and as_template is None:
        raise ToolError(f"Nothing to change: pass one of {', '.join(page_props.KEYS)} (null clears it), "
                        "or template.")
    note = ""
    if as_template is not None:
        from app.services import page_user_templates

        try:
            raw = await page_user_templates.set_template(ctx.db, ctx.user, actor_of(ctx), _actx(ctx), raw,
                                                         bool(as_template))
        except HTTPException as exc:
            raise ToolError(http_message(exc))
        note = (f" It is now a template (id {raw['_id']}): it shows in the New page gallery and "
                f"create_page(template={str(raw['_id'])!r}) starts a page from it; it no longer appears in "
                "lists or search." if as_template else " It is an ordinary page again.")
        if not changes:
            props = page_props.parse(raw.get("content"))
            out = {**await _result(ctx, raw), "properties": props, "template": bool(raw.get("template")),
                   "template_id": str(raw["_id"]) if raw.get("template") else None}
            return f"Updated {out['url']}.{note}", out
    for k in ("icon", "cover"):
        v = changes.get(k)
        if isinstance(v, str) and v.startswith("asset:"):
            if not await ctx.db["page_assets"].find_one({"_id": v[6:], "doc_id": str(raw["_id"])}, {"_id": 1}):
                raise ToolError(f"{v} isn't an image of this page. Upload it to this page first "
                                "(create_page_image_upload, or upload_page_image), or copy it here from "
                                "another page with copy_page_asset.")
    try:
        content = page_props.apply(raw.get("content") or "", changes)
    except ValueError as exc:
        raise ToolError(str(exc))
    after = await _save(ctx, raw, content, int(raw.get("rev") or 1))
    props = page_props.parse(after.get("content"))
    out = {**await _result(ctx, after), "properties": props, "template": bool(after.get("template")),
           "template_id": str(after["_id"]) if after.get("template") else None}
    return f"Updated the page properties of {out['url']}: " + ", ".join(
        f"{k}={props[k]}" for k in changes) + note, out


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


# ── Page AI (services/pages_ai.py) ────────────────────────────────────────────


async def _ai_job(ctx: Context, raw: dict, action: str):
    from app.services import pages_ai

    content = await pages.content_for(actor_of(ctx), raw, _actx(ctx))
    return pages_ai.Job(db=ctx.db, user=ctx.user, action=action, target=pages_ai.page_target(raw, content),
                        via="mcp")


def _ai_error(exc) -> ToolError:
    return ToolError(exc.detail)


async def translate_page(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import pages_ai

    raw = await load_for(ctx, args["document"], "edit_content", "translate")
    _editable_page(raw)
    job = await _ai_job(ctx, raw, "translate")
    try:
        gen = await pages_ai.translate_page(job, lang=args["language"], actor=actor_of(ctx), ctx=_actx(ctx))
        done = await pages_ai.collect(gen)
    except pages_ai.AIError as exc:
        raise _ai_error(exc)
    new = await ctx.db["documents"].find_one({"slug": done["slug"]}, {"content": 0})
    out = {**await url_pair(ctx, new), "slug": done["slug"], "title": done["title"],
           "language": pages_ai.language(args["language"]), "source": raw["slug"]}
    text = f"Created the translated page {done['title']!r}: {out['url']} (the original is unchanged)."
    if done.get("workspace_error"):
        text += f"\n{done['workspace_error']}"
    return text, out


async def summarize_page(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import pages_ai

    insert = bool(args.get("insert"))
    raw = await load_for(ctx, args["document"], "edit_content", "summarize")
    _editable_page(raw)
    job = await _ai_job(ctx, raw, "summary")
    try:
        done = await pages_ai.collect(await pages_ai.summary(job))
    except pages_ai.AIError as exc:
        raise _ai_error(exc)
    block = done["markdown"]
    out: dict[str, Any] = {"slug": raw["slug"], "markdown": block, "inserted": False, "trimmed": done["trimmed"]}
    if not insert:
        return (f"Summary of {raw['slug']} (not inserted; call again with insert: true to put it at the top):"
                f"\n\n{block}"), out
    _lock_check(raw, ctx)
    fresh = await ctx.db["documents"].find_one({"_id": raw["_id"]})
    after = await _save(ctx, fresh, pages_ai.with_summary(fresh.get("content") or "", block),
                        int(fresh.get("rev") or 1))
    out.update(await _result(ctx, after), inserted=True)
    return f"Added the summary at the top of {out['url']} (revision {out['rev']}):\n\n{block}", out


async def suggest_page_meta(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import pages_ai

    raw = await load_for(ctx, args["document"], "edit_content", "suggest a title for")
    _editable_page(raw)
    job = await _ai_job(ctx, raw, "meta")
    try:
        out = await pages_ai.meta(job)
    except pages_ai.AIError as exc:
        raise _ai_error(exc)
    out = {"slug": raw["slug"], "title": out["title"], "description": out["description"], "icon": out["icon"]}
    return (f"Suggested for {raw['slug']}: title {out['title']!r}, icon {out['icon'] or '(none)'}, description "
            f"{out['description']!r}. Nothing was changed: apply them with set_page_properties (icon) and "
            "update_document (title) if the user wants them."), out


async def export_page(ctx: Context, args: dict) -> tuple[str, dict]:
    """The page as portable Markdown or one HTML file; a .zip (images, sub-pages) as a link."""
    from app.services import page_export

    raw = await load_for(ctx, args["document"], "read", "export")
    if raw.get("encrypted"):
        raise ToolError(ENCRYPTED_READ + " It can't be exported here either.")
    actor = actor_of(ctx)
    actx = _actx(ctx)
    try:
        await page_export.check_allowed(actor, raw, actx)
    except page_export.ExportError as exc:
        raise ToolError(exc.message)
    fmt = "html" if args.get("format") == "html" else "md"
    sub = bool(args.get("include_subpages"))
    as_zip = sub or (bool(args.get("zip")) and fmt == "md")
    token_fmt = "zip" if as_zip and fmt == "md" else fmt
    try:
        p = await page_export.plan(ctx.db, raw, actor, actor, actx, fmt=token_fmt, subpages=sub)
    except page_export.ExportError as exc:
        raise ToolError(exc.message)
    token, exp = page_export.sign(raw["slug"], ctx.user.id, token_fmt, sub)
    url = page_export.download_url(raw["slug"], token)
    from datetime import datetime, timezone

    expires = datetime.fromtimestamp(exp, timezone.utc).isoformat().replace("+00:00", "Z")
    out: dict[str, Any] = {"slug": raw["slug"], "format": "markdown" if fmt == "md" else "html",
                           "filename": page_export.filename(p), "download_url": url, "expires_at": expires,
                           "pages": len(p.pages), "notes": list(p.notes)}
    if p.zip:
        what = f"{len(p.pages)} page{'s' if len(p.pages) != 1 else ''}"
        return (f"Exported {raw['slug']} as {out['filename']} ({what}, images included). Download it within "
                f"10 minutes (it needs no sign-in, so don't share the link): {url}"), out
    content = page_export.render(p.pages[0], fmt)
    if len(content) > MAX_RETURNED_CHARS:
        out["note"] = f"The export is longer than {MAX_RETURNED_CHARS:,} characters: download it instead."
        return f"{out['note']} {url}", out
    out["content"] = content
    if p.pages[0].images:
        out["note"] = ("The page's images aren't in this text (a public page's are linked); download_url gives "
                       + ("the HTML with them inlined." if fmt == "html" else "the same Markdown; zip: true "
                          "gives a .zip with the images."))
    return content, out

def _alt_of(name: str | None, alt: str | None = None) -> str:
    """Alt text for ![alt](asset:…): the one given, else the file's name
    without its extension. Brackets would end the alt early."""
    text = (alt or "").strip()
    if not text:
        base = (name or "image").replace("\\", "/").rsplit("/", 1)[-1]
        text = base.rsplit(".", 1)[0] if "." in base else base
    return " ".join(text.replace("[", " ").replace("]", " ").split())[:200] or "image"


def _image_out(info: dict, slug: str, alt: str) -> dict:
    asset = f"asset:{info['id']}"
    return {"asset": asset, "markdown": f"![{alt}]({asset})", "id": info["id"], "mime": info["mime"],
            "size": info["size"], "width": info.get("width"), "height": info.get("height"), "slug": slug}


async def _image_page(ctx: Context, document: str) -> dict:
    """A page the caller may add images to (edit_content, and its lock)."""
    raw = await load_for(ctx, document, "edit_content", "add images to")
    _editable_page(raw)
    try:
        await pages.check_page_lock(raw, actor_of(ctx), _actx(ctx))
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    return raw


def page_image_instructions(file_name: str, upload_id: str, part_size: int, parts: list[dict]) -> str:
    """The exact commands that send an image to its presigned URL(s): one curl
    for a one-part image (any image up to 20 MB with the default part size),
    else split + one curl per part, as create_upload's instructions."""
    import shlex

    url_ttl = settings.file_upload_url_ttl // 60
    then = (f'Then call complete_page_image_upload with upload_id "{upload_id}" (parts are optional: '
            "omitted, the parts storage received are used).")
    lines = [f"FILE={shlex.quote(file_name)}   # use the file's full path"]
    if len(parts) == 1:
        lines.append(f"curl -sS --fail -X PUT --upload-file \"$FILE\" '{parts[0]['url']}' -D - -o /dev/null "
                     "| grep -i '^etag'")
        head = (f"Upload {file_name} with the shell commands below (one PUT straight to storage; it prints "
                f"the part's ETag). {then}")
    else:
        prefix = f"/tmp/md-{upload_id}.part."
        lines.append(f'split -b {part_size} -d -a 4 "$FILE" {prefix}')
        for p in parts:
            n = int(p["part_number"])
            lines.append(f"printf '{n} '; curl -sS --fail -X PUT --upload-file {prefix}{n - 1:04d} "
                         f"'{p['url']}' -D - -o /dev/null | grep -i '^etag'")
        lines.append(f"rm -f {prefix}*")
        head = (f"Upload {file_name} in {len(parts)} part(s) of {part_size:,} bytes with the shell commands "
                f"below. Each curl prints the part number and its ETag. {then}")
    head += (f" The URL(s) expire in {url_ttl} minutes; calling create_page_image_upload again with the "
             "same arguments returns fresh ones for the same upload. Use curl --upload-file as shown: "
             "storage needs the Content-Length, so never stream from stdin.")
    return head + "\n\n" + "\n".join(lines)


async def create_page_image_upload(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await _image_page(ctx, args["document"])
    name = (args.get("file_name") or args.get("filename") or "").strip().replace("\\", "/").rsplit("/", 1)[-1][:255]
    if not name:
        raise ToolError("Pass file_name: the image's name with its extension, e.g. 'architecture.png'.")
    try:
        sess = await page_asset_uploads.create(
            ctx.db, ctx.user, raw, file_name=name, size_bytes=int(args["size_bytes"]), sha256=args["sha256"],
            content_type=args.get("content_type"), alt=(args.get("alt") or "").strip() or None)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    out = jsonable(sess)
    out["instructions"] = page_image_instructions(name, out["upload_id"], out["part_size"], out["parts"])
    return out["instructions"], out


async def complete_page_image_upload(ctx: Context, args: dict) -> tuple[str, dict]:
    from pydantic import ValidationError

    from app.schemas.files import UploadCompleteRequest

    try:
        parsed = UploadCompleteRequest(parts=args.get("parts") or None)
    except ValidationError:
        raise ToolError('parts must be a list of {"part_number": N, "etag": "..."}.')
    parts = [p.model_dump() for p in parsed.parts] if parsed.parts else None
    actor, actx = actor_of(ctx), _actx(ctx)

    async def authorize(page: dict) -> None:
        # Re-checked at complete: the caller may have lost the page since create.
        d = await access_service.can(actor, page, "edit_content", actx)
        if not d.allowed:
            raise HTTPException(status_code=403, detail=(
                f"You can no longer add images to {page['slug']}; the image was discarded."))
        await pages.check_page_lock(page, actor, actx)

    try:
        info = await page_asset_uploads.complete(ctx.db, ctx.user.id, args["upload_id"], parts,
                                                 authorize=authorize)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    alt = _alt_of(info.get("file_name"), info.get("alt"))
    out = {"state": "done", "upload_id": args["upload_id"], **_image_out(info, info["slug"], alt)}
    return (f"Uploaded the image to {info['slug']} (sha256 verified, {out['mime']}"
            + (f", {out['width']}x{out['height']}" if out.get("width") else "")
            + f"). Put this in the page where it belongs (update_page, replace_section or append_blocks): "
            f"{out['markdown']} — or make it the cover with set_page_properties cover=\"{out['asset']}\"."), out


async def copy_page_asset(ctx: Context, args: dict) -> tuple[str, dict]:
    source = await load_for(ctx, args["from_document"], "read", "read")
    if source.get("kind") == "artifact" or source.get("encrypted"):
        raise ToolError(f"{source['slug']} has no page images to copy.")
    target = await _image_page(ctx, args["to_document"])
    ref = (args.get("asset") or "").strip()
    m = re.search(r"asset:([A-Za-z0-9_-]{8,64})", ref) or re.fullmatch(r"([A-Za-z0-9_-]{8,64})", ref)
    if not m:
        raise ToolError("asset must be asset:<id> (as get_page lists the page's images) or the id alone.")
    asset_id = m.group(1)
    try:
        info = await page_assets.copy(ctx.db, source, asset_id, target, user_id=ctx.user.id)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    out = {**_image_out(info, target["slug"], _alt_of(None, args.get("alt"))), "from_slug": source["slug"],
           "from_asset": f"asset:{asset_id}"}
    return (f"Copied asset:{asset_id} from {source['slug']} to {target['slug']} as {out['asset']}. Put this in "
            f"that page (update_page, replace_section or append_blocks): {out['markdown']}, or make it its "
            f"cover with set_page_properties cover=\"{out['asset']}\"."), out


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
    "'![alt](asset:<id>)' (create_page_image_upload or upload_page_image) or '![alt](https://… \"caption\")', optionally "
    "'{width=\"60%\" align=\"left\"}' after it. Markdrop item: '::markdrop{src=\"<slug>\" "
    "mode=\"live|preview|card\"}'; mention: ':markdrop[Title]{src=\"<slug>\"}'. Sub-page link: "
    "'::page{src=\"<slug>\"}'; '::toc'; '::breadcrumb'. Bookmark: '::bookmark{url=\"https://…\" "
    "title=\"…\" description=\"…\"}'. Web embed (YouTube, Vimeo, Loom, Figma, Google Maps, CodePen only): "
    "'::embed{src=\"https://…\"}'. Person: ':person[Name]{id=\"<user id>\"}'; date: ':date[YYYY-MM-DD]'; "
    "key: ':kbd[⌘ K]'. Page properties go in front matter (icon, cover, cover_y, full_width, small_text, "
    "font, locked, allow_export): use set_page_properties."
)
_SYNTAX = PAGE_SYNTAX

PAGE_TOOLS: list[Tool] = [
    Tool(
        name="create_page",
        title="Create a page",
        description=("Create a Markdrop page (a document that opens in the block editor), optionally from a "
                     "template (see list_page_templates: a built-in id, or a workspace or personal template's "
                     "id or slug), in a workspace folder (a folder's default template applies when neither "
                     "template nor content is given), or inside another page "
                     "(parent: it then lives in that page's workspace and folder and has the same access). "
                     "slug sets its link: markdrop.in/<slug>, and on the workspace's domain "
                     "/<folders>/<parent pages>/<slug>; a taken slug is an error naming it (never a silent "
                     "rename); change it later with set_slug. "
                     "Always give the user the returned url. " + _SYNTAX),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "title": {"type": "string", "minLength": 1, "maxLength": 200},
            "workspace": {**_WORKSPACE_ARG, "description": "Optional: create it in this workspace (id, name or domain)."},
            "folder": {**_FOLDER_ARG, "description": "Optional: an existing folder of that workspace."},
            "parent": {**_DOC_REF, "description": "Optional: the page to put it inside (slug or link). The user "
                                                  "must be able to edit it."},
            "template": {"type": "string", "minLength": 1, "maxLength": 64, "description": (
                "Optional: a template from list_page_templates — a built-in id ("
                + ", ".join(t["id"] for t in page_templates.TEMPLATES)
                + ") or a workspace or personal template's id or slug. {{title}}, {{date}}, {{author}} (the "
                "user's name) and {{folder}} are filled in; its images and sub-pages are copied. Without "
                "template or content, a page in a folder with a default template starts from that; pass "
                "'blank' for an empty page.")},
            "slug": {**SLUG_ARG, "description": ("Optional: its link (random if omitted). 3-50 letters, digits, "
                                                 "- or _. If it is taken you get an error naming it.")},
            "content": {"type": "string", "maxLength": settings.max_content_chars,
                        "description": "Optional Markdown for the page (instead of a template)."},
            "properties": {"type": "object", "description": (
                "Optional page properties: icon (an emoji), cover (gallery:<name>, one of "
                f"{', '.join(page_props.GALLERY)}; or an https:// image), cover_y, full_width, "
                "small_text, font (default, serif, mono), locked.")},
        }, "required": ["title"]},
        output_schema=_out({**_URL_PROPS, "slug": {"type": "string"}, "title": _NULLABLE_STR,
                            "editor": {"type": "string"}, "parent": _NULLABLE_STR,
                            "workspace_error": _NULLABLE_STR, "template_id": _NULLABLE_STR},
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
        description="The page templates create_page accepts, each with its id: the built-in ones (feature "
                    "guide, how-to, QA plan, spec, meeting notes, runbook, blank), then the user's personal "
                    "templates and the templates of each workspace they're a member of (with their slug). "
                    "workspace: only the built-ins and that workspace's templates. Placeholders {{title}}, "
                    "{{date}}, {{author}} and {{folder}} are filled in on each new page.",
        scope=READ,
        input_schema={"type": "object", "properties": {
            "workspace": {**_WORKSPACE_ARG, "description": "Optional: list this workspace's templates (id, name "
                                                           "or domain) with the built-ins."}}},
        output_schema=_out({"templates": {"type": "array"}}),
        annotations=_ann(True, False, True),
        handler=list_page_templates,
    ),
    Tool(
        name="save_page_as_template",
        title="Save a page as a template",
        description=("Save a copy of a page as a template the user (scope personal) or their workspace "
                     "(scope workspace: the page's own workspace unless another is named; members and up) can "
                     "make new pages from. Its images are copied; include_subpages copies the sub-pages the "
                     "user can open too. Templates never appear in listings or search. Placeholders "
                     "{{title}}, {{date}}, {{author}} and {{folder}} in it are filled in on each new page. "
                     "To make the page itself a template instead, use set_page_properties(template=true)."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF,
            "name": {"type": "string", "maxLength": 120, "description": "Default: the page's title."},
            "description": {"type": "string", "maxLength": 300},
            "icon": {"type": "string", "maxLength": 16, "description": "Optional: an emoji."},
            "include_subpages": {"type": "boolean", "default": False},
            "scope": {"type": "string", "enum": ["workspace", "personal"],
                      "description": "Default: workspace for a page in a workspace, else personal."},
            "workspace": {**_WORKSPACE_ARG, "description": "Optional: save it to this workspace instead."},
        }, "required": ["document"]},
        output_schema=_out({"id": {"type": "string"}, "slug": {"type": "string"}, "name": {"type": "string"},
                            "description": {"type": "string"}, "scope": {"type": "string"},
                            "workspace_id": _NULLABLE_STR, "subpages": {"type": "integer"}},
                           ["id", "slug", "name", "scope"]),
        annotations=_ann(False, False, False),
        handler=save_page_as_template,
    ),
    Tool(
        name="set_folder_default_template",
        title="Set a folder's default template",
        description=("Choose the template New page starts from in a workspace folder (workspace admins): a "
                     "built-in id or one of that workspace's templates (id or slug); null for blank. People "
                     "making a page there can still choose blank or another template, and create_page in that "
                     "folder without template or content uses it."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "workspace": _WORKSPACE_ARG,
            "folder": {**_FOLDER_ARG, "description": "The folder (id or path, e.g. 'product-hub/02-prds')."},
            "template": {"type": ["string", "null"], "maxLength": 64},
        }, "required": ["workspace", "folder", "template"]},
        output_schema=_out({"folder_id": {"type": "string"}, "folder": _NULLABLE_STR,
                            "default_template": _NULLABLE_STR}, ["folder_id", "default_template"]),
        annotations=_ann(False, False, True),
        handler=set_folder_default_template,
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
        description=("Set a page's icon (an emoji, or asset:<id> of an image of this page), "
                     "cover (asset:<id> of an image of this page, an https:// image, or gallery:<name>, a "
                     f"built-in cover: {', '.join(page_props.GALLERY)}) and its focal point cover_y "
                     "(0 top .. 100 bottom), "
                     "full_width, small_text, font (default, serif, mono) and locked (only the owner or a "
                     "workspace admin may edit a locked page, or lock / unlock one) and allow_export (false: "
                     "readers can't export it; editors always can). Pass null to clear one. "
                     "An asset:<id> must belong to this page: add an image file with create_page_image_upload "
                     "then complete_page_image_upload (or base64 with upload_page_image), or copy one from "
                     "another page with copy_page_asset; it then shows to exactly the page's readers. "
                     "They live in the page's front matter. Refused while someone is editing the page. "
                     "template: true turns the page into a workspace (or personal) template, false back."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF,
            "icon": {"type": ["string", "null"], "maxLength": 80},
            "cover": {"type": ["string", "null"], "maxLength": 80,
                      "description": "asset:<id> (an image of this page), gallery:<name>, an https:// image, "
                                     "or null."},
            "cover_y": {"type": ["number", "null"], "minimum": 0, "maximum": 100},
            "full_width": {"type": ["boolean", "null"]},
            "small_text": {"type": ["boolean", "null"]},
            "font": {"type": ["string", "null"], "enum": ["default", "serif", "mono", None]},
            "locked": {"type": ["boolean", "null"]},
            "allow_export": {"type": ["boolean", "null"]},
            "template": {"type": "boolean", "description": (
                "true: the page itself becomes a template of its workspace (or the user's own, for a "
                "personal page): it leaves every list and search, and create_page(template=<its id or "
                "slug>) starts new pages from a copy of it. Top-level pages only; its sub-pages come with "
                "it. false: back to an ordinary page. Pages already made from it never change.")},
        }, "required": ["document"]},
        output_schema=_out({**_URL_PROPS, "slug": {"type": "string"}, "rev": {"type": "integer"},
                            "properties": {"type": "object"}, "template": {"type": "boolean"},
                            "template_id": _NULLABLE_STR}, ["url", "markdrop_url", "slug", "rev", "properties"]),
        annotations=_ann(False, False, True),
        handler=set_page_properties,
    ),
    Tool(
        name="upload_page_image",
        title="Add an image to a page",
        description=("Upload a PNG, JPEG, GIF or WebP image (base64, up to 10 MB) to a page. Returns the "
                     "Markdown to put in the page: ![alt](asset:<id>). Anyone who can read the page sees it, "
                     "nobody else. For an image file on a machine you can run shell commands on, and for any "
                     "image over a few hundred KB, use create_page_image_upload then "
                     "complete_page_image_upload instead (no base64, up to 20 MB): base64 in an argument "
                     "costs tokens and can be cut short."),
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
    Tool(
        name="translate_page",
        title="Translate a page",
        description=("Translate a page into another language as a NEW page next to it, titled 'Title (Español)' "
                     "and so on: same blocks, embeds, images and properties, in the same place (a sub-page stays "
                     "inside the same parent and inherits its access). Only the text is translated; the "
                     "structure is checked block by block before the page is created. The original page is not "
                     "changed. Uses Markdrop's AI (Claude Haiku), which counts towards the user's AI limits. "
                     "Give the user the returned url."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF,
            "language": {"type": "string", "minLength": 2, "maxLength": 40,
                         "description": "The language to translate into, e.g. Spanish, French, Japanese."},
        }, "required": ["document", "language"]},
        output_schema=_out({**_URL_PROPS, "slug": {"type": "string"}, "title": {"type": "string"},
                            "language": {"type": "string"}, "source": {"type": "string"}},
                           ["url", "markdrop_url", "slug", "title", "language", "source"]),
        annotations=_ann(False, False, False),
        handler=translate_page,
    ),
    Tool(
        name="summarize_page",
        title="Summarize a page",
        description=("Write a TL;DR of a page as a callout titled Summary (':::note[Summary]' … ':::'), with "
                     "Markdrop's AI. insert: true puts it at the top of the page (replacing an earlier Summary "
                     "callout there); otherwise it is only returned. Counts towards the user's AI limits."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF,
            "insert": {"type": "boolean", "default": False,
                       "description": "Add it at the top of the page (refused while someone is editing it)."},
        }, "required": ["document"]},
        output_schema=_out({**_URL_PROPS, "slug": {"type": "string"}, "markdown": {"type": "string"},
                            "inserted": {"type": "boolean"}, "trimmed": {"type": "boolean"},
                            "rev": {"type": "integer"}},
                           ["slug", "markdown", "inserted"]),
        annotations=_ann(False, False, False),
        handler=summarize_page,
    ),
    Tool(
        name="suggest_page_meta",
        title="Suggest a page's title and icon",
        description=("Suggest a title, a one-sentence description and an emoji icon for a page from its "
                     "content, with Markdrop's AI. Changes nothing; apply what the user accepts with "
                     "set_page_properties (icon) or update_document (title). Counts towards the user's AI limits."),
        scope=WRITE,
        # It changes nothing, but it is an AI call: the stricter write rate limit applies.
        writes=True,
        input_schema={"type": "object", "properties": {"document": _DOC_REF}, "required": ["document"]},
        output_schema=_out({"slug": {"type": "string"}, "title": _NULLABLE_STR, "description": _NULLABLE_STR,
                            "icon": _NULLABLE_STR}),
        annotations=_ann(True, False, False),
        handler=suggest_page_meta,
    ),
    Tool(
        name="export_page",
        title="Export a page",
        description=("Export a page (or any Markdown document) for use outside Markdrop: format markdown gives "
                     "portable Markdown (callouts become labelled quotes, columns follow one another, people and "
                     "dates become text, embedded Markdrop items become links, and items the user can't open "
                     "become 'Locked item'); format html gives one self-contained HTML file in the page's look. "
                     "The text comes back in the result. include_subpages (or zip: true for Markdown with its "
                     "images) returns a .zip as a download link valid for 10 minutes instead, with a folder per "
                     "sub-page the user can open. Readers can export only when the page allows it."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF,
            "format": {"type": "string", "enum": ["markdown", "html"], "default": "markdown"},
            "include_subpages": {"type": "boolean", "default": False},
            "zip": {"type": "boolean", "default": False,
                    "description": "Markdown only: a .zip with page.md and its images/ folder."},
        }, "required": ["document"]},
        output_schema=_out({
            "slug": {"type": "string"}, "format": {"type": "string"}, "filename": {"type": "string"},
            "download_url": {"type": "string"}, "expires_at": {"type": "string"}, "pages": {"type": "integer"},
            "notes": {"type": "array"}, "content": {"type": "string"}, "note": {"type": "string"},
        }, ["slug", "format", "filename", "download_url", "expires_at", "pages", "notes"]),
        annotations=_ann(True, False, True),
        handler=export_page,
    ),
    Tool(
        name="create_page_image_upload",
        title="Start a page image upload",
        description=(
            "Add an image file to a page without base64: from the machine you run shell commands on, a "
            f"PNG, JPEG, GIF or WebP up to {page_asset_uploads.MAX_BYTES // (1024 * 1024)} MB. Give the "
            "page, the file's name, exact size in bytes and sha256 (e.g. `wc -c < FILE` and "
            "`shasum -a 256 FILE`). Returns presigned part URLs plus the exact shell command(s) (curl) "
            "that send the bytes straight to storage; then call complete_page_image_upload, which "
            "returns asset:<id> and the Markdown ![alt](asset:<id>) to put in the page, or to pass as "
            "set_page_properties cover / icon. The image belongs to the page: anyone who can read the "
            "page sees it, nobody else. Never put file contents in an argument. An upload not completed "
            f"within {settings.page_image_upload_hours} hours is discarded."
        ),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": {**_DOC_REF, "description": "The page to add the image to (slug or link). The user "
                                                    "must be able to edit it."},
            "file_name": {"type": "string", "minLength": 1, "maxLength": 255,
                          "description": "The image's name with its extension, e.g. 'architecture.png'. "
                                         "Without alt, the name (minus the extension) is the alt text."},
            "filename": {"type": "string", "minLength": 1, "maxLength": 255,
                         "description": "Same as file_name (the name upload_page_image uses)."},
            "size_bytes": {"type": "integer", "minimum": 1,
                           "description": (f"Exact size in bytes (e.g. `wc -c < FILE`), at most "
                                           f"{page_asset_uploads.MAX_BYTES:,} (20 MB).")},
            "sha256": {"type": "string", "pattern": "^[0-9a-fA-F]{64}$",
                       "description": "Hex sha256 of the file; the upload is verified against it."},
            "content_type": {"type": "string", "maxLength": 100,
                             "description": "Optional: image/png, image/jpeg, image/gif or image/webp. The "
                                            "extension decides when omitted; the bytes are checked either way."},
            "alt": {"type": "string", "maxLength": 200,
                    "description": "Optional alt text (what the image shows) for the returned Markdown."},
        }, "required": ["document", "size_bytes", "sha256"]},
        output_schema=_out({
            "upload_id": {"type": "string"}, "part_size": {"type": "integer"},
            "parts": {"type": "array", "items": _out({"part_number": {"type": "integer"},
                                                       "url": {"type": "string"}})},
            "expires_at": {"type": "string"}, "instructions": {"type": "string"}, "slug": {"type": "string"},
        }),
        annotations=_ann(False, False, False),
        handler=create_page_image_upload,
    ),
    Tool(
        name="complete_page_image_upload",
        title="Finish a page image upload",
        description=(
            "Finish an upload started with create_page_image_upload, once the curl command(s) ran: "
            "storage assembles the parts, Markdrop checks the size, the sha256 and that the bytes are a "
            "PNG, JPEG, GIF or WebP image, then adds it to the page. Returns asset (asset:<id>) and "
            "markdown (![alt](asset:<id>)): put the markdown in the page with update_page, "
            "replace_section or append_blocks, or pass the asset to set_page_properties as cover or icon. "
            "A mismatch discards the upload and changes nothing. Safe to call again (the same image)."
        ),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "upload_id": {"type": "string", "minLength": 1, "maxLength": 64, "pattern": "^up_[A-Za-z0-9_-]+$",
                          "description": "The upload_id from create_page_image_upload."},
            "parts": {
                "type": "array", "maxItems": 10000,
                "description": ("Each part's number and the ETag its upload returned. Optional: omitted, "
                                "the parts storage received are used."),
                "items": {"type": "object", "properties": {
                    "part_number": {"type": "integer", "minimum": 1},
                    "etag": {"type": "string", "minLength": 1}},
                    "required": ["part_number", "etag"]},
            },
        }, "required": ["upload_id"]},
        output_schema=_out({
            "state": {"type": "string", "enum": ["done"]}, "upload_id": {"type": "string"},
            "asset": {"type": "string"}, "markdown": {"type": "string"}, "id": {"type": "string"},
            "mime": {"type": "string"}, "size": {"type": "integer"},
            "width": {"type": ["integer", "null"]}, "height": {"type": ["integer", "null"]},
            "slug": {"type": "string"},
        }, ["state", "upload_id", "asset", "markdown", "id", "mime", "size", "slug"]),
        annotations=_ann(False, False, True),
        handler=complete_page_image_upload,
    ),
    Tool(
        name="copy_page_asset",
        title="Copy an image to another page",
        description=(
            "Copy an image of one page (asset:<id>, as get_page lists it) to another page, as a new image "
            "of that page with its own asset:<id>: an asset only shows in its own page, so copying the "
            "Markdown alone doesn't work. The user must be able to read the source page and edit the "
            "target. Returns the new asset and the Markdown to put in the target page (or pass the asset "
            "to set_page_properties as its cover or icon)."
        ),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "from_document": {**_DOC_REF, "description": "The page the image is on (slug or link)."},
            "asset": {"type": "string", "minLength": 8, "maxLength": 80,
                      "description": "The image: asset:<id>, or the id alone."},
            "to_document": {**_DOC_REF, "description": "The page to copy it to (slug or link)."},
            "alt": {"type": "string", "maxLength": 200, "description": "Optional alt text for the Markdown."},
        }, "required": ["from_document", "asset", "to_document"]},
        output_schema=_out({
            "asset": {"type": "string"}, "markdown": {"type": "string"}, "id": {"type": "string"},
            "mime": {"type": "string"}, "size": {"type": "integer"},
            "width": {"type": ["integer", "null"]}, "height": {"type": ["integer", "null"]},
            "slug": {"type": "string"}, "from_slug": {"type": "string"}, "from_asset": {"type": "string"},
        }, ["asset", "markdown", "id", "mime", "size", "slug", "from_slug", "from_asset"]),
        annotations=_ann(False, False, False),
        handler=copy_page_asset,
    ),
]
