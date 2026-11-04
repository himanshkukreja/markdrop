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
  "d",
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
  "trash",
  "upload",
  "w",
]);

/**
 * Markdrop Guides: /guides, and its old address /docs-studio (which redirects). The literal
 * screens under it; any other second segment is a site id.
 */
const GUIDES_ROOTS = new Set(["guides", "docs-studio"]);
// home: the studio home (guides.markdrop.in/, the app route /guides/home; /guides is the landing page).
const GUIDES_SCREENS = new Set(["home", "new", "members"]);
/** A site's screens below /guides/<site> (the [siteId] route's children). */
const GUIDES_SITE_SCREENS = new Set(["changelog", "design", "fixes", "import", "insights", "publish", "settings"]);
/** The sections of a site's Settings (/guides/<site>/settings/<section>). */
const GUIDES_SETTINGS = new Set(["general", "domains", "access", "ask-ai", "api-reference", "github", "redirects", "people", "private", "export", "danger"]);

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
  // Back from github.com (/guides/github/installed): a literal screen, not a site.
  if (segments.length === 3 && segments[1] === "github" && segments[2] === "installed") return `${root}/github/installed`;
  if (segments.length === 3 && GUIDES_SITE_SCREENS.has(segments[2]!)) return `${root}/[site]/${segments[2]}`;
  if (segments.length === 4 && segments[2] === "publish" && segments[3] === "compare") return `${root}/[site]/publish/compare`;
  // Settings › <section>. A domain's own setup page (…/settings/domains/<host>) names a customer's domain: [other].
  if (segments.length === 4 && segments[2] === "settings" && GUIDES_SETTINGS.has(segments[3]!)) return `${root}/[site]/settings/${segments[3]}`;
  return `${root}/[site]/[other]`;
}

/**
 * The docs site's internal route tree (docs/host DOCS_INTERNAL, repeated here to stay import-free).
 * docs.markdrop.in/<path> is reported as /docs-site/<path>, the app route it is served from, the way
 * a studio-host path is reported as its /guides/… route: never mistaken for an app page
 * (docs.markdrop.in/guides/overview is not the studio's /guides/[site]).
 */
export const DOCS_ROUTE = "/docs-site";

/** A docs-host path as its route: "/" → /docs-site, "/guides/x" → /docs-site/guides/x (never twice). */
export function docsRoute(pathname: string): string {
  const p = pathname.split(/[?#]/)[0] || "/";
  if (p === DOCS_ROUTE || p.startsWith(`${DOCS_ROUTE}/`)) return p;
  return p === "/" ? DOCS_ROUTE : `${DOCS_ROUTE}${p}`;
}

/** The literal pages below an app route. Anything else below one is reported as [other]. */
const APP_CHILDREN: Readonly<Record<string, ReadonlySet<string>>> = {
  auth: new Set(["callback", "docs-access", "handoff"]),
  dashboard: new Set(["analytics", "live"]),
  extension: new Set(["authorize"]),
  oauth: new Set(["consent"]),
  settings: new Set(["account", "connections", "tokens", "workspaces"]),
};
/** The one dynamic segment below some of those pages: a document's slug, a workspace id. */
const APP_GRANDCHILD: Readonly<Record<string, string>> = { "dashboard/analytics": "[slug]", "settings/workspaces": "[id]" };

/**
 * Query keys that can carry a secret (a token, a key, an OAuth state). A page whose address has one
 * is never recorded. Belt and braces: a recording only ever holds the route shape anyway.
 */
const SECRET_QUERY = /^(t|k|key|token|code|state|secret|sig|signature|password|pw|otp|jwt|ticket|auth|access_token|id_token|refresh_token)$/i;

/**
 * Whether session replay may record this page. Every page may (documents, share rooms, invites,
 * folders and workspaces included: their content is blocked or masked in the markup, and the
 * recording only ever holds the route shape of the address), except:
 *  - /admin, which shows other people's data;
 *  - /auth/*, the sign-in hand-offs, which hold a token while they run;
 *  - an address with a query key that can carry a secret (?token=, ?state=…).
 * The fragment is checked by hashIsRecordable, an encrypted document's page by the caller
 * (lib/thirdPartyAnalytics onEncryptedPage). `pathname` is a route (analyticsRoute, docsRoute).
 */
export function isRecordable(pathname: string, queryKeys: Iterable<string> = []): boolean {
  const first = pathname.split("/").filter(Boolean)[0] ?? "";
  if (first === "admin" || first === "auth") return false;
  for (const k of queryKeys) if (SECRET_QUERY.test(k)) return false;
  return true;
}

/**
 * A fragment replay may see: none, or a plain #anchor. Never one carrying a value: an encrypted
 * document's key (#k=…), a sign-in token (#token=…), a session hand-off (#mdt=…).
 */
export function hashIsRecordable(hash: string): boolean {
  return !hash || hash === "#" || !/[=&]/.test(hash);
}

/** A document's page (/<slug>): its page view waits briefly for the viewer to say which one. */
export function isDocumentRoute(pathname: string): boolean {
  return redactPath(pathname) === "/[slug]";
}

/**
 * Whether PostHog and Google Analytics may run on this host: Markdrop's own hosts (`production`:
 * markdrop.in, the studio host, the docs host), and the local ones only with `dev`
 * (NEXT_PUBLIC_ANALYTICS_DEV=1). Exact names, never a suffix: a published guide
 * (<site>.guides.markdrop.in) or a customer's own domain is never one of them.
 */
export function isAnalyticsHost(hostname: string, production: ReadonlySet<string>, local: ReadonlySet<string>, dev: boolean): boolean {
  if (production.has(hostname)) return true;
  return dev && local.has(hostname);
}

/** Swap an identifier-bearing path for its route shape. */
export function redactPath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "/";

  // /guides/<site>[/<screen>]: a Guides site's screens (and the old /docs-studio/… addresses).
  if (GUIDES_ROOTS.has(segments[0]!)) return guidesShape(segments);
  // /docs-site/<path>: a page of the docs site (docsRoute). Public pages, reported as they are.
  if (`/${segments[0]}` === DOCS_ROUTE) return pathname;

  // /share/<roomId> — an ephemeral P2P room, no more shareable than a document.
  if (segments[0] === "share" && segments.length > 1) return "/share/[id]";
  // /invite/<token> — the token is a bearer secret for joining a workspace.
  if (segments[0] === "invite" && segments.length > 1) return "/invite/[token]";
  // /h/<host>/<path> — the internal route a workspace domain is served from;
  // the path below the host is a document.
  if (segments[0] === "h") return "/h/[workspace-doc]";
  // /d/check/<host> — a guide's domain check page; the host is a customer's domain.
  if (segments[0] === "d" && segments.length > 1) return "/d/check/[host]";
  // /f/<share_id>[/…] — a shared folder link is a capability, like a document slug.
  if (segments[0] === "f" && segments.length > 1) return "/f/[share]";
  // /w/<workspace>[/f/<folder>] — ids, not secrets, but not worth a row per workspace either.
  if (segments[0] === "w" && segments.length > 1) return segments.length > 2 ? "/w/[workspace]/f/[folder]" : "/w/[workspace]";
  // /requests/<id> — one access request; not worth a row each.
  if (segments[0] === "requests" && segments.length > 1) return "/requests/[id]";

  if (segments.length === 1 && !APP_ROUTES.has(segments[0])) return "/[slug]";
  // Below an app route: its literal pages (/settings/account), the one id some of them take
  // (/dashboard/analytics/<slug> is a document's own analytics), anything else [other].
  if (segments.length > 1) {
    const [root, child] = [segments[0]!, segments[1]!];
    if (!APP_ROUTES.has(root)) return "/[slug]/[other]";
    if (!APP_CHILDREN[root]?.has(child)) return `/${root}/[other]`;
    if (segments.length === 2) return pathname;
    const id = APP_GRANDCHILD[`${root}/${child}`];
    return `/${root}/${child}/${id && segments.length === 3 ? id : "[other]"}`;
  }
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
