# Markdrop design system

Markdrop turns docs and files into links that render (*Drop it. It renders.*). This folder holds the tokens, fonts, logos and React components for the Markdrop UI revamp: two equal themes (dark, as shipped today, and a new light theme), Manrope + JetBrains Mono, 31 primitives and 17 Markdrop components.

The rules for using them — voice, colour, type, spacing, motion, layout — are in **[BRAND.md](BRAND.md)**. Per-component guidelines are in [`docs/components/`](docs/components/).

## What's here

```
design-system/
├── BRAND.md                  brand book: the rules
├── tokens/
│   ├── tokens.json           source of truth: every colour (dark + light), type style, space, radius, shadow, z-index
│   ├── tokens.css            generated: CSS custom properties per theme + @font-face
│   ├── type-classes.css      generated: .h1 / .body / .caption … classes
│   └── tailwind-theme.css    generated: Tailwind v4 @theme (bg-surface, text-text-muted, text-h1 …)
├── fonts/                    Manrope + JetBrains Mono, variable woff2, SIL OFL 1.1 licences
├── assets/logos/             the mark (favicon), the VS Code extension icon (svg + png)
├── (components)              live in frontend/src/components/ui/ (canonical; React only, no other deps)
│   ├── primitives.tsx        Button, Input, Field, Checkbox, Switch, Badge, Card, Tabs, Dialog, Drawer,
│   │                         Dropdown, Tooltip, Toast, Alert, Progress, Table, Pagination, EmptyState, Icon …
│   ├── markdrop.tsx          AppHeader, CreateMenu, DocumentRow, AccessGate, MarkdropLoader, CopyButton …
│   └── markdrop.css          component styles; every value is a token
├── bundle/                   generated: browser build for the previews (window.Markdrop) + .d.ts types
├── previews/                 one live page per component and a gallery (index.html), both themes
├── docs/components/          guidelines per component
└── scripts/                  build-tokens.mjs, build-bundle.mjs
```

## Look at it

```bash
cd design-system
npm run preview          # serves this folder on http://localhost:4000
```

Open <http://localhost:4000/previews/> for the gallery and switch Dark / Light at the top. Previews need the server (they load `/fonts/…` and React 18 from jsDelivr), so opening the HTML files directly from disk won't load the fonts.

## Change it

Edit `tokens/tokens.json` (or a component in `frontend/src/components/ui/`), then:

```bash
npm install              # once: esbuild, typescript, @types/react
npm run build            # tokens → CSS, src → bundle/, types → bundle/types/
```

Commit `tokens.json` together with the regenerated files. Never hand-edit `tokens.css`, `type-classes.css`, `tailwind-theme.css` or anything in `bundle/`.

- **Token names** are the API. Rename one and every consumer breaks; add new ones freely.
- **Contrast**: every text colour's `usage` note names the grounds it reads on, and each pair is ≥ 4.5:1 in both themes (the exceptions, `text-subtle` and white on `accent-hover`, are flagged in their notes). Check both themes when you change a value.

## Use it in the Next.js app

This is the foundation step of the revamp; nothing in `frontend/` uses the system until you do it.

**1. Tokens and Tailwind utilities.** In `frontend/src/app/globals.css`, after `@import "tailwindcss";`:

```css
@import "../../../design-system/tokens/tokens.css";
@import "../../../design-system/tokens/tailwind-theme.css";
```

You then get semantic utilities next to the existing ones, so pages can move over one at a time:

| Instead of | Use |
| --- | --- |
| `bg-white dark:bg-gray-900` | `bg-surface` |
| `text-gray-900 dark:text-gray-100` | `text-text` |
| `text-gray-500 dark:text-gray-400` | `text-text-muted` |
| `border-gray-200 dark:border-gray-800` | `border-border` |
| `bg-blue-600 hover:bg-blue-500 text-white` | `bg-accent hover:bg-accent-hover text-on-accent` |
| `text-sm` / `text-2xl font-bold` | `text-body` / `text-h2` |

Radii (`rounded-lg` …) and the 4px spacing scale already match Tailwind's, so those classes stay as they are. Remove the `html { font-size: 17px }` rule at the top of `globals.css`: the system is built on a 16px root, and at 17px every rem-based size and space comes out 6% larger than designed.

**2. Fonts.** Copy `design-system/fonts/*.woff2` into `frontend/public/fonts/`. `tokens.css` loads them from `/fonts/`, and `--font-sans` / `--font-mono` (which Tailwind's `font-sans` / `font-mono` read) switch to Manrope and JetBrains Mono.

**3. Theme switching.** Themes are `data-theme="dark"` / `"light"` on `<html>`. Replace the inline script in `frontend/src/app/layout.tsx` that forces `.dark` with one that reads the saved choice, falling back to `prefers-color-scheme`, and sets `data-theme` before first paint. Keep `dark` the default until the light theme has been checked page by page.

**4. Components (done: the app copy is canonical).** The components were vendored into `frontend/src/components/ui/`, and that folder is now the only source; `design-system/src/` is gone. `scripts/build-bundle.mjs` builds `bundle/markdrop.js` + `bundle/markdrop.css` for the previews from `frontend/src/components/ui/index.ts`, and `npm run build:types` writes `bundle/types/` from the same barrel, so editing a component means editing it in `frontend/` and running `npm run build` here.

- **Dependencies:** `components/ui/*` imports `react` and `react-dom` only (no `@/…`, no `next/*`), so the bundle can build from it. Modules that use hooks start with `"use client"`; `icons.ts` is plain data for server components.
- **Links:** DS components render links through `LinkProvider` / `useLinkComponent()` (`link.tsx`; default a plain `<a>`). The app mounts `components/theme/NextLinkProvider.tsx` once at the root so internal hrefs use `next/link`.
- **Theme islands:** `ThemeScope` (`scope.tsx`) pins a subtree to dark or light; Dialog, Drawer and portalled menus stamp the nearest scope on their portal root. Toasts follow the page.
- **Screen readers:** mount `StatusRegion` (`status.tsx`) once; `announce(text)` speaks through it (CopyButton uses it).
- **Theme controls:** `components/theme/ThemeToggle.tsx` and `ThemeSegmented.tsx` bind to `useTheme()` in `frontend/src/lib/theme.ts`; they live outside `ui/` because they import app code.

## Provenance

Built from `himanshkukreja/markdrop@592689c` on 2026-10-12, then redesigned. The dark palette, the logo, the loader animation and the copy of the Markdrop components come from the code; the light theme, type scale, semantic tokens and component library are new. Details are under *Provenance* in [BRAND.md](BRAND.md). The same system is published as a private Design System artifact on claude.ai. This folder is the version to edit from now on.
