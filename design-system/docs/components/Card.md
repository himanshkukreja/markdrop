# Card

The surface for a bounded piece of content, with optional header, actions and footer.

## What you provide

`title`, `description`, `actions` (right of the header), children (body), `footer` (right-aligned actions on `surface-inset`), `interactive`, `inset`, `compact`.

## Look

- `surface`, `border`, `radius-xl`; padding `space-5` (`space-4` compact).
- Interactive cards lift with `border-strong` + `shadow-md` on hover and are focusable.

## Do / don't

- Cards hold one thing. Lists of things are DocumentRows or a Table, not stacked Cards.
- No coloured left borders, no shadows at rest in dark.
