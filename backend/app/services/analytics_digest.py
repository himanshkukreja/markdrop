"""The weekly analytics digest (creator analytics build spec §6).

On Mondays from 03:30 UTC every owner whose links had at least one view last
week (Monday to Sunday, UTC; workspace members' views don't count, the owner's
own are never recorded) gets one email: views and the change on the week
before, people / watch time / read to the end, the top three links with a
one-line note each, up to two insights, and a button to the dashboard.

Never twice:

* The pass runs under a lease in ``job_leases`` (the domain_monitor pattern), so
  one worker sends; the row also remembers the last ISO week that finished
  (``last_week``), so a restart doesn't run it again.
* Each recipient is claimed in ``digest_sends`` ({user_id, week} unique) before
  the email goes, so a pass that dies half-way resumes with the people it
  hadn't reached — at the cost of never retrying the one it died on.

Skipped: users with ``unsubscribed_at`` (the account-wide opt-out), with
``analytics_digest == "off"`` (Settings → Account, or the email's own link),
and addresses on the campaign suppression list (bounces, complaints).

The turn-off link carries a signed token (HMAC of the user id with the auth
secret, purpose "digest"), like campaign unsubscribe links; it is served by
``routers/creator_analytics.py`` at ``/api/v1/me/digest/off``.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import html
import logging
import os
import re
import secrets
import socket
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from typing import Any, Callable

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.services import creator_analytics as ca
from app.services import engage, mailer, md_outline

settings = get_settings()
log = logging.getLogger(__name__)

JOB_ID = "analytics-digest"
LEASE_SECONDS = 30 * 60
SENDS = "digest_sends"
SENDS_TTL_DAYS = 120
SEND_AT = time(3, 30)
# A pass missed on Monday (the API was down) still goes out on Tuesday; from
# Wednesday it's too late to be "last week", and that week is skipped.
CLOSES_AFTER = timedelta(days=2)
PREFERENCES = ("weekly", "off")
TOP_LINKS = 3
MAX_TIPS = 2
OFF_PATH = "/api/v1/me/digest/off"

_OWNER = f"{socket.gethostname()}:{os.getpid()}:{secrets.token_hex(3)}"
_task: asyncio.Task | None = None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[SENDS].create_index([("user_id", 1), ("week", 1)], unique=True)
    await db[SENDS].create_index("at", expireAfterSeconds=SENDS_TTL_DAYS * 24 * 3600)


# ── Weeks ─────────────────────────────────────────────────────────────────────


def monday_of(now: datetime) -> datetime:
    """00:00 UTC on the Monday of ``now``'s ISO week."""
    now = _aware(now)
    d = now.date() - timedelta(days=now.weekday())
    return datetime.combine(d, time.min, tzinfo=timezone.utc)


def week_key(now: datetime) -> str:
    """The ISO week a digest sent at ``now`` belongs to ("2026-W44")."""
    y, w, _ = _aware(now).isocalendar()
    return f"{y}-W{w:02d}"


def report_window(now: datetime) -> ca.Window:
    """Last week, Monday 00:00 to Monday 00:00 UTC, compared with the one before."""
    end = monday_of(now)
    start = end - timedelta(days=7)
    return ca.Window("7d", start, end, start - timedelta(days=7), start)


def is_due_at(now: datetime) -> bool:
    """Inside this week's sending window: Monday 03:30 UTC to the end of Tuesday."""
    now = _aware(now)
    monday = monday_of(now)
    opens = monday + timedelta(hours=SEND_AT.hour, minutes=SEND_AT.minute)
    return opens <= now < monday + CLOSES_AFTER


async def is_due(db: AsyncIOMotorDatabase, now: datetime) -> bool:
    if not is_due_at(now):
        return False
    row = await db["job_leases"].find_one({"_id": JOB_ID}, {"last_week": 1})
    return (row or {}).get("last_week") != week_key(now)


# ── Lease (services/domain_monitor.py's pattern, its own row) ────────────────


async def acquire_lease(db: AsyncIOMotorDatabase, owner: str, now: datetime,
                        seconds: int = LEASE_SECONDS) -> bool:
    try:
        await db["job_leases"].find_one_and_update(
            {"_id": JOB_ID, "$or": [{"lease_until": {"$lte": now}}, {"owner": owner}, {"lease_until": None}]},
            {"$set": {"owner": owner, "lease_until": now + timedelta(seconds=seconds)}},
            upsert=True,
        )
        return True
    except DuplicateKeyError:
        return False


async def release_lease(db: AsyncIOMotorDatabase, owner: str, finished: datetime | None) -> None:
    update: dict = {"lease_until": None}
    if finished is not None:
        update.update(last_run_at=finished, last_week=week_key(finished))
    await db["job_leases"].update_one({"_id": JOB_ID, "owner": owner}, {"$set": update})


# ── Turn-off token ────────────────────────────────────────────────────────────


def off_token(user_id: str) -> str:
    """Signed, non-guessable: it can only ever stop this email, so no expiry."""
    sig = hmac.new(settings.auth_secret.encode(), f"digest:{user_id}".encode(),
                   hashlib.sha256).hexdigest()[:32]
    return f"{user_id}.{sig}"


def verify_off_token(token: str | None) -> str | None:
    try:
        user_id, sig = (token or "").rsplit(".", 1)
    except ValueError:
        return None
    if not user_id or not sig:
        return None
    expected = off_token(user_id).rsplit(".", 1)[1]
    return user_id if hmac.compare_digest(sig.encode(), expected.encode()) else None


def off_url(user_id: str) -> str:
    return f"{settings.api_base_url.rstrip('/')}{OFF_PATH}?t={off_token(user_id)}"


async def set_preference(db: AsyncIOMotorDatabase, user_id: str, value: str) -> bool:
    if value not in PREFERENCES or not ObjectId.is_valid(user_id):
        return False
    res = await db["users"].update_one(
        {"_id": ObjectId(user_id)},
        {"$set": {"analytics_digest": value, "analytics_digest_at": _now()}})
    return res.matched_count == 1


# ── Recipients ────────────────────────────────────────────────────────────────


def wants_digest(user: dict) -> bool:
    return not user.get("unsubscribed_at") and (user.get("analytics_digest") or "weekly") != "off"


async def recipients(db: AsyncIOMotorDatabase, w: ca.Window) -> list[dict]:
    """Owners with at least one non-internal view in the window who still want
    the email, oldest account first (a stable order for a resumed pass)."""
    ids = [r["_id"] async for r in db["events"].aggregate([
        {"$match": ca.views_match({"owner_id": {"$ne": None}}, w.start, w.end, False)},
        {"$group": {"_id": "$owner_id"}},
    ])]
    oids = [ObjectId(i) for i in ids if isinstance(i, str) and ObjectId.is_valid(i)]
    if not oids:
        return []
    users = await db["users"].find(
        {"_id": {"$in": oids}},
        {"email": 1, "name": 1, "unsubscribed_at": 1, "analytics_digest": 1, "created_at": 1},
    ).to_list(length=None)
    users = [u for u in users if u.get("email") and wants_digest(u)]
    if users:
        suppressed = {r["_id"] async for r in db["email_suppressions"].find(
            {"_id": {"$in": [u["email"].strip().lower() for u in users]}}, {"_id": 1})}
        users = [u for u in users if u["email"].strip().lower() not in suppressed]
    users.sort(key=lambda u: (_aware(u.get("created_at")) or datetime.min.replace(tzinfo=timezone.utc),
                              str(u["_id"])))
    return users


# ── Content ───────────────────────────────────────────────────────────────────


def _count(n: float) -> str:
    return f"{n:,.0f}"


def fmt_watch(seconds: float) -> str:
    s = float(seconds or 0)
    if s >= 3600:
        h = s / 3600
        return f"{h:.0f} h" if h >= 10 else f"{h:.1f} h".replace(".0 h", " h")
    if s >= 60:
        return f"{round(s / 60)} min"
    return f"{s:.0f} s"


def _days(w: ca.Window) -> str:
    a, b = w.start, w.end - timedelta(days=1)
    return f"{a:%b} {a.day} – {b:%b} {b.day}"


def headline(views: int, prev: int | None) -> str:
    s = f"Your week: {_count(views)} view{'s' if views != 1 else ''}"
    if prev:
        d = round(100 * (views - prev) / prev)
        if d > 0:
            s += f", up {d}%"
        elif d < 0:
            s += f", down {-d}%"
        else:
            s += ", the same as the week before"
    return s


_NOTE_DROPS = ("media_drop", "section_drop", "page_drop")


def link_note(link: dict, doc_insights: list[dict], titles: dict[str, str]) -> str | None:
    """"64% watched · biggest drop at 2:14" — the link's engagement in words,
    and where people leave when an insight found it."""
    kind, label = link.get("kind"), link.get("engage_label") or ""
    m = re.match(r"^(\d+)%", label)
    first = None
    if m:
        n = m.group(1)
        first = {"video": f"{n}% watched", "audio": f"{n}% listened", "doc": f"{n}% read it all",
                 "pdf": f"{n}% reached the last page"}.get(kind, label)
    elif label:
        first = label
    second = None
    for i in doc_insights:
        if i.get("key") not in _NOTE_DROPS:
            continue
        if i["key"] == "media_drop":
            second = "biggest drop at " + i["title"].rsplit(" at ", 1)[-1]
        elif i["key"] == "section_drop":
            second = f"readers leave at “{md_outline.section_title(i.get('section'), titles)}”"
        else:
            second = i["title"][0].lower() + i["title"][1:]
        break
    parts = [p for p in (first, second) if p]
    return " · ".join(parts) or None


@dataclass
class Digest:
    subject: str
    html: str
    text: str
    week: str


async def _has_sessions(db: AsyncIOMotorDatabase, user_id: str, w: ca.Window, kinds: tuple[str, ...]) -> bool:
    row = await db[engage.COLL].find_one(
        {"owner_id": user_id, "kind": {"$in": list(kinds)}, **ca._ts("started_at", w.start, w.end),
         "internal": {"$ne": True}}, {"_id": 1})
    return row is not None


def _user_fields(user: Any) -> tuple[str, str, str | None]:
    if isinstance(user, dict):
        return str(user["_id"]), user.get("email") or "", user.get("name")
    return str(user.id), user.email, getattr(user, "name", None)


async def compose(db: AsyncIOMotorDatabase, user: Any, now: datetime | None = None) -> Digest | None:
    """The digest for ``user`` (a users row or a User) for the week before
    ``now``; None when nothing of theirs was viewed."""
    now = _aware(now) or _now()
    user_id, _email, _name = _user_fields(user)
    w = report_window(now)
    per_doc: dict[str, list[dict]] = {}
    data = await ca.home(db, user_id, w, False, per_doc_out=per_doc)
    k = {x["key"]: x for x in data["kpis"]}
    views = int(k["views"]["value"])
    if views <= 0:
        return None
    head = headline(views, k["views"].get("prev"))
    watch = (fmt_watch(k["watch_time"]["value"])
             if await _has_sessions(db, user_id, w, ca.MEDIA_KINDS) else "—")
    read = (f"{k['read_end']['value']:.0f}%"
            if await _has_sessions(db, user_id, w, ("doc", "pdf")) else "—")
    kpis = [("People", _count(k["people"]["value"])), ("Watch time", watch), ("Read to the end", read)]

    links = data["links"][:TOP_LINKS]
    tips_src = data["insights"][:MAX_TIPS]
    slugs = {lk["slug"] for lk in links} | {i.get("slug") for i in tips_src if i.get("slug")}
    raws = {r["slug"]: r for r in await db["documents"].find(
        {"slug": {"$in": list(slugs)}, "owner_id": user_id},
        {"slug": 1, "title": 1, "kind": 1, "encrypted": 1, "original_filename": 1, "content": 1},
    ).to_list(length=len(slugs) or 1)}
    titles = {s: md_outline.doc_heading_titles(r) for s, r in raws.items()}

    def name_of(slug: str) -> str:
        r = raws.get(slug)
        return md_outline.display_title(r) if r else slug

    top_views = max((lk["views"] for lk in links), default=0) or 1
    top = [{"slug": lk["slug"], "title": name_of(lk["slug"]), "views": lk["views"],
            "pct": max(2, round(100 * lk["views"] / top_views)),
            "note": link_note(lk, per_doc.get(lk["slug"], []), titles.get(lk["slug"], {}))}
           for lk in links]
    tips = []
    for i in tips_src:
        t = md_outline.plain_insight(i, titles.get(i.get("slug") or "", {}))
        tips.append({"title": t["title"], "body": t["body"],
                     "doc": name_of(i["slug"]) if i.get("slug") else None})

    base = settings.frontend_url.rstrip("/")
    analytics_url = f"{base}/dashboard/analytics"
    off = off_url(user_id)
    sub = f"{_days(w)} · your own views aren't counted"
    subject = mailer._one_line(head.replace("Your week:", "Your Markdrop week:", 1), 150)
    return Digest(subject=subject, html=_html(head, sub, kpis, top, tips, analytics_url, off),
                  text=_text(head, sub, kpis, top, tips, analytics_url, off), week=week_key(now))


async def render_digest(db: AsyncIOMotorDatabase, user: Any,
                        now: datetime | None = None) -> tuple[str, str] | None:
    """(subject, html) of the digest ``user`` would get, or None — for previews and tests."""
    d = await compose(db, user, now)
    return (d.subject, d.html) if d else None


def _e(s: Any) -> str:
    return html.escape(str(s), quote=True)


def _html(head: str, sub: str, kpis: list[tuple[str, str]], top: list[dict], tips: list[dict],
          analytics_url: str, off: str) -> str:
    S, M, INK, BODY, LINE, INSET, ACC = (mailer._SANS, mailer._MUTED, mailer._INK, mailer._BODY,
                                         mailer._LINE, mailer._INSET, mailer._ACCENT)
    cells = "".join(
        f'<td width="33%" valign="top" style="padding:0 {6 if i < 2 else 0}px 0 0">'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
        f'<td bgcolor="{INSET}" style="background-color:{INSET};border-radius:8px;padding:12px">'
        f'<div style="font-family:{S};font-size:12px;line-height:16px;color:{M}">{_e(label)}</div>'
        f'<div style="font-family:{S};font-size:22px;line-height:28px;font-weight:700;color:{INK}">{_e(value)}</div>'
        f"</td></tr></table></td>"
        for i, (label, value) in enumerate(kpis))
    kpi_row = (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
               f'style="margin:4px 0 24px"><tr>{cells}</tr></table>')

    def h2(text: str) -> str:
        return (f'<h2 style="font-family:{S};font-size:15px;line-height:22px;font-weight:600;color:{INK};'
                f'margin:0 0 10px;padding:0">{text}</h2>')

    base = settings.frontend_url.rstrip("/")
    rows = []
    for t in top:
        href = _e(f"{base}/dashboard/analytics/{t['slug']}")
        note = (f'<div style="font-family:{S};font-size:12px;line-height:18px;color:{M};margin-top:4px">'
                f"{_e(t['note'])}</div>") if t["note"] else ""
        rows.append(
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
            'style="margin:0 0 14px"><tr>'
            f'<td style="font-family:{S};font-size:13px;line-height:20px;font-weight:600;color:{INK}">'
            f'<a href="{href}" style="color:{INK};text-decoration:none">{_e(t["title"])}</a></td>'
            f'<td align="right" style="font-family:{S};font-size:13px;line-height:20px;color:{BODY};'
            f'white-space:nowrap;padding-left:12px">{_e(_count(t["views"]))}</td></tr>'
            '<tr><td colspan="2" style="padding-top:4px">'
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
            f'<td bgcolor="{INSET}" style="background-color:{INSET};border-radius:3px;height:6px;line-height:6px;font-size:0">'
            f'<table role="presentation" width="{t["pct"]}%" cellpadding="0" cellspacing="0" border="0"><tr>'
            f'<td bgcolor="{ACC}" style="background-color:{ACC};border-radius:3px;height:6px;line-height:6px;'
            f'font-size:0">&nbsp;</td></tr></table></td></tr></table>'
            f"{note}</td></tr></table>")
    links_html = h2("Top links") + "".join(rows) if rows else ""

    tip_html = ""
    if tips:
        boxes = []
        for t in tips:
            body = _e(t["body"])
            if t["doc"]:
                body = f"{_e('“' + t['doc'] + '”')} · {body}"
            boxes.append(
                '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
                f'style="margin:0 0 10px"><tr><td style="border:1px solid {LINE};border-radius:8px;padding:12px 14px">'
                f'<div style="font-family:{S};font-size:13px;line-height:20px;font-weight:600;color:{INK}">{_e(t["title"])}</div>'
                f'<div style="font-family:{S};font-size:13px;line-height:20px;color:{BODY}">{body}</div>'
                "</td></tr></table>")
        tip_html = '<div style="height:10px;line-height:10px;font-size:0">&nbsp;</div>' + h2("Worth a look") + "".join(boxes)

    content = (
        mailer._heading(_e(head))
        + mailer._p(_e(sub), size=14, color=M, margin="-4px 0 20px")
        + kpi_row
        + links_html
        + tip_html
        + mailer._button(_e(analytics_url), "Open analytics", margin="14px 0 20px")
    )
    footer = ("You get this every Monday. "
              f"{mailer._footer_link(_e(off), 'Turn off weekly emails')} &middot; "
              f"{mailer._footer_link(_e(base + '/settings/account'), 'Email settings')}")
    return mailer._shell(title=_e(head), preheader=_e(f"{head}. {sub}."), content=content, footer=footer)


def _text(head: str, sub: str, kpis: list[tuple[str, str]], top: list[dict], tips: list[dict],
          analytics_url: str, off: str) -> str:
    out = [head, sub, ""]
    out += [f"{label}: {value}" for label, value in kpis]
    if top:
        out += ["", "Top links"]
        for t in top:
            out.append(f"- {t['title']}: {_count(t['views'])} views" + (f" ({t['note']})" if t["note"] else ""))
    if tips:
        out += ["", "Worth a look"]
        for t in tips:
            out.append(f"- {t['title']}. " + (f"“{t['doc']}”: " if t["doc"] else "") + t["body"])
    out += ["", f"Open analytics: {analytics_url}", "",
            "You get this every Monday.", f"Turn off weekly emails: {off}"]
    return "\n".join(out)


# ── Sending ───────────────────────────────────────────────────────────────────


async def send_one(db: AsyncIOMotorDatabase, user: dict, now: datetime) -> str:
    """Claim, compose and send one user's digest. Returns sent | empty |
    already | failed."""
    user_id = str(user["_id"])
    week = week_key(now)
    try:
        await db[SENDS].insert_one({"user_id": user_id, "week": week, "status": "claimed", "at": _now()})
    except DuplicateKeyError:
        return "already"
    status = "failed"
    try:
        d = await compose(db, user, now)
        if d is None:
            status = "empty"
        else:
            off = off_url(user_id)
            await mailer._post({
                "from": mailer._sender("welcome"),
                "to": [user["email"]],
                "subject": d.subject,
                "reply_to": settings.email_reply_to,
                "html": d.html,
                "text": d.text,
                "headers": {
                    "List-Unsubscribe": f"<{off}>",
                    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
                },
            })
            status = "sent"
    except Exception:
        log.exception("weekly digest for %s failed", user_id)
    await db[SENDS].update_one({"user_id": user_id, "week": week}, {"$set": {"status": status, "at": _now()}})
    return status


async def run_pass(db: AsyncIOMotorDatabase, now: datetime | None = None) -> dict[str, int]:
    now = _aware(now) or _now()
    await ensure_indexes(db)
    counts: dict[str, int] = {}
    for user in await recipients(db, report_window(now)):
        outcome = await send_one(db, user, now)
        counts[outcome] = counts.get(outcome, 0) + 1
    return counts


async def tick(db: AsyncIOMotorDatabase, owner: str = _OWNER, now: datetime | None = None) -> dict[str, int] | None:
    """One wake-up: send this week's digests if they're due and the lease is
    ours. None when nothing ran."""
    now = _aware(now) or _now()
    if not mailer.is_configured() or not await is_due(db, now):
        return None
    if not await acquire_lease(db, owner, now):
        return None
    ran = False
    try:
        if not await is_due(db, now):  # another worker finished between the check and the lease
            return None
        counts = await run_pass(db, now)
        ran = True
        log.info("weekly analytics digest %s: %s", week_key(now), counts)
        return counts
    finally:
        await release_lease(db, owner, now if ran else None)


async def _loop(get_db: Callable[[], AsyncIOMotorDatabase]) -> None:
    await asyncio.sleep(5 + secrets.randbelow(30))
    while True:
        try:
            await tick(get_db())
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("weekly digest tick failed")
        await asyncio.sleep(max(30, settings.analytics_digest_poll_seconds))


def start(get_db: Callable[[], AsyncIOMotorDatabase]) -> bool:
    """Start the weekly loop when enabled (off by default). True if started."""
    global _task
    if not (settings.analytics_digest_enabled and settings.background_workers_enabled) or _task is not None:
        return False
    _task = asyncio.get_running_loop().create_task(_loop(get_db))
    return True


async def stop() -> None:
    global _task
    if _task is None:
        return
    _task.cancel()
    try:
        await _task
    except (asyncio.CancelledError, Exception):
        pass
    _task = None
