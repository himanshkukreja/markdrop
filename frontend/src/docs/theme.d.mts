/** Types for theme.mjs (site.json `theme`: presets, fonts, corners, mode, brand palettes, custom CSS). */

export type PresetId = "clean" | "editorial" | "technical" | "minimal" | "playful" | "helpcenter";
export type ThemeLayout = "sidebar" | "top" | "helpcenter";
export type FontKind = "sans" | "serif" | "mono";
export type CornersId = "sharp" | "soft" | "round";
export type ThemeMode = "both" | "light" | "dark";
export type RadiusScale = Record<"sm" | "md" | "lg" | "xl" | "2xl" | "3xl", number>;

export interface BasePalette {
  bg: string;
  header: string;
  card: string;
  text: string;
  muted: string;
  line: string;
  code: string;
  codeText: string;
}

export interface Palette {
  accent: string;
  accentDark?: string;
  tint?: string;
  light: BasePalette;
  dark: BasePalette;
}

export interface Preset {
  label: string;
  blurb: string;
  layout: ThemeLayout;
  fonts: { heading: string; body: string; mono: string };
  corners: CornersId | RadiusScale;
  headingWeight: number;
  palette: { accent: string; light: BasePalette; dark: BasePalette } | null;
}

export declare const CORNERS: Record<CornersId, RadiusScale>;
export declare const PRESETS: Record<PresetId, Preset>;
export declare const FONTS: Record<string, { label: string; kind: FontKind }>;
export declare const FONT_STACKS: Record<FontKind, string>;
export declare const MODES: ThemeMode[];
export declare const CUSTOM_CSS_MAX: number;
export declare const WASH: { dark: number; light: number };

type RGB = [number, number, number];
export declare function parseHex(v: unknown): RGB | null;
export declare function toHex(c: RGB): string;
export declare function luminance(c: RGB): number;
export declare function contrast(a: RGB, b: RGB): number;
export declare function mix(a: RGB, b: RGB, amount: number): RGB;
export declare function accentFor(
  hex: string | undefined,
  theme: "light" | "dark",
  grounds: RGB[],
): { accent: string; accentHover: string; onAccent: string; text: string; textHover: string } | null;

export declare function brandRoles(colors: unknown): { accent: string; ink?: string; tint?: string } | null;
export declare function buildPalette(presetId: string, opts?: { colors?: unknown; accent?: string; accentDark?: string }): Palette | null;
export declare function paletteTokens(palette: Palette, theme: "light" | "dark"): Record<string, string>;
export declare function paletteReport(palette: Palette): Record<"light" | "dark", { text: number; muted: number; links: number; button: number }>;

export declare function sanitizeCss(input: unknown, scope?: string): { css: string; errors: string[] };

export interface ThemeConfig {
  preset?: string;
  fonts?: { heading?: string; body?: string; mono?: string };
  corners?: string;
  mode?: string;
  colors?: string[];
  customCss?: string;
}

export interface ResolvedTheme {
  preset: PresetId;
  layout: ThemeLayout;
  fonts: { heading: string; body: string; mono: string };
  headingWeight: number;
  radius: RadiusScale;
  mode: ThemeMode;
  palette: Palette | null;
  customCss: string;
  customCssErrors: string[];
}

export declare function resolveTheme(theme: unknown, brand?: { accent?: string; accentDark?: string }): ResolvedTheme | null;
export declare function themeCss(t: ResolvedTheme, families: Record<string, string>): string;
export declare function validateTheme(theme: unknown): Array<{ level: "error" | "warn"; msg: string }>;
