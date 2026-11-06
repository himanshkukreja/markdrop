"""Notifications: someone mentioned you, asked you to sign off, or shared a page
with you (Senseloaf P2 item 9).

``notifications`` rows::

    {_id, user_id, kind, doc_id, block_id, actor_id, actor_name, via, extra,
     created_at, read_at, email, emailed_at}

``kind``: ``mention`` (a ``:person[..]{id=…}`` on a page), ``signoff_requested``
(the named person of a ``:::signoff{person=…}`` block; services that own the
block may also call :func:`notify` themselves: a second call is a no-op) and
``shared`` (someone added you to a page with "Notify people" on).

Privacy, the rules every path follows:

* Nobody is notified about a page they can't open: :func:`notify` asks
  ``access.can(read)`` for the recipient (a password gate counts as "can't").
* A row never stores the page's title. Listing resolves the title and the link
  per row with the reader's access *now*; a page they can no longer open shows
  as "a page you can't open", with no title, link, excerpt, label or message.
  Opening a notification (:func:`open_one`) checks again.
* The author is never notified of their own mention; only signed-in writers
  notify (an anonymous edit-secret holder can't send anyone anything).
* A mention already in the previous version doesn't notify again
  (:func:`on_page_saved` diffs before / after), and the same person + page +
  block + kind notifies at most once in 24 hours (removing and re-adding a
  mention while editing doesn't ring twice). At most 50 people per save.

Email (mentions and sign-off requests; "shared" has its own immediate email in
routers/access.py), "email calm" (owner, 2026-11-06). A row is born ``email:
"pending"`` when the person wants that kind's email (:func:`email_modes`:
Instant, Hourly bundle — mentions' default —, Daily digest or Off; sign-off
requests default to Instant). :func:`flush_emails` (background loop, every
30 s) looks at each person whose rows are due (``email_at``):

* App and push first: no email about a row read in the app, shown to them by
  the bell after it arrived (``users.app_seen_at``) ("seen"), or delivered by a
  push to one of their devices ("pushed") or a Slack DM ("slack"). A push or DM
  still on its way holds the email for up to the kind's ``WINDOW`` (mentions 30
  min, sign-off requests 10).
* Instant: one email per person per page, batching that page's rows, once the
  newest waited ``GATHER`` and none went about that page in the last 10 minutes
  (``notification_email_log``); someone in the app lately gets the window to see
  it there first. Hourly: one bundle an hour at most, once its oldest row waited
  30 minutes. Daily: one digest at 08:00 their time (``users.email_tz``, from
  the bell, else UTC).
* At most ``DAILY_CAP`` (3) of these emails a day (their day); past it the rows
  wait for one catch-up email the next morning (``catchup``). An email with a
  sign-off request may be a fourth, once a day.
* At send time it checks again: access (per page), the preference, the
  suppression list and whether the mention is still on the page (else
  ``email: "withdrawn"``). Every email has "Email me less" (:func:`email_less`)
  and the turn-off link.

Mistaken mentions (owner, 2026-11-06): a save that takes a mention out
(:func:`removed_mentions`) withdraws that person's *unread* notifications for
that page (:func:`withdraw`): the bell entry goes and a pending email, push or
Slack message is dropped. Push and Slack messages about mentions and sign-off
requests wait a minute too (services/push.py ``SLOW_GATHER``,
services/slack_notify.py), so a mention fixed within a minute never reaches
anyone. A read row stays; one already delivered leaves a tombstone
(``notification_withdrawn``) so putting the mention back the same day doesn't
ring twice.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator

import hashlib
import hmac
import html
import logging
import re
from datetime import datetime, timedelta, timezone
from datetime import time as dtime
from typing import Any
from zoneinfo import ZoneInfo

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.config import get_settings

settings = get_settings()
log = logging.getLogger(__name__)

COLL = "notifications"
EMAIL_LOG = "notification_email_log"
WITHDRAWN = "notification_withdrawn"   # delivered-then-withdrawn rows, for the 24-hour dedupe
KINDS = ("mention", "signoff_requested", "shared")
EMAIL_KINDS = ("mention", "signoff_requested")
DEDUPE = timedelta(hours=24)
EMAIL_GAP = timedelta(minutes=10)
GATHER = timedelta(seconds=60)
MAX_PER_SAVE = 50
MAX_PER_EMAIL = 10
KEEP_DAYS = 90
LIST_MAX = 100
FLUSH_GROUPS = 200
OFF_PATH = "/api/v1/me/mentions/off"
_ANCHOR = re.compile(r"^b-[a-z0-9]{4,12}$")
_ANCHOR_IN = re.compile(r"(?:^|\s)#(b-[a-z0-9]{4,12})(?=\s|$)")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index([("user_id", 1), ("created_at", -1)])
    await db[COLL].create_index([("user_id", 1), ("read_at", 1)])
    await db[COLL].create_index([("user_id", 1), ("kind", 1), ("doc_id", 1), ("block_id", 1), ("created_at", -1)])
    await db[COLL].create_index([("email", 1), ("created_at", 1)])
    await db[COLL].create_index([("email", 1), ("email_at", 1)])
    await db[COLL].create_index("created_at", expireAfterSeconds=KEEP_DAYS * 24 * 3600)
    await db[EMAIL_LOG].create_index("sent_at", expireAfterSeconds=24 * 3600)
    await db[DAYS].create_index("at", expireAfterSeconds=3 * 24 * 3600)
    await db[WITHDRAWN].create_index([("user_id", 1), ("kind", 1), ("doc_id", 1), ("block_id", 1)])
    await db[WITHDRAWN].create_index("created_at", expireAfterSeconds=int(DEDUPE.total_seconds()))


# ── Who ───────────────────────────────────────────────────────────────────────


def _actor_info(actor: Any) -> tuple[str | None, str | None]:
    """(user id, display name) of whoever acted: an access.Actor, a User, a
    users row, or a user id."""
    from app.services import viewers

    if actor is None:
        return None, None
    if isinstance(actor, str):
        return actor, None
    if isinstance(actor, dict):
        uid = str(actor.get("_id") or actor.get("id") or "") or None
        return uid, viewers.display_name(type("U", (), {"name": actor.get("name"), "email": actor.get("email")}))
    user = getattr(actor, "user", actor) if hasattr(actor, "cred") else actor
    uid = getattr(user, "id", None)
    return (str(uid) if uid else None), (viewers.display_name(user) if uid else None)


def _via(actor: Any) -> str | None:
    """The AI app's name when the write came over MCP."""
    return "mcp" if getattr(actor, "cred", None) == "mcp" else None


async def _user_row(db: AsyncIOMotorDatabase, user_id: str | None) -> dict | None:
    if not user_id or not ObjectId.is_valid(str(user_id)):
        return None
    return await db["users"].find_one({"_id": ObjectId(str(user_id))})


def _as_user(row: dict):
    from app.models.user import User

    return User(id=str(row["_id"]), email=row.get("email") or "", name=row.get("name"),
                created_at=row.get("created_at") or _now(), updated_at=row.get("updated_at") or _now())


async def can_open(db: AsyncIOMotorDatabase, user_row: dict | None, doc: dict | None) -> bool:
    """Whether this account may read ``doc`` right now (no password: a page
    behind one counts as closed to them)."""
    from app.services import access

    if user_row is None or doc is None:
        return False
    d = await access.can(access.Actor.of(_as_user(user_row)), doc, "read", access.Ctx(db))
    return bool(d.allowed)


async def _load_doc(db: AsyncIOMotorDatabase, doc: Any) -> dict | None:
    if isinstance(doc, dict):
        return doc
    if isinstance(doc, ObjectId):
        return await db["documents"].find_one({"_id": doc})
    if isinstance(doc, str):
        if ObjectId.is_valid(doc):
            row = await db["documents"].find_one({"_id": ObjectId(doc)})
            if row is not None:
                return row
        return await db["documents"].find_one({"slug": doc})
    return None


def _clean_extra(extra: dict | None) -> dict:
    from app.services import mailer

    out: dict = {}
    for key, limit in (("label", 120), ("excerpt", 200), ("message", 500), ("role", 20)):
        v = (extra or {}).get(key)
        if isinstance(v, str) and v.strip():
            out[key] = v.strip()[:limit] if key == "message" else mailer._one_line(v, limit)
    return out


# ── notify ────────────────────────────────────────────────────────────────────


async def notify(db: AsyncIOMotorDatabase, user_id: str, kind: str, doc: Any, block_id: str | None = None,
                 actor: Any = None, extra: dict | None = None) -> dict | None:
    """Tell ``user_id`` that ``actor`` did ``kind`` on ``doc`` (a documents row,
    or its id / slug), at ``block_id`` (``b-…``, or None for the page).

    ``extra``: ``label`` (a sign-off's label), ``excerpt`` (the line, plain
    text), ``message`` (a share's note), ``role``. Returns the new row, or None
    when nobody is notified: the recipient has no account, is the actor, can't
    open the page, the actor isn't signed in, the page is encrypted, or the same
    notification was made in the last 24 hours. Never raises for those."""
    if kind not in KINDS:
        raise ValueError(f"unknown notification kind {kind!r}")
    actor_id, actor_name = _actor_info(actor)
    user_id = str(user_id or "")
    if not actor_id or not user_id or user_id == actor_id:
        return None
    raw = await _load_doc(db, doc)
    if raw is None or raw.get("encrypted"):
        return None
    recipient = await _user_row(db, user_id)
    if recipient is None or not await can_open(db, recipient, raw):
        return None
    block = block_id if isinstance(block_id, str) and _ANCHOR.match(block_id) else None
    doc_id = str(raw["_id"])
    now = _now()
    if kind != "shared":
        same = {"user_id": user_id, "kind": kind, "doc_id": doc_id, "block_id": block,
                "created_at": {"$gt": now - DEDUPE}}
        dup = await db[COLL].find_one(same, {"_id": 1}) or await db[WITHDRAWN].find_one(same, {"_id": 1})
        if dup is not None:
            return None
    if actor_name is None:
        actor_name = _actor_info(await _user_row(db, actor_id) or {"_id": actor_id})[1]
    row = {
        "user_id": user_id, "kind": kind, "doc_id": doc_id, "block_id": block,
        "actor_id": actor_id, "actor_name": (actor_name or "Someone")[:80], "via": _via(actor),
        "extra": _clean_extra(extra), "created_at": now, "read_at": None,
        "email": "pending" if kind in EMAIL_KINDS and wants_email(recipient, kind) else "off",
        "email_at": now + GATHER, "emailed_at": None,
    }
    res = await db[COLL].insert_one(row)
    row["_id"] = res.inserted_id
    # A direct message in Slack too, for a linked account that wants this kind (services/slack_notify).
    from app.services import slack_notify

    await slack_notify.queue_notification(db, row)
    # And a push notification on their devices (services/push).
    from app.services import push

    await push.queue_notification(db, row)
    return row


# ── Mentions in a page's Markdown ─────────────────────────────────────────────


_SIGNOFF = re.compile(r"^ {0,3}:{3,}signoff\{([^}\n]*)\}")
_LINE_ATTRS = re.compile(r"\{([^{}\n]*)\}[ \t]*$")
_BLOCK_START = re.compile(r"^ {0,3}(?:[-*+] |\d+[.)] |#{1,6}(?:\s|$)|>|`{3,}|~{3,}|:{2,}|\||!\[)")
_CONTAINER_OPEN = re.compile(r"^ {0,3}(:{3,})[A-Za-z][\w-]*(?:\[[^\]\n]*\])?(?:\{([^}\n]*)\})?\s*$")
_CONTAINER_CLOSE = re.compile(r"^ {0,3}(:{3,})\s*$")


def _anchor_of(attrs: str | None) -> str | None:
    m = _ANCHOR_IN.search(attrs or "")
    return m.group(1) if m else None


def _line_anchor(line: str) -> str | None:
    m = _LINE_ATTRS.search(line)
    return _anchor_of(m.group(1)) if m else None


def _plain(line: str) -> str:
    """One line of page Markdown as a short plain sentence (for an excerpt)."""
    from app.services import pages

    s = pages._PERSON.sub(lambda m: "@" + (m.group(1) or "someone"), line)
    s = _LINE_ATTRS.sub("", s)
    s = re.sub(r"^ {0,3}(?:[-*+] |\d+[.)] |#{1,6}\s+|>\s?)+", "", s)
    s = re.sub(r"^\[[ xX]\]\s+", "", s)
    s = re.sub(r":[a-z]+\[((?:\\.|[^\]\\\n])*)\]\{[^}\n]*\}", r"\1", s)
    s = re.sub(r"!?\[([^\]\n]*)\]\([^)\n]*\)", r"\1", s)
    s = re.sub(r"[*_`~]{1,3}", "", s)
    return " ".join(s.split())[:200]


def mentions(markdown: str | None) -> list[dict]:
    """Every person mention (kind ``mention``) and sign-off block
    (``signoff_requested``) outside code, in order: ``{kind, user, block,
    line, label}``. ``block``: the anchor of the block it's in — its own
    line's ``{#b-…}``, the end of its paragraph, else the container around it."""
    from app.services import page_people, pages

    text = markdown or ""
    if ":person[" not in text and "signoff" not in text:
        return []
    lines = text.split("\n")
    out: list[dict] = []
    fence: str | None = None
    stack: list[tuple[int, str | None]] = []  # open ::: containers: (colons, anchor)
    for i, line in enumerate(lines):
        f = pages._FENCE.match(line)
        if f:
            mark = f.group(1)[0]
            fence = mark if fence is None else (None if mark == fence else fence)
            continue
        if fence is not None:
            continue
        so = _SIGNOFF.match(line)
        if so:
            attrs = so.group(1)
            vals = {a.group(1): pages._unescape(a.group(3) if a.group(3) is not None else
                                                (a.group(4) if a.group(4) is not None else a.group(5)) or "")
                    for a in pages._ATTR.finditer(attrs)}
            pid = (vals.get("person") or "").strip()
            if ObjectId.is_valid(pid):
                out.append({"kind": "signoff_requested", "user": pid, "block": _anchor_of(attrs),
                            "label": (vals.get("label") or "").strip()[:120] or None, "line": None})
        close = _CONTAINER_CLOSE.match(line)
        if close and stack:
            stack.pop()
            continue
        opened = _CONTAINER_OPEN.match(line)
        if opened:
            stack.append((len(opened.group(1)), _anchor_of(opened.group(2))))
            continue
        if ":person[" not in line:
            continue
        clean = page_people._CODE_SPAN.sub("", line)
        for m in pages._PERSON.finditer(clean):
            pid = (pages._person_id(m.group(2)) or "").strip()
            if not ObjectId.is_valid(pid):
                continue
            block = _line_anchor(line)
            j = i
            while block is None and j + 1 < len(lines) and lines[j + 1].strip() \
                    and not _BLOCK_START.match(lines[j + 1]) and not _BLOCK_START.match(lines[i]):
                j += 1
                block = _line_anchor(lines[j])
            if block is None:
                block = next((a for _, a in reversed(stack) if a), None)
            out.append({"kind": "mention", "user": pid, "block": block, "line": line, "label": None})
    return out


def new_mentions(before: str | None, after: str | None) -> list[dict]:
    """The mentions in ``after`` that weren't in ``before``: one per (kind,
    person, block) that occurs more often now — and only for a person named
    more often now than before, so a mention that moved, or whose block got
    an anchor, isn't news."""
    from collections import Counter

    old, new = mentions(before), mentions(after)
    per_old = Counter((m["kind"], m["user"]) for m in old)
    per_new = Counter((m["kind"], m["user"]) for m in new)
    at_old = Counter((m["kind"], m["user"], m["block"]) for m in old)
    at_new = Counter((m["kind"], m["user"], m["block"]) for m in new)
    out, seen = [], set()
    for m in new:
        key = (m["kind"], m["user"], m["block"])
        if key in seen or at_new[key] <= at_old[key] or per_new[key[:2]] <= per_old[key[:2]]:
            continue
        seen.add(key)
        out.append(m)
    return out


def removed_mentions(before: str | None, after: str | None) -> list[dict]:
    """:func:`new_mentions`' counterpart: the mentions in ``before`` that ``after`` took away, one per
    (kind, person, block): the person is named fewer times now, and fewer times at that block (a
    mention that only moved, or whose block got an anchor, isn't removed). ``gone`` is True when the
    person isn't named on the page at all any more (then every block of theirs counts)."""
    from collections import Counter

    old, new = mentions(before), mentions(after)
    if not old:
        return []
    per_old = Counter((m["kind"], m["user"]) for m in old)
    per_new = Counter((m["kind"], m["user"]) for m in new)
    at_old = Counter((m["kind"], m["user"], m["block"]) for m in old)
    at_new = Counter((m["kind"], m["user"], m["block"]) for m in new)
    out, seen = [], set()
    for m in old:
        key = (m["kind"], m["user"], m["block"])
        if key in seen or per_new[key[:2]] >= per_old[key[:2]] or (per_new[key[:2]] and at_new[key] >= at_old[key]):
            continue
        seen.add(key)
        out.append({"kind": m["kind"], "user": m["user"], "block": m["block"], "gone": not per_new[key[:2]]})
    return out


def named_on(markdown: str | None) -> set[tuple[str, str]]:
    """``(kind, person)`` for every mention and sign-off request on the page now: what a pending
    email or push re-checks at send time (a mention taken out meanwhile is "withdrawn")."""
    return {(m["kind"], m["user"]) for m in mentions(markdown)}


def still_there(row: dict, named: set[tuple[str, str]]) -> bool:
    """A mention / sign-off request still on the page (``named``: :func:`named_on` of its content).
    Other kinds (a share) always are."""
    return row.get("kind") not in EMAIL_KINDS or (row["kind"], row.get("user_id")) in named


async def withdraw(db: AsyncIOMotorDatabase, doc_id: str, removed: list[dict]) -> int:
    """A save took these mentions out (:func:`removed_mentions`): their *unread* notifications for this
    page go. The bell entry is removed and a pending email, push or Slack message is dropped (outcome
    "withdrawn"); an email or push already delivered can't be recalled, but a row delivered somewhere
    leaves a tombstone so putting the mention back within a day doesn't ring again. A read row stays.
    Returns how many rows went. Never raises."""
    from app.services import push, slack_notify

    try:
        ids: list = []
        for m in removed[:MAX_PER_SAVE]:
            q: dict = {"user_id": m["user"], "kind": m["kind"], "doc_id": str(doc_id), "read_at": None}
            if not m.get("gone"):
                q["block_id"] = m["block"]
            ids += [r["_id"] async for r in db[COLL].find(q, {"_id": 1})]
        if not ids:
            return 0
        rows = await db[COLL].find({"_id": {"$in": ids}}).to_list(length=len(ids))
        refs = [str(i) for i in ids]
        delivered = {r["ref"] async for r in db[push.OUTBOX].find({"ref": {"$in": refs}, "state": "sent"}, {"ref": 1})}
        delivered |= {r["ref"] async for r in db[slack_notify.OUTBOX].find({"ref": {"$in": refs}, "state": "sent"},
                                                                         {"ref": 1})}
        stones = [{k: r.get(k) for k in ("user_id", "kind", "doc_id", "block_id", "created_at")}
                  | {"withdrawn_at": _now()}
                  for r in rows if r.get("email") == "sent" or str(r["_id"]) in delivered]
        if stones:
            await db[WITHDRAWN].insert_many(stones)
        res = await db[COLL].delete_many({"_id": {"$in": ids}, "read_at": None})
        await db[push.OUTBOX].update_many({"ref": {"$in": refs}, "state": "pending"},
                                          {"$set": {"state": "skipped", "outcome": "withdrawn", "done_at": _now()}})
        await db[slack_notify.OUTBOX].update_many({"ref": {"$in": refs}, "state": "pending"},
                                                  {"$set": {"state": "skipped", "error": "withdrawn", "done_at": _now()}})
        return res.deleted_count
    except Exception:
        log.warning("notifications: withdrawing on %s failed", doc_id, exc_info=True)
        return 0


async def _excerpt_for(db: AsyncIOMotorDatabase, user_id: str, page: dict, line: str | None) -> str | None:
    """The mention's line as this recipient may read it: other people's names
    emptied outside the page's circle, and the labels of items they can't open
    (pages.content_for's rules), then plain text."""
    from app.services import access, pages

    if not line:
        return None
    row = await _user_row(db, user_id)
    if row is None:
        return None
    actor, ctx = access.Actor.of(_as_user(row)), access.Ctx(db)
    if not await pages.sees_people(actor, page, ctx):
        # Other people's names are emptied for a reader outside the page's circle; their own stays.
        line = pages._PERSON.sub(lambda m: m.group(0) if pages._person_id(m.group(2)) == user_id
                                 else f":person[]{{{m.group(2)}}}", line)
    if "markdrop" in line:
        line = await pages.redact_refs(actor, ctx, line)
    return _plain(line) or None


_quiet: ContextVar[bool] = ContextVar("notifications_quiet", default=False)


@contextmanager
def quiet() -> Iterator[None]:
    """Writes inside this (and tasks spawned from it) notify nobody: history being imported (a past
    meeting's @mentions stay links; services/meetings.py ``notify=False``)."""
    token = _quiet.set(True)
    try:
        yield
    finally:
        _quiet.reset(token)


def is_quiet() -> bool:
    return _quiet.get()


async def on_page_saved(db: AsyncIOMotorDatabase, before: dict | None, after: dict | None, actor: Any) -> int:
    """After a write of a page: withdraw what the save took out (:func:`withdraw`, even inside
    :func:`quiet`), then notify each person newly mentioned (or newly named on a sign-off block).
    Returns how many were notified. Never raises. Nobody is notified inside :func:`quiet`."""
    try:
        if before and after and "content" in after and after.get("kind") != "artifact":
            gone = removed_mentions(before.get("content"), after.get("content"))
            if gone:
                await withdraw(db, str(after["_id"]), gone)
    except Exception:
        log.warning("notifications: withdrawing failed", exc_info=True)
    if _quiet.get():
        return 0
    try:
        if not after or after.get("encrypted") or after.get("kind") == "artifact" \
                or after.get("editor") != "blocks":
            return 0
        fresh = new_mentions((before or {}).get("content"), after.get("content"))[:MAX_PER_SAVE]
        sent = 0
        for m in fresh:
            extra = {"excerpt": await _excerpt_for(db, m["user"], after, m.get("line")), "label": m.get("label")}
            if await notify(db, m["user"], m["kind"], after, m.get("block"), actor, extra):
                sent += 1
        return sent
    except Exception:
        log.warning("notifications: page save hook failed", exc_info=True)
        return 0


# ── Reading them ──────────────────────────────────────────────────────────────


def _sentence(kind: str, actor: str, title: str | None, label: str | None) -> str:
    where = f"“{title}”" if title else "a page you can't open"
    if kind == "signoff_requested":
        what = f"“{label}”" if (label and title) else "a sign-off"
        return f"{actor} asked you to sign off on {what}" + (f" in {where}" if title else f" on {where}")
    if kind == "shared":
        return f"{actor} shared {where} with you" if title else f"{actor} shared a page with you that you can't open now"
    return f"{actor} mentioned you in {where}" if title else f"{actor} mentioned you on {where}"


async def _pictures(db: AsyncIOMotorDatabase, ids: set[str]) -> dict[str, str | None]:
    oids = [ObjectId(i) for i in ids if i and ObjectId.is_valid(i)]
    if not oids:
        return {}
    return {str(u["_id"]): u.get("picture") async for u in db["users"].find({"_id": {"$in": oids}}, {"picture": 1})}


async def _view(db: AsyncIOMotorDatabase, rows: list[dict], user_row: dict) -> list[dict]:
    """Rows as the reader may see them now (title, link and text only for pages
    they can open)."""
    from app.services import md_outline, urls

    ids = list({r["doc_id"] for r in rows if ObjectId.is_valid(r.get("doc_id") or "")})
    docs = {str(d["_id"]): d async for d in db["documents"].find(
        {"_id": {"$in": [ObjectId(i) for i in ids]}})} if ids else {}
    readable: dict[str, bool] = {}
    for i, d in docs.items():
        readable[i] = await can_open(db, user_row, d)
    pics = await _pictures(db, {r.get("actor_id") or "" for r in rows})
    out = []
    for r in rows:
        d = docs.get(r["doc_id"])
        ok = bool(d is not None and readable.get(r["doc_id"]))
        title = md_outline.display_title(d) if ok else None
        extra = r.get("extra") or {}
        block = r.get("block_id") if ok else None
        href = (f"/{d['slug']}" + (f"#{block}" if block else "")) if ok else None
        actor = r.get("actor_name") or "Someone"
        page_meta = {"slug": d["slug"], "title": title} if ok else None
        out.append({
            "id": str(r["_id"]), "kind": r["kind"], "read": r.get("read_at") is not None,
            "created_at": _aware(r["created_at"]).isoformat(),
            "actor": {"id": r.get("actor_id"), "name": actor, "picture": pics.get(r.get("actor_id") or "")},
            "via_ai": r.get("via") == "mcp",
            "text": _sentence(r["kind"], actor, title, extra.get("label") if ok else None),
            "available": ok, "page": page_meta, "block": block, "href": href,
            "url": (urls.markdrop_url(d["slug"]) + (f"#{block}" if block else "")) if ok else None,
            "excerpt": extra.get("excerpt") if ok else None,
            "label": extra.get("label") if ok else None,
            "message": extra.get("message") if ok else None,
        })
    return out


async def unread_count(db: AsyncIOMotorDatabase, user_id: str) -> int:
    return await db[COLL].count_documents({"user_id": str(user_id), "read_at": None})


async def listing(db: AsyncIOMotorDatabase, user_id: str, *, unread_only: bool = False, limit: int = 30,
                  before: str | None = None) -> dict:
    """Newest first: ``{items, unread_count, next_before}``. ``before``: a
    notification id to continue after."""
    user_row = await _user_row(db, user_id)
    if user_row is None:
        return {"items": [], "unread_count": 0, "next_before": None}
    limit = max(1, min(int(limit or 30), LIST_MAX))
    q: dict = {"user_id": str(user_id)}
    if unread_only:
        q["read_at"] = None
    if before and ObjectId.is_valid(before):
        q["_id"] = {"$lt": ObjectId(before)}
    rows = await db[COLL].find(q).sort([("_id", -1)]).limit(limit + 1).to_list(length=limit + 1)
    more = len(rows) > limit
    rows = rows[:limit]
    return {"items": await _view(db, rows, user_row), "unread_count": await unread_count(db, user_id),
            "next_before": str(rows[-1]["_id"]) if more and rows else None}


def _oids(ids: list[str] | None) -> list[ObjectId]:
    return [ObjectId(i) for i in (ids or []) if isinstance(i, str) and ObjectId.is_valid(i)]


async def mark_read(db: AsyncIOMotorDatabase, user_id: str, ids: list[str] | None = None,
                    all_: bool = False) -> int:
    """Mark the reader's own notifications read (``ids``, or every one). Returns
    how many changed."""
    q: dict = {"user_id": str(user_id), "read_at": None}
    if not all_:
        oids = _oids(ids)
        if not oids:
            return 0
        q["_id"] = {"$in": oids[:LIST_MAX]}
    res = await db[COLL].update_many(q, {"$set": {"read_at": _now()}})
    return res.modified_count


async def open_one(db: AsyncIOMotorDatabase, user_id: str, notification_id: str) -> dict:
    """Clicking a notification: marks it read and returns ``{href, slug,
    block}`` when the reader can open the page *now*; 404 for someone else's or
    an unknown id, 403 when the page is closed to them (or gone)."""
    if not ObjectId.is_valid(notification_id or ""):
        raise HTTPException(status_code=404, detail="That notification doesn't exist.")
    row = await db[COLL].find_one({"_id": ObjectId(notification_id), "user_id": str(user_id)})
    if row is None:
        raise HTTPException(status_code=404, detail="That notification doesn't exist.")
    if row.get("read_at") is None:
        await db[COLL].update_one({"_id": row["_id"]}, {"$set": {"read_at": _now()}})
    user_row = await _user_row(db, user_id)
    doc = await db["documents"].find_one({"_id": ObjectId(row["doc_id"])}) if ObjectId.is_valid(row["doc_id"]) else None
    if doc is None or not await can_open(db, user_row, doc):
        raise HTTPException(status_code=403, detail="You can't open that page any more.")
    block = row.get("block_id")
    return {"href": f"/{doc['slug']}" + (f"#{block}" if block else ""), "slug": doc["slug"], "block": block}


# ── Email ─────────────────────────────────────────────────────────────────────
#
# Email calm (owner, 2026-11-06): the app and push come first, then email, and never a flood.
# Each person picks, for mentions and for sign-off requests separately (users.email_notify):
# Instant, Hourly bundle (mentions' default), Daily digest (08:00 their time) or Off (sign-off
# requests default to Instant). At most DAILY_CAP of these emails a day; past it, what's left waits
# for one catch-up email the next morning. Every email carries "Email me less" (one step down)
# and the turn-off link.

MODES = ("instant", "hourly", "daily", "off")
DEFAULT_MODES = {"mention": "hourly", "signoff_requested": "instant"}
MODE_LABELS = {"instant": "Instant", "hourly": "Hourly bundle", "daily": "Daily digest", "off": "Off"}
KIND_LABELS = {"mention": "Mentions", "signoff_requested": "Sign-off requests"}
_SHORT = {"mention": "m", "signoff_requested": "s"}
# How long an email waits for the app or a push to reach the person first ("App/push first").
WINDOW = {"mention": timedelta(minutes=30), "signoff_requested": timedelta(minutes=10)}
BUNDLE_GAP = timedelta(hours=1)      # at most one hourly bundle an hour
BUNDLE_WAIT = timedelta(minutes=30)  # a bundle goes once its oldest item has waited this long
DIGEST_HOUR = 8                      # the daily digest and the catch-up, local time
DAILY_CAP = 3                        # notification emails per person per (local) day
STALE = timedelta(days=3)            # a row still waiting after this is dropped ("stale")
SEEN_EVERY = timedelta(seconds=30)   # how often the bell's poll may write users.app_seen_at
RECHECK = timedelta(minutes=1)
DAYS = "notification_email_days"     # {_id: "<user>:<local date>", n, over, at}: the daily cap
LESS_PATH = "/api/v1/me/emails/less"
MAX_PAGES = 20
MAX_PER_PAGE = 5
FLUSH_PEOPLE = 200
_TZ = re.compile(r"^[A-Za-z][A-Za-z0-9_+\-]*(?:/[A-Za-z0-9_+\-]+){0,2}$")


def email_modes(user_row: dict | None) -> dict[str, str]:
    """``{mention, signoff_requested}`` → instant | hourly | daily | off. Someone who turned the old
    "Email me when someone mentions me" off (``mention_emails: False``) and never chose since has
    both off."""
    saved = (user_row or {}).get("email_notify") or {}
    legacy_off = (user_row or {}).get("mention_emails") is False and not saved
    return {k: saved.get(k) if saved.get(k) in MODES else ("off" if legacy_off else DEFAULT_MODES[k])
            for k in EMAIL_KINDS}


def step_down(mode: str) -> str:
    """Instant → Hourly bundle → Daily digest → Off."""
    return MODES[min(MODES.index(mode) + 1, len(MODES) - 1)] if mode in MODES else "off"


def valid_tz(tz: Any) -> str | None:
    if not isinstance(tz, str) or not 0 < len(tz) <= 64 or not _TZ.match(tz):
        return None
    try:
        ZoneInfo(tz)
    except Exception:
        return None
    return tz


def _zone(user_row: dict | None) -> ZoneInfo:
    tz = valid_tz((user_row or {}).get("email_tz"))
    return ZoneInfo(tz) if tz else ZoneInfo("UTC")


def wants_email(user_row: dict | None, kind: str | None = None) -> bool:
    """The person can get notification email at all (an address, not unsubscribed from Markdrop
    email) and, with ``kind``, hasn't turned that kind's email off (any kind, without)."""
    if not (user_row and user_row.get("email") and not user_row.get("unsubscribed_at")):
        return False
    modes = email_modes(user_row)
    return modes.get(kind, "off") != "off" if kind else any(m != "off" for m in modes.values())


async def set_modes(db: AsyncIOMotorDatabase, user_id: str, changes: dict[str, str]) -> dict[str, str] | None:
    """Change how often email comes, per kind. Returns the new modes (None: no such person). A kind
    turned off drops what was waiting; every other waiting row is looked at again at once."""
    if not ObjectId.is_valid(user_id or ""):
        return None
    row = await db["users"].find_one({"_id": ObjectId(user_id)}, {"email_notify": 1, "mention_emails": 1})
    if row is None:
        return None
    modes = email_modes(row) | {k: v for k, v in (changes or {}).items() if k in EMAIL_KINDS and v in MODES}
    now = _now()
    await db["users"].update_one({"_id": ObjectId(user_id)}, {"$set": {
        "email_notify": modes, "mention_emails": any(m != "off" for m in modes.values()),
        "mention_emails_at": now}})
    off = [k for k, m in modes.items() if m == "off"]
    if off:
        await db[COLL].update_many({"user_id": str(user_id), "email": "pending", "kind": {"$in": off}},
                                   {"$set": {"email": "off"}})
    await db[COLL].update_many({"user_id": str(user_id), "email": "pending"}, {"$set": {"email_at": now}})
    return modes


async def set_preference(db: AsyncIOMotorDatabase, user_id: str, on: bool) -> bool:
    """The old on/off switch (and the turn-off link): off turns both kinds off; on turns each kind
    that's off back to its default."""
    row = await db["users"].find_one({"_id": ObjectId(user_id)}, {"email_notify": 1, "mention_emails": 1}) \
        if ObjectId.is_valid(user_id or "") else None
    if row is None:
        return False
    modes = email_modes(row)
    changes = {k: ("off" if not on else (m if m != "off" else DEFAULT_MODES[k])) for k, m in modes.items()}
    return await set_modes(db, user_id, changes) is not None


async def saw_app(db: AsyncIOMotorDatabase, user_id: str, tz: str | None = None) -> None:
    """The app showed this person the bell (its unread count is polled only while a tab is
    visible): what came before it doesn't need an email ("seen"). Also keeps their timezone for the
    daily digest. At most one write every ``SEEN_EVERY`` (unless the timezone changed). Never raises."""
    try:
        if not ObjectId.is_valid(user_id or ""):
            return
        now = _now()
        sets: dict = {"app_seen_at": now}
        when: list[dict] = [{"app_seen_at": {"$lt": now - SEEN_EVERY}}, {"app_seen_at": None}]
        zone = valid_tz(tz)
        if zone:
            sets["email_tz"] = zone
            when.append({"email_tz": {"$ne": zone}})
        await db["users"].update_one({"_id": ObjectId(user_id), "$or": when}, {"$set": sets})
    except Exception:
        log.warning("notifications: saw_app failed", exc_info=True)


def off_token(user_id: str) -> str:
    sig = hmac.new(settings.auth_secret.encode(), f"mentions:{user_id}".encode(), hashlib.sha256).hexdigest()[:32]
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


# "Email me less": one signed link per email, no sign-in. It names each kind in the email and the
# setting it had when the email went ("m1-s0": mentions were Hourly, sign-offs Instant), so a second
# click (or an old email) never lowers anything twice.


def _less_sig(payload: str) -> str:
    return hmac.new(settings.auth_secret.encode(), f"email-less:{payload}".encode(), hashlib.sha256).hexdigest()[:32]


def less_token(user_id: str, steps: dict[str, str]) -> str:
    spec = "-".join(f"{_SHORT[k]}{MODES.index(m)}" for k, m in sorted(steps.items()) if k in _SHORT and m in MODES)
    payload = f"{user_id}.{spec}"
    return f"{payload}.{_less_sig(payload)}"


def verify_less_token(token: str | None) -> tuple[str, dict[str, str]] | None:
    try:
        user_id, spec, sig = (token or "").split(".")
    except ValueError:
        return None
    if not ObjectId.is_valid(user_id) or not spec or \
            not hmac.compare_digest(sig.encode(), _less_sig(f"{user_id}.{spec}").encode()):
        return None
    kinds = {v: k for k, v in _SHORT.items()}
    steps: dict[str, str] = {}
    for part in spec.split("-"):
        if len(part) != 2 or part[0] not in kinds or not part[1].isdigit() or int(part[1]) >= len(MODES):
            return None
        steps[kinds[part[0]]] = MODES[int(part[1])]
    return user_id, steps


def less_url(user_id: str, steps: dict[str, str]) -> str | None:
    steps = {k: m for k, m in steps.items() if m != "off"}
    if not steps:
        return None
    return f"{settings.api_base_url.rstrip('/')}{LESS_PATH}?t={less_token(user_id, steps)}"


async def email_less(db: AsyncIOMotorDatabase, user_id: str, steps: dict[str, str]) -> tuple[dict[str, str], dict[str, str]]:
    """Apply an "Email me less" link: each kind still at the setting the email was sent with goes one
    step down. Returns (what changed, every kind's setting now)."""
    row = await db["users"].find_one({"_id": ObjectId(user_id)}, {"email_notify": 1, "mention_emails": 1})
    modes = email_modes(row)
    changes = {k: step_down(m) for k, m in steps.items() if k in modes and modes[k] == m and m != "off"}
    if changes:
        modes = await set_modes(db, user_id, changes) or modes
    return changes, modes


def _e(s: Any) -> str:
    return html.escape(str(s), quote=True)


def _item_html(i: dict, page_url: str) -> str:
    from app.services import mailer

    S, INK, BODY, LINE = mailer._SANS, mailer._INK, mailer._BODY, mailer._LINE
    if i["kind"] == "signoff_requested":
        what = f"asked you to sign off on {mailer._strong(_e(i.get('label') or 'a sign-off'))}"
    else:
        what = "mentioned you"
    quote = (f'<div style="font-family:{S};font-size:14px;line-height:1.55;color:{BODY};margin-top:4px">'
             f"{_e(i['excerpt'])}</div>") if i.get("excerpt") else ""
    link = f"{page_url}#{i['block']}" if i.get("block") else page_url
    return ('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
            f'style="margin:0 0 10px"><tr><td style="border:1px solid {LINE};border-radius:8px;padding:12px 14px">'
            f'<div style="font-family:{S};font-size:14px;line-height:20px;color:{INK}">'
            f"{mailer._strong(_e(i['actor']))} {what}</div>{quote}"
            f'<div style="font-family:{S};font-size:12px;line-height:18px;margin-top:6px">'
            f'<a href="{_e(link)}" style="color:{mailer._ACCENT};text-decoration:none;font-weight:600">'
            "Go to the block</a></div></td></tr></table>")


def _item_text(i: dict) -> str:
    verb = (f"asked you to sign off on {i.get('label') or 'a sign-off'}" if i["kind"] == "signoff_requested"
            else "mentioned you")
    return f"- {i['actor']} {verb}" + (f": {i['excerpt']}" if i.get("excerpt") else "")


WHY = {
    "instant": "You get this when someone mentions you or asks for your sign-off on Markdrop, at most once "
               "every 10 minutes per page, unless you saw it in the app first",
    "hourly": "You get at most one email an hour with what's new for you on Markdrop, unless you saw it in "
              "the app first",
    "daily": "You get one email a day, in the morning, with what's new for you on Markdrop",
    "catchup": f"Markdrop sends at most {DAILY_CAP} of these emails a day, so these waited for this morning",
}


def _footer(user_id: str, why: str, less: str | None) -> tuple[str, list[str]]:
    from app.services import mailer

    off = off_url(user_id)
    links = []
    if less:
        links.append(mailer._footer_link(_e(less), "Email me less"))
    links += [mailer._footer_link(_e(off), "Turn off these emails"),
              mailer._footer_link(_e(mailer._base() + "/settings/account#email"), "Email settings")]
    text = ([f"Email me less: {less}"] if less else []) + [f"Turn off these emails: {off}"]
    return f"{_e(why)}. " + " &middot; ".join(links), text


def compose_email(*, user_id: str, title: str, page_url: str, items: list[dict], more: int = 0,
                  why: str | None = None, less: str | None = None) -> dict:
    """``{subject, html, text}`` for one person about one page. ``items``:
    ``[{kind, actor, block, excerpt, label}]`` (oldest first). ``less``: the "Email me less" link."""
    from app.services import mailer

    n = len(items) + more
    first = items[0]
    kinds = {i["kind"] for i in items}
    if n == 1 and first["kind"] == "signoff_requested":
        head = f"{first['actor']} asked you to sign off on “{first.get('label') or title}”"
        eyebrow = "Sign-off requested"
    elif n == 1:
        head = f"{first['actor']} mentioned you in “{title}”"
        eyebrow = "Mentioned"
    elif kinds == {"mention"}:
        head = f"You were mentioned {n} times in “{title}”"
        eyebrow = "Mentions"
    else:
        head = f"{n} updates for you in “{title}”"
        eyebrow = "Mentions"
    subject = mailer._one_line(head, 150)
    target = f"{page_url}#{first['block']}" if (n == 1 and first.get("block")) else page_url
    more_html = mailer._p(f"And {more} more on this page.", size=13, color=mailer._MUTED) if more else ""
    content = (mailer._eyebrow(eyebrow) + mailer._heading(_e(head))
               + "".join(_item_html(i, page_url) for i in items) + more_html
               + mailer._button(_e(target), "Open the page", margin="14px 0 20px"))
    footer, foot_text = _footer(user_id, why or WHY["instant"], less)
    html_out = mailer._shell(title=_e(head), preheader=_e(head + "."), content=content, footer=footer)
    text = [head, ""] + [_item_text(i) for i in items]
    if more:
        text.append(f"And {more} more on this page.")
    text += ["", f"Open the page: {target}", ""] + foot_text
    return {"subject": subject, "html": html_out, "text": "\n".join(text)}


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def digest_head(pages: list[dict]) -> str:
    """"You were mentioned in 4 pages", "2 sign-off requests are waiting for you", or both."""
    mentioned = sum(1 for p in pages if any(i["kind"] == "mention" for i in p["items"]))
    signoffs = sum(sum(1 for i in p["items"] if i["kind"] == "signoff_requested") + p.get("more_signoffs", 0)
                   for p in pages)
    if mentioned and signoffs:
        return (f"You were mentioned in {_plural(mentioned, 'page')} and asked for "
                f"{_plural(signoffs, 'sign-off')}")
    if signoffs:
        return (f"{_plural(signoffs, 'sign-off request')} "
                f"{'is' if signoffs == 1 else 'are'} waiting for you")
    return f"You were mentioned in {_plural(mentioned, 'page')}"


def compose_digest(*, user_id: str, pages: list[dict], mode: str, more_pages: int = 0,
                   catchup: bool = False, less: str | None = None) -> dict:
    """``{subject, html, text}``: the hourly bundle, the daily digest or the morning catch-up for one
    person. ``pages``: ``[{title, url, items, more}]`` (oldest first; ``items`` as
    :func:`compose_email`'s); ``mode``: hourly | daily | catchup."""
    from app.services import mailer

    head = digest_head(pages)
    if more_pages:
        head += f" (and {_plural(more_pages, 'more page')})"
    lead = {"hourly": "", "daily": "Daily digest: ", "catchup": "Catching up: "}[mode]
    subject = mailer._one_line(lead + (head[0].lower() + head[1:] if lead and head.startswith("You ") else head), 150)
    eyebrow = {"hourly": "This past hour", "daily": "Daily digest", "catchup": "Catching up"}[mode]
    S, INK, LINE = mailer._SANS, mailer._INK, mailer._LINE
    intro = ""
    if mode == "catchup" or catchup:
        intro = mailer._p(f"You'd had {DAILY_CAP} notification emails that day, so these waited for this morning.",
                          size=14)
    parts = []
    text = [head, ""]
    for p in pages:
        title_html = (f'<a href="{_e(p["url"])}" style="color:{INK};text-decoration:none">{_e(p["title"])}</a>')
        parts.append(f'<div style="font-family:{S};font-size:16px;line-height:24px;font-weight:700;color:{INK};'
                     f'margin:18px 0 8px;padding-top:14px;border-top:1px solid {LINE}">{title_html}</div>')
        parts += [_item_html(i, p["url"]) for i in p["items"]]
        if p.get("more"):
            parts.append(mailer._p(f"And {p['more']} more on this page.", size=13, color=mailer._MUTED,
                                   margin="0 0 8px"))
        text.append(f"{p['title']} — {p['url']}")
        text += [_item_text(i) for i in p["items"]]
        if p.get("more"):
            text.append(f"And {p['more']} more on this page.")
        text.append("")
    if more_pages:
        parts.append(mailer._p(f"And {_plural(more_pages, 'more page')}: see them under the bell in Markdrop.",
                               size=13, color=mailer._MUTED))
        text += [f"And {_plural(more_pages, 'more page')}: see them under the bell in Markdrop.", ""]
    content = (mailer._eyebrow(eyebrow) + mailer._heading(_e(head)) + intro + "".join(parts)
               + mailer._button(_e(mailer._base() + "/dashboard"), "Open Markdrop", margin="18px 0 20px"))
    footer, foot_text = _footer(user_id, WHY[mode], less)
    html_out = mailer._shell(title=_e(head), preheader=_e(head + "."), content=content, footer=footer)
    return {"subject": subject, "html": html_out, "text": "\n".join(text + foot_text)}


async def _send(user_row: dict, mail: dict, *, kind: str = "mention", ref: str | None = None) -> None:
    from app.services import mailer

    off = off_url(str(user_row["_id"]))
    await mailer._post({
        "from": mailer._sender("share"),
        "to": [user_row["email"]],
        "subject": mail["subject"],
        "reply_to": settings.email_reply_to,
        "html": mail["html"],
        "text": mail["text"],
        "headers": {"List-Unsubscribe": f"<{off}>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"},
    }, kind=kind, ref=ref)


async def _claim(db: AsyncIOMotorDatabase, user_id: str, doc_id: str, now: datetime) -> bool:
    """The 10-minute rule: True (and the slot is taken) when no email about
    this page went to this person in the last 10 minutes."""
    return await _claim_key(db, f"{user_id}:{doc_id}", now, EMAIL_GAP, {"user_id": user_id, "doc_id": doc_id})


async def _claim_key(db: AsyncIOMotorDatabase, key: str, now: datetime, gap: timedelta | None,
                     extra: dict | None = None) -> bool:
    """Take ``key`` in the email log when it was last taken ``gap`` ago or more (``None``: never)."""
    when: list[dict] = [{"sent_at": {"$exists": False}}]
    if gap is not None:
        when.append({"sent_at": {"$lte": now - gap}})
    try:
        await db[EMAIL_LOG].find_one_and_update({"_id": key, "$or": when},
                                                {"$set": {"sent_at": now, **(extra or {})}}, upsert=True)
        return True
    except DuplicateKeyError:
        return False


async def _take_slot(db: AsyncIOMotorDatabase, user_id: str, day: str, now: datetime, *, over: bool) -> bool:
    """One of today's ``DAILY_CAP`` emails (atomic). ``over``: a sign-off request may be one more,
    once a day — it may be the only way the request reaches them."""
    key = f"{user_id}:{day}"
    try:
        await db[DAYS].find_one_and_update({"_id": key, "n": {"$lt": DAILY_CAP}},
                                           {"$inc": {"n": 1}, "$set": {"at": now}}, upsert=True)
        return True
    except DuplicateKeyError:
        pass
    if over:
        got = await db[DAYS].find_one_and_update({"_id": key, "over": {"$ne": True}},
                                                 {"$inc": {"n": 1}, "$set": {"over": True, "at": now}})
        return got is not None
    return False


async def _give_back(db: AsyncIOMotorDatabase, user_id: str, day: str) -> None:
    await db[DAYS].update_one({"_id": f"{user_id}:{day}", "n": {"$gt": 0}}, {"$inc": {"n": -1}})


async def _mark(db: AsyncIOMotorDatabase, ids: list, state: str, now: datetime | None = None) -> None:
    if ids:
        sets: dict = {"email": state}
        if state == "sent":
            sets["emailed_at"] = now or _now()
        await db[COLL].update_many({"_id": {"$in": ids}, "email": "pending"}, {"$set": sets})


def _slots(now: datetime, zone: ZoneInfo) -> tuple[datetime, datetime, str]:
    """(the last digest time at or before ``now``, the next one, the last one's local date)."""
    local = now.astimezone(zone)
    today = datetime.combine(local.date(), dtime(DIGEST_HOUR), tzinfo=zone)
    if local >= today:
        last, nxt = today, datetime.combine(local.date() + timedelta(days=1), dtime(DIGEST_HOUR), tzinfo=zone)
    else:
        last, nxt = datetime.combine(local.date() - timedelta(days=1), dtime(DIGEST_HOUR), tzinfo=zone), today
    return last.astimezone(timezone.utc), nxt.astimezone(timezone.utc), last.date().isoformat()


def _items(rows: list[dict]) -> list[dict]:
    return [{"kind": r["kind"], "actor": r.get("actor_name") or "Someone", "block": r.get("block_id"),
             "excerpt": (r.get("extra") or {}).get("excerpt"), "label": (r.get("extra") or {}).get("label")}
            for r in rows]


class _Person:
    """One person's pass of :func:`flush_emails`."""

    def __init__(self, db: AsyncIOMotorDatabase, user_row: dict, now: datetime, bump):
        self.db, self.user, self.now, self.bump = db, user_row, now, bump
        self.uid = str(user_row["_id"])
        self.modes = email_modes(user_row)
        self.zone = _zone(user_row)
        self.day = now.astimezone(self.zone).date().isoformat()
        self.slot, self.next_slot, self.slot_day = _slots(now, self.zone)
        self.wake: dict = {}       # row id → when to look again
        self.done: set = set()     # row ids given an outcome (or sent)

    async def mark(self, rows: list[dict], state: str) -> None:
        ids = [r["_id"] for r in rows]
        await _mark(self.db, ids, state, self.now)
        self.done.update(ids)
        if state != "sent":
            self.bump(state, len(ids))

    def later(self, rows: list[dict], when: datetime) -> None:
        for r in rows:
            self.wake[r["_id"]] = min(self.wake.get(r["_id"], when), when)

    async def defer(self, rows: list[dict]) -> None:
        """Over today's cap: to the catch-up at 08:00 tomorrow (their time), when the cap is new."""
        ids = [r["_id"] for r in rows]
        local = self.now.astimezone(self.zone).date() + timedelta(days=1)
        at = datetime.combine(local, dtime(DIGEST_HOUR), tzinfo=self.zone).astimezone(timezone.utc)
        await self.db[COLL].update_many({"_id": {"$in": ids}, "email": "pending"},
                                        {"$set": {"catchup": True, "catchup_at": at, "email_at": at}})
        self.done.update(ids)
        self.bump("capped", len(ids))

    async def pages(self, rows: list[dict], docs: dict) -> list[tuple[dict, list[dict]]]:
        """Rows by page (in order), the pages this person may open now; the rest are "no_access"."""
        by: dict[str, list[dict]] = {}
        for r in rows:
            by.setdefault(r["doc_id"], []).append(r)
        out = []
        for doc_id, prs in by.items():
            doc = docs.get(doc_id)
            if doc is None or not await can_open(self.db, self.user, doc):
                await self.mark(prs, "no_access")
            else:
                out.append((doc, prs))
        return out

    def less(self, rows: list[dict]) -> str | None:
        return less_url(self.uid, {r["kind"]: self.modes[r["kind"]] for r in rows if r["kind"] in self.modes})

    async def deliver(self, rows: list[dict], mail: dict, *, over: bool) -> bool:
        """Send within today's cap; over it, the rows wait for the catch-up."""
        if not await _take_slot(self.db, self.uid, self.day, self.now, over=over):
            await self.defer(rows)
            return False
        try:
            # The admin email log's ref: the page, when the email is about one page (a bundle spans several).
            pages_in = {str(r.get("doc_id")) for r in rows}
            await _send(self.user, mail, ref=pages_in.pop() if len(pages_in) == 1 else None,
                        kind="signoff" if all(r["kind"] == "signoff_requested" for r in rows) else "mention")
        except Exception:
            log.warning("notifications: email to %s failed", self.uid, exc_info=True)
            await _give_back(self.db, self.uid, self.day)
            await self.mark(rows, "failed")
            return False
        await self.mark(rows, "sent")
        self.bump("sent")
        return True

    async def instant(self, rows: list[dict], docs: dict) -> None:
        """One email per page, as before; while the person was around in the app lately, it waits
        (up to the window) for them to see it there."""
        from app.services import md_outline, urls

        app_seen = _aware(self.user.get("app_seen_at"))
        by: dict[str, list[dict]] = {}
        for r in rows:
            by.setdefault(r["doc_id"], []).append(r)
        for doc_id, prs in by.items():
            hold = [_aware(r["created_at"]) + WINDOW[r["kind"]] for r in prs
                    if app_seen is not None and app_seen >= self.now - WINDOW[r["kind"]]
                    and self.now < _aware(r["created_at"]) + WINDOW[r["kind"]]]
            if len(hold) == len(prs):
                self.later(prs, min(hold))
                continue
            for doc, ok in await self.pages(prs, docs):
                if not await _claim(self.db, self.uid, doc_id, self.now):
                    self.bump("waiting", len(ok))
                    continue  # an email about this page went less than 10 minutes ago: these wait
                items = _items(ok)
                mail = compose_email(user_id=self.uid, title=md_outline.display_title(doc),
                                     page_url=urls.markdrop_url(doc["slug"]), items=items[:MAX_PER_EMAIL],
                                     more=max(0, len(items) - MAX_PER_EMAIL), why=WHY["instant"], less=self.less(ok))
                await self.deliver(ok, mail, over=any(r["kind"] == "signoff_requested" for r in ok))

    async def bundle(self, rows: list[dict], docs: dict, mode: str) -> None:
        """The hourly bundle, or the daily digest / morning catch-up: every page in one email."""
        from app.services import md_outline, urls

        pages = await self.pages(rows, docs)
        if not pages:
            return
        key = f"{self.uid}:hourly" if mode == "hourly" else f"{self.uid}:daily:{self.slot_day}"
        if not await _claim_key(self.db, key, self.now, BUNDLE_GAP if mode == "hourly" else None,
                                {"user_id": self.uid}):
            waiting = [r for _, prs in pages for r in prs]
            self.later(waiting, self.now + RECHECK if mode == "hourly" else self.next_slot)
            self.bump("waiting", len(waiting))
            return
        sent_rows = [r for _, prs in pages for r in prs]
        over = any(r["kind"] == "signoff_requested" for r in sent_rows)
        if mode == "hourly" and len(pages) == 1:
            doc, prs = pages[0]
            items = _items(prs)
            mail = compose_email(user_id=self.uid, title=md_outline.display_title(doc),
                                 page_url=urls.markdrop_url(doc["slug"]), items=items[:MAX_PER_EMAIL],
                                 more=max(0, len(items) - MAX_PER_EMAIL), why=WHY["hourly"], less=self.less(prs))
            await self.deliver(prs, mail, over=over)
            return
        shown = []
        for doc, prs in pages[:MAX_PAGES]:
            items = _items(prs)
            shown.append({"title": md_outline.display_title(doc), "url": urls.markdrop_url(doc["slug"]),
                          "items": items[:MAX_PER_PAGE], "more": max(0, len(items) - MAX_PER_PAGE),
                          "more_signoffs": sum(1 for i in items[MAX_PER_PAGE:] if i["kind"] == "signoff_requested")})
        catchup = any(r.get("catchup") for r in sent_rows)
        if mode != "hourly":
            mode = "catchup" if all(r.get("catchup") for r in sent_rows) else "daily"
        mail = compose_digest(user_id=self.uid, pages=shown, mode=mode, more_pages=max(0, len(pages) - MAX_PAGES),
                              catchup=catchup, less=self.less(sent_rows))
        await self.deliver(sent_rows, mail, over=over)

    async def run(self, rows: list[dict]) -> None:
        from app.services import mailer, push, slack_notify

        now, db = self.now, self.db
        app_seen = _aware(self.user.get("app_seen_at"))
        out: dict[str, list[dict]] = {}
        left: list[dict] = []
        for r in rows:
            created = _aware(r["created_at"]) or now
            if now - created > STALE:
                out.setdefault("stale", []).append(r)
            elif self.modes.get(r["kind"], "off") == "off":
                out.setdefault("off", []).append(r)
            elif r.get("read_at") is not None or (app_seen is not None and app_seen > created):
                out.setdefault("seen", []).append(r)  # read, or the bell showed it to them
            else:
                left.append(r)
        oids = list({ObjectId(r["doc_id"]) for r in left if ObjectId.is_valid(r.get("doc_id") or "")})
        docs = {str(d["_id"]): d async for d in db["documents"].find({"_id": {"$in": oids}})} if oids else {}
        named: dict[str, set] = {}
        refs = [str(r["_id"]) for r in left]
        states: dict[str, set] = {}
        if refs:
            for coll in (push.OUTBOX, slack_notify.OUTBOX):
                async for o in db[coll].find({"ref": {"$in": refs}, "user_id": self.uid}, {"ref": 1, "state": 1}):
                    states.setdefault(o["ref"], set()).add(("push" if coll == push.OUTBOX else "slack", o.get("state")))
        live: list[dict] = []
        for r in left:
            doc = docs.get(r["doc_id"])
            if doc is not None:
                if r["doc_id"] not in named:
                    named[r["doc_id"]] = named_on(doc.get("content"))
                if not still_there(r, named[r["doc_id"]]):
                    out.setdefault("withdrawn", []).append(r)  # taken out of the page since
                    continue
            got = states.get(str(r["_id"]), set())
            if ("push", "sent") in got:
                out.setdefault("pushed", []).append(r)  # a device of theirs showed it
            elif ("slack", "sent") in got:
                out.setdefault("slack", []).append(r)   # so did Slack
            else:
                live.append(r)
        for state, rs in out.items():
            await self.mark(rs, state)
        if not live:
            return
        if await db["email_suppressions"].find_one({"_id": self.user["email"].strip().lower()}, {"_id": 1}):
            await self.mark(live, "suppressed")
            return
        if not mailer.is_configured():
            await self.mark(live, "unconfigured")
            return
        instant: list[dict] = []
        hourly: list[dict] = []
        daily: list[dict] = []
        for r in live:
            created = _aware(r["created_at"]) or now
            window = WINDOW[r["kind"]]
            if now - created < GATHER:
                self.later([r], created + GATHER)  # still gathering: someone may be mentioning more people
                continue
            got = states.get(str(r["_id"]), set())
            if any(s in ("pending", "sending") for _, s in got) and now - created < window:
                self.later([r], min(created + window, now + RECHECK))  # a push or Slack DM is on its way
                continue
            mode = self.modes[r["kind"]]
            if r.get("catchup"):
                at = _aware(r.get("catchup_at")) or self.slot
                if now < at:
                    self.later([r], at)  # over the cap yesterday: tomorrow morning's catch-up
                    continue
                mode = "daily"
            (instant if mode == "instant" else hourly if mode == "hourly" else daily).append(r)
        if instant:
            await self.instant(instant, docs)
        if hourly:
            last = await db[EMAIL_LOG].find_one({"_id": f"{self.uid}:hourly"}, {"sent_at": 1})
            last_at = _aware((last or {}).get("sent_at"))
            oldest = min(_aware(r["created_at"]) for r in hourly)
            due = max(oldest + BUNDLE_WAIT, (last_at + BUNDLE_GAP) if last_at else oldest)
            if now < due:
                self.later(hourly, due)
            else:
                await self.bundle(hourly, docs, "hourly")
        if daily:
            if any(r.get("catchup") or _aware(r["created_at"]) < self.slot for r in daily) and \
                    await db[EMAIL_LOG].find_one({"_id": f"{self.uid}:daily:{self.slot_day}"}, {"_id": 1}) is None:
                await self.bundle(daily, docs, "daily")
            else:
                self.later(daily, self.next_slot)

    async def save_wakes(self, rows: list[dict]) -> None:
        by: dict[datetime, list] = {}
        for r in rows:
            if r["_id"] in self.done:
                continue
            by.setdefault(self.wake.get(r["_id"], self.now + RECHECK), []).append(r["_id"])
        for when, ids in by.items():
            await self.db[COLL].update_many({"_id": {"$in": ids}, "email": "pending"}, {"$set": {"email_at": when}})


async def flush_emails(db: AsyncIOMotorDatabase, now: datetime | None = None) -> dict[str, int]:
    """One pass of the notification email (background loop, every 30 s): every person with a waiting
    row that's due (``email_at``). Returns counts by outcome: ``sent`` (emails), and per row
    ``seen`` / ``pushed`` / ``slack`` / ``withdrawn`` / ``off`` / ``suppressed`` / ``no_access`` /
    ``capped`` (to the morning catch-up) / ``waiting`` / ``failed`` / ``stale`` / ``unconfigured``."""
    now = _aware(now) or _now()
    counts: dict[str, int] = {}

    def bump(k: str, n: int = 1) -> None:
        if n:
            counts[k] = counts.get(k, 0) + n

    people = await db[COLL].aggregate([
        {"$match": {"email": "pending", "$or": [{"email_at": {"$lte": now}}, {"email_at": None}]}},
        {"$group": {"_id": "$user_id", "oldest": {"$min": "$created_at"}}},
        {"$sort": {"oldest": 1}},
        {"$limit": FLUSH_PEOPLE},
    ]).to_list(length=FLUSH_PEOPLE)
    for p in people:
        uid = p["_id"]
        try:
            rows = await db[COLL].find({"user_id": uid, "email": "pending"}).sort(
                [("created_at", 1)]).to_list(length=500)
            if not rows:
                continue
            user_row = await _user_row(db, uid)
            if not wants_email(user_row):
                await _mark(db, [r["_id"] for r in rows], "off")
                bump("off", len(rows))
                continue
            person = _Person(db, user_row, now, bump)
            try:
                await person.run(rows)
            finally:
                await person.save_wakes(rows)
        except Exception:
            log.warning("notifications: email pass for %s failed", uid, exc_info=True)
    return counts


# ── Sharing with a named person ("Notify people") ─────────────────────────────


async def share_with(db: AsyncIOMotorDatabase, raw: dict, email: str, role: str, actor: Any, ctx: Any, *,
                     notify_them: bool = True, message: str | None = None):
    """Grant ``email`` access to ``raw`` (``access.add_grant``: every rule and
    error is its own) and, with ``notify_them``, tell them: the share email
    (now, not batched: it's one deliberate act) and, when the address has an
    account, a "shared" notification under the bell. Nothing is sent when they
    already had that access. A failed email never undoes the grant; the
    returned grant's ``notified`` says whether it went."""
    from app.services import access as access_service
    from app.services import mailer

    grant = await access_service.add_grant(db, raw, email, role, actor, ctx)
    if not notify_them or grant.unchanged:
        return grant
    message = (message or "").strip()[:500] or None
    if mailer.is_configured():
        try:
            user = getattr(actor, "user", None)
            await mailer.send_document_share_email(
                to_email=grant.email,
                document_title=raw.get("title") or f"/{raw['slug']}",
                slug=raw["slug"],
                sharer_name=(getattr(user, "name", None) or getattr(user, "email", None) or "Someone"),
                role=grant.role,
                encrypted=bool(raw.get("encrypted")),
                message=message,
                noun="page" if raw.get("editor") == "blocks" else "document",
            )
            await access_service.mark_notified(db, grant.id)
            grant.notified = True
        except Exception:
            grant.notified = False
    try:
        target = await db["users"].find_one({"email": grant.email}, {"_id": 1}) or await db["users"].find_one(
            {"email": {"$regex": f"^{re.escape(grant.email)}$", "$options": "i"}}, {"_id": 1})
        if target is not None:
            fresh = await db["documents"].find_one({"_id": raw["_id"]}) or raw
            await notify(db, str(target["_id"]), "shared", fresh, None, actor,
                         {"message": message, "role": grant.role})
    except Exception:
        log.warning("notifications: shared notification failed", exc_info=True)
    return grant
