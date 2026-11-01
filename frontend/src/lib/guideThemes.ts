/**
 * Custom themes and saved designs for Markdrop Guides (the Design panel's theme builder).
 *
 * The API stores a guide's custom theme in `settings.theme.custom` with snake_case keys
 * (backend docs_site_settings.py Custom); the docs engine reads it from site.json in camelCase
 * (src/docs/theme.mjs normalizeCustom). This module holds the API shape, the conversion the live
 * preview and the contrast guard need, and the saved-design ("Your templates") endpoints under
 * /api/v1/docs-studio/theme-templates (backend services/docs_theme_templates.py).
 */
import { docsRequest, type SiteTheme } from "@/lib/docsSites";
import type { CustomColorKey, CustomOptions, CustomTheme } from "@/docs/theme.mjs";

const STUDIO_BASE = "/api/v1/docs-studio";
const enc = encodeURIComponent;

/** The engine's colour keys (camelCase) and the API's (snake_case), in the builder's order. */
export const COLOR_KEYS: Array<{ key: CustomColorKey; api: CustomColorApiKey }> = [
  { key: "bg", api: "bg" },
  { key: "surface", api: "surface" },
  { key: "sidebar", api: "sidebar" },
  { key: "header", api: "header" },
  { key: "text", api: "text" },
  { key: "muted", api: "muted" },
  { key: "accent", api: "accent" },
  { key: "border", api: "border" },
  { key: "codeBg", api: "code_bg" },
  { key: "codeText", api: "code_text" },
  { key: "note", api: "note" },
  { key: "tip", api: "tip" },
  { key: "warning", api: "warning" },
  { key: "danger", api: "danger" },
  { key: "selection", api: "selection" },
];

export type CustomColorApiKey =
  | "bg" | "surface" | "sidebar" | "header" | "text" | "muted" | "accent" | "border"
  | "code_bg" | "code_text" | "note" | "tip" | "warning" | "danger" | "selection";

export type CustomColorsSettings = Partial<Record<CustomColorApiKey, string | null>>;

/** settings.theme.custom as the API stores it. Every key optional; null = the preset's. */
export interface CustomThemeSettings {
  light?: CustomColorsSettings | null;
  dark?: CustomColorsSettings | null;
  base_size?: number | null;
  line_height?: number | null;
  heading_weight?: number | null;
  content_width?: number | null;
  radius?: CustomOptions["radius"] | null;
  buttons?: CustomOptions["buttons"] | null;
  cards?: CustomOptions["cards"] | null;
  header_align?: CustomOptions["headerAlign"] | null;
  header_style?: CustomOptions["headerStyle"] | null;
  tab_style?: CustomOptions["tabStyle"] | null;
  sidebar_style?: CustomOptions["sidebarStyle"] | null;
  callouts?: CustomOptions["callouts"] | null;
  code_theme?: CustomOptions["codeTheme"] | null;
  links?: CustomOptions["links"] | null;
  icons?: CustomOptions["icons"] | null;
  section_tabs?: boolean | null;
  sidebar_icons?: boolean | null;
}

/** Every key of a custom theme, so a save replaces the whole block (the API deep-merges objects). */
export const CUSTOM_KEYS = [
  "base_size", "line_height", "heading_weight", "content_width", "radius", "buttons", "cards",
  "header_align", "header_style", "tab_style", "sidebar_style", "callouts", "code_theme", "links",
  "icons", "section_tabs", "sidebar_icons",
] as const;

/** A custom theme with every key present (null where unset), or null when nothing is set. */
export function fullCustom(c: CustomThemeSettings | null | undefined): CustomThemeSettings | null {
  if (!c || isEmptyCustom(c)) return null;
  const colors = (m: CustomColorsSettings | null | undefined): CustomColorsSettings =>
    Object.fromEntries(COLOR_KEYS.map(({ api }) => [api, m?.[api] || null])) as CustomColorsSettings;
  return {
    light: colors(c.light),
    dark: colors(c.dark),
    ...Object.fromEntries(CUSTOM_KEYS.map((k) => [k, c[k] ?? null])),
  } as CustomThemeSettings;
}

export function isEmptyCustom(c: CustomThemeSettings | null | undefined): boolean {
  if (!c) return true;
  const colorsSet = (m: CustomColorsSettings | null | undefined) => !!m && Object.values(m).some((v) => !!v);
  return !colorsSet(c.light) && !colorsSet(c.dark) && CUSTOM_KEYS.every((k) => c[k] === null || c[k] === undefined);
}

const camel = (k: string) => k.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());

/** The API's custom block → the engine's (camelCase, unset values left out). */
export function engineCustom(c: CustomThemeSettings | null | undefined): CustomTheme | null {
  if (!c) return null;
  const out: Record<string, unknown> = {};
  for (const mode of ["light", "dark"] as const) {
    const m = c[mode];
    if (!m) continue;
    const colors: Record<string, string> = {};
    for (const { key, api } of COLOR_KEYS) if (m[api]) colors[key] = m[api]!;
    if (Object.keys(colors).length) out[mode] = colors;
  }
  for (const k of CUSTOM_KEYS) if (c[k] !== null && c[k] !== undefined) out[camel(k)] = c[k];
  return Object.keys(out).length ? (out as CustomTheme) : null;
}

/**
 * A guide's design (the API's settings.theme) as the docs engine reads it from site.json: the
 * `theme` and the `brand` the palette uses (as backend docs_snapshot.py writes them).
 */
export function engineTheme(t: SiteTheme): { theme: Record<string, unknown>; brand: { accent?: string; accentDark?: string; colors?: string[] } } {
  const fonts = Object.fromEntries(Object.entries(t.fonts ?? {}).filter(([, v]) => !!v));
  const theme: Record<string, unknown> = { preset: t.preset ?? "clean" };
  if (Object.keys(fonts).length) theme.fonts = fonts;
  if (t.mode) theme.mode = t.mode;
  if (t.corners) theme.corners = t.corners;
  if (t.custom_css) theme.customCss = t.custom_css;
  const custom = engineCustom(t.custom);
  if (custom) theme.custom = custom;
  const brand: { accent?: string; accentDark?: string; colors?: string[] } = {};
  const b = t.brand;
  if (b?.enabled) {
    const colors = (b.colors ?? []).filter(Boolean);
    const accent = b.accent || colors[0];
    if (accent) brand.accent = accent;
    if (b.accent_dark) brand.accentDark = b.accent_dark;
    if (colors.length) brand.colors = colors;
  }
  return { theme, brand };
}

// ── Saved designs ("Your templates") ────────────────────────────────────────

/** A design without the guide's brand: what a template holds. */
export type TemplateTheme = Omit<SiteTheme, "brand">;

export interface ThemeTemplate {
  id: string;
  name: string;
  /** null: a personal template (your personal guides). */
  workspace_id: string | null;
  theme: TemplateTheme;
  created_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ThemeTemplateList {
  templates: ThemeTemplate[];
  /** Guides admins of the workspace (or you, for personal templates). */
  can_edit: boolean;
  limit: number;
}

/** The design part of a guide's theme, ready to save as a template. */
export function templateTheme(t: SiteTheme): TemplateTheme {
  return {
    preset: t.preset,
    fonts: { heading: t.fonts?.heading ?? null, body: t.fonts?.body ?? null, mono: t.fonts?.mono ?? null },
    mode: t.mode,
    corners: t.corners ?? null,
    custom_css: t.custom_css || null,
    custom: fullCustom(t.custom),
  };
}

export function listThemeTemplates(workspaceId: string | null): Promise<ThemeTemplateList> {
  return docsRequest(`/theme-templates${workspaceId ? `?workspace_id=${enc(workspaceId)}` : ""}`, undefined, STUDIO_BASE);
}

export function createThemeTemplate(input: { workspace_id: string | null; name: string; theme: TemplateTheme }): Promise<ThemeTemplate> {
  return docsRequest("/theme-templates", { method: "POST", json: input }, STUDIO_BASE);
}

export function updateThemeTemplate(id: string, patch: { name?: string; theme?: TemplateTheme }): Promise<ThemeTemplate> {
  return docsRequest(`/theme-templates/${enc(id)}`, { method: "PATCH", json: patch }, STUDIO_BASE);
}

export function duplicateThemeTemplate(id: string, name?: string): Promise<ThemeTemplate> {
  return docsRequest(`/theme-templates/${enc(id)}/duplicate`, { method: "POST", json: name ? { name } : {} }, STUDIO_BASE);
}

export function deleteThemeTemplate(id: string): Promise<{ deleted: true; id: string }> {
  return docsRequest(`/theme-templates/${enc(id)}`, { method: "DELETE" }, STUDIO_BASE);
}

// ── Export / import (a JSON file) ───────────────────────────────────────────

export const TEMPLATE_FILE_FORMAT = "markdrop-guide-theme";

/** The file "Export" downloads: the name and the design, nothing about the workspace. */
export function templateFile(name: string, theme: TemplateTheme): string {
  return JSON.stringify({ format: TEMPLATE_FILE_FORMAT, version: 1, name, theme }, null, 2) + "\n";
}

/**
 * A design read from an exported file (the server validates it again when it's saved). Throws a
 * message for anything that isn't one.
 */
export function parseTemplateFile(text: string): { name: string; theme: TemplateTheme } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't a theme export (it isn't JSON).");
  }
  const d = data as { format?: unknown; version?: unknown; name?: unknown; theme?: unknown };
  if (!d || typeof d !== "object" || d.format !== TEMPLATE_FILE_FORMAT || typeof d.theme !== "object" || !d.theme) {
    throw new Error("That file isn't a Markdrop Guides theme export.");
  }
  if (d.version !== 1) throw new Error("That theme export is from a newer version of Markdrop. Update and try again.");
  const name = typeof d.name === "string" && d.name.trim() ? d.name.trim().slice(0, 60) : "Imported theme";
  const t = d.theme as Partial<TemplateTheme> & { brand?: unknown };
  const { brand: _brand, ...theme } = t;
  void _brand;
  return { name, theme: theme as TemplateTheme };
}
