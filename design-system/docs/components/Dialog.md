# Dialog

A centred modal for one decision or one short form.

## What you provide

`open`, `onClose`, `title`, `description`, children, `footer` (actions), `size` sm | md | lg | xl. Escape, the × and a scrim click all call `onClose`; body scroll locks while open.

## Look

- `overlay` scrim with 4px blur; panel on `surface`, `border`, `radius-xl`, `shadow-xl`, max 448px (360 / 640 / 840).
- Title `h3`, description `text-muted`, footer actions right-aligned above a `border` rule.

## Do / don't

- The primary action restates the decision: "Rotate key", not "Confirm".
- Anything longer than a short form belongs in a Drawer or a page.
