# Field

Label, hint and error wiring around any control.

## What you provide

`label`, `hint`, `error`, `required`, and ONE child control. Field assigns the id, `aria-describedby` and `invalid` for you.

## Look

- Label 13px / 600 `text`; hint 12px `text-muted`; error 12px `danger` with an alert icon, `role="alert"`.
- Gap `space-1.5` between the parts.

## Do / don't

- An error replaces the hint; never show both.
- Required marks are a `danger` asterisk; do not add "(required)".
