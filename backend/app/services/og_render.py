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

# Artifact accents, matched to components/ArtifactBadge.tsx so a link preview
# and the dashboard chip for the same file are visibly the same thing.
_ARTIFACT_ACCENT: dict[str, tuple[int, int, int]] = {
    "html":  (249, 115, 22),   # orange-500
    "pdf":   (239, 68, 68),    # red-500
    "sheet": (16, 185, 129),   # emerald-500
    "image": (139, 92, 246),   # violet-500
    "text":  (14, 165, 233),   # sky-500
}


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


def _draw_file_motif(img: Image.Image, accent: tuple[int, int, int]) -> None:
    """A large, low-opacity document silhouette bleeding off the right edge.

    Drawn on its own RGBA layer and alpha-composited so it reads as a subtle
    tint rather than a solid block competing with the title.
    """
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x0, y0, w, h = WIDTH - 300, 140, 260, 330
    fold = 78
    d.polygon(
        [
            (x0, y0), (x0 + w - fold, y0), (x0 + w, y0 + fold),
            (x0 + w, y0 + h), (x0, y0 + h),
        ],
        fill=(*accent, 30),
    )
    # The folded corner, slightly brighter so the shape reads as a page.
    d.polygon(
        [(x0 + w - fold, y0), (x0 + w, y0 + fold), (x0 + w - fold, y0 + fold)],
        fill=(*accent, 55),
    )
    # Suggestion of text lines on the page.
    for i in range(4):
        ly = y0 + 150 + i * 38
        d.rounded_rectangle(
            [x0 + 44, ly, x0 + w - (44 if i % 2 == 0 else 96), ly + 14],
            radius=7,
            fill=(*accent, 45),
        )
    img.alpha_composite(layer) if img.mode == "RGBA" else img.paste(
        Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB"), (0, 0)
    )


def _fmt_size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.0f} KB"
    return f"{n / (1024 * 1024):.1f} MB"


def render_og_png(
    *,
    title: str,
    snippet: str,
    views: int,
    protected: bool,
    artifact_kind: str | None = None,
    artifact_label: str | None = None,
    artifact_size: int | None = None,
    artifact_filename: str | None = None,
) -> bytes:
    """Render the preview card to PNG bytes.

    ``protected`` renders a generic, content-free card. Passing
    ``artifact_kind`` (the renderer name: html/pdf/sheet/image/text) switches to
    the artifact layout — a type pill and file size in place of a text snippet,
    with the accent colour keyed to the file family.
    """
    accent = _ARTIFACT_ACCENT.get(artifact_kind or "", _ACCENT)

    img = Image.new("RGB", (WIDTH, HEIGHT), _BG)
    draw = ImageDraw.Draw(img)

    # Left accent stripe.
    draw.rectangle([0, 0, _ACCENT_BAR, HEIGHT], fill=accent)

    content_w = WIDTH - _MARGIN - _MARGIN

    _draw_wordmark(draw, _MARGIN, 64)

    if protected:
        title_text = "Password-protected document"
        snippet_text = "This document is protected. Open it on Markdrop to unlock."
    else:
        title_text = title.strip() or "Untitled document"
        snippet_text = snippet.strip()

    # Artifact cards get their own composition: a big translucent file motif on
    # the right, then a type pill + title + filename block centred vertically so
    # the card doesn't read as a mostly-empty markdown card with a badge on it.
    y_title = 190
    is_artifact = bool(artifact_kind) and not protected
    if is_artifact:
        _draw_file_motif(img, accent)

        pill_font = _font(bold=True, size=26)
        pill_text = (artifact_label or artifact_kind or "").upper()
        pad_x, pad_y = 18, 10
        pill_h = pill_font.size + pad_y * 2

        # Measure the title first so the whole block can be centred as one unit.
        probe_font = _font(bold=True, size=66)
        n_title = len(_wrap(draw, title_text, probe_font, content_w - 220, max_lines=3))
        block_h = pill_h + 30 + n_title * (probe_font.size + 18)
        if artifact_filename:
            block_h += 46
        y_pill = max(190, (HEIGHT - block_h) // 2 + 10)

        tw = draw.textlength(pill_text, font=pill_font)
        draw.rounded_rectangle(
            [_MARGIN, y_pill, _MARGIN + tw + pad_x * 2, y_pill + pill_h],
            radius=10,
            fill=accent,
        )
        draw.text((_MARGIN + pad_x, y_pill + pad_y - 2), pill_text, font=pill_font, fill=_BG)
        y_title = y_pill + pill_h + 30

    # Title — large bold, up to 3 lines.
    title_font = _font(bold=True, size=66)
    title_w = content_w - 220 if is_artifact else content_w
    title_lines = _wrap(draw, title_text, title_font, title_w, max_lines=3)
    y = y_title
    line_h = title_font.size + 18
    for line in title_lines:
        draw.text((_MARGIN, y), line, font=title_font, fill=_TITLE)
        y += line_h

    # Original filename — the artifact equivalent of a snippet.
    if is_artifact and artifact_filename:
        fn_font = _font(bold=False, size=30)
        fn = artifact_filename
        while draw.textlength(fn, font=fn_font) > title_w and len(fn) > 8:
            fn = fn[:-2]
        if fn != artifact_filename:
            fn += "…"
        draw.text((_MARGIN, y + 8), fn, font=fn_font, fill=_MUTED)

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
        left = _fmt_views(views)
        if artifact_size:
            left = f"{_fmt_size(artifact_size)} · {left}"
        draw.text((_MARGIN, foot_y), left, font=foot_font, fill=_FOOT)
    domain = "markdrop.in"
    dw = draw.textlength(domain, font=foot_font)
    draw.text((WIDTH - _MARGIN - dw, foot_y), domain, font=foot_font, fill=_FOOT)

    buf = BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
