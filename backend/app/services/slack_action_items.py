"""Markdrop for Slack: each person's own action items as a direct message after a meeting.

Owner, 2026-11-06: after every meeting (the moment its summary is ready: slack_notify.meeting_ready,
whether or not the workspace chose a meetings channel), each person with an open action item gets
"Your action items from Daily Syncup · Nov 6" in Slack, members of the Markdrop workspace and people
who aren't. **Not opt-in** (the owner's decision; unlike the notification DMs, which are), but easy to
stop: on unless the workspace admin turned it off (``slack_installs.action_item_dms: false``,
Integrations › Slack), the person clicked **Stop these** (``slack_optouts``, keyed by Slack user so
people without a Markdrop account can stop them too), or a member turned "Action items after
meetings" off (``users.slack_notify.action_items: false``, Settings › Account).

Whose item
    The open to-dos (``- [ ]``) under "## Action items" on the meeting page, as they are on the page
    (edited, ticked or removed before sending counts). An item's person is the one it starts with:
    a ``:person`` mention (a member), ``**Name**`` (the AI's owner who isn't a member), ``[Name]``, or
    a name Google's notes start the line with ("Ravi Kumar will …"). That person must be one of the
    meeting's attendees (or its organizer); anyone else gets nothing.

Finding them in Slack (:func:`find`)
    1. a member's linked Slack account (``slack_links``);
    2. ``users.lookupByEmail`` with the member's Markdrop sign-in address, then the address Google
       gave for the attendee (bot scope ``users:read.email``; without it the install is marked as
       needing an update and the status card says so);
    3. last resort, a Slack member whose name is exactly the attendee's, when exactly one is (never
       for a meeting restricted to its attendees).
    A Markdrop account is trusted to be that Slack person only through 1, or through 2 with that
    account's own address (or the Slack account's own link). Only then does the message carry
    **Open the notes** (when the account may read the page) and a **Done** button per item (when it
    may edit it: :func:`click_done`, the same tick as the channel post's Done). Everyone else gets
    the item text and "Notes are in Markdrop (ask <organizer> for access)": no link, nothing else of
    the meeting.

Volume
    At most one message per person per meeting (``slack.remember``: ``aim:<team>:<user>:<meeting>``).
    Queued in ``slack_outbox`` (kind ``action_items``) and sent after :data:`WAIT` (an item ticked
    in that minute is dropped; meetings ready within it go in one message). A meeting ready within
    :data:`BUNDLE` of the message already sent to that person is added to that message
    (``chat.update``) instead of a new one. Never for a meeting brought in as history (Import past
    meetings) or held more than :data:`MAX_AGE` ago.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.services import slack, slack_api
from app.services import slack_blocks as kit
from app.services import slack_notify as sn

log = logging.getLogger("markdrop.slack")

KIND = "action_items"
OPTOUTS = "slack_optouts"
WAIT = sn.SLOW_WAIT                     # an item ticked or a mention fixed in the first minute never goes
BUNDLE = timedelta(minutes=30)          # meetings ready this close together share one message
MAX_AGE = timedelta(hours=24)
SENT_TTL = timedelta(days=30)
NAMES_TTL = 600                         # seconds a team's member list (name match) is reused
MAX_PEOPLE = 60


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: Any) -> datetime | None:
    if not isinstance(dt, datetime):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    # One waiting message per person (meetings ready within the wait join it).
    await db[sn.OUTBOX].create_index("bundle", unique=True, name="bundle_pending",
                                     partialFilterExpression={"state": "pending", "kind": KIND})
    await db[sn.OUTBOX].create_index([("bundle", 1), ("done_at", -1)], name="bundle_sent", sparse=True)
    await db[OPTOUTS].create_index("user_id", sparse=True)


# ── Settings ──────────────────────────────────────────────────────────────────


def workspace_on(inst: dict | None) -> bool:
    """The admin's switch (Integrations › Slack): on unless turned off."""
    return bool(inst) and inst.get("action_item_dms") is not False


def member_on(user_row: dict | None) -> bool:
    """A member's own switch (Settings › Account › Slack notifications): on unless turned off."""
    return ((user_row or {}).get("slack_notify") or {}).get("action_items") is not False


async def stopped(db: AsyncIOMotorDatabase, team_id: str, slack_user_id: str) -> bool:
    return await db[OPTOUTS].find_one({"_id": f"{team_id}:{slack_user_id}"}, {"_id": 1}) is not None


async def stop(db: AsyncIOMotorDatabase, team_id: str, slack_user_id: str, user_id: str | None) -> None:
    """Stop these (the button in the message): this Slack person gets no more of them. A member's own
    switch in Settings goes off too."""
    await db[OPTOUTS].update_one({"_id": f"{team_id}:{slack_user_id}"},
                                 {"$set": {"team_id": team_id, "slack_user_id": slack_user_id, "kind": KIND,
                                           "user_id": user_id, "at": _now()}}, upsert=True)
    if user_id and ObjectId.is_valid(user_id):
        await db["users"].update_one({"_id": ObjectId(user_id)}, {"$set": {"slack_notify.action_items": False}})
    await db[sn.OUTBOX].update_many({"kind": KIND, "team_id": team_id, "slack_user_id": slack_user_id, "state": "pending"},
                                    {"$set": {"state": "skipped", "error": "stopped"}})


async def start(db: AsyncIOMotorDatabase, team_id: str, slack_user_id: str, user_id: str | None) -> None:
    await db[OPTOUTS].delete_one({"_id": f"{team_id}:{slack_user_id}"})
    if user_id and ObjectId.is_valid(user_id):
        await db["users"].update_one({"_id": ObjectId(user_id)}, {"$set": {"slack_notify.action_items": True}})


async def set_mine(db: AsyncIOMotorDatabase, user_id: str, on: bool) -> bool:
    """Settings › Account: a member's switch. On also undoes a Stop these from any Slack account of
    theirs (the one it was clicked in, or one linked to them)."""
    await db["users"].update_one({"_id": ObjectId(user_id)}, {"$set": {"slack_notify.action_items": bool(on)}})
    if on:
        ids = [f"{ln['team_id']}:{ln['slack_user_id']}" async for ln in db[slack.LINKS].find({"user_id": user_id})]
        await db[OPTOUTS].delete_many({"$or": [{"user_id": user_id}, {"_id": {"$in": ids}}]})
    return bool(on)


# ── The items on the page ─────────────────────────────────────────────────────

_LEAD_MENTION = re.compile(r'^\s*:person\[([^\]\n]*)\]\{id="([0-9a-f]{24})"\}\s*')
_LEAD_BOLD = re.compile(r"^\s*\*\*([^*\n]{2,80}?)\*\*\s*[:,-]?\s*")
_LEAD_BRACKET = re.compile(r"^\s*\\?\[([^\]\\\n]{2,80})\\?\]\s*[:,-]?\s*")
_DUE = re.compile(r"\s+·\s+due\s+(.+?)\s*$")
_LINK = re.compile(r"\[([^\]\n]*)\]\((?:[^()\s]|\([^()\s]*\))*\)")
_ESC = re.compile(r"\\([\\`*_\[\]{}()<>#+\-.!|~$:])")
_EMAIL = re.compile(r"<?\s*([\w.+-]+@[\w-]+(?:\.[\w-]+)+)\s*>?")


def _plain(md: str) -> str:
    """One to-do's Markdown as plain text: mentions their name, links their label, escapes undone."""
    t = sn._PERSON.sub(lambda m: m.group(1), md or "")
    t = sn._CITE.sub("", t)
    t = _LINK.sub(lambda m: m.group(1), t)
    t = re.sub(r"(\*\*|__)(.+?)\1", r"\2", t)
    t = _ESC.sub(r"\1", t)
    return " ".join(t.split())


@dataclass
class Item:
    block: str
    done: bool
    text: str                       # plain text, without the person it starts with
    due: str | None = None
    who_id: str | None = None       # a :person mention's member id
    who_name: str | None = None     # the name it starts with, as written
    who_email: str | None = None


def page_items(md: str) -> list[Item]:
    """Every to-do under "## Action items", in page order, its person (if it starts with one) apart."""
    out: list[Item] = []
    for m in sn._TODO.finditer(sn._section(md, "Action items")):
        rest = sn._CITE.sub("", m.group("rest")).strip()
        due = None
        dm = _DUE.search(rest)
        if dm:
            due, rest = _plain(dm.group(1)) or None, rest[: dm.start()]
        it = Item(block=m.group("block"), done=m.group("mark") in "xX", text="", due=due)
        hit = _LEAD_MENTION.match(rest)
        if hit:
            it.who_name, it.who_id, rest = hit.group(1), hit.group(2), rest[hit.end():]
        else:
            hit = _LEAD_BOLD.match(rest) or _LEAD_BRACKET.match(rest)
            if hit:
                it.who_name, rest = _plain(hit.group(1)), rest[hit.end():]
                em = _EMAIL.fullmatch(it.who_name.strip()) or re.search(r"<([\w.+-]+@[\w-]+(?:\.[\w-]+)+)>", it.who_name)
                if em:
                    it.who_email = em.group(1).lower()
        it.text = _tidy(_plain(rest)) if it.who_name else _plain(rest)
        out.append(it)
    return out


def _tidy(text: str) -> str:
    """ "will email the team …" (a name taken off the front) → "Email the team …"."""
    t = re.sub(r"^(?:will|to|should|needs to|is going to)\s+", "", text.strip(), flags=re.I)
    t = t.lstrip(":,- ")
    return (t[:1].upper() + t[1:]) if t else text.strip()


@dataclass
class Person:
    key: str
    name: str
    user_id: str | None = None
    email: str | None = None
    items: list[Item] = field(default_factory=list)


def _people(row: dict) -> list[Person]:
    """The meeting's attendees, and its organizer when not among them."""
    out: list[Person] = []
    for i, a in enumerate(row.get("attendees") or []):
        if a.get("name"):
            out.append(Person(key=f"a{i}", name=a["name"], user_id=a.get("user_id"),
                              email=(a.get("email") or "").lower() or None))
    org = row.get("organizer") or {}
    if org.get("name") and not any((org.get("user_id") and p.user_id == org["user_id"])
                                   or p.name.casefold() == org["name"].casefold() for p in out):
        out.append(Person(key="org", name=org["name"], user_id=org.get("user_id"),
                          email=(org.get("email") or "").lower() or None))
    return out


def assign(row: dict, items: list[Item]) -> list[Person]:
    """Who has which open items: only attendees (and the organizer), each once, in page order. A
    ticked item's text loses its leading name too (it's shown done in a message already sent)."""
    from app.services import meetings

    people = _people(row)
    finder = meetings.People([{"id": p.key, "name": p.name, "email": p.email} for p in people])
    by_key = {p.key: p for p in people}
    for it in items:
        who: Person | None = None
        if it.who_id:
            who = next((p for p in people if p.user_id == it.who_id), None)
        elif it.who_name or it.who_email:
            m = finder.match(it.who_name, it.who_email)
            who = by_key.get(m["id"]) if m else None
        else:
            m, _written, rest = finder.leading(it.text)
            if m is not None:
                who = by_key.get(m["id"])
                it.text = _tidy(rest)
        if who is not None and it.text and not it.done:
            who.items.append(it)
    return [p for p in people if p.items]


# ── Finding them in Slack ─────────────────────────────────────────────────────


@dataclass
class Found:
    slack_user_id: str
    user_id: str | None             # the Markdrop account trusted to be this Slack person
    how: str                        # "link" | "email" | "name"


@dataclass
class Lookup:
    """One meeting's lookups: what Slack said, so each answer is asked for once."""
    inst: dict
    token: str
    restricted: bool = False
    needs_update: bool = False
    no_names: bool = False
    by_email: dict[str, dict | None] = field(default_factory=dict)


_NAMES: dict[str, tuple[float, list[dict]]] = {}


async def _by_email(db: AsyncIOMotorDatabase, lk: Lookup, email: str) -> dict | None:
    """The Slack person who confirmed ``email`` (not a bot, not deactivated), else None."""
    email = email.strip().lower()
    if not email or "@" not in email or lk.needs_update:
        return None
    if email in lk.by_email:
        return lk.by_email[email]
    try:
        r = await slack_api.call("users.lookupByEmail", lk.token, email=email)
    except slack_api.SlackError as exc:
        if exc.error in ("missing_scope", "no_permission"):
            lk.needs_update = True
            await slack._note_email_scopes(db, lk.inst, False)
        elif exc.error != "users_not_found":
            log.info("slack: action items: users.lookupByEmail in %s: %s", lk.inst["_id"], exc.error)
        lk.by_email[email] = None
        return None
    await slack._note_email_scopes(db, lk.inst, True)
    u = r.get("user") or {}
    profile_email = str((u.get("profile") or {}).get("email") or "").strip().lower()
    ok = (u.get("id") and not u.get("deleted") and not u.get("is_bot") and u.get("is_email_confirmed") is not False
          and (not profile_email or profile_email == email))
    lk.by_email[email] = u if ok else None
    return lk.by_email[email]


async def _members(lk: Lookup) -> list[dict]:
    team = lk.inst["_id"]
    hit = _NAMES.get(team)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    out: list[dict] = []
    cursor = None
    for _ in range(10):
        r = await slack_api.call("users.list", lk.token, limit=200, cursor=cursor)
        out += [u for u in r.get("members") or [] if not u.get("deleted") and not u.get("is_bot")
                and u.get("id") != "USLACKBOT"]
        cursor = (r.get("response_metadata") or {}).get("next_cursor")
        if not cursor:
            break
    _NAMES[team] = (time.monotonic() + NAMES_TTL, out)
    return out


async def _by_name(lk: Lookup, name: str) -> dict | None:
    """The one Slack member whose name (real or display) is exactly ``name``; None when none or several."""
    from app.services import meetings

    want = meetings._pnorm(name)
    if lk.no_names or lk.restricted or len(want) < 3 or " " not in want and len(want) < 4:
        return None
    try:
        members = await _members(lk)
    except slack_api.SlackError as exc:
        log.info("slack: action items: users.list in %s: %s", lk.inst["_id"], exc.error)
        lk.no_names = True
        return None
    hits = []
    for u in members:
        p = u.get("profile") or {}
        names = {meetings._pnorm(x) for x in (u.get("real_name"), p.get("real_name"), p.get("display_name"))} - {""}
        if want in names:
            hits.append(u)
    return hits[0] if len(hits) == 1 else None


async def find(db: AsyncIOMotorDatabase, lk: Lookup, p: Person) -> Found | None:
    team = lk.inst["_id"]
    account_email = None
    if p.user_id:
        link = await slack.link_for(db, team, p.user_id)
        if link is not None:
            return Found(link["slack_user_id"], p.user_id, "link")
        u = await db["users"].find_one({"_id": ObjectId(p.user_id)}, {"email": 1}) if ObjectId.is_valid(p.user_id) else None
        account_email = ((u or {}).get("email") or "").strip().lower() or None
    for email in dict.fromkeys(x for x in (account_email, p.email) if x):
        su = await _by_email(db, lk, email)
        if su is None:
            continue
        linked = await db[slack.LINKS].find_one({"_id": f"{team}:{su['id']}"}, {"user_id": 1})
        trusted = (linked or {}).get("user_id") or (p.user_id if email == account_email else None)
        return Found(su["id"], trusted, "email")
    su = await _by_name(lk, p.name)
    if su is not None:
        linked = await db[slack.LINKS].find_one({"_id": f"{team}:{su['id']}"}, {"user_id": 1})
        return Found(su["id"], (linked or {}).get("user_id"), "name")
    return None


# ── Queueing (when a meeting's summary is ready) ──────────────────────────────


def too_old(row: dict, now: datetime | None = None) -> bool:
    now = now or _now()
    if row.get("history"):
        return True
    created = _aware(row.get("created_at"))
    if created is not None and now - created > MAX_AGE:
        return True
    d = row.get("date")
    return bool(d and d < (now - MAX_AGE).date().isoformat())


async def _user_row(db: AsyncIOMotorDatabase, user_id: str | None) -> dict | None:
    if not user_id or not ObjectId.is_valid(user_id):
        return None
    return await db["users"].find_one({"_id": ObjectId(user_id)}, {"slack_notify": 1, "name": 1, "email": 1})


async def queue_meeting(db: AsyncIOMotorDatabase, meeting_id: str) -> dict:
    """Queue each person's message for this meeting. Never raises for Slack's answers. Returns what
    happened ({queued, reason, missing, needs_update}); the install keeps it as ``action_items_last``."""
    from app.services import meetings

    out: dict[str, Any] = {"queued": 0, "reason": None, "missing": [], "needs_update": False}
    if not slack.configured():
        return {**out, "reason": "not_configured"}
    row = await meetings.get_row(db, meeting_id)
    if row is None:
        return {**out, "reason": "not_found"}
    inst = await slack.install_for_workspace(db, row.get("workspace_id"))
    if inst is None:
        return {**out, "reason": "not_connected"}
    if not workspace_on(inst):
        return {**out, "reason": "off"}
    if too_old(row):
        return {**out, "reason": "history" if row.get("history") else "old"}
    token = slack.bot_token(inst)
    if not token:
        return {**out, "reason": "token"}
    raw = await meetings.page_of(db, row)
    if raw is None or raw.get("encrypted") or raw.get("deleted_at"):
        return {**out, "reason": "not_found"}
    people = assign(row, page_items(raw.get("content") or ""))
    lk = Lookup(inst=inst, token=token, restricted=bool(row.get("restricted")))
    team = inst["_id"]
    for p in people[:MAX_PEOPLE]:
        if p.user_id and not member_on(await _user_row(db, p.user_id)):
            continue
        found = await find(db, lk, p)
        if found is None:
            out["missing"].append(p.name)
            continue
        if await stopped(db, team, found.slack_user_id):
            continue
        if found.user_id and found.user_id != p.user_id and not member_on(await _user_row(db, found.user_id)):
            continue
        if not await slack.remember(db, f"aim:{team}:{found.slack_user_id}:{row['_id']}", SENT_TTL):
            continue   # this person already has this meeting's items
        await _enqueue(db, team, found, {"meeting_id": str(row["_id"]), "blocks": [i.block for i in p.items],
                                         "user_id": found.user_id, "how": found.how, "sent": False})
        out["queued"] += 1
    out["needs_update"] = lk.needs_update
    await db[slack.INSTALLS].update_one({"_id": team}, {"$set": {"action_items_last": {
        "at": _now(), "meeting_id": str(row["_id"]), "title": row.get("title"), "people": len(people),
        "queued": out["queued"], "missing": len(out["missing"]), "needs_update": lk.needs_update}}})
    if out["queued"]:
        log.info("slack: action items of meeting %s queued for %d people (%d not found)",
                 row["_id"], out["queued"], len(out["missing"]))
    return out


async def _enqueue(db: AsyncIOMotorDatabase, team: str, found: Found, entry: dict) -> None:
    bundle = f"{team}:{found.slack_user_id}"
    now = _now()
    for _attempt in range(3):
        r = await db[sn.OUTBOX].update_one({"bundle": bundle, "kind": KIND, "state": "pending"},
                                           {"$push": {"meetings": entry}})
        if r.modified_count:
            return
        row: dict[str, Any] = {"kind": KIND, "bundle": bundle, "team_id": team, "slack_user_id": found.slack_user_id,
                               "user_id": found.user_id, "ref": None, "meetings": [entry], "state": "pending",
                               "attempts": 0, "next_at": now + WAIT, "created_at": now}
        # Sent to them a moment ago (another meeting that ended close to this one): add to that message.
        last = await db[sn.OUTBOX].find_one({"bundle": bundle, "kind": KIND, "state": "sent", "ts": {"$ne": None}},
                                            sort=[("done_at", -1)])
        first = _aware((last or {}).get("first_at") or (last or {}).get("done_at"))
        if last is not None and first is not None and now - first <= BUNDLE:
            row.update(update_of=last["_id"], first_at=first,
                       meetings=[*[m for m in last.get("meetings") or [] if m["meeting_id"] != entry["meeting_id"]], entry])
        try:
            await db[sn.OUTBOX].insert_one(row)
            return
        except DuplicateKeyError:
            continue   # another meeting queued for them at the same moment: join it


# ── Sending ───────────────────────────────────────────────────────────────────


def _short_day(d: str | None) -> str | None:
    if not d:
        return None
    try:
        day = datetime.strptime(d, "%Y-%m-%d")
    except ValueError:
        return d
    return day.strftime("%b %-d") + ("" if day.year == _now().year else f", {day.year}")


_BY = re.compile(r"\b(?:by|before|until|due)\s+((?:the\s+)?(?:end of\s+)?(?:next|this)?\s*[A-Za-z]+(?:\s+\d{1,2})?)\b", re.I)


def due_label(it: Item, meeting_day: str | None) -> str | None:
    """The deadline to show: the AI's "due …" with its date ("Thursday (Nov 12)"), or the date a
    "by Friday" in the text means. Resolved against the meeting's day (workspace_memory.resolve_due,
    the same reading Team's targets use)."""
    from app.services import workspace_memory as wm

    try:
        base = datetime.strptime(meeting_day or "", "%Y-%m-%d").date()
    except ValueError:
        base = _now().date()

    def fmt(d) -> str:
        return d.strftime("%a, %b %-d") + ("" if d.year == base.year else f", {d.year}")

    if it.due:
        d = wm.resolve_due(it.due, base)
        if d and re.fullmatch(r"\d{4}-\d{2}-\d{2}", it.due.strip()):
            return fmt(d)
        return f"{it.due} ({fmt(d)})" if d and not re.search(r"\d", it.due) else it.due
    m = _BY.search(it.text)
    d = wm.resolve_due(m.group(1), base) if m else None
    return fmt(d) if d else None


async def _organizer_name(db: AsyncIOMotorDatabase, row: dict) -> str | None:
    org = row.get("organizer") or {}
    if org.get("name"):
        return org["name"]
    u = await _user_row(db, row.get("imported_by") or row.get("created_by"))
    return (u or {}).get("name") or None


async def render(db: AsyncIOMotorDatabase, row: dict, *, first: bool) -> tuple[dict | None, list[dict]]:
    """(the message, the meetings as sent). ``first``: items ticked before sending are dropped (the
    ones already sent show as done instead)."""
    from app.services import access, md_outline, meetings, urls
    from app.services.user import get_user_by_id

    shown: list[dict] = []
    kept: list[dict] = []
    for entry in row.get("meetings") or []:
        mrow = await meetings.get_row(db, entry["meeting_id"])
        raw = await meetings.page_of(db, mrow) if mrow else None
        if mrow is None or raw is None or raw.get("deleted_at") or raw.get("encrypted"):
            continue
        on_page = {i.block: i for i in page_items(raw.get("content") or "")}
        assign(mrow, list(on_page.values()))     # the text as the page says now, its name taken off the front
        items = []
        for b in entry.get("blocks") or []:
            it = on_page.get(b)
            if it is None:
                continue          # removed from the page
            if it.done and (first or not entry.get("sent")):
                continue          # ticked before the message went
            items.append({"block": b, "text": kit.esc(kit.cut(it.text, 500)), "due": due_label(it, mrow.get("date")),
                          "done": it.done})
        if not items:
            continue
        user = await get_user_by_id(db, entry["user_id"]) if entry.get("user_id") else None
        can_read = can_edit = False
        if user is not None:
            actor, ctx = access.Actor.of(user, cred="session"), access.Ctx(db, surface="slack")
            can_read = (await access.can(actor, raw, "read", ctx)).allowed
            can_edit = can_read and (await access.can(actor, raw, "edit_content", ctx)).allowed
        title = (mrow.get("title") or md_outline.display_title(raw) or "Meeting").strip()
        shown.append({"title": title, "when": _short_day(mrow.get("date")),
                      "url": urls.markdrop_url(raw["slug"]) if can_read else None,
                      "organizer": None if can_read else await _organizer_name(db, mrow),
                      "can_edit": can_edit, "items": items})
        kept.append({**entry, "blocks": [i["block"] for i in items], "sent": True})
    if not shown:
        return None, kept
    stop_v = slack.sign_value(row["team_id"], "stop", row["slack_user_id"], row.get("user_id") or "")
    return kit.dm_action_items(row["team_id"], str(row["_id"]), shown, stop_value=stop_v), kept


async def deliver(db: AsyncIOMotorDatabase, row: dict) -> tuple[str, dict]:
    """slack_notify.flush → one queued message. Checked again now: the switches, the page."""
    inst = await slack.get_install(db, row["team_id"])
    if inst is None:
        return "skipped", {"error": "uninstalled"}
    if not workspace_on(inst):
        return "skipped", {"error": "off"}
    token = slack.bot_token(inst)
    if not token:
        return "skipped", {"error": "token"}
    if await stopped(db, row["team_id"], row["slack_user_id"]):
        return "skipped", {"error": "stopped"}
    if row.get("user_id") and not member_on(await _user_row(db, row["user_id"])):
        return "skipped", {"error": "off"}
    msg, kept = await render(db, row, first=True)
    if msg is None:
        return "skipped", {"error": "gone"}
    now = _now()
    if row.get("update_of"):
        prev = await db[sn.OUTBOX].find_one({"_id": row["update_of"]})
        if prev is not None and prev.get("ts") and prev.get("channel"):
            try:
                r = await slack_api.call("chat.update", token, channel=prev["channel"], ts=prev["ts"],
                                         blocks=msg["blocks"], text=msg["text"])
                await db[sn.OUTBOX].update_one({"_id": prev["_id"]}, {"$set": {"merged_into": row["_id"]}})
                return "sent", {"channel": r.get("channel") or prev["channel"], "ts": r.get("ts") or prev["ts"],
                                "meetings": kept, "first_at": row.get("first_at") or now, "updated": True}
            except slack_api.SlackError as exc:
                if exc.dead_token or exc.error == "ratelimited" or exc.status in (0, 500, 502, 503):
                    raise
                log.info("slack: action items: chat.update %s (sending a new message)", exc.error)
    r = await slack_api.call("chat.postMessage", token, channel=row["slack_user_id"], blocks=msg["blocks"],
                             text=msg["text"], unfurl_links=False, unfurl_media=False)
    return "sent", {"channel": r.get("channel"), "ts": r.get("ts"), "meetings": kept, "first_at": now}


# ── Buttons ───────────────────────────────────────────────────────────────────


async def click_done(db: AsyncIOMotorDatabase, inst: dict, slack_user: str, row_id: str, block: str,
                     payload: dict) -> str:
    """Done in someone's action-items message: only they can click it (it's their direct message, and
    the button is bound to it), and it ticks the to-do as the Markdrop account the message was sent
    for, through the normal save path, when that account may edit the page. Returns what to tell them."""
    from app.services import meetings
    from app.services.user import get_user_by_id

    row = await db[sn.OUTBOX].find_one({"_id": sn._oid(row_id), "kind": KIND}) if sn._oid(row_id) else None
    if row is None or row.get("team_id") != inst["_id"]:
        return "That message isn't from this Slack workspace."
    if row.get("slack_user_id") != slack_user:
        return "Only the person this message was sent to can tick these."
    entry = next((m for m in row.get("meetings") or [] if block in (m.get("blocks") or [])), None)
    user = await get_user_by_id(db, entry["user_id"]) if entry and entry.get("user_id") else None
    if entry is None or user is None:
        return "Open the meeting's notes in Markdrop to tick this one."
    mrow = await meetings.get_row(db, entry["meeting_id"])
    raw = await meetings.page_of(db, mrow) if mrow else None
    if raw is None:
        return "That meeting's page is gone (deleted or in the trash)."
    why, done = await sn.tick(db, raw, user, block)
    if done:
        await sn.done_elsewhere(db, inst["_id"], entry["meeting_id"], block, "someone in Markdrop" if why else
                                (user.name or user.email))
        msg, _kept = await render(db, row, first=False)
        if msg is not None:
            await _update(inst, payload, msg)
    return why


async def _update(inst: dict, payload: dict, msg: dict) -> None:
    cont = payload.get("container") or {}
    chan = cont.get("channel_id") or (payload.get("channel") or {}).get("id")
    ts = cont.get("message_ts") or (payload.get("message") or {}).get("ts")
    token = slack.bot_token(inst)
    if not (token and chan and ts):
        return
    try:
        await slack_api.call("chat.update", token, channel=chan, ts=ts, blocks=msg["blocks"], text=msg["text"])
    except slack_api.SlackError as exc:
        log.info("slack: action items: chat.update %s", exc.error)


async def click_stop(db: AsyncIOMotorDatabase, inst: dict, slack_user: str, parts: list[str], *, on: bool) -> dict | None:
    """Stop these / Turn back on. ``parts``: [kind, Slack user, Markdrop user or ""] from the signed
    value; only that Slack person can use it. Returns the reply (only they see it)."""
    if len(parts) != 3 or parts[1] != slack_user:
        return kit.notice("That button is for the person the message was sent to.")
    user_id = parts[2] or None
    team = inst["_id"]
    if on:
        await start(db, team, slack_user, user_id)
        return kit.notice("Back on: Markdrop sends you your action items after each meeting again.")
    await stop(db, team, slack_user, user_id)
    return kit.action_items_stopped(slack.sign_value(team, "start", slack_user, user_id or ""))


# ── Admin: the switch's preview ───────────────────────────────────────────────


async def preview(db: AsyncIOMotorDatabase, user, workspace_id: str) -> dict:
    """What the next messages would look like, from the newest meeting the admin can open that has
    action items with a person: who would get one (and how Markdrop would find them in Slack, without
    asking Slack) and what the first of them would read. Nothing is sent."""
    from app.services import access, meetings, urls

    await slack.require_admin(db, user, workspace_id)
    inst = await slack.install_for_workspace(db, workspace_id)
    actor, ctx = access.Actor.of(user), access.Ctx(db)
    out: dict[str, Any] = {"on": workspace_on(inst), "meeting": None, "people": [], "message": None,
                           "can_find_by_email": slack.can_find_by_email(inst)}
    cur = db[meetings.COLL].find({"workspace_id": workspace_id}).sort([("date", -1), ("created_at", -1)]).limit(25)
    async for row in cur:
        raw = await meetings.readable(db, row, actor, ctx)
        if raw is None:
            continue
        people = assign(row, page_items(raw.get("content") or ""))
        if not people:
            continue
        out["meeting"] = {"id": str(row["_id"]), "title": row.get("title"), "when": _short_day(row.get("date")),
                          "restricted": bool(row.get("restricted"))}
        for p in people[:MAX_PEOPLE]:
            reach = "name"
            if p.user_id and inst and await slack.link_for(db, inst["_id"], p.user_id):
                reach = "linked"
            elif p.user_id or p.email:
                reach = "email"
            if reach == "name" and row.get("restricted"):
                reach = "none"
            out["people"].append({"name": p.name, "member": bool(p.user_id), "reach": reach, "items": len(p.items)})
        first = max(people, key=lambda p: len(p.items))      # the fullest message as the example
        member = bool(first.user_id)
        out["message"] = {
            "to": first.name, "title": row.get("title") or "Meeting", "when": _short_day(row.get("date")),
            "items": [{"text": kit.cut(i.text, 300), "due": due_label(i, row.get("date"))} for i in first.items[:15]],
            "open_link": urls.markdrop_url(raw["slug"]) if member else None,
            "organizer": None if member else await _organizer_name(db, row),
            "done_buttons": member,
        }
        break
    return out
