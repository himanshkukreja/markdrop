"""Creator analytics read API (build spec §3), under ``/api/v1/me``.

Per-document endpoints are the owner's only: ``access.require(..., "view_stats")``
(anonymous 401, a reader who isn't the owner 403, anyone else the read denial,
404). The home and live boards cover the caller's own documents
(``owner_id == user.id``). Computation lives in services/creator_analytics.py.

Also the weekly digest's preference (``PATCH /preferences``) and its signed
turn-off link (``GET``/``POST /digest/off?t=``), services/analytics_digest.py.

Common query parameters: ``range=7d|30d|90d|all`` (default 30d) and
``internal=0|1`` (default 0: workspace members' views and sessions hidden).
"""

from __future__ import annotations

import html

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, Response
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import is_tenant_request, require_user
from app.schemas.auth import PreferencesUpdate
from app.services import access, mailer
from app.services import analytics_digest as digest
from app.services import creator_analytics as ca

router = APIRouter(prefix="/api/v1/me", tags=["creator-analytics"])

RANGE = "^(7d|30d|90d|all)$"


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


async def _owned_doc(request: Request, db: AsyncIOMotorDatabase, slug: str, user: User) -> dict:
    raw = await db["documents"].find_one({"slug": slug})
    await access.require(access.actor_from_request(request, user), raw, "view_stats", access.Ctx(db))
    return raw


def _csv(body: str, filename: str) -> Response:
    return Response(content=body, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"',
                             "Cache-Control": "private, no-store"})


@router.get("/documents/{slug}/analytics/overview")
@limiter.limit("120/minute")
async def analytics_overview(
    request: Request, slug: str,
    range: str = Query("30d", pattern=RANGE),
    internal: int = Query(0, ge=0, le=1),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    raw = await _owned_doc(request, db, slug, user)
    return await ca.overview(db, raw, ca.window(range), bool(internal))


@router.get("/documents/{slug}/analytics/media")
@limiter.limit("120/minute")
async def analytics_media(
    request: Request, slug: str,
    ver: int | None = Query(None, ge=1, le=100_000),
    range: str = Query("30d", pattern=RANGE),
    internal: int = Query(0, ge=0, le=1),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    raw = await _owned_doc(request, db, slug, user)
    return await ca.media_report(db, raw, ca.window(range), bool(internal), ver)


@router.get("/documents/{slug}/analytics/frame")
@limiter.limit("60/minute")
async def analytics_frame(
    request: Request, slug: str,
    t: float = Query(..., ge=0, le=24 * 3600),
    ver: int | None = Query(None, ge=1, le=100_000),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """A frame of the owner's video at ``t`` seconds (rounded), as a JPEG.
    404 when it isn't a video, or frames can't be made here."""
    raw = await _owned_doc(request, db, slug, user)
    jpg = await ca.frame(db, raw, t, ver)
    if not jpg:
        raise HTTPException(status_code=404, detail="No frame available")
    return Response(content=jpg, media_type="image/jpeg",
                    headers={"Cache-Control": "private, max-age=86400"})


@router.get("/documents/{slug}/analytics/content")
@limiter.limit("120/minute")
async def analytics_content(
    request: Request, slug: str,
    range: str = Query("30d", pattern=RANGE),
    internal: int = Query(0, ge=0, le=1),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    raw = await _owned_doc(request, db, slug, user)
    return await ca.content_report(db, raw, ca.window(range), bool(internal))


@router.get("/documents/{slug}/analytics/pages")
@limiter.limit("120/minute")
async def analytics_pages(
    request: Request, slug: str,
    range: str = Query("30d", pattern=RANGE),
    internal: int = Query(0, ge=0, le=1),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    raw = await _owned_doc(request, db, slug, user)
    return await ca.pages_report(db, raw, ca.window(range), bool(internal))


@router.get("/documents/{slug}/analytics/audience")
@limiter.limit("120/minute")
async def analytics_audience(
    request: Request, slug: str,
    range: str = Query("30d", pattern=RANGE),
    internal: int = Query(0, ge=0, le=1),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    raw = await _owned_doc(request, db, slug, user)
    return await ca.audience_report(db, raw, ca.window(range), bool(internal))


@router.get("/documents/{slug}/analytics/versions")
@limiter.limit("120/minute")
async def analytics_versions(
    request: Request, slug: str,
    # Accepted for symmetry; versions are compared over their whole lifetime.
    range: str = Query("30d", pattern=RANGE),
    internal: int = Query(0, ge=0, le=1),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    raw = await _owned_doc(request, db, slug, user)
    return await ca.versions_report(db, raw, bool(internal))


@router.get("/documents/{slug}/analytics.csv")
@limiter.limit("60/minute")
async def analytics_csv(
    request: Request, slug: str,
    range: str = Query("30d", pattern=RANGE),
    internal: int = Query(0, ge=0, le=1),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    raw = await _owned_doc(request, db, slug, user)
    body = await ca.daily_csv(db, raw, ca.window(range), bool(internal))
    return _csv(body, f"{raw['slug']}-analytics-{range}.csv")


@router.get("/analytics")
@limiter.limit("120/minute")
async def analytics_home(
    request: Request,
    range: str = Query("30d", pattern=RANGE),
    internal: int = Query(0, ge=0, le=1),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    return await ca.home(db, user.id, ca.window(range), bool(internal))


@router.get("/analytics/live")
@limiter.limit("240/minute")
async def analytics_live(
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    return await ca.live(db, user.id)


@router.get("/analytics.csv")
@limiter.limit("60/minute")
async def analytics_home_csv(
    request: Request,
    range: str = Query("30d", pattern=RANGE),
    internal: int = Query(0, ge=0, le=1),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    body = await ca.home_csv(db, user.id, ca.window(range), bool(internal))
    return _csv(body, f"markdrop-analytics-{range}.csv")


# ── Weekly digest preferences (build spec §6) ────────────────────────────────


# No @limiter here: slowapi's wrapper would hide the body model from FastAPI
# (string annotations resolve in the wrapper's module). Signed-in only anyway.
@router.patch("/preferences")
async def update_preferences(
    request: Request,
    data: PreferencesUpdate,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Account preferences: ``analytics_digest`` "weekly" | "off"."""
    if is_tenant_request(request):
        # A workspace domain's session reads documents; it doesn't change the account.
        raise HTTPException(status_code=403, detail="Change this on markdrop.in.")
    await digest.set_preference(db, user.id, data.analytics_digest)
    return {"analytics_digest": data.analytics_digest}


_DIGEST_HEADERS = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
                   "X-Robots-Tag": "noindex, nofollow"}


def _digest_page(heading: str, body: str, *, status: int = 200, form: str = "") -> HTMLResponse:
    content = (mailer._eyebrow("Email preferences") + mailer._heading(heading)
               + mailer._p(body) + form
               + mailer._p(mailer._link(mailer._base(), "Go to Markdrop"), margin="0 0 20px"))
    footer = f"Markdrop &middot; {mailer._footer_link(mailer._base(), 'markdrop.in')}"
    return HTMLResponse(mailer._shell(title=heading, content=content, footer=footer, page=True),
                        status_code=status, headers=_DIGEST_HEADERS)


async def _digest_user(db: AsyncIOMotorDatabase, t: str) -> tuple[dict | None, int]:
    user_id = digest.verify_off_token(t)
    if not user_id or not ObjectId.is_valid(user_id):
        return None, 400
    row = await db["users"].find_one({"_id": ObjectId(user_id)}, {"email": 1, "analytics_digest": 1})
    return (row, 200) if row else (None, 404)


_BAD_LINK = "This link isn't valid. You can turn the weekly email off in Settings → Account."


@router.get("/digest/off", response_class=HTMLResponse)
@limiter.limit("60/minute")
async def digest_off_page(request: Request, t: str = "", db: AsyncIOMotorDatabase = Depends(get_db)):
    """The "Turn off weekly emails" link. It asks before acting: mail scanners
    open every link in an email, and a GET that acted would turn the email off
    for people who never clicked. The button (and one-click) POSTs."""
    row, status = await _digest_user(db, t)
    if row is None:
        return _digest_page("This link can't be used", _BAD_LINK, status=status)
    if row.get("analytics_digest") == "off":
        return _digest_page("Weekly emails are off", "You won't get the weekly analytics email. "
                            "Turn it back on any time in Settings → Account.")
    form = ('<form method="post" style="margin:4px 0 24px"><button type="submit" style="display:inline-block;'
            f"padding:12px 24px;font-family:{mailer._SANS};font-size:14px;line-height:20px;font-weight:600;"
            f'color:#ffffff;background-color:{mailer._ACCENT};border:0;border-radius:8px;cursor:pointer">'
            "Turn off weekly emails</button></form>")
    return _digest_page("Turn off the weekly analytics email?",
                        f"{mailer._strong(html.escape(row.get('email') or 'This address'))} will stop getting "
                        "the Monday summary of views and reading. Other Markdrop email is unaffected.",
                        form=form)


@router.post("/digest/off", response_class=HTMLResponse)
@limiter.limit("60/minute")
async def digest_off(request: Request, t: str = "", db: AsyncIOMotorDatabase = Depends(get_db)):
    """The page's button, and RFC 8058 one-click from List-Unsubscribe-Post."""
    row, status = await _digest_user(db, t)
    if row is None:
        return _digest_page("This link can't be used", _BAD_LINK, status=status)
    await digest.set_preference(db, str(row["_id"]), "off")
    return _digest_page("Weekly emails are off", "You won't get the weekly analytics email any more. "
                        "Turn it back on any time in Settings → Account.")
