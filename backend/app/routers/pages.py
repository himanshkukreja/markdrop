"""Pages: create one (from a template, in a workspace, or inside another page)
and list the built-in templates. Everything else about a page is a document
route (routers/documents.py): it *is* a document."""

from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.config import get_settings
from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import optional_user, require_user
from app.schemas.document import DocumentResponse, PageCreate, PageCreateResponse
from app.services import access, page_covers, page_templates, page_user_templates, pages

settings = get_settings()
router = APIRouter(prefix="/api/v1", tags=["pages"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


@router.post("/pages", response_model=PageCreateResponse, status_code=201)
@limiter.limit(settings.rate_limit_create)
async def create_page(
    request: Request,
    data: PageCreate,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """A new page (``editor: "blocks"``). ``template`` fills it from a built-in
    template (``{{date}}`` / ``{{title}}`` filled in); ``content`` gives its
    Markdown instead. ``workspace`` (member+) and ``folder`` file it there;
    ``parent`` (the slug of a page you can edit) puts it inside that page, in
    its workspace and folder, inheriting its access. ``slug`` gives it its link
    (publish's custom-slug rules; 409 when taken, nothing is created). Unless it
    has a cover (or ``auto_cover`` is false, or its workspace turned Auto covers
    off), a cover is picked for it in the background: ``cover_pending``."""
    from app.routers.auth import is_tenant_request
    from app.routers.documents import _ctx, _full_response

    actor = access.actor_from_request(request, user)
    ctx = _ctx(db, request)
    tenant = is_tenant_request(request)
    if tenant:
        # On a workspace's own domain: a sub-page of a page this person can edit, and nothing else.
        # The parent's can(edit_content) is pinned to the token's workspace (access.can), and a
        # sub-page always lives in its parent's workspace — so the new page is in that workspace
        # too. No top-level pages, no filing into a workspace or folder by id; a built-in template
        # or one of this workspace's own templates (a personal one, or another workspace's, are
        # read by id from anywhere: those stay on markdrop.in).
        if not data.parent:
            raise HTTPException(status_code=403, detail="On the workspace's own domain you can add pages "
                                                        "inside a page you can edit. Create other pages on "
                                                        "markdrop.in.")
        if data.workspace or data.folder:
            raise HTTPException(status_code=422, detail="A sub-page lives in its parent's workspace and "
                                                        "folder; leave workspace and folder out.")
        if data.template and page_templates.get(data.template) is None:
            # This workspace's own templates are fine (its members make sub-pages from them here, as
            # on markdrop.in); another workspace's, or a personal one, stay on markdrop.in.
            from app.routers.auth import tenant_workspace

            tpl = await page_user_templates.find(db, data.template)
            if tpl is None or not tpl.get("workspace_id") or tpl.get("workspace_id") != tenant_workspace(request):
                raise HTTPException(status_code=403, detail="That template is available on markdrop.in.")
    raw, secret, error = await pages.create_page(
        db, user, actor, ctx, title=data.title, workspace=data.workspace, folder=data.folder,
        parent=data.parent, template=data.template, content=data.content, slug=data.slug)
    # Its cover is picked in the background; the page says cover_pending until it lands.
    await page_covers.start(db, raw, user, via="web", auto=data.auto_cover)
    body = await _full_response(db, raw, actor, access.Ctx(db, surface="rest"))
    # The new page's edit secret is a key to all of it (settings, delete, anywhere): never handed to
    # a workspace's domain. Its creator is signed in and owns it, so they don't need it.
    return PageCreateResponse(document=DocumentResponse(**body), edit_secret=None if tenant else secret,
                              workspace_error=error)


@router.get("/pages/{slug}/cover")
@limiter.limit(settings.rate_limit_read)
async def cover_status(
    request: Request,
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_edit_secret: str | None = Header(None),
    user: User | None = Depends(optional_user),
):
    """The page's cover now, for an editor waiting on an auto cover: ``{cover, cover_auto,
    cover_pending, rev}`` (anyone who can read it)."""
    from app.routers.documents import _ctx
    from app.services import page_props

    actor = access.actor_from_request(request, user, edit_secret=x_edit_secret)
    raw = await db["documents"].find_one({"slug": slug})
    await access.require(actor, raw, "read", _ctx(db, request))
    if raw.get("encrypted") or raw.get("kind") == "artifact":
        return {"cover": None, "cover_auto": False, "cover_pending": False, "rev": int(raw.get("rev") or 1)}
    return {"cover": page_props.parse(raw.get("content")).get("cover"), **page_covers.fields(raw),
            "rev": int(raw.get("rev") or 1)}


@router.post("/pages/{slug}/cover/suggest")
@limiter.limit("30/minute")
async def cover_suggest(
    request: Request,
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_edit_secret: str | None = Header(None),
    user: User = Depends(require_user),
):
    """A cover for the page, picked like an auto cover, not written (the cover picker's "Pick for
    me"): ``{cover: "gallery:<id>", how}``. Editors only."""
    from app.routers.documents import _ctx

    actor = access.actor_from_request(request, user, edit_secret=x_edit_secret)
    raw = await db["documents"].find_one({"slug": slug})
    await access.require(actor, raw, "edit_content", _ctx(db, request))
    if raw.get("encrypted") or raw.get("kind") == "artifact":
        raise HTTPException(status_code=422, detail="Only pages get covers.")
    cid, how = await page_covers.suggest(db, raw, user, via="web")
    return {"cover": f"gallery:{cid}", "how": "ai" if how == "ai" else "keywords"}


@router.get("/page-templates")
@limiter.limit(settings.rate_limit_read)
async def list_templates(request: Request):
    """The built-in templates: ``[{id, name, description, icon, category, content}]``."""
    return page_templates.all_templates()


# ── Workspace and personal templates (services/page_user_templates.py) ───────


class TemplateSave(BaseModel):
    name: str | None = Field(None, max_length=200)
    description: str | None = Field(None, max_length=600)
    icon: str | None = Field(None, max_length=32)
    include_subpages: bool = False
    # "workspace" (default for a page in a workspace) or "personal".
    scope: Literal["workspace", "personal"] | None = None
    # Another workspace to save it to (member+); default: the page's own.
    workspace: str | None = Field(None, min_length=1, max_length=64)


class TemplatePatch(BaseModel):
    name: str | None = Field(None, max_length=200)
    description: str | None = Field(None, max_length=600)
    icon: str | None = Field(None, max_length=32)


class TemplateOrder(BaseModel):
    # The workspace whose templates these are; null for your personal ones.
    workspace: str | None = Field(None, min_length=1, max_length=64)
    ids: list[str] = Field(..., max_length=page_user_templates.MAX_PER_SCOPE)


@router.post("/documents/{slug}/save-as-template", status_code=201)
@limiter.limit(settings.rate_limit_create)
async def save_as_template(
    request: Request,
    slug: str,
    data: TemplateSave,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_edit_secret: str | None = Header(None),
    user: User = Depends(require_user),
):
    """Save a copy of the page (and, with ``include_subpages``, the sub-pages
    you can open) as a template: the workspace's (members and up) or your own.
    Its images are copied with it."""
    from app.routers.documents import _ctx

    actor = access.actor_from_request(request, user, edit_secret=x_edit_secret)
    ctx = _ctx(db, request)
    raw = await db["documents"].find_one({"slug": slug})
    if raw is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return await page_user_templates.save_as_template(
        db, user, actor, ctx, raw, name=data.name, description=data.description, icon=data.icon,
        include_subpages=data.include_subpages, scope=data.scope, workspace=data.workspace)


@router.get("/page-templates/all")
@limiter.limit(settings.rate_limit_read)
async def list_all_templates(
    request: Request,
    workspace: str | None = None,
    folder: str | None = None,
    parent: str | None = None,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """The New page gallery: ``{builtin, workspace, personal, workspace_id,
    workspace_name, workspace_role, can_save_workspace, can_reorder_workspace,
    folder}``. ``workspace`` lists that workspace's templates when you're a
    member (not a viewer) of it; ``folder`` (an id or path of it) adds
    ``folder: {id, name, default_template, can_set_default}``. ``parent`` (a
    page's slug: Add a sub-page) reads both from that page instead, which you
    must be able to read. On a workspace's own domain ``parent`` is required,
    and the gallery offers the built-ins and that workspace's templates."""
    from app.routers.auth import is_tenant_request
    from app.routers.documents import _ctx

    tenant = is_tenant_request(request)
    if parent:
        actor = access.actor_from_request(request, user)
        return await page_user_templates.listing_for_parent(
            db, user, actor, _ctx(db, request), parent, workspace_id=workspace, tenant=tenant)
    if tenant:
        raise HTTPException(status_code=403, detail="On the workspace's own domain, templates are listed "
                                                    "for a sub-page: pass parent.")
    return await page_user_templates.listing(db, user, workspace, folder)


@router.get("/page-templates/{template_id}")
@limiter.limit(settings.rate_limit_read)
async def get_template(
    request: Request,
    template_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """One workspace or personal template with its Markdown and image links (the preview). On a
    workspace's own domain: that workspace's templates only."""
    from app.routers.auth import is_tenant_request, tenant_workspace

    raw = await page_user_templates.load(db, template_id, user)
    tenant = is_tenant_request(request)
    if tenant and raw.get("workspace_id") != tenant_workspace(request):
        raise HTTPException(status_code=404, detail="Template not found")
    out = await page_user_templates.view(db, raw, user, content=True)
    if tenant:
        out["can_manage"] = False
    return out


@router.patch("/page-templates/{template_id}")
@limiter.limit(settings.rate_limit_create)
async def update_template(
    request: Request,
    template_id: str,
    data: TemplatePatch,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Rename it, or change its description or icon (an empty icon clears it).
    Workspace templates: its admins and whoever saved it."""
    return await page_user_templates.update_meta(
        db, user, template_id, name=data.name, description=data.description,
        icon=data.icon or None, clear_icon=data.icon is not None and not data.icon.strip())


@router.put("/page-templates/order")
@limiter.limit(settings.rate_limit_create)
async def reorder_templates(
    request: Request,
    data: TemplateOrder,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Reorder a workspace's templates (admins) or your personal ones."""
    return {"templates": await page_user_templates.reorder(db, user, data.workspace, data.ids)}


@router.delete("/page-templates/{template_id}", status_code=204)
@limiter.limit(settings.rate_limit_create)
async def delete_template(
    request: Request,
    template_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Delete a template and its sub-pages. Pages made from it stay as they are."""
    await page_user_templates.delete(db, user, template_id)
    return Response(status_code=204)


class TemplateToggle(BaseModel):
    template: bool


@router.put("/documents/{slug}/template")
@limiter.limit(settings.rate_limit_create)
async def set_page_template(
    request: Request,
    slug: str,
    data: TemplateToggle,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Turn this page itself into a template (``true``: it leaves every list
    and search and shows in the New page gallery; its sub-pages come with it)
    or back into a page (``false``). Pages made from it never change."""
    from app.routers.documents import _ctx

    actor = access.actor_from_request(request, user)
    ctx = _ctx(db, request)
    raw = await db["documents"].find_one({"slug": slug})
    if raw is None:
        raise HTTPException(status_code=404, detail="Document not found")
    after = await page_user_templates.set_template(db, user, actor, ctx, raw, data.template)
    return {"slug": after["slug"], "template": bool(after.get("template")),
            "id": str(after["_id"]) if after.get("template") else None}


class FolderDefaultTemplate(BaseModel):
    # A built-in id, or a workspace template's id or slug; null: new pages start blank.
    template: str | None = Field(None, max_length=64)


@router.put("/workspaces/{workspace_id}/folders/{folder_id}/default-template")
@limiter.limit(settings.rate_limit_create)
async def set_folder_default_template(
    request: Request,
    workspace_id: str,
    folder_id: str,
    data: FolderDefaultTemplate,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """What New page in this folder starts from (admins). The person making a
    page can still choose blank or another template."""
    return await page_user_templates.set_folder_default(db, user, workspace_id, folder_id, data.template)
