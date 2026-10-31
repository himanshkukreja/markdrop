/**
 * The API's page-address rules (backend services/docs_site_pages.normalize_path), checked as you
 * type. No imports: the docs:test suite runs it on node's type stripping (pagePath.test.mjs).
 */

/**
 * First path segments a page can't use: routes the docs site answers itself, and folders the
 * build reads as something else and would skip as pages (backend docs_snapshot.RESERVED_FIRST).
 */
export const RESERVED_FIRST = new Set([
  "docs-assets", "mcp", "md", "og", "changelog", "_next", "api-reference-json",
  "public", "api-reference", "node_modules", "video-scenes",
]);
/** Folder names the build skips at any depth. */
export const RESERVED_ANYWHERE = new Set(["node_modules", "video-scenes"]);

/** Why `path` can't be a page's address, or "" when it can: "/" or up to 6 segments of [a-z0-9-]. */
export function pathProblem(path: string): string {
  if (path === "/") return "";
  if (!path.startsWith("/")) return "The address starts with /.";
  if (path.endsWith("/")) return "The address can't end with /.";
  const parts = path.slice(1).split("/");
  if (parts.some((p) => !p)) return "The address can't have //.";
  if (parts.some((p) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(p))) return "Use lowercase letters, numbers and hyphens between the slashes.";
  if (parts.length > 6) return "Use at most 6 levels.";
  if (path.length > 200) return "That address is too long.";
  if (RESERVED_FIRST.has(parts[0]!)) return `/${parts[0]} is used by the guide itself. Start the address with another word.`;
  const skipped = parts.find((p) => RESERVED_ANYWHERE.has(p));
  if (skipped) return `${skipped} can't be part of a page's address.`;
  return "";
}

/**
 * The address the New page dialog suggests: /<group>/<title>, or /<title> when the group's slug
 * can't start an address (a group called "API reference" or "Changelog").
 */
export function suggestedPath(titleSlug: string, groupSlug: string): string {
  const group = groupSlug && !RESERVED_FIRST.has(groupSlug) ? groupSlug : "";
  return `/${[group, titleSlug].filter(Boolean).join("/")}`;
}
