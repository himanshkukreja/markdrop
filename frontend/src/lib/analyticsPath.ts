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
  "extension",
  "login",
  "new",
  "settings",
  "share",
  "upload",
]);

/** Swap an identifier-bearing path for its route shape. */
export function redactPath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "/";

  // /share/<roomId> — an ephemeral P2P room, no more shareable than a document.
  if (segments[0] === "share" && segments.length > 1) return "/share/[id]";

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
