/**
 * Opening an item (fix/open-flash). A workspace item (a page, a document, a file) is gated, and the
 * server render of its address is anonymous (it is cached for everyone), so that render is the
 * locked view. A signed-in reader used to see that locked view (the app header, a "/slug · Private"
 * bar and a skeleton) for as long as their own read took, and then the item in different chrome.
 *
 * Instead, a browser with a session paints the "opening" cover over it from the first paint: the
 * page's own chrome when the item is known to be a page, else the brand loader on the plain ground
 * a document's full-screen reader and a file's frame open on. Which one is decided before the
 * first paint by OPENING_SCRIPT (an inline script in the cover, so it also works in cached HTML):
 * the listing that opened the item leaves a short-lived hint naming its kind (rememberOpening).
 * The hint is the kind only, in this browser's own storage; it never decides access, which stays
 * with the API read.
 */

export type OpeningKind = "page" | "doc" | "file";

export const OPENING_ATTR = "data-md-opening";
const HINT_KEY = "md_opening";
const TOKEN_KEY = "markdrop_token";
const HINT_TTL_MS = 60_000;

/** Runs while the cover is parsed: marks <html> when this browser has a session (or a sign-in
 *  handoff is arriving on #mdt=), with the hinted kind for this address or "any". */
export const OPENING_SCRIPT = `(function(){try{var d=document.documentElement,ls=localStorage;if(!ls.getItem(${JSON.stringify(TOKEN_KEY)})&&location.hash.indexOf("#mdt=")!==0)return;var k="any";try{var h=JSON.parse(ls.getItem(${JSON.stringify(HINT_KEY)})||"null");if(h&&h.p===location.pathname&&Date.now()-h.t<${HINT_TTL_MS}&&/^(page|doc|file)$/.test(h.k))k=h.k}catch(e){}d.setAttribute(${JSON.stringify(OPENING_ATTR)},k);if(window.__mdOpening==null)window.__mdOpening=performance.now()}catch(e){}})();`;

/** The kind of a listed item, for the hint. */
export function openingKindOf(it: { kind?: string | null; editor?: string | null }): OpeningKind {
  return it.editor === "blocks" || it.kind === "page" ? "page" : it.kind === "artifact" ? "file" : "doc";
}

/** Called as a link to an item is followed (a new tab reads it before its first paint). */
export function rememberOpening(href: string, kind: OpeningKind): void {
  if (!href.startsWith("/") || href.startsWith("//")) return;
  try {
    localStorage.setItem(HINT_KEY, JSON.stringify({ p: href.split(/[?#]/)[0], k: kind, t: Date.now() }));
  } catch {
    /* storage blocked: the cover shows the brand loader */
  }
}

// The kind of the view this tab showed last: moving from a page to another page in the same tab
// (its tree, breadcrumbs, links) opens on a page's screen too.
let lastKind: OpeningKind | null = null;
export function noteViewKind(kind: OpeningKind): void {
  lastKind = kind;
}

/** What OPENING_SCRIPT decides, for a cover mounted on the client (a client-side navigation, where
 *  the inline script does not run), falling back to the kind this tab showed last. */
export function openingNow(): OpeningKind | "any" | null {
  if (typeof window === "undefined") return null;
  try {
    if (!localStorage.getItem(TOKEN_KEY) && !location.hash.startsWith("#mdt=")) return null;
    const h = JSON.parse(localStorage.getItem(HINT_KEY) || "null");
    if (h && h.p === location.pathname && Date.now() - h.t < HINT_TTL_MS && /^(page|doc|file)$/.test(h.k)) return h.k;
    return lastKind ?? "any";
  } catch {
    return null;
  }
}

declare global {
  interface Window { __mdOpening?: number | null; __mdOpened?: { at: number; since: number } | null }
}

/** The cover first painted (the inline script stamps it; a client-side cover stamps it on mount). */
export function openingStarted(): void {
  if (typeof window !== "undefined" && window.__mdOpening == null) window.__mdOpening = performance.now();
}

/** The cover is gone: the view it was standing in for is on screen. */
export function openingEnded(): void {
  if (typeof window === "undefined") return;
  document.documentElement.removeAttribute(OPENING_ATTR);
  if (window.__mdOpening != null) window.__mdOpened = { at: performance.now(), since: window.__mdOpening };
  window.__mdOpening = null;
}

/** ms since the cover first painted, when a cover handed over in the last moment (else null). A view
 *  that takes over from it (a file's frame cover) shows its loader as far along as the cover's was,
 *  instead of starting its own grace period again, so the loader doesn't blink. */
export function openingElapsed(): number | null {
  if (typeof window === "undefined") return null;
  const now = performance.now();
  if (window.__mdOpening != null) return now - window.__mdOpening;
  const o = window.__mdOpened;
  return o && now - o.at < 2000 ? now - o.since : null;
}
