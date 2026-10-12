# Button

The one action control: six variants on one shape, three sizes, loading and link forms.

## What you provide

`variant` primary | secondary | ghost | danger | inverse | link; `size` sm | md | lg; `iconLeft` / `iconRight` (Icon names); `loading`, `disabled`, `block`; `href` renders an `<a>` with the same look. Children are the label.

## Look

- Heights 28 / 36 / 44 px, `radius-lg` (`radius-md` at sm), label in `body-strong` (600).
- Primary: `accent` → `accent-hover`, `on-accent` text. Secondary: `surface` + `border-strong` + `shadow-sm`. Ghost: transparent, hover `surface-hover`. Danger: `danger-fill`. Inverse: `surface-inverse`. Link: `accent-text`, underline on hover.
- Focus: 2px `border-focus` outline, 2px offset. Loading hides the label and centres a Spinner so the width does not jump.

## Do / don't

- One primary per view; everything else secondary or ghost.
- Labels are verbs: "Publish", "Copy link", "Rotate key". Never "OK" / "Yes".
- Destructive actions use `danger` only inside a confirmation (Dialog) or an overflow menu — not on a toolbar.
