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
from fastapi import BackgroundTasks, APIRouter, Depends, HTTPException, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.config import get_settings
from app.database import get_database
from app.limiter import limiter  # shared slowapi limiter
from app.schemas.auth import (
    AudiencePreviewRequest,
    AudiencePreviewResponse,
    CampaignCreateRequest,
    CampaignItem,
    CampaignListResponse,
    CampaignTestRequest,
)
from app.schemas.document import MAX_CONTENT
from app.services import campaign, mailer
from app.services import feedback as feedback_service

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
    # Feature usage
    vscode_token_count: int = 0
    vscode_last_synced_at: datetime | None = None
    google_connected: bool = False
    google_export_count: int = 0
    share_count: int = 0


class AdminUserListResponse(BaseModel):
    users: list[AdminUserListItem]
    total: int
    page: int
    pages: int


class FeatureUsageResponse(BaseModel):
    total_users: int
    # VS Code sync
    vscode_users_with_token: int
    vscode_users_synced: int
    vscode_tokens_total: int
    # Google Drive / Docs
    google_connected_users: int
    google_exported_docs: int
    # P2P file sharing
    share_events_total: int
    share_users_identified: int
    share_events_anonymous: int


class AdminShareEventItem(BaseModel):
    id: str
    ts: datetime
    room_id: str
    file_name: str | None = None
    file_size: int | None = None
    mime_type: str | None = None
    user_id: str | None = None
    user_email: str | None = None


class AdminShareEventListResponse(BaseModel):
    events: list[AdminShareEventItem]
    total: int
    page: int
    pages: int


class AdminFeedbackItem(BaseModel):
    id: str
    type: str  # "bug" | "feature"
    message: str
    email: str | None = None
    user_id: str | None = None
    user_email: str | None = None
    page_url: str | None = None
    user_agent: str | None = None
    status: str  # "open" | "resolved"
    created_at: datetime


class AdminFeedbackListResponse(BaseModel):
    items: list[AdminFeedbackItem]
    total: int
    open_count: int
    page: int
    pages: int


class FeedbackStatusUpdate(BaseModel):
    status: str  # "open" | "resolved"


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

    # Per-user aggregates for the users on this page
    ids = [str(u["_id"]) for u in users]
    counts: dict[str, int] = {}
    gdoc_counts: dict[str, int] = {}
    token_agg: dict[str, dict] = {}
    share_counts: dict[str, int] = {}
    if ids:
        # Document counts (all + Google-exported) in a single pass
        async for row in db["documents"].aggregate(
            [
                {"$match": {"owner_id": {"$in": ids}}},
                {
                    "$group": {
                        "_id": "$owner_id",
                        "n": {"$sum": 1},
                        "gdocs": {
                            "$sum": {"$cond": [{"$ifNull": ["$google_doc_id", False]}, 1, 0]}
                        },
                    }
                },
            ]
        ):
            counts[row["_id"]] = row["n"]
            gdoc_counts[row["_id"]] = row.get("gdocs", 0)

        # VS Code sync: token count + most recent sync per user
        async for row in db["api_tokens"].aggregate(
            [
                {"$match": {"user_id": {"$in": ids}}},
                {
                    "$group": {
                        "_id": "$user_id",
                        "n": {"$sum": 1},
                        "last_used": {"$max": "$last_used_at"},
                    }
                },
            ]
        ):
            token_agg[row["_id"]] = row

        # P2P shares attributed to each user
        async for row in db["share_events"].aggregate(
            [
                {"$match": {"user_id": {"$in": ids}}},
                {"$group": {"_id": "$user_id", "n": {"$sum": 1}}},
            ]
        ):
            share_counts[row["_id"]] = row["n"]

    items = []
    for u in users:
        uid = str(u["_id"])
        tok = token_agg.get(uid, {})
        items.append(
            AdminUserListItem(
                id=uid,
                email=u["email"],
                name=u.get("name"),
                picture=u.get("picture"),
                providers=u.get("providers", []),
                created_at=u["created_at"],
                last_login_at=u.get("last_login_at"),
                document_count=counts.get(uid, 0),
                vscode_token_count=tok.get("n", 0),
                vscode_last_synced_at=tok.get("last_used"),
                google_connected=bool(u.get("google_refresh_token_enc")),
                google_export_count=gdoc_counts.get(uid, 0),
                share_count=share_counts.get(uid, 0),
            )
        )
    return AdminUserListResponse(
        users=items, total=total, page=page, pages=max(1, math.ceil(total / limit))
    )


@router.get("/feature-usage", response_model=FeatureUsageResponse)
async def feature_usage(
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """Adoption totals for VS Code sync, Google Drive, and P2P file sharing."""
    total_users = await db["users"].count_documents({})

    # VS Code sync — distinct users with a token, and of those, who has synced
    token_users = await db["api_tokens"].distinct("user_id")
    synced_users = await db["api_tokens"].distinct(
        "user_id", {"last_used_at": {"$ne": None}}
    )
    tokens_total = await db["api_tokens"].count_documents({})

    # Google Drive / Docs
    google_connected = await db["users"].count_documents(
        {"google_refresh_token_enc": {"$ne": None}}
    )
    google_exported = await db["documents"].count_documents(
        {"google_doc_id": {"$ne": None}}
    )

    # P2P file sharing
    shares_total = await db["share_events"].count_documents({})
    shares_anon = await db["share_events"].count_documents({"user_id": None})
    share_users = await db["share_events"].distinct(
        "user_id", {"user_id": {"$ne": None}}
    )

    return FeatureUsageResponse(
        total_users=total_users,
        vscode_users_with_token=len(token_users),
        vscode_users_synced=len(synced_users),
        vscode_tokens_total=tokens_total,
        google_connected_users=google_connected,
        google_exported_docs=google_exported,
        share_events_total=shares_total,
        share_users_identified=len(share_users),
        share_events_anonymous=shares_anon,
    )


@router.get("/share-events", response_model=AdminShareEventListResponse)
async def list_share_events(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    identified: bool = Query(False),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """List P2P file-share events (newest first). `identified=1` hides anonymous shares."""
    query: dict = {}
    if identified:
        query["user_id"] = {"$ne": None}

    total = await db["share_events"].count_documents(query)
    skip = (page - 1) * limit
    rows = await (
        db["share_events"].find(query).sort("ts", -1).skip(skip).limit(limit)
    ).to_list(length=limit)

    # Resolve emails for the identified sharers on this page
    uids = {r["user_id"] for r in rows if r.get("user_id")}
    valid = [ObjectId(i) for i in uids if ObjectId.is_valid(i)]
    email_map: dict[str, str] = {}
    if valid:
        async for u in db["users"].find({"_id": {"$in": valid}}, {"email": 1}):
            email_map[str(u["_id"])] = u["email"]

    events = [
        AdminShareEventItem(
            id=str(r["_id"]),
            ts=r["ts"],
            room_id=r.get("room_id", ""),
            file_name=r.get("file_name"),
            file_size=r.get("file_size"),
            mime_type=r.get("mime_type"),
            user_id=r.get("user_id"),
            user_email=email_map.get(r.get("user_id")) if r.get("user_id") else None,
        )
        for r in rows
    ]
    return AdminShareEventListResponse(
        events=events, total=total, page=page, pages=max(1, math.ceil(total / limit))
    )


@router.get("/feedback", response_model=AdminFeedbackListResponse)
async def list_feedback(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    type: str | None = Query(None, description="bug | feature"),
    status: str | None = Query(None, description="open | resolved"),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """List bug reports & feature requests (newest first), with submitter emails."""
    rows, total, open_count = await feedback_service.list_feedback(
        db, page=page, limit=limit, type_filter=type, status_filter=status
    )

    # Resolve account emails for the signed-in submitters on this page.
    uids = {r["user_id"] for r in rows if r.get("user_id")}
    valid = [ObjectId(i) for i in uids if ObjectId.is_valid(i)]
    email_map: dict[str, str] = {}
    if valid:
        async for u in db["users"].find({"_id": {"$in": valid}}, {"email": 1}):
            email_map[str(u["_id"])] = u["email"]

    items = [
        AdminFeedbackItem(
            id=str(r["_id"]),
            type=r.get("type", "bug"),
            message=r.get("message", ""),
            email=r.get("email"),
            user_id=r.get("user_id"),
            user_email=email_map.get(r.get("user_id")) if r.get("user_id") else None,
            page_url=r.get("page_url"),
            user_agent=r.get("user_agent"),
            status=r.get("status", "open"),
            created_at=r["created_at"],
        )
        for r in rows
    ]
    return AdminFeedbackListResponse(
        items=items,
        total=total,
        open_count=open_count,
        page=page,
        pages=max(1, math.ceil(total / limit)),
    )


@router.patch("/feedback/{feedback_id}", status_code=204)
async def update_feedback_status(
    feedback_id: str,
    data: FeedbackStatusUpdate,
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """Mark a report open / resolved."""
    if data.status not in ("open", "resolved"):
        raise HTTPException(status_code=400, detail="Invalid status")
    ok = await feedback_service.set_status(db, feedback_id, data.status)
    if not ok:
        raise HTTPException(status_code=404, detail="Feedback not found")


@router.delete("/feedback/{feedback_id}", status_code=204)
async def delete_feedback(
    feedback_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """Permanently delete a feedback entry."""
    ok = await feedback_service.delete_feedback(db, feedback_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Feedback not found")


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


# ── Email campaigns ────────────────────────────────────────────────────────────


def _sender(custom: str | None) -> str:
    """From address for a campaign.

    Defaults to a distinct `updates@` mailbox rather than the login sender, so a
    spam complaint about an announcement can't take the sign-in codes down with
    it. Falls back to the configured sender if the domain can't be derived.
    """
    if custom:
        return custom
    domain = settings.email_from.split("@")[-1] if "@" in settings.email_from else ""
    if domain:
        return f"{settings.email_from_name} <updates@{domain}>"
    return f"{settings.email_from_name} <{settings.email_from}>"


@router.post("/campaigns/audience", response_model=AudiencePreviewResponse)
async def preview_audience(
    data: AudiencePreviewRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """How many people a campaign would reach, so a send is never a guess."""
    people = await campaign.resolve_audience(
        db, data.audience, recent_days=data.recent_days, emails=data.emails
    )
    return AudiencePreviewResponse(
        count=len(people), sample=[p["email"] for p in people[:5]]
    )


@router.post("/campaigns/test", status_code=202)
async def send_campaign_test(
    data: CampaignTestRequest,
    _: dict = Depends(require_admin),
):
    """Send one copy to a chosen address so the template can be checked first."""
    if not mailer.is_configured():
        raise HTTPException(status_code=503, detail="Email is not configured on this server.")
    ok = await campaign.send_test(
        data.to_email, data.subject, data.html, _sender(data.sender)
    )
    if not ok:
        raise HTTPException(status_code=502, detail="Resend rejected the test email.")
    return {"status": "sent"}


@router.post("/campaigns", status_code=202)
async def create_campaign(
    data: CampaignCreateRequest,
    background: BackgroundTasks,
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """Queue a campaign and start sending in the background."""
    if not mailer.is_configured():
        raise HTTPException(status_code=503, detail="Email is not configured on this server.")

    people = await campaign.resolve_audience(
        db, data.audience, recent_days=data.recent_days, emails=data.emails
    )
    if not people:
        raise HTTPException(status_code=422, detail="That audience has no recipients.")

    doc = {
        "subject": data.subject,
        "html": data.html,
        "sender": _sender(data.sender),
        "audience": data.audience,
        "recent_days": data.recent_days,
        "custom_emails": data.emails,
        "status": "queued",
        "total": len(people),
        "sent": 0,
        "failed": 0,
        "created_at": datetime.now(timezone.utc),
        "started_at": None,
        "finished_at": None,
    }
    res = await db["campaigns"].insert_one(doc)
    background.add_task(campaign.run_campaign, db, str(res.inserted_id))
    return {"id": str(res.inserted_id), "total": len(people), "status": "queued"}


@router.get("/campaigns", response_model=CampaignListResponse)
async def list_campaigns(
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    rows = await db["campaigns"].find({}, {"html": 0}).sort("created_at", -1).to_list(length=50)
    return CampaignListResponse(
        campaigns=[
            CampaignItem(
                id=str(r["_id"]),
                subject=r["subject"],
                audience=r.get("audience", "all"),
                status=r.get("status", "queued"),
                total=r.get("total", 0),
                sent=r.get("sent", 0),
                failed=r.get("failed", 0),
                created_at=r["created_at"],
                finished_at=r.get("finished_at"),
            )
            for r in rows
        ]
    )
