"""A guide's own domains: /api/v1/docs-sites/{site_id}/domains…

Add one (it is registered on Cloudflare for SaaS by the ``domain`` job, which runs right away),
check it again now, or remove it (services/docs_custom_domains.py). Guides admins of the site
only; every answer is the site view, whose ``domains`` carry each one's status and, for admins, the
DNS records to add. Included by routers/docs_sites.py.
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.services import docs_custom_domains as domains
from app.services import docs_site_store as store

router = APIRouter()


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


class DomainAdd(BaseModel):
    host: str = Field(..., max_length=300)


NOT_AVAILABLE = "Own domains aren't switched on for this Markdrop server yet."


async def _fresh(db: AsyncIOMotorDatabase, site: dict, role) -> dict:
    row = await db[store.SITES].find_one({"_id": site["_id"]})
    return await store.site_view(db, row or site, role)


@router.post("/{site_id}/domains", status_code=201)
@limiter.limit("20/minute")
async def add_domain(request: Request, site_id: str, body: DomainAdd, db: AsyncIOMotorDatabase = Depends(get_db),
                     user: User = Depends(require_user)):
    site, role = await store.site_access(db, site_id, user, "admin")
    try:
        await domains.add(db, site, body.host, user.id)
    except PermissionError:
        raise HTTPException(status_code=503, detail=NOT_AVAILABLE) from None
    except LookupError as e:
        raise HTTPException(status_code=409, detail=str(e)) from None
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None
    await store.log_event(db, "docs_domain_added", site, user.id)
    return await _fresh(db, site, role)


@router.post("/{site_id}/domains/{host}/check")
@limiter.limit("20/minute")
async def check_domain(request: Request, site_id: str, host: str, db: AsyncIOMotorDatabase = Depends(get_db),
                       user: User = Depends(require_user)):
    site, role = await store.site_access(db, site_id, user, "admin")
    try:
        found = await domains.check_now(db, site, host)
    except PermissionError:
        raise HTTPException(status_code=503, detail=NOT_AVAILABLE) from None
    except domains.DomainError:
        raise HTTPException(status_code=502, detail="Cloudflare didn't answer. Try again in a minute.") from None
    if not found:
        raise HTTPException(status_code=404, detail="That domain isn't on this guide.")
    return await _fresh(db, site, role)


@router.delete("/{site_id}/domains/{host}")
@limiter.limit("20/minute")
async def remove_domain(request: Request, site_id: str, host: str, db: AsyncIOMotorDatabase = Depends(get_db),
                        user: User = Depends(require_user)):
    site, role = await store.site_access(db, site_id, user, "admin")
    if not await domains.remove(db, site, host, user.id):
        raise HTTPException(status_code=404, detail="That domain isn't on this guide.")
    return await _fresh(db, site, role)
