# MarkdropLogo

The mark and wordmark, exactly as the favicon draws them.

## What you provide

MarkdropLogo: `size` (mark px; the wordmark scales with it), `wordmark`, `href`. Also exported: `MarkdropMark` (the SVG alone), `Wordmark` (the text alone).

## Look

- Mark: `logo-ground` pill rx 8/32, mono "m" in `logo-ink`, `logo-dot` at 27,20 r 4. Same in both themes — the mark never inverts.
- Wordmark: Manrope 800, -0.03em, lower case: "mark" in `text`, "drop" in `accent-text`.

## Do / don't

- Never redraw the mark, recolour the dot, or set the wordmark in title case.
