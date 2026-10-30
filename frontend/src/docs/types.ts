import type { ApiOperation } from "./openapi.mjs";

export type { ApiOperation };

/**
 * The docs engine's data model. Everything site-specific lives in the content folder
 * (`site.json`, `changelog.json`, `videos.json`, `*.md`); the engine only knows these shapes, so
 * the same code can serve another site later.
 */

export interface SiteTab {
  id: string;
  label: string;
  href: string;
}

export interface NavGroupConfig {
  group: string;
  icon?: string;
  tab?: string;
  /** Marks every page in the group "New" in the left nav. */
  new?: boolean;
  pages: string[];
}

export interface LinkConfig {
  label: string;
  href: string;
}

/** A generated API reference: one page per operation of an OpenAPI description. */
export interface OpenApiConfig {
  /** OpenAPI JSON, relative to the content root. */
  spec: string;
  /** Titles, prose, groups and hidden operations (see openapi.mjs). */
  overlay?: string;
  /** The tab whose sidebar lists the generated groups. */
  tab?: string;
  /** Docs path prefix of the pages (default /api). */
  base?: string;
  /** The API's origin, for URLs and samples. */
  server?: string;
  /**
   * The vendor extension the backend export writes on each operation (auth, rate limits) and on
   * `info` (`<extension>-exported`, the export date). Default "x-docs".
   */
  extension?: string;
}

/**
 * The header logo: the built-in Markdrop mark (followed by the Markdrop wordmark), or images
 * (/docs-assets/… paths or https URLs) for the light and dark themes. `wordmark: true` means the
 * image already spells the name, so no name text is shown beside it. `tile: true` (an opaque
 * image, like a logo on a white square) sets the light image on a light tile in the dark theme
 * when there is no `dark` image.
 */
export type LogoConfig = { builtin: "markdrop" } | { light: string; dark?: string; alt?: string; wordmark?: boolean; tile?: boolean };

/** Branding. Every key is optional: absent, the site shows no logo and its own name in plain text. */
export interface BrandConfig {
  /** The product name in UI copy ("Ask a question about {name}") and beside an image logo. */
  name?: string;
  /** Text after the logo in the header (default "Docs"; "" for none). */
  label?: string;
  logo?: LogoConfig;
  /** A /docs-assets/… path or https URL ("/icon.svg" keeps the app's own). Absent, no icon. */
  favicon?: string;
  /** Accent colour (#rgb or #rrggbb) for the light theme; also dark's unless `accentDark` is set. */
  accent?: string;
  accentDark?: string;
  /** The Open Graph card: ground colour, accent (eyebrow, the mark's dot) and mark. */
  og?: { background?: string; accent?: string; mark?: "markdrop" | "none" };
}

/** Ask AI. Off unless `enabled` is true and `api` is set. */
export interface AiConfig {
  enabled?: boolean;
  /** Base URL of the Ask AI backend (it serves /api/v1/docs/ask…). */
  api?: string;
  /** The backend's key for this site (defaults to the top-level `id`). */
  site?: string;
  /** What the assistant is called in the UI (default "Ask AI"). */
  assistantName?: string;
}

/** Try it on generated API pages. */
export interface TryItConfig {
  /** Where readers create a token (the "Create a token" link). */
  tokenHelpUrl?: string;
  /** The environment variable the code samples read the token from (default API_TOKEN). */
  tokenEnv?: string;
  /** The token's fixed prefix, for placeholders and masking (like "mdk_"). */
  tokenPrefix?: string;
}

/** The docs MCP server (/mcp). */
export interface McpConfig {
  /** serverInfo.name, and the name editors install it under (default "<id>-docs", else "docs"). */
  name?: string;
  /** Examples in the tool descriptions. Absent, they come from the site's own pages. */
  examples?: { queries?: string[]; page?: string; path?: string; report?: string };
}

/** How article pages present themselves (all off by default). */
export interface PagesConfig {
  /**
   * Show the frontmatter description under the title, as a lede. Left out on a page whose first
   * paragraph already says it.
   */
  showDescription?: boolean;
  /** Show each page's frontmatter `icon` in the sidebar and beside its title. */
  icons?: boolean;
}

/** Features that only make sense for Markdrop's own docs (all off by default). */
export interface IntegrationsConfig {
  /**
   * Markdrop's app: Ask AI sends a Markdrop session token stored for the docs origin, videos.json
   * `markdrop` links are framed, Markdrop's trackers run on the docs host, Ask AI and Try it follow
   * NEXT_PUBLIC_API_URL, and the docs MCP server points readers at Markdrop's own MCP server.
   */
  markdropApp?: boolean;
}

export interface SiteConfig {
  /** Stable site id (backend key, cache tags). Default "default". */
  id?: string;
  name: string;
  description: string;
  /** Canonical origin, no trailing slash (https://docs.example.com). */
  url: string;
  product?: { name: string; url: string; openLabel?: string };
  repo?: string;
  /** Base of "Suggest an edit" links: `${edit}${path}.md`. */
  edit?: string;
  /** POST endpoint for "Did this page help?" ({path, helpful, comment?}). */
  feedback?: string;
  /** Hosts whose links `::embed` may frame. Anything else renders as a link card. */
  embedHosts?: string[];
  eyebrow?: string;
  headline?: string;
  tabs: SiteTab[];
  home?: {
    chips?: string[];
    /** "Start here" cards: a page, shown with its title and description unless overridden here. */
    start?: Array<{ page: string; icon?: string; time?: string; title?: string; description?: string }>;
    areas?: string[];
    askPlaceholder?: string;
    install?: { title: string; sync?: string; commands: Record<string, string>; note?: string; href?: string };
    ai?: { title: string; body: string; links?: LinkConfig[] };
  };
  changelog?: { title?: string; description?: string };
  footer?: LinkConfig[];
  nav: NavGroupConfig[];
  pages?: PagesConfig;
  openapi?: OpenApiConfig;
  brand?: BrandConfig;
  ai?: AiConfig;
  tryIt?: TryItConfig;
  mcp?: McpConfig;
  integrations?: IntegrationsConfig;
}

export interface Frontmatter {
  title: string;
  /** Short label for the sidebar, prev/next and breadcrumb (falls back to `title`). */
  nav?: string;
  description: string;
  updated: string;
  checked?: string;
  prerequisites?: string[];
  since?: string;
  keywords?: string[];
  /** A design-system icon name, shown in the sidebar and by the title when site.json `pages.icons` is on. */
  icon?: string;
  /**
   * Old heading ids that still land on a heading: `{ "old-id": "current-id" }` (deep links into an
   * earlier version of the docs, or into the site an importer read).
   */
  anchors?: Record<string, string>;
}

export interface Heading {
  /** DOM id (github-slugger style, no prefix). */
  id: string;
  text: string;
  depth: number;
  /** 0-based line of the heading in the body. */
  line: number;
  /** Inside a container directive (a step title, a tab): kept out of the contents rail. */
  nested?: boolean;
}

export interface Section {
  id: string;
  title: string;
  depth: number;
  /** Raw markdown of the section (directives intact), heading line included. */
  raw: string;
  /** Short content hash: drives the "changed since your last visit" dots. */
  hash: string;
}

export interface DocPage {
  /** URL path, e.g. "/workspaces/custom-domain". */
  path: string;
  /** Source file, relative to the content root. */
  file: string;
  meta: Frontmatter;
  /** Body markdown (frontmatter removed). */
  body: string;
  headings: Heading[];
  sections: Section[];
  minutes: number;
  /** Set on pages generated from the OpenAPI description. */
  api?: ApiOperation;
}

export interface NavItem {
  path: string;
  title: string;
  /** False while the page's file doesn't exist yet (writers still working). */
  available: boolean;
  isNew: boolean;
  /** HTTP method, for generated API reference pages. */
  method?: string;
  /** The page's icon, when site.json `pages.icons` is on and the page has one. */
  icon?: string;
}

export interface NavGroup {
  group: string;
  icon?: string;
  tab: string;
  items: NavItem[];
  /** Built from the OpenAPI description rather than listed in site.json. */
  generated?: boolean;
}

export type ChangeKind = "new" | "improved" | "fixed";

export interface ChangelogEntry {
  id: string;
  date: string;
  title: string;
  kind: ChangeKind;
  area: string;
  products: string[];
  versions?: Record<string, string>;
  summary: string;
  body?: string;
  media?: { video?: string; image?: string; alt?: string };
  try?: LinkConfig;
  docs?: string[];
  highlights?: string[];
}

export interface Changelog {
  products: Array<{ id: string; label: string }>;
  next: Array<{ title: string; body?: string; area?: string }>;
  entries: ChangelogEntry[];
}

/**
 * One entry of videos.json, filling a `::video{id=…}` slot. A self-hosted video (`src`, an MP4
 * under /docs-assets/videos/) plays in the docs' own player; `markdrop` (a published Markdrop link)
 * is framed instead when set, on a site with `integrations.markdropApp`. `url` is the older name of
 * `markdrop`.
 */
export interface VideoRef {
  src?: string;
  poster?: string;
  /** "0:45" */
  duration?: string;
  title?: string;
  /** WebVTT chapters, listed under the player too. */
  chapters?: string;
  /** WebVTT captions (English). */
  captions?: string;
  markdrop?: string;
  url?: string;
}

/** One row of the client-side search index. */
export interface SearchDoc {
  id: string;
  kind: "page" | "section" | "change";
  /** Heading (sections), page title (pages) or entry title (changes). */
  title: string;
  /** Where it lives: page title for sections, nav group for pages, "Changelog" for changes. */
  where: string;
  href: string;
  text: string;
  keywords?: string;
  snippet: string;
}
