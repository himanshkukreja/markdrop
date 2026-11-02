/**
 * Signing in on the studio host (guides.markdrop.in) without signing in again.
 *
 * A browser keeps storage per origin, so the session on markdrop.in is invisible on
 * guides.markdrop.in. The studio borrows it, through the page that can see both
 * (markdrop.in/auth/handoff, the same page custom domains use):
 *
 *   1. guides.markdrop.in/<path>, no session here: pick a random `state`, keep it in this tab's
 *      sessionStorage (with any #fragment of the address), go to
 *      markdrop.in/auth/handoff?studio=1&state=<state>&next=<path>
 *   2. markdrop.in, signed in: POST /api/v1/auth/studio-token mints a fresh session for the
 *      studio, and the page goes back to guides.markdrop.in<path>#mdt=<token>&mds=<state>.
 *      Signed out: /login first, then step 2 (Google, an email code or link: any sign-in).
 *   3. guides.markdrop.in: the inline boot script (STUDIO_BOOT_SCRIPT, before anything renders)
 *      takes the token only if `mds` is the state this tab sent (login CSRF: a link carrying
 *      someone else's token is ignored) and it is a full session token; it stores it as this
 *      origin's session, strips the fragment and puts the original #fragment back.
 *
 * The token travels in a fragment, never a query: fragments aren't sent to servers, logged or put
 * in a Referer header. Only the studio host takes one; the guide sites on *.guides.markdrop.in
 * are other origins and never see it. Three hand-offs in two minutes without a working session
 * stop (StudioSignIn shows a Sign in button instead of looping).
 *
 * Signing out: on the studio host, Sign out clears this origin's session and opens
 * markdrop.in/auth/handoff?signout=studio, which offers to sign out of Markdrop too. Signing out
 * on markdrop.in clears the studio's session as well (public/studio-signout.html in a hidden frame).
 *
 * Plain module (the server layout inlines the boot script).
 */
import { STUDIO_DEV_HOST, STUDIO_HOST, appOriginFrom, handoffStudioOrigin, isStudioHost } from "./studioHost";

/** lib/api's TOKEN_KEY, repeated so this file stays server-safe. */
const TOKEN_KEY = "markdrop_token";
/** sessionStorage: {s: state, h: original #fragment, at: hand-off start times}. */
export const HANDOFF_KEY = "markdrop_studio_handoff";
/** Set on <html> when the hand-off gave up (StudioSignIn shows the way out). */
export const HANDOFF_FAILED_ATTR = "data-studio-signin";
const MAX_TRIES = 3;
const WINDOW_MS = 120_000;

/** Fragment keys of a completed studio hand-off. */
export const STUDIO_TOKEN_FRAGMENT = "mdt";
export const STUDIO_STATE_FRAGMENT = "mds";

/** A state: 32 hex characters. */
export const STATE_RE = /^[0-9a-f]{32}$/;

/** markdrop.in/auth/handoff for the studio (relative to the app origin `app`). */
export function studioHandoffPath(next: string, state?: string): string {
  const q = new URLSearchParams({ studio: "1", next });
  if (state) q.set("state", state);
  return `/auth/handoff?${q}`;
}

/**
 * The boot script: first thing in every studio page's HTML (the (guides) layout). A no-op off the
 * studio host. Mirrors consume/startStudioHandoff below; kept small and dependency-free.
 */
export const STUDIO_BOOT_SCRIPT = `(function(){try{
var H=${JSON.stringify([STUDIO_HOST, STUDIO_DEV_HOST])};if(H.indexOf(location.hostname)<0)return;
var T=${JSON.stringify(TOKEN_KEY)},K=${JSON.stringify(HANDOFF_KEY)},ss=sessionStorage,ls=localStorage,p=null;
try{p=JSON.parse(ss.getItem(K)||"null")}catch(e){}
function ok(t){try{var b=t.split(".")[1];if(!b)return false;var j=JSON.parse(atob(b.replace(/-/g,"+").replace(/_/g,"/")+"===".slice((b.length+3)%4)));return !!j&&j.typ==="access"&&typeof j.sub==="string"&&(!j.exp||j.exp*1000>Date.now())}catch(e){return false}}
if(location.hash.indexOf("#${STUDIO_TOKEN_FRAGMENT}=")===0){var q=new URLSearchParams(location.hash.slice(1)),t=q.get("${STUDIO_TOKEN_FRAGMENT}")||"",st=q.get("${STUDIO_STATE_FRAGMENT}")||"";
if(p&&p.s&&st===p.s&&ok(t))ls.setItem(T,t);
history.replaceState(history.state,"",location.pathname+location.search+(p&&p.h||""));if(p){p.s="";p.h="";ss.setItem(K,JSON.stringify(p))}}
if(ls.getItem(T))return;
var now=Date.now(),at=((p&&p.at)||[]).filter(function(x){return now-x<${WINDOW_MS}});
if(at.length>=${MAX_TRIES}){document.documentElement.setAttribute("${HANDOFF_FAILED_ATTR}","failed");return}
var a=new Uint8Array(16);crypto.getRandomValues(a);var s="";for(var i=0;i<16;i++)s+=(a[i]+256).toString(16).slice(1);
at.push(now);ss.setItem(K,JSON.stringify({s:s,h:location.hash||"",at:at}));
var app=location.hostname==="${STUDIO_DEV_HOST}"?"http://localhost"+(location.port?":"+location.port:""):${JSON.stringify(appOriginFrom({ hostname: STUDIO_HOST }))};
location.replace(app+"/auth/handoff?studio=1&state="+s+"&next="+encodeURIComponent(location.pathname+location.search));
}catch(e){}})();`;

interface Pending {
  s?: string;
  h?: string;
  at?: number[];
}

function readPending(): Pending | null {
  try {
    return JSON.parse(sessionStorage.getItem(HANDOFF_KEY) || "null") as Pending | null;
  } catch {
    return null;
  }
}

function randomState(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * On the studio host with no (working) session: go and borrow markdrop.in's. False when it gave up
 * (three tries in two minutes), with <html> marked for StudioSignIn. Browser only.
 */
export function startStudioHandoff(): boolean {
  if (typeof window === "undefined" || !isStudioHost(window.location.hostname)) return false;
  const now = Date.now();
  const at = (readPending()?.at ?? []).filter((x) => now - x < WINDOW_MS);
  if (at.length >= MAX_TRIES) {
    document.documentElement.setAttribute(HANDOFF_FAILED_ATTR, "failed");
    return false;
  }
  const s = randomState();
  at.push(now);
  try {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ s, h: window.location.hash || "", at }));
  } catch {
    /* storage off: the state check fails on the way back, and the guard can't count. Give up. */
    document.documentElement.setAttribute(HANDOFF_FAILED_ATTR, "failed");
    return false;
  }
  const next = window.location.pathname + window.location.search;
  window.location.replace(`${appOriginFrom(window.location)}${studioHandoffPath(next, s)}`);
  return true;
}

/** A working session on the studio host: the hand-off guard starts over. */
export function studioSignedIn(): void {
  try {
    sessionStorage.removeItem(HANDOFF_KEY);
  } catch {
    /* nothing kept */
  }
  if (typeof document !== "undefined") document.documentElement.removeAttribute(HANDOFF_FAILED_ATTR);
}

/**
 * "Sign in" on the studio host: markdrop.in's hand-off page without a state. It signs the reader
 * in there if needed and comes back to `next` here, where the boot script starts a proper
 * hand-off (which then goes through without a screen).
 */
export function studioSignInHref(next: string): string {
  if (typeof window === "undefined") return `${appOriginFrom({ hostname: STUDIO_HOST })}${studioHandoffPath(next)}`;
  return `${appOriginFrom(window.location)}${studioHandoffPath(next)}`;
}

/** Sign out on the studio host: this origin's session goes, then markdrop.in offers its own. */
export function studioSignOutHref(): string {
  const w = typeof window === "undefined" ? { hostname: STUDIO_HOST } : window.location;
  return `${appOriginFrom(w)}/auth/handoff?signout=studio`;
}

/**
 * Sign out on the studio host. Only storage changes before leaving (no React state), so no screen
 * notices the missing session and starts a hand-off on the way out. Sessions are stateless JWTs
 * (POST /auth/logout revokes nothing), so there is no request to make.
 */
export function signOutOfStudio(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(HANDOFF_KEY);
  } catch {
    /* storage off: nothing kept */
  }
  window.location.assign(studioSignOutHref());
}

/* ── markdrop.in's side ───────────────────────────────────────────────────── */

/** The frame that clears the studio host's session (public/studio-signout.html). */
const SIGNOUT_FRAME = "/studio-signout.html";

/**
 * After signing out on markdrop.in: clear the studio host's session too, through a hidden frame of
 * the studio origin (same site, so it shares the studio's storage) that only listens to
 * markdrop.in. Resolves when done or after `timeoutMs`; never throws.
 */
export function clearStudioSession(timeoutMs = 1500): Promise<void> {
  if (typeof window === "undefined" || isStudioHost(window.location.hostname)) return Promise.resolve();
  const origin = handoffStudioOrigin(window.location);
  if (!origin) return Promise.resolve();
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      frame.remove();
      resolve();
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frame.contentWindow) return;
      if (e.data === "markdrop:studio-ready") frame.contentWindow?.postMessage("markdrop:signout", origin);
      else if (e.data === "markdrop:studio-signed-out") finish();
    };
    window.addEventListener("message", onMessage);
    window.setTimeout(finish, timeoutMs);
    frame.src = `${origin}${SIGNOUT_FRAME}`;
    document.body.appendChild(frame);
  });
}
