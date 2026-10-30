/**
 * The theme font allow-list (theme.mjs FONTS), self-hosted with next/font/local: woff2 files under
 * ./fonts (Latin subsets of the Google Fonts releases, OFL; see fonts/OFL.txt).
 *
 * Why local files rather than next/font/google: the builds are deterministic and offline. A docs
 * build (our build workers, a customer's CI, the self-host Docker image) and the app's own build
 * never depend on fonts.googleapis.com answering, and the same input always gives the same bytes,
 * which the publish store relies on. Readers get the same thing either way: files on the docs
 * host itself (/_next/static/media, served from Workers Static Assets), no third-party request.
 *
 * Nothing is preloaded: the @font-face rules ship with the docs stylesheet, and a browser only
 * downloads the faces the theme's CSS actually uses. The family names go into the theme's
 * stylesheet (--font-sans / --font-mono / --dx-font-heading), built here.
 */
import localFont from "next/font/local";
import { themeCss } from "./theme.mjs";
import { siteTheme } from "./themeSite";
import type { SiteConfig } from "./types";

const inter = localFont({ src: "./fonts/inter.woff2", weight: "100 900", display: "swap", preload: false, adjustFontFallback: "Arial" });
const geist = localFont({ src: "./fonts/geist.woff2", weight: "100 900", display: "swap", preload: false, adjustFontFallback: "Arial" });
const plexSans = localFont({ src: "./fonts/ibm-plex-sans.woff2", weight: "100 700", display: "swap", preload: false, adjustFontFallback: "Arial" });
const sourceSans = localFont({ src: "./fonts/source-sans-3.woff2", weight: "200 900", display: "swap", preload: false, adjustFontFallback: "Arial" });
const dmSans = localFont({ src: "./fonts/dm-sans.woff2", weight: "100 1000", display: "swap", preload: false, adjustFontFallback: "Arial" });
const nunito = localFont({ src: "./fonts/nunito.woff2", weight: "200 1000", display: "swap", preload: false, adjustFontFallback: "Arial" });
const newsreader = localFont({ src: "./fonts/newsreader.woff2", weight: "200 800", display: "swap", preload: false, adjustFontFallback: "Times New Roman" });
const sourceSerif = localFont({ src: "./fonts/source-serif-4.woff2", weight: "200 900", display: "swap", preload: false, adjustFontFallback: "Times New Roman" });
const lora = localFont({ src: "./fonts/lora.woff2", weight: "400 700", display: "swap", preload: false, adjustFontFallback: "Times New Roman" });
const geistMono = localFont({ src: "./fonts/geist-mono.woff2", weight: "100 900", display: "swap", preload: false, adjustFontFallback: false });
const plexMono = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-400.woff2", weight: "400" },
    { path: "./fonts/ibm-plex-mono-500.woff2", weight: "500" },
    { path: "./fonts/ibm-plex-mono-600.woff2", weight: "600" },
    { path: "./fonts/ibm-plex-mono-700.woff2", weight: "700" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

/** Font id → the CSS family to put first in the stack. Manrope and JetBrains Mono are the root layout's. */
export const THEME_FONT_FAMILIES: Record<string, string> = {
  manrope: "var(--font-manrope)",
  "jetbrains-mono": "var(--font-jetbrains)",
  inter: inter.style.fontFamily,
  geist: geist.style.fontFamily,
  plex: plexSans.style.fontFamily,
  "source-sans-3": sourceSans.style.fontFamily,
  dmsans: dmSans.style.fontFamily,
  nunito: nunito.style.fontFamily,
  newsreader: newsreader.style.fontFamily,
  "source-serif-4": sourceSerif.style.fontFamily,
  lora: lora.style.fontFamily,
  "geist-mono": geistMono.style.fontFamily,
  "plex-mono": plexMono.style.fontFamily,
};

/** The theme's stylesheet (fonts, corners, palette, custom CSS), or null for a site without a theme. */
export function themeStylesheet(site: SiteConfig): string | null {
  const t = siteTheme(site);
  return t ? themeCss(t, THEME_FONT_FAMILIES) : null;
}
