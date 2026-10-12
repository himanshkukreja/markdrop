# ColorPicker

The OS colour picker beside a hex field, with Reset.

## What you provide

`value` (hex | null), `onChange(hex | null)`, `disabled`, `label`.

## Look

- 36px swatch with `border-strong`; mono Input validates `#rgb` / `#rrggbb` before pushing up.

## Do / don't

- No preset swatches: people arrive with a brand hex.
