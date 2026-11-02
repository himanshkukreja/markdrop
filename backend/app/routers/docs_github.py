"""Markdrop Guides ↔ GitHub: /api/v1/github/… (connect the app, pick a repository, the webhook).

    GET    /status?workspace_id=           the app (set up?) and the GitHub accounts connected here
    POST   /install {workspace_id, return_to}    → {url}: install the app on GitHub
    POST   /authorize {workspace_id, return_to}  → {url}: link an installation that already exists
    POST   /connect {code, state, installation_id?, setup_action?}   the round trip's end
    DELETE /installations/{installation_id}?workspace_id=           unlink (Markdrop only)
    GET    /repos?workspace_id=&installation_id=&q=                 an installation's repositories
    GET    /repo?workspace_id=&owner=&name=[&installation_id=]       a repository and its branches
    GET    /inspect?workspace_id=&owner=&name=&branch=&path=[&installation_id=][&format=]
                                            folders worth importing, the chosen one's format and preview
    POST   /webhook                          GitHub's deliveries (X-Hub-Signature-256)

``workspace_id`` is a workspace id or "personal". Connecting, listing repositories and inspecting
are for Guides admins of that workspace (the people who create guides and connect them); a
repository read without ``installation_id`` is a public one (no app needed). Services:
services/docs_github_app.py (GitHub), docs_github_detect.py (the preview), docs_github_sync.py.
App-internal (kept out of the public schema), like the docs-sites API.
"""

import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.schemas.docs_site import GitHubConnect, GitHubStart
from app.services import docs_github_app as gh
from app.services import docs_github_detect as detect
from app.services import docs_github_sync as sync

log = logging.getLogger("markdrop.docs_github")

router = APIRouter(prefix="/api/v1/github", tags=["github"])

MAX_WEBHOOK_BYTES = 5 * 1024 * 1024


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _gh_error(e: gh.GitHubError) -> JSONResponse:
    body: dict = {"detail": e.message}
    headers = {}
    if e.retry_after:
        body["retry_after"] = e.retry_after
        headers["Retry-After"] = str(e.retry_after)
    return JSONResponse(body, status_code=e.status, headers=headers)


def _need_app() -> None:
    if not gh.configured():
        raise HTTPException(status_code=503, detail="Private repositories and sync need the Markdrop Guides GitHub App, "
                                                    "which isn't set up yet. Public repositories import without it.")


def _callback_url() -> str:
    # Markdrop Guides' studio host (guides.markdrop.in/github/installed): the GitHub App's callback
    # and setup URL must name exactly this (docs-platform/setup-github-app.md).
    return get_settings().studio_link("/github/installed")


@router.get("/status")
@limiter.limit("120/minute")
async def status(request: Request, workspace_id: str | None = Query(None, max_length=40),
                 db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    scope = await sync.require_scope_admin(db, user, workspace_id)
    return {"app": gh.app_view(), "installations": await sync.list_installations(db, *scope), "can_manage": True}


@router.post("/install")
@limiter.limit("20/minute")
async def install(request: Request, body: GitHubStart, db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    _need_app()
    ws, _owner = await sync.require_scope_admin(db, user, body.workspace_id)
    state = gh.sign_state(user.id, ws, sync.safe_return(body.return_to))
    return {"url": gh.install_url(state)}


@router.post("/authorize")
@limiter.limit("20/minute")
async def authorize(request: Request, body: GitHubStart, db: AsyncIOMotorDatabase = Depends(get_db),
                    user: User = Depends(require_user)):
    _need_app()
    ws, _owner = await sync.require_scope_admin(db, user, body.workspace_id)
    state = gh.sign_state(user.id, ws, sync.safe_return(body.return_to))
    return {"url": gh.authorize_url(state, _callback_url())}


@router.post("/connect")
@limiter.limit("20/minute")
async def connect(request: Request, body: GitHubConnect, db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    return await sync.connect(db, user, code=body.code, state=body.state, installation_id=body.installation_id)


@router.delete("/installations/{installation_id}")
@limiter.limit("20/minute")
async def unlink(request: Request, installation_id: int, workspace_id: str | None = Query(None, max_length=40),
                 db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    scope = await sync.require_scope_admin(db, user, workspace_id)
    await sync.unlink_installation(db, *scope, installation_id)
    return {"ok": True}


@router.get("/repos")
@limiter.limit("60/minute")
async def repos(request: Request, installation_id: int, workspace_id: str | None = Query(None, max_length=40),
                q: str | None = Query(None, max_length=100), db: AsyncIOMotorDatabase = Depends(get_db),
                user: User = Depends(require_user)):
    _need_app()
    scope = await sync.require_scope_admin(db, user, workspace_id)
    await sync.scope_installation(db, *scope, installation_id)
    try:
        rows, truncated = await gh.installation_repos(installation_id, q)
    except gh.GitHubError as e:
        return _gh_error(e)
    return {"repos": rows, "truncated": truncated}


async def _installation_or_public(db, user: User, workspace_id: str | None, installation_id: int | None):
    scope = await sync.require_scope_admin(db, user, workspace_id)
    if installation_id:
        _need_app()
        await sync.scope_installation(db, *scope, installation_id)
    return scope


def _check_names(owner: str, name: str) -> None:
    from app.schemas.docs_site import GitHubRepo

    try:
        GitHubRepo(owner=owner, name=name)
    except ValueError:
        raise HTTPException(status_code=422, detail="That isn't a GitHub repository name.") from None


@router.get("/repo")
@limiter.limit("60/minute")
async def repo(request: Request, owner: str = Query(..., max_length=100), name: str = Query(..., max_length=100),
               installation_id: int | None = None, workspace_id: str | None = Query(None, max_length=40),
               db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    _check_names(owner, name)
    await _installation_or_public(db, user, workspace_id, installation_id)
    try:
        info = await gh.get_repo(owner, name, installation_id)
        if not installation_id and info["private"]:
            raise gh.GitHubError(404, "We couldn't find that repository. Check the address, or connect GitHub for a private one.")
        names = await gh.branches(owner, name, installation_id)
    except gh.GitHubError as e:
        return _gh_error(e)
    default = info["default_branch"]
    names = [default] + [b for b in names if b != default]
    return {"repo": {**info, "public": not info["private"]}, "branches": names[:300],
            "via": "app" if installation_id else "public"}


@router.get("/inspect")
@limiter.limit("60/minute")
async def inspect(request: Request, owner: str = Query(..., max_length=100), name: str = Query(..., max_length=100),
                  branch: str = Query(..., max_length=200), path: str | None = Query(None, max_length=300),
                  installation_id: int | None = None, format: str | None = Query(None, max_length=20),
                  workspace_id: str | None = Query(None, max_length=40),
                  db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    _check_names(owner, name)
    await _installation_or_public(db, user, workspace_id, installation_id)
    try:
        sha = await gh.branch_sha(owner, name, branch, installation_id)
        paths, truncated = await gh.tree(owner, name, sha, installation_id)

        async def read(p: str) -> bytes | None:
            return await gh.file_bytes(owner, name, sha, p, installation_id, max_bytes=512_000)

        candidates = await detect.folders(paths, read)
        chosen = path if path is not None else (candidates[0]["path"] if candidates else "")
        try:
            selected = await detect.preview(paths, chosen, read, format if format in detect.FORMATS else None)
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e)) from None
    except gh.GitHubError as e:
        return _gh_error(e)
    if truncated:
        selected["warnings"].append("This repository is very large: the preview read part of its file list. "
                                    "The import reads all of it.")
    return {"sha": sha, "folders": candidates, "selected": selected, "truncated": truncated}


# ── Webhook ───────────────────────────────────────────────────────────────────


@router.post("/webhook", include_in_schema=False)
async def webhook(request: Request, db: AsyncIOMotorDatabase = Depends(get_db)):
    """GitHub's deliveries. Unsigned or wrongly signed: 401 (nothing read). A delivery seen before:
    200 without doing it again. Not rate limited per address (GitHub's hooks share a few)."""
    if not gh.configured():
        return JSONResponse({"detail": "not set up"}, status_code=503)
    n = int(request.headers.get("content-length") or 0)
    if n > MAX_WEBHOOK_BYTES:
        return JSONResponse({"detail": "too large"}, status_code=413)
    raw = b""
    async for chunk in request.stream():
        raw += chunk
        if len(raw) > MAX_WEBHOOK_BYTES:
            return JSONResponse({"detail": "too large"}, status_code=413)
    if not gh.verify_signature(raw, request.headers.get("x-hub-signature-256")):
        return JSONResponse({"detail": "bad signature"}, status_code=401)
    event = (request.headers.get("x-github-event") or "").strip()[:60]
    delivery = (request.headers.get("x-github-delivery") or "").strip()[:100]
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        return JSONResponse({"detail": "body must be JSON"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"detail": "body must be a JSON object"}, status_code=400)
    if not await sync.first_delivery(db, delivery, event):
        return {"ok": True, "duplicate": True}
    try:
        out = await sync.handle_event(db, event, body)
    except Exception:
        # Forget the delivery so GitHub's retry (or a manual redelivery) can do it.
        if delivery:
            await db[sync.DELIVERIES].delete_one({"_id": delivery})
        log.exception("github webhook %s %s failed", event, delivery)
        return JSONResponse({"detail": "failed"}, status_code=500)
    log.info("github webhook %s %s: %s", event, delivery, {k: v for k, v in out.items() if k != "ok"})
    return out
