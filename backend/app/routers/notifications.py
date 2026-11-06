"""The signed-in person's notifications (services/notifications.py), and the
mention emails' turn-off link.

    GET  /api/v1/notifications?unread_only=&limit=&before=   {items, unread_count, next_before}
    GET  /api/v1/notifications/unread-count?tz=              {unread_count}  (the app showed the bell: "seen")
    POST /api/v1/notifications/read  {ids?: [...], all?: bool} {marked, unread_count}
    POST /api/v1/notifications/{id}/open                     {href, slug, block} | 403 (can't open it now)
    GET  /api/v1/me/mentions/off?t=      asks before turning mention emails off (link scanners)
    POST /api/v1/me/mentions/off?t=      turns them off (the page's button, RFC 8058 one-click)
    GET  /api/v1/me/emails/less?t=       "Email me less": asks first (link scanners)
    POST /api/v1/me/emails/less?t=       lowers each kind in that email one step (Instant → Hourly → Daily → Off)

Not on a workspace's own domain: its session reads documents there, and the
notifications span every workspace (403).
"""

from __future__ import annotations

import html

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import is_tenant_request, require_user
from app.services import mailer
from app.services import notifications as svc

router = APIRouter(prefix="/api/v1", tags=["notifications"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _app_only(request: Request) -> None:
    if is_tenant_request(request):
        raise HTTPException(status_code=403, detail="Notifications are on markdrop.in.")


class MarkRead(BaseModel):
    ids: list[str] | None = Field(None, max_length=svc.LIST_MAX)
    all: bool = False


@router.get("/notifications")
@limiter.limit("120/minute")
async def list_notifications(
    request: Request,
    unread_only: bool = False,
    limit: int = 30,
    before: str | None = None,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    _app_only(request)
    await svc.saw_app(db, user.id)
    return await svc.listing(db, user.id, unread_only=unread_only, limit=limit, before=before)


@router.get("/notifications/unread-count")
@limiter.limit("240/minute")
async def unread_count(request: Request, tz: str | None = Query(None, max_length=64),
                       db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """The bell polls this only while a tab is visible: the person has seen what came before
    (no email about it), and ``tz`` (their IANA zone) times the daily digest."""
    _app_only(request)
    await svc.saw_app(db, user.id, tz)
    return {"unread_count": await svc.unread_count(db, user.id)}


# No @limiter on the body routes: slowapi's wrapper hides the body model from FastAPI. Signed-in only.
@router.post("/notifications/read")
async def mark_read(request: Request, data: MarkRead, db: AsyncIOMotorDatabase = Depends(get_db),
                    user: User = Depends(require_user)):
    _app_only(request)
    if not data.all and not data.ids:
        raise HTTPException(status_code=422, detail="Give ids, or all: true.")
    marked = await svc.mark_read(db, user.id, data.ids, data.all)
    return {"marked": marked, "unread_count": await svc.unread_count(db, user.id)}


@router.post("/notifications/{notification_id}/open")
@limiter.limit("120/minute")
async def open_notification(request: Request, notification_id: str, db: AsyncIOMotorDatabase = Depends(get_db),
                            user: User = Depends(require_user)):
    _app_only(request)
    return await svc.open_one(db, user.id, notification_id)


# ── Turn-off link (in every mention email) ────────────────────────────────────

_HEADERS = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow"}
_BAD_LINK = "This link isn't valid. You can change these emails in Settings → Account."


def _page(heading: str, body: str, *, status: int = 200, form: str = "") -> HTMLResponse:
    content = (mailer._eyebrow("Email preferences") + mailer._heading(heading) + mailer._p(body) + form
               + mailer._p(mailer._link(mailer._base(), "Go to Markdrop"), margin="0 0 20px"))
    footer = ""
    return HTMLResponse(mailer._shell(title=heading, content=content, footer=footer, page=True),
                        status_code=status, headers=_HEADERS)


async def _who(db: AsyncIOMotorDatabase, t: str) -> tuple[dict | None, int]:
    user_id = svc.verify_off_token(t)
    if not user_id or not ObjectId.is_valid(user_id):
        return None, 400
    row = await db["users"].find_one({"_id": ObjectId(user_id)}, {"email": 1, "mention_emails": 1, "email_notify": 1})
    return (row, 200) if row else (None, 404)


@router.get("/me/mentions/off", response_class=HTMLResponse)
@limiter.limit("60/minute")
async def mentions_off_page(request: Request, t: str = "", db: AsyncIOMotorDatabase = Depends(get_db)):
    """Asks first: mail scanners open every link, and a GET that acted would
    turn the emails off for people who never clicked."""
    row, status = await _who(db, t)
    if row is None:
        return _page("This link can't be used", _BAD_LINK, status=status)
    if not svc.wants_email(row):
        return _page("Mention emails are off", "You won't get an email when someone mentions you. You still "
                     "see mentions under the bell in Markdrop. Turn emails back on any time in Settings → Account.")
    form = ('<form method="post" style="margin:4px 0 24px"><button type="submit" style="display:inline-block;'
            f"padding:12px 24px;font-family:{mailer._SANS};font-size:14px;line-height:20px;font-weight:600;"
            f'color:#ffffff;background-color:{mailer._ACCENT};border:0;border-radius:8px;cursor:pointer">'
            "Turn off mention emails</button></form>")
    return _page("Turn off mention emails?",
                 f"{mailer._strong(html.escape(row.get('email') or 'This address'))} will stop getting an email "
                 "when someone mentions you or asks for your sign-off. You'll still see them under the bell in "
                 "Markdrop. Other Markdrop email is unaffected.", form=form)


@router.post("/me/mentions/off", response_class=HTMLResponse)
@limiter.limit("60/minute")
async def mentions_off(request: Request, t: str = "", db: AsyncIOMotorDatabase = Depends(get_db)):
    row, status = await _who(db, t)
    if row is None:
        return _page("This link can't be used", _BAD_LINK, status=status)
    await svc.set_preference(db, str(row["_id"]), False)
    return _page("Mention emails are off", "You won't get an email when someone mentions you any more. You "
                 "still see mentions under the bell in Markdrop. Turn emails back on any time in Settings → Account.")


# ── "Email me less" (in every notification email) ────────────────────────────


def _modes_html(modes: dict[str, str]) -> str:
    return "<br>".join(f"{svc.KIND_LABELS[k]}: {mailer._strong(svc.MODE_LABELS[m])}" for k, m in modes.items())


def _button_form(label: str) -> str:
    return ('<form method="post" style="margin:4px 0 24px"><button type="submit" style="display:inline-block;'
            f"padding:12px 24px;font-family:{mailer._SANS};font-size:14px;line-height:20px;font-weight:600;"
            f'color:#ffffff;background-color:{mailer._ACCENT};border:0;border-radius:8px;cursor:pointer">'
            f"{label}</button></form>")


_SETTINGS_NOTE = "Change these any time in Settings → Account → Email."


@router.get("/me/emails/less", response_class=HTMLResponse)
@limiter.limit("60/minute")
async def email_less_page(request: Request, t: str = "", db: AsyncIOMotorDatabase = Depends(get_db)):
    """Asks first, like the turn-off link: a mail scanner opening it changes nothing."""
    who = svc.verify_less_token(t)
    row = await db["users"].find_one({"_id": ObjectId(who[0])}, {"email": 1, "mention_emails": 1, "email_notify": 1}) \
        if who else None
    if row is None:
        return _page("This link can't be used", _BAD_LINK, status=400 if who is None else 404)
    modes = svc.email_modes(row)
    plan = {k: svc.step_down(m) for k, m in who[1].items() if modes.get(k) == m and m != "off"}
    if not plan:
        return _page("Already done", f"Your notification emails are set to:<br>{_modes_html(modes)}<br><br>"
                     + _SETTINGS_NOTE)
    lines = "<br>".join(f"{svc.KIND_LABELS[k]}: {svc.MODE_LABELS[modes[k]]} → {mailer._strong(svc.MODE_LABELS[m])}"
                        for k, m in plan.items())
    return _page("Email me less?", f"{mailer._strong(html.escape(row.get('email') or 'This address'))} will get "
                 f"fewer notification emails:<br>{lines}<br><br>You still see everything under the bell in Markdrop.",
                 form=_button_form("Email me less"))


@router.post("/me/emails/less", response_class=HTMLResponse)
@limiter.limit("60/minute")
async def email_less(request: Request, t: str = "", db: AsyncIOMotorDatabase = Depends(get_db)):
    who = svc.verify_less_token(t)
    exists = who and await db["users"].find_one({"_id": ObjectId(who[0])}, {"_id": 1})
    if not exists:
        return _page("This link can't be used", _BAD_LINK, status=400 if who is None else 404)
    changed, modes = await svc.email_less(db, who[0], who[1])
    heading = "Done: fewer emails" if changed else "Already done"
    return _page(heading, f"Your notification emails are now:<br>{_modes_html(modes)}<br><br>{_SETTINGS_NOTE}")
