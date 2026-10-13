"""Build the Markdrop logo kit into markdrop/brand/.

Every shape is a filled path: no strokes, no live text, no font dependency —
the files look identical in a browser, Figma, Illustrator or a print shop.
"""
import glob
import os
import subprocess

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

# Run from anywhere:  pip install uharfbuzz fonttools && python brand/build.py
# Needs rsvg-convert and ImageMagick (brew install librsvg imagemagick), and an
# Inter Bold TTF in brand/fonts/ (Google Fonts; SIL OFL).
HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")
OUT = os.path.dirname(os.path.abspath(__file__))

NAVY = "#0f172a"     # tile
SNOW = "#f1f5f9"     # the "m" on dark
INK = "#0f172a"      # the "m" / "mark" on light
BLUE = "#3b82f6"     # the drop, "drop" on light
BLUE_LIGHT = "#60a5fa"  # "drop" on dark — what the site's dark header uses
PAGE_DARK = "#030712"

# ── The symbol, on a 128 grid ────────────────────────────────────────────────
# m: x-height 43–91, 10-unit stems at 17–27 / 39–49 / 61–71, semicircular
# arches (outer r16, inner r6) springing at y59. Drop: point at (95,37), bowl
# centre (95,74) r17, sitting on the same baseline as the m.
M_PATH = (
    "M17 43H27V91H17Z"
    "M17 59A16 16 0 0 1 49 59H39A6 6 0 0 0 27 59Z"
    "M39 59H49V91H39Z"
    "M39 59A16 16 0 0 1 71 59H61A6 6 0 0 0 49 59Z"
    "M61 59H71V91H61Z"
)
DROP_PATH = "M95 37C101 47 112 60 112 74A17 17 0 1 1 78 74C78 60 89 47 95 37Z"
HIGHLIGHT = '<circle cx="88" cy="73" r="3.4" fill="#ffffff" fill-opacity="0.9"/>'


def symbol(m_color: str, drop_color: str, highlight: bool = True) -> str:
    h = HIGHLIGHT if highlight else ""
    return f'<path d="{M_PATH}" fill="{m_color}"/><path d="{DROP_PATH}" fill="{drop_color}"/>{h}'


def svg(w, h, body, vb=None) -> str:
    vb = vb or f"0 0 {w} {h}"
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="{vb}">{body}</svg>\n'


def icon_svg(rounded=True, highlight=True, scale=1.0) -> str:
    tile = f'<rect width="128" height="128" rx="28" fill="{NAVY}"/>' if rounded else f'<rect width="128" height="128" fill="{NAVY}"/>'
    inner = symbol(SNOW, BLUE, highlight)
    if scale != 1.0:
        o = 64 * (1 - scale)
        inner = f'<g transform="translate({o:.2f} {o:.2f}) scale({scale})">{inner}</g>'
    return svg(128, 128, tile + inner)


def mark_svg(m_color, drop_color, highlight=False) -> str:
    # Tight box around the symbol (x 17–112, y 37–91) plus a hair of margin.
    return svg(99, 58, f'<g transform="translate(-15 -35)">{symbol(m_color, drop_color, highlight)}</g>')


# ── Wordmark: "markdrop" in Inter Bold, real kerning, tracking -0.025em ─────
font_path = [f for f in glob.glob(os.path.join(HERE, "*.ttf")) if TTFont(f)["OS/2"].usWeightClass == 700][0]
tt = TTFont(font_path)
glyphset = tt.getGlyphSet()
upem = tt["head"].unitsPerEm
blob = hb.Blob.from_file_path(font_path)
face = hb.Face(blob)
hbfont = hb.Font(face)


def shape(text: str):
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(hbfont, buf, {"kern": True, "liga": True})
    return buf.glyph_infos, buf.glyph_positions


TRACK = -0.025 * upem
order = tt.getGlyphOrder()
infos, positions = shape("markdrop")
pen_x = 0
parts = {"mark": [], "drop": []}
for i, (info, pos) in enumerate(zip(infos, positions)):
    name = order[info.codepoint]
    pen = SVGPathPen(glyphset)
    # font units, y up → svg, y down; baseline at y=0
    glyphset[name].draw(TransformPen(pen, (1, 0, 0, -1, pen_x + pos.x_offset, -pos.y_offset)))
    parts["mark" if i < 4 else "drop"].append(pen.getCommands())
    pen_x += pos.x_advance + TRACK
pen_x -= TRACK
cap = tt["OS/2"].sxHeight  # x-height
asc = max(tt["OS/2"].sCapHeight, 0)
# Vertical extent for lowercase with ascenders (k, d) and descender (p)
desc = -tt["hhea"].descent
WM_TOP = -(tt["OS/2"].sCapHeight + 60)   # a touch above the ascenders
WM_BOTTOM = 220 + 40                      # below the descender of "p"
WM_W = pen_x


def wordmark_paths(mark_color, drop_color) -> str:
    return (f'<path d="{" ".join(parts["mark"])}" fill="{mark_color}"/>'
            f'<path d="{" ".join(parts["drop"])}" fill="{drop_color}"/>')


def wordmark_svg(mark_color, drop_color, height=64) -> str:
    vb_h = WM_BOTTOM - WM_TOP
    w = round(height * WM_W / vb_h)
    return svg(w, height, wordmark_paths(mark_color, drop_color), vb=f"0 {WM_TOP} {WM_W:.0f} {vb_h}")


# Lockup proportions: the wordmark's x-height is ~3/4 of the m in the tile
# (34 vs 48 units), and its x-height band is centred on the tile, so the text
# reads as a caption to the symbol rather than competing with it.
LOCKUP_XH = 34
LOCKUP_SCALE = LOCKUP_XH / tt["OS/2"].sxHeight
LOCKUP_GAP = 28
LOCKUP_BASELINE = 64 + LOCKUP_XH / 2


def lockup_svg(bg, mark_color, drop_color, transparent=False) -> str:
    """Icon tile + wordmark. The wordmark's x-height is optically matched to
    the m in the tile; the gap is a quarter of the tile."""
    tile = 128
    s = LOCKUP_SCALE
    gap = LOCKUP_GAP
    text_w = WM_W * s
    pad = 0 if transparent else 40
    W = pad * 2 + tile + gap + text_w
    H = pad * 2 + tile
    baseline = pad + LOCKUP_BASELINE
    bgrect = "" if transparent else f'<rect width="{W:.0f}" height="{H}" fill="{bg}"/>'
    body = (bgrect
            + f'<g transform="translate({pad} {pad})"><rect width="128" height="128" rx="28" fill="{NAVY}"/>{symbol(SNOW, BLUE)}</g>'
            + f'<g transform="translate({pad + tile + gap} {baseline}) scale({s:.5f})">{wordmark_paths(mark_color, drop_color)}</g>')
    return svg(round(W), H, body)


def social_banner() -> str:
    W, H = 1200, 630
    s = 1.55
    lock_w = (128 + LOCKUP_GAP + WM_W * LOCKUP_SCALE) * s
    x0 = (W - lock_w) / 2
    # Lockup + gap + tagline, centred as one block.
    block_h = 128 * s + 56 + 30
    y0 = (H - block_h) / 2
    ws = LOCKUP_SCALE
    tag = shape_text_paths("Drop it. It renders.", 30, SNOW, opacity=0.62)
    return svg(W, H,
               f'<rect width="{W}" height="{H}" fill="{PAGE_DARK}"/>'
               f'<radialGradient id="g" cx="50%" cy="38%" r="60%"><stop offset="0" stop-color="{BLUE}" stop-opacity="0.22"/><stop offset="1" stop-color="{BLUE}" stop-opacity="0"/></radialGradient>'
               f'<rect width="{W}" height="{H}" fill="url(#g)"/>'
               f'<g transform="translate({x0:.1f} {y0}) scale({s})">'
               f'<rect width="128" height="128" rx="28" fill="{NAVY}" stroke="#1e293b" stroke-width="1"/>{symbol(SNOW, BLUE)}'
               f'<g transform="translate({128 + LOCKUP_GAP} {LOCKUP_BASELINE}) scale({ws:.5f})">{wordmark_paths(SNOW, BLUE_LIGHT)}</g></g>'
               f'<g transform="translate({(W - tag[1]) / 2:.1f} {y0 + 128 * s + 56 + 24:.1f})">{tag[0]}</g>')


def shape_text_paths(text, px, color, opacity=1.0):
    infos, positions = shape(text)
    sc = px / upem
    x = 0
    cmds = []
    for info, pos in zip(infos, positions):
        pen = SVGPathPen(glyphset)
        glyphset[order[info.codepoint]].draw(TransformPen(pen, (sc, 0, 0, -sc, x + pos.x_offset * sc, 0)))
        cmds.append(pen.getCommands())
        x += pos.x_advance * sc
    return f'<path d="{" ".join(cmds)}" fill="{color}" fill-opacity="{opacity}"/>', x


# ── Write everything ──────────────────────────────────────────────────────────

def write(rel, text):
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)
    return path


def png(svg_path, rel, w, h=None):
    out = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    args = ["rsvg-convert", "-w", str(w)] + (["-h", str(h)] if h else []) + [svg_path, "-o", out]
    subprocess.run(args, check=True)
    return out


icon = write("icon/markdrop-icon.svg", icon_svg())
# 16–48 px: no highlight (a speck at that size) and the symbol 12% larger in
# the tile, so the m's counters stay open on a favicon.
small = write("icon/markdrop-icon-small.svg", icon_svg(highlight=False, scale=1.12))
square = write("icon/markdrop-icon-square.svg", icon_svg(rounded=False))
maskable = write("icon/markdrop-icon-maskable.svg", icon_svg(rounded=False, scale=0.8))

for size in (64, 128, 256, 512, 1024):
    png(icon, f"icon/png/markdrop-icon-{size}.png", size)
for size in (16, 32, 48):
    png(small, f"icon/png/markdrop-icon-{size}.png", size)
png(square, "icon/png/apple-touch-icon-180.png", 180)
png(maskable, "icon/png/markdrop-icon-maskable-512.png", 512)
png(maskable, "social/avatar-400.png", 400)  # circle-cropped by most platforms
subprocess.run(["magick"] + [os.path.join(OUT, f"icon/png/markdrop-icon-{s}.png") for s in (16, 32, 48)]
               + [os.path.join(OUT, "icon/favicon.ico")], check=True)

for name, m, d in [("on-dark", SNOW, BLUE), ("on-light", INK, BLUE), ("white", "#ffffff", "#ffffff"), ("black", "#000000", "#000000")]:
    p = write(f"symbol/markdrop-symbol-{name}.svg", mark_svg(m, d))
    png(p, f"symbol/png/markdrop-symbol-{name}-1024.png", 1024)

for name, m, d in [("on-dark", SNOW, BLUE_LIGHT), ("on-light", INK, BLUE), ("white", "#ffffff", "#ffffff"), ("black", "#000000", "#000000")]:
    p = write(f"wordmark/markdrop-wordmark-{name}.svg", wordmark_svg(m, d))
    png(p, f"wordmark/png/markdrop-wordmark-{name}-2000.png", 2000)

for name, bg, m, d, tr in [("dark", PAGE_DARK, SNOW, BLUE_LIGHT, False), ("light", "#ffffff", INK, BLUE, False),
                           ("on-dark-transparent", None, SNOW, BLUE_LIGHT, True), ("on-light-transparent", None, INK, BLUE, True)]:
    p = write(f"lockup/markdrop-lockup-{name}.svg", lockup_svg(bg, m, d, transparent=tr))
    png(p, f"lockup/png/markdrop-lockup-{name}-2400.png", 2400)

banner = write("social/markdrop-social-1200x630.svg", social_banner())
png(banner, "social/markdrop-social-1200x630.png", 1200, 630)
print("built into", OUT)
