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

export interface SiteConfig {
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
    start?: Array<{ page: string; icon?: string; time?: string }>;
    areas?: string[];
    askPlaceholder?: string;
    install?: { title: string; sync?: string; commands: Record<string, string>; note?: string; href?: string };
    ai?: { title: string; body: string; links?: LinkConfig[] };
  };
  changelog?: { title?: string; description?: string };
  footer?: LinkConfig[];
  nav: NavGroupConfig[];
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
}

export interface NavItem {
  path: string;
  title: string;
  /** False while the page's file doesn't exist yet (writers still working). */
  available: boolean;
  isNew: boolean;
}

export interface NavGroup {
  group: string;
  icon?: string;
  tab: string;
  items: NavItem[];
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

export interface VideoRef {
  url: string;
  poster?: string;
  duration?: string;
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
