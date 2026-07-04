"""Render ASCII / box-drawing diagrams to PNG.

Google Drive's markdown→Doc converter renders text (even inside a code block)
in a font that substitutes a *proportional* fallback for box-drawing and arrow
glyphs (``│ ─ ▶ →``), so the column alignment a diagram depends on collapses.
The robust fix is to render the diagram ourselves to a raster image with a true
monospace font and let Google embed the image (verified: the converter fetches
remote ``![](url)`` images and embeds them into the Doc). Alignment then no
longer depends on Google's fonts at all.

The bundled DejaVu Sans Mono covers box-drawing (U+2500–257F), block/geometric
shapes (arrows/triangles) and renders every glyph at one fixed cell width.
"""

import base64
import zlib
from functools import lru_cache
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

_FONT_PATH = Path(__file__).resolve().parent.parent / "assets" / "fonts" / "DejaVuSansMono.ttf"

# Rendered at 2× for a crisp result inside Google Docs (it downscales cleanly).
_FONT_SIZE = 28
_PADDING = 20
_LINE_SPACING = 6
_FG = (32, 33, 36)         # near-black, matches Docs body text
_BG = (255, 255, 255)      # opaque white — Docs has no transparency benefit here

# Guard rails so a pathological document can't ask us to render a huge canvas.
MAX_LINES = 400
MAX_COLS = 400

# Diagram text travels in the image URL itself (stateless — no server storage),
# zlib-compressed + urlsafe-base64. Caps guard the public endpoint against
# oversized input and zip bombs.
MAX_ENCODED = 8000     # ~encoded token chars; keeps the whole URL well under limits
MAX_DECODED = 20000    # bytes of diagram text we're willing to render


def encode_diagram(text: str) -> str:
    """Compress + urlsafe-base64 a diagram block for embedding in the image URL.

    Padding ``=`` is stripped so the token is clean in a URL query string.
    """
    packed = base64.urlsafe_b64encode(zlib.compress(text.encode("utf-8"), 9))
    return packed.rstrip(b"=").decode("ascii")


def decode_diagram(token: str) -> str:
    """Inverse of :func:`encode_diagram`, with hard size limits (raises ValueError)."""
    if len(token) > MAX_ENCODED:
        raise ValueError("diagram token too large")
    padding = "=" * (-len(token) % 4)  # restore stripped base64 padding
    raw = base64.urlsafe_b64decode(token.encode("ascii") + padding.encode("ascii"))
    dec = zlib.decompressobj()
    text = dec.decompress(raw, MAX_DECODED)
    if dec.unconsumed_tail:
        raise ValueError("decompressed diagram too large")
    return text.decode("utf-8")


@lru_cache(maxsize=1)
def _font() -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(_FONT_PATH), _FONT_SIZE)


def render_diagram_png(text: str) -> bytes:
    """Render a monospace diagram block to PNG bytes (opaque white background)."""
    lines = text.replace("\t", "    ").split("\n")
    # Trim trailing blank lines so the image isn't bottom-heavy.
    while lines and lines[-1].strip() == "":
        lines.pop()
    if not lines:
        lines = [""]
    lines = [ln[:MAX_COLS] for ln in lines[:MAX_LINES]]

    font = _font()
    # Cell metrics from a representative glyph — the font is monospace so every
    # advance is identical; measure a box char to include its full cell width.
    bbox = font.getbbox("─")
    ascent, descent = font.getmetrics()
    char_w = font.getlength("─") or (bbox[2] - bbox[0])
    line_h = ascent + descent + _LINE_SPACING

    cols = max((len(ln) for ln in lines), default=1)
    width = int(round(char_w * cols)) + _PADDING * 2
    height = int(round(line_h * len(lines))) + _PADDING * 2

    img = Image.new("RGB", (max(width, 1), max(height, 1)), _BG)
    draw = ImageDraw.Draw(img)
    y = _PADDING
    for line in lines:
        # Draw per-character at exact column positions so alignment is grid-perfect
        # regardless of any residual per-glyph advance differences.
        x = _PADDING
        for ch in line:
            if ch != " ":
                draw.text((x, y), ch, font=font, fill=_FG)
            x += char_w
        y += line_h

    buf = BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
