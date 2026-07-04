"""Admin API — JWT-protected endpoints for managing all documents.

Authentication flow
-------------------
1. POST /api/v1/admin/login  { username, password }
   → returns { token, expires_at }  (token is a signed JWT, valid 24 h)

2. All other admin endpoints require:
   Authorization: Bearer <token>

Security notes
--------------
- Username and password are compared with secrets.compare_digest to prevent
  timing attacks.
- The JWT is signed with MARKDROP_ADMIN_SECRET (HS256). Set this to a long
  random value in production.
- Admin update bypasses the per-document edit_secret — only the JWT is checked.
- Rate limit on login: 5 requests / minute per IP (brute-force mitigation).
"""

import math
import secrets
from datetime import datetime, timedelta, timezone

import jwt
from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.config import get_settings
from app.database import get_database
from app.limiter import limiter  # shared slowapi limiter
from app.schemas.document import MAX_CONTENT

settings = get_settings()
router = APIRouter(prefix="/api/v1/admin", tags=["admin"])

BASE_URL = "https://markdrop.in"


# ── Pydantic schemas ─────────────────────────────────────────────────────────


class AdminLoginRequest(BaseModel):
    username: str
    password: str


class AdminLoginResponse(BaseModel):
    token: str
    expires_at: datetime


class AdminDocListItem(BaseModel):
    slug: str
    title: str | None
    content_preview: str
    created_at: datetime
    updated_at: datetime
    expires_at: datetime | None = None
    views: int
    is_password_protected: bool
    content_length: int
    owner_id: str | None = None
    owner_email: str | None = None
    report_count: int = 0


class AdminDocListResponse(BaseModel):
    documents: list[AdminDocListItem]
    total: int
    page: int
    pages: int


class AdminUserListItem(BaseModel):
    id: str
    email: str
    name: str | None = None
    picture: str | None = None
    providers: list[str] = []
    created_at: datetime
    last_login_at: datetime | None = None
    document_count: int = 0


class AdminUserListResponse(BaseModel):
    users: list[AdminUserListItem]
    total: int
    page: int
    pages: int


class AdminDocumentUpdate(BaseModel):
    title: str | None = Field(None, max_length=200)
    content: str = Field(..., min_length=1, max_length=MAX_CONTENT)


class AdminDocumentResponse(BaseModel):
    slug: str
    url: str
    title: str | None
    content: str
    created_at: datetime
    updated_at: datetime
    expires_at: datetime | None = None
    views: int
    is_password_protected: bool

    model_config = {"from_attributes": True}


# ── Helpers ───────────────────────────────────────────────────────────────────


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _make_token() -> tuple[str, datetime]:
    """Return (signed JWT, expiry datetime)."""
    exp = datetime.now(timezone.utc) + timedelta(hours=24)
    payload = {"sub": settings.admin_username, "exp": exp}
    token = jwt.encode(payload, settings.admin_secret, algorithm="HS256")
    return token, exp


def _verify_token(token: str) -> dict:
    """Decode and validate the JWT. Raises HTTP 401 on any failure."""
    try:
        return jwt.decode(token, settings.admin_secret, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Admin token expired — please log in again")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid admin token")


async def require_admin(request: Request) -> dict:
    """FastAPI dependency — validates Bearer token and returns the payload."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing admin token")
    return _verify_token(auth.removeprefix("Bearer ").strip())


def _to_list_item(raw: dict, owner_email: str | None = None) -> AdminDocListItem:
    content: str = raw.get("content", "")
    return AdminDocListItem(
        slug=raw["slug"],
        title=raw.get("title"),
        content_preview=content[:300],
        created_at=raw["created_at"],
        updated_at=raw["updated_at"],
        expires_at=raw.get("expires_at"),
        views=raw.get("views", 0),
        is_password_protected=bool(raw.get("read_password_hash")),
        content_length=len(content),
        owner_id=raw.get("owner_id"),
        owner_email=owner_email,
        report_count=raw.get("report_count", 0),
    )


async def _owner_email_map(db: AsyncIOMotorDatabase, docs: list[dict]) -> dict[str, str]:
    """Map owner_id → email for the documents that have an owner."""
    ids = {d["owner_id"] for d in docs if d.get("owner_id")}
    valid = [ObjectId(i) for i in ids if ObjectId.is_valid(i)]
    if not valid:
        return {}
    out: dict[str, str] = {}
    async for u in db["users"].find({"_id": {"$in": valid}}, {"email": 1}):
        out[str(u["_id"])] = u["email"]
    return out


def _to_doc_response(raw: dict) -> dict:
    return {
        "slug": raw["slug"],
        "url": f"{BASE_URL}/{raw['slug']}",
        "title": raw.get("title"),
        "content": raw["content"],
        "created_at": raw["created_at"],
        "updated_at": raw["updated_at"],
        "expires_at": raw.get("expires_at"),
        "views": raw.get("views", 0),
        "is_password_protected": bool(raw.get("read_password_hash")),
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────


@router.post("/login", response_model=AdminLoginResponse)
@limiter.limit("5/minute")
async def admin_login(request: Request, data: AdminLoginRequest):
    """Verify admin credentials and return a signed JWT (valid 24 h)."""
    username_ok = secrets.compare_digest(data.username, settings.admin_username)
    password_ok = secrets.compare_digest(data.password, settings.admin_password)
    if not (username_ok and password_ok):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token, exp = _make_token()
    return AdminLoginResponse(token=token, expires_at=exp)


@router.get("/documents", response_model=AdminDocListResponse)
async def list_all_documents(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    q: str | None = Query(None),
    reported: bool = Query(False),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """List documents. `q` uses the full-text index; `reported=1` filters flagged docs."""
    query: dict = {}
    if q:
        query["$text"] = {"$search": q}
    if reported:
        query["report_count"] = {"$gt": 0}

    total = await db["documents"].count_documents(query)
    skip = (page - 1) * limit
    sort_field = "report_count" if reported else "created_at"
    cursor = (
        db["documents"]
        .find(query, {"_id": 0})
        .sort(sort_field, -1)
        .skip(skip)
        .limit(limit)
    )
    docs = await cursor.to_list(length=limit)
    owner_map = await _owner_email_map(db, docs)

    return AdminDocListResponse(
        documents=[_to_list_item(d, owner_map.get(d.get("owner_id"))) for d in docs],
        total=total,
        page=page,
        pages=max(1, math.ceil(total / limit)),
    )


@router.get("/users", response_model=AdminUserListResponse)
async def list_all_users(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    q: str | None = Query(None),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """List all registered users (newest first), with their document counts."""
    query: dict = {}
    if q:
        query["$or"] = [
            {"email": {"$regex": q, "$options": "i"}},
            {"name": {"$regex": q, "$options": "i"}},
        ]

    total = await db["users"].count_documents(query)
    skip = (page - 1) * limit
    users = await (
        db["users"].find(query).sort("created_at", -1).skip(skip).limit(limit)
    ).to_list(length=limit)

    # Document counts per user on this page
    ids = [str(u["_id"]) for u in users]
    counts: dict[str, int] = {}
    if ids:
        async for row in db["documents"].aggregate(
            [{"$match": {"owner_id": {"$in": ids}}}, {"$group": {"_id": "$owner_id", "n": {"$sum": 1}}}]
        ):
            counts[row["_id"]] = row["n"]

    items = [
        AdminUserListItem(
            id=str(u["_id"]),
            email=u["email"],
            name=u.get("name"),
            picture=u.get("picture"),
            providers=u.get("providers", []),
            created_at=u["created_at"],
            last_login_at=u.get("last_login_at"),
            document_count=counts.get(str(u["_id"]), 0),
        )
        for u in users
    ]
    return AdminUserListResponse(
        users=items, total=total, page=page, pages=max(1, math.ceil(total / limit))
    )


@router.get("/documents/{slug}", response_model=AdminDocumentResponse)
async def admin_get_document(
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """Fetch a single document (bypasses password gate)."""
    raw = await db["documents"].find_one({"slug": slug}, {"_id": 0})
    if not raw:
        raise HTTPException(status_code=404, detail="Document not found")
    return _to_doc_response(raw)


@router.put("/documents/{slug}", response_model=AdminDocumentResponse)
async def admin_update_document(
    slug: str,
    data: AdminDocumentUpdate,
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """Update title and content without requiring the per-document edit_secret."""
    raw = await db["documents"].find_one({"slug": slug}, {"_id": 0})
    if not raw:
        raise HTTPException(status_code=404, detail="Document not found")

    now = datetime.now(timezone.utc)
    updates = {
        "title": data.title or None,
        "content": data.content,
        "updated_at": now,
    }
    await db["documents"].update_one({"slug": slug}, {"$set": updates})
    raw.update(updates)
    return _to_doc_response(raw)


@router.delete("/documents/{slug}", status_code=204)
async def admin_delete_document(
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """Permanently delete a document without requiring the edit_secret."""
    result = await db["documents"].delete_one({"slug": slug})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Document not found")
