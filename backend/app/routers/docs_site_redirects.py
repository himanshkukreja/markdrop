"""A guide's redirects as Settings shows them: /api/v1/docs-sites/{site_id}/redirects.

The guide's own (``settings.redirects``, each with why it's there: a page moved, or someone added it)
are on the site view and saved with PATCH /{site_id}. This adds the ones an import brought
(``engine_extra.redirects``: a GitBook space's old addresses), which the build writes beside them
and Settings lists read-only. Everyone on the guide reads them. Included by routers/docs_sites.py.
"""

from fastapi import APIRouter, Depends, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.routers.docs_site_pages import DocsRoute
from app.services import docs_site_store as store

router = APIRouter(route_class=DocsRoute)


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


@router.get("/{site_id}/redirects/imported")
@limiter.limit("60/minute")
async def imported_redirects(request: Request, site_id: str, limit: int = Query(200, ge=1, le=2000),
                             db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """{count, redirects: [{from, to}]} (the first ``limit``), from the guide's import."""
    site, _role = await store.load_site(db, site_id, user)
    raw = (site.get("engine_extra") or {}).get("redirects")
    if isinstance(raw, dict):
        pairs = list(raw.items())
    elif isinstance(raw, list):
        pairs = [(r.get("from"), r.get("to")) for r in raw if isinstance(r, dict)]
    else:
        pairs = []
    rows = [{"from": f, "to": t} for f, t in pairs if isinstance(f, str) and isinstance(t, str)]
    return {"count": len(rows), "redirects": rows[:limit]}
