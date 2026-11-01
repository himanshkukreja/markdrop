/**
 * What each theme preset looks like, for the Design panel's live preview and the site cards'
 * thumbnails (the engine draws the real thing). Colours here are the presets' defaults; "Match my
 * brand" swaps the accent for one built from the brand colour, clamped to readable contrast in both
 * modes with the same maths as the tenant chrome (components/tenant/branding).
 */
import { contrast, parseHex } from "@/components/tenant/branding";
import { CORNERS, PRESETS as ENGINE } from "@/docs/theme.mjs";
import { FONTS, type Corners, type SiteTheme, type ThemePreset } from "@/lib/docsSites";

export interface Palette { bg: string; header: string; card: string; text: string; muted: string; line: string; code: string; codeText: string }

export interface PresetLook {
  head: string;
  body: string;
  headW: number;
  r: string;
  logoR: string;
  sidebar: boolean;
  hero: boolean;
  measure: string;
  center: boolean;
  accent: string;
  accentDark: string;
  light: Palette;
  dark: Palette;
  /** Thumbnails show the dark palette (a dark-first theme). */
  darkFirst?: boolean;
  /** The home is the help center's card grid (thumbnails draw the home: no sidebar). */
  homeCards?: boolean;
  /** The header shows the sections as tabs (Atlas: theme.mjs sectionTabs). */
  tabs?: boolean;
  /** The title on the Design panel's mini preview. */
  headline?: string;
}

const family = (id: string) => FONTS.find((f) => f.id === id)?.family ?? "var(--font-sans)";

/** A look drawn from the engine's own preset (theme.mjs: palettes, fonts, corners), so the two can't drift. */
function engineLook(id: ThemePreset, look: Pick<PresetLook, "logoR"> & Partial<PresetLook>): PresetLook {
  const p = ENGINE[id];
  const pal = p.palette!;
  const radius = typeof p.corners === "string" ? CORNERS[p.corners] : p.corners;
  return {
    head: family(p.fonts.heading), body: family(p.fonts.body), headW: p.headingWeight, r: `${radius.lg}px`,
    sidebar: true, hero: false, measure: "760px", center: false, tabs: !!p.sectionTabs,
    accent: pal.accent, accentDark: pal.accentDark ?? pal.accent, light: pal.light, dark: pal.dark,
    ...look,
  };
}

export const LOOKS: Record<ThemePreset, PresetLook> = {
  clean: { head: "var(--font-sans)", body: "var(--font-sans)", headW: 800, r: "8px", logoR: "7px", sidebar: true, hero: false, measure: "760px", center: false, accent: "#2563eb", accentDark: "#60a5fa", light: { bg: "#f7f9fc", header: "#ffffff", card: "#ffffff", text: "#13203a", muted: "#5b6b84", line: "#e2e7ef", code: "#f0f3f8", codeText: "#13203a" }, dark: { bg: "#0d1320", header: "#121a2a", card: "#141d2e", text: "#e6edf7", muted: "#9aa7bd", line: "#243049", code: "#0a101b", codeText: "#e6edf7" } },
  editorial: { head: "Newsreader, Georgia, serif", body: '"Source Sans 3", var(--font-sans)', headW: 600, r: "4px", logoR: "50%", sidebar: false, hero: false, measure: "640px", center: true, accent: "#9a3412", accentDark: "#fdba74", light: { bg: "#fbf8f3", header: "#fbf8f3", card: "#fffdf9", text: "#2b2118", muted: "#776655", line: "#ece2d4", code: "#f3ece1", codeText: "#2b2118" }, dark: { bg: "#1a1612", header: "#1a1612", card: "#221d18", text: "#f1e8dc", muted: "#b3a491", line: "#3a3128", code: "#120f0c", codeText: "#f1e8dc" } },
  technical: { head: '"IBM Plex Sans", var(--font-sans)', body: '"IBM Plex Sans", var(--font-sans)', headW: 600, r: "3px", logoR: "3px", sidebar: true, hero: false, measure: "820px", center: false, accent: "#0369a1", accentDark: "#38bdf8", light: { bg: "#ffffff", header: "#ffffff", card: "#fafbfc", text: "#0b1220", muted: "#4b5565", line: "#e5e7eb", code: "#0b1220", codeText: "#e5f2ff" }, dark: { bg: "#0a0f17", header: "#0a0f17", card: "#0f1622", text: "#e6edf7", muted: "#93a1b5", line: "#1e2a3b", code: "#05080d", codeText: "#bfe6ff" } },
  minimal: { head: "Geist, var(--font-sans)", body: "Geist, var(--font-sans)", headW: 600, r: "10px", logoR: "50%", sidebar: false, hero: false, measure: "680px", center: true, accent: "#111827", accentDark: "#f4f4f5", light: { bg: "#ffffff", header: "#ffffff", card: "#ffffff", text: "#111827", muted: "#6b7280", line: "#eeeeee", code: "#f6f6f6", codeText: "#111827" }, dark: { bg: "#0b0b0c", header: "#0b0b0c", card: "#111113", text: "#f4f4f5", muted: "#a1a1aa", line: "#232326", code: "#141416", codeText: "#f4f4f5" } },
  playful: { head: "Nunito, var(--font-sans)", body: "Nunito, var(--font-sans)", headW: 800, r: "16px", logoR: "50%", sidebar: true, hero: false, measure: "760px", center: false, accent: "#7c3aed", accentDark: "#c4b5fd", light: { bg: "#faf7ff", header: "#ffffff", card: "#ffffff", text: "#24163f", muted: "#6c5b8c", line: "#ece4fb", code: "#f3edff", codeText: "#24163f" }, dark: { bg: "#140e22", header: "#1a1230", card: "#1e1535", text: "#efe7ff", muted: "#b6a5d8", line: "#33275a", code: "#0e0919", codeText: "#efe7ff" } },
  helpcenter: { head: '"DM Sans", var(--font-sans)', body: '"DM Sans", var(--font-sans)', headW: 700, r: "12px", logoR: "8px", sidebar: false, hero: true, measure: "760px", center: true, accent: "#c2410c", accentDark: "#fdba74", light: { bg: "#ffffff", header: "#ffffff", card: "#ffffff", text: "#1c1917", muted: "#6b625c", line: "#ebe5df", code: "#f6f2ee", codeText: "#1c1917" }, dark: { bg: "#121010", header: "#121010", card: "#1a1716", text: "#f5f0eb", muted: "#ada39b", line: "#2e2826", code: "#0c0a0a", codeText: "#f5f0eb" }, headline: "How can we help?" },
  midnight: engineLook("midnight", { logoR: "7px", darkFirst: true }),
  paper: engineLook("paper", { logoR: "50%" }),
  terminal: engineLook("terminal", { logoR: "3px", darkFirst: true, headline: "$ get started" }),
  corporate: engineLook("corporate", { logoR: "2px" }),
  studio: engineLook("studio", { logoR: "12px", headline: "Ship faster" }),
  academic: engineLook("academic", { logoR: "3px", headline: "1. Introduction" }),
  atlas: engineLook("atlas", { logoR: "8px", homeCards: true, headline: "Browse topics" }),
  pastel: engineLook("pastel", { logoR: "50%" }),
};

/** The Google Fonts the preview needs (presets + the font picker), loaded once by the Design panel. */
export const PREVIEW_FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,500;6..72,600&family=Source+Sans+3:wght@400;600;700&family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Mono:wght@400;500&family=Nunito:wght@400;700;800&family=DM+Sans:wght@400;600;700;800&family=Geist:wght@400;600;700&family=Inter:wght@400;600;700&family=Lora:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500;8..60,600&family=Space+Grotesk:wght@400;600;700&family=Plus+Jakarta+Sans:wght@400;600;800&family=Figtree:wght@400;600;800&family=Fraunces:wght@400;600;800&family=Crimson+Pro:wght@400;600&family=Fira+Code:wght@400;500&family=Source+Code+Pro:wght@400;500&display=swap";

const CORNER_R: Record<Corners, string> = { sharp: "3px", soft: "8px", round: "16px" };

type RGB = [number, number, number];
const toHex = ([r, g, b]: RGB) => "#" + [r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("");
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];
const INK: RGB = [3, 7, 18];

/** Move `c` toward `toward` until it reaches `target` contrast on every ground. */
function clamp(c: RGB, grounds: RGB[], toward: RGB, target: number): RGB {
  for (let i = 0; i <= 50; i++) {
    const out = mix(c, toward, i / 50);
    if (grounds.every((g) => contrast(out, g) >= target)) return out;
  }
  return toward;
}

export interface PreviewTokens extends Palette {
  head: string;
  body: string;
  mono: string;
  headW: number;
  r: string;
  logoR: string;
  sidebar: boolean;
  hero: boolean;
  /** Section tabs in the header (Atlas). */
  tabs: boolean;
  measure: string;
  center: boolean;
  accent: string;
  accentText: string;
  soft: string;
  onAccent: string;
  calloutBorder: string;
}

export type ThemeInput = Pick<SiteTheme, "preset" | "brand" | "fonts" | "corners"> & { custom?: SiteTheme["custom"] };

/** The brand accent the theme uses, or null when "Match my brand" is off or has no colour. */
export function brandAccent(theme: ThemeInput): { light: string; dark: string | null } | null {
  if (!theme.brand?.enabled) return null;
  const light = theme.brand.accent || theme.brand.colors?.[0];
  return parseHex(light) ? { light: light!, dark: parseHex(theme.brand.accent_dark) ? theme.brand.accent_dark! : null } : null;
}

export function previewTokens(theme: ThemeInput, dark: boolean): PreviewTokens {
  const look = LOOKS[theme.preset] ?? LOOKS.clean;
  // A custom theme's colours for this mode (the theme builder) over the preset's.
  const cc = theme.custom?.[dark ? "dark" : "light"] ?? null;
  const own = (k: keyof NonNullable<typeof cc>) => (cc?.[k] && parseHex(cc[k]) ? cc[k]! : undefined);
  const base0 = dark ? look.dark : look.light;
  const pal: Palette = {
    bg: own("bg") ?? base0.bg, header: own("header") ?? base0.header, card: own("surface") ?? base0.card, text: own("text") ?? base0.text,
    muted: own("muted") ?? base0.muted, line: own("border") ?? base0.line, code: own("code_bg") ?? base0.code, codeText: own("code_text") ?? base0.codeText,
  };
  const bg = parseHex(pal.bg)!;
  const card = parseHex(pal.card)!;
  const brand = brandAccent(theme);
  const base = parseHex(own("accent") ?? (brand ? (dark ? brand.dark ?? brand.light : brand.light) : dark ? look.accentDark : look.accent))!;
  // Links: readable on the page and on cards (4.5:1).
  const text = clamp(base, [bg, card], dark ? WHITE : BLACK, 4.5);
  // Fill: whichever of white / ink reads better on it, nudged until it reaches 4.5:1.
  const lightOn = contrast(WHITE, base) >= contrast(INK, base);
  let fill = base;
  for (let i = 1; contrast(lightOn ? WHITE : INK, fill) < 4.5 && i <= 40; i++) fill = mix(base, lightOn ? BLACK : WHITE, i / 100);
  const soft = toHex(mix(bg, base, dark ? 0.16 : 0.1));
  const font = (id: string | null | undefined, fallback: string) => FONTS.find((f) => f.id === id)?.family ?? fallback;
  return {
    ...pal,
    head: font(theme.fonts?.heading, look.head),
    body: font(theme.fonts?.body, look.body),
    mono: '"IBM Plex Mono", var(--font-mono)',
    headW: look.headW,
    r: theme.corners ? CORNER_R[theme.corners] : look.r,
    logoR: theme.corners === "sharp" ? "3px" : look.logoR,
    sidebar: look.sidebar,
    hero: look.hero,
    tabs: !!look.tabs,
    measure: look.measure,
    center: look.center,
    accent: toHex(fill),
    accentText: toHex(text),
    soft,
    onAccent: lightOn ? "#ffffff" : toHex(INK),
    calloutBorder: theme.preset === "technical" ? `1px solid ${pal.line}` : "0",
  };
}

/** The three contrast checks the panel shows: body text, links (light) and links (dark). */
export function contrastChecks(theme: ThemeInput): Array<{ label: string; ratio: number; ok: boolean }> {
  const L = previewTokens(theme, false);
  const D = previewTokens(theme, true);
  const c = (a: string, b: string) => contrast(parseHex(a)!, parseHex(b)!);
  const rows = [
    { label: "Text", ratio: c(L.text, L.bg) },
    { label: "Links", ratio: c(L.accentText, L.bg) },
    { label: "Dark links", ratio: c(D.accentText, D.bg) },
  ];
  return rows.map((r) => ({ ...r, ok: r.ratio >= 4.5 }));
}

/** Thumbnail colours for a site card (light palette of the preset, brand accent when set). */
export function thumbColours(preset: ThemePreset | undefined, accent?: string | null) {
  const look = LOOKS[preset ?? "clean"] ?? LOOKS.clean;
  const dark = preset === "technical" || !!look.darkFirst;
  const p = dark ? look.dark : look.light;
  const a = parseHex(accent) ? accent! : dark ? look.accentDark : look.accent;
  const A = parseHex(a)!;
  return {
    ground: dark ? p.bg : toHex(mix(parseHex(p.bg)!, parseHex(p.line)!, 0.6)),
    card: p.card,
    ink: p.text,
    line: p.line,
    accent: a,
    callout: toHex(mix(parseHex(p.card)!, A, dark ? 0.25 : 0.16)),
    sidebar: look.sidebar && !look.homeCards,
  };
}

/**
 * The Design panel's mini preview of a preset (Themes board, "Choose a look"): a page in its own
 * palette (dark for the dark-first themes), its heading face, corners and accent; the brand accent,
 * contrast-safe, when Match my brand is on.
 */
export function miniLook(preset: ThemePreset, brand: SiteTheme["brand"] | undefined) {
  const look = LOOKS[preset] ?? LOOKS.clean;
  const dark = preset === "technical" || !!look.darkFirst;
  const t = previewTokens({ preset, brand: brand ?? { enabled: false, colors: [] }, fonts: {}, corners: null }, dark);
  const bg = parseHex(t.bg)!;
  return {
    ground: toHex(dark ? mix(bg, BLACK, 0.35) : mix(bg, parseHex(t.accent)!, 0.08)),
    page: t.card,
    bar: t.header,
    edge: t.line,
    ink: t.text,
    accent: t.accent,
    tint: toHex(mix(parseHex(t.card)!, parseHex(t.accent)!, dark ? 0.2 : 0.12)),
    r: `min(${t.r}, 10px)`,
    font: t.head,
    weight: t.headW,
    headline: look.headline ?? "Get started",
    sidebar: look.sidebar && !look.homeCards,
  };
}

/** Up to `n` distinct dominant colours in an image (for "Colours found in your logo"). */
export async function coloursFromImage(src: string, n = 4): Promise<string[]> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = src;
  await img.decode();
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];
  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! < 200) continue; // transparent
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += r; e.g += g; e.b += b;
    buckets.set(key, e);
  }
  const ranked = [...buckets.values()].sort((a, b) => b.n - a.n).map((e) => [e.r / e.n, e.g / e.n, e.b / e.n] as RGB);
  const out: RGB[] = [];
  for (const c of ranked) {
    if (out.every((o) => Math.abs(o[0] - c[0]) + Math.abs(o[1] - c[1]) + Math.abs(o[2] - c[2]) > 60)) out.push(c);
    if (out.length >= n) break;
  }
  // Coloured before neutral (the white or black around a logo is rarely the brand), then by area.
  const sat = ([r, g, b]: RGB) => Math.max(r, g, b) - Math.min(r, g, b);
  return out
    .map((c, i) => ({ c, i, neutral: sat(c) < 40 }))
    .sort((a, b) => Number(a.neutral) - Number(b.neutral) || a.i - b.i)
    .map((x) => toHex(x.c));
}
