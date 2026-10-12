# Alert

An inline notice that stays in the flow of the page.

## What you provide

`tone` info | success | warning | danger | neutral; `title`, children, `actions`, `onDismiss`, `icon` (null to hide).

## Look

- `*-soft` fill, no border (neutral: `surface` + `border`); tone colour on icon and title, body in `text-secondary`; `radius-xl`.

## Do / don't

- Use for state the user should keep seeing (encrypted, expiring, DNS pending). Transient outcomes are toasts.
