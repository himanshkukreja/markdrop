"""Import past meetings: what each file is, which call it belongs to, when it was, and which
recurring series it is part of. Pure (no I/O); services/meeting_backfill.py stores and imports.

**Date**, in this order (``date_from`` says which won):

1. ``title`` — the file's or Google Doc's name. Google names them "Daily Standup – 2026/10/28 10:00
   IST – Transcript", "Weekly sync (2026-11-04 10:00 GMT+05:30) - Transcript", "… - Notes by Gemini";
   a download keeps it with "_" for "/" and ":" ("2026_10_28 10_00"); people write "standup
   2026-10-28.vtt" or "Retro Oct 28, 2026.docx".
2. ``created`` — the Google Doc's creation day (from the Drive Picker, in the person's own time zone).
   An uploaded file's modified time is never used: a download sets it to the day of the download.
3. ``content`` — a date in the first lines of the text ("Nov 4, 2026" under Gemini's title).
   Only a plausible one: not in the future, not more than ten years back.

No date → the review flags the row and the person fills it in before the import starts.

**Pairing** (Google writes the notes and the transcript of one call as two Docs): a notes source and
a transcript source with the same name (one may be the start of the other), the same date (or both
undated) and start times within 45 minutes become one meeting. A Doc that holds both (Gemini notes
with a Transcript tab) is a meeting of its own; never two transcripts in one meeting.

**Series**: meetings whose names differ only by numbers, dates or Google's suffixes ("Sprint 23
review" / "Sprint 24 review", "Daily Standup" every day) share a :func:`series_key`; two or more
meetings with one key are a series named by :func:`series_label` ("Sprint review", "Daily Standup").
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Iterable

from app.services import meeting_parse as mp

PAIR_TIME_SLACK_MIN = 45
MAX_PAST_YEARS = 10

# Cost (Claude Haiku 5.5): $0.10/M input, $0.50/M output; a summary writes ~1.5k tokens.
IN_PER_TOKEN = 0.10 / 1_000_000
OUT_PER_TOKEN = 0.50 / 1_000_000
OUT_TOKENS = 1500
PROMPT_TOKENS = 900
NOTES_ONLY_USD = 0.0012

_EXT = re.compile(r"\.(?:txt|vtt|srt|sbv|docx|md)$", re.I)
_GOOGLE_SUFFIX = re.compile(r"[-–—:]\s*(?:transcript|notes by gemini|meeting notes|notes|recording)\s*$", re.I)
# A date (and a time, and a time zone) anywhere in a name: "2026/10/28 10:00 IST", "2026_10_28 10_00",
# "(2026-11-04 10:00 GMT+05:30)".
_ISO_IN_NAME = re.compile(
    r"\(?\s*\d{4}[-/_.]\d{1,2}[-/_.]\d{1,2}(?:[ T_]+\d{1,2}[:_.]\d{2}(?:[:_.]\d{2})?)?"
    r"(?:\s*(?:[A-Z]{2,5}(?:[+-]\d{1,2}(?::?\d{2})?)?|[+-]\d{2}:?\d{2}))?\s*\)?")
GOOGLE_NAME = re.compile(r"[-–—]\s*(?:transcript|notes by gemini)\s*(?:\.\w{2,4})?\s*$", re.I)
_STARTED = re.compile(r"^\s*meeting started\b.*$", re.I)


def plain_name(name: str | None) -> str:
    """A file name without its extension, "_" as spaces."""
    n = _EXT.sub("", (name or "").strip())
    return re.sub(r"\s+", " ", n.replace("_", " ")).strip()


def title_from_name(name: str | None) -> str | None:
    """The meeting's name in a Google (or hand-made) file name, without dates, times, time zones and
    Google's suffixes. None when the name says nothing about the meeting ("Meeting started …",
    "Pasted text", "transcript.txt")."""
    raw = _EXT.sub("", (name or "").strip())
    raw = _ISO_IN_NAME.sub(" ", raw)
    raw = re.sub(r"\s+", " ", raw.replace("_", " ")).strip()
    if _STARTED.match(raw):
        return None
    t = mp.clean_title(raw)
    if not t:
        return None
    t = _GOOGLE_SUFFIX.sub("", t).strip(" -–—:")
    if t.casefold() in ("pasted text", "transcript", "notes", "meeting", "meeting notes", "notes by gemini",
                        "google doc", "untitled", "untitled document", "recording"):
        return None
    return t[:150] or None


def _plausible(d: str | None, today: date) -> bool:
    if not d:
        return False
    try:
        x = date.fromisoformat(d)
    except ValueError:
        return False
    return today - timedelta(days=366 * MAX_PAST_YEARS) <= x <= today + timedelta(days=1)


def date_of(name: str | None, created: str | None, parsed_date: str | None, parsed_time: str | None,
            *, today: date) -> tuple[str | None, str | None, str | None]:
    """(date, time, date_from) of one source; see the module docstring for the order."""
    d, t = mp.find_date(_EXT.sub("", name or "")) if name else (None, None)
    if _plausible(d, today):
        return d, t, "title"
    c = (created or "").strip()[:10]
    if re.match(r"^\d{4}-\d{2}-\d{2}$", c) and _plausible(c, today):
        return c, None, "created"
    if _plausible(parsed_date, today):
        return parsed_date, parsed_time, "content"
    return None, None, None


# ── Pairing ──────────────────────────────────────────────────────────────────


@dataclass
class Item:
    """One source as pairing sees it."""
    id: str
    kind: str                     # transcript | notes | both
    title: str | None
    date: str | None
    time: str | None
    extra: dict[str, Any] = field(default_factory=dict)


def _minutes(t: str | None) -> int | None:
    m = re.match(r"^(\d{1,2}):(\d{2})$", t or "")
    return int(m.group(1)) * 60 + int(m.group(2)) if m else None


def _names_match(a: str | None, b: str | None, *, exact: bool) -> bool:
    ka, kb = mp.title_key(a), mp.title_key(b)
    if not ka or not kb:
        return False
    return ka == kb if exact else (ka.startswith(kb) or kb.startswith(ka))


def _halves(a: Item, b: Item) -> bool:
    if a.date != b.date:
        return False
    ta, tb = _minutes(a.time), _minutes(b.time)
    return ta is None or tb is None or abs(ta - tb) <= PAIR_TIME_SLACK_MIN


def pair(items: Iterable[Item]) -> list[list[Item]]:
    """Group sources into meetings, in order (a meeting sits where its first source was): exact
    names pair first, then a name that is the start of the other ("Weekly sync" / "Weekly sync with
    Acme")."""
    groups: list[list[Item] | None] = [[it] for it in items]
    for exact in (True, False):
        for i, g in enumerate(groups):
            if g is None or len(g) != 1 or g[0].kind == "both":
                continue
            for j in range(i + 1, len(groups)):
                h = groups[j]
                if h is None or len(h) != 1 or h[0].kind in ("both", g[0].kind):
                    continue
                if _names_match(g[0].title, h[0].title, exact=exact) and _halves(g[0], h[0]):
                    g.append(h[0])
                    groups[j] = None
                    break
    return [g for g in groups if g]


# ── Series ───────────────────────────────────────────────────────────────────

_ONE_ON_ONE = re.compile(r"\b(?:1\s*[:\-/]\s*1|1\s*on\s*1|one[\s-]on[\s-]one)\b", re.I)
_MONTHS = r"jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december"
_MONTH_WORD = re.compile(rf"\b(?:{_MONTHS})\b\.?", re.I)
_WEEKDAY = re.compile(r"\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day)?\b\.?", re.I)
_COPY = re.compile(r"^\s*copy of\s+", re.I)


def _strip_numbers(title: str) -> str:
    t = _COPY.sub("", title)
    t = _ONE_ON_ONE.sub(" 1:1 ", t)
    keep = "\x00"
    t = t.replace("1:1", keep)
    # "Sprint 23 review" → "Sprint review", "Weekly sync #12" → "Weekly sync"; the word before a number
    # stays when it carries meaning ("Sprint", "Week") only as part of a name like "Sprint review".
    t = re.sub(r"(?:#\s*\d+|\(\s*\d+\s*\)|\b\d+(?:st|nd|rd|th)?\b)", " ", t)
    t = re.sub(r"\b(?:w|wk|q|v)\d+\b", " ", t, flags=re.I)
    t = _MONTH_WORD.sub(" ", t)
    t = _WEEKDAY.sub(" ", t)
    t = t.replace(keep, "1:1")
    t = re.sub(r"\s*[-–—:,|/]+\s*$", "", t)
    t = re.sub(r"^\s*[-–—:,|/]+\s*", "", t)
    t = re.sub(r"\s+([-–—:,|/])\s+(?=[-–—:,|/]|$)", " ", t)
    return re.sub(r"\s+", " ", t).strip(" -–—:,|/")


def series_label(title: str | None) -> str | None:
    """A meeting name without its numbers and dates ("Sprint 23 review" → "Sprint review")."""
    if not title:
        return None
    t = _strip_numbers(mp.clean_title(title) or title)
    return t[:80] or None


def series_key(title: str | None) -> str:
    """What recurring meetings have in common ("sprint review", "daily standup")."""
    label = series_label(title)
    if not label:
        return ""
    k = re.sub(r"[^a-z0-9À-￿:]+", " ", label.casefold()).strip()
    # Plurals and "the": "Daily Standups" is the "Daily Standup" series.
    words = [w[:-1] if len(w) > 4 and w.endswith("s") and not w.endswith("ss") else w for w in k.split() if w != "the"]
    return " ".join(words)


def group_key(key_or_title: str | None, *, is_key: bool = False) -> str:
    """The key meetings are grouped into one series by: :func:`series_key` without its spaces, so
    "Daily Syncup", "Daily Sync Up" and "daily sync-up" are one series (case, spaces and punctuation
    don't count) while "Daily Standup" stays another (owner, 2026-11-05)."""
    k = key_or_title if is_key else series_key(key_or_title)
    return re.sub(r"\s+", "", k or "")


def pick_label(labels: Iterable[str | None]) -> str | None:
    """The series' name: the way it is written most often (the first such on a tie)."""
    xs = [x for x in labels if x]
    if not xs:
        return None
    counts = Counter(xs)
    best = max(counts.values())
    return next(x for x in xs if counts[x] == best)


# ── Cost ─────────────────────────────────────────────────────────────────────


def estimate_usd(transcript_chars: int, has_notes: bool) -> float:
    """What the AI summary of one meeting costs (about): its transcript in, the sections out."""
    if transcript_chars <= 0:
        return NOTES_ONLY_USD if has_notes else 0.0
    tokens_in = PROMPT_TOKENS + transcript_chars / 3.6 + (600 if has_notes else 0)
    chunks = 1 if transcript_chars <= 240_000 else (transcript_chars // 160_000 + 2)
    return round(tokens_in * IN_PER_TOKEN + OUT_TOKENS * chunks * OUT_PER_TOKEN, 6)
