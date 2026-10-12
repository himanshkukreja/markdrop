# Dropdown

A trigger plus a menu of actions, with click-outside, Escape and upward flipping built in.

## What you provide

`trigger` (any element — Dropdown adds onClick and aria attributes), `items` MenuItem[] ({label, onClick | href, icon, kbd, danger, disabled, separated, busy, external, description, tile}), `align` left | right, `minWidth`, `defaultOpen`.

## Look

- Menu on `surface-raised`, `border`, `radius-xl`, `shadow-lg`, 6px below the trigger; items 14px with 16px `text-muted` icons, hover `surface-hover`.
- Rich items (description / tile) are used by CreateMenu.
- Danger items in `danger`, after a `separated` rule, last.

## Do / don't

- Up to ~8 items; group with `separated`.
- Never hover-to-open.
