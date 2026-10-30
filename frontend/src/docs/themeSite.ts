/**
 * The site's theme as the engine renders it (server only). theme.mjs holds the rules; this file
 * ties them to the site. The stylesheet, which needs the font module, is in themeFonts.ts, so
 * routes that only need colours (OG cards) never load next/font.
 *
 * A site without a `theme` key gets nothing from here: no attribute, no stylesheet, no script,
 * so docs.markdrop.in renders exactly as before themes existed.
 */
import { paletteTokens, resolveTheme, type ResolvedTheme, type ThemeLayout } from "./theme.mjs";
import type { SiteConfig } from "./types";

const cache = new WeakMap<SiteConfig, ResolvedTheme | null>();

/** The resolved theme, or null for a site with no `theme` key. */
export function siteTheme(site: SiteConfig): ResolvedTheme | null {
  if (!cache.has(site)) {
    const t = resolveTheme(site.theme, site.brand);
    if (t?.customCssErrors.length) console.warn(`[docs] theme.customCss ignored: ${t.customCssErrors.join("; ")}`);
    cache.set(site, t);
  }
  return cache.get(site) ?? null;
}

/** Which page structure the theme uses ("sidebar" without a theme). */
export function themeLayout(site: SiteConfig): ThemeLayout {
  return siteTheme(site)?.layout ?? "sidebar";
}

/** "light" or "dark" when the theme forces one (no theme switch then), else null. */
export function forcedMode(site: SiteConfig): "light" | "dark" | null {
  const m = siteTheme(site)?.mode;
  return m === "light" || m === "dark" ? m : null;
}

export interface OgLook {
  ground: string;
  text: string;
  body: string;
  foot: string;
  /** Eyebrow colour; undefined keeps the brand's (brand.ts ogTheme). */
  eyebrow?: string;
  /** The mark's corner radius. */
  radius: number;
  /** A themed card: the accent rule and the initial tile when the site has no mark. */
  accent?: { fill: string; on: string };
}

/**
 * The Open Graph card's colours: the theme's own (its light palette, or dark for a dark-only
 * site), else the card as it always was.
 */
export function ogLook(site: SiteConfig): OgLook {
  const plain: OgLook = { ground: "#F8FAFC", text: "#0B1220", body: "#475569", foot: "#64748B", radius: 16 };
  const t = siteTheme(site);
  if (!t) return plain;
  const radius = Math.min(t.radius["2xl"], 32);
  if (!t.palette) return { ...plain, radius };
  const tok = paletteTokens(t.palette, t.mode === "dark" ? "dark" : "light");
  return {
    ground: tok["--bg"],
    text: tok["--text"],
    body: tok["--text-secondary"],
    foot: tok["--text-muted"],
    eyebrow: tok["--accent-text"],
    radius,
    accent: { fill: tok["--accent"], on: tok["--on-accent"] },
  };
}

/**
 * For a forced mode: the script that pins <html data-theme> to it before the page paints (the
 * root layout's head script has already applied the reader's stored choice, which a forced site
 * ignores), and the browser-chrome colour. Null when the reader picks.
 */
export function forcedModeScript(site: SiteConfig): string | null {
  const mode = forcedMode(site);
  if (!mode) return null;
  const bg = siteTheme(site)?.palette?.[mode].bg;
  // Palette colours went through parseHex in theme.mjs; anything else falls back to the app's.
  const color = bg && /^#[0-9a-f]{6}$/i.test(bg) ? bg : mode === "light" ? "#E3E7ED" : "#030712";
  return `(function(){var d=document.documentElement;d.setAttribute('data-theme','${mode}');d.classList.toggle('dark',${mode === "dark"});var m=document.querySelector('meta[name=theme-color]');if(m)m.content='${color}';})();`;
}
