# Progress

A horizontal bar for uploads, transfers and multi-step work.

## What you provide

`value`, `max`, `label`, `showValue`, `tone` accent | success | danger, `size` md | sm, `indeterminate`.

## Look

- 6px (3px sm) `radius-full` track on `surface-active`; bar in `accent`, `success-fill` when done, `danger-fill` on failure.
- Indeterminate sweeps a third-width bar — the same motion as the loader.

## Do / don't

- Label the file or step; show the percent only when it is real.
