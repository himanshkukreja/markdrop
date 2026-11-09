"""The API's own health for the admin console (services/memory_health.py).

    GET /api/v1/admin/health/memory?hours=24   this process: RSS, swap, gc, the known caches' sizes,
                                               tracemalloc's top 20 (MARKDROP_TRACEMALLOC=1); every
                                               process's samples of the last ``hours`` (the Product
                                               health card's chart) and each one's latest
"""

from fastapi import APIRouter, Depends, Query
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.routers.admin import get_db, require_admin
from app.services import memory_health

router = APIRouter(prefix="/api/v1/admin/health", tags=["admin"])


@router.get("/memory")
async def memory(hours: int = Query(24, ge=1, le=72), db: AsyncIOMotorDatabase = Depends(get_db),
                 _: dict = Depends(require_admin)) -> dict:
    out = memory_health.report()
    samples = await memory_health.history(db, hours)
    latest: dict[str, dict] = {}
    for s in samples:
        latest[f"{s.get('host')}:{s.get('pid')}"] = s
    out["samples"] = samples
    # Each process's newest sample, newest first (a restarted process is a new pid).
    out["processes"] = sorted(latest.values(), key=lambda s: s["at"], reverse=True)[:8]
    return out
