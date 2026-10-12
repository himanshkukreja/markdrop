# AppHeader

The product header: logo, primary nav, theme toggle, Create and the account avatar.

## What you provide

`nav` [{label, href, current}], `user` {name, src} | null, `onSignIn`, `theme`, `onToggleTheme`.

## Look

- 56px on `bg` with a `border` rule; nav links `text-muted` → `text`, current on `surface-active`.

## Do / don't

- Create stays in the header on every signed-in page; the avatar opens account actions.
