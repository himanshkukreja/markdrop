"""Admin API — the endpoints behind markdrop.in/admin.

Who may call them
-----------------
The owner's own Markdrop account, signed in on markdrop.in. There is no admin username or password
(retired 2026-11-06). `require_admin` takes the app's ordinary session (the same bearer token every
signed-in route takes) and opens the console when:

- it is a full session signed in on markdrop.in: not an API token (mdk_…), not a custom domain's
  tenant token, not the copy handed to Markdrop Guides' studio host (`via: "studio"`);
- the account's email is in MARKDROP_ADMIN_EMAILS (comma-separated, case-insensitive, exact;
  default kukreja.him@gmail.com) and the account isn't disabled. Accounts exist only through a
  verified sign-in (Google with a verified address, or an emailed code/link), so the address is
  the verified one;
- it was signed in within MARKDROP_ADMIN_SESSION_MAX_AGE_DAYS (default 7, of the session's 30).
  An older one gets 401 and the console sends the owner through sign-in again.

Anyone else signed in gets 404 Not Found, the same as a route that doesn't exist; no session (or an
expired one) gets the app's usual 401. The decision is made here, on the server, on every request.
Bearer tokens in a header (never a cookie, never a query parameter) are the app's CSRF defence, and
the console uses the same. Every admin access, and every refused attempt by a signed-in account, is
counted in `admin_access_log` beside the moderation actions (one `action: "access"` row per account,
ip hash, outcome and UTC day); moderation rows name the admin and their ip hash too.
"""

import math
from datetime import datetime, timedelta, timezone

import jwt
from bson import ObjectId
from fastapi import BackgroundTasks, APIRouter, Depends, HTTPException, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.config import get_settings
from app.database import get_database
from app.limiter import limiter  # shared slowapi limiter
from app.utils.auth import decode_access_token, session_issued_at
from app.utils.net import get_client_ip
from app.schemas.auth import (
    AudiencePreviewRequest,
    AudiencePreviewResponse,
    CampaignCreateRequest,
    CampaignRenderRequest,
    CampaignRenderResponse,
    CampaignItem,
    CampaignListResponse,
    CampaignTestRequest,
    RenderedSample,
)
from app.schemas.document import MAX_CONTENT
from app.services import ai_usage, api_token, artifact, campaign, mailer, oauth_server
from app.services import feedback as feedback_service

settings = get_settings()
router = APIRouter(prefix="/api/v1/admin", tags=["admin"])

BASE_URL = "https://markdrop.in"


# ── Pydantic schemas ─────────────────────────────────────────────────────────


class AdminSessionResponse(BaseModel):
    email: str
    name: str | None = None
    picture: str | None = None


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
    # Artifacts: `content_preview` is only a filename stand-in for these, so the
    # UI needs the type and real size to say anything useful about them.
    # End-to-end encrypted: moderation can act on the record (delete, expire)
    # but cannot read it. That is the guarantee, not a gap.
    encrypted: bool = False
    kind: str = "markdown"
    mime: str | None = None
    renderer: str | None = None
    type_label: str | None = None
    size_bytes: int | None = None
    original_filename: str | None = None


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
    artifact_count: int = 0
    artifact_bytes: int = 0
    # Markdrop Guides: sites they own (not deleted) and publishes they started
    guides_site_count: int = 0
    guides_publish_count: int = 0


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
    # P2P connection health, last 30 days, one row per room (both peers report;
    # a room counts as connected if either side got a working pair).
    share_connections: dict = {}
    # Artifacts
    artifact_total: int = 0
    artifact_users: int = 0
    artifact_bytes: int = 0
    artifact_protected: int = 0
    artifact_by_type: list[dict] = []
    # Markdrop Guides (docs_sites + docs_events + the Ask AI ledger)
    guides: dict = {}


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


# ── The admin guard ───────────────────────────────────────────────────────────

ACCESS_LOG = "admin_access_log"
_NOT_FOUND = HTTPException(status_code=404, detail="Not Found")


def _is_disabled(raw: dict) -> bool:
    """A disabled account. Markdrop has no switch for this yet; a `disabled` flag or `disabled_at` /
    `deleted_at` stamp set on the user row by hand closes the console to it at once."""
    return bool(raw.get("disabled") or raw.get("disabled_at") or raw.get("deleted_at"))


async def _log_access(db: AsyncIOMotorDatabase, email: str, user_id: str, ip_hash: str | None,
                      outcome: str, path: str) -> None:
    """Console access, in the moderation audit log (`admin_access_log`): one `action: "access"` row
    per (account, ip hash, outcome, UTC day) with first and last time and a count."""
    now = datetime.now(timezone.utc)
    key = {"action": "access", "email": email, "user_id": user_id, "ip_hash": ip_hash,
           "outcome": outcome, "day": now.strftime("%Y-%m-%d")}
    try:
        await db[ACCESS_LOG].update_one(
            key,
            {"$setOnInsert": {"first_at": now}, "$set": {"last_at": now, "last_path": path}, "$inc": {"count": 1}},
            upsert=True,
        )
    except Exception:  # the log never decides access
        pass


def _audit_row(admin: dict, slug: str, action: str) -> dict:
    """A moderation action (read, update, delete of one document): what, when, who, from where."""
    return {"slug": slug, "action": action, "ts": datetime.now(timezone.utc),
            "admin": admin.get("email"), "ip_hash": admin.get("ip_hash")}


async def require_admin(request: Request, db: AsyncIOMotorDatabase = Depends(get_db)) -> dict:
    """FastAPI dependency: the signed-in admin, as {sub, email, user_id, name}. See the module doc."""
    auth = request.headers.get("Authorization", "")
    token = auth.removeprefix("Bearer ").strip() if auth.startswith("Bearer ") else ""
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    if token.startswith((api_token.TOKEN_PREFIX, oauth_server.ACCESS_PREFIX)):
        # API tokens (CLI, VS Code) and MCP connector tokens never open the console, valid or not.
        raise _NOT_FOUND
    try:
        payload = decode_access_token(token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Session expired — please log in again")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid session token")
    if payload.get("typ") != "access" or payload.get("via"):
        # A custom domain's tenant token, the studio host's session, or any other token signed with
        # the auth secret (OAuth state, tickets): only a session signed in on markdrop.in counts.
        raise _NOT_FOUND
    uid = str(payload.get("sub") or "")
    raw = await db["users"].find_one({"_id": ObjectId(uid)}) if ObjectId.is_valid(uid) else None
    if raw is None:
        raise HTTPException(status_code=401, detail="User no longer exists")
    email = str(raw.get("email") or "").strip().lower()
    ip_hash = ai_usage.hash_ip(get_client_ip(request))
    path = request.url.path
    if not email or email not in settings.admin_email_set or _is_disabled(raw):
        await _log_access(db, email, uid, ip_hash, "denied", path)
        raise _NOT_FOUND
    max_age = settings.admin_session_max_age_days
    issued = session_issued_at(payload)
    if max_age > 0 and (issued is None or datetime.now(timezone.utc) - issued > timedelta(days=max_age)):
        await _log_access(db, email, uid, ip_hash, "reauth", path)
        raise HTTPException(status_code=401, detail="Sign in again to open the admin console.",
                            headers={"X-Admin-Reauth": "1"})
    await _log_access(db, email, uid, ip_hash, "ok", path)
    return {"sub": email, "email": email, "user_id": uid, "ip_hash": ip_hash,
            "name": raw.get("name"), "picture": raw.get("picture")}


def _to_list_item(raw: dict, owner_email: str | None = None) -> AdminDocListItem:
    encrypted: bool = bool(raw.get("encrypted"))
    stored: str = raw.get("content", "")
    # `content_length` stays the real stored size — an admin still needs to see
    # that a record has bulk. Only the readable projections go empty.
    return AdminDocListItem(
        slug=raw["slug"],
        title=None if encrypted else raw.get("title"),
        content_preview="" if encrypted else stored[:300],
        created_at=raw["created_at"],
        updated_at=raw["updated_at"],
        expires_at=raw.get("expires_at"),
        views=raw.get("views", 0),
        is_password_protected=bool(raw.get("read_password_hash")),
        content_length=len(stored),
        encrypted=encrypted,
        owner_id=raw.get("owner_id"),
        owner_email=owner_email,
        report_count=raw.get("report_count", 0),
        kind=raw.get("kind", "markdown"),
        mime=raw.get("mime"),
        renderer=(
            artifact.renderer_for(raw.get("mime") or "")
            if raw.get("kind") == "artifact"
            else None
        ),
        type_label=(
            artifact.label_for(raw.get("mime") or "")
            if raw.get("kind") == "artifact"
            else None
        ),
        size_bytes=raw.get("size_bytes"),
        original_filename=raw.get("original_filename"),
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
    # The single-document admin view is a moderation tool, so it must not hand
    # back ciphertext dressed up as a document body.
    encrypted = bool(raw.get("encrypted"))
    return {
        "slug": raw["slug"],
        "url": f"{BASE_URL}/{raw['slug']}",
        "title": None if encrypted else raw.get("title"),
        "content": "" if encrypted else raw["content"],
        "created_at": raw["created_at"],
        "updated_at": raw["updated_at"],
        "expires_at": raw.get("expires_at"),
        "views": raw.get("views", 0),
        "is_password_protected": bool(raw.get("read_password_hash")),
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────


@router.get("/session", response_model=AdminSessionResponse)
@limiter.limit("60/minute")
async def admin_session(request: Request, admin: dict = Depends(require_admin)):
    """Who the console is open for. /admin calls this first: 200 opens it, 404 shows a plain
    not-found page, 401 sends the person to sign in (again)."""
    return AdminSessionResponse(email=admin["email"], name=admin.get("name"), picture=admin.get("picture"))


# How the admin document list can be ordered. Each maps to (sort key, direction); the computed
# keys come from `_SORT_FIELDS` so documents without the field sort last, not first.
_DOC_SORTS: dict[str, tuple[str, int]] = {
    "newest": ("created_at", -1),
    "oldest": ("created_at", 1),
    "updated": ("updated_at", -1),
    "views": ("views", -1),
    "views_asc": ("views", 1),
    "reports": ("report_count", -1),
    "size": ("_size", -1),
    "expiring": ("_expires", 1),
    "title": ("_title", 1),
}
_SORT_FIELDS: dict[str, dict] = {
    # Artifacts carry their byte size; markdown is measured from the stored content.
    "_size": {"$ifNull": ["$size_bytes", {"$strLenBytes": {"$ifNull": ["$content", ""]}}]},
    # No expiry sorts after every real date.
    "_expires": {"$ifNull": ["$expires_at", datetime(9999, 12, 31, tzinfo=timezone.utc)]},
    # Untitled and encrypted documents (no readable title) sort after titled ones.
    "_title": {
        "$cond": [
            {"$or": [{"$eq": ["$encrypted", True]}, {"$eq": [{"$ifNull": ["$title", ""]}, ""]}]},
            "\uffff",
            {"$toLower": "$title"},
        ]
    },
}


@router.get("/documents", response_model=AdminDocListResponse)
async def list_all_documents(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    q: str | None = Query(None),
    reported: bool = Query(False),
    kind: str | None = Query(None, pattern="^(markdown|artifact)$"),
    sort: str | None = Query(None, pattern="^(" + "|".join(_DOC_SORTS) + ")$"),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """List documents. `q` uses the full-text index; `reported=1` filters flagged docs; `sort`
    orders them (default: newest, or most reported when `reported=1`)."""
    query: dict = {}
    if q:
        query["$text"] = {"$search": q}
    if reported:
        query["report_count"] = {"$gt": 0}
    if kind == "artifact":
        query["kind"] = "artifact"
    elif kind == "markdown":
        # Documents predating artifacts have no `kind` field at all.
        query["kind"] = {"$ne": "artifact"}

    total = await db["documents"].count_documents(query)
    skip = (page - 1) * limit
    field, direction = _DOC_SORTS[sort or ("reports" if reported else "newest")]
    pipeline: list[dict] = [{"$match": query}]
    if field in _SORT_FIELDS:
        pipeline.append({"$addFields": {field: _SORT_FIELDS[field]}})
    # `_id` breaks ties so paging is stable when many documents share a value (0 views).
    pipeline += [
        {"$sort": {field: direction, "_id": direction}},
        {"$skip": skip},
        {"$limit": limit},
        {"$project": {"_id": 0, "_size": 0, "_expires": 0, "_title": 0}},
    ]
    docs = await db["documents"].aggregate(pipeline, allowDiskUse=True).to_list(length=limit)
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
    artifact_counts: dict[str, int] = {}
    artifact_bytes: dict[str, int] = {}
    guides_sites: dict[str, int] = {}
    guides_publishes: dict[str, int] = {}
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
                        "artifacts": {
                            "$sum": {"$cond": [{"$eq": ["$kind", "artifact"]}, 1, 0]}
                        },
                        "artifact_bytes": {
                            "$sum": {
                                "$cond": [
                                    {"$eq": ["$kind", "artifact"]},
                                    {"$ifNull": ["$size_bytes", 0]},
                                    0,
                                ]
                            }
                        },
                    }
                },
            ]
        ):
            counts[row["_id"]] = row["n"]
            gdoc_counts[row["_id"]] = row.get("gdocs", 0)
            artifact_counts[row["_id"]] = row.get("artifacts", 0)
            artifact_bytes[row["_id"]] = row.get("artifact_bytes", 0)

        # VS Code sync: token count + most recent sync per user
        async for row in db["api_tokens"].aggregate(
            [
                {"$match": {"user_id": {"$in": ids}, "scope": {"$exists": False}}},
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

        # Markdrop Guides: sites they own, and publishes they started (directly or approved)
        async for row in db["docs_sites"].aggregate(
            [
                {"$match": {"owner_id": {"$in": ids}, "deleted_at": None}},
                {"$group": {"_id": "$owner_id", "n": {"$sum": 1}}},
            ]
        ):
            guides_sites[row["_id"]] = row["n"]
        async for row in db["docs_events"].aggregate(
            [
                {"$match": {"user_id": {"$in": ids}, "kind": {"$in": list(GUIDES_PUBLISH_KINDS)}}},
                {"$group": {"_id": "$user_id", "n": {"$sum": 1}}},
            ]
        ):
            guides_publishes[row["_id"]] = row["n"]

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
                artifact_count=artifact_counts.get(uid, 0),
                artifact_bytes=artifact_bytes.get(uid, 0),
                guides_site_count=guides_sites.get(uid, 0),
                guides_publish_count=guides_publishes.get(uid, 0),
            )
        )
    return AdminUserListResponse(
        users=items, total=total, page=page, pages=max(1, math.ceil(total / limit))
    )


# A publish someone started: directly (docs_published) or by approving a review, which publishes.
GUIDES_PUBLISH_KINDS = ("docs_published", "docs_review_approved")
# A Guides site's Ask AI rows carry the site's id (an ObjectId's hex); file-based docs sites
# (docs.markdrop.in is "markdrop") don't.
_GUIDES_AI_SITE = {"$regex": "^[0-9a-f]{24}$"}


async def guides_usage(db: AsyncIOMotorDatabase) -> dict:
    """Markdrop Guides adoption, all time: sites, who creates and publishes them, builds, imports
    and Ask AI answers. From docs_sites, docs_events (services/docs_site_store.log_event) and the
    Ask AI ledger (services/ai_usage)."""
    ev = db["docs_events"]
    kinds: dict[str, int] = {}
    async for row in ev.aggregate([{"$group": {"_id": "$kind", "n": {"$sum": 1}}}]):
        kinds[str(row["_id"])] = row["n"]
    creators = await ev.distinct("user_id", {"kind": "docs_site_created", "user_id": {"$ne": None}})
    publishers = await ev.distinct("user_id", {"kind": {"$in": list(GUIDES_PUBLISH_KINDS)}, "user_id": {"$ne": None}})
    sites = db["docs_sites"]
    by_source: dict[str, int] = {}
    async for row in sites.aggregate([
        {"$match": {"deleted_at": None}},
        {"$group": {"_id": "$source.kind", "n": {"$sum": 1}}},
    ]):
        by_source[str(row["_id"] or "blank")] = row["n"]
    return {
        "sites": await sites.count_documents({"deleted_at": None}),
        "sites_live": await sites.count_documents({"deleted_at": None, "status": "live"}),
        "sites_deleted": await sites.count_documents({"deleted_at": {"$ne": None}}),
        "by_source": by_source,
        "creators": len(creators),
        "publishers": len(publishers),
        "publishes": sum(kinds.get(k, 0) for k in GUIDES_PUBLISH_KINDS),
        "builds_live": kinds.get("docs_build_live", 0),
        "builds_failed": kinds.get("docs_build_failed", 0),
        "reviews_submitted": kinds.get("docs_review_submitted", 0),
        "restores": kinds.get("docs_restored", 0),
        "imports": kinds.get("docs_imported", 0),
        "imports_finished": kinds.get("docs_import_finished", 0),
        "imports_failed": kinds.get("docs_import_failed", 0),
        "ai_answers": await db["ai_requests"].count_documents(
            {"feature": "docs_ask", "outcome": "answered", "site": _GUIDES_AI_SITE}),
        "ai_sites": len(await db["ai_requests"].distinct(
            "site", {"feature": "docs_ask", "outcome": "answered", "site": _GUIDES_AI_SITE})),
    }


@router.get("/feature-usage", response_model=FeatureUsageResponse)
async def feature_usage(
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """Adoption totals for VS Code sync, Google Drive, P2P file sharing, artifacts and Guides."""
    total_users = await db["users"].count_documents({})

    # VS Code sync — distinct users with a token, and of those, who has synced
    # (personal tokens only: a scoped token, e.g. the Google Meet script's, isn't VS Code sync)
    personal = {"scope": {"$exists": False}}
    token_users = await db["api_tokens"].distinct("user_id", personal)
    synced_users = await db["api_tokens"].distinct(
        "user_id", {"last_used_at": {"$ne": None}, **personal}
    )
    tokens_total = await db["api_tokens"].count_documents(personal)

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

    # P2P connection health. The split among failures is the diagnosis:
    # no server-reflexive candidate means STUN itself was unreachable (UDP or
    # its port blocked); one present means a public address was found but no
    # pair worked — client isolation or no hairpin NAT, which only TURN fixes.
    since = datetime.now(timezone.utc) - timedelta(days=30)
    share_connections = {"rooms": 0, "connected": 0, "relayed": 0,
                         "failed": 0, "failed_no_stun": 0, "failed_with_stun": 0,
                         "turn_offered": 0}
    async for row in db["share_diagnostics"].aggregate(
        [
            {"$match": {"ts": {"$gte": since}}},
            {"$group": {
                "_id": "$room_id",
                "ok": {"$max": {"$cond": [{"$eq": ["$outcome", "connected"]}, 1, 0]}},
                "relay": {"$max": {"$cond": [{"$or": [
                    {"$eq": ["$route.local", "relay"]},
                    {"$eq": ["$route.remote", "relay"]}]}, 1, 0]}},
                "stun": {"$max": {"$cond": [
                    {"$gt": [{"$ifNull": ["$local_candidates.srflx", 0]}, 0]}, 1, 0]}},
                "turn": {"$max": {"$cond": ["$turn_offered", 1, 0]}},
            }},
            {"$group": {
                "_id": None,
                "rooms": {"$sum": 1},
                "connected": {"$sum": "$ok"},
                "relayed": {"$sum": {"$cond": [{"$and": ["$ok", "$relay"]}, 1, 0]}},
                "failed_no_stun": {"$sum": {"$cond": [{"$or": ["$ok", "$stun"]}, 0, 1]}},
                "failed_with_stun": {"$sum": {"$cond": [{"$and": [{"$not": ["$ok"]}, "$stun"]}, 1, 0]}},
                "turn_offered": {"$sum": "$turn"},
            }},
        ]
    ):
        share_connections.update({k: v for k, v in row.items() if k != "_id"})
        share_connections["failed"] = row["rooms"] - row["connected"]

    # Artifacts — adoption, storage footprint, and the mix of file types, which
    # is what decides whether a renderer is worth further investment.
    artifact_total = await db["documents"].count_documents({"kind": "artifact"})
    artifact_users = await db["documents"].distinct(
        "owner_id", {"kind": "artifact", "owner_id": {"$ne": None}}
    )
    artifact_protected = await db["documents"].count_documents(
        {"kind": "artifact", "read_password_hash": {"$ne": None}}
    )
    # Bucketed by renderer, not raw mime: .xls and .xlsx are different mime
    # types that render identically, and listing "Excel spreadsheet" twice reads
    # as a bug rather than a distinction.
    buckets: dict[str, dict] = {}
    total_bytes = 0
    async for row in db["documents"].aggregate(
        [
            {"$match": {"kind": "artifact"}},
            {"$group": {"_id": "$mime", "n": {"$sum": 1},
                        "bytes": {"$sum": {"$ifNull": ["$size_bytes", 0]}}}},
        ]
    ):
        mime = row["_id"] or ""
        renderer = artifact.renderer_for(mime)
        total_bytes += row.get("bytes", 0)
        b = buckets.setdefault(
            renderer,
            {"renderer": renderer, "label": artifact.label_for(mime), "count": 0, "bytes": 0},
        )
        b["count"] += row["n"]
        b["bytes"] += row.get("bytes", 0)
    by_type = sorted(buckets.values(), key=lambda b: -b["count"])

    return FeatureUsageResponse(
        total_users=total_users,
        artifact_total=artifact_total,
        artifact_users=len(artifact_users),
        artifact_bytes=total_bytes,
        artifact_protected=artifact_protected,
        artifact_by_type=by_type,
        vscode_users_with_token=len(token_users),
        vscode_users_synced=len(synced_users),
        vscode_tokens_total=tokens_total,
        google_connected_users=google_connected,
        google_exported_docs=google_exported,
        share_events_total=shares_total,
        share_users_identified=len(share_users),
        share_events_anonymous=shares_anon,
        share_connections=share_connections,
        guides=await guides_usage(db),
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
    admin: dict = Depends(require_admin),
):
    """Fetch a single document (bypasses password gate)."""
    raw = await db["documents"].find_one({"slug": slug}, {"_id": 0})
    if not raw:
        raise HTTPException(status_code=404, detail="Document not found")
    # Moderation reads bypass every gate, so each one is recorded (§6.20 #254).
    await db[ACCESS_LOG].insert_one(_audit_row(admin, slug, "read"))
    return _to_doc_response(raw)


@router.put("/documents/{slug}", response_model=AdminDocumentResponse)
async def admin_update_document(
    slug: str,
    data: AdminDocumentUpdate,
    db: AsyncIOMotorDatabase = Depends(get_db),
    admin: dict = Depends(require_admin),
):
    """Update title and content without requiring the per-document edit_secret."""
    raw = await db["documents"].find_one({"slug": slug}, {"_id": 0})
    if not raw:
        raise HTTPException(status_code=404, detail="Document not found")

    # Writing plaintext into an encrypted document would destroy it: the owner's
    # key can't decrypt it, and nothing on this side can re-encrypt. Moderation
    # keeps delete and expiry, which don't need to read the content.
    if raw.get("encrypted"):
        raise HTTPException(
            status_code=422,
            detail="This document is end-to-end encrypted and cannot be edited here.",
        )

    now = datetime.now(timezone.utc)
    updates = {
        "title": data.title or None,
        "content": data.content,
        "updated_at": now,
    }
    # Same side effects as any content edit (§4.1 #37): rev, live, purge.
    from app.services import live, revalidate

    full = await db["documents"].find_one_and_update(
        {"slug": slug}, {"$set": updates, "$inc": {"rev": 1}}, return_document=True)
    if full is not None:
        live.publish(slug, int(full.get("rev") or 1))
        await revalidate.purge_doc(db, full)
        from app.services import search_index

        search_index.touch(db, full["_id"])
    await db[ACCESS_LOG].insert_one(_audit_row(admin, slug, "update"))
    raw.update(updates)
    return _to_doc_response(raw)


@router.delete("/documents/{slug}", status_code=204)
async def admin_delete_document(
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    admin: dict = Depends(require_admin),
):
    """Permanently delete a document without requiring the edit_secret. The
    same cleanup as an owner's delete (A8): bytes, versions, posters, grants,
    caches, live sockets, slug tombstone."""
    from app.services import lifecycle

    raw = await db["documents"].find_one({"slug": slug})
    if raw is None or not await lifecycle.destroy(db, raw, reason="admin delete"):
        raise HTTPException(status_code=404, detail="Document not found")
    await db[ACCESS_LOG].insert_one(_audit_row(admin, slug, "delete"))


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
        raise HTTPException(status_code=502, detail="The test email wasn't sent.")
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


@router.post("/campaigns/render", response_model=CampaignRenderResponse)
async def render_campaign_samples(
    data: CampaignRenderRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """Render the template against real recipients before anything is sent.

    Substitution bugs — a stray {{name}}, an unsubscribe link that never got
    placed — are invisible in the raw template and permanent once the send
    starts. This returns exactly what the first few people would receive.
    """
    if data.preview_email:
        # Match send_test: a synthetic recipient, so any address previews.
        known = await db["users"].find_one({"email": data.preview_email.strip().lower()})
        person = {
            "id": str(known["_id"]) if known else "preview",
            "email": data.preview_email.strip(),
            "name": (known or {}).get("name"),
        }
        return CampaignRenderResponse(
            total=1,
            samples=[
                RenderedSample(
                    email=person["email"],
                    name=person.get("name"),
                    html=campaign.render(data.html, person),
                    unsubscribe_url=campaign.unsubscribe_url(person["id"]),
                )
            ],
        )

    people = await campaign.resolve_audience(
        db, data.audience, recent_days=data.recent_days, emails=data.emails
    )
    return CampaignRenderResponse(
        total=len(people),
        samples=[
            RenderedSample(
                email=p["email"],
                name=p.get("name"),
                html=campaign.render(data.html, p),
                unsubscribe_url=campaign.unsubscribe_url(p["id"]),
            )
            for p in people[: data.limit]
        ],
    )
