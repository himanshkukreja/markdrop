# Input

The text field, with optional icon adornments and a mono mode for slugs, URLs and keys.

## What you provide

`size` md | sm; `prefix` / `suffix` (an Icon name or any node — a `<button>` inside stays clickable); `invalid`; `mono`; all native input props.

## Look

- `surface` fill, `border-strong`, `radius-lg`, 14px `body`, `text-muted` placeholder.
- Hover darkens the border to `text-muted`; focus swaps to `border-focus` plus a 3px `accent-ring` glow. Invalid uses `danger` for both.
- Disabled sits on `surface-inset` at 55% opacity.

## Do / don't

- Always inside a Field unless the label is visually obvious (search box with a placeholder and a prefix icon).
- Use `mono` for anything the user will copy exactly.
