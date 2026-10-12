# Logos

The Markdrop mark is a slate pill (`logo-ground` #0f172a, corner radius 8 of 32) holding a bold monospace "m" in `logo-ink` #f1f5f9, with the blue "drop" (`logo-dot` #3b82f6) beside it. The colours are the same in both themes; the mark never inverts.

- `markdrop-mark.svg` — the 32×32 favicon and header mark, from `frontend/src/app/icon.svg`. Use at 24–40px; at 16px the "m" still reads.
- `markdrop-extension-icon.svg` — the 128×128 VS Code extension icon, from `extension/icon.svg`: the same pill with a teardrop "drop" instead of a dot. Marketplace and store listings only.
- `markdrop-extension-icon.png` — the same at 128px, raster, for stores that refuse SVG.

Rules: keep the pill; never recolour the drop; never add a wordmark inside the pill. The wordmark is set in type (`Wordmark` / `MarkdropLogo` in the library), lower case, "drop" in `accent-text`. Clear space around the mark is a quarter of its width.
