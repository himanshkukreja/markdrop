/**
 * Content loader (server only: reads the content folder from disk at build time).
 *
 * Root: `content/docs/` under the frontend (override with DOCS_CONTENT_DIR). One page per
 * `<section>/<page>.md`; `index.md` at the root is the home's Markdown twin; `site.json`,
 * `changelog.json` and `videos.json` configure the site. Nothing here throws on bad content: a
 * page that is listed but missing is shown greyed (dev) or left out (production) and skipped by
 * the build; malformed JSON reads as empty. `npm run docs:check` reports all of it.
 */
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter";
import { introOf, plainText, readingMinutes, scanHeadings, snippet, splitSections, toPlainMarkdown } from "./markdown";
import { buildApiReference, type ApiReference } from "./openapi.mjs";
import { clipVariants, formatDuration, type MediaManifest } from "./media";
import type { Changelog, ChangelogEntry, DocPage, NavGroup, SiteConfig, VideoRef } from "./types";

export const CONTENT_DIR = process.env.DOCS_CONTENT_DIR || path.join(process.cwd(), "content", "docs");
/** Folders under the content root that never hold pages. */
const SKIP_DIRS = new Set(["video-scenes", "node_modules"]);
const DEV = process.env.NODE_ENV === "development";

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, file), "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Memoised for the build; in `next dev` kept for a second, so edits show on the next refresh. */
function memo<T>(fn: () => T): () => T {
  let v: { value: T; at: number } | null = null;
  return () => {
    if (!v || (DEV && Date.now() - v.at > 1000)) v = { value: fn(), at: Date.now() };
    return v.value;
  };
}

export const getSite = memo((): SiteConfig => {
  const s = readJson<Partial<SiteConfig>>("site.json", {});
  return {
    ...s,
    name: s.name || "Docs",
    description: s.description || "",
    url: (s.url || "http://localhost").replace(/\/+$/, ""),
    tabs: Array.isArray(s.tabs) ? s.tabs : [],
    nav: Array.isArray(s.nav) ? s.nav.filter((g) => g && Array.isArray(g.pages)) : [],
  } as SiteConfig;
});

function walk(dir: string, rel = ""): string[] {
  let out: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name.startsWith("_")) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out = out.concat(walk(path.join(dir, e.name), r));
    } else if (e.name.endsWith(".md") && r !== "index.md") out.push(r);
  }
  return out;
}

export function fileToPath(file: string): string {
  return "/" + file.replace(/\.md$/, "").replace(/\/index$/, "");
}

function loadPage(file: string): DocPage {
  const src = fs.readFileSync(path.join(CONTENT_DIR, file), "utf8");
  const { data, body } = parseFrontmatter(src);
  const headings = scanHeadings(body);
  const p = fileToPath(file);
  return {
    path: p,
    file,
    meta: {
      title: data.title || p.split("/").pop()!.replace(/-/g, " "),
      nav: data.nav,
      description: data.description || snippet(plainText(introOf(body, headings), { code: false }), 160),
      updated: data.updated || "",
      checked: data.checked,
      prerequisites: data.prerequisites,
      since: data.since,
      keywords: data.keywords,
    },
    body,
    headings,
    sections: splitSections(body, headings),
    minutes: readingMinutes(body),
  };
}

/**
 * The API reference generated from site.json `openapi` (openapi.mjs), or null without one. Its
 * pages join the written ones below; its groups join the nav after the tab's written groups.
 */
export const getApiReference = memo((): (ApiReference & { updated: string }) | null => {
  const cfg = getSite().openapi;
  if (!cfg?.spec) return null;
  const spec = readJson<Record<string, unknown> | null>(cfg.spec, null);
  if (!spec) return null;
  const overlay = cfg.overlay ? readJson<Record<string, unknown>>(cfg.overlay, {}) : {};
  try {
    const ref = buildApiReference(spec, overlay, { server: cfg.server, base: cfg.base });
    const info = (spec.info ?? {}) as Record<string, unknown>;
    return { ...ref, updated: typeof info["x-markdrop-exported"] === "string" ? (info["x-markdrop-exported"] as string) : "" };
  } catch (e) {
    console.warn(`[docs] API reference skipped: ${(e as Error).message}`);
    return null;
  }
});

function apiPages(): DocPage[] {
  const ref = getApiReference();
  if (!ref) return [];
  return ref.ops.map((op) => {
    const headings = scanHeadings(op.markdown);
    return {
      path: op.path,
      file: getSite().openapi!.spec,
      meta: { title: op.title, description: op.summary, updated: ref.updated, keywords: op.keywords },
      body: op.markdown,
      headings,
      sections: splitSections(op.markdown, headings),
      minutes: readingMinutes(op.markdown),
      api: op,
    };
  });
}

const pagesByPath = memo((): Map<string, DocPage> => {
  const map = new Map<string, DocPage>();
  for (const file of walk(CONTENT_DIR).sort()) {
    try {
      const page = loadPage(file);
      map.set(page.path, page);
    } catch (e) {
      console.warn(`[docs] skipped ${file}: ${(e as Error).message}`);
    }
  }
  // A written page at the same address wins over a generated one.
  for (const page of apiPages()) if (!map.has(page.path)) map.set(page.path, page);
  return map;
});

export function getAllPages(): DocPage[] {
  return [...pagesByPath().values()];
}

/** The short label (frontmatter `nav`) used by the sidebar, prev/next and breadcrumb. */
export function navLabel(page: DocPage): string {
  return page.meta.nav || page.meta.title;
}

export function getPage(p: string): DocPage | undefined {
  return pagesByPath().get(p);
}

/** The home's Markdown twin (`index.md`), for agents. */
export const getHome = memo((): { meta: DocPage["meta"]; body: string } | null => {
  try {
    const src = fs.readFileSync(path.join(CONTENT_DIR, "index.md"), "utf8");
    const { data, body } = parseFrontmatter(src);
    const site = getSite();
    return {
      meta: { title: data.title || site.name, description: data.description || site.description, updated: data.updated || "" },
      body,
    };
  } catch {
    return null;
  }
});

/** Nav groups from site.json. Missing pages: greyed in dev, left out in production builds. */
export const getNav = memo((): NavGroup[] => {
  const site = getSite();
  const fallbackTab = site.tabs[0]?.id ?? "guides";
  const written: NavGroup[] = site.nav
    .map((g) => ({
      group: g.group,
      icon: g.icon,
      tab: g.tab || fallbackTab,
      items: g.pages
        .map((p) => {
          const page = getPage(p);
          return { path: p, title: page ? navLabel(page) : p.split("/").pop()!.replace(/-/g, " "), available: !!page, isNew: !!g.new };
        })
        .filter((it) => it.available || DEV),
    }))
    .filter((g) => g.items.length > 0);
  const ref = getApiReference();
  if (!ref) return written;
  const tab = site.openapi?.tab ?? "api";
  const listed = new Set(written.flatMap((g) => g.items.map((it) => it.path)));
  const generated: NavGroup[] = ref.groups
    .map((g) => ({
      group: g.title,
      tab,
      generated: true,
      items: g.ops
        .filter((op) => !listed.has(op.path))
        .map((op) => ({ path: op.path, title: op.title, available: true, isNew: false, method: op.method })),
    }))
    .filter((g) => g.items.length > 0);
  // After the tab's last written group (its overview), else at the end.
  let at = -1;
  written.forEach((g, i) => {
    if (g.tab === tab) at = i;
  });
  return at < 0 ? [...written, ...generated] : [...written.slice(0, at + 1), ...generated, ...written.slice(at + 1)];
});

export function groupOf(p: string): NavGroup | undefined {
  return getNav().find((g) => g.items.some((it) => it.path === p));
}

/** Pages in reading order (nav order, available only), then any page not in the nav. */
export function orderedPages(): DocPage[] {
  const seen = new Set<string>();
  const out: DocPage[] = [];
  for (const g of getNav())
    for (const it of g.items) {
      const page = getPage(it.path);
      if (page && !seen.has(page.path)) {
        seen.add(page.path);
        out.push(page);
      }
    }
  for (const page of getAllPages()) if (!seen.has(page.path)) out.push(page);
  return out;
}

export function prevNext(p: string): { prev?: DocPage; next?: DocPage } {
  const list = orderedPages().filter((pg) => groupOf(pg.path));
  const i = list.findIndex((pg) => pg.path === p);
  if (i < 0) return {};
  return { prev: list[i - 1], next: list[i + 1] };
}

export const getVideos = memo((): Record<string, VideoRef> => readJson<Record<string, VideoRef>>("videos.json", {}));

/** media.json: sizes, bytes and kinds of everything under public/docs-assets (see media.ts). */
export const getMedia = memo((): MediaManifest => {
  const m = readJson<MediaManifest>("media.json", {});
  return m && typeof m === "object" && !Array.isArray(m) ? m : {};
});

const KINDS = new Set(["new", "improved", "fixed"]);
export const getChangelog = memo((): Changelog => {
  const raw = readJson<Partial<Changelog>>("changelog.json", {});
  const entries = (Array.isArray(raw.entries) ? raw.entries : [])
    .filter((e): e is ChangelogEntry => !!e && typeof e.id === "string" && typeof e.title === "string" && typeof e.date === "string")
    .map((e) => ({
      ...e,
      kind: (KINDS.has(e.kind) ? e.kind : "improved") as ChangelogEntry["kind"],
      area: e.area || "General",
      products: Array.isArray(e.products) ? e.products : [],
      summary: e.summary || "",
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return {
    products: Array.isArray(raw.products) ? raw.products : [],
    next: Array.isArray(raw.next) ? raw.next : [],
    entries,
  };
});

/* ── Markdown for agents ─────────────────────────────────────────────────── */

export function absoluteUrl(p: string): string {
  return getSite().url + (p === "/" ? "" : p);
}

export function mdUrl(p: string): string {
  return getSite().url + (p === "/" ? "/index" : p) + ".md";
}

function yamlList(xs: string[]): string {
  return `[${xs.join(", ")}]`;
}

/** Where a filled `::video` slot points agents: the Markdrop link, else the MP4 itself. */
function videoResolver(id: string): { url: string; duration?: string } | undefined {
  const v = getVideos()[id];
  const link = v?.markdrop || v?.url || (v?.src?.startsWith("/") ? getSite().url + v.src : undefined);
  return link ? { url: link, duration: v?.duration } : undefined;
}

/** A `::clip` for agents: its MP4 (absolute) and length from the manifest. */
function clipResolver(src: string): { url: string; duration?: string } {
  const c = clipVariants(getMedia(), src);
  const file = c.light.mp4 ?? c.light.webm ?? `${src}.mp4`;
  return { url: getSite().url + file, duration: formatDuration(c.duration) };
}

const resolvers = { video: videoResolver, clip: clipResolver };

/** The page as served at `<path>.md`: frontmatter for agents, the title, then plain Markdown. */
export function agentMarkdown(page: DocPage): string {
  const site = getSite();
  const fm = [
    "---",
    `title: ${JSON.stringify(page.meta.title)}`,
    `description: ${JSON.stringify(page.meta.description)}`,
    `canonical_url: ${absoluteUrl(page.path)}`,
    page.meta.updated && `last_updated: ${page.meta.updated}`,
    page.meta.checked && `checked: ${page.meta.checked}`,
    page.meta.since && `since: ${JSON.stringify(page.meta.since)}`,
    page.meta.prerequisites?.length && `prerequisites: ${yamlList(page.meta.prerequisites)}`,
    `site: ${JSON.stringify(site.name)}`,
    `index: ${site.url}/llms.txt`,
    "---",
  ].filter(Boolean);
  return `${fm.join("\n")}\n\n# ${page.meta.title}\n\n${toPlainMarkdown(page.body, { base: site.url, ...resolvers })}\n`;
}

/** One section (h2/h3) as plain Markdown, for "Copy section". */
export function sectionMarkdown(page: DocPage, raw: string): string {
  const site = getSite();
  return `${toPlainMarkdown(raw, { base: site.url, ...resolvers })}\n\nSource: ${absoluteUrl(page.path)}\n`;
}

/** The page plus the pages it lists as prerequisites (each once, prerequisites first). */
export function withPrerequisites(page: DocPage): { markdown: string; count: number } {
  const pre = (page.meta.prerequisites ?? []).map((p) => getPage(p)).filter((p): p is DocPage => !!p);
  const parts = [...pre.map((p) => agentMarkdown(p)), agentMarkdown(page)];
  return { markdown: parts.join("\n\n"), count: pre.length };
}

export function homeMarkdown(): string {
  const site = getSite();
  const home = getHome();
  const head = `---\ntitle: ${JSON.stringify(home?.meta.title || site.name)}\ncanonical_url: ${site.url}/\nindex: ${site.url}/llms.txt\n---\n\n`;
  if (home) return `${head}# ${home.meta.title}\n\n${toPlainMarkdown(home.body, { base: site.url, ...resolvers })}\n`;
  return `${head}# ${site.name}\n\n> ${site.description}\n\nSee ${site.url}/llms.txt for every page.\n`;
}

export function plainOf(md: string, base?: string): string {
  return toPlainMarkdown(md, { base, ...resolvers });
}
