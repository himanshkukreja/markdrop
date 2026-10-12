# AccessGate

What a reader sees instead of a document they cannot open, with copy for each of three situations.

## What you provide

`mode` password | signin | denied, `signInHref`; `email` (denied); `value`, `onValue`, `onSubmit`, `submitting`, `error` (password).

## Look

- A blurred ghost document behind a blurred panel; `radius-2xl`.
- Glyph tile: `accent-soft` lock for password/sign-in, `warning-soft` for denied.
- Password: Input with a show/hide eye and an Unlock primary; errors inline in `danger`.

## Do / don't

- Name the signed-in address in denied — the fix is usually the other account.
- Never offer a password box for a document that has none.
