import json
import re

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import optional_user, require_user
from app.schemas.document import (
    DocumentCopyRequest,
    DocumentCreate,
    DocumentCreateResponse,
    DocumentResponse,
    DocumentUpdate,
    EventRequest,
    ReportRequest,
    SlugChangeRequest,
)
from app.services import access, analytics, artifact as art_service, document as doc_service
from app.services import folder as folder_service
from app.services import publicity, tickets, urls
from app.services.doc_ref import doc_ref
from app.utils.net import get_client_ip

settings = get_settings()
router = APIRouter(prefix="/api/v1/documents", tags=["documents"])

BASE_URL = "https://markdrop.in"

_BOT_RE = re.compile(r"bot|crawl|spider|slurp|preview|fetch|monitor|headless|curl|wget|python-|axios|node-fetch", re.I)


def _is_bot(user_agent: str | None) -> bool:
    return bool(user_agent) and bool(_BOT_RE.search(user_agent or ""))


def _build_url(slug: str) -> str:
    return f"{BASE_URL}/{slug}"


def _to_response(doc, viewer_id: str | None = None, *, public: bool | None = None) -> dict:
    """The response body for a reader already past every gate (access.can)."""
    is_owner = bool(viewer_id) and doc.owner_id == viewer_id
    if public is None:
        public = not art_service.is_guarded(
            has_password=bool(doc.read_password_hash), access_level=doc.access_level)
    byte_urls = publicity.byte_urls(doc, public=public)
    return dict(
        slug=doc.slug,
        url=_build_url(doc.slug),
        folder_path=doc.folder_path,
        title=doc.title,
        content=doc.content,
        created_at=doc.created_at,
        updated_at=doc.updated_at,
        expires_at=doc.expires_at,
        views=doc.views,
        is_password_protected=bool(doc.read_password_hash),
        is_owned=bool(doc.owner_id),
        is_owner=is_owner,
        # Owner-only: never expose the internal id or Google link to others.
        id=doc.id if is_owner else None,
        # Everyone past the gates: the opaque reference analytics gets instead of
        # the slug (services/doc_ref.py). It opens nothing.
        ref=doc_ref(doc.id),
        google_doc_url=doc.google_doc_url if is_owner else None,
        google_doc_stale=bool(
            is_owner and doc.google_doc_id and (doc.google_doc_synced_rev or 0) < doc.rev
        ),
        vscode_synced=doc.vscode_synced,
        encrypted=doc.encrypted,
        kind=doc.kind,
        mime=doc.mime,
        renderer=art_service.renderer_for(doc.mime or "") if doc.kind == "artifact" else None,
        type_label=art_service.label_for(doc.mime or "") if doc.kind == "artifact" else None,
        size_bytes=doc.size_bytes,
        original_filename=doc.original_filename,
        # One rule for every byte path (services/publicity.py): signed (with the
        # access epoch) unless the bytes are public.
        artifact_url=byte_urls["artifact_url"],
        download_url=byte_urls["download_url"],
        poster_url=byte_urls["poster_url"],
        media=doc.media if doc.kind == "artifact" else None,
        access_level=doc.access_level,
        workspace_id=doc.workspace_id,
    )


async def _full_response(db: AsyncIOMotorDatabase, raw: dict, actor: access.Actor,
                         ctx: access.Ctx) -> dict:
    doc = doc_service._doc_from_mongo(raw)
    public = await publicity.doc_is_public(db, raw)
    body = _to_response(doc, actor.user_id, public=public)
    body["workspace_url"] = await urls.workspace_url(db, raw)
    body["can"] = await access.can_flags(actor, raw, ctx)
    body["read_ticket"] = tickets.mint(str(raw["_id"]), publicity.epoch_of(raw))
    body["access_epoch"] = publicity.epoch_of(raw)
    return body


async def _folder_owns_path(db, workspace_id: str, slug: str, path: str | None) -> bool:
    """True when ``path`` (``a/b/<slug>``, as the tenant page was asked for)
    names a folder of ``workspace_id``. Ignored unless its last segment is
    the slug being read."""
    from urllib.parse import unquote

    if not path or len(path) > 2000:
        return False
    segments = [unquote(s) for s in path.strip("/").split("/") if s]
    if not segments or segments[-1] != slug or len(segments) > folder_service.MAX_DEPTH + 1:
        return False
    return await folder_service.resolve_path(db, workspace_id, segments) is not None


def _ctx(db, request: Request, scope: str | None = None) -> access.Ctx:
    return access.Ctx(db, surface="rest", workspace_scope=scope or None, ip=get_client_ip(request))


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


@router.post("", response_model=DocumentCreateResponse, status_code=201)
@limiter.limit(settings.rate_limit_create)
async def create_document(
    request: Request,
    data: DocumentCreate,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User | None = Depends(optional_user),
):
    # Logged-in creators automatically own their document.
    owner_id = user.id if user else None
    doc, raw_secret = await doc_service.create_document(db, data, owner_id=owner_id)
    return DocumentCreateResponse(**_to_response(doc, owner_id), edit_secret=raw_secret)


@router.get("/{slug}", response_model=DocumentResponse)
@limiter.limit(settings.rate_limit_read)
async def get_document(
    request: Request,
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_read_password: str | None = Header(None),
    x_edit_secret: str | None = Header(None),
    x_markdrop_workspace: str | None = Header(None),
    x_markdrop_path: str | None = Header(None),
    user: User | None = Depends(optional_user),
):
    """One document, through access.can(read).

    Scope: a tenant token's workspace wins over ``X-Markdrop-Workspace`` (set by
    the edge on a workspace's own domain; unsigned, so it can only narrow).

    Renamed documents (Q4): a slug that is in some document's ``old_slugs``
    answers — only to a caller who can read that document — ``200
    {"moved": true, "slug": <current>, "url", "workspace_url", "folder_path"}``
    with header ``X-Markdrop-Moved: <current>``; the page then 307s to the
    canonical address. Anyone else gets exactly the denial the current slug
    would give them (404 / 401 + gate), never the new slug.
    """
    actor = access.actor_from_request(request, user, edit_secret=x_edit_secret,
                                      read_password=x_read_password)
    ctx = _ctx(db, request, x_markdrop_workspace)
    raw, moved = await doc_service.find_for_read(db, slug)
    scope = actor.tenant_ws or ctx.workspace_scope
    # X-Markdrop-Path is honoured only on requests our own tenant pages sign (R3-B1): sent straight
    # to the API it would let anyone probe for hidden folders by comparing 404 with the gate.
    from app.middleware import internal as internal_mw

    if not internal_mw.is_valid(request.headers.get("x-markdrop-internal")):
        x_markdrop_path = None
    if scope and raw is not None and await _folder_owns_path(db, scope, slug, x_markdrop_path):
        # B-N2: on the workspace's own domain the address asked for
        # (``X-Markdrop-Path``, the whole tenant path) is a folder of that
        # workspace. Folders own their addresses: a document — or an old slug
        # of one — filed elsewhere never takes it over through the
        # "last segment is the slug" redirect. Same answer as a missing doc.
        raise HTTPException(status_code=404, detail="Document not found")
    if (scope and raw is not None and not moved and raw.get("workspace_id") == scope
            and await folder_service.slug_shadowed(db, raw)):
        # B5: on the workspace's own domain this address belongs to a folder
        # (a collision that predates the rule; the owner isn't a workspace
        # admin). Same answer as a missing document, before any gate.
        raise HTTPException(status_code=404, detail="Document not found")
    await access.require(actor, raw, "read", ctx)
    if moved:
        current = raw["slug"]
        return JSONResponse(
            {"moved": True, "slug": current, "url": _build_url(current),
             "workspace_url": await urls.workspace_url(db, raw),
             "folder_path": raw.get("folder_path") or []},
            headers={"X-Markdrop-Moved": current},
        )
    return DocumentResponse(**await _full_response(db, raw, actor, ctx))


@router.put("/{slug}", response_model=DocumentResponse)
@limiter.limit(settings.rate_limit_create)
async def update_document(
    request: Request,
    slug: str,
    data: DocumentUpdate,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_edit_secret: str | None = Header(None),
    user: User | None = Depends(optional_user),
):
    actor = access.actor_from_request(request, user, edit_secret=x_edit_secret)
    ctx = _ctx(db, request)
    after = await doc_service.update_document(db, slug, data, actor, ctx)
    return DocumentResponse(**await _full_response(db, after, actor, ctx))


@router.delete("/{slug}", status_code=204)
@limiter.limit(settings.rate_limit_create)
async def delete_document(
    request: Request,
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_edit_secret: str | None = Header(None),
    user: User | None = Depends(optional_user),
):
    actor = access.actor_from_request(request, user, edit_secret=x_edit_secret)
    await doc_service.delete_document(db, slug, actor, _ctx(db, request))


@router.post("/{slug}/edit-secret/rotate")
@limiter.limit(settings.rate_limit_create)
async def rotate_edit_secret(
    request: Request,
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """A9: the owner replaces a leaked edit secret. The old one stops working
    at once; the new one is returned once."""
    from app.utils.security import generate_edit_secret

    actor = access.actor_from_request(request, user)
    ctx = _ctx(db, request)
    raw = await db["documents"].find_one({"slug": slug})
    d = await access.can(actor, raw, "change_access", ctx)  # owner session only
    d.raise_()
    secret, hashed = generate_edit_secret()
    await db["documents"].update_one({"_id": raw["_id"]}, {"$set": {"edit_secret_hash": hashed}})
    return {"slug": slug, "edit_secret": secret}


@router.post("/{slug}/claim", response_model=DocumentResponse)
@limiter.limit(settings.rate_limit_create)
async def claim_document(
    request: Request,
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_edit_secret: str = Header(...),
    user: User = Depends(require_user),
):
    """Attach an anonymous document to the logged-in account (proven via secret)."""
    actor = access.actor_from_request(request, user, edit_secret=x_edit_secret)
    doc = await doc_service.claim_document(db, slug, actor, _ctx(db, request))
    return DocumentResponse(**_to_response(doc, user.id))


@router.post("/{slug}/copy", response_model=DocumentCreateResponse, status_code=201)
@limiter.limit(settings.rate_limit_create)
async def copy_document(
    request: Request,
    slug: str,
    data: DocumentCopyRequest,
    x_markdrop_workspace: str | None = Header(None),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Import a copy of a readable document into the caller's account.

    Owned by the caller with a fresh slug, no password and no expiry; born
    private unless the source is plainly public (Q3). 404/401/403 exactly as a
    read of the source would answer.
    """
    actor = access.actor_from_request(request, user, read_password=data.read_password)
    doc, raw_secret = await doc_service.copy_document(
        db, slug, actor, _ctx(db, request, x_markdrop_workspace))
    return DocumentCreateResponse(**_to_response(doc, user.id), edit_secret=raw_secret)


@router.patch("/{slug}/slug", response_model=DocumentResponse)
@limiter.limit(settings.rate_limit_create)
async def change_slug(
    request: Request,
    slug: str,
    data: SlugChangeRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_edit_secret: str | None = Header(None),
    user: User | None = Depends(optional_user),
):
    actor = access.actor_from_request(request, user, edit_secret=x_edit_secret)
    ctx = _ctx(db, request)
    after = await doc_service.change_slug(db, slug, data.new_slug, actor, ctx)
    return DocumentResponse(**await _full_response(db, after, actor, ctx))


async def _beacon_target(db: AsyncIOMotorDatabase, slug: str, ticket: str | None) -> dict | None:
    """The document a beacon may be recorded against, or None. Anonymous-
    readable documents need no ticket; anything else needs a valid one (§2.7).
    The caller answers identically either way (I5)."""
    raw = await db["documents"].find_one({"slug": slug})
    if raw is None or publicity.is_expired(raw):
        return None
    if tickets.valid_for(ticket, raw) or await access.anonymous_can_read(db, raw):
        return raw
    return None


@router.post("/{slug}/events", status_code=202)
@limiter.limit("120/minute")
async def record_click(
    request: Request,
    slug: str,
    data: EventRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """Record a view / export-PDF / copy-URL event (called by the viewer's
    browser). Always 202: missing, unreadable and recorded look the same."""
    if data.type == "view" and _is_bot(request.headers.get("user-agent")):
        return {"status": "ignored"}
    raw = await _beacon_target(db, slug, data.ticket)
    if raw is not None:
        result = await doc_service.register_event(db, raw, data.type)
        if result is not None:
            doc_id, owner_id = result
            await analytics.record_event(
                db, doc_id, owner_id, data.type,
                ip=get_client_ip(request),
                referrer=data.referrer,
            )
    return {"status": "ok"}


@router.post("/{slug}/read", status_code=204)
@limiter.limit("60/minute")
async def record_read(
    slug: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
) -> None:
    """How far a reader got and how long they spent (see analytics.record_read).

    Takes a raw body rather than a model so the page can send it with
    navigator.sendBeacon as text/plain while it unloads — a JSON content type
    would need a CORS preflight, which a closing page can't wait for. The body
    may carry ``"t"``: the read ticket. Always 204.
    """
    if _is_bot(request.headers.get("user-agent")):
        return
    raw_body = await request.body()
    if len(raw_body) > 3072:
        return
    try:
        body = json.loads(raw_body)
        rid = body["rid"]
        depth = int(body["depth"])
        seconds = int(body["seconds"])
        ticket = body.get("t") if isinstance(body.get("t"), str) else None
    except (ValueError, KeyError, TypeError, AttributeError):
        return
    if not (isinstance(rid, str) and re.fullmatch(r"[A-Za-z0-9_-]{8,64}", rid)):
        return
    doc = await _beacon_target(db, slug, ticket)
    if not doc:
        return
    await analytics.record_read(
        db, str(doc["_id"]), doc.get("owner_id"), rid,
        depth=max(0, min(100, depth)), seconds=max(0, min(7200, seconds)),
        ip=get_client_ip(request),
    )


@router.post("/{slug}/report", status_code=202)
@limiter.limit("5/minute")
async def report_document(
    request: Request,
    slug: str,
    data: ReportRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """Flag a document for abuse (public, rate-limited). Always 202; stored
    only when the slug exists."""
    await doc_service.report_document(db, slug, data.reason, get_client_ip(request))
    return {"status": "ok"}
