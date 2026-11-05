"""Ask across meetings, scoped: a series and/or a date range, given or read from the question.

    POST /api/v1/meetings/ask {workspace, question, series?, since?, until?}   MCP ask_meetings(…)

When the asker gives no scope, :func:`from_question` reads a conservative one from the question:
a series the workspace has, named in it ("in Daily Standups", "the sprint reviews"), and a
relative range ("last month", "this week", "yesterday", "in October", "last 10 days", "since
October"). Nothing is guessed from a word that could mean anything ("review", "sync").

:func:`wants_recent` tells a question about the latest state ("what's the latest on pricing?", "is
the release still on Friday?") so the ranking prefers newer meetings (services/meetings_ai.py).
Pure: no I/O.
"""

from __future__ import annotations

import re
from calendar import monthrange
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Iterable

from app.services import meeting_backfill_detect as det

_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
           "november", "december"]
_MON3 = {m[:3]: i + 1 for i, m in enumerate(_MONTHS)} | {"sept": 9}
_GENERIC = frozenset("""meeting meetings call calls sync syncs review reviews planning update updates check chat catch session
sessions discussion discussions team weekly daily monthly call notes general all hands""".split())
_RECENT = re.compile(
    r"\b(latest|most recent|recent(?:ly)?|current(?:ly)?|right now|now|still|as of|these days|status|lately|"
    r"newest|up to date|last time|last meeting|last call|last standup|last sync|last review|anymore|so far)\b", re.I)


@dataclass
class Scope:
    series: str | None = None
    since: str | None = None
    until: str | None = None
    detected: bool = False

    @property
    def empty(self) -> bool:
        return not (self.series or self.since or self.until)

    def label(self) -> str:
        bits = []
        if self.series:
            bits.append(self.series)
        if self.since or self.until:
            bits.append(range_label(self.since, self.until))
        return " · ".join(bits)

    def as_dict(self) -> dict:
        return {"series": self.series, "since": self.since, "until": self.until, "detected": self.detected,
                "label": self.label()}


def _d(x: date) -> str:
    return x.isoformat()


def _fmt(d: str, *, year: bool) -> str:
    x = date.fromisoformat(d)
    return f"{x.strftime('%b')} {x.day}" + (f", {x.year}" if year else "")


def range_label(since: str | None, until: str | None) -> str:
    try:
        if since and until:
            a, b = date.fromisoformat(since), date.fromisoformat(until)
            if a == b:
                return _fmt(since, year=True)
            if a.day == 1 and b.day == monthrange(b.year, b.month)[1] and (a.year, a.month) == (b.year, b.month):
                return f"{a.strftime('%B')} {a.year}"
            return f"{_fmt(since, year=a.year != b.year)} – {_fmt(until, year=True)}"
        if since:
            return f"since {_fmt(since, year=True)}"
        if until:
            return f"until {_fmt(until, year=True)}"
    except ValueError:
        pass
    return ""


def _month_range(year: int, month: int) -> tuple[str, str]:
    return _d(date(year, month, 1)), _d(date(year, month, monthrange(year, month)[1]))


def dates_from(question: str, today: date) -> tuple[str | None, str | None]:
    """A date range named in the question (relative to ``today``), or (None, None)."""
    q = question.casefold()
    if re.search(r"\btoday\b", q):
        return _d(today), _d(today)
    if re.search(r"\byesterday\b", q):
        y = today - timedelta(days=1)
        return _d(y), _d(y)
    m = re.search(r"\b(?:last|past|previous)\s+(\d{1,3})\s+(day|week|month)s?\b", q)
    if m:
        n, unit = int(m.group(1)), m.group(2)
        days = n * {"day": 1, "week": 7, "month": 30}[unit]
        return _d(today - timedelta(days=days)), _d(today)
    if re.search(r"\bthis week\b", q):
        return _d(today - timedelta(days=today.weekday())), _d(today)
    if re.search(r"\b(?:last|previous|past) week\b", q):
        start = today - timedelta(days=today.weekday() + 7)
        return _d(start), _d(start + timedelta(days=6))
    if re.search(r"\bthis month\b", q):
        return _d(today.replace(day=1)), _d(today)
    if re.search(r"\b(?:last|previous|past) month\b", q):
        first = today.replace(day=1) - timedelta(days=1)
        return _month_range(first.year, first.month)
    if re.search(r"\bthis year\b", q):
        return _d(date(today.year, 1, 1)), _d(today)
    names = "|".join([*_MONTHS, *[k for k in _MON3 if k != "may"]])
    m = re.search(rf"\b(since|in|during|from|of)\s+({names})\.?(?:\s+(\d{{4}}))?\b", q)
    if m:
        word = m.group(2)
        month = _MONTHS.index(word) + 1 if word in _MONTHS else _MON3[word]
        year = int(m.group(3)) if m.group(3) else (today.year if month <= today.month else today.year - 1)
        a, b = _month_range(year, month)
        if m.group(1) == "since":
            return a, _d(today)
        return a, b
    return None, None


def _norm_words(text: str) -> list[str]:
    words = re.sub(r"[^a-z0-9À-￿:]+", " ", text.casefold()).split()
    return [w[:-1] if len(w) > 4 and w.endswith("s") and not w.endswith("ss") else w for w in words if w != "the"]


def series_from(question: str, series: Iterable[str]) -> str | None:
    """The series named in the question: its whole name ("daily standups"), else its one distinctive
    word when only one series has it ("standups" → Daily Standup). None otherwise."""
    qw = _norm_words(question)
    joined = f" {' '.join(qw)} "
    best: tuple[int, str] | None = None
    names = [s for s in series if s]
    for s in names:
        k = det.series_key(s)
        if k and f" {k} " in joined and (best is None or len(k) > best[0]):
            best = (len(k), s)
    if best:
        return best[1]
    last: dict[str, list[str]] = {}
    for s in names:
        ws = det.series_key(s).split()
        if ws and len(ws[-1]) >= 4 and ws[-1] not in _GENERIC and not ws[-1].isdigit():
            last.setdefault(ws[-1], []).append(s)
    for w in qw:
        hit = last.get(w)
        if hit and len(hit) == 1:
            return hit[0]
    return None


def from_question(question: str, series: Iterable[str], today: date) -> Scope:
    since, until = dates_from(question, today)
    s = series_from(question, series)
    return Scope(series=s, since=since, until=until, detected=bool(s or since or until))


def wants_recent(question: str) -> bool:
    return bool(_RECENT.search(question or ""))


def checked(series: str | None, since: str | None, until: str | None) -> Scope:
    """An explicit scope, validated (ValueError with a message)."""
    for name, v in (("since", since), ("until", until)):
        if v:
            try:
                date.fromisoformat(v)
            except ValueError:
                raise ValueError(f"{name} is a date, YYYY-MM-DD.")
    if since and until and since > until:
        raise ValueError("since is after until.")
    s = " ".join((series or "").split())[:60] or None
    return Scope(series=s, since=since or None, until=until or None)


def day_label(d: str | None) -> str:
    """ "Tue 28 Oct 2026" (how a meeting's date is given to the model)."""
    if not d:
        return "unknown date"
    try:
        x = date.fromisoformat(d)
    except ValueError:
        return d
    return f"{x.strftime('%a')} {x.day} {x.strftime('%b')} {x.year}"
