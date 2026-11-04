"""Draw the site-wide default link-preview cards (frontend/public/og/).

``markdrop.png`` is the default; ``transfer.png`` is a file-transfer room's
(/share/<id>), which shares files and must not say "It renders."

Every markdrop.in URL that has no card of its own (the dashboard, settings,
/new, /builder, a file-transfer room…) shares with this one, so no link ever
unfurls bare. Same ground, type and grid as the document cards
(services/og_render.py), with the brand-kit lockup in the header.

    cd backend && .venv/bin/python -m scripts.make_default_og
"""

from __future__ import annotations

from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw

from app.services import og_render as o

ROOT = Path(__file__).resolve().parents[2]
LOCKUP = ROOT / "brand" / "lockup" / "png" / "markdrop-lockup-on-dark-transparent-2400.png"
OUT = ROOT / "frontend" / "public" / "og"
CARDS = {
    "markdrop.png": ("Drop it. It renders.",
                     "Docs, AI pages and files as links that open in any browser."),
    "transfer.png": ("Someone sent you files.",
                     "Encrypted device to device. Open the link to receive them."),
}


def render(headline: str, sub: str) -> bytes:
    img = o._ground(o._RADIAL).copy()
    draw = ImageDraw.Draw(img)

    lockup = Image.open(LOCKUP).convert("RGBA")
    h = 64
    lockup = lockup.resize((round(lockup.width * h / lockup.height), h), Image.LANCZOS)
    img.paste(lockup, (o._M, o._M), lockup)

    line_h = round(o._DISPLAY.size * 1.1)
    base = 330
    o._draw_line(draw, headline, o._DISPLAY, x=o._M, baseline=base,
                 width=o._LIVE_W, fill=o._TEXT)
    for i, ln in enumerate(o._wrap(sub, o._SNIPPET, 900, max_lines=2)):
        o._draw_line(draw, ln, o._SNIPPET, x=o._M, baseline=base + line_h - 20 + i * o._SNIPPET_LINE,
                     width=900, fill=o._TEXT_SECONDARY)
    o._draw_line(draw, "markdrop.in", o._FOOT_MONO, x=o._M, baseline=o._FOOTER_BASELINE,
                 width=o._LIVE_W, fill=o._DOC_BLUE)

    buf = BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (headline, sub) in CARDS.items():
        (OUT / name).write_bytes(render(headline, sub))
        print(OUT / name, (OUT / name).stat().st_size)
