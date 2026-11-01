/**
 * A guide's saved design as the published engine draws it, for the studio's previews: the same
 * engine rules (docs/theme.mjs resolveTheme + paletteTokens, the accent maths of docs/brand.ts) fed
 * the same site.json the snapshot writer makes from the settings (backend services/docs_snapshot.py
 * _theme/_brand). The editor's Preview and the Design panel's drawing both read their colours from
 * here, so neither can show another design than the one the guide will publish with.
 */
import { accentTokens } from "@/components/tenant/branding";
import { FONTS, FONT_STACKS, paletteTokens, resolveTheme, scopedThemeCss, themeAttrs, themeRootVars, type ResolvedTheme } from "@/docs/theme.mjs";
import type { SiteTheme } from "@/lib/docsSites";

type ThemeLike = Pick<SiteTheme, "preset" | "brand" | "fonts" | "corners"> & Partial<Pick<SiteTheme, "mode" | "custom" | "custom_css">>;

/**
 * A custom theme as site.json carries it: the engine's camelCase keys (code_bg → codeBg), unset values
 * and empty groups left out — the same as the snapshot writer's _camel (backend docs_snapshot.py).
 */
function camel(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v0] of Object.entries(value as Record<string, unknown>)) {
    const v = camel(v0);
    if (v === null || v === undefined) continue;
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0) continue;
    out[k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out;
}

/** The site.json `theme` and `brand` colours the snapshot writer makes from these settings. */
export function engineInput(theme: ThemeLike): { theme: Record<string, unknown>; brand?: { accent?: string; accentDark?: string; colors?: string[] } } {
  const fonts = Object.fromEntries(Object.entries(theme.fonts ?? {}).filter(([, v]) => !!v));
  const t: Record<string, unknown> = { preset: theme.preset || "clean" };
  if (Object.keys(fonts).length) t.fonts = fonts;
  if (theme.mode) t.mode = theme.mode;
  if (theme.corners) t.corners = theme.corners;
  // The theme builder's overrides: without them the preview would show the preset, not the design saved.
  const custom = camel(theme.custom);
  if (custom && typeof custom === "object" && Object.keys(custom).length) t.custom = custom;
  const b = theme.brand;
  if (!b?.enabled) return { theme: t };
  const colors = (b.colors ?? []).filter((c) => typeof c === "string");
  const accent = b.accent || colors[0] || undefined;
  return {
    theme: t,
    brand: { ...(accent ? { accent } : {}), ...(b.accent_dark ? { accentDark: b.accent_dark } : {}), ...(colors.length ? { colors } : {}) },
  };
}

/** The resolved theme (never null: the settings always name a preset). */
export function resolvedGuideTheme(theme: ThemeLike): ResolvedTheme {
  const { theme: t, brand } = engineInput(theme);
  return resolveTheme(t, brand)!;
}

/** A font id → its CSS family, as the engine names it (the studio loads the same faces from Google Fonts). */
const family = (id: string) => {
  const f = (FONTS as Record<string, { label: string; kind: "sans" | "serif" | "mono" }>)[id];
  if (!f) return "var(--font-sans)";
  if (id === "system") return FONT_STACKS.sans;
  // The app's own faces (root layout next/font variables), as the engine's THEME_FONT_FAMILIES has them.
  if (id === "manrope") return `var(--font-manrope), ${FONT_STACKS.sans}`;
  if (id === "jetbrains-mono") return `var(--font-jetbrains), ${FONT_STACKS.mono}`;
  return `"${f.label}", ${FONT_STACKS[f.kind]}`;
};

/**
 * The CSS custom properties a page of the guide renders with, in light or dark: the engine's root
 * properties (theme.mjs themeRootVars: the three faces, heading weight, corner radii, a custom
 * content width) and the colour tokens (the preset's palette, built with the brand colours and a
 * custom theme's colours; for a preset without a palette, Markdrop's tokens with the brand accent
 * swapped in, like the engine's accent stylesheet).
 */
export function guideThemeVars(theme: ThemeLike, dark: boolean): Record<string, string> {
  const t = resolvedGuideTheme(theme);
  const mode = dark ? "dark" : "light";
  const vars: Record<string, string> = themeRootVars(t, family);
  if (t.palette) return { ...vars, ...paletteTokens(t.palette, mode) };
  const { brand } = engineInput(theme);
  const a = accentTokens(dark ? brand?.accentDark ?? brand?.accent : brand?.accent) ?? (dark ? accentTokens(brand?.accent) : null);
  if (a) {
    Object.assign(vars, {
      "--accent": a.accent,
      "--accent-hover": a.accentHover,
      "--on-accent": a.onAccent,
      "--accent-text": a.text[mode].base,
      "--accent-text-hover": a.text[mode].hover,
      "--accent-soft": `color-mix(in oklab, ${a.accent} ${dark ? 28 : 14}%, transparent)`,
      "--accent-ring": `color-mix(in oklab, ${a.accent} 30%, transparent)`,
    });
  }
  return vars;
}

/** What the editor's Preview puts on its docs root to draw the guide as the published engine does. */
export interface GuideLook {
  /** The root's attributes (theme.mjs themeAttrs: data-preset, data-layout, one per custom choice). */
  attrs: Record<string, string>;
  /** The root's custom properties (guideThemeVars). */
  vars: Record<string, string>;
  /** The rest of the theme's stylesheet, scoped to the root (theme.mjs scopedThemeCss). */
  css: string;
}

/**
 * A guide's saved design on one docs root in the studio, from the engine's own functions: the
 * attributes the published layout puts on .dx-root, the tokens, and the custom theme's code-block,
 * type and width rules plus the custom CSS, scoped to `scope` (an attribute selector the root also
 * carries, e.g. `[data-dx-preview="p1"]`).
 */
export function guideLook(theme: ThemeLike, dark: boolean, scope: string): GuideLook {
  const t = resolvedGuideTheme(theme);
  return {
    attrs: themeAttrs(t),
    vars: guideThemeVars(theme, dark),
    css: scopedThemeCss(t, dark ? "dark" : "light", scope, theme.custom_css),
  };
}

/** Whether the guide opens dark (a dark-only guide, or a dark-first preset left on "both"). */
export function opensDark(theme: Pick<ThemeLike, "preset" | "mode">): boolean {
  if (theme.mode === "dark") return true;
  if (theme.mode === "light") return false;
  return theme.preset === "midnight" || theme.preset === "terminal";
}
