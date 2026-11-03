"""Pages: create one (from a template, in a workspace, or inside another page)
and list the built-in templates. Everything else about a page is a document
route (routers/documents.py): it *is* a document."""

from fastapi import APIRouter, Depends, Request
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.schemas.document import DocumentResponse, PageCreate, PageCreateResponse
from app.services import access, page_templates, pages

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
