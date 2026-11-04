"""Text helpers for global search (services/search.py, services/search_index.py).

Pure functions, no I/O: normalising text, cutting it into words and trigrams,
Markdown / HTML to plain text, the edit-distance-1 variants of a word, and the
query's shape (does it read like a question?).

Normal form (``norm``): NFKD with combining marks dropped ("Café" → "cafe"),
lower-cased, every run of characters that isn't a letter or a digit is one space.
Positions in a normalised string are NOT positions in the original; the snippet
code (services/search.py) maps matches back on the original text itself.
"""

from __future__ import annotations

import functools
import html
import re
import unicodedata
from html.parser import HTMLParser

# Words kept in the body word set: long enough to mean something, short enough
# not to be a hash or a URL.
MIN_WORD = 2
MAX_WORD = 32
MAX_BODY_WORDS = 1500
MAX_GRAMS = 600

STOPWORDS = frozenset("""
a an and are as at be but by for from has have he her his i if in into is it its me my no not of on or our
she so than that the their them then there these they this to was we were what when which who will with
you your yours do does did can could should would may might must shall been being am also just about over
how why where whose whom us
""".split())

_SPLIT = re.compile(r"[\W_]+")


def _strip_marks(text: str) -> str:
    d = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in d if not unicodedata.combining(ch))


def norm(text: str | None) -> str:
    """Lower case, accents off, every non letter/digit run → one space, trimmed."""
    if not text:
        return ""
    t = text.lower() if text.isascii() else _strip_marks(text.replace("\x00", " ")).lower()
    return " ".join(w for w in _SPLIT.split(t) if w)


@functools.lru_cache(maxsize=100_000)
def title_words(text: str) -> tuple[str, ...]:
    """``words`` for titles, slugs and names, memoised (the same titles come back every search)."""
    n = norm(text)
    return tuple(n.split(" ")) if n else ()


def words(text: str | None) -> list[str]:
    """The normalised words of ``text``, in order (duplicates kept)."""
    n = norm(text)
    return n.split(" ") if n else []


def word_set(text: str | None, *, limit: int = MAX_BODY_WORDS) -> list[str]:
    """Distinct words worth indexing (stopwords and 1-letter/very long words out), first seen first."""
    out: dict[str, None] = {}
    for w in words(text):
        if MIN_WORD <= len(w) <= MAX_WORD and w not in STOPWORDS and w not in out:
            out[w] = None
            if len(out) >= limit:
                break
    return list(out)


def word_grams(word: str) -> list[str]:
    """Trigrams of one word, marked at its start ("_on", "onb", …). A 1-2 letter word is one gram."""
    if not word:
        return []
    w = "_" + word
    if len(w) <= 3:
        return [w]
    return [w[i:i + 3] for i in range(len(w) - 2)]


def grams(*texts: str | None, limit: int = MAX_GRAMS) -> list[str]:
    """The distinct word trigrams of all ``texts`` (the first texts first, so a cap keeps titles)."""
    out: dict[str, None] = {}
    for t in texts:
        for w in words(t):
            if len(w) > MAX_WORD:
                continue
            for g in word_grams(w):
                if g not in out:
                    out[g] = None
                    if len(out) >= limit:
                        return list(out)
    return list(out)


# ── Markdown and HTML → text ──────────────────────────────────────────────────

_FRONTMATTER = re.compile(r"\A---\n.*?\n---[ \t]*(?:\n|\Z)", re.S)
_FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})[^\n]*$", re.M)
# A directive fence line (":::note[Heads up]{…}", "::::columns", ":::"): its label is kept.
_DIRECTIVE_LINE = re.compile(r"^\s*:{2,}(?:[A-Za-z][\w-]*(?:\[([^\]\n]*)\])?(?:\{[^}\n]*\})?)?\s*$", re.M)
_BLOCK_ATTRS = re.compile(r"\{#?[\w-]*(?:\s+[\w-]+=(?:\"[^\"\n]*\"|'[^'\n]*'|[^\s}]+))*\s*\}\s*$", re.M)
_IMG = re.compile(r"!\[([^\]\n]*)\]\([^)\n]*\)")
_LINK = re.compile(r"\[([^\]\n]*)\]\([^)\n]*\)")
_INLINE_DIR = re.compile(r"(?<![\w:]):([A-Za-z][\w-]*)\[([^\]\n]*)\](?:\{[^}\n]*\})?")
_LEAF_DIR = re.compile(r"(?<![\w:])::?[A-Za-z][\w-]*\{[^}\n]*\}")
_TAG = re.compile(r"<[^>\n]{1,400}>")
_MD_PUNCT = re.compile(r"^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+(?:\[[ xX]\]\s+)?|\d{1,9}[.)]\s+)", re.M)
_EMPH = re.compile(r"(\*\*|__|~~|\*|`)")
_TABLE_RULE = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$", re.M)
_SPACES = re.compile(r"[ \t ]+")
_BLANKS = re.compile(r"\n{3,}")


def markdown_text(md: str | None) -> str:
    """Readable text of a Markdown page: syntax, URLs, directive fences and block attributes
    removed; link and directive labels and code kept. Line breaks kept (snippets cut on them)."""
    if not md:
        return ""
    t = md.replace("\r\n", "\n").replace("\x00", "")
    t = _FRONTMATTER.sub("", t)
    t = _FENCE.sub("", t)
    t = _DIRECTIVE_LINE.sub(lambda m: m.group(1) or "", t)
    t = _BLOCK_ATTRS.sub("", t)
    t = _IMG.sub(lambda m: m.group(1), t)
    t = _LINK.sub(lambda m: m.group(1), t)
    t = _INLINE_DIR.sub(lambda m: m.group(2), t)
    t = _LEAF_DIR.sub("", t)
    t = _TAG.sub(" ", t)
    t = _TABLE_RULE.sub("", t)
    t = _MD_PUNCT.sub("", t)
    t = _EMPH.sub("", t)
    t = t.replace("|", " ")
    t = html.unescape(t)
    t = _SPACES.sub(" ", t)
    t = "\n".join(line.strip() for line in t.split("\n"))
    return _BLANKS.sub("\n\n", t).strip()


class _HTMLText(HTMLParser):
    SKIP = {"script", "style", "noscript", "template", "svg", "head"}
    BLOCK = {"p", "div", "li", "tr", "br", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article",
             "header", "footer", "table", "ul", "ol", "pre", "blockquote", "title"}

    def __init__(self, limit: int):
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.size = 0
        self.skip = 0
        self.limit = limit
        self.title: list[str] = []
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        if tag == "title":
            self.in_title = True
        if tag in self.BLOCK:
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skip:
            self.skip -= 1
        if tag == "title":
            self.in_title = False
        if tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, data):
        if self.in_title:
            self.title.append(data)
            return
        if self.skip or self.size >= self.limit:
            return
        self.out.append(data)
        self.size += len(data)


def html_text(source: str | bytes | None, limit: int = 60_000) -> str:
    """Visible text of an HTML document (scripts, styles and markup out), about ``limit`` characters."""
    if not source:
        return ""
    if isinstance(source, bytes):
        source = source.decode("utf-8", "replace")
    p = _HTMLText(limit)
    try:
        p.feed(source[: limit * 8])
        p.close()
    except Exception:
        pass
    t = "".join(p.out)
    t = _SPACES.sub(" ", t)
    t = "\n".join(line.strip() for line in t.split("\n"))
    return _BLANKS.sub("\n\n", t).strip()[:limit]


def html_title(source: str | bytes | None) -> str | None:
    if not source:
        return None
    if isinstance(source, bytes):
        source = source[:200_000].decode("utf-8", "replace")
    m = re.search(r"<title[^>]*>(.*?)</title>", source[:200_000], re.I | re.S)
    return html.unescape(m.group(1)).strip()[:200] or None if m else None


# ── Typo variants ─────────────────────────────────────────────────────────────

_ALPHA = "abcdefghijklmnopqrstuvwxyz"


def edits1(word: str) -> set[str]:
    """Every string one edit away (delete, transpose, replace, insert; a-z), Norvig style."""
    splits = [(word[:i], word[i:]) for i in range(len(word) + 1)]
    deletes = {a + b[1:] for a, b in splits if b}
    transposes = {a + b[1] + b[0] + b[2:] for a, b in splits if len(b) > 1}
    replaces = {a + c + b[1:] for a, b in splits if b for c in _ALPHA if c != b[0]}
    inserts = {a + c + b for a, b in splits for c in _ALPHA}
    out = deletes | transposes | replaces | inserts
    out.discard(word)
    return {w for w in out if len(w) >= MIN_WORD}


# ── Query shape ───────────────────────────────────────────────────────────────

_QUESTION_START = re.compile(
    r"^(who|what|when|where|why|how|which|whose|whom|is|are|was|were|do|does|did|can|could|should|would|will|"
    r"has|have|had|explain|summari[sz]e|compare|tell me|show me|find me|list|give me|any|anything|everything|"
    r"docs? (about|on|for|that)|something (about|on|that)|the (doc|page|file|one) (about|on|with|where|that))\b",
    re.I)


def looks_like_question(q: str | None) -> bool:
    """A question or a description ("how do we onboard contractors", "the doc about pricing for EU"):
    AI search runs on its own for these; plain names and keywords stay fuzzy-only."""
    q = (q or "").strip()
    if len(q) < 8:
        return False
    if q.endswith("?"):
        return True
    ws = q.split()
    if len(ws) >= 3 and _QUESTION_START.match(q):
        return True
    return len(ws) >= 7
