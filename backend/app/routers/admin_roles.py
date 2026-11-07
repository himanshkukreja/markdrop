"""Admin › Admins: who may open the admin console, and (owners only) adding and removing admins.

- GET    /api/v1/admin/admins                 any admin: owners, admins, recent changes, can_manage
- GET    /api/v1/admin/admins/candidates?q=   owners: existing accounts to pick from
- POST   /api/v1/admin/admins {email, note?}  owners: make someone an admin (an address with no account
                                              yet is a pending admin until they first sign in)
- DELETE /api/v1/admin/admins/{email}         owners: take it away

Everything sits behind routers/admin.require_admin (same 401/404 as every admin route). Changes also
need an owner (403 for an admin) and a session signed in within MARKDROP_ADMIN_ROLE_CHANGE_MAX_AGE_HOURS
(default 24; else 401 with `X-Admin-Reauth: fresh`, and the console asks the owner to sign in again).
Rate limited. The rules, the audit rows and the emails are in services/admin_roles.
"""


from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.config import get_settings
from app.limiter import limiter
from app.routers.admin import get_db, require_admin
from app.services import admin_roles

settings = get_settings()
router = APIRouter(prefix="/api/v1/admin/admins", tags=["admin"])


class Person(BaseModel):
    email: str
    name: str | None = None
    picture: str | None = None
    has_account: bool = True
    disabled: bool = False
    last_visit_at: datetime | None = None


class AddedAdmin(Person):
    note: str | None = None
    added_by: str | None = None
    added_at: datetime | None = None


class Change(BaseModel):
    id: str
    at: datetime
    action: str  # "add" | "remove"
    actor: str | None = None
    target: str | None = None
    note: str | None = None
    via: str = "console"


class AdminsResponse(BaseModel):
    you: str
    role: str
    can_manage: bool
    owners: list[Person]
    admins: list[AddedAdmin]
    history: list[Change]


class Candidate(BaseModel):
    email: str
    name: str | None = None
    picture: str | None = None
    role: str | None = None


class AddAdminRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=254)
    note: str | None = Field(None, max_length=admin_roles.NOTE_MAX)


class AddAdminResponse(BaseModel):
    email: str
    pending: bool


async def require_owner(admin: dict = Depends(require_admin)) -> dict:
    if admin.get("role") != "owner":
        raise HTTPException(status_code=403, detail="Only an owner can change who is an admin.")
    return admin


def _require_fresh(admin: dict) -> None:
    hours = settings.admin_role_change_max_age_hours
    issued = admin.get("issued_at")
    if hours > 0 and (issued is None or datetime.now(timezone.utc) - issued > timedelta(hours=hours)):
        raise HTTPException(status_code=401, headers={"X-Admin-Reauth": "fresh"},
                            detail=f"For safety, sign in again before changing admins (your session is more than {hours} hours old).")


def _raise(e: admin_roles.RoleError):
    raise HTTPException(status_code=e.status, detail=e.message)


@router.get("", response_model=AdminsResponse)
@limiter.limit("60/minute")
async def list_admins(request: Request, admin: dict = Depends(require_admin), db: AsyncIOMotorDatabase = Depends(get_db)):
    data = await admin_roles.listing(db)
    return AdminsResponse(you=admin["email"], role=admin["role"], can_manage=admin["role"] == "owner",
                          history=await admin_roles.history(db), **data)


@router.get("/candidates", response_model=list[Candidate])
@limiter.limit("60/minute")
async def search_candidates(request: Request, q: str = Query("", max_length=100), _: dict = Depends(require_owner),
                            db: AsyncIOMotorDatabase = Depends(get_db)):
    return await admin_roles.candidates(db, q)


@router.post("", response_model=AddAdminResponse, status_code=201)
@limiter.limit("10/minute;40/hour")
async def add_admin(request: Request, body: AddAdminRequest, owner: dict = Depends(require_owner),
                    db: AsyncIOMotorDatabase = Depends(get_db)):
    _require_fresh(owner)
    try:
        return await admin_roles.grant(db, owner, body.email, body.note)
    except admin_roles.RoleError as e:
        _raise(e)


@router.delete("/{email}", status_code=204)
@limiter.limit("10/minute;40/hour")
async def remove_admin(request: Request, email: str, owner: dict = Depends(require_owner),
                       db: AsyncIOMotorDatabase = Depends(get_db)):
    _require_fresh(owner)
    try:
        await admin_roles.revoke(db, owner, email)
    except admin_roles.RoleError as e:
        _raise(e)
