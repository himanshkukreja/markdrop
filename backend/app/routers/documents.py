import json
import re
from typing import Literal

from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, Request, UploadFile
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
    DocumentSettingsRequest,
    DocumentUpdate,
    EditorSwitchRequest,
    EmbedsRequest,
    EventRequest,
    ParentMoveRequest,
    ReportRequest,
    SlugChangeRequest,
)
from app.services import access, analytics, artifact as art_service, document as doc_service
from app.services import folder as folder_service
from app.services import page_assets, pages, publicity, tickets, urls
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
        # The address prefix on a workspace's domain: folders, then (for a
        # sub-page) its ancestor pages' slugs.
        folder_path=[*doc.folder_path, *doc.page_path],
        page_path=doc.page_path,
        editor=doc.editor,
        access_inherit=(doc.access_inherit is not False) if doc.parent_id else None,
        template_id=doc.template_id,
        title=doc.title,
        content=doc.content,
        created_at=doc.created_at,
        updated_at=doc.updated_at,
        expires_at=doc.expires_at,
        views=doc.views,
        rev=doc.rev,
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
        # Which version of the file this is (artifacts); the engagement tracker
        # tags its sessions with it so versions can be compared.
        file_version=(doc.file_version or 1) if doc.kind == "artifact" else None,
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
    # Who's viewing (services/viewers.py): the signed-in reader's ticket for the
    # live socket's hello, and the owner's "Show who's viewing" switch.
    body["presence_ticket"] = (tickets.mint_presence(str(raw["_id"]), actor.user_id)
                               if actor.user_id else None)
    body["show_presence"] = (raw.get("show_presence") is not False) if body.get("is_owner") else None
    # Pages (services/pages.py): parent, breadcrumbs, sub-page count, images.
    body.update(await pages.page_fields(db, raw, actor, ctx))
    # Person mentions name people only inside the page's circle.
    body["content"] = await pages.content_for(actor, raw, ctx)
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
    if data.workspace:
        return await _create_filed(request, db, data, user)
    doc, raw_secret = await doc_service.create_document(db, data, owner_id=owner_id)
    return DocumentCreateResponse(**_to_response(doc, owner_id), edit_secret=raw_secret)


async def _create_filed(request: Request, db: AsyncIOMotorDatabase, data: DocumentCreate,
                        user: User | None) -> DocumentCreateResponse:
    """Create straight into a workspace folder (drag-and-drop of a .md file).
    Checked before anything exists; born private, filed, then given its level
    — the one asked for, else the folder's "new items start as" (A11)."""
    from app.services import library as lib_service

    explicit = data.access_level if "access_level" in data.model_fields_set else None
    folder_id, level = await lib_service.prepare_new_filing(
        db, user, data.workspace, data.folder, custom_slug=data.custom_slug, access_level=explicit)
    born = data.model_copy(update={"access_level": "private", "workspace": None, "folder": None})
    doc, raw_secret = await doc_service.create_document(db, born, owner_id=user.id)
    raw = await db["documents"].find_one({"slug": doc.slug})
    after, error = await lib_service.place_new(db, raw, user, data.workspace, folder_id, level)
    actor = access.actor_from_request(request, user)
    body = await _full_response(db, after, actor, _ctx(db, request))
    return DocumentCreateResponse(**body, edit_secret=raw_secret, workspace_error=error)


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
             "folder_path": [*(raw.get("folder_path") or []), *(raw.get("page_path") or [])]},
            headers={"X-Markdrop-Moved": current},
        )
    body = await _full_response(db, raw, actor, ctx)
    if actor.user_id:
        # "Recent" (services/personal.py): a signed-in reader's successful
        # read. Re-checked with can() whenever the list is shown.
        from app.services import personal

        await personal.record_view(db, actor.user_id, raw["_id"])
    return DocumentResponse(**body)


@router.put("/{slug}", response_model=DocumentResponse)
@limiter.limit(settings.rate_limit_edit)
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
    children: Literal["delete", "lift"] | None = Query(None),
):
    """A page with sub-pages needs ``?children=delete`` (they go too) or
    ``?children=lift`` (they move up a level); without it, 409
    ``{code: "has_children", count}``."""
    actor = access.actor_from_request(request, user, edit_secret=x_edit_secret)
    await doc_service.delete_document(db, slug, actor, _ctx(db, request), children=children)


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


@router.get("/{slug}/slug-check")
@limiter.limit(settings.rate_limit_read)
async def check_slug(
    request: Request,
    slug: str,
    new_slug: str = Query(..., max_length=100),
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_edit_secret: str | None = Header(None),
    user: User | None = Depends(optional_user),
):
    """Could the document at ``slug`` move to ``new_slug``? For whoever may
    rename it (``PATCH …/slug``'s rule): ``{slug, current, available, code
    (null | same | invalid | reserved | taken | folder), detail, url,
    markdrop_url, workspace_url, redirects_from}`` — the links it would have
    (its workspace's domain with folders and parent pages, when it is filed)
    and the old slugs that already redirect to it."""
    actor = access.actor_from_request(request, user, edit_secret=x_edit_secret)
    return await doc_service.check_new_slug(db, slug, new_slug.strip(), actor, _ctx(db, request))


@router.patch("/{slug}/settings", response_model=DocumentResponse)
@limiter.limit(settings.rate_limit_create)
async def update_settings(
    request: Request,
    slug: str,
    data: DocumentSettingsRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_edit_secret: str | None = Header(None),
    user: User | None = Depends(optional_user),
):
    """A document's password and expiry, without its content (the share
    dialog's "More options"). can(edit_settings): the owner or the edit
    secret. Same transition as ``PUT /{slug}`` with those fields: a new
    password narrows (epoch bump, bytes closed first, cache purge awaited);
    removing it widens; an expiry books its purge. A past date is 422."""
    actor = access.actor_from_request(request, user, edit_secret=x_edit_secret)
    ctx = _ctx(db, request)
    after = await doc_service.update_settings(
        db, slug, actor, ctx,
        read_password=data.read_password,
        remove_password=data.remove_password,
        expires_in=data.expires_in,
        custom_expires_at=data.custom_expires_at,
    )
    return DocumentResponse(**await _full_response(db, after, actor, ctx))


# ── Pages (services/pages.py, services/page_assets.py) ────────────────────────


async def _readable_page(db, request: Request, slug: str, user, *, read_password: str | None = None,
                         edit_secret: str | None = None, scope: str | None = None):
    """(row, actor, ctx) for a caller past can(read) on the document at exactly ``slug``."""
    actor = access.actor_from_request(request, user, edit_secret=edit_secret, read_password=read_password)
    ctx = _ctx(db, request, scope)
    raw = await db["documents"].find_one({"slug": slug})
    await access.require(actor, raw, "read", ctx)
    return raw, actor, ctx


@router.put("/{slug}/editor", response_model=DocumentResponse)
@limiter.limit(settings.rate_limit_create)
async def switch_editor(
    request: Request,
    slug: str,
    data: EditorSwitchRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_edit_secret: str | None = Header(None),
    user: User | None = Depends(optional_user),
):
    """Open a document in the block editor (``blocks``) or the classic one.
    The Markdown is unchanged. can(edit_content); refused for encrypted
    documents and files."""
    actor = access.actor_from_request(request, user, edit_secret=x_edit_secret)
    ctx = _ctx(db, request)
    raw = await db["documents"].find_one({"slug": slug})
    after = await pages.set_editor(db, raw, data.editor, actor, ctx)
    return DocumentResponse(**await _full_response(db, after, actor, ctx))


@router.get("/{slug}/children")
@limiter.limit(settings.rate_limit_read)
async def list_children(
    request: Request,
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_read_password: str | None = Header(None),
    x_edit_secret: str | None = Header(None),
    x_markdrop_workspace: str | None = Header(None),
    user: User | None = Depends(optional_user),
):
    """The page's sub-pages this caller can read: ``[{slug, title, editor,
    updated_at, has_children, access_inherit}]``, oldest first."""
    raw, actor, ctx = await _readable_page(db, request, slug, user, read_password=x_read_password,
                                           edit_secret=x_edit_secret, scope=x_markdrop_workspace)
    return await pages.children_listing(db, raw, actor, ctx)


@router.get("/{slug}/backlinks")
@limiter.limit(settings.rate_limit_read)
async def list_backlinks(
    request: Request,
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_read_password: str | None = Header(None),
    x_edit_secret: str | None = Header(None),
    x_markdrop_workspace: str | None = Header(None),
    user: User | None = Depends(optional_user),
):
    """Pages that mention, embed or link to this one — only those this caller
    can read: ``[{slug, title, editor, updated_at, kinds}]``."""
    from app.services import page_links

    raw, _actor, ctx = await _readable_page(db, request, slug, user, read_password=x_read_password,
                                            edit_secret=x_edit_secret, scope=x_markdrop_workspace)
    # The pages are checked for the person, not with this page's password or secret.
    return await page_links.backlinks(db, raw, access.actor_from_request(request, user), ctx)


@router.get("/{slug}/mentionable")
@limiter.limit(settings.rate_limit_read)
async def mentionable_people(
    request: Request,
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_edit_secret: str | None = Header(None),
    user: User | None = Depends(optional_user),
):
    """Who the page's editor can @-mention (``@`` and ``/person`` in the page
    editor): ``{state, people: [{id, name, email, avatar_url, you}]}``, the
    members of the page's workspace, sorted by name. can(edit_content).

    ``state`` is ``ok``; ``signin`` for an edit-link editor with no account;
    ``personal`` for a page in no workspace; ``not_member`` for someone who
    edits it (a grant, the edit link) but isn't a member of its workspace.
    Only ``ok`` lists anyone. ``email`` is filled in for a signed-in member on
    markdrop.in only, never on the workspace's own domain (as ``/auth/me``)."""
    actor = access.actor_from_request(request, user, edit_secret=x_edit_secret)
    ctx = _ctx(db, request)
    raw = await db["documents"].find_one({"slug": slug})
    await access.require(actor, raw, "edit_content", ctx)
    if user is None:
        return {"state": "signin", "people": []}
    f = await access.facts(actor, raw, ctx)
    if f.ws_id is None:
        return {"state": "personal", "people": []}
    if f.ws_role is None:
        return {"state": "not_member", "people": []}
    from app.services import workspace as ws_service

    people = await ws_service.mention_people(db, f.ws_id, viewer_id=user.id,
                                             emails=actor.cred != "tenant")
    return {"state": "ok", "people": people}


@router.put("/{slug}/parent", response_model=DocumentResponse)
@limiter.limit(settings.rate_limit_create)
async def move_page(
    request: Request,
    slug: str,
    data: ParentMoveRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Put the page under another page (``parent``: its slug) or at the top
    (null). 409 ``{code: "access_change", readers_before, readers_after}`` when
    that changes who can read it, unless ``confirm_access_change``."""
    actor = access.actor_from_request(request, user)
    ctx = _ctx(db, request)
    raw = await db["documents"].find_one({"slug": slug})
    after = await pages.move(db, raw, data.parent, actor, ctx, confirm=data.confirm_access_change)
    return DocumentResponse(**await _full_response(db, after, actor, access.Ctx(db, surface="rest")))


@router.post("/{slug}/assets", status_code=201)
@limiter.limit("60/minute")
async def upload_page_asset(
    request: Request,
    slug: str,
    file: UploadFile = File(...),
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_edit_secret: str | None = Header(None),
    user: User | None = Depends(optional_user),
):
    """An image for the page (PNG, JPEG, GIF or WebP, up to 10 MB):
    ``{id, mime, size, width, height}``; write it as ``![alt](asset:<id>)``.
    can(edit_content)."""
    actor = access.actor_from_request(request, user, edit_secret=x_edit_secret)
    ctx = _ctx(db, request)
    raw = await db["documents"].find_one({"slug": slug})
    await access.require(actor, raw, "edit_content", ctx)
    if pages.is_page_capable(raw):
        await pages.check_page_lock(raw, actor, ctx)
    data = await file.read(page_assets.MAX_BYTES + 1)
    return await page_assets.upload(db, raw, data, user_id=actor.user_id or raw.get("owner_id"))


@router.get("/{slug}/assets/urls")
@limiter.limit(settings.rate_limit_read)
async def page_asset_urls(
    request: Request,
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_read_password: str | None = Header(None),
    x_edit_secret: str | None = Header(None),
    x_markdrop_workspace: str | None = Header(None),
    user: User | None = Depends(optional_user),
):
    """Fresh links for the page images its content references (signed ones
    expire with an artifact link's lifetime): ``{assets: {id: {url, expires_at}}}``."""
    raw, _actor, _ctx_ = await _readable_page(db, request, slug, user, read_password=x_read_password,
                                              edit_secret=x_edit_secret, scope=x_markdrop_workspace)
    if raw.get("encrypted"):
        return {"assets": {}}
    return {"assets": await page_assets.urls_for(db, raw, pages.asset_ids(raw.get("content")))}


@router.post("/{slug}/embeds")
@limiter.limit(settings.rate_limit_read)
async def resolve_page_embeds(
    request: Request,
    slug: str,
    data: EmbedsRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_read_password: str | None = Header(None),
    x_edit_secret: str | None = Header(None),
    x_markdrop_workspace: str | None = Header(None),
    user: User | None = Depends(optional_user),
):
    """What this viewer may see of each embedded item (``{embeds: {slug:
    Resolved}}``). The caller must be able to read the page; each item is then
    resolved with the item's own access, for this caller. Anything not "ok"
    carries no title, excerpt or link."""
    _raw, _page_actor, _ = await _readable_page(db, request, slug, user, read_password=x_read_password,
                                                edit_secret=x_edit_secret, scope=x_markdrop_workspace)
    # Items are resolved for the person (no password or edit secret of the page).
    actor = access.actor_from_request(request, user)
    ctx = _ctx(db, request, x_markdrop_workspace)
    return {"embeds": await pages.resolve_embeds(db, actor, ctx, data.slugs)}


@router.post("/{slug}/lock")
@limiter.limit(settings.rate_limit_edit)
async def take_page_lock(
    request: Request,
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Take (or renew) the page's edit lock: ``{holder: {name}, expires_at}``,
    two minutes past the last call (the editor sends one every 30 s). 423
    ``{code: "locked", holder: {name}}`` while someone else holds it."""
    actor = access.actor_from_request(request, user)
    raw = await db["documents"].find_one({"slug": slug})
    return await pages.acquire_lock(db, raw, actor, _ctx(db, request))


@router.delete("/{slug}/lock", status_code=204)
@limiter.limit(settings.rate_limit_edit)
async def release_page_lock(
    request: Request,
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    actor = access.actor_from_request(request, user)
    raw = await db["documents"].find_one({"slug": slug})
    await pages.release_lock(db, raw, actor, _ctx(db, request))


@router.post("/{slug}/lock/release", status_code=204)
@limiter.limit(settings.rate_limit_edit)
async def release_page_lock_on_close(
    request: Request,
    slug: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """``DELETE …/lock`` for a page that is closing. The browser sends it with
    ``navigator.sendBeacon``: a keepalive DELETE needs a CORS preflight that
    browsers don't make while a page unloads, and a beacon can't carry an
    Authorization header, so the session token is the text/plain body: the
    markdrop.in session, or a workspace domain's tenant token sent from that
    domain (its Origin must be the token's host, the host must still be live,
    and the page must be in the token's workspace — the same three checks as
    any tenant request). Anything else (no token, an API token, someone else's
    lock) is ignored; the answer is always 204."""
    import jwt

    from app.routers import auth as auth_router
    from app.services import user as user_service
    from app.utils.auth import decode_access_token

    token = (await request.body())[:4096].decode("utf-8", "ignore").strip()
    try:
        payload = decode_access_token(token)
    except jwt.InvalidTokenError:
        return
    actor_kw: dict = {"cred": "session"}
    if payload.get("typ") == "tenant":
        claim = auth_router.domain_service.clean_host(payload.get("host"))
        if not claim or auth_router._origin_host(request) != claim:
            return
        if not await auth_router._tenant_host_live(payload):
            return
        actor_kw = {"cred": "tenant", "tenant_ws": payload.get("ws")}
    user = await user_service.get_user_by_id(db, payload.get("sub", ""))
    raw = await db["documents"].find_one({"slug": slug}) if user else None
    if raw is None:
        return
    try:
        # release_lock checks can(read) — pinned to the tenant workspace for a tenant token.
        await pages.release_lock(db, raw, access.Actor(user=user, **actor_kw), _ctx(db, request))
    except HTTPException:
        return


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


async def _beacon_user(request: Request) -> User | None:
    """The signed-in viewer behind a beacon, resolved exactly like
    ``optional_user`` (session JWT, API token, tenant token on its own domain)
    — but a credential that doesn't resolve is simply anonymous here: a beacon
    always answers the same."""
    try:
        return await optional_user(request)
    except HTTPException:
        return None


async def _viewer_flags(db: AsyncIOMotorDatabase, raw: dict, user_id: str | None) -> tuple[bool, bool]:
    """(is_owner, internal) for a viewer of ``raw``: the owner's own views are
    never counted; a member of the document's workspace is counted as internal."""
    if not user_id:
        return False, False
    if raw.get("owner_id") and raw["owner_id"] == user_id:
        return True, False
    if raw.get("workspace_id"):
        from app.services import workspace as ws_service

        return False, (await ws_service.role_for(db, raw["workspace_id"], user_id)) is not None
    return False, False


@router.post("/{slug}/events", status_code=202, include_in_schema=False)
@limiter.limit("120/minute")
async def record_click(
    request: Request,
    slug: str,
    data: EventRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """Record a view / export-PDF / copy-URL event (called by the viewer's
    browser). Always 202: missing, unreadable and recorded look the same.

    A signed-in viewer sends their bearer token: the owner's own events are
    not recorded at all (and don't bump ``views``); a member of the
    document's workspace is recorded with ``internal: true``."""
    ua = request.headers.get("user-agent") or ""
    if data.type == "view" and _is_bot(ua):
        return {"status": "ignored"}
    raw = await _beacon_target(db, slug, data.ticket)
    if raw is not None:
        user = await _beacon_user(request)
        is_owner, internal = await _viewer_flags(db, raw, user.id if user else None)
        if is_owner:
            return {"status": "ok"}
        result = await doc_service.register_event(db, raw, data.type)
        if result is not None:
            doc_id, owner_id = result
            utm = data.utm.model_dump() if data.utm is not None else {}
            ver = None
            if raw.get("kind") == "artifact":
                current = int(raw.get("file_version") or 1)
                ver = data.ver if data.ver and 1 <= data.ver <= current else current
            await analytics.record_event(
                db, doc_id, owner_id, data.type,
                ip=get_client_ip(request),
                referrer=data.referrer,
                user_agent=ua,
                utm=utm,
                ver=ver,
                internal=internal,
            )
    return {"status": "ok"}


@router.post("/{slug}/read", status_code=204, include_in_schema=False)
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


async def _engage_viewer(token: str) -> str | None:
    """The user behind an engagement beacon's ``u``: a session JWT or an API
    token. A tenant token is treated as anonymous here — a body field carries
    no Origin to hold it to the domain it was minted for."""
    from app.routers.auth import _user_id_from_token
    from app.services import api_token as api_token_service

    if not token.startswith(api_token_service.TOKEN_PREFIX):
        import jwt as pyjwt

        from app.utils.auth import decode_access_token

        try:
            if decode_access_token(token).get("typ") == "tenant":
                return None
        except pyjwt.InvalidTokenError:
            return None
    return await _user_id_from_token(token)


@router.post("/{slug}/engage", status_code=204, include_in_schema=False)
@limiter.limit("120/minute")
async def record_engagement(
    slug: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
) -> None:
    """The engagement beacon (creator analytics, build spec §1b): deltas of
    what a reader did since the previous beacon of the same page load.

    A raw ``text/plain`` body (≤ 8 KB) so ``navigator.sendBeacon`` can send it
    without a CORS preflight while the page unloads. Admission is the read
    beacon's (``_beacon_target``: anonymous-readable, or a valid read ticket in
    ``"t"``). ``"u"`` may carry the viewer's Markdrop token: the owner's own
    sessions are dropped, a workspace member's are marked internal. Always
    204, whatever happened.
    """
    from app.services import engage

    ua = request.headers.get("user-agent") or ""
    if _is_bot(ua):
        return
    raw_body = await request.body()
    try:
        msg = engage.parse(raw_body)
        if msg is None:
            return
        doc = await _beacon_target(db, slug, msg["t"])
        if not doc:
            return
        viewer_id = await _engage_viewer(msg["u"]) if msg["u"] else None
        is_owner, internal = await _viewer_flags(db, doc, viewer_id)
        await engage.ingest(db, doc, msg, ip=get_client_ip(request), ua=ua,
                            viewer_id=viewer_id, internal=internal)
    except Exception:  # pragma: no cover - a beacon never errors
        import logging

        logging.getLogger(__name__).warning("engage beacon failed", exc_info=True)
    return


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
