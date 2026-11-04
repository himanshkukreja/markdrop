"""Trash (services/trash.py): list, restore, delete forever, and what a link
to a trashed item says to someone who could edit it.

    GET    /api/v1/trash[?workspace=<id>]        what the caller may restore
    GET    /api/v1/trash/lookup/{slug}           the trash notice (404 unless they could edit it)
    POST   /api/v1/trash/{key}/restore           put it (and its batch) back
    DELETE /api/v1/trash/{key}                   delete forever

``key``: a document's slug, or a folder's id.
    GET    /api/v1/documents/{slug}/delete-preview   what a delete would take (the delete dialog)

Never on a workspace's own domain: a tenant session only reads.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import optional_user, require_user
from app.services import access, pages, trash

settings = get_settings()
router = APIRouter(tags=["trash"])
_NO_STORE = {"Cache-Control": "no-store"}


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


@router.get("/api/v1/trash")
@limiter.limit("120/minute")
async def list_trash(request: Request, workspace: str | None = Query(None, max_length=64),
                     db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    actor = access.actor_from_request(request, user)
    if actor.cred == "tenant":
        raise HTTPException(status_code=401, detail="Sign in on markdrop.in to see the trash.")
    items = await trash.list_for(db, actor, workspace_id=workspace or None)
    return JSONResponse({"items": items, "days": trash.DAYS}, headers=_NO_STORE)


@router.get("/api/v1/trash/lookup/{slug}")
@limiter.limit("60/minute")
async def lookup(request: Request, slug: str, db: AsyncIOMotorDatabase = Depends(get_db),
                 x_edit_secret: str | None = Header(None), user: User | None = Depends(optional_user)):
    actor = access.actor_from_request(request, user, edit_secret=x_edit_secret)
    return JSONResponse(await trash.notice(db, actor, slug), headers=_NO_STORE)


@router.post("/api/v1/trash/{slug}/restore")
@limiter.limit(settings.rate_limit_create)
async def restore(request: Request, slug: str, db: AsyncIOMotorDatabase = Depends(get_db),
                  x_edit_secret: str | None = Header(None), user: User | None = Depends(optional_user)):
    actor = access.actor_from_request(request, user, edit_secret=x_edit_secret)
    out = await trash.restore(db, actor, slug)
    out.pop("row")
    return JSONResponse({"restored": True, "key": out["key"], "slug": out["slug"], "kind": out["kind"],
                         "title": out["title"], "url": trash.public_url(out["slug"]) if out["slug"] else None,
                         "items": out["restored"], "folders": out["folders"], "notes": out["notes"]},
                        headers=_NO_STORE)


@router.delete("/api/v1/trash/{slug}")
@limiter.limit(settings.rate_limit_create)
async def delete_forever(request: Request, slug: str, db: AsyncIOMotorDatabase = Depends(get_db),
                         x_edit_secret: str | None = Header(None), user: User | None = Depends(optional_user)):
    actor = access.actor_from_request(request, user, edit_secret=x_edit_secret)
    items = await trash.delete_forever(db, actor, slug)
    return JSONResponse({"deleted": True, "items": items}, headers=_NO_STORE)


@router.get("/api/v1/documents/{slug}/delete-preview")
@limiter.limit("120/minute")
async def delete_preview(request: Request, slug: str, db: AsyncIOMotorDatabase = Depends(get_db),
                         x_edit_secret: str | None = Header(None), user: User | None = Depends(optional_user)):
    """What a delete of ``slug`` would take, for the delete dialog: kind, title,
    link, and how many sub-pages sit below it (direct, and in all)."""
    from app.services.workspace_items import display_title

    actor = access.actor_from_request(request, user, edit_secret=x_edit_secret)
    raw = await db["documents"].find_one({"slug": slug}, {"content": 0})
    await access.require(actor, raw, "delete", access.Ctx(db, surface="rest"))
    kids = await pages.children_rows(db, raw["_id"], projection={"_id": 1})
    below = await pages.descendants(db, raw, projection={"_id": 1}) if kids else []
    from app.services import artifact as art_service

    return JSONResponse({
        "slug": raw["slug"], "title": display_title(raw), "kind": pages.deleted_item(raw)["kind"],
        "type_label": art_service.label_for(raw.get("mime") or "") if raw.get("kind") == "artifact" else None,
        "url": trash.public_url(raw["slug"]), "children": len(kids), "descendants": len(below),
        "days": trash.DAYS,
    }, headers=_NO_STORE)
