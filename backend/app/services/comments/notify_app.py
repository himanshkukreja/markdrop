"""Bell rows for comment events (CONTRACT §10).

* a new thread → the item's owner (``comment_new``), the people it mentions (``comment_mention``), its
  assignee (``comment_assigned``);
* a reply → everyone in the thread (``comment_reply``) and the people it mentions (``comment_mention``,
  which wins over the reply for the same person);
* an edit that adds mentions → the newly mentioned;
* resolved → the thread's author (``comment_resolved``);
* assigned → the assignee.

Never the actor; never someone who can't see the comments now (notifications.notify re-checks the read
rule; here we also check the item still has comments on). An unread row for the same person, kind and
thread is bumped instead of a new one (notifications.notify).
"""

from __future__ import annotations

from app.services.comments import perms as perms_mod
from app.services.comments.service import excerpt


async def _send(db, ev, user_ids, kind: str, text: str | None) -> None:
    from app.services import notifications

    tid = str(ev.thread.get("_id")) if ev.thread.get("_id") is not None else None
    actor_id = getattr(ev.actor, "user_id", None)
    for uid in user_ids:
        if not uid or uid == actor_id:
            continue
        try:
            await notifications.notify(db, uid, kind, ev.doc, actor=ev.actor, thread_id=tid,
                                       extra={"excerpt": excerpt(text)} if text else None)
        except Exception:
            import logging

            logging.getLogger(__name__).exception("comment notification failed")


async def on_event(db, ev) -> None:
    if not getattr(ev.actor, "user_id", None):
        return
    if not perms_mod.eligible(ev.doc) or ev.doc.get("comments_off") is True:
        return
    body = (ev.message or {}).get("body")
    owner = ev.doc.get("owner_id")
    mentioned = list(ev.new_mentions or [])
    if ev.kind == "thread_created":
        await _send(db, ev, mentioned, "comment_mention", body)
        if owner and owner not in mentioned:
            await _send(db, ev, [owner], "comment_new", body)
    elif ev.kind == "replied":
        await _send(db, ev, mentioned, "comment_mention", body)
        rest = [u for u in (ev.thread.get("participants") or []) if u not in mentioned]
        await _send(db, ev, rest, "comment_reply", body)
    elif ev.kind == "message_edited":
        await _send(db, ev, mentioned, "comment_mention", body)
    elif ev.kind == "resolved":
        author = ev.thread.get("created_by")
        if author:
            await _send(db, ev, [author], "comment_resolved", None)
    elif ev.kind == "assigned":
        who = (ev.extra or {}).get("assignee") or ev.thread.get("assignee")
        if who:
            first = await _first_body(db, ev.thread)
            await _send(db, ev, [who], "comment_assigned", first)


async def _first_body(db, thread: dict) -> str | None:
    from app.services.comments.model import MESSAGES

    if thread.get("_id") is None:
        return None
    m = await db[MESSAGES].find_one({"thread_id": thread["_id"], "deleted_at": None}, {"body": 1},
                                    sort=[("created_at", 1)])
    return (m or {}).get("body")
