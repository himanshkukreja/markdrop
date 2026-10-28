"""Heading ids and fenced code blocks of a markdown document, as the reader sees them.

Creator analytics stores a markdown document's sections by the DOM ids the
viewer gives its headings (``user-content-<slug>``) and code copies by a hash of
the copied block. The web dashboard turns those back into words in the browser
(frontend ``components/reading/slug.ts`` and ``lib/analytics.ts``); the MCP tool
and the weekly digest need the same words on the server, so this is a port of
those rules:

* :func:`extract_headings` — ``extractHeadings``: h1–h4, github-slugger-like
  slugs (lower-case, punctuation dropped, spaces → "-", duplicates "-1", "-2"…)
  with the sanitizer's ``user-content-`` prefix.
* :func:`fenced_blocks` / :func:`block_preview` — ``fencedBlocks`` /
  ``blockPreview``: FNV-1a 32-bit over UTF-8 bytes or UTF-16 code units.

Keep the two in step: a change to the frontend's slug rules must be made here
too (tests/test_mcp_tools.py pins a few ids).
"""

from __future__ import annotations

import re
import unicodedata

HEADING_ID_PREFIX = "user-content-"

# ── Slugs ─────────────────────────────────────────────────────────────────────


def _keep(ch: str) -> bool:
    if ch in (" ", "-"):
        return True
    cat = unicodedata.category(ch)
    return cat[0] in ("L", "M", "N") or cat == "Pc"


def slugify(text: str) -> str:
    """github-slugger-like: lower-case, keep letters/marks/numbers/connector
    punctuation, spaces → "-"."""
    s = re.sub(r"\s+", " ", text).strip().lower()
    s = "".join(ch for ch in s if _keep(ch))
    return s.replace(" ", "-")


def make_slugger():
    """A deterministic slugger that dedupes like github-slugger ("a", "a-1"…)."""
    seen: dict[str, int] = {}

    def slug(text: str) -> str:
        base = slugify(text) or "section"
        out = base
        while out in seen:
            n = seen.get(base, 0) + 1
            seen[base] = n
            out = f"{base}-{n}"
        seen[out] = 0
        return out

    return slug


# ── Inline markdown → text ────────────────────────────────────────────────────

_PH_OPEN, _PH_CLOSE = "\ue000", "\ue001"
_ENTITIES = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'", "nbsp": "\u00a0"}


def _entity(m: re.Match) -> str:
    e = m.group(1)
    if e[0] == "#":
        try:
            code = int(e[2:], 16) if e[1:2] in ("x", "X") else int(e[1:], 10)
            return chr(code) if code > 0 else m.group(0)
        except (ValueError, OverflowError):
            return m.group(0)
    return _ENTITIES.get(e.lower(), m.group(0))


def inline_text(src: str) -> str:
    """Inline markdown → the text a reader sees (links keep their text,
    images and footnote refs drop)."""
    keep: list[str] = []

    def stash(s: str) -> str:
        keep.append(s)
        return f"{_PH_OPEN}{len(keep) - 1}{_PH_CLOSE}"

    s = re.sub(r"\\([!-/:-@\[-`{-~])", lambda m: stash(m.group(1)), src)
    s = re.sub(r"(`+)([\s\S]*?[^`])\1(?!`)",
               lambda m: stash(re.sub(r"^ (.*) $", r"\1", m.group(2))), s)
    s = re.sub(r"(\${1,2})([^$]+?)\1", lambda m: stash(m.group(2)), s)
    s = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", s)
    s = re.sub(r"!\[[^\]]*\]\[[^\]]*\]", "", s)
    s = re.sub(r"\[\^[^\]]+\]", "", s)
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"\[([^\]]*)\]\[[^\]]*\]", r"\1", s)
    s = re.sub(r"<((?:https?|mailto|ftp):[^>\s]+)>", r"\1", s, flags=re.I)
    s = re.sub(r"</?[A-Za-z][^>]*>", "", s)
    s = re.sub(r"(\*\*|__)(?=\S)([\s\S]*?\S)\1", r"\2", s)
    s = re.sub(r"\*(?=\S)([\s\S]*?\S)\*", r"\1", s)
    # [\W_] = not a letter or number; (?![^\W_]) = not followed by one.
    s = re.sub(r"(^|[\W_])_(?=\S)([\s\S]*?\S)_(?![^\W_])", r"\1\2", s)
    s = re.sub(r"~~?(?=\S)([\s\S]*?\S)~~?", r"\1", s)
    s = re.sub(r"&(#x[0-9a-f]+|#\d+|[a-z]+);", _entity, s, flags=re.I)
    s = re.sub(f"{_PH_OPEN}(\\d+){_PH_CLOSE}",
               lambda m: keep[int(m.group(1))] if int(m.group(1)) < len(keep) else "", s)
    return re.sub(r"\s+", " ", s).strip()


_QUOTE_PREFIX = re.compile(r"^\s{0,3}(?:>\s?)+")


def heading_source_text(source: str) -> str:
    """The source of one heading → its plain text."""
    lines = re.split(r"\r?\n", source)
    if len(lines) > 1 and re.match(r"^\s*(?:>\s?)*\s*(=+|-+)\s*$", lines[-1]):
        body = [ln if i == 0 else _QUOTE_PREFIX.sub("", ln) for i, ln in enumerate(lines[:-1])]
        return inline_text(" ".join(body))
    atx = re.sub(r"^\s{0,3}#{1,6}(?=\s|$)", "", lines[0])
    atx = re.sub(r"(?:^|\s+)#+\s*$", "", atx)
    return inline_text(atx)


# ── The scanner ───────────────────────────────────────────────────────────────


def extract_headings(markdown: str) -> list[dict]:
    """Headings h1–h4 of a markdown string, ``[{id, text, depth}]``, with the
    ids the viewer gives them. One pass over the lines, no parser; headings
    inside list items aren't seen (as in the frontend scanner)."""
    slug = make_slugger()
    out: list[dict] = []

    def push(depth: int, text: str) -> None:
        if depth <= 4:
            out.append({"id": HEADING_ID_PREFIX + slug(text), "text": text, "depth": depth})

    fence: tuple[str, int] | None = None
    math = html = False
    para: list[str] = []
    for raw in re.split(r"\r?\n", markdown or ""):
        line = _QUOTE_PREFIX.sub("", raw, count=1)
        if fence:
            close = re.match(r"^\s{0,3}(`{3,}|~{3,})\s*$", line)
            if close and close.group(1)[0] == fence[0] and len(close.group(1)) >= fence[1]:
                fence = None
            continue
        if math:
            if re.match(r"^\s{0,3}\$\$\s*$", line):
                math = False
            continue
        if html:
            if not line.strip():
                html = False
            continue
        if not line.strip():
            para = []
            continue
        opened = re.match(r"^\s{0,3}(`{3,}|~{3,})(.*)$", line)
        if opened and not (opened.group(1)[0] == "`" and "`" in opened.group(2)):
            fence = (opened.group(1)[0], len(opened.group(1)))
            para = []
            continue
        if re.match(r"^\s{0,3}\$\$(?!.*\$)", line):
            math = True
            para = []
            continue
        atx = re.match(r"^\s{0,3}(#{1,6})(?:\s|$)", line)
        if atx:
            push(len(atx.group(1)), heading_source_text(line))
            para = []
            continue
        underline = re.match(r"^\s{0,3}(=+|-+)\s*$", line)
        if underline and para:
            push(1 if underline.group(1)[0] == "=" else 2, inline_text(" ".join(para)))
            para = []
            continue
        if not para:
            if re.match(r"^ {4,}|^\t", raw):
                continue  # indented code
            if re.match(r"^\s{0,3}(?:<!--|</?[A-Za-z][\w-]*(?:\s|/?>|$))", line):
                html = True
                continue
        if re.match(r"^\s{0,3}(?:[-+*]|\d{1,9}[.)])(?:\s|$)|^\s{0,3}\||^\s{0,3}(?:[-*_]\s*){3,}$", line):
            para = []
            continue
        para.append(line)
    return out


def heading_titles(markdown: str | None) -> dict[str, str]:
    """{heading id: heading text}."""
    return {h["id"]: h["text"] for h in extract_headings(markdown or "")}


def pretty_heading_id(hid: str) -> str:
    """"user-content-install-the-sdk" → "Install the sdk" (no markdown at hand)."""
    s = re.sub(r"-\d+$", "", hid.removeprefix(HEADING_ID_PREFIX)).replace("-", " ").strip()
    return s[0].upper() + s[1:] if s else "Top of the page"


def section_title(hid: str | None, titles: dict[str, str]) -> str | None:
    if not hid:
        return None
    return titles.get(hid) or pretty_heading_id(hid)


_ID_IN_TEXT = re.compile(r"#?user-content-[^\s,;:!?\"')]+")


def rewrite_ids(text: str, titles: dict[str, str], quote: bool = True) -> str:
    """Insight text may name a section by its heading id; show its title."""
    def sub(m: re.Match) -> str:
        hid = m.group(0).lstrip("#")
        clean = hid.rstrip(".")
        name = section_title(clean, titles) or clean
        return (f"“{name}”" if quote else name) + hid[len(clean):]

    return _ID_IN_TEXT.sub(sub, text or "")


# ── Fenced code blocks (copied-code previews) ─────────────────────────────────


def fenced_blocks(markdown: str | None) -> list[str]:
    out: list[str] = []
    fence: tuple[str, int, int] | None = None
    buf: list[str] = []
    for raw in re.split(r"\r?\n", markdown or ""):
        if fence:
            close = re.match(r"^(\s{0,3})(`{3,}|~{3,})\s*$", raw)
            if close and close.group(2)[0] == fence[0] and len(close.group(2)) >= fence[1]:
                out.append("\n".join(buf).strip())
                fence, buf = None, []
            else:
                buf.append(re.sub(f"^ {{0,{fence[2]}}}", "", raw) if fence[2] else raw)
            continue
        opened = re.match(r"^(\s{0,3})(`{3,}|~{3,})(.*)$", raw)
        if opened and not (opened.group(2)[0] == "`" and "`" in opened.group(3)):
            fence = (opened.group(2)[0], len(opened.group(2)), len(opened.group(1)))
            buf = []
    if fence and buf:
        out.append("\n".join(buf).strip())
    return out


def _fnv(units) -> int:
    h = 0x811C9DC5
    for b in units:
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def _fnv_utf8(text: str) -> int:
    return _fnv(text.encode("utf-8"))


def _fnv_units(text: str) -> int:
    data = text.encode("utf-16-le")
    return _fnv(int.from_bytes(data[i:i + 2], "little") for i in range(0, len(data), 2))


def block_preview(blocks: list[str], hash_hex: str) -> str | None:
    """The first non-empty line of the fenced block whose hash matches."""
    try:
        want = int(hash_hex, 16)
    except (TypeError, ValueError):
        return None
    for b in blocks:
        if _fnv_utf8(b) == want or _fnv_units(b) == want:
            return next((ln.strip() for ln in b.split("\n") if ln.strip()), None)
    return None


# ── For a stored document ─────────────────────────────────────────────────────


def doc_heading_titles(raw: dict) -> dict[str, str]:
    """Heading titles of a stored markdown document. Empty for files and for
    end-to-end encrypted documents (their content is ciphertext)."""
    if raw.get("kind") == "artifact" or raw.get("encrypted"):
        return {}
    return heading_titles(raw.get("content"))


def display_title(raw: dict) -> str:
    """What a person would call the document: its title, else (markdown) its
    first heading, else its file name, else its slug. Never an encrypted
    document's stored title (ciphertext)."""
    if not raw.get("encrypted"):
        t = (raw.get("title") or "").strip()
        if t:
            return t
        if raw.get("kind") != "artifact":
            from app.services.doc_ref import heading_title

            t = heading_title((raw.get("content") or "")[:2000])
            if t:
                return inline_text(t) or t
        if raw.get("original_filename"):
            return raw["original_filename"]
    return raw.get("slug") or "Untitled"


def plain_insight(insight: dict, titles: dict[str, str]) -> dict:
    """An insight's {title, body} with section ids in words."""
    return {"title": rewrite_ids(insight.get("title") or "", titles),
            "body": rewrite_ids(insight.get("body") or "", titles)}
