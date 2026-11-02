/**
 * Where Markdrop Guides' studio lives, and every address that points into it.
 *
 *   https://guides.markdrop.in/<path>     the studio (production). The middleware rewrites each
 *                                         path to the app route /guides/<path> ("/" → /guides/home)
 *   https://markdrop.in/guides            the Markdrop Guides landing page, for everyone
 *   https://markdrop.in/guides/<path>     a permanent redirect to guides.markdrop.in/<path>
 *   http://localhost:<port>/guides/<path> local development (and Vercel previews): the studio stays
 *                                         under /guides on the app's own host; its home is /guides/home
 *   http://guides.localhost:<port>/<path> the studio host in local development (like docs.localhost)
 *
 * Studio code never writes "/guides/…" itself: it names a *studio path* (as on the studio host:
 * "/", "/new?ws=x", "/<site>/fixes") and asks `studioHref` for the address on the current host.
 * Links into the rest of Markdrop from the studio go through `appHref` (absolute on the studio
 * host, which serves nothing but the studio).
 *
 * Plain module with no imports: the edge middleware, server components, the browser and
 * `node --test` (studioHost.test.mjs) all use it.
 */

/** The studio's production host (NEXT_PUBLIC_STUDIO_HOST overrides it). */
export const STUDIO_HOST = cleanHost(process.env.NEXT_PUBLIC_STUDIO_HOST || "guides.markdrop.in");
/** Local development: http://guides.localhost:<port> resolves to 127.0.0.1 in every modern browser. */
export const STUDIO_DEV_HOST = "guides.localhost";
/** The app route tree the studio is built from. */
export const STUDIO_ROUTE = "/guides";
/** The studio home's app route ("/" on the studio host; /guides itself is the landing page). */
export const STUDIO_HOME_ROUTE = "/guides/home";
/** The studio's literal first segments (anything else that is a site id is a site's screens). */
export const STUDIO_SEGMENTS: ReadonlySet<string> = new Set(["new", "members", "github", "theme-preview"]);
/** A site id (a MongoDB ObjectId). */
const SITE_ID = /^[0-9a-f]{24}$/;

/** Lowercase, no port, no trailing dot (tenant/hosts normalizeHost, repeated to stay import-free). */
export function cleanHost(raw: string | null | undefined): string {
  let h = (raw || "").trim().toLowerCase();
  if (h.startsWith("[")) return "";
  h = h.split(":")[0]!;
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** Hosts that serve the studio at their root. */
export const STUDIO_HOSTS: ReadonlySet<string> = new Set([STUDIO_HOST, STUDIO_DEV_HOST].filter(Boolean));

export function isStudioHost(raw: string | null | undefined): boolean {
  return STUDIO_HOSTS.has(cleanHost(raw));
}

/** markdrop.in for guides.markdrop.in. */
function parentOf(host: string): string {
  return host.split(".").slice(1).join(".");
}

/**
 * The production app (markdrop.in, www.markdrop.in): its /guides/* moved to the studio host. Not
 * localhost, 127.0.0.1 or a Vercel preview: those keep the studio under /guides.
 */
export function isStudioParentHost(raw: string | null | undefined): boolean {
  const h = cleanHost(raw);
  const p = parentOf(STUDIO_HOST);
  return !!h && !!p && p.includes(".") && (h === p || h === `www.${p}`);
}

/** Where a link is resolved from: window.location, or the request's host on the server. */
export interface Where {
  hostname: string;
  port?: string;
  protocol?: string;
}

/**
 * Server rendering assumes the studio host: in production that is the only host the studio's
 * screens are served on. (StudioShell remounts its header when the browser is elsewhere, so a
 * local or preview build never keeps a server-rendered address.)
 */
export const SERVER_WHERE: Where = { hostname: STUDIO_HOST, port: "", protocol: "https:" };

export function currentWhere(): Where {
  return typeof window === "undefined" ? SERVER_WHERE : window.location;
}

const portPart = (w: Where) => (w.port ? `:${w.port}` : "");

/**
 * Seen from `w`, the studio is at:
 *   ""                            the studio host itself (paths as they are)
 *   "https://guides.markdrop.in"  the production app
 *   "/guides"                     anywhere else (localhost, previews): under the app's own /guides
 */
export function studioBaseFrom(w: Where): string {
  if (isStudioHost(w.hostname)) return "";
  if (isStudioParentHost(w.hostname)) return `https://${STUDIO_HOST}`;
  return STUDIO_ROUTE;
}

/** "/new?ws=x#y" → ["/new", "?ws=x#y"]. A missing or relative path is the home ("/"). */
function splitPath(path: string): [string, string] {
  const p = path && path.startsWith("/") ? path : `/${path || ""}`;
  const i = p.search(/[?#]/);
  return i < 0 ? [p, ""] : [p.slice(0, i) || "/", p.slice(i)];
}

/** A studio path as its app route: "/" → /guides/home, "/x?y" → /guides/x?y. */
export function studioRoute(path = "/"): string {
  const [p, rest] = splitPath(path);
  return `${p === "/" ? STUDIO_HOME_ROUTE : `${STUDIO_ROUTE}${p}`}${rest}`;
}

/**
 * An app route (or an old address) as a studio path: /guides, /guides/home → "/"; /guides/x → "/x";
 * /docs-studio/x → "/x". Null when it isn't under /guides or /docs-studio.
 */
export function studioPathOf(route: string): string | null {
  const [p, rest] = splitPath(route);
  for (const root of [STUDIO_ROUTE, "/docs-studio"]) {
    if (p === root || p === `${root}/`) return `/${rest}`;
    if (p.startsWith(`${root}/`)) {
      const sub = p.slice(root.length);
      return `${sub === "/home" ? "/" : sub}${rest}`;
    }
  }
  return null;
}

/** The address of a studio path ("/", "/new?ws=x", "/<site>/fixes") as seen from `w` (default: here). */
export function studioHref(path = "/", w: Where = currentWhere()): string {
  const base = studioBaseFrom(w);
  if (base === STUDIO_ROUTE) return studioRoute(path);
  const [p, rest] = splitPath(path);
  return `${base}${p}${rest}`;
}

/** Server rendering of the rest of Markdrop assumes the production app (markdrop.in). */
const APP_SERVER_WHERE: Where = { hostname: cleanHost(parentOf(STUDIO_HOST)) || "markdrop.in", port: "", protocol: "https:" };

/**
 * A link into the studio from the rest of Markdrop (the account menu, the sidebar, the create
 * menu, the landing page): https://guides.markdrop.in/… from markdrop.in, /guides/… locally. For
 * markup the browser renders (a menu, a click): on the server it assumes markdrop.in.
 */
export function studioUrl(path = "/"): string {
  return studioHref(path, typeof window === "undefined" ? APP_SERVER_WHERE : window.location);
}

/**
 * A studio address (host-relative, absolute, or an app route) as its app route, e.g. for the API's
 * GitHub `return_to`, which is checked to start with /guides. Null for anything else.
 */
export function toStudioRoute(href: string, w: Where = currentWhere()): string | null {
  if (!href || href.startsWith("//") || href.includes("\\")) return null;
  let u: URL;
  try {
    u = new URL(href, `http://${cleanHost(w.hostname) || "localhost"}`);
  } catch {
    return null;
  }
  const path = `${u.pathname}${u.search}${u.hash}`;
  // Already an app route (/guides/…): as it is. No studio path starts with /guides.
  if (studioPathOf(u.pathname) !== null) return isStudioHost(u.hostname) || u.hostname === cleanHost(w.hostname) || isStudioParentHost(u.hostname) ? path : null;
  return isStudioHost(u.hostname) && isStudioPath(u.pathname) ? studioRoute(path) : null;
}

/**
 * The app route a page path stands for, for analytics: on the studio host guides.markdrop.in/<site>/
 * fixes is /guides/<site>/fixes (what reports have always grouped by); elsewhere the path itself.
 */
export function analyticsRoute(pathname: string, hostname?: string): string {
  const h = hostname ?? (typeof window === "undefined" ? "" : window.location.hostname);
  return isStudioHost(h) && studioPathOf(pathname) === null ? studioRoute(pathname) : pathname;
}

/** The app's origin as seen from the studio host: https://markdrop.in, or http://localhost:<port>. */
export function appOriginFrom(w: Where): string {
  const h = cleanHost(w.hostname);
  if (h === STUDIO_DEV_HOST) return `http://localhost${portPart(w)}`;
  if (h === STUDIO_HOST) return `https://${parentOf(STUDIO_HOST)}`;
  return "";
}

/**
 * A page of the rest of Markdrop ("/dashboard", "/settings/account") from wherever this runs: the
 * same path on the app's own host, an absolute markdrop.in address on the studio host.
 */
export function appHref(path: string, w: Where = currentWhere()): string {
  return isStudioHost(w.hostname) ? `${appOriginFrom(w)}${path}` : path;
}

/**
 * The studio origin a sign-in hand-off goes back to, from the app host it runs on: the production
 * studio host from markdrop.in, http://guides.localhost:<port> from localhost. Null where the
 * studio has no host of its own (previews): it is under /guides there, and shares the session.
 */
export function handoffStudioOrigin(w: Where): string | null {
  const h = cleanHost(w.hostname);
  if (isStudioParentHost(h)) return `https://${STUDIO_HOST}`;
  if (h === "localhost" || h === "127.0.0.1") return `http://${STUDIO_DEV_HOST}${portPart(w)}`;
  return null;
}

/* ── Requests (the middleware) ─────────────────────────────────────────────── */

export type StudioRouting =
  | { kind: "rewrite"; path: string }
  | { kind: "redirect"; location: string; /** true: 307 (the rest of Markdrop, from the studio host); else 308 */ temporary?: boolean }
  | { kind: "robots" }
  | { kind: "not-found" }
  | { kind: "next" };

/** What the studio host answers itself, untouched: public files, route handlers, framework paths. */
function passThrough(pathname: string): boolean {
  if (pathname.startsWith("/api/") || pathname.startsWith("/_vercel/") || pathname.startsWith("/__")) return true;
  if (pathname === "/apple-icon" || pathname.startsWith("/apple-icon") || pathname === "/icon") return true;
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return last.includes(".");
}

/** Is `pathname` one of the studio's own screens (on the studio host)? */
export function isStudioPath(pathname: string): boolean {
  const first = pathname.split("/")[1] ?? "";
  return pathname === "/" || STUDIO_SEGMENTS.has(first) || SITE_ID.test(first);
}

/**
 * How the middleware answers a request on a host that isn't the docs host. `search` includes its
 * "?" (or is ""). A fragment never reaches the server; browsers carry it across a redirect whose
 * Location has none, so a deep link's #section survives every redirect below.
 */
export function studioRouting(rawHost: string, pathname: string, search: string, port = ""): StudioRouting {
  const host = cleanHost(rawHost);

  if (isStudioHost(host)) {
    if (pathname === "/robots.txt") return { kind: "robots" };
    if (pathname === "/sitemap.xml") return { kind: "not-found" };
    // A screen first: a site's screens may end in a dotted segment (…/settings/domains/help.acme.com).
    if (isStudioPath(pathname)) return { kind: "rewrite", path: studioRoute(pathname) };
    if (passThrough(pathname)) return { kind: "next" };
    // An old /guides/… (or /docs-studio/…) address on the studio host: the same screen, unprefixed.
    const moved = studioPathOf(pathname);
    if (moved !== null) {
      const [p] = splitPath(moved);
      return { kind: "redirect", location: `${p}${search}` };
    }
    if (pathname === "/home") return { kind: "redirect", location: `/${search}` };
    // Everything else is the rest of Markdrop (a document, /dashboard, /login…): over to the app.
    return { kind: "redirect", location: `${appOriginFrom({ hostname: host, port })}${pathname}${search}`, temporary: true };
  }

  const params = new URLSearchParams(search);
  const prod = isStudioParentHost(host);
  const studio = (path: string) => (prod ? `https://${STUDIO_HOST}${path}` : studioRoute(path));
  const bare = pathname === STUDIO_ROUTE || pathname === `${STUDIO_ROUTE}/`;

  // The landing page's old "about" addresses: the landing page is /guides for everyone now.
  if ((bare && params.get("about") !== null) || pathname === `${STUDIO_ROUTE}/about`) {
    params.delete("about");
    const q = params.toString();
    return { kind: "redirect", location: `${STUDIO_ROUTE}${q ? `?${q}` : ""}` };
  }
  // /guides?ws=<id> was the studio home filtered to a workspace (the sidebar's Guides link).
  if (bare && params.get("ws")) return { kind: "redirect", location: studio(`/${search}`) };
  // Markdrop Guides' old name (Docs Studio).
  const legacy = studioPathOf(pathname);
  if (legacy !== null && (pathname === "/docs-studio" || pathname.startsWith("/docs-studio/"))) {
    const [p] = splitPath(legacy);
    return { kind: "redirect", location: studio(`${p}${search}`) };
  }
  // Every studio screen on markdrop.in moved to the studio host (the landing page's own link
  // preview image stays).
  if (prod && pathname.startsWith(`${STUDIO_ROUTE}/`) && !bare && !pathname.startsWith(`${STUDIO_ROUTE}/opengraph-image`)) {
    const [p] = splitPath(studioPathOf(pathname) ?? "/");
    return { kind: "redirect", location: `https://${STUDIO_HOST}${p}${search}` };
  }
  return { kind: "next" };
}

/** robots.txt on the studio host: an app, never indexed (markdrop.in/guides is the page to index). */
export const STUDIO_ROBOTS = "User-agent: *\nDisallow: /\n";
