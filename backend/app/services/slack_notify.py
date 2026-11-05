"""What Markdrop posts to Slack on its own: meeting notes in a channel, and direct messages.

Meeting posts
    When a meeting's AI summary is ready (meetings_ai._generate → :func:`meeting_ready`), the
    summary, decisions and action items go to the workspace's meetings channel, each action item
    with a **Done** button. Only a meeting the whole channel may see is posted (:func:`channel_may_see`:
    link-public, or the workspace's own audience in a channel that isn't shared with other
    organizations); one restricted to its attendees never is. A click ticks the item on the page
    (``- [ ]`` → ``- [x]``, found by its block id) as the person who clicked, through the normal
    save path, and updates the message.

Direct messages (``slack_outbox``)
    notifications.notify() (mentions, sign-off requests, shares) and access_requests.create()
    queue one row per linked recipient whose preference allows the kind; :func:`flush` (a
    background loop) sends them, checking again at send time that the person may open the page.
    Bell and email are unaffected.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.services import slack, slack_api
from app.services import slack_blocks as kit

log = logging.getLogger("markdrop.slack")

POSTS = "slack_posts"
OUTBOX = "slack_outbox"
MAX_ATTEMPTS = 5
STUCK = timedelta(minutes=5)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _oid(v: Any) -> ObjectId | None:
    if isinstance(v, ObjectId):
        return v
    return ObjectId(v) if isinstance(v, str) and ObjectId.is_valid(v) else None


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[POSTS].create_index("key", unique=True)
    await db[POSTS].create_index("meeting_id")
    await db[OUTBOX].create_index([("state", 1), ("next_at", 1)])
    await db[OUTBOX].create_index("created_at", expireAfterSeconds=30 * 24 * 3600)


# ── Who may see it: the channel's audience ────────────────────────────────────


async def channel_is_shared(token: str | None, channel: str | None) -> bool:
    """True unless Slack confirms the conversation isn't shared with another organization
    (Slack Connect). Unknown (the composer, an error) counts as shared: link-public only."""
    if not token or not channel or channel == "COMPOSER":
        return True
    try:
        r = await slack_api.call("conversations.info", token, channel=channel)
    except slack_api.SlackError:
        return True
    c = r.get("channel") or {}
    return bool(c.get("is_ext_shared") or c.get("is_shared") or c.get("is_pending_ext_shared"))


async def channel_may_see(db: AsyncIOMotorDatabase, inst: dict, raw: dict | None, *, shared: bool) -> bool:
    """May everyone in a channel of this Slack team open ``raw``? Link-public (no password, no
    sign-in wall) always; the team's own Markdrop workspace audience only when the channel isn't
    shared with another organization."""
    from app.services import access

    if raw is None:
        return False
    if await access.anonymous_can_read(db, raw):
        return True
    if shared:
        return False
    ctx = access.Ctx(db)
    eff = await access.effective_doc(db, raw, ctx)
    from app.services import publicity

    return ((eff.get("access_level") or "link") == "workspace"
            and bool(eff.get("workspace_id")) and eff.get("workspace_id") == inst.get("workspace_id")
            and not eff.get("read_password_hash")
            and not publicity.is_expired(raw, ctx.now))


# ── Meeting posts ─────────────────────────────────────────────────────────────

_TODO = re.compile(r"^(?P<lead>[ \t]{0,3}[-*+][ \t]+)\[(?P<mark>[ xX])\](?P<rest>[ \t].*?)[ \t]*\{#(?P<block>b-[0-9A-Za-z_-]+)\}[ \t]*$",
                   re.M)
_PERSON = re.compile(r':person\[([^\]\n]*)\]\{id="([0-9a-f]{24})"\}')
_CITE = re.compile(r"\s*\[\d{1,2}:\d{2}(?::\d{2})?\]\([^)\s]*#b-t\d+\)|\s*\[#\d+\]\([^)\s]*#b-t\d+\)")


def _section(md: str, heading: str) -> str:
    m = re.search(rf"^## {re.escape(heading)}[ \t]*$", md or "", re.M)
    if not m:
        return ""
    rest = (md or "")[m.end():]
    nxt = re.search(r"^#{1,2} ", rest, re.M)
    return rest[: nxt.start()] if nxt else rest


async def _slack_names(db: AsyncIOMotorDatabase, team_id: str, user_ids: set[str]) -> dict[str, str]:
    if not user_ids:
        return {}
    rows = await db[slack.LINKS].find({"team_id": team_id, "user_id": {"$in": list(user_ids)}}).to_list(length=500)
    return {r["user_id"]: r["slack_user_id"] for r in rows}


async def action_items(db: AsyncIOMotorDatabase, team_id: str, md: str) -> list[dict]:
    """The to-dos under "## Action items": [{block, done, text (mrkdwn)}]. A member who has linked
    Slack is @mentioned there; anyone else is shown by name."""
    from app.services import search_text

    sec = _section(md, "Action items")
    found = list(_TODO.finditer(sec))
    ids = {pm.group(2) for m in found for pm in _PERSON.finditer(m.group("rest"))}
    slack_ids = await _slack_names(db, team_id, ids)
    out = []
    for m in found:
        rest = _CITE.sub("", m.group("rest"))
        marks: list[str] = []

        def person(pm: re.Match) -> str:
            sid = slack_ids.get(pm.group(2))
            marks.append(f"<@{sid}>" if sid else f"*{kit.esc(pm.group(1))}*")
            return f"MDPERSON{len(marks) - 1}MDPERSON"

        rest = _PERSON.sub(person, rest)
        text = kit.esc(search_text.markdown_text(rest).replace("\n", " "))
        text = re.sub(r"MDPERSON(\d+)MDPERSON", lambda x: marks[int(x.group(1))], text)
        out.append({"block": m.group("block"), "done": m.group("mark") in "xX", "text": kit.cut(text, 600)})
    return out


def _when(row: dict) -> str | None:
    d = row.get("date")
    if not d:
        return None
    try:
        day = datetime.strptime(d, "%Y-%m-%d").strftime("%a %b %-d, %Y")
    except ValueError:
        day = d
    return f"{day} · {row['time']}" if row.get("time") else day


def _render_post(post: dict) -> dict:
    return kit.meeting_post(post["team_id"], str(post["_id"]), title=post["title"], url=post["url"], when=post.get("when"),
                            summary=post.get("summary"), decisions=post.get("decisions") or [],
                            items=post.get("items") or [])


async def post_meeting(db: AsyncIOMotorDatabase, meeting_id: str, *, again: bool = False) -> dict:
    """Post this meeting to its workspace's meetings channel. Returns {posted, reason, …}."""
    from app.services import meetings, md_outline, urls

    row = await meetings.get_row(db, meeting_id)
    if row is None:
        return {"posted": False, "reason": "not_found"}
    inst = await slack.install_for_workspace(db, row.get("workspace_id"))
    if inst is None:
        return {"posted": False, "reason": "not_connected"}
    chan = (inst.get("meetings_channel") or {}).get("id")
    if not chan:
        return {"posted": False, "reason": "no_channel"}
    if not again and inst.get("post_meetings") is False:
        return {"posted": False, "reason": "off"}
    token = slack.bot_token(inst)
    if not token:
        return {"posted": False, "reason": "token"}
    raw = await meetings.page_of(db, row)
    if raw is None:
        return {"posted": False, "reason": "not_found"}
    if row.get("restricted") or not await channel_may_see(db, inst, raw, shared=await channel_is_shared(token, chan)):
        return {"posted": False, "reason": "private"}
    gen = row.get("generated") or {}
    notes = row.get("notes") or {}
    summary = (notes.get("summary") or gen.get("summary") or "").strip()
    decisions = [d.get("text") if isinstance(d, dict) else str(d) for d in gen.get("decisions") or []]
    items = await action_items(db, inst["_id"], raw.get("content") or "")
    key = f"m:{meeting_id}:{inst['_id']}:{(row.get('ai') or {}).get('at') or ''}"
    if again:
        key += f":{_now().timestamp()}"
    post = {"key": key, "team_id": inst["_id"], "channel": chan, "ts": None, "meeting_id": str(row["_id"]),
            "doc_id": str(raw["_id"]), "title": md_outline.display_title(raw), "url": urls.markdrop_url(raw["slug"]),
            "when": _when(row), "summary": summary or None, "decisions": [d for d in decisions if d][:8],
            "items": [{"block": i["block"], "text": i["text"], "done_by": "Markdrop" if i["done"] else None} for i in items],
            "created_at": _now(), "state": "posting"}
    try:
        res = await db[POSTS].insert_one(post)
    except DuplicateKeyError:
        return {"posted": False, "reason": "already"}
    post["_id"] = res.inserted_id
    msg = _render_post(post)
    try:
        r = await slack_api.call("chat.postMessage", token, channel=chan, blocks=msg["blocks"], text=msg["text"],
                                 unfurl_links=False, unfurl_media=False)
    except slack_api.SlackError as exc:
        await db[POSTS].update_one({"_id": post["_id"]}, {"$set": {"state": "failed", "error": exc.error}})
        log.info("slack: meeting %s not posted to %s: %s", meeting_id, chan, exc.error)
        return {"posted": False, "reason": exc.error}
    await db[POSTS].update_one({"_id": post["_id"]}, {"$set": {"state": "posted", "ts": r.get("ts"),
                                                               "channel": r.get("channel") or chan}})
    return {"posted": True, "reason": None, "channel": (inst.get("meetings_channel") or {}).get("name"), "ts": r.get("ts")}


async def meeting_ready(db: AsyncIOMotorDatabase, meeting_id: str) -> None:
    """The hook in meetings_ai: never raises, never slows the meeting import (posts in the background)."""
    if not slack.configured():
        return

    async def go() -> None:
        try:
            await post_meeting(db, meeting_id)
        except Exception:
            log.warning("slack: posting meeting %s failed", meeting_id, exc_info=True)

    slack.spawn(go())


async def mark_done(db: AsyncIOMotorDatabase, inst: dict, user, post_id: str, block: str) -> str:
    """A Done click by ``user`` (their linked Markdrop account). Returns what to tell them."""
    from app.services import access, meetings, pages

    post = await db[POSTS].find_one({"_id": _oid(post_id)}) if _oid(post_id) else None
    if post is None or post.get("team_id") != inst["_id"]:
        return "That meeting post isn't from this Slack workspace."
    raw = await db["documents"].find_one({"_id": _oid(post.get("doc_id"))})
    if raw is None:
        return "That meeting's page is gone (deleted or in the trash)."
    actor, ctx = access.Actor.of(user, cred="session"), access.Ctx(db, surface="slack")
    d = await access.can(actor, raw, "edit_content", ctx)
    if not d.allowed:
        return "You can't edit that meeting's page in Markdrop, so you can't tick its action items."
    name = user.name or user.email
    for _attempt in range(3):
        content = raw.get("content") or ""
        hit = next((m for m in _TODO.finditer(content) if m.group("block") == block), None)
        if hit is None:
            return "That action item was changed or removed on the page."
        if hit.group("mark") in "xX":
            await _set_done(db, post, block, "someone in Markdrop")
            return "That one is already done."
        new = content[: hit.start("mark")] + "x" + content[hit.end("mark"):]
        try:
            await pages.check_page_lock(raw, actor, ctx, new)
            await meetings._save(db, raw, new, actor, ctx, base_rev=int(raw.get("rev") or 1))
        except HTTPException as exc:
            if exc.status_code == 409:
                raw = await db["documents"].find_one({"_id": raw["_id"]}) or raw
                continue
            if exc.status_code == 423:
                return "Someone is editing that page right now. Try again in a minute."
            return str(exc.detail) if isinstance(exc.detail, str) else "Markdrop couldn't save that."
        await _set_done(db, post, block, name)
        return ""
    return "That page keeps changing. Try again in a moment."


async def _set_done(db: AsyncIOMotorDatabase, post: dict, block: str, name: str) -> None:
    items = post.get("items") or []
    changed = False
    for it in items:
        if it["block"] == block and not it.get("done_by"):
            it["done_by"] = name[:80]
            changed = True
    if not changed:
        return
    await db[POSTS].update_one({"_id": post["_id"]}, {"$set": {"items": items}})
    inst = await slack.get_install(db, post["team_id"])
    token = slack.bot_token(inst)
    if not token or not post.get("ts"):
        return
    msg = _render_post({**post, "items": items})
    try:
        await slack_api.call("chat.update", token, channel=post["channel"], ts=post["ts"], blocks=msg["blocks"], text=msg["text"])
    except slack_api.SlackError as exc:
        log.info("slack: couldn't update the meeting post %s: %s", post["_id"], exc.error)


# ── Direct messages ───────────────────────────────────────────────────────────


async def _queue(db: AsyncIOMotorDatabase, user_id: str, kind: str, ref: str) -> int:
    if not slack.configured() or kind not in slack.NOTIFY_KINDS:
        return 0
    links = await db[slack.LINKS].find({"user_id": user_id}).to_list(length=20)
    if not links:
        return 0
    urow = await db["users"].find_one({"_id": _oid(user_id)}, {"slack_notify": 1}) if _oid(user_id) else None
    if not slack.prefs_of(urow).get(kind):
        return 0
    now = _now()
    rows = [{"user_id": user_id, "team_id": ln["team_id"], "slack_user_id": ln["slack_user_id"], "kind": kind,
             "ref": ref, "state": "pending", "attempts": 0, "next_at": now, "created_at": now} for ln in links]
    await db[OUTBOX].insert_many(rows)
    return len(rows)


async def queue_notification(db: AsyncIOMotorDatabase, row: dict) -> None:
    """notifications.notify() made ``row`` (mention / signoff_requested / shared)."""
    try:
        await _queue(db, row["user_id"], row["kind"], str(row["_id"]))
    except Exception:
        log.warning("slack: couldn't queue notification %s", row.get("_id"), exc_info=True)


async def queue_access_request(db: AsyncIOMotorDatabase, raw: dict, row: dict) -> None:
    """access_requests.create() made ``row``: DM whoever decides it (the owner, or the workspace's admins)."""
    try:
        if row.get("admin_workspace_id"):
            mem = await db["memberships"].find({"workspace_id": row["admin_workspace_id"],
                                                "role": {"$in": ["admin", "owner"]}}, {"user_id": 1}).to_list(length=50)
            deciders = [m["user_id"] for m in mem]
        else:
            deciders = [raw.get("owner_id")] if raw.get("owner_id") else []
        for uid in deciders:
            if uid and uid != row.get("requester_user_id"):
                await _queue(db, uid, "access_request", str(row["_id"]))
    except Exception:
        log.warning("slack: couldn't queue access request %s", row.get("_id"), exc_info=True)


async def _claim(db: AsyncIOMotorDatabase) -> dict | None:
    now = _now()
    return await db[OUTBOX].find_one_and_update(
        {"$or": [{"state": "pending", "next_at": {"$lte": now}},
                 {"state": "sending", "claimed_at": {"$lt": now - STUCK}}]},
        {"$set": {"state": "sending", "claimed_at": now}, "$inc": {"attempts": 1}},
        sort=[("next_at", 1)], return_document=ReturnDocument.AFTER)


async def flush(db: AsyncIOMotorDatabase, *, limit: int = 50) -> int:
    """Send what's queued (the background loop, every few seconds). Returns how many were sent."""
    if not slack.configured():
        return 0
    sent = 0
    for _ in range(limit):
        row = await _claim(db)
        if row is None:
            break
        try:
            state, extra = await _deliver(db, row)
        except slack_api.SlackError as exc:
            if exc.error == "ratelimited" or exc.status in (0, 500, 502, 503):
                if row["attempts"] < MAX_ATTEMPTS:
                    wait = exc.retry_after or 30 * row["attempts"]
                    await db[OUTBOX].update_one({"_id": row["_id"]}, {"$set": {
                        "state": "pending", "next_at": _now() + timedelta(seconds=wait), "error": exc.error}})
                    continue
            state, extra = "failed", {"error": exc.error}
            if exc.dead_token:
                await slack.forget_team(db, row["team_id"])
        except Exception as exc:  # never let one row stop the queue
            log.warning("slack: DM %s failed", row["_id"], exc_info=True)
            state, extra = "failed", {"error": type(exc).__name__}
        await db[OUTBOX].update_one({"_id": row["_id"]}, {"$set": {"state": state, "done_at": _now(), **extra}})
        sent += state == "sent"
    return sent


async def _deliver(db: AsyncIOMotorDatabase, row: dict) -> tuple[str, dict]:
    inst = await slack.get_install(db, row["team_id"])
    link = await db[slack.LINKS].find_one({"_id": f"{row['team_id']}:{row['slack_user_id']}"})
    if inst is None or link is None or link.get("user_id") != row["user_id"]:
        return "skipped", {"error": "unlinked"}
    token = slack.bot_token(inst)
    if not token:
        return "skipped", {"error": "token"}
    urow = await db["users"].find_one({"_id": _oid(row["user_id"])})
    if urow is None or not slack.prefs_of(urow).get(row["kind"]):
        return "skipped", {"error": "off"}
    if row["kind"] == "access_request":
        msg = await _access_request_message(db, inst, row)
    else:
        msg = await _notification_message(db, inst, row, urow)
    if msg is None:
        return "skipped", {"error": "gone"}
    r = await slack_api.call("chat.postMessage", token, channel=row["slack_user_id"], blocks=msg["blocks"],
                             text=msg["text"], unfurl_links=False, unfurl_media=False)
    return "sent", {"channel": r.get("channel"), "ts": r.get("ts")}


async def _notification_message(db: AsyncIOMotorDatabase, inst: dict, row: dict, urow: dict) -> dict | None:
    from app.services import md_outline, notifications, signoffs, urls

    n = await db["notifications"].find_one({"_id": _oid(row["ref"])})
    if n is None:
        return None
    raw = await db["documents"].find_one({"_id": _oid(n.get("doc_id"))})
    # Checked again now: they may have lost access since the notification was made.
    if raw is None or raw.get("encrypted") or not await notifications.can_open(db, urow, raw):
        return None
    title = md_outline.display_title(raw)
    url = urls.markdrop_url(raw["slug"])
    extra = n.get("extra") or {}
    actor = n.get("actor_name") or "Someone"
    if n["kind"] == "mention":
        return kit.dm_mention(actor, title, url + (f"#{n['block_id']}" if n.get("block_id") else ""), extra.get("excerpt"))
    if n["kind"] == "shared":
        return kit.dm_shared(actor, title, url, extra.get("role"), extra.get("message"))
    if n["kind"] == "signoff_requested":
        b = signoffs.find(raw.get("content"), n.get("block_id") or "") if n.get("block_id") else None
        options = b.options if b is not None and b.person == row["user_id"] else []
        return kit.dm_signoff(inst["_id"], actor, title, url + (f"#{n['block_id']}" if n.get("block_id") else ""),
                              extra.get("label") or (b.label if b else None), str(raw["_id"]), n.get("block_id") or "",
                              options, done=None if options else "Open the page to sign off.")
    return None


async def _access_request_message(db: AsyncIOMotorDatabase, inst: dict, row: dict) -> dict | None:
    from app.services import access_requests, md_outline, urls

    req = await db[access_requests.COLL].find_one({"_id": _oid(row["ref"])})
    if req is None or req.get("status") != "pending":
        return None
    raw = await db["documents"].find_one({"_id": _oid(req.get("doc_id"))})
    if raw is None:
        return None
    title = md_outline.display_title(raw)
    review = slack.frontend_link(f"/requests/{req['_id']}")
    return kit.dm_access_request(inst["_id"], req.get("requester_name") or req.get("requester_email") or "Someone",
                                 req.get("requester_email"), title, review, str(req["_id"]),
                                 access_requests.requested_role(req) == "editor", req.get("message"),
                                 bool(req.get("admin_workspace_id")))
