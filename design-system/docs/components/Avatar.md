# Avatar

Initials or a photo in a circle, with an optional presence dot; AvatarGroup overlaps several.

## What you provide

Avatar: `name` (initials derive from it), `src`, `size` sm | md | lg | xl, `status` online | away | offline, `neutral` (gray instead of accent). AvatarGroup: Avatar children.

## Look

- 24 / 32 / 40 / 56 px, `accent` fill with `on-accent` initials; `neutral` uses `surface-active`.
- Status dot: `success-fill` / `warning-fill` / `text-subtle`, ringed by `surface`.

## Do / don't

- Always pass the full name — it is the accessible label and the tooltip.
