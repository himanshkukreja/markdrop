"""A guide's changelog: /api/v1/docs-sites/{site_id}/changelog…

Included by routers/docs_sites.py. Everyone on the guide reads; editors, reviewers and admins write
(entries are content, like pages). Changes go live with the guide's next publish
(services/docs_site_changelog.py).
"""

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, ConfigDict, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.routers.docs_site_pages import DocsRoute
from app.services import docs_site_changelog as changelog
from app.services import docs_site_store as store

router = APIRouter(route_class=DocsRoute)


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Media(_Body):
    image: str | None = Field(None, max_length=600)
    video: str | None = Field(None, max_length=600)
    alt: str | None = Field(None, max_length=400)


class TryLink(_Body):
    label: str | None = Field(None, max_length=80)
    href: str | None = Field(None, max_length=600)


class EntryIn(_Body):
    """Create (title and summary required) or change (any subset, with ``base_rev``) an entry.
    The service checks the values (services/docs_site_changelog.clean_entry)."""
    slug: str | None = Field(None, max_length=120)
    date: str | None = Field(None, max_length=20)
    title: str | None = Field(None, max_length=400)
    kind: Literal["new", "improved", "fixed"] | None = None
    area: str | None = Field(None, max_length=120)
    summary: str | None = Field(None, max_length=1000)
    body: str | None = Field(None, max_length=changelog.MAX_BODY + 1000)
    highlights: list[str] | None = Field(None, max_length=40)
    products: list[str] | None = Field(None, max_length=40)
    versions: dict[str, str | None] | None = None
    media: Media | None = None
    try_: TryLink | None = Field(None, alias="try")
    docs: list[str] | None = Field(None, max_length=40)
    base_rev: int | None = None

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    def fields(self) -> dict[str, Any]:
        out = self.model_dump(exclude_unset=True, by_alias=True)
        out.pop("base_rev", None)
        return out


class ProductIn(_Body):
    id: str | None = Field(None, max_length=40)
    label: str = Field(..., max_length=120)


class NextIn(_Body):
    title: str = Field(..., max_length=400)
    body: str | None = Field(None, max_length=1000)
    area: str | None = Field(None, max_length=120)


class SettingsIn(_Body):
    title: str | None = Field(None, max_length=200)
    description: str | None = Field(None, max_length=1000)
    products: list[ProductIn] = Field(default_factory=list, max_length=40)
    next: list[NextIn] = Field(default_factory=list, max_length=40)


class ImportPage(_Body):
    page_id: str = Field(..., min_length=1, max_length=40)


@router.get("/{site_id}/changelog")
@limiter.limit("240/minute")
async def overview(request: Request, site_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                   user: User = Depends(require_user)):
    """The changelog's settings and every entry (newest first, without details) with its status."""
    site, _role = await store.load_site(db, site_id, user)
    return await changelog.overview(db, site)


@router.put("/{site_id}/changelog/settings")
@limiter.limit("60/minute")
async def save_settings(request: Request, site_id: str, body: SettingsIn, db: AsyncIOMotorDatabase = Depends(get_db),
                        user: User = Depends(require_user)):
    """The hub's title and description, the products entries can name, and Coming next."""
    site, _role = await store.load_site(db, site_id, user, "editor")
    return await changelog.save_settings(db, site, user, body.model_dump())


@router.post("/{site_id}/changelog/entries", status_code=201)
@limiter.limit("60/minute")
async def create_entry(request: Request, site_id: str, body: EntryIn, db: AsyncIOMotorDatabase = Depends(get_db),
                       user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user, "editor")
    row = await changelog.create(db, site, user, body.fields())
    return await changelog.view(db, site, row)


@router.get("/{site_id}/changelog/entries/{entry_id}")
@limiter.limit("240/minute")
async def get_entry(request: Request, site_id: str, entry_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                    user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user)
    return await changelog.view(db, site, await changelog.load(db, site, entry_id))


@router.put("/{site_id}/changelog/entries/{entry_id}")
@limiter.limit("240/minute")
async def save_entry(request: Request, site_id: str, entry_id: str, body: EntryIn,
                     db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """Change any of the fields. ``base_rev``: the rev you edited (409 with the current one when
    someone saved since)."""
    site, _role = await store.load_site(db, site_id, user, "editor")
    row = await changelog.load(db, site, entry_id)
    saved = await changelog.save(db, site, row, user, body.fields(), body.base_rev)
    return await changelog.view(db, site, saved)


@router.delete("/{site_id}/changelog/entries/{entry_id}")
@limiter.limit("60/minute")
async def delete_entry(request: Request, site_id: str, entry_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                       user: User = Depends(require_user)):
    """Readers keep seeing a published entry until the next publish."""
    site, _role = await store.load_site(db, site_id, user, "editor")
    await changelog.delete(db, site, await changelog.load(db, site, entry_id), user)
    return {"deleted": True}


@router.post("/{site_id}/changelog/entries/{entry_id}/duplicate", status_code=201)
@limiter.limit("60/minute")
async def duplicate_entry(request: Request, site_id: str, entry_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                          user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user, "editor")
    row = await changelog.duplicate(db, site, await changelog.load(db, site, entry_id), user)
    return await changelog.view(db, site, row)


@router.get("/{site_id}/changelog/media")
@limiter.limit("120/minute")
async def media(request: Request, site_id: str, kind: Literal["image", "video"] | None = Query(None),
                db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """The guide's images and videos, newest first, for an entry's media."""
    site, _role = await store.load_site(db, site_id, user)
    return {"items": await changelog.media(db, site, kind)}


@router.get("/{site_id}/changelog/candidates")
@limiter.limit("60/minute")
async def candidates(request: Request, site_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                     user: User = Depends(require_user)):
    """Pages that read as dated release notes (Changelog, Release notes, What's new…)."""
    site, _role = await store.load_site(db, site_id, user)
    return {"pages": await changelog.candidates(db, site)}


@router.post("/{site_id}/changelog/import-page", status_code=201)
@limiter.limit("10/minute")
async def import_page(request: Request, site_id: str, body: ImportPage, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    """Turn a page of dated release notes into entries (drafts). The page stays."""
    site, _role = await store.load_site(db, site_id, user, "editor")
    return await changelog.import_page(db, site, user, body.page_id)
