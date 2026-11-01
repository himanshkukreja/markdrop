/** Types for theme.mjs (site.json `theme`: presets, fonts, corners, mode, brand palettes, custom CSS). */

export type PresetId =
  | "clean" | "editorial" | "technical" | "minimal" | "playful" | "helpcenter"
  | "midnight" | "paper" | "terminal" | "corporate" | "studio" | "academic" | "atlas" | "pastel";
export type ThemeLayout = "sidebar" | "top" | "helpcenter";
/** The home page: the hero home, or the help center's (search, category cards). */
export type ThemeHome = "hero" | "categories";
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
  /** Custom themes only. */
  sidebar?: string;
  note?: string;
  tip?: string;
  warning?: string;
  danger?: string;
  selection?: string;
  codeSet?: boolean;
}

export interface Palette {
  accent: string;
  accentDark?: string;
  tint?: string;
  light: BasePalette;
  dark: BasePalette;
  /** A custom theme's palette: held to WCAG AA rather than the presets' designed ratios. */
  custom?: boolean;
}

export interface Preset {
  label: string;
  blurb: string;
  layout: ThemeLayout;
  /** Overrides the layout's own home ("categories" for helpcenter, else "hero"). */
  home?: ThemeHome;
  /** The header shows the nav groups as tabs when the site has no tabs of its own (Atlas). */
  sectionTabs?: boolean;
  fonts: { heading: string; body: string; mono: string };
  corners: CornersId | RadiusScale;
  headingWeight: number;
  palette: { accent: string; accentDark?: string; light: BasePalette; dark: BasePalette } | null;
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

/* Custom themes (the theme builder). */
export type CustomColorKey =
  | "bg" | "surface" | "sidebar" | "header" | "text" | "muted" | "accent" | "border"
  | "codeBg" | "codeText" | "note" | "tip" | "warning" | "danger" | "selection";
export type CustomColors = Partial<Record<CustomColorKey, string>>;
export interface CustomOptions {
  radius: "none" | "small" | "medium" | "large" | "xlarge";
  buttons: "square" | "rounded" | "pill";
  cards: "flat" | "bordered" | "raised";
  headerAlign: "left" | "center";
  headerStyle: "solid" | "transparent";
  tabStyle: "pills" | "underline";
  sidebarStyle: "pills" | "lines" | "plain";
  callouts: "tinted" | "bordered" | "bar";
  codeTheme: "auto" | "light" | "dark";
  links: "underline" | "accent" | "plain";
  icons: "regular" | "light" | "bold" | "duotone";
}
export interface CustomTheme extends Partial<CustomOptions> {
  light?: CustomColors;
  dark?: CustomColors;
  baseSize?: number;
  lineHeight?: number;
  headingWeight?: number;
  contentWidth?: number;
  sectionTabs?: boolean;
  sidebarIcons?: boolean;
}
export interface GuardRow {
  mode: "light" | "dark";
  /** The custom colour "Fix" replaces. */
  key: CustomColorKey;
  label: string;
  fg: string;
  bg: string;
  ratio: number;
  min: number;
  ok: boolean;
  fix: string | null;
}
export declare const CUSTOM_COLORS: CustomColorKey[];
export declare const CUSTOM_OPTIONS: { [K in keyof CustomOptions]: Array<CustomOptions[K]> };
export declare const CUSTOM_BOOLS: Array<"sectionTabs" | "sidebarIcons">;
export declare const CUSTOM_RANGES: Record<"baseSize" | "lineHeight" | "headingWeight" | "contentWidth", [number, number, number]>;
export declare const CUSTOM_RADIUS: Record<CustomOptions["radius"], RadiusScale>;
export declare const CALLOUT_KINDS: Array<"note" | "tip" | "warning" | "danger">;
export declare function normalizeCustom(raw: unknown): CustomTheme | null;
export declare function validateCustom(raw: unknown): string[];
export declare function applyCustomColors(palette: Palette | null, custom: CustomTheme | null): Palette | null;
export declare function codeTokens(palette: Palette, theme: "light" | "dark", codeTheme?: string): Record<string, string> | null;
export declare function contrastGuard(theme: unknown, brand?: { accent?: string | null; accentDark?: string | null; colors?: unknown }): GuardRow[];
export declare function themeAttrs(t: ResolvedTheme | null): Record<string, string>;

export declare function sanitizeCss(input: unknown, scope?: string): { css: string; errors: string[] };

/** site.json `theme`. null is "the preset's default". Brand colours live in `brand.colors`. */
export interface ThemeConfig {
  preset?: string | null;
  fonts?: { heading?: string | null; body?: string | null; mono?: string | null } | null;
  corners?: string | null;
  mode?: string | null;
  customCss?: string | null;
  custom?: CustomTheme | null;
}

export interface ResolvedTheme {
  preset: PresetId;
  layout: ThemeLayout;
  home: ThemeHome;
  sectionTabs: boolean;
  fonts: { heading: string; body: string; mono: string };
  headingWeight: number;
  radius: RadiusScale;
  mode: ThemeMode;
  palette: Palette | null;
  custom: CustomTheme | null;
  customCss: string;
  customCssErrors: string[];
}

export declare function resolveTheme(theme: unknown, brand?: { accent?: string | null; accentDark?: string | null; colors?: unknown }): ResolvedTheme | null;
export declare function themeCss(t: ResolvedTheme, families: Record<string, string>): string;
export declare function validateTheme(theme: unknown): Array<{ level: "error" | "warn"; msg: string }>;
export declare function validateBrandColors(colors: unknown): string[];

export interface HeaderTab { key: string; label: string; href: string; current: boolean }
export function headerTabs(
  tabs: Array<{ id: string; label: string; href: string }>,
  groups: Array<{ group: string; tab?: string; items: Array<{ path: string; available?: boolean }> }>,
  opts: { sections: boolean; activeTab?: string; current?: string },
): HeaderTab[];
