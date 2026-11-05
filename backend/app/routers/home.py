"""The signed-in home (/dashboard): services/home.py.

    GET  /api/v1/home                {attention, actions, meetings, workspaces, meet}
    POST /api/v1/home/actions/tick   {slug, block} → {done}       tick one of your to-dos
    POST /api/v1/me/previews         {slugs} → {previews}         card previews of items anywhere

Signed in, on markdrop.in only (a workspace domain's session reads that workspace's documents; the
home spans every workspace). Every item is decided for the caller now (services/home.py).
"""

# No `from __future__ import annotations`: slowapi wraps these routes (see routers/docs_ai.py).
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import is_tenant_request, require_user
from app.services import access, card_preview
from app.services import home as home_service
from app.utils.net import get_client_ip

router = APIRouter(prefix="/api/v1", tags=["home"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _ac(request: Request, db, user: User):
    if is_tenant_request(request):
        raise HTTPException(status_code=403, detail="The home is on markdrop.in.")
    return (access.actor_from_request(request, user),
            access.Ctx(db, surface="rest", ip=get_client_ip(request)))


@router.get("/home")
@limiter.limit("120/minute")
async def get_home(request: Request, db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """What the home shows, decided for you: unread notifications and access requests waiting on you
    (``attention``), the open to-dos that mention you in pages you can read (``actions``; ``can_tick``
    when you may edit the page), the latest meetings across your workspaces (``meetings``), your
    workspaces with people, item and meeting counts (``workspaces``) and whether Google Meet is
    connected (``meet``). No AI."""
    actor, ctx = _ac(request, db, user)
    return jsonable_encoder(await home_service.home(db, actor, ctx))


class TickBody(BaseModel):
    slug: str = Field(..., min_length=1, max_length=200)
    block: str = Field(..., pattern=r"^b-[0-9A-Za-z_-]{1,40}$")


@router.post("/home/actions/tick")
@limiter.limit("60/minute")
async def tick_action(request: Request, body: TickBody, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    """Mark one of your to-dos done (``- [ ]`` → ``- [x]``, found by its block id) through the normal
    save path. 404: the page or to-do is gone (or you can't open it); 403: you can't edit the page, or
    the to-do doesn't mention you; 409: already done; 423: someone is editing the page."""
    actor, ctx = _ac(request, db, user)
    return await home_service.tick(db, actor, ctx, body.slug, body.block)


class PreviewsBody(BaseModel):
    slugs: list[str] = Field(..., min_length=1, max_length=card_preview.MAX_SLUGS)


@router.post("/me/previews")
@limiter.limit("240/minute")
async def my_previews(request: Request, body: PreviewsBody, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    """Card previews (as ``POST /workspaces/{id}/items/previews``) for items anywhere: your own, shared
    with you, in any workspace. Each answers ``locked`` unless you can open it right now."""
    actor, ctx = _ac(request, db, user)
    return {"previews": await card_preview.previews(db, actor, ctx, None, body.slugs)}
