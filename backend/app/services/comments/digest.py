"""The daily comments digest (Track C): one email at 08:00 your time listing the threads waiting on you and the
open threads on your items, sent only on a day something happened.

Who gets it: anyone with an open thread waiting on them, or open threads on an item they own, **and** some of
that activity is new since their last digest (or the last 24 hours) — a day with nothing new sends nothing
(calm rules, owner 2026-11-06). Off with ``users.comment_digest: "off"`` (Settings → Account → Email, the
digest's own one-click "Turn off" link, or the turn-off-everything link of notification emails, which sets
``unsubscribed_at``/modes off and :func:`wants` honours).

* **Waiting on you** — open threads assigned to you; threads whose newest message mentions you; threads you
  started where someone else wrote last (CONTRACT §6's "waiting" rule).
* **On your items** — items you own with open threads: how many, how many with new activity, the newest few.

Every thread and item is checked against the person's access *now* (``perms.can_view_comments``): nothing they
can't see is listed. Sent from notifications@ (``mailer._sender("share")``) as a ``digest`` email (the bulk
tier), with List-Unsubscribe pointing at the digest's own off link. It doesn't count toward the 3 notification
emails a day.

Run by the notifications background loop (services/background.py ``_notifications`` → :func:`run_due`), which
itself looks at most every ``EVERY`` and only at people with comment activity in the last ``LOOKBACK``.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
from datetime import datetime, timedelta, timezone
from datetime import time as dtime
from typing import Any

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.config import get_settings

log = logging.getLogger(__name__)
settings = get_settings()

LOG = "comment_digest_log"        # {_id: "<user>:<local date>", user_id, at, threads}
META = "comment_digest_meta"      # {_id: "run", at}: the last pass (one pass per EVERY across processes)
HOUR = 8
EVERY = timedelta(minutes=5)
LOOKBACK = timedelta(hours=26)
MAX_PEOPLE = 300
MAX_WAITING = 8
MAX_ITEMS = 6
PER_ITEM = 3
OFF_PATH = "/api/v1/comments/digest/off"
PREFS = ("daily", "off")
_indexed = False


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(v: datetime | None) -> datetime | None:
    if v is None:
        return None
    return v if v.tzinfo else v.replace(tzinfo=timezone.utc)


def _oid(v: Any) -> ObjectId | None:
    if isinstance(v, ObjectId):
        return v
    return ObjectId(v) if isinstance(v, str) and ObjectId.is_valid(v) else None


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[LOG].create_index("at", expireAfterSeconds=4 * 24 * 3600)


# ── Preference and the off link ───────────────────────────────────────────────


def is_on(user_row: dict | None) -> bool:
    return (user_row or {}).get("comment_digest") != "off"


def wants(user_row: dict | None) -> bool:
    """Has an address, isn't unsubscribed from Markdrop email, and kept the digest on."""
    return bool(user_row and user_row.get("email") and not user_row.get("unsubscribed_at") and is_on(user_row))


async def set_on(db: AsyncIOMotorDatabase, user_id: str, on: bool) -> bool:
    if not ObjectId.is_valid(user_id or ""):
        return False
    res = await db["users"].update_one({"_id": ObjectId(user_id)}, {"$set": {"comment_digest": "daily" if on else "off"}})
    return res.matched_count == 1


def off_token(user_id: str) -> str:
    sig = hmac.new(settings.auth_secret.encode(), f"comment-digest:{user_id}".encode(), hashlib.sha256).hexdigest()[:32]
    return f"{user_id}.{sig}"


def verify_off_token(token: str | None) -> str | None:
    try:
        user_id, sig = (token or "").rsplit(".", 1)
    except ValueError:
        return None
    if not ObjectId.is_valid(user_id) or not sig:
        return None
    return user_id if hmac.compare_digest(sig.encode(), off_token(user_id).rsplit(".", 1)[1].encode()) else None


def off_url(user_id: str) -> str:
    return f"{settings.api_base_url.rstrip('/')}{OFF_PATH}?t={off_token(user_id)}"


# ── What goes in it ───────────────────────────────────────────────────────────


def _cut(s: str | None, n: int) -> str:
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


class _Access:
    """Per-person access cache: doc id → can view comments there now."""

    def __init__(self, db, user_row: dict):
        from app.services import access, notifications

        self.db = db
        self.actor = access.Actor.of(notifications._as_user(user_row))
        self.ctx = access.Ctx(db)
        self.cache: dict[str, bool] = {}

    async def ok(self, doc: dict | None) -> bool:
        from app.services.comments import perms

        if doc is None:
            return False
        k = str(doc["_id"])
        if k not in self.cache:
            try:
                self.cache[k] = await perms.can_view_comments(self.db, self.actor, doc, self.ctx)
            except Exception:
                log.warning("comment digest: access check failed on %s", k, exc_info=True)
                self.cache[k] = False
        return self.cache[k]


async def _docs(db, ids: set[str]) -> dict[str, dict]:
    oids = [ObjectId(i) for i in ids if ObjectId.is_valid(i)]
    if not oids:
        return {}
    return {str(d["_id"]): d async for d in db["documents"].find({"_id": {"$in": oids}, "deleted_at": None})}


async def _last_messages(db, thread_ids: list) -> dict[str, dict]:
    if not thread_ids:
        return {}
    out: dict[str, dict] = {}
    async for m in db["comment_messages"].aggregate([
        {"$match": {"thread_id": {"$in": thread_ids}, "deleted_at": None}},
        {"$sort": {"created_at": -1}},
        {"$group": {"_id": "$thread_id", "m": {"$first": "$$ROOT"}}},
    ]):
        out[str(m["_id"])] = m["m"]
    return out


def _reason(t: dict, uid: str, last: dict | None) -> str | None:
    """Why an open thread waits on ``uid`` (CONTRACT §6), or None."""
    if t.get("assignee") == uid:
        return "assigned"
    if last is None or last.get("author_id") == uid:
        return None
    if uid in (last.get("mentions") or []):
        return "mentioned"
    if t.get("created_by") == uid:
        return "reply"
    return None


async def build(db: AsyncIOMotorDatabase, user_row: dict, now: datetime | None = None,
                since: datetime | None = None) -> dict:
    """``{"waiting": [row], "items": [item], "new": int, "since": datetime}`` for one person (access-checked).
    ``row`` = ``{thread_id, slug, title, url, reason, quote, last: {author, excerpt, at}, new}``; ``item`` =
    ``{slug, title, url, open, new, threads: [row]}``. ``new``: threads with activity after ``since``."""
    from app.services import md_outline, urls
    from app.services.comments import notify_email

    now = now or _now()
    uid = str(user_row["_id"])
    since = _aware(since) or _aware(user_row.get("comment_digest_at")) or (now - timedelta(hours=24))
    acc = _Access(db, user_row)
    base = {"status": "open", "deleted_at": None}
    cand = await db["comment_threads"].find({**base, "$or": [
        {"assignee": uid}, {"mentions": uid}, {"created_by": uid}]}).sort("updated_at", -1).limit(200).to_list(length=200)
    owned = await db["documents"].find({"owner_id": uid, "deleted_at": None, "comment_counts.open": {"$gt": 0}},
                                       ).sort("updated_at", -1).limit(50).to_list(length=50)
    owned_ids = [str(d["_id"]) for d in owned]
    on_mine = await db["comment_threads"].find({**base, "doc_id": {"$in": owned_ids}}).sort(
        "last_message_at", -1).limit(400).to_list(length=400) if owned_ids else []
    docs = {str(d["_id"]): d for d in owned}
    docs.update(await _docs(db, {t["doc_id"] for t in cand} - set(docs)))
    last = await _last_messages(db, [t["_id"] for t in cand + on_mine])

    def row(t: dict, reason: str | None = None) -> dict:
        d = docs[t["doc_id"]]
        m = last.get(str(t["_id"]))
        at = _aware(t.get("last_message_at") or t.get("updated_at") or t.get("created_at"))
        return {"thread_id": str(t["_id"]), "slug": d["slug"], "title": md_outline.display_title(d),
                "url": urls.markdrop_url(d["slug"]) + f"#c-{t['_id']}", "reason": reason,
                "quote": notify_email.anchor_quote(t),
                "last": {"author": (m or {}).get("author_name") or "Someone", "excerpt": _cut((m or {}).get("body"), 200),
                         "at": at},
                "new": bool(at and at > since)}

    waiting: list[dict] = []
    seen: set[str] = set()
    for t in cand:
        why = _reason(t, uid, last.get(str(t["_id"])))
        if not why or not await acc.ok(docs.get(t["doc_id"])):
            continue
        waiting.append(row(t, why))
        seen.add(str(t["_id"]))
    items: list[dict] = []
    by_doc: dict[str, list[dict]] = {}
    for t in on_mine:
        by_doc.setdefault(t["doc_id"], []).append(t)
    for doc_id, ts in by_doc.items():
        d = docs.get(doc_id)
        if not await acc.ok(d):
            continue
        rows = [row(t) for t in ts]
        items.append({"slug": d["slug"], "title": md_outline.display_title(d), "url": urls.markdrop_url(d["slug"]),
                      "open": len(rows), "new": sum(1 for r in rows if r["new"]),
                      "threads": [r for r in rows if r["thread_id"] not in seen][:PER_ITEM]})
    items.sort(key=lambda i: (-i["new"], -i["open"]))
    new = sum(1 for r in waiting if r["new"]) + sum(i["new"] for i in items)
    return {"waiting": waiting, "items": items, "new": new, "since": since}


# ── The email ─────────────────────────────────────────────────────────────────

REASONS = {"assigned": "Assigned to you", "mentioned": "You were mentioned", "reply": "New reply to your comment"}


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def compose(*, user_id: str, data: dict) -> dict:
    """``{subject, preheader, html, text}`` for one person's digest."""
    from app.services import email_kit as K, mailer

    waiting, items = data["waiting"], data["items"]
    shown_w = waiting[:MAX_WAITING]
    open_total = sum(i["open"] for i in items)
    if waiting:
        head = (f"{_plural(len(waiting), 'comment thread')} "
                f"{'is' if len(waiting) == 1 else 'are'} waiting on you")
    else:
        head = f"{_plural(open_total, 'open comment thread')} on your pages"
    subject = mailer._one_line(f"Comments: {head[0].lower() + head[1:]}", 150)
    body: list = [K.eyebrow("Comments · daily digest"), K.title(head)]
    tiles = [("Waiting on you", str(len(waiting)))] + ([("Open on your pages", str(open_total))] if items else []) + \
        ([("New since yesterday", str(data["new"]))] if data["new"] else [])
    body.append(K.stats(tiles, margin="4px 0 8px"))

    def part(r: dict, k: int, n: int):
        what = [K.strong(r["last"]["author"]), " in ", K.link(r["url"].split("#", 1)[0], r["title"])]
        meta = " · ".join(x for x in (REASONS.get(r.get("reason") or ""), f"On “{r['quote']}”" if r.get("quote") else None,
                                      "New" if r.get("new") else None) if x)
        return K.item(what, who=r["last"]["author"], quote_=r["last"]["excerpt"] or None, meta=meta or None,
                      href=r["url"], action="Reply", last=k == n - 1)

    if shown_w:
        body.append(K.heading("Waiting on you", count=len(waiting), top=20))
        body.append(K.rows([part(r, k, len(shown_w)) for k, r in enumerate(shown_w)]))
        if len(waiting) > len(shown_w):
            body.append(K.small(f"And {_plural(len(waiting) - len(shown_w), 'more thread')}: see Home in Markdrop."))
    for it in items[:MAX_ITEMS]:
        count = f"{it['open']} open" + (f" · {it['new']} new" if it["new"] else "")
        body.append(K.heading(K.link(it["url"], it["title"]), count=count, top=20))
        if it["threads"]:
            body.append(K.rows([part(r, k, len(it["threads"])) for k, r in enumerate(it["threads"])], margin="0 0 4px"))
        more = it["open"] - len(it["threads"])
        if more > 0:
            body.append(K.small(f"And {_plural(more, 'more open thread')} on this page.", margin="0 0 8px"))
    if len(items) > MAX_ITEMS:
        body.append(K.small(f"And {_plural(len(items) - MAX_ITEMS, 'more page')} with open threads."))
    body.append(K.button(mailer._base() + "/dashboard", "Open Markdrop", margin="18px 0 24px"))
    footer = K.Footer(why="You get this once a day, in the morning, when there's something new in the comments "
                          "on your pages or waiting on you.",
                      links=[("Turn off this digest", off_url(user_id)),
                             ("Email settings", mailer._base() + "/settings/account#email")])
    e = K.layout(title_=head, preheader=head + ".", base=mailer._base(), body=body, footer=footer)
    return {"subject": subject, "preheader": head + ".", "html": e.html, "text": e.text}


async def _send(user_row: dict, mail: dict) -> None:
    from app.services import mailer

    off = off_url(str(user_row["_id"]))
    await mailer._post({
        "from": mailer._sender("share"), "to": [user_row["email"]], "subject": mail["subject"],
        "reply_to": settings.email_reply_to, "html": mail["html"], "text": mail["text"],
        "headers": {"List-Unsubscribe": f"<{off}>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"},
    }, kind="digest", ref=None)


def _local_slot(now: datetime, user_row: dict) -> tuple[bool, str]:
    """(is it 08:00 or later their time, their local date)."""
    from app.services import notifications

    local = now.astimezone(notifications._zone(user_row))
    return local.time() >= dtime(HOUR), local.date().isoformat()


async def send_one(db: AsyncIOMotorDatabase, user_row: dict, now: datetime | None = None, *, force: bool = False) -> str:
    """Send this person's digest when it's due. Returns the outcome: sent | off | early | already | nothing |
    suppressed | unconfigured | failed."""
    from app.services import mailer

    now = now or _now()
    if not wants(user_row):
        return "off"
    due, day = _local_slot(now, user_row)
    if not due and not force:
        return "early"
    uid = str(user_row["_id"])
    if await db[LOG].find_one({"_id": f"{uid}:{day}"}, {"_id": 1}):
        return "already"
    data = await build(db, user_row, now)
    if not data["new"] or not (data["waiting"] or data["items"]):
        return "nothing"
    if await db["email_suppressions"].find_one({"_id": user_row["email"].strip().lower()}, {"_id": 1}):
        return "suppressed"
    if not mailer.is_configured():
        return "unconfigured"
    try:
        await db[LOG].insert_one({"_id": f"{uid}:{day}", "user_id": uid, "at": now,
                                  "threads": len(data["waiting"]) + sum(i["open"] for i in data["items"])})
    except DuplicateKeyError:
        return "already"
    try:
        await _send(user_row, compose(user_id=uid, data=data))
    except Exception:
        log.warning("comment digest: email to %s failed", uid, exc_info=True)
        await db[LOG].delete_one({"_id": f"{uid}:{day}"})
        return "failed"
    await db["users"].update_one({"_id": user_row["_id"]}, {"$set": {"comment_digest_at": now}})
    return "sent"


async def candidates(db: AsyncIOMotorDatabase, now: datetime) -> list[str]:
    """People with comment activity around them in the last LOOKBACK: owners of items with recently active open
    threads, and the threads' assignees / mentioned / participants."""
    ids: set[str] = set()
    doc_ids: set[str] = set()
    async for t in db["comment_threads"].find(
            {"status": "open", "deleted_at": None, "updated_at": {"$gte": now - LOOKBACK}},
            {"doc_id": 1, "assignee": 1, "mentions": 1, "participants": 1}).limit(5000):
        doc_ids.add(t["doc_id"])
        ids.update(x for x in [t.get("assignee"), *(t.get("mentions") or []), *(t.get("participants") or [])] if x)
    oids = [ObjectId(i) for i in doc_ids if ObjectId.is_valid(i)]
    if oids:
        async for d in db["documents"].find({"_id": {"$in": oids}}, {"owner_id": 1}):
            if d.get("owner_id"):
                ids.add(str(d["owner_id"]))
    return sorted(i for i in ids if ObjectId.is_valid(i))


async def run_due(db: AsyncIOMotorDatabase, now: datetime | None = None, *, force: bool = False) -> dict[str, int]:
    """One pass (at most every EVERY unless ``force``): every candidate whose 08:00 has come today gets their
    digest if there's something new. Returns counts by outcome. Never raises."""
    global _indexed
    now = now or _now()
    counts: dict[str, int] = {}
    if not _indexed:
        _indexed = True
        try:
            await ensure_indexes(db)
        except Exception:
            log.warning("comment digest: indexes", exc_info=True)
    try:
        if not force:
            got = await db[META].find_one_and_update(
                {"_id": "run", "$or": [{"at": {"$lte": now - EVERY}}, {"at": {"$exists": False}}]},
                {"$set": {"at": now}}, upsert=True)
            del got
    except DuplicateKeyError:
        return counts
    try:
        people = (await candidates(db, now))[:MAX_PEOPLE]
        rows = {str(u["_id"]): u async for u in db["users"].find({"_id": {"$in": [ObjectId(p) for p in people]}})}
        for uid in people:
            u = rows.get(uid)
            if u is None:
                continue
            try:
                out = await send_one(db, u, now)
            except Exception:
                log.warning("comment digest for %s failed", uid, exc_info=True)
                out = "failed"
            counts[out] = counts.get(out, 0) + 1
    except Exception:
        log.warning("comment digest pass failed", exc_info=True)
    return counts
