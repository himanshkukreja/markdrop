/**
 * Signed-in people never see the landing page: markdrop.in/ takes them to /dashboard.
 *
 * The session token lives in localStorage, which the server can't read, so the browser also keeps
 * a hint cookie, `md_si=1` (not the token, nothing secret: "this browser has a session"). It is set
 * whenever a session is stored or confirmed (lib/api setToken, AuthContext after /auth/me) and
 * removed with the session (clearToken: sign out, a 401). It expires with the token it stands for
 * (at most 400 days), so an expired session doesn't send anyone to /dashboard.
 *
 *   - middleware: GET "/" on the app host (markdrop.in, www, localhost, Vercel previews; never a
 *     workspace's domain, the docs site or the Guides studio) with md_si=1 answers 307 → /dashboard
 *     (query kept) before any HTML. Only "/": /pricing, /privacy, /guides… stay put for everyone.
 *     The redirect is a middleware response marked no-store, so the prerendered "/" that anonymous
 *     visitors get is untouched (Vercel runs middleware in front of its cache: no Vary needed).
 *   - the boot script (HOME_BOOT_SCRIPT, first in <head> of every page, a no-op off "/"): a session
 *     from before the cookie existed (token but no cookie) sets the cookie and replaces the location
 *     with /dashboard before the first paint, the page hidden meanwhile. Anonymous visitors only pay
 *     a localStorage read.
 *   - `/?home=1` shows the landing page to a signed-in person (the account menu's "Home page").
 *
 * Plain module with no imports: the edge middleware, the browser and `node --test`
 * (homeRedirect.test.mjs) all use it.
 */

export const SIGNED_IN_COOKIE = "md_si";
/** `/?home=1`: the landing page, even when signed in. */
export const HOME_ESCAPE_PARAM = "home";
export const HOME_TARGET = "/dashboard";
/** lib/api's TOKEN_KEY, repeated so this file has no imports. */
const TOKEN_KEY = "markdrop_token";
const MAX_AGE_S = 400 * 24 * 3600;

/** Lowercase, no port, no trailing dot. */
function cleanHost(raw: string | null | undefined): string {
  let h = (raw || "").trim().toLowerCase();
  if (h.startsWith("[")) return "";
  h = h.split(":")[0]!;
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/**
 * The app's own hosts, where "/" is the landing page. Deliberately a short allowlist (not
 * components/tenant/hosts' isPrimaryHost, which also counts the Guides studio): anything else —
 * a workspace's domain, docs.markdrop.in, guides.markdrop.in — never redirects.
 */
const APP_HOSTS: readonly string[] = Array.from(
  new Set(
    [...(process.env.NEXT_PUBLIC_PRIMARY_HOSTS || "markdrop.in,www.markdrop.in,localhost").split(","), "localhost", "127.0.0.1"]
      .map(cleanHost)
      .filter((h) => h && !h.startsWith("docs.") && !h.startsWith("guides.")),
  ),
);

export function isAppHomeHost(raw: string | null | undefined): boolean {
  const host = cleanHost(raw);
  if (!host) return false;
  return APP_HOSTS.includes(host) || host.endsWith(".vercel.app");
}

function escaped(search: string): boolean {
  return new URLSearchParams(search).get(HOME_ESCAPE_PARAM) === "1";
}

/**
 * Where the middleware sends this request, or null to serve it. `search` is the raw query
 * ("" or "?utm_source=x"), kept on the way to the dashboard.
 */
export function homeRedirect(req: {
  host: string | null | undefined;
  method: string;
  pathname: string;
  search: string;
  cookie: string | null | undefined;
}): string | null {
  if (req.pathname !== "/") return null;
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  if (req.cookie !== "1") return null;
  if (!isAppHomeHost(req.host)) return null;
  if (escaped(req.search)) return null;
  return HOME_TARGET + req.search;
}

/** The `exp` (seconds) of a JWT, or null when it has none or isn't one. */
export function tokenExpiry(token: string | null | undefined): number | null {
  try {
    const b = String(token || "").split(".")[1];
    if (!b) return null;
    const j = JSON.parse(atob(b.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b.length + 3) % 4)));
    return j && typeof j.exp === "number" ? j.exp : null;
  } catch {
    return null;
  }
}

/** The Set-Cookie-style string for document.cookie: on (until `exp`, at most 400 days) or off. */
export function hintCookie(on: boolean, exp: number | null, https: boolean, nowMs: number): string {
  const tail = "; Path=/; SameSite=Lax" + (https ? "; Secure" : "");
  let age = MAX_AGE_S;
  if (exp) age = Math.min(age, Math.floor(exp - nowMs / 1000));
  if (!on || age <= 0) return `${SIGNED_IN_COOKIE}=; Max-Age=0${tail}`;
  return `${SIGNED_IN_COOKIE}=1; Max-Age=${age}${tail}`;
}

/** Browser: this browser has a session (`token`'s expiry bounds the hint). */
export function rememberSignedIn(token: string | null | undefined): void {
  if (typeof document === "undefined") return;
  try {
    document.cookie = hintCookie(true, tokenExpiry(token), location.protocol === "https:", Date.now());
  } catch {
    /* cookies off: the boot script covers it */
  }
}

/** Browser: the session is gone. */
export function forgetSignedIn(): void {
  if (typeof document === "undefined") return;
  try {
    document.cookie = hintCookie(false, null, location.protocol === "https:", Date.now());
  } catch {
    /* cookies off */
  }
}

/**
 * The boot script: synchronous, first thing in <head> (app/layout.tsx), before any stylesheet or
 * paint. On "/" of the app host, with a stored, unexpired session and no `?home=1`, it sets the hint
 * cookie, hides the page and replaces the location with /dashboard; anything else returns at once.
 * Mirrors homeRedirect / tokenExpiry / hintCookie above (homeRedirect.test.mjs runs it).
 */
export const HOME_BOOT_SCRIPT = `(function(){try{
var l=location,h=l.hostname.toLowerCase().replace(/\\.+$/,"");
if(l.pathname!=="/"||!(${JSON.stringify(APP_HOSTS)}.indexOf(h)>=0||/\\.vercel\\.app$/.test(h)))return;
if(new URLSearchParams(l.search).get(${JSON.stringify(HOME_ESCAPE_PARAM)})==="1")return;
var t=localStorage.getItem(${JSON.stringify(TOKEN_KEY)});if(!t)return;
var x=null;try{var b=t.split(".")[1];if(b){var j=JSON.parse(atob(b.replace(/-/g,"+").replace(/_/g,"/")+"===".slice((b.length+3)%4)));if(j&&typeof j.exp==="number")x=j.exp}}catch(e){}
var n=Date.now(),a=${MAX_AGE_S};if(x)a=Math.min(a,Math.floor(x-n/1000));if(a<=0)return;
document.cookie=${JSON.stringify(SIGNED_IN_COOKIE)}+"=1; Max-Age="+a+"; Path=/; SameSite=Lax"+(l.protocol==="https:"?"; Secure":"");
document.documentElement.style.visibility="hidden";
l.replace(${JSON.stringify(HOME_TARGET)}+l.search+l.hash);
}catch(e){}})();`;
