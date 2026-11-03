"""Version history of a page (services/page_history.py): list, read and restore.

People who can edit the page only (``can(edit_content)``), signed in; anyone
else gets the page's own denial (404 / 401 + gate, or 403 for a reader).
End-to-end encrypted documents have no history: the list says so.
"""

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.schemas.document import DocumentResponse
from app.services import access, page_history

settings = get_settings()
router = APIRouter(prefix="/api/v1/documents", tags=["page history"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


async def _editable(db, request: Request, slug: str, user: User, scope: str | None):
    from app.routers.documents import _ctx

    actor = access.actor_from_request(request, user)
    ctx = _ctx(db, request, scope)
    raw = await db["documents"].find_one({"slug": slug})
    await access.require(actor, raw, "edit_content", ctx)
    return raw, actor, ctx


@router.get("/{slug}/versions")
@limiter.limit(settings.rate_limit_read)
async def list_versions(
    request: Request,
    slug: str,
    cursor: int | None = Query(None, ge=1),
    limit: int = Query(page_history.PAGE_SIZE, ge=1, le=100),
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_markdrop_workspace: str | None = Header(None),
    user: User = Depends(require_user),
):
    """``{versions: [{n, ts, author: {kind, id, name, client, label, picture},
    title, icon, bytes, restored_from, current}], next_cursor, available,
    reason}``, newest first; pass ``next_cursor`` back as ``cursor`` for older
    ones. ``available: false`` (``reason: "encrypted"``) for an encrypted document."""
    raw, _actor, _ctx = await _editable(db, request, slug, user, x_markdrop_workspace)
    return await page_history.listing(db, raw, cursor, limit)


@router.get("/{slug}/versions/{n}")
@limiter.limit(settings.rate_limit_read)
async def get_version(
    request: Request,
    slug: str,
    n: int,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_markdrop_workspace: str | None = Header(None),
    user: User = Depends(require_user),
):
    """One version: its Markdown and image links, plus ``current_doc`` (the
    page as it is now) to compare with."""
    raw, actor, ctx = await _editable(db, request, slug, user, x_markdrop_workspace)
    row = await page_history.get_version(db, raw, n)
    if row is None:
        raise HTTPException(status_code=404, detail="That version doesn't exist (any more).")
    return await page_history.detail(db, raw, row, actor, ctx)


@router.post("/{slug}/versions/{n}/restore")
@limiter.limit(settings.rate_limit_edit)
async def restore_version(
    request: Request,
    slug: str,
    n: int,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Make version ``n`` the page again, as a new version (the page as it was
    is kept first, so this can be undone). 423 ``{code: "locked", holder}``
    while someone else has the page open in the editor."""
    from app.routers.documents import _ctx, _full_response

    raw, actor, ctx = await _editable(db, request, slug, user, None)
    after, version = await page_history.restore(db, raw, n, actor, ctx)
    body = await _full_response(db, after, actor, _ctx(db, request))
    return {"document": DocumentResponse(**body).model_dump(mode="json"),
            "version": version.get("n"), "restored_from": n}
