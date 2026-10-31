"""Insights for Markdrop Guides (services/guide_insights.py): the beacons a published guide sends,
and the guide's Insights tab.

Collection, under /api/v1/docs/insights/{site_id} (CORS: the guide's own live addresses only,
middleware/docs_cors.py):

    POST …/hit        a page view, from the docs edge Worker (server side; `Authorization: Bearer
                      <edge key>`, the reader's address in X-Docs-Reader-Ip, never stored)
    POST …/event      {k: "view", p} (a client-side navigation) or {k: "search", q, n, p}, from
                      the guide's pages (Origin must be the guide's own address); sent as
                      text/plain so the browser needs no preflight
    POST …/feedback   {path, helpful, comment?}: "Did this page help?" (Origin: the guide's own
                      address) and the docs MCP server's report_problem (server side, no Origin)

Each answers 202 {"status": "ok" | "ignored" | "off"}: a beacon never learns more than that.
A guide that isn't live (or doesn't exist) is a 404; Insights turned off drops everything.

The tab, under /api/v1/docs-sites/{site_id} (signed in; a Guides role on the site):

    GET    …/insights?range=7d|30d|90d&feedback=open|resolved|all     viewers and up
    PATCH  …/insights/feedback/{id}  {resolved}                       editors and up
    DELETE …/insights                                                 admins: clear the data

Turning collection off is a settings change (PATCH /docs-sites/{id} settings.insights.enabled),
which only admins may make.
"""

# No `from __future__ import annotations`: slowapi wraps these routes (see routers/docs_ai.py).
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field, ValidationError

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.services import docs_site_store as store
from app.services import docs_sites
from app.services import guide_insights as insights
from app.utils.net import get_client_ip

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/docs/insights", tags=["docs"])
app_router = APIRouter(prefix="/api/v1/docs-sites", tags=["docs-sites"])

MAX_BODY = 4096
READER_IP = "x-docs-reader-ip"


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _reader_key(request: Request) -> str:
    """Rate-limit key: the reader behind the edge (its own header, trusted only with the edge's
    key), else the caller's address."""
    if insights.edge_authorized(request.headers.get("authorization")):
        ip = (request.headers.get(READER_IP) or "").strip()[:64]
        if ip:
            return f"reader:{ip}"
    return get_client_ip(request)


def _accepted(status: str) -> JSONResponse:
    return JSONResponse({"status": status}, status_code=202)


async def _site(db: AsyncIOMotorDatabase, site_id: str) -> "docs_sites.StudioSite":
    st = await docs_sites.studio_site(db, site_id)
    if st is None:
        raise HTTPException(status_code=404, detail="Unknown guide")
    return st


async def _json(request: Request) -> dict:
    raw = await request.body()
    if len(raw) > MAX_BODY:
        raise HTTPException(status_code=413, detail="Too large")
    try:
        body = json.loads(raw or b"null")
    except ValueError:
        raise HTTPException(status_code=422, detail="Send a JSON object") from None
    if not isinstance(body, dict):
        raise HTTPException(status_code=422, detail="Send a JSON object")
    return body


def _model(cls, body: dict):
    try:
        return cls.model_validate(body)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=json.loads(exc.json(include_input=False))) from None


def _out(request: Request) -> bool:
    return insights.opted_out(request.headers.get("dnt"), request.headers.get("sec-gpc"))


async def _browser_origin(db: AsyncIOMotorDatabase, request: Request, site_id: str, *, required: bool) -> None:
    origin = request.headers.get("origin")
    if not origin:
        if required:
            raise HTTPException(status_code=403, detail="Send this from the guide's own pages")
        return
    if not await insights.origin_allowed(db, site_id, origin):
        raise HTTPException(status_code=403, detail="Not this guide's address")


# ── Collection ────────────────────────────────────────────────────────────────


class HitBody(BaseModel):
    path: str = Field(..., max_length=400)
    host: str | None = Field(None, max_length=255)
    ref: str | None = Field(None, max_length=1000)
    ua: str | None = Field(None, max_length=512)
    country: str | None = Field(None, max_length=8)
    dnt: bool = False


@router.post("/{site_id}/hit")
@limiter.limit("120/minute", key_func=_reader_key)
async def hit(request: Request, site_id: str, db: AsyncIOMotorDatabase = Depends(get_db)):
    """A page view the docs edge served (server side: no script, nothing to block)."""
    if not insights.edge_authorized(request.headers.get("authorization")):
        raise HTTPException(status_code=401, detail="Edge key required")
    body = _model(HitBody, await _json(request))
    st = await _site(db, site_id)
    if not st.insights:
        return _accepted("off")
    path = insights.clean_path(body.path)
    if path is None or insights.is_bot(body.ua):
        return _accepted("ignored")
    ip = (request.headers.get(READER_IP) or "").strip()[:64] or None
    ok = await insights.record_view(db, st.id, path=path, ref=body.ref, own_hosts=st.hosts, ua=body.ua, ip=ip,
                                    country=body.country, out=body.dnt, soft=False)
    return _accepted("ok" if ok else "ignored")


class EventBody(BaseModel):
    k: str = Field(..., pattern=r"^(view|search)$")
    p: str | None = Field(None, max_length=400)
    q: str | None = Field(None, max_length=500)
    n: int | None = Field(None, ge=0, le=100_000)


@router.post("/{site_id}/event")
@limiter.limit("60/minute")
async def event(request: Request, site_id: str, db: AsyncIOMotorDatabase = Depends(get_db)):
    """A client-side navigation or a settled search, from the guide's own pages."""
    body = _model(EventBody, await _json(request))
    st = await _site(db, site_id)
    await _browser_origin(db, request, site_id, required=True)
    if not st.insights:
        return _accepted("off")
    ua = request.headers.get("user-agent") or ""
    if insights.is_bot(ua):
        return _accepted("ignored")
    ip = get_client_ip(request)
    path = insights.clean_path(body.p) if body.p else None
    if body.k == "view":
        if path is None:
            return _accepted("ignored")
        from app.services import geo

        ok = await insights.record_view(db, st.id, path=path, ref=None, own_hosts=st.hosts, ua=ua, ip=ip,
                                        country=geo.lookup(ip).get("country"), out=_out(request), soft=True)
        return _accepted("ok" if ok else "ignored")
    q = insights.normalize_query(body.q)
    if q is None or body.n is None:
        return _accepted("ignored")
    ok = await insights.record_search(db, st.id, query=q, results=body.n, path=path, ua=ua, ip=ip, out=_out(request))
    return _accepted("ok" if ok else "ignored")


class FeedbackBody(BaseModel):
    path: str = Field(..., max_length=400)
    helpful: bool
    comment: str | None = Field(None, max_length=4000)


@router.post("/{site_id}/feedback")
@limiter.limit("10/minute")
async def feedback(request: Request, site_id: str, db: AsyncIOMotorDatabase = Depends(get_db)):
    """"Did this page help?" from the guide's pages, or report_problem from its docs MCP server."""
    body = _model(FeedbackBody, await _json(request))
    st = await _site(db, site_id)
    await _browser_origin(db, request, site_id, required=False)
    if not st.insights:
        return _accepted("off")
    path = insights.clean_path(body.path)
    if path is None:
        return _accepted("ignored")
    status = await insights.record_feedback(db, st.id, path=path, helpful=body.helpful, comment=body.comment)
    return _accepted("ok" if status == "received" else "ignored")


# ── The Insights tab ──────────────────────────────────────────────────────────


@app_router.get("/{site_id}/insights")
@limiter.limit("60/minute")
async def get_insights(request: Request, site_id: str,
                       range: str = Query("30d", pattern="^(7d|30d|90d)$"),
                       feedback: str = Query("open", pattern="^(open|resolved|all)$"),
                       db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, role = await store.load_site(db, site_id, user)
    out = await insights.overview(db, site, range, status=feedback)
    out["can_manage"] = store.role_at_least(role, "admin")
    out["can_resolve"] = store.role_at_least(role, "editor")
    return out


class ResolveBody(BaseModel):
    resolved: bool


@app_router.patch("/{site_id}/insights/feedback/{feedback_id}")
@limiter.limit("120/minute")
async def resolve_feedback(request: Request, site_id: str, feedback_id: str, body: ResolveBody,
                           db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user, "editor")
    row = await insights.set_resolved(db, str(site["_id"]), feedback_id, body.resolved, user.id)
    if row is None:
        raise HTTPException(status_code=404, detail="Feedback not found")
    return row


@app_router.delete("/{site_id}/insights")
@limiter.limit("5/minute")
async def clear_insights(request: Request, site_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                         user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user, "admin")
    return {"cleared": await insights.clear(db, str(site["_id"]))}
