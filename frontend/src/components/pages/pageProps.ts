/**
 * A page's properties, kept in its front matter so the Markdown carries them (and AI apps can read
 * and write them):
 *
 *   ---
 *   icon: 🚀                 an emoji, or asset:<id> (an uploaded image)
 *   cover: gallery:dawn      gallery:<id>, asset:<id> or an https image
 *   cover_y: 40              the cover's focal point, 0 (top) … 100 (bottom); default 50
 *   full_width: true
 *   small_text: true
 *   font: serif              default | serif | mono
 *   locked: true             only the owner and workspace admins can edit
 *   allow_export: false      readers can't export it (editors always can)
 *   ---
 *
 * Unknown keys are kept as written.
 */
import coverManifest from "../../../public/page-covers/manifest.json";

// No YAML parser here: the document view reads these few keys on every page load.
const FRONT_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
function frontKeys(markdown: string): Record<string, string> {
  const m = FRONT_RE.exec(String(markdown ?? ""));
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!kv) continue;
    let v = kv[2];
    if (/^"(.*)"$/.test(v)) {
      try {
        v = JSON.parse(v);
      } catch {
        v = v.slice(1, -1);
      }
    } else if (/^'(.*)'$/.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
    else v = v.replace(/[ \t]+#.*$/, "");
    out[kv[1]] = v;
  }
  return out;
}

export type PageFont = "default" | "serif" | "mono";

export interface PageProps {
  icon: string | null;
  cover: string | null;
  coverY: number;
  fullWidth: boolean;
  smallText: boolean;
  font: PageFont;
  locked: boolean;
  /** Readers may export the page (Export in its ⋯ menu); editors always can. */
  allowExport: boolean;
}

const yes = (v: unknown) => v === true || v === "true" || v === "yes" || v === 1;

export function readPageProps(markdown: string): PageProps {
  const d = frontKeys(markdown) as Record<string, unknown>;
  const y = Number(d.cover_y);
  const font = String(d.font ?? "default");
  return {
    icon: typeof d.icon === "string" && d.icon.trim() ? d.icon.trim() : null,
    cover: typeof d.cover === "string" && d.cover.trim() ? d.cover.trim() : null,
    coverY: Number.isFinite(y) ? Math.max(0, Math.min(100, Math.round(y > 0 && y < 1 ? y * 100 : y))) : 50,
    fullWidth: yes(d.full_width),
    smallText: yes(d.small_text),
    font: font === "serif" || font === "mono" ? font : "default",
    locked: yes(d.locked),
    allowExport: !/^(false|no|off|0)$/i.test(String(d.allow_export ?? "true").trim()),
  };
}

const PAGE_KEYS = ["icon", "cover", "cover_y", "full_width", "small_text", "font", "locked", "allow_export"];

/** Front matter only a page writes (an icon, a cover, its layout…): a classic document with it was a page. */
export function hasPageProps(markdown: string): boolean {
  const d = frontKeys(markdown);
  return PAGE_KEYS.some((k) => k in d);
}

/** The Markdown without its front matter (a classic reader of a page that went classic shows its body). */
export function withoutFrontMatter(markdown: string): string {
  return String(markdown ?? "").replace(FRONT_RE, "");
}

export type CoverCategory = "Paper" | "Duotone" | "Lines" | "Shapes" | "Calm";
export interface GalleryCover {
  id: string;
  name: string;
  category: CoverCategory;
  /** Light or dark (auto covers pick within a theme by tint). */
  tint?: "light" | "dark";
  /** What kind of page it suits (auto covers match on these). */
  tags?: string[];
}

/**
 * Built-in covers (public/page-covers, drawn by scripts/page-covers/generate.mjs and themed.mjs):
 * 1500×480 WebP, each with a small thumbnail for the picker, a tint and tags. The backend keeps the
 * same ids, tints and tags (services/page_covers.json) and picks one for new pages (auto covers).
 */
export const COVER_CATEGORIES = coverManifest.categories as CoverCategory[];
export const COVER_GALLERY = coverManifest.covers as GalleryCover[];
/** The first gallery's gradient ids, still on older pages: each shows the nearest new cover. */
export const COVER_ALIASES: Record<string, string> = coverManifest.aliases;

/** The gallery cover a `gallery:<id>` value shows (an old id resolves to its replacement). */
export function galleryCover(cover: string | null): GalleryCover | null {
  const g = /^gallery:([a-z0-9-]+)$/.exec(cover ?? "");
  if (!g) return null;
  const id = COVER_ALIASES[g[1]] ?? g[1];
  return COVER_GALLERY.find((c) => c.id === id) ?? null;
}

// Served on every host, a workspace's own domain included (middleware passes /page-covers/ through).
export const coverImageUrl = (id: string) => `/page-covers/${id}.webp`;
export const coverThumbUrl = (id: string) => `/page-covers/thumbs/${id}.webp`;

/** What a cover value draws: an image URL (null when it can't be shown). */
export function coverStyle(cover: string | null, resolve: (src: string) => string): { background?: string; image?: string } | null {
  if (!cover) return null;
  if (cover.startsWith("gallery:")) {
    const item = galleryCover(cover);
    return item ? { image: coverImageUrl(item.id) } : null;
  }
  const url = resolve(cover);
  if (!url || !/^(https?:|blob:|data:image\/)/.test(url)) return null;
  return { image: url };
}
