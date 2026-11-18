"""HubSpot Phase 2: what reaches people (brief .work/briefs/hubspot-v2.md, items 7 and 10).

**Pre-call briefs** (:func:`tick`, the ``hubspot`` background loop, every :data:`EVERY` seconds). For each
connected workspace (switch ``precall``, on by default), the HubSpot meetings owned by the HubSpot team's
members (owner matched by email) that start in :data:`LEAD_MIN`–:data:`LEAD_MAX` minutes and have a contact
or deal get, once per person and meeting (``hubspot_precall``: the claim is the row), a Slack direct
message and a Markdrop inbox item: the deal's stage, amount and close date; the last call with that
deal / company / contacts (only one the person can open): its summary, follow-ups and open questions;
and the account page. Template only: no AI. A person turns them off in Settings › Account (or with
**Stop these** on the message): ``users.hubspot_notify.precall: false``.

**Slack approve** (:func:`offer`, hubspot.meeting_ready). When a HubSpot-team call's summary is ready, the
call's host (a member of the HubSpot team, found by the host's email) gets one Slack message (once per
meeting, switch ``approve``, on by default): the deal, how many deal updates are suggested, and buttons
**Log to HubSpot** and **Create N tasks** (the action items proposed then; nothing goes to HubSpot until
a click). A click works only for the person it was sent to (team + Slack user + Markdrop account on the
meeting's ``hubspot.offer``) and runs the same code as the meeting panel as that person (their access is
checked again). Off: ``users.hubspot_notify.approve: false`` or **Stop these**.

Collections
    hubspot_precall   _id "<workspace>:<hubspot meeting>:<user>": workspace_id, user_id, meeting_id (HubSpot),
                      start, state (sent | skipped), why, slack, inbox, at (kept 14 days)
    meetings.hubspot.offer   {user_id, team, slack_user, channel, ts, keys, log, at, done}
    users.hubspot_notify     {precall: bool, approve: bool} (absent: on)
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.services import hubspot as H
from app.services.hubspot_api import HubSpotError

log = logging.getLogger("markdrop.hubspot")

PRECALL = "hubspot_precall"
EVERY = 300.0
LEAD_MIN = 5          # minutes before the start: nothing later than this
LEAD_MAX = 60         # minutes before the start: nothing earlier than this
KEEP = timedelta(days=14)
KINDS = ("precall", "approve")
NOTIFICATION_KIND = "hubspot_precall"
SETTINGS_PATH = "/settings/account#hubspot"
MAX_ITEMS = 5


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[PRECALL].create_index("at", expireAfterSeconds=int(KEEP.total_seconds()))


# ── Each person's choices ─────────────────────────────────────────────────────


def prefs_of(user_row: dict | None) -> dict[str, bool]:
    saved = (user_row or {}).get("hubspot_notify") or {}
    return {k: saved.get(k) is not False for k in KINDS}


async def _user_row(db, user_id: str | None) -> dict | None:
    if not user_id or not ObjectId.is_valid(str(user_id)):
        return None
    return await db["users"].find_one({"_id": ObjectId(str(user_id))}, {"hubspot_notify": 1, "name": 1, "email": 1})


async def teams_of(db: AsyncIOMotorDatabase, user_id: str) -> list[dict]:
    """The HubSpot teams this person is in: [{workspace_id, workspace, team}]."""
    from app.services import teams as T

    teams = await db[T.TEAMS].find({"member_ids": user_id}, {"name": 1, "workspace_id": 1}).to_list(length=500)
    if not teams:
        return []
    by = {str(t["_id"]): t for t in teams}
    out = []
    async for c in db[H.CONNS].find({"team_id": {"$in": list(by)}, "token_enc": {"$exists": True}}, {"team_id": 1}):
        t = by[c["team_id"]]
        ws = await db["workspaces"].find_one({"_id": T.oid(c["_id"])}, {"name": 1}) or {}
        out.append({"workspace_id": c["_id"], "workspace": ws.get("name"), "team": t.get("name"), "team_id": c["team_id"]})
    return out


async def me(db: AsyncIOMotorDatabase, user) -> dict:
    return {"teams": await teams_of(db, user.id), **prefs_of(await _user_row(db, user.id))}


async def set_me(db: AsyncIOMotorDatabase, user, changes: dict) -> dict:
    sets = {f"hubspot_notify.{k}": bool(v) for k, v in changes.items() if k in KINDS and v is not None}
    if sets:
        await db["users"].update_one({"_id": ObjectId(user.id)}, {"$set": sets})
    return await me(db, user)


# ── Slack plumbing ────────────────────────────────────────────────────────────


async def _slack_for(db, workspace_id: str, user_id: str) -> tuple[dict, str, str] | None:
    """(install, bot token, Slack user id) for a member of the workspace, else None."""
    from app.services import slack, slack_action_items as sai

    if not slack.configured():
        return None
    inst = await slack.install_for_workspace(db, workspace_id)
    token = slack.bot_token(inst) if inst else None
    if not token:
        return None
    u = await _user_row(db, user_id)
    found = await sai.find(db, sai.Lookup(inst=inst, token=token), sai.Person(key=user_id, name=(u or {}).get("name") or "",
                                                                                 user_id=user_id, email=None))
    if found is None or found.user_id != user_id:
        return None
    return inst, token, found.slack_user_id


def _stop_button(team_id: str, kind: str, user_id: str) -> dict:
    from app.services import slack
    from app.services import slack_blocks as kit

    return kit.button("Stop these", action_id="md_hs_stop", value=slack.sign_value(team_id, "hsp", kind, user_id))


def _footer(why: str) -> dict:
    from app.services import slack
    from app.services import slack_blocks as kit

    return kit.context(f"{why} · {kit.link(slack.frontend_link(SETTINGS_PATH), 'Turn off in Markdrop')}")


async def _ws_name(db, workspace_id: str) -> str | None:
    ws = await db["workspaces"].find_one({"_id": ObjectId(workspace_id)}, {"name": 1}) if ObjectId.is_valid(workspace_id) else None
    return (ws or {}).get("name")


def _deal_bits(d: dict | None) -> str | None:
    if not d:
        return None
    bits = [d.get("stage") or "no stage"]
    if d.get("amount") is not None:
        bits.append(f"{d['amount']:,.0f} {d.get('currency') or ''}".strip())
    if d.get("close_date"):
        bits.append(f"closes {d['close_date']}")
    if d.get("owner"):
        bits.append(f"owner {d['owner']}")
    return f"{d['name']} · " + " · ".join(bits)


# ── Pre-call briefs ───────────────────────────────────────────────────────────


async def tick(db: AsyncIOMotorDatabase, now: datetime | None = None) -> int:
    """One pass over the connected workspaces (the background loop). Returns how many briefs went out."""
    if not H.configured():
        return 0
    now = now or now_utc()
    n = 0
    async for conn in db[H.CONNS].find({"token_enc": {"$exists": True}, "team_id": {"$ne": None}}):
        if conn.get("broken") or not H.switch(conn, "precall"):
            continue
        try:
            n += await precall_workspace(db, conn, now)
        except HubSpotError as exc:
            log.info("hubspot: pre-call briefs for %s: %s", conn["_id"], exc)
        except Exception:
            log.warning("hubspot: pre-call briefs for %s failed", conn["_id"], exc_info=True)
    return n


async def _members(db, conn: dict) -> dict[str, dict]:
    """{HubSpot owner id: {user_id, name}} for the HubSpot team's members who have a HubSpot user."""
    team = await H._team(db, conn["_id"], conn.get("team_id"))
    uids = [u for u in (team or {}).get("member_ids") or [] if ObjectId.is_valid(str(u))]
    if not uids:
        return {}
    users = await db["users"].find({"_id": {"$in": [ObjectId(u) for u in uids]}}, {"email": 1, "name": 1}).to_list(length=500)
    by_email = {(u.get("email") or "").lower(): u for u in users if u.get("email")}
    out = {}
    for o in await H.owners(db, conn):
        u = by_email.get(o.get("email") or "")
        if u is not None:
            out[o["id"]] = {"user_id": str(u["_id"]), "name": u.get("name")}
    return out


async def precall_workspace(db: AsyncIOMotorDatabase, conn: dict, now: datetime) -> int:
    members = await _members(db, conn)
    if not members:
        return 0
    lo, hi = now + timedelta(minutes=LEAD_MIN), now + timedelta(minutes=LEAD_MAX)
    got = await H.call(db, conn, "POST", "crm/v3/objects/meetings/search", json={
        "filterGroups": [{"filters": [
            {"propertyName": "hubspot_owner_id", "operator": "IN", "values": list(members)[:100]},
            {"propertyName": "hs_meeting_start_time", "operator": "BETWEEN", "value": str(H._ms(lo)), "highValue": str(H._ms(hi))}]}],
        "properties": [*H.MEETING_PROPS, "hs_meeting_outcome"], "limit": 50}) or {}
    sent = 0
    for hm in got.get("results") or []:
        p = hm.get("properties") or {}
        who = members.get(str(p.get("hubspot_owner_id") or ""))
        if who is None or str(p.get("hs_meeting_outcome") or "").upper() in ("CANCELED", "CANCELLED"):
            continue
        key = f"{conn['_id']}:{hm['id']}:{who['user_id']}"
        if await db[PRECALL].find_one({"_id": key}, {"_id": 1}) is not None:
            continue
        if not prefs_of(await _user_row(db, who["user_id"]))["precall"]:
            await _mark(db, key, conn, who, hm, "skipped", "off")
            continue
        try:
            await db[PRECALL].insert_one({"_id": key, "workspace_id": conn["_id"], "user_id": who["user_id"],
                                          "meeting_id": str(hm["id"]), "state": "sending", "at": now_utc()})
        except DuplicateKeyError:
            continue        # another worker has it
        try:
            out = await send_brief(db, conn, who["user_id"], hm)
        except Exception as exc:
            await db[PRECALL].update_one({"_id": key}, {"$set": {"state": "failed", "why": type(exc).__name__}})
            raise
        await db[PRECALL].update_one({"_id": key}, {"$set": out})
        sent += out.get("state") == "sent"
    return sent


async def _mark(db, key: str, conn: dict, who: dict, hm: dict, state: str, why: str) -> None:
    try:
        await db[PRECALL].insert_one({"_id": key, "workspace_id": conn["_id"], "user_id": who["user_id"],
                                      "meeting_id": str(hm["id"]), "state": state, "why": why, "at": now_utc()})
    except DuplicateKeyError:
        pass


async def _last_call(db, conn: dict, user, deal_ids: list[str], company_ids: list[str], contact_ids: list[str]) -> dict | None:
    """The latest team call with this deal, company or these contacts that ``user`` can open now."""
    from app.services import access, meetings

    ors = []
    if deal_ids:
        ors.append({"hubspot.match.deal_id": {"$in": deal_ids}})
    if company_ids:
        ors.append({"hubspot.match.company_ids": {"$in": company_ids}})
    if contact_ids:
        ors.append({"hubspot.match.contact_ids": {"$in": contact_ids}})
    if not ors:
        return None
    actor, ctx = access.Actor.of(user), access.Ctx(db)
    cur = db[meetings.COLL].find({"workspace_id": conn["_id"], "team_ids": conn["team_id"],
                                  "hubspot.match.portal_id": conn["portal_id"], "$or": ors},
                                 {"segments": 0}).sort([("date", -1), ("created_at", -1)]).limit(10)
    async for row in cur:
        if await meetings.readable(db, row, actor, ctx) is not None:
            return row
    return None


async def build_brief(db: AsyncIOMotorDatabase, conn: dict, user, hm: dict) -> dict | None:
    """What a pre-call brief says: {title, start, deal, last_call {title, date, url, summary}, follow_ups,
    questions, account {href, name}, doc_id} — None when the HubSpot meeting has no contact or deal."""
    from app.services import hubspot_accounts, urls

    hid = str(hm["id"])
    deals = (await H.assoc(db, conn, "meetings", [hid], "deals")).get(hid, [])
    contacts = (await H.assoc(db, conn, "meetings", [hid], "contacts")).get(hid, [])
    companies = (await H.assoc(db, conn, "meetings", [hid], "companies")).get(hid, [])
    if not deals and not contacts:
        return None
    if not companies and contacts:
        companies = list(dict.fromkeys(c for v in (await H.assoc(db, conn, "contacts", contacts[:H.MAX_CONTACTS], "companies")).values() for c in v))[:3]
    if not deals and (contacts or companies):
        deals = await H._deals_of(db, conn, contacts[:H.MAX_CONTACTS], companies[:3])
    deal, _others, _n = await H._pick_deal(db, conn, deals) if deals else (None, [], 0)
    stage_by = {s["id"]: s for s in await H.stages(db, conn)}
    owner_by = {o["id"]: o for o in await H.owners(db, conn)}
    dv = H._deal_view(conn, deal, stage_by, owner_by) if deal else None
    p = hm.get("properties") or {}
    start = H._from_hs_time(p.get("hs_meeting_start_time"))
    out: dict[str, Any] = {"title": H._plain(p.get("hs_meeting_title")) or "Meeting", "start": start, "deal": dv,
                           "last_call": None, "follow_ups": [], "questions": [], "account": None, "doc_id": None}
    row = await _last_call(db, conn, user, [str(dv["id"])] if dv else [], companies, contacts)
    if row is not None:
        gen = row.get("generated") or {}
        summary = gen.get("summary") or (row.get("notes") or {}).get("summary") or ""
        out["last_call"] = {"title": row.get("title"), "date": row.get("date"), "url": urls.markdrop_url(row["slug"]) if row.get("slug") else None,
                            "summary": " ".join(H._plain(summary).split(". ")[:2])[:400] or None}
        done = (row.get("hubspot") or {}).get("tasks") or {}
        for it in H.items_of(row)[:MAX_ITEMS]:
            t = done.get(H.task_key(it["text"]))
            extra = " · ".join(x for x in (it.get("owner"), f"due {it['due']}" if it.get("due") else None) if x)
            out["follow_ups"].append(it["text"] + (f" ({extra})" if extra else "")
                                     + (" · in HubSpot" if isinstance(t, dict) and t.get("state") == "created" else ""))
        for q in (gen.get("open_questions") or [])[:4]:
            t = H._plain(q.get("text") if isinstance(q, dict) else q)
            if t:
                out["questions"].append(t)
        out["doc_id"] = row.get("doc_id")
    link = await hubspot_accounts.link_for(db, conn, {"company_ids": companies})
    if link:
        raw = await db["documents"].find_one({"slug": link["slug"]})
        from app.services import access

        if raw is not None and (await access.can(access.Actor.of(user), raw, "read", access.Ctx(db))).allowed:
            out["account"] = {"href": link["href"], "url": urls.markdrop_url(link["slug"]), "name": link.get("name")}
            out["doc_id"] = raw["_id"]
    return out


def _when(conn: dict, start: datetime | None) -> str:
    if start is None:
        return "soon"
    local = start.astimezone(H._tz(conn))
    return local.strftime("%-I:%M %p").lower() + (f" ({conn.get('time_zone')})" if conn.get("time_zone") else " UTC")


def brief_message(conn: dict, team_id: str, user_id: str, b: dict, where: str | None) -> dict:
    from app.services import slack_blocks as kit

    head = f"*{kit.esc(kit.cut(b['title'], 150))}* starts at {kit.esc(_when(conn, b['start']))}"
    blocks: list[dict | None] = [kit.eyebrow("Pre-call brief", where), kit.section(head)]
    if b["deal"]:
        d = b["deal"]
        blocks.append(kit.section("*Deal*  " + (kit.link(d["url"], kit.cut(_deal_bits(d), 200)) if d.get("url") else kit.esc(_deal_bits(d)))))
    lc = b["last_call"]
    if lc:
        t = f"*Last call*  {kit.link(lc['url'], kit.cut(lc['title'] or 'Meeting', 120)) if lc.get('url') else kit.esc(lc['title'])} · {kit.esc(lc.get('date') or '')}"
        if lc.get("summary"):
            t += f"\n{kit.esc(kit.cut(lc['summary'], 400))}"
        blocks.append(kit.section(t))
    if b["follow_ups"]:
        blocks.append(kit.section("*Follow-ups from that call*\n" + kit.bullets(kit.esc(kit.cut(x, 200)) for x in b["follow_ups"])))
    if b["questions"]:
        blocks.append(kit.section("*Open questions*\n" + kit.bullets(kit.esc(kit.cut(x, 200)) for x in b["questions"])))
    btns = []
    if b["account"]:
        btns.append(kit.open_button(b["account"]["url"], "Open the account page", primary=True))
    elif lc and lc.get("url"):
        btns.append(kit.open_button(lc["url"], "Open the last call", primary=True))
    btns.append(_stop_button(team_id, "precall", user_id))
    blocks.append(kit.actions(*btns))
    blocks.append(_footer("Pre-call briefs come to the HubSpot team's members"))
    return kit.message(blocks, f"Pre-call brief: {b['title']}")


async def send_brief(db: AsyncIOMotorDatabase, conn: dict, user_id: str, hm: dict) -> dict:
    """Build and deliver one pre-call brief (Slack DM + inbox). Returns the claim row's new fields."""
    from app.services import notifications, slack_api
    from app.services.user import get_user_by_id

    user = await get_user_by_id(db, user_id)
    if user is None or not await H.can_use(db, user_id, conn):
        return {"state": "skipped", "why": "no_access"}
    b = await build_brief(db, conn, user, hm)
    if b is None:
        return {"state": "skipped", "why": "no_contact"}
    out: dict[str, Any] = {"state": "sent", "slack": None, "inbox": None, "start": b["start"]}
    where = await _ws_name(db, conn["_id"])
    s = await _slack_for(db, conn["_id"], user_id)
    if s is not None:
        inst, token, su = s
        try:
            r = await slack_api.call("chat.postMessage", token, channel=su, unfurl_links=False, unfurl_media=False,
                                     **brief_message(conn, inst["_id"], user_id, b, where))
            out["slack"] = {"channel": r.get("channel"), "ts": r.get("ts")}
        except slack_api.SlackError as exc:
            out["slack"] = {"error": exc.error}
    if b.get("doc_id") is not None:
        d = b["deal"]
        now = now_utc()
        row = {"user_id": user_id, "kind": NOTIFICATION_KIND, "doc_id": str(b["doc_id"]), "block_id": None,
               "actor_id": None, "actor_name": "HubSpot", "via": "hubspot",
               "extra": {"label": H._plain(b["title"])[:120], "excerpt": (_deal_bits(d) or "")[:200] or None,
                         "message": f"Starts at {_when(conn, b['start'])}"},
               "created_at": now, "read_at": None, "email": "off", "email_at": now, "emailed_at": None}
        res = await db[notifications.COLL].insert_one(row)
        out["inbox"] = str(res.inserted_id)
    if not out["slack"] and not out["inbox"]:
        out.update(state="skipped", why="nowhere")
    return out


# ── Slack approve (Log to HubSpot, tasks) ─────────────────────────────────────


async def _host_user(db, conn: dict, row: dict) -> str | None:
    email = await H.host_email_of(db, row)
    if not email:
        return None
    u = await db["users"].find_one({"email": email}, {"_id": 1})
    uid = str(u["_id"]) if u else None
    return uid if uid and await H.can_use(db, uid, conn) else None


def offer_message(team_id: str, row: dict, offer: dict, deal: dict | None, n_suggestions: int, where: str | None,
                  done: str | None = None) -> dict:
    from app.services import slack, slack_blocks as kit
    from app.services import urls

    url = urls.markdrop_url(row["slug"]) if row.get("slug") else slack.frontend_link("/")
    mid = str(row["_id"])
    blocks: list[dict | None] = [kit.eyebrow("HubSpot", where),
                                 kit.section(f"Your call *{kit.link(url, kit.cut(row.get('title') or 'Meeting', 120))}* is ready for HubSpot.")]
    if deal:
        blocks.append(kit.section("*Deal*  " + (kit.link(deal["url"], kit.cut(_deal_bits(deal), 200)) if deal.get("url") else kit.esc(_deal_bits(deal)))))
    tasks = offer.get("tasks") or []
    if tasks and not done:
        blocks.append(kit.section("*Action items to create as HubSpot tasks*\n" + kit.bullets(kit.esc(kit.cut(t, 200)) for t in tasks[:8])))
    if n_suggestions:
        blocks.append(kit.context(f"{kit.plural(n_suggestions, 'suggested deal update')} to review · {kit.link(url, 'Open the meeting')}"))
    if done:
        blocks.append(kit.context(f"{kit.DONE_MARK}  {kit.esc(done)}"))
        blocks.append(kit.actions(kit.open_button(url, "Open in Markdrop")))
    else:
        btns = []
        if offer.get("log"):
            btns.append(kit.button("Log to HubSpot", action_id="md_hs_log", value=slack.sign_value(team_id, "hs", "log", mid), style="primary"))
        if tasks:
            btns.append(kit.button(f"Create {kit.plural(len(tasks), 'task')}", action_id="md_hs_tasks",
                                   value=slack.sign_value(team_id, "hs", "tasks", mid)))
        btns.append(kit.open_button(url, "Open in Markdrop"))
        btns.append(_stop_button(team_id, "approve", offer["user_id"]))
        blocks.append(kit.actions(*btns))
    blocks.append(_footer("Nothing goes to HubSpot until you click"))
    return kit.message(blocks, f"{row.get('title') or 'Your call'} is ready for HubSpot")


async def offer(db: AsyncIOMotorDatabase, conn: dict, meeting_id: str, m: dict) -> dict | None:
    """hubspot.meeting_ready: the host's one Slack message with Log / Create tasks (never for past meetings)."""
    from app.services import meetings, slack_api

    if not H.switch(conn, "approve"):
        return None
    row = await meetings.get_row(db, meeting_id)
    if row is None or row.get("history") or (row.get("hubspot") or {}).get("offer"):
        return None
    uid = await _host_user(db, conn, row)
    if uid is None or not prefs_of(await _user_row(db, uid))["approve"]:
        return None
    s = await _slack_for(db, conn["_id"], uid)
    if s is None:
        return None
    inst, token, su = s
    hs = row.get("hubspot") or {}
    logged = (hs.get("logged") or {}).get("portal_id") == conn["portal_id"]
    can_log = bool(m.get("meeting_id") or m.get("deal_id") or m.get("contact_ids"))
    deal = None
    if m.get("deal_id"):
        ds = await H.batch_read(db, conn, "deals", [m["deal_id"]], H.DEAL_PROPS)
        if ds:
            deal = H._deal_view(conn, ds[0], {s_["id"]: s_ for s_ in await H.stages(db, conn)}, {o["id"]: o for o in await H.owners(db, conn)})
    props = [p for p in await H.proposals(db, conn, row, m, deal) if not p["created"]] if can_log else []
    off = {"user_id": uid, "team": inst["_id"], "slack_user": su, "keys": [p["key"] for p in props],
           "tasks": [p["text"] for p in props], "log": can_log and not logged, "at": now_utc(), "done": None}
    if not off["log"] and not off["keys"]:
        return None
    claim = await db[meetings.COLL].update_one({"_id": row["_id"], "hubspot.offer": {"$exists": False}},
                                               {"$set": {"hubspot.offer": off}})
    if claim.modified_count == 0:
        return None
    n_sug = sum(1 for i in ((hs.get("suggestions") or {}).get("items") or []) if i.get("state") == "open")
    if not n_sug:
        fresh = await meetings.get_row(db, meeting_id) or row
        n_sug = sum(1 for i in ((((fresh.get("hubspot") or {}).get("suggestions") or {}).get("items")) or []) if i.get("state") == "open")
    msg = offer_message(inst["_id"], row, off, deal, n_sug, await _ws_name(db, conn["_id"]))
    try:
        r = await slack_api.call("chat.postMessage", token, channel=su, unfurl_links=False, unfurl_media=False, **msg)
        await db[meetings.COLL].update_one({"_id": row["_id"]}, {"$set": {"hubspot.offer.channel": r.get("channel"),
                                                                         "hubspot.offer.ts": r.get("ts")}})
    except slack_api.SlackError as exc:
        await db[meetings.COLL].update_one({"_id": row["_id"]}, {"$set": {"hubspot.offer.error": exc.error}})
    return off


async def click(db: AsyncIOMotorDatabase, inst: dict, slack_user: str, parts: list[str], payload: dict) -> str | None:
    """A Log to HubSpot / Create tasks click. Returns a notice for the clicker, or None (the message was
    updated)."""
    from app.services import access, meetings, slack_events
    from app.services.user import get_user_by_id

    action, mid = parts[1], parts[2]
    row = await meetings.get_row(db, mid) if ObjectId.is_valid(mid) else None
    off = ((row or {}).get("hubspot") or {}).get("offer") or {}
    if row is None or off.get("team") != inst["_id"] or off.get("slack_user") != slack_user:
        return "Only the person this message was sent to can use these buttons."
    user = await get_user_by_id(db, off.get("user_id") or "")
    if user is None:
        return "Markdrop couldn't find your account."
    actor, ctx = access.Actor.of(user, cred="session"), access.Ctx(db, surface="slack")
    try:
        if action == "log":
            p = await H.log_meeting(db, user, actor, ctx, mid)
            done = "Logged to HubSpot" + (" (a new meeting on the deal)." if (p.get("logged") or {}).get("created") else ".")
        elif action == "tasks":
            p = await H.create_tasks(db, user, actor, ctx, mid, list(off.get("keys") or []))
            made = sum(1 for r in p.get("results") or [] if r["status"] == "created")
            done = f"{made} {'task' if made == 1 else 'tasks'} created in HubSpot."
        else:
            return None
    except HTTPException as exc:
        return str(exc.detail) if isinstance(exc.detail, str) else "Markdrop couldn't do that."
    sets: dict[str, Any] = {"hubspot.offer.done": done}
    if action == "log":
        sets["hubspot.offer.log"] = False
    else:
        sets["hubspot.offer.keys"], sets["hubspot.offer.tasks"] = [], []
    await db[meetings.COLL].update_one({"_id": row["_id"]}, {"$set": sets})
    off = {**off, **{k.split(".")[-1]: v for k, v in sets.items()}}
    finished = not off.get("log") and not off.get("keys")
    msg = offer_message(inst["_id"], row, off, p.get("deal"), 0, await _ws_name(db, row["workspace_id"]),
                        done=done if finished else None)
    if not finished:
        from app.services import slack_blocks as kit

        msg["blocks"].insert(len(msg["blocks"]) - 2, kit.context(f"{kit.DONE_MARK}  {kit.esc(done)}"))
    await slack_events._update_message(inst, payload, msg)
    return None


async def click_stop(db: AsyncIOMotorDatabase, parts: list[str]) -> str:
    kind, uid = parts[1], parts[2]
    if kind not in KINDS or not ObjectId.is_valid(uid):
        return "That button isn't valid any more."
    await db["users"].update_one({"_id": ObjectId(uid)}, {"$set": {f"hubspot_notify.{kind}": False}})
    what = "pre-call briefs" if kind == "precall" else "messages after your calls"
    return f"You won't get HubSpot {what} any more. Turn them back on in Markdrop: Settings › Account."
