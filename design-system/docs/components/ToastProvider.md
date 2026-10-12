# ToastProvider

Viewport-anchored feedback for something that already happened. Mount once; call `useToast()` anywhere.

## What you provide

`<ToastProvider>` around the app. `useToast()` → { toast(message, kind?), success, error, info }. Outside a provider calls are no-ops.

## Look

- Bottom-left stack of at most four; `surface-raised` glass with a tone-coloured border and icon, message in `text`.
- success 3.2 s · info 3.8 s · error 6.5 s; click dismisses.

## Do / don't

- Write the result: "Link copied to clipboard", "Saved — your changes are live".
- Field errors stay next to the field; toasts are for page-level outcomes.
