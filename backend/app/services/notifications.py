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
routers/access.py): a row is born ``email: "pending"`` when the person wants
these emails (``users.mention_emails`` not False, no ``unsubscribed_at``).
:func:`flush_emails` (background loop, every 30 s) sends one email per person
per page, batching every pending row for that page, once the newest has waited
``GATHER`` and no email went to that person about that page in the last 10
minutes (``notification_email_log``, one row per person+page, claimed
atomically). At send time it checks again: access, the preference, the
suppression list, and whether the row was read in the app meanwhile (then no
email: ``email: "seen"``).
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
from typing import Any

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.config import get_settings

settings = get_settings()
log = logging.getLogger(__name__)

COLL = "notifications"
EMAIL_LOG = "notification_email_log"
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
    await db[COLL].create_index("created_at", expireAfterSeconds=KEEP_DAYS * 24 * 3600)
    await db[EMAIL_LOG].create_index("sent_at", expireAfterSeconds=24 * 3600)


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


def wants_email(user_row: dict | None) -> bool:
    return bool(user_row and user_row.get("email") and not user_row.get("unsubscribed_at")
                and user_row.get("mention_emails") is not False)


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
        dup = await db[COLL].find_one({"user_id": user_id, "kind": kind, "doc_id": doc_id, "block_id": block,
                                       "created_at": {"$gt": now - DEDUPE}}, {"_id": 1})
        if dup is not None:
            return None
    if actor_name is None:
        actor_name = _actor_info(await _user_row(db, actor_id) or {"_id": actor_id})[1]
    row = {
        "user_id": user_id, "kind": kind, "doc_id": doc_id, "block_id": block,
        "actor_id": actor_id, "actor_name": (actor_name or "Someone")[:80], "via": _via(actor),
        "extra": _clean_extra(extra), "created_at": now, "read_at": None,
        "email": "pending" if kind in EMAIL_KINDS and wants_email(recipient) else "off",
        "emailed_at": None,
    }
    res = await db[COLL].insert_one(row)
    row["_id"] = res.inserted_id
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
    """After a write of a page: notify each person newly mentioned (or newly
    named on a sign-off block). Returns how many were notified. Never raises.
    Nobody is notified inside :func:`quiet`."""
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


async def set_preference(db: AsyncIOMotorDatabase, user_id: str, on: bool) -> bool:
    if not ObjectId.is_valid(user_id or ""):
        return False
    res = await db["users"].update_one({"_id": ObjectId(user_id)},
                                       {"$set": {"mention_emails": bool(on), "mention_emails_at": _now()}})
    if not on:
        await db[COLL].update_many({"user_id": str(user_id), "email": "pending"}, {"$set": {"email": "off"}})
    return res.matched_count == 1


def _e(s: Any) -> str:
    return html.escape(str(s), quote=True)


def compose_email(*, user_id: str, title: str, page_url: str, items: list[dict], more: int = 0) -> dict:
    """``{subject, html, text}`` for one person about one page. ``items``:
    ``[{kind, actor, block, excerpt, label}]`` (oldest first)."""
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
    S, M, INK, BODY, LINE = mailer._SANS, mailer._MUTED, mailer._INK, mailer._BODY, mailer._LINE

    def line(i: dict) -> str:
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

    target = f"{page_url}#{first['block']}" if (n == 1 and first.get("block")) else page_url
    more_html = mailer._p(f"And {more} more on this page.", size=13, color=M) if more else ""
    content = (mailer._eyebrow(eyebrow) + mailer._heading(_e(head))
               + "".join(line(i) for i in items) + more_html
               + mailer._button(_e(target), "Open the page", margin="14px 0 20px"))
    off = off_url(user_id)
    footer = ("You get this when someone mentions you or asks for your sign-off on Markdrop, at most once "
              "every 10 minutes per page. "
              f"{mailer._footer_link(_e(off), 'Turn off mention emails')} &middot; "
              f"{mailer._footer_link(_e(mailer._base() + '/settings/account'), 'Email settings')}")
    html_out = mailer._shell(title=_e(head), preheader=_e(head + "."), content=content, footer=footer)
    text = [head, ""]
    for i in items:
        verb = (f"asked you to sign off on {i.get('label') or 'a sign-off'}" if i["kind"] == "signoff_requested"
                else "mentioned you")
        text.append(f"- {i['actor']} {verb}" + (f": {i['excerpt']}" if i.get("excerpt") else ""))
    if more:
        text.append(f"And {more} more on this page.")
    text += ["", f"Open the page: {target}", "", f"Turn off mention emails: {off}"]
    return {"subject": subject, "html": html_out, "text": "\n".join(text)}


async def _send(user_row: dict, mail: dict) -> None:
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
    })


async def _claim(db: AsyncIOMotorDatabase, user_id: str, doc_id: str, now: datetime) -> bool:
    """The 10-minute rule: True (and the slot is taken) when no email about
    this page went to this person in the last 10 minutes."""
    try:
        await db[EMAIL_LOG].find_one_and_update(
            {"_id": f"{user_id}:{doc_id}", "$or": [{"sent_at": {"$lte": now - EMAIL_GAP}},
                                                   {"sent_at": {"$exists": False}}]},
            {"$set": {"sent_at": now, "user_id": user_id, "doc_id": doc_id}}, upsert=True)
        return True
    except DuplicateKeyError:
        return False


async def _mark(db: AsyncIOMotorDatabase, ids: list, state: str, now: datetime | None = None) -> None:
    if ids:
        sets: dict = {"email": state}
        if state == "sent":
            sets["emailed_at"] = now or _now()
        await db[COLL].update_many({"_id": {"$in": ids}, "email": "pending"}, {"$set": sets})


async def flush_emails(db: AsyncIOMotorDatabase, now: datetime | None = None) -> dict[str, int]:
    """One pass of the batched email: every (person, page) with pending rows
    whose newest is at least ``GATHER`` old. Returns counts by outcome."""
    from app.services import mailer, md_outline, urls

    now = _aware(now) or _now()
    counts: dict[str, int] = {}

    def bump(k: str, n: int = 1) -> None:
        counts[k] = counts.get(k, 0) + n

    groups = await db[COLL].aggregate([
        {"$match": {"email": "pending"}},
        {"$group": {"_id": {"u": "$user_id", "d": "$doc_id"}, "newest": {"$max": "$created_at"}}},
        {"$sort": {"newest": 1}},
        {"$limit": FLUSH_GROUPS * 5},
    ]).to_list(length=FLUSH_GROUPS * 5)
    done = 0
    for g in groups:
        if done >= FLUSH_GROUPS:
            break
        if (_aware(g["newest"]) or now) > now - GATHER:
            continue  # still gathering: someone may be mentioning more people
        uid, doc_id = g["_id"]["u"], g["_id"]["d"]
        rows = await db[COLL].find({"user_id": uid, "doc_id": doc_id, "email": "pending"}).sort(
            [("created_at", 1)]).to_list(length=200)
        if not rows:
            continue
        done += 1
        seen = [r["_id"] for r in rows if r.get("read_at") is not None]
        unread = [r for r in rows if r.get("read_at") is None]
        if seen:
            await _mark(db, seen, "seen")
            bump("seen", len(seen))
        if not unread:
            continue
        uids = [r["_id"] for r in unread]
        user_row = await _user_row(db, uid)
        doc = await db["documents"].find_one({"_id": ObjectId(doc_id)}) if ObjectId.is_valid(doc_id) else None
        if not wants_email(user_row):
            await _mark(db, uids, "off")
            bump("off", len(uids))
            continue
        if await db["email_suppressions"].find_one({"_id": user_row["email"].strip().lower()}, {"_id": 1}):
            await _mark(db, uids, "suppressed")
            bump("suppressed", len(uids))
            continue
        if doc is None or not await can_open(db, user_row, doc):
            await _mark(db, uids, "no_access")
            bump("no_access", len(uids))
            continue
        if not mailer.is_configured():
            await _mark(db, uids, "unconfigured")
            bump("unconfigured", len(uids))
            continue
        if not await _claim(db, uid, doc_id, now):
            bump("waiting", len(uids))
            continue  # an email about this page went less than 10 minutes ago: these wait
        items = [{"kind": r["kind"], "actor": r.get("actor_name") or "Someone", "block": r.get("block_id"),
                  "excerpt": (r.get("extra") or {}).get("excerpt"), "label": (r.get("extra") or {}).get("label")}
                 for r in unread]
        mail = compose_email(user_id=uid, title=md_outline.display_title(doc), page_url=urls.markdrop_url(doc["slug"]),
                             items=items[:MAX_PER_EMAIL], more=max(0, len(items) - MAX_PER_EMAIL))
        try:
            await _send(user_row, mail)
            await _mark(db, uids, "sent", now)
            bump("sent")
        except Exception:
            log.warning("notifications: email to %s failed", uid, exc_info=True)
            await _mark(db, uids, "failed")
            bump("failed")
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
