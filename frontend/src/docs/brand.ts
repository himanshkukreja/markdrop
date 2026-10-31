/**
 * The site settings that make the engine one site's docs rather than Markdrop's: branding, Ask AI,
 * Try it, the MCP server's name and the Markdrop-only integrations. Plain module (server and
 * client): it only reads a SiteConfig. Every key is optional and the defaults are neutral: no
 * logo, no Markdrop name anywhere, Ask AI off.
 */
import type { Metadata } from "next";
import { accentTokens, parseHex } from "@/components/tenant/branding";
import type { SiteConfig, VideoRef } from "./types";

const DEFAULT_ASSISTANT = "Ask AI";

/** Stable site id (backend key, cache tags). */
export function siteId(site: SiteConfig): string {
  return site.id?.trim() || "default";
}

/** The product the docs are about, for UI copy, or undefined when the site names none. */
export function brandName(site: SiteConfig): string | undefined {
  return site.brand?.name?.trim() || site.product?.name?.trim() || undefined;
}

/** True for Markdrop's own docs: app-session token, Markdrop video links, Markdrop trackers. */
export function markdropApp(site: SiteConfig): boolean {
  return site.integrations?.markdropApp === true;
}

/* ── header logo ─────────────────────────────────────────────────────────── */

export type HeaderBrand =
  | { kind: "markdrop"; label: string }
  | { kind: "image"; light: string; dark?: string; alt: string; text?: string; label: string; tile?: boolean }
  | { kind: "text"; text: string; label: string };

/**
 * What the header shows left of the tabs. The built-in mark comes with its wordmark; an image is
 * followed by the brand name unless it is a wordmark itself; no logo shows the name as text (the
 * brand name, else the site's name, whose own "Docs" makes the label redundant). An opaque light
 * logo with no dark image (`tile: true`) sits on a light tile in the dark theme.
 */
export function headerBrand(site: SiteConfig): HeaderBrand {
  const b = site.brand ?? {};
  const name = brandName(site);
  const label = b.label ?? (name ? "Docs" : "");
  const logo = b.logo;
  if (logo && "builtin" in logo && logo.builtin === "markdrop") return { kind: "markdrop", label };
  if (logo && "light" in logo && typeof logo.light === "string" && logo.light) {
    const dark = logo.dark || undefined;
    const text = logo.wordmark ? undefined : name;
    return { kind: "image", light: logo.light, dark, alt: logo.alt || name || site.name, text, label: labelAfter(text, label), ...(logo.tile === true && !dark ? { tile: true } : {}) };
  }
  const text = name || site.name;
  return { kind: "text", text, label: labelAfter(text, label) };
}

/** The label, unless the name already ends with it ("Acme Docs" + "Docs" shows "Acme Docs", not "Acme Docs | Docs"). */
export function labelAfter(text: string | undefined, label: string): string {
  const l = label.trim().toLowerCase();
  if (!text || !l) return label;
  const t = text.trim().toLowerCase();
  return t === l || t.endsWith(` ${l}`) ? "" : label;
}

/** The app's own icon (app/icon.svg): left to the root layout's file-based icon links as they are. */
const APP_ICON = "/icon.svg";

/**
 * The docs' `icons` metadata: undefined keeps the root layout's (Markdrop's) icons, which is what
 * a site gets by pointing `favicon` at the app's own /icon.svg; any other favicon replaces them;
 * no favicon removes them, so a site never shows Markdrop's icon by default.
 */
export function faviconMetadata(site: SiteConfig): Metadata["icons"] | undefined {
  const f = site.brand?.favicon?.trim();
  if (f === APP_ICON) return undefined;
  if (f) return { icon: [{ url: f }], apple: [] };
  return { icon: [], apple: [] };
}

/* ── colours ─────────────────────────────────────────────────────────────── */

/**
 * The stylesheet that re-points the accent tokens at the site's colours, or null without any.
 * Values come out of the tenant accent maths (contrast-clamped, always #rrggbb), never the raw
 * input, so nothing from site.json reaches the CSS unparsed.
 */
export function accentCss(site: SiteConfig): string | null {
  const light = accentTokens(site.brand?.accent);
  const dark = accentTokens(site.brand?.accentDark) ?? light;
  if (!light && !dark) return null;
  const block = (theme: "dark" | "light") => {
    const t = theme === "light" ? light ?? dark : dark;
    if (!t) return "";
    const wash = theme === "dark" ? 28 : 14;
    return [
      `--accent:${t.accent}`,
      `--accent-hover:${t.accentHover}`,
      `--on-accent:${t.onAccent}`,
      `--accent-text:${t.text[theme].base}`,
      `--accent-text-hover:${t.text[theme].hover}`,
      `--accent-soft:color-mix(in oklab, ${t.accent} ${wash}%, transparent)`,
      `--accent-ring:color-mix(in oklab, ${t.accent} 30%, transparent)`,
    ].join(";");
  };
  return [`:root,[data-theme="dark"][data-theme]{${block("dark")}}`, `[data-theme="light"][data-theme]{${block("light")}}`].join("\n");
}

const hex = (v: string | undefined, fallback: string) => (v && parseHex(v) ? v : fallback);

/**
 * The Open Graph card: the mark (Markdrop's "m" tile, or none), its ground (`og.background`) and
 * dot (`og.accent`), and the eyebrow colour (the site's accent, else blue).
 */
export function ogTheme(site: SiteConfig): { mark: "markdrop" | "none"; ground: string; dot: string; eyebrow: string } {
  const og = site.brand?.og ?? {};
  return {
    mark: og.mark === "markdrop" ? "markdrop" : "none",
    ground: hex(og.background, "#0f172a"),
    dot: hex(og.accent, "#3b82f6"),
    eyebrow: hex(site.brand?.accent, "#2563EB"),
  };
}

/* ── Ask AI, Try it, MCP ─────────────────────────────────────────────────── */

export interface AiSettings {
  /** Backend origin, no trailing slash. */
  api: string;
  /** Backend site key. */
  site: string;
  name: string;
  /** Send a Markdrop session token stored for the docs origin (Markdrop's own docs only). */
  appSession: boolean;
}

/** Markdrop's own docs follow NEXT_PUBLIC_API_URL (local and preview backends); other sites never do. */
function appApi(site: SiteConfig): string | undefined {
  return markdropApp(site) ? process.env.NEXT_PUBLIC_API_URL || undefined : undefined;
}

/** Ask AI's settings, or null when the site has it off (the default). */
export function aiSettings(site: SiteConfig): AiSettings | null {
  const ai = site.ai;
  if (!ai?.enabled) return null;
  const api = (appApi(site) || ai.api || "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(api)) return null;
  return { api, site: ai.site?.trim() || siteId(site), name: ai.assistantName?.trim() || DEFAULT_ASSISTANT, appSession: markdropApp(site) };
}

export interface TryItSettings {
  tokenHelpUrl?: string;
  tokenEnv: string;
  tokenPrefix: string;
  /** Where Try it sends requests instead of the operation's server (Markdrop's NEXT_PUBLIC_API_URL), if anywhere. */
  sendTo?: string;
}

export function tryItSettings(site: SiteConfig): TryItSettings {
  const t = site.tryIt ?? {};
  const app = appApi(site);
  return {
    tokenHelpUrl: t.tokenHelpUrl || undefined,
    tokenEnv: t.tokenEnv && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.tokenEnv) ? t.tokenEnv : "API_TOKEN",
    tokenPrefix: t.tokenPrefix || "",
    ...(app ? { sendTo: app.replace(/\/+$/, "") } : {}),
  };
}

export function mcpName(site: SiteConfig): string {
  const n = site.mcp?.name?.trim();
  if (n) return n;
  return site.id?.trim() ? `${site.id.trim()}-docs` : "docs";
}

/* ── videos ──────────────────────────────────────────────────────────────── */

/** The published Markdrop link a videos.json entry frames, on Markdrop's own docs only. */
export function videoLink(ref: VideoRef | undefined, site: SiteConfig): string | undefined {
  if (!ref || !markdropApp(site)) return undefined;
  return ref.markdrop || ref.url || undefined;
}

/* ── what the client islands need ────────────────────────────────────────── */

/** The settings the browser needs, built once on the server and handed to DocsSiteProvider. */
export interface DocsClientSite {
  /** Canonical origin of the docs. */
  url: string;
  /** Product name for copy, if the site names one. */
  name?: string;
  ai: AiSettings | null;
  mcpName: string;
  tryIt: TryItSettings;
  /** A Markdrop Guides site's Insights endpoint (site.json `insights`); absent everywhere else. */
  insights?: string;
}

export function clientSite(site: SiteConfig): DocsClientSite {
  const out: DocsClientSite = { url: site.url, name: brandName(site), ai: aiSettings(site), mcpName: mcpName(site), tryIt: tryItSettings(site) };
  if (typeof site.insights === "string" && /^https?:\/\//.test(site.insights)) out.insights = site.insights.replace(/\/+$/, "");
  return out;
}
