import time
import tracemalloc
from contextlib import asynccontextmanager

from app.config import get_settings

# MARKDROP_TRACEMALLOC=1: trace allocations from before the app's own modules load, so
# /api/v1/admin/health/memory's top 20 covers everything the process holds (services/memory_health.py).
if get_settings().tracemalloc and not tracemalloc.is_tracing():
    tracemalloc.start(10)

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.database import connect, disconnect
from app.limiter import limiter
from app.middleware.docs_cors import DocsCORSMiddleware
from app.middleware.errors import ServerErrorJSONMiddleware
from app.middleware.internal import InternalRequestMiddleware
from app.middleware.public_cors import PublicCORSMiddleware
from app.middleware.security_headers import SecurityHeadersMiddleware
from app.middleware.tenant_cors import TenantCORSMiddleware
from app.routers.admin import router as admin_router
from app.routers.trash import router as trash_router
from app.routers.admin_ai import router as admin_ai_router
from app.routers.admin_ai_log import router as admin_ai_log_router
from app.routers.admin_ai_workspaces import router as admin_ai_workspaces_router
from app.routers.admin_analytics import router as admin_analytics_router
from app.routers.admin_email import router as admin_email_router
from app.routers.admin_journeys import router as admin_journeys_router
from app.routers.admin_roles import router as admin_roles_router
from app.routers.admin_health import router as admin_health_router
from app.routers.beat import router as beat_router
from app.routers.artifacts import router as artifacts_router
from app.routers.auth import router as auth_router
from app.routers.auth import unsubscribe_alias_router
from app.routers.docs_access import router as docs_access_router
from app.routers.docs_page_access import router as docs_page_access_router
from app.routers.docs_page_access import studio as docs_page_access_studio_router
from app.routers.docs_ai import router as docs_ai_router
from app.routers.docs_github import router as docs_github_router
from app.routers.docs_jobs_internal import router as docs_jobs_internal_router
from app.routers.docs_sites import router as docs_sites_router
from app.routers.docs_embeds import public_router as docs_embeds_public_router
from app.routers.guide_insights import app_router as guide_insights_app_router
from app.routers.guide_insights import router as guide_insights_router
from app.routers.docs_studio import router as docs_studio_router
from app.routers.documents import router as documents_router
from app.routers.comments import router as comments_router
from app.routers.comments_review import router as comments_review_router
from app.routers.comments_insights import router as comments_insights_router
from app.routers.feedback import router as feedback_router
from app.routers.files import router as files_router
from app.routers.workspaces import router as workspaces_router
from app.routers.domains import router as domains_router
from app.routers.email_public import router as email_public_router
from app.routers.folders import router as folders_router
from app.routers.folder_pages import router as folder_pages_router
from app.routers.page_db import router as page_db_router
from app.routers.workspace_items import router as workspace_items_router
from app.routers.invites import router as invites_router
from app.routers.library import router as library_router
from app.routers.access import router as access_router
from app.routers.google import router as google_router
from app.routers.live import router as live_router
from app.routers.mcp import router as mcp_router
from app.routers.me import router as me_router
from app.routers.creator_analytics import router as creator_analytics_router
from app.routers.analytics_settings import router as analytics_settings_router
from app.routers.analytics_ai_home import router as analytics_ai_home_router
from app.routers.analytics_ai_doc import router as analytics_ai_doc_router
from app.routers.notifications import router as notifications_router
from app.routers.push import router as push_router
from app.routers.oauth import router as oauth_router
from app.routers.personal import router as personal_router
from app.routers.search import router as search_router
from app.routers.meetings import router as meetings_router
from app.routers.meetings_backfill import router as meetings_backfill_router
from app.routers.meeting_memory import router as meeting_memory_router
from app.routers.team import router as team_router
from app.routers.teams import meetings_router as teams_meetings_router
from app.routers.teams import router as teams_router
from app.routers.slack import router as slack_router
from app.routers.jira import router as jira_router
from app.routers.jira_pages import router as jira_pages_router
from app.routers.zoom import router as zoom_router
from app.routers.ask import router as ask_router
from app.routers.home import router as home_router
from app.routers.og import router as og_router
from app.routers.share import router as share_router
from app.routers.sync import router as sync_router
from app.routers.pages import router as pages_router
from app.routers.pages_ai import guides_router as pages_ai_guides_router
from app.routers.pages_ai import router as pages_ai_router
from app.routers.page_history import router as page_history_router
from app.routers.signoffs import router as signoffs_router
from app.routers.page_export import router as page_export_router
from app.routers.bookmarks import router as bookmarks_router
from app.routers.bookmarks import web_router as web_embeds_router
from app.routers.bookmarks import alias_router as link_preview_router
from app.services.pages import PageError

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Event-loop lag and who caused it (services/loop_monitor.py): GET /health/loop on the box.
    from app.services import loop_monitor

    loop_monitor.start()
    await connect()
    from app import worker
    from app.database import get_database
    from app.services import live, memory_health

    # The background loops (app/worker.py): here unless MARKDROP_ROLE=web, where the
    # markdrop-worker service runs them.
    loops = worker.runs_loops()
    if loops:
        await worker.start_loops()
    # Every process watches its own memory (logs, samples, the owners' alert).
    memory_health.start(get_database)
    # Several processes (web + worker): document changes reach every process's sockets.
    live.start_bus()
    # Comments' plugin handlers (Track B / C modules register on import; services/comments/events.py).
    from app.services.comments import events as _comment_events

    _comment_events.load_plugins()
    # Everything loaded at startup lives as long as the process: move it out of the collector's
    # reach, so a full collection doesn't walk it on every request that allocates a lot (global
    # search builds thousands of candidates per keystroke; a gen-2 pass over the startup heap
    # was its p95, 2026-11-04).
    import gc

    gc.collect()
    gc.freeze()
    yield
    await live.stop_bus()
    await memory_health.stop()
    if loops:
        await worker.stop_loops()
    await disconnect()
    await loop_monitor.stop()


app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    lifespan=lifespan,
)

# Added first, so it sits innermost: an exception no handler caught becomes a JSON
# 500 here, inside every CORS layer below, so the browser can read it (Starlette's
# own 500 is written outside them and reads as a network error in the app).
app.add_middleware(ServerErrorJSONMiddleware)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # `allow_headers` governs what the browser may *send*; a response header is
    # invisible to JavaScript unless it is named here. Without this the gate
    # header arrives and is silently unreadable, and the page falls back to
    # guessing which kind of 401 it got — which is the bug it exists to fix.
    expose_headers=["X-Markdrop-Gate", "X-Markdrop-Moved", "Retry-After"],
    # Starlette defaults to 600s. Every cross-origin API call the app makes is
    # preceded by a preflight, so a short cache doubles the request count the
    # rate limiter sees for an authenticated page. 7200 is Chrome's ceiling --
    # asking for more is silently clamped, not honoured.
    max_age=7200,
)

# Registered last so it runs FIRST. add_middleware prepends, and CORSMiddleware
# answers any preflight it recognises without calling further in — so a custom
# domain's OPTIONS would be rejected before this ever saw it. Outermost, it
# handles verified hosts itself and passes everything else straight through to
# the static-list behaviour below.
app.add_middleware(TenantCORSMiddleware)

# The MCP endpoint and the public OAuth endpoints answer any origin, without
# credentials (middleware/public_cors.py). Outside both CORS layers above so it
# sees their preflights first; every other path passes through untouched.
app.add_middleware(PublicCORSMiddleware)

# The docs site (docs.markdrop.in) calling /api/v1/docs/*, and the public API for
# Try it, without credentials (middleware/docs_cors.py). Outermost, so it answers
# a docs-origin preflight before CORSMiddleware refuses it; internal routes and
# every other origin pass through untouched. Pure ASGI, so Ask AI's event stream
# isn't buffered.
app.add_middleware(DocsCORSMiddleware)

# Rate limiting
app.state.limiter = limiter
def _rate_limited(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    """429 with Retry-After (seconds until the window resets), so clients can show a live countdown
    instead of guessing. slowapi's own handler only sets it when headers are enabled globally, which
    would require a `response` parameter on every limited route."""
    retry_after = 60
    try:
        limit = getattr(request.state, "view_rate_limit", None)
        if limit is not None:
            reset_at, _remaining = request.app.state.limiter.limiter.get_window_stats(limit[0], *limit[1])
            retry_after = max(1, int(1 + reset_at - time.time()))
    except Exception:
        pass
    return JSONResponse({"error": f"Rate limit exceeded: {exc.detail}"}, status_code=429, headers={"Retry-After": str(retry_after)})


app.add_exception_handler(RateLimitExceeded, _rate_limited)


def _page_error(request: Request, exc: PageError) -> JSONResponse:
    """Pages (services/pages.py): errors that carry more than a message — the
    lock holder (423), the readers before and after a move or the number of
    sub-pages (409). The body is ``{detail, code, …}``."""
    return JSONResponse(jsonable_encoder(exc.body), status_code=exc.status_code, headers=exc.headers)


app.add_exception_handler(PageError, _page_error)


def _small(value):
    """A validation error's `input`, unless it is big: FastAPI echoes it back, so an oversized
    field (a 12 MB HTML file) would otherwise come straight back down the wire."""
    if isinstance(value, (str, bytes)) and len(value) > 300:
        return f"<{len(value):,} characters omitted>"
    if isinstance(value, (dict, list)) and len(repr(value)) > 2000:
        return "<omitted>"
    return value


async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    errors = [{**e, "input": _small(e.get("input"))} if "input" in e else e for e in exc.errors()]
    return JSONResponse({"detail": jsonable_encoder(errors)}, status_code=422)


app.add_exception_handler(RequestValidationError, _validation_error)
app.add_middleware(SlowAPIMiddleware)
# Outside SlowAPIMiddleware (added after it, so it runs first): a request signed
# by the frontend's own server is exempt from per-IP limits (middleware/internal.py).
app.add_middleware(InternalRequestMiddleware)
# Who is asking (a test harness's X-Markdrop-Test header, the address, the User-Agent, an API
# token), for the AI request log's actor and test tagging (services/ai_log.py). Pure ASGI.
from app.services.ai_log import RequestContextMiddleware  # noqa: E402

app.add_middleware(RequestContextMiddleware)
# Read requests remember who the caller is, a workspace and a role for their own length
# (services/request_memo.py): one dashboard call asked the database the same thing several times.
from app.services.request_memo import RequestMemoMiddleware  # noqa: E402

app.add_middleware(RequestMemoMiddleware)
# Outermost: HSTS and nosniff on every response, CORS preflights and 429s included
# (middleware/security_headers.py).
app.add_middleware(SecurityHeadersMiddleware)

# Routers
app.include_router(trash_router)  # before documents: /documents/{slug}/delete-preview
app.include_router(documents_router)
app.include_router(pages_router)
# Page AI (routers/pages_ai.py), and its Guides page editor endpoints.
app.include_router(pages_ai_router)
app.include_router(pages_ai_guides_router)
app.include_router(page_history_router)
app.include_router(signoffs_router)
# Comments: insights (C) first — its literal /comments/insights and /comments/export would otherwise reach
# core's GET /comments/{thread_id}, whose 24-hex pattern is checked after matching (a 422, not a fall-through) —
# then core and review (B).
app.include_router(comments_insights_router)
app.include_router(comments_router)
app.include_router(comments_review_router)
app.include_router(page_export_router)
app.include_router(bookmarks_router)
app.include_router(web_embeds_router)
app.include_router(link_preview_router)
app.include_router(artifacts_router)
app.include_router(files_router)
app.include_router(share_router)
app.include_router(google_router)
# Admin, tracking and email-link routes are internal: kept out of the public OpenAPI schema
# (it is linked from the docs as the API reference).
app.include_router(admin_router, include_in_schema=False)
app.include_router(admin_analytics_router, include_in_schema=False)
app.include_router(admin_ai_router, include_in_schema=False)
app.include_router(admin_ai_log_router, include_in_schema=False)
app.include_router(admin_ai_workspaces_router, include_in_schema=False)
app.include_router(admin_journeys_router, include_in_schema=False)
app.include_router(admin_email_router, include_in_schema=False)
app.include_router(admin_roles_router, include_in_schema=False)
app.include_router(admin_health_router, include_in_schema=False)
app.include_router(email_public_router, include_in_schema=False)
app.include_router(beat_router, include_in_schema=False)
app.include_router(auth_router)
# Old campaign unsubscribe links (/api/v1/unsubscribe); see routers/auth.py.
app.include_router(unsubscribe_alias_router, include_in_schema=False)
app.include_router(me_router)
app.include_router(creator_analytics_router)
app.include_router(analytics_settings_router)
app.include_router(analytics_ai_home_router)
app.include_router(analytics_ai_doc_router)
app.include_router(notifications_router)
app.include_router(push_router)
app.include_router(sync_router)
app.include_router(og_router)
app.include_router(live_router)
app.include_router(feedback_router)
app.include_router(docs_ai_router)
app.include_router(guide_insights_router, include_in_schema=False)
# Markdrop files embedded in docs pages: resolve + beacons (public, CORS *; routers/docs_embeds.py).
app.include_router(docs_embeds_public_router, include_in_schema=False)
# Hosted docs sites (dashboard/editor API; app-internal, see routers/docs_sites.py).
app.include_router(docs_sites_router, include_in_schema=False)
app.include_router(guide_insights_app_router, include_in_schema=False)
app.include_router(docs_studio_router, include_in_schema=False)
# Markdrop Guides ↔ GitHub: connect the app, pick a repository, the webhook (routers/docs_github.py).
app.include_router(docs_github_router, include_in_schema=False)
# Docs job runners (GitHub Actions) call back here with a per-job token.
app.include_router(docs_jobs_internal_router, include_in_schema=False)
# Signing in to password and members-only docs sites (the docs edge's sign-in page, /auth/docs-access).
app.include_router(docs_access_router, include_in_schema=False)
app.include_router(docs_page_access_router, include_in_schema=False)
app.include_router(docs_page_access_studio_router, include_in_schema=False)
app.include_router(workspaces_router)
app.include_router(domains_router)
app.include_router(folders_router)
app.include_router(workspace_items_router)
app.include_router(folder_pages_router)
app.include_router(page_db_router)
app.include_router(invites_router)
app.include_router(library_router)
app.include_router(access_router)
app.include_router(personal_router)
app.include_router(search_router)
# Meetings (routers/meetings.py): imported calls as pages, Ask this meeting / across meetings.
# Import past meetings (routers/meetings_backfill.py): before meetings_router, whose /{meeting_id}
# would take /backfill and /series.
app.include_router(meetings_backfill_router)
app.include_router(meetings_router)
# Meeting memory (routers/meeting_memory.py): meetings' decisions next to the page being written.
app.include_router(meeting_memory_router)
# Team (routers/team.py): who is doing what in a workspace, from its meetings and pages.
app.include_router(team_router)
# Teams inside a workspace (routers/teams.py): spaces, briefs, routing, projects.
app.include_router(teams_router)
app.include_router(teams_meetings_router)
app.include_router(slack_router)
# Jira Cloud (routers/jira.py): issues from meetings, Team and pages; both-way status sync.
app.include_router(jira_router)
# Jira inside pages (routers/jira_pages.py): chips, cards, live lists, actions, discussions → issues.
app.include_router(jira_pages_router)
# Zoom (routers/zoom.py): a workspace's recorded Zoom meetings → Meetings, in one team.
app.include_router(zoom_router)
# Ask Markdrop (routers/ask.py): the home's question box, threads, suggestions.
app.include_router(ask_router)
app.include_router(home_router)
app.include_router(oauth_router)
app.include_router(mcp_router)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/health/loop", include_in_schema=False)
async def health_loop(request: Request, reset: bool = False):
    """Event-loop lag since the last reset, and the stacks that blocked it (services/loop_monitor.py).
    Only on the box itself: a direct loopback request, never one nginx forwarded."""
    from app.services import loop_monitor

    host = request.client.host if request.client else ""
    if host not in ("127.0.0.1", "::1") or request.headers.get("x-forwarded-for") or request.headers.get("x-real-ip"):
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    return loop_monitor.snapshot(reset=reset)
