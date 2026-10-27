"""Render dynamic Open Graph / link-preview cards to PNG.

When a ``markdrop.in/<slug>`` link is pasted into Slack, Twitter/X, LinkedIn,
etc., the crawler fetches the ``og:image`` we advertise in the page metadata.
This module renders that 1200×630 card server-side with Pillow, on the grid in
design-system/REVAMP_PLAN.md §7.21.

The renderer is deliberately dumb about access: it draws exactly the ``Card``
it is handed. Deciding what an anonymous crawler may see (and so which card
kind to ask for) is the router's job — see ``routers/og.py``. The content-free
kinds (``password``, ``encrypted``, ``private``, ``generic``) take no title or
snippet at all, so a caller cannot leak one into them by mistake.

Fonts (``app/assets/fonts``, OFL, licences alongside): static instances of
Manrope 500/700/800 and JetBrains Mono 500/700 made from the design-system
variable fonts. Manrope covers Latin, Greek and Cyrillic only, so any glyph it
lacks (Arabic, Hebrew, …) falls back, run by run, to the bundled DejaVu Sans.
Scripts neither font has (CJK) still render as boxes; no font for them ships.

Nothing here fetches anything: no remote logo, no remote font. A workspace
logo would mean fetching a customer-supplied URL from inside the renderer, a
server-side request forgery hole pointed at the host's metadata endpoint.
"""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont, features

_FONTS = Path(__file__).resolve().parent.parent / "assets" / "fonts"

# Standard OG card size (1.91:1).
WIDTH = 1200
HEIGHT = 630

# ── Palette (dark ground only; the card is an image, it has no theme) ────────
_BG = (3, 7, 18)                 # gray-950  #030712
_TEXT = (243, 244, 246)          # gray-100  #f3f4f6
_TEXT_SECONDARY = (153, 161, 175)  # gray-400 #99a1af
_DOC_BLUE = (81, 162, 255)       # blue-400  #51a2ff  (cat-document, accent-text)
_ARTIFACT_ORANGE = (255, 137, 4)  # orange-400 #ff8904 (cat-artifact)
_RADIAL = (43, 127, 255)         # blue-500  #2b7fff
_LOGO_GROUND = (15, 23, 42)      # --logo-ground #0f172a
_LOGO_EDGE = (30, 41, 59)        # the loader's 1px edge #1e293b
_LOGO_INK = (241, 245, 249)      # --logo-ink #f1f5f9
_LOGO_DOT = (59, 130, 246)       # --logo-dot #3b82f6

# ── Grid (REVAMP_PLAN §7.21; all baselines) ──────────────────────────────────
_M = 64                           # margin, all sides
_LIVE_W = WIDTH - 2 * _M          # 1072
_RIGHT = WIDTH - _M               # 1136
_HEADER_BASELINE = 110
_EYEBROW_BASELINE = 214
_TITLE_BASELINE = 290
_TITLE_LINE = 70
_SNIPPET_GAP = 28
_SNIPPET_LINE = 40
_FOOTER_BASELINE = HEIGHT - _M    # 566
_ARTIFACT_TEXT_W = 760

_ELLIPSIS = "…"


# ── Data ────────────────────────────────────────────────────────────────────


@dataclass
class CardBrand:
    """What a workspace puts on its own preview cards.

    No logo image on purpose (see the module docstring): the site name carries
    the brand.
    """

    site_name: str | None = None
    accent: tuple[int, int, int] | None = None
    footer: str | None = None          # a validated host; never caller text
    hide_markdrop_branding: bool = False


# Which card to draw. The content-free kinds ignore title/snippet entirely.
CARD_KINDS = ("document", "artifact", "password", "encrypted", "private", "generic")


@dataclass
class Card:
    kind: str = "generic"
    title: str = ""
    snippet: str = ""
    slug: str = ""
    meta: str = ""                    # footer right: "4 min read" / "2.3 MB"
    artifact_renderer: str | None = None
    artifact_label: str | None = None
    brand: CardBrand | None = None
    # A link-level video's poster frame (image bytes read from our own bucket),
    # drawn into the artifact card in place of the type glyph.
    poster: bytes | None = None


def parse_hex_color(value: str | None) -> tuple[int, int, int] | None:
    """#rgb or #rrggbb to an RGB triple. None for anything else — the card is
    not the place to discover that a colour was malformed."""
    if not value or not value.startswith("#"):
        return None
    raw = value[1:]
    if len(raw) == 3:
        raw = "".join(c * 2 for c in raw)
    if len(raw) != 6:
        return None
    try:
        return (int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16))
    except ValueError:
        return None


# ── Text helpers shared with the router ──────────────────────────────────────


def _plain(content: str) -> str:
    text = content
    text = re.sub(r"```.*?```", " ", text, flags=re.DOTALL)   # fenced code
    text = re.sub(r"`[^`]*`", " ", text)                        # inline code
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)           # images
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)        # links → text
    text = re.sub(r"<[^>]{1,200}>", " ", text)                  # inline html
    text = re.sub(r"[#>*_~`|]", " ", text)                      # md punctuation
    return re.sub(r"\s+", " ", text).strip()


_LEAD_HEADING = re.compile(r"\A\s*#{1,6}[ \t]+(.+?)[ \t#]*(?:\n|\Z)")


def lead_heading(content: str) -> str | None:
    """The document's opening ATX heading, when it opens with one. Most
    documents carry no stored title and name themselves this way."""
    m = _LEAD_HEADING.match(content or "")
    if not m:
        return None
    text = _plain(m.group(1))
    return text or None


def make_snippet(content: str, limit: int = 220, *, skip_heading: bool = False) -> str:
    """Turn raw markdown into a short, plain-text snippet for the card.
    ``skip_heading`` drops an opening heading already used as the title."""
    if skip_heading:
        content = _LEAD_HEADING.sub("", content or "", count=1)
    text = _plain(content)
    if len(text) > limit:
        text = text[:limit].rstrip() + _ELLIPSIS
    return text


def reading_time(content: str, wpm: int = 200) -> str:
    """'4 min read' for a markdown body (code included: people read it too)."""
    words = len(re.findall(r"\w+", content or ""))
    return f"{max(1, round(words / wpm))} min read"


def fmt_size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.0f} KB"
    if n < 1024 ** 3:
        return f"{n / (1024 * 1024):.1f} MB"
    return f"{n / 1024 ** 3:.1f} GB"


# ── Fonts and glyph fallback ─────────────────────────────────────────────────

_FACES = {
    ("sans", 500): ("Manrope-Medium.ttf", "DejaVuSans.ttf"),
    ("sans", 700): ("Manrope-Bold.ttf", "DejaVuSans-Bold.ttf"),
    ("sans", 800): ("Manrope-ExtraBold.ttf", "DejaVuSans-Bold.ttf"),
    ("mono", 500): ("JetBrainsMono-Medium.ttf", "DejaVuSansMono.ttf"),
    ("mono", 700): ("JetBrainsMono-Bold.ttf", "DejaVuSansMono.ttf"),
}

# libraqm gives bidi + shaping (Arabic joining). Pillow's wheels bundle it, but
# it needs FriBiDi at runtime; without it RTL words are drawn reversed and
# unshaped, which is legible for Hebrew and poor for Arabic.
_HAS_RAQM = bool(features.check("raqm"))
_LAYOUT = ImageFont.Layout.RAQM if _HAS_RAQM else ImageFont.Layout.BASIC


@lru_cache(maxsize=48)
def _font_file(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(_FONTS / name), size, layout_engine=_LAYOUT)


@dataclass(frozen=True)
class _Style:
    family: str
    weight: int
    size: int

    @property
    def primary(self) -> ImageFont.FreeTypeFont:
        return _font_file(_FACES[(self.family, self.weight)][0], self.size)

    @property
    def fallback(self) -> ImageFont.FreeTypeFont:
        return _font_file(_FACES[(self.family, self.weight)][1], self.size)


# A private-use code point no font maps: its mask *is* the .notdef glyph.
_NOTDEF_PROBE = "\U0010FFFD"


@lru_cache(maxsize=8)
def _notdef_mask(name: str) -> bytes:
    f = _font_file(name, 24)
    m = f.getmask(_NOTDEF_PROBE)
    return bytes(m.size) + bytes(m)


@lru_cache(maxsize=8192)
def _covers(name: str, ch: str) -> bool:
    """Does this font file have a real glyph for ``ch``?

    Pillow has no has-glyph call, so compare the glyph's mask with the
    .notdef mask. Whitespace and controls always count as covered.
    """
    if ch.isspace() or unicodedata.category(ch)[0] in ("C", "Z"):
        return True
    f = _font_file(name, 24)
    m = f.getmask(ch)
    return (bytes(m.size) + bytes(m)) != _notdef_mask(name)


def _runs(text: str, style: _Style) -> list[tuple[str, ImageFont.FreeTypeFont]]:
    """Split ``text`` into maximal runs drawable by one font: Manrope where it
    has the glyph, DejaVu where it does not."""
    primary_name, fallback_name = _FACES[(style.family, style.weight)]
    out: list[tuple[str, ImageFont.FreeTypeFont]] = []
    cur, cur_primary = "", True
    for ch in text:
        use_primary = _covers(primary_name, ch) or not _covers(fallback_name, ch)
        if cur and use_primary != cur_primary:
            out.append((cur, style.primary if cur_primary else style.fallback))
            cur = ""
        cur += ch
        cur_primary = use_primary
    if cur:
        out.append((cur, style.primary if cur_primary else style.fallback))
    return out


def _is_rtl_char(ch: str) -> bool:
    return unicodedata.bidirectional(ch) in ("R", "AL")


def _base_rtl(text: str) -> bool:
    """Paragraph direction from the first strong character (the UBA's P2)."""
    for ch in text:
        d = unicodedata.bidirectional(ch)
        if d in ("R", "AL"):
            return True
        if d == "L":
            return False
    return False


def _word_is_rtl(word: str) -> bool:
    return any(_is_rtl_char(c) for c in word)


def _rtl_word_font(word: str, style: _Style) -> ImageFont.FreeTypeFont:
    # A word with RTL letters is drawn in one font so raqm can shape and order
    # it as a unit (punctuation included). Manrope has no RTL scripts.
    return style.fallback


def _measure_word(word: str, style: _Style) -> float:
    if _word_is_rtl(word):
        f = _rtl_word_font(word, style)
        return f.getlength(word, direction="rtl") if _HAS_RAQM else f.getlength(word)
    return sum(f.getlength(run) for run, f in _runs(word, style))


def _space(style: _Style) -> float:
    return style.primary.getlength(" ")


def _measure(text: str, style: _Style) -> float:
    words = text.split(" ")
    return sum(_measure_word(w, style) for w in words) + _space(style) * (len(words) - 1)


def _draw_word(draw: ImageDraw.ImageDraw, x: float, baseline: float, word: str,
               style: _Style, fill) -> None:
    if not word:
        return
    if _word_is_rtl(word):
        f = _rtl_word_font(word, style)
        if _HAS_RAQM:
            draw.text((x, baseline), word, font=f, fill=fill, anchor="ls", direction="rtl")
        else:
            # No shaping engine: at least put the letters in visual order.
            draw.text((x, baseline), word[::-1], font=f, fill=fill, anchor="ls")
        return
    for run, f in _runs(word, style):
        draw.text((x, baseline), run, font=f, fill=fill, anchor="ls")
        x += f.getlength(run)


def _draw_line(draw: ImageDraw.ImageDraw, text: str, style: _Style, *, x: float,
               baseline: float, width: float, fill, rtl: bool = False,
               align_right: bool = False) -> None:
    """Draw one line, word by word, with a small bidi pass.

    LTR paragraphs draw words in logical order (RTL words inside them are
    shaped right-to-left on their own). RTL paragraphs right-align and lay
    their words out right to left, keeping a run of consecutive LTR words
    (a product name, a version number) in its own reading order.
    """
    words = text.split(" ")
    sp = _space(style)
    if not rtl:
        cx = x + (width - _measure(text, style) if align_right else 0)
        for w in words:
            _draw_word(draw, cx, baseline, w, style, fill)
            cx += _measure_word(w, style) + sp
        return

    # Group into islands: each RTL word alone, consecutive LTR words together.
    islands: list[list[str]] = []
    for w in words:
        if _word_is_rtl(w) or not islands or _word_is_rtl(islands[-1][-1]):
            islands.append([w])
        else:
            islands[-1].append(w)
    cursor = x + width
    for isl in islands:
        isl_text = " ".join(isl)
        iw = _measure(isl_text, style)
        start = cursor - iw
        cx = start
        for w in isl:
            _draw_word(draw, cx, baseline, w, style, fill)
            cx += _measure_word(w, style) + sp
        cursor = start - sp


def _fit(text: str, style: _Style, width: float) -> str:
    """Trim ``text`` to ``width`` with a trailing ellipsis if it doesn't fit."""
    if _measure(text, style) <= width:
        return text
    t = text
    while t and _measure(t.rstrip() + _ELLIPSIS, style) > width:
        t = t[:-1]
    return (t.rstrip() + _ELLIPSIS) if t.strip() else _ELLIPSIS


def _wrap(text: str, style: _Style, width: float, max_lines: int) -> list[str]:
    """Greedy word wrap; over-long words break by character; the last allowed
    line is ellipsised when text remains."""
    words = text.split()
    if not words or max_lines <= 0:
        return []
    lines: list[str] = []
    cur = ""
    i = 0
    while i < len(words):
        w = words[i]
        trial = f"{cur} {w}" if cur else w
        if _measure(trial, style) <= width:
            cur = trial
            i += 1
            continue
        if not cur:
            # A single word wider than the box: take as many characters as fit.
            cut = len(w)
            while cut > 1 and _measure(w[:cut], style) > width:
                cut -= 1
            cur = w[:cut]
            words[i] = w[cut:]
        lines.append(cur)
        cur = ""
        if len(lines) == max_lines:
            break
    else:
        if cur:
            lines.append(cur)
        return lines

    # Ran out of lines with words left over: ellipsise the last line, at a word
    # boundary when that still leaves a reasonably full line.
    last = lines[-1].split(" ")
    while len(last) > 1 and _measure(" ".join(last) + _ELLIPSIS, style) > width:
        last.pop()
    candidate = " ".join(last) + _ELLIPSIS
    if _measure(candidate, style) <= width and _measure(candidate, style) >= width * 0.6:
        lines[-1] = candidate
    else:
        lines[-1] = _fit(lines[-1] + " " + " ".join(words[i:]), style, width)
    return lines


def _draw_tracked(draw: ImageDraw.ImageDraw, x: float, baseline: float, text: str,
                  style: _Style, fill, tracking: float) -> float:
    """Letter-spaced text (Pillow has no tracking). Prefix widths keep kerning.
    Returns the drawn width."""
    runs = _runs(text, style)
    cx = x
    for run, f in runs:
        for i, ch in enumerate(run):
            px = cx + f.getlength(run[:i]) + i * tracking
            draw.text((px, baseline), ch, font=f, fill=fill, anchor="ls")
        cx += f.getlength(run) + len(run) * tracking
    return cx - x - tracking


def _tracked_width(text: str, style: _Style, tracking: float) -> float:
    return sum(f.getlength(r) + len(r) * tracking for r, f in _runs(text, style)) - tracking


# ── Colour ──────────────────────────────────────────────────────────────────


def _luminance(rgb: tuple[int, int, int]) -> float:
    def ch(c: int) -> float:
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = rgb
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def contrast(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    la, lb = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


# ── Icons (the design-system set, stroked from the same path data) ──────────

# From frontend/src/components/ui/icons.ts (24px grid, 1.8 stroke, round caps).
_ICON_PATHS = {
    "doc": "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
    "lines": "M4 6h16M4 12h10M4 18h13",
    "image": "M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21",
    "lock": "M19 10h-1V7a6 6 0 0 0-12 0v3H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2zM8 10V7a4 4 0 0 1 8 0v3",
    "key": "m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4M21 2l-9.6 9.6M7.5 21a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z",
    "globe": "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z",
    "film": "M19.82 2H4.18A2.18 2.18 0 0 0 2 4.18v15.64C2 21.02 2.98 22 4.18 22h15.64A2.18 2.18 0 0 0 22 19.82V4.18A2.18 2.18 0 0 0 19.82 2zM7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5",
    "archive": "M21 8v13H3V8M1 3h22v5H1zm9 9h4",
    "table": "M3 3h18v18H3zM3 9h18M3 15h18M9 3v18",
    "music": "M9 18V5l12-2v13M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm12-2a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    "code": "m16 18 6-6-6-6M8 6l-6 6 6 6",
}

# Backend renderer → (FileIcon glyph, category colour), matching FILE_KINDS /
# RENDERER_KIND in frontend/src/components/ui/markdrop.tsx.
_RENDERER_GLYPH: dict[str, tuple[str, tuple[int, int, int]]] = {
    "pdf": ("doc", (255, 100, 103)),        # cat-pdf    red-400
    "sheet": ("table", (0, 212, 146)),      # cat-sheet  emerald-400
    "docx": ("lines", _DOC_BLUE),           # document
    "text": ("lines", _DOC_BLUE),
    "video": ("film", (166, 132, 255)),     # cat-video  violet-400
    "html": ("globe", _ARTIFACT_ORANGE),    # cat-artifact
    "image": ("image", (251, 100, 182)),    # cat-image  pink-400
    "bundle": ("archive", _ARTIFACT_ORANGE),
    "zip": ("archive", _ARTIFACT_ORANGE),
}
_OTHER_GLYPH = ("doc", _TEXT_SECONDARY)

_PATH_TOKEN = re.compile(r"[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?")
_ARGS = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2, "A": 7, "Z": 0}


def _arc_points(x1, y1, rx, ry, phi_deg, large, sweep, x2, y2, steps_per_rad=6.0):
    """SVG endpoint arc → points (F.6.5 of the SVG spec)."""
    if rx == 0 or ry == 0 or (x1 == x2 and y1 == y2):
        return [(x2, y2)]
    rx, ry = abs(rx), abs(ry)
    phi = math.radians(phi_deg)
    cp, sp = math.cos(phi), math.sin(phi)
    dx, dy = (x1 - x2) / 2, (y1 - y2) / 2
    x1p, y1p = cp * dx + sp * dy, -sp * dx + cp * dy
    lam = (x1p ** 2) / (rx ** 2) + (y1p ** 2) / (ry ** 2)
    if lam > 1:
        s = math.sqrt(lam)
        rx, ry = rx * s, ry * s
    num = rx ** 2 * ry ** 2 - rx ** 2 * y1p ** 2 - ry ** 2 * x1p ** 2
    den = rx ** 2 * y1p ** 2 + ry ** 2 * x1p ** 2
    coef = math.sqrt(max(0.0, num / den)) if den else 0.0
    if large == sweep:
        coef = -coef
    cxp, cyp = coef * rx * y1p / ry, -coef * ry * x1p / rx
    cx = cp * cxp - sp * cyp + (x1 + x2) / 2
    cy = sp * cxp + cp * cyp + (y1 + y2) / 2

    def ang(ux, uy, vx, vy):
        a = math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
        return a

    t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not sweep and dt > 0:
        dt -= 2 * math.pi
    elif sweep and dt < 0:
        dt += 2 * math.pi
    n = max(4, int(abs(dt) * steps_per_rad * max(1.0, math.sqrt(max(rx, ry)))))
    pts = []
    for i in range(1, n + 1):
        t = t1 + dt * i / n
        ex, ey = rx * math.cos(t), ry * math.sin(t)
        pts.append((cp * ex - sp * ey + cx, sp * ex + cp * ey + cy))
    return pts


def _path_polylines(d: str) -> list[tuple[list[tuple[float, float]], bool]]:
    """Flatten an SVG path into (points, closed) polylines. Handles every
    command the icon set uses (M L H V C S Q T A Z, absolute and relative)."""
    toks = _PATH_TOKEN.findall(d)
    out: list[tuple[list[tuple[float, float]], bool]] = []
    pts: list[tuple[float, float]] = []
    x = y = sx = sy = 0.0
    last_ctrl = None
    cmd = None
    i = 0

    def flush(closed=False):
        nonlocal pts
        if pts:
            out.append((pts, closed))
        pts = []

    def num():
        nonlocal i
        v = float(toks[i])
        i += 1
        return v

    while i < len(toks):
        if toks[i].isalpha():
            cmd = toks[i]
            i += 1
            if cmd in "Zz":
                if pts:
                    pts.append((sx, sy))
                flush(closed=True)
                x, y = sx, sy
                last_ctrl = None
                continue
        if cmd is None:
            break
        rel = cmd.islower()
        c = cmd.upper()
        if i + _ARGS[c] > len(toks) or any(t.isalpha() for t in toks[i:i + _ARGS[c]]):
            break
        ox, oy = (x, y) if rel else (0.0, 0.0)
        if c == "M":
            flush()
            x, y = ox + num(), oy + num()
            sx, sy = x, y
            pts = [(x, y)]
            cmd = "l" if rel else "L"   # implicit lineto after the first pair
            last_ctrl = None
        elif c == "L":
            x, y = ox + num(), oy + num()
            pts.append((x, y))
            last_ctrl = None
        elif c == "H":
            x = (x if rel else 0.0) + num()
            pts.append((x, y))
            last_ctrl = None
        elif c == "V":
            y = (y if rel else 0.0) + num()
            pts.append((x, y))
            last_ctrl = None
        elif c in ("C", "S", "Q", "T"):
            if c == "C":
                c1 = (ox + num(), oy + num())
                c2 = (ox + num(), oy + num())
            elif c == "S":
                c1 = (2 * x - last_ctrl[0], 2 * y - last_ctrl[1]) if last_ctrl else (x, y)
                c2 = (ox + num(), oy + num())
            elif c == "Q":
                q = (ox + num(), oy + num())
                c1 = (x + 2 / 3 * (q[0] - x), y + 2 / 3 * (q[1] - y))
                c2 = None
            else:  # T
                q = (2 * x - last_ctrl[0], 2 * y - last_ctrl[1]) if last_ctrl else (x, y)
                c1 = (x + 2 / 3 * (q[0] - x), y + 2 / 3 * (q[1] - y))
                c2 = None
            end = (ox + num(), oy + num())
            if c2 is None:
                c2 = (end[0] + 2 / 3 * (q[0] - end[0]), end[1] + 2 / 3 * (q[1] - end[1]))
            p0 = (x, y)
            for k in range(1, 17):
                t = k / 16
                mt = 1 - t
                pts.append((
                    mt ** 3 * p0[0] + 3 * mt ** 2 * t * c1[0] + 3 * mt * t ** 2 * c2[0] + t ** 3 * end[0],
                    mt ** 3 * p0[1] + 3 * mt ** 2 * t * c1[1] + 3 * mt * t ** 2 * c2[1] + t ** 3 * end[1],
                ))
            last_ctrl = q if c in ("Q", "T") else c2
            x, y = end
        elif c == "A":
            rx, ry, rot = num(), num(), num()
            large, sweep = bool(num()), bool(num())
            ex, ey = ox + num(), oy + num()
            pts.extend(_arc_points(x, y, rx, ry, rot, large, sweep, ex, ey))
            x, y = ex, ey
            last_ctrl = None
    flush()
    return out


def _icon_mask(name: str, size: int, stroke: float = 1.8) -> Image.Image:
    """An 'L' mask of a stroked icon at ``size`` px, supersampled for clean AA."""
    ss = 8 if size <= 64 else 3
    big = size * ss
    scale = big / 24
    w = max(1, round(stroke * scale))
    mask = Image.new("L", (big, big), 0)
    d = ImageDraw.Draw(mask)
    r = w / 2
    for pts, closed in _path_polylines(_ICON_PATHS[name]):
        sp = [(px * scale, py * scale) for px, py in pts]
        if len(sp) > 1:
            d.line(sp, fill=255, width=w, joint="curve")
        # Round caps (and the dot glyphs, which are zero-length segments).
        for px, py in ([sp[0], sp[-1]] if not closed else [sp[0]]):
            d.ellipse([px - r, py - r, px + r, py + r], fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def _paste_icon(img: Image.Image, name: str, size: int, xy: tuple[int, int],
                colour: tuple[int, int, int], opacity: float = 1.0) -> None:
    mask = _icon_mask(name, size)
    if opacity < 1:
        mask = mask.point(lambda v: round(v * opacity))
    img.paste(Image.new("RGB", (size, size), colour), xy, mask)


# ── Ground, mark, header ─────────────────────────────────────────────────────


@lru_cache(maxsize=4)
def _ground(accent: tuple[int, int, int]) -> Image.Image:
    """#030712 with a 12% accent radial top-right and a 4% 32px dot grid."""
    img = Image.new("RGB", (WIDTH, HEIGHT), _BG)

    radius = 760
    grad = Image.radial_gradient("L").resize((radius * 2, radius * 2), Image.BILINEAR)
    # 0 at the centre → 255 at the rim: invert, ease (squared) and scale to 12%.
    falloff = ImageChops.invert(grad).point(lambda v: round(((v / 255) ** 2) * 255 * 0.12))
    cx, cy = WIDTH - 80, -40
    img.paste(Image.new("RGB", falloff.size, accent), (cx - radius, cy - radius), falloff)

    dots = Image.new("L", (WIDTH, HEIGHT), 0)
    dd = ImageDraw.Draw(dots)
    alpha = round(255 * 0.04)
    for gx in range(16, WIDTH, 32):
        for gy in range(16, HEIGHT, 32):
            dd.ellipse([gx - 1.5, gy - 1.5, gx + 1.5, gy + 1.5], fill=alpha)
    img.paste(Image.new("RGB", img.size, _TEXT), (0, 0), dots)
    return img


@lru_cache(maxsize=2)
def _mark(size: int) -> Image.Image:
    """MarkdropMark: the 32-unit SVG (rounded ground, mono 'm', blue dot) drawn
    as shapes, supersampled. The 1px edge is the loader's, so the ground reads
    on a near-black card."""
    ss = 8
    u = size * ss / 32
    big = Image.new("RGBA", (size * ss, size * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    d.rounded_rectangle([0, 0, 32 * u - 1, 32 * u - 1], radius=8 * u, fill=_LOGO_GROUND)
    d.rounded_rectangle([0.5 * u, 0.5 * u, 31.5 * u, 31.5 * u], radius=7.5 * u,
                        outline=_LOGO_EDGE, width=max(1, round(u)))
    mono = _font_file("JetBrainsMono-Bold.ttf", round(18 * u))
    d.text((3 * u, 23 * u), "m", font=mono, fill=_LOGO_INK, anchor="ls")
    d.ellipse([23 * u, 16 * u, 31 * u, 24 * u], fill=_LOGO_DOT)
    return big.resize((size, size), Image.LANCZOS)


_WORDMARK = _Style("sans", 800, 40)
_EYEBROW = _Style("sans", 700, 22)
_TITLE = _Style("sans", 800, 64)
_DISPLAY = _Style("sans", 800, 80)
_SNIPPET = _Style("sans", 500, 30)
_FOOT_MONO = _Style("mono", 500, 26)
_FOOT_META = _Style("sans", 500, 26)


def _draw_header(img: Image.Image, draw: ImageDraw.ImageDraw, brand: CardBrand | None) -> None:
    show_markdrop = not (brand and brand.hide_markdrop_branding)
    if show_markdrop:
        mark = _mark(64)
        img.paste(mark, (_M, _M), mark)

    if brand and brand.site_name:
        x = 144 if show_markdrop else _M
        name = _fit(brand.site_name.strip(), _WORDMARK, _RIGHT - x)
        rtl = _base_rtl(name)
        w = _measure(name, _WORDMARK)
        _draw_line(draw, name, _WORDMARK, x=x, baseline=_HEADER_BASELINE, width=w,
                   fill=_TEXT, rtl=rtl)
        underline = brand.accent or _DOC_BLUE
        draw.rectangle([x, 122, x + w, 127], fill=underline)
        return

    if not show_markdrop:
        return  # asked for no Markdrop and named nothing: leave the slot empty
    tracking = -0.03 * _WORDMARK.size
    w = _draw_tracked(draw, 144, _HEADER_BASELINE, "mark", _WORDMARK, _TEXT, tracking)
    _draw_tracked(draw, 144 + w + tracking, _HEADER_BASELINE, "drop", _WORDMARK, _DOC_BLUE, tracking)


def _draw_eyebrow(draw: ImageDraw.ImageDraw, x: float, text: str, colour) -> None:
    _draw_tracked(draw, x, _EYEBROW_BASELINE, text.upper(), _EYEBROW, colour,
                  0.08 * _EYEBROW.size)


def _footer_left(card: Card) -> str:
    """The address printed bottom-left. A workspace's validated host stands
    alone (its paths are not slugs); otherwise markdrop.in/{slug}; nothing at all
    when Markdrop branding is hidden and there is no host of their own."""
    b = card.brand
    if b and b.footer:
        return b.footer
    if b and b.hide_markdrop_branding:
        return ""
    if card.kind == "generic" or not card.slug:
        return "markdrop.in"
    return f"markdrop.in/{card.slug}"


def _draw_footer(draw: ImageDraw.ImageDraw, card: Card, left_colour, meta: str) -> None:
    meta_w = 0.0
    if meta:
        meta_w = _measure(meta, _FOOT_META)
        draw.text((_RIGHT, _FOOTER_BASELINE), meta, font=_FOOT_META.primary,
                  fill=_TEXT_SECONDARY, anchor="rs")
    left = _footer_left(card)
    if left:
        room = _LIVE_W - (meta_w + 40 if meta else 0)
        left = _fit(left, _FOOT_MONO, room)
        _draw_line(draw, left, _FOOT_MONO, x=_M, baseline=_FOOTER_BASELINE, width=room,
                   fill=left_colour)


# ── Cards ───────────────────────────────────────────────────────────────────


def _title_and_snippet(draw: ImageDraw.ImageDraw, title: str, snippet: str, width: int) -> None:
    rtl = _base_rtl(title)
    lines = _wrap(title, _TITLE, width, max_lines=3)
    for i, line in enumerate(lines):
        _draw_line(draw, line, _TITLE, x=_M, baseline=_TITLE_BASELINE + i * _TITLE_LINE,
                   width=width, fill=_TEXT, rtl=rtl, align_right=rtl)
    snippet_lines = {1: 2, 2: 1}.get(len(lines), 0)
    if not snippet or not snippet_lines:
        return
    last = _TITLE_BASELINE + (len(lines) - 1) * _TITLE_LINE
    # 28px between the title's last line box and the snippet's first: one
    # snippet line box (40) below the title's descent.
    y = last + _SNIPPET_GAP + _SNIPPET_LINE
    s_rtl = _base_rtl(snippet)
    for i, line in enumerate(_wrap(snippet, _SNIPPET, width, max_lines=snippet_lines)):
        _draw_line(draw, line, _SNIPPET, x=_M, baseline=y + i * _SNIPPET_LINE, width=width,
                   fill=_TEXT_SECONDARY, rtl=s_rtl, align_right=s_rtl)


def _footer_colour(brand: CardBrand | None) -> tuple[int, int, int]:
    # 26px is large text, so 3:1 is the bar; a brand accent that misses it
    # never becomes text.
    if brand and brand.accent:
        return brand.accent if contrast(brand.accent, _BG) >= 3 else _TEXT_SECONDARY
    return _DOC_BLUE


_PROTECTED_COPY = {
    "password": ("lock", "Password", "Password-protected document",
                 "Open the link and enter the password to read it."),
    "encrypted": ("key", "End-to-end encrypted", "Encrypted document",
                  "The key is in the link. Markdrop stores ciphertext it has no key for."),
    "private": ("lock", "Private", "Private document",
                "Only people with access can open it."),
}


# A video's poster, framed on the right of the artifact card (16:9, 512 wide).
_POSTER_W, _POSTER_H = 512, 288
_POSTER_X = _RIGHT - _POSTER_W
_POSTER_Y = 168
_POSTER_MAX_PIXELS = 40_000_000  # refuse decompression bombs before decoding


def _poster_frame(data: bytes) -> Image.Image | None:
    """The poster cover-cropped to the frame, or None if it isn't an image we
    can (safely) decode. Bytes come from our own bucket, never a URL."""
    try:
        src = Image.open(BytesIO(data))
        if src.width * src.height > _POSTER_MAX_PIXELS:
            return None
        src = src.convert("RGB")
    except Exception:
        return None
    scale = max(_POSTER_W / src.width, _POSTER_H / src.height)
    w, h = max(1, round(src.width * scale)), max(1, round(src.height * scale))
    src = src.resize((w, h), Image.LANCZOS)
    left, top = (w - _POSTER_W) // 2, (h - _POSTER_H) // 2
    return src.crop((left, top, left + _POSTER_W, top + _POSTER_H))


@lru_cache(maxsize=2)
def _poster_mask(w: int, h: int) -> Image.Image:
    ss = 4
    big = Image.new("L", (w * ss, h * ss), 0)
    ImageDraw.Draw(big).rounded_rectangle([0, 0, w * ss - 1, h * ss - 1], radius=20 * ss, fill=255)
    return big.resize((w, h), Image.LANCZOS)


def _draw_play(img: Image.Image, cx: int, cy: int, r: int = 44) -> None:
    """A play disc over the poster, so the card reads as a video at a glance."""
    ss = 4
    size = 2 * r
    disc = Image.new("RGBA", (size * ss, size * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(disc)
    d.ellipse([0, 0, size * ss - 1, size * ss - 1], fill=(3, 7, 18, 190))
    u = size * ss
    d.polygon([(0.40 * u, 0.30 * u), (0.40 * u, 0.70 * u), (0.72 * u, 0.50 * u)], fill=(*_TEXT, 255))
    disc = disc.resize((size, size), Image.LANCZOS)
    img.paste(disc, (cx - r, cy - r), disc)


def render_og_png(card: Card) -> bytes:
    """Render ``card`` to PNG bytes (1200×630)."""
    if card.kind not in CARD_KINDS:
        card = Card(kind="generic")
    brand = card.brand
    radial = brand.accent if brand and brand.accent else _RADIAL
    img = _ground(radial).copy()
    draw = ImageDraw.Draw(img)
    _draw_header(img, draw, brand)

    footer_colour = _footer_colour(brand)

    if card.kind == "generic":
        lines = _wrap("Drop it. It renders.", _DISPLAY, _LIVE_W, max_lines=2)
        line_h = round(_DISPLAY.size * 1.1)
        top = (250 + 420) / 2 - len(lines) * line_h / 2
        for i, line in enumerate(lines):
            # Baseline sits a cap-height-centred distance into each line box.
            base = top + i * line_h + (line_h + 0.72 * _DISPLAY.size) / 2
            _draw_line(draw, line, _DISPLAY, x=_M, baseline=base, width=_LIVE_W, fill=_TEXT)
        _draw_footer(draw, card, footer_colour, "")

    elif card.kind in _PROTECTED_COPY:
        icon, eyebrow, title, line = _PROTECTED_COPY[card.kind]
        if card.kind == "encrypted" and brand and brand.hide_markdrop_branding:
            line = "The key is in the link. The server stores ciphertext it has no key for."
        _paste_icon(img, icon, 28, (_M, 190), _DOC_BLUE)
        _draw_eyebrow(draw, 104, eyebrow, _DOC_BLUE)
        _draw_line(draw, _fit(title, _TITLE, _LIVE_W), _TITLE, x=_M,
                   baseline=_TITLE_BASELINE, width=_LIVE_W, fill=_TEXT)
        y = _TITLE_BASELINE + _SNIPPET_GAP + _SNIPPET_LINE
        for i, ln in enumerate(_wrap(line, _SNIPPET, _LIVE_W, max_lines=2)):
            _draw_line(draw, ln, _SNIPPET, x=_M, baseline=y + i * _SNIPPET_LINE,
                       width=_LIVE_W, fill=_TEXT_SECONDARY)
        _draw_footer(draw, card, footer_colour, "")

    elif card.kind == "artifact":
        poster = _poster_frame(card.poster) if card.poster else None
        text_w = _ARTIFACT_TEXT_W
        if poster is not None:
            img.paste(poster, (_POSTER_X, _POSTER_Y), _poster_mask(*poster.size))
            _draw_play(img, _POSTER_X + poster.width // 2, _POSTER_Y + poster.height // 2)
            text_w = _POSTER_X - _M - 40
        else:
            glyph, colour = _RENDERER_GLYPH.get(card.artifact_renderer or "", _OTHER_GLYPH)
            _paste_icon(img, glyph, 280, (856, 175), colour, opacity=0.10)
        label = (card.artifact_label or "").strip()
        eyebrow = f"Artifact · {label}" if label else "Artifact"
        _draw_eyebrow(draw, _M, _fit(eyebrow.upper(), _EYEBROW, text_w), _ARTIFACT_ORANGE)
        _title_and_snippet(draw, card.title.strip() or card.slug, card.snippet.strip(), text_w)
        _draw_footer(draw, card, footer_colour, card.meta)

    else:  # document
        _draw_eyebrow(draw, _M, "Document", _DOC_BLUE)
        _title_and_snippet(draw, card.title.strip() or card.slug, card.snippet.strip(), _LIVE_W)
        _draw_footer(draw, card, footer_colour, card.meta)

    buf = BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
