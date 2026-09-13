from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.config import get_settings
from app.database import connect, disconnect
from app.limiter import limiter
from app.middleware.tenant_cors import TenantCORSMiddleware
from app.routers.admin import router as admin_router
from app.routers.artifacts import router as artifacts_router
from app.routers.auth import router as auth_router
from app.routers.documents import router as documents_router
from app.routers.feedback import router as feedback_router
from app.routers.workspaces import router as workspaces_router
from app.routers.domains import router as domains_router
from app.routers.folders import router as folders_router
from app.routers.invites import router as invites_router
from app.routers.google import router as google_router
from app.routers.live import router as live_router
from app.routers.me import router as me_router
from app.routers.og import router as og_router
from app.routers.share import router as share_router
from app.routers.sync import router as sync_router

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await connect()
    yield
    await disconnect()


app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Registered last so it runs FIRST. add_middleware prepends, and CORSMiddleware
# answers any preflight it recognises without calling further in — so a custom
# domain's OPTIONS would be rejected before this ever saw it. Outermost, it
# handles verified hosts itself and passes everything else straight through to
# the static-list behaviour below.
app.add_middleware(TenantCORSMiddleware)

# Rate limiting
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

# Routers
app.include_router(documents_router)
app.include_router(artifacts_router)
app.include_router(share_router)
app.include_router(google_router)
app.include_router(admin_router)
app.include_router(auth_router)
app.include_router(me_router)
app.include_router(sync_router)
app.include_router(og_router)
app.include_router(live_router)
app.include_router(feedback_router)
app.include_router(workspaces_router)
app.include_router(domains_router)
app.include_router(folders_router)
app.include_router(invites_router)


@app.get("/health")
async def health():
    return {"status": "ok"}
