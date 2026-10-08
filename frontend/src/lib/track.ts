/**
 * First-party analytics: page views, engaged time and product events, sent to
 * our own API (backend/app/services/traffic.py) — no third party involved.
 *
 * Identity: a random visitor id in localStorage, so returning visitors and
 * retention can be measured. A browser that sends Global Privacy Control or Do
 * Not Track gets a session-only id instead — its visits are never linked
 * across days. No cookies are set.
 *
 * Paths are reported as route shapes (`/[slug]`, never the slug): a document's
 * URL is its capability. The server redacts again, so this is belt and braces.
 */
import { redactPath } from "@/lib/analyticsPath";
import { getToken } from "@/lib/api";

const API = process.env.NEXT_PUBLIC_API_URL ?? "https://api.markdrop.in";
const SESSION_IDLE_MS = 30 * 60 * 1000;
const OPT_OUT = "md_notrack";

type Item =
  | { k: "pv"; p: string }
  | { k: "ev"; n: string; p: string; props?: Record<string, string | number | boolean> }
  | { k: "leave"; p: string; d: number };

let queue: Item[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let currentPath: string | null = null;
let visibleSince = 0;
let engagedMs = 0;
let pendingEntry: Record<string, string> | null = null;
let started = false;

function store(kind: "local" | "session"): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null; // private mode / blocked storage
  }
}

function randomId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function privacySignal(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.globalPrivacyControl === true || navigator.doNotTrack === "1";
}

export function trackingDisabled(): boolean {
  return store("local")?.getItem(OPT_OUT) === "1";
}

/** Admin toggle: stop counting this browser (the owner's own visits skew everything). */
export function setTrackingDisabled(off: boolean) {
  const ls = store("local");
  if (off) ls?.setItem(OPT_OUT, "1");
  else ls?.removeItem(OPT_OUT);
}

function visitorId(): { vid: string; eph: boolean } {
  const eph = privacySignal();
  const s = eph ? store("session") : store("local");
  const key = eph ? "md_evid" : "md_vid";
  let vid = s?.getItem(key) ?? null;
  if (!vid) {
    vid = randomId();
    s?.setItem(key, vid);
  }
  return { vid, eph };
}

/** Session id; a new one after 30 idle minutes. Returns whether it's new. */
function sessionId(): { sid: string; fresh: boolean } {
  const ss = store("session");
  const now = Date.now();
  const last = Number(ss?.getItem("md_last") ?? 0);
  let sid = ss?.getItem("md_sid") ?? null;
  let fresh = false;
  if (!sid || now - last > SESSION_IDLE_MS) {
    sid = randomId();
    fresh = true;
    ss?.setItem("md_sid", sid);
  }
  ss?.setItem("md_last", String(now));
  return { sid, fresh };
}

/** Where this session came from: referrer and UTM tags of the landing URL. */
function entryInfo(): Record<string, string> {
  const out: Record<string, string> = {};
  if (document.referrer) out.ref = document.referrer;
  const q = new URLSearchParams(location.search);
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) {
    const v = q.get(k);
    if (v) out[k] = v;
  }
  // ?ref=producthunt and friends: treat as a source when no utm_source is set.
  if (!out.utm_source && q.get("ref")) out.utm_source = q.get("ref")!;
  return out;
}

function isPrimaryHost(): boolean {
  const h = location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "markdrop.in" || h.endsWith(".markdrop.in") || h.endsWith(".vercel.app");
}

function shape(pathname: string): string {
  if (!isPrimaryHost()) return pathname === "/" ? "/" : "/[workspace-doc]";
  return redactPath(pathname);
}

function flush(final = false) {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!queue.length) return;
  const { vid, eph } = visitorId();
  const { sid, fresh } = sessionId();
  if (fresh && !pendingEntry) pendingEntry = entryInfo();
  const body: Record<string, unknown> = { vid, sid, eph, host: location.hostname, events: queue };
  if (pendingEntry) body.entry = pendingEntry;
  queue = [];
  pendingEntry = null;
  const url = `${API}/api/v1/beat`;
  try {
    if (final) {
      // The page is going away. sendBeacon is the API built for this: the
      // browser delivers it after the page is gone. Sent as text/plain with
      // no Authorization header it is a CORS "simple" request, so no
      // preflight has to complete during teardown. The session was already
      // tied to the account by earlier beats, so nothing is lost by omitting it.
      const blob = new Blob([JSON.stringify(body)], { type: "text/plain" });
      if (navigator.sendBeacon?.(url, blob)) return;
      void fetch(url, { method: "POST", body: blob, keepalive: true, mode: "no-cors" }).catch(() => {});
      return;
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    void fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      keepalive: true,
      priority: "low",
    } as RequestInit).catch(() => {});
  } catch {
    /* analytics must never break the page */
  }
}

function enqueue(item: Item, now = false) {
  if (trackingDisabled() || !started) return;
  queue.push(item);
  if (now || queue.length >= 20) flush(now);
  else if (!timer) timer = setTimeout(() => flush(), 1500);
}

function closePage(final: boolean) {
  if (currentPath === null) return;
  if (visibleSince) engagedMs += Date.now() - visibleSince;
  visibleSince = document.visibilityState === "visible" ? Date.now() : 0;
  if (engagedMs > 500) enqueue({ k: "leave", p: currentPath, d: Math.round(engagedMs) }, final);
  engagedMs = 0;
}

/** Call on every route change (SiteTracker does). */
export function trackPageview(pathname: string) {
  if (typeof window === "undefined") return;
  if (pathname.startsWith("/admin")) {
    closePage(false);
    currentPath = null;
    return;
  }
  if (!started) {
    started = true;
    // The landing page's referrer belongs to the session; computed now, while
    // location.search still holds the landing URL's UTM tags.
    const { fresh } = sessionId();
    if (fresh) pendingEntry = entryInfo();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") closePage(true);
      else visibleSince = Date.now();
    });
    window.addEventListener("pagehide", () => closePage(true));
  }
  const p = shape(pathname);
  if (p === currentPath) return;
  closePage(false);
  currentPath = p;
  visibleSince = document.visibilityState === "visible" ? Date.now() : 0;
  enqueue({ k: "pv", p });
}

/**
 * A product event — name in snake_case, a few flat props. Never put a slug,
 * title, filename or email in props: these are aggregated, not inspected.
 */
export function track(name: string, props?: Record<string, string | number | boolean>) {
  if (typeof window === "undefined") return;
  if (!started) trackPageview(location.pathname);
  enqueue({ k: "ev", n: name, p: currentPath ?? shape(location.pathname), props });
}
