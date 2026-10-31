/**
 * Content loader (server only: reads a content folder from disk at build time).
 *
 * A site is one content folder: one page per `<section>/<page>.md`; `index.md` at the root is the
 * home's Markdown twin; `site.json`, `changelog.json` and `videos.json` configure the site.
 * `loadSite(dir)` returns that folder's SiteBundle (kept in a small LRU keyed by folder), so the
 * engine can serve more than one site. The zero-argument getters below (getSite, getPage, getNav…)
 * read the default site: `content/docs/` under the frontend, or DOCS_CONTENT_DIR.
 *
 * Nothing here throws on bad content: a page that is listed but missing is shown greyed (dev) or
 * left out (production) and skipped by the build; malformed JSON reads as empty. `npm run
 * docs:check` reports all of it.
 */
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter";
import { introOf, plainText, readingMinutes, scanHeadings, snippet, splitSections, toPlainMarkdown } from "./markdown";
import { buildApiReference, type ApiReference } from "./openapi.mjs";
import { clipVariants, formatDuration, type MediaManifest } from "./media";
import { videoLink } from "./brand";
import type { Changelog, ChangelogEntry, DocPage, NavGroup, SiteConfig, VideoRef } from "./types";

export const CONTENT_DIR = process.env.DOCS_CONTENT_DIR || path.join(process.cwd(), "content", "docs");
/** Folders under the content root that never hold pages. */
const SKIP_DIRS = new Set(["video-scenes", "node_modules"]);
const DEV = process.env.NODE_ENV === "development";
/** How many sites stay loaded at once. */
const MAX_SITES = 16;

/** Memoised for the build; in `next dev` kept for a second, so edits show on the next refresh. */
function memo<T>(fn: () => T): () => T {
  let v: { value: T; at: number } | null = null;
  return () => {
    if (!v || (DEV && Date.now() - v.at > 1000)) v = { value: fn(), at: Date.now() };
    return v.value;
  };
}

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

/** The short label (frontmatter `nav`) used by the sidebar, prev/next and breadcrumb. */
export function navLabel(page: DocPage): string {
  return page.meta.nav || page.meta.title;
}

function yamlList(xs: string[]): string {
  return `[${xs.join(", ")}]`;
}

const KINDS = new Set(["new", "improved", "fixed"]);

export type HomeDoc = { meta: DocPage["meta"]; body: string };
export type ApiReferenceWithDate = ApiReference & { updated: string };

/**
 * Everything one content folder holds, read lazily and memoised: the settings, the pages (written
 * and generated from OpenAPI), the nav, the changelog, the videos and the media manifest, plus
 * the Markdown outputs built from them.
 */
export class SiteBundle {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private readJson<T>(file: string, fallback: T): T {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  private readonly siteMemo = memo((): SiteConfig => {
    const s = this.readJson<Partial<SiteConfig>>("site.json", {});
    const tabs = Array.isArray(s.tabs) ? s.tabs : [];
    return {
      ...s,
      name: s.name || "Docs",
      description: s.description || "",
      url: (s.url || "http://localhost").replace(/\/+$/, ""),
      // A site with no changelog entries has no /changelog (see hasChangelog), so no tab to it either.
      tabs: this.hasChangelog ? tabs : tabs.filter((t) => t?.href !== "/changelog"),
      nav: Array.isArray(s.nav) ? s.nav.filter((g) => g && Array.isArray(g.pages)) : [],
    } as SiteConfig;
  });
  get site(): SiteConfig {
    return this.siteMemo();
  }

  private loadPage(file: string): DocPage {
    const src = fs.readFileSync(path.join(this.dir, file), "utf8");
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
        ...(data.icon ? { icon: data.icon } : {}),
        ...(data.anchors ? { anchors: data.anchors } : {}),
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
  private readonly apiMemo = memo((): ApiReferenceWithDate | null => {
    const site = this.site;
    const cfg = site.openapi;
    if (!cfg?.spec) return null;
    const spec = this.readJson<Record<string, unknown> | null>(cfg.spec, null);
    if (!spec) return null;
    const overlay = cfg.overlay ? this.readJson<Record<string, unknown>>(cfg.overlay, {}) : {};
    const extension = cfg.extension || "x-docs";
    try {
      const ref = buildApiReference(spec, overlay, {
        server: cfg.server,
        base: cfg.base,
        extension,
        tokenEnv: site.tryIt?.tokenEnv,
        tokenPrefix: site.tryIt?.tokenPrefix,
        sessionHost: hostOf(site.product?.url),
        ...(cfg.auto ? { auto: true, title: cfg.label } : {}),
      });
      const info = (spec.info ?? {}) as Record<string, unknown>;
      const exported = info[`${extension}-exported`];
      return { ...ref, updated: typeof exported === "string" ? exported : cfg.updated || "" };
    } catch (e) {
      console.warn(`[docs] API reference skipped: ${(e as Error).message}`);
      return null;
    }
  });
  get apiReference(): ApiReferenceWithDate | null {
    return this.apiMemo();
  }

  /** Where the generated overview page lives (auto mode: the reference's base path), if anywhere. */
  private get apiOverviewPath(): string | null {
    const ref = this.apiReference;
    return ref?.overview ? (this.site.openapi?.base || "/api").replace(/\/+$/, "") || null : null;
  }

  private apiPages(): DocPage[] {
    const ref = this.apiReference;
    if (!ref) return [];
    const overview: DocPage[] = [];
    const at = this.apiOverviewPath;
    if (ref.overview && at) {
      const md = ref.overview.markdown;
      const headings = scanHeadings(md);
      overview.push({
        path: at,
        file: this.site.openapi!.spec,
        meta: { title: ref.overview.title, nav: "Overview", description: ref.overview.description, updated: ref.updated },
        body: md,
        headings,
        sections: splitSections(md, headings),
        minutes: readingMinutes(md),
      });
    }
    return overview.concat(ref.ops.map((op) => {
      const headings = scanHeadings(op.markdown);
      return {
        path: op.path,
        file: this.site.openapi!.spec,
        meta: { title: op.title, description: op.summary, updated: ref.updated, keywords: op.keywords },
        body: op.markdown,
        headings,
        sections: splitSections(op.markdown, headings),
        minutes: readingMinutes(op.markdown),
        api: op,
      };
    }));
  }

  private readonly pagesMemo = memo((): Map<string, DocPage> => {
    const map = new Map<string, DocPage>();
    for (const file of walk(this.dir).sort()) {
      try {
        const page = this.loadPage(file);
        map.set(page.path, page);
      } catch (e) {
        console.warn(`[docs] skipped ${file}: ${(e as Error).message}`);
      }
    }
    // A written page at the same address wins over a generated one.
    for (const page of this.apiPages()) if (!map.has(page.path)) map.set(page.path, page);
    return map;
  });
  /** Every page by path, written and generated. */
  get pages(): Map<string, DocPage> {
    return this.pagesMemo();
  }

  allPages(): DocPage[] {
    return [...this.pages.values()];
  }

  page(p: string): DocPage | undefined {
    return this.pages.get(p);
  }

  /** The home's Markdown twin (`index.md`), for agents. */
  private readonly homeMemo = memo((): HomeDoc | null => {
    try {
      const src = fs.readFileSync(path.join(this.dir, "index.md"), "utf8");
      const { data, body } = parseFrontmatter(src);
      const site = this.site;
      return {
        meta: { title: data.title || site.name, description: data.description || site.description, updated: data.updated || "" },
        body,
      };
    } catch {
      return null;
    }
  });
  get home(): HomeDoc | null {
    return this.homeMemo();
  }

  /** Nav groups from site.json. Missing pages: greyed in dev, left out in production builds. */
  private readonly navMemo = memo((): NavGroup[] => {
    const site = this.site;
    const fallbackTab = site.tabs[0]?.id ?? "guides";
    const icons = site.pages?.icons === true;
    const written: NavGroup[] = site.nav
      .map((g) => ({
        group: g.group,
        icon: g.icon,
        tab: g.tab || fallbackTab,
        items: g.pages
          .map((p) => {
            const page = this.page(p);
            const icon = icons ? page?.meta.icon : undefined;
            return { path: p, title: page ? navLabel(page) : p.split("/").pop()!.replace(/-/g, " "), available: !!page, isNew: !!g.new, ...(icon ? { icon } : {}) };
          })
          .filter((it) => it.available || DEV),
      }))
      .filter((g) => g.items.length > 0);
    const ref = this.apiReference;
    if (!ref) return written;
    const tab = site.openapi?.tab ?? "api";
    const listed = new Set(written.flatMap((g) => g.items.map((it) => it.path)));
    // Auto mode: the overview leads, in a group named after the reference ("API reference").
    const overviewAt = this.apiOverviewPath;
    const lead: NavGroup[] =
      ref.overview && overviewAt && !listed.has(overviewAt) && this.page(overviewAt) && !this.page(overviewAt)!.file.endsWith(".md")
        ? [{ group: site.openapi?.label || "API reference", tab, generated: true, items: [{ path: overviewAt, title: "Overview", available: true, isNew: false }] }]
        : [];
    const generated: NavGroup[] = lead.concat(ref.groups
      .map((g) => ({
        group: g.title,
        tab,
        generated: true,
        items: g.ops
          .filter((op) => !listed.has(op.path))
          .map((op) => ({ path: op.path, title: op.title, available: true, isNew: false, method: op.method })),
      }))
      .filter((g) => g.items.length > 0));
    // After the tab's last written group (its overview), else at the end.
    let at = -1;
    written.forEach((g, i) => {
      if (g.tab === tab) at = i;
    });
    return at < 0 ? [...written, ...generated] : [...written.slice(0, at + 1), ...generated, ...written.slice(at + 1)];
  });
  get nav(): NavGroup[] {
    return this.navMemo();
  }

  groupOf(p: string): NavGroup | undefined {
    return this.nav.find((g) => g.items.some((it) => it.path === p));
  }

  /** Pages in reading order (nav order, available only), then any page not in the nav. */
  orderedPages(): DocPage[] {
    const seen = new Set<string>();
    const out: DocPage[] = [];
    for (const g of this.nav)
      for (const it of g.items) {
        const page = this.page(it.path);
        if (page && !seen.has(page.path)) {
          seen.add(page.path);
          out.push(page);
        }
      }
    for (const page of this.allPages()) if (!seen.has(page.path)) out.push(page);
    return out;
  }

  prevNext(p: string): { prev?: DocPage; next?: DocPage } {
    const list = this.orderedPages().filter((pg) => this.groupOf(pg.path));
    const i = list.findIndex((pg) => pg.path === p);
    if (i < 0) return {};
    return { prev: list[i - 1], next: list[i + 1] };
  }

  private readonly videosMemo = memo((): Record<string, VideoRef> => this.readJson<Record<string, VideoRef>>("videos.json", {}));
  get videos(): Record<string, VideoRef> {
    return this.videosMemo();
  }

  /** media.json: sizes, bytes and kinds of everything under public/docs-assets (see media.ts). */
  private readonly mediaMemo = memo((): MediaManifest => {
    const m = this.readJson<MediaManifest>("media.json", {});
    return m && typeof m === "object" && !Array.isArray(m) ? m : {};
  });
  get media(): MediaManifest {
    return this.mediaMemo();
  }

  private readonly changelogMemo = memo((): Changelog => {
    const raw = this.readJson<Partial<Changelog>>("changelog.json", {});
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
  get changelog(): Changelog {
    return this.changelogMemo();
  }
  /**
   * Whether the site has a changelog: at least one entry in changelog.json. Without one (every Docs
   * Studio site today: the studio has no changelog editor) /changelog and its feeds answer 404 and
   * nothing links to them (header tab, 404 page, sitemap, llms.txt, skill.md, RSS alternate).
   */
  get hasChangelog(): boolean {
    return this.changelog.entries.length > 0;
  }

  /* ── Markdown for agents ─────────────────────────────────────────────── */

  absoluteUrl(p: string): string {
    return this.site.url + (p === "/" ? "" : p);
  }

  mdUrl(p: string): string {
    return this.site.url + (p === "/" ? "/index" : p) + ".md";
  }

  /** Where a filled `::video` slot points agents: the Markdrop link, else the MP4 itself. */
  private videoResolver = (id: string): { url: string; duration?: string } | undefined => {
    const site = this.site;
    const v = this.videos[id];
    const link = videoLink(v, site) || (v?.src?.startsWith("/") ? site.url + v.src : undefined);
    return link ? { url: link, duration: v?.duration } : undefined;
  };

  /** A `::clip` for agents: its MP4 (absolute) and length from the manifest. */
  private clipResolver = (src: string): { url: string; duration?: string } => {
    const c = clipVariants(this.media, src);
    const file = c.light.mp4 ?? c.light.webm ?? `${src}.mp4`;
    return { url: this.site.url + file, duration: formatDuration(c.duration) };
  };

  private get resolvers() {
    return { video: this.videoResolver, clip: this.clipResolver };
  }

  /** The page as served at `<path>.md`: frontmatter for agents, the title, then plain Markdown. */
  agentMarkdown(page: DocPage): string {
    const site = this.site;
    const fm = [
      "---",
      `title: ${JSON.stringify(page.meta.title)}`,
      `description: ${JSON.stringify(page.meta.description)}`,
      `canonical_url: ${this.absoluteUrl(page.path)}`,
      page.meta.updated && `last_updated: ${page.meta.updated}`,
      page.meta.checked && `checked: ${page.meta.checked}`,
      page.meta.since && `since: ${JSON.stringify(page.meta.since)}`,
      page.meta.prerequisites?.length && `prerequisites: ${yamlList(page.meta.prerequisites)}`,
      `site: ${JSON.stringify(site.name)}`,
      `index: ${site.url}/llms.txt`,
      "---",
    ].filter(Boolean);
    return `${fm.join("\n")}\n\n# ${page.meta.title}\n\n${toPlainMarkdown(page.body, { base: site.url, ...this.resolvers })}\n`;
  }

  /** One section (h2/h3) as plain Markdown, for "Copy section". */
  sectionMarkdown(page: DocPage, raw: string): string {
    return `${toPlainMarkdown(raw, { base: this.site.url, ...this.resolvers })}\n\nSource: ${this.absoluteUrl(page.path)}\n`;
  }

  /** The page plus the pages it lists as prerequisites (each once, prerequisites first). */
  withPrerequisites(page: DocPage): { markdown: string; count: number } {
    const pre = (page.meta.prerequisites ?? []).map((p) => this.page(p)).filter((p): p is DocPage => !!p);
    const parts = [...pre.map((p) => this.agentMarkdown(p)), this.agentMarkdown(page)];
    return { markdown: parts.join("\n\n"), count: pre.length };
  }

  homeMarkdown(): string {
    const site = this.site;
    const home = this.home;
    const head = `---\ntitle: ${JSON.stringify(home?.meta.title || site.name)}\ncanonical_url: ${site.url}/\nindex: ${site.url}/llms.txt\n---\n\n`;
    if (home) return `${head}# ${home.meta.title}\n\n${toPlainMarkdown(home.body, { base: site.url, ...this.resolvers })}\n`;
    return `${head}# ${site.name}\n\n> ${site.description}\n\nSee ${site.url}/llms.txt for every page.\n`;
  }

  plainOf(md: string, base?: string): string {
    return toPlainMarkdown(md, { base, ...this.resolvers });
  }
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/* ── sites ───────────────────────────────────────────────────────────────── */

const sites = new Map<string, SiteBundle>();

/** The site whose content is in `dir` (an LRU of the last few, keyed by the resolved folder). */
export function loadSite(dir: string = CONTENT_DIR): SiteBundle {
  const key = path.resolve(dir);
  let s = sites.get(key);
  if (s) {
    sites.delete(key);
  } else {
    s = new SiteBundle(key);
    if (sites.size >= MAX_SITES) sites.delete(sites.keys().next().value!);
  }
  sites.set(key, s);
  return s;
}

/** The default site (content/docs, or DOCS_CONTENT_DIR): what the getters below read. */
export function defaultSite(): SiteBundle {
  return loadSite(CONTENT_DIR);
}

/* ── the default site, for callers that serve one ────────────────────────── */

export const getSite = (): SiteConfig => defaultSite().site;
export const getApiReference = (): ApiReferenceWithDate | null => defaultSite().apiReference;
export const getAllPages = (): DocPage[] => defaultSite().allPages();
export const getPage = (p: string): DocPage | undefined => defaultSite().page(p);
export const getHome = (): HomeDoc | null => defaultSite().home;
export const getNav = (): NavGroup[] => defaultSite().nav;
export const groupOf = (p: string): NavGroup | undefined => defaultSite().groupOf(p);
export const orderedPages = (): DocPage[] => defaultSite().orderedPages();
export const prevNext = (p: string) => defaultSite().prevNext(p);
export const getVideos = (): Record<string, VideoRef> => defaultSite().videos;
export const getMedia = (): MediaManifest => defaultSite().media;
export const getChangelog = (): Changelog => defaultSite().changelog;
export const hasChangelog = (): boolean => defaultSite().hasChangelog;
/**
 * Whether search engines may index the site: site.json `seo.index` (default true). False: pages
 * carry `<meta name="robots" content="noindex">`, robots.txt disallows everything, the sitemap is
 * empty, and the edge adds `X-Robots-Tag: noindex` (docs-platform builder/build.mjs manifestSite).
 */
export const indexable = (site: SiteConfig): boolean => site.seo?.index !== false;
export const absoluteUrl = (p: string): string => defaultSite().absoluteUrl(p);
export const mdUrl = (p: string): string => defaultSite().mdUrl(p);
export const agentMarkdown = (page: DocPage): string => defaultSite().agentMarkdown(page);
export const sectionMarkdown = (page: DocPage, raw: string): string => defaultSite().sectionMarkdown(page, raw);
export const withPrerequisites = (page: DocPage) => defaultSite().withPrerequisites(page);
export const homeMarkdown = (): string => defaultSite().homeMarkdown();
export const plainOf = (md: string, base?: string): string => defaultSite().plainOf(md, base);
