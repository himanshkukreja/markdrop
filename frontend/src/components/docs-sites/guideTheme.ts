/**
 * A guide's saved design as the published engine draws it, for the studio's previews: the same
 * engine rules (docs/theme.mjs resolveTheme + paletteTokens, the accent maths of docs/brand.ts) fed
 * the same site.json the snapshot writer makes from the settings (backend services/docs_snapshot.py
 * _theme/_brand). The editor's Preview and the Design panel's drawing both read their colours from
 * here, so neither can show another design than the one the guide will publish with.
 */
import { accentTokens } from "@/components/tenant/branding";
import { FONTS, FONT_STACKS, paletteTokens, resolveTheme, type ResolvedTheme } from "@/docs/theme.mjs";
import type { SiteTheme } from "@/lib/docsSites";

type ThemeLike = Pick<SiteTheme, "preset" | "brand" | "fonts" | "corners"> & Partial<Pick<SiteTheme, "mode">>;

/** The site.json `theme` and `brand` colours the snapshot writer makes from these settings. */
export function engineInput(theme: ThemeLike): { theme: Record<string, unknown>; brand?: { accent?: string; accentDark?: string; colors?: string[] } } {
  const fonts = Object.fromEntries(Object.entries(theme.fonts ?? {}).filter(([, v]) => !!v));
  const t: Record<string, unknown> = { preset: theme.preset || "clean" };
  if (Object.keys(fonts).length) t.fonts = fonts;
  if (theme.mode) t.mode = theme.mode;
  if (theme.corners) t.corners = theme.corners;
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
const family = (id: string, fallback: string) => {
  const f = (FONTS as Record<string, { label: string; kind: "sans" | "serif" | "mono" }>)[id];
  if (!f) return fallback;
  return id === "system" ? FONT_STACKS.sans : `"${f.label}", ${FONT_STACKS[f.kind]}`;
};

/**
 * The CSS custom properties a page of the guide renders with, in light or dark: fonts, heading
 * weight, corner radii, and the colour tokens (the preset's palette, built with the brand colours;
 * for a preset without its own palette, Markdrop's tokens with the brand accent swapped in, like
 * the engine's accent stylesheet).
 */
export function guideThemeVars(theme: ThemeLike, dark: boolean): Record<string, string> {
  const t = resolvedGuideTheme(theme);
  const mode = dark ? "dark" : "light";
  const vars: Record<string, string> = {
    "--font-sans": family(t.fonts.body, "var(--font-sans)"),
    "--dx-font-heading": family(t.fonts.heading, "var(--font-sans)"),
    "--dx-heading-weight": String(t.headingWeight),
    ...Object.fromEntries(Object.entries(t.radius).map(([k, v]) => [`--radius-${k}`, `${v}px`])),
  };
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

/** Whether the guide opens dark (a dark-only guide, or a dark-first preset left on "both"). */
export function opensDark(theme: ThemeLike): boolean {
  if (theme.mode === "dark") return true;
  if (theme.mode === "light") return false;
  return theme.preset === "midnight" || theme.preset === "terminal";
}
