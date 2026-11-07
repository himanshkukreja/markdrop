"""Meetings: every team call as a page in the workspace's Meetings folder (v1: import).

    POST /api/v1/meetings/import (routers/meetings.py)     MCP ``import_meeting`` (mcp/meeting_tools.py)

A meeting is a ``meetings`` row plus two pages:

* the **meeting page** (blocks editor) in the workspace's Meetings folder (``folders.meetings``,
  created on the first import with typed properties: Date, Type, Attendees, Organizer, Duration,
  Action items): a summary callout, Decisions, Action items (``:person`` mentions for assignees who
  are members), Open questions, Topics, Google's Details
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

**Quiet** (owner, 2026-11-06): Markdrop's meeting writer notifies nobody about the @mentions it
writes, on every path (Import meeting, a Drive link, the Google Meet script and its inbox, MCP
``import_meeting``, Import past meetings, the other half attached later, the AI sections written or
regenerated, Organize). Every one of its saves runs inside ``notifications.quiet()`` (:func:`_save`;
background tasks spawned inside inherit it). The mentions stay links, and action items still show on
Home. A person editing a meeting page by hand notifies as usual. A meeting held more than a day ago
is also ``history``: not posted to the Slack meetings channel on its own.

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
PENDING_STALE = timedelta(minutes=15)
PAGE_ICON = "🎙️"
TRANSCRIPT_ICON = "📜"

# Covers (owner, 2026-11-05): every meeting page gets one of the built-in gallery covers
# (services/page_covers.py), never an AI pick: one per series, the same for every meeting of it
# (a hash of the series' group key over SERIES_COVERS), and GENERIC_COVER for a one-off. The row's
# ``cover`` is the cover Markdrop chose; the page keeps it while nobody changed the cover by hand.
GENERIC_COVER = "circles"
SERIES_COVERS = ("orbit", "gather", "route", "horizon", "tide", "contour", "lanterns", "waypoints",
                 "dawn", "sage", "fold", "ascent")


def cover_for(series: str | None) -> str:
    """The gallery cover of a meeting in ``series`` (None: a one-off)."""
    import hashlib

    from app.services import meeting_backfill_detect as det

    key = det.group_key(series) if series else ""
    if not key:
        return GENERIC_COVER
    return SERIES_COVERS[int(hashlib.sha1(key.encode("utf-8")).hexdigest()[:8], 16) % len(SERIES_COVERS)]

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
    from app.services import meetings_list

    await meetings_list.ensure_indexes(db)


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
                hits = self.by_name.setdefault(_pnorm(local.replace(".", " ").replace("_", " ")), [])
                if not any(h is m for h in hits):   # priya.nair@… for Priya Nair: one member, not two
                    hits.append(m)

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
    who = people_section(meeting, people)
    if who:
        parts.append(who)
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
    names = attendees_text(meeting)
    # Who ran the meeting (never simply the importer): a member, else nobody (the name is on Details).
    oid_ = (meeting.get("organizer") or {}).get("user_id")
    org = oid_ if oid_ and any(m["id"] == oid_ for m in people.members) else None
    want = {"date": meeting.get("date"), "type": meeting.get("type"), "series": meeting.get("series"),
            "attendees": names or None,
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
    md = page_props.apply(body, {"icon": PAGE_ICON, **({"cover": page_props.gallery_cover(meeting["cover"])}
                                                       if meeting.get("cover") else {})})
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
    if not f.get("meetings_views"):
        from app.services import meeting_series

        f = await meeting_series.organise_folder(db, f, user_id)
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
    # The Drive file's owner ({name, email}) when Google said: who organized the call.
    owner: dict | None = None


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
                          restricted: bool | None = None, wait: bool = False, via: str = "web",
                          dedupe: str | None = None, notify: bool = True, series: str | None = None,
                          series_from: str | None = None) -> list[dict]:
    """Make a meeting per group of sources (notes + transcript of one call pair up). Returns the rows,
    each with ``_status``: "imported" (new), "attached" (it filled the other half of a meeting that was
    already here) or "duplicate" (already here; nothing changed).

    ``dedupe``: None (always new meetings), "file" (a Google Doc already imported into this workspace
    is that meeting), "all" (also a meeting with the same name, date and start time: see
    :func:`find_existing`).

    Nobody is notified about the @mentions of any meeting, however it comes in (**Quiet**, at the top).
    ``notify=False``: history (a past meeting brought in by a backfill): the meeting is marked
    ``history`` and isn't posted to the Slack meetings channel on its own.

    ``series``/``series_from``: the meeting's series as decided elsewhere (Import past meetings'
    review, services/meeting_backfill.py: "auto" detected, "user" set by the person, None for none);
    otherwise it is detected here (services/meeting_series.py). Each meeting is filed by
    ``meeting_place.place_meeting``'s rule: ``Meetings/<Series>`` or ``Meetings/Other meetings``.

    ``restricted``: True restricts to attendees, False leaves it to the team, None (the default)
    decides by the call: a 1:1 or two-person call is restricted, 3+ people the team (owner)."""
    from app.services import notifications

    kw = dict(title=title, date_=date_, type_=type_, restricted=restricted, wait=wait, via=via, dedupe=dedupe,
              series=series, series_from=series_from)
    # A meeting import notifies nobody, however it comes in: its @mentions stay links (**Quiet**, at the top).
    with notifications.quiet():
        return await _import_meetings(db, user, workspace_id, incoming, history=not notify, **kw)


async def _import_meetings(db: AsyncIOMotorDatabase, user, workspace_id: str, incoming: list[Incoming], *,
                           title: str | None, date_: str | None, type_: str | None, restricted: bool | None, wait: bool,
                           via: str, dedupe: str | None, history: bool, series: str | None = None,
                           series_from: str | None = None) -> list[dict]:
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
                            type_=type_, restricted=restricted, wait=wait, via=via, history=history,
                            series=series if one else None, series_from=series_from if one else None)
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
    and the AI sections are written again once a summary still being written has finished.
    Quiet, like every meeting write (**Quiet**, at the top)."""
    from app.services import notifications

    with notifications.quiet():
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
        sources.append({"kind": s.kind, "origin": inc.origin, "name": inc.name, "file_id": inc.file_id,
                        "url": inc.url, "format": s.format})
    if not row.get("organizer"):
        org = organizer_of(group, people)
        if org:
            sets["organizer"] = org
    sets.update(people_sets(row, group, people), sources=sources, updated_at=now_utc())
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


async def refresh_sources(db: AsyncIOMotorDatabase, user, row: dict, group: list[mp.Source], *,
                          wait: bool = False) -> dict:
    """A Google Doc this meeting came from, sent again with newer content (Gemini filled its notes in after
    the call, someone edited them, Meet added to the transcript): the meeting takes the new notes and the
    longer transcript (its Transcript page rewritten), then, like an attach, the page is written again
    when nobody edited it (else the new notes are added at the end) and the AI sections are written again.
    ``_status``: "updated", or "duplicate" when nothing it has changed. Quiet (**Quiet**, at the top)."""
    from app.services import notifications

    with notifications.quiet():
        return await _refresh_sources(db, user, row, group, wait=wait)


async def _refresh_sources(db: AsyncIOMotorDatabase, user, row: dict, group: list[mp.Source], *, wait: bool) -> dict:
    from app.services import page_props

    view = dict(row)
    fids = {getattr(s, "_incoming").file_id for s in group}
    changed = False
    for s in group:
        old = row.get("notes") or None
        if s.notes and s.notes != old:
            # _attach_sources fills what the meeting doesn't have: these notes replace the old ones.
            view["notes"] = None
            view["action_items"] = max(0, int(row.get("action_items") or 0) - len((old or {}).get("next_steps") or []))
            changed = True
        if s.segments and row.get("segments") and len(s.segments) > len(row["segments"]):
            sets: dict[str, Any] = {"segments": s.segments, "approx_times": s.approx_times}
            if s.duration_s and s.duration_s > int(row.get("duration_s") or 0):
                sets["duration_s"] = s.duration_s
            traw = await db["documents"].find_one({"_id": row.get("transcript_doc_id")}) if row.get("transcript_doc_id") else None
            if traw is not None:
                try:
                    await _save(db, traw, page_props.apply(transcript_markdown(s.segments, approx=s.approx_times),
                                                           {"icon": TRANSCRIPT_ICON}), access.Actor.of(user), access.Ctx(db))
                except HTTPException as exc:
                    log.info("meetings: transcript %s not rewritten (%s)", traw.get("slug"), exc.detail)
            await db[COLL].update_one({"_id": row["_id"]}, {"$set": sets})
            view.update(sets)
            changed = True
        elif s.segments and not row.get("segments"):
            changed = True   # the transcript arrived in the same Doc (a Transcript tab): attached below
    if not changed:
        row["_status"] = "duplicate"
        return row
    view["sources"] = [x for x in row.get("sources") or [] if x.get("file_id") not in fids]
    out = await _attach_sources(db, user, view, group, wait=wait)
    out["_status"] = "updated"
    return out


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


def organizer_of(group: list[mp.Source], people: People) -> dict | None:
    """Who organized the call: the Drive file's owner (the script, the Picker, a Drive link), else where
    the text says so ("Organizer: …"); a member when the name or address is one. None when unknown:
    never the person who imported it."""
    found, how = None, None
    for s in group:
        inc = getattr(s, "_incoming", None)
        own = getattr(inc, "owner", None) or None
        if own and (own.get("name") or own.get("email")):
            found, how = {"name": own.get("name"), "email": own.get("email")}, "drive"
            break
    if found is None:
        for s in group:
            hit = s.organizer
            if hit:
                found, how = hit, "content"
                break
    if found is None:
        return None
    mem = people.match(found.get("name"), found.get("email"))
    name = (mem or {}).get("name") or found.get("name") or (found.get("email") or "").split("@")[0] or None
    return {"name": name, "email": (found.get("email") or (mem or {}).get("email") or None),
            "user_id": mem["id"] if mem else None, "from": how}


SMALL_CALL = 2   # 1:1s and two-person calls are restricted to their attendees on import (owner, 2026-11-05)


def auto_restricts(attendees: list[dict], organizer: dict | None = None) -> bool:
    """A call with one or two known people (attendees and invitees, plus the organizer when not among them)."""
    names = {(a.get("name") or "").casefold() for a in attendees if a.get("name")}
    if organizer and organizer.get("name") and organizer["name"].casefold() not in names \
            and not any(organizer.get("user_id") and a.get("user_id") == organizer["user_id"] for a in attendees):
        names.add(organizer["name"].casefold())
    return 1 <= len(names) <= SMALL_CALL


# ── Who was there (attendees_v 2, owner 2026-11-06) ───────────────────────────
# attendees: who joined (a transcript's "Attendees" list and its speakers; else the speakers);
# invited: the calendar invite (Gemini notes' "Invited"), kept apart: not counted, never "attendees".
# attendees_v 3 (2026-11-06): Gemini's next steps ("Gautam Khurana Review Video: Gautam Khurana will …")
# are never speakers or attendees (meeting_parse.task_owner); repair_attendees fixes the old ones.
# attendees_v 4 (2026-11-06): a meeting with only Gemini's notes lists the people the notes name as its
# attendees ("notes", notes_attendees), not nobody.
# attendees_v 5 (2026-11-07): bracketed owners ("[Gautam] Post Video"), Gemini's placeholders, the lines
# v4 dropped read back from the trashed Transcript page, chip lines as the invite.
ATTENDEES_V = 5
ATTENDEES_V2 = 2   # attendees told apart from the invite (recompute_people)


def person_rows(found: list[dict], people: People, *, limit: int = 100) -> list[dict]:
    """People as a meeting row keeps them ({name, user_id, email}): names cleaned and read as names
    (meeting_parse.name_like), a member matched by the address first, each person once (by member,
    address or name)."""
    out: list[dict] = []
    for a in found or []:
        p = mp.person_of(a.get("name")) or ({"name": "", "email": a.get("email")} if a.get("email") else None)
        if p is None:
            continue
        email = (a.get("email") or p.get("email") or "").lower() or None
        uid = a.get("user_id")
        mem = None
        if not uid:
            mem = people.match(p["name"], email)
            uid = mem["id"] if mem else None
        name = p["name"] or (mem or {}).get("name") or ""
        if mem and mem.get("name") and mp.task_owner(name, None, [mem["name"]]):
            name = mem["name"]      # "Gautam Khurana Review Video" (a next step's label) is the member
        if not name or not (mp.name_like(name) or uid or email):
            continue
        if any((uid and x.get("user_id") == uid) or (email and x.get("email") == email)
               or x["name"].casefold() == name.casefold() for x in out):
            continue    # the same member under another name (the invite's "Priya Nair", the speaker "priya.nair")
        out.append({"name": name, "user_id": uid, "email": email})
        if len(out) >= limit:
            break
    return out


def notes_attendees(notes: dict | None, invited: list[dict], people: People,
                    universe: mp.Universe | None = None) -> list[dict]:
    """Who Gemini's notes show joined a call that has nothing better (no transcript, no Attendees line):
    the invited people the notes name (a next step's owner, a full name, a first name only one of them
    has: meeting_parse.named_in_notes); then anyone the workspace knows (``universe``: members, every
    invitee, the names Gemini's labels start with) who owns a next step ("Shreesha Joshi Audit Alerts:
    …", "Rehan Establish Structure: …") or whom the notes name by full name. As meeting rows, once each."""
    u = universe or mp.Universe([{"name": m.get("name"), "email": m.get("email"), "user_id": m["id"]}
                                 for m in people.members])
    notes = mp.clean_empty_notes(notes)
    found = list(mp.named_in_notes(notes, invited))
    for step in (notes or {}).get("next_steps") or []:
        head = str(step).partition(":")[0]
        owners = mp.bracket_owners(head, u)
        if owners:      # "[Mayuri Pillay, Rehan Islam] Prepare Presentation: …"
            found.extend(dict(u.get(o) or {"name": o}) for o in owners if u.get(o))
            continue
        hit, _extra = u.owner(head)
        if hit is None:
            owner = mp.owner_of_step(step, u.names())
            hit = u.get(owner) if owner else None
        if hit is not None:
            found.append(dict(hit))
    text = re.sub(r"\s+", " ", mp.notes_text(notes)).casefold()
    if text:
        for p in u.people:
            n = p["name"]
            if len(n.split()) >= 2 and re.search(r"(?<![\w])" + re.escape(n.casefold()) + r"(?![\w])", text):
                found.append(dict(p))
    return tidy_people(person_rows(found, people), u, people)


def with_notes_people(att: list[dict], inv: list[dict], how: str, notes: dict | None,
                      people: People, universe: mp.Universe | None = None) -> tuple[list[dict], str]:
    """(attendees, attendees_from): nobody known to have joined ("invited" / "none") and Gemini's notes
    there: the people they name ("notes")."""
    if how in ("invited", "none", "notes") and not (how != "notes" and att) and notes:
        got = notes_attendees(notes, inv, people, universe)
        if got:
            return got, "notes"
    return att, how


def tidy_people(entries: list[dict], universe: mp.Universe, people: People,
                labels: dict[str, str | None] | None = None, *, limit: int = 100) -> list[dict]:
    """Meeting people with no task words and no headings: "<Person> <task words>" is that person (with
    their address and account when known), a heading or a label that is no one goes, each once.
    Someone with an address is who the address says."""
    labels = {**{mp.clean_name(k): v for k, v in (labels or {}).items()}, **(labels or {})}
    out: list[dict] = []
    for a in entries:
        name = a.get("name") or ""
        if a.get("email") and name not in labels:
            out.append(a)       # an address (the invite) says who it is
            continue
        if len(name.split()) >= 4 and not a.get("email"):
            # People chips run together ("Himanshu Kukreja Arunprakaash G Jason Chad"): each of them.
            glued = mp._split_glued(name, universe.names())
            if glued and len(glued) >= 2 and all(universe.get(g["name"]) for g in glued):
                out.extend(dict(universe.get(g["name"])) for g in glued)
                continue
        shape = labels[name] if name in labels else mp.task_shaped(name, None, universe)
        if isinstance(shape, str):
            hit = universe.get(shape) or {"name": shape}
            out.append({"name": hit["name"], "user_id": hit.get("user_id") or a.get("user_id"),
                        "email": hit.get("email")})
        elif shape is False:
            hit = universe.get(name) or {}
            out.append({**a, "email": a.get("email") or hit.get("email"), "user_id": a.get("user_id") or hit.get("user_id")})
        elif name in labels or mp.topicish(name):
            continue
        elif a.get("user_id") or (len(name.split()) <= mp.TASK_MAX_WORDS and mp.name_like(name)):
            out.append(a)       # "anand.k", "Speaker 1": a transcript's own way of naming someone
    return person_rows(out, people, limit=limit)


async def people_universe(db: AsyncIOMotorDatabase, workspace_id: str, people: People) -> mp.Universe:
    """Everyone the workspace knows (prod dry run, 2026-11-06): its members; every invitee and attendee
    of its meetings with an address; the two-word names Gemini's labels keep starting with ("Shreesha
    Joshi" from "Shreesha Joshi Audit Alerts" and "Shreesha Joshi Escalate Security"); and a clean 2-3
    word name that is a whole speaker label in two or more meetings."""
    u = mp.Universe([{"name": m.get("name"), "email": m.get("email"), "user_id": m["id"]} for m in people.members])
    labels: list[str] = []
    whole: dict[str, set] = {}
    pipeline = [{"$match": {"workspace_id": workspace_id}},
                {"$project": {"invited": 1, "attendees": 1, "sp": "$segments.speaker", "steps": "$notes.next_steps"}}]
    async for r in db[COLL].aggregate(pipeline):
        for a in [*(r.get("invited") or []), *(r.get("attendees") or [])]:
            if a.get("email") and not mp.topicish(a.get("name")) and len(mp.clean_name(a.get("name")).split()) <= 4:
                u.add(a)
        mine = {mp.clean_name(x) for x in (r.get("sp") or []) if x}
        mine |= {mp.clean_name(str(x).partition(":")[0]) for x in (r.get("steps") or []) if ":" in str(x)}
        for lab in mine:
            if lab:
                labels.append(lab)
                whole.setdefault(lab.casefold(), set()).add(str(r["_id"]))
    for n in mp.mine_names(labels):
        hit, extra = u.owner(n)
        if hit is None or extra:
            u.add({"name": n})
    for lab in sorted({x for x in labels if len(whole.get(x.casefold(), ())) >= 2}):
        words = lab.split()
        if 2 <= len(words) <= 3 and mp._person_shape(words) and u.owner(lab)[0] is None:
            u.add({"name": lab})
    return u


def people_sets(row: dict, group: list[mp.Source], people: People) -> dict:
    """The row's attendees / invited / attendees_from once ``group`` (another half of the call, or a
    changed Doc sent again) is in, by the same rules as a new import (meeting_parse.people_of_group):
    everyone either side knows joined (an "Attendees" list, a speaker) is an attendee, every invite
    list goes to the invitees, and attendees_from is the better of the two."""
    if int(row.get("attendees_v") or 0) < ATTENDEES_V2:
        att, inv, how = recompute_people(row, people)
    else:
        att, inv, how = list(row.get("attendees") or []), list(row.get("invited") or []), row.get("attendees_from") or "none"
    n_att, n_inv, n_how = mp.people_of_group(group)
    rank = {"attendees": 3, "speakers": 2, "notes": 1.5, "invited": 1, "none": 0}
    # Named in the notes is the weakest evidence: who spoke or the Attendees line replaces it.
    if how == "notes" and rank.get(n_how, 0) > rank["notes"]:
        att = []
    elif n_how == "notes" and rank.get(how, 0) > rank["notes"]:
        n_att = []
    att = person_rows([*att, *n_att], people)
    inv = person_rows([*inv, *n_inv], people, limit=200)
    how = max((how, n_how), key=lambda h: rank.get(h, 0))
    if how in ("invited", "none") and att:
        how = "speakers"
    if how in ("invited", "none", "notes"):
        notes = row.get("notes") or next((s.notes for s in group if s.notes), None)
        att, how = with_notes_people([] if how != "notes" else att, inv, how, notes, people)
    # A meeting from before v3 keeps its place in the repair queue (repair_attendees fixes its next steps).
    v = ATTENDEES_V if int(row.get("attendees_v") or 0) >= ATTENDEES_V else ATTENDEES_V2
    return {"attendees": att, "invited": inv, "attendees_from": how, "attendees_v": v}


def _speakers_of(row: dict) -> list[str]:
    out: list[str] = []
    for seg in row.get("segments") or []:
        sp = mp.clean_name(seg.get("speaker"))
        if sp and not any(x.casefold() == sp.casefold() for x in out):
            out.append(sp)
    return out


def recompute_people(row: dict, people: People) -> tuple[list[dict], list[dict], str]:
    """(attendees, invited, attendees_from) of a meeting imported before attendees_v 2, from what it
    kept (the raw Docs aren't stored). Its ``attendees`` were the invite list (Gemini notes' "Invited"),
    an "Attendees" line and the speakers, all in one:

    * Gemini notes among its sources and a transcript: the speakers are who surely joined (each with
      the matching old entry's member and address); the old list is the invite.
    * Gemini notes only: nobody known to have joined; the old list is the invite.
    * no Gemini notes: the old list came from a transcript's "Attendees" line and its speakers: kept.

    Every list cleaned (names read as names: a paragraph taken for names goes)."""
    old = person_rows(row.get("attendees") or [], people)
    old_inv = list(row.get("invited") or [])
    gemini = any((s.get("format") == "gemini_notes") for s in row.get("sources") or [])
    if not gemini:
        speakers = {x.casefold() for x in _speakers_of(row)}
        how = "attendees" if any(a["name"].casefold() not in speakers for a in old) else "speakers" if old else "none"
        return old, person_rows(old_inv, people, limit=200), how
    found: list[dict] = []
    for sp in _speakers_of(row):
        hits = [a for a in old if mp._covers(sp, a["name"])]
        found.append(dict(hits[0]) if len(hits) == 1 else {"name": sp, "email": None})
    att = person_rows(found, people)
    inv = person_rows([*old_inv, *old], people, limit=200)
    return att, inv, "speakers" if att else "invited" if inv else "none"


def attendees_text(meeting: dict) -> str | None:
    """The page's Attendees property: the attendees' names, comma separated (never the invitees)."""
    from app.services import page_db

    names = [a["name"] for a in meeting.get("attendees") or [] if a.get("name")]
    return ", ".join(names)[:page_db.TEXT_MAX] or None


def people_section(meeting: dict, people: People) -> str:
    """The page's "Attendees" section: members as @mentions (quiet: meeting writes notify nobody),
    everyone else by name. With nobody known to have joined, the invite list as "Invited"."""
    att = meeting.get("attendees") or []
    head = "Attendees"
    if not att and meeting.get("invited"):
        att, head = meeting["invited"], "Invited"
    members = {m["id"]: m for m in people.members}
    names = []
    for a in att:
        mem = members.get(a.get("user_id") or "")
        names.append(_mention(mem, a["name"]) if mem else md_inline(a.get("name")))
    names = [n for n in names if n]
    if not names:
        return ""
    note = "\n\n_From the calendar invite: who joined isn't in Google's notes._" if head == "Invited" else \
        "\n\n_From Google's notes: the people they name. Everyone invited is in the meeting's Details._" \
        if meeting.get("attendees_from") == "notes" else ""
    return f"## {head}\n\n" + ", ".join(names) + note


async def _create(db: AsyncIOMotorDatabase, user, workspace_id: str, folder: dict, people: People,
                  group: list[mp.Source], *, title: str | None, date_: str | None, type_: str | None,
                  restricted: bool | None, wait: bool, via: str, history: bool = False, series: str | None = None,
                  series_from: str | None = None) -> dict:
    """A meeting held more than a day ago is history however it comes in (Import meeting by hand, a
    Drive link, the API), the same rule as the script's backfill and Import past meetings: it isn't
    posted to the Slack meetings channel on its own. Nobody is notified about any meeting's @mentions
    (**Quiet**, at the top)."""
    from app.services import notifications

    if not history:
        d = date_ or mp.merge(group).date
        history = bool(d and d < (now_utc().date() - timedelta(days=1)).isoformat())
    with notifications.quiet():
        return await _create_row(db, user, workspace_id, folder, people, group, title=title, date_=date_,
                                 type_=type_, restricted=restricted, wait=wait, via=via, history=history,
                                 series=series, series_from=series_from)


async def _create_row(db: AsyncIOMotorDatabase, user, workspace_id: str, folder: dict, people: People,
                      group: list[mp.Source], *, title: str | None, date_: str | None, type_: str | None,
                      restricted: bool | None, wait: bool, via: str, history: bool = False, series: str | None = None,
                      series_from: str | None = None) -> dict:
    from app.schemas.document import DocumentUpdate
    from app.services import document as doc_service
    from app.services import meeting_series, meetings_ai, page_covers, pages

    m = mp.merge(group)
    name = " ".join((title or m.title or "Meeting").split())[:150]
    d = date_ or m.date or now_utc().date().isoformat()
    # The series: as given (the bulk import's review), else detected from the workspace's meetings.
    if series_from in ("auto", "user"):
        sname, skey = meeting_series.clean_name(series), meeting_series.det.group_key(name)
    else:
        sname, skey = await meeting_series.detect(db, workspace_id, name, date_=d)
        series_from = "auto"
    attendees = person_rows(m.attendees, people)
    invited = person_rows(m.invited, people, limit=200)
    attendees_from = m.attendees_from
    # Against everyone the workspace knows: no task words, no headings, and who the notes name.
    known = row_universe({"invited": invited, "attendees": attendees, "segments": m.segments, "notes": m.notes}, people,
                         await people_universe(db, workspace_id, people))
    attendees = tidy_people(attendees, known, people)
    if attendees_from in ("invited", "none", "notes"):
        attendees, attendees_from = with_notes_people(attendees, invited, attendees_from, m.notes, people, known)
    sources = []
    for s in group:
        inc: Incoming = s._incoming  # type: ignore[attr-defined]
        sources.append({"kind": s.kind, "origin": inc.origin, "name": inc.name, "file_id": inc.file_id,
                        "url": inc.url, "format": s.format})
    organizer = organizer_of(group, people)
    # Not decided by the caller (None): 1:1s and two-person calls start restricted, 3+ the team's.
    small = restricted is None and auto_restricts(attendees + invited, organizer)
    if restricted is None:
        restricted = small
    now = now_utc()
    row = {
        "workspace_id": workspace_id, "folder_id": str(folder["_id"]), "doc_id": None, "transcript_doc_id": None,
        "created_by": user.id, "imported_by": user.id, "organizer": organizer, "auto_restricted": small,
        "created_at": now, "updated_at": now, "title": name, "date": d, "time": m.time,
        "duration_s": m.duration_s, "type": type_ or guess_type(name), "attendees": attendees,
        "invited": invited, "attendees_from": attendees_from, "attendees_v": ATTENDEES_V,
        "restricted": False, "granted": [], "sources": sources, "segments": m.segments, "notes": m.notes,
        "approx_times": m.approx_times, "truncated": m.truncated,
        "ai": {"state": "pending"}, "action_items": len((m.notes or {}).get("next_steps") or []), "via": via,
        "series": sname, "series_from": series_from, "series_key": skey, "v2": True, "names_v": NAMES_V,
    }
    if history:
        row["history"] = True
    # Where it goes (one function for every import path: services/meeting_place.py):
    # Meetings/<Series> or Meetings/Other meetings.
    from app.services import meeting_place

    row["folder_id"] = await meeting_place.place_meeting(db, workspace_id, row)
    folder = await db["folders"].find_one({"_id": oid(row["folder_id"])}) or folder
    if sname:
        row["series"] = sname = meeting_series.option_name(folder, sname) or sname
    if await page_covers.workspace_allows(db, workspace_id):
        row["cover"] = cover_for(sname)
    res = await db[COLL].insert_one(row)
    row["_id"] = res.inserted_id
    actor, ctx = access.Actor.of(user), access.Ctx(db)
    display = f"{name} · {fmt_date(d)}"[:200]
    try:
        raw, _secret, _err = await pages.create_page(db, user, actor, ctx, title=display, workspace=workspace_id,
                                                     folder=row["folder_id"], content="\n")
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
    if sname and series_from == "auto":
        # The earlier one-off of this name is the same series now.
        await meeting_series.adopt(db, user, workspace_id, skey, sname, skip_id=row["_id"])
    if not reason:
        if wait:
            await meetings_ai.generate(db, str(row["_id"]), user)
        else:
            spawn(meetings_ai.generate(db, str(row["_id"]), user))
    elif (m.notes or {}).get("summary"):
        # No AI (off, not set up, over its limit): Google's notes are the summary, so the meeting is
        # ready now — the Slack channel post and each person's action items (as meetings_ai does).
        await meetings_ai._slack_ready(db, row)
    return await db[COLL].find_one({"_id": row["_id"]})


async def refresh_cover(db: AsyncIOMotorDatabase, row: dict) -> str | None:
    """The meeting page's cover for its series now (cover_for), when Markdrop may set it: the page
    has no cover, or still has the one Markdrop chose, and nobody removed it. The cover set, or None.
    A page nobody edited since import stays "untouched" (base_rev follows), so the AI's sections
    still replace it whole."""
    from app.services import page_covers, page_props

    raw = await db["documents"].find_one({"_id": oid(row.get("doc_id"))}) if row.get("doc_id") else None
    if raw is None or raw.get("cover_removed_at") or not await page_covers.workspace_allows(db, row.get("workspace_id")):
        return None
    want = cover_for(row.get("series"))
    cur = page_props.parse(raw.get("content")).get("cover")
    ours = page_props.gallery_cover(row["cover"]) if row.get("cover") else None
    if cur and cur != ours:
        return None   # a cover someone chose
    if cur == page_props.gallery_cover(want):
        if row.get("cover") != want:
            await db[COLL].update_one({"_id": row["_id"]}, {"$set": {"cover": want}})
        return None
    untouched = int(raw.get("rev") or 1) == int(row.get("base_rev") or 0)
    after = await page_covers.apply(db, raw["_id"], want, how="meeting", replace=True)
    if after is None:
        return None
    sets: dict = {"cover": want}
    if untouched:
        sets["base_rev"] = int(after.get("rev") or 1)
    await db[COLL].update_one({"_id": row["_id"]}, {"$set": sets})
    return want


async def upgrade_tick(db: AsyncIOMotorDatabase, *, batch: int = 20) -> int:
    """Meetings imported before covers and hidden transcripts (2026-11-05), a batch at a time from
    the background loop (services/background.py "meetings_backfill"); idempotent: a meeting is
    done once its row has ``v2: True``. Returns how many it did."""
    if _UPGRADED["done"]:
        return 0
    await db["documents"].update_many({"meeting_role": "transcript", "hidden_in_listings": {"$ne": True}},
                                      {"$set": {"hidden_in_listings": True}})
    n = 0
    async for row in db[COLL].find({"v2": {"$ne": True}}, {"segments": 0}).limit(batch):
        try:
            await refresh_cover(db, row)
        except Exception:
            log.warning("meetings: cover not set on %s", row.get("_id"), exc_info=True)
        await db[COLL].update_one({"_id": row["_id"]}, {"$set": {"v2": True}})
        n += 1
    if n == 0:
        _UPGRADED["done"] = True   # new meetings are made with v2 (this process never needs to look again)
    return n


_UPGRADED = {"done": False}


async def _make_transcript(db: AsyncIOMotorDatabase, user, row: dict, page: dict, segments: list[dict],
                           approx: bool) -> dict:
    """The Transcript sub-page under the meeting page."""
    from app.services import page_covers, page_props, pages

    actor, ctx = access.Actor.of(user), access.Ctx(db)
    traw, _s, _e = await pages.create_page(
        db, user, actor, ctx, title="Transcript", parent=page["slug"],
        content=transcript_markdown(segments, approx=approx))
    # One item per meeting: the transcript is the meeting page's sub-page, not an item of its own
    # in folder views, counts or search (workspace_items.NOT_HIDDEN, search._owner_page).
    await db["documents"].update_one({"_id": traw["_id"]}, {"$set": {"meeting_id": str(row["_id"]),
                                                                     "meeting_role": "transcript",
                                                                     "hidden_in_listings": True}})
    await page_covers.opt_out(db, traw)
    await _save(db, traw, page_props.apply(traw.get("content") or "", {"icon": TRANSCRIPT_ICON}), actor, ctx)
    return traw


def spawn(coro) -> None:
    task = asyncio.create_task(coro)
    _bg.add(task)
    task.add_done_callback(_bg.discard)


async def _save(db: AsyncIOMotorDatabase, raw: dict, content: str, actor, ctx, *, base_rev: int | None = None) -> dict | None:
    """Through the website's save path (the edit lock, revisions, search), quietly: every write of
    Markdrop's meeting writer (the page made at import, the transcript, the other half attached, the AI
    sections written or regenerated, a to-do ticked from Home or Slack) goes through here, in a
    background task or not, and notifies nobody about the @mentions in it (**Quiet**, at the top). A person
    editing the meeting page by hand saves through the website as usual, and their mentions notify."""
    from app.schemas.document import DocumentUpdate
    from app.services import document as doc_service
    from app.services import notifications

    data = DocumentUpdate(title=raw.get("title"), content=content or "\n", base_rev=base_rev)
    with notifications.quiet():
        return await doc_service.update_document(db, raw["slug"], data, actor, ctx)


async def write_generated(db: AsyncIOMotorDatabase, meeting: dict, gen: dict | None, user) -> None:
    """The AI's sections into the meeting page: the whole page when nobody changed it since import,
    else the new sections appended at the end (never over someone's edits). Its mentions notify
    nobody (**Quiet**, at the top)."""
    from app.services import meeting_memory, notifications

    try:
        with notifications.quiet():
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
    keep = [p for p in body.split("\n\n## ") if not p.startswith(("## Sources", "Sources", "Attendees\n", "Invited\n"))]
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
        # The calendar invite (Gemini's "Invited"), joined or not: shown as "Invited: N", never as attendees.
        "invited": [{"name": a["name"], "user_id": a.get("user_id")} for a in row.get("invited") or []],
        "attendees_from": row.get("attendees_from"),
        "restricted": bool(row.get("restricted")), "action_items": int(row.get("action_items") or 0),
        "segments": len(row.get("segments") or []), "has_notes": bool(row.get("notes")),
        "has_transcript": bool(row.get("segments")),
        "sources": [{k: s.get(k) for k in ("kind", "origin", "name", "url", "format")} for s in row.get("sources") or []],
        "ai": ai_view(row), "created_at": iso(row.get("created_at")), "created_by": row.get("created_by"),
        # Who ran the call (Drive owner or stated in the text; None: unknown) and who brought it in.
        "organizer": ({k: (row.get("organizer") or {}).get(k) for k in ("name", "user_id", "from")}
                      if row.get("organizer") else None),
        "imported_by": await _person(db, row.get("imported_by") or row.get("created_by")),
        "auto_restricted": bool(row.get("auto_restricted")),
        "can_manage": can_manage, "can_delete": can_delete, "can_regenerate": (await access.can(actor, raw, "edit_content", ctx)).allowed,
        "approx_times": bool(row.get("approx_times")),
        "source": source_of(row),
        "history": bool(row.get("history")),   # a past meeting from a backfill (imported quietly)
        "series": row.get("series") or None,
        # For the list's cards: a line of the summary, how many decisions / open questions, the series' cover.
        **card_bits(row, raw),
    }
    if full:
        from app.services import urls

        out["url"] = urls.markdrop_url(raw["slug"])
    return out


SNIPPET_CHARS = 220
_MD_NOISE = re.compile(r"\[(?:M?\d{1,3}-)?[sn]?\d{1,5}\]|\*\*|__|`|^#+\s*|^[-*]\s+", re.M)


def snippet(text: str | None, limit: int = SNIPPET_CHARS) -> str | None:
    """Plain text of a summary (no Markdown, no citations), cut on a word."""
    t = _MD_NOISE.sub("", str(text or ""))
    t = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", t)
    t = re.sub(r"\s+", " ", t).strip()
    if len(t) <= limit:
        return t or None
    return t[:limit].rsplit(" ", 1)[0].rstrip(",;:.") + "…"


def card_bits(row: dict, raw: dict) -> dict:
    """``summary`` (a line), ``decisions`` / ``open_questions`` (counts) and ``cover`` (the gallery cover the
    page shows, else the series' one) — what the Meetings list shows on a card."""
    from app.services import page_props

    gen = row.get("generated") or {}
    notes = row.get("notes") or {}
    cover = None
    try:
        cur = page_props.parse(raw.get("content")).get("cover") or ""
        if isinstance(cur, str) and cur.startswith("gallery:"):
            cover = cur[len("gallery:"):]
    except Exception:
        cover = None
    return {"summary": snippet(gen.get("summary") or notes.get("summary")),
            "decisions": len(gen.get("decisions") or []), "open_questions": len(gen.get("open_questions") or []),
            "cover": cover or row.get("cover") or cover_for(row.get("series"))}


async def repair_organizers(db: AsyncIOMotorDatabase, *, apply: bool = False, workspace_id: str | None = None) -> dict:
    """Meetings imported before Organizer and Imported by were separate had the importer as Organizer.
    For each: the organizer is the Google Doc's owner when the Google Meet script reported it (its
    inbox row), else unknown; the page's Organizer property is corrected when it still says the importer
    (a value someone set by hand stays). ``apply=False``: only count."""
    from app.services import page_db, user as user_service

    q: dict[str, Any] = {"organizer": {"$exists": False}}
    if workspace_id:
        q["workspace_id"] = workspace_id
    out = {"checked": 0, "from_drive": 0, "unknown": 0, "props_fixed": 0, "errors": 0}
    people_cache: dict[str, People] = {}
    async for row in db[COLL].find(q):
        out["checked"] += 1
        ws = row["workspace_id"]
        people = people_cache.get(ws) or await people_of(db, ws)
        people_cache[ws] = people
        fids = [s.get("file_id") for s in row.get("sources") or [] if s.get("file_id")]
        org = None
        if fids:
            ib = await db["meeting_inbox"].find_one({"workspace_id": ws, "file_id": {"$in": fids},
                                                    "owner": {"$type": "object"}})
            own = (ib or {}).get("owner") or None
            if own:
                mem = people.match(own.get("name"), own.get("email"))
                org = {"name": (mem or {}).get("name") or own.get("name") or (own.get("email") or "").split("@")[0],
                       "email": own.get("email"), "user_id": mem["id"] if mem else None, "from": "drive"}
        out["from_drive" if org else "unknown"] += 1
        if not apply:
            continue
        try:
            await db[COLL].update_one({"_id": row["_id"]}, {"$set": {"organizer": org,
                                                                     "imported_by": row.get("imported_by") or row.get("created_by")}})
            page = await page_of(db, row)
            want = (org or {}).get("user_id")
            if page is not None and page_db.read_values(page.get("content")).get("organizer") == row.get("created_by") \
                    and want != row.get("created_by"):
                user = await user_service.get_user_by_id(db, row.get("created_by"))
                if user is not None:
                    content = page_db.write_values(page.get("content"), {"organizer": want})
                    await _save(db, page, content, access.Actor.of(user), access.Ctx(db))
                    out["props_fixed"] += 1
        except Exception:
            log.warning("meetings: organizer repair failed for %s", row.get("_id"), exc_info=True)
            out["errors"] += 1
    return out


def clean_people(row: dict, people: People) -> tuple[list[dict], dict | None]:
    """A meeting's attendees and organizer with clean names (meeting_parse.person_of: markdown links,
    brackets, quotes, "Name <email>"), garbage dropped, each person once, and a member matched by the
    address a name carried ("[Ishaan Gupta](mailto:ishaan@…)") when it had none. A user_id already
    set is kept (who it is was decided at import, and so was the restriction)."""
    out: list[dict] = []
    for a in row.get("attendees") or []:
        p = mp.person_of(a.get("name"))
        if p is None:
            continue
        uid = a.get("user_id")
        if not uid:
            mem = people.match(p["name"], p["email"])
            uid = mem["id"] if mem else None
        if uid and any(x.get("user_id") == uid for x in out):
            continue
        if any(x["name"].casefold() == p["name"].casefold() and (not uid or not x.get("user_id")) for x in out):
            continue
        out.append({**a, "name": p["name"], "user_id": uid})
    org = row.get("organizer")
    if org and org.get("name"):
        p = mp.person_of(org["name"])
        if p is not None and p["name"] != org["name"]:
            org = {**org, "name": p["name"], "email": org.get("email") or p["email"]}
            if not org.get("user_id"):
                mem = people.match(p["name"], org["email"])
                org["user_id"] = mem["id"] if mem else None
    return out, org


NAMES_V = 1   # rows with names_v >= this have clean attendee names (new rows are made clean)


async def repair_names(db: AsyncIOMotorDatabase, row: dict, people: People, *, apply: bool = True) -> bool:
    """One meeting's names cleaned (:func:`clean_people`); the page's Attendees property too when
    it still reads what Markdrop wrote (a value someone typed stays). True when anything changed.
    Idempotent; never touches the restriction or its grants."""
    from app.services import page_db, user as user_service

    attendees, org = clean_people(row, people)
    changed = attendees != (row.get("attendees") or []) or org != row.get("organizer")
    if not apply:
        return changed
    sets: dict[str, Any] = {"names_v": NAMES_V}
    if changed:
        sets.update(attendees=attendees, organizer=org)
    await db[COLL].update_one({"_id": row["_id"]}, {"$set": sets})
    if not changed:
        return False
    page = await page_of(db, row)
    if page is None:
        return True
    old = ", ".join(a.get("name") or "" for a in row.get("attendees") or [])[:page_db.TEXT_MAX]
    new = ", ".join(a["name"] for a in attendees)[:page_db.TEXT_MAX]
    content = page.get("content") or ""
    if old != new and page_db.read_values(content).get("attendees") == old:
        user = await user_service.get_user_by_id(db, row.get("created_by"))
        if user is not None:
            unedited = int(page.get("rev") or 1) == int(row.get("base_rev") or 0)
            after = await _save(db, page, page_db.write_values(content, {"attendees": new or None}),
                                access.Actor.of(user), access.Ctx(db))
            if after is not None and unedited:
                await db[COLL].update_one({"_id": row["_id"]}, {"$set": {"base_rev": int(after.get("rev") or 1)}})
    return True


async def names_tick(db: AsyncIOMotorDatabase, *, batch: int = 50) -> int:
    """Meetings imported before names were cleaned (2026-11-06), a batch at a time from the
    background loop; idempotent (``names_v``). Returns how many it looked at."""
    if _NAMES["done"]:
        return 0
    n = 0
    cache: dict[str, People] = {}
    async for row in db[COLL].find({"names_v": {"$not": {"$gte": NAMES_V}}}, {"segments": 0, "notes": 0}).limit(batch):
        ws = row["workspace_id"]
        try:
            cache[ws] = cache.get(ws) or await people_of(db, ws)
            await repair_names(db, row, cache[ws])
        except Exception:
            log.warning("meetings: names not cleaned on %s", row.get("_id"), exc_info=True)
            await db[COLL].update_one({"_id": row["_id"]}, {"$set": {"names_v": NAMES_V}})
        n += 1
    if n == 0:
        _NAMES["done"] = True
    return n


_NAMES = {"done": False}


async def count_dirty_names(db: AsyncIOMotorDatabase, *, workspace_id: str | None = None) -> dict:
    """Dry run for scripts/fix_meeting_attendees.py: how many meetings :func:`names_tick` would change."""
    q: dict[str, Any] = {"names_v": {"$not": {"$gte": NAMES_V}}}
    if workspace_id:
        q["workspace_id"] = workspace_id
    out = {"pending": 0, "would_change": 0, "examples": []}
    cache: dict[str, People] = {}
    async for row in db[COLL].find(q, {"segments": 0, "notes": 0}):
        out["pending"] += 1
        ws = row["workspace_id"]
        cache[ws] = cache.get(ws) or await people_of(db, ws)
        if await repair_names(db, row, cache[ws], apply=False):
            out["would_change"] += 1
            if len(out["examples"]) < 5:
                out["examples"].append([a.get("name") for a in (row.get("attendees") or [])[:3]])
    return out


# ── Repair: attendees_v 2 and 3 (owner, 2026-11-06) ───────────────────────────
# v2: attendees told apart from the invite (recompute_people). v3: Gemini's next steps
# ("Gautam Khurana Review Video: Gautam Khurana will review the video …") had been read as transcript
# turns, so "Gautam Khurana Review Video" was a speaker and an attendee (51 of Senseloaf's 166
# meetings). The fake turns came from the notes Doc: dropped (a meeting with Gemini notes and no real
# transcript has no transcript any more); elsewhere the owner is the speaker. Attendees follow.


def _norm_text(text: str | None) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[*_`#\\]+", " ", str(text or ""))).strip().casefold()


def row_universe(row: dict, people: People, base: mp.Universe | None = None) -> mp.Universe:
    """The workspace's people (:func:`people_universe`, or the members) and this meeting's own: its
    invitees and attendees with an address, and the names its own labels keep starting with."""
    u = mp.Universe(base.people if base is not None else
                    [{"name": m.get("name"), "email": m.get("email"), "user_id": m["id"]} for m in people.members])
    for a in [*(row.get("invited") or []), *(row.get("attendees") or [])]:
        if a.get("email") and not mp.topicish(a.get("name")):
            u.add(a)
    heads = [str(x).partition(":")[0] for x in (row.get("notes") or {}).get("next_steps") or [] if ":" in str(x)]
    for n in mp.mine_names([*(s.get("speaker") or "" for s in row.get("segments") or []), *heads]):
        if u.owner(n)[0] is None:
            u.add({"name": n})
    return u


def fix_task_segments(row: dict, universe: mp.Universe) -> dict | None:
    """The meeting's segments without speakers that are no one, or None when every label is a person:
    {segments, labels: {label: owner or None}, dropped, notes_only, notes (built when the row has none)}.

    * Half or more of the labels (2+) are "<Person> <task words>" (meeting_parse.read_turns): every
      "turn" was Gemini's notes (prod: 43 sync-ups, some never marked as notes): none is kept.
    * Gemini notes among its sources: the fake turns and every other line of the notes read as turns
      (their text is in the notes kept) are dropped; nothing real left (no speaker): none is kept.
    * Elsewhere the owner is the speaker; a label longer than a name speaks for nobody.
    A meeting left with no transcript and no notes gets notes from those lines (next steps, details)."""
    segs = list(row.get("segments") or [])
    got = mp.read_turns(segs, universe, universe.names())
    labels = got["labels"]
    if not labels:
        return None
    gemini = any(s.get("format") == "gemini_notes" for s in row.get("sources") or [])
    if got["whole"]:
        out: list[dict] = []
    elif gemini:
        notes = row.get("notes") or {}
        corpus = _norm_text(" ".join([notes.get("summary") or "", *(notes.get("details") or []),
                                      *(notes.get("next_steps") or [])]))

        def from_notes(s: dict) -> bool:
            if s.get("speaker") in labels:
                return True
            t = _norm_text(s.get("text"))
            return len(t) >= 15 and t[:60] in corpus

        out = [s for s in segs if not from_notes(s)]
        if not any(s.get("speaker") for s in out):
            out = []
    else:
        out = segs
    out = [{**s, "speaker": labels[s["speaker"]]} if s.get("speaker") in labels and labels[s["speaker"]] else
           {**s, "speaker": None} if s.get("speaker") in labels and len(mp.clean_name(s["speaker"]).split()) > mp.TASK_MAX_WORDS
           else s for s in out]
    notes_only = not out and bool(segs)
    return {"segments": out, "labels": labels, "dropped": len(segs) - len(out), "notes_only": notes_only,
            "lines": note_lines(segs, labels) if notes_only else None, "whole": got["whole"]}


def note_lines(segs: list[dict], labels: dict[str, str | None]) -> dict:
    """Lines of Gemini's notes that were read as turns, back as notes: {next_steps, details}."""
    steps = [f"{s['speaker']}: {(s.get('text') or '').strip()}" for s in segs
             if s.get("speaker") in labels and labels[s["speaker"]]]
    details = [f"{mp.clean_name(s['speaker'])}: {(s.get('text') or '').strip()}" if s.get("speaker")
               else (s.get("text") or "").strip() for s in segs
               if not (s.get("speaker") in labels and labels[s["speaker"]])]
    return {"next_steps": [x for x in steps if x][:80], "details": [d for d in details if d][:80]}


def with_lines(notes: dict | None, lines: dict | None) -> dict | None:
    """``notes`` (placeholders gone) with the recovered lines where it has none of its own."""
    n = mp.clean_empty_notes(notes) if notes else None
    if not lines or not (lines.get("next_steps") or lines.get("details")):
        return n
    n = dict(n or {"summary": "", "details": [], "next_steps": []})
    if not n.get("next_steps"):
        n["next_steps"] = list(lines.get("next_steps") or [])
    if not n.get("details"):
        n["details"] = list(lines.get("details") or [])
    return n


_T_LINE = re.compile(r"^\*\*(.+?)\*\*\s(.*?)\s*\{#b-t\d+\}\s*$")


async def recovered_lines(db: AsyncIOMotorDatabase, row: dict) -> list[dict]:
    """The "turns" the v4 repair dropped (Gemini's notes read as a transcript), read back from the
    Transcript page it moved to the Trash: [{speaker, t, text}] ([] when there is none)."""
    t = await db["trash"].find_one({"doc.meeting_id": str(row["_id"]), "doc.meeting_role": "transcript"},
                                   {"doc.content": 1}, sort=[("deleted_at", -1)])
    out: list[dict] = []
    for line in ((t or {}).get("doc") or {}).get("content", "").split("\n"):
        m = _T_LINE.match(line.strip())
        if not m:
            continue
        head = [h.strip() for h in m.group(1).split(" · ")]
        if head and re.fullmatch(r"\d{1,2}:\d{2}(?::\d{2})?", head[0]):
            head = head[1:]
        who = re.sub(r"\\(.)", r"\1", head[-1]) if head else None
        out.append({"speaker": who or None, "t": None, "text": re.sub(r"\\(.)", r"\1", m.group(2)).strip()})
    return out


def fix_task_people(view: dict, att: list[dict], inv: list[dict], how: str, people: People,
                    fixed: dict | None, universe: mp.Universe | None = None) -> tuple[list[dict], list[dict], str]:
    """(attendees, invited, attendees_from) with no task words and no headings (:func:`tidy_people`
    against the workspace's people). Taken from the speakers ("speakers"), they are the fixed
    transcript's speakers again. Nobody known to have joined and Gemini's notes there (or the lines
    that were read as turns): the people they name ("notes", :func:`notes_attendees`)."""
    u = universe or row_universe({**view, "invited": inv, "attendees": att}, people)
    labels = dict((fixed or {}).get("labels") or {})
    if how == "speakers" and fixed is not None:
        found = []
        for sp in _speakers_of(view):
            hit = u.get(sp) or next((a for a in [*att, *inv] if (a.get("name") or "").casefold() == sp.casefold()
                                     and (a.get("email") or a.get("user_id"))), None)
            found.append({"name": sp, "user_id": (hit or {}).get("user_id"), "email": (hit or {}).get("email")})
    else:
        found = att
    out = tidy_people(found, u, people, labels)
    invited = tidy_people(inv, u, people, labels, limit=200)
    if how == "speakers" and not out:
        how = "invited" if invited else "none"
    out, how = with_notes_people(out, invited, how, view.get("notes"), people, u)
    return out, invited, how


async def repair_attendees(db: AsyncIOMotorDatabase, row: dict, people: People, *, apply: bool = True,
                           universe: mp.Universe | None = None) -> dict:
    """One meeting repaired (``attendees_v`` 3): its "<Owner> <Task Title>" speakers fixed
    (:func:`fix_task_segments`), its attendees recomputed (:func:`recompute_people` when from before
    v2, then :func:`fix_task_people`). The page follows only where Markdrop's own words are still
    there: a page nobody edited since Markdrop wrote it is written again; an edited one gets its
    Attendees property and section only where they still read what Markdrop wrote; the Transcript
    page is written again (or, with no transcript left, moved to the Trash) only when nobody edited
    it. Never touches the restriction or its grants. Idempotent. Returns what it did: {changed, from,
    before, after, invited, page, segments, transcript, before_names, after_names}."""
    from app.services import page_db, page_props, trash, user as user_service

    u = row_universe(row, people, universe)
    fixed = fix_task_segments(row, u)
    lines = (fixed or {}).get("lines")
    if not row.get("segments") and not lines and (row.get("attendees_from") or "none") in ("invited", "none", "notes"):
        # v4 dropped Gemini's notes read as turns, keeping notes that say nothing: read them back.
        rec = await recovered_lines(db, row)
        if rec:
            got = mp.read_turns(rec, u, u.names())
            lines = note_lines(rec, got["labels"]) if got["labels"] else None
    notes = with_lines(row.get("notes"), lines)
    view = {**row, "segments": fixed["segments"] if fixed else row.get("segments") or [], "notes": notes}
    if not row.get("invited") and notes:
        # No invite kept: a line of people chips in the notes (Gemini's newer header) is the invite.
        chips = next((c for c in (mp.chip_people(x) for x in [notes.get("summary") or "", *(notes.get("details") or [])]) if c), [])
        if chips:
            view["invited"] = person_rows(chips, people, limit=200)
    if int(row.get("attendees_v") or 0) < ATTENDEES_V2:
        att, inv, how = recompute_people(view, people)
    else:
        att, inv, how = list(row.get("attendees") or []), list(view.get("invited") or []), row.get("attendees_from") or "none"
    if fixed and fixed["notes_only"] and how == "speakers":
        att, how = [], "invited"    # every "speaker" was a line of the notes: who joined comes from the notes
    att, inv, how = fix_task_people(view, att, inv, how, people, fixed, u)
    before = row.get("attendees") or []
    seg_changed = fixed is not None and fixed["segments"] != (row.get("segments") or [])
    notes_changed = (notes or None) != (row.get("notes") or None)
    changed = [(a.get("name"), a.get("user_id")) for a in before] != [(a["name"], a["user_id"]) for a in att] \
        or [a["name"] for a in inv] != [a.get("name") for a in row.get("invited") or []] or seg_changed \
        or how != row.get("attendees_from") or notes_changed
    out = {"changed": changed, "from": how, "before": len(before), "after": len(att), "invited": len(inv),
           "page": "none", "segments": "same", "transcript": "none",
           "before_names": [a.get("name") for a in before], "after_names": [a["name"] for a in att]}
    if seg_changed:
        out["segments"] = "dropped" if fixed["notes_only"] else f"fixed ({fixed['dropped']} dropped)" if fixed["dropped"] else "renamed"
    page = await page_of(db, row) if changed else None
    untouched = page is not None and int(page.get("rev") or 1) == int(row.get("base_rev") or 0)
    old_text = ", ".join(a.get("name") or "" for a in before)[:page_db.TEXT_MAX]
    old_section = people_section(row, people)
    if page is not None:
        if untouched:
            out["page"] = "rewritten"
        elif page_db.read_values(page.get("content")).get("attendees") == old_text \
                or (old_section and old_section in (page.get("content") or "")):
            out["page"] = "attendees"
        else:
            out["page"] = "left"
    traw = None
    if seg_changed and row.get("transcript_doc_id"):
        traw = await db["documents"].find_one({"_id": row["transcript_doc_id"]})
        if traw is not None and not traw.get("deleted_at"):
            want = page_props.apply(transcript_markdown(row.get("segments") or [], approx=bool(row.get("approx_times"))),
                                    {"icon": TRANSCRIPT_ICON})
            if (traw.get("content") or "").strip() == want.strip():
                out["transcript"] = "trashed" if not fixed["segments"] else "rewritten"
            else:
                out["transcript"] = "left"
        else:
            traw = None
    if not apply:
        return out
    # One writer per meeting (the background loop and the script's --apply run side by side).
    now = now_utc()
    claim = await db[COLL].find_one_and_update(
        {"_id": row["_id"], "attendees_v": {"$not": {"$gte": ATTENDEES_V}},
         "$or": [{"attendees_lock": {"$exists": False}}, {"attendees_lock": {"$lt": now - timedelta(minutes=2)}}]},
        {"$set": {"attendees_lock": now}}, projection={"_id": 1})
    if claim is None:
        out["page"] = "busy"
        return out
    user = None
    if out["page"] in ("rewritten", "attendees") or out["transcript"] in ("rewritten", "trashed"):
        user = await user_service.get_user_by_id(db, row.get("created_by"))
        if user is None:    # nobody to write as: the pages stay as they are (the row is fixed all the same)
            out["page"] = "left" if out["page"] != "none" else "none"
            out["transcript"] = "left" if out["transcript"] != "none" else "none"
    sets: dict[str, Any] = {"attendees_v": ATTENDEES_V, "names_v": NAMES_V, "attendees_from": how}
    if changed:
        sets.update(attendees=att, invited=inv,
                    attendees_repair={"from": how, "before": len(before), "at": now_utc(), "v": ATTENDEES_V})
    if seg_changed:
        sets["segments"] = fixed["segments"]
        sets["attendees_repair"]["segments"] = out["segments"]
        if fixed["notes_only"]:
            sets["sources"] = [{**s, "kind": "notes", "format": "gemini_notes"} if s.get("kind") in ("both", "transcript") else s
                               for s in row.get("sources") or []]
            if out["transcript"] == "trashed":
                sets.update(transcript_doc_id=None, transcript_slug=None)
    if notes_changed:
        old_n = len((row.get("notes") or {}).get("next_steps") or [])
        sets["notes"] = notes
        sets["action_items"] = max(0, int(row.get("action_items") or 0) - old_n + len((notes or {}).get("next_steps") or []))
    await db[COLL].update_one({"_id": row["_id"]}, {"$set": sets, "$unset": {"attendees_lock": ""}})
    if seg_changed:
        from app.services import meeting_memory

        await meeting_memory.sync_quietly(db, row["_id"])     # its facts' speakers and segments
    if user is None:
        return out
    actor, ctx = access.Actor.of(user), access.Ctx(db)
    if traw is not None and out["transcript"] == "rewritten":
        try:
            await _save(db, traw, page_props.apply(transcript_markdown(fixed["segments"], approx=bool(row.get("approx_times"))),
                                                   {"icon": TRANSCRIPT_ICON}), actor, ctx)
        except HTTPException as exc:
            log.info("meetings: transcript %s not rewritten (%s)", traw.get("slug"), exc.detail)
            out["transcript"] = "left"
    elif traw is not None and out["transcript"] == "trashed":
        await trash.move(db, [traw], traw, actor)
    if out["page"] not in ("rewritten", "attendees"):
        return out
    # The whole row (the tick reads it without Google's notes): the page is written from all of it.
    fresh = {**(await db[COLL].find_one({"_id": row["_id"]}) or row), **sets}

    async def write(page: dict, mode: str) -> dict | None:
        if mode == "rewritten":
            content = await full_markdown(db, fresh, fresh.get("generated"), people)
            return await _save(db, page, content, actor, ctx, base_rev=int(page.get("rev") or 1))
        content = page.get("content") or ""
        if page_db.read_values(content).get("attendees") == old_text:
            content = page_db.write_values(content, {"attendees": attendees_text(fresh)})
        new_section = people_section(fresh, people)
        if old_section and old_section in content and new_section != old_section:
            content = content.replace(old_section, new_section, 1) if new_section \
                else content.replace(old_section + "\n\n", "", 1).replace(old_section, "", 1)
        if out["transcript"] == "trashed" and row.get("transcript_slug"):
            embed = f'::page{{src="{row["transcript_slug"]}"}}'
            content = content.replace(embed + "\n\n", "", 1).replace(embed, "", 1)
        return await _save(db, page, content, actor, ctx) if content != (page.get("content") or "") else None

    page = await page_of(db, row) or page
    try:
        after = await write(page, out["page"])
    except HTTPException as exc:
        if exc.status_code != 409:
            raise
        # Saved meanwhile (another writer): once more on the page as it is now.
        page = await page_of(db, row) or page
        if out["page"] == "rewritten" and int(page.get("rev") or 1) != int(row.get("base_rev") or 0):
            out["page"] = "attendees"
            untouched = False
        after = await write(page, out["page"])
    if after is not None and untouched:
        await db[COLL].update_one({"_id": row["_id"]}, {"$set": {"base_rev": int(after.get("rev") or 1)}})
    return out


_ATTENDEES = {"done": False}


async def attendees_tick(db: AsyncIOMotorDatabase, *, batch: int = 50) -> int:
    """Meetings from before attendees_v 3 (:func:`repair_attendees`), a batch at a time from the
    background loop. Returns how many it looked at (0: none left)."""
    if _ATTENDEES["done"]:
        return 0
    n = 0
    cache: dict[str, People] = {}
    known: dict[str, mp.Universe] = {}
    q = {"attendees_v": {"$not": {"$gte": ATTENDEES_V}}}
    async for row in db[COLL].find(q).limit(batch):     # the notes too: fix_task_segments reads them
        ws = row["workspace_id"]
        try:
            cache[ws] = cache.get(ws) or await people_of(db, ws)
            known[ws] = known.get(ws) or await people_universe(db, ws, cache[ws])
            with _quiet():
                await repair_attendees(db, row, cache[ws], universe=known[ws])
        except Exception:
            log.warning("meetings: attendees not repaired on %s", row.get("_id"), exc_info=True)
            await db[COLL].update_one({"_id": row["_id"]}, {"$set": {"attendees_v": ATTENDEES_V}})
        n += 1
    if n == 0:
        _ATTENDEES["done"] = True
    return n


def _quiet():
    from app.services import notifications

    return notifications.quiet()


async def attendees_dry_run(db: AsyncIOMotorDatabase, *, workspace_id: str | None = None, examples: int = 15) -> dict:
    """What :func:`attendees_tick` would do (scripts/fix_meeting_attendees.py,
    scripts/fix_attendee_task_names.py): counts by kind and a few examples (title, date, attendees
    before → after, what happens to the transcript and the page)."""
    q: dict[str, Any] = {"attendees_v": {"$not": {"$gte": ATTENDEES_V}}}
    if workspace_id:
        q["workspace_id"] = workspace_id
    out: dict[str, Any] = {"pending": 0, "would_change": 0, "from": {}, "page": {}, "people_before": 0,
                           "people_after": 0, "invited": 0, "segments": {}, "transcript": {}, "task_names": 0,
                           "examples": [], "bad_after": [], "empty_after": []}
    cache: dict[str, People] = {}
    known: dict[str, mp.Universe] = {}
    async for row in db[COLL].find(q):
        out["pending"] += 1
        ws = row["workspace_id"]
        cache[ws] = cache.get(ws) or await people_of(db, ws)
        known[ws] = known.get(ws) or await people_universe(db, ws, cache[ws])
        r = await repair_attendees(db, row, cache[ws], apply=False, universe=known[ws])
        u = row_universe(row, cache[ws], known[ws])
        task = [n for n in r["before_names"] if n and (isinstance(mp.task_shaped(n, None, u), str) or mp.topicish(n))]
        # The target: no task words and no headings left in any attendee name; nobody's sync-up empty.
        for n in r["after_names"]:
            if isinstance(mp.task_shaped(n, None, u), str) or mp.topicish(n) or len(n.split()) > mp.TASK_MAX_WORDS:
                out["bad_after"].append(f"{row.get('date')} {row.get('title')}: {n}")
        if not r["after_names"] and r["before_names"]:
            out["empty_after"].append(f"{row.get('date')} {row.get('title')} ({r['from']})")
        if not r["changed"]:
            continue
        out["would_change"] += 1
        for k in ("from", "page", "segments", "transcript"):
            out[k][r[k]] = out[k].get(r[k], 0) + 1
        out["people_before"] += r["before"]
        out["people_after"] += r["after"]
        out["invited"] += r["invited"]
        out["task_names"] += 1 if task or r["segments"] != "same" else 0
        if len(out["examples"]) < examples and (task or r["segments"] != "same" or len(out["examples"]) < examples // 3):
            out["examples"].append({"workspace_id": ws, "title": row.get("title"), "date": row.get("date"),
                                    "before": r["before_names"], "after": r["after_names"], "invited": r["invited"],
                                    "from": r["from"], "page": r["page"], "segments": r["segments"],
                                    "transcript": r["transcript"]})
    return out


async def stray_fact_subjects(db: AsyncIOMotorDatabase, *, apply: bool = False) -> dict:
    """Team memory facts (``memory_facts``) whose subject isn't a member of their workspace: a fake
    "<Owner> <Task Title>" person never became one (subjects are member ids, matched by
    People.match); counted, and with ``apply`` removed when the subject isn't anyone's account at all.
    {facts, not_member, not_a_user, removed}."""
    from app.services import workspace_memory

    out = {"facts": 0, "not_member": 0, "not_a_user": 0, "removed": 0}
    members: dict[str, set[str]] = {}
    bad: list[Any] = []
    async for f in db[workspace_memory.FACTS].find({}, {"workspace_id": 1, "subject": 1}):
        out["facts"] += 1
        ws = str(f.get("workspace_id") or "")
        if ws not in members:
            members[ws] = {m["id"] for m in (await people_of(db, ws)).members} if ws else set()
        subj = str(f.get("subject") or "")
        if subj in members[ws]:
            continue
        out["not_member"] += 1
        if not ObjectId.is_valid(subj) or await db["users"].find_one({"_id": ObjectId(subj)}, {"_id": 1}) is None:
            out["not_a_user"] += 1
            bad.append(f["_id"])
    if apply and bad:
        out["removed"] = (await db[workspace_memory.FACTS].delete_many({"_id": {"$in": bad}})).deleted_count
    return out


async def _person(db: AsyncIOMotorDatabase, user_id: str | None) -> dict | None:
    if not user_id or not ObjectId.is_valid(user_id):
        return None
    u = await db["users"].find_one({"_id": ObjectId(user_id)}, {"name": 1, "email": 1})
    if u is None:
        return {"user_id": user_id, "name": None}
    return {"user_id": user_id, "name": u.get("name") or (u.get("email") or "").split("@")[0] or None}


SOURCES = ("manual", "auto", "mcp")
_VIA = {"manual": {"$nin": ["inbox", "mcp"]}, "auto": "inbox", "mcp": "mcp"}


def source_of(row: dict) -> str:
    """How the meeting came in: "auto" (the Google Meet script), "mcp", or "manual" (the website)."""
    return {"inbox": "auto", "mcp": "mcp"}.get(row.get("via") or "", "manual")


async def list_meetings(db: AsyncIOMotorDatabase, workspace_id: str, actor: access.Actor, ctx: access.Ctx, *,
                        limit: int = 30, q: str | None = None, source: str | None = None,
                        since: str | None = None, until: str | None = None, series: str | None = None,
                        cursor: str | None = None, sort: str = "date_desc", overview: bool = True,
                        attendees_max: int | None = 5) -> dict:
    """The meetings of a workspace the caller can open, a page at a time (services/meetings_list.py):
    {meetings (cards), next_cursor, total (first page), hidden, folder_id (first page)}. A workspace
    admin also sees restricted meetings they can't open, without their title (so they can delete them).

    ``q``: titles, series or attendee names containing it; ``source``: only those that came in that way
    (:data:`SOURCES`); ``since`` / ``until``: only meetings on or after / on or before that date
    (YYYY-MM-DD); ``series``: only that series (any case; "none": meetings without one)."""
    from app.services import meetings_list

    return await meetings_list.list_page(
        db, workspace_id, actor, ctx, limit=limit, cursor=cursor, sort=sort, overview=overview,
        attendees_max=attendees_max,
        filters=meetings_list.Filters(q=q, source=source, since=since, until=until, series=series))


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
        ids = {a["user_id"] for a in [*(row.get("attendees") or []), *(row.get("invited") or [])] if a.get("user_id")}
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
