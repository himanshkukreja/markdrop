"""Open to-dos that mention people, as the home's "Your action items" shows them.

One reading of a block page's Markdown, used twice:

* at index time (services/search_index.doc_row): ``people(raw)`` — who has an open to-do in the page — and
  ``lines(raw)`` — each such person's to-do lines, already worded for their own list — are stored on the
  page's search row (``td`` / ``tdl``), so the home finds and shows them with an index lookup;
* on the home's fallback path (before the index carries them) from the page itself.

Pure functions (no database); ``ask_markdrop.task_lines`` decides what a task line is.
"""

from __future__ import annotations

import re

# A meeting note's citation of a transcript line ("[00:04](…#b-t3)", "[#3](…#b-t3)"): not part of the to-do.
CITE = re.compile(r"\s*\[(?:#?\d{1,4}|\d{1,2}:\d{2}(?::\d{2})?)\]\([^)\s]*#b-t\d+\)")
_OPEN_TASK = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s+\S")
# Any id="…" on the line, like task_lines' own test (a superset of person mentions: a stray id only means
# a page the home reads and finds nothing for).
_ID = re.compile(r'\bid="([^"\n]{1,64})"')
MAX_LINES_PER_PERSON = 60
_SAFE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")  # ids become field names on the search row (``tdl``)


def eligible(raw: dict) -> bool:
    """A block page whose words may be read (never encrypted or password-protected, never a file)."""
    return (raw.get("editor") == "blocks" and raw.get("kind") != "artifact"
            and not raw.get("encrypted") and not raw.get("read_password_hash"))


def people(raw: dict) -> list[str]:
    """Who has an open to-do in this page (the ids its unchecked task lines mention), sorted."""
    if not eligible(raw):
        return []
    content = raw.get("content") or ""
    if 'id="' not in content:
        return []
    out: set[str] = set()
    fence = False
    for line in content.split("\n"):
        if line.lstrip().startswith(("```", "~~~")):
            fence = not fence
            continue
        if fence or 'id="' not in line or not _OPEN_TASK.match(line):
            continue
        out.update(i for i in _ID.findall(line) if _SAFE.match(i))
    return sorted(out)


def for_person(content: str, uid: str) -> list[tuple[str, str | None]]:
    """``uid``'s open to-dos in ``content``: (text for their own list, block anchor). Their own mention
    is dropped ("@Bo Order the banners" → "Order the banners": on your own list it's noise)."""
    from app.services.ask_markdrop import task_lines

    content = CITE.sub("", content or "")
    tasks = task_lines(content, uid)
    if not tasks:
        return []
    me = {f"@{n}" for n in re.findall(r':person\[([^\]\n]*)\]\{id="' + re.escape(uid) + '"', content)}
    out = []
    for full, anchor in tasks:
        text = full
        for m in me:
            text = text.replace(m, " ")
        text = re.sub(r"\s+", " ", text).strip(" ,;:-") or full
        out.append((text[:1].upper() + text[1:], anchor))
    return out


def lines(raw: dict, uids: list[str] | None = None) -> dict[str, list[list]]:
    """{uid: [[text, anchor], …]} for everyone with an open to-do here (``uids`` from people())."""
    uids = people(raw) if uids is None else uids
    content = raw.get("content") or ""
    out: dict[str, list[list]] = {}
    for uid in uids:
        got = for_person(content, uid)
        if got:
            out[uid] = [[t, a] for t, a in got[:MAX_LINES_PER_PERSON]]
    return out
