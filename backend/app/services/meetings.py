"""Meetings: every team call as a page in the workspace's Meetings folder (v1: import).

    POST /api/v1/meetings/import (routers/meetings.py)     MCP ``import_meeting`` (mcp/meeting_tools.py)

A meeting is a ``meetings`` row plus two pages:

* the **meeting page** (blocks editor) in the workspace's Meetings folder (``folders.meetings``,
  created on the first import with typed properties: Date, Type, Attendees, Organizer, Duration,
  Action items): a summary callout, Decisions, Action items (``:person`` mentions for assignees who
  are members, which notify through the page-save path), Open questions, Topics, Google's Details
  when Google's notes were imported, and Sources;
* the **Transcript** sub-page: one anchored paragraph per segment (``{#b-t0012}``), which answers
  and the meeting page link to ("[Ada Lovelace, 12:34]").

**Access** is the page's (``access.can``), never the row's: the meeting page starts as
``workspace`` (the team), the transcript inherits it. *Restrict to attendees* makes it private
with a quiet grant for each attendee who is a workspace member; lifting it puts the level back and
removes exactly the grants it added. Every read of a meeting (list, detail, ask, MCP) re-decides
``can(read)`` on the meeting page.

**Retention** (owner, 2026-11-05): the transcript (``segments``) stays on the row until the meeting
is deleted. Deleting (the page's owner, or a workspace admin/owner for any meeting) drops the row
and moves both pages to the Trash.

The AI half (summary, decisions, … and asking) is services/meetings_ai.py.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import re
import secrets
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import access
from app.services import meeting_parse as mp

log = logging.getLogger("markdrop.meetings")

COLL = "meetings"
FOLDER_NAME = "Meetings"
TYPES = ("Standup", "Planning", "Review", "1:1", "Interview", "Customer", "Other")
SCHEMA = [
    {"key": "date", "name": "Date", "type": "date"},
    {"key": "type", "name": "Type", "type": "select", "options": [
        {"name": t, "color": c} for t, c in zip(TYPES, ("blue", "purple", "green", "orange", "pink", "yellow", "gray"))]},
    {"key": "attendees", "name": "Attendees", "type": "text"},
    {"key": "organizer", "name": "Organizer", "type": "person"},
    {"key": "duration", "name": "Duration", "type": "text"},
    {"key": "action_items", "name": "Action items", "type": "number"},
]
MAX_SOURCES = 6
MAX_SOURCE_BYTES = 4_000_000
MAX_PASTE_CHARS = 1_500_000
MAX_LIST = 300
PENDING_STALE = timedelta(minutes=15)
PAGE_ICON = "🎙️"
TRANSCRIPT_ICON = "📜"

_bg: set[asyncio.Task] = set()


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index([("workspace_id", 1), ("date", -1), ("created_at", -1)])
    await db[COLL].create_index("doc_id")
    await db[COLL].create_index("transcript_doc_id", sparse=True)


def oid(value: Any) -> ObjectId | None:
    if isinstance(value, ObjectId):
        return value
    if isinstance(value, str) and ObjectId.is_valid(value):
        return ObjectId(value)
    return None


# ── People ────────────────────────────────────────────────────────────────────


def _pnorm(name: str | None) -> str:
    n = re.sub(r"\(.*?\)", " ", name or "")
    n = re.sub(r"[^\w\s'-]+", " ", n.casefold())
    return re.sub(r"\s+", " ", n).strip()


class People:
    """The workspace's members, and who a name or address in a meeting is.

    Matching (never fuzzy across people): the address exactly; else the full name; else a first name
    (or the first word of the name given) that exactly one member has; else a name that is the start
    of exactly one member's name (or the other way round, 3+ letters). No match: plain text."""

    def __init__(self, members: list[dict]):
        self.members = [m for m in members if m.get("id")]
        self.by_email = {(m.get("email") or "").lower(): m for m in self.members if m.get("email")}
        self.by_name: dict[str, list[dict]] = {}
        self.by_first: dict[str, list[dict]] = {}
        for m in self.members:
            n = _pnorm(m.get("name"))
            if n:
                self.by_name.setdefault(n, []).append(m)
                self.by_first.setdefault(n.split(" ")[0], []).append(m)
            local = (m.get("email") or "").split("@")[0].lower()
            if local:
                self.by_name.setdefault(_pnorm(local.replace(".", " ").replace("_", " ")), []).append(m)

    def match(self, name: str | None, email: str | None = None) -> dict | None:
        if email and email.lower() in self.by_email:
            return self.by_email[email.lower()]
        n = _pnorm(name)
        if not n:
            return None
        hit = self.by_name.get(n)
        if hit and len(hit) == 1:
            return hit[0]
        if hit:
            return None   # two members with that name: don't guess
        first = n.split(" ")[0]
        if len(first) >= 2:
            hit = self.by_first.get(first)
            if hit and len(hit) == 1 and (n == first or _pnorm(hit[0].get("name")).startswith(n)):
                return hit[0]
        if len(n) >= 3:
            cands = [m for m in self.members if (mn := _pnorm(m.get("name"))) and (mn.startswith(n) or n.startswith(mn + " "))]
            if len(cands) == 1:
                return cands[0]
        return None

    def leading(self, text: str) -> tuple[dict | None, str, str]:
        """(member, the name as written, the rest) when ``text`` starts with a member's full name
        ("Priya Sharma will run …", "Priya Sharma <priya@…> will …") or a first name only one member
        has; (None, "", text) otherwise."""
        text = re.sub(r"^((?:\S+\s+){1,3}?)<([\w.+-]+@[\w-]+(?:\.[\w-]+)+)>\s*", lambda mm: mm.group(1), text)
        words = text.split()
        for k in (3, 2, 1):
            if len(words) <= k:
                continue
            cand = " ".join(words[:k]).rstrip(",:")
            m = self.match(cand)
            if m is None:
                continue
            full = _pnorm(m.get("name"))
            if _pnorm(cand) == full or (k == 1 and full.split(" ")[0] == _pnorm(cand)):
                return m, cand, " ".join(words[k:])
        return None, "", text


async def people_of(db: AsyncIOMotorDatabase, workspace_id: str) -> People:
    from app.services import workspace as ws_service

    return People(await ws_service.mention_people(db, workspace_id, viewer_id=None, emails=True))


# ── Markdown ──────────────────────────────────────────────────────────────────


def md_inline(text: str | None, *, keep_bold: bool = False) -> str:
    """Text as inline Markdown that renders as itself: punctuation that starts syntax escaped,
    braces (block options) neutralised, no line breaks."""
    t = re.sub(r"\s+", " ", (text or "").replace("\x00", "")).strip()
    t = t.replace("\\", "\\\\")
    t = re.sub(r":(?=[A-Za-z][\w-]*[\[{(])", r"\\:", t)
    t = re.sub(r"([`*_\[\]<>|~$#])", r"\\\1", t)
    t = t.replace("{", "(").replace("}", ")")
    if keep_bold:
        t = re.sub(r"\\\*\\\*(.+?)\\\*\\\*", r"**\1**", t)
    return t


def anchor(i: int) -> str:
    """The transcript paragraph of segment ``i`` (1-based)."""
    return f"b-t{i:04d}"


def _block_id() -> str:
    return "b-" + secrets.token_hex(4)


def seg_label(seg: dict) -> str:
    who = seg.get("speaker") or "Someone"
    t = seg.get("t")
    return f"{who}, {mp.clock(t)}" if t is not None else who


def cite_link(meeting: dict, i: int | None) -> str:
    """" [12:34](/<transcript>#b-t0012)" for segment i (1-based), or ""."""
    segs = meeting.get("segments") or []
    ts = meeting.get("transcript_slug")
    if not ts or not i or i < 1 or i > len(segs):
        return ""
    t = segs[i - 1].get("t")
    label = mp.clock(t) if t is not None else f"#{i}"
    return f" [{label}](/{ts}#{anchor(i)})"


def fmt_date(d: str | None) -> str:
    if not d:
        return ""
    try:
        x = date.fromisoformat(d)
    except ValueError:
        return d
    return f"{x.strftime('%b')} {x.day}, {x.year}"


def fmt_duration(s: int | None) -> str | None:
    if not s:
        return None
    m = max(1, round(s / 60))
    return f"{m // 60} h {m % 60} min" if m >= 60 else f"{m} min"


def guess_type(title: str | None) -> str:
    t = (title or "").casefold()
    for words, kind in (
        (("standup", "stand-up", "stand up", "daily", "scrum", "huddle"), "Standup"),
        (("1:1", "1-1", "one on one", "one-on-one", "1on1"), "1:1"),
        (("planning", "sprint", "roadmap", "kickoff", "kick-off"), "Planning"),
        (("review", "retro", "demo", "post-mortem", "postmortem"), "Review"),
        (("interview", "screen"), "Interview"),
        (("customer", "client", "sales", "onboarding call", "partner"), "Customer"),
    ):
        if any(w in t for w in words):
            return kind
    return "Other"


def transcript_markdown(segments: list[dict], *, approx: bool, limit: int | None = None) -> str:
    from app.config import get_settings

    limit = limit or get_settings().max_content_chars - 4000
    lines = []
    size = 0
    if approx:
        lines.append(":::note[Times]{icon=\"🕒\"}\nGoogle Meet marks the time every five minutes; the times "
                     "between the marks are estimated.\n:::\n")
    for i, s in enumerate(segments, 1):
        who = md_inline(s.get("speaker") or "")
        t = s.get("t")
        head = " · ".join(x for x in (mp.clock(t) if t is not None else "", who) if x)
        text = md_inline(s.get("text"))
        line = (f"**{head}** {text}" if head else text) + f" {{#{anchor(i)}}}"
        if size + len(line) + 2 > limit:
            lines.append(f":::note[The rest of the transcript]{{icon=\"✂️\"}}\nThe last {len(segments) - i + 1} lines "
                         "don't fit on one page. Ask this meeting still reads them.\n:::")
            break
        size += len(line) + 2
        lines.append(line)
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _cite_index(c: Any) -> int | None:
    m = re.match(r"^\s*\[?s?(\d{1,5})\]?\s*$", str(c or ""))
    return int(m.group(1)) if m else None


def _mention(member: dict | None, name: str) -> str:
    if member is None:
        return f"**{md_inline(name)}**" if name else ""
    label = (member.get("name") or name).replace("[", "(").replace("]", ")").replace("\\", "")
    return f':person[{label}]{{id="{member["id"]}"}}'


def action_lines(meeting: dict, gen: dict | None, people: People) -> list[str]:
    """The checklist: Google's next steps first (its wording, the leading name as a mention when it
    is a member), then the AI's action items."""
    out: list[str] = []
    notes = meeting.get("notes") or {}
    for step in notes.get("next_steps") or []:
        member, written, rest = people.leading(step)
        if member is not None:
            line = f"{_mention(member, written)} {md_inline(rest, keep_bold=True)}"
        else:
            line = md_inline(step, keep_bold=True)
        out.append(f"- [ ] {line} {{#{_block_id()}}}")
    for item in (gen or {}).get("action_items") or []:
        text = md_inline(item.get("text"))
        if not text:
            continue
        who = (item.get("owner") or "").strip()
        member = people.match(who) if who else None
        lead = _mention(member, who)
        due = md_inline(item.get("due")) if item.get("due") else ""
        line = " ".join(x for x in (lead, text) if x)
        if due:
            line += f" · due {due}"
        line += cite_link(meeting, _cite_index(item.get("cite")))
        out.append(f"- [ ] {line} {{#{_block_id()}}}")
    return out


def page_markdown(meeting: dict, gen: dict | None, people: People) -> str:
    """The meeting page's body (no front matter). ``gen``: the AI's sections (None: not yet / none)."""
    ai = meeting.get("ai") or {}
    state = ai.get("state")
    notes = meeting.get("notes")
    parts: list[str] = []
    if notes and notes.get("summary"):
        body = "\n\n".join(md_inline(p, keep_bold=True) for p in notes["summary"].split("\n\n") if p.strip())
        parts.append(f':::note[Summary · From Google Meet notes]{{icon="📝"}}\n{body}\n:::')
    elif gen and (gen.get("summary") or gen.get("highlights")):
        body = md_inline(gen.get("summary"))
        hl = [f"- {md_inline(h)}" for h in (gen.get("highlights") or [])[:6] if str(h).strip()]
        parts.append(':::note[Summary]{icon="✨"}\n' + body + ("\n\n" + "\n".join(hl) if hl else "") + "\n:::")
    elif state == "pending":
        parts.append(':::note[Summarizing…]{icon="⏳"}\nMarkdrop AI is writing the summary, decisions and '
                     'action items. This page fills in by itself in a moment.\n:::')
    elif not notes:
        why = ai.get("message") or "AI didn't write a summary for this meeting."
        parts.append(f':::warning[No AI summary]\n{md_inline(why)} Open the meeting panel (Meeting, at the '
                     'bottom right) to try again.\n:::')
    sections_ready = gen is not None or state not in ("pending",)

    def bullets(items: list, *, key: str = "text") -> list[str]:
        out = []
        for it in items or []:
            if isinstance(it, str):
                it = {key: it}
            text = md_inline(it.get(key))
            if text:
                out.append(f"- {text}{cite_link(meeting, _cite_index(it.get('cite')))}")
        return out

    if gen is not None:
        dec = bullets(gen.get("decisions"))
        parts.append("## Decisions\n\n" + ("\n".join(dec) if dec else "_No decisions were made._"))
    acts = action_lines(meeting, gen, people)
    if acts or sections_ready:
        parts.append("## Action items\n\n" + ("\n".join(acts) if acts else "_No action items._"))
    if gen is not None:
        oq = bullets(gen.get("open_questions"))
        parts.append("## Open questions\n\n" + ("\n".join(oq) if oq else "_None._"))
        tops = []
        for tp in gen.get("topics") or []:
            title = md_inline(tp.get("title") if isinstance(tp, dict) else tp)
            if not title:
                continue
            gist = md_inline(tp.get("gist")) if isinstance(tp, dict) and tp.get("gist") else ""
            link = cite_link(meeting, _cite_index(tp.get("cite") if isinstance(tp, dict) else None))
            tops.append(f"- **{title}**" + (f" — {gist}" if gist else "") + link)
        if tops:
            parts.append("## Topics\n\n" + "\n".join(tops))
    if notes and notes.get("details"):
        det = "\n".join(f"- {md_inline(d, keep_bold=True)}" for d in notes["details"] if d.strip())
        parts.append("## Details\n\n_From Google Meet notes._\n\n" + det)
    src = ["## Sources"]
    if meeting.get("transcript_slug"):
        src.append(f'::page{{src="{meeting["transcript_slug"]}"}}')
    links = []
    for s in meeting.get("sources") or []:
        what = {"notes": "Google Meet notes", "both": "Google Meet notes and transcript"}.get(s.get("kind"), "Transcript")
        name = md_inline(s.get("name") or what)
        if s.get("url"):
            links.append(f"- {what}: [{name}]({s['url']})")
        else:
            how = {"paste": "pasted", "upload": "uploaded"}.get(s.get("origin"), "imported")
            links.append(f"- {what} ({how}): {name}")
    if links:
        src.append("\n".join(links))
    parts.append("\n\n".join(src))
    return "\n\n".join(parts).rstrip() + "\n"


async def props_values(db: AsyncIOMotorDatabase, meeting: dict, folder: dict | None, people: People) -> dict:
    """The folder's typed values for the meeting page (only keys the folder still has)."""
    from app.services import page_db

    schema = {p["key"]: p for p in ((folder or {}).get("properties") or [])}
    names = ", ".join(a["name"] for a in meeting.get("attendees") or [])[:page_db.TEXT_MAX]
    org = meeting.get("created_by") if any(m["id"] == meeting.get("created_by") for m in people.members) else None
    want = {"date": meeting.get("date"), "type": meeting.get("type"), "attendees": names or None,
            "organizer": org, "duration": fmt_duration(meeting.get("duration_s")),
            "action_items": meeting.get("action_items")}
    out = {}
    members = {m["id"] for m in people.members}
    for k, v in want.items():
        p = schema.get(k)
        if p is None or v is None:
            continue
        try:
            out[k] = page_db.check_value(p, v, members=members)
        except page_db.PropsError:
            continue
    return out


async def full_markdown(db: AsyncIOMotorDatabase, meeting: dict, gen: dict | None, people: People) -> str:
    from app.services import page_db, page_props

    folder = await db["folders"].find_one({"_id": oid(meeting.get("folder_id"))}) if meeting.get("folder_id") else None
    body = page_markdown(meeting, gen, people)
    md = page_props.apply(body, {"icon": PAGE_ICON})
    vals = await props_values(db, meeting, folder, people)
    return page_db.write_values(md, vals) if vals else md


# ── The Meetings folder ───────────────────────────────────────────────────────


async def ensure_folder(db: AsyncIOMotorDatabase, workspace_id: str, user_id: str) -> dict:
    """The workspace's Meetings folder (made, with its properties, on the first import)."""
    from app.services import folder as folder_service
    from app.services import page_db

    f = await db["folders"].find_one({"workspace_id": workspace_id, "meetings": True}, sort=[("created_at", 1)])
    if f is None:
        made = await folder_service.create_folder(db, workspace_id, FOLDER_NAME, None)
        await db["folders"].update_one({"_id": ObjectId(made.id)}, {"$set": {"meetings": True}})
        first = await db["folders"].find_one({"workspace_id": workspace_id, "meetings": True}, sort=[("created_at", 1), ("_id", 1)])
        if first is not None and str(first["_id"]) != made.id:
            # Another import made one at the same moment: keep the first, drop ours (it is empty).
            await db["folders"].delete_one({"_id": ObjectId(made.id)})
        f = first
    if not f.get("properties"):
        try:
            await page_db.set_schema(db, workspace_id, str(f["_id"]), user_id, SCHEMA)
        except HTTPException as exc:
            log.info("meetings: folder properties not set (%s)", exc.detail)
        f = await db["folders"].find_one({"_id": f["_id"]})
    return f


async def folder_of(db: AsyncIOMotorDatabase, workspace_id: str) -> dict | None:
    return await db["folders"].find_one({"workspace_id": workspace_id, "meetings": True}, sort=[("created_at", 1)])


# ── Import ────────────────────────────────────────────────────────────────────


@dataclass
class Incoming:
    name: str
    text: str
    origin: str = "paste"            # paste | upload | google | mcp
    file_id: str | None = None
    url: str | None = None


def incoming_from(item: dict, origin: str) -> Incoming:
    """One request source ({name, text} or {name, data_b64}) → text. ValueError with a message."""
    if item.get("origin") in ("paste", "upload"):
        origin = item["origin"]
    name = str(item.get("name") or "").strip()[:200] or ("Pasted text" if origin == "paste" else "Meeting")
    if item.get("data_b64"):
        try:
            data = base64.b64decode(item["data_b64"], validate=False)
        except Exception as exc:
            raise ValueError(f"{name}: the file couldn't be read.") from exc
        if len(data) > MAX_SOURCE_BYTES:
            raise ValueError(f"{name} is bigger than {MAX_SOURCE_BYTES // 1_000_000} MB.")
        low = name.lower()
        if "." in low and not low.endswith(mp.ACCEPTED):
            raise ValueError(f"{name}: Markdrop reads .txt, .vtt, .srt, .sbv, .docx and .md files.")
        text = mp.decode_upload(name, data)
        return Incoming(name=name, text=text, origin="upload" if origin == "paste" else origin)
    text = str(item.get("text") or "")
    if len(text) > MAX_PASTE_CHARS:
        raise ValueError(f"{name} is longer than {MAX_PASTE_CHARS:,} characters.")
    return Incoming(name=name, text=text, origin=origin)


async def require_member(db: AsyncIOMotorDatabase, workspace_id: str, user_id: str, *, write: bool = True) -> str:
    """The caller's role in the workspace (404 when not a member; 403 for a viewer importing)."""
    from app.models.workspace import role_allows
    from app.services import workspace as ws_service

    role = await ws_service.role_for(db, workspace_id, user_id)
    if role is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    if write and not role_allows(role, "member"):
        raise HTTPException(status_code=403, detail="Viewers can't import meetings. Ask an admin to make you a member.")
    return role


def preview(incoming: list[Incoming]) -> list[dict]:
    return mp.summary_of([mp.parse_source(i.name, i.text) for i in incoming])


async def import_meetings(db: AsyncIOMotorDatabase, user, workspace_id: str, incoming: list[Incoming], *,
                          title: str | None = None, date_: str | None = None, type_: str | None = None,
                          restricted: bool = False, wait: bool = False, via: str = "web",
                          dedupe: str | None = None, notify: bool = True) -> list[dict]:
    """Make a meeting per group of sources (notes + transcript of one call pair up). Returns the rows,
    each with ``_status``: "imported" (new), "attached" (it filled the other half of a meeting that was
    already here) or "duplicate" (already here; nothing changed).

    ``dedupe``: None (always new meetings), "file" (a Google Doc already imported into this workspace
    is that meeting), "all" (also a meeting with the same name, date and start time: see
    :func:`find_existing`).

    ``notify=False``: history (a past meeting brought in by a backfill). Its @mentions stay links and
    nobody is notified, now or when its AI sections are written; the meeting is marked ``history``."""
    from app.services import notifications

    if not notify:
        with notifications.quiet():
            return await _import_meetings(db, user, workspace_id, incoming, title=title, date_=date_, type_=type_,
                                          restricted=restricted, wait=wait, via=via, dedupe=dedupe, history=True)
    return await _import_meetings(db, user, workspace_id, incoming, title=title, date_=date_, type_=type_,
                                  restricted=restricted, wait=wait, via=via, dedupe=dedupe, history=False)


async def _import_meetings(db: AsyncIOMotorDatabase, user, workspace_id: str, incoming: list[Incoming], *,
                           title: str | None, date_: str | None, type_: str | None, restricted: bool, wait: bool,
                           via: str, dedupe: str | None, history: bool) -> list[dict]:
    from app.services import workspace as ws_service

    await require_member(db, workspace_id, user.id)
    await ws_service.assert_open(db, workspace_id)
    if not incoming:
        raise HTTPException(status_code=422, detail="Add a transcript or Google's meeting notes.")
    if len(incoming) > MAX_SOURCES:
        raise HTTPException(status_code=422, detail=f"Import at most {MAX_SOURCES} files at once.")
    sources = []
    for inc in incoming:
        if not inc.text.strip():
            raise HTTPException(status_code=422, detail=f"{inc.name} is empty.")
        s = mp.parse_source(inc.name, inc.text)
        s._incoming = inc  # type: ignore[attr-defined]
        if not s.segments and not s.notes:
            raise HTTPException(status_code=422, detail=f"{inc.name}: no transcript or meeting notes found in it.")
        sources.append(s)
    groups = mp.pair(sources)
    if type_ is not None and type_ not in TYPES:
        raise HTTPException(status_code=422, detail=f"Type is one of {', '.join(TYPES)}.")
    if date_:
        try:
            date.fromisoformat(date_)
        except ValueError:
            raise HTTPException(status_code=422, detail="Date is written YYYY-MM-DD.")
    rows: list[dict] = []
    if dedupe:
        fresh = []
        for s in sources:
            fid = s._incoming.file_id  # type: ignore[attr-defined]
            hit = await db[COLL].find_one({"workspace_id": workspace_id, "sources.file_id": fid}) if fid else None
            if hit is not None:
                hit["_status"] = "duplicate"
                rows.append(hit)
            else:
                fresh.append(s)
        if not fresh:
            return rows
        groups = mp.pair(fresh)
    folder = await ensure_folder(db, workspace_id, user.id)
    people = await people_of(db, workspace_id)
    for g in groups:
        one = len(groups) == 1
        if dedupe == "all":
            m = mp.merge(g)
            have = ({"transcript"} if m.segments else set()) | ({"notes"} if m.notes else set())
            action, hit = await find_existing(db, workspace_id, title=(title if one else None) or m.title,
                                              date_=(date_ if one else None) or m.date, time_=m.time, kinds=have)
            if action == "duplicate":
                hit["_status"] = "duplicate"
                rows.append(hit)
                continue
            if action == "attach":
                row = await attach_sources(db, user, hit, g, wait=wait)
                row["_status"] = "attached"
                rows.append(row)
                continue
        row = await _create(db, user, workspace_id, folder, people, g,
                            title=title if one else None, date_=date_ if one else None,
                            type_=type_, restricted=restricted, wait=wait, via=via, history=history)
        row["_status"] = "imported"
        rows.append(row)
    return rows


# ── One call, several imports (the Google Meet script, MCP) ───────────────────

PAIR_TIME_SLACK_MIN = 45


def _minutes(t: str | None) -> int | None:
    m = re.match(r"^(\d{1,2}):(\d{2})$", t or "")
    return int(m.group(1)) * 60 + int(m.group(2)) if m else None


def kinds_of(row: dict) -> set[str]:
    return ({"transcript"} if row.get("segments") else set()) | ({"notes"} if row.get("notes") else set())


def same_call(row: dict, title: str | None, date_: str | None, time_: str | None) -> bool:
    """Is ``row`` the meeting that a source named ``title`` on ``date_`` at ``time_`` belongs to? The
    same name (Google's suffixes and dates aside; one may be the start of the other), the same day,
    and start times (when both are known) within 45 minutes: a daily "Standup" is another meeting
    every day, and two calls of one name on one day are told apart by their times."""
    rk, sk = mp.title_key(row.get("title")), mp.title_key(title)
    if not rk or not sk or not (rk == sk or rk.startswith(sk) or sk.startswith(rk)):
        return False
    if not date_ or row.get("date") != date_:
        return False
    a, b = _minutes(row.get("time")), _minutes(time_)
    return a is None or b is None or abs(a - b) <= PAIR_TIME_SLACK_MIN


async def find_existing(db: AsyncIOMotorDatabase, workspace_id: str, *, title: str | None, date_: str | None,
                        time_: str | None, kinds: set[str]) -> tuple[str, dict | None]:
    """("duplicate", row) when the workspace already has this call with everything the source has,
    ("attach", row) when it has the call but not this half (Google's notes, or the transcript),
    ("new", None) otherwise. Needs a date: undated text is never matched by name alone."""
    if not date_ or not kinds:
        return "new", None
    proj = {"segments": {"$slice": 1}, "title": 1, "date": 1, "time": 1, "notes": 1, "workspace_id": 1,
            "doc_id": 1, "created_at": 1}
    cursor = db[COLL].find({"workspace_id": workspace_id, "date": date_}, proj).sort("created_at", -1).limit(50)
    async for row in cursor:
        if not same_call(row, title, date_, time_):
            continue
        if kinds <= kinds_of(row):
            return "duplicate", row
        return "attach", await db[COLL].find_one({"_id": row["_id"]})
    return "new", None


async def attach_sources(db: AsyncIOMotorDatabase, user, row: dict, group: list[mp.Source], *,
                         wait: bool = False) -> dict:
    """The other half of a call into its meeting: the transcript (segments and the Transcript
    sub-page) or Google's notes, whichever the meeting doesn't have yet; attendees and sources merged.
    The page is written again when nobody edited it since (else the new parts are added at the end),
    and the AI sections are written again once a summary still being written has finished. A
    ``history`` meeting stays quiet (no notifications)."""
    from app.services import notifications

    if row.get("history") and not notifications.is_quiet():
        with notifications.quiet():
            return await _attach_sources(db, user, row, group, wait=wait)
    return await _attach_sources(db, user, row, group, wait=wait)


async def _attach_sources(db: AsyncIOMotorDatabase, user, row: dict, group: list[mp.Source], *,
                          wait: bool = False) -> dict:
    from app.services import meetings_ai, pages

    page = await page_of(db, row)
    if page is None:
        raise HTTPException(status_code=404, detail="Meeting not found")
    actor, ctx = access.Actor.of(user), access.Ctx(db)
    await access.require(actor, page, "edit_content", ctx)
    people = await people_of(db, row["workspace_id"])
    sets: dict[str, Any] = {}
    added_transcript = added_notes = False
    attendees = list(row.get("attendees") or [])
    sources = list(row.get("sources") or [])
    for s in group:
        inc: Incoming = s._incoming  # type: ignore[attr-defined]
        if s.segments and not row.get("segments") and not sets.get("segments"):
            traw = await _make_transcript(db, user, row, page, s.segments, s.approx_times)
            sets.update(segments=s.segments, approx_times=s.approx_times, transcript_doc_id=traw["_id"],
                        transcript_slug=traw["slug"])
            if not row.get("duration_s") and s.duration_s:
                sets["duration_s"] = s.duration_s
            added_transcript = True
        if s.notes and not row.get("notes") and not sets.get("notes"):
            sets["notes"] = s.notes
            sets["action_items"] = int(row.get("action_items") or 0) + len(s.notes.get("next_steps") or [])
            added_notes = True
        if s.time and not row.get("time"):
            sets["time"] = s.time
        if s.truncated:
            sets["truncated"] = True
        for a in s.attendees:
            if any(x["name"].casefold() == a["name"].casefold() for x in attendees):
                continue
            mem = people.match(a["name"], a.get("email"))
            attendees.append({"name": a["name"], "user_id": mem["id"] if mem else None})
        sources.append({"kind": s.kind, "origin": inc.origin, "name": inc.name, "file_id": inc.file_id,
                        "url": inc.url, "format": s.format})
    sets.update(attendees=attendees[:100], sources=sources, updated_at=now_utc())
    await db[COLL].update_one({"_id": row["_id"]}, {"$set": sets})
    row = await db[COLL].find_one({"_id": row["_id"]})
    busy = (row.get("ai") or {}).get("state") == "pending" and ai_view(row)["state"] == "pending"
    reason = await meetings_ai.generate_reason(db, user.id, row["workspace_id"])
    if not busy:
        # Show the new half now (the AI sections, if any, are written again below).
        page = await page_of(db, row) or page
        if int(page.get("rev") or 1) == int(row.get("base_rev") or 0):
            try:
                after = await _save(db, page, await full_markdown(db, row, row.get("generated"), people), actor, ctx,
                                    base_rev=int(page.get("rev") or 1))
                if after is not None:
                    await db[COLL].update_one({"_id": row["_id"]}, {"$set": {"base_rev": int(after.get("rev") or 1)}})
            except HTTPException as exc:
                log.info("meetings: %s not rewritten after an attach (%s)", page.get("slug"), exc.detail)
        elif reason:
            # Edited since, and no AI pass to add things: put the new half at the end.
            block = _added_block(row, added_notes=added_notes, added_transcript=added_transcript)
            if block:
                cur = page.get("content") or ""
                try:
                    await pages.check_page_lock(page, actor, ctx, pages.appended(cur, block))
                    await _save(db, page, pages.appended(cur, block), actor, ctx)
                except HTTPException as exc:
                    log.info("meetings: couldn't add to %s (%s)", page.get("slug"), exc.detail)
    if not reason:
        if wait:
            await _when_free(db, row["_id"])
            await meetings_ai.generate(db, str(row["_id"]), user)
        else:
            spawn(_regenerate_when_free(db, str(row["_id"]), user))
    return await db[COLL].find_one({"_id": row["_id"]})


def _added_block(row: dict, *, added_notes: bool, added_transcript: bool) -> str:
    parts = []
    notes = row.get("notes") or {}
    if added_notes and notes.get("summary"):
        body = "\n\n".join(md_inline(p, keep_bold=True) for p in notes["summary"].split("\n\n") if p.strip())
        parts.append(f':::note[Summary · From Google Meet notes]{{icon="📝"}}\n{body}\n:::')
    if added_notes and notes.get("details"):
        parts.append("## Details\n\n_From Google Meet notes._\n\n" +
                     "\n".join(f"- {md_inline(d, keep_bold=True)}" for d in notes["details"] if d.strip()))
    if added_transcript and row.get("transcript_slug"):
        parts.append(f'## Transcript\n\n::page{{src="{row["transcript_slug"]}"}}')
    return "\n\n".join(parts) + "\n" if parts else ""


async def _when_free(db: AsyncIOMotorDatabase, row_id: Any, *, timeout_s: float = 300, every_s: float = 1.0) -> None:
    """Waits (up to ``timeout_s``) while the meeting's summary is still being written."""
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout_s
    while loop.time() < end:
        row = await db[COLL].find_one({"_id": row_id}, {"ai": 1, "updated_at": 1, "created_at": 1})
        if row is None or ai_view(row)["state"] != "pending":
            return
        await asyncio.sleep(every_s)


async def _regenerate_when_free(db: AsyncIOMotorDatabase, meeting_id: str, user) -> None:
    from app.services import meetings_ai

    await _when_free(db, ObjectId(meeting_id))
    await meetings_ai.generate(db, meeting_id, user)


async def _create(db: AsyncIOMotorDatabase, user, workspace_id: str, folder: dict, people: People,
                  group: list[mp.Source], *, title: str | None, date_: str | None, type_: str | None,
                  restricted: bool, wait: bool, via: str, history: bool = False) -> dict:
    from app.schemas.document import DocumentUpdate
    from app.services import document as doc_service
    from app.services import meetings_ai, page_covers, pages

    m = mp.merge(group)
    name = " ".join((title or m.title or "Meeting").split())[:150]
    d = date_ or m.date or now_utc().date().isoformat()
    attendees = []
    for a in m.attendees:
        mem = people.match(a["name"], a.get("email"))
        attendees.append({"name": mem["name"] if mem and not a["name"] else a["name"],
                          "user_id": mem["id"] if mem else None})
    sources = []
    for s in group:
        inc: Incoming = s._incoming  # type: ignore[attr-defined]
        sources.append({"kind": s.kind, "origin": inc.origin, "name": inc.name, "file_id": inc.file_id,
                        "url": inc.url, "format": s.format})
    now = now_utc()
    row = {
        "workspace_id": workspace_id, "folder_id": str(folder["_id"]), "doc_id": None, "transcript_doc_id": None,
        "created_by": user.id, "created_at": now, "updated_at": now, "title": name, "date": d, "time": m.time,
        "duration_s": m.duration_s, "type": type_ or guess_type(name), "attendees": attendees,
        "restricted": False, "granted": [], "sources": sources, "segments": m.segments, "notes": m.notes,
        "approx_times": m.approx_times, "truncated": m.truncated,
        "ai": {"state": "pending"}, "action_items": len((m.notes or {}).get("next_steps") or []), "via": via,
    }
    if history:
        row["history"] = True
    res = await db[COLL].insert_one(row)
    row["_id"] = res.inserted_id
    actor, ctx = access.Actor.of(user), access.Ctx(db)
    display = f"{name} · {fmt_date(d)}"[:200]
    try:
        raw, _secret, _err = await pages.create_page(db, user, actor, ctx, title=display, workspace=workspace_id,
                                                     folder=str(folder["_id"]), content="\n")
    except HTTPException:
        await db[COLL].delete_one({"_id": row["_id"]})
        raise
    await page_covers.opt_out(db, raw)
    raw = await db["documents"].find_one({"_id": raw["_id"]}) or raw
    if (raw.get("access_level") or "link") != "workspace":
        raw = await access.set_level(db, raw, "workspace", actor, ctx)
    # After the level change (transitions writes the row it read): the page is this meeting's.
    await db["documents"].update_one({"_id": raw["_id"]}, {"$set": {"meeting_id": str(row["_id"]), "meeting_role": "page"}})
    row["doc_id"] = raw["_id"]
    row["slug"] = raw["slug"]
    if m.segments:
        traw = await _make_transcript(db, user, row, raw, m.segments, m.approx_times)
        row["transcript_doc_id"] = traw["_id"]
        row["transcript_slug"] = traw["slug"]
    reason = await meetings_ai.generate_reason(db, user.id, workspace_id)
    if reason:
        row["ai"] = {"state": "skipped", "reason": reason, "message": meetings_ai.message(reason)}
    await db[COLL].update_one({"_id": row["_id"]}, {"$set": {
        "doc_id": row["doc_id"], "slug": row["slug"], "transcript_doc_id": row["transcript_doc_id"],
        "transcript_slug": row.get("transcript_slug"), "ai": row["ai"]}})
    fresh = await db["documents"].find_one({"_id": raw["_id"]})
    after = await _save(db, fresh, await full_markdown(db, row, None, people), actor, ctx)
    row["base_rev"] = int((after or fresh).get("rev") or 1)
    await db[COLL].update_one({"_id": row["_id"]}, {"$set": {"base_rev": row["base_rev"]}})
    if restricted:
        await set_restricted(db, row, True, actor, ctx)
        row = await db[COLL].find_one({"_id": row["_id"]})
    if not reason:
        if wait:
            await meetings_ai.generate(db, str(row["_id"]), user)
        else:
            spawn(meetings_ai.generate(db, str(row["_id"]), user))
    return await db[COLL].find_one({"_id": row["_id"]})


async def _make_transcript(db: AsyncIOMotorDatabase, user, row: dict, page: dict, segments: list[dict],
                           approx: bool) -> dict:
    """The Transcript sub-page under the meeting page."""
    from app.services import page_covers, page_props, pages

    actor, ctx = access.Actor.of(user), access.Ctx(db)
    traw, _s, _e = await pages.create_page(
        db, user, actor, ctx, title="Transcript", parent=page["slug"],
        content=transcript_markdown(segments, approx=approx))
    await db["documents"].update_one({"_id": traw["_id"]}, {"$set": {"meeting_id": str(row["_id"]),
                                                                     "meeting_role": "transcript"}})
    await page_covers.opt_out(db, traw)
    await _save(db, traw, page_props.apply(traw.get("content") or "", {"icon": TRANSCRIPT_ICON}), actor, ctx)
    return traw


def spawn(coro) -> None:
    task = asyncio.create_task(coro)
    _bg.add(task)
    task.add_done_callback(_bg.discard)


async def _save(db: AsyncIOMotorDatabase, raw: dict, content: str, actor, ctx, *, base_rev: int | None = None) -> dict | None:
    """Through the website's save path: the edit lock, revisions, search, mention notifications."""
    from app.schemas.document import DocumentUpdate
    from app.services import document as doc_service

    data = DocumentUpdate(title=raw.get("title"), content=content or "\n", base_rev=base_rev)
    return await doc_service.update_document(db, raw["slug"], data, actor, ctx)


async def write_generated(db: AsyncIOMotorDatabase, meeting: dict, gen: dict | None, user) -> None:
    """The AI's sections into the meeting page: the whole page when nobody changed it since import,
    else the new sections appended at the end (never over someone's edits). A ``history`` meeting's
    mentions notify nobody."""
    from app.services import notifications

    from app.services import meeting_memory

    try:
        if meeting.get("history") and not notifications.is_quiet():
            with notifications.quiet():
                return await _write_generated(db, meeting, gen, user)
        return await _write_generated(db, meeting, gen, user)
    finally:
        # Meeting memory (services/meeting_memory.py): the summary's decisions, action items… as facts.
        await meeting_memory.sync_quietly(db, meeting.get("_id"))


async def _write_generated(db: AsyncIOMotorDatabase, meeting: dict, gen: dict | None, user) -> None:
    from app.services import pages

    raw = await db["documents"].find_one({"_id": oid(meeting.get("doc_id"))})
    if raw is None:
        return
    people = await people_of(db, meeting["workspace_id"])
    actor, ctx = access.Actor.of(user), access.Ctx(db)
    if not (await access.can(actor, raw, "edit_content", ctx)).allowed:
        return
    content = await full_markdown(db, meeting, gen, people)
    if int(raw.get("rev") or 1) == int(meeting.get("base_rev") or 0):
        try:
            after = await _save(db, raw, content, actor, ctx, base_rev=int(raw.get("rev") or 1))
            if after is not None:
                await db[COLL].update_one({"_id": meeting["_id"]}, {"$set": {"base_rev": int(after.get("rev") or 1)}})
            return
        except HTTPException as exc:
            if exc.status_code not in (409, 423):
                raise
            raw = await db["documents"].find_one({"_id": raw["_id"]}) or raw
    # Edited meanwhile (or someone is editing): add the sections below what's there.
    body = page_markdown(meeting, gen, people)
    keep = [p for p in body.split("\n\n## ") if not p.startswith("## Sources") and not p.startswith("Sources")]
    block = "\n\n## ".join(keep).rstrip() + "\n"
    cur = raw.get("content") or ""
    try:
        await pages.check_page_lock(raw, actor, ctx, pages.appended(cur, block))
        await _save(db, raw, pages.appended(cur, block), actor, ctx)
    except HTTPException as exc:
        log.info("meetings: couldn't add the AI sections to %s (%s)", raw.get("slug"), exc.detail)


# ── Reading ───────────────────────────────────────────────────────────────────


async def page_of(db: AsyncIOMotorDatabase, meeting: dict) -> dict | None:
    did = oid(meeting.get("doc_id"))
    return await db["documents"].find_one({"_id": did}) if did else None


async def readable(db: AsyncIOMotorDatabase, meeting: dict | None, actor: access.Actor, ctx: access.Ctx) -> dict | None:
    """The meeting page when the caller can read it now (the one rule for every meeting read)."""
    if not meeting:
        return None
    raw = await page_of(db, meeting)
    if raw is None:
        return None
    return raw if (await access.can(actor, raw, "read", ctx)).allowed else None


async def get_row(db: AsyncIOMotorDatabase, meeting_id: str) -> dict | None:
    m = oid(meeting_id)
    return await db[COLL].find_one({"_id": m}) if m else None


async def for_read(db: AsyncIOMotorDatabase, meeting_id: str, actor: access.Actor, ctx: access.Ctx) -> tuple[dict, dict]:
    """(row, page) or 404 — the same 404 whether it's missing or not readable."""
    row = await get_row(db, meeting_id)
    raw = await readable(db, row, actor, ctx)
    if row is None or raw is None:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return row, raw


async def is_ws_admin(db: AsyncIOMotorDatabase, workspace_id: str, user_id: str | None) -> bool:
    from app.models.workspace import role_allows
    from app.services import workspace as ws_service

    return bool(user_id) and role_allows(await ws_service.role_for(db, workspace_id, user_id), "admin")


def ai_view(row: dict) -> dict:
    ai = dict(row.get("ai") or {})
    state = ai.get("state") or "skipped"
    if state == "pending":
        ts = row.get("updated_at") or row.get("created_at")
        if ts is not None and (now_utc() - (ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc))) > PENDING_STALE:
            state = "failed"
            ai["message"] = "The summary didn't finish. Try again."
    return {"state": state, "reason": ai.get("reason"), "message": ai.get("message"),
            "cost_usd": round(float(ai.get("cost_usd") or 0), 6), "calls": ai.get("calls") or 0,
            "chunks": ai.get("chunks"), "at": iso(ai.get("at"))}


async def shape(db: AsyncIOMotorDatabase, row: dict, raw: dict, actor: access.Actor, ctx: access.Ctx, *,
                full: bool = False) -> dict:
    uid = actor.user_id
    can_manage = (await access.can(actor, raw, "change_access", ctx)).allowed
    owner = raw.get("owner_id") == uid
    can_delete = owner or await is_ws_admin(db, row["workspace_id"], uid)
    out = {
        "id": str(row["_id"]), "workspace_id": row["workspace_id"], "title": row.get("title"),
        "page_title": raw.get("title"), "slug": raw["slug"], "transcript_slug": row.get("transcript_slug"),
        "date": row.get("date"), "time": row.get("time"), "duration_s": row.get("duration_s"),
        "type": row.get("type"), "attendees": [{"name": a["name"], "user_id": a.get("user_id")} for a in row.get("attendees") or []],
        "restricted": bool(row.get("restricted")), "action_items": int(row.get("action_items") or 0),
        "segments": len(row.get("segments") or []), "has_notes": bool(row.get("notes")),
        "has_transcript": bool(row.get("segments")),
        "sources": [{k: s.get(k) for k in ("kind", "origin", "name", "url", "format")} for s in row.get("sources") or []],
        "ai": ai_view(row), "created_at": iso(row.get("created_at")), "created_by": row.get("created_by"),
        "can_manage": can_manage, "can_delete": can_delete, "can_regenerate": (await access.can(actor, raw, "edit_content", ctx)).allowed,
        "approx_times": bool(row.get("approx_times")),
        "source": source_of(row),
        "history": bool(row.get("history")),   # a past meeting from a backfill (imported quietly)
    }
    if full:
        from app.services import urls

        out["url"] = urls.markdrop_url(raw["slug"])
    return out


SOURCES = ("manual", "auto", "mcp")
_VIA = {"manual": {"$nin": ["inbox", "mcp"]}, "auto": "inbox", "mcp": "mcp"}


def source_of(row: dict) -> str:
    """How the meeting came in: "auto" (the Google Meet script), "mcp", or "manual" (the website)."""
    return {"inbox": "auto", "mcp": "mcp"}.get(row.get("via") or "", "manual")


async def list_meetings(db: AsyncIOMotorDatabase, workspace_id: str, actor: access.Actor, ctx: access.Ctx, *,
                        limit: int = 100, q: str | None = None, source: str | None = None,
                        since: str | None = None) -> dict:
    """The meetings of a workspace the caller can open, newest first. A workspace admin also sees
    restricted meetings they can't open, without their title (so they can delete them).

    ``source``: only those that came in that way (:data:`SOURCES`); ``since``: only meetings on or
    after that date (YYYY-MM-DD)."""
    await require_member(db, workspace_id, actor.user_id, write=False)
    admin = await is_ws_admin(db, workspace_id, actor.user_id)
    limit = max(1, min(limit, MAX_LIST))
    out, hidden = [], []
    query: dict[str, Any] = {"workspace_id": workspace_id}
    if source:
        if source not in SOURCES:
            raise HTTPException(status_code=422, detail=f"source is one of {', '.join(SOURCES)}.")
        query["via"] = _VIA[source]
    if since:
        try:
            date.fromisoformat(since)
        except ValueError:
            raise HTTPException(status_code=422, detail="since is a date, YYYY-MM-DD.")
        query["date"] = {"$gte": since}
    filtered = bool(q or source or since)
    cursor = db[COLL].find(query, {"segments": 0}).sort([("date", -1), ("created_at", -1)])
    async for row in cursor:
        raw = await page_of(db, row)
        if raw is None:
            continue
        if (await access.can(actor, raw, "read", ctx)).allowed:
            if q and q.casefold() not in (row.get("title") or "").casefold():
                continue
            out.append(await shape(db, row, raw, actor, ctx))
        elif admin and not filtered:
            hidden.append({"id": str(row["_id"]), "date": row.get("date"), "restricted": True, "redacted": True,
                           "can_delete": True})
        if len(out) >= limit:
            break
    folder = await folder_of(db, workspace_id)
    return {"meetings": out, "hidden": hidden[:50], "folder_id": str(folder["_id"]) if folder else None}


# ── Changes ───────────────────────────────────────────────────────────────────


async def set_restricted(db: AsyncIOMotorDatabase, row: dict, value: bool, actor: access.Actor, ctx: access.Ctx) -> dict:
    """Restrict to attendees (private + a grant per attendee who is a member) or back to the team."""
    from app.models.workspace import role_allows
    from app.services import workspace as ws_service

    raw = await page_of(db, row)
    if raw is None:
        raise HTTPException(status_code=404, detail="Meeting not found")
    await access.require(actor, raw, "change_access", ctx)
    if value:
        raw = await access.set_level(db, raw, "private", actor, ctx)
        granted: list[str] = list(row.get("granted") or [])
        ids = {a["user_id"] for a in row.get("attendees") or [] if a.get("user_id")}
        users = {str(u["_id"]): u for u in await db["users"].find(
            {"_id": {"$in": [ObjectId(i) for i in ids if ObjectId.is_valid(i)]}}, {"email": 1}).to_list(length=200)}
        for uid in ids:
            if uid == raw.get("owner_id") or uid not in users:
                continue
            role = await ws_service.role_for(db, row["workspace_id"], uid)
            if role is None:
                continue
            email = access.normalize_email(users[uid].get("email"))
            if not email or await access.grant_for(db, str(raw["_id"]), email) is not None:
                continue
            try:
                await access.add_grant(db, raw, email, "editor" if role_allows(role, "member") else "viewer", actor, ctx)
                granted.append(email)
            except HTTPException as exc:
                log.info("meetings: grant for an attendee refused (%s)", exc.detail)
        await db[COLL].update_one({"_id": row["_id"]}, {"$set": {"restricted": True, "granted": granted,
                                                                 "updated_at": now_utc()}})
    else:
        for email in row.get("granted") or []:
            try:
                await access.remove_grant(db, raw, email, actor, ctx)
            except HTTPException:
                pass
        await access.set_level(db, raw, "workspace", actor, ctx)
        await db[COLL].update_one({"_id": row["_id"]}, {"$set": {"restricted": False, "granted": [],
                                                                 "updated_at": now_utc()}})
    return await db[COLL].find_one({"_id": row["_id"]})


async def set_type(db: AsyncIOMotorDatabase, row: dict, raw: dict, value: str, actor: access.Actor, ctx: access.Ctx) -> dict:
    from app.services import page_db

    if value not in TYPES:
        raise HTTPException(status_code=422, detail=f"Type is one of {', '.join(TYPES)}.")
    await access.require(actor, raw, "edit_content", ctx)
    await db[COLL].update_one({"_id": row["_id"]}, {"$set": {"type": value, "updated_at": now_utc()}})
    folder = await db["folders"].find_one({"_id": oid(row.get("folder_id"))})
    if folder and any(p["key"] == "type" for p in folder.get("properties") or []):
        try:
            await page_db.set_values(db, raw, {"type": value}, actor, ctx)
        except Exception as exc:  # the page is being edited: the row still says it
            log.info("meetings: type not written to %s (%s)", raw.get("slug"), getattr(exc, "detail", exc))
    return await db[COLL].find_one({"_id": row["_id"]})


async def delete_meeting(db: AsyncIOMotorDatabase, row: dict, actor: access.Actor, ctx: access.Ctx) -> dict:
    """The page's owner, or a workspace admin/owner (any meeting, even one restricted from them):
    both pages to the Trash, the row (and its transcript) gone."""
    from app.services import pages, trash

    raw = await page_of(db, row)
    uid = actor.user_id
    admin = await is_ws_admin(db, row["workspace_id"], uid)
    if raw is not None:
        owner = raw.get("owner_id") == uid
        if not owner and not admin:
            if (await access.can(actor, raw, "read", ctx)).allowed:
                raise HTTPException(status_code=403, detail="Only the person who imported this meeting or a "
                                                            "workspace admin can delete it.")
            raise HTTPException(status_code=404, detail="Meeting not found")
        below = await pages.descendants(db, raw)
        await trash.move(db, [*reversed(below), raw], raw, actor)
    elif not admin and row.get("created_by") != uid:
        raise HTTPException(status_code=404, detail="Meeting not found")
    await db[COLL].delete_one({"_id": row["_id"]})
    from app.services import meeting_memory

    await meeting_memory.drop_meeting(db, str(row["_id"]))
    return {"deleted": True, "id": str(row["_id"]), "trashed": raw is not None}


# ── For AI ────────────────────────────────────────────────────────────────────


def page_text(raw: dict) -> str:
    """The meeting page as the team has it now (edits included), without front matter."""
    from app.services import page_props

    _lines, body = page_props.split(raw.get("content") or "")
    return body.strip()
