"""Workspace and personal page templates: pages saved as templates.

A template is an ordinary ``documents`` row (a page, ``editor: "blocks"``) with
``template: True``. It is edited in the same editor, at its own slug, and it is
hidden from every listing, search and tree (``access.NOT_TEMPLATE`` is in
``access.readable_filter``'s base and in every owner/grant listing).

Scope
-----
* **Workspace template** — ``workspace_id`` set, ``access_level: "workspace"``:
  members (member, admin, owner) list it and make pages from it; viewers and
  non-members never see it. Saving one needs member+. Renaming, reordering and
  deleting: the workspace's admins and owner, and the member who saved it.
* **Personal template** — no workspace, ``access_level: "private"``: only its
  owner sees, uses and manages it.

Fields: ``template_description``, ``template_icon`` (an emoji; else the page's
own icon), ``template_order`` (lower first), ``template_saved_from`` (the slug
it was saved from). Its name is the row's ``title``. A template's sub-pages are
templates too (``template: True``, ``parent_id`` the template).

Using one
---------
``POST /api/v1/pages {template: <id>}`` (and MCP ``create_page``): the new page
gets the template's Markdown with ``{{date}}``, ``{{author}}`` and ``{{title}}``
filled in, a ``locked`` property dropped, and a copy of every page image the
template references, so the new page owns them (``pa/<new doc>/<new id>``) and
they follow the new page's access. Sub-pages come along, each with its own
images.
"""

from __future__ import annotations

import logging
import re
import secrets
from datetime import datetime, timezone

from bson import ObjectId
from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.models.workspace import role_allows
from app.services import access

log = logging.getLogger(__name__)

MAX_PER_SCOPE = 200
MAX_SUBPAGES = 100
NAME_MAX = 120
DESCRIPTION_MAX = 300
ICON_MAX = 16
EXCERPT_CHARS = 280
_ID_RE = re.compile(r"^[0-9a-f]{24}$")
_NO_CONTENT = {"content": 0}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def is_template_id(value: str | None) -> bool:
    return bool(value) and bool(_ID_RE.match(value or ""))


def _clean(text: str | None, limit: int) -> str:
    return " ".join((text or "").split())[:limit]


def _icon(value: str | None) -> str | None:
    """An emoji (a few characters, no markup) or None."""
    v = (value or "").strip()
    if not v:
        return None
    if len(v) > ICON_MAX or any(c in v for c in "<>\"'`\\/:{}[]()") or v.isascii():
        raise HTTPException(status_code=422, detail="A template's icon is an emoji.")
    return v


# ── Placeholders ──────────────────────────────────────────────────────────────


PLACEHOLDERS = ("{{title}}", "{{date}}", "{{author}}", "{{folder}}")


def fill(text: str | None, *, title: str, author: str, now: datetime | None = None,
         folder: str | None = None) -> str:
    """``{{date}}`` (e.g. "November 4, 2026"), ``{{author}}`` (the creator's
    display name), ``{{title}}`` and — when ``folder`` is given — ``{{folder}}``
    (the name of the folder the new page lands in; empty when it has none)."""
    d = now or now_utc()
    when = f"{d:%B} {d.day}, {d:%Y}"
    out = (text or "").replace("{{date}}", when).replace("{{author}}", author).replace("{{title}}", title)
    return out.replace("{{folder}}", folder) if folder is not None else out


async def folder_name(db: AsyncIOMotorDatabase, row: dict | None) -> str:
    """The name of the folder ``row`` is filed in ("" when none)."""
    fid = (row or {}).get("folder_id")
    if not fid or not ObjectId.is_valid(str(fid)):
        return ""
    f = await db["folders"].find_one({"_id": ObjectId(str(fid))}, {"name": 1})
    return (f or {}).get("name") or ""


async def fill_folder(db: AsyncIOMotorDatabase, raw: dict) -> dict:
    """After a page from a template is filed: its ``{{folder}}``, then the row."""
    content = raw.get("content") or ""
    if "{{folder}}" not in content:
        return raw
    from app.services import page_links

    name = await folder_name(db, raw)
    after = await db["documents"].find_one_and_update(
        {"_id": raw["_id"]}, {"$set": {"content": content.replace("{{folder}}", name)}}, return_document=True)
    if after is not None:
        await page_links.reindex(db, after)
    return after or raw


def _unlocked(markdown: str) -> str:
    """The Markdown without a ``locked`` page property (a new page starts open)."""
    from app.services import page_props

    if not page_props.is_locked(markdown):
        return markdown
    try:
        return page_props.apply(markdown, {"locked": None})
    except ValueError:  # pragma: no cover - front matter we can't rewrite: keep it
        return markdown


# ── Who may do what ───────────────────────────────────────────────────────────


async def _role(db: AsyncIOMotorDatabase, ws_id: str | None, user) -> str | None:
    from app.services import workspace as ws_service

    if not ws_id or user is None:
        return None
    return await ws_service.role_for(db, ws_id, user.id)


async def can_use(db: AsyncIOMotorDatabase, raw: dict, user) -> bool:
    """List it, preview it and make pages from it."""
    if user is None or not raw or not raw.get("template") or raw.get("parent_id") is not None:
        return False
    ws_id = raw.get("workspace_id")
    if ws_id:
        return role_allows(await _role(db, ws_id, user), "member")
    return raw.get("owner_id") == user.id


async def can_manage(db: AsyncIOMotorDatabase, raw: dict, user) -> bool:
    """Rename, reorder and delete it."""
    if not await can_use(db, raw, user):
        return False
    ws_id = raw.get("workspace_id")
    if ws_id:
        return raw.get("owner_id") == user.id or role_allows(await _role(db, ws_id, user), "admin")
    return True


async def find(db: AsyncIOMotorDatabase, ref: str | None) -> dict | None:
    """A template's row by its id or its page's slug (current or former)."""
    ref = (ref or "").strip()
    if not ref:
        return None
    if is_template_id(ref):
        hit = await db["documents"].find_one({"_id": ObjectId(ref), "template": True, "parent_id": None})
        if hit is not None:
            return hit
    from app.services.pages import SLUG_RE

    if not SLUG_RE.match(ref):
        return None
    return await db["documents"].find_one({"$or": [{"slug": ref}, {"old_slugs": ref}], "template": True,
                                           "parent_id": None})


async def load(db: AsyncIOMotorDatabase, template_id: str, user, *, manage: bool = False) -> dict:
    """The template's row (by id or slug), or 404 (never confirming that it
    exists to someone who can't use it); 403 when they can use it but not
    manage it."""
    raw = await find(db, template_id)
    if raw is None or not await can_use(db, raw, user):
        raise HTTPException(status_code=404, detail="Template not found")
    if manage and not await can_manage(db, raw, user):
        raise HTTPException(status_code=403, detail="Only the workspace's admins (or whoever saved it) can "
                                                    "change this template.")
    return raw


# ── Views ─────────────────────────────────────────────────────────────────────


def _excerpt(markdown: str | None) -> str:
    from app.services import page_props

    _lines, body = page_props.split(markdown)
    text = re.sub(r"[#>*_`|~\[\]]+", " ", body or "")
    text = re.sub(r"^:{2,}\S*.*$", " ", text, flags=re.M)
    return _clean(text, EXCERPT_CHARS)


async def view(db: AsyncIOMotorDatabase, raw: dict, user, *, content: bool = False,
               names: dict | None = None) -> dict:
    from app.services import page_assets, page_props, pages

    props = page_props.parse(raw.get("content"))
    page_icon = props.get("icon")
    icon_url = None
    if isinstance(page_icon, str) and page_icon.startswith("asset:"):
        hit = (await page_assets.urls_for(db, raw, [page_icon[6:]])).get(page_icon[6:])
        icon_url = hit["url"] if hit else None
        page_icon = None
    subpages = await db["documents"].count_documents({"parent_id": raw["_id"]})
    owner = raw.get("owner_id")
    if names is None or owner not in names:
        names = {**(names or {}), **await _names(db, [owner])}
    out = {
        "id": str(raw["_id"]),
        "slug": raw["slug"],
        "name": raw.get("title") or "Untitled template",
        "description": raw.get("template_description") or "",
        "icon": raw.get("template_icon") or page_icon,
        "icon_url": icon_url if not raw.get("template_icon") else None,
        "scope": "workspace" if raw.get("workspace_id") else "personal",
        "workspace_id": raw.get("workspace_id"),
        "order": int(raw.get("template_order") or 0),
        "subpages": subpages,
        "created_by": names.get(owner),
        "updated_at": pages.iso(raw.get("updated_at")),
        "excerpt": _excerpt(raw.get("content")),
        "cover": props.get("cover") if not str(props.get("cover") or "").startswith("asset:") else None,
        "can_manage": await can_manage(db, raw, user),
    }
    if content:
        out["content"] = raw.get("content") or ""
        out["assets"] = await page_assets.urls_for(db, raw, pages.asset_ids(raw.get("content")))
    return out


async def _names(db: AsyncIOMotorDatabase, ids: list) -> dict:
    oids = [ObjectId(i) for i in ids if i and ObjectId.is_valid(i)]
    if not oids:
        return {}
    rows = await db["users"].find({"_id": {"$in": oids}}, {"name": 1, "email": 1}).to_list(length=len(oids))
    out = {}
    for r in rows:
        name = (r.get("name") or "").strip() or (r.get("email") or "").split("@", 1)[0] or "Someone"
        out[str(r["_id"])] = name
    return out


def _scope_query(ws_id: str | None, user) -> dict:
    if ws_id:
        return {"template": True, "parent_id": None, "workspace_id": ws_id}
    return {"template": True, "parent_id": None, "workspace_id": None, "owner_id": user.id}


async def _rows(db: AsyncIOMotorDatabase, ws_id: str | None, user) -> list[dict]:
    return await db["documents"].find(_scope_query(ws_id, user)).sort(
        [("template_order", 1), ("created_at", 1), ("_id", 1)]).to_list(length=MAX_PER_SCOPE)


async def listing(db: AsyncIOMotorDatabase, user, workspace_id: str | None, folder: str | None = None, *,
                  personal: bool = True, manage: bool = True) -> dict:
    """``{builtin, workspace, personal, workspace_id, workspace_name, workspace_role,
    can_save_workspace, can_reorder_workspace, folder}`` for the New page gallery.
    ``workspace`` is empty unless the caller is a member+ of ``workspace_id``.
    ``personal=False`` leaves the caller's own templates out and ``manage=False``
    every way to change one (the workspace's own domain: it reads, it doesn't manage)."""
    from app.services import page_templates
    from app.services import workspace as ws_service

    out: dict = {"builtin": page_templates.all_templates(), "workspace": [], "personal": [],
                 "workspace_id": None, "workspace_name": None, "workspace_role": None,
                 "can_save_workspace": False, "can_reorder_workspace": False, "folder": None}
    if user is None:
        return out
    if workspace_id and folder:
        out["folder"] = await folder_info(db, user, workspace_id, folder)
        if out["folder"] is not None and not manage:
            out["folder"]["can_set_default"] = False
    role = await _role(db, workspace_id, user) if workspace_id else None
    if workspace_id and role is not None:
        ws = await ws_service.get_workspace(db, workspace_id)
        out["workspace_id"] = workspace_id
        out["workspace_name"] = ws.name if ws else None
        out["workspace_role"] = role
        out["can_save_workspace"] = manage and role_allows(role, "member")
        out["can_reorder_workspace"] = manage and role_allows(role, "admin")
        if role_allows(role, "member"):
            rows = await _rows(db, workspace_id, user)
            names = await _names(db, [r.get("owner_id") for r in rows])
            out["workspace"] = [await view(db, r, user, names=names) for r in rows]
    if personal:
        rows = await _rows(db, None, user)
        names = await _names(db, [user.id])
        out["personal"] = [await view(db, r, user, names=names) for r in rows]
    if not manage:
        for t in out["workspace"]:
            t["can_manage"] = False
    return out


async def listing_for_parent(db: AsyncIOMotorDatabase, user, actor: access.Actor, ctx: access.Ctx,
                             parent: str, *, workspace_id: str | None = None, tenant: bool = False) -> dict:
    """The gallery for a sub-page of ``parent`` (a slug): the parent's
    workspace's templates (members and up only, as ever) and its folder's
    default, read from the parent itself, so every way to add a sub-page offers
    the same. 404 unless the caller can read the parent (pinned to the token's
    workspace on a workspace's own domain, ``access.can``); 422 when
    ``workspace_id`` is another workspace than the parent's. ``tenant``: the
    workspace's own domain, which offers that workspace's templates and the
    built-ins only (personal templates stay on markdrop.in) and manages none."""
    from app.services import document as doc_service

    raw, _moved = await doc_service.find_for_read(db, parent)
    await access.require(actor, raw, "read", ctx)
    ws_id = raw.get("workspace_id")
    if workspace_id and workspace_id != ws_id:
        raise HTTPException(status_code=422, detail="A sub-page lives in its parent's workspace; leave "
                                                    "workspace out.")
    folder_id = raw.get("folder_id")
    return await listing(db, user, ws_id, str(folder_id) if ws_id and folder_id else None,
                         personal=not tenant, manage=not tenant)


async def all_usable(db: AsyncIOMotorDatabase, user) -> list[dict]:
    """Every template the user can use: personal, then each workspace's (MCP)."""
    from app.services import workspace as ws_service

    out = []
    for r in await _rows(db, None, user):
        out.append(await view(db, r, user))
    for ws, role in await ws_service.list_for_user(db, user.id):
        if not role_allows(role, "member"):
            continue
        for r in await _rows(db, ws.id, user):
            out.append({**await view(db, r, user), "workspace_name": ws.name})
    return out


# ── Page images ───────────────────────────────────────────────────────────────


_ASSET_REF = re.compile(r"(asset\\?:)([A-Za-z0-9_-]{8,64})(?![A-Za-z0-9_-])")


async def _plan_assets(db: AsyncIOMotorDatabase, src: dict, markdown: str) -> tuple[str, list[tuple[dict, str]]]:
    """The Markdown with each of ``src``'s page images it references renamed to
    a fresh id, and ``[(the source row, the new id)]`` to copy once the new page
    exists. References to images that aren't ``src``'s are left as they are."""
    from app.services import page_assets, pages

    ids = pages.asset_ids(markdown)
    if not ids:
        return markdown, []
    rows = await db[page_assets.COLL].find({"doc_id": str(src["_id"]), "_id": {"$in": ids}}).to_list(
        length=page_assets.MAX_PER_PAGE)
    mapping: dict[str, str] = {}
    plan: list[tuple[dict, str]] = []
    for r in rows:
        new_id = secrets.token_hex(12)
        mapping[r["_id"]] = new_id
        plan.append((r, new_id))
    if not mapping:
        return markdown, []
    out = _ASSET_REF.sub(lambda m: m.group(1) + mapping.get(m.group(2), m.group(2)), markdown)
    return out, plan


async def _quota_ok(db: AsyncIOMotorDatabase, owner_id: str, plans: list[list[tuple[dict, str]]]) -> None:
    from app.services import artifact as art_service

    total = sum(int(r.get("size") or 0) for plan in plans for r, _ in plan)
    if not total:
        return
    allowed, _used = await art_service.check_quota(db, owner_id, total)
    if not allowed:
        raise HTTPException(status_code=413, detail="Your Markdrop storage is full, so the template's "
                                                    "images can't be copied.")


async def copy_assets(db: AsyncIOMotorDatabase, page: dict, plan: list[tuple[dict, str]], *, user_id: str) -> int:
    """Copy each planned image into ``page`` (``pa/<page>/<new id>.<ext>``), owned
    by the page's owner, open or closed as the page is. Returns how many were
    copied; one that can't be read is skipped (the page shows it as missing)."""
    from app.services import page_assets, publicity, r2

    if not plan or not r2.is_configured():
        return 0
    doc_id = str(page["_id"])
    public = await page_assets.is_public(db, page)
    epoch = publicity.epoch_of(page)
    owner = page.get("owner_id") or user_id
    n = 0
    for row, new_id in plan:
        ext = (row.get("key") or "").rsplit(".", 1)[-1] or "png"
        key = page_assets.key_for(doc_id, new_id, ext)
        ok = await run_in_threadpool(_copy_object, row["key"], key, row.get("mime") or "image/png", public)
        if not ok:
            log.warning("copying a page image for %s failed", page.get("slug"))
            continue
        if not public and epoch:
            await run_in_threadpool(r2.set_public, key, False, row.get("mime"), epoch)
        await db[page_assets.COLL].insert_one({
            "_id": new_id, "doc_id": doc_id, "key": key, "mime": row.get("mime"), "size": row.get("size"),
            "width": row.get("width"), "height": row.get("height"), "created_by": user_id,
            "owner_id": owner, "created_at": now_utc(), "copied_from": row["_id"]})
        n += 1
    if n:
        # The page may have narrowed while the bytes were copied: follow it now.
        fresh = await db["documents"].find_one({"_id": page["_id"]}, _NO_CONTENT)
        if fresh is not None and (await page_assets.is_public(db, fresh) != public
                                  or publicity.epoch_of(fresh) != epoch):
            await page_assets.sync(db, fresh)
    return n


def _copy_object(src: str, dst: str, mime: str, public: bool) -> bool:
    """R2's server-side copy; falls back to reading and writing the bytes."""
    from app.services import page_assets, r2

    copy = getattr(r2, "copy_object", None)
    if copy is not None:
        try:
            if copy(src, dst, mime, public):
                return True
        except Exception:
            log.warning("server-side copy %s → %s failed", src, dst, exc_info=True)
    data = r2.get_bytes(src, page_assets.MAX_BYTES + 1)
    if not data:
        return False
    return bool(r2.put_bytes(dst, data, mime, public))


# ── Saving a page as a template ───────────────────────────────────────────────


async def _source_tree(db: AsyncIOMotorDatabase, raw: dict, actor: access.Actor, ctx: access.Ctx) -> list[dict]:
    """The sub-pages below ``raw`` the caller can read, parents before children."""
    from app.services import pages

    out: list[dict] = []
    readable = {str(raw["_id"])}
    for d in await pages.descendants(db, raw):
        if str(d.get("parent_id")) not in readable:
            continue  # below a page they can't open
        if not pages.is_page_capable(d):
            continue
        if not (await access.can(actor, d, "read", ctx)).allowed:
            continue
        readable.add(str(d["_id"]))
        out.append(d)
        if len(out) >= MAX_SUBPAGES:
            break
    return out


async def save_as_template(db: AsyncIOMotorDatabase, user, actor: access.Actor, ctx: access.Ctx, raw: dict, *,
                           name: str | None, description: str | None, icon: str | None,
                           include_subpages: bool, scope: str | None, workspace: str | None) -> dict:
    """Copy the page (and, if asked, the sub-pages the caller can open) into a
    new template. ``scope`` "workspace" (default for a page in a workspace) puts
    it in ``workspace`` (default: the page's workspace; member+); "personal"
    keeps it to the caller."""
    from app.schemas.document import DocumentCreate
    from app.services import document as doc_service
    from app.services import pages

    if user is None:
        raise HTTPException(status_code=401, detail="Sign in to save templates.")
    await access.require(actor, raw, "read", ctx)
    if raw.get("encrypted"):
        raise HTTPException(status_code=422, detail="End-to-end encrypted documents can't be templates: the "
                                                    "server can't read them.")
    if raw.get("kind") == "artifact":
        raise HTTPException(status_code=422, detail="Only pages (Markdown documents) can be templates.")
    if raw.get("template"):
        raise HTTPException(status_code=422, detail="That's already a template.")
    ws_id = None
    if (scope or ("workspace" if (workspace or raw.get("workspace_id")) else "personal")) == "workspace":
        ws_id = workspace or raw.get("workspace_id")
        if not ws_id:
            raise HTTPException(status_code=422, detail="This page isn't in a workspace: save it as a personal "
                                                        "template, or name a workspace.")
        role = await _role(db, ws_id, user)
        if role is None:
            raise HTTPException(status_code=404, detail="Workspace not found")
        if not role_allows(role, "member"):
            raise HTTPException(status_code=403, detail="Viewers can't save templates to the workspace.")
        from app.services import workspace as ws_service

        await ws_service.assert_open(db, ws_id)
    if await db["documents"].count_documents(_scope_query(ws_id, user)) >= MAX_PER_SCOPE:
        raise HTTPException(status_code=429, detail=f"There can be at most {MAX_PER_SCOPE} templates here. "
                                                    "Delete some first.")
    title = _clean(name, NAME_MAX) or _clean(raw.get("title"), NAME_MAX) or "Untitled template"
    icon = _icon(icon)
    tree = await _source_tree(db, raw, actor, ctx) if include_subpages else []

    root_md, root_plan = await _plan_assets(db, raw, await pages.content_for(actor, raw, ctx) or "\n")
    sub_plans: list[tuple[dict, str, list]] = []
    for d in tree:
        md, plan = await _plan_assets(db, d, await pages.content_for(actor, d, ctx) or "\n")
        sub_plans.append((d, md, plan))
    await _quota_ok(db, user.id, [root_plan, *[p for _d, _m, p in sub_plans]])

    last = await db["documents"].find(_scope_query(ws_id, user), {"template_order": 1}).sort(
        "template_order", -1).limit(1).to_list(length=1)
    order = (int(last[0].get("template_order") or 0) + 1) if last else 0
    level = "workspace" if ws_id else "private"
    base = {"editor": "blocks", "template": True, "workspace_id": ws_id, "folder_id": None, "folder_path": [],
            "access_level": level}
    extra = {**base, "template_description": _clean(description, DESCRIPTION_MAX), "template_icon": icon,
             "template_order": order, "template_saved_from": raw.get("slug"), "template_saved_at": now_utc()}
    doc, _secret = await doc_service.create_document(
        db, DocumentCreate(title=title, content=root_md, access_level="private"), owner_id=user.id, extra=extra)
    root = await db["documents"].find_one({"slug": doc.slug})
    await copy_assets(db, root, root_plan, user_id=user.id)

    made = {str(raw["_id"]): root}
    for d, md, plan in sub_plans:
        parent = made.get(str(d.get("parent_id")))
        if parent is None:
            continue
        sub_extra = {**base, "parent_id": parent["_id"], "access_inherit": True,
                     "page_path": [*(parent.get("page_path") or []), parent["slug"]]}
        sdoc, _s = await doc_service.create_document(
            db, DocumentCreate(title=_clean(d.get("title"), 200) or None, content=md, access_level="private"),
            owner_id=user.id, extra=sub_extra)
        child = await db["documents"].find_one({"slug": sdoc.slug})
        await copy_assets(db, child, plan, user_id=user.id)
        made[str(d["_id"])] = child
    return await view(db, root, user)


# ── Making a page from one ────────────────────────────────────────────────────


async def create_from(db: AsyncIOMotorDatabase, user, actor: access.Actor, ctx: access.Ctx, template_id: str, *,
                      title: str, workspace: str | None, folder: str | None, parent: str | None,
                      content: str | None = None) -> tuple[dict, str, str | None]:
    """A new page (and its sub-pages) from a workspace or personal template.
    Placement and permissions are ``pages.create_page``'s."""
    from app.services import pages, viewers

    tpl = await load(db, template_id, user)
    author = viewers.display_name(user)
    clean_title = " ".join((title or "").split())[:200]
    when = now_utc()
    if content is None:
        md, plan = await _plan_assets(db, tpl, _unlocked(fill(tpl.get("content"), title=clean_title,
                                                               author=author, now=when)))
    else:
        md, plan = content, []
    tree = await pages.descendants(db, tpl)
    tree = [d for d in tree if d.get("template")][:MAX_SUBPAGES]
    sub_plans = []
    for d in tree:
        smd, splan = await _plan_assets(db, d, _unlocked(fill(d.get("content"), title=clean_title, author=author,
                                                                now=when)))
        sub_plans.append((d, smd, splan))
    await _quota_ok(db, user.id, [plan, *[p for _d, _m, p in sub_plans]])

    raw, secret, error = await pages.create_page(db, user, actor, ctx, title=title, workspace=workspace,
                                                 folder=folder, parent=parent, content=md)
    raw = await db["documents"].find_one_and_update(
        {"_id": raw["_id"]}, {"$set": {"template_id": str(tpl["_id"])}}, return_document=True) or raw
    raw = await fill_folder(db, raw)
    await copy_assets(db, raw, plan, user_id=user.id)
    made = {str(tpl["_id"]): raw}
    for d, smd, splan in sub_plans:
        p = made.get(str(d.get("parent_id")))
        if p is None:
            continue
        sub_title = fill(d.get("title") or "Untitled", title=clean_title, author=author, now=when,
                         folder=await folder_name(db, raw))
        try:
            child, _s, _e = await pages.create_page(db, user, actor, ctx, title=sub_title, parent=p["slug"],
                                                    content=smd)
        except HTTPException:
            log.warning("a sub-page of template %s couldn't be made", tpl.get("slug"), exc_info=True)
            continue
        child = await fill_folder(db, child)
        await copy_assets(db, child, splan, user_id=user.id)
        made[str(d["_id"])] = child
    fresh = await db["documents"].find_one({"_id": raw["_id"]})
    return fresh or raw, secret, error


# ── Managing ──────────────────────────────────────────────────────────────────


async def update_meta(db: AsyncIOMotorDatabase, user, template_id: str, *, name: str | None = None,
                      description: str | None = None, icon: str | None = None, clear_icon: bool = False) -> dict:
    raw = await load(db, template_id, user, manage=True)
    sets: dict = {}
    if name is not None:
        clean = _clean(name, NAME_MAX)
        if not clean:
            raise HTTPException(status_code=422, detail="Give the template a name.")
        sets["title"] = clean
    if description is not None:
        sets["template_description"] = _clean(description, DESCRIPTION_MAX)
    if clear_icon:
        sets["template_icon"] = None
    elif icon is not None:
        sets["template_icon"] = _icon(icon)
    if sets:
        sets["updated_at"] = now_utc()
        raw = await db["documents"].find_one_and_update({"_id": raw["_id"]}, {"$set": sets},
                                                        return_document=True) or raw
        if "title" in sets:
            from app.services import live

            live.publish(raw["slug"], int(raw.get("rev") or 1))
    return await view(db, raw, user)


async def reorder(db: AsyncIOMotorDatabase, user, workspace_id: str | None, ids: list[str]) -> list[dict]:
    """Put the scope's templates in the order of ``ids`` (ones left out keep
    their place after them). Workspace: admins; personal: the owner."""
    if user is None:
        raise HTTPException(status_code=401, detail="Sign in to manage templates.")
    if workspace_id:
        role = await _role(db, workspace_id, user)
        if role is None:
            raise HTTPException(status_code=404, detail="Workspace not found")
        if not role_allows(role, "admin"):
            raise HTTPException(status_code=403, detail="Only the workspace's admins can reorder its templates.")
    rows = await _rows(db, workspace_id, user)
    by_id = {str(r["_id"]): r for r in rows}
    seen = [i for i in dict.fromkeys(ids) if i in by_id]
    rest = [str(r["_id"]) for r in rows if str(r["_id"]) not in set(seen)]
    for n, tid in enumerate([*seen, *rest]):
        if int(by_id[tid].get("template_order") or 0) != n:
            await db["documents"].update_one({"_id": by_id[tid]["_id"]}, {"$set": {"template_order": n}})
    rows = await _rows(db, workspace_id, user)
    names = await _names(db, [r.get("owner_id") for r in rows])
    return [await view(db, r, user, names=names) for r in rows]


async def delete(db: AsyncIOMotorDatabase, user, template_id: str) -> None:
    """The template, its sub-pages and their images. Pages made from it stay."""
    from app.services import lifecycle, pages

    raw = await load(db, template_id, user, manage=True)
    for d in reversed(await pages.descendants(db, raw)):
        await lifecycle.destroy(db, d, reason="template delete")
    await lifecycle.destroy(db, raw, reason="template delete")


# ── A page in place: set_page_properties(template=…) / PUT …/template ─────────


async def set_template(db: AsyncIOMotorDatabase, user, actor: access.Actor, ctx: access.Ctx, raw: dict,
                       on: bool) -> dict:
    """Turn the page itself into a template (it leaves every listing; its
    sub-pages become part of it) or back into an ordinary page. On: the
    caller can edit it and is a member+ of its workspace (a personal page: its
    owner). Off: whoever may manage the template. Pages already made from it
    never change."""
    from app.services import pages

    if user is None:
        raise HTTPException(status_code=401, detail="Sign in to manage templates.")
    await access.require(actor, raw, "edit_content", ctx)
    if not pages.is_page_capable(raw):
        raise HTTPException(status_code=422, detail="Only pages (Markdown documents, not encrypted) can be "
                                                    "templates.")
    if bool(raw.get("template")) == on:
        return raw
    if on:
        if raw.get("parent_id") is not None:
            raise HTTPException(status_code=422, detail="Only a top-level page can become a template. Move it "
                                                        "to the top level, or save a copy as a template.")
        ws_id = raw.get("workspace_id")
        if ws_id:
            role = await _role(db, ws_id, user)
            if not role_allows(role, "member"):
                raise HTTPException(status_code=403, detail="Only the workspace's members can make its "
                                                            "templates.")
        elif raw.get("owner_id") != user.id:
            raise HTTPException(status_code=403, detail="Only the page's owner can make it a template.")
        if await db["documents"].count_documents(_scope_query(ws_id, user)) >= MAX_PER_SCOPE:
            raise HTTPException(status_code=429, detail=f"There can be at most {MAX_PER_SCOPE} templates here.")
        last = await db["documents"].find(_scope_query(ws_id, user), {"template_order": 1}).sort(
            "template_order", -1).limit(1).to_list(length=1)
        sets = {"template": True, "template_order": (int(last[0].get("template_order") or 0) + 1) if last else 0,
                "template_saved_at": now_utc()}
    else:
        if raw.get("parent_id") is not None:
            raise HTTPException(status_code=422, detail="This page is part of a template: turn the template "
                                                        "itself back into a page.")
        if not await can_manage(db, raw, user):
            raise HTTPException(status_code=403, detail="Only the workspace's admins (or whoever made it a "
                                                        "template) can turn it back into a page.")
        sets = {"template": False}
    after = await db["documents"].find_one_and_update({"_id": raw["_id"]}, {"$set": sets},
                                                      return_document=True)
    below = [d["_id"] for d in await pages.descendants(db, raw, projection={"_id": 1})]
    if below:
        await db["documents"].update_many({"_id": {"$in": below}}, {"$set": {"template": on}})
    ctx.forget(raw)
    return after or raw


# ── A folder's default template ───────────────────────────────────────────────


async def _folder(db: AsyncIOMotorDatabase, workspace_id: str, folder_ref: str) -> dict:
    from app.services import folder as folder_service

    fid = await folder_service.resolve_ref(db, workspace_id, folder_ref)
    return await db["folders"].find_one({"_id": ObjectId(fid), "workspace_id": workspace_id})


async def resolve_ref(db: AsyncIOMotorDatabase, user, ref: str | None, *, workspace_id: str | None = None) -> str | None:
    """A template reference as stored or passed: a built-in id, or a workspace
    or personal template's id or slug (returned as its id). None if unknown or
    not usable by ``user``; an id/slug of ``workspace_id``'s templates only, when given."""
    from app.services import page_templates

    if not ref:
        return None
    if page_templates.get(ref):
        return ref
    raw = await find(db, ref)
    if raw is None or not await can_use(db, raw, user):
        return None
    if workspace_id is not None and raw.get("workspace_id") not in (workspace_id, None):
        return None
    return str(raw["_id"])


async def folder_default(db: AsyncIOMotorDatabase, workspace_id: str, folder_id: str | None, user) -> str | None:
    """The folder's default template, as a ref ``create_page`` takes, when this
    user can use it (a deleted template, or one they can't use: none)."""
    if not folder_id or not ObjectId.is_valid(str(folder_id)):
        return None
    f = await db["folders"].find_one({"_id": ObjectId(str(folder_id)), "workspace_id": workspace_id},
                                     {"default_template": 1})
    ref = (f or {}).get("default_template")
    return await resolve_ref(db, user, ref) if ref else None


async def set_folder_default(db: AsyncIOMotorDatabase, user, workspace_id: str, folder_ref: str,
                             template: str | None) -> dict:
    """Admins: what New page in this folder starts from (None: blank)."""
    if user is None:
        raise HTTPException(status_code=401, detail="Sign in to change folders.")
    role = await _role(db, workspace_id, user)
    if role is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    if not role_allows(role, "admin"):
        raise HTTPException(status_code=403, detail="Only the workspace's admins can set a folder's default "
                                                    "template.")
    f = await _folder(db, workspace_id, folder_ref)
    ref = None
    if template:
        ref = await resolve_ref(db, user, template)
        raw = await find(db, ref) if ref and is_template_id(ref) else None
        if ref is None or (raw is not None and raw.get("workspace_id") != workspace_id):
            raise HTTPException(status_code=422, detail="That isn't a built-in template or one of this "
                                                        "workspace's templates.")
    await db["folders"].update_one({"_id": f["_id"]}, {"$set": {"default_template": ref}})
    return {"folder_id": str(f["_id"]), "folder": f.get("name"), "default_template": ref}


async def folder_info(db: AsyncIOMotorDatabase, user, workspace_id: str, folder_ref: str) -> dict | None:
    """For the gallery: ``{id, name, default_template, can_set_default}`` (members only)."""
    role = await _role(db, workspace_id, user)
    if not role_allows(role, "member"):
        return None
    try:
        f = await _folder(db, workspace_id, folder_ref)
    except HTTPException:
        return None
    if f is None:
        return None
    return {"id": str(f["_id"]), "name": f.get("name"),
            "default_template": await folder_default(db, workspace_id, str(f["_id"]), user),
            "can_set_default": role_allows(role, "admin")}
