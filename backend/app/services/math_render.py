"""Render LaTeX math to PNG in-house via matplotlib's mathtext engine.

Google Docs' markdown importer renders ``$…$`` / ``$$…$$`` as literal text, so
math never appears as math. We rasterise each expression ourselves and embed it
as an image (the same "let Google fetch an image URL" trick used for diagrams).

matplotlib's *mathtext* engine renders a large subset of LaTeX math WITHOUT a
system TeX install or a browser — it ships as a prebuilt wheel (numpy +
matplotlib, cp314 wheels verified), so it fits the native, low-infra stack.
"""

import os
from functools import lru_cache
from io import BytesIO

# Headless backend — must be set before pyplot/backends import.
os.environ.setdefault("MPLBACKEND", "Agg")

# Fit inside a portrait Doc's ~624px content column (same reasoning as the
# diagram renderer): downscale anything wider so a long equation never overflows.
MAX_IMG_WIDTH = 600

_FG = "#202124"      # near-black, matches Docs body text
_BG = "#ffffff"      # opaque white (Docs page background)


@lru_cache(maxsize=1)
def _figure_cls():
    # Import lazily: matplotlib import is ~1s and only needed when math is present.
    from matplotlib.figure import Figure

    return Figure


def render_math_png(latex: str, display: bool) -> bytes:
    """Render a LaTeX math expression (without ``$`` delimiters) to PNG bytes.

    ``display`` picks block sizing (larger) vs inline sizing. Raises on a
    mathtext parse error so the caller can fall back to leaving the source text.
    """
    from PIL import Image

    Figure = _figure_cls()

    latex = latex.strip()
    fontsize = 22 if display else 16
    dpi = 150 if display else 130

    fig = Figure(figsize=(0.1, 0.1), dpi=dpi)
    # Draw the expression; wrap in $…$ so mathtext parses it as math.
    fig.text(0, 0, f"${latex}$", fontsize=fontsize, color=_FG)

    buf = BytesIO()
    # bbox_inches='tight' crops the canvas to just the rendered glyphs.
    fig.savefig(
        buf,
        format="png",
        dpi=dpi,
        bbox_inches="tight",
        pad_inches=0.06,
        facecolor=_BG,
    )
    buf.seek(0)

    img = Image.open(buf).convert("RGB")
    if img.width > MAX_IMG_WIDTH:
        new_h = max(1, round(img.height * MAX_IMG_WIDTH / img.width))
        img = img.resize((MAX_IMG_WIDTH, new_h), Image.LANCZOS)

    out = BytesIO()
    img.save(out, format="PNG", optimize=True)
    return out.getvalue()
