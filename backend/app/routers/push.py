"""Push notifications on the signed-in person's devices (services/push.py, services/webpush.py).

    GET    /api/v1/push?endpoint=                    {enabled, public_key, devices, prefs, kinds}
    POST   /api/v1/push/subscriptions               this device's subscription → {device}
                                                    ({refresh: true}: only an already known one → {device|null})
    POST   /api/v1/push/subscriptions/remove        {endpoint} this device stops → {removed}
    DELETE /api/v1/push/devices/{id}                any of their devices → {removed}
    PATCH  /api/v1/push/prefs                       {mention?: bool, …} → {prefs}
    POST   /api/v1/push/test                        {device_id?} a test notification → {sent, …}
    POST   /api/v1/push/read?t=                     the notification's click (from the service
                                                    worker, no session): marks those read → {marked}

Not on a workspace's own domain (its session reads documents there; push belongs to the account).
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import is_tenant_request, require_user
from app.services import push as svc

router = APIRouter(prefix="/api/v1/push", tags=["push"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _app_only(request: Request) -> None:
    if is_tenant_request(request):
        raise HTTPException(status_code=403, detail="Push notifications are on markdrop.in.")


class Keys(BaseModel):
    p256dh: str = Field(..., max_length=200)
    auth: str = Field(..., max_length=100)


class Subscription(BaseModel):
    endpoint: str = Field(..., max_length=1024)
    keys: Keys
    # PushSubscription.expirationTime: ms since the epoch, or null.
    expirationTime: float | None = None
    # Running as the installed app (display-mode: standalone).
    standalone: bool = False
    # The app opening (not "Turn on"): only keeps a device this account already has.
    refresh: bool = False


class Endpoint(BaseModel):
    endpoint: str = Field(..., max_length=1024)


class Prefs(BaseModel):
    mention: bool | None = None
    signoff_requested: bool | None = None
    shared: bool | None = None
    access_request: bool | None = None
    comment_mention: bool | None = None
    comment_assigned: bool | None = None


class TestPush(BaseModel):
    device_id: str | None = Field(None, max_length=40)


@router.get("")
@limiter.limit("60/minute")
async def push_status(request: Request, endpoint: str | None = None, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    """Whether push is set up here, the key a browser subscribes with, this person's devices
    (``endpoint``: this browser's own, marked ``this_device``) and which kinds they want."""
    _app_only(request)
    return await svc.status(db, user.id, endpoint)


# No @limiter on the body routes: slowapi's wrapper hides the body model from FastAPI. Signed-in only.
@router.post("/subscriptions")
async def subscribe(request: Request, data: Subscription, db: AsyncIOMotorDatabase = Depends(get_db),
                    user: User = Depends(require_user)):
    _app_only(request)
    expires = None
    if data.expirationTime:
        try:
            expires = datetime.fromtimestamp(data.expirationTime / 1000, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            expires = None
    device = await svc.subscribe(db, user.id, data.endpoint, data.keys.p256dh, data.keys.auth,
                                 ua=request.headers.get("user-agent"), standalone=data.standalone, expires_at=expires,
                                 refresh=data.refresh)
    return {"device": device}


@router.post("/subscriptions/remove")
async def unsubscribe(request: Request, data: Endpoint, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    _app_only(request)
    return {"removed": await svc.unsubscribe(db, user.id, data.endpoint)}


@router.delete("/devices/{device_id}")
@limiter.limit("60/minute")
async def remove_device(request: Request, device_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                        user: User = Depends(require_user)):
    _app_only(request)
    if not await svc.remove_device(db, user.id, device_id):
        raise HTTPException(status_code=404, detail="That device isn't on your list.")
    return {"removed": True}


@router.patch("/prefs")
async def set_prefs(request: Request, data: Prefs, db: AsyncIOMotorDatabase = Depends(get_db),
                    user: User = Depends(require_user)):
    _app_only(request)
    return {"prefs": await svc.set_prefs(db, user.id, data.model_dump(exclude_none=True))}


@router.post("/test")
async def test_push(request: Request, data: TestPush, db: AsyncIOMotorDatabase = Depends(get_db),
                    user: User = Depends(require_user)):
    _app_only(request)
    return await svc.send_test(db, user.id, data.device_id)


@router.post("/read")
@limiter.limit("120/minute")
async def read_from_click(request: Request, t: str = "", db: AsyncIOMotorDatabase = Depends(get_db)):
    """The service worker calls this when someone clicks a notification: the signed link (made
    for that person and those notifications only) marks them read. No session: the worker has none."""
    return {"marked": await svc.mark_read_by_token(db, t)}
