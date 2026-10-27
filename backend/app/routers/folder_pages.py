"""Public folder pages (D2: a folder shows each visitor only what they could
already open; folders never grant).

    GET /api/v1/host/folder?host=<host>&path=<a/b>     a custom domain's folder index
    GET /api/v1/folders/shared/{share_id}?path=<a/b>   a shared folder (markdrop.in/f/<id>)

Optional auth: none (anonymous), a session / ``mdk_`` token, or a tenant token
**of that workspace** (another workspace's tenant token is a 401). A workspace
that requires sign-in answers anonymous callers 401 with ``X-Markdrop-Gate:
signin`` and its branding only. A folder is shown only when it holds at least
one item the caller can read (recursively) — otherwise 404, so the structure
of a workspace never leaks — except a shared folder's own root.

Kept in its own router (the domains router belongs to another workstream).
"""

from __future__ import annotations

import jwt
from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.services import access, api_token, urls
from app.services import folder as folder_service
from app.services import user as user_service
from app.services import workspace as ws_service
from app.services import workspace_items as items_service
from app.utils.auth import decode_access_token
from app.utils.net import get_client_ip

router = APIRouter(prefix="/api/v1", tags=["folder-pages"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


async def reader_for(request: Request, db: AsyncIOMotorDatabase, workspace_id: str) -> access.Actor:
    """The optional reader. Never widens: an expired session is anonymous; a
    bad API token or a tenant token for another workspace/host is a 401."""
    auth = request.headers.get("Authorization", "")
    token = auth.removeprefix("Bearer ").strip() if auth.startswith("Bearer ") else ""
    if not token:
        return access.Actor()
    if token.startswith(api_token.TOKEN_PREFIX):
        uid = await api_token.verify_token(db, token)
        if not uid:
            raise HTTPException(status_code=401, detail="Invalid API token")
        return access.Actor.of(await user_service.get_user_by_id(db, uid), "api_token")
    try:
        payload = decode_access_token(token)
    except jwt.InvalidTokenError:
        return access.Actor()
    if payload.get("typ") == "tenant":
        # Exactly the document route's tenant-token rule (routers/auth.py,
        # policy §2.2 step 1): an allowlisted route, an Origin that is present
        # and equals the claim host, that host still a *live* app domain of the
        # claim workspace — and here, that workspace is the one being listed
        # (B1). No Origin is a 401, not a pass.
        from app.routers.auth import _tenant_host_live, _tenant_scope_ok

        if (payload.get("ws") != workspace_id or not _tenant_scope_ok(request, payload)
                or not await _tenant_host_live(payload)):
            raise HTTPException(status_code=401,
                                detail="This session only works for documents on that workspace's domain.")
        user = await user_service.get_user_by_id(db, payload.get("sub", ""))
        if user is None:
            return access.Actor()
        return access.Actor(user=user, cred="tenant", tenant_ws=workspace_id,
                            tenant_host=payload.get("host"))
    user = await user_service.get_user_by_id(db, payload.get("sub", ""))
    if user is None:
        return access.Actor()
    return access.Actor.of(user, "session")


def _branding(ws) -> dict:
    b = ws.branding
    return {
        "id": ws.id, "name": ws.name,
        "branding": {"site_name": b.site_name, "favicon_url": b.favicon_url, "logo_url": b.logo_url,
                     "accent_color": b.accent_color, "logo_well": b.logo_well,
                     "hide_markdrop_branding": b.hide_markdrop_branding},
        "require_auth_to_view": ws.settings.require_auth_to_view,
    }


def _public_branding(ws) -> dict:
    """What an anonymous visitor of a sign-in-only site may learn: the public
    site name and look — not the workspace id or its internal name."""
    b = ws.branding
    return {
        "name": b.site_name or None,
        "branding": {"site_name": b.site_name, "favicon_url": b.favicon_url, "logo_url": b.logo_url,
                     "accent_color": b.accent_color, "logo_well": b.logo_well,
                     "hide_markdrop_branding": b.hide_markdrop_branding},
        "require_auth_to_view": ws.settings.require_auth_to_view,
    }


def _signin(ws) -> JSONResponse:
    return JSONResponse({"detail": "Sign in to view this site.", "gate": "signin",
                         "workspace": _public_branding(ws)},
                        status_code=401, headers={"X-Markdrop-Gate": "signin",
                                                  "Cache-Control": "private, no-store"})


def _cache(response: Response, actor: access.Actor) -> None:
    response.headers["Cache-Control"] = (
        "public, max-age=60" if actor.user is None else "private, no-store")


@router.get("/host/folder")
@limiter.limit("600/minute")
async def host_folder(
    request: Request, response: Response,
    host: str = Query(..., max_length=253),
    path: str = Query("", max_length=1000),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """The folder index of a workspace's own domain (folderIndex.ts contract):

    ``{folder: {name, path[]}|null, trail: [{name, path[]}], folders: [{name,
    path[], document_count}], documents: [{slug, title, kind, type_label,
    renderer, mime, original_filename, folder_path, created_at, updated_at,
    url, size_bytes, poster_url?}], workspace: {...}}``

    ``document_count`` counts readable documents at or below the folder.
    """
    row = await urls.live_host(db, host)
    ws = await ws_service.get_workspace(db, row["workspace_id"]) if row else None
    if ws is None:
        raise HTTPException(status_code=404, detail="Unknown domain.")
    actor = await reader_for(request, db, ws.id)
    if ws.settings.require_auth_to_view and actor.user is None:
        return _signin(ws)
    ctx = access.Ctx(db, surface="host", workspace_scope=ws.id, host=row["host"],
                     ip=get_client_ip(request))
    segments = [s for s in (path or "").strip("/").split("/") if s]
    folder_id = await folder_service.resolve_path(db, ws.id, segments) if segments else None
    if segments and folder_id is None:
        raise HTTPException(status_code=404, detail="Folder not found")
    shared_link = False
    if folder_id:
        f = await db["folders"].find_one({"_id": ObjectId(folder_id)}, {"share": 1})
        shared_link = ((f or {}).get("share") or {}).get("level") == "link"
    # In a sign-in-only workspace a link share opens nothing to an outsider,
    # so for them it is a gated item like any other: shown only when it holds
    # something they can read (small B: no folder names for strangers).
    if shared_link and ws.settings.require_auth_to_view and await ctx.role(ws.id, actor.user_id) is None:
        shared_link = False
    listing = await items_service.folder_listing(
        db, actor, ctx, ws.id, folder_id, always_show=(folder_id is None or shared_link))
    if listing is None:
        raise HTTPException(status_code=404, detail="Folder not found")
    paths, total = listing["paths"], listing["total"]
    folders_by_id = {f.id: f for f in await folder_service.list_folders(db, ws.id)}
    trail, folder = [], None
    if folder_id:
        chain, cur = [], folders_by_id.get(folder_id)
        while cur is not None and len(chain) <= folder_service.MAX_DEPTH + 1:
            chain.append(cur)
            cur = folders_by_id.get(cur.parent_id) if cur.parent_id else None
        chain.reverse()
        # Only ancestors the caller could open themselves (≥1 readable item at
        # or below): a link-shared folder inside an otherwise unreadable one
        # must not name its parents (B6).
        trail = [{"name": f.name, "path": paths.get(f.id) or []} for f in chain[:-1]
                 if total.get(f.id, 0) > 0]
        folder = {"name": chain[-1].name, "path": paths.get(folder_id) or [],
                  "document_count": total.get(folder_id, 0)}
    _cache(response, actor)
    return jsonable_encoder({
        "folder": folder,
        "trail": trail,
        "folders": [{"name": f.name, "path": paths.get(f.id) or [], "document_count": total.get(f.id, 0)}
                    for f in listing["folders"]],
        "documents": listing["documents"],
        "workspace": _branding(ws),
    })


@router.get("/folders/shared/{share_id}")
@limiter.limit("300/minute")
async def shared_folder(
    request: Request, response: Response, share_id: str,
    path: str = Query("", max_length=1000),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """A shared folder: ``{workspace:{name, branding…}, folder:{name, path,
    breadcrumbs:[{name, path}]}, subfolders:[{name, path, count}], items:[{slug,
    title, kind, mime, url, size_bytes?, updated_at, poster_url?}]}`` — paths
    relative to the shared root; items filtered to what this caller can read.
    Level ``workspace`` needs a member (else 401 signin / 404)."""
    folder_raw = await folder_service.find_share(db, share_id)
    ws = await ws_service.get_workspace(db, folder_raw["workspace_id"]) if folder_raw else None
    if folder_raw is None or ws is None:
        raise HTTPException(status_code=404, detail="This folder link doesn't exist.")
    actor = await reader_for(request, db, ws.id)
    if ws.settings.require_auth_to_view and actor.user is None:
        return _signin(ws)
    level = (folder_raw.get("share") or {}).get("level") or "link"
    ctx = access.Ctx(db, surface="share", ip=get_client_ip(request))
    if level == "workspace" and await ctx.role(ws.id, actor.user_id) is None:
        if actor.user is None:
            return _signin(ws)
        raise HTTPException(status_code=404, detail="This folder link doesn't exist.")

    root_id = str(folder_raw["_id"])
    # A sign-in-only workspace's link share shows its root to an outsider only
    # when it holds something they can read (small B).
    outsider_in_gated = (ws.settings.require_auth_to_view
                         and await ctx.role(ws.id, actor.user_id) is None)
    folders = await folder_service.list_folders(db, ws.id)
    by_id = {f.id: f for f in folders}
    target, crumbs = root_id, [{"name": folder_raw["name"], "path": ""}]
    for seg in [s for s in (path or "").strip("/").split("/") if s]:
        child = next((f for f in folders if f.parent_id == target and f.slug == seg), None)
        if child is None:
            raise HTTPException(status_code=404, detail="Folder not found")
        target = child.id
        crumbs.append({"name": child.name, "path": "/".join([c for c in [crumbs[-1]["path"], seg] if c])})
    listing = await items_service.folder_listing(db, actor, ctx, ws.id, target, root_id=root_id,
                                                 always_show=(target == root_id and not outsider_in_gated))
    if listing is None:
        if target == root_id:
            raise HTTPException(status_code=404, detail="This folder link doesn't exist.")
        raise HTTPException(status_code=404, detail="Folder not found")
    here = crumbs[-1]["path"]
    _cache(response, actor)
    return jsonable_encoder({
        "share": {"id": share_id, "level": level},
        "workspace": _branding(ws),
        "folder": {"name": by_id[target].name if target in by_id else folder_raw["name"],
                   "path": here, "breadcrumbs": crumbs},
        "subfolders": [{"name": f.name, "path": "/".join([p for p in [here, f.slug] if p]),
                        "count": listing["total"].get(f.id, 0)} for f in listing["folders"]],
        "items": [{k: d.get(k) for k in ("slug", "title", "kind", "mime", "url", "size_bytes",
                                         "updated_at", "poster_url", "type_label", "renderer")}
                  for d in listing["documents"]],
    })
