/**
 * The name a new guide imported from GitHub is given until the person types their own (NewSite.tsx):
 * the name the docs give themselves (the preview's `site_name`: Mintlify docs.json `name`, MkDocs
 * `site_name`, Docusaurus `title`, GitBook book.json `title`), else one made from the repository's.
 * No imports, so node's type stripping can test it (guideName.test.mjs).
 */

/** Repository names that say nothing about the product ("docs") → the owner's name instead. */
const GENERIC_REPOS = new Set(["docs", "doc", "documentation", "website", "site", "guides", "guide", "help", "handbook", "manual", "wiki"]);
const titleCase = (s: string) => s.replace(/[-_.]+/g, " ").trim().replace(/\s+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** A guide name for a repository: "acme/docs" → "Acme Docs", "acme/widget-docs" → "Widget Docs". */
export function nameFromRepo(owner: string, name: string): string {
  const base = name.toLowerCase().replace(/\.git$/, "");
  if (GENERIC_REPOS.has(base)) return `${titleCase(owner)} Docs`.slice(0, 80);
  const t = titleCase(base);
  return (/\b(docs?|documentation|guides?|help|handbook)\b/i.test(t) ? t : `${t} Docs`).slice(0, 80);
}

/** The config's own name when it has one ("Acme Rockets"), else the repository's. */
export function suggestGuideName(repo: { owner: string; name: string }, siteName?: string | null): string {
  const own = typeof siteName === "string" ? siteName.replace(/\s+/g, " ").trim().slice(0, 80).trim() : "";
  return own || nameFromRepo(repo.owner, repo.name);
}

/** The address suggested for a name: a name made from the repository drops its " Docs" suffix. */
export function slugBaseFor(name: string, fromConfig: boolean): string {
  return fromConfig ? name : name.replace(/\s+Docs$/, "");
}
