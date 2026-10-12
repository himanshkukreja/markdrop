# Markdrop brand book

Markdrop publishes Markdown, shares files peer-to-peer and syncs from VS Code. The product promise is *no login, no friction, just links*, and the interface should feel the same way: quiet, fast, mostly ink on a dark or light ground, with one blue that means "go".

This system is the revamp target. Its dark values are the palette the app ships today; the light theme, the type scale and the component library are new. Build every new screen on the semantic tokens and the components in `src/`; never reach for a raw hex or a Tailwind palette class in product code. How to wire it into the app is in [README.md](README.md).

## Voice and content

- Plain, second person, present tense: "Paste markdown and get a shareable link instantly." Say what happens, not what the feature is called.
- Sentence case everywhere — headings, buttons, labels, tabs. The only ALL-CAPS text is the `eyebrow` style and `upper` badges (NEW, BETA, E2E).
- Buttons are verbs that restate the outcome: "Publish", "Copy link", "Rotate key", "Unlock". Never "OK", "Yes", "Submit".
- Status is a word plus a mark, never a colour alone: "Live" with a dot, "Direct" with an arrow, "Expires in 2 days" with a clock.
- Error copy names the fix: "Sign in with the address it was shared with and it'll open." A failure toast says what to do next.
- Explain privacy honestly and specifically ("The key lives in the link, which browsers never send to a server") — it is the brand's strongest claim; never soften it into "secure".
- No emoji in UI chrome. Markdown content a user wrote renders as written.
- The product name is **Markdrop** in prose and `markdrop` in the wordmark; the link domain is written as `markdrop.in/slug` in `code-inline`.

## Colour

Two equal themes, `dark` (the default, as shipped) and `light`. Every semantic token has both values; components only ever use semantic tokens, so a theme switch is `data-theme="light"` on the root and nothing else.

- Grounds: `bg` is the page; `surface` is anything with an edge (cards, inputs, dialogs); `surface-raised` is menus and tooltips; `surface-inset` is wells (editor, pill-tab tracks); `surface-hover` / `surface-active` are the only hover and pressed fills.
- Edges: `border` for hairlines and cards, `border-strong` for controls at rest, `border-focus` for the ring. Borders are decorative (under 3:1 in both themes); meaning is never carried by a border, which is why every control also has a focus ring.
- Ink: `text` for headings and primary copy, `text-secondary` for body in tables and dialogs, `text-muted` for captions, placeholders and icon strokes. All three pass AA on every surface in both themes. `text-subtle` does not (3.7:1 dark, 2.6:1 light) — disabled labels and decoration only.
- Accent: `accent` is the one blue fill (primary button, checked controls, progress); `accent-text` is links and selected states; `accent-soft` tints selected rows, info alerts and the document icon tile. White on `accent-hover` (blue-500) is only 3.8:1 — fine for a transient hover, never a resting fill.
- Status: `success` / `warning` / `danger` are text and icon colours, each with a `*-soft` tint and a `*-fill` solid. Success and danger are told apart by lightness and by their icons, not hue alone. `warning-fill` carries dark text, never white.
- Categories: `cat-document`, `cat-artifact`, `cat-builder`, `cat-share`, `cat-sync` tint the Create menu tiles and FileIcon; they are never used for state.
- Code: `code-bg` / `code-border` for fenced blocks (GitHub dark and light), `code-inline` on `code-inline-bg` for inline code.
- The logo colours (`logo-ground`, `logo-ink`, `logo-dot`, `logo-drop`) are identical in both themes. The mark never inverts.
- The full Tailwind-derived scales (`gray-50`…`sky-950`) are present for reference and aliasing only; never use a scale step directly in UI.

## Typography

- `Manrope` (variable, 200–800) for everything that is not code; `JetBrains Mono` (variable, 100–800) for code, slugs, URLs, keys and the Kbd. Both ship as files in `fonts/` under the SIL OFL.
- Root size is 16px. Body copy is `body` (14/20); forms, dialogs, menus and tables all sit at 14px. `caption` (12/16) is metadata; `micro` (11/16, 500) is the floor for badges and labels — nothing in the UI is smaller than 11px.
- Headings: `h1` (30/36, 700) page titles, `h2` (24/32) sections, `h3` (18/28, 600) dialog and card titles, `h4` (16/24, 600) sub-sections. Marketing gets `display` and `display-xl` at weight 800 with tight tracking.
- The wordmark is the `wordmark` style, always lower case, "mark" in `text` and "drop" in `accent-text`.
- `eyebrow` (11px, 700, uppercase, 0.08em) labels table headers and section kickers in `text-muted`.
- Code blocks are `code` (13/20) in `text` on `code-bg`; inline code is `code-inline` at 0.875em with `radius-sm` and 2px 6px padding.

## Spacing, shape, depth

- A 4px grid (`space-1`). Inline gaps are `space-2`; control padding `space-3` horizontally; card and dialog padding `space-5`; page gutters `space-4` on phones, `space-6` above; sections `space-8` apart; marketing sections `space-16` to `space-24`.
- Radii are tied to size: `radius-sm` (4) for checkboxes, inline code and kbd; `radius-md` (6) for small buttons and menu items; `radius-lg` (8) for buttons, inputs, tabs and tiles — the same 8/32 ratio as the logo pill; `radius-xl` (12) for cards, dialogs, menus and toasts; `radius-2xl` (16) for large panels; `radius-full` for pills, badges, avatars and switches.
- Depth comes from borders first, shadows second. Dark surfaces carry no shadow at rest; `shadow-md` appears on hover, `shadow-lg` under menus and toasts, `shadow-xl` under dialogs and drawers. Light surfaces add `shadow-sm` to controls so they read as raised. `shadow-glow` is the single coloured shadow, reserved for the loader mark and marketing CTAs.
- Layers: `z-sticky` 20, `z-dropdown` 50, `z-overlay` 100, `z-immersive` 101, `z-toast` 200. Nothing else sets a z-index.

## Motion

- Colour and border transitions are 150ms; overlays enter in 150–220ms on `cubic-bezier(.16,1,.3,1)` with a small translate and scale, never a fade alone.
- Loading is the brand: `MarkdropLoader`'s drop falls into the mark on a 1.9s cycle; indeterminate `Progress` and the loader bar share one 1.4s sweep.
- Every animation has a `prefers-reduced-motion` rest state that still reads (the drop parked mid-fall, the packet mid-path).

## Iconography

- One line set, 24px grid, 1.8 stroke, round caps, `currentColor`, exported as `Icon` with its `ICONS` map. Used at 12–20px inside components. Add to it in the same grid; do not mix in a second set.
- File types come from `FileIcon`, tinted by family. The VS Code mark is `VSCodeIcon`, single colour.
- No emoji as icons.

## Layout rules

- Content columns max out at 880px on app pages (see the Dashboard page) and 1280px on marketing pages, centred, with the gutters above.
- Lists are `DocumentRow`s `space-2` apart, filtered by pill `Tabs` and paged by `Pagination` with a "Showing x of y" caption. Admin and analytics data use `Table`.
- One primary `Button` per view. Destructive actions live in overflow menus or dialog footers.
- Forms: every control inside a `Field`; errors replace hints; the submit button is the only primary.
- Mobile: single column, header actions collapse to Create + avatar, drawers become full-width, menus stay click-to-open.

## Using the system

See [README.md](README.md) for the files, the build, and how the Next.js app consumes the tokens and components.

## Provenance

This system was built from `himanshkukreja/markdrop@592689c` (frontend/) on 2026-10-12 and then redesigned, so most of it is new design rather than a transcription:

- Kept from the code verbatim: the dark palette values, the logo geometry and colours, the loader animation, the Create menu's four entries and copy, the access-gate copy, the transfer and bulk explainers' copy, the toast durations.
- New: the light theme, Manrope + JetBrains Mono (the app uses the system stack), the type scale (the app has a 17px root and ad-hoc 9–11px sizes), semantic tokens, and the 31 primitives. The 17 original components were rebuilt on the primitives; their Tailwind classes are gone.
- Not carried: the `vscode:` grey theme variant (dead in the app), the print stylesheet, landing-page showcase animations beyond AmbientBackground, and the admin analytics charts.
- Icons are a new hand-drawn set in the same style as the app's inline SVGs; no icon files exist in the repository.
