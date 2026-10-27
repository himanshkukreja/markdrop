"""User-scoped endpoints (require login) — the dashboard.

Phase 3: GET /api/v1/me/documents (list the caller's own documents).
Phase 4 adds per-document analytics under this same prefix.
"""

import math

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.schemas.auth import (
    ApiTokenCreateResponse,
    ApiTokenItem,
    ApiTokenListResponse,
    TokenCreateRequest,
)
from app.schemas.access import ContactItem, ContactListResponse
from app.schemas.document import MyDocListItem, MyDocListResponse
from app.services import analytics, api_token, artifact as art_service, document as doc_service

router = APIRouter(prefix="/api/v1/me", tags=["me"])

BASE_URL = "https://markdrop.in"


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _to_list_item(doc) -> MyDocListItem:
    return MyDocListItem(
        id=doc.id,
        slug=doc.slug,
        url=f"{BASE_URL}/{doc.slug}",
        # Both are ciphertext when encrypted — only the browser holding the key
        # from the link fragment can turn them back into words.
        title=None if doc.encrypted else doc.title,
        content_preview="" if doc.encrypted else doc.content[:300],
        created_at=doc.created_at,
        updated_at=doc.updated_at,
        expires_at=doc.expires_at,
        views=doc.views,
        export_pdf_count=doc.export_pdf_count,
        copy_url_count=doc.copy_url_count,
        is_password_protected=bool(doc.read_password_hash),
        google_doc_url=doc.google_doc_url,
        google_doc_stale=bool(
            doc.google_doc_id and (doc.google_doc_synced_rev or 0) < doc.rev
        ),
        vscode_synced=doc.vscode_synced,
        encrypted=doc.encrypted,
        kind=doc.kind,
        mime=doc.mime,
        renderer=art_service.renderer_for(doc.mime or "") if doc.kind == "artifact" else None,
        type_label=art_service.label_for(doc.mime or "") if doc.kind == "artifact" else None,
        size_bytes=doc.size_bytes,
        original_filename=doc.original_filename,
        workspace_id=doc.workspace_id,
        folder_id=doc.folder_id,
        folder_path=doc.folder_path,
        access_level=doc.access_level,
    )


@router.get("/documents", response_model=MyDocListResponse)
async def list_my_documents(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    # Alias for `limit` in the revamped dashboard's vocabulary; wins when sent.
    per_page: int | None = Query(None, ge=1, le=50),
    # Title/slug substring. Literal text, escaped server-side.
    q: str | None = Query(None),
    # "document" is the new name for "markdown"; both mean "not an artifact".
    kind: str | None = Query(None, pattern="^(markdown|document|artifact)$"),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    if per_page is not None:
        limit = per_page
    docs, total = await doc_service.list_user_documents(db, user.id, page, limit, q, kind)
    items = [_to_list_item(d) for d in docs]
    # One grouped count for the whole page rather than a query per row.
    if items:
        rows = await db["document_grants"].aggregate([
            {"$match": {"document_id": {"$in": [d.id for d in docs if d.id]}}},
            {"$group": {"_id": "$document_id", "n": {"$sum": 1}}},
        ]).to_list(length=len(items))
        by_doc = {r["_id"]: r["n"] for r in rows}
        for item in items:
            item.shared_with_count = by_doc.get(item.id, 0)
    return MyDocListResponse(
        documents=items,
        total=total,
        page=page,
        pages=max(1, math.ceil(total / limit)),
        per_page=limit,
        **await doc_service.count_user_documents(db, user.id),
    )


@router.get("/documents/{slug}/analytics")
async def document_analytics(
    request: Request,
    slug: str,
    range: str = Query("30d", pattern="^(7d|30d|all)$"),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Aggregated analytics: can(view_stats) — the owner only. A reader who
    isn't the owner gets 403, anyone else the read denial (404)."""
    from app.services import access

    raw = await db["documents"].find_one({"slug": slug})
    await access.require(access.actor_from_request(request, user), raw, "view_stats", access.Ctx(db))
    return await analytics.get_analytics(db, str(raw["_id"]), range)


# ── Share-dialog suggestions ────────────────────────────────────────────────────

MAX_CONTACTS = 50


@router.get("/contacts", response_model=ContactListResponse)
@limiter.limit("60/minute")
async def list_contacts(
    request: Request,
    q: str | None = Query(None, max_length=200),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Up to 50 people to suggest in the share dialog.

    Only two sources, both people the caller already has a relationship with:
    addresses they have granted document access to themselves, and members of
    workspaces they belong to (whom any member can already list). It is never a
    search over all users -- that would turn the share box into an oracle for
    "does this address have an account here". For the same reason a grant-only
    contact carries no name: the share list never showed one either.

    `q` narrows by case-insensitive substring of email or name. Most recently
    shared-with first, then co-members by name. The caller is never included.
    """
    me = (user.email or "").strip().lower()
    needle = (q or "").strip().lower()
    out: dict[str, ContactItem] = {}

    # Co-members first, into a lookup, so a grant row can borrow a real name.
    member_names: dict[str, str | None] = {}
    mine = await db["memberships"].find(
        {"user_id": user.id}, {"workspace_id": 1}
    ).to_list(length=100)
    workspace_ids = [m["workspace_id"] for m in mine if m.get("workspace_id")]
    if workspace_ids:
        # Bounded: at most 100 memberships x MAX_MEMBERS (200) each in theory,
        # far fewer in practice; the projection keeps every row tiny.
        rows = await db["memberships"].find(
            {"workspace_id": {"$in": workspace_ids}, "user_id": {"$ne": user.id}},
            {"email": 1, "name": 1},
        ).to_list(length=5000)
        for r in rows:
            email = (r.get("email") or "").strip().lower()
            if email and (email not in member_names or not member_names[email]):
                member_names[email] = r.get("name") or None

    if user.email:
        grants = await db["document_grants"].find(
            {"granted_by_email": {"$in": list({user.email, me})}},
            {"email": 1, "created_at": 1},
        ).sort("created_at", -1).to_list(length=1000)
        for g in grants:
            email = (g.get("email") or "").strip().lower()
            if email and email not in out:
                out[email] = ContactItem(
                    email=email, name=member_names.get(email), source="shared"
                )

    for email, name in sorted(
        member_names.items(), key=lambda kv: ((kv[1] or kv[0]).lower(), kv[0])
    ):
        if email not in out:
            out[email] = ContactItem(email=email, name=name, source="workspace")

    contacts = [
        c for c in out.values()
        if c.email != me
        and (not needle or needle in c.email or needle in (c.name or "").lower())
    ]
    return ContactListResponse(contacts=contacts[:MAX_CONTACTS])


# ── API tokens (for the VS Code extension / sync) ───────────────────────────────


def _token_item(rec: dict) -> ApiTokenItem:
    return ApiTokenItem(
        id=str(rec["_id"]),
        name=rec["name"],
        prefix=rec["prefix"],
        created_at=rec["created_at"],
        last_used_at=rec.get("last_used_at"),
    )


@router.post("/tokens", response_model=ApiTokenCreateResponse)
@limiter.limit("20/hour")
async def create_api_token(
    request: Request,
    data: TokenCreateRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Create a personal API token (raw value returned once)."""
    raw, rec = await api_token.create_token(db, user.id, data.name)
    return ApiTokenCreateResponse(**_token_item(rec).model_dump(), token=raw)


@router.get("/tokens", response_model=ApiTokenListResponse)
async def list_api_tokens(
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    recs = await api_token.list_tokens(db, user.id)
    return ApiTokenListResponse(tokens=[_token_item(r) for r in recs])


@router.delete("/tokens/{token_id}", status_code=204)
async def revoke_api_token(
    token_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    ok = await api_token.revoke_token(db, user.id, token_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Token not found")
