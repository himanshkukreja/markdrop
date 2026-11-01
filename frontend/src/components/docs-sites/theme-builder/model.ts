/**
 * The theme builder's model: reading and writing a custom theme on a guide's design (the API's
 * snake_case `settings.theme.custom`), what each setting is when the owner hasn't set it (the
 * preset's own), and the suggested palettes.
 */
import { MARKDROP_BASE, mix, parseHex, resolveTheme, toHex, type Palette } from "@/docs/theme.mjs";
import type { SiteTheme, ThemePreset } from "@/lib/docsSites";
import { COLOR_KEYS, engineTheme, fullCustom, type CustomColorApiKey, type CustomColorsSettings, type CustomThemeSettings } from "@/lib/guideThemes";

export type Mode = "light" | "dark";
export type CustomKey = Exclude<keyof CustomThemeSettings, "light" | "dark">;

export function getCustom<K extends CustomKey>(t: SiteTheme, k: K): NonNullable<CustomThemeSettings[K]> | null {
  return (t.custom?.[k] ?? null) as NonNullable<CustomThemeSettings[K]> | null;
}

export function withCustom(t: SiteTheme, patch: Partial<CustomThemeSettings>): SiteTheme {
  return { ...t, custom: fullCustom({ ...(t.custom ?? {}), ...patch }) };
}

export function getColor(t: SiteTheme, mode: Mode, k: CustomColorApiKey): string | null {
  return t.custom?.[mode]?.[k] ?? null;
}

export function withColor(t: SiteTheme, mode: Mode, k: CustomColorApiKey, hex: string | null): SiteTheme {
  const colors: CustomColorsSettings = { ...(t.custom?.[mode] ?? {}), [k]: hex };
  return withCustom(t, { [mode]: colors });
}

export function withColors(t: SiteTheme, colors: Partial<Record<Mode, CustomColorsSettings>>): SiteTheme {
  return withCustom(t, {
    light: { ...(t.custom?.light ?? {}), ...(colors.light ?? {}) },
    dark: { ...(t.custom?.dark ?? {}), ...(colors.dark ?? {}) },
  });
}

/** The callout colours readers see by default (styles/ds/tokens.css), per theme. */
const TONES: Record<Mode, Record<"tip" | "warning" | "danger", string>> = {
  light: { tip: "#05674c", warning: "#8c4100", danger: "#b41c1c" },
  dark: { tip: "#00d492", warning: "#ffb900", danger: "#ff6467" },
};

/**
 * Every colour as the guide shows it now, per theme: the owner's where set, else the preset's
 * (or Match my brand's). What a colour field shows when it is "Theme default".
 */
export function effectiveColors(t: SiteTheme): Record<Mode, Record<CustomColorApiKey, string>> {
  const { theme, brand } = engineTheme(t);
  const resolved = resolveTheme(theme, brand);
  const pal: Palette = resolved?.palette ?? { accent: MARKDROP_BASE.accent, light: MARKDROP_BASE.light, dark: MARKDROP_BASE.dark };
  const out = {} as Record<Mode, Record<CustomColorApiKey, string>>;
  for (const mode of ["light", "dark"] as const) {
    const p = pal[mode];
    const accent = mode === "dark" ? pal.accentDark ?? pal.accent : pal.accent;
    const bg = parseHex(p.bg) ?? [255, 255, 255];
    out[mode] = {
      bg: p.bg,
      surface: p.card,
      sidebar: p.sidebar ?? p.bg,
      header: p.header,
      text: p.text,
      muted: p.muted,
      accent,
      border: p.line,
      code_bg: p.code,
      code_text: p.codeText,
      note: p.note ?? accent,
      tip: p.tip ?? TONES[mode].tip,
      warning: p.warning ?? TONES[mode].warning,
      danger: p.danger ?? TONES[mode].danger,
      selection: p.selection ?? toHex(mix(bg, parseHex(accent) ?? bg, mode === "light" ? 0.14 : 0.28)),
    };
  }
  return out;
}

/** The reading size, line height and column the presets use (themes.css), for "Theme default". */
const TYPE: Partial<Record<ThemePreset, { size: number; line: number; width: number }>> = {
  editorial: { size: 18, line: 1.65, width: 640 },
  technical: { size: 15, line: 1.6, width: 820 },
  minimal: { size: 16.5, line: 1.75, width: 680 },
  playful: { size: 16.5, line: 1.7, width: 760 },
  paper: { size: 18, line: 1.7, width: 760 },
  corporate: { size: 15.5, line: 1.6, width: 760 },
  academic: { size: 17, line: 1.7, width: 760 },
  pastel: { size: 16.5, line: 1.7, width: 760 },
  helpcenter: { size: 16, line: 1.7, width: 760 },
};

export function presetType(preset: ThemePreset) {
  return TYPE[preset] ?? { size: 16, line: 1.7, width: 760 };
}

/** A complete light and dark palette around one accent: tinted neutrals, readable text. */
export function paletteFrom(accentHex: string, opts: { warm?: boolean; tint?: number } = {}): Record<Mode, CustomColorsSettings> {
  const a = parseHex(accentHex) ?? [33, 80, 216];
  const tint = opts.tint ?? 0.035;
  const white: [number, number, number] = opts.warm ? [255, 252, 246] : [255, 255, 255];
  const night: [number, number, number] = opts.warm ? [22, 19, 16] : [11, 13, 18];
  const ink: [number, number, number] = opts.warm ? [43, 33, 24] : [15, 23, 42];
  const lbg = mix(white, a, tint);
  const dbg = mix(night, a, 0.09);
  const dcard = mix(dbg, [255, 255, 255], 0.045);
  const lightText = mix(ink, a, 0.12);
  const darkText: [number, number, number] = mix([240, 242, 247], a, 0.06);
  return {
    light: {
      bg: toHex(lbg),
      surface: toHex(mix(lbg, [255, 255, 255], 0.7)),
      sidebar: toHex(mix(white, a, tint * 1.8)),
      header: toHex(mix(lbg, [255, 255, 255], 0.7)),
      text: toHex(lightText),
      muted: toHex(mix(lightText, lbg, 0.42)),
      accent: toHex(a),
      border: toHex(mix(lbg, lightText, 0.12)),
    },
    dark: {
      bg: toHex(dbg),
      surface: toHex(dcard),
      sidebar: toHex(mix(dbg, [255, 255, 255], 0.025)),
      header: toHex(dcard),
      text: toHex(darkText),
      muted: toHex(mix(darkText, dbg, 0.38)),
      accent: toHex(mix(a, [255, 255, 255], 0.35)),
      border: toHex(mix(dbg, darkText, 0.14)),
    },
  };
}

/** Curated starting palettes (each a full light and dark set). */
export const CURATED: Array<{ id: string; name: string; accent: string; warm?: boolean }> = [
  { id: "ocean", name: "Ocean", accent: "#0369a1" },
  { id: "forest", name: "Forest", accent: "#15803d" },
  { id: "plum", name: "Plum", accent: "#7e22ce" },
  { id: "ember", name: "Ember", accent: "#c2410c", warm: true },
  { id: "rose", name: "Rose", accent: "#be123c" },
  { id: "graphite", name: "Graphite", accent: "#334155" },
];

export { COLOR_KEYS };
