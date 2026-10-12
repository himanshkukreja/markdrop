# Checkbox

A checkbox with a label, an optional description and an indeterminate state.

## What you provide

`label`, `description`, `checked` / `onChange`, `indeterminate`, `disabled`.

## Look

- 18px box, `radius-sm`, `border-strong`; checked fills `accent` with an `on-accent` check. Indeterminate shows a minus.
- Focus ring on the box, not the label.

## Do / don't

- Use for independent yes/no settings in a list. For one choice among several use Radio; for an immediate on/off, Switch.
