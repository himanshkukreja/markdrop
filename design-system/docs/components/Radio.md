# Radio

A radio with a label and description; RadioGroup renders a set from options.

## What you provide

Radio: `label`, `description`, `name`, `value`, `checked`, `onChange`. RadioGroup: `name`, `options` [{value, label, description, disabled}], `value`, `onChange`, `row`, `aria-label`.

## Look

- Same box skin as Checkbox, round, with an `on-accent` dot.

## Do / don't

- Options in a group are mutually exclusive and all visible. More than five → Select.
