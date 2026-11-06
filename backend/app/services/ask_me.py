"""Who is asking: the "You" block every Ask Markdrop prompt carries, and personal retrieval.

Owner report (2026-11-06): "what did I tell in my last sync-up discussion" was answered with "I can't
tell which attendee you are". The assistant now always knows who is asking (.work/briefs/assistant-me.md):

* :func:`you_of` — the asker's own profile: name, email, workspaces and their role in each, timezone
  and today's date there, and **how they appear in meetings**: the attendee and organizer names the
  import matched to their account, and transcript speaker names that the import's own people matcher
  (``meetings.People``: address, full name, a first name only one member has, a name prefix) resolves
  to them. Sent as ``<untrusted_you>`` (a name is text anyone could have typed): data, never
  instructions. "I / me / my" in a question mean this person.
* :func:`personal` — for a question about the asker (:func:`is_personal`, cheap keyword test), the
  meetings they attended, organized or spoke in (latest first, the ones the question names first),
  their own transcript lines with times and links, the action items assigned to them there, and
  their recent work: documents and pages they created, edited (version history) or signed off,
  and meetings they imported. Combined with the normal search by the engines.

**Access.** Only the asker's own profile. Everything else goes through the existing per-item checks:
a meeting only when ``meetings.readable`` (its page) says so, its transcript lines only when the
transcript page is readable, a document only when ``access.can(read)``. Nobody else's email is ever
put in the block. A workspace-domain session sees only that workspace (``search.world_of``).
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import access, meetings
from app.services import meeting_parse as mp
from app.services import search_text as st

log = logging.getLogger("markdrop.ask_me")

MAX_WORKSPACES = 20
SPEAKER_SCAN = 80            # recent meetings per workspace whose speaker names are matched
NAMES_TTL = 600.0            # seconds the meeting names of a person are kept (per process)
PERSONAL_SCAN = 150          # meetings looked at for a personal question (newest first, no segments)
PERSONAL_MEETINGS = 3        # meetings sent with the asker's own lines
MY_LINES = 14                # the asker's lines per meeting
WORK_DAYS = 30
WORK_ITEMS = 8
ACTIONS_PER_MEETING = 6

ROLE_WORDS = {"owner": "owner", "admin": "admin", "member": "member", "viewer": "viewer (read only)"}

# "I / me / my" (and the Hinglish forms people type: maine, mera, meri, mujhe).
_ME = re.compile(r"\b(i|me|my|mine|myself|i'm|im|i've|ive|i'd|i'll|maine|mera|meri|mere|mujhe|mujhse)\b", re.I)
_PROFILE = re.compile(
    r"\b(who am i|what(?:'s| is) my (?:name|e-?mail|account|profile|role|plan|time ?zone)"
    r"|my (?:e-?mail|account|profile|roles?|plan|time ?zone|workspaces?)"
    r"|which workspaces?|what workspaces?|am i (?:an? )?(?:admin|owner|member|viewer)"
    r"|what (?:is|'s) (?:my|the) (?:role|plan))\b", re.I)
_WORK = re.compile(
    r"\b(working on|worked on|work on|been doing|did i do|have i done|my (?:docs?|documents?|pages?|files?|work|activity|drafts?)"
    r"|i (?:created|wrote|edited|published|made|uploaded|signed|imported|changed|updated)|recent(?:ly)?|lately|this week|last week)\b",
    re.I)
_MEETINGISH = re.compile(
    r"\b(meetings?|sync[- ]?ups?|syncs?|stand[- ]?ups?|calls?|1:1s?|one[- ]on[- ]ones?|standups?|retros?|reviews?|"
    r"say|said|tell|told|spoke|speak|talk(?:ed)?|discuss(?:ed|ion)?|mention(?:ed)?|attend(?:ed)?|present(?:ed)?|"
    r"update|asked|promised|commit(?:ted)?|bola|kaha|boli)\b", re.I)

_PERSONAL_STOP = frozenset("""
i me my mine myself im ive maine mera meri mere mujhe mujhse what whats which who whom when where why how did do does
done was were is are am be been have has had say said says tell told talk talked speak spoke discuss discussed
discussion discussions mention mentioned last latest recent recently previous meeting meetings call calls about in on
at the a an from of for to with and or any anything something there their they them that this these those our we us
you your up get got give gave quote quotes exactly word words line lines please can could would should will kya
""".split())


def is_personal(question: str) -> bool:
    return bool(_ME.search(question or ""))


def is_profile(question: str) -> bool:
    return bool(_PROFILE.search(question or ""))


def wants_work(question: str) -> bool:
    return bool(_WORK.search(question or ""))


def wants_meetings(question: str) -> bool:
    return bool(_MEETINGISH.search(question or ""))


def pnorm(name: str | None) -> str:
    return meetings._pnorm(name)


def compact(text: str | None) -> str:
    return re.sub(r"[^0-9a-z]+", "", (text or "").casefold())


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    """What :func:`recent_work` reads by person (version history and sign-offs are read by page elsewhere)."""
    await db["document_versions"].create_index([("author_id", 1), ("ts", -1)])
    await db["signoffs"].create_index([("signer_id", 1), ("signed_at", -1)])


# ── You ───────────────────────────────────────────────────────────────────────


@dataclass
class You:
    user_id: str
    name: str
    email: str
    tz: str
    today: date
    now_local: datetime
    workspaces: list[dict] = field(default_factory=list)       # [{id, name, role}]
    names: dict[str, set[str]] = field(default_factory=dict)   # workspace id → normalised names that are them
    shown: list[str] = field(default_factory=list)              # those names as written (for the block)

    def all_names(self) -> set[str]:
        out: set[str] = set()
        for v in self.names.values():
            out |= v
        return out

    def is_me(self, speaker: str | None, workspace_id: str | None = None) -> bool:
        n = pnorm(speaker)
        if not n:
            return False
        if workspace_id and workspace_id in self.names:
            return n in self.names[workspace_id]
        return n in self.all_names()

    def ws_name(self, ws_id: str | None) -> str | None:
        return next((w["name"] for w in self.workspaces if w["id"] == ws_id), None)

    def text(self) -> str:
        lines = [f"Name: {self.name}", f"Email: {self.email}" if self.email else None,
                 f"Today: {self.today.strftime('%A')} {self.today.isoformat()}, {self.now_local.strftime('%H:%M')} "
                 f"in their timezone ({self.tz})",
                 "Plan: Markdrop is free while in beta (no paid plan on any account yet)"]
        if self.workspaces:
            lines.append("Workspaces (their role): " + "; ".join(
                f"{w['name']} ({ROLE_WORDS.get(w['role'], w['role'])})" for w in self.workspaces))
        else:
            lines.append("Workspaces: none (only their personal space)")
        if self.shown:
            lines.append("In meetings they appear as (attendee / speaker names): " + ", ".join(self.shown[:12]))
            lines.append('Transcript lines spoken by them are marked "(you)".')
        else:
            lines.append("In meetings: no attendee or speaker name is matched to them yet")
        return "\n".join(x for x in lines if x)

    def block(self) -> str:
        from app.services import pages_ai

        return ("The person asking (their own account; \"I\", \"me\", \"my\" in the question mean them):\n"
                + pages_ai.wrap("you", self.text()))


_names_cache: dict[tuple[str, str], tuple[float, set[str], list[str]]] = {}


def forget_names(user_id: str | None = None) -> None:
    """Drop cached meeting names (tests; a person renamed)."""
    if user_id is None:
        _names_cache.clear()
    else:
        for k in [k for k in _names_cache if k[0] == user_id]:
            _names_cache.pop(k, None)


async def _ws_names(db: AsyncIOMotorDatabase, user_id: str, ws: str, own: list[str]) -> tuple[set[str], list[str]]:
    """The names that are this person in this workspace's meetings: attendee and organizer names the
    import matched to them, their own name, and speaker names the people matcher resolves to them."""
    key = (user_id, ws)
    hit = _names_cache.get(key)
    if hit and time.monotonic() - hit[0] < NAMES_TTL:
        return hit[1], hit[2]
    norm: set[str] = set()
    shown: list[str] = []

    def add(name: str | None) -> None:
        n = pnorm(name)
        if n and n not in norm:
            norm.add(n)
            shown.append(re.sub(r"\s+", " ", str(name)).strip()[:80])

    for n in own:
        add(n)
    try:
        pipe = [{"$match": {"workspace_id": ws, "$or": [{"attendees.user_id": user_id}, {"organizer.user_id": user_id}]}},
                {"$sort": {"date": -1}}, {"$limit": 200},
                {"$project": {"a": {"$filter": {"input": {"$ifNull": ["$attendees", []]}, "cond": {"$eq": ["$$this.user_id", user_id]}}},
                              "o": {"$cond": [{"$eq": ["$organizer.user_id", user_id]}, "$organizer.name", None]}}}]
        async for r in db[meetings.COLL].aggregate(pipe):
            for a in r.get("a") or []:
                add(a.get("name"))
            if r.get("o"):
                add(r["o"])
        # Speakers of recent meetings that aren't restricted to others (a restricted meeting's
        # attendees are the only ones who read it; names here are the asker's own anyway).
        pipe = [{"$match": {"workspace_id": ws, "$or": [{"restricted": {"$ne": True}}, {"attendees.user_id": user_id}]}},
                {"$sort": {"date": -1}}, {"$limit": SPEAKER_SCAN},
                {"$project": {"s": "$segments.speaker"}}, {"$unwind": "$s"}, {"$group": {"_id": "$s"}}, {"$limit": 2000}]
        speakers = [r["_id"] async for r in db[meetings.COLL].aggregate(pipe) if isinstance(r.get("_id"), str)]
        if speakers:
            people = await meetings.people_of(db, ws)
            for s in speakers:
                if pnorm(s) in norm:
                    continue
                m = people.match(s)
                if m is not None and m.get("id") == user_id:
                    add(s)
    except Exception:   # names help; an answer never fails for want of them
        log.warning("ask_me: meeting names failed", exc_info=True)
    _names_cache[key] = (time.monotonic(), norm, shown)
    return norm, shown


async def you_of(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx | None = None) -> You | None:
    """The asker's own profile (None when signed out). Never raises."""
    uid = actor.user_id
    if not uid:
        return None
    from app.services import notifications, search, viewers

    try:
        row = await db["users"].find_one({"_id": ObjectId(uid)}, {"name": 1, "email": 1, "email_tz": 1}) or {}
    except Exception:
        row = {}
    email = str(row.get("email") or getattr(actor.user, "email", "") or "")
    name = viewers.display_name(type("U", (), {"name": row.get("name") or getattr(actor.user, "name", None), "email": email}))
    tz = notifications.valid_tz(row.get("email_tz")) or "UTC"
    now_local = datetime.now(timezone.utc).astimezone(ZoneInfo(tz))
    you = You(user_id=uid, name=name, email=email, tz=tz, today=now_local.date(), now_local=now_local)
    try:
        w = await search.world_of(db, actor, ctx or access.Ctx(db))
        for ws, role in w.memberships[:MAX_WORKSPACES]:
            you.workspaces.append({"id": ws.id, "name": ws.name, "role": role})
    except Exception:
        log.warning("ask_me: workspaces failed", exc_info=True)
    own = [n for n in (row.get("name"), name) if n]
    seen: set[str] = set()
    for w_ in you.workspaces:
        norm, shown = await _ws_names(db, uid, w_["id"], own)
        you.names[w_["id"]] = norm
        for s in shown:
            if pnorm(s) not in seen:
                seen.add(pnorm(s))
                you.shown.append(s)
    if not you.workspaces:
        you.shown = [n for n in dict.fromkeys(own)]
        you.names[""] = {pnorm(n) for n in own if pnorm(n)}
    return you


async def you_for_user(db: AsyncIOMotorDatabase, user_id: str | None) -> You | None:
    """:func:`you_of` for a caller that has only the user id (analytics)."""
    if not user_id or not ObjectId.is_valid(user_id):
        return None
    from types import SimpleNamespace

    row = await db["users"].find_one({"_id": ObjectId(user_id)}, {"name": 1, "email": 1})
    if row is None:
        return None
    user = SimpleNamespace(id=user_id, email=row.get("email") or "", name=row.get("name"))
    return await you_of(db, access.Actor.of(user))


# ── Personal retrieval ────────────────────────────────────────────────────────


@dataclass
class MyMeeting:
    row: dict                         # the meetings row (with segments when the transcript is readable)
    page: dict                        # the meeting page (readable)
    transcript: dict | None           # the transcript page when readable
    attended: bool
    organized: bool
    spoke: int                        # how many of the transcript's lines are theirs
    lines: list[int]                  # 0-based indexes of their lines sent
    topical: bool                     # the question names this meeting (title / series)
    actions: list[dict] = field(default_factory=list)   # action items assigned to them here

    @property
    def mine(self) -> bool:
        return self.attended or self.organized or self.spoke > 0

    def status(self) -> str:
        """"they organized it and attended but didn't speak", "they attended and spoke 3 times"…"""
        if not self.mine:
            return "the person asking was not in this meeting"
        who = "they organized it and attended" if self.organized else "they attended"
        if self.transcript is None and self.row.get("transcript_doc_id"):
            return who + " (the transcript isn't open to them)"
        if not self.row.get("segments"):
            return who + " (no transcript)"
        if self.spoke:
            return f"{who} and spoke {self.spoke} time{'s' if self.spoke != 1 else ''}"
        return who + " but didn't speak"


@dataclass
class Personal:
    meetings: list[MyMeeting] = field(default_factory=list)
    work: list[tuple[dict, str]] = field(default_factory=list)   # (document row, what they did)

    @property
    def empty(self) -> bool:
        return not self.meetings and not self.work


def topic_terms(question: str) -> list[str]:
    out: list[str] = []
    for w in st.words(question or ""):
        if len(w) >= 3 and w not in st.STOPWORDS and w not in _PERSONAL_STOP and w not in out:
            out.append(w)
    return out[:10]


def _topical(row: dict, terms: list[str], question: str) -> bool:
    hay = compact(f"{row.get('title') or ''} {row.get('series') or ''}")
    if not hay:
        return False
    words = st.words(question or "")
    grams = {compact(a + b) for a, b in zip(words, words[1:])}       # "sync up" → "syncup"
    for t in [*terms, *grams]:
        c = compact(t)
        if len(c) >= 4 and c in hay and c not in ("meeting", "meetings"):
            return True
    return False


def _my_lines(segs: list[dict], ws: str, you: You, terms: list[str]) -> tuple[int, list[int]]:
    mine = [i for i, s in enumerate(segs) if you.is_me(s.get("speaker"), ws)]
    if len(mine) <= MY_LINES:
        return len(mine), mine
    tset = set(terms)
    scored = sorted(mine, key=lambda i: (-len(tset & set(st.words(segs[i].get("text")))), i))
    hit = [i for i in scored if tset & set(st.words(segs[i].get("text")))][:MY_LINES]
    rest = [i for i in mine if i not in hit]
    # Their lines that match the question, then their first and last lines (what they opened and closed with).
    while len(hit) < MY_LINES and rest:
        hit.append(rest.pop(0))
        if rest and len(hit) < MY_LINES:
            hit.append(rest.pop())
    return len(mine), sorted(hit)


async def personal_meetings(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, you: You, question: str, *,
                            workspaces: list[str] | None = None, since: str | None = None, until: str | None = None,
                            series: str | None = None, limit: int = PERSONAL_MEETINGS) -> list[MyMeeting]:
    """The meetings a personal question is about, newest first among equals: the ones the question names
    (title / series) that they were in, else the ones they were in whose own lines match its words,
    else simply their latest. The newest named meeting they were *not* in comes along too (so the answer
    can say "you weren't in that one"). Only meetings readable by the asker now."""
    from app.services import meeting_scope

    uid = you.user_id
    wss = [w["id"] for w in you.workspaces if workspaces is None or w["id"] in workspaces]
    if not wss:
        return []
    q: dict[str, Any] = {"workspace_id": {"$in": wss}}
    if not (since or until):
        since, until = meeting_scope.dates_from(question, you.today)
    if since:
        q.setdefault("date", {})["$gte"] = since
    if until:
        q.setdefault("date", {})["$lte"] = until
    if series:
        q["series"] = {"$regex": f"^{re.escape(series)}$", "$options": "i"}
    terms = topic_terms(question)
    rows = await db[meetings.COLL].find(q, {"segments.text": 0, "segments.t": 0}).sort(
        [("date", -1), ("created_at", -1)]).limit(PERSONAL_SCAN).to_list(length=PERSONAL_SCAN)
    picked: list[tuple[float, int, dict, bool, bool]] = []
    first_topical_other = None
    for i, r in enumerate(rows):
        ws = r.get("workspace_id")
        attended = any(a.get("user_id") == uid for a in r.get("attendees") or [])
        organized = (r.get("organizer") or {}).get("user_id") == uid
        spoke = any(you.is_me(s.get("speaker"), ws) for s in r.get("segments") or [])
        topical = _topical(r, terms, question)
        mine = attended or organized or spoke
        if not mine:
            if topical and first_topical_other is None:
                first_topical_other = r
            continue
        picked.append((3.0 if topical else 0.0, i, r, topical, mine))
    # Score their meetings: named ones first; then (loaded below) their lines matching the question.
    picked.sort(key=lambda x: (-x[0], x[1]))
    cands = picked[: max(limit * 4, 8)]
    out: list[MyMeeting] = []
    tset = set(terms)
    scored: list[tuple[float, int, MyMeeting]] = []
    for score, i, r, topical, _mine in cands:
        page = await meetings.readable(db, r, actor, ctx)
        if page is None:
            continue
        mm = await _load(db, actor, ctx, r, page, you, terms, topical=topical)
        if mm is None:
            continue
        bonus = 0.0
        if tset and mm.lines:
            segs = mm.row.get("segments") or []
            hits = sum(1 for k in mm.lines if tset & set(st.words(segs[k].get("text"))))
            bonus = min(2.0, hits / 2.0)
        scored.append((score + bonus, i, mm))
    scored.sort(key=lambda x: (-x[0], x[1]))
    if scored and scored[0][0] == 0:
        scored.sort(key=lambda x: x[1])      # nothing named or matched: simply their latest
    out = [mm for _s, _i, mm in scored[:limit]]
    # The newest meeting the question names that they weren't in (newer than what they were in).
    if first_topical_other is not None:
        newest_mine = out[0].row.get("date") if out else None
        if not newest_mine or (first_topical_other.get("date") or "") >= newest_mine:
            page = await meetings.readable(db, first_topical_other, actor, ctx)
            if page is not None:
                mm = await _load(db, actor, ctx, first_topical_other, page, you, terms, topical=True)
                if mm is not None:
                    out.insert(0, mm)
    return out


async def _load(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, r: dict, page: dict, you: You,
                terms: list[str], *, topical: bool) -> MyMeeting | None:
    from app.services import meeting_memory

    uid = you.user_id
    ws = r.get("workspace_id")
    full = await db[meetings.COLL].find_one({"_id": r["_id"]})
    if full is None:
        return None
    traw = None
    if full.get("transcript_doc_id"):
        t = await db["documents"].find_one({"_id": meetings.oid(full["transcript_doc_id"])}, {"content": 0})
        if t is not None and not t.get("deleted_at") and (await access.can(actor, t, "read", ctx)).allowed:
            traw = t
    segs = full.get("segments") or [] if traw is not None else []
    spoke, lines = _my_lines(segs, ws, you, terms) if segs else (0, [])
    if traw is None:
        full = {**full, "segments": []}
    attended = any(a.get("user_id") == uid for a in full.get("attendees") or [])
    organized = (full.get("organizer") or {}).get("user_id") == uid
    actions = await db[meeting_memory.COLL].find(
        {"meeting_id": str(full["_id"]), "kind": "action_item", "owner_id": uid}, {"text": 1, "due": 1, "seg": 1}
    ).sort("ord", 1).limit(ACTIONS_PER_MEETING).to_list(length=ACTIONS_PER_MEETING)
    return MyMeeting(row=full, page=page, transcript=traw, attended=attended, organized=organized, spoke=spoke,
                     lines=lines, topical=topical, actions=actions)


async def recent_work(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, you: You, *,
                      workspaces: list[str] | None = None, folders: set[str] | None = None,
                      limit: int = WORK_ITEMS) -> list[tuple[dict, str]]:
    """What they did lately, newest first, from data Markdrop already keeps: documents and pages they
    created (owner), edited (version history) or signed off — not meeting pages (an import of many
    meetings would flood it; :func:`personal_meetings` covers meetings). Each item is decided readable
    now; (the document row, "you created it Nov 2; you edited it Nov 5")."""
    from app.services import page_history, signoffs

    uid = you.user_id
    since = datetime.now(timezone.utc) - timedelta(days=WORK_DAYS)
    did: dict[str, list[tuple[datetime, str]]] = {}

    def note(doc_id: Any, at: Any, what: str) -> None:
        if doc_id is None or not isinstance(at, datetime):
            return
        did.setdefault(str(doc_id), []).append((at if at.tzinfo else at.replace(tzinfo=timezone.utc), what))

    try:
        async for d in db["documents"].find({"owner_id": uid, "deleted_at": None, "created_at": {"$gte": since}},
                                            {"created_at": 1}).sort("created_at", -1).limit(40):
            note(d["_id"], d.get("created_at"), "created")
        async for v in db[page_history.COLL].find({"author_id": uid, "ts": {"$gte": since}},
                                                  {"doc_id": 1, "ts": 1}).sort("ts", -1).limit(200):
            note(v.get("doc_id"), v.get("ts"), "edited")
        async for s in db[signoffs.COLL].find({"signer_id": uid, "signed_at": {"$gte": since}},
                                              {"doc_id": 1, "signed_at": 1, "option": 1}).sort("signed_at", -1).limit(40):
            note(s.get("doc_id"), s.get("signed_at"), f"signed it off ({s.get('option')})" if s.get("option") else "signed it off")
        # Their own documents they touched lately even without a version row (a Markdown document's save).
        async for d in db["documents"].find({"owner_id": uid, "deleted_at": None, "updated_at": {"$gte": since}},
                                            {"updated_at": 1}).sort("updated_at", -1).limit(40):
            if str(d["_id"]) not in did:
                note(d["_id"], d.get("updated_at"), "updated")
    except Exception:
        log.warning("ask_me: recent work failed", exc_info=True)
        return []
    order = sorted(did, key=lambda k: -max(t for t, _ in did[k]).timestamp())
    oids = [ObjectId(k) for k in order if ObjectId.is_valid(k)][:60]
    rows = {str(r["_id"]): r for r in await db["documents"].find({"_id": {"$in": oids}}, {"content": 0}).to_list(length=len(oids))}
    out: list[tuple[dict, str]] = []
    for k in order:
        raw = rows.get(k)
        if raw is None or raw.get("deleted_at") or raw.get("encrypted"):
            continue
        if workspaces is not None and raw.get("workspace_id") not in workspaces:
            continue
        if folders is not None and raw.get("folder_id") not in folders:
            continue
        if raw.get("meeting_id"):
            continue    # meetings are covered by personal_meetings (an import would flood this list)
        if not (await access.can(actor, raw, "read", ctx)).allowed:
            continue
        acts: dict[str, datetime] = {}
        for t, what in sorted(did[k], key=lambda x: -x[0].timestamp()):
            acts.setdefault(what, t)
        tz = ZoneInfo(you.tz)
        text = "; ".join(f"you {what if ' it' in what else what + ' it'} {meetings.fmt_date(t.astimezone(tz).date().isoformat())}"
                         for what, t in acts.items())
        out.append((raw, text))
        if len(out) >= limit:
            break
    return out


async def personal(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, you: You | None, question: str, *,
                   workspaces: list[str] | None = None, folders: set[str] | None = None) -> Personal:
    """What a personal question needs about the asker (empty for any other question)."""
    out = Personal()
    if you is None or not is_personal(question):
        return out
    profile_only = is_profile(question) and not wants_meetings(question) and not wants_work(question)
    if profile_only:
        return out
    try:
        if folders is None:
            out.meetings = await personal_meetings(db, actor, ctx, you, question, workspaces=workspaces)
        if wants_work(question) or not wants_meetings(question):
            out.work = await recent_work(db, actor, ctx, you, workspaces=workspaces, folders=folders)
    except Exception:
        log.warning("ask_me: personal retrieval failed", exc_info=True)
    return out


def line_text(label: str, seg: dict, me: bool) -> str:
    t = mp.clock(seg.get("t")) if seg.get("t") is not None else "-"
    who = seg.get("speaker") or "Unknown"
    return f"[{label}] {t} {who}{' (you)' if me else ''}: {seg.get('text') or ''}"
