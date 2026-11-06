"""Jira Cloud: /api/v1/jira/… (services/jira.py, jira_links.py, jira_ai.py, jira_team.py).

Settings (signed in, markdrop.in only):
    GET    /status?workspace_id=            the workspace card: set up?, the site, me (connected?)
    POST   /connect/start {kind, workspace_id?, back?}   → {url}: Atlassian's consent screen
                                            (kind "site": a workspace admin connecting the site; "me": my own account)
    POST   /connect/finish {code, state}    the end of it (stores my tokens, encrypted)
    GET    /sites?workspace_id=             the Jira sites my connection reaches (admins, to pick one)
    GET    /projects?workspace_id=&cloud_id=   projects (as me)
    GET    /issue-types?workspace_id=&project=  issue types I can create there
    PUT    /site {workspace_id, cloud_id, projects, default_project, default_issue_type}   (admins)
    DELETE /site?workspace_id=              disconnect the site (admins; removes the webhook)
    GET    /me                              Settings › Account › Jira
    DELETE /me                              forget my Atlassian connection

Issues from items (members; as the person, through their own connection):
    GET    /page?slug=                      the page's chips for me + what I can do
    POST   /draft {slug, block|offset|selection | fact_id, project?}     an AI draft to review
    POST   /draft/all {slug, project?}      drafts for every open action item on a page
    POST   /issues {slug, block|offset|selection | fact_id, fields}     create (as me) and link
    POST   /issues/bulk {slug, items: [{block, fields}]}                create several
    POST   /links {slug, block|offset | fact_id, key}                   link an existing issue
    DELETE /links/{id}                      unlink;   POST /links/{id}/retry: push the to-do's state again
    POST   /lookup {urls}                   live chips for Jira links pasted in pages (my own connection)

Team (members):
    GET    /team/{ws}?refresh=              the board's Jira part (details for connected viewers, counts otherwise)
    GET    /team/{ws}/people/{user_id}      a person's issues, grouped

From Jira (no session; a JWT signed with the app's client secret; out of the public schema):
    POST   /webhook/{workspace_id}
"""

# No `from __future__ import annotations`: slowapi wraps these routes (see routers/docs_ai.py).
import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import is_tenant_request, require_user
from app.services import access, jira, jira_links, jira_team
from app.utils.net import get_client_ip

log = logging.getLogger("markdrop.jira")

router = APIRouter(prefix="/api/v1/jira", tags=["jira"])

_WS = r"^[0-9a-f]{24}$"
_BLOCK = r"^b-[0-9A-Za-z_-]{1,40}$"
_SLUG = r"^[A-Za-z0-9_-]{1,64}$"
MAX_BODY = 512 * 1024


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _app_only(request: Request) -> None:
    if is_tenant_request(request):
        raise HTTPException(status_code=403, detail="Jira settings are on markdrop.in.")


def _ac(request: Request, db, user: User):
    return access.actor_from_request(request, user), access.Ctx(db, surface="rest", ip=get_client_ip(request))


class StartIn(BaseModel):
    kind: str = Field(..., pattern=r"^(site|me)$")
    workspace_id: Optional[str] = Field(None, pattern=_WS)
    back: Optional[str] = Field(None, max_length=500)


class CodeIn(BaseModel):
    code: str = Field(..., min_length=1, max_length=2000)
    state: str = Field(..., min_length=1, max_length=1000)


class SiteIn(BaseModel):
    workspace_id: str = Field(..., pattern=_WS)
    cloud_id: str = Field(..., min_length=1, max_length=80)
    projects: list[str] = Field(default_factory=list, max_length=jira.MAX_PROJECTS)
    default_project: Optional[str] = Field(None, max_length=20)
    default_issue_type: Optional[str] = Field(None, max_length=60)


class ItemIn(BaseModel):
    slug: Optional[str] = Field(None, pattern=_SLUG)
    block: Optional[str] = Field(None, pattern=_BLOCK)
    offset: Optional[int] = Field(None, ge=0, le=5_000_000)
    selection: Optional[str] = Field(None, max_length=jira_links.SELECTION_MAX + 1000)
    fact_id: Optional[str] = Field(None, pattern=_WS)
    project: Optional[str] = Field(None, max_length=20)


class Fields(BaseModel):
    project: str = Field(..., min_length=1, max_length=20)
    issue_type: Optional[str] = Field(None, max_length=60)
    summary: str = Field(..., min_length=1, max_length=400)
    description: Optional[str] = Field("", max_length=8000)
    priority: Optional[str] = Field(None, max_length=40)
    assignee_user_id: Optional[str] = Field(None, pattern=_WS)
    assignee_account_id: Optional[str] = Field(None, max_length=128)
    due: Optional[str] = Field(None, max_length=10)
    labels: list[str] = Field(default_factory=list, max_length=10)


class CreateIn(ItemIn):
    fields: Fields


class BulkItem(BaseModel):
    block: str = Field(..., pattern=_BLOCK)
    fields: Fields


class BulkIn(BaseModel):
    slug: str = Field(..., pattern=_SLUG)
    items: list[BulkItem] = Field(..., min_length=1, max_length=25)


class LinkIn(ItemIn):
    key: str = Field(..., min_length=3, max_length=300)


class LookupIn(BaseModel):
    urls: list[str] = Field(default_factory=list, max_length=50)


# ── Settings ──────────────────────────────────────────────────────────────────


@router.get("/status", summary="Jira connection status")
@limiter.limit("120/minute")
async def status(request: Request, workspace_id: str = Query(..., pattern=_WS),
                 db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    _app_only(request)
    return await jira.status(db, user, workspace_id)


@router.post("/connect/start", summary="Start connecting Jira")
@limiter.limit("20/minute")
async def connect_start(request: Request, body: StartIn, db: AsyncIOMotorDatabase = Depends(get_db),
                        user: User = Depends(require_user)):
    _app_only(request)
    if body.kind == "site" and not body.workspace_id:
        raise HTTPException(status_code=422, detail="Pass workspace_id to connect a workspace's Jira site.")
    return {"url": await jira.start(db, user, body.kind, body.workspace_id, body.back)}


@router.post("/connect/finish", summary="Finish connecting Jira")
@limiter.limit("20/minute")
async def connect_finish(request: Request, body: CodeIn, db: AsyncIOMotorDatabase = Depends(get_db),
                         user: User = Depends(require_user)):
    _app_only(request)
    return await jira.finish(db, user, body.code, body.state)


@router.get("/sites", summary="Jira sites my connection reaches")
@limiter.limit("30/minute")
async def sites(request: Request, workspace_id: str = Query(..., pattern=_WS),
                db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    _app_only(request)
    await jira.require_admin(db, user, workspace_id)
    try:
        return {"sites": await jira.my_sites(db, user)}
    except jira.NotConnected as exc:
        raise jira.not_connected(exc)


@router.get("/projects", summary="Jira projects")
@limiter.limit("60/minute")
async def projects(request: Request, workspace_id: str = Query(..., pattern=_WS), cloud_id: Optional[str] = Query(None, max_length=80),
                   db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    _app_only(request)
    await jira.require_member(db, user, workspace_id)
    if not cloud_id:
        site = await jira.site_for(db, workspace_id)
        if site is None:
            raise HTTPException(status_code=404, detail="This workspace isn't connected to Jira.")
        cloud_id = site["cloud_id"]
    try:
        return {"projects": await jira.projects(db, user.id, cloud_id)}
    except jira.NotConnected as exc:
        raise jira.not_connected(exc)


@router.get("/issue-types", summary="Jira issue types of a project")
@limiter.limit("60/minute")
async def issue_types(request: Request, workspace_id: str = Query(..., pattern=_WS), project: str = Query(..., max_length=20),
                      cloud_id: Optional[str] = Query(None, max_length=80),
                      db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    await jira.require_member(db, user, workspace_id)
    if not cloud_id:
        site = await jira.site_for(db, workspace_id)
        if site is None:
            raise HTTPException(status_code=404, detail="This workspace isn't connected to Jira.")
        cloud_id = site["cloud_id"]
    try:
        return {"issue_types": await jira.issue_types(db, user.id, cloud_id, project.strip().upper())}
    except jira.NotConnected as exc:
        raise jira.not_connected(exc)


@router.put("/site", summary="Connect the workspace's Jira site")
@limiter.limit("20/minute")
async def set_site(request: Request, body: SiteIn, db: AsyncIOMotorDatabase = Depends(get_db),
                   user: User = Depends(require_user)):
    _app_only(request)
    return await jira.set_site(db, user, body.workspace_id, body.cloud_id, body.projects, body.default_project,
                               body.default_issue_type)


@router.delete("/site", summary="Disconnect the workspace's Jira site")
@limiter.limit("20/minute")
async def delete_site(request: Request, workspace_id: str = Query(..., pattern=_WS),
                      db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    _app_only(request)
    return await jira.disconnect_site(db, user, workspace_id)


@router.get("/me", summary="My Atlassian connection")
@limiter.limit("120/minute")
async def me(request: Request, db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    _app_only(request)
    return await jira.me_status(db, user)


@router.delete("/me", summary="Disconnect my Atlassian account")
@limiter.limit("20/minute")
async def me_delete(request: Request, db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    _app_only(request)
    await jira.disconnect_me(db, user)
    return await jira.me_status(db, user)


# ── Issues from items ─────────────────────────────────────────────────────────


def _item_kw(body: ItemIn) -> dict:
    if not body.fact_id and not body.slug:
        raise HTTPException(status_code=422, detail="Pass slug (a page) or fact_id (a Team line).")
    return {"slug": body.slug, "block": body.block, "offset": body.offset, "selection": body.selection,
            "fact_id": body.fact_id}


@router.get("/page", summary="Jira chips on a page")
@limiter.limit("240/minute")
async def page(request: Request, slug: str = Query(..., pattern=_SLUG), db: AsyncIOMotorDatabase = Depends(get_db),
               user: User = Depends(require_user)):
    actor, ctx = _ac(request, db, user)
    return await jira_links.page_links(db, actor, ctx, slug)


@router.post("/draft", summary="Draft a Jira issue from an item")
@limiter.limit("30/minute")
async def draft(request: Request, body: ItemIn, db: AsyncIOMotorDatabase = Depends(get_db),
                user: User = Depends(require_user)):
    actor, ctx = _ac(request, db, user)
    return await jira_links.draft(db, actor, ctx, project=body.project, **_item_kw(body))


@router.post("/draft/all", summary="Draft Jira issues for a page's open action items")
@limiter.limit("10/minute")
async def draft_all(request: Request, body: ItemIn, db: AsyncIOMotorDatabase = Depends(get_db),
                    user: User = Depends(require_user)):
    if not body.slug:
        raise HTTPException(status_code=422, detail="Pass the page's slug.")
    actor, ctx = _ac(request, db, user)
    return await jira_links.draft_all(db, actor, ctx, body.slug, project=body.project)


@router.post("/issues", summary="Create a Jira issue from an item")
@limiter.limit("30/minute")
async def create(request: Request, body: CreateIn, db: AsyncIOMotorDatabase = Depends(get_db),
                 user: User = Depends(require_user)):
    actor, ctx = _ac(request, db, user)
    return await jira_links.create(db, actor, ctx, fields=body.fields.model_dump(), **_item_kw(body))


@router.post("/issues/bulk", summary="Create several Jira issues from a page's items")
@limiter.limit("10/minute")
async def create_bulk(request: Request, body: BulkIn, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    actor, ctx = _ac(request, db, user)
    out = []
    for it in body.items:
        try:
            made = await jira_links.create(db, actor, ctx, slug=body.slug, block=it.block, fields=it.fields.model_dump())
            out.append({"block": it.block, "ok": True, **made})
        except HTTPException as exc:
            out.append({"block": it.block, "ok": False, "detail": exc.detail if isinstance(exc.detail, str) else "Not created."})
    return {"results": out, "created": sum(1 for r in out if r["ok"])}


@router.post("/links", summary="Link an existing Jira issue to an item")
@limiter.limit("30/minute")
async def link(request: Request, body: LinkIn, db: AsyncIOMotorDatabase = Depends(get_db),
               user: User = Depends(require_user)):
    actor, ctx = _ac(request, db, user)
    kw = _item_kw(body)
    kw.pop("selection")
    return await jira_links.link_existing(db, actor, ctx, key=body.key, **kw)


@router.delete("/links/{link_id}", summary="Unlink a Jira issue")
@limiter.limit("30/minute")
async def unlink(request: Request, link_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                 user: User = Depends(require_user)):
    actor, ctx = _ac(request, db, user)
    return await jira_links.unlink(db, actor, ctx, link_id)


@router.post("/links/{link_id}/retry", summary="Sync a linked to-do to Jira again")
@limiter.limit("20/minute")
async def retry(request: Request, link_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                user: User = Depends(require_user)):
    actor, ctx = _ac(request, db, user)
    return await jira_links.retry(db, actor, ctx, link_id)


@router.post("/lookup", summary="Live chips for pasted Jira links")
@limiter.limit("120/minute")
async def lookup(request: Request, body: LookupIn, db: AsyncIOMotorDatabase = Depends(get_db),
                 user: User = Depends(require_user)):
    actor, _ctx = _ac(request, db, user)
    return await jira_links.lookup_urls(db, actor, [u[:500] for u in body.urls])


# ── Team ──────────────────────────────────────────────────────────────────────


@router.get("/team/{workspace_id}", summary="Jira on the Team board")
@limiter.limit("60/minute")
async def team(request: Request, workspace_id: str, refresh: bool = False, db: AsyncIOMotorDatabase = Depends(get_db),
               user: User = Depends(require_user)):
    await jira.require_member(db, user, workspace_id)
    actor, _ctx = _ac(request, db, user)
    return await jira_team.board(db, actor, workspace_id, refresh=refresh)


@router.get("/team/{workspace_id}/people/{user_id}", summary="A person's Jira issues")
@limiter.limit("60/minute")
async def team_person(request: Request, workspace_id: str, user_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    await jira.require_member(db, user, workspace_id)
    actor, _ctx = _ac(request, db, user)
    return await jira_team.person(db, actor, workspace_id, user_id)


# ── From Jira ─────────────────────────────────────────────────────────────────


@router.post("/webhook/{workspace_id}", include_in_schema=False)
async def webhook(request: Request, workspace_id: str, db: AsyncIOMotorDatabase = Depends(get_db)):
    if not jira.configured():
        return JSONResponse({"detail": "not set up"}, status_code=503)
    why = jira.verify_webhook(request.headers)
    if why:
        log.info("jira: refused a webhook (%s)", why)
        return JSONResponse({"detail": why}, status_code=401)
    n = int(request.headers.get("content-length") or 0)
    if n > MAX_BODY:
        return JSONResponse({"detail": "too large"}, status_code=413)
    raw = await request.body()
    if len(raw) > MAX_BODY:
        return JSONResponse({"detail": "too large"}, status_code=413)
    try:
        payload = json.loads(raw or b"{}")
    except ValueError:
        return JSONResponse({"detail": "body must be JSON"}, status_code=400)
    if not isinstance(payload, dict) or len(workspace_id) != 24:
        return JSONResponse({"detail": "bad request"}, status_code=400)
    site = await jira.site_for(db, workspace_id)
    ids = (payload.get("matchedWebhookIds") or [])
    mine = ((site or {}).get("webhook") or {}).get("ids") or []
    if site is None or (ids and mine and not set(ids) & set(mine)):
        return {"ok": True, "ignored": True}
    return await jira_links.handle_webhook(db, workspace_id, payload)
