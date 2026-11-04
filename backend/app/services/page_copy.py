"""Duplicating a page on the server (the MCP tool ``duplicate_page``).

The app's own **Duplicate** (frontend/src/components/pages/DuplicatePage.tsx)
does the same in the browser. Here:

* A duplicate is a read: the caller needs ``copy`` on the source (any reader,
  signed in), like ``document.copy_document``. The copy holds what *this*
  caller can read (``pages.content_for``: names and item labels they can't see
  stay out of the copy) and is owned by the caller. End-to-end encrypted pages
  and files are refused.
* The copy is never locked (the ``locked`` page property is dropped): it is the
  caller's own page.
* A Markdown document in the classic editor gives a classic copy.
* Its images are copies: each ``asset:<id>`` the page uses (in the body, the
  icon and the cover) that belongs to the source is read from storage and
  uploaded to the copy, so the copy owns new ids whose links follow the
  copy's access, never the source's. One that can't be read is left as it was
  (it shows as missing) and named in the result.
* Placement: inside ``parent`` (the caller must be able to add pages to it),
  or in ``workspace`` / ``folder`` (member or above), or else next to the
  original: in its parent when the caller may add pages there, else in its
  workspace and folder when the caller is a member there, else among the
  caller's personal pages (private, unless the original is plainly public,
  like a copy made with ``copy_document``). The copy's access is that of a
  new page in that place.
* ``include_subpages``: the sub-pages the caller can read are copied below the
  copy (and theirs, MAX_PAGES pages in all), and the copy's ``::page`` links
  point at them. A sub-page with access of its own is left out (its copy would
  follow the copy's access, which may be wider) and named.
"""

from __future__ import annotations

import logging
import re

from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import access, page_assets, page_props, pages, publicity, r2

log = logging.getLogger(__name__)

MAX_PAGES = 50
ENCRYPTED = ("End-to-end encrypted pages can't be duplicated on the server, because it can't read them. "
             "Open the page with its full link and use Save a copy from its menu.")
_PAGE_LINK = re.compile(r"(::page\{[^}\n]*?\bsrc=)(\"?)([A-Za-z0-9_-]+)\2")


def copy_title(title: str | None) -> str:
    return f"Copy of {(title or '').strip() or 'Untitled'}"[:200]


def _rewrite_assets(markdown: str, mapping: dict[str, str]) -> str:
    for old, new in mapping.items():
        markdown = re.sub(r"(asset\\?:)" + re.escape(old) + r"(?![A-Za-z0-9_-])",
                          lambda m, n=new: m.group(1) + n, markdown)
    return markdown


def _rewrite_page_links(markdown: str, mapping: dict[str, str]) -> str:
    if not mapping:
        return markdown
    return _PAGE_LINK.sub(lambda m: f"{m.group(1)}{m.group(2)}{mapping[m.group(3)]}{m.group(2)}"
                          if m.group(3) in mapping else m.group(0), markdown)


def _describe(markdown: str, asset_id: str) -> str:
    """What an image is called in the page: its alt text, or the icon / cover."""
    m = re.search(r"!\[([^\]\n]*)\]\(\s*<?asset\\?:" + re.escape(asset_id) + r"(?![A-Za-z0-9_-])", markdown)
    if m and m.group(1).strip():
        return m.group(1).strip()
    props = page_props.parse(markdown)
    if props.get("icon") == f"asset:{asset_id}":
        return "the icon"
    if props.get("cover") == f"asset:{asset_id}":
        return "the cover"
    return "an image"


async def _source_content(src: dict, actor: access.Actor, ctx: access.Ctx) -> str:
    content = await pages.content_for(actor, src, ctx) or ""
    if page_props.is_locked(content):
        content = page_props.apply(content, {"locked": None})
    return content


async def _copy_images(db: AsyncIOMotorDatabase, src: dict, copy: dict, content: str, user_id: str,
                       missing: list[str]) -> tuple[str, int]:
    ids = pages.asset_ids(content)
    if not ids:
        return content, 0
    rows = {r["_id"]: r for r in await db[page_assets.COLL].find(
        {"_id": {"$in": ids}, "doc_id": str(src["_id"])}, {"key": 1, "mime": 1}).to_list(length=len(ids))}
    mapping: dict[str, str] = {}
    for asset_id in ids:
        row = rows.get(asset_id)
        data = None
        if row is not None and r2.is_configured():
            try:
                data = await run_in_threadpool(r2.get_bytes, row["key"], page_assets.MAX_BYTES)
            except Exception:
                log.warning("reading page image %s failed", row.get("key"), exc_info=True)
        if not data:
            missing.append(_describe(content, asset_id))
            continue
        try:
            info = await page_assets.upload(db, copy, data, user_id=user_id)
        except HTTPException as exc:
            log.info("copying page image %s failed: %s", asset_id, exc.detail)
            missing.append(_describe(content, asset_id))
            continue
        mapping[asset_id] = info["id"]
    return _rewrite_assets(content, mapping), len(mapping)


async def _target(db: AsyncIOMotorDatabase, src: dict, user, actor: access.Actor,
                  ctx: access.Ctx) -> dict:
    """Where "next to the original" is for this caller (see the module doc)."""
    from app.models.workspace import role_allows
    from app.services import workspace as ws_service

    if src.get("parent_id") is not None:
        parent = await db["documents"].find_one({"_id": src["parent_id"]}, {"content": 0})
        if parent is not None and pages.is_page_capable(parent) \
                and (await access.can(actor, parent, "edit_content", ctx)).allowed:
            ws_id = parent.get("workspace_id")
            if not ws_id or role_allows(await ws_service.role_for(db, ws_id, user.id), "member"):
                return {"parent": parent["slug"]}
    ws_id = src.get("workspace_id")
    if ws_id and role_allows(await ws_service.role_for(db, ws_id, user.id), "member"):
        ws = await ctx.workspace(ws_id)
        if ws is not None and not getattr(ws, "deleting", False):
            return {"workspace": ws_id, "folder": src.get("folder_id")}
    return {}


async def duplicate(db: AsyncIOMotorDatabase, src: dict, user, actor: access.Actor, ctx: access.Ctx, *,
                    title: str | None = None, workspace: str | None = None, folder: str | None = None,
                    parent: str | None = None, include_subpages: bool = False) -> dict:
    """Copy ``src`` (see the module doc). ``workspace`` is a workspace id,
    ``folder`` a folder id or path in it, ``parent`` a page's slug. Returns
    ``{raw, placed, workspace_error, images_copied, images_missing, pages,
    skipped_own_access, skipped_over_limit, failed}``."""
    if user is None:
        raise HTTPException(status_code=401, detail="Sign in to duplicate a page.")
    await access.require(actor, src, "copy", ctx)
    if src.get("encrypted"):
        raise HTTPException(status_code=422, detail=ENCRYPTED)
    if src.get("kind") == "artifact":
        raise HTTPException(status_code=422, detail="That's a file, not a page: only pages and Markdown "
                                                    "documents can be duplicated.")
    if parent and (workspace or folder):
        raise HTTPException(status_code=422, detail="A sub-page lives in its parent's workspace and folder: "
                                                    "pass parent alone.")
    explicit = bool(parent or workspace or folder)
    if folder and not workspace:
        workspace = src.get("workspace_id")
        if not workspace:
            raise HTTPException(status_code=422, detail="That page isn't in a workspace: pass workspace "
                                                        "with folder.")
    place = {"parent": parent} if parent else ({"workspace": workspace, "folder": folder} if workspace else
                                               ({} if explicit else await _target(db, src, user, actor, ctx)))
    placed = "parent" if place.get("parent") else ("workspace" if place.get("workspace") else "personal")
    level = None
    if placed == "personal":
        require_auth = await publicity.workspace_requires_auth(db, src.get("workspace_id"))
        eff = await access.effective_doc(db, src)
        level = "link" if publicity.is_public(eff, require_auth=require_auth) else "private"

    result: dict = {"placed": placed, "workspace_error": None, "images_copied": 0, "images_missing": [],
                    "pages": 0, "skipped_own_access": [], "skipped_over_limit": 0, "failed": 0}

    async def one(row: dict, where: dict, new_title: str, *, top: bool) -> dict:
        content = await _source_content(row, actor, ctx)
        copy, _secret, error = await pages.create_page(
            db, user, actor, ctx, title=new_title, workspace=where.get("workspace"),
            folder=where.get("folder"), parent=where.get("parent"), content=content,
            access_level=where.get("level"))
        if top:
            result["workspace_error"] = error
        result["pages"] += 1
        if row.get("editor") != "blocks":
            # A document in the classic editor stays one (create_page makes pages).
            await db["documents"].update_one({"_id": copy["_id"]}, {"$set": {"editor": None}})
            copy["editor"] = None
        links: dict[str, str] = {}
        if include_subpages:
            for kid in await pages.children_rows(db, row["_id"]):
                if not (await access.can(actor, kid, "read", ctx)).allowed or not pages.is_page_capable(kid):
                    continue  # never named: the caller can't see it
                if kid.get("access_inherit") is False:
                    result["skipped_own_access"].append(kid.get("title") or kid["slug"])
                    continue
                if result["pages"] >= MAX_PAGES:
                    result["skipped_over_limit"] += 1
                    continue
                try:
                    kid_copy = await one(kid, {"parent": copy["slug"]}, kid.get("title") or "Untitled", top=False)
                except HTTPException:
                    log.info("copying sub-page %s failed", kid.get("slug"), exc_info=True)
                    result["failed"] += 1
                    continue
                links[kid["slug"]] = kid_copy["slug"]
        new, n = await _copy_images(db, row, copy, content, user.id, result["images_missing"])
        result["images_copied"] += n
        new = _rewrite_page_links(new, links)
        if new != content:
            # The copy's own image ids and sub-page links, in one more revision.
            from app.services import transitions

            fresh = await db["documents"].find_one({"_id": copy["_id"]}) or copy
            copy = await transitions.change(db, fresh, sets={"content": new, "updated_at": pages.now_utc()},
                                            inc={"rev": 1})
        return copy

    top_title = " ".join((title or "").split())[:200] or copy_title(
        src.get("title") or _heading(await pages.content_for(actor, src, ctx)))
    raw = await one(src, {**place, "level": level}, top_title, top=True)
    result["raw"] = await db["documents"].find_one({"_id": raw["_id"]}) or raw
    return result


def _heading(content: str | None) -> str | None:
    """The first heading of what the caller can read (names they can't see stay out)."""
    from app.services.doc_ref import heading_title

    return heading_title(page_props.split(content or "")[1][:400])
