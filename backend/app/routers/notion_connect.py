"""Connect Notion (services/notion_import/connect.py, api_source.py, sync.py): import straight from Notion
and keep it in sync, one way (Notion → Markdrop). Read-only in Notion.

    GET    /api/v1/notion/status                    set up?, my Notion connections, my synced roots
    POST   /api/v1/notion/connect/start {back?}     → {url}: Notion's consent screen (pick the pages to share)
    POST   /api/v1/notion/connect/finish {code, state}   the end of it (stores my token, encrypted)
    DELETE /api/v1/notion/connections/{id}          disconnect (revokes the token; imported pages stay)
    GET    /api/v1/notion/connections/{id}/pages    the pages and databases I shared with Markdrop (the picker)
    POST   /api/v1/notion/import                    import chosen pages → an import job (follow it at
                                                    GET /api/v1/imports/notion/{id}); keep_in_sync per root
    PATCH  /api/v1/notion/syncs/{id} {keep_in_sync} turn Keep in sync on or off
    POST   /api/v1/notion/syncs/{id}/run            Sync now → the job
    DELETE /api/v1/notion/syncs/{id}                stop following that root (its pages stay)

Signed-in people only; connections and syncs are their owner's own (anyone else's answers 404), and an
import goes only where its owner can add pages (checked again on every sync).
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
from app.routers.notion_import import Destination
from app.services.notion_import import connect, jobs
from app.services.notion_import import sync as S

router = APIRouter(prefix="/api/v1/notion", tags=["import"])

_ID = r"^[A-Za-z0-9_-]{4,64}$"


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


class StartIn(BaseModel):
    back: Optional[str] = Field(None, max_length=500, description="A path on Markdrop to come back to.")


class FinishIn(BaseModel):
    code: str = Field(..., min_length=1, max_length=500)
    state: str = Field(..., min_length=10, max_length=1000)


class Root(BaseModel):
    id: str = Field(..., min_length=32, max_length=36, description="A Notion page or database id.")
    kind: Optional[str] = Field(None, pattern="^(page|database)$")


class ImportIn(BaseModel):
    connection_id: Optional[str] = Field(None, pattern=_ID, description="Default: your only Notion connection.")
    pages: list[Root] = Field(..., min_length=1, max_length=50,
                              description="The pages / databases to import (their sub-pages come with them).")
    destination: Destination = Field(default_factory=Destination)
    keep_in_sync: bool = Field(False, description="Import again about every 15 minutes (only what changed).")


class KeepIn(BaseModel):
    keep_in_sync: bool


@router.get("/status", summary="Notion connection status")
@limiter.limit("120/minute")
async def status(request: Request, user: User = Depends(require_user), db: AsyncIOMotorDatabase = Depends(get_db)):
    conns = [connect.out(r) for r in await connect.list_for(db, user)] if connect.configured() else []
    return {"configured": connect.configured(), "connections": conns, "syncs": await S.list_for(db, user),
            "sync_minutes": int(S.every().total_seconds() // 60)}


@router.post("/connect/start", summary="Start connecting Notion")
@limiter.limit("20/minute")
async def connect_start(request: Request, body: StartIn, user: User = Depends(require_user)):
    return {"url": connect.start(user, body.back)}


@router.post("/connect/finish", summary="Finish connecting Notion")
@limiter.limit("20/minute")
async def connect_finish(request: Request, body: FinishIn, user: User = Depends(require_user),
                         db: AsyncIOMotorDatabase = Depends(get_db)):
    return await connect.finish(db, user, body.code, body.state)


@router.delete("/connections/{connection_id}", summary="Disconnect Notion")
@limiter.limit("20/minute")
async def disconnect(request: Request, connection_id: str, user: User = Depends(require_user),
                     db: AsyncIOMotorDatabase = Depends(get_db)):
    return await connect.disconnect(db, user, connection_id)


@router.get("/connections/{connection_id}/pages", summary="Pages shared with Markdrop in Notion")
@limiter.limit("30/minute")
async def shared_pages(request: Request, connection_id: str, user: User = Depends(require_user),
                       db: AsyncIOMotorDatabase = Depends(get_db)):
    connect.need_configured()
    conn = await connect.get_own(db, user, connection_id)
    return await jobs.shared_listing(db, conn)


@router.post("/import", status_code=201, summary="Import from Notion (connected)")
@limiter.limit("20/minute")
async def import_pages(request: Request, body: ImportIn, user: User = Depends(require_user),
                       db: AsyncIOMotorDatabase = Depends(get_db)):
    job = await jobs.create_api(db, user, connection_id=body.connection_id, roots=[p.model_dump() for p in body.pages],
                                destination=body.destination.model_dump(), keep_in_sync=body.keep_in_sync)
    return {"import": jobs.out(job)}


@router.patch("/syncs/{sync_id}", summary="Keep a Notion import in sync")
@limiter.limit("60/minute")
async def set_keep(request: Request, sync_id: str, body: KeepIn, user: User = Depends(require_user),
                   db: AsyncIOMotorDatabase = Depends(get_db)):
    return await S.set_keep(db, user, sync_id, body.keep_in_sync)


@router.post("/syncs/{sync_id}/run", summary="Sync a Notion import now")
@limiter.limit("30/minute")
async def run_sync(request: Request, sync_id: str, user: User = Depends(require_user),
                   db: AsyncIOMotorDatabase = Depends(get_db)):
    connect.need_configured()
    job = await S.run_now(db, user, sync_id)
    return {"import": jobs.out(job), "sync": await S.list_one(db, user, sync_id)}


@router.delete("/syncs/{sync_id}", status_code=204, summary="Stop syncing a Notion import")
@limiter.limit("30/minute")
async def remove_sync(request: Request, sync_id: str, user: User = Depends(require_user),
                      db: AsyncIOMotorDatabase = Depends(get_db)):
    await S.remove(db, user, sync_id)
