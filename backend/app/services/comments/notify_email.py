"""Comment emails (Track C, CONTRACT §10): what a comment notification looks like in an email, and the checks
made when it is about to go.

The bell rows themselves are Track A's (services/comments/notify_app.py → notifications.notify(…, thread_id=…));
every row of a comment kind is born ``email: "pending"`` when its person wants that kind of email, and the one
email engine (services/notifications.py ``flush_emails``, every 30 s) sends it under the calm rules
(email_setup, owner 2026-11-06): the app, push and Slack first; at most 3 notification emails a day with a
morning catch-up; "Email me less" and the turn-off link in every one; sent from notifications@.

Two settings (users.email_notify, Settings → Account → Email):

* ``comment_mention`` — someone @mentions you in a comment or assigns a thread to you. Default **Instant**:
  one email per page as soon as the 60-second gather is over (it waits up to 10 minutes while you're in the
  app, so the bell can show it first).
* ``comment_activity`` — replies on threads you're in, new comments on your items, your thread resolved.
  Default **Instant**, which for these means *gathered*: at most one email every 15 minutes
  (notifications.QUARTER), listing everything that came in meanwhile, across pages.

Both also offer Hourly bundle, Daily digest and Off, like mentions on pages.

At send time (:func:`still_relevant`) a row is dropped when its thread was deleted, the mention was edited
out (``withdrawn``), the thread was unassigned or reopened since, or the person can no longer see comments on
that item (``no_access``: lost access, comments turned off, the workspace turned them off).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from bson import ObjectId

log = logging.getLogger(__name__)

THREADS = "comment_threads"
QUOTE_MAX = 140

VERBS = {
    "comment_mention": "mentioned you in a comment",
    "comment_assigned": "assigned a comment to you",
    "comment_reply": "replied to a comment",
    "comment_new": "commented",
    "comment_resolved": "resolved your comment",
}
EYEBROWS = {
    "comment_mention": "Mentioned in a comment",
    "comment_assigned": "Assigned to you",
    "comment_reply": "Reply",
    "comment_new": "New comment",
    "comment_resolved": "Comment resolved",
}


def _cut(s: str | None, n: int) -> str:
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def _oid(v) -> ObjectId | None:
    if isinstance(v, ObjectId):
        return v
    return ObjectId(v) if isinstance(v, str) and ObjectId.is_valid(v) else None


def anchor_quote(thread: dict | None) -> str | None:
    """The text a thread is about, short: the quoted words, else the block's text (None for the page)."""
    if not thread:
        return None
    a = thread.get("anchor") or {}
    q = (a.get("quote") or {}).get("exact") if isinstance(a.get("quote"), dict) else None
    if thread.get("anchor_status") == "changed":
        q = (thread.get("original") or {}).get("exact") or q
    text = q or a.get("block_text") or (thread.get("original") or {}).get("block_text")
    return _cut(text, QUOTE_MAX) if text else None


async def threads_for(db, rows: list[dict]) -> dict[str, dict]:
    """thread id → comment_threads row, for the comment rows among ``rows`` (one query)."""
    ids = list({_oid(r.get("thread_id")) for r in rows if r.get("thread_id") and _oid(r.get("thread_id"))})
    if not ids:
        return {}
    return {str(t["_id"]): t async for t in db[THREADS].find({"_id": {"$in": ids}})}


async def still_relevant(db, row: dict, doc: dict | None, thread: dict | None, user_row: dict) -> str | None:
    """None when the email may go; else the outcome to record (``withdrawn`` / ``no_access``)."""
    from app.services import access, notifications
    from app.services.comments import perms

    if thread is None or thread.get("deleted_at") is not None or (doc is not None and thread.get("doc_id") != str(doc["_id"])):
        return "withdrawn"
    if doc is None:
        return "no_access"
    uid = str(user_row["_id"])
    kind = row.get("kind")
    if kind == "comment_mention" and uid not in (thread.get("mentions") or []):
        return "withdrawn"      # the mention was edited out (or its message deleted)
    if kind == "comment_assigned" and thread.get("assignee") != uid:
        return "withdrawn"      # unassigned or given to someone else since
    if kind == "comment_resolved" and thread.get("status") != "resolved":
        return "withdrawn"      # reopened since
    try:
        actor = access.Actor.of(notifications._as_user(user_row))
        if not await perms.can_view_comments(db, actor, doc, access.Ctx(db)):
            return "no_access"
    except Exception:
        log.warning("comment email: access check failed for %s", row.get("_id"), exc_info=True)
        return "no_access"
    row["_thread"] = thread
    return None


def item_fields(row: dict) -> dict:
    """What a comment row adds to an email item (notifications._items)."""
    if not row.get("thread_id"):
        return {}
    extra = row.get("extra") or {}
    count = extra.get("count")
    return {"thread_id": str(row["thread_id"]), "count": int(count) if isinstance(count, int) and count > 1 else 1,
            "quote": anchor_quote(row.get("_thread"))}


def verb(i: dict) -> str:
    kind = i["kind"]
    n = int(i.get("count") or 1)
    if kind == "comment_reply" and n > 1:
        return f"and others replied to a comment ({n} new replies)"
    if kind == "comment_mention" and n > 1:
        return f"mentioned you in a comment thread ({n} times)"
    return VERBS.get(kind, "commented")


def sentence(kind: str, actor: str, title: str | None) -> str:
    """The bell's line for a comment row (notifications._sentence)."""
    where = f"“{title}”" if title else "a page you can't open"
    v = VERBS.get(kind, "commented")
    if kind == "comment_new":
        return f"{actor} commented on {where}"
    return f"{actor} {v} on {where}"


def email_head(items: list[dict], n: int, title: str) -> tuple[str, str]:
    """(headline, eyebrow) of a one-page email made only of comment items."""
    first = items[0]
    if n == 1:
        if first["kind"] == "comment_new":
            return f"{first['actor']} commented on “{title}”", EYEBROWS["comment_new"]
        return f"{first['actor']} {verb(first)} on “{title}”", EYEBROWS.get(first["kind"], "Comment")
    kinds = {i["kind"] for i in items}
    if kinds <= {"comment_mention", "comment_assigned"}:
        return f"{n} comments need you in “{title}”", "Comments"
    return f"{n} comment updates in “{title}”", "Comments"


def item_part(i: dict, page_url: str, *, last: bool = False):
    """One comment item as an email row: who did what, their words, what it's about, a link to the thread."""
    from app.services import email_kit as K

    what = [K.strong(i["actor"]), " " + verb(i)]
    href = f"{page_url}#c-{i['thread_id']}" if i.get("thread_id") else page_url
    quote = i.get("quote")
    action = "Reply" if i["kind"] in ("comment_mention", "comment_reply", "comment_new", "comment_assigned") else \
        "Open the comment"
    return K.item(what, who=i["actor"], quote_=i.get("excerpt") or None, href=href, action=action,
                  meta=f"On “{quote}”" if quote else None, last=last)


def bump_fields(recipient: dict | None, kind: str, now: datetime | None = None) -> dict:
    """For Track A's coalescing (an unread row for the same person + kind + thread bumped instead of a new
    row): the ``$set`` that puts its email back in line when the earlier one already went or was seen, so a
    later reply still reaches someone who wants these emails. Empty when they don't."""
    from app.services import notifications

    now = now or datetime.now(timezone.utc)
    if not notifications.wants_email(recipient, kind):
        return {}
    return {"email": "pending", "email_at": now + notifications.GATHER, "emailed_at": None}
