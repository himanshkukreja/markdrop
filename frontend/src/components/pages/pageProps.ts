/**
 * A page's properties, kept in its front matter so the Markdown carries them (and AI apps can read
 * and write them):
 *
 *   ---
 *   icon: 🚀                 an emoji, or asset:<id> (an uploaded image)
 *   cover: gallery:aurora    gallery:<name>, asset:<id> or an https image
 *   cover_y: 40              the cover's focal point, 0 (top) … 100 (bottom); default 50
 *   full_width: true
 *   small_text: true
 *   font: serif              default | serif | mono
 *   locked: true             only the owner and workspace admins can edit
 *   ---
 *
 * Unknown keys are kept as written.
 */
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
  };
}

/** Built-in covers: gradients, so a page needs no upload to look finished. */
export const COVER_GALLERY: Array<{ id: string; name: string; css: string }> = [
  { id: "aurora", name: "Aurora", css: "linear-gradient(120deg, #2150d8 0%, #7c3aed 45%, #14b8a6 100%)" },
  { id: "sunset", name: "Sunset", css: "linear-gradient(120deg, #f97316 0%, #db2777 60%, #7c3aed 100%)" },
  { id: "ocean", name: "Ocean", css: "linear-gradient(135deg, #0ea5e9 0%, #2563eb 55%, #1e3a8a 100%)" },
  { id: "forest", name: "Forest", css: "linear-gradient(135deg, #22c55e 0%, #15803d 55%, #14532d 100%)" },
  { id: "peach", name: "Peach", css: "linear-gradient(120deg, #fed7aa 0%, #fda4af 55%, #f9a8d4 100%)" },
  { id: "sand", name: "Sand", css: "linear-gradient(120deg, #fef3c7 0%, #fde68a 50%, #fcd34d 100%)" },
  { id: "slate", name: "Slate", css: "linear-gradient(135deg, #475569 0%, #1e293b 100%)" },
  { id: "mint", name: "Mint", css: "linear-gradient(120deg, #a7f3d0 0%, #99f6e4 50%, #bae6fd 100%)" },
];

/** What a cover value draws: a gradient, or an image URL (null when it can't be shown). */
export function coverStyle(cover: string | null, resolve: (src: string) => string): { background?: string; image?: string } | null {
  if (!cover) return null;
  const g = /^gallery:([a-z0-9-]+)$/.exec(cover);
  if (g) {
    const item = COVER_GALLERY.find((c) => c.id === g[1]);
    return item ? { background: item.css } : null;
  }
  const url = resolve(cover);
  if (!url || !/^(https?:|blob:|data:image\/)/.test(url)) return null;
  return { image: url };
}
