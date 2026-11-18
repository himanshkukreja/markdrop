"""Import from Notion (services/notion_import/: a "Markdown & CSV" export zip → pages, databases, files).

    GET  /api/v1/imports/notion/destinations   where the caller can import to: My files, and the team spaces
    POST /api/v1/imports/notion                a new import: its id and a URL to PUT the zip to
    POST /api/v1/imports/notion/{id}/start     the zip is up: run it (in the background)
    GET  /api/v1/imports/notion/{id}           progress (N of M), then the report
    GET  /api/v1/imports/notion                the caller's last imports
    POST /api/v1/imports/notion/{id}/cancel    stop it (what was written stays)

Signed-in people only; an import is its starter's own (anyone else's answers 404).
"""

# No `from __future__ import annotations`: slowapi wraps these routes (see routers/docs_ai.py).
from typing import Optional

from fastapi import APIRouter, Depends, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.services.notion_import import jobs

router = APIRouter(prefix="/api/v1/imports/notion", tags=["import"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


class Destination(BaseModel):
    workspace: Optional[str] = Field(None, max_length=64, description="Workspace id; empty: My files.")
    team: Optional[str] = Field(None, max_length=100, description="A team's id, slug or name; empty: company-wide.")
    folder: Optional[str] = Field(None, max_length=500, description="An existing folder (id or path) to import into.")
    new_folder: bool = Field(True, description="Put everything in a new folder (My files: a page) named folder_name.")
    folder_name: Optional[str] = Field(None, max_length=100, description="Default: the export's name.")


class ImportCreate(BaseModel):
    file_name: str = Field(..., min_length=1, max_length=255)
    size_bytes: int = Field(..., ge=1)
    destination: Destination = Field(default_factory=Destination)


@router.get("/destinations")
@limiter.limit("60/minute")
async def destinations(request: Request, user: User = Depends(require_user),
                       db: AsyncIOMotorDatabase = Depends(get_db)):
    return await jobs.destinations(db, user)


@router.post("", status_code=201)
@limiter.limit("20/minute")
async def create_import(request: Request, body: ImportCreate, user: User = Depends(require_user),
                        db: AsyncIOMotorDatabase = Depends(get_db)):
    job, upload = await jobs.create(db, user, file_name=body.file_name, size_bytes=body.size_bytes,
                                    destination=body.destination.model_dump())
    return {"import": jobs.out(job), "upload": upload}


@router.get("")
@limiter.limit("120/minute")
async def list_imports(request: Request, user: User = Depends(require_user),
                       db: AsyncIOMotorDatabase = Depends(get_db)):
    return {"imports": [jobs.out(j) for j in await jobs.recent(db, user)]}


@router.post("/{import_id}/start")
@limiter.limit("30/minute")
async def start_import(request: Request, import_id: str, user: User = Depends(require_user),
                       db: AsyncIOMotorDatabase = Depends(get_db)):
    return jobs.out(await jobs.start(db, user, import_id))


@router.get("/{import_id}")
@limiter.limit("240/minute")
async def get_import(request: Request, import_id: str, user: User = Depends(require_user),
                     db: AsyncIOMotorDatabase = Depends(get_db)):
    return jobs.out(await jobs.get(db, user, import_id))


@router.post("/{import_id}/cancel")
@limiter.limit("30/minute")
async def cancel_import(request: Request, import_id: str, user: User = Depends(require_user),
                        db: AsyncIOMotorDatabase = Depends(get_db)):
    return jobs.out(await jobs.cancel(db, user, import_id))
