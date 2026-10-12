# Markdrop brand kit

Everything here is a filled vector outline: no live text, no strokes, no font
dependency. The files look the same in a browser, Figma, Illustrator, Keynote
or at a print shop. Use the SVGs wherever you can; the PNGs are for places that
won't take vectors.

## The pieces

| Piece | What it is | Use it for |
|---|---|---|
| **Icon** `icon/markdrop-icon.svg` | The "m" and drop on the navy tile | App icon, favicon, avatar, anywhere the logo stands alone |
| **Symbol** `symbol/` | The "m" and drop without the tile | Small marks on colored or photographic backgrounds |
| **Wordmark** `wordmark/` | "markdrop" set in Inter Bold | Where the name needs to be read and the symbol is elsewhere |
| **Lockup** `lockup/` | Icon + wordmark side by side | Headers, decks, documents, partner pages — the default |
| **Social** `social/` | 1200×630 share image, 400×400 avatar | Link previews, X/LinkedIn/GitHub profiles |

### Which file

- **Website favicon:** `icon/favicon.ico` (16/32/48) plus `icon/markdrop-icon.svg`
- **iPhone home screen:** `icon/png/apple-touch-icon-180.png` (square; iOS rounds it)
- **Android / PWA:** `icon/png/markdrop-icon-maskable-512.png` (content inside the safe zone)
- **Profile pictures:** `social/avatar-400.png` (survives a circle crop)
- **Small sizes (16–48 px):** the build uses `markdrop-icon-small.svg` — no highlight dot
  and a slightly larger symbol, so the "m" stays readable on a browser tab
- **Print:** the SVGs, or the 1024 / 2000 / 2400 px PNGs

## Colors

| Name | Hex | Role |
|---|---|---|
| Navy | `#0F172A` | The icon tile; "mark" on light backgrounds |
| Markdrop Blue | `#3B82F6` | The drop; "drop" on light backgrounds |
| Sky | `#60A5FA` | "drop" on dark backgrounds (reads better than Blue on near-black) |
| Snow | `#F1F5F9` | The "m" on the tile; "mark" on dark backgrounds |
| Night | `#030712` | Site and banner background |

## Rules

- **Clear space:** keep at least the drop's width free on every side of the icon
  or lockup.
- **Minimum size:** icon 16 px (use the small variant); lockup 120 px wide;
  wordmark 80 px wide.
- **Color:** on photos or busy backgrounds use the icon (tile included) or the
  single-color white/black symbol — never the two-color symbol.
- **Don't** recolor "mark" and "drop" to other colors, stretch, rotate, add
  shadows or outlines, change the typeface, or put the two-color symbol on blue.
- The wordmark is always lowercase and one word: **markdrop**.

## Type

The wordmark is **Inter Bold** (SIL Open Font License), tracked −2.5%, with the
font's own kerning. The site's UI uses the system font stack; Inter is the
nearest freely licensed match and is safe to use in marketing material.

## Rebuilding

The kit is generated, not hand-drawn: the symbol's geometry lives in one place
(a 128-unit grid — 10-unit stems, semicircular arches, a teardrop on the same
baseline), so every file stays consistent. Regenerate rather than editing
exported files.
