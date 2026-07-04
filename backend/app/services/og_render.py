"""Render dynamic Open Graph / link-preview cards to PNG.

When a ``markdrop.in/<slug>`` link is pasted into Slack, Twitter/X, LinkedIn,
etc., the crawler fetches the ``og:image`` we advertise in the page metadata.
This module renders that 1200×630 card server-side with Pillow (the same
approach already used for diagram images): document title + a short snippet +
view count + Markdrop branding.

Password-protected documents render a generic card that leaks no content.

Bundled fonts (``app/assets/fonts``): DejaVu Sans (proportional, regular +
bold) for the title/body and — via the diagram renderer — DejaVu Sans Mono.
"""

from functools import lru_cache
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

_FONTS = Path(__file__).resolve().parent.parent / "assets" / "fonts"
_SANS = str(_FONTS / "DejaVuSans.ttf")
_SANS_BOLD = str(_FONTS / "DejaVuSans-Bold.ttf")

# Standard OG card size (1.91:1). Both Twitter summary_large_image and Facebook
# use this comfortably.
WIDTH = 1200
HEIGHT = 630

# Palette — dark navy to match the Markdrop app chrome.
_BG = (11, 18, 32)          # #0B1220
_ACCENT = (59, 130, 246)    # blue-500 (the "drop" in the wordmark)
_TITLE = (243, 244, 246)    # near-white
_MUTED = (148, 163, 184)    # slate-400
_FOOT = (100, 116, 139)     # slate-500

_MARGIN = 90
_ACCENT_BAR = 14            # slim left accent stripe


@lru_cache(maxsize=8)
def _font(bold: bool, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(_SANS_BOLD if bold else _SANS, size)


def _wrap(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.FreeTypeFont,
    max_width: int,
    max_lines: int,
) -> list[str]:
    """Greedy word-wrap to ``max_width`` px, capped at ``max_lines`` (ellipsised)."""
    words = text.split()
    if not words:
        return []
    lines: list[str] = []
    cur = words[0]
    for word in words[1:]:
        trial = f"{cur} {word}"
        if draw.textlength(trial, font=font) <= max_width:
            cur = trial
        else:
            lines.append(cur)
            cur = word
            if len(lines) == max_lines:
                break
    else:
        lines.append(cur)

    if len(lines) > max_lines:
        lines = lines[:max_lines]

    # If we truncated (more words remained), ellipsise the last visible line.
    if len(lines) == max_lines and (draw.textlength(" ".join(lines), font=font) < draw.textlength(text, font=font)):
        last = lines[-1]
        ell = "…"
        while last and draw.textlength(last + ell, font=font) > max_width:
            last = last[:-1].rstrip()
        lines[-1] = (last + ell) if last else ell
    return lines


def make_snippet(content: str, limit: int = 220) -> str:
    """Turn raw markdown into a short, plain-text snippet for the card."""
    import re

    text = content
    text = re.sub(r"```.*?```", " ", text, flags=re.DOTALL)   # fenced code
    text = re.sub(r"`[^`]*`", " ", text)                        # inline code
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)           # images
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)        # links → text
    text = re.sub(r"[#>*_~`|]", " ", text)                      # md punctuation
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > limit:
        text = text[:limit].rstrip() + "…"
    return text


def _fmt_views(views: int) -> str:
    return f"{views:,} view" + ("" if views == 1 else "s")


def _draw_wordmark(draw: ImageDraw.ImageDraw, x: int, y: int) -> None:
    """'markdrop' with the 'drop' half in the accent blue."""
    font = _font(bold=True, size=44)
    draw.text((x, y), "mark", font=font, fill=_TITLE)
    w = draw.textlength("mark", font=font)
    draw.text((x + w, y), "drop", font=font, fill=_ACCENT)


def render_og_png(
    *,
    title: str,
    snippet: str,
    views: int,
    protected: bool,
) -> bytes:
    """Render the preview card to PNG bytes.

    ``protected`` renders a generic, content-free card.
    """
    img = Image.new("RGB", (WIDTH, HEIGHT), _BG)
    draw = ImageDraw.Draw(img)

    # Left accent stripe.
    draw.rectangle([0, 0, _ACCENT_BAR, HEIGHT], fill=_ACCENT)

    content_w = WIDTH - _MARGIN - _MARGIN

    _draw_wordmark(draw, _MARGIN, 64)

    if protected:
        title_text = "Password-protected document"
        snippet_text = "This document is protected. Open it on Markdrop to unlock."
    else:
        title_text = title.strip() or "Untitled document"
        snippet_text = snippet.strip()

    # Title — large bold, up to 3 lines.
    title_font = _font(bold=True, size=66)
    title_lines = _wrap(draw, title_text, title_font, content_w, max_lines=3)
    y = 190
    line_h = title_font.size + 18
    for line in title_lines:
        draw.text((_MARGIN, y), line, font=title_font, fill=_TITLE)
        y += line_h

    # Snippet — muted, up to 3 lines, below the title.
    if snippet_text:
        snip_font = _font(bold=False, size=32)
        y += 12
        snip_lines = _wrap(draw, snippet_text, snip_font, content_w, max_lines=3)
        snip_h = snip_font.size + 14
        for line in snip_lines:
            # Don't let the snippet run into the footer.
            if y + snip_h > HEIGHT - 130:
                break
            draw.text((_MARGIN, y), line, font=snip_font, fill=_MUTED)
            y += snip_h

    # Footer row: view count (left) + domain (right).
    foot_font = _font(bold=False, size=30)
    foot_y = HEIGHT - _MARGIN - 8
    if not protected:
        draw.text((_MARGIN, foot_y), _fmt_views(views), font=foot_font, fill=_FOOT)
    domain = "markdrop.in"
    dw = draw.textlength(domain, font=foot_font)
    draw.text((WIDTH - _MARGIN - dw, foot_y), domain, font=foot_font, fill=_FOOT)

    buf = BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
