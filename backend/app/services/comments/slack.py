"""Comments in Slack (Track C): a direct message when someone @mentions you in a comment or assigns a thread to
you, with **Reply** (a modal; the reply is posted as you) and **Resolve**.

How it rides on the existing Slack app (services/slack*.py), with no new scopes or manifest changes:

* The bell row (Track A's notify_app → notifications.notify) is queued for Slack like every other kind
  (slack_notify.queue_notification): only for a linked person who turned Slack notifications on and keeps
  "Mentions in comments" / "Comments assigned to you" on (slack.NOTIFY_KINDS). A comment mention waits a
  minute first (slack_notify.SLOW_KINDS), so a mention edited out right away never reaches anyone.
* At send time (:func:`dm_message`) it checks again: the thread is still there and still about them, and
  they can still see comments on the item (notify_email.still_relevant). Resolve shows only to someone who may
  resolve that thread (its author or an editor).
* Buttons carry team-bound signed values (``cm|doc|thread|op``); a click is handled as the clicker's linked
  Markdrop account through Track A's service (``service.reply`` / ``service.resolve``), so every access rule
  and rate limit is the app's own. Reply opens a modal (``views.open``, bot token only); its submission
  (``view_submission``, callback ``md_cm_reply``) posts the reply and updates the DM.
* Resolved anywhere (the app, MCP, Slack): every DM sent about that thread loses its Resolve button and says
  who resolved it (:func:`_on_resolved`, an events handler).
"""

from __future__ import annotations

import logging

from bson import ObjectId
from fastapi import HTTPException

from app.services.comments import events

log = logging.getLogger("markdrop.slack")

MAX_UPDATES = 20


def _oid(v) -> ObjectId | None:
    if isinstance(v, ObjectId):
        return v
    return ObjectId(v) if isinstance(v, str) and ObjectId.is_valid(v) else None


def _detail(exc: HTTPException) -> str:
    d = exc.detail
    if isinstance(d, dict):
        d = d.get("detail")
    return d if isinstance(d, str) and d else "Markdrop couldn't do that."


async def _thread_url(raw: dict, thread_id: str) -> str:
    from app.services import urls

    return urls.markdrop_url(raw["slug"]) + f"#c-{thread_id}"


async def _can_resolve(db, urow: dict, raw: dict, thread: dict) -> bool:
    from app.services import access, notifications
    from app.services.comments import perms

    try:
        actor = access.Actor.of(notifications._as_user(urow), cred="session")
        return await perms.can_resolve(db, actor, raw, access.Ctx(db, surface="slack"), thread)
    except Exception:
        return False


async def dm_message(db, inst: dict, n: dict, urow: dict, raw: dict, *, where: str | None = None,
                     done: str | None = None) -> dict | None:
    """The direct message for bell row ``n`` (comment_mention / comment_assigned), or None when it shouldn't go."""
    from app.services import md_outline
    from app.services import slack_blocks as kit
    from app.services.comments import notify_email

    thread = await db["comment_threads"].find_one({"_id": _oid(n.get("thread_id"))}) if _oid(n.get("thread_id")) else None
    if await notify_email.still_relevant(db, n, raw, thread, urow) is not None:
        return None
    tid = str(thread["_id"])
    return kit.dm_comment(
        inst["_id"], n["kind"], n.get("actor_name") or "Someone", md_outline.display_title(raw),
        await _thread_url(raw, tid), (n.get("extra") or {}).get("excerpt"), notify_email.anchor_quote(thread),
        str(raw["_id"]), tid, can_resolve=await _can_resolve(db, urow, raw, thread), done=done,
        resolved=thread.get("status") == "resolved", where=where)


async def _load(db, doc_id: str, thread_id: str) -> tuple[dict | None, dict | None]:
    raw = await db["documents"].find_one({"_id": _oid(doc_id)}) if _oid(doc_id) else None
    thread = await db["comment_threads"].find_one({"_id": _oid(thread_id), "doc_id": doc_id}) \
        if raw is not None and _oid(thread_id) else None
    return raw, thread


async def _rerender(db, inst: dict, user_id: str, raw: dict, thread: dict, *, done: str | None) -> dict | None:
    """The DM again for ``user_id`` (after a click), from their newest bell row about this thread."""
    n = await db["notifications"].find_one(
        {"user_id": user_id, "thread_id": str(thread["_id"]), "kind": {"$in": ["comment_mention", "comment_assigned"]}},
        sort=[("created_at", -1)])
    urow = await db["users"].find_one({"_id": _oid(user_id)})
    if n is None or urow is None:
        return None
    from app.services import slack_notify

    return await dm_message(db, inst, n, urow, raw, where=await slack_notify._workspace_name(db, raw), done=done)


async def click(db, inst: dict, user, parts: list[str], action_id: str, payload: dict) -> None:
    """A Reply or Resolve click (``parts`` = ``["cm", doc_id, thread_id, op]``), as ``user`` (their linked account)."""
    from app.services import access, md_outline, slack, slack_api
    from app.services import slack_blocks as kit
    from app.services.comments import notify_email, service

    response_url = payload.get("response_url")
    _, doc_id, thread_id, op = parts
    raw, thread = await _load(db, doc_id, thread_id)
    if raw is None or thread is None or thread.get("deleted_at") is not None:
        await slack_api.respond(response_url, kit.notice("That comment was deleted, or its page is gone."))
        return
    actor, ctx = access.Actor.of(user, cred="session"), access.Ctx(db, surface="slack")
    if op == "x" and action_id == "md_cm_resolve":
        try:
            await service.resolve(db, actor, raw, ctx, thread_id)
        except HTTPException as exc:
            await slack_api.respond(response_url, kit.notice(_detail(exc)))
            return
        thread = await db["comment_threads"].find_one({"_id": thread["_id"]}) or thread
        msg = await _rerender(db, inst, user.id, raw, thread, done="Resolved by you.")
        if msg:
            from app.services import slack_events

            await slack_events._update_message(inst, payload, msg)
        return
    if op == "r" and action_id == "md_cm_reply":
        token = slack.bot_token(inst)
        trigger = payload.get("trigger_id")
        cont = payload.get("container") or {}
        chan = cont.get("channel_id") or (payload.get("channel") or {}).get("id") or ""
        ts = cont.get("message_ts") or (payload.get("message") or {}).get("ts") or ""
        if not token or not trigger:
            await slack_api.respond(response_url, kit.notice("Open the thread in Markdrop to reply."))
            return
        last = await db["comment_messages"].find_one({"thread_id": thread["_id"], "deleted_at": None},
                                                       sort=[("created_at", -1)])
        meta = slack.sign_value(inst["_id"], "cmr", doc_id, thread_id, chan, ts)
        view = kit.comment_reply_modal(md_outline.display_title(raw), (last or {}).get("body"),
                                       notify_email.anchor_quote(thread), meta)
        try:
            await slack_api.call("views.open", token, trigger_id=trigger, view=view)
        except slack_api.SlackError as exc:
            log.info("slack: views.open for a comment reply failed: %s", exc.error)
            await slack_api.respond(response_url, kit.notice("Slack couldn't open the reply box. Open the thread in Markdrop to reply."))


def reply_text(payload: dict) -> str:
    vals = ((payload.get("view") or {}).get("state") or {}).get("values") or {}
    return str(((vals.get("reply") or {}).get("body") or {}).get("value") or "").strip()


async def submit(db, payload: dict) -> None:
    """A Reply modal's ``view_submission`` (already verified as Slack's): the reply, as the linked account."""
    from app.services import access, slack, slack_api
    from app.services import slack_blocks as kit
    from app.services.comments import service

    view = payload.get("view") or {}
    if view.get("callback_id") != kit.COMMENT_REPLY_CALLBACK:
        return
    team_id = ((payload.get("team") or {}).get("id")) or ""
    slack_user = ((payload.get("user") or {}).get("id")) or ""
    inst = await slack.get_install(db, team_id)
    parts = slack.read_value(team_id, view.get("private_metadata")) if inst else None
    if inst is None or parts is None or len(parts) != 5 or parts[0] != "cmr":
        log.info("slack: refused a comment reply with a forged or foreign value (team %s)", team_id)
        return
    _, doc_id, thread_id, chan, ts = parts
    token = slack.bot_token(inst)

    async def tell(text: str) -> None:
        if token and chan:
            try:
                await slack_api.call("chat.postMessage", token, channel=chan, text=kit.esc(text),
                                     blocks=kit.notice(text).get("blocks"))
            except slack_api.SlackError as exc:
                log.info("slack: comment reply notice failed: %s", exc.error)

    user = await slack.linked_user(db, team_id, slack_user)
    if user is None:
        await tell("Link your Slack account to Markdrop to reply from here.")
        return
    body = reply_text(payload)
    if not body:
        return
    raw, thread = await _load(db, doc_id, thread_id)
    if raw is None or thread is None or thread.get("deleted_at") is not None:
        await tell("That comment was deleted, or its page is gone, so your reply wasn't posted.")
        return
    actor, ctx = access.Actor.of(user, cred="session"), access.Ctx(db, surface="slack")
    try:
        await service.reply(db, actor, raw, ctx, thread_id, body=body[:5000])
    except HTTPException as exc:
        await tell(f"Your reply wasn't posted: {_detail(exc)}")
        return
    thread = await db["comment_threads"].find_one({"_id": thread["_id"]}) or thread
    msg = await _rerender(db, inst, user.id, raw, thread, done=f"You replied: “{body}”")
    if msg and token and chan and ts:
        try:
            await slack_api.call("chat.update", token, channel=chan, ts=ts, blocks=msg["blocks"], text=msg["text"])
        except slack_api.SlackError as exc:
            log.info("slack: chat.update after a comment reply: %s", exc.error)


async def _on_resolved(db, ev: events.CommentEvent) -> None:
    """Resolved (or reopened) anywhere: the DMs sent about this thread follow (Resolve button off / back)."""
    from app.services import slack as slack_svc
    from app.services import slack_api, slack_notify
    from app.services.comments import notify_email  # noqa: F401

    if not slack_svc.configured():
        return
    tid = str(ev.thread["_id"])
    refs = [str(r["_id"]) async for r in db["notifications"].find(
        {"thread_id": tid, "kind": {"$in": ["comment_mention", "comment_assigned"]}}, {"_id": 1}).limit(200)]
    if not refs:
        return
    user = getattr(ev.actor, "user", None)
    who = getattr(user, "name", None) or getattr(user, "email", None) or "someone"
    done = f"Resolved by {who}." if ev.kind == "resolved" else None
    sent = await db[slack_notify.OUTBOX].find({"ref": {"$in": refs}, "state": "sent", "ts": {"$ne": None}}).to_list(
        length=MAX_UPDATES)
    for o in sent:
        try:
            inst = await slack_svc.get_install(db, o["team_id"])
            token = slack_svc.bot_token(inst)
            n = await db["notifications"].find_one({"_id": _oid(o["ref"])})
            urow = await db["users"].find_one({"_id": _oid(o["user_id"])})
            if not token or n is None or urow is None:
                continue
            msg = await dm_message(db, inst, n, urow, ev.doc, where=await slack_notify._workspace_name(db, ev.doc),
                                   done=done)
            if msg is None:
                continue
            await slack_api.call("chat.update", token, channel=o.get("channel") or o["slack_user_id"], ts=o["ts"],
                                 blocks=msg["blocks"], text=msg["text"])
        except Exception:
            log.info("slack: updating a comment DM after %s failed", ev.kind, exc_info=True)


async def _on_resolved_bg(db, ev: events.CommentEvent) -> None:
    from app.services import slack as slack_svc

    if slack_svc.configured():
        slack_svc.spawn(_on_resolved(db, ev))   # Slack calls never hold up the write


events.on(_on_resolved_bg, kinds=["resolved", "reopened"], name="slack.comment_dm_state")
