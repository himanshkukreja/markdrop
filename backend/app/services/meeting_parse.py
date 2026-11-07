"""Meeting sources → a normal form (Meetings v1, .work/meetings/SPEC.md). Pure: no I/O.

A *source* is one file or one pasted text: a transcript, Google's Gemini meeting notes, or a notes
Doc whose second tab is the transcript (both). :func:`parse_source` detects the format and returns a
:class:`Source`::

    kind        "transcript" | "notes" | "both"
    format      "google_meet" | "gemini_notes" | "vtt" | "srt" | "sbv" | "otter" | "speaker_lines" | "plain"
    title, date ("YYYY-MM-DD"), time ("HH:MM"), duration_s, attendees [{name, email}]
    segments    [{speaker, t, text}]   t: seconds from the start, or None; approx: interpolated
    notes       {summary, details: [..], next_steps: [..]} | None

Formats understood:

* **Google Meet transcript Doc**: "<name> (2026-11-04 10:00 GMT+05:30) - Transcript", an
  "Attendees" block, "Name: text" lines, a bare "00:05:00" every five minutes, "Transcription
  ended after 00:42:13". Times inside a five-minute block are interpolated by characters.
* **Gemini "Take notes for me" Doc**: Summary / Details / Suggested next steps ("Notes by Gemini"),
  optionally followed by a Transcript tab (``=== Tab: Transcript ===`` from the Docs API reader,
  or a "Transcript" heading followed by speaker lines).
* **WebVTT** (``<v Name>`` voice tags or "Name: text"), **SRT**, **SBV** (YouTube).
* **Otter / Zoom text**: "Name  12:34" then the words on the next lines.
* "[12:34] Name: text", "12:34 Name: text", "Name (12:34): text", plain "Name: text".
* Anything else: one segment per paragraph, no speaker.

:func:`docx_text` reads a .docx (zip + XML, headings kept as ``#``). :func:`pair` groups notes and
transcripts that belong to the same meeting by their normalised title and date.
"""

from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass, field
from datetime import date
from typing import Any
from xml.etree import ElementTree as ET

MAX_SEGMENTS = 6000
MAX_TEXT = 450_000          # characters of transcript kept per meeting (~11 hours of talk)
MAX_SEGMENT_CHARS = 1500    # a longer turn is cut into several segments
MERGE_CHARS = 600           # consecutive cues of one speaker are merged up to this length

TAB_MARK = re.compile(r"^=== Tab: (.*?) ===\s*$")

_TS = r"(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?"
_TS_RE = re.compile(rf"^{_TS}$")
_BARE_TS = re.compile(r"^\s*\(?(\d{1,2}:\d{2}(?::\d{2})?)\)?\s*$")
_VTT_CUE = re.compile(rf"^\s*{_TS}\s*-->\s*{_TS}")
_SBV_CUE = re.compile(r"^\s*(\d{1,2}:\d{2}:\d{2}\.\d{3}),(\d{1,2}:\d{2}:\d{2}\.\d{3})\s*$")
_SRT_INDEX = re.compile(r"^\s*\d{1,6}\s*$")
_VOICE = re.compile(r"<v(?:\.[\w.-]+)?\s+([^>]+)>", re.I)
_TAGS = re.compile(r"</?[a-z][^>]*>", re.I)
_OTTER = re.compile(r"^(?P<name>[^\d\s:][^:\n]{0,60}?)\s{2,}(?P<ts>\d{1,2}:\d{2}(?::\d{2})?)\s*$")
_OTTER_NAME_FIRST = re.compile(r"^(?P<name>[^\d\s:\[][^:\n]{0,60}?)\s+(?P<ts>\d{1,2}:\d{2}(?::\d{2})?)\s*$")
_BRACKET_TS = re.compile(r"^\s*[\[(]?(?P<ts>\d{1,2}:\d{2}(?::\d{2})?)[\])]?\s*[-–—]?\s*(?P<rest>.+)$")
_NAME_TS = re.compile(r"^(?P<name>[^:\n\[\]()]{1,60}?)\s*[\[(](?P<ts>\d{1,2}:\d{2}(?::\d{2})?)[\])]\s*:?\s*(?P<text>.*)$")
_SPEAKER = re.compile(r"^(?P<name>[^:\n]{1,60}?)\s*:\s+(?P<text>\S.*)$")
_ENDED = re.compile(r"transcription ended after\s+(\d{1,2}:\d{2}:\d{2})", re.I)
# Google's own lines around a transcript (metadata, never anyone's words): the closing "Transcription
# ended after 00:42:13" and the header notice. They end the speaker's turn instead of joining it.
_GOOGLE_META = re.compile(
    r"^(?:transcription ended after\b|transcript(?:ion)? (?:has )?ended\b|this editable transcript was computer generated"
    r"|people can also change the text after it was created|meeting ended after\b)", re.I)
_ENDED_TAIL = re.compile(r"\s*\btranscription ended after\s+\d{1,2}:\d{2}:\d{2}\b.*$", re.I)
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$")
_BULLET = re.compile(r"^\s*(?:[-*•●▪◦]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?(.*)$")
_CHECK = re.compile(r"^\s*(?:[-*•]\s+)?\[[ xX]\]\s+(.*)$")

_NOT_NAMES = frozenset("""
note notes summary details agenda action actions decision decisions question questions next steps todo to-do
http https www re fw fwd subject date time attendees transcript topic topics outcome outcomes owner owners
meeting example warning important tip update status q a
""".split())

_MONTHS = {m: i + 1 for i, m in enumerate(
    ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"))}

NOTES_HEADS = {
    "summary": ("summary", "meeting summary", "overview"),
    "details": ("details", "discussion", "notes", "key points", "discussion points"),
    "next_steps": ("suggested next steps", "next steps", "action items", "follow-ups", "follow ups"),
}
_GEMINI_BOILER = re.compile(
    r"^(you should review gemini'?s notes|please provide feedback about using gemini|get tips and learn how gemini"
    r"|this editable transcript was computer generated|people can also change the text|meeting records\b"
    r"|attachments\b|notes by gemini\s*$|📝|📖|transcript\s*$)", re.I)
# Gemini's notes for a call it couldn't summarise ("not enough conversation in a supported language"):
# placeholders, never a summary, a detail or a next step.
GEMINI_EMPTY = re.compile(
    r"^\W*(?:no suggested next steps were found|a summary wasn'?t produced|details weren'?t produced"
    r"|if the meeting was transcribed, you can review|visit the help center|how is the quality of these specific notes"
    r"|no details were found|no summary was produced)", re.I)


@dataclass
class Source:
    name: str = ""
    kind: str = "transcript"           # transcript | notes | both
    format: str = "plain"
    title: str | None = None
    date: str | None = None
    time: str | None = None
    duration_s: int | None = None
    attendees: list[dict] = field(default_factory=list)   # who joined (see people_lists / _with_speakers)
    invited: list[dict] = field(default_factory=list)     # the calendar invite (Gemini's "Invited"), joined or not
    listed: list[dict] = field(default_factory=list)      # an "Attendees" line's people, as written
    attendees_from: str = "none"       # attendees | speakers | none
    organizer: dict | None = None      # {name, email} where the text says who organized the call
    segments: list[dict] = field(default_factory=list)
    notes: dict | None = None
    approx_times: bool = False
    truncated: bool = False

    @property
    def speakers(self) -> list[str]:
        out: list[str] = []
        for s in self.segments:
            sp = s.get("speaker")
            if sp and sp not in out:
                out.append(sp)
        return out

    def describe(self) -> dict:
        return {"name": self.name, "kind": self.kind, "format": self.format, "title": self.title,
                "date": self.date, "time": self.time, "duration_s": self.duration_s,
                "attendees": [a["name"] for a in self.attendees], "speakers": self.speakers,
                "invited": [a["name"] for a in self.invited], "attendees_from": self.attendees_from,
                "organizer": (self.organizer or {}).get("name"),
                "segments": len(self.segments), "has_notes": bool(self.notes), "truncated": self.truncated,
                "approx_times": self.approx_times}


# ── Small helpers ─────────────────────────────────────────────────────────────


def to_seconds(ts: str | None) -> int | None:
    """"1:02:03" / "02:03" / "00:00:01.500" / "00:00:01,500" → whole seconds."""
    if not ts:
        return None
    m = _TS_RE.match(ts.strip())
    if not m:
        return None
    h, mi, s = int(m.group(1) or 0), int(m.group(2)), int(m.group(3))
    if s >= 60 or (m.group(1) is not None and mi >= 60):
        return None
    return h * 3600 + mi * 60 + s


def clock(t: int | None) -> str:
    """Seconds → "12:34" (or "1:02:03")."""
    if t is None:
        return ""
    t = max(0, int(t))
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _clean_line(line: str) -> str:
    return line.replace("\u00a0", " ").replace("\u200b", "").rstrip()


def _plausible_name(name: str) -> bool:
    n = name.strip().strip("*_").strip()
    if not n or len(n) > 60 or "http" in n.lower() or "@" in n and " " in n:
        return False
    words = n.split()
    # Longer than a name (bullets and "[ ]" aside): a sentence or a "<Owner> <Task Title>" next step.
    if len(words) > 6 or len((clean_speaker(n) or n).split()) > 5:
        return False
    if n.casefold() in _NOT_NAMES or words[0].casefold() in _NOT_NAMES:
        return False
    if sum(ch.isdigit() for ch in n) > 2:
        return False
    if not any(ch.isalpha() for ch in n):
        return False
    return not n.endswith((".", "?", "!", ","))


def clean_speaker(name: str) -> str:
    n = re.sub(r"\s+", " ", name.strip().strip("*_>-").strip())
    n = re.sub(r"\s*\((?:guest|host|external|presenter)\)$", "", n, flags=re.I)
    if re.search(r"[\[\]\\\"“”‘’`]|^['(<{]|mailto:", n):
        n = clean_name(n)
    return n[:60]


# ── People's names (attendees, organizer) ─────────────────────────────────────
# Google Docs people chips come through as "Name <email>" (the Google Meet script), as markdown links
# ("[Ishaan Gupta](mailto:ishaan@…)", a Docs markdown export or a copy-paste), or bracketed /
# quoted / escaped. Every name a meeting shows is cleaned here, and the address kept for matching
# members (owner, 2026-11-06: the meeting bar showed "[I [G [S").
_EMAIL = r"[\w.+'-]+@[\w-]+(?:\.[\w-]+)+"
_MD_LINK = re.compile(r"\[([^\[\]]*)\]\(\s*(?:mailto:)?([^)\s]*)\s*\)", re.I)
_ANGLE = re.compile(r"([^,;<>\[\]]*?)\s*[<(]\s*(?:mailto:)?(" + _EMAIL + r")\s*[>)]", re.I)
_EDGE = " \t*_`~'\"“”‘’«»[](){}<>\\|,;:.!?-–—•·"


def clean_name(raw: str | None) -> str:
    """A person's name without markdown or list noise: "[Ishaan Gupta](mailto:x@y)" → "Ishaan Gupta",
    "**Bo Chen**," → "Bo Chen", "\\[Priya\\]" → "Priya", "'Ravi Kumar'" → "Ravi Kumar". "" when nothing
    readable is left (an address alone stays an address: :func:`person_of` names it)."""
    n = (raw or "").replace("\u00a0", " ").replace("\u200b", "").replace("\ufeff", "")
    n = _MD_LINK.sub(lambda m: m.group(1) or m.group(2), n)
    n = re.sub(r"\bmailto:", "", n, flags=re.I)
    n = re.sub(r"\\(.)", r"\1", n)                  # markdown escapes: \[ \_ \*
    n = re.sub(r"[*_`~]{2,}|(?<!\w)[*_`~]|[*_`~](?!\w)", "", n)
    n = re.sub(r"\[|\]|[<>{}]", " ", n)
    n = re.sub(r"\(\s*\)", " ", n)
    n = re.sub(r"\s+", " ", n).strip(_EDGE).strip()
    # A lone bracket left over from a cut link: "(Ishaan Gupta" → "Ishaan Gupta".
    if n.count("(") != n.count(")"):
        n = n.replace("(", " ").replace(")", " ")
        n = re.sub(r"\s+", " ", n).strip(_EDGE).strip()
    return n[:60] if any(ch.isalnum() for ch in n) else ""


def person_of(raw: str | None) -> dict | None:
    """One person as written ("Name <email>", "[Name](mailto:email)", "email", "Name") →
    {name, email} with a clean name (the address's local part when no name), or None."""
    text = (raw or "").strip()
    email = None
    m = _MD_LINK.search(text)
    if m and re.fullmatch(_EMAIL, m.group(2) or ""):
        email = m.group(2)
    if email is None:
        em = re.search(_EMAIL, text)
        email = em.group(0) if em else None
    if email:
        text = text.replace(email, " ")
        email = email.strip(".'").lower()
    name = clean_name(text)
    if not name and email:
        name = email.split("@")[0]
    return {"name": name, "email": email} if name else None


def people_in(text: str) -> list[dict]:
    """The people on an "Attendees" / "Invited" line: comma or "and" separated, or people chips one
    after another with no separator ("[A B](mailto:a@x) [C D](mailto:c@x)", "A B <a@x> C D <c@x>")."""
    items: list[dict | None] = []

    def hold(raw: str) -> str:
        items.append(person_of(raw))
        return f",\x00{len(items) - 1}\x00,"

    rest = _MD_LINK.sub(lambda m: hold(m.group(0)), text or "")
    rest = _ANGLE.sub(lambda m: hold(m.group(0)), rest)
    out: list[dict] = []
    for part in re.split(r"[,;]|\s+and\s+|\s+&\s+", rest):
        held = re.fullmatch(r"\s*\x00(\d+)\x00\s*", part)
        p = items[int(held.group(1))] if held else person_of(part) if part.strip() else None
        if p:
            out.append(p)
    return dedupe_people(out)


def dedupe_people(people: list[dict]) -> list[dict]:
    """Once each: the same address, or the same name (case-insensitive); an address joins the
    entry that had none."""
    out: list[dict] = []
    for p in people:
        name, email = p.get("name") or "", (p.get("email") or "").lower() or None
        hit = next((x for x in out if (email and x.get("email") == email)
                    or (name and x["name"].casefold() == name.casefold())), None)
        if hit is None:
            out.append({**p, "name": name, "email": email})
        elif email and not hit.get("email"):
            hit["email"] = email
    return out


def _cut(text: str) -> list[str]:
    """A long turn → pieces of at most MAX_SEGMENT_CHARS, cut at sentence ends when possible."""
    text = text.strip()
    if len(text) <= MAX_SEGMENT_CHARS:
        return [text] if text else []
    out, cur = [], ""
    for sent in re.split(r"(?<=[.!?])\s+", text):
        while len(sent) > MAX_SEGMENT_CHARS:
            if cur:
                out.append(cur)
                cur = ""
            out.append(sent[:MAX_SEGMENT_CHARS])
            sent = sent[MAX_SEGMENT_CHARS:]
        if len(cur) + len(sent) + 1 > MAX_SEGMENT_CHARS and cur:
            out.append(cur)
            cur = sent
        else:
            cur = f"{cur} {sent}".strip()
    if cur:
        out.append(cur)
    return out


def _finish(segs: list[dict], *, merge: bool) -> tuple[list[dict], bool]:
    """Merge short consecutive cues of one speaker, cut long ones, cap the total."""
    merged: list[dict] = []
    for s in segs:
        text = re.sub(r"\s+", " ", s.get("text") or "").strip()
        if not text:
            continue
        sp = s.get("speaker") or None
        prev = merged[-1] if merged else None
        if merge and prev and prev["speaker"] == sp and len(prev["text"]) + len(text) < MERGE_CHARS:
            prev["text"] = f"{prev['text']} {text}"
            continue
        merged.append({"speaker": sp, "t": s.get("t"), "text": text})
    out: list[dict] = []
    total = 0
    truncated = False
    for s in merged:
        for piece in _cut(s["text"]):
            if len(out) >= MAX_SEGMENTS or total + len(piece) > MAX_TEXT:
                truncated = True
                break
            out.append({"speaker": s["speaker"], "t": s["t"], "text": piece})
            total += len(piece)
        if truncated:
            break
    return out, truncated


# ── Dates and titles ──────────────────────────────────────────────────────────

_ISO_DT = re.compile(r"(\d{4})[-/_.](\d{1,2})[-/_.](\d{1,2})(?:[ T_]+(\d{1,2})[:_.](\d{2}))?")
_MDY = re.compile(r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b", re.I)
_DMY = re.compile(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b", re.I)
_CLOCK = re.compile(r"\b(\d{1,2}):(\d{2})\s*(am|pm)?\b", re.I)


def find_date(text: str | None) -> tuple[str | None, str | None]:
    """The first date (and a time right after it) in ``text``: ("2026-11-04", "10:00")."""
    if not text:
        return None, None
    best: tuple[int, str, str | None] | None = None
    for m in _ISO_DT.finditer(text):
        try:
            d = date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
        except ValueError:
            continue
        t = f"{int(m.group(4)):02d}:{m.group(5)}" if m.group(4) and int(m.group(4)) < 24 else None
        best = (m.start(), d, t)
        break
    for rx, order in ((_MDY, "mdy"), (_DMY, "dmy")):
        m = rx.search(text)
        if not m:
            continue
        try:
            if order == "mdy":
                d = date(int(m.group(3)), _MONTHS[m.group(1)[:3].lower()], int(m.group(2))).isoformat()
            else:
                d = date(int(m.group(3)), _MONTHS[m.group(2)[:3].lower()], int(m.group(1))).isoformat()
        except (ValueError, KeyError):
            continue
        if best is None or m.start() < best[0]:
            t = None
            c = _CLOCK.search(text, m.end(), m.end() + 20)
            if c:
                h = int(c.group(1)) % 12 + (12 if (c.group(3) or "").lower() == "pm" else 0) if c.group(3) else int(c.group(1))
                if h < 24:
                    t = f"{h:02d}:{c.group(2)}"
            best = (m.start(), d, t)
    return (best[1], best[2]) if best else (None, None)


_TITLE_JUNK = [
    re.compile(r"\s*[-–—:]\s*(?:transcript|notes by gemini|meeting notes|notes)\s*$", re.I),
    re.compile(r"^\s*(?:transcript|notes by gemini|meeting notes|notes)\s*[-–—:]\s*", re.I),
    re.compile(r"\s*\((?:[^()]*\d{4}[^()]*)\)\s*"),
    re.compile(r"\s*[-–—]\s*\d{4}[-/_.]\d{1,2}[-/_.]\d{1,2}(?:[ T_]+\d{1,2}[:_.]\d{2})?(?:\s*[A-Z]{2,5}(?:[+-]\d{1,2}(?::?\d{2})?)?)?\s*"),
    re.compile(r"\s*[-–—,]?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\s*", re.I),
    re.compile(r"\.(?:txt|vtt|srt|sbv|docx|md)$", re.I),
]


def clean_title(title: str | None) -> str | None:
    """A meeting's name without Google's suffixes, dates and file extensions."""
    if not title:
        return None
    t = title.strip().strip("#").strip()
    for _ in range(3):
        before = t
        for rx in _TITLE_JUNK:
            t = rx.sub(" ", t).strip()
        if t == before:
            break
    t = re.sub(r"[_]+", " ", t)
    t = re.sub(r"\s+", " ", t).strip(" -–—:")
    return t[:150] or None


def title_key(title: str | None) -> str:
    t = (clean_title(title) or "").casefold()
    return re.sub(r"[^a-z0-9\u00c0-\uffff]+", " ", t).strip()


# ── Notes (Gemini "Take notes for me") ────────────────────────────────────────


def _head_kind(line: str) -> str | None:
    """Which notes section a line opens ("summary" | "details" | "next_steps"), if it's a heading."""
    m = _HEADING.match(line)
    text = (m.group(1) if m else line).strip().strip("*").strip().rstrip(":").strip()
    if len(text) > 40:
        return None
    t = re.sub(r"^[^\w]+", "", text).casefold()
    for kind, names in NOTES_HEADS.items():
        if t in names:
            return kind
    return None


def _strip_bullet(line: str) -> str:
    m = _CHECK.match(line) or _BULLET.match(line)
    return (m.group(1) if m else line).strip()


def notes_span(lines: list[str]) -> set[int]:
    """The indices of the lines that belong to a notes section (Summary / Details / Suggested next
    steps / Action items, their headings included), the way :func:`parse_notes` reads them: never a
    transcript's turns (a Gemini next step "Nikhil Bansal Review Video: Nikhil Bansal will …" reads
    like a speaker's line, owner 2026-11-06)."""
    out: set[int] = set()
    sect: str | None = None
    for i, raw in enumerate(lines):
        line = _clean_line(raw)
        if _head_kind(line):
            sect = "on"
            out.add(i)
            continue
        if sect is None:
            continue
        if _HEADING.match(line) or _is_transcript_heading(line):
            sect = None
            continue
        out.add(i)
    return out


def parse_notes(lines: list[str]) -> dict | None:
    """{summary, details, next_steps} from the lines of a notes document (None: not notes)."""
    sect: str | None = None
    buf: dict[str, list[str]] = {"summary": [], "details": [], "next_steps": []}
    seen: set[str] = set()
    for raw in lines:
        line = _clean_line(raw)
        k = _head_kind(line)
        if k:
            sect = k
            seen.add(k)
            continue
        if sect is None:
            continue
        if (_HEADING.match(line) and not k) or _is_transcript_heading(line):
            sect = None   # some other section (e.g. the transcript tab's heading)
            continue
        if _GEMINI_BOILER.match(line.strip()) or _DATE_ONLY.match(line.strip()) or GEMINI_EMPTY.match(line.strip()):
            continue    # Google's notices; the date line under Gemini's "📝 Notes" label
        buf[sect].append(line)
    if "summary" not in seen or not (seen & {"details", "next_steps"}):
        return None

    def items(ls: list[str]) -> list[str]:
        out: list[str] = []
        for line in ls:
            if not line.strip():
                continue
            if _BULLET.match(line) or _CHECK.match(line) or not out:
                out.append(_strip_bullet(line))
            elif line.startswith((" ", "\t")):
                out[-1] = f"{out[-1]} {line.strip()}"
            else:
                out.append(line.strip())
        return [re.sub(r"\s+", " ", x).strip() for x in out if x.strip()][:80]

    summary = "\n\n".join(p.strip() for p in "\n".join(buf["summary"]).strip().split("\n\n") if p.strip())
    return {"summary": summary[:6000], "details": items(buf["details"]), "next_steps": items(buf["next_steps"])}


# ── Transcripts ───────────────────────────────────────────────────────────────


def _vtt(lines: list[str]) -> list[dict]:
    segs: list[dict] = []
    i = 0
    while i < len(lines):
        m = _VTT_CUE.match(lines[i])
        if not m:
            i += 1
            continue
        t = to_seconds(lines[i].split("-->")[0].strip())
        i += 1
        text_lines = []
        while i < len(lines) and lines[i].strip():
            text_lines.append(lines[i].strip())
            i += 1
        text = " ".join(text_lines)
        speaker = None
        v = _VOICE.search(text)
        if v:
            speaker = clean_speaker(v.group(1))
        text = _TAGS.sub("", text).strip()
        if speaker is None:
            sm = _SPEAKER.match(text)
            if sm and _plausible_name(sm.group("name")):
                speaker, text = clean_speaker(sm.group("name")), sm.group("text")
        segs.append({"speaker": speaker, "t": t, "text": text})
    return segs


def _sbv(lines: list[str]) -> list[dict]:
    segs: list[dict] = []
    i = 0
    while i < len(lines):
        m = _SBV_CUE.match(lines[i])
        if not m:
            i += 1
            continue
        t = to_seconds(m.group(1))
        i += 1
        text_lines = []
        while i < len(lines) and lines[i].strip():
            text_lines.append(lines[i].strip())
            i += 1
        text = " ".join(text_lines)
        speaker = None
        sm = _SPEAKER.match(text) or re.match(r"^>>\s*(?P<name>[^:]{1,60}):\s*(?P<text>.*)$", text)
        if sm and _plausible_name(sm.group("name")):
            speaker, text = clean_speaker(sm.group("name")), sm.group("text")
        segs.append({"speaker": speaker, "t": t, "text": text})
    return segs


def _otter(lines: list[str]) -> list[dict]:
    segs: list[dict] = []
    cur: dict | None = None
    for raw in lines:
        line = raw.strip()
        m = _OTTER.match(raw.rstrip()) or _OTTER_NAME_FIRST.match(line)
        if m and _plausible_name(m.group("name")):
            cur = {"speaker": clean_speaker(m.group("name")), "t": to_seconds(m.group("ts")), "text": ""}
            segs.append(cur)
            continue
        if not line or cur is None:
            continue
        cur["text"] = f"{cur['text']} {line}".strip()
    return segs


# Header / footer labels of meeting documents ("Organizer: Gautam Kumar", "Duration: 42 min", "Meeting
# ID: abc-defg-hij"). Written "Label: value" they look like a speaker's turn.
_META_LABELS = frozenset("""
organizer organiser organizers organisers organized-by organised-by meeting-organizer meeting-organiser
host hosts co-host co-hosts cohost hosted-by meeting-host
attendees attendee invited invitees invitee guests guest-list participants present absent optional required
date time when where location room duration length start start-time started end end-time ended time-zone timezone
meeting-date meeting-time meeting-id meeting-code meeting-link meeting-url join-link joining-link joining-info
dial-in passcode recording recordings recorded-by transcript transcription notes meeting-notes notes-by
agenda title meeting-title subject calendar calendar-event created-by
""".split())
_META_EMAIL_URL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+|https?://|\bwww\.|\bmeet\.google\.com\b", re.I)
_META_CODE = re.compile(r"\b[a-z]{3}-[a-z]{4}-[a-z]{3}\b", re.I)
_META_SPAN = re.compile(r"^\d+(?:\.\d+)?\s*(?:h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)\b", re.I)
# Labels that are also what a transcript calls someone ("Host: Welcome, everyone."): a turn when it reads as speech.
_SPEAKABLE = frozenset(("host", "hosts", "co-host", "co-hosts", "cohost", "meeting-host"))
_NAME_WORD = re.compile(r"^(?:[A-ZÀ-ɏ][\w'.À-ɏ-]*|de|da|van|von|der|bin|al|la|le|del|di)$")


def _meta_label(name: str) -> str | None:
    """The metadata label a would-be speaker name is ("organizer", "meeting-id"), else None."""
    n = re.sub(r"^[#>\-*•_\s]+|[*_\s]+$", "", name or "").casefold()
    key = re.sub(r"[\s_-]+", "-", n)
    return key if key in _META_LABELS else None


def _meta_value(value: str, known: set[str]) -> bool:
    """Whether what follows a label is clearly metadata: a date, a time, a length, an address, a link, a
    meeting code or ID, or a list of people's names (known speakers, or Title Case full names)."""
    v = (value or "").strip().strip("*_").strip()
    if not v:
        return True
    if _META_EMAIL_URL.search(v) or _META_CODE.search(v) or _META_SPAN.match(v) or find_date(v)[0] \
            or re.search(r"\b\d{1,2}:\d{2}\b", v):
        return True
    compact = re.sub(r"[\s()+-]", "", v)
    if compact and sum(ch.isdigit() for ch in compact) * 2 >= len(compact):
        return True
    if v.endswith((".", "?", "!")):
        return False
    parts = [p.strip() for p in re.split(r"[,;]|\s+and\s+|\s+&\s+", v) if p.strip()]
    if not parts:
        return False
    for p in parts:
        if clean_speaker(p).casefold() in known:
            continue
        words = p.split()
        if not (2 <= len(words) <= 4 and all(_NAME_WORD.match(w) for w in words)):
            return False
    return True


def _speech(value: str, known: set[str]) -> bool:
    """Whether what follows a label reads as someone talking (a sentence, or four words or more)."""
    v = (value or "").strip()
    return not _meta_value(v, known) and (v.endswith((".", "?", "!", "…")) or len(v.split()) >= 4)


def _turn(line: str) -> tuple[str, str, bool] | None:
    """(name, text, timestamped) when ``line`` reads as a speaker's turn, the way _speaker_lines reads it."""
    nm = _NAME_TS.match(line)
    if nm and _plausible_name(nm.group("name")):
        return nm.group("name"), nm.group("text"), True
    rest, stamped = line, False
    bt = _BRACKET_TS.match(line)
    if bt and to_seconds(bt.group("ts")) is not None and (line.startswith(("[", "(")) or _SPEAKER.match(bt.group("rest"))):
        rest, stamped = bt.group("rest"), True
    sm = _SPEAKER.match(rest)
    if sm and _plausible_name(sm.group("name")):
        return sm.group("name"), sm.group("text"), stamped
    return None


def _meta_scan(lines: list[str]) -> tuple[dict[int, bool], set[int]]:
    """Which "Label: value" lines are metadata, not someone speaking. (drop, text): ``drop`` maps a
    metadata line's index to whether it's in the header / footer; ``text`` are not a new turn (the words
    stay with the turn before).

    A label line ("Organizer: …", "Duration: …") before the first real turn or after the last one (the
    header and footer) is metadata; in the middle, it's metadata when its value clearly is (a date, a
    link, a list of the call's people…), else plain words. A label is someone speaking after all when
    it takes two or more turns that aren't metadata, or a "Host: …" line reads as speech ("Host:
    Welcome, everyone."); timestamped turns always are. Then only its header / footer lines with a
    metadata value ("Host: Gautam Kumar") are dropped."""
    turns: list[tuple[int, str | None, str, bool]] = []
    known: set[str] = set()
    for i, raw in enumerate(lines):
        line = _clean_line(raw).strip()
        if not line or _GOOGLE_META.match(line):
            continue
        tr = _turn(line)
        if tr is None:
            sm = _SPEAKER.match(line)   # "Meeting notes: …", "Date: …": never names, still metadata
            tr = (sm.group("name"), sm.group("text"), False) if sm and _meta_label(sm.group("name")) else None
        if tr:
            lab = _meta_label(tr[0])
            turns.append((i, lab, tr[1], tr[2]))
            if not lab:
                known.add(clean_speaker(tr[0]).casefold())
    if not any(lab for _i, lab, _v, _s in turns):
        return {}, set()
    speaking: dict[str, int] = {}
    for _i, lab, v, stamped in turns:
        if lab and (stamped or not _meta_value(v, known)):
            speaking[lab] = speaking.get(lab, 0) + 1
    real = {lab for lab, n in speaking.items() if n >= 2}

    def speaks(lab: str, v: str) -> bool:
        return (lab in real and not _meta_value(v, known)) or (lab in _SPEAKABLE and _speech(v, known))

    anchors = [i for i, lab, v, stamped in turns if not lab or stamped or speaks(lab, v)]
    first, last = (anchors[0], anchors[-1]) if anchors else (len(lines), -1)
    drop: dict[int, bool] = {}
    text: set[int] = set()
    for i, lab, v, stamped in turns:
        if not lab or stamped:
            continue
        edge = i < first or i > last
        if lab in real or speaks(lab, v):
            if edge and _meta_value(v, known):
                drop[i] = True
        elif edge or _meta_value(v, known):
            drop[i] = edge
        else:
            text.add(i)
    return drop, text


def _speaker_lines(lines: list[str]) -> tuple[list[dict], bool]:
    """Google Meet transcripts and every "Name: text" style. (segments, google_style_time_marks)."""
    segs: list[dict] = []
    t_mark: int | None = None
    marks = 0
    cur: dict | None = None
    meta_drop, meta_text = _meta_scan(lines)
    for idx, raw in enumerate(lines):
        line = _clean_line(raw).strip()
        if not line:
            continue
        if idx in meta_drop:
            # Metadata ends a turn in the header and footer; in the middle the turn goes on around it.
            if meta_drop[idx]:
                cur = None
            continue
        if idx in meta_text:
            if cur is not None:
                cur["text"] = f"{cur['text']} {line}".strip()
            else:
                cur = {"speaker": None, "t": t_mark, "text": line, "_mark": True}
                segs.append(cur)
            continue
        if _GOOGLE_META.match(line):
            cur = None
            continue
        if _GEMINI_BOILER.match(line) and not _SPEAKER.match(line):
            continue
        # The footer pasted onto the last line ("… sounds good. Transcription ended after 00:42:13").
        line = _ENDED_TAIL.sub("", line)
        if not line:
            cur = None
            continue
        bm = _BARE_TS.match(line)
        if bm:
            t_mark = to_seconds(bm.group(1))
            marks += 1
            cur = None
            continue
        nm = _NAME_TS.match(line)
        if nm and _plausible_name(nm.group("name")):
            cur = {"speaker": clean_speaker(nm.group("name")), "t": to_seconds(nm.group("ts")),
                   "text": nm.group("text").strip()}
            segs.append(cur)
            continue
        t = None
        rest = line
        bt = _BRACKET_TS.match(line)
        if bt and to_seconds(bt.group("ts")) is not None and (line.startswith(("[", "(")) or _SPEAKER.match(bt.group("rest"))):
            t, rest = to_seconds(bt.group("ts")), bt.group("rest")
        sm = _SPEAKER.match(rest)
        if sm and _plausible_name(sm.group("name")):
            cur = {"speaker": clean_speaker(sm.group("name")), "t": t if t is not None else t_mark,
                   "text": sm.group("text").strip(), "_mark": t is None}
            segs.append(cur)
            continue
        if cur is not None:
            cur["text"] = f"{cur['text']} {rest}".strip()
        else:
            cur = {"speaker": None, "t": t if t is not None else t_mark, "text": rest, "_mark": t is None}
            segs.append(cur)
    if marks:
        # Google stamps the first mark at 05:00: what came before it started at 0.
        for s in segs:
            if s.get("_mark") and s["t"] is None:
                s["t"] = 0
    return segs, marks > 0


def _skip_header(lines: list[str]) -> list[str]:
    """Drop a short header (title, "Organizer: …", "Attendees", "Transcript", Google's notice) before the
    first speaker line."""
    drop, text = _meta_scan(lines)
    for i, raw in enumerate(lines[:40]):
        if i in drop or i in text:
            continue
        line = _clean_line(raw).strip()
        sm = _SPEAKER.match(line)
        if (sm and _plausible_name(sm.group("name")) and not re.match(r"^(attendees|invited|participants)\b", line, re.I)) \
                or _BARE_TS.match(line) or _NAME_TS.match(line):
            head = [x for j, x in enumerate(lines[:i]) if x.strip() and j not in drop]
            if len(head) <= 12 and all(len(x) < 300 for x in head):
                return lines[i:]
            return lines
    return lines


def _interpolate(segs: list[dict], end_s: int | None) -> bool:
    """Google Meet only stamps every five minutes: spread each block's time over its turns by characters.
    True when any time was interpolated."""
    changed = False
    i = 0
    while i < len(segs):
        if not segs[i].pop("_mark", False):
            i += 1
            continue
        j = i
        while j < len(segs) and segs[j].get("_mark", j == i) and segs[j]["t"] == segs[i]["t"]:
            segs[j].pop("_mark", None)
            j += 1
        start = segs[i]["t"]
        nxt = segs[j]["t"] if j < len(segs) else end_s
        if start is not None and nxt is not None and nxt > start and j - i > 1:
            total = sum(len(s["text"]) for s in segs[i:j]) or 1
            acc = 0
            for s in segs[i:j]:
                s["t"] = start + int((nxt - start) * acc / total)
                acc += len(s["text"])
            changed = True
        i = max(j, i + 1)
    for s in segs:
        s.pop("_mark", None)
    return changed


_ORGANIZER = re.compile(r"^(?:#+\s*)?(?:[-*]\s*)?(?:\*\*)?(?:meeting\s+)?(?:organi[sz]er|organi[sz]ed\s+by|host|hosted\s+by)"
                        r"(?:\*\*)?\s*:?(?:\*\*)?\s+(.+)$", re.I)


def organizer_in(text: str) -> dict | None:
    """Who organized the call, where the text says so ("Organizer: Nikhil Rao <nikhil@…>",
    "Hosted by …"), in its first lines: {name, email} or None. Never guessed from anything else, and
    never a turn of someone called "Host" ("Host: Welcome, everyone.")."""
    lines = (text or "").split("\n")
    drop, _text = _meta_scan(lines)
    for i, raw in enumerate(lines[:80]):
        line = _clean_line(raw).strip()
        m = _ORGANIZER.match(line)
        if not m or (i not in drop and _turn(line)):
            continue
        first = (people_in(m.group(1).strip()) or [{}])[0]
        email = first.get("email")
        name = first.get("name") or None
        if name and email and name == email.split("@")[0]:
            name = None
        if name and not _plausible_name(name):
            name = None
        if name or email:
            return {"name": name or (email or "").split("@")[0], "email": email}
    return None


# ── Who was there (owner, 2026-11-06) ────────────────────────────────────────
# Google's Gemini notes start with "Invited <chips>": everyone on the calendar invite, joined or not (a
# daily sync-up showed "27 people" for 12). A Meet transcript Doc's "Attendees" line is who joined, and
# the transcript's speakers joined too. So a meeting's attendees are an Attendees list when a source has
# one (plus speakers it doesn't name), else its speakers; the invite list is kept apart as ``invited``.
# A label's value is taken only when it reads as a list of names: never the paragraph after it.
_PEOPLE_LABEL = re.compile(
    r"^(?:#+\s*)?(?:[-*•]\s+)?(?:\*\*|__)?(?P<label>attendees|attendee|participants|present|invited|invitees|guests)"
    r"\s*:?(?:\*\*|__)?(?:\s*:\s*|\s+|$)(?P<rest>.*)$", re.I)
_JOINED = frozenset(("attendees", "attendee", "participants", "present"))
_STOP = frozenset("""
the a an to of for with and or but is are was were be been being has have had do does did done this that these
those it its we our us they their them he she his her him you your i me my on in at by from about into over under
as if then than so not no yes also just all any each every some discussed agreed reviewed decided shared talked
noted mentioned asked said says meeting meetings team call update updates project plan should would could need needs
going will following following: today tomorrow yesterday week next last regarding including during after before
attachments attachment records recording recordings transcript transcripts notes summary details invited attendees
""".split()) - {"will"}
_MORE = re.compile(r"^(?:and\s+)?(?:\+\s*)?\d+\s+(?:more|others?|other people|guests?)$", re.I)


def name_like(name: str | None) -> bool:
    """A person's name, not words: 1-5 words, no sentence punctuation at the end, none of the little
    words sentences are made of ("discussed the plan" is not a name; "Saurabh Kr. Singh",
    "Rahul bhai", "anand.k" are)."""
    n = (name or "").strip()
    if not n or len(n) > 50 or "http" in n.lower() or not any(ch.isalpha() for ch in n):
        return False
    words = n.split()
    if len(words) > 5 or n.endswith(("?", "!", ":", ";")) or (n.endswith(".") and len(words[-1]) > 3):
        return False
    if sum(ch.isdigit() for ch in n) > 2:
        return False
    low = [re.sub(r"[^\w]+", "", w).casefold() for w in words]
    if low[0] in _NOT_NAMES or n.casefold() in _NOT_NAMES:
        return False
    return not any(w in _STOP for w in low if w)


# ── "<Owner Name> <Task Title>" (Gemini's next steps, owner 2026-11-06) ──────────
# Gemini writes a next step as "Nikhil Bansal Review Video: Nikhil Bansal will review the video …".
# Read as a speaker's turn it made "Nikhil Bansal Review Video" an attendee (51 of 166 meetings). The
# label is a known person's name followed by a Title Case task, or the words after the colon start with
# the label's first words (the owner, said again).
_TASK_SMALL = frozenset("a an and as at by for from in into of on or per the to via vs with & + - / –".split())
TASK_MAX_WORDS = 4      # a speaker label longer than this is not a name in a notes Doc


def _wkey(w: str) -> str:
    return re.sub(r"[^\w]+", "", w).casefold()


def _task_words(words: list[str]) -> bool:
    """A task title: Title Case words ("Review Video", "Fix Email Bug", "Share PRD with Team")."""
    if not words or not (words[0][:1].isupper() or words[0][:1].isdigit()):
        return False
    return all(w[:1].isupper() or w[:1].isdigit() or w.casefold() in _TASK_SMALL for w in words)


def task_owner(label: str | None, text: str | None = None, known: list[str] | tuple = ()) -> str | None:
    """The owner when ``label`` is "<Owner Name> <Task Title>" rather than a name, else None:

    * the longest known person's name (2+ words; ``known``: the invite, the attendees, the members)
      that starts it, followed by a Title Case task;
    * else the longest start of it (1-3 words) that the words after the colon (``text``) start with,
      followed by a Title Case task ("Meera Kapoor Fix Email Bug" / "Meera Kapoor will fix …"); the label
      is 3+ words then, so "Bo Chen" saying "Bo, can you …" is never a task.

    Never fuzzy: "Mohd Arif Khan" is a task of "Mohd Arif" only when "Khan" reads as a task title."""
    words = clean_name(label).split()
    if len(words) < 2:
        return None
    keys = [_wkey(w) for w in words]
    best: list[str] | None = None
    for k in known or ():
        kw = clean_name(k).split()
        if len(kw) < 2 or len(kw) >= len(words):
            continue
        if keys[:len(kw)] == [_wkey(w) for w in kw] and (best is None or len(kw) > len(best)):
            best = kw
    def rest_ok(rest: list[str]) -> bool:
        # A task title: it starts with a verb ("Create navbar iteration"), or is Title Case words when
        # the whole label can't be a name ("Lavanya Rao Security Testing", never "Saurabh Kr. Singh").
        return bool(rest) and rest[0][:1].isupper() and \
            (_wkey(rest[0]) in _TASK_VERBS or (_task_words(rest) and not _person_shape(words)))

    if best and rest_ok(words[len(best):]):
        return " ".join(words[:len(best)])
    if text and len(words) >= 3:
        tkeys = [_wkey(w) for w in str(text).split()[:4]]
        for n in range(min(3, len(words) - 1), 0, -1):
            if keys[:n] != tkeys[:n]:
                continue
            # "Siddharth Menon Update Prompts: Siddharth will …": a first name said again, a full name in
            # the label (a task is rarely one word when the label is 4+).
            if n == 1 and len(words) >= 4 and name_like(" ".join(words[:2])) and \
                    _wkey(words[1]) not in _TASK_VERBS and rest_ok(words[2:]):
                return " ".join(words[:2])
            if rest_ok(words[n:]):
                return " ".join(words[:n])
    return None


def owner_of_step(step: str | None, known: list[str] | tuple = ()) -> str | None:
    """A next step's owner: "Nikhil Bansal Review Video: Nikhil Bansal will …" → "Nikhil Bansal" (a
    known person's name at its start, the label's owner, or the first 2-3 capitalised words followed by
    a Title Case task); None when it doesn't name one."""
    s = clean_name(step) if step and "](" in step else (step or "").strip()
    head, sep, rest = s.partition(":")
    if sep and len(head.split()) <= 8:
        owner = task_owner(head, rest, known)
        if owner:
            return owner
    words = s.split()
    for k in sorted((clean_name(x) for x in known or ()), key=lambda x: -len(x.split())):
        kw = k.split()
        if kw and [_wkey(w) for w in words[:len(kw)]] == [_wkey(w) for w in kw]:
            return k
    if sep:
        hw = head.split()
        for n in (2, 3):
            if len(hw) > n and all(w[:1].isupper() for w in hw[:n]) and _task_words(hw[n:]) and name_like(" ".join(hw[:n])):
                return " ".join(hw[:n])
    return None


def _says_owner(text: str | None, owner: str) -> bool:
    """The words after the colon start with the owner's name (Gemini: "<Owner> will …")."""
    ow = [_wkey(w) for w in owner.split()]
    return bool(ow) and [_wkey(w) for w in str(text or "").split()[:len(ow)]] == ow


def read_turns(segments: list[dict], universe: Universe, known: list[str] | tuple = (), *,
               notes_doc: bool = False) -> dict:
    """What a transcript's speaker labels are (:func:`task_shaped`), and the segments without the ones
    that aren't anyone's turn: {segments, steps, details, labels, whole}.

    * Half or more of the labels (2+) are "<Person> <task words>": the whole "transcript" is Gemini's
      notes read as turns (prod: 43 sync-ups): no segments; the task lines are next steps, the rest
      details (``whole``).
    * Else, in a notes Doc, a task line whose words name the owner again and a label that's no one
      (a heading, longer than a name) are next steps; elsewhere the owner is the speaker.

    ``labels``: {label: the owner, or None (nobody)} for every label that isn't a person's name."""
    first: dict[str, str] = {}
    for s in segments:
        sp = s.get("speaker")
        if sp and sp not in first:
            first[sp] = s.get("text") or ""
    shape = {sp: task_shaped(sp, text, universe, known) for sp, text in first.items()}
    task = [sp for sp, sh in shape.items() if isinstance(sh, str)]
    labels = {sp: (sh if isinstance(sh, str) else None) for sp, sh in shape.items() if sh is not False}
    whole = len(task) >= 2 and len(task) * 2 >= len(shape)
    out: list[dict] = []
    steps: list[str] = []
    details: list[str] = []
    for s in segments:
        sp = s.get("speaker")
        text = (s.get("text") or "").strip()
        line = f"{clean_name(sp)}: {text}" if sp else text
        if whole:
            (steps if sp in task else details).append(line)
            continue
        if not sp or sp not in labels:
            out.append(s)
            continue
        owner = labels[sp]
        long = len(clean_name(sp).split()) > TASK_MAX_WORDS
        if notes_doc and ((owner and _says_owner(text, owner)) or (owner is None and (long or topicish(sp)))):
            steps.append(line) if owner else details.append(line)
            continue
        out.append({**s, "speaker": owner} if owner else s)
    return {"segments": out, "steps": steps, "details": details, "labels": labels, "whole": whole}


def doc_universe(people: list[dict], segments: list[dict]) -> Universe:
    """One Doc's people: its invite and Attendees line, and the names its labels keep starting with."""
    u = Universe(people)
    for n in mine_names([s.get("speaker") or "" for s in segments]):
        u.add({"name": n})
    return u


def clean_task_speakers(segments: list[dict], known: list[str] | tuple = (), *,
                        notes_doc: bool = False) -> tuple[list[dict], list[str], list[str]]:
    """(segments, next steps, details) with no "<Owner Name> <Task Title>" speaker: :func:`read_turns`
    against the Doc's own people (``known``: the invite and attendee names)."""
    got = read_turns(segments, doc_universe([{"name": k} for k in known or () if k], segments), known,
                     notes_doc=notes_doc)
    return got["segments"], got["steps"], got["details"]


def resolve_speaker(name: str | None, known: list[str] | tuple = (), text: str | None = None) -> str | None:
    """A speaker's name as a person: "Nikhil Bansal Review Video" → "Nikhil Bansal" (a known person
    followed by a task), the name itself when it reads as one, None when it doesn't (not a person)."""
    n = clean_name(name)
    if not n:
        return None
    owner = task_owner(n, text, known)
    if owner:
        return owner
    return n if name_like(n) else None


# ── The people a workspace knows (prod dry run, 2026-11-06) ────────────────────
# Gemini's next-step labels name people the meeting's invite often doesn't ("Lavanya Rao Audit
# Alerts", "Imran Establish Structure", "Harsha Vardhan Add images"). A label is read against every
# person the workspace knows (members, every invitee and attendee with an address, names that recur
# as a whole speaker label, and the two-word names Gemini's labels keep starting with); a label that
# starts with no one is not a person.
_TOPIC_WORDS = frozenset("""
daily weekly monthly sprint standup stand-up syncup sync-up sync product release client clients demo demos team project
customer customers sales design marketing security data model models sourcing review plan planning discussion update
workflow workflows automation assessment endpoint vulnerability positioning competitors pricing roadmap launch onboarding
integration integrations testing deployment infra infrastructure api apis ai ml ui ux qa gtm crm prd mvp bug bugs issue
issues feature features page pages website landing content strategy process flow flows dashboard report reports analytics
email emails interview interviews candidate candidates hiring meeting meetings call calls agenda summary details notes
action items next steps open questions decisions decision topic topics overview status video videos audio profile profiles
google slack zoom jira notion microsoft linkedin aws azure openai stripe knowledge transfer verification proctoring
recording recordings transcript transcripts payment payments billing documentation docs
""".split())
# The verbs Gemini's next-step titles start with ("Imran Establish Structure"): never a surname.
_TASK_VERBS = frozenset("""
add adjust align analyze analyse ask assess audit automate book build call capture check clean collaborate compare
conduct configure consolidate coordinate complete confirm connect contact create ensure get handle look post provide
reply upgrade
debug define deploy design discuss document draft enable escalate establish evaluate explore finalize finalise finish fix
follow gather implement improve integrate investigate launch list map merge migrate monitor move organize organise pair
plan prepare present prioritize prioritise publish push record reach refine release remove report research resolve
restructure retrain review run schedule send set setup share ship start submit sync test track train trim update upload
validate verify write
""".split())
# Word endings of headings ("Standardizing", "Proctoring", "Verification", "Deployment"), long enough that
# names like "Fleming", "Channing", "Clement", "Florence" are never read as one.
_TOPIC_ENDS = (("ing", 9), ("tion", 7), ("tions", 8), ("ment", 9), ("ments", 9), ("ology", 7))


def topicish(name: str | None) -> bool:
    """A heading, not a person: "Workflow Automation", "Standardizing Demo Flows", "AI Assessment
    Endpoint Security Vulnerability", "Positioning Acme versus Competitors"."""
    words = clean_name(name).split()
    if not words:
        return True
    low = [_wkey(w) for w in words]
    if any(len(w) > 1 and (w in _TOPIC_WORDS or w in _STOP or w in _NOT_NAMES) for w in low):
        return True
    # "Standardizing Demo", "Video Proctoring", "Profile Verification" ("Fleming", "Channing": short -ing)
    return any(len(w) >= n and w.endswith(suf) for w in low for suf, n in _TOPIC_ENDS)


def _person_shape(words: list[str]) -> bool:
    """Words that can be a person's name: 1-3 words, each capitalised (or a particle), not a heading."""
    if not 1 <= len(words) <= 3 or any(_wkey(w) in _TASK_VERBS for w in words[1:]):
        return False
    if not all(w[:1].isupper() or w.casefold() in ("bhai", "ji", "de", "da", "van", "von", "bin", "al") for w in words):
        return False
    return name_like(" ".join(words)) and not topicish(" ".join(words))


class Universe:
    """Everyone a workspace (or one Doc) knows: {name, email, user_id} once each, by full name.

    :meth:`owner` reads a label: the longest known full name it starts with (any case), else a first
    name only one known person has (or 4+ letters that start only one person's first name: "Bala" for
    "Balakrishnan R"), with how many words follow it."""

    def __init__(self, people: list[dict] | None = None):
        self.people: list[dict] = []
        self._by_key: dict[tuple, dict] = {}
        for p in people or []:
            self.add(p)

    def add(self, p: dict) -> None:
        name = clean_name(p.get("name"))
        if not name:
            return
        key = tuple(_wkey(w) for w in name.split())
        hit = self._by_key.get(key)
        if hit is None:
            e = {"name": name, "email": (p.get("email") or None), "user_id": p.get("user_id") or None}
            self._by_key[key] = e
            self.people.append(e)
        else:
            hit["email"] = hit.get("email") or p.get("email") or None
            hit["user_id"] = hit.get("user_id") or p.get("user_id") or None

    def names(self) -> list[str]:
        return [p["name"] for p in self.people]

    def get(self, name: str | None) -> dict | None:
        return self._by_key.get(tuple(_wkey(w) for w in clean_name(name).split()))

    def _first(self, word: str) -> dict | None:
        w = _wkey(word)
        if len(w) < 2:
            return None
        exact = [p for p in self.people if _wkey(p["name"].split()[0]) == w]
        if len(exact) == 1:
            return exact[0]
        if exact:
            return None
        if len(w) >= 4:
            pre = [p for p in self.people if _wkey(p["name"].split()[0]).startswith(w)]
            if len(pre) == 1:
                return pre[0]
        return None

    def owner(self, label: str | None) -> tuple[dict | None, int]:
        words = clean_name(label).split()
        keys = [_wkey(w) for w in words]
        for n in range(min(4, len(words)), 1, -1):
            hit = self._by_key.get(tuple(keys[:n]))
            if hit is not None:
                return hit, len(words) - n
        rest_task = len(words) == 1 or words[1][:1].islower() or keys[1] in _TASK_VERBS or \
            (len(words) >= 3 and not _person_shape(words[:2]))
        if words and words[0][:1].isupper() and rest_task:
            hit = self._by_key.get((keys[0],)) or self._first(words[0])
            if hit is not None:
                # "Tanvi Research Visitor Emails" is Shreya; "Tanvi Desai" (a surname, not a task) is not
                # whoever else is called Shreya.
                return hit, len(words) - 1
        return None, 0


def mine_names(labels: list[str]) -> list[str]:
    """Two-word names Gemini's labels keep starting with: "Lavanya Rao" from "Lavanya Rao Audit
    Alerts" and "Lavanya Rao Escalate Security" (two different continuations), never a heading's
    start ("Standardizing Demo")."""
    conts: dict[tuple, set[str]] = {}
    shown: dict[tuple, str] = {}
    for lab in labels:
        words = clean_name(lab).split()
        if len(words) < 3:
            continue
        head = words[:2]
        if not _person_shape(head):
            continue
        k = tuple(_wkey(w) for w in head)
        conts.setdefault(k, set()).add(_wkey(words[2]))
        shown.setdefault(k, " ".join(head))
    return [shown[k] for k, c in conts.items() if len(c) >= 2]


_BRACKET_OWNER = re.compile(r"^\W{0,4}\[([^\[\]]{2,120})\]\s*(\S.*)$")


def bracket_owners(label: str | None, universe: Universe | None = None) -> list[str]:
    """The owners Gemini's newer next steps put in brackets: "[Nikhil] Post Video", "[Nandini Pai,
    Imran Qureshi] Prepare Presentation" → the people they are (a known person by full or first name,
    else the bracketed name when it reads as one). [] when the label isn't that shape."""
    m = _BRACKET_OWNER.match(str(label or ""))
    if not m:
        return []
    out: list[str] = []
    for part in re.split(r",|\s+and\s+|\s*&\s*", m.group(1)):
        part = clean_name(part)
        if not part:
            continue
        hit, extra = universe.owner(part) if universe is not None else (None, 0)
        name = hit["name"] if hit is not None and not extra else part if _person_shape(part.split()) else None
        if name and name not in out:
            out.append(name)
    return out


def task_shaped(label: str | None, text: str | None, universe: Universe, known: list[str] | tuple = ()) -> str | None | bool:
    """What a speaker label is: the owner's name ("<Person> <task words>"), False for a person's name
    as it is, None for neither (a heading, a sentence, nobody known)."""
    n = clean_name(label)
    if not n:
        return None
    owners = bracket_owners(label, universe)
    if owners:
        return owners[0]
    hit, extra = universe.owner(n)
    if hit is not None:
        return hit["name"] if extra else False
    owner = task_owner(n, text, known)
    if owner:
        return owner
    words = n.split()
    if len(words) > TASK_MAX_WORDS or topicish(n):
        return None
    return False if _person_shape(words) else None


def clean_empty_notes(notes: dict | None) -> dict | None:
    """Gemini's notes without its placeholders for a call it couldn't summarise ("No suggested next
    steps were found for this meeting.", "A summary wasn't produced …"): they're not anyone's words."""
    if not notes or not any(GEMINI_EMPTY.match(str(x).strip()) for x in [
            *str(notes.get("summary") or "").split("\n\n"), *(notes.get("details") or []), *(notes.get("next_steps") or [])]):
        return notes
    paras = [p for p in str(notes.get("summary") or "").split("\n\n") if p.strip() and not GEMINI_EMPTY.match(p.strip())]
    out = {**notes, "summary": "\n\n".join(paras),
           "details": [d for d in notes.get("details") or [] if not GEMINI_EMPTY.match(str(d).strip())],
           "next_steps": [x for x in notes.get("next_steps") or [] if not GEMINI_EMPTY.match(str(x).strip())]}
    return out


def chip_people(text: str | None, *, at_least: int = 3) -> list[dict]:
    """People chips run along a line with no label ("### Daily Standup Nikhil Bansal <nikhil@…> Rohit
    Batra <rohit@…> …", newer Gemini notes): each chip's name (the name words right before the
    address) and address; [] for fewer than ``at_least`` chips."""
    out: list[dict] = []
    for m in _ANGLE.finditer(text or ""):
        words = clean_name(m.group(1)).split()
        name = next((" ".join(words[-k:]) for k in range(min(4, len(words)), 0, -1)
                     if _person_shape(words[-k:])), "")
        if name:
            out.append({"name": name, "email": m.group(2).lower()})
    out = dedupe_people(out)
    return out if len(out) >= at_least else []


def notes_text(notes: dict | None) -> str:
    """Everything Gemini's notes say (summary, details, next steps, and decisions when kept) as one text."""
    n = notes or {}
    parts = [n.get("summary") or "", *(n.get("details") or []), *(n.get("next_steps") or []),
             *[d if isinstance(d, str) else (d or {}).get("text") or "" for d in n.get("decisions") or []]]
    return "\n".join(str(p) for p in parts if p)


def named_in_notes(notes: dict | None, people: list[dict], *, first_names: bool = True) -> list[dict]:
    """Those of ``people`` (the invite) that Gemini's notes name, in order: a next step's owner, the full
    name anywhere (any case), or, with ``first_names``, a first name only one of them has (written with
    its capital: "Nikhil said …", never "will"). Owner 2026-11-06: a sync-up with only Gemini's notes
    lists the people they name as its attendees ("notes"); the rest of the invite stays invited."""
    text = notes_text(notes)
    if not text or not people:
        return []
    low = re.sub(r"\s+", " ", text).casefold()
    words = set(re.findall(r"[\w'-]+", text))
    names = [clean_name(p.get("name")) for p in people]
    firsts: dict[str, int] = {}
    for n in names:
        if n:
            f = n.split()[0].strip(".").casefold()
            firsts[f] = firsts.get(f, 0) + 1
    owners = {(owner_of_step(s, names) or "").casefold() for s in (notes or {}).get("next_steps") or []}
    out: list[dict] = []
    for p, n in zip(people, names):
        if not n:
            continue
        hit = n.casefold() in owners
        if not hit and len(n.split()) >= 2:
            hit = re.search(r"(?<![\w])" + re.escape(n.casefold()) + r"(?![\w])", low) is not None
        if not hit and first_names:
            f = n.split()[0].strip(".")
            hit = len(f) >= 3 and firsts.get(f.casefold()) == 1 and f[:1].isupper() and f in words \
                and f.casefold() not in _STOP and f.casefold() not in _NOT_NAMES
        if hit:
            out.append(p)
    return out


def _covers(a: str, b: str) -> bool:
    """One name is the other, or the start of it ("Gautam" / "Gautam Kumar")."""
    x, y = clean_name(a).casefold().split(), clean_name(b).casefold().split()
    if not x or not y:
        return False
    k = min(len(x), len(y))
    return x[:k] == y[:k]


def _split_glued(text: str, known: list[str]) -> list[dict] | None:
    """Names run together with nothing between them ("Gautam Kumar Ishaan Gupta Shreya Rao", people chips
    exported without their addresses): split at the known names (the transcript's speakers, 2+ words);
    the words between two known names are a name of their own when they read as one (1-3 words).
    None when no known name is in it (it can't be told apart)."""
    words = text.split()
    names = sorted({" ".join(k.split()) for k in known if len(k.split()) >= 2}, key=lambda k: -len(k.split()))
    out: list[dict] = []
    buf: list[str] = []
    hit = False

    def flush() -> bool:
        if not buf:
            return True
        chunk = " ".join(buf)
        buf.clear()
        if len(chunk.split()) > 3 or not name_like(chunk):
            return False
        out.append({"name": clean_name(chunk), "email": None})
        return True

    i = 0
    while i < len(words):
        for k in names:
            n = len(k.split())
            if " ".join(words[i:i + n]).casefold() == k.casefold():
                if not flush():
                    return None
                out.append({"name": k, "email": None})
                i += n
                hit = True
                break
        else:
            buf.append(words[i])
            i += 1
    if not flush() or not hit:
        return None
    return out


def names_list(text: str | None, known: list[str] | None = None) -> list[dict] | None:
    """The people in ``text`` when it is a list of people ("A, B and C", chips one after another,
    "Name <email>"…), else None: a sentence, a paragraph, a heading. "+3 more" is skipped."""
    t = (text or "").strip()
    if not t or len(t) > 8000:
        return None
    items: list[dict | None] = []

    def hold(raw: str) -> str:
        items.append(person_of(raw))
        return f",\x00{len(items) - 1}\x00,"

    rest = _MD_LINK.sub(lambda m: hold(m.group(0)), t)
    rest = _ANGLE.sub(lambda m: hold(m.group(0)), rest)
    out: list[dict] = []
    for part in re.split(r"[,;|]|\s+and\s+|\s+&\s+|\s{3,}|\t", rest):
        part = part.strip()
        if not part:
            continue
        held = re.fullmatch(r"\x00(\d+)\x00", part)
        if held:
            p = items[int(held.group(1))]
            if p is None or not (name_like(p["name"]) or p.get("email")):
                return None
            out.append(p)
            continue
        if _MORE.match(part):
            continue
        p = person_of(part)
        if p is None:
            continue
        if len(p["name"].split()) > 3 and not p.get("email"):
            glued = _split_glued(p["name"], known or [])
            if glued is None:
                return None
            out.extend(glued)
            continue
        if not name_like(p["name"]):
            return None
        out.append(p)
    return dedupe_people(out)[:200] or None


def people_lists(lines: list[str], known: list[str] | None = None) -> tuple[list[dict], list[dict]]:
    """(attendees, invited) as a document lists them: an "Attendees" / "Participants" / "Present" line
    (who joined) and an "Invited" / "Guests" line (the calendar invite), each with its names on the
    line or, for a label alone, on the lines right under it (one line of names, or a bulleted list).
    A value that isn't a list of names (a paragraph, a heading) is not taken."""
    joined: list[dict] = []
    invited: list[dict] = []
    for i, raw in enumerate(lines[:80]):
        line = _clean_line(raw).strip()
        m = _PEOPLE_LABEL.match(line)
        if not m:
            continue
        label, rest = m.group("label").casefold(), m.group("rest").strip()
        got: list[dict] | None = None
        if rest:
            got = names_list(rest, known)
        else:
            j = i + 1
            while j < len(lines) and j <= i + 2 and not _clean_line(lines[j]).strip():
                j += 1
            bullets: list[dict] = []
            k = j
            while k < len(lines) and _BULLET.match(_clean_line(lines[k])):
                p = names_list(_strip_bullet(_clean_line(lines[k])), known)
                if p is None or len(p) != 1:
                    bullets = []
                    break
                bullets.extend(p)
                k += 1
            if bullets:
                got = dedupe_people(bullets)
            elif j < len(lines) and not _HEADING.match(_clean_line(lines[j]).strip()):
                got = names_list(_clean_line(lines[j]).strip(), known)
        if not got:
            continue
        target = joined if label in _JOINED else invited
        if not target:
            target.extend(got)
    return joined[:200], invited[:200]


def _with_speakers(listed: list[dict], speakers: list[str], invited: list[dict]) -> list[dict]:
    """``listed`` and each speaker it doesn't name already; a speaker the invite names fuller
    ("Gautam" → "Gautam Kumar <gautam@…>") takes that name and address (members match by address)."""
    out = [dict(p) for p in listed]
    known = [p["name"] for p in [*listed, *invited] if p.get("name")] + \
        [clean_name(s) for s in speakers if 2 <= len(clean_name(s).split()) <= 3]
    for sp in speakers:
        # "Nikhil Bansal Review Video" (a next step read as a turn) is Nikhil Bansal; not a name: nobody.
        sp = resolve_speaker(sp, known) or ""
        if not sp or any(_covers(sp, p["name"]) for p in out):
            continue
        inv = [p for p in invited if _covers(sp, p["name"])]
        out.append(dict(inv[0]) if len(inv) == 1 else {"name": sp, "email": None})
    return dedupe_people(out)


# ── Detection ─────────────────────────────────────────────────────────────────


def _split_tabs(text: str) -> list[tuple[str | None, list[str]]]:
    tabs: list[tuple[str | None, list[str]]] = [(None, [])]
    for line in text.split("\n"):
        m = TAB_MARK.match(line.strip())
        if m:
            tabs.append((m.group(1).strip(), []))
        else:
            tabs[-1][1].append(line)
    return [t for t in tabs if any(x.strip() for x in t[1])] or [(None, [])]


# A Doc's section label, not its title: Gemini's notes open with "📝 Notes", transcripts with "📖 Transcript".
_SECTION_TITLE = re.compile(
    r"^(?:notes|meeting notes|notes by gemini|transcript|summary|details|suggested next steps|next steps|"
    r"attachments|meeting records|invited|attendees)$", re.I)


# A line that is only a date ("Nov 6, 2026", "6 Nov 2026", "2026/11/06"): Gemini puts one above the title.
_DATE_ONLY = re.compile(
    r"^(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?(?:[a-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[a-z]{3,9}\.?,?\s+\d{4}|"
    r"\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})$", re.I)


def _section_label(text: str) -> bool:
    if _DATE_ONLY.match(text.strip()):
        return True
    return bool(_SECTION_TITLE.match(re.sub(r"[^\w\s]", "", text, flags=re.UNICODE).strip()))


def _first_title(lines: list[str]) -> str | None:
    for raw in lines[:12]:
        line = _clean_line(raw).strip()
        if not line or line.upper() == "WEBVTT":
            continue
        m = _HEADING.match(line)
        if m:
            if _section_label(m.group(1)):
                continue
            return m.group(1).strip()
        if _section_label(line):
            continue
        sm = _SPEAKER.match(line)
        if sm and _meta_label(sm.group("name")):
            continue    # "Organizer: …", "Date: …" above the title
        if sm or _BARE_TS.match(line) or _VTT_CUE.match(line) or _SBV_CUE.match(line):
            return None
        if len(line) <= 150 and not line.endswith("."):
            return line
        return None
    return None


def _transcript_of(lines: list[str]) -> tuple[list[dict], str, bool, int | None]:
    """(segments, format, approx_times, duration_s) for the lines of a transcript."""
    text = "\n".join(lines)
    head = "\n".join(lines[:5]).lstrip("\ufeff").strip()
    ended = _ENDED.search(text)
    end_s = to_seconds(ended.group(1)) if ended else None
    if head.upper().startswith("WEBVTT") or sum(1 for x in lines[:40] if _VTT_CUE.match(x)) >= 2:
        fmt = "srt" if any(_SRT_INDEX.match(x) for x in lines[:3]) and "," in (next((x for x in lines[:5] if "-->" in x), "")) else "vtt"
        return _vtt(lines), fmt, False, end_s
    if sum(1 for x in lines[:40] if _SBV_CUE.match(x)) >= 2:
        return _sbv(lines), "sbv", False, end_s
    otter_hits = sum(1 for x in lines[:200] if (_OTTER.match(x.rstrip()) or _OTTER_NAME_FIRST.match(x.strip()))
                     and _plausible_name((_OTTER.match(x.rstrip()) or _OTTER_NAME_FIRST.match(x.strip())).group("name")))
    speaker_hits = sum(1 for x in lines[:200] if _SPEAKER.match(x.strip()) and _plausible_name(_SPEAKER.match(x.strip()).group("name")))
    if otter_hits >= 2 and otter_hits >= speaker_hits:
        return _otter(lines), "otter", False, end_s
    segs, google_marks = _speaker_lines(_skip_header(lines))
    named = sum(1 for s in segs if s.get("speaker"))
    if named >= 2 or (named >= 1 and len(segs) <= 3):
        approx = _interpolate(segs, end_s) if google_marks else False
        is_google = google_marks or bool(ended) or re.search(r"-\s*transcript\b", head, re.I) is not None
        return segs, "google_meet" if is_google else "speaker_lines", approx, end_s
    # Plain prose: a segment per paragraph (Google's footer and notice are not paragraphs of it).
    body = "\n".join(_ENDED_TAIL.sub("", x) for x in lines if not _GOOGLE_META.match(_clean_line(x).strip()))
    paras = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
    if len(paras) <= 1:
        paras = [x.strip() for x in body.split("\n") if x.strip()]
    return [{"speaker": None, "t": None, "text": p} for p in paras], "plain", False, end_s


def _is_transcript_heading(line: str) -> bool:
    m = _HEADING.match(line)
    t = (m.group(1) if m else line).strip().strip("*").strip()
    return re.sub(r"^[^\w]+", "", t).casefold() in ("transcript", "meeting transcript", "full transcript")


def parse_source(name: str, text: str) -> Source:
    """Detect what ``text`` is and normalise it (see the module docstring)."""
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff")
    src = Source(name=(name or "").strip()[:200])
    tabs = _split_tabs(text)
    all_lines = text.split("\n")
    first = tabs[0][1]
    notes = parse_notes(first)
    transcript_lines: list[str] | None = None
    if notes is not None:
        # A transcript in a later tab, or under a "Transcript" heading after the notes.
        for title, ls in tabs[1:]:
            if (title or "").casefold().strip(" 📖") in ("transcript", "meeting transcript") or \
                    sum(1 for x in ls[:80] if _SPEAKER.match(x.strip())) >= 2:
                transcript_lines = ls
                break
        if transcript_lines is None:
            # A "Transcript" heading in the notes tab: what follows it, never the notes' own sections
            # (a "Transcript" line above them, Gemini's meeting records, took the next steps for turns).
            span = notes_span(first)
            for i, line in enumerate(first):
                if _is_transcript_heading(line) and i > 0:
                    after = [x for j, x in enumerate(first) if j > i and j not in span]
                    if sum(1 for x in after[:80] if _SPEAKER.match(x.strip())) >= 2:
                        transcript_lines = after
                        break
        elif parse_notes(transcript_lines) is not None:
            span = notes_span(transcript_lines)
            transcript_lines = [x for j, x in enumerate(transcript_lines) if j not in span]
        src.notes = notes
        src.kind = "both" if transcript_lines else "notes"
        src.format = "gemini_notes"
    else:
        transcript_lines = [line for _t, ls in tabs for line in ls]
    if transcript_lines:
        segs, fmt, approx, end_s = _transcript_of(transcript_lines)
        if notes is None:
            src.format = fmt
        src.segments, src.truncated = _finish(segs, merge=fmt in ("vtt", "srt", "sbv"))
        src.approx_times = approx
        last = max((s["t"] for s in src.segments if s.get("t") is not None), default=None)
        src.duration_s = end_s if end_s else (last + 30 if last else None)
    # Title, date, attendees.
    raw_title = _first_title(all_lines)
    if src.format in ("vtt", "srt", "sbv"):
        raw_title = None
    src.title = clean_title(raw_title) or clean_title(src.name)
    d, t = find_date(raw_title)
    if not d:
        d, t = find_date("\n".join(x for x in all_lines[:8]))
    if not d:
        d, t = find_date(src.name)
    src.date, src.time = d, t
    src.organizer = organizer_in(text)
    speakers = [clean_name(sp) for sp in src.speakers]
    listed: list[dict] = []
    invited: list[dict] = []
    for _t, ls in tabs:
        j, inv = people_lists(ls, speakers)
        listed = listed or j
        invited = invited or inv
    if not listed and not invited:
        # No "Invited" label: a line of people chips (Gemini's newer notes put them after the title).
        invited = next((got for got in (chip_people(_clean_line(x)) for x in all_lines[:80]) if got), [])
    src.listed, src.invited = listed, invited
    if src.segments:
        # "<Owner Name> <Task Title>: …" is a next step, never a speaker (owner 2026-11-06).
        had = bool(src.segments)
        src.segments, steps, details = clean_task_speakers(src.segments, [p["name"] for p in [*listed, *invited]],
                                                           notes_doc=notes is not None)
        if notes is None and had and not src.segments and steps:
            # Gemini's notes that weren't recognised as notes (no Summary heading): its lines are notes.
            notes = src.notes = {"summary": "", "details": details[:80], "next_steps": []}
            src.format = "gemini_notes"
        if notes is not None:
            have = {_wkey(x) for x in notes.get("next_steps") or []}
            notes["next_steps"] = [*(notes.get("next_steps") or []),
                                   *[x for x in steps if _wkey(x) not in have]][:80]
            if not src.segments:
                src.kind = "notes"
                src.duration_s = None
        speakers = [clean_name(sp) for sp in src.speakers]
    src.attendees = _with_speakers(listed, speakers, invited)[:100]
    src.attendees_from = "attendees" if listed else "speakers" if src.attendees else "none"
    return src


# ── Several sources → meetings ────────────────────────────────────────────────


def pair(sources: list[Source]) -> list[list[Source]]:
    """Group sources into meetings: a notes source and a transcript source with the same normalised
    title (and the same date when both have one) are one meeting. Order is kept."""
    groups: list[list[Source]] = []
    for s in sources:
        key = title_key(s.title or s.name)
        placed = False
        for g in groups:
            kinds = {x.kind for x in g}
            if "both" in kinds or s.kind == "both" or s.kind in kinds:
                continue
            gk = title_key(g[0].title or g[0].name)
            dates = {x.date for x in g if x.date}
            if key and gk and (key == gk or key.startswith(gk) or gk.startswith(key)) and \
                    (not s.date or not dates or s.date in dates):
                g.append(s)
                placed = True
                break
        if not placed:
            groups.append([s])
    # Two sources, one of each kind, that don't name themselves alike: still one meeting.
    if len(groups) == 2 and {groups[0][0].kind, groups[1][0].kind} == {"notes", "transcript"} \
            and len(sources) == 2 and (not sources[0].date or not sources[1].date or sources[0].date == sources[1].date):
        return [groups[0] + groups[1]]
    return groups


@dataclass
class Merged:
    title: str | None
    date: str | None
    time: str | None
    duration_s: int | None
    attendees: list[dict]
    segments: list[dict]
    notes: dict | None
    kinds: list[str]
    approx_times: bool
    truncated: bool
    invited: list[dict] = field(default_factory=list)
    attendees_from: str = "none"       # attendees | speakers | notes | invited | none


def merge(group: list[Source]) -> Merged:
    """One meeting from its sources: the transcript's segments, the notes' sections."""
    tr = next((s for s in group if s.kind in ("both", "transcript") and s.segments), None)
    nt = next((s for s in group if s.notes), None)
    title = (nt.title if nt and nt.title else None) or next((s.title for s in group if s.title), None)
    d = next((s.date for s in group if s.date), None)
    tm = next((s.time for s in group if s.time), None)
    dur = next((s.duration_s for s in group if s.duration_s), None)
    att, invited, how = people_of_group(group)
    return Merged(title=title, date=d, time=tm, duration_s=dur, attendees=att[:100],
                  segments=tr.segments if tr else [], notes=nt.notes if nt else None,
                  kinds=[s.kind for s in group], approx_times=bool(tr and tr.approx_times),
                  truncated=any(s.truncated for s in group), invited=invited[:200], attendees_from=how)


def people_of_group(group: list[Source]) -> tuple[list[dict], list[dict], str]:
    """(attendees, invited, attendees_from) of one meeting's sources: every "Attendees" list and the
    speakers they don't name ("attendees"); else the speakers ("speakers"); else the invited people
    Gemini's notes name ("notes", :func:`named_in_notes`); else nobody, with the invite list as the only
    names ("invited"), or none at all ("none")."""
    invited = dedupe_people([a for s in group for a in s.invited])
    listed = dedupe_people([a for s in group for a in s.listed])
    speakers: list[str] = []
    for s in group:
        for sp in s.speakers:
            if sp not in speakers:
                speakers.append(sp)
    att = _with_speakers(listed, speakers, invited)
    how = "attendees" if listed else "speakers" if att else "invited" if invited else "none"
    if how == "invited":
        # Gemini's notes only (owner 2026-11-06): the people they name joined; the rest stays invited.
        notes = next((s.notes for s in group if s.notes), None)
        att = named_in_notes(notes, invited)
        how = "notes" if att else how
    return att, invited, how


# ── .docx and Google Docs → text ──────────────────────────────────────────────

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def docx_text(data: bytes) -> str:
    """The text of a .docx: a line per paragraph, headings as "#"s, list items as "- "."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            xml = z.read("word/document.xml")
    except (zipfile.BadZipFile, KeyError) as exc:
        raise ValueError("That isn't a readable .docx file.") from exc
    if len(xml) > 30_000_000:
        raise ValueError("That .docx is too big.")
    root = ET.fromstring(xml)
    out: list[str] = []
    for p in root.iter(f"{_W}p"):
        style = p.find(f"{_W}pPr/{_W}pStyle")
        sval = (style.get(f"{_W}val") if style is not None else "") or ""
        is_list = p.find(f"{_W}pPr/{_W}numPr") is not None
        parts: list[str] = []
        for el in p.iter():
            if el.tag == f"{_W}t" and el.text:
                parts.append(el.text)
            elif el.tag == f"{_W}tab":
                parts.append("\t")
            elif el.tag in (f"{_W}br", f"{_W}cr"):
                parts.append("\n")
        text = "".join(parts).rstrip()
        hm = re.match(r"^(?:heading|überschrift)\s*(\d)$", sval, re.I) or re.match(r"^Heading(\d)$", sval)
        if sval.lower() == "title" and text:
            text = f"# {text}"
        elif hm and text:
            text = f"{'#' * min(6, int(hm.group(1)) + 1)} {text}"
        elif is_list and text:
            text = f"- {text}"
        out.append(text)
    return "\n".join(out)


def gdoc_text(doc: dict) -> str:
    """A Google Docs API document (``includeTabsContent=true``) as text: headings as "#"s, bullets as
    "- ", person chips as "Name <email>", each tab after the first opened by ``=== Tab: <title> ===``."""
    out: list[str] = []

    def body_text(body: dict) -> None:
        for el in (body or {}).get("content") or []:
            para = el.get("paragraph")
            if para:
                style = ((para.get("paragraphStyle") or {}).get("namedStyleType") or "")
                parts: list[str] = []
                for pe in para.get("elements") or []:
                    if "textRun" in pe:
                        parts.append((pe["textRun"].get("content") or ""))
                    elif "person" in pe:
                        pp = (pe["person"].get("personProperties") or {})
                        nm, em = pp.get("name") or "", pp.get("email") or ""
                        parts.append(f"{nm} <{em}>" if em else nm)
                    elif "richLink" in pe:
                        parts.append(((pe["richLink"].get("richLinkProperties") or {}).get("title")) or "")
                text = "".join(parts).replace("\u000b", "\n").rstrip("\n")
                if style == "TITLE" and text:
                    text = f"# {text}"
                elif style.startswith("HEADING_") and text:
                    text = f"{'#' * min(6, int(style[-1]) + 1)} {text}"
                elif para.get("bullet") is not None and text:
                    text = f"- {text}"
                out.append(text)
            elif el.get("table"):
                for row in el["table"].get("tableRows") or []:
                    cells = []
                    for cell in row.get("tableCells") or []:
                        sub: list[str] = []
                        for c in cell.get("content") or []:
                            for pe in (c.get("paragraph") or {}).get("elements") or []:
                                sub.append(((pe.get("textRun") or {}).get("content") or "").strip())
                        cells.append(" ".join(x for x in sub if x))
                    out.append(" | ".join(cells))

    tabs = doc.get("tabs")
    if tabs:
        flat: list[dict] = []

        def walk(ts: list[dict]) -> None:
            for t in ts:
                flat.append(t)
                walk(t.get("childTabs") or [])
        walk(tabs)
        for i, t in enumerate(flat):
            if i > 0:
                out.append(f"=== Tab: {((t.get('tabProperties') or {}).get('title') or 'Tab')} ===")
            body_text(((t.get("documentTab") or {}).get("body")) or {})
    else:
        body_text(doc.get("body") or {})
    return "\n".join(out)


def decode_upload(name: str, data: bytes) -> str:
    """An uploaded file's text: .docx through :func:`docx_text`, everything else as UTF-8 (or UTF-16)."""
    low = (name or "").lower()
    if low.endswith(".docx") or data[:2] == b"PK":
        return docx_text(data)
    for enc in ("utf-8-sig", "utf-16"):
        try:
            text = data.decode(enc)
            if enc == "utf-16" and not data[:2] in (b"\xff\xfe", b"\xfe\xff"):
                continue
            return text
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1")


ACCEPTED = (".txt", ".vtt", ".srt", ".sbv", ".docx", ".md")


def summary_of(sources: list[Source]) -> list[dict[str, Any]]:
    """What a preview shows: one entry per meeting the sources make."""
    out = []
    for g in pair(sources):
        m = merge(g)
        out.append({"title": m.title, "date": m.date, "time": m.time, "duration_s": m.duration_s,
                    "attendees": [a["name"] for a in m.attendees], "invited": [a["name"] for a in m.invited],
                    "attendees_from": m.attendees_from, "segments": len(m.segments),
                    "has_notes": bool(m.notes), "kinds": m.kinds, "sources": [s.describe() for s in g],
                    "truncated": m.truncated})
    return out
