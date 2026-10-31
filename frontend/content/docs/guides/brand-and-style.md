---
title: Match your brand
nav: Brand and style
description: Add your logo and colours to a guide, choose fonts, colour mode and corners, and what custom CSS can and can't do.
updated: 2026-10-31
prerequisites: [/guides/themes]
keywords: [brand, logo, colours, colors, accent, fonts, dark mode, light mode, corners, custom css, contrast, favicon]
---

Everything on this page is in the guide's **Design** tab, beside the [themes](/guides/themes). Changes show in the preview straight away. Choose **Save design** to keep them; readers see them after the next publish. Only Guides admins can change the design.

## Match my brand

Turn on **Match my brand**, then **Upload logo** (SVG, PNG, JPEG or WebP). Markdrop Guides picks up the logo's colours and shows them as swatches. Choose the one to use as the accent, or **Add** another colour. A guide can have up to six brand colours.

![Match my brand turned on, with Acme's logo, the colours #0f766e, #13203a and #f59e0b, and contrast checks Text 15.3:1, Links 5.1:1 and Dark links 4.9:1.](/docs-assets/guides/brand-and-style/match-brand.webp)

From these colours Markdrop Guides builds a light and a dark palette. The accent colours links, buttons and callouts; a very dark colour becomes the text colour, and a very light one tints backgrounds. Text, links and buttons are adjusted so they keep readable contrast in both themes. The badges under the colours show the contrast for text, links and dark-theme links: a check means it's readable, a warning sign means it's close.

The logo also becomes the guide's favicon. With **Match my brand** off, the guide uses the theme's own colours.

## Fonts, colour mode and corners

| Setting | Choices |
| --- | --- |
| **Headings font** and **Body font** | **Theme default**, or one of System UI, Inter, Manrope, Geist, DM Sans, IBM Plex Sans, Nunito, Source Sans 3, Newsreader, Source Serif 4, Lora, JetBrains Mono and IBM Plex Mono |
| **Colour mode** | **Light and dark** (readers can switch), **Light only** or **Dark only** |
| **Corners** | **Theme default**, **Sharp**, **Soft** or **Round** |

Fonts are served with the guide, so readers' browsers don't fetch them from anyone else. With **Light only** or **Dark only**, readers don't get a theme switch.

![Headings font set to Lora, Body font Inter, Colour mode Light and dark, Corners Round, next to the preview of the Quickstart page with serif headings and rounder corners.](/docs-assets/guides/brand-and-style/fonts-mode-corners.webp)

## Custom CSS

Open **Custom CSS** to add your own styles. They apply after the theme, on the published guide only (not in the preview), and only inside the guide: every rule is scoped to the guide's page, so it can't restyle anything else. Selectors on `html`, `body` and `:root` apply to the guide's root, and `[data-theme="dark"]` rules apply in the dark theme.

```css title="Examples"
.dx-callout { border-radius: 0; }
.dx-callout--tip { border-left: 3px solid var(--accent); }
html[data-theme="dark"] .dx-header { backdrop-filter: blur(8px); }
```

The engine's own class names start with `dx-`: `.dx-header` for the header, `.dx-callout` (and `.dx-callout--note`, `--tip`, `--warning`, `--danger`) for callouts. Your browser's developer tools show the rest on your published guide.

The box checks your CSS as you type and says what's wrong. **Save design** stays off until it's fixed.

![The Custom CSS box with an @import line, and the error "Custom CSS: @import isn't allowed."](/docs-assets/guides/brand-and-style/custom-css.webp)

What's allowed:

- Up to 20 KB.
- `@media`, `@supports`, `@container`, `@layer`, `@keyframes`, `@font-face` and `@property`.
- `url()` with an `https://` address or a file uploaded to the guide (`/docs-assets/…`).

What isn't:

- Scripts or HTML of any kind, including the `<` character, `expression()`, `javascript:` links, `behavior` and `-moz-binding`.
- `@import`, and `src()` or `image-set()` (use `url()` instead).
- Backslash escapes.
- Nested rules (CSS nesting), and selectors that reach outside the guide (`~` or `+` right after `html`, `body` or `:root`).
