"""A Notion database's columns → Markdrop typed properties (services/page_db.py), and each row's values.

An export's CSV has no types, so they are read from the values (the API's types, Phase B, come in
``Column.notion_type`` and win):

    Yes / No everywhere                         checkbox
    numbers (1,234.5, 12%, $3)                  number
    Notion dates (November 19, 2026 [3:00 PM] [→ …], 2026/11/19, ISO)   date (the start; an end goes in the
                                                note under the row's properties)
    http(s) links                               link
    "Title (Page%20id.md)" items                relation → link to the imported pages
    people who are members of the workspace     person (by name or email; otherwise text)
    a few repeated values                       select (Status too); comma-separated ones → multi-select
    anything else                               text (emails, phone numbers, long text)

At most ``page_db.MAX_PROPERTIES`` columns become properties (in Notion's order); the rest, and values a
property can't hold (a second person, a date range's end), are written into the row's page instead, so
nothing is lost.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from app.services import page_db
from app.services.notion_import.tree import Column

_NUM = re.compile(r"^[-+]?[$€£¥₹]?\s?\d{1,3}(,\d{3})*(\.\d+)?%?$|^[-+]?[$€£¥₹]?\s?\d+(\.\d+)?%?$")
_URL = re.compile(r"^https?://\S+$", re.I)
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$", re.I)
_REL_ITEM = re.compile(r"(.+?)\s*\(([^()]*\.md)\)")
_DATE_FORMATS = ("%B %d, %Y", "%b %d, %Y", "%Y/%m/%d", "%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y", "%B %d, %Y %I:%M %p",
                 "%b %d, %Y %I:%M %p", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M", "%B %d, %Y %H:%M")
_STATUSY = ("status", "stage", "state", "priority", "type", "category")
SELECT_MAX_LEN = page_db.OPTION_MAX


def parse_date(v: str) -> tuple[str | None, str | None]:
    """("YYYY-MM-DD" start, the end as written) of a Notion date, or (None, None)."""
    s = (v or "").strip()
    if not s:
        return None, None
    start, end = s, None
    if "→" in s:
        start, end = [x.strip() for x in s.split("→", 1)]
    start = re.sub(r"\s*\(([A-Z]{2,5}|GMT[^)]*|UTC[^)]*)\)\s*$", "", start)
    start = start.replace("@", "").strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(start, fmt).date().isoformat(), end
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(start.replace("Z", "+00:00")).date().isoformat(), end
    except ValueError:
        return None, None


def parse_number(v: str) -> float | int | None:
    s = (v or "").strip()
    if not s or not _NUM.match(s):
        return None
    pct = s.endswith("%")
    s = re.sub(r"[$€£¥₹%,\s]", "", s)
    try:
        f = float(s)
    except ValueError:
        return None
    if pct:
        f = f / 100
    return int(f) if f.is_integer() and abs(f) < 2 ** 53 else f


def split_multi(v: str) -> list[str]:
    return [x.strip() for x in (v or "").split(",") if x.strip()]


def relation_items(v: str) -> list[tuple[str, str]]:
    """[(title, "Page%20id.md")] of a relation cell, or [] when it isn't one."""
    s = (v or "").strip()
    if not s:
        return []
    items = _REL_ITEM.findall(s)
    if not items:
        return []
    rest = _REL_ITEM.sub("", s).replace(",", "").strip()
    return [(t.strip().lstrip(",").strip(), p) for t, p in items] if not rest else []


_PERSONY = ("owner", "assignee", "assigned", "person", "people", "created by", "author", "lead", "reviewer",
            "edited by", "dri", "responsible")


def _peopleish(name: str, vals: list[str], people: "People") -> bool:
    """Most values are members of the workspace — or the column is named for people and some are."""
    hits = sum(1 for v in vals if split_multi(v) and all(people.match(x) for x in split_multi(v)))
    if hits * 2 >= len(vals) and hits:
        return True
    return hits > 0 and any(w in name.strip().lower() for w in _PERSONY)


class People:
    """Workspace members, matched by name or email (case-insensitive); a name two members share isn't matched."""

    def __init__(self, members: list[dict]):
        self.by_email: dict[str, str] = {}
        self.by_name: dict[str, str | None] = {}
        for m in members:
            uid = m.get("id")
            if not uid:
                continue
            if m.get("email"):
                self.by_email[m["email"].strip().lower()] = uid
            name = " ".join((m.get("name") or "").split()).casefold()
            if name:
                self.by_name[name] = None if name in self.by_name and self.by_name[name] != uid else uid

    def match(self, v: str) -> str | None:
        s = " ".join((v or "").split())
        if not s:
            return None
        if s.lower() in self.by_email:
            return self.by_email[s.lower()]
        return self.by_name.get(s.casefold())


def infer(col: Column, values: list[str], people: People | None) -> dict:
    """{name, type, options?, multi_person?} for one column, from its non-empty values."""
    vals = [v.strip() for v in values if v and v.strip()]
    name = col.name
    t = (col.notion_type or "").lower()
    api = {"checkbox": "checkbox", "number": "number", "date": "date", "url": "link", "select": "select",
           "status": "select", "multi_select": "multi_select", "people": "person", "relation": "relation",
           "email": "text", "phone_number": "text", "rich_text": "text", "created_time": "date",
           "last_edited_time": "date"}
    typ = api.get(t)
    if typ is None:
        typ = "text"
        if vals:
            if all(v in ("Yes", "No") for v in vals):
                typ = "checkbox"
            elif all(parse_number(v) is not None for v in vals):
                typ = "number"
            elif all(parse_date(v)[0] for v in vals):
                typ = "date"
            elif all(_URL.match(v) for v in vals):
                typ = "link"
            elif all(relation_items(v) for v in vals):
                typ = "relation"
            elif people is not None and _peopleish(name, vals, people):
                typ = "person"
            elif all(_EMAIL.match(v) for v in vals):
                typ = "text"
            else:
                tokens = [x for v in vals for x in split_multi(v)]
                distinct = {x for x in tokens}
                multi = any("," in v for v in vals)
                small = len(distinct) <= page_db.MAX_OPTIONS and all(len(x) <= SELECT_MAX_LEN for x in distinct)
                repeated = len(distinct) < len(tokens) or len(vals) <= 2 or name.strip().lower() in _STATUSY
                if small and repeated and all(len(v) <= 200 for v in vals):
                    typ = "multi_select" if multi else "select"
    elif typ == "person" and people is None:
        typ = "text"
    out: dict[str, Any] = {"name": name, "type": typ}
    if typ in ("select", "multi_select"):
        opts: list[str] = []
        for v in vals:
            for x in (split_multi(v) if typ == "multi_select" else [" ".join(v.split())]):
                x = x[:SELECT_MAX_LEN]
                if x and x.casefold() not in {o.casefold() for o in opts}:
                    opts.append(x)
        if len(opts) > page_db.MAX_OPTIONS:
            out = {"name": name, "type": "text"}
        else:
            out["options"] = opts
    return out


def schema_for(columns: list[Column], rows: list[dict[str, str]], people: People | None) -> tuple[list[dict], list[str]]:
    """(page_db schema items in Notion's order — relation columns typed "link", the columns left over).
    The first column is the title."""
    items: list[dict] = []
    extra: list[str] = []
    seen: set[str] = set()
    for col in columns[1:]:
        nm = " ".join((col.name or "").split())[:page_db.NAME_MAX] or "Property"
        base, k = nm, 2
        while nm.casefold() in seen or nm.casefold() in ("title", "name"):
            nm = f"{base[:page_db.NAME_MAX - 4]} ({k})"
            k += 1
        if len(items) >= page_db.MAX_PROPERTIES:
            extra.append(col.name)
            continue
        seen.add(nm.casefold())
        item = infer(col, [r.get(col.name, "") for r in rows], people)
        item["name"] = nm
        item["source"] = col.name
        items.append(item)
    return items, extra


def value_for(prop: dict, raw: str, *, people: People | None, link_of) -> tuple[Any, str | None]:
    """(the value for ``prop`` from a CSV cell, a note for what didn't fit). ``link_of(title, path)`` →
    a Markdrop slug for a related row, or None."""
    s = (raw or "").strip()
    if not s:
        return None, None
    t = prop["type"]
    if t == "checkbox":
        return s == "Yes", None
    if t == "number":
        n = parse_number(s)
        return (n, None) if n is not None else (None, s)
    if t == "date":
        d, end = parse_date(s)
        if d is None:
            return None, s
        return d, (f"until {end}" if end else None)
    if t == "link":
        if prop.get("relation"):
            slugs = []
            for title, path in relation_items(s):
                slug = link_of(title, path)
                if slug:
                    slugs.append(slug)
            slugs = slugs[:page_db.MAX_LINKS]
            return (slugs[0] if len(slugs) == 1 else slugs) if slugs else None, None
        return (s if _URL.match(s) else None), (None if _URL.match(s) else s)
    if t == "person":
        names = split_multi(s)
        ids = [people.match(x) for x in names] if people else []
        first = next((i for i in ids if i), None)
        rest = [n for n, i in zip(names, ids) if i != first] if first else names
        return first, (", ".join(rest) if rest else None)
    if t == "select":
        v = " ".join(s.split())[:SELECT_MAX_LEN]
        opts = {o.casefold(): o for o in prop.get("option_names") or []}
        return opts.get(v.casefold(), v), None
    if t == "multi_select":
        opts = {o.casefold(): o for o in prop.get("option_names") or []}
        out = []
        for x in split_multi(s)[:page_db.MAX_MULTI]:
            x = opts.get(x[:SELECT_MAX_LEN].casefold(), x[:SELECT_MAX_LEN])
            if x not in out:
                out.append(x)
        return out, None
    v = s.replace("\r", "")
    if len(v) > page_db.TEXT_MAX:
        return v[:page_db.TEXT_MAX], "(cut to 2,000 characters)"
    return v, None
