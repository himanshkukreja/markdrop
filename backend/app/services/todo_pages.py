"""Personal to-do pages: one page per person per team, kept up to date from the team's calls (owner, 2026-11-19;
brief .work/briefs/jason-folders-todos.md §2).

    GET  /api/v1/me/todos                               your to-do pages across your teams (You › My to-dos)
    GET  /api/v1/workspaces/{ws}/teams/{team}/todos     the team's to-do pages (leads: every member's; others: theirs)
    POST /api/v1/todos/tick                             {block, done} tick one of your to-dos (and its call's)
    GET  /api/v1/workspaces/{ws}/teams/{team}/todos/mine   does your page exist (no build): the button's label
    POST /api/v1/workspaces/{ws}/teams/{team}/todos/mine   "Create my to-dos" / "Refresh to-dos": :func:`refresh`
    POST /api/v1/workspaces/{ws}/teams/{team}/todos/all    leads: "Create for everyone" (:func:`ensure_team`)
    MCP  my_todos, team_todos, tick_todo, refresh_my_todos   (mcp/todo_tools.py)
    scripts/todo_pages.py                               the backfill (dry run by default)

**The page.** "<Name> — To-dos" in the team's hidden "To-dos" folder (``folders.todo_root``: kept out of the file
tree like the Deals folder; reached from the team's People & memory and You › My to-dos). Never in General. Markdrop
keeps the section between :data:`START` and :data:`END`: one collapsible section (a toggle heading,
``:::details{summary heading=3 open}``) per company — the call's HubSpot company (its deal folder's or account
page's company), else the outside attendees' company (their email domain) — and "Internal" for calls with neither;
the header says company · N open · last call. Each item is the person's action item from a call (the line on the
meeting page that @mentions them): the task, due date, the call it came from (a link to the item on the meeting
page) and the transcript moment when there is one. What the person writes outside the section stays
(hubspot_accounts.merge). No items yet: :data:`EMPTY`.

**The team's pages** (owner, 2026-11-19; brief .work/briefs/todos-refresh.md) are a second source: task lines
(``- [ ] … {#b-…}``) that @mention the person on the team's own pages (``team_ids`` has the team; not meeting pages,
not to-do pages, nothing in a hidden folder such as the Deals folder's deal internals) that they can read. They go in
their own collapsible section, :data:`PAGES_SECTION`, after the company sections; each links to the item on its page.
Same identity (the block id) and the same two-way ticking as calls (``todo_items.meeting_doc_id`` is then the page's
id). Saving such a page rebuilds the to-do pages that already exist for the people its changed task lines mention
(:func:`_from_team_page`; a save without a person chip costs one substring test). At most :data:`MAX_TEAM_PAGES`
pages are read, newest edit first.

**Identity.** An item on the to-do page carries the SAME block id as the action item on the meeting page
(``{#b-…}``): that is the task's identity. ``todo_items`` remembers, per (to-do page, block), the meeting page it
belongs to and the last state both sides agreed on (``done``).

**Two-way ticking** (every save goes through ``document.update_document``, which calls :func:`on_page_saved`):

* ticked (or unticked) on the to-do page — editor, view mode's quick tick, MCP, :func:`tick` — the meeting page's
  line follows, written as the person when they can edit the call, else (it is their own item and they can read the
  call) as the call page's owner; quietly, through the save path, merging into anyone's open editor
  (``pages.MERGE_EDIT``);
* ticked on the meeting page (the editor, Home, Slack's Done, Jira) or the call's action items changed (written,
  regenerated, edited by hand): the to-do pages of the people its task lines mention are rebuilt (in the background).

No echo and no lost tick: the agreed state is stored BEFORE the other side is written, and a rebuild merges three
ways — the call changed since the agreed state → the call wins; else the to-do page's own tick (one the call didn't
take yet) stays and is pushed again.

**Access.** The page is private: its owner (the person) only. Team LEADS read every member's to-do page in that team
— a rule decided at read time in ``access.facts`` (the page's ``todo_team_id`` / ``todo_user_id`` against the team's
``lead_ids`` and ``member_ids`` now), never per-page grants that go stale. The owner can share it like any page.
Calls the person can't read never show on their page.

**Who gets one.** Every member of a team (not General) once the team uses to-dos: the first call with action items
in the team, the backfill, or someone opening the team's to-dos. A member added later gets theirs at once
(teams.add_members / set_leads / create_team call :func:`team_changed`). Anyone in the team can also make or refresh
theirs in one click (:func:`refresh`, synchronous: "Added N new · M open"); a lead can make everyone's.

Collections
    todo_pages   _id "<team>:<user>": workspace_id, team_id, user_id, doc_id, slug, open, sections [{name, open,
                 last_call}], built_at, created_at
    todo_items   _id "<to-do doc id>:<block>": todo_doc_id, team_id, user_id, meeting_doc_id, block, done, done_at
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import access

log = logging.getLogger("markdrop.todos")

PAGES = "todo_pages"
ITEMS = "todo_items"
FOLDER_NAME = "To-dos"
TITLE_SUFFIX = " — To-dos"
START = "## From the team's calls"
END = ("*Markdrop keeps the section above up to date from the team's calls. Tick an item here or on its call: "
       "both follow. Write your own to-dos above or below it.*")
EMPTY = "_No open action items yet — they'll appear here after your next call._"
INTERNAL = "Internal"
PAGES_KEY = "pages"                 # the section of items from the team's own pages (always last)
PAGES_SECTION = "From the team's pages"
MAX_TEAM_PAGES = 200                # the team's pages a rebuild reads (newest edit first)
DONE_SHOWN = timedelta(days=14)     # a ticked item stays (to untick) this long after it was ticked
MAX_MEETINGS = 600                  # the team's latest calls a rebuild reads
MAX_ITEMS = 400
STALE = timedelta(minutes=30)       # a listing refreshes pages older than this, in the background
FREE_MAIL = frozenset({
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "yahoo.co.in",
    "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "zoho.com", "gmx.com", "gmx.net",
    "yandex.com", "mail.com", "rediffmail.com", "fastmail.com", "hey.com", "pm.me"})
_SLD = frozenset({"co", "com", "org", "net", "ac", "gov", "edu", "ltd", "plc"})

_bg: set[asyncio.Task] = set()
_locks: dict[str, asyncio.Lock] = {}
_pending: set[str] = set()


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _oid(v: Any) -> ObjectId | None:
    if isinstance(v, ObjectId):
        return v
    try:
        return ObjectId(str(v))
    except Exception:
        return None


def page_key(team_id: str, user_id: str) -> str:
    return f"{team_id}:{user_id}"


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[PAGES].create_index([("user_id", 1), ("workspace_id", 1)])
    await db[PAGES].create_index([("team_id", 1)])
    await db[PAGES].create_index("doc_id")
    await db[ITEMS].create_index([("todo_doc_id", 1)])
    await db[ITEMS].create_index([("meeting_doc_id", 1)])
    await db["documents"].create_index("todo_team_id", sparse=True)


# ── Background ────────────────────────────────────────────────────────────────


def spawn(coro) -> None:
    t = asyncio.get_running_loop().create_task(coro)
    _bg.add(t)
    t.add_done_callback(_bg.discard)


async def drain(timeout: float = 30) -> None:
    """Wait for the background rebuilds (tests, the backfill)."""
    for _ in range(20):
        if not _bg:
            return
        await asyncio.wait(set(_bg), timeout=timeout)


def schedule(db: AsyncIOMotorDatabase, team_id: str, user_id: str) -> None:
    """Rebuild one person's to-do page in a team soon (coalesced: one waiting rebuild per page)."""
    key = page_key(team_id, user_id)
    if key in _pending:
        return
    _pending.add(key)

    async def run():
        try:
            await asyncio.sleep(0)
            _pending.discard(key)
            await build(db, team_id, user_id)
        except Exception:
            log.warning("todos: rebuilding %s failed", key, exc_info=True)
        finally:
            _pending.discard(key)

    try:
        spawn(run())
    except RuntimeError:
        _pending.discard(key)


def team_changed(db: AsyncIOMotorDatabase, team_id: str) -> None:
    """Members added (or a team made): everyone in a team that uses to-dos gets their page."""
    async def run():
        try:
            if await db[PAGES].find_one({"team_id": team_id}, {"_id": 1}):
                await ensure_team(db, team_id)
        except Exception:
            log.warning("todos: ensuring team %s failed", team_id, exc_info=True)

    try:
        spawn(run())
    except RuntimeError:
        pass


# ── Reading task lines ────────────────────────────────────────────────────────

_TASK = re.compile(r"^(?P<lead>[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+)\[(?P<mark>[ xX])\](?P<rest>[ \t].*?)[ \t]*"
                   r"\{#(?P<block>b-[0-9A-Za-z_-]{1,40})[^}\n]*\}[ \t]*$")
_CITE = re.compile(r"\s*\[(?:#?\d{1,4}|\d{1,2}:\d{2}(?::\d{2})?)\]\([^)\s]*#b-t\d+\)")
_PERSON = re.compile(r':person\[([^\]\n]*)\](?:\{[^}\n]*\})?')
_DUE = re.compile(r"\s*·\s*due\s+(.+?)\s*$", re.I)


@dataclass
class Line:
    block: str
    done: bool
    rest: str          # the text after the box (without the block id)
    start: int         # offset of the mark character in the content


def task_lines(content: str) -> list[Line]:
    """Every to-do with a block id in ``content`` (outside code fences)."""
    out: list[Line] = []
    pos = 0
    fence = False
    for raw in (content or "").split("\n"):
        line_start = pos
        pos += len(raw) + 1
        s = raw.lstrip()
        if s.startswith(("```", "~~~")):
            fence = not fence
            continue
        if fence or "{#b-" not in raw or "[" not in raw:
            continue
        m = _TASK.match(raw)
        if m is None:
            continue
        out.append(Line(m.group("block"), m.group("mark") in "xX", m.group("rest").strip(), line_start + m.start("mark")))
    return out


def marks(content: str) -> dict[str, bool]:
    return {ln.block: ln.done for ln in task_lines(content)}


def mentions(rest: str) -> set[str]:
    return set(re.findall(r'id="([A-Za-z0-9_-]{1,64})"', rest or ""))


def region(content: str) -> str:
    """The part of a to-do page Markdrop keeps (START..END), or ''."""
    lines = (content or "").split("\n")
    try:
        i = next(k for k, ln in enumerate(lines) if ln.strip() == START)
    except StopIteration:
        return ""
    j = next((k for k in range(i + 1, len(lines)) if lines[k].strip() == END), len(lines) - 1)
    return "\n".join(lines[i:j + 1])


def _clean_text(rest: str, uid: str) -> tuple[str, str | None, str | None]:
    """(task, due, transcript moment link) from a meeting page's action item line, for ``uid``'s own list."""
    moment = None
    cm = _CITE.search(rest)
    if cm:
        moment = cm.group(0).strip()
    text = _CITE.sub("", rest)

    def person(m: re.Match) -> str:
        if f'id="{uid}"' in (m.group(0) or ""):
            return " "
        return m.group(1).strip()
    # People first: on a team's own page the person's chip can come after the due date.
    text = re.sub(r"[ \t]+", " ", _PERSON.sub(person, text)).rstrip()
    due = None
    dm = _DUE.search(text)
    if dm:
        due = dm.group(1).strip()
        text = text[: dm.start()]
    text = re.sub(r"\s+", " ", text).strip(" ,;:-·")
    if text[:1].islower():
        text = text[:1].upper() + text[1:]
    return text, due, moment


# ── Companies ─────────────────────────────────────────────────────────────────


def company_of_domain(domain: str) -> str | None:
    d = (domain or "").lower().strip(".")
    if not d or d in FREE_MAIL or "." not in d:
        return None
    labels = d.split(".")[:-1]            # without the top-level domain
    while len(labels) > 1 and labels[-1] in _SLD:
        labels.pop()
    if not labels:
        return None
    name = labels[-1]
    if len(name) < 2:
        return None
    return name[:1].upper() + name[1:]


class Companies:
    """Which company a call is about, from what Markdrop already knows (never a HubSpot request): the deal
    folder's company, an account page's company, else the outside attendees' email domain."""

    def __init__(self, db: AsyncIOMotorDatabase, workspace_id: str, member_domains: set[str]):
        self.db, self.ws, self.member_domains = db, workspace_id, member_domains
        self._deals: dict[str, dict] | None = None
        self._by_company: dict[str, str] = {}

    async def _load(self) -> None:
        if self._deals is not None:
            return
        self._deals = {}
        async for r in self.db["hubspot_deal_folders"].find({"workspace_id": self.ws}, {"deal_id": 1, "company": 1, "name": 1}):
            self._deals[str(r.get("deal_id"))] = r
            co = r.get("company") or {}
            if co.get("id") and co.get("name"):
                self._by_company[str(co["id"])] = co["name"]
        async for r in self.db["hubspot_accounts"].find({"workspace_id": self.ws}, {"company_id": 1, "name": 1}):
            if r.get("company_id") and r.get("name"):
                self._by_company.setdefault(str(r["company_id"]), r["name"])

    async def of(self, meeting: dict) -> tuple[str, str]:
        """(key, name): "hs:<company id>" | "deal:<id>" | "dom:<domain>" | "internal"."""
        await self._load()
        hs = meeting.get("hubspot") or {}
        m = hs.get("match") or {}
        deal_id = (hs.get("filed") or {}).get("deal_id") or m.get("deal_id")
        if deal_id and str(deal_id) in (self._deals or {}):
            row = self._deals[str(deal_id)]
            co = row.get("company") or {}
            if co.get("id") and co.get("name"):
                return f"hs:{co['id']}", co["name"]
            if row.get("name"):
                return f"deal:{deal_id}", row["name"]
        for cid in m.get("company_ids") or []:
            if str(cid) in self._by_company:
                return f"hs:{cid}", self._by_company[str(cid)]
        counts: dict[str, int] = {}
        for p in [*(meeting.get("attendees") or []), *(meeting.get("invited") or [])]:
            if p.get("user_id"):
                continue
            email = (p.get("email") or "").lower()
            if "@" not in email:
                continue
            dom = email.rsplit("@", 1)[1]
            if dom in self.member_domains or dom in FREE_MAIL:
                continue
            counts[dom] = counts.get(dom, 0) + 1
        if counts:
            dom = max(counts, key=lambda d: (counts[d], d))
            name = company_of_domain(dom)
            if name:
                return f"dom:{dom}", name
        return "internal", INTERNAL


# ── Collecting a person's items ───────────────────────────────────────────────


@dataclass
class Item:
    block: str
    text: str
    due: str | None
    moment: str | None
    done: bool                 # on the meeting page now
    meeting_doc_id: ObjectId
    meeting_slug: str
    meeting_title: str
    date: str | None
    company_key: str
    company: str
    source: str = "call"       # "call" | "page" (one of the team's pages)


@dataclass
class Collected:
    items: list[Item] = field(default_factory=list)
    meetings: int = 0


async def _member_domains(db: AsyncIOMotorDatabase, workspace_id: str) -> set[str]:
    from app.services import workspace_memory as wm

    out = set()
    for p in await wm.members_of(db, workspace_id):
        e = (p.get("email") or "").lower()
        if "@" in e:
            dom = e.rsplit("@", 1)[1]
            if dom not in FREE_MAIL:
                out.add(dom)
    return out


async def collect(db: AsyncIOMotorDatabase, team: dict, user) -> Collected:
    """The person's action items from the team's calls they can read, newest call first."""
    from app.services import md_outline

    ws, tid, uid = team["workspace_id"], str(team["_id"]), user.id
    rows = await db["meetings"].find(
        {"workspace_id": ws, "team_ids": tid, "doc_id": {"$ne": None}},
        {"segments": 0, "generated": 0, "notes": 0}).sort([("date", -1), ("created_at", -1)]).limit(MAX_MEETINGS) \
        .to_list(length=MAX_MEETINGS)
    by_doc = {r["doc_id"]: r for r in rows if r.get("doc_id") is not None}
    out = Collected()
    docs = [] if not by_doc else await db["documents"].find(
        {"_id": {"$in": list(by_doc)}, "deleted_at": None, "encrypted": {"$ne": True},
         "content": {"$regex": re.escape(f'id="{uid}"')}}).to_list(length=len(by_doc))
    actor, ctx = access.Actor.of(user), access.Ctx(db, surface="todos")
    companies = Companies(db, ws, await _member_domains(db, ws))
    for raw in docs:
        if not (await access.can(actor, raw, "read", ctx)).allowed:
            continue
        mrow = by_doc[raw["_id"]]
        mine = [ln for ln in task_lines(raw.get("content") or "") if f'id="{uid}"' in ln.rest]
        if not mine:
            continue
        out.meetings += 1
        key, name = await companies.of(mrow)
        title = mrow.get("title") or md_outline.display_title(raw) or "Meeting"
        for ln in mine:
            text, due, moment = _clean_text(ln.rest, uid)
            if not text:
                continue
            out.items.append(Item(ln.block, text, due, moment, ln.done, raw["_id"], raw["slug"], title,
                                  mrow.get("date"), key, name))
    seen = {it.block for it in out.items}
    out.items.sort(key=lambda it: (it.date or ""), reverse=True)
    from_pages = [it for it in await collect_pages(db, team, user, set(by_doc)) if it.block not in seen]
    out.items = (out.items + from_pages)[:MAX_ITEMS]
    return out


async def _hidden_folders(db: AsyncIOMotorDatabase, workspace_id: str) -> list[str]:
    """The workspace's hidden folders (Deals and its deal folders, To-dos, archives) and everything under them."""
    rows = await db["folders"].find({"workspace_id": workspace_id}, {"parent_id": 1, "hidden": 1}).to_list(length=20000)
    kids: dict[str, list[str]] = {}
    for r in rows:
        kids.setdefault(str(r.get("parent_id") or ""), []).append(str(r["_id"]))
    out: set[str] = set()
    todo = [str(r["_id"]) for r in rows if r.get("hidden")]
    while todo:
        f = todo.pop()
        if f in out:
            continue
        out.add(f)
        todo += kids.get(f, [])
    return list(out)


async def collect_pages(db: AsyncIOMotorDatabase, team: dict, user, skip: set | None = None) -> list[Item]:
    """The person's tasks on the team's own pages: task lines with a block id that @mention them, on pages in the
    team they can read (not meeting pages, to-do pages, or anything in a hidden folder), newest edit first."""
    from app.services import md_outline

    ws, tid, uid = team["workspace_id"], str(team["_id"]), user.id
    q: dict[str, Any] = {"workspace_id": ws, "team_ids": tid, "deleted_at": None, "encrypted": {"$ne": True},
                         "meeting_id": None, "todo_team_id": None, "backlog_team_id": None, "content": {"$regex": re.escape(f'id="{uid}"')}}
    hidden = await _hidden_folders(db, ws)
    if hidden:
        q["folder_id"] = {"$nin": [*hidden, *[ObjectId(h) for h in hidden if ObjectId.is_valid(h)]]}
    if skip:
        q["_id"] = {"$nin": list(skip)}
    docs = await db["documents"].find(q).sort([("updated_at", -1), ("_id", -1)]).limit(MAX_TEAM_PAGES) \
        .to_list(length=MAX_TEAM_PAGES)
    actor, ctx = access.Actor.of(user), access.Ctx(db, surface="todos")
    out: list[Item] = []
    for raw in docs:
        mine = [ln for ln in task_lines(raw.get("content") or "") if f'id="{uid}"' in ln.rest]
        if not mine or not (await access.can(actor, raw, "read", ctx)).allowed:
            continue
        title = md_outline.display_title(raw) or raw.get("title") or "Untitled page"
        when = _aware(raw.get("updated_at") or raw.get("created_at"))
        day = when.date().isoformat() if when else None
        for ln in mine:
            text, due, _moment = _clean_text(ln.rest, uid)
            if not text:
                continue
            out.append(Item(ln.block, text, due, None, ln.done, raw["_id"], raw["slug"], title, day, PAGES_KEY,
                            PAGES_SECTION, source="page"))
    return out


# ── Writing the section ───────────────────────────────────────────────────────


def _fmt_day(d: str | None) -> str:
    """"Nov 17" (this year) or "Nov 17, 2025"."""
    from datetime import date

    try:
        x = date.fromisoformat((d or "")[:10])
    except ValueError:
        return ""
    return f"{x:%b} {x.day}" + ("" if x.year == now_utc().year else f", {x.year}")


def _attr(v: str) -> str:
    return re.sub(r"\s+", " ", (v or "").replace('"', "'").replace("\\", "")).strip()[:150]


def item_line(it: Item, done: bool) -> str:
    from app.services import meetings

    parts = [it.text]
    if it.due:
        parts.append(f"due {it.due}")
    call = meetings.md_inline(it.meeting_title)[:120] + (f" · {_fmt_day(it.date)}" if it.date and it.source == "call" else "")
    link = f"[{call}](/{it.meeting_slug}#{it.block})"
    tail = f" — {link}" + (f" · {it.moment}" if it.moment else "")
    return f"- [{'x' if done else ' '}] {' · '.join(parts)}{tail} {{#{it.block}}}"


@dataclass
class Section:
    key: str
    name: str
    open: int
    last_call: str | None
    lines: list[str]


def sections(items: list[Item], state: dict[str, bool], shown: Callable[[Item, bool], bool]) -> list[Section]:
    groups: dict[str, list[Item]] = {}
    names: dict[str, str] = {}
    for it in items:
        groups.setdefault(it.company_key, []).append(it)
        names.setdefault(it.company_key, it.company)
    out = []
    for key, its in groups.items():
        visible = [it for it in its if shown(it, state[it.block])]
        if not visible:
            continue
        opened = [it for it in visible if not state[it.block]]
        closed = [it for it in visible if state[it.block]]
        last = None if key == PAGES_KEY else (max((it.date or "" for it in its), default="") or None)
        out.append(Section(key, names[key], len(opened), last, [item_line(it, state[it.block]) for it in opened + closed]))
    out.sort(key=lambda s: (s.key == PAGES_KEY, s.key == "internal", -(int((s.last_call or "0000-00-00").replace("-", "")) or 0),
                            s.name.casefold()))
    return out


def section_markdown(secs: list[Section]) -> str:
    out = [START, ""]
    if not any(s.open for s in secs):
        out += [EMPTY, ""]
    for s in secs:
        head = f"{s.name} · {s.open} open" + (f" · last call {_fmt_day(s.last_call)}" if s.last_call else "")
        out.append(f':::details{{summary="{_attr(head)}" heading="3" open="1"}}')
        out += s.lines
        out += [":::", ""]
    out.append(END)
    return "\n".join(out)


def merge(content: str, section: str) -> str:
    from app.services import hubspot_accounts

    return hubspot_accounts.merge(content or "", section, start=START, end=END)


def intro(team_name: str) -> str:
    from app.services import meetings

    return (f"Your action items from the calls in **{meetings.md_inline(team_name)}**, by company, and the tasks on its pages that "
            f"mention you. Tick one here or where it came from: both follow. Only you and the team's leads can see this page; "
            f"share it like any page.")


# ── The page ──────────────────────────────────────────────────────────────────


async def _user(db: AsyncIOMotorDatabase, uid: str | None):
    from app.services.user import get_user_by_id

    return await get_user_by_id(db, uid) if uid else None


async def _folder(db: AsyncIOMotorDatabase, team: dict) -> str:
    """The team's hidden "To-dos" folder (made once)."""
    from app.services import folder as folder_service
    from app.services import teams as T

    ws, tid = team["workspace_id"], str(team["_id"])
    q = {"workspace_id": ws, "todo_root": tid}
    f = await db["folders"].find_one(q, sort=[("created_at", 1), ("_id", 1)])
    if f is None:
        made = await folder_service.create_folder(db, ws, FOLDER_NAME, None)
        await db["folders"].update_one({"_id": ObjectId(made.id)}, {"$set": {
            "todo_root": tid, "hidden": True, **T.team_update([tid], [])["$set"]}})
        f = await db["folders"].find_one(q, sort=[("created_at", 1), ("_id", 1)])
        if f is not None and str(f["_id"]) != made.id:
            await db["folders"].delete_one({"_id": ObjectId(made.id)})
    if f is not None and not f.get("hidden"):
        await db["folders"].update_one({"_id": f["_id"]}, {"$set": {"hidden": True}})
    return str(f["_id"])


def _title(user) -> str:
    from app.services import viewers

    return (viewers.display_name(user) or "Someone")[:150] + TITLE_SUFFIX


async def _page(db: AsyncIOMotorDatabase, team: dict, user, *, create: bool) -> dict | None:
    """The person's to-do page in the team (made when ``create``)."""
    from app.services import pages
    from app.services import teams as T

    tid, uid = str(team["_id"]), user.id
    row = await db[PAGES].find_one({"_id": page_key(tid, uid)})
    raw = await db["documents"].find_one({"_id": row["doc_id"], "deleted_at": None}) if row and row.get("doc_id") else None
    if raw is not None or not create:
        return raw
    folder = await _folder(db, team)
    content = intro(team.get("name") or "the team") + "\n\n" + section_markdown([]) + "\n"
    made = None
    for who in (user, *[await _user(db, x) for x in (team.get("lead_ids") or [])]):
        if who is None:
            continue
        actor, ctx = access.Actor.of(who), access.Ctx(db, surface="todos")
        try:
            made, _secret, _err = await pages.create_page(db, who, actor, ctx, title=_title(user), workspace=team["workspace_id"],
                                                          folder=folder, content=content, access_level="private")
            break
        except HTTPException as exc:
            log.info("todos: %s can't make the to-do page of %s (%s)", who.id, uid, exc.detail)
    if made is None:
        return None
    raw = await db["documents"].find_one({"_id": made["_id"]}) or made
    await T.apply_to_doc(db, raw, [tid], [])
    sets = {"todo_team_id": tid, "todo_user_id": uid}
    if raw.get("owner_id") != uid:
        sets["owner_id"] = uid      # made by a lead for a member who can't add pages (a workspace viewer): theirs
    if (raw.get("access_level") or "link") != "private":
        sets["access_level"] = "private"
    await db["documents"].update_one({"_id": raw["_id"]}, {"$set": sets})
    now = now_utc()
    await db[PAGES].update_one({"_id": page_key(tid, uid)}, {"$set": {
        "workspace_id": team["workspace_id"], "team_id": tid, "user_id": uid, "doc_id": raw["_id"], "slug": raw.get("slug"),
        "updated_at": now}, "$setOnInsert": {"created_at": now, "open": 0, "sections": []}}, upsert=True)
    return await db["documents"].find_one({"_id": raw["_id"]})


async def _save(db: AsyncIOMotorDatabase, raw: dict, make: Callable[[str], str | None], user, *, tries: int = 4) -> dict | None:
    """Write ``make(current content)`` over the latest version as ``user``, quietly, merging into an open editor.
    None: nothing to change (or it couldn't)."""
    from app.schemas.document import DocumentUpdate
    from app.services import document as doc_service
    from app.services import notifications, pages

    # "system": Markdrop's own write as this person — it merges into open editors and isn't their edit (the
    # edit lock's idle clock and unsaved flag stay theirs: pages.touch_lock).
    actor, ctx = access.Actor.of(user, cred="system"), access.Ctx(db, surface="todos")
    token = pages.MERGE_EDIT.set(True)
    try:
        for _ in range(tries):
            cur = raw.get("content") or ""
            new = make(cur)
            if new is None or new == cur:
                return None
            try:
                data = DocumentUpdate(title=raw.get("title"), content=new, base_rev=int(raw.get("rev") or 1))
                with notifications.quiet():
                    return await doc_service.update_document(db, raw["slug"], data, actor, ctx)
            except HTTPException as exc:
                if exc.status_code == 409:
                    raw = await db["documents"].find_one({"_id": raw["_id"]}) or raw
                    continue
                log.info("todos: couldn't write %s (%s %s)", raw.get("slug"), exc.status_code, exc.detail)
                return None
        return None
    finally:
        pages.MERGE_EDIT.reset(token)


def _set_mark(content: str, block: str, done: bool) -> str | None:
    for ln in task_lines(content):
        if ln.block == block:
            if ln.done == done:
                return None
            return content[: ln.start] + ("x" if done else " ") + content[ln.start + 1:]
    return None


# ── Rebuild ───────────────────────────────────────────────────────────────────


@dataclass
class Built:
    team_id: str
    user_id: str
    slug: str | None = None
    open: int = 0
    items: int = 0
    meetings: int = 0
    sections: list[dict] = field(default_factory=list)
    written: bool = False
    skipped: str | None = None
    added: int = 0             # items shown now that the page didn't have before
    created: bool = False      # the page was made by this build


async def build(db: AsyncIOMotorDatabase, team_id: str, user_id: str, *, apply: bool = True) -> Built:
    """Make or bring up to date one person's to-do page in a team (dry run: ``apply=False``, nothing written)."""
    from app.services import teams as T

    out = Built(team_id, user_id)
    team = await db[T.TEAMS].find_one({"_id": _oid(team_id)})
    if team is None or T.is_general(team):
        out.skipped = "no team" if team is None else "General has no to-do pages"
        return out
    if user_id not in (team.get("member_ids") or []):
        out.skipped = "not a member"
        return out
    user = await _user(db, user_id)
    if user is None:
        out.skipped = "no account"
        return out
    key = f"{id(asyncio.get_running_loop())}:{page_key(team_id, user_id)}"
    lock = _locks.setdefault(key, asyncio.Lock())
    async with lock:
        return await _build(db, team, user, out, apply)


async def _build(db: AsyncIOMotorDatabase, team: dict, user, out: Built, apply: bool) -> Built:
    tid, uid = str(team["_id"]), user.id
    got = await collect(db, team, user)
    out.meetings = got.meetings
    had = await _page(db, team, user, create=False)
    raw = had if had is not None or not apply else await _page(db, team, user, create=True)
    out.created = had is None and raw is not None
    page_marks = marks(region((raw or {}).get("content") or "")) if raw else {}
    stored = {}
    if raw is not None:
        stored = {r["block"]: r async for r in db[ITEMS].find({"todo_doc_id": raw["_id"]})}
    # Three-way: the call changed since we agreed → the call; else the page's own tick stays (and is pushed again).
    state: dict[str, bool] = {}
    push: list[Item] = []
    for it in got.items:
        s = stored.get(it.block)
        p = page_marks.get(it.block)
        if s is None or it.done != bool(s.get("done")):
            state[it.block] = it.done
        elif p is not None and p != bool(s.get("done")):
            state[it.block] = p
            push.append(it)
        else:
            state[it.block] = it.done
    now = now_utc()

    def done_at(it: Item) -> datetime | None:
        s = stored.get(it.block)
        if not state[it.block]:
            return None
        if s is not None and s.get("done") and s.get("done_at"):
            return _aware(s["done_at"])
        if s is not None:
            return now               # ticked since we last looked
        return None                  # done before this page knew it: not shown

    when = {it.block: done_at(it) for it in got.items}

    def shown(it: Item, done: bool) -> bool:
        return (not done) or (when[it.block] is not None and when[it.block] > now - DONE_SHOWN)

    secs = sections(got.items, state, shown)
    out.items = sum(1 for it in got.items if shown(it, state[it.block]))
    out.added = sum(1 for it in got.items if it.block not in stored and shown(it, state[it.block]))
    out.open = sum(s.open for s in secs)
    out.sections = [{"name": s.name, "open": s.open, "last_call": s.last_call} for s in secs]
    if not apply or raw is None:
        if raw is None and apply:
            out.skipped = "couldn't make the page"
        out.slug = (raw or {}).get("slug")
        return out
    out.slug = raw.get("slug")
    # The agreed state first: the save hook below must find nothing to send back.
    keep = []
    for it in got.items:
        keep.append(it.block)
        await db[ITEMS].update_one({"_id": f"{raw['_id']}:{it.block}"}, {"$set": {
            "todo_doc_id": raw["_id"], "team_id": tid, "user_id": uid, "meeting_doc_id": it.meeting_doc_id,
            "block": it.block, "done": state[it.block], "done_at": when[it.block], "updated_at": now}}, upsert=True)
    await db[ITEMS].delete_many({"todo_doc_id": raw["_id"], "block": {"$nin": keep}})
    section = section_markdown(secs)
    after = await _save(db, raw, lambda cur: merge(cur, section), user)
    out.written = after is not None
    await db[PAGES].update_one({"_id": page_key(tid, uid)}, {"$set": {
        "open": out.open, "sections": out.sections, "built_at": now, "slug": (after or raw).get("slug"),
        "title": (after or raw).get("title")}})
    for it in push:
        await push_to_meeting(db, it.meeting_doc_id, it.block, state[it.block], user)
    return out


async def ensure_team(db: AsyncIOMotorDatabase, team_id: str, *, apply: bool = True,
                      on_line: Callable[[str], Any] | None = None) -> list[Built]:
    """Every member of the team gets their page (built from the team's calls)."""
    from app.services import teams as T

    team = await db[T.TEAMS].find_one({"_id": _oid(team_id)})
    if team is None or T.is_general(team):
        return []
    out = []
    for uid in list(dict.fromkeys(team.get("member_ids") or [])):
        if apply and await db[PAGES].find_one({"_id": page_key(team_id, uid), "doc_id": {"$ne": None}}):
            continue
        b = await build(db, team_id, uid, apply=apply)
        out.append(b)
        if on_line:
            on_line(_line(b))
    return out


async def refresh(db: AsyncIOMotorDatabase, team_id: str, user) -> dict:
    """"Create my to-dos" / "Refresh to-dos": make or rebuild the caller's page in the team now, from the team's calls
    and pages. ``{slug, href, open, added, created}``. The caller checked the team (member, not General)."""
    b = await build(db, team_id, user.id)
    if b.skipped:
        raise HTTPException(status_code=409 if b.skipped == "couldn't make the page" else 404,
                            detail="Couldn't make your to-do page. Try again in a moment." if b.skipped == "couldn't make the page"
                            else f"No to-do page here ({b.skipped}).")
    return {"slug": b.slug, "href": f"/{b.slug}" if b.slug else None, "open": b.open, "added": b.added, "created": b.created}


async def status(db: AsyncIOMotorDatabase, team_id: str, user_id: str) -> dict:
    """Does the person have a to-do page in the team (nothing is made): ``{exists, slug, href, open, updated_at}``."""
    row = await db[PAGES].find_one({"_id": page_key(team_id, user_id), "doc_id": {"$ne": None}})
    if row is not None and not await db["documents"].find_one({"_id": row["doc_id"], "deleted_at": None}, {"_id": 1}):
        row = None
    slug = (row or {}).get("slug")
    return {"exists": row is not None, "slug": slug, "href": f"/{slug}" if slug else None, "open": int((row or {}).get("open") or 0),
            "updated_at": (row or {}).get("built_at")}


def _line(b: Built) -> str:
    secs = ", ".join(f"{s['name']} ({s['open']})" for s in b.sections) or "none"
    what = f"skipped: {b.skipped}" if b.skipped else f"{b.open} open in {len(b.sections)} section(s): {secs}"
    return f"  {b.user_id}: {b.meetings} call(s) · {what}" + (f" · /{b.slug}" if b.slug else "")


async def backfill(db: AsyncIOMotorDatabase, workspace_id: str, team_ref: str | None, *, apply: bool,
                   on_line: Callable[[str], Any] | None = None) -> dict:
    """The script: every member of the workspace's teams (or one team) — a page each, built from the calls."""
    from app.services import teams as T

    q: dict[str, Any] = {"workspace_id": workspace_id, "general": {"$ne": True}}
    teams = await db[T.TEAMS].find(q).to_list(length=T.MAX_TEAMS + 10)
    if team_ref:
        r = team_ref.strip().casefold()
        teams = [t for t in teams if str(t["_id"]) == team_ref or (t.get("slug") or "") == r or (t.get("name") or "").casefold() == r]
        if not teams:
            raise RuntimeError(f"No team {team_ref!r} in workspace {workspace_id}.")
    summary = {"teams": [], "pages": 0, "open": 0}
    for t in teams:
        if on_line:
            on_line(f"{t.get('name')} ({t['_id']}): {len(t.get('member_ids') or [])} member(s)")
        built = []
        for uid in list(dict.fromkeys(t.get("member_ids") or [])):
            b = await build(db, str(t["_id"]), uid, apply=apply)
            built.append(b)
            if on_line:
                on_line(_line(b))
        summary["teams"].append({"id": str(t["_id"]), "name": t.get("name"), "members": len(built),
                                 "open": sum(b.open for b in built), "skipped": sum(1 for b in built if b.skipped)})
        summary["pages"] += sum(1 for b in built if not b.skipped)
        summary["open"] += sum(b.open for b in built)
    return summary


# ── Sync: the save hook ───────────────────────────────────────────────────────


async def on_page_saved(db: AsyncIOMotorDatabase, before: dict, after: dict, actor) -> None:
    """``document.update_document`` after every save. Never fails the save."""
    try:
        if after.get("encrypted"):
            return
        if after.get("todo_team_id"):
            await _from_todo_page(db, before, after, actor)
        elif after.get("meeting_id"):
            await _from_meeting_page(db, before, after)
        elif after.get("backlog_team_id"):
            return                      # the team's backlog (services/team_backlog.py): its own items, not anyone's to-dos
        elif after.get("team_ids") or before.get("team_ids"):
            await _from_team_page(db, before, after)
    except Exception:
        log.warning("todos: the save hook failed", exc_info=True)


def _people_lines(content: str) -> dict[str, tuple[bool, str]]:
    return {ln.block: (ln.done, ln.rest) for ln in task_lines(content) if 'id="' in ln.rest}


async def _from_meeting_page(db: AsyncIOMotorDatabase, before: dict, after: dict) -> None:
    a = _people_lines(before.get("content") or "")
    b = _people_lines(after.get("content") or "")
    if a == b:
        return
    who: set[str] = set()
    for blk in set(a) | set(b):
        if a.get(blk) != b.get(blk):
            who |= mentions((a.get(blk) or (False, ""))[1]) | mentions((b.get(blk) or (False, ""))[1])
    if who:
        await meeting_people_changed(db, after["_id"], who)


async def meeting_people_changed(db: AsyncIOMotorDatabase, doc_id, who: set[str] | None = None,
                                 extra_teams: list[str] | None = None) -> None:
    """Rebuild the to-do pages of ``who`` (None: everyone its task lines mention) in the meeting's teams."""
    from app.services import teams as T

    m = await db["meetings"].find_one({"doc_id": doc_id}, {"team_ids": 1, "workspace_id": 1})
    tids = list(dict.fromkeys([*T.ids_of(m, "team_ids"), *(extra_teams or [])]))
    if not tids:
        return
    if who is None:
        raw = await db["documents"].find_one({"_id": doc_id}, {"content": 1})
        who = set()
        for _done, rest in _people_lines((raw or {}).get("content") or "").values():
            who |= mentions(rest)
    if not who:
        return
    for t in await db[T.TEAMS].find({"_id": {"$in": [_oid(x) for x in tids if _oid(x)]}}).to_list(length=len(tids)):
        if T.is_general(t):
            continue
        tid = str(t["_id"])
        members = set(t.get("member_ids") or [])
        for uid in who & members:
            schedule(db, tid, uid)
        # The team now uses to-dos: everyone in it gets a page.
        if who & members and not await db[PAGES].find_one({"team_id": tid}, {"_id": 1}):
            team_changed_now(db, tid)


async def _from_team_page(db: AsyncIOMotorDatabase, before: dict, after: dict) -> None:
    """One of a team's own pages saved: the people its changed task lines mention get their (existing) to-do pages
    rebuilt. Cheap first: a save without a person chip on either side stops at a substring test."""
    from app.services import teams as T

    a_text, b_text = before.get("content") or "", after.get("content") or ""
    if ":person[" not in a_text and ":person[" not in b_text:
        return
    a, b = _people_lines(a_text), _people_lines(b_text)
    moved = set(T.ids_of(before, "team_ids")) != set(T.ids_of(after, "team_ids")) or bool(after.get("deleted_at"))
    if a == b and not moved:
        return
    who: set[str] = set()
    for blk in set(a) | set(b):
        if moved or a.get(blk) != b.get(blk):
            who |= mentions((a.get(blk) or (False, ""))[1]) | mentions((b.get(blk) or (False, ""))[1])
    tids = list(dict.fromkeys([*T.ids_of(before, "team_ids"), *T.ids_of(after, "team_ids")]))
    if not who or not tids:
        return
    async for r in db[PAGES].find({"team_id": {"$in": tids}, "user_id": {"$in": list(who)}, "doc_id": {"$ne": None}},
                                  {"team_id": 1, "user_id": 1}):
        schedule(db, r["team_id"], r["user_id"])


def team_changed_now(db: AsyncIOMotorDatabase, team_id: str) -> None:
    async def run():
        try:
            await ensure_team(db, team_id)
        except Exception:
            log.warning("todos: ensuring team %s failed", team_id, exc_info=True)

    try:
        spawn(run())
    except RuntimeError:
        pass


async def _from_todo_page(db: AsyncIOMotorDatabase, before: dict, after: dict, actor) -> None:
    now_marks = marks(after.get("content") or "")
    if marks(before.get("content") or "") == now_marks:
        return
    rows = {r["block"]: r async for r in db[ITEMS].find({"todo_doc_id": after["_id"]})}
    for blk, done in now_marks.items():
        r = rows.get(blk)
        if r is None or bool(r.get("done")) == done:
            continue
        res = await db[ITEMS].update_one({"_id": r["_id"], "done": r.get("done")},
                                         {"$set": {"done": done, "done_at": now_utc() if done else None, "updated_at": now_utc()}})
        if not res.modified_count:
            continue
        user = getattr(actor, "user", None) or await _user(db, after.get("todo_user_id"))
        await push_to_meeting(db, r["meeting_doc_id"], blk, done, user, owner_id=after.get("todo_user_id"))


async def push_to_meeting(db: AsyncIOMotorDatabase, doc_id, block: str, done: bool, user, *, owner_id: str | None = None) -> bool:
    """Tick (or untick) the action item ``block`` on its meeting page: as ``user`` when they may edit it, else —
    their own item on a call they can read — as the call page's owner."""
    raw = await db["documents"].find_one({"_id": doc_id, "deleted_at": None})
    if raw is None or user is None:
        return False
    actor, ctx = access.Actor.of(user), access.Ctx(db, surface="todos")
    writer = None
    if (await access.can(actor, raw, "edit_content", ctx)).allowed:
        writer = user
    elif (await access.can(actor, raw, "read", ctx)).allowed:
        line = next((ln for ln in task_lines(raw.get("content") or "") if ln.block == block), None)
        assignee = owner_id or user.id
        if line is not None and f'id="{assignee}"' in line.rest and assignee == user.id:
            writer = await _user(db, raw.get("owner_id"))
    if writer is None:
        log.info("todos: %s can't tick %s on %s", getattr(user, "id", None), block, raw.get("slug"))
        return False
    after = await _save(db, raw, lambda cur: _set_mark(cur, block, done), writer)
    return after is not None


# ── Reading (the website, MCP) ────────────────────────────────────────────────


def _card(row: dict, team: dict | None, ppl: dict[str, dict], viewer: str) -> dict:
    p = ppl.get(row["user_id"]) or {}
    return {"team": {"id": row["team_id"], "name": (team or {}).get("name")}, "workspace_id": row["workspace_id"],
            "user": {"id": row["user_id"], "name": p.get("name") or "Someone", "avatar_url": p.get("avatar_url")},
            "you": row["user_id"] == viewer, "slug": row.get("slug"), "href": f"/{row['slug']}" if row.get("slug") else None,
            "title": row.get("title"), "open": int(row.get("open") or 0), "sections": row.get("sections") or [],
            "updated_at": row.get("built_at")}


async def _fresh(db: AsyncIOMotorDatabase, rows: list[dict]) -> None:
    cut = now_utc() - STALE
    for r in rows:
        b = _aware(r.get("built_at"))
        if b is None or b < cut:
            schedule(db, r["team_id"], r["user_id"])


async def mine(db: AsyncIOMotorDatabase, user, *, workspace_id: str | None = None, team_id: str | None = None) -> list[dict]:
    """Your to-do pages across your teams (made now when missing)."""
    return (await mine_and_missing(db, user, workspace_id=workspace_id, team_id=team_id))[0]


async def mine_and_missing(db: AsyncIOMotorDatabase, user, *, workspace_id: str | None = None,
                           team_id: str | None = None) -> tuple[list[dict], list[dict]]:
    """(your to-do pages, the teams you're in where there's still none — it couldn't be made: "Create my to-dos")."""
    from app.services import teams as T

    ws_ids = [workspace_id] if workspace_id else [
        m["workspace_id"] for m in await db["memberships"].find({"user_id": user.id}, {"workspace_id": 1}).to_list(length=500)]
    q: dict[str, Any] = {"workspace_id": {"$in": ws_ids}, "member_ids": user.id, "general": {"$ne": True}}
    if team_id:
        q["_id"] = _oid(team_id)
    teams = await db[T.TEAMS].find(q).to_list(length=500)
    rows = []
    missing = []
    for t in teams:
        tid = str(t["_id"])
        row = await db[PAGES].find_one({"_id": page_key(tid, user.id)})
        if row is None or not row.get("doc_id") or not await db["documents"].find_one({"_id": row["doc_id"], "deleted_at": None}, {"_id": 1}):
            await build(db, tid, user.id)
            row = await db[PAGES].find_one({"_id": page_key(tid, user.id)})
        if row is not None and row.get("doc_id"):
            rows.append((row, t))
        else:
            missing.append({"team": {"id": tid, "name": t.get("name"), "slug": t.get("slug")}, "workspace_id": t["workspace_id"]})
    await _fresh(db, [r for r, _t in rows])
    names = {}
    for ws in {r["workspace_id"] for r, _t in rows}:
        names[ws] = (await db["workspaces"].find_one({"_id": _oid(ws)}, {"name": 1}) or {}).get("name")
    me = {user.id: {"name": None, "avatar_url": None}}
    out = []
    for r, t in rows:
        c = _card(r, t, me, user.id)
        c["user"]["name"] = getattr(user, "name", None) or c["user"]["name"]
        c["workspace"] = {"id": r["workspace_id"], "name": names.get(r["workspace_id"])}
        out.append(c)
    out.sort(key=lambda c: (-c["open"], (c["team"]["name"] or "").casefold()))
    for m in missing:
        m["workspace"] = {"id": m["workspace_id"], "name": names.get(m["workspace_id"])
                          or (await db["workspaces"].find_one({"_id": _oid(m["workspace_id"])}, {"name": 1}) or {}).get("name")}
    return out, missing


async def team(db: AsyncIOMotorDatabase, user, view, team_row: dict) -> dict:
    """The team's to-do pages for ``user``: a lead sees every member's, anyone else their own."""
    from app.services import teams as T
    from app.services import workspace_memory as wm

    tid = str(team_row["_id"])
    if T.is_general(team_row):
        return {"team": {"id": tid, "name": team_row.get("name")}, "lead": False, "pages": [], "general": True}
    lead = view.lead_of(tid)
    member = user.id in (team_row.get("member_ids") or [])
    if lead:
        await ensure_team(db, tid)
    elif member and not await db[PAGES].find_one({"_id": page_key(tid, user.id), "doc_id": {"$ne": None}}):
        await build(db, tid, user.id)
    q: dict[str, Any] = {"team_id": tid, "doc_id": {"$ne": None}}
    if not lead:
        q["user_id"] = user.id
    rows = [r for r in await db[PAGES].find(q).to_list(length=500) if r["user_id"] in (team_row.get("member_ids") or [])]
    await _fresh(db, rows)
    ppl = {p["id"]: p for p in await wm.members_of(db, team_row["workspace_id"])}
    cards = [_card(r, team_row, ppl, user.id) for r in rows]
    # Someone else's page: its counts and companies as this reader may see them (calls they can't read hidden).
    actor, ctx = access.Actor.of(user), access.Ctx(db, surface="todos")
    for c, r in zip(cards, rows):
        if c["you"]:
            continue
        raw = await db["documents"].find_one({"_id": r["doc_id"]})
        if raw is None:
            continue
        shown = await for_reader(actor, raw, ctx, raw.get("content") or "")
        if shown != (raw.get("content") or ""):
            c["open"], secs = summary_of(shown)
            last = {x["name"]: x.get("last_call") for x in r.get("sections") or []}
            c["sections"] = [{"name": x["name"], "open": x["open"], "last_call": last.get(x["name"])} for x in secs if x["open"]]
    cards.sort(key=lambda c: (not c["you"], c["user"]["name"].casefold()))
    return {"team": {"id": tid, "name": team_row.get("name")}, "lead": lead, "member": member, "pages": cards}


async def items_of(db: AsyncIOMotorDatabase, slug: str, *, open_only: bool = True, reader=None) -> list[dict]:
    """A to-do page's items as data (MCP): [{block, done, text, company, call {title, slug}, due}] — as ``reader``
    (a user) may see them (:func:`for_reader`)."""
    raw = await db["documents"].find_one({"slug": slug, "deleted_at": None})
    content = (raw or {}).get("content") or ""
    if raw is not None and reader is not None:
        content = await for_reader(access.Actor.of(reader), raw, access.Ctx(db, surface="todos"), content)
    out = []
    company = None
    for line in region(content).split("\n"):
        h = re.match(r'^:::details\{summary="([^"]*)"', line)
        if h:
            company = h.group(1).split(" · ")[0]
            continue
        m = _TASK.match(line)
        if not m:
            continue
        done = m.group("mark") in "xX"
        if open_only and done:
            continue
        rest = m.group("rest").strip()
        text, _, tail = rest.partition(" — ")
        call = re.match(r"\[([^\]]*)\]\(/([^)#\s]+)#", tail)
        parts = text.split(" · ")
        due = next((p[4:] for p in parts[1:] if p.startswith("due ")), None)
        out.append({"block": m.group("block"), "done": done, "text": parts[0], "due": due, "company": company,
                    "call": {"title": call.group(1), "slug": call.group(2)} if call else None})
    return out


async def tick(db: AsyncIOMotorDatabase, user, block: str, done: bool = True, *, slug: str | None = None) -> dict:
    """Tick (``done``) or untick one of the caller's to-dos on their own to-do page — the call follows (the save hook).
    404: no such to-do of yours; 409: already that way."""
    q: dict[str, Any] = {"user_id": user.id, "doc_id": {"$ne": None}}
    rows = await db[PAGES].find(q).to_list(length=200)
    for r in rows:
        raw = await db["documents"].find_one({"_id": r["doc_id"], "deleted_at": None})
        if raw is None or (slug and raw.get("slug") != slug):
            continue
        cur = marks(region(raw.get("content") or ""))
        if block not in cur:
            continue
        if cur[block] == done:
            raise HTTPException(status_code=409, detail="That one is already done." if done else "That one is already open.")
        after = await _save(db, raw, lambda c: _set_mark(c, block, done), user)
        if after is None:
            raise HTTPException(status_code=409, detail="That page keeps changing. Try again in a moment.")
        return {"done": done, "slug": raw.get("slug"), "block": block}
    raise HTTPException(status_code=404, detail="That isn't one of your to-dos.")


# ── What a reader other than the owner sees (read time) ──────────────────────
#
# The owner sees every item. Anyone else who reads the page (a team lead, someone it's shared with) sees an item only
# when they can read its call NOW; the others become "N items from private calls" in their section, and a section
# whose calls they can't read at all is folded into one "Private calls" section (no company name, no task text).
# Applied wherever a page's Markdown is served (pages.content_for: the page, MCP, export, history, AI). A save by such
# a reader keeps Markdrop's section as stored (:func:`restore_region`).

_HEAD = re.compile(r'^:::details\{summary="([^"]*)"(.*)\}\s*$')
PRIVATE = "Private calls"


def _plural(n: int) -> str:
    return f"{n} item{'s' if n != 1 else ''}"


async def _readable_blocks(actor: access.Actor, raw: dict, ctx: access.Ctx) -> dict[str, bool]:
    """{block: the reader can read its call} for the page's items."""
    db = ctx.db
    rows = await db[ITEMS].find({"todo_doc_id": raw["_id"]}, {"block": 1, "meeting_doc_id": 1}).to_list(length=MAX_ITEMS * 2)
    ids = list({r["meeting_doc_id"] for r in rows if r.get("meeting_doc_id") is not None})
    docs = {d["_id"]: d for d in await db["documents"].find({"_id": {"$in": ids}}, {"content": 0}).to_list(length=len(ids))} if ids else {}
    ok: dict[Any, bool] = {}
    for mid, d in docs.items():
        ok[mid] = (not d.get("deleted_at")) and (await access.can(actor, d, "read", ctx)).allowed
    return {r["block"]: ok.get(r.get("meeting_doc_id"), False) for r in rows}


def filter_region(content: str, readable: dict[str, bool]) -> str:
    """``content`` with the items of calls the reader can't read taken out of Markdrop's section."""
    lines = (content or "").split("\n")
    try:
        i = next(k for k, ln in enumerate(lines) if ln.strip() == START)
    except StopIteration:
        return content
    j = next((k for k in range(i + 1, len(lines)) if lines[k].strip() == END), None)
    if j is None:
        return content
    out: list[str] = []
    private = 0
    k = i
    while k < j:
        ln = lines[k]
        h = _HEAD.match(ln)
        if h is None:
            out.append(ln)
            k += 1
            continue
        end = next((x for x in range(k + 1, j) if lines[x].strip() == ":::"), j)
        body = lines[k + 1:end]
        keep, hidden, open_ = [], 0, 0
        for b in body:
            m = _TASK.match(b)
            if m and readable.get(m.group("block")) is False:
                hidden += 1
                continue
            if m and m.group("mark") == " ":
                open_ += 1
            keep.append(b)
        if not any(_TASK.match(b) for b in keep):
            private += hidden
        else:
            parts = h.group(1).split(" · ")
            rest = [p for p in parts[1:] if not re.match(r"^\d+ open$", p)]
            head = " · ".join([parts[0], f"{open_} open", *rest])
            out.append(f':::details{{summary="{_attr(head)}"{h.group(2)}}}')
            out += keep
            if hidden:
                out.append(f"_{_plural(hidden)} from private calls_")
            out.append(":::")
        k = end + 1
        # the blank line after a section stays (it is a normal line)
    if private:
        while out and not out[-1].strip():
            out.pop()
        out += ["", f':::details{{summary="{PRIVATE} · {_plural(private)}" heading="3" open="1"}}',
                f"_{_plural(private)} from calls you can't open._", ":::", ""]
    return "\n".join([*lines[:i], *out, *lines[j:]])


async def for_reader(actor: access.Actor, raw: dict, ctx: access.Ctx, content: str) -> str:
    if not content or START not in content:
        return content
    f = await access.facts(actor, raw, ctx)
    if f.is_owner or f.secret_ok:
        return content
    readable = await _readable_blocks(actor, raw, ctx)
    if all(readable.values()):
        return content
    return filter_region(content, readable)


def restore_region(new: str, old: str | None) -> str:
    """A save by someone other than the owner: Markdrop's section stays as stored (they may have been shown less)."""
    kept = region(old or "")
    if not kept or START not in (new or ""):
        return new
    return merge(new, kept)


def summary_of(content: str) -> tuple[int, list[dict]]:
    """(open, sections) as a page's Markdown shows them (a reader's own view of a card)."""
    secs, total = [], 0
    cur = None
    for ln in region(content).split("\n"):
        h = _HEAD.match(ln)
        if h:
            name = h.group(1).split(" · ")[0]
            last = next((p[10:] for p in h.group(1).split(" · ") if p.startswith("last call ")), None)
            cur = {"name": name, "open": 0, "last_call": None, "_last": last}
            secs.append(cur)
            continue
        m = _TASK.match(ln)
        if m and cur is not None and m.group("mark") == " ":
            cur["open"] += 1
            total += 1
    return total, secs
