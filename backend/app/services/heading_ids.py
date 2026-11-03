"""Heading ids as the reader's renderer gives them, for links to a page's sections.

A Python port of ``frontend/src/components/reading/slug.ts`` (``slugify``,
``createSlugger``, ``inlineText``, ``headingSourceText`` and the ``extractHeadings``
scanner). Page AI's Ask links its answers to ``#<id>`` and must produce exactly the
ids the page shows: the renderer sets ``id="user-content-<id>"`` on h1–h4, and a
link to ``#<id>`` (no prefix) scrolls to it (components/reading/navigate.ts). Keep
the two in step; tests/test_pages_ai.py pins a few cases.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

PREFIX = "user-content-"


@dataclass
class Heading:
    id: str        # without the user-content- prefix: what a #link uses
    text: str
    depth: int


def _keep(ch: str) -> bool:
    if ch in " -":
        return True
    cat = unicodedata.category(ch)
    return cat[0] in ("L", "M", "N") or cat == "Pc"


def slugify(text: str) -> str:
    """github-slugger-like: lower-case, keep letters/marks/numbers/connector punctuation, spaces → "-"."""
    t = re.sub(r"\s+", " ", text).strip().lower()
    t = "".join(ch for ch in t if _keep(ch))
    return t.replace(" ", "-")


def slugger():
    seen: dict[str, int] = {}

    def slug(text: str) -> str:
        base = slugify(text) or "section"
        s = base
        while s in seen:
            n = seen.get(base, 0) + 1
            seen[base] = n
            s = f"{base}-{n}"
        seen[s] = 0
        return s

    return slug


_ENTITIES = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'", "nbsp": "\u00a0"}
_PH_OPEN, _PH_CLOSE = "\ue000", "\ue001"


def inline_text(src: str) -> str:
    """Inline Markdown → the text a reader sees (links keep their text, images drop)."""
    keep: list[str] = []

    def stash(s: str) -> str:
        keep.append(s)
        return f"{_PH_OPEN}{len(keep) - 1}{_PH_CLOSE}"

    s = re.sub(r"\\([!-/:-@\[-`{-~])", lambda m: stash(m.group(1)), src)

    def code(m: re.Match) -> str:
        c = m.group(2)
        mm = re.fullmatch(r" (.*) ", c)
        return stash(mm.group(1) if mm else c)

    s = re.sub(r"(`+)([\s\S]*?[^`])\1(?!`)", code, s)
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
    s = re.sub(r"(^|[^\w]|_)_(?=\S)([\s\S]*?\S)_(?![^\W_])",
               lambda m: m.group(1) + m.group(2), s)
    s = re.sub(r"~~?(?=\S)([\s\S]*?\S)~~?", r"\1", s)

    def entity(m: re.Match) -> str:
        e = m.group(1)
        if e[0] == "#":
            try:
                code_point = int(e[2:], 16) if e[1] in "xX" else int(e[1:], 10)
                return chr(code_point) if code_point > 0 else m.group(0)
            except (ValueError, OverflowError):
                return m.group(0)
        return _ENTITIES.get(e.lower(), m.group(0))

    s = re.sub(r"&(#x[0-9a-f]+|#\d+|[a-z]+);", entity, s, flags=re.I)
    s = re.sub(f"{_PH_OPEN}(\\d+){_PH_CLOSE}", lambda m: keep[int(m.group(1))] if int(m.group(1)) < len(keep) else "", s)
    return re.sub(r"\s+", " ", s).strip()


_QUOTE_PREFIX = re.compile(r"^\s{0,3}(?:>\s?)+")


def heading_source_text(line: str) -> str:
    atx = re.sub(r"^\s{0,3}#{1,6}(?=\s|$)", "", line, count=1)
    atx = re.sub(r"(?:^|\s+)#+\s*$", "", atx, count=1)
    return inline_text(atx)


def extract(markdown: str) -> list[Heading]:
    """Headings h1–h4 of a page body (front matter already removed), with their ids."""
    slug = slugger()
    out: list[Heading] = []

    def push(depth: int, text: str) -> None:
        if depth > 4:
            return
        out.append(Heading(id=slug(text), text=text, depth=depth))

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
        op = re.match(r"^\s{0,3}(`{3,}|~{3,})(.*)$", line)
        if op and not (op.group(1)[0] == "`" and "`" in op.group(2)):
            fence = (op.group(1)[0], len(op.group(1)))
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
        under = re.match(r"^\s{0,3}(=+|-+)\s*$", line)
        if under and para:
            push(1 if under.group(1)[0] == "=" else 2, inline_text(" ".join(para)))
            para = []
            continue
        if not para:
            if re.match(r"^ {4,}|^\t", raw):
                continue
            if re.match(r"^\s{0,3}(?:<!--|</?[A-Za-z][\w-]*(?:\s|/?>|$))", line):
                html = True
                continue
        if re.match(r"^\s{0,3}(?:[-+*]|\d{1,9}[.)])(?:\s|$)|^\s{0,3}\||^\s{0,3}(?:[-*_]\s*){3,}$", line):
            para = []
            continue
        para.append(line)
    return out
