"""The docs, loaded for the Ask AI agent: pages, sections, search and the brief.

One index per docs site (services/docs_sites.py): a site's folder holds
``**/*.md`` plus ``site.json``, ``changelog.json``, ``videos.json`` and an
optional ``ai.json`` (Markdrop's is frontend/content/docs). Content is written by people and by other tools while this runs, so nothing
here throws on bad content: a page without frontmatter gets a title from its
file name, malformed JSON reads as empty, a missing folder is an empty index.

Section anchors are the ids the docs site gives its headings: the same
github-slugger-like slug of each heading's *source* text, in document order,
that ``frontend/src/components/reading/slug.ts`` computes (``createSlugger`` +
``headingSourceText``), over the same lines ``frontend/src/docs/markdown.ts``
(``scanHeadings``) looks at: ATX h1–h4 outside fenced code and ``$$`` math.
The tests pin a set of tricky headings against the TypeScript output.

Directive syntax (``:::note``, ``::::steps``, ``::video{…}``, ``:kbd[…]``) is
turned into plain Markdown the way ``toPlainMarkdown`` does, so what the model
reads is what a reader sees, minus the components.

Search is a small pure-Python BM25 over sections with field boosts (page title,
heading, keywords + description, body), with the site's ai.json synonyms added
to queries. Indexes are built on first use and kept for the most recently used
sites (settings.docs_sites_cache_size); each rebuilds itself when a file under
its folder changes (checked at most every few seconds). A Markdrop Guides site has
no folder: its index is built from its live build's snapshot (aget_index) and
rebuilt when the live build changes.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import threading
import time
import unicodedata
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path

from app.config import get_settings
from app.services import docs_sites
from app.services.docs_sites import DEFAULT_SITE, UnknownSite  # noqa: F401  (re-exported)

SKIP_DIRS = {"video-scenes", "node_modules"}
RECHECK_S = 5.0
SITE_FILES = ("site.json", "changelog.json", "videos.json", "ai.json")


def content_dir() -> Path:
    """Markdrop's own docs folder (see docs_sites.default_content_dir)."""
    return docs_sites.default_content_dir()


# ── Slugs (port of frontend/src/components/reading/slug.ts) ───────────────────


def _keep_slug_char(ch: str) -> bool:
    if ch in (" ", "-"):
        return True
    cat = unicodedata.category(ch)
    return cat[0] in ("L", "M", "N") or cat == "Pc"


def slugify(text: str) -> str:
    t = re.sub(r"\s+", " ", text).strip().lower()
    t = "".join(ch for ch in t if _keep_slug_char(ch))
    return t.replace(" ", "-")


def create_slugger():
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


_PH_OPEN, _PH_CLOSE = "\ue000", "\ue001"
_ENTITIES = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'", "nbsp": "\u00a0"}


def inline_text(src: str) -> str:
    """Inline markdown → the text a reader sees (port of `inlineText`)."""
    keep: list[str] = []

    def stash(s: str) -> str:
        keep.append(s)
        return f"{_PH_OPEN}{len(keep) - 1}{_PH_CLOSE}"

    s = re.sub(r"\\([!-/:-@\[-`{-~])", lambda m: stash(m.group(1)), src)
    s = re.sub(r"(`+)([\s\S]*?[^`])\1(?!`)", lambda m: stash(re.sub(r"^ (.*) $", r"\1", m.group(2))), s)
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
    s = re.sub(r"(^|[\W_])_(?=\S)([\s\S]*?\S)_(?![^\W_])", r"\1\2", s)
    s = re.sub(r"~~?(?=\S)([\s\S]*?\S)~~?", r"\1", s)

    def entity(m: re.Match) -> str:
        e = m.group(1)
        if e[0] == "#":
            try:
                code = int(e[2:], 16) if e[1] in "xX" else int(e[1:], 10)
                return chr(code) if code > 0 else m.group(0)
            except (ValueError, OverflowError):
                return m.group(0)
        return _ENTITIES.get(e.lower(), m.group(0))

    s = re.sub(r"&(#x[0-9a-f]+|#\d+|[a-z]+);", entity, s, flags=re.I)
    s = re.sub(f"{_PH_OPEN}(\\d+){_PH_CLOSE}", lambda m: keep[int(m.group(1))] if int(m.group(1)) < len(keep) else "", s)
    return re.sub(r"\s+", " ", s).strip()


def heading_source_text(line: str) -> str:
    """One ATX heading line → its plain text (port of `headingSourceText`)."""
    atx = re.sub(r"^\s{0,3}#{1,6}(?=\s|$)", "", line, count=1)
    atx = re.sub(r"(?:^|\s+)#+\s*$", "", atx)
    return inline_text(atx)


# ── Lines, headings, directives (port of frontend/src/docs/markdown.ts) ───────

_QUOTE = re.compile(r"^\s{0,3}(?:>\s?)+")
_FENCE_OPEN = re.compile(r"^\s{0,3}(`{3,}|~{3,})(.*)$")
_FENCE_CLOSE = re.compile(r"^\s{0,3}(`{3,}|~{3,})\s*$")
DIRECTIVE_OPEN = re.compile(r"^\s*(:{3,})([A-Za-z][\w-]*)(?:\[([^\]]*)\])?(?:\{([^}]*)\})?\s*$")
DIRECTIVE_CLOSE = re.compile(r"^\s*(:{3,})\s*$")
DIRECTIVE_LEAF = re.compile(r"^\s*::([A-Za-z][\w-]*)(?:\[([^\]]*)\])?(?:\{([^}]*)\})?\s*$")
_TEXT_DIRECTIVE = re.compile(r"(^|[^\w:\\]):([A-Za-z][\w-]*)\[([^\]]*)\](?:\{[^}]*\})?")
TEXT_DIRECTIVES = ("kbd",)
CALLOUTS = {"note": "Note", "tip": "Tip", "warning": "Warning", "danger": "Danger"}


def walk_lines(body: str):
    """(raw line, index, inside fenced code or $$ math)."""
    fence: tuple[str, int] | None = None
    math_block = False
    for i, raw in enumerate(re.split(r"\r?\n", body)):
        line = _QUOTE.sub("", raw, count=1)
        if fence:
            close = _FENCE_CLOSE.match(line)
            if close and close.group(1)[0] == fence[0] and len(close.group(1)) >= fence[1]:
                fence = None
            yield raw, i, True
            continue
        if math_block:
            if re.match(r"^\s{0,3}\$\$\s*$", line):
                math_block = False
            yield raw, i, True
            continue
        op = _FENCE_OPEN.match(line)
        if op and not (op.group(1)[0] == "`" and "`" in op.group(2)):
            fence = (op.group(1)[0], len(op.group(1)))
            yield raw, i, True
            continue
        if re.match(r"^\s{0,3}\$\$(?!.*\$\$)", line):
            math_block = True
            yield raw, i, True
            continue
        yield raw, i, False


@dataclass
class Heading:
    id: str
    text: str
    depth: int
    line: int


def scan_headings(body: str) -> list[Heading]:
    slug = create_slugger()
    out: list[Heading] = []
    for raw, i, code in walk_lines(body):
        if code:
            continue
        line = _QUOTE.sub("", raw, count=1)
        m = re.match(r"^\s{0,3}(#{1,6})(?:\s|$)", line)
        if not m or len(m.group(1)) > 4:
            continue
        text = heading_source_text(line)
        out.append(Heading(id=slug(text), text=text, depth=len(m.group(1)), line=i))
    return out


def parse_attrs(src: str | None) -> dict[str, str]:
    out: dict[str, str] = {}
    if not src:
        return out
    for m in re.finditer(r"([A-Za-z_][\w-]*)(?:=(?:\"([^\"]*)\"|'([^']*)'|([^\s\"']+)))?|#([\w-]+)|\.([\w-]+)", src):
        if m.group(5):
            out["id"] = m.group(5)
        elif m.group(6):
            out["class"] = f"{out['class']} {m.group(6)}" if "class" in out else m.group(6)
        elif m.group(1):
            out[m.group(1)] = next((g for g in (m.group(2), m.group(3), m.group(4)) if g is not None), "")
    return out


def to_plain_markdown(body: str, *, base: str | None = None, videos: dict | None = None) -> str:
    """Directive syntax → plain GitHub Markdown (port of `toPlainMarkdown`)."""
    out: list[str] = []
    stack: list[bool] = []  # True = this container renders as a blockquote

    def prefix() -> str:
        return "> " * sum(1 for q in stack if q)

    def emit(s: str) -> None:
        p = prefix()
        out.append((p + s if s else p.rstrip()) if p else s)

    for raw, _i, code in walk_lines(body):
        if code:
            emit(raw)
            continue
        op = DIRECTIVE_OPEN.match(raw)
        if op:
            name, label, attrs = op.group(2), op.group(3), op.group(4)
            a = parse_attrs(attrs)
            if name in CALLOUTS:
                emit("")
                stack.append(True)
                emit(f"**{CALLOUTS[name]}: {label}**" if label else f"**{CALLOUTS[name]}**")
                emit("")
            else:
                stack.append(False)
                if name in ("details", "tab"):
                    emit("")
                    emit(f"**{label or ('Option' if name == 'tab' else 'Details')}**")
                    emit("")
                elif name == "card":
                    href = a.get("href", "")
                    if href.startswith("/") and base:
                        href = base + href
                    emit("")
                    emit(f"**[{label or href}]({href})**" if href else f"**{label or ''}**")
                    emit("")
            continue
        if DIRECTIVE_CLOSE.match(raw):
            if stack:
                stack.pop()
            emit("")
            continue
        leaf = DIRECTIVE_LEAF.match(raw)
        if leaf:
            name, label, attrs = leaf.group(1), leaf.group(2), leaf.group(3)
            a = parse_attrs(attrs)
            if name == "video":
                v = (videos or {}).get(a.get("id", "")) if a.get("id") else None
                if isinstance(v, dict) and v.get("url"):
                    dur = f" ({a['duration']})" if a.get("duration") else ""
                    emit(f"[Video: {a.get('title') or label or a.get('id')}{dur}]({v['url']})")
            elif name == "embed" and a.get("src"):
                emit(f"[{a.get('title') or label or a['src']}]({a['src']})")
            continue
        line = _TEXT_DIRECTIVE.sub(lambda m: f"{m.group(1)}{m.group(3)}" if m.group(2) in TEXT_DIRECTIVES else m.group(0), raw)
        if base:
            line = re.sub(r"\]\((/[^)\s]*)", lambda m: f"]({base}{m.group(1)}", line)
        emit(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


def plain_text(md: str) -> str:
    """Markdown (directives allowed) → one line of plain text, for search."""
    parts: list[str] = []
    for raw, _i, code in walk_lines(to_plain_markdown(md)):
        if code:
            if not re.match(r"^\s{0,3}(`{3,}|~{3,}|\$\$)", raw):
                parts.append(raw.strip())
            continue
        line = _QUOTE.sub("", raw, count=1).strip()
        if not line or re.match(r"^\|?\s*:?-{3,}", line):
            continue
        line = re.sub(r"^#{1,6}\s+", "", line)
        line = re.sub(r"^(?:[-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?", "", line)
        parts.append(inline_text(line.replace("|", " ")))
    return re.sub(r"\s+", " ", " ".join(parts)).strip()


# ── Frontmatter (the YAML subset the docs use) ────────────────────────────────

_FM = re.compile(r"^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)")


def _scalar(v: str) -> str:
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        inner = v[1:-1]
        return inner.replace('\\"', '"') if v[0] == '"' else inner.replace("''", "'")
    return re.sub(r"\s+#.*$", "", v).strip()


def _split_inline_list(v: str) -> list[str]:
    items, cur, quote = [], "", None
    for ch in v:
        if quote:
            cur += ch
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
            cur += ch
        elif ch == ",":
            items.append(cur)
            cur = ""
        else:
            cur += ch
    items.append(cur)
    return [_scalar(x) for x in items if x.strip()]


def parse_frontmatter(source: str) -> tuple[dict, str]:
    src = source.lstrip("\ufeff")
    m = _FM.match(src)
    if not m:
        return {}, src
    data: dict = {}
    key = None
    for line in m.group(1).split("\n"):
        line = line.rstrip("\r")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        item = re.match(r"^\s+-\s+(.*)$", line)
        if item and key is not None:
            if not isinstance(data.get(key), list):
                data[key] = []
            data[key].append(_scalar(item.group(1)))
            continue
        kv = re.match(r"^([A-Za-z_][\w-]*)\s*:\s*(.*)$", line)
        if not kv:
            continue
        key, raw = kv.group(1), kv.group(2).strip()
        if raw.startswith("[") and raw.rstrip().endswith("]"):
            data[key] = _split_inline_list(raw.strip()[1:-1])
        elif raw == "":
            data[key] = ""
        else:
            data[key] = _scalar(raw)
    body = src[m.end():]
    body = re.sub(r"^\s*\n", "", body, count=1)
    return data, body


def _list(v) -> list[str]:
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    if isinstance(v, str) and v.strip():
        return [x.strip() for x in v.split(",") if x.strip()]
    return []


# ── Model ─────────────────────────────────────────────────────────────────────


@dataclass
class Section:
    key: str                  # "<page>#<anchor>" or "<page>" for the intro
    page: str                 # docs path, "/workspaces/custom-domain"
    anchor: str | None
    title: str                # heading text, or the page title for the intro
    depth: int                # 0 intro, 1–4 heading depth
    parent: str | None        # the h2 an h3 sits under
    text: str                 # plain text of this section's own lines (search)
    raw: str                  # markdown from the heading to the next heading of the same or higher level
    page_title: str = ""
    kind: str = "section"     # section | changelog


@dataclass
class Page:
    path: str
    file: str
    title: str
    description: str
    updated: str | None
    keywords: list[str]
    since: str | None
    prerequisites: list[str]
    body: str
    headings: list[Heading]
    sections: list[Section] = field(default_factory=list)
    group: str | None = None


def file_to_path(rel: str) -> str:
    p = "/" + re.sub(r"\.md$", "", rel)
    return re.sub(r"/index$", "", p) or "/"


def _title_from_file(rel: str) -> str:
    stem = Path(rel).stem.replace("-", " ").replace("_", " ").strip()
    return stem[:1].upper() + stem[1:] if stem else "Untitled"


def _build_sections(page: Page) -> list[Section]:
    lines = re.split(r"\r?\n", page.body)
    hs = page.headings
    out: list[Section] = []
    first = hs[0].line if hs else len(lines)
    intro_raw = "\n".join(lines[:first]).strip()
    out.append(Section(key=page.path, page=page.path, anchor=None, title=page.title, depth=0, parent=None,
                       text=plain_text(intro_raw), raw=intro_raw, page_title=page.title))
    parent = None
    for idx, h in enumerate(hs):
        nxt_any = hs[idx + 1].line if idx + 1 < len(hs) else len(lines)
        nxt_same = next((o.line for o in hs[idx + 1:] if o.depth <= h.depth), len(lines))
        own = "\n".join(lines[h.line + 1:nxt_any])
        raw = "\n".join(lines[h.line:nxt_same]).strip()
        if h.depth <= 2:
            parent = h.text
        out.append(Section(key=f"{page.path}#{h.id}", page=page.path, anchor=h.id, title=h.text, depth=h.depth,
                           parent=parent if h.depth > 2 else None, text=plain_text(own), raw=raw,
                           page_title=page.title))
    return out


# ── BM25 ──────────────────────────────────────────────────────────────────────

_STOP = frozenset("""a an and are as at be but by can do does for from how i if in into is it its me my of on or
so that the their them then there these this to was we what when where which who why will with you your yours
able about after all also am any been before being both each had has have he her here him his just more most no
not now only other our out over own same she should some such than too under until up very were while would
make get want need way possible please tell know
""".split())


def _stem(t: str) -> str:
    for suf in ("ing", "ied", "ies", "ed", "es", "s"):
        if len(t) > len(suf) + 2 and t.endswith(suf):
            if suf in ("ied", "ies"):
                return t[: -len(suf)] + "y"
            if suf == "es" and not re.search(r"(ss|x|ch|sh|z)es$", t):
                return t[:-1]
            return t[: -len(suf)]
    return t


def tokenize(text: str) -> list[str]:
    toks = re.findall(r"[^\W_]+", (text or "").lower())
    return [_stem(t) for t in toks if t not in _STOP and (len(t) > 1 or t.isdigit())]


def expand_query(terms: list[str], synonyms: dict[str, list[str]] | None = None) -> list[tuple[str, float]]:
    """Query terms with synonyms added at half weight.

    `synonyms` (words people ask with → the words the docs use) come from the
    site's ai.json and are looked up by query token.
    """
    out: dict[str, float] = {t: 1.0 for t in terms}
    for t in terms:
        for syn in (synonyms or {}).get(t, []):
            for s in tokenize(syn):
                out.setdefault(s, 0.5)
    return list(out.items())


FIELDS = {"page_title": 1.5, "heading": 2.5, "keywords": 1.5, "body": 1.0}
K1, B = 1.2, 0.75


@dataclass
class _Doc:
    section: Section
    tf: dict[str, dict[str, int]]
    lengths: dict[str, int]


class Index:
    def __init__(self, root: Path, site_id: str = DEFAULT_SITE):
        self.root = root
        self.site_id = site_id
        self.cfg = docs_sites.SiteConfig(site_id, root, {}, {})
        self.synonyms: dict[str, list[str]] = {}
        self.site: dict = {}
        self.changelog: dict = {}
        self.videos: dict = {}
        self.pages: dict[str, Page] = {}
        self.sections: dict[str, Section] = {}
        self._docs: list[_Doc] = []
        self._df: dict[str, int] = {}
        self._avg: dict[str, float] = {}
        self.signature: tuple = ()
        self.brief: str = ""
        self.loaded_at = time.time()

    @property
    def site_url(self) -> str:
        return self.cfg.url

    def url_for(self, page: str, anchor: str | None = None) -> str:
        path = "" if page == "/" else page
        return f"{self.site_url}{path}" + (f"#{anchor}" if anchor else "")

    # ── loading ──

    def _json(self, name: str) -> dict:
        try:
            v = json.loads((self.root / name).read_text("utf-8"))
            return v if isinstance(v, dict) else {}
        except Exception:
            return {}

    def load(self) -> "Index":
        """The site's folder: its Markdown files, site.json, ai.json, changelog and videos."""
        self.signature = scan_signature(self.root)
        self.cfg = docs_sites.SiteConfig.load(self.site_id, self.root)
        self.changelog = self._json("changelog.json")
        self.videos = self._json("videos.json")

        def sources():
            for rel in _walk(self.root):
                try:
                    yield rel, (self.root / rel).read_text("utf-8")
                except Exception:
                    continue

        return self._build(sources())

    def load_files(self, files: dict[str, str], cfg, signature: tuple) -> "Index":
        """The same, from a content folder held in memory ({relative path: text}, the
        files docs_snapshot.content_files writes for the engine) and the site's settings."""
        self.signature = signature
        self.cfg = cfg
        self.changelog = _parse_json(files.get("changelog.json"))
        self.videos = _parse_json(files.get("videos.json"))
        rels = sorted((r for r in files if _walkable(r)), key=_walk_order)
        return self._build((r, files[r]) for r in rels)

    def _build(self, sources) -> "Index":
        self.site = self.cfg.site
        self.synonyms = self.cfg.synonyms
        groups: dict[str, str] = {}
        for g in self.site.get("nav") or []:
            if isinstance(g, dict):
                for p in g.get("pages") or []:
                    if isinstance(p, str):
                        groups.setdefault(p, str(g.get("group") or ""))
        for rel, src in sources:
            data, body = parse_frontmatter(src)
            path = file_to_path(rel)
            page = Page(
                path=path, file=rel,
                title=str(data.get("title") or "").strip() or _title_from_file(rel),
                description=str(data.get("description") or "").strip(),
                updated=str(data.get("updated")) if data.get("updated") else None,
                keywords=_list(data.get("keywords")),
                since=str(data.get("since")) if data.get("since") else None,
                prerequisites=_list(data.get("prerequisites")),
                body=body, headings=scan_headings(body), group=groups.get(path),
            )
            page.sections = _build_sections(page)
            self.pages[path] = page
            for s in page.sections:
                self.sections[s.key] = s
        for entry in self.changelog_entries():
            key = f"/changelog/{entry['id']}"
            body = "\n\n".join(str(x) for x in (entry.get("summary"), entry.get("body"),
                                                  "\n".join(f"- {h}" for h in entry.get("highlights") or [])) if x)
            self.sections[key] = Section(
                key=key, page=key, anchor=None, title=str(entry.get("title") or entry["id"]), depth=0,
                parent=None, text=plain_text(body), raw=body, page_title="Changelog", kind="changelog")
        self._build_search()
        self.brief = self._build_brief()
        self.loaded_at = time.time()
        return self

    def changelog_entries(self) -> list[dict]:
        out = []
        for e in self.changelog.get("entries") or []:
            if isinstance(e, dict) and isinstance(e.get("id"), str) and re.match(r"^[\w-]{1,80}$", e["id"]):
                out.append(e)
        out.sort(key=lambda e: str(e.get("date") or ""), reverse=True)
        return out

    # ── search ──

    def _build_search(self) -> None:
        docs: list[_Doc] = []
        df: dict[str, int] = {}
        totals = {f: 0 for f in FIELDS}
        for s in self.sections.values():
            page = self.pages.get(s.page)
            heading = " ".join(x for x in (s.parent, s.title if s.depth else "") if x)
            fields = {
                "page_title": tokenize(s.page_title),
                "heading": tokenize(heading),
                "keywords": tokenize(" ".join((page.keywords if page else []) + [page.description if page else ""])),
                "body": tokenize(s.text),
            }
            tf: dict[str, dict[str, int]] = {}
            lengths = {}
            seen: set[str] = set()
            for f, toks in fields.items():
                lengths[f] = len(toks)
                totals[f] += len(toks)
                counts: dict[str, int] = {}
                for t in toks:
                    counts[t] = counts.get(t, 0) + 1
                    seen.add(t)
                tf[f] = counts
            for t in seen:
                df[t] = df.get(t, 0) + 1
            docs.append(_Doc(section=s, tf=tf, lengths=lengths))
        n = max(1, len(docs))
        self._docs, self._df = docs, df
        self._avg = {f: (totals[f] / n) or 1.0 for f in FIELDS}

    def search(self, query: str, limit: int = 5, per_page: int = 2) -> list[tuple[Section, float]]:
        terms = list(dict.fromkeys(tokenize(query)))
        if not terms or not self._docs:
            return []
        weighted = expand_query(terms, self.synonyms)
        n = len(self._docs)
        q_norm = " ".join(re.findall(r"[^\W_]+", query.lower()))
        scored: list[tuple[float, _Doc]] = []
        for d in self._docs:
            score = 0.0
            for t, qw in weighted:
                dfi = self._df.get(t)
                if not dfi:
                    continue
                idf = qw * math.log(1 + (n - dfi + 0.5) / (dfi + 0.5))
                for f, w in FIELDS.items():
                    tf = d.tf[f].get(t)
                    if not tf:
                        continue
                    norm = 1 - B + B * d.lengths[f] / self._avg[f]
                    score += w * idf * tf * (K1 + 1) / (tf + K1 * norm)
            if score <= 0:
                continue
            # A phrase match in the heading or text is worth a nudge.
            if len(terms) > 1 and q_norm:
                hay = " ".join(re.findall(r"[^\W_]+", f"{d.section.title} {d.section.text}".lower()))
                if q_norm in hay:
                    score *= 1.25
            scored.append((score, d))
        scored.sort(key=lambda x: (-x[0], x[1].section.key))
        out: list[tuple[Section, float]] = []
        per: dict[str, int] = {}
        for score, d in scored:
            p = d.section.page
            if per.get(p, 0) >= per_page:
                continue
            per[p] = per.get(p, 0) + 1
            out.append((d.section, round(score, 3)))
            if len(out) >= limit:
                break
        return out

    def snippet(self, section: Section, query: str, n: int = 240) -> str:
        text = section.text or (self.pages[section.page].description if section.page in self.pages else "")
        if len(text) <= n:
            return text
        terms = [t for t in re.findall(r"[^\W_]+", query.lower()) if t not in _STOP and len(t) > 2]
        low = text.lower()
        pos = min((low.find(t) for t in terms if low.find(t) >= 0), default=0)
        start = max(0, pos - n // 3)
        if start:
            sp = text.find(" ", start)
            start = sp + 1 if 0 <= sp < start + 30 else start
        cut = text[start:start + n]
        sp = cut.rfind(" ")
        if sp > n - 40:
            cut = cut[:sp]
        return ("…" if start else "") + cut.rstrip(" ,.;:") + "…"

    # ── reading ──

    def plain(self, md: str) -> str:
        return to_plain_markdown(md, base=self.site_url, videos=self.videos)

    def resolve_page(self, ref: str) -> Page | None:
        """'/a/b', 'a/b', 'https://docs.markdrop.in/a/b#x', '/a/b.md' → the page."""
        if not isinstance(ref, str):
            return None
        r = ref.strip()
        r = re.sub(r"^https?://[^/]+", "", r)
        r = r.split("#", 1)[0].split("?", 1)[0]
        r = re.sub(r"\.md$", "", r).rstrip("/")
        if not r.startswith("/"):
            r = "/" + r
        return self.pages.get(r or "/") or self.pages.get(r)

    # ── brief ──

    def _build_brief(self) -> str:
        site = self.site
        product = site.get("product") if isinstance(site.get("product"), dict) else {}
        product_url = product.get("url") if isinstance(product.get("url"), str) else ""
        name = product.get("name") if isinstance(product.get("name"), str) and product.get("name") else self.cfg.name
        lines = [
            f"Product: {name} ({product_url})." if product_url else f"Product: {name}.",
            f"Docs site: {self.site_url}. {str(site.get('description') or '').strip()}".strip(),
            "",
            "Site map (path: title, what it covers):",
        ]
        listed: set[str] = set()
        for g in site.get("nav") or []:
            if not isinstance(g, dict):
                continue
            entries = []
            for p in g.get("pages") or []:
                page = self.pages.get(p) if isinstance(p, str) else None
                if page is None:
                    continue
                listed.add(p)
                desc = f": {page.description}" if page.description else ""
                entries.append(f"- {p}: {page.title}{desc}")
            if entries:
                lines.append(f"{g.get('group') or 'Pages'}")
                lines.extend(entries)
        rest = sorted(p for p in self.pages if p not in listed and p != "/")
        if rest:
            lines.append("Other pages")
            for p in rest:
                page = self.pages[p]
                desc = f": {page.description}" if page.description else ""
                lines.append(f"- {p}: {page.title}{desc}")
        if not self.pages:
            lines.append("- (no pages are published yet)")
        if self.cfg.product_tools:
            from app.services import platform_facts

            lines += ["", "Key limits (from the running code):"]
            lines += [f"- {x}" for x in platform_facts.brief_lines()]
        entries = self.changelog_entries()
        if entries:
            latest = entries[0]
            lines += ["", f"Changelog: {len(entries)} entries; latest {latest.get('date')}: {latest.get('title')}. "
                          "Call get_changelog for details."]
        return "\n".join(lines)


def _walk(root: Path) -> list[str]:
    out: list[str] = []
    if not root.is_dir():
        return out
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith((".", "_")))
        rel_dir = os.path.relpath(dirpath, root)
        for name in sorted(filenames):
            if name.startswith((".", "_")) or not name.endswith(".md"):
                continue
            rel = name if rel_dir == "." else f"{rel_dir}/{name}".replace(os.sep, "/")
            out.append(rel)
    return out


def _walkable(rel: str) -> bool:
    """A Markdown file _walk would pick up (for a folder held in memory)."""
    parts = rel.split("/")
    if not rel.endswith(".md") or any(not p for p in parts):
        return False
    return not any(p.startswith((".", "_")) for p in parts) and not any(p in SKIP_DIRS for p in parts[:-1])


def _walk_order(rel: str) -> tuple:
    """_walk's order: a folder's files (sorted), then its sub-folders (sorted), depth first."""
    parts = rel.split("/")
    return tuple(parts[:-1]), parts[-1]


def _parse_json(text: str | None) -> dict:
    try:
        v = json.loads(text) if text else {}
        return v if isinstance(v, dict) else {}
    except Exception:
        return {}


def scan_signature(root: Path) -> tuple:
    sig = []
    for rel in _walk(root):
        try:
            st = (root / rel).stat()
            sig.append((rel, st.st_mtime_ns, st.st_size))
        except OSError:
            continue
    for name in SITE_FILES:
        try:
            st = (root / name).stat()
            sig.append((name, st.st_mtime_ns, st.st_size))
        except OSError:
            pass
    return tuple(sig)


# ── The shared instances: one per site, least recently used dropped ──────────

_lock = threading.Lock()


@dataclass
class _Entry:
    index: Index
    checked: float


_entries: "OrderedDict[str, _Entry]" = OrderedDict()


def get_index(site: str | None = DEFAULT_SITE, force: bool = False) -> Index:
    """A site's current index, rebuilt when a file changed (checked every few seconds).

    Raises docs_sites.UnknownSite for a site that isn't registered.
    """
    site_id, root = docs_sites.resolve(site)
    now = time.monotonic()
    with _lock:
        entry = _entries.get(site_id)
        if entry is not None and not force and entry.index.root == root and now - entry.checked < RECHECK_S:
            _entries.move_to_end(site_id)
            return entry.index
        if entry is None or force or entry.index.root != root or scan_signature(root) != entry.index.signature:
            index = Index(root, site_id).load()
        else:
            index = entry.index
        _entries[site_id] = _Entry(index=index, checked=now)
        _entries.move_to_end(site_id)
        while len(_entries) > max(1, get_settings().docs_sites_cache_size):
            _entries.popitem(last=False)
        return index


_studio_loads: dict[tuple, asyncio.Future] = {}


async def aget_index(db, site: str | None = DEFAULT_SITE) -> Index:
    """get_index() that also serves live Markdrop Guides sites (services/docs_sites.py).

    A studio site's index is its live build's snapshot, turned into the content
    folder the engine builds from (docs_snapshot.content_files) and indexed
    exactly like a folder on disk, so page paths and section anchors are the
    ones the built site has. It shares the LRU with the file-based sites, keyed
    by site id, and is rebuilt when the site's live build changes. Raises
    docs_sites.UnknownSite.
    """
    try:
        return get_index(site)
    except UnknownSite:
        st = await docs_sites.studio_site(db, docs_sites.normalize_id(site))
        if st is None:
            raise
    signature = ("docs-studio", st.live_build_id)
    with _lock:
        entry = _entries.get(st.id)
        if entry is not None and entry.index.signature == signature:
            _entries.move_to_end(st.id)
            entry.index.cfg.state = st  # the AI switch, name and suggestions, as read just now
            return entry.index
    key = (db.name, st.id, st.live_build_id)
    fut = _studio_loads.get(key)
    if fut is None:
        fut = asyncio.ensure_future(_load_studio(db, st, signature))
        _studio_loads[key] = fut
        fut.add_done_callback(lambda _f: _studio_loads.pop(key, None))
    index = await asyncio.shield(fut)
    index.cfg.state = st
    return index


async def _load_studio(db, st, signature: tuple) -> Index:
    from app.services import docs_snapshot
    from app.services.docs_site_store import SNAPSHOTS

    snap = await db[SNAPSHOTS].find_one({"_id": st.snapshot_id})
    if snap is None:
        raise UnknownSite(st.id)
    await docs_snapshot._page_ids(db, snap)  # older snapshots: nav refers to page ids
    files, _warnings = docs_snapshot.content_files(st.row, snap, url=st.url, ai_api="")

    def build() -> Index:
        site = _parse_json(files.get("site.json"))
        return Index(Path("docs-studio") / st.id, st.id).load_files(
            files, docs_sites.StudioSiteConfig(st, site), signature)

    index = await asyncio.to_thread(build)
    with _lock:
        # Last one in wins: a request that finds another build's index rebuilds it.
        _entries[st.id] = _Entry(index=index, checked=time.monotonic())
        _entries.move_to_end(st.id)
        while len(_entries) > max(1, get_settings().docs_sites_cache_size):
            _entries.popitem(last=False)
    return index


def cached_sites() -> list[str]:
    """Site ids with an index in memory, least recently used first."""
    with _lock:
        return list(_entries)


def expire(site: str | None = None) -> None:
    """Tests: make the next get_index() look at the files again."""
    with _lock:
        for sid, entry in _entries.items():
            if site is None or sid == site:
                entry.checked = 0.0


def reset() -> None:
    """Tests: forget every cached index and site setting."""
    with _lock:
        _entries.clear()
    docs_sites.reset()
