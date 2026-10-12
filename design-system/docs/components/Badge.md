# Badge

A small status pill with five tones and three fills.

## What you provide

`tone` neutral | info | success | warning | danger; `variant` soft (default) | solid | outline; `size` md | sm; `dot`, `icon`, `upper` (uppercase tracking for tags like NEW).

## Look

- 20px tall (16 sm), `radius-full`, 11px / 600.
- Soft = `*-soft` fill with the tone's text colour; solid = `*-fill` with white (or gray-900 on warning); outline = `border-strong`.

## Do / don't

- Status words, never sentences: "Live", "Expiring", "E2E".
- A tone always comes with a word or icon; colour alone never carries the meaning.
