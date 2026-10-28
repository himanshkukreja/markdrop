/**
 * Folder address rules, shared by every folder dialog. Mirrors the backend (`services/folder.py`
 * `MAX_SLUG`, `_unique_slug`, and `utils/slug.py` `RESERVED_SLUGS`) so the dialog says "no" before
 * the server does — keep them in sync.
 *
 * A top-level folder is the first path segment on a workspace's own domain, so it may not be a
 * name that domain already uses for something else: `api` (the API proxy), `_next` (the app's
 * assets), `mdp` (the analytics proxy), `h` (the tenant rewrite) — plus every app route.
 */

/** Mirrors MAX_SLUG in services/folder.py. */
export const FOLDER_SLUG_MAX = 40;

/** Mirrors RESERVED_SLUGS in backend/app/utils/slug.py. */
export const RESERVED_FOLDER_SLUGS: ReadonlySet<string> = new Set([
  "admin", "share", "auth", "api", "login", "logout", "signup",
  "dashboard", "me", "new", "health", "settings", "account",
  "about", "terms", "privacy", "_next", "static", "favicon.ico",
  "robots.txt", "sitemap.xml",
  "artifacts", "artifact", "upload", "builder",
  "h", "mdp",
  "enterprise",
  "invite", "extension", "dev-preview", "dev-kit-frames",
  "dev-kit-publish", "dev-reading", "fonts", "icon.svg",
  "email",
  "mcp", "oauth",
  "f", "w",
  "shared", "recent", "requests",
]);

/** URL-safe folder segment, the same as the server's slugify (the server may add a suffix on a clash). */
export function folderSlug(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, FOLDER_SLUG_MAX)
      .replace(/-+$/g, "") || "folder"
  );
}

/**
 * Why this name can't be used for a folder at this level, or null when it can. Only top-level
 * folders are restricted (a nested segment never shadows a route).
 */
export function folderNameProblem(name: string, topLevel: boolean): string | null {
  if (!topLevel) return null;
  const slug = folderSlug(name);
  if (RESERVED_FOLDER_SLUGS.has(slug)) {
    return `“${name.trim()}” can't be a top-level folder name — it clashes with an address the site already uses. Try another name or put it inside a folder.`;
  }
  return null;
}
