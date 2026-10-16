"""Public email endpoints, linked from campaign emails (served on api.markdrop.in).

    GET  /api/v1/email/o/{token}.gif      open pixel (1×1 GIF, never cached)
    GET  /api/v1/email/c/{token}?u=<url>  click: 302 to an allow-listed URL, else 400
    GET  /api/v1/email/u/{token}          unsubscribe page with a confirm button
    POST /api/v1/email/u/{token}          unsubscribe (the button, and RFC 8058
                                          one-click from List-Unsubscribe-Post)
    POST /api/v1/email/webhooks/resend    Resend events, Svix-signed (503 unless
                                          MARKDROP_RESEND_WEBHOOK_SECRET is set)

Tracking never reveals whether a token exists: every request gets the same
pixel and the same redirect. "preview" / "test" tokens (admin previews and test
sends) work everywhere and are never recorded.

Unsubscribe GET doesn't act on its own: corporate link scanners open every URL
in an email, and an immediate GET would unsubscribe people who never clicked.
The page's button (and mail clients' one-click POST) does it. The older
user-token links (/api/v1/auth/unsubscribe, /api/v1/unsubscribe) still act on
GET, as they always have; they live in routers/auth.py.
"""

from __future__ import annotations

import base64
import html
import json
import logging

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.database import get_database
from app.limiter import limiter
from app.services import mailer
from app.services.email_campaigns import links, store, webhooks

settings = get_settings()
log = logging.getLogger("uvicorn.error").getChild("email")
router = APIRouter(prefix="/api/v1/email", tags=["email"])

PIXEL = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
NO_CACHE = {
    "Cache-Control": "no-store, no-cache, must-revalidate, private, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
}


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _trackable(token: str) -> bool:
    return links.valid_token(token) and not links.is_non_tracking_token(token)


@router.get("/o/{file}")
@limiter.limit("600/minute")
async def open_pixel(file: str, request: Request, db: AsyncIOMotorDatabase = Depends(get_db)):
    token = file[:-4] if file.endswith(".gif") else file
    if _trackable(token):
        try:
            await store.track(db, token, "open", None, request.headers.get("user-agent"))
        except Exception:  # the image must load whatever happens
            log.exception("[email] open not recorded")
    return Response(PIXEL, media_type="image/gif", headers=NO_CACHE)


def _page(title: str, heading: str, body_html: str, *, status: int = 200, form: str = "") -> HTMLResponse:
    content = (
        mailer._eyebrow("Email preferences")
        + mailer._heading(heading)
        + body_html
        + form
        + mailer._p(mailer._link(links.site_base(), "Go to Markdrop"), margin="0 0 20px")
    )
    footer = f"Markdrop &middot; {mailer._footer_link(links.site_base(), 'markdrop.in')}"
    return HTMLResponse(
        mailer._shell(title=html.escape(title), content=content, footer=footer, page=True),
        status_code=status, headers=NO_CACHE,
    )


@router.get("/c/{token}")
@limiter.limit("240/minute")
async def click(token: str, request: Request, u: str = "", db: AsyncIOMotorDatabase = Depends(get_db)):
    target = links.allowed_url(u) if u else None
    if not target:
        return _page(
            "This link can't be opened", "This link can't be opened",
            mailer._p("It doesn't point anywhere Markdrop sends people, so we stopped here rather than redirect you somewhere unknown."),
            status=400,
        )
    if _trackable(token):
        try:
            await store.track(db, token, "click", target, request.headers.get("user-agent"))
        except Exception:
            log.exception("[email] click not recorded")
    return RedirectResponse(target, status_code=302, headers=NO_CACHE)


_BUTTON = (
    '<form method="post" style="margin:4px 0 24px">'
    '<button type="submit" style="display:inline-block;padding:12px 24px;font-family:{sans};font-size:14px;'
    'line-height:20px;font-weight:600;color:#ffffff;background-color:{accent};border:0;border-radius:8px;'
    'cursor:pointer">Unsubscribe</button></form>'
)


@router.get("/u/{token}")
@limiter.limit("60/minute")
async def unsubscribe_page(token: str, request: Request, db: AsyncIOMotorDatabase = Depends(get_db)):
    form = _BUTTON.format(sans=mailer._SANS, accent=mailer._ACCENT)
    if links.valid_token(token) and links.is_non_tracking_token(token):
        return _page("Unsubscribe", "Unsubscribe from Markdrop emails?",
                     mailer._p("This link came from a test or preview email, so pressing the button changes nothing."), form=form)
    m = await db["email_messages"].find_one({"token": token}, {"email": 1, "unsubscribed_at": 1}) if _trackable(token) else None
    if not m:
        return HTMLResponse(mailer.unsubscribe_page_html(False), status_code=400, headers=NO_CACHE)
    if m.get("unsubscribed_at"):
        return HTMLResponse(mailer.unsubscribe_page_html(True), headers=NO_CACHE)
    who = html.escape(m.get("email") or "this address")
    return _page(
        "Unsubscribe from Markdrop emails", "Unsubscribe from Markdrop emails?",
        mailer._p(f"{mailer._strong(who)} will stop getting product updates from Markdrop. Sign-in codes and invitations still arrive, because you ask for those."),
        form=form,
    )


@router.post("/u/{token}")
@limiter.limit("60/minute")
async def unsubscribe(token: str, request: Request, db: AsyncIOMotorDatabase = Depends(get_db)):
    """The page's button and RFC 8058 one-click (body ``List-Unsubscribe=One-Click``)."""
    if links.valid_token(token) and links.is_non_tracking_token(token):
        return _page("Test email", "Nothing changed",
                     mailer._p("That was a test or preview email, so nobody was unsubscribed."))
    m = None
    if _trackable(token):
        try:
            m = await store.unsubscribe_message(db, token, request.headers.get("user-agent"))
        except Exception:
            log.exception("[email] unsubscribe failed")
            return HTMLResponse("error", status_code=500, headers=NO_CACHE)
    if not m:
        return HTMLResponse(mailer.unsubscribe_page_html(False), status_code=400, headers=NO_CACHE)
    try:
        from app.services.email_campaigns import audience
        audience.invalidate()
    except Exception:
        pass
    return HTMLResponse(mailer.unsubscribe_page_html(True), headers=NO_CACHE)


@router.post("/webhooks/resend")
@limiter.limit("600/minute")
async def resend_webhook(request: Request, db: AsyncIOMotorDatabase = Depends(get_db)):
    secret = settings.resend_webhook_secret
    if not secret:
        return JSONResponse({"detail": "Webhooks aren't configured on this server."}, status_code=503)
    body = await request.body()
    headers = {k.lower(): v for k, v in request.headers.items()}
    try:
        webhooks.verify(secret, headers, body)
    except webhooks.SignatureError as e:
        return JSONResponse({"detail": f"Invalid signature: {e}"}, status_code=401)
    try:
        event = json.loads(body)
    except ValueError:
        return JSONResponse({"detail": "Body isn't JSON."}, status_code=400)
    res = await webhooks.handle(db, headers.get("svix-id") or headers.get("webhook-id") or "", event)
    if res.get("suppressed"):
        from app.services.email_campaigns import audience
        audience.invalidate()
    return JSONResponse(res)
