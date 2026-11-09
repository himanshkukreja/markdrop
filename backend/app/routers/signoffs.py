"""Sign-off blocks in pages (services/signoffs.py): their state for this viewer,
and the named person's decision.

``GET  /api/v1/documents/{slug}/signoffs``          anyone who can read the page
``POST /api/v1/documents/{slug}/signoffs/{block}``  only the person the block names
"""

from fastapi import APIRouter, Depends, Header, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.config import get_settings
from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import optional_user, require_user
from app.services import access, signoffs

settings = get_settings()
router = APIRouter(prefix="/api/v1/documents", tags=["pages"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


class SignRequest(BaseModel):
    """``option``: one of the block's options; null clears the decision."""

    option: str | None = Field(None, max_length=signoffs.MAX_OPTION_CHARS + 20)
    #: Sign off although comment threads are still open on the page (else 409 ``open_comments``).
    acknowledge_open_comments: bool = False


@router.get("/{slug}/signoffs")
@limiter.limit(settings.rate_limit_read)
async def list_signoffs(
    request: Request,
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_read_password: str | None = Header(None),
    x_edit_secret: str | None = Header(None),
    x_markdrop_workspace: str | None = Header(None),
    user: User | None = Depends(optional_user),
):
    """The page's sign-off blocks for this viewer: ``{signoffs: [{block, label,
    options, lock, person, option, tone, signed_at, signed_by, can_sign,
    can_remove, history}]}``. Names (person, signer, history) only for people
    inside the page's circle, like ``:person`` mentions. The decision comes from
    the server, never from the Markdown."""
    from app.routers.documents import _readable_page

    raw, actor, ctx = await _readable_page(db, request, slug, user, read_password=x_read_password,
                                           edit_secret=x_edit_secret, scope=x_markdrop_workspace)
    return {"signoffs": await signoffs.listing(db, raw, actor, ctx)}


@router.post("/{slug}/signoffs/{block}")
@limiter.limit(settings.rate_limit_edit)
async def sign_off(
    request: Request,
    slug: str,
    block: str,
    data: SignRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """The person the block names chooses an option (``{option: null}``
    clears it). 403 for anyone else, 404 for a block that isn't on the page, 422
    for an option the block doesn't offer, 409 ``open_comments`` while comment
    threads are open on the page unless ``acknowledge_open_comments``. Returns
    the block as they see it."""
    from app.routers.documents import _ctx

    actor = access.actor_from_request(request, user)
    ctx = _ctx(db, request)
    raw = await db["documents"].find_one({"slug": slug})
    out = await signoffs.sign(db, raw, block, data.option, actor, ctx,
                              open_comments_ok=True if data.acknowledge_open_comments else False)
    # Viewer analytics: the sign-off joins this person's view of the page (services/doc_views.py).
    from app.services import doc_views

    await doc_views.note_for_slug(db, slug, user.id, {"k": "signoff", "o": (data.option or None) and
                                                      str(data.option)[:80]})
    return out
