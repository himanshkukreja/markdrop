"""Signing in to a password or members-only docs site: /api/v1/docs-access.

The docs edge serves a non-public site only to a browser holding its session
cookie, which it sets from a short grant minted here (services/docs_site_access.py
has the whole flow and the token format).

- ``POST /password?site=<id>``: the edge's sign-in page posts the password here
  (an HTML form, so the password never passes through the edge). Answers with a
  303: to ``https://<host>/_access/callback#g=<grant>…`` when it is right, else
  back to the sign-in page with a reason. Rate limited per IP and site, per IP,
  and by wrong passwords per site from every IP together.
- ``POST /grant`` (signed in): markdrop.in's /auth/docs-access page asks for a
  members-only site; the reader's Docs Studio role on the site must be viewer or
  more.
- ``POST /{site_id}/sign-out-everyone`` (site admin): every reader's edge session
  ends (the policy version moves on), e.g. after someone left the team.

App-internal: kept out of the public OpenAPI schema.
"""

import html
import logging

import bcrypt
from fastapi import APIRouter, Depends, Form, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, RedirectResponse
from limits import parse
from limits.storage import MemoryStorage
from limits.strategies import MovingWindowRateLimiter
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.services import docs_site_access as access
from app.services import docs_site_store as store
from app.services.docs_site_store import SITES
from app.utils.net import get_client_ip

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/docs-access", tags=["docs-access"])

# Password attempts: per reader and site, and per reader across sites (bcrypt costs CPU too).
PER_SITE = parse("10/15 minutes")
PER_IP = parse("50/hour")
# Wrong passwords for one site from every address together (a guesser spread over many
# addresses): past this the site takes no password until the oldest failure is an hour old
# (a moving window, so a guesser who keeps trying stays shut out). Readers already signed in
# keep reading; the sign-in page says to wait.
SITE_FAILURES = parse("100/hour")
_fallback = MovingWindowRateLimiter(MemoryStorage())
_NO_STORE = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"}


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _hit(item, *keys: str) -> bool:
    """One attempt against ``item`` (Redis, shared by every API worker); per-process memory when
    Redis is unreachable. False = over the limit."""
    try:
        return limiter.limiter.hit(item, "docs-access", *keys)
    except Exception:
        return _fallback.hit(item, "docs-access", *keys)


def _room(item, *keys: str) -> bool:
    """Whether ``item`` has room for one more (without counting one)."""
    try:
        return limiter.limiter.test(item, "docs-access", *keys)
    except Exception:
        return _fallback.test(item, "docs-access", *keys)


def _page(status: int, title: str, text: str) -> HTMLResponse:
    body = (f"<!doctype html><meta charset=utf-8><meta name=robots content=noindex>"
            f"<meta name=viewport content='width=device-width,initial-scale=1'><title>{html.escape(title)}</title>"
            f"<body style='font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px'>"
            f"<h1 style='font-size:1.25rem'>{html.escape(title)}</h1><p>{html.escape(text)}</p>")
    return HTMLResponse(body, status_code=status, headers=_NO_STORE)


def _redirect(url: str) -> RedirectResponse:
    return RedirectResponse(url, status_code=303, headers=_NO_STORE)


async def _site(db: AsyncIOMotorDatabase, site_id: str) -> dict | None:
    try:
        sid = store.oid(site_id)
    except HTTPException:
        return None
    return await db[SITES].find_one({"_id": sid, "deleted_at": None})


@router.post("/password", include_in_schema=False)
async def password(request: Request, site: str = Query(..., max_length=64), host: str = Form("", max_length=300),
                   next: str = Form("/", max_length=2000), sh: str = Form("", max_length=100),
                   password: str = Form("", max_length=1000), db: AsyncIOMotorDatabase = Depends(get_db)):
    row = await _site(db, site)
    h = access.clean_host(host)
    if row is None or h is None:
        return _page(404, "Site not found", "This sign-in form doesn't lead to a docs site. Open the site again.")
    if h not in access.site_hosts(row):
        return _page(400, "Wrong address", "This sign-in form doesn't belong to that site. Open the site again.")
    nxt = access.safe_next(next)
    ip = get_client_ip(request)
    sid = str(row["_id"])
    if not _room(SITE_FAILURES, "failures", sid):
        return _redirect(access.gate_url(h, "rate", nxt))
    if not _hit(PER_SITE, ip, sid) or not _hit(PER_IP, ip):
        return _redirect(access.gate_url(h, "rate", nxt))
    if not access.secret():
        return _redirect(access.gate_url(h, "unavailable", nxt))
    if row.get("status") != "live" or access.level_of(row) != "password":
        return _redirect(access.gate_url(h, "changed", nxt))
    if not access.valid_state_hash(sh):
        return _redirect(access.gate_url(h, "cookies", nxt))
    pw_hash = ((row.get("settings") or {}).get("access") or {}).get("password_hash") or ""
    ok = False
    if password and len(password) <= 200 and pw_hash:
        try:
            ok = await run_in_threadpool(bcrypt.checkpw, password.encode(), pw_hash.encode())
        except ValueError:
            ok = False
    if not ok:
        _hit(SITE_FAILURES, "failures", sid)
        return _redirect(access.gate_url(h, "wrong", nxt))
    await store.log_event(db, "docs_access_granted", row, None, via="password")
    return _redirect(access.callback_url(h, access.mint_grant(row, h, sh), nxt))


class GrantRequest(BaseModel):
    site_id: str = Field(..., max_length=64)
    host: str = Field(..., max_length=300)
    next: str = Field("/", max_length=2000)
    sh: str = Field(..., max_length=100)


@router.post("/grant", include_in_schema=False)
@limiter.limit("30/minute")
async def grant(request: Request, body: GrantRequest, db: AsyncIOMotorDatabase = Depends(get_db),
                user: User = Depends(require_user)):
    row = await _site(db, body.site_id)
    h = access.clean_host(body.host)
    if row is None or h is None:
        raise HTTPException(status_code=404, detail="Docs site not found")
    if h not in access.site_hosts(row):
        raise HTTPException(status_code=400, detail="That address isn't this site's.")
    name = row.get("name") or "this site"
    if row.get("status") != "live" or access.level_of(row) != "members":
        raise HTTPException(status_code=409, detail="This site doesn't use Markdrop sign-in any more. Open it again.")
    if not access.valid_state_hash(body.sh):
        raise HTTPException(status_code=400, detail="Open the site again and choose Sign in.")
    if not access.secret():
        raise HTTPException(status_code=503, detail="Signing in to docs sites isn't available right now.")
    role = await store.site_role(db, row, user.id)
    if not store.role_at_least(role, "viewer"):
        raise HTTPException(status_code=403, detail={"message": f"You don't have access to {name}.", "site_name": name})
    await store.log_event(db, "docs_access_granted", row, user.id, via="members")
    return {"url": access.callback_url(h, access.mint_grant(row, h, body.sh), body.next), "site_name": name}


@router.post("/{site_id}/sign-out-everyone", include_in_schema=False)
@limiter.limit("10/minute")
async def sign_out_everyone(request: Request, site_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                            user: User = Depends(require_user)):
    """A site admin ends every reader's session (someone left the team, a password leaked): the
    policy version moves on, so every edge cookie signed for the old one stops working."""
    site, _role = await store.load_site(db, site_id, user, need="admin")
    if access.is_public(site):
        raise HTTPException(status_code=409, detail="This site is public: nobody signs in to read it.")
    row = await db[SITES].find_one_and_update({"_id": site["_id"]}, {"$inc": {"access_version": 1}},
                                              {"access_version": 1}, return_document=True)
    await access.queue_sync(db, site["_id"], "sign-out-everyone")
    await store.log_event(db, "docs_access_signed_out", site, user.id)
    return {"policy_version": access.version_of(row or {})}
