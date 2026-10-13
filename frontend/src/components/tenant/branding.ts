/**
 * Tenant branding: the shape the tenant chrome reads, and the accent maths.
 *
 * A plain module (no "use client"), so the server can compute the accent CSS once per request
 * and the client components can share the types.
 *
 * Why computed rather than "just set --accent": a workspace picks any hex. Used raw it can sit
 * at 1.5:1 against our background as link text, or put white text on a yellow button. So the
 * fill keeps the brand colour (nudged only in the narrow band where neither white nor gray-950
 * reaches 4.5:1 on it), the text-on-fill is whichever of white / gray-950 contrasts more, and the
 * accent *text* is moved toward white (dark theme) or black (light theme) until it clears 4.5:1
 * on every surface it is drawn on, including its own wash (REVAMP_PLAN 5.4, 7.8).
 */

import type { HostResolution } from "@/lib/hostResolution";

export type LogoWell = "light" | "dark" | "checker";

/**
 * What the tenant chrome needs. Built on the server from the host resolution, handed to the
 * client through `TenantProvider`. Every field is already public (it is what the page shows).
 */
export interface TenantChrome {
  /** The custom host the request arrived on, e.g. "docs.acme.com". */
  host: string;
  /** The name shown in the header and in "Sign in to read {name}". Falls back to the host. */
  name: string;
  /** The workspace's own site name, or null when it set none. */
  siteName: string | null;
  logoUrl: string | null;
  /** D38: which well the logo sits on; null = follow the theme. */
  logoWell: LogoWell | null;
  accentColor: string | null;
  hideMarkdropBranding: boolean;
  /** "minimal" behaves like "full" (D24). */
  viewerChrome: "full" | "minimal" | "none";
  requireAuthToView: boolean;
}

/** `HostResolution` plus the optional `logo_well` the host endpoint may carry (D38). */
export type TenantResolution = HostResolution & { logo_well?: string | null };

function wellOf(v: unknown): LogoWell | null {
  return v === "light" || v === "dark" || v === "checker" ? v : null;
}

/** Only http(s) logos; anything else (javascript:, data:) is dropped rather than rendered. */
function safeImageUrl(v: string | null | undefined): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function tenantChromeFrom(resolved: TenantResolution, host: string): TenantChrome {
  const siteName = resolved.site_name?.trim() || null;
  return {
    host,
    name: siteName || host,
    siteName,
    logoUrl: safeImageUrl(resolved.logo_url),
    logoWell: wellOf(resolved.logo_well),
    accentColor: parseHex(resolved.accent_color) ? resolved.accent_color : null,
    hideMarkdropBranding: !!resolved.hide_markdrop_branding,
    viewerChrome: resolved.viewer_chrome ?? "full",
    requireAuthToView: !!resolved.require_auth_to_view,
  };
}

/* ── Colour maths ───────────────────────────────────────────────────────── */

type RGB = [number, number, number];

/** "#rgb" or "#rrggbb" only (what the API validates). Anything else is no accent at all. */
export function parseHex(v: string | null | undefined): RGB | null {
  if (!v) return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex([r, g, b]: RGB): string {
  return "#" + [r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("");
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance([r, g, b]: RGB): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `amount` of `b` mixed into `a` (sRGB, enough for clamping). */
function mix(a: RGB, b: RGB, amount: number): RGB {
  return [a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount];
}

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];
/** gray-950, the dark choice for text on a light accent. */
const INK: RGB = [3, 7, 18];

/** The grounds accent text is drawn on, per theme (bg, surface, surface-raised). Mirrors tokens.css. */
const GROUNDS: Record<"dark" | "light", RGB[]> = {
  dark: [[3, 7, 18], [16, 24, 40], [30, 41, 57]],
  light: [[227, 231, 237], [235, 238, 242], [242, 244, 247]],
};

/** Wash strength of `--accent-soft` per theme (REVAMP_PLAN 5.4: 28% dark, 14% light). */
const WASH = { dark: 0.28, light: 0.14 } as const;

/** Move `c` toward `toward` until it reaches `target` against every ground. */
function clampAgainst(c: RGB, grounds: RGB[], toward: RGB, target: number): RGB {
  let out = c;
  for (let i = 0; i <= 50; i++) {
    if (grounds.every((g) => contrast(out, g) >= target)) return out;
    out = mix(c, toward, i / 50);
  }
  return toward;
}

export interface AccentTokens {
  accent: string;
  accentHover: string;
  onAccent: string;
  /** Per theme: the clamped text colour and its hover. */
  text: Record<"dark" | "light", { base: string; hover: string }>;
}

/** The contrast-safe accent token values for a brand hex, or null when there is no valid accent. */
export function accentTokens(hex: string | null | undefined): AccentTokens | null {
  const brand = parseHex(hex);
  if (!brand) return null;

  // Text on the fill: whichever of white / gray-950 contrasts more.
  const lightText = contrast(WHITE, brand) >= contrast(INK, brand);
  const on = lightText ? WHITE : INK;
  // In the band where neither reaches 4.5:1, nudge the fill (darker under white, lighter under
  // ink) just far enough. Most brand colours never enter it, so they are drawn exactly.
  let fill = brand;
  for (let i = 1; contrast(on, fill) < 4.5 && i <= 40; i++) fill = mix(brand, lightText ? BLACK : WHITE, i / 100);
  // Hover moves away from the text colour, so the label never loses contrast on hover.
  const hover = mix(fill, lightText ? BLACK : WHITE, 0.12);

  const text = (["dark", "light"] as const).reduce(
    (acc, theme) => {
      const washed = mix(GROUNDS[theme][0], brand, WASH[theme]);
      const grounds = [...GROUNDS[theme], washed];
      const toward = theme === "dark" ? WHITE : BLACK;
      acc[theme] = {
        // 4.6 rather than 4.5: the wash is mixed in oklab by the browser, sRGB here.
        base: toHex(clampAgainst(brand, grounds, toward, 4.6)),
        hover: toHex(clampAgainst(brand, grounds, toward, 6)),
      };
      return acc;
    },
    {} as AccentTokens["text"],
  );

  return { accent: toHex(fill), accentHover: toHex(hover), onAccent: toHex(on), text };
}

/**
 * The stylesheet that re-points the accent tokens (and the automatic logo well) at the tenant's
 * values. Specificity is doubled (`[data-theme][data-theme]`) so it also wins inside portals and
 * theme scopes, which re-declare the tokens on their own element. Every value comes out of
 * `toHex` or a fixed string, never the raw input, so nothing user-supplied reaches the CSS.
 */
export function tenantCss(chrome: Pick<TenantChrome, "accentColor">): string {
  const t = accentTokens(chrome.accentColor);
  const block = (theme: "dark" | "light") => {
    const decls = [`--tenant-logo-well:var(--logo-well-${theme})`];
    if (t) {
      decls.push(
        `--accent:${t.accent}`,
        `--accent-hover:${t.accentHover}`,
        `--on-accent:${t.onAccent}`,
        `--accent-text:${t.text[theme].base}`,
        `--accent-text-hover:${t.text[theme].hover}`,
        `--accent-soft:color-mix(in oklab, ${t.accent} ${Math.round(WASH[theme] * 100)}%, transparent)`,
        `--accent-ring:color-mix(in oklab, ${t.accent} 30%, transparent)`,
      );
    }
    return decls.join(";");
  };
  return [
    `:root,[data-theme="dark"][data-theme]{${block("dark")}}`,
    `[data-theme="light"][data-theme]{${block("light")}}`,
    `@media (prefers-color-scheme: light){:root:not([data-theme]){${block("light")}}}`,
  ].join("\n");
}
