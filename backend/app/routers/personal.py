"""The caller's own lists and requests (simpler workspaces UI).

    GET  /api/v1/me/shared?cursor=&limit=          Shared with me (+ new_count)
    GET  /api/v1/me/recent                          last 30 opened, re-checked now
    GET  /api/v1/search/quick?q=&limit=8            ⌘K: files, folders, workspaces
    POST /api/v1/documents/{slug}/access-requests  {message?}  → 201 {id, status}
    GET  /api/v1/documents/{slug}/access-requests/mine         gate state
    GET  /api/v1/me/access-requests?status=pending  requests on docs I own
    GET  /api/v1/access-requests/{id}               one of them (owner only)
    POST /api/v1/access-requests/{id}/decision      {decision: view|edit|decline}

All signed-in only (``require_user``); a tenant token is refused (not on its
allowlist). Every document decision is ``access.can`` / ``readable_filter``.
"""

from typing import Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.encoders import jsonable_encoder
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.services import access
from app.services import access_requests as requests_service
from app.services import personal
from app.utils.net import get_client_ip

router = APIRouter(tags=["personal"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _ac(request: Request, db, user: User):
    return (access.actor_from_request(request, user),
            access.Ctx(db, surface="rest", ip=get_client_ip(request)))


class AccessRequestCreate(BaseModel):
    message: str | None = Field(None, max_length=requests_service.MAX_MESSAGE)


class AccessRequestDecision(BaseModel):
    decision: Literal["view", "edit", "decline"]


@router.get("/api/v1/me/shared")
@limiter.limit("120/minute")
async def shared_with_me(request: Request,
                         cursor: str | None = Query(None, max_length=300),
                         limit: int = Query(30, ge=1, le=personal.MAX_SHARED_PAGE),
                         db: AsyncIOMotorDatabase = Depends(get_db),
                         user: User = Depends(require_user)):
    actor, ctx = _ac(request, db, user)
    return jsonable_encoder(await personal.shared(db, actor, ctx, cursor=cursor, limit=limit))


@router.get("/api/v1/me/recent")
@limiter.limit("120/minute")
async def recent(request: Request, db: AsyncIOMotorDatabase = Depends(get_db),
                 user: User = Depends(require_user)):
    actor, ctx = _ac(request, db, user)
    return jsonable_encoder(await personal.recent(db, actor, ctx))


@router.get("/api/v1/search/quick")
@limiter.limit("60/minute")
async def quick_search(request: Request,
                       q: str = Query("", max_length=200),
                       limit: int = Query(8, ge=1, le=personal.QUICK_MAX_LIMIT),
                       db: AsyncIOMotorDatabase = Depends(get_db),
                       user: User = Depends(require_user)):
    actor, ctx = _ac(request, db, user)
    return jsonable_encoder(await personal.quick(db, actor, ctx, q, limit))


@router.post("/api/v1/documents/{slug}/access-requests", status_code=201)
@limiter.limit("30/hour")
async def request_access(request: Request, slug: str, data: AccessRequestCreate,
                         db: AsyncIOMotorDatabase = Depends(get_db),
                         user: User = Depends(require_user)):
    actor, ctx = _ac(request, db, user)
    row = await requests_service.create(db, actor, ctx, slug, data.message)
    return {"id": str(row["_id"]), "status": row["status"]}


@router.get("/api/v1/documents/{slug}/access-requests/mine")
@limiter.limit("120/minute")
async def my_access_request(request: Request, slug: str,
                            db: AsyncIOMotorDatabase = Depends(get_db),
                            user: User = Depends(require_user)):
    actor, ctx = _ac(request, db, user)
    return jsonable_encoder(await requests_service.mine(db, actor, ctx, slug))


@router.get("/api/v1/me/access-requests")
@limiter.limit("120/minute")
async def access_requests_for_me(
    request: Request,
    status: Literal["pending", "approved", "declined", "all"] = Query("pending"),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    actor, ctx = _ac(request, db, user)
    return jsonable_encoder(await requests_service.list_for_owner(db, actor, ctx, status))


@router.get("/api/v1/access-requests/{request_id}")
@limiter.limit("120/minute")
async def get_access_request(request: Request, request_id: str,
                             db: AsyncIOMotorDatabase = Depends(get_db),
                             user: User = Depends(require_user)):
    actor, ctx = _ac(request, db, user)
    return jsonable_encoder(await requests_service.get_for_owner(db, actor, ctx, request_id))


@router.post("/api/v1/access-requests/{request_id}/decision")
@limiter.limit("120/hour")
async def decide_access_request(request: Request, request_id: str, data: AccessRequestDecision,
                                db: AsyncIOMotorDatabase = Depends(get_db),
                                user: User = Depends(require_user)):
    actor, ctx = _ac(request, db, user)
    return jsonable_encoder(await requests_service.decide(db, actor, ctx, request_id, data.decision))
