"""Typed page properties and folder database views (services/page_db.py).

    GET  /api/v1/workspaces/{ws}/folders/{folder}/database    viewer+: schema, views, readable rows
    PUT  /api/v1/workspaces/{ws}/folders/{folder}/properties  member+: the schema (and views)
    PUT  /api/v1/workspaces/{ws}/folders/{folder}/views       member+: the saved views
    GET  /api/v1/documents/{slug}/properties                  can(read): the page's panel
    PATCH /api/v1/documents/{slug}/properties                 can(edit_content): set values

Every route authorises against the workspace (or the page) first; a folder of
another workspace answers like one that doesn't exist.
"""

from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.config import get_settings
from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import optional_user, require_user
from app.services import access, page_db
from app.services import workspace as ws_service

settings = get_settings()
router = APIRouter(prefix="/api/v1", tags=["page properties"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


class SchemaPut(BaseModel):
    properties: list[dict[str, Any]] = Field(..., max_length=page_db.MAX_PROPERTIES)
    views: list[dict[str, Any]] | None = Field(None, max_length=page_db.MAX_VIEWS)
    base_rev: int | None = None


class ViewsPut(BaseModel):
    views: list[dict[str, Any]] = Field(..., max_length=page_db.MAX_VIEWS)
    base_rev: int | None = None


class ValuesPatch(BaseModel):
    # {key: value | null}
    values: dict[str, Any] = Field(..., max_length=page_db.MAX_PROPERTIES)
    base_rev: int | None = None


def _ctx(db, request: Request) -> access.Ctx:
    from app.routers.documents import _ctx as doc_ctx

    return doc_ctx(db, request)


@router.get("/workspaces/{workspace_id}/folders/{folder_id}/database")
@limiter.limit("120/minute")
async def folder_database(request: Request, workspace_id: str, folder_id: str, rows: bool = True,
                          db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """The folder as a database: ``{folder, properties, views, rev, rows, truncated,
    people, links, can_edit_schema, role}``. Rows are the top-level pages filed
    directly in the folder that the caller can read (at most 500, newest first);
    ``rows=false`` leaves them out (the views bar of the folder's list)."""
    await ws_service.require_role(db, workspace_id, user.id, "viewer")
    actor = access.actor_from_request(request, user)
    return await page_db.database(db, actor, _ctx(db, request), workspace_id, folder_id, with_rows=rows)


@router.put("/workspaces/{workspace_id}/folders/{folder_id}/properties")
@limiter.limit("60/minute")
async def put_properties(request: Request, workspace_id: str, folder_id: str, data: SchemaPut,
                         db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """Replace the folder's property schema (members and admins). Values in
    pages are never changed: a property left out keeps its values, hidden."""
    return await page_db.set_schema(db, workspace_id, folder_id, user.id, data.properties,
                                    views=data.views, base_rev=data.base_rev)


@router.put("/workspaces/{workspace_id}/folders/{folder_id}/views")
@limiter.limit("120/minute")
async def put_views(request: Request, workspace_id: str, folder_id: str, data: ViewsPut,
                    db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """Replace the folder's saved views (members and admins; at most 20)."""
    return await page_db.set_views(db, workspace_id, folder_id, user.id, data.views, base_rev=data.base_rev)


async def _page(request: Request, db, slug: str, user, action: str, *, edit_secret: str | None = None,
                read_password: str | None = None):
    actor = access.actor_from_request(request, user, edit_secret=edit_secret, read_password=read_password)
    ctx = _ctx(db, request)
    raw = await db["documents"].find_one({"slug": slug})
    await access.require(actor, raw, action, ctx)
    return raw, actor, ctx


@router.get("/documents/{slug}/properties")
@limiter.limit(settings.rate_limit_read)
async def page_properties(request: Request, slug: str, db: AsyncIOMotorDatabase = Depends(get_db),
                          x_read_password: str | None = Header(None), x_edit_secret: str | None = Header(None),
                          user: User | None = Depends(optional_user)):
    """The page's properties panel for this reader (null: none)."""
    raw, actor, ctx = await _page(request, db, slug, user, "read", edit_secret=x_edit_secret,
                                  read_password=x_read_password)
    return {"page_properties": await page_db.panel(db, raw, actor, ctx)}


@router.patch("/documents/{slug}/properties")
@limiter.limit("120/minute")
async def patch_properties(request: Request, slug: str, data: ValuesPatch,
                           db: AsyncIOMotorDatabase = Depends(get_db), x_edit_secret: str | None = Header(None),
                           user: User | None = Depends(optional_user)):
    """Set some of the page's values (``null`` clears one), through the page's
    own save path: 423 while someone else is editing it or it's locked, 409 on
    a stale ``base_rev``, 422 when a value doesn't fit its property."""
    raw, actor, ctx = await _page(request, db, slug, user, "edit_content", edit_secret=x_edit_secret)
    if raw.get("encrypted") or raw.get("kind") == "artifact":
        raise HTTPException(status_code=422, detail="Only pages have properties.")
    try:
        after = await page_db.set_values(db, raw, data.values, actor, ctx, base_rev=data.base_rev)
    except page_db.PropsError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"slug": after["slug"], "rev": int(after.get("rev") or 1),
            "values": page_db.read_values(after.get("content")),
            "page_properties": await page_db.panel(db, after, actor, ctx)}
