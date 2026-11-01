/**
 * A guide's Settings, one focused page per section (/guides/<site>/settings/<section>):
 *
 *   general        name, address, logo, where it started, GitHub (a summary)
 *   domains        the free address and your own domains (…/domains/new, …/domains/<host>: setup)
 *   access         who can read it, search indexing
 *   ask-ai         on/off, usage, name, suggested questions
 *   api-reference  the OpenAPI file and how the reference appears
 *   github         the repository it's imported from and kept in sync with, sync history
 *   redirects      old addresses → their pages
 *   people         roles on this guide, required reviews
 *   danger         unpublish, delete
 *
 * The old one-page Settings used #anchors (/settings#people, #redirects, #review…), which Publishes,
 * Members and shared links still use: /settings reads the hash and goes to the section (ANCHORS).
 */
export type SettingsSection = "general" | "domains" | "access" | "ask-ai" | "api-reference" | "github" | "redirects" | "people" | "danger";

export const SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string; icon: string; blurb: string }> = [
  { id: "general", label: "General", icon: "settings", blurb: "The guide's name, its address and where it started." },
  { id: "domains", label: "Domains", icon: "globe", blurb: "Where readers find your guide. Old links keep working when you change it." },
  { id: "access", label: "Readers and access", icon: "lock", blurb: "Who can read the guide, and whether search engines list it." },
  { id: "ask-ai", label: "Ask AI", icon: "zap", blurb: "Readers ask questions and get answers from your pages, with a link to the exact section." },
  { id: "api-reference", label: "API reference", icon: "code", blurb: "Bring your OpenAPI file. Readers get a page for every endpoint, code samples, and Try it against your real API." },
  { id: "github", label: "GitHub", icon: "github", blurb: "Import a repository's docs and keep them in sync: each push to the branch updates the guide." },
  { id: "redirects", label: "Redirects", icon: "link", blurb: "Old addresses that send readers to the right page. Moving a page adds one for you." },
  { id: "people", label: "People and reviews", icon: "user", blurb: "Who can write, review and publish this guide." },
  { id: "danger", label: "Take it down", icon: "trash", blurb: "Unpublish the guide, or delete it for good." },
];

export const isSection = (s: string | undefined | null): s is SettingsSection => SECTIONS.some((x) => x.id === s);
/** A section's one-line description (its header and the Settings index). */
export const blurbOf = (id: SettingsSection): string => SECTIONS.find((x) => x.id === id)?.blurb ?? "";

/** The old page's #anchors → the section that has that card now. */
export const ANCHORS: Record<string, SettingsSection> = {
  general: "general",
  name: "general",
  address: "general",
  github: "github",
  sync: "github",
  import: "general",
  source: "general",
  domain: "domains",
  domains: "domains",
  access: "access",
  seo: "access",
  ai: "ask-ai",
  "ask-ai": "ask-ai",
  "api-reference": "api-reference",
  api: "api-reference",
  redirects: "redirects",
  people: "people",
  review: "people",
  reviews: "people",
  danger: "danger",
};

/** /guides/<site>/settings/<section> */
export const settingsHref = (base: string, section: SettingsSection = "general") => `${base}/settings/${section}`;
/** A domain's setup and status page. */
export const domainHref = (base: string, host: string) => `${base}/settings/domains/${encodeURIComponent(host)}`;
