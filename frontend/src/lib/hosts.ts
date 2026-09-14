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

/**
 * Where to send someone on a workspace domain who has to identify themselves.
 *
 * Not straight to `/login`: their session already exists on the primary host,
 * it just isn't visible from this origin — browsers scope storage per origin,
 * and that is the whole problem. The handoff page reads it there, exchanges it
 * for a token scoped to this one workspace, and sends them back *here*, to the
 * address they were already on. Bouncing them to markdrop.in instead would
 * work and would also strand them: the folder path they arrived at only exists
 * on this domain.
 */
export function signInUrlFor(host: string, path: string): string {
  const params = new URLSearchParams({ host, next: path });
  return `https://${PRIMARY_HOST}/auth/handoff?${params}`;
}

/** The fragment a completed handoff comes back on. A fragment, never a query:
 *  it is a credential, and fragments are not sent to servers, logged by
 *  proxies, or put in a Referer header. */
export const HANDOFF_FRAGMENT = "mdt";
