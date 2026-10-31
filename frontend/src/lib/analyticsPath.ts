/**
 * Path redaction shared by Vercel Web Analytics and Speed Insights.
 *
 * On Markdrop the page path *is* the document: `markdrop.in/bkwJuG4`. Those
 * slugs are capability URLs — holding one is what grants you the document — so
 * reporting raw paths would hand a third party a browsable index of everything
 * published here, on a product that tells people we store ciphertext we cannot
 * read. The encryption key is never at risk (it lives in the fragment, which is
 * not part of the path and is not collected), but the slugs alone are enough to
 * undo the claim.
 *
 * Lives here rather than in either component so the two cannot drift: a rule
 * that protects one report and not the other protects neither.
 */

/** Every real page. Anything else with a single path segment is a document. */
const APP_ROUTES = new Set([
  "",
  "admin",
  "auth",
  "builder",
  "dashboard",
  "docs-studio",
  "enterprise",
  "extension",
  "f",
  "guides",
  "h",
  "invite",
  "login",
  "mcp",
  "new",
  "oauth",
  "privacy",
  "recent",
  "requests",
  "settings",
  "share",
  "shared",
  "upload",
  "w",
]);

/**
 * Markdrop Guides: /guides, and its old address /docs-studio (which redirects). The literal
 * screens under it; any other second segment is a site id.
 */
const GUIDES_ROOTS = new Set(["guides", "docs-studio"]);
const GUIDES_SCREENS = new Set(["new", "members"]);
/** A site's screens below /guides/<site> (the [siteId] route's children). */
const GUIDES_SITE_SCREENS = new Set(["design", "import", "publish", "settings"]);

/**
 * /guides/<site>[/<screen>] → /guides/[site][/<screen>]. Site ids aren't secrets (one opens
 * nothing without a role on the site), but each would be a row of its own. Anything deeper or
 * unknown collapses to /guides/[site]/[other]. The legacy prefix keeps its own name.
 */
function guidesShape(segments: string[]): string {
  const root = `/${segments[0]}`;
  if (segments.length === 1) return root;
  if (segments.length === 2 && GUIDES_SCREENS.has(segments[1]!)) return `${root}/${segments[1]}`;
  if (segments.length === 2) return `${root}/[site]`;
  if (segments.length === 3 && GUIDES_SITE_SCREENS.has(segments[2]!)) return `${root}/[site]/${segments[2]}`;
  return `${root}/[site]/[other]`;
}

/** Query keys a Guides screen carries: ids and flags, never capabilities. */
const GUIDES_QUERY = new Set(["page", "job", "ws", "new"]);

/**
 * Whether session replay may record this page: nothing in its path needed redacting, or the only
 * thing redacted was a Guides site id (a product's dashboard, not a document). `queryKeys` are the
 * URL's query parameter names: UTM tags are always fine, and on a Guides screen so are its own
 * (?page=, ?job=, ?ws=, ?new=). Documents, share rooms, invites, folder links and workspace pages
 * never qualify. Reports still carry only the route shape, without the query.
 */
export function isRecordable(pathname: string, queryKeys: Iterable<string> = []): boolean {
  const segments = pathname.split("/").filter(Boolean);
  const guides = segments.length > 0 && GUIDES_ROOTS.has(segments[0]!);
  for (const k of queryKeys) if (!k.startsWith("utm_") && !(guides && GUIDES_QUERY.has(k))) return false;
  const shape = redactPath(pathname);
  if (shape === pathname) return true;
  return guides && !shape.endsWith("/[other]");
}

/** Swap an identifier-bearing path for its route shape. */
export function redactPath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "/";

  // /guides/<site>[/<screen>]: a Guides site's screens (and the old /docs-studio/… addresses).
  if (GUIDES_ROOTS.has(segments[0]!)) return guidesShape(segments);

  // /share/<roomId> — an ephemeral P2P room, no more shareable than a document.
  if (segments[0] === "share" && segments.length > 1) return "/share/[id]";
  // /invite/<token> — the token is a bearer secret for joining a workspace.
  if (segments[0] === "invite" && segments.length > 1) return "/invite/[token]";
  // /h/<host>/<path> — the internal route a workspace domain is served from;
  // the path below the host is a document.
  if (segments[0] === "h") return "/h/[workspace-doc]";
  // /f/<share_id>[/…] — a shared folder link is a capability, like a document slug.
  if (segments[0] === "f" && segments.length > 1) return "/f/[share]";
  // /w/<workspace>[/f/<folder>] — ids, not secrets, but not worth a row per workspace either.
  if (segments[0] === "w" && segments.length > 1) return segments.length > 2 ? "/w/[workspace]/f/[folder]" : "/w/[workspace]";
  // /requests/<id> — one access request; not worth a row each.
  if (segments[0] === "requests" && segments.length > 1) return "/requests/[id]";

  if (segments.length === 1 && !APP_ROUTES.has(segments[0])) return "/[slug]";
  return pathname;
}

/**
 * Redact a full URL for reporting, or return null if it can't be parsed —
 * an unparseable URL isn't worth guessing at, so the event is dropped.
 */
export function redactUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    url.pathname = redactPath(url.pathname);
    // The fragment never reaches these events anyway; clearing the query keeps
    // ?new=1 and friends out, since those only appear alongside a slug.
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
