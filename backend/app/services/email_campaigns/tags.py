"""Merge tags for campaign emails.

``{{first_name}}`` is replaced per recipient; ``{{first_name|there}}`` falls
back to "there" when the recipient has no value; ``{{#if first_name}}…{{else}}…{{/if}}``
picks a branch (not nested). The same functions validate the composer's fields,
render the admin preview, the test send and every real send, so what the admin
sees is what a recipient gets.

Truthiness for ``#if``: a value counts when it is non-empty after trimming and
is not "0", so ``{{#if doc_count}}`` means "has at least one document".
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass

MergeVars = dict[str, str]


@dataclass(frozen=True)
class MergeTag:
    tag: str
    label: str
    hint: str
    sample: str
    url: bool = False


MERGE_TAGS: tuple[MergeTag, ...] = (
    MergeTag("first_name", "First name", "from the account name; empty if unknown", "Priya"),
    MergeTag("name", "Full name", "account or Google name", "Priya Raman"),
    MergeTag("email", "Email", "recipient address", "priya@example.com"),
    MergeTag("doc_count", "Documents", "markdown documents published, 0 if none", "12"),
    MergeTag("artifact_count", "Files", "artifacts (HTML, PDF, sheets…) uploaded, 0 if none", "3"),
    MergeTag("joined", "Joined", "sign-up date, e.g. 4 Mar 2026; empty without an account", "4 Mar 2026"),
    MergeTag("vscode_user", "VS Code user", "\"yes\" with a VS Code token, else empty (for #if)", "yes"),
    MergeTag("site_url", "Site", "https://markdrop.in", "https://markdrop.in", url=True),
    MergeTag("dashboard_url", "Dashboard link", "the recipient's dashboard", "https://markdrop.in/dashboard", url=True),
    MergeTag("unsubscribe_url", "Unsubscribe link", "one-click, per recipient", "https://api.markdrop.in/api/v1/email/u/preview", url=True),
)
KNOWN_TAGS = frozenset(t.tag for t in MERGE_TAGS)
URL_TAGS = frozenset(t.tag for t in MERGE_TAGS if t.url)
SAMPLE_VARS: MergeVars = {t.tag: t.sample for t in MERGE_TAGS}

# {{ tag }} / {{ tag | fallback }}. Tag names: letters, digits, underscore.
TAG_RE = re.compile(r"\{\{\s*([a-zA-Z0-9_]+)\s*(?:\|([^}]*))?\}\}")
# Control tags of a conditional (not nested).
CONTROL_RE = re.compile(r"\{\{\s*(?:#if\s+[a-zA-Z0-9_]+|else|/if)\s*\}\}")
IF_RE = re.compile(
    r"\{\{\s*#if\s+([a-zA-Z0-9_]+)\s*\}\}([\s\S]*?)(?:\{\{\s*else\s*\}\}([\s\S]*?))?\{\{\s*/if\s*\}\}"
)
_IF_OPEN_RE = re.compile(r"\{\{\s*#if\s+([a-zA-Z0-9_]+)\s*\}\}")
_IF_OPEN_ANY = re.compile(r"\{\{\s*#if\s")
_IF_CLOSE = re.compile(r"\{\{\s*/if\s*\}\}")
_MALFORMED = re.compile(r"\{\{[^}]{0,40}|\{[a-zA-Z_]+\}(?!\})")


@dataclass(frozen=True)
class TagUse:
    tag: str
    fallback: str | None
    raw: str


def find_tags(s: str) -> list[TagUse]:
    out: list[TagUse] = []
    for m in TAG_RE.finditer(s or ""):
        tag = m.group(1).lower()
        if tag == "else":
            continue
        out.append(TagUse(tag, m.group(2).strip() if m.group(2) is not None else None, m.group(0)))
    return out


def _distance(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def suggest_tag(tag: str) -> str | None:
    best, score = None, 3
    for t in sorted(KNOWN_TAGS):
        d = _distance(tag, t)
        if d < score:
            best, score = t, d
    return best


def problem(where: str, raw: str, message: str) -> dict[str, str]:
    return {"where": where, "raw": raw, "message": message}


def check_field(where: str, s: str | None) -> list[dict[str, str]]:
    """Unknown tags, unbalanced conditionals and malformed braces in one field."""
    if not s:
        return []
    problems: list[dict[str, str]] = []
    for u in find_tags(s):
        if u.tag not in KNOWN_TAGS:
            sug = suggest_tag(u.tag)
            hint = f" (did you mean {{{{{sug}}}}}?)" if sug else ""
            problems.append(problem(where, u.raw, f"Unknown tag {u.raw}{hint}"))
    for m in _IF_OPEN_RE.finditer(s):
        if m.group(1).lower() not in KNOWN_TAGS:
            problems.append(problem(where, m.group(0), f"Unknown tag in {m.group(0)}"))
    opens = len(_IF_OPEN_ANY.findall(s))
    closes = len(_IF_CLOSE.findall(s))
    if opens != closes:
        problems.append(problem(where, "{{#if}}", f"{opens} {{{{#if …}}}} but {closes} {{{{/if}}}}"))
    rest = CONTROL_RE.sub("", TAG_RE.sub("", s))
    bad = _MALFORMED.search(rest)
    if bad:
        problems.append(problem(
            where, bad.group(0),
            f'Malformed tag near "{bad.group(0)[:30]}" (use {{{{tag}}}} or {{{{tag|fallback}}}})',
        ))
    return problems


def truthy(v: str | None) -> bool:
    t = (v or "").strip()
    return bool(t) and t != "0"


def resolve_tags(s: str, vars: MergeVars, mode: str = "text") -> str:
    """Replace tags with values; HTML-escaped (quotes included) in ``html`` mode.

    Empty value → inline fallback → "". Conditionals resolve first.
    """
    if not s:
        return ""

    def _if(m: re.Match[str]) -> str:
        return m.group(2) if truthy(vars.get(m.group(1).lower())) else (m.group(3) or "")

    def _tag(m: re.Match[str]) -> str:
        v = (vars.get(m.group(1).lower()) or "").strip()
        out = v or (m.group(2).strip() if m.group(2) is not None else "")
        return html.escape(out, quote=True) if mode == "html" else out

    return TAG_RE.sub(_tag, IF_RE.sub(_if, s))


def has_empty_tag(s: str, vars: MergeVars) -> bool:
    """True when any tag in ``s`` resolves to "" (no value, no fallback)."""
    return any(not (vars.get(u.tag) or "").strip() and not (u.fallback or "").strip() for u in find_tags(s))


def first_name_of(full: str | None) -> str:
    """"Priya Raman" → "Priya"; empty, email-looking, 1-char or very long first words → ""."""
    t = (full or "").strip()
    if not t or "@" in t:
        return ""
    first = t.split()[0]
    return first if 1 < len(first) <= 40 else ""
