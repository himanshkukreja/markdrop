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
from app.routers.auth import require_user
from app.schemas.document import DocumentResponse, PageCreate, PageCreateResponse
from app.services import access, page_templates, page_user_templates, pages

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
    its workspace and folder, inheriting its access."""
    from app.routers.documents import _ctx, _full_response

    actor = access.actor_from_request(request, user)
    ctx = _ctx(db, request)
    raw, secret, error = await pages.create_page(
        db, user, actor, ctx, title=data.title, workspace=data.workspace, folder=data.folder,
        parent=data.parent, template=data.template, content=data.content)
    body = await _full_response(db, raw, actor, access.Ctx(db, surface="rest"))
    return PageCreateResponse(document=DocumentResponse(**body), edit_secret=secret, workspace_error=error)


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
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """The New page gallery: ``{builtin, workspace, personal, workspace_role,
    can_save_workspace, can_reorder_workspace}``. ``workspace`` lists that
    workspace's templates when you're a member (not a viewer) of it."""
    return await page_user_templates.listing(db, user, workspace)


@router.get("/page-templates/{template_id}")
@limiter.limit(settings.rate_limit_read)
async def get_template(
    request: Request,
    template_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """One workspace or personal template with its Markdown and image links (the preview)."""
    raw = await page_user_templates.load(db, template_id, user)
    return await page_user_templates.view(db, raw, user, content=True)


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
