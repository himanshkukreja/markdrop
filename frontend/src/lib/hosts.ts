/**
 * The one host that serves the app's own pages.
 *
 * A workspace's custom domain rewrites *every* path to the document route (see
 * middleware.ts), so it has no `/login`, no `/dashboard`, nothing but
 * documents. Anything that needs to send a reader to an app page has to name
 * this host explicitly, or it sends them to a 404 on the tenant domain.
 */
export const PRIMARY_HOST =
  process.env.NEXT_PUBLIC_PRIMARY_HOST || "www.markdrop.in";

/** Where to send someone who has to identify themselves to read `slug`. */
export function signInUrlFor(slug: string): string {
  return `https://${PRIMARY_HOST}/login?next=${encodeURIComponent(`/${slug}`)}`;
}
