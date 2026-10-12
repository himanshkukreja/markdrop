# Tabs

Switch between views of the same thing: line tabs for page sections, pill tabs for filters.

## What you provide

`items` [{value, label, icon, count, disabled}], `value`, `onChange`, `variant` line | pill, `aria-label`. Arrow keys move between tabs.

## Look

- Line: 14px / 500, `text-muted` → `accent-text` with a 2px underline, on a `border` rule.
- Pill: a `surface-inset` track with the selected tab raised on `surface` + `shadow-sm`.
- Counts are 11px pills on `surface-active`.

## Do / don't

- Tabs never navigate away from the page; use the header nav or links for that.
