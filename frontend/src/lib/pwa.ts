/**
 * Markdrop as an installed app (PWA): where the service worker may be registered, and the bits of
 * the browser the install UI reads. Two apps, one per origin:
 *
 *   markdrop.in          "Markdrop"         /manifest.webmanifest    opens /dashboard
 *   guides.markdrop.in   "Markdrop Guides"  /studio.webmanifest      opens the studio home
 *                                           (the middleware answers /manifest.webmanifest with it there)
 *
 * The service worker (/sw.js, app/sw.js/route.ts, source in lib/pwaWorker.ts) is registered only
 * from app screens on those hosts (and localhost, for the e2e stack), never from the landing page,
 * a document, the docs site, a workspace's own domain or a Vercel preview. Once installed it
 * covers its whole origin, but it only ever caches build assets: see lib/pwaWorker.ts.
 *
 * Plain module with no imports: the browser and `node --test` (pwa.test.mjs) both use it.
 */

/** Production builds register the worker; NEXT_PUBLIC_PWA=0 is the kill switch (the page then unregisters it). */
export const PWA_ENABLED = process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_PWA !== "0";

/** This build's id (next.config.ts): the worker's cache names and the "new version" check use it. */
export const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID || "dev";

/** Where the app opens when launched from the home screen / dock (manifest start_url). */
export const APP_START_URL = "/dashboard?source=pwa";
export const STUDIO_START_URL = "/?source=pwa";

const STUDIO_HOST = cleanHost(process.env.NEXT_PUBLIC_STUDIO_HOST || "guides.markdrop.in");
const PRIMARY_HOST = cleanHost(process.env.NEXT_PUBLIC_PRIMARY_HOST || "");

/** Lowercase, no port, no trailing dot. */
function cleanHost(raw: string | null | undefined): string {
  let h = (raw || "").trim().toLowerCase();
  if (h.startsWith("[")) return "";
  h = h.split(":")[0]!;
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** Which installable app a host serves: Markdrop, the Guides studio, or neither. */
export function pwaSurface(rawHost: string | null | undefined): "app" | "studio" | null {
  const h = cleanHost(rawHost);
  if (!h) return null;
  if (h === STUDIO_HOST || h === "guides.localhost") return "studio";
  if (h === "markdrop.in" || h === "www.markdrop.in" || h === "localhost" || h === "127.0.0.1") return "app";
  if (PRIMARY_HOST && h === PRIMARY_HOST && !h.endsWith(".vercel.app") && !h.endsWith(".workers.dev")) return "app";
  return null;
}

/**
 * First path segments of the app's own screens on markdrop.in: the account pages, sign-in, the
 * publishing tools and the admin console. Not "/", /enterprise, /mcp, /privacy, /guides (landing
 * pages) and not a document's address (anything else).
 */
const APP_SEGMENTS: ReadonlySet<string> = new Set([
  "dashboard", "pages", "recent", "requests", "search", "settings", "shared", "trash", "w",
  "login", "auth", "invite", "oauth", "new", "upload", "builder", "admin",
]);

/** Is `pathname` an app screen, on which the worker may be registered? */
export function isAppRoute(pathname: string, surface: "app" | "studio"): boolean {
  if (surface === "studio") return true; // the studio host serves nothing but the studio
  const segs = (pathname || "/").split("/").filter(Boolean);
  const first = segs[0] ?? "";
  // The studio under /guides on localhost and previews: /guides itself is the landing page.
  if (first === "guides") return segs.length > 1;
  return APP_SEGMENTS.has(first);
}

/** Launched from the home screen / dock (or a desktop app window)? */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return true;
    return ["standalone", "minimal-ui", "fullscreen", "window-controls-overlay"].some((m) => matchMedia(`(display-mode: ${m})`).matches);
  } catch {
    return false;
  }
}

/**
 * How this browser installs a web app, for the "Install app" menu item:
 *   "prompt"      Chrome, Edge, Samsung Internet… (beforeinstallprompt): one click
 *   "ios"         iPhone and iPad: Share › Add to Home Screen (any iOS browser, 16.4+)
 *   "mac-safari"  Safari 17+ on a Mac: File › Add to Dock
 *   null          no way we can point at (Firefox desktop…)
 */
export type InstallPath = "prompt" | "ios" | "mac-safari" | null;

export function installPathFor(ua: string, maxTouchPoints = 0, hasPrompt = false): InstallPath {
  if (hasPrompt) return "prompt";
  const iPad = /Macintosh/.test(ua) && maxTouchPoints > 1; // iPadOS asks for the desktop site
  if (/iPhone|iPad|iPod/.test(ua) || iPad) return "ios";
  if (/Macintosh/.test(ua) && /Version\/(1[7-9]|[2-9]\d)\b/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg\/|Firefox|OPR\//.test(ua)) return "mac-safari";
  return null;
}

/**
 * The inline <head> script (root layout), before anything renders. Static, so ISR-safe.
 *   - Keeps the browser's install prompt for the account menu's "Install app" (and keeps Android's
 *     mini-infobar off the landing page and documents): `beforeinstallprompt` can fire before
 *     React hydrates, so it is caught here (PwaProvider takes it from window.__mdInstallPrompt).
 *   - The installed Markdrop app never shows the landing page: launched (or navigated) to "/" in
 *     a standalone window on markdrop.in, it goes to the dashboard, which sends a signed-out
 *     person through sign-in and back.
 */
export function pwaBootScript(): string {
  const hosts = ["markdrop.in", "www.markdrop.in", "localhost", "127.0.0.1", PRIMARY_HOST].filter(Boolean);
  return `(function(){try{addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__mdInstallPrompt=e;dispatchEvent(new Event('md:installprompt'))});var s=navigator.standalone===true||matchMedia('(display-mode: standalone)').matches;if(s&&location.pathname==='/'&&${JSON.stringify(hosts)}.indexOf(location.hostname)>=0)location.replace('/dashboard'+location.search);}catch(e){}})();`;
}
