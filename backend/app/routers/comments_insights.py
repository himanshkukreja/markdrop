"""Comment analytics, exports and the daily digest (Track C; CONTRACT §5).

    GET  /api/v1/documents/{slug}/comments/insights?range=7d|30d|90d|all
         An item's comment numbers (services/comments/analytics.py): open / resolved threads, time to first
         reply and to resolve, the most-discussed sections, a daily series, the most active people. Anyone who
         may see the item's comments (they could count them in the panel anyway).
    GET  /api/v1/documents/{slug}/comments/export?status=open|all
         The item's threads in page order, numbered, with every message (services/comments/export.py): what the
         PDF export prints as notes or footnotes. Same rule. (Markdown and Word take ``comments=`` on
         ``GET /api/v1/documents/{slug}/export``.)
    GET  /api/v1/comments/digest/settings          {"on": bool}: the daily comments digest (signed in)
    PUT  /api/v1/comments/digest/settings          {"on": bool}
    GET  /api/v1/comments/digest/off?t=…           the digest's "Turn off" link: asks first (mail scanners)
    POST /api/v1/comments/digest/off?t=…           the page's button and RFC 8058 one-click
    GET  /api/v1/admin/analytics/comments?range=   admin totals (the admin Analytics tab)
"""

from __future__ import annotations

import html
from typing import Literal

from bson import ObjectId
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.admin import require_admin
from app.routers.auth import optional_user, require_user
from app.services import access
from app.services.comments import analytics, digest, perms
from app.services.comments import export as comment_export
from app.utils.net import get_client_ip

router = APIRouter(tags=["comments"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


async def _item(request: Request, db, slug: str, user: User | None, read_password: str | None,
                scope: str | None) -> tuple[dict, access.Actor, access.Ctx]:
    actor = access.actor_from_request(request, user, read_password=read_password)
    ctx = access.Ctx(db, surface="rest", workspace_scope=scope or None, ip=get_client_ip(request))
    raw = await db["documents"].find_one({"slug": slug})
    await perms.require(db, actor, raw, ctx, "view")
    return raw, actor, ctx


@router.get("/api/v1/documents/{slug}/comments/insights", summary="Comment analytics for an item")
@limiter.limit("60/minute")
async def insights(request: Request, slug: str, range_: Literal["7d", "30d", "90d", "all"] = Query("30d", alias="range"),
                   db: AsyncIOMotorDatabase = Depends(get_db), x_read_password: str | None = Header(None),
                   x_markdrop_workspace: str | None = Header(None), user: User | None = Depends(optional_user)):
    raw, _actor, _ctx = await _item(request, db, slug, user, x_read_password, x_markdrop_workspace)
    out = await analytics.item_stats(db, raw, range_=range_)
    out["summary"] = analytics.summary_line(out)
    return out


@router.get("/api/v1/documents/{slug}/comments/export", summary="An item's comment threads for printing")
@limiter.limit("60/minute")
async def export_threads(request: Request, slug: str, status: Literal["open", "all"] = Query("all"),
                         db: AsyncIOMotorDatabase = Depends(get_db), x_read_password: str | None = Header(None),
                         x_markdrop_workspace: str | None = Header(None), user: User | None = Depends(optional_user)):
    raw, actor, ctx = await _item(request, db, slug, user, x_read_password, x_markdrop_workspace)
    threads = await comment_export.collect(db, actor, raw, ctx, status=status) or []
    return {"threads": [t.as_dict() for t in threads]}


# ── The daily digest ──────────────────────────────────────────────────────────


class DigestIn(BaseModel):
    on: bool


@router.get("/api/v1/comments/digest/settings", summary="Your daily comments digest setting")
async def digest_settings(db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    row = await db["users"].find_one({"_id": ObjectId(user.id)}, {"comment_digest": 1})
    return {"on": digest.is_on(row)}


@router.put("/api/v1/comments/digest/settings", summary="Turn the daily comments digest on or off")
async def set_digest_settings(request: Request, body: DigestIn, db: AsyncIOMotorDatabase = Depends(get_db),
                              user: User = Depends(require_user)):
    from app.routers.auth import is_tenant_request

    if is_tenant_request(request):
        raise HTTPException(status_code=403, detail="Change this on markdrop.in.")
    await digest.set_on(db, user.id, body.on)
    return {"on": body.on}


def _page(heading: str, body: str, *, status: int = 200, form: str = "") -> HTMLResponse:
    from app.services import mailer

    content = (mailer._eyebrow("Email preferences") + mailer._heading(heading) + mailer._p(body) + form
               + mailer._p(mailer._link(mailer._base(), "Go to Markdrop"), margin="0 0 20px"))
    return HTMLResponse(mailer._shell(title=heading, content=content, footer="", page=True), status_code=status,
                        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
                                 "X-Robots-Tag": "noindex, nofollow"})


_BAD = "This link isn't valid. You can turn the comments digest off in Settings → Account → Email."
_OFF = ("You won't get the daily comments digest any more. Mentions and replies still reach you as you chose "
        "in Settings → Account → Email.")


async def _digest_user(db, t: str) -> dict | None:
    uid = digest.verify_off_token(t)
    if not uid:
        return None
    return await db["users"].find_one({"_id": ObjectId(uid)}, {"email": 1, "comment_digest": 1})


@router.get("/api/v1/comments/digest/off", response_class=HTMLResponse, include_in_schema=False)
@limiter.limit("60/minute")
async def digest_off_page(request: Request, t: str = "", db: AsyncIOMotorDatabase = Depends(get_db)):
    from app.services import mailer

    row = await _digest_user(db, t)
    if row is None:
        return _page("This link can't be used", _BAD, status=400)
    if not digest.is_on(row):
        return _page("The comments digest is off", _OFF)
    form = ('<form method="post" style="margin:4px 0 24px"><button type="submit" style="display:inline-block;'
            f"padding:12px 24px;font-family:{mailer._SANS};font-size:14px;line-height:20px;font-weight:600;"
            f'color:#ffffff;background-color:{mailer._ACCENT};border:0;border-radius:8px;cursor:pointer">'
            "Turn off the digest</button></form>")
    return _page("Turn off the daily comments digest?",
                 f"{mailer._strong(html.escape(row.get('email') or 'This address'))} will stop getting the morning "
                 "summary of comment threads. Other Markdrop email is unaffected.", form=form)


@router.post("/api/v1/comments/digest/off", response_class=HTMLResponse, include_in_schema=False)
@limiter.limit("60/minute")
async def digest_off(request: Request, t: str = "", db: AsyncIOMotorDatabase = Depends(get_db)):
    row = await _digest_user(db, t)
    if row is None:
        return _page("This link can't be used", _BAD, status=400)
    await digest.set_on(db, str(row["_id"]), False)
    return _page("The comments digest is off", _OFF)


# ── Admin totals ──────────────────────────────────────────────────────────────



@router.get("/api/v1/admin/analytics/comments", summary="Comments across Markdrop (admin)", include_in_schema=False)
async def admin_comments(range_: str = Query("30d", alias="range", max_length=16),
                         db: AsyncIOMotorDatabase = Depends(get_db), _: dict = Depends(require_admin)):
    # The admin tab's range keys (today, 24h, 7d, 30d, 90d, 12m, custom…) → the nearest of ours.
    r = {"today": "7d", "24h": "7d", "yesterday": "7d", "7d": "7d", "30d": "30d", "90d": "90d"}.get(range_, "all"
                                                                                                       if range_ in ("12m", "all", "6m") else "30d")
    return await analytics.admin_totals(db, range_=r)
