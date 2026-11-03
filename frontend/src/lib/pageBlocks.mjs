/**
 * Pages (documents in the block editor): the pure rules shared by the page renderer, the editor's
 * embed and mention views, and the tests (pageBlocks.test.mjs). No DOM, no React.
 *
 *   ::markdrop{src=<slug> mode=live|preview|card}   an embed block (a file or page from Markdrop)
 *   :markdrop[Title]{src=<slug>}                     a mention chip
 *   ![alt](asset:<id>)                               a page image (a per-viewer URL replaces it)
 *
 * `src` is a slug; a Markdrop link (https://markdrop.in/<slug>) is read as its slug too. An embed
 * names the slug, never a version or a blob, so replacing the file updates every page that embeds it.
 */
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { math } from "micromark-extension-math";
import { mathFromMarkdown } from "mdast-util-math";
import { directive } from "micromark-extension-directive";
import { directiveFromMarkdown } from "mdast-util-directive";

export const SLUG_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const PAGE_EMBED_MODES = ["live", "preview", "card"];
const MARKDROP_HOSTS = ["markdrop.in", "www.markdrop.in"];

/** The slug an embed or mention names: a bare slug, or a Markdrop link's one path segment. */
export function embedSlug(src, extraHosts = []) {
  if (typeof src !== "string") return null;
  const s = src.trim();
  if (!s) return null;
  if (SLUG_RE.test(s)) return s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const host = u.host.toLowerCase();
  const ok = (MARKDROP_HOSTS.includes(host) && u.protocol === "https:") || extraHosts.some((h) => String(h).toLowerCase() === host);
  if (!ok || u.username || u.password) return null;
  const segs = u.pathname.split("/").filter(Boolean);
  if (!segs.length) return null;
  let slug;
  try {
    slug = decodeURIComponent(segs[segs.length - 1]);
  } catch {
    return null;
  }
  return SLUG_RE.test(slug) ? slug : null;
}

/** An embed's display: live (default), preview (a cover until asked) or card. */
export function embedMode(v) {
  const m = typeof v === "string" ? v.trim() : "";
  return PAGE_EMBED_MODES.includes(m) ? m : "live";
}

/**
 * A web embed's frame address, for the providers pages allow (YouTube, Vimeo, Loom, Figma, Google
 * Maps, CodePen), or null. A watch / share link becomes the provider's embed link.
 */
export function webEmbedUrl(src) {
  let u;
  try {
    u = new URL(String(src ?? "").trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const h = u.hostname.replace(/^www\./, "").toLowerCase();
  const id = (re, s) => (re.exec(s) ?? [])[1] ?? null;
  if (h === "youtube.com" || h === "m.youtube.com" || h === "youtu.be" || h === "youtube-nocookie.com") {
    const v = h === "youtu.be" ? id(/^\/([\w-]{6,20})/, u.pathname) : u.pathname.startsWith("/embed/") ? id(/^\/embed\/([\w-]{6,20})/, u.pathname) : u.pathname.startsWith("/shorts/") ? id(/^\/shorts\/([\w-]{6,20})/, u.pathname) : u.searchParams.get("v");
    return v && /^[\w-]{6,20}$/.test(v) ? `https://www.youtube-nocookie.com/embed/${v}` : null;
  }
  if (h === "vimeo.com" || h === "player.vimeo.com") {
    const v = id(/(\d{5,12})/, u.pathname);
    return v ? `https://player.vimeo.com/video/${v}` : null;
  }
  if (h === "loom.com") {
    const v = id(/^\/(?:share|embed)\/([0-9a-f]{20,40})/, u.pathname);
    return v ? `https://www.loom.com/embed/${v}` : null;
  }
  if (h === "figma.com") {
    return /^\/(file|design|proto|board)\//.test(u.pathname) ? `https://www.figma.com/embed?embed_host=markdrop&url=${encodeURIComponent(u.toString())}` : null;
  }
  if ((h === "google.com" && u.pathname.startsWith("/maps/embed")) || h === "maps.google.com") {
    return u.pathname.startsWith("/maps/embed") ? u.toString() : null;
  }
  if (h === "codepen.io") {
    const m = /^\/([\w-]+)\/(?:pen|embed)\/([\w-]+)/.exec(u.pathname);
    return m ? `https://codepen.io/${m[1]}/embed/${m[2]}?default-tab=result` : null;
  }
  return null;
}

/** `asset:<id>` → id (null for any other address). */
export function assetId(src) {
  if (typeof src !== "string") return null;
  const m = /^asset:([A-Za-z0-9_-]{1,128})$/.exec(src.trim());
  return m ? m[1] : null;
}

const PARSE = {
  extensions: [gfm(), math(), directive()],
  mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown(), directiveFromMarkdown()],
};

/**
 * What a page refers to: the slugs of its embeds and mentions (in order, once each) and its page
 * images' asset ids. Code and math are not read.
 */
export function pageRefs(markdown) {
  const embeds = [];
  const mentions = [];
  const assets = [];
  let tree;
  try {
    tree = fromMarkdown(String(markdown ?? ""), PARSE);
  } catch {
    return { slugs: [], embeds, mentions, assets };
  }
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "leafDirective" && n.name === "page") {
      const s = embedSlug(n.attributes?.src);
      if (s) embeds.push(s);
    } else if (n.type === "leafDirective" && n.name === "markdrop") {
      const s = embedSlug(n.attributes?.src);
      if (s) embeds.push(s);
    } else if (n.type === "textDirective" && n.name === "markdrop") {
      const s = embedSlug(n.attributes?.src);
      if (s) mentions.push(s);
    } else if (n.type === "image") {
      const a = assetId(n.url);
      if (a) assets.push(a);
    }
    if (Array.isArray(n.children)) n.children.forEach(walk);
  };
  walk(tree);
  const uniq = (xs) => [...new Set(xs)];
  return { slugs: uniq([...embeds, ...mentions]), embeds: uniq(embeds), mentions: uniq(mentions), assets: uniq(assets) };
}

/**
 * What a reader sees where an embed or mention can't be shown. None of these name the item: a
 * locked item's title never reaches the page.
 */
export const LOCKED = {
  signin: { title: "Sign in to see this", body: "It's shared with its workspace or with people by email.", action: "signin" },
  denied: { title: "You don't have access", body: "Ask the page's author to share it with you.", action: null },
  password: { title: "Password-protected — open it", body: "It needs a password, which this page can't enter for you.", action: "open" },
  encrypted: { title: "Encrypted document", body: "Its key is only in the link its author shares, so it can't be shown here.", action: "open" },
  missing: { title: "Not available", body: "It may have been deleted, or you can't open it.", action: null },
};

/** The locked placeholder for a state (anything unknown is "missing"). */
export function lockedOf(state) {
  return LOCKED[state] ?? LOCKED.missing;
}

/** Re-resolve this long before the earliest `expires_at` (signed URLs), in ms; null when nothing expires. */
export function refreshDelay(resolved, now = Date.now(), margin = 60_000) {
  let soonest = Infinity;
  for (const r of Object.values(resolved ?? {})) {
    const t = r && typeof r.expires_at === "string" ? Date.parse(r.expires_at) : NaN;
    if (Number.isFinite(t)) soonest = Math.min(soonest, t);
  }
  if (!Number.isFinite(soonest)) return null;
  return Math.max(5_000, soonest - now - margin);
}

/** Same for page images (`{id: {url, expires_at}}`). */
export function assetRefreshDelay(assets, now = Date.now(), margin = 60_000) {
  return refreshDelay(assets, now, margin);
}

/**
 * A page's address. On markdrop.in it is `/<slug>`; on a workspace's own domain a page lives under
 * its folders and its ancestors: `/<folders…>/<parent-slug>/<child-slug>`.
 */
export function pagePath(slug, { tenant = false, folderPath = [], ancestors = [] } = {}) {
  const segs = tenant ? [...folderPath, ...ancestors, slug] : [slug];
  return `/${segs.filter(Boolean).map(encodeURIComponent).join("/")}`;
}

/** The text a template's `{{title}}` / `{{date}}` become (the API fills them; the gallery's preview too). */
export function fillTemplate(content, { title = "", date = new Date() } = {}) {
  const d = date instanceof Date ? date : new Date(date);
  const iso = Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : "";
  return String(content ?? "").replace(/\{\{\s*title\s*\}\}/g, title).replace(/\{\{\s*date\s*\}\}/g, iso);
}

/** Append Markdown to a page's Markdown (a live `appended` event): one blank line between. */
export function appendMarkdown(current, addition) {
  const a = String(current ?? "").replace(/\s+$/, "");
  const b = String(addition ?? "").replace(/^\s+/, "").replace(/\s+$/, "");
  if (!b) return String(current ?? "");
  return a ? `${a}\n\n${b}\n` : `${b}\n`;
}
