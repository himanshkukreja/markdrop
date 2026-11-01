/**
 * The editor's page checks (the Checks tab, the wavy underlines, the status bar's word count), read
 * from the page's Markdown so Visual and Markdown mode agree: links to pages that don't exist or
 * aren't live yet, images without a description, empty headings, headings that would share an
 * anchor, very long pages; and the outline (h2 / h3).
 *
 * No imports (type-only aside): the docs:test suite runs it on node's type stripping
 * (pageChecks.test.mjs).
 */
import type { RevealTarget } from "../../docs-editor/types";

export interface PageRef {
  id: string;
  path: string;
  title: string;
  /** In the live guide (false: new, never published). */
  published: boolean;
}

export interface CheckContext {
  /** This page's address (relative links resolve against it). */
  path: string;
  pages: PageRef[];
  /** Addresses the guide redirects (a link to an old address still lands somewhere). */
  redirects?: string[];
  /** First path segments the guide answers itself (/docs-assets, /api-reference…): not pages. */
  reserved?: (segment: string) => boolean;
}

export interface ScannedHeading {
  level: number;
  text: string;
  slug: string;
  /** Inside a callout, steps, tabs… (not in the outline). */
  nested: boolean;
}

export interface Scan {
  links: Array<{ href: string; text: string }>;
  images: Array<{ src: string; alt: string }>;
  headings: ScannedHeading[];
  words: number;
}

export type CheckKind = "link_missing" | "link_unpublished" | "image_alt" | "heading_empty" | "heading_duplicate" | "page_long" | "ok";

export interface Check {
  id: string;
  kind: CheckKind;
  title: string;
  note: string;
  /** Show: what to scroll to and select. */
  target?: RevealTarget;
  /** Fix: what the button does. */
  fix?: { kind: "create_page"; path: string; title: string } | { kind: "image_alt"; src: string } | { kind: "remove_empty_headings" };
}

/** Words above which a page counts as very long. */
export const LONG_PAGE_WORDS = 3500;
const WORDS_PER_MINUTE = 230;

/** github-slugger's ids, close enough to tell when two headings would share one. */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Strips inline Markdown from a heading's source: links to their text, emphasis and code marks. */
function inlinePlain(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/:kbd\[([^\]]*)\]/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/\\(.)/g, "$1")
    .trim();
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const DIRECTIVE_OPEN = /^\s*:{3,}[A-Za-z]/;
const DIRECTIVE_CLOSE = /^\s*:{3,}\s*$/;
const HEADING = /^\s{0,3}(?:>\s?)*(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const LINK = /(!?)\[((?:[^\]\\\n]|\\.)*)\]\(\s*<?([^)\s>]*)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;

/** Links, images, headings and the word count of a page body (fenced code skipped). */
export function scanPage(body: string): Scan {
  const out: Scan = { links: [], images: [], headings: [], words: 0 };
  let fence: string | null = null;
  let depth = 0;
  for (const line of body.split(/\r?\n/)) {
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[1]!;
      continue;
    }
    if (DIRECTIVE_OPEN.test(line)) {
      depth++;
      continue;
    }
    if (DIRECTIVE_CLOSE.test(line)) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const prose = line.replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
    const h = HEADING.exec(line);
    if (h) {
      const raw = (h[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").replace(/^#+$/, "");
      const custom = /\{#([^}\s]+)\}\s*$/.exec(raw);
      const text = inlinePlain(raw.replace(/\{#[^}]*\}\s*$/, ""));
      out.headings.push({ level: h[1]!.length, text, slug: custom ? custom[1]! : headingSlug(text), nested: depth > 0 });
    }
    for (const m of prose.matchAll(LINK)) {
      if (m[1]) out.images.push({ src: m[3] ?? "", alt: (m[2] ?? "").trim() });
      else out.links.push({ href: m[3] ?? "", text: inlinePlain(m[2] ?? "") });
    }
    // Words: what a reader reads (link targets, directive markers and Markdown marks left out).
    const words = line
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s*::[A-Za-z][\w-]*.*$/, "")
      .replace(/:[A-Za-z][\w-]*\[([^\]]*)\]/g, "$1")
      .replace(/\{[^}]*\}/g, " ")
      .match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
    out.words += words ? words.length : 0;
  }
  return out;
}

/** Minutes to read `words` (at least 1 once there is anything to read). */
export function readMinutes(words: number): number {
  return words ? Math.max(1, Math.round(words / WORDS_PER_MINUTE)) : 0;
}

/** The page address a link points at, or null when it isn't a page of this guide (external, asset, anchor). */
export function linkPath(href: string, from: string, reserved?: (segment: string) => boolean): string | null {
  const h = href.trim();
  if (!h || h.startsWith("#") || h.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(h)) return null;
  let path: string;
  try {
    path = new URL(h, `https://guide.invalid${from.endsWith("/") ? from : from.replace(/[^/]*$/, "")}`).pathname;
  } catch {
    return null;
  }
  try {
    path = decodeURIComponent(path);
  } catch { /* keep it as written */ }
  path = path.replace(/\.md$/i, "").replace(/\/+$/, "") || "/";
  const first = path.split("/")[1] ?? "";
  if (first && reserved?.(first)) return null;
  // A file (an image, a PDF) is not a page.
  if (/\.[a-z0-9]{2,5}$/i.test(path)) return null;
  return path;
}

/** What's wrong with a link's target, or null (fine, or not a page link). */
export function linkProblem(href: string, ctx: CheckContext): { kind: "missing" | "unpublished"; path: string; page?: PageRef; message: string } | null {
  const path = linkPath(href, ctx.path, ctx.reserved);
  if (path === null) return null;
  const page = ctx.pages.find((p) => p.path === path);
  if (!page) {
    if (ctx.redirects?.includes(path)) return null;
    return { kind: "missing", path, message: `There's no page at ${path}. Readers get "page not found".` };
  }
  if (!page.published) {
    return { kind: "unpublished", path, page, message: `"${page.title || path}" isn't live yet. Readers get "page not found" until it's published.` };
  }
  return null;
}

/** A title for a page at `path` (its last segment, in words). */
function titleFromPath(path: string): string {
  const last = path.split("/").filter(Boolean).pop() ?? "";
  const words = last.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "New page";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The Checks tab: problems first, then a "looks good" row when headings and links are fine. */
export function pageChecks(scan: Scan, ctx: CheckContext): Check[] {
  const out: Check[] = [];
  const seenLinks = new Set<string>();
  for (const l of scan.links) {
    if (seenLinks.has(l.href)) continue;
    seenLinks.add(l.href);
    const p = linkProblem(l.href, ctx);
    if (!p) continue;
    if (p.kind === "missing") {
      out.push({
        id: `missing:${l.href}`,
        kind: "link_missing",
        title: "Link to a page that doesn't exist",
        note: `"${l.text || l.href}" goes to ${p.path}, which isn't a page in this guide.`,
        target: { kind: "link", href: l.href },
        fix: { kind: "create_page", path: p.path, title: l.text ? l.text.charAt(0).toUpperCase() + l.text.slice(1) : titleFromPath(p.path) },
      });
    } else {
      out.push({
        id: `unpublished:${l.href}`,
        kind: "link_unpublished",
        title: "Link to an unpublished page",
        note: `"${p.page?.title || p.path}" is new. Publish it too, or readers get "page not found".`,
        target: { kind: "link", href: l.href },
      });
    }
  }
  const seenImages = new Set<string>();
  for (const im of scan.images) {
    if (im.alt || seenImages.has(im.src)) continue;
    seenImages.add(im.src);
    out.push({
      id: `alt:${im.src}`,
      kind: "image_alt",
      title: "Image without a description",
      note: "Used by screen readers and search engines.",
      target: { kind: "image", src: im.src },
      fix: { kind: "image_alt", src: im.src },
    });
  }
  const empty = scan.headings.filter((h) => !h.text);
  if (empty.length) {
    out.push({
      id: "headings:empty",
      kind: "heading_empty",
      title: empty.length === 1 ? "Empty heading" : `${empty.length} empty headings`,
      note: "A heading with no words shows as a blank line in the outline.",
      target: { kind: "heading", text: "", level: empty[0]!.level },
      fix: { kind: "remove_empty_headings" },
    });
  }
  const bySlug = new Map<string, ScannedHeading[]>();
  for (const h of scan.headings) {
    if (!h.text) continue;
    bySlug.set(h.slug, [...(bySlug.get(h.slug) ?? []), h]);
  }
  for (const [slug, hs] of bySlug) {
    if (hs.length < 2) continue;
    out.push({
      id: `dup:${slug}`,
      kind: "heading_duplicate",
      title: "Two headings with the same anchor",
      note: `"${hs[0]!.text}" is used ${hs.length} times. Links to #${slug} always open the first one.`,
      target: { kind: "heading", text: hs[1]!.text, nth: hs.slice(0, 1).filter((x) => x.text === hs[1]!.text).length },
    });
  }
  if (scan.words > LONG_PAGE_WORDS) {
    out.push({
      id: "long",
      kind: "page_long",
      title: `Long page (${scan.words.toLocaleString("en")} words)`,
      note: "Readers skim long pages. Consider splitting it into a few shorter ones.",
    });
  }
  const headingsOrLinks = out.some((c) => c.kind.startsWith("link") || c.kind.startsWith("heading"));
  if (!headingsOrLinks) {
    out.push({
      id: "ok",
      kind: "ok",
      title: "Headings and links look good",
      note: `${plural(scan.headings.length, "heading")}, ${plural(scan.links.length, "link")} checked.`,
    });
  }
  return out;
}

export interface OutlineItem {
  level: 2 | 3;
  text: string;
  slug: string;
  /** Which heading with this text it is (0-based), for Show. */
  nth: number;
}

/** "On this page": the h2 and h3 outside callouts, steps and tabs, as the published page lists them. */
export function outlineOf(scan: Scan): OutlineItem[] {
  const count = new Map<string, number>();
  const out: OutlineItem[] = [];
  for (const h of scan.headings) {
    const n = count.get(h.text) ?? 0;
    count.set(h.text, n + 1);
    if (h.nested || !h.text || (h.level !== 2 && h.level !== 3)) continue;
    out.push({ level: h.level as 2 | 3, text: h.text, slug: h.slug, nth: n });
  }
  return out;
}

/**
 * A link in the Preview (DraftPreview): a page of the guide (opened in the editor), an #anchor on
 * the page, a file under /docs-assets, or another site (opened in a new tab).
 */
export function previewLinkTarget(href: string): { kind: "page"; path: string; hash: string } | { kind: "hash"; hash: string } | { kind: "external" } | { kind: "asset" } {
  const h = href.trim();
  if (h.startsWith("#")) return { kind: "hash", hash: h.slice(1) };
  if (h.startsWith("/") && !h.startsWith("//")) {
    if (/^\/docs-assets\//.test(h)) return { kind: "asset" };
    const [p, hash = ""] = h.split("#");
    let path = p.split("?")[0];
    try {
      path = decodeURIComponent(path);
    } catch { /* keep it as written */ }
    return { kind: "page", path: path.replace(/\.md$/i, "").replace(/\/+$/, "") || "/", hash };
  }
  return { kind: "external" };
}
