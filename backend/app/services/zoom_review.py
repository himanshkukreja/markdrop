"""Zoom: which recorded meetings come in, and the host's say (owner + Prakhar, 2026-11-18;
brief .work/briefs/zoom-share-control.md).

**Each host's setting** "When my Zoom meetings are recorded" (``users.zoom_share``): ``auto`` (share
automatically, the default), ``ask`` (ask me first) or ``never`` (never bring them in). The person sets it in
Settings › Account › Zoom; a workspace admin can set it for the Zoom team's members on the Zoom card.

**The rules**, in this order, for every recorded meeting of a Zoom-team member (services/zoom.handle_recording,
the webhook and Import past meetings alike), before anything is downloaded:

1. The Zoom topic has the word "personal" or "private" (any case) → never imported. Only the meeting's
   uuid and the reason are kept (so it isn't looked at again).
2. The host's setting is ``never`` → skipped the same way.
3. Someone on the call is from outside the company (an address that isn't a workspace member's and
   isn't at one of the members' company domains: :func:`company_domains`) → shared automatically.
4. Everyone on the call is from the company → the host is asked first.
5. Otherwise (Zoom gave no address for someone, or no participants at all) → the host's setting.

**Ask first = held.** Only metadata is kept: topic, start, duration, participants' names and count, uuid
(no transcript, no captions, no audio, no recording, nothing sent to Deepgram), and nobody but the host
sees it. The host is told once: a Markdrop inbox item, and a Slack DM with **Share with <team>**, **Keep it
just for me** and **Skip** when their Slack account is linked. Only the host decides (the buttons work
only for the Slack user they were sent to; the API checks the host's Markdrop account):

* share   → imported as usual, into the Zoom team (the meeting is fetched from Zoom again).
* private → imported restricted to the host alone (a private page, no attendee grants).
* skip    → dropped: only the uuid and "skipped" stay.

Held meetings expire after :data:`HOLD_DAYS` days (Zoom keeps the recording): the metadata is deleted.
Meetings imported before this existed stay as they are.

Collections
    users.zoom_share     "auto" | "ask" | "never" (absent: auto)
    zoom_meetings        state held: topic, start_time, date, duration_min, host, people {names, count},
                         reason, held_at, expires_at, review_id, slack {team, user, channel, ts}; then
                         decision (share | private), decided_at, decided_by; skipped | expired: uuid + reason
"""

from __future__ import annotations

import logging
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

log = logging.getLogger("markdrop.zoom")

CHOICES = ("auto", "ask", "never")
DEFAULT = "auto"
DECISIONS = ("share", "private", "skip")
HOLD_DAYS = 30
HELD, SKIPPED, EXPIRED = "held", "skipped", "expired"
CLOSED = (SKIPPED, EXPIRED)
NOTIFICATION_KIND = "zoom_review"
REVIEW_PATH = "/integrations/zoom/review"
SETTINGS_PATH = "/settings/account#zoom"
_PERSONAL = re.compile(r"\b(personal|private)\b", re.IGNORECASE)

# Why a meeting was held or skipped (shown to the host, and as the skip reason to importers).
REASONS = {
    "personal": "Its Zoom topic says it's personal or private, so Markdrop never brings it in.",
    "host_never": "Its host chose to never bring their Zoom meetings in.",
    "internal_only": "Everyone on it is from the company, so its host decides whether to share it.",
    "host_ask": "Its host asked to decide before their Zoom meetings are shared.",
    "host_skipped": "Its host chose not to bring it in.",
    "expired": f"Nobody decided within {HOLD_DAYS} days. It's still in Zoom.",
}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def choice_of(user_row: dict | None) -> str:
    v = (user_row or {}).get("zoom_share")
    return v if v in CHOICES else DEFAULT


def personal_topic(topic: Any) -> bool:
    """Rule 1: the word "personal" or "private" in the Zoom topic (any case)."""
    return bool(_PERSONAL.search(str(topic or "")))


# ── Who's on the call ─────────────────────────────────────────────────────────


async def company(db: AsyncIOMotorDatabase, workspace_id: str) -> tuple[set[str], set[str]]:
    """(the workspace members' addresses, their company domains). Public mail domains (gmail.com, …) are
    never a company domain: a member on Gmail doesn't make every Gmail address internal."""
    from app.services.docs_page_access import PUBLIC_DOMAINS

    ids = [m["user_id"] async for m in db["memberships"].find({"workspace_id": str(workspace_id)}, {"user_id": 1})]
    oids = [ObjectId(i) for i in ids if ObjectId.is_valid(str(i))]
    emails = {str(u.get("email") or "").lower() async for u in db["users"].find({"_id": {"$in": oids}}, {"email": 1})}
    emails.discard("")
    domains = {e.rsplit("@", 1)[1] for e in emails if "@" in e} - set(PUBLIC_DOMAINS)
    return emails, domains


def audience(people: list[dict], emails: set[str], domains: set[str]) -> str:
    """"external" (someone from outside the company), "internal" (everyone has an address, all the
    company's) or "unknown" (no participants, or someone without an address and nobody external)."""
    if not people:
        return "unknown"
    unknown = False
    for p in people:
        e = str(p.get("email") or "").lower()
        if not e:
            unknown = True
        elif e not in emails and e.rsplit("@", 1)[-1] not in domains:
            return "external"
    return "unknown" if unknown else "internal"


async def rule(db: AsyncIOMotorDatabase, workspace_id: str, host: dict, topic: Any,
               people: list[dict] | None) -> tuple[str, str]:
    """(action, reason): action "share" | "hold" | "skip". ``people`` None: not asked yet (rules 1–2 only
    need the topic and the setting; the caller asks Zoom only when they pass)."""
    if personal_topic(topic):
        return "skip", "personal"
    u = await db["users"].find_one({"_id": ObjectId(host["id"])}, {"zoom_share": 1}) if ObjectId.is_valid(str(host.get("id"))) else None
    choice = choice_of(u)
    if choice == "never":
        return "skip", "host_never"
    if people is None:
        return "people", ""
    emails, domains = await company(db, workspace_id)
    who = audience(people, emails, domains)
    if who == "external":
        return "share", "external"
    if who == "internal":
        return "hold", "internal_only"
    return ("hold", "host_ask") if choice == "ask" else ("share", "host_auto")


# ── Held / skipped rows ───────────────────────────────────────────────────────


async def skip(db: AsyncIOMotorDatabase, key: str, workspace_id: str, uuid: str, reason: str) -> None:
    """Keep nothing but the uuid and why (so the meeting isn't looked at again)."""
    from app.services import zoom

    now = now_utc()
    await db[zoom.MEETINGS].replace_one({"_id": key}, {"workspace_id": workspace_id, "uuid": uuid, "state": SKIPPED,
                                                       "reason": reason, "at": now, "created_at": now}, upsert=True)
    await zoom._count(db, workspace_id, "skipped")


async def hold(db: AsyncIOMotorDatabase, conn: dict, key: str, base: dict, people: list[dict], reason: str) -> bool:
    """Hold the meeting for its host. True when it is newly held (the host is told then, once)."""
    from app.services import zoom

    now = now_utc()
    row = {k: base.get(k) for k in ("workspace_id", "uuid", "meeting_id", "topic", "start_time", "date",
                                    "duration_min", "host", "via")}
    names = [p["name"] for p in people if p.get("name")]
    row.update(state=HELD, reason=reason, at=now, held_at=now, expires_at=now + timedelta(days=HOLD_DAYS),
               people={"names": names[:30], "count": len(people)}, review_id=secrets.token_urlsafe(9),
               time=base.get("time"))
    try:
        res = await db[zoom.MEETINGS].update_one(
            {"_id": key, "state": {"$nin": ["processing", HELD, *CLOSED, *zoom.DONE]}},
            {"$set": row, "$setOnInsert": {"created_at": now}}, upsert=True)
    except DuplicateKeyError:      # it is held, skipped, being imported or in already
        return False
    if not (res.upserted_id or res.modified_count):
        return False
    await zoom._count(db, conn["_id"], "held")
    return True


# ── Telling the host ──────────────────────────────────────────────────────────


async def _team_name(db: AsyncIOMotorDatabase, conn: dict) -> str:
    from app.services import zoom

    t = await zoom._team(db, conn["_id"], conn.get("team_id"))
    return (t or {}).get("name") or "the team"


def _when(row: dict) -> str:
    bits = [b for b in (row.get("date"), row.get("time")) if b]
    if row.get("duration_min"):
        bits.append(f"{row['duration_min']} min")
    n = int((row.get("people") or {}).get("count") or 0)
    if n:
        bits.append(f"{n} {'person' if n == 1 else 'people'}")
    return " · ".join(bits)


def review_url(workspace_id: str) -> str:
    from app.services import slack

    return slack.frontend_link(f"{REVIEW_PATH}?workspace={workspace_id}")


def slack_message(team_id: str, row: dict, team_name: str, where: str | None, done: str | None = None) -> dict:
    from app.services import slack
    from app.services import slack_blocks as kit

    rid = row.get("review_id") or ""
    topic = kit.cut(row.get("topic") or "Zoom meeting", 120)
    blocks: list[dict | None] = [
        kit.eyebrow("Zoom", where),
        kit.section(f"Your Zoom meeting *{kit.esc(topic)}* was recorded. Should it come into Markdrop?"),
        kit.context(kit.esc(" · ".join(x for x in (_when(row), REASONS.get(row.get("reason") or "", "")) if x))),
    ]
    if done:
        blocks.append(kit.context(f"{kit.DONE_MARK}  {kit.esc(done)}"))
    else:
        blocks.append(kit.actions(
            kit.button(f"Share with {team_name}", action_id="md_zr_share", value=slack.sign_value(team_id, "zr", "share", rid), style="primary"),
            kit.button("Keep it just for me", action_id="md_zr_private", value=slack.sign_value(team_id, "zr", "private", rid)),
            kit.button("Skip", action_id="md_zr_skip", value=slack.sign_value(team_id, "zr", "skip", rid)),
        ))
        blocks.append(kit.context(f"Only you can see this until you decide. Nothing is downloaded until then. "
                                  f"{kit.link(slack.frontend_link(SETTINGS_PATH), 'Change when Markdrop asks')}"))
    return kit.message(blocks, f"Your Zoom meeting {row.get('topic') or ''} was recorded: share it?")


async def notify(db: AsyncIOMotorDatabase, conn: dict, key: str, *, slack_dm: bool = True) -> dict:
    """The host's inbox item (and Slack DM with buttons when ``slack_dm`` and their Slack is linked), once."""
    from app.services import notifications, zoom

    row = await db[zoom.MEETINGS].find_one({"_id": key})
    if row is None or row.get("state") != HELD or row.get("notified_at"):
        return {}
    claim = await db[zoom.MEETINGS].update_one({"_id": key, "notified_at": {"$exists": False}},
                                               {"$set": {"notified_at": now_utc()}})
    if not claim.modified_count:
        return {}
    uid = (row.get("host") or {}).get("id")
    out: dict[str, Any] = {}
    now = now_utc()
    n = {"user_id": uid, "kind": NOTIFICATION_KIND, "doc_id": None, "block_id": None, "actor_id": None,
         "actor_name": "Zoom", "via": "zoom", "workspace_id": conn["_id"], "zoom_key": key,
         "extra": {"label": str(row.get("topic") or "Zoom meeting")[:120]},
         "created_at": now, "read_at": None, "email": "off", "email_at": now, "emailed_at": None}
    out["inbox"] = str((await db[notifications.COLL].insert_one(n)).inserted_id)
    if slack_dm:
        from app.services import hubspot_notify, slack_api

        s = await hubspot_notify._slack_for(db, conn["_id"], uid)
        if s is not None:
            inst, token, su = s
            msg = slack_message(inst["_id"], row, await _team_name(db, conn), await hubspot_notify._ws_name(db, conn["_id"]))
            slack_row: dict[str, Any] = {"team": inst["_id"], "user": su}
            try:
                r = await slack_api.call("chat.postMessage", token, channel=su, unfurl_links=False, unfurl_media=False, **msg)
                slack_row.update(channel=r.get("channel"), ts=r.get("ts"))
            except slack_api.SlackError as exc:
                slack_row["error"] = exc.error
            await db[zoom.MEETINGS].update_one({"_id": key}, {"$set": {"slack": slack_row}})
            out["slack"] = slack_row
    return out


async def notify_backfill(db: AsyncIOMotorDatabase, conn: dict, host_id: str, keys: list[str]) -> None:
    """Import past meetings held some of this host's meetings: one inbox item for all of them (no Slack DMs)."""
    from app.services import notifications, zoom

    fresh = [k for k in keys if (await db[zoom.MEETINGS].update_one(
        {"_id": k, "state": HELD, "notified_at": {"$exists": False}}, {"$set": {"notified_at": now_utc()}})).modified_count]
    if not fresh:
        return
    now = now_utc()
    first = await db[zoom.MEETINGS].find_one({"_id": fresh[0]}, {"topic": 1})
    await db[notifications.COLL].insert_one({
        "user_id": host_id, "kind": NOTIFICATION_KIND, "doc_id": None, "block_id": None, "actor_id": None,
        "actor_name": "Zoom", "via": "zoom", "workspace_id": conn["_id"], "zoom_key": fresh[0] if len(fresh) == 1 else None,
        "extra": {"label": str((first or {}).get("topic") or "Zoom meeting")[:120], **({"count": len(fresh)} if len(fresh) > 1 else {})},
        "created_at": now, "read_at": None, "email": "off", "email_at": now, "emailed_at": None})


async def inbox_view(db: AsyncIOMotorDatabase, r: dict) -> dict:
    """An inbox item of :data:`NOTIFICATION_KIND` as its reader sees it (services/notifications._view)."""
    from app.services import slack, zoom

    ws = str(r.get("workspace_id") or "")
    extra = r.get("extra") or {}
    count = int(extra.get("count") or 1)
    if r.get("zoom_key"):
        z = await db[zoom.MEETINGS].find_one({"_id": r["zoom_key"]}, {"state": 1, "host": 1})
        ok = bool(z and z.get("state") == HELD and (z.get("host") or {}).get("id") == r.get("user_id"))
    else:
        ok = await db[zoom.MEETINGS].count_documents({"workspace_id": ws, "state": HELD, "host.id": r.get("user_id")}, limit=1) > 0
    label = extra.get("label")
    if count > 1:
        text = f"{count} of your past Zoom meetings wait for you to decide whether they come in"
    elif ok:
        text = f"Your Zoom meeting “{label}” was recorded: share it, keep it just for you, or skip it"
    else:
        text = "A Zoom meeting of yours was decided or is no longer waiting"
    path = f"{REVIEW_PATH}?workspace={ws}"
    return {"available": ok, "text": text, "href": path if ok else None,
            "url": slack.frontend_link(path) if ok else None,
            "label": label if ok else None, "count": count}


# ── The host decides ──────────────────────────────────────────────────────────


def view(row: dict) -> dict:
    from app.services import zoom

    return {"uuid": row.get("uuid"), "workspace_id": row.get("workspace_id"), "topic": row.get("topic"),
            "date": row.get("date"), "time": row.get("time"), "start_time": row.get("start_time"),
            "duration_min": row.get("duration_min"), "people": (row.get("people") or {}).get("names") or [],
            "people_count": int((row.get("people") or {}).get("count") or 0), "reason": row.get("reason"),
            "why": REASONS.get(row.get("reason") or ""), "held_at": zoom.iso(row.get("held_at")),
            "expires_at": zoom.iso(row.get("expires_at"))}


async def listing(db: AsyncIOMotorDatabase, user, workspace_id: str | None = None) -> dict:
    """The caller's own held meetings (every workspace, or one), newest first."""
    from app.services import zoom

    q: dict[str, Any] = {"state": HELD, "host.id": user.id}
    if workspace_id:
        await zoom.role_of(db, user, workspace_id)
        q["workspace_id"] = workspace_id
    rows = await db[zoom.MEETINGS].find(q).sort("held_at", -1).limit(200).to_list(length=200)
    teams: dict[str, tuple[str, str | None]] = {}
    out = []
    for r in rows:
        ws = r["workspace_id"]
        if ws not in teams:
            conn = await zoom.get(db, ws) or {"_id": ws}
            teams[ws] = (await _team_name(db, conn), str(conn["team_id"]) if conn.get("team_id") else None)
        # team_id: the Zoom team (its Meetings section's "To review" tab lists these).
        out.append({**view(r), "team": teams[ws][0], "team_id": teams[ws][1]})
    return {"meetings": out, "total": len(out)}


async def decide(db: AsyncIOMotorDatabase, user, workspace_id: str, uuid: str, decision: str, *, via: str = "web") -> dict:
    """The host's answer for one held meeting. share / private: imported (in the background, fetched from
    Zoom again); skip: dropped. ``{status, decision}``."""
    from app.services import zoom, zoom_media

    if decision not in DECISIONS:
        raise HTTPException(status_code=422, detail="Decide share, private or skip.")
    await zoom.role_of(db, user, workspace_id)
    key = f"{workspace_id}:{uuid}"
    row = await db[zoom.MEETINGS].find_one({"_id": key})
    if row is None or row.get("state") != HELD:
        raise HTTPException(status_code=404, detail="That Zoom meeting isn't waiting for a decision any more.")
    if (row.get("host") or {}).get("id") != user.id:
        raise HTTPException(status_code=403, detail="Only the meeting's host decides whether it comes in.")
    now = now_utc()
    if decision == "skip":
        res = await db[zoom.MEETINGS].replace_one({"_id": key, "state": HELD}, {
            "workspace_id": workspace_id, "uuid": row.get("uuid"), "state": SKIPPED, "reason": "host_skipped",
            "at": now, "created_at": row.get("created_at") or now, "slack": row.get("slack"), "review_id": row.get("review_id")})
        if not res.modified_count:
            raise HTTPException(status_code=409, detail="That Zoom meeting was just decided.")
        await zoom._count(db, workspace_id, "skipped")
        log.info("zoom: a held meeting was skipped by its host (%s)", via)
        return {"status": SKIPPED, "decision": decision}
    res = await db[zoom.MEETINGS].update_one({"_id": key, "state": HELD}, {"$set": {
        "state": "waiting", "due_at": now, "at": now, "tries": 0, "decision": decision, "decided_at": now,
        "decided_by": user.id, "decided_via": via, "reason": None}})
    if not res.modified_count:
        raise HTTPException(status_code=409, detail="That Zoom meeting was just decided.")
    fresh = await db[zoom.MEETINGS].find_one({"_id": key})
    zoom.spawn(zoom_media.run_waiting(db, fresh))
    log.info("zoom: a held meeting was decided by its host: %s (%s)", decision, via)
    return {"status": "importing", "decision": decision}


DONE_TEXT = {"share": "Shared with {team}: it's being imported.", "private": "Kept just for you: it's being imported, private to you.",
             "skip": "Skipped: Markdrop won't bring it in."}


async def click(db: AsyncIOMotorDatabase, inst: dict, slack_user: str, parts: list[str], payload: dict) -> str | None:
    """A Share / Keep it just for me / Skip click on the host's DM. Works only for the Slack user it was
    sent to. A notice for the clicker, or None (the message was updated)."""
    from app.services import slack_events, zoom
    from app.services.user import get_user_by_id

    decision, rid = parts[1], parts[2]
    row = await db[zoom.MEETINGS].find_one({"review_id": rid}) if rid else None
    sl = (row or {}).get("slack") or {}
    if row is None or sl.get("team") != inst["_id"] or sl.get("user") != slack_user:
        return "Only the person this message was sent to can use these buttons."
    user = await get_user_by_id(db, (row.get("host") or {}).get("id") or "")
    if user is None:
        return "Markdrop couldn't find your account."
    try:
        await decide(db, user, row["workspace_id"], row["uuid"], decision, via="slack")
    except HTTPException as exc:
        return str(exc.detail)
    conn = await zoom.get(db, row["workspace_id"]) or {"_id": row["workspace_id"]}
    team = await _team_name(db, conn)
    from app.services import hubspot_notify

    msg = slack_message(inst["_id"], row, team, await hubspot_notify._ws_name(db, row["workspace_id"]),
                        done=DONE_TEXT[decision].format(team=team))
    await slack_events._update_message(inst, payload, msg)
    return None


# ── Expiry ────────────────────────────────────────────────────────────────────


async def expire(db: AsyncIOMotorDatabase, now: datetime | None = None) -> int:
    """Held meetings nobody decided within :data:`HOLD_DAYS` days: their metadata is deleted."""
    from app.services import zoom

    now = now or now_utc()
    res = await db[zoom.MEETINGS].update_many(
        {"state": HELD, "expires_at": {"$lte": now}},
        {"$set": {"state": EXPIRED, "reason": "expired", "at": now},
         "$unset": {k: "" for k in ("topic", "start_time", "date", "time", "duration_min", "host", "people", "meeting_id",
                                    "held_at", "expires_at", "via", "event")}})
    if res.modified_count:
        log.info("zoom: %d held meetings expired", res.modified_count)
    return res.modified_count


# ── Settings ──────────────────────────────────────────────────────────────────


async def zoom_teams_of(db: AsyncIOMotorDatabase, user_id: str) -> list[dict]:
    """The connected workspaces whose Zoom team this person is in: [{workspace_id, workspace, team}]."""
    from app.services import teams as T
    from app.services import zoom

    out = []
    async for conn in db[zoom.CONNS].find({"team_id": {"$ne": None}}, {"team_id": 1, "client_secret_enc": 1, "refresh_enc": 1}):
        if not zoom.is_connected(conn):
            continue
        team = await db[T.TEAMS].find_one({"_id": T.oid(conn["team_id"]), "member_ids": user_id}, {"name": 1}) \
            if T.oid(conn["team_id"]) else None
        if team is None:
            continue
        ws = await db["workspaces"].find_one({"_id": ObjectId(conn["_id"])}, {"name": 1}) if ObjectId.is_valid(conn["_id"]) else None
        out.append({"workspace_id": conn["_id"], "workspace": (ws or {}).get("name"), "team": team.get("name")})
    return out


async def me(db: AsyncIOMotorDatabase, user) -> dict:
    from app.services import zoom

    u = await db["users"].find_one({"_id": ObjectId(user.id)}, {"zoom_share": 1})
    return {"share": choice_of(u), "teams": await zoom_teams_of(db, user.id),
            "held": await db[zoom.MEETINGS].count_documents({"state": HELD, "host.id": user.id})}


async def set_me(db: AsyncIOMotorDatabase, user, share: str) -> dict:
    if share not in CHOICES:
        raise HTTPException(status_code=422, detail="Choose auto, ask or never.")
    await db["users"].update_one({"_id": ObjectId(user.id)}, {"$set": {"zoom_share": share}})
    return await me(db, user)


async def members(db: AsyncIOMotorDatabase, conn: dict) -> list[dict]:
    """The Zoom team's members and each one's setting (the admins' view on the Zoom card)."""
    from app.services import zoom

    team = await zoom._team(db, conn["_id"], conn.get("team_id"))
    ids = [ObjectId(u) for u in (team or {}).get("member_ids") or [] if ObjectId.is_valid(u)]
    rows = await db["users"].find({"_id": {"$in": ids}}, {"name": 1, "email": 1, "zoom_share": 1}).to_list(length=1000)
    out = [{"id": str(u["_id"]), "name": u.get("name") or (u.get("email") or "").split("@")[0], "share": choice_of(u)} for u in rows]
    return sorted(out, key=lambda m: (m["name"] or "").casefold())


async def set_member(db: AsyncIOMotorDatabase, user, workspace_id: str, member_id: str, share: str) -> dict:
    """A workspace admin sets a Zoom-team member's setting."""
    from app.services import zoom

    await zoom.require_admin(db, user, workspace_id)
    if share not in CHOICES:
        raise HTTPException(status_code=422, detail="Choose auto, ask or never.")
    conn = await zoom.get(db, workspace_id)
    team = await zoom._team(db, workspace_id, (conn or {}).get("team_id")) if conn else None
    if team is None or member_id not in (team.get("member_ids") or []):
        raise HTTPException(status_code=404, detail="That person isn't in the Zoom team.")
    await db["users"].update_one({"_id": ObjectId(member_id)}, {"$set": {"zoom_share": share}})
    return {"members": await members(db, conn)}
