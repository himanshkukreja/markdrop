"""The Fix list of a Markdrop Guides site (services/guide_fixes.py, services/guide_fix_drafts.py),
under /api/v1/docs-sites/{site_id} (signed in; a Guides role on the site):

    GET    …/fixes?status=active|open|in_progress|fixed|dismissed|all&type=&path=   viewers and up
           the ranked items, counts by status and type, the pages with items, when it was
           last checked (a check runs first when the last one is a day old)
    GET    …/fixes/count                         viewers and up: {open, high} (the site bar's badge)
    GET    …/fixes/{id}                          viewers and up: one item with its evidence, history, draft
    POST   …/fixes/check                         editors and up: re-detect now
    PATCH  …/fixes/{id}  {status, reason?, note?}   editors and up: start / mark fixed / dismiss / reopen
    POST   …/fixes/{id}/draft                    editors and up: an AI-drafted fix (the guide's AI budget)
    POST   …/fixes/{id}/applied {page_id}        editors and up: the draft is in the page (in progress)
"""

# No `from __future__ import annotations`: slowapi wraps these routes (see routers/docs_ai.py).
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.routers.docs_site_pages import DocsRoute
from app.services import docs_site_store as store
from app.services import guide_fix_drafts as drafts
from app.services import guide_fixes as fixes
from app.services import guide_insights as gi

router = APIRouter(route_class=DocsRoute)


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _out(data: dict, site: dict, role: str) -> dict:
    data["can_edit"] = store.role_at_least(role, "editor")
    data["enabled"] = gi.enabled(site)
    data["live"] = site.get("status") == "live" and bool(site.get("live_build_id"))
    return data


@router.get("/{site_id}/fixes")
@limiter.limit("60/minute")
async def list_fixes(request: Request, site_id: str,
                     status: str = Query("active", pattern="^(active|open|in_progress|fixed|dismissed|all)$"),
                     type: str | None = Query(None, pattern="^(drop|search|ask|not_helpful|video|broken|stale|heavy)$"),
                     path: str | None = Query(None, max_length=400),
                     db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, role = await store.load_site(db, site_id, user)
    if gi.enabled(site) and (site.get("live_build_id") or site.get("last_published_at")):
        try:
            await fixes.check_if_due(db, site)
        except Exception:
            fixes.log.warning("fix list check failed for %s", site_id, exc_info=True)
        else:
            await fixes.reconcile_applied(db, site)
    return _out(await fixes.listing(db, site, status=status, type_=type, path=path), site, role)


@router.get("/{site_id}/fixes/count")
@limiter.limit("240/minute")
async def count_fixes(request: Request, site_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user)
    sid = str(site["_id"])
    return (await fixes.open_counts(db, [sid])).get(sid, {"open": 0, "high": 0})


@router.post("/{site_id}/fixes/check")
@limiter.limit("6/minute")
async def check_fixes(request: Request, site_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    site, role = await store.load_site(db, site_id, user, "editor")
    st = await fixes.state(db, str(site["_id"]))
    last = fixes.aware(st.get("checked_at"))
    if last and fixes.now() - last < fixes.MANUAL_CHECK_EVERY:
        raise HTTPException(status_code=429, detail="Checked a moment ago. Try again in a couple of minutes.")
    stats = await fixes.check(db, site)
    out = await fixes.listing(db, site)
    out["stats"] = stats
    return _out(out, site, role)


@router.get("/{site_id}/fixes/{item_id}")
@limiter.limit("120/minute")
async def get_fix(request: Request, site_id: str, item_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    site, role = await store.load_site(db, site_id, user)
    it = await fixes.get_item(db, str(site["_id"]), item_id)
    if it is None:
        raise HTTPException(status_code=404, detail="Not on the Fix list")
    out = fixes.view(it, full=True)
    out["can_edit"] = store.role_at_least(role, "editor")
    return out


class StatusBody(BaseModel):
    status: str = Field(..., pattern="^(open|in_progress|fixed|dismissed)$")
    reason: str | None = Field(None, pattern="^(not_a_problem|wont_fix|duplicate|other)$")
    note: str | None = Field(None, max_length=500)


@router.patch("/{site_id}/fixes/{item_id}")
@limiter.limit("120/minute")
async def set_fix_status(request: Request, site_id: str, item_id: str, body: StatusBody,
                         db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user, "editor")
    if body.status == "dismissed" and not body.reason:
        raise HTTPException(status_code=422, detail="Say why it's dismissed")
    it = await fixes.set_status(db, str(site["_id"]), item_id, body.status, user.id, reason=body.reason, note=body.note)
    if it is None:
        raise HTTPException(status_code=404, detail="Not on the Fix list")
    return fixes.view(it, full=True)


@router.post("/{site_id}/fixes/{item_id}/draft")
@limiter.limit("20/minute")
async def draft_fix(request: Request, site_id: str, item_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                    user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user, "editor")
    return await drafts.draft(db, site, user, item_id)


class AppliedBody(BaseModel):
    page_id: str = Field(..., pattern="^[0-9a-f]{24}$")


@router.post("/{site_id}/fixes/{item_id}/applied")
@limiter.limit("60/minute")
async def fix_applied(request: Request, site_id: str, item_id: str, body: AppliedBody,
                      db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user, "editor")
    page = await db[store.PAGES].find_one({"_id": store.oid(body.page_id), "site_id": site["_id"], "deleted_at": None},
                                          {"_id": 1})
    if page is None:
        raise HTTPException(status_code=404, detail="Unknown page")
    it = await fixes.mark_applied(db, site, item_id, body.page_id, user.id)
    if it is None:
        raise HTTPException(status_code=404, detail="Not on the Fix list")
    return fixes.view(it, full=True)
