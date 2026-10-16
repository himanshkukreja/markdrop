/**
 * PostHog (product analytics, session replay) and Google Analytics 4, behind one privacy layer.
 *
 * What never leaves the browser, whatever the tool:
 *  - Document slugs. A slug is a document's capability (lib/analyticsPath), so every URL, path,
 *    referrer and link target is reported as its route shape (`/[slug]`). The document a reader
 *    opened is reported as `doc_ref`, an opaque id from our API that opens nothing; the admin
 *    Journeys tab resolves it from our own database.
 *  - URL fragments (E2E keys `#k=`, tenant hand-off tokens) and query strings (signed tokens).
 *    UTM tags are read by PostHog separately, before this layer, so campaigns still attribute.
 *  - What people write. Editors, previews and lists of a person's own documents carry
 *    `ph-no-capture` (not recorded, clicks not autocaptured) or `ph-sensitive ph-mask` (text masked).
 *    Every input is masked in replays.
 *  - Anything at all on /admin, on a workspace's custom domain, or with `md_notrack` set.
 *
 * Session replay runs only while the current URL is "clean": nothing in it needed redacting, so no
 * document page, invite, share room or sign-in link is ever recorded. On those pages events (clicks,
 * scroll depth, reading time) still flow, sanitised. The Meta events inside recordings carry the
 * page URL too, so `$snapshot` batches are sanitised as well, as a second line of defence.
 *
 * Consent (lib/consent): "full" = cookies + replay + GA; "limited" = PostHog in cookieless mode
 * (counted, never linked across visits, never recorded) and no GA.
 *
 * posthog-js (~60 kB) loads with a dynamic import after the page is idle, so it never weighs on
 * first load.
 */
import type { CaptureResult, PostHog } from "posthog-js";
import { GA_ID, POSTHOG_KEY, POSTHOG_PROXY, POSTHOG_UI_HOST, thirdPartyAnalyticsHost } from "@/lib/analyticsConfig";
import { redactPath } from "@/lib/analyticsPath";
import type { AnalyticsMode } from "@/lib/consent";
import { trackingDisabled } from "@/lib/track";

export type DocContext = {
  ref: string | null;
  kind: "document" | "artifact";
  /** public: anyone with the link; protected: password, private or workspace; encrypted: E2E. */
  access: "public" | "protected" | "encrypted";
};

type Props = Record<string, unknown>;

let ph: PostHog | null = null;
let loading: Promise<PostHog | null> | null = null;
let mode: AnalyticsMode | null = null;
let gaLoaded = false;
let currentPath: string | null = null;
let doc: DocContext | null = null;
let pendingDocView: ReturnType<typeof setTimeout> | null = null;
const queued: [string, Props | undefined][] = [];
type User = { id: string; email: string; name: string | null; created_at?: string };
let pendingUser: User | null = null;

// ── Sanitising ───────────────────────────────────────────────────────────────

const API_ORIGIN = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_API_URL || "https://api.markdrop.in").origin;
  } catch {
    return "https://api.markdrop.in";
  }
})();

function origin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

/** A path as reported: its route shape. */
export function cleanPath(pathname: string): string {
  try {
    return redactPath(pathname.split(/[?#]/)[0] || "/");
  } catch {
    return "/";
  }
}

/** A URL as reported: same-origin URLs lose the slug, query and fragment; others keep origin + path. */
export function cleanUrl(raw: unknown): unknown {
  if (typeof raw !== "string" || !raw) return raw;
  let url: URL;
  try {
    url = new URL(raw, origin() || "https://www.markdrop.in");
  } catch {
    return null;
  }
  // Our API's URLs carry slugs too (/api/v1/og/<slug>.png, /api/v1/documents/<slug>).
  if (url.origin === API_ORIGIN || /^api\.markdrop\.in$/.test(url.hostname)) return `${url.origin}/api`;
  // By hostname: GA reports the page without its port.
  const here = typeof window === "undefined" ? "" : window.location.hostname;
  const own = url.hostname === here || /(^|\.)markdrop\.in$/.test(url.hostname);
  if (own) url.pathname = cleanPath(url.pathname);
  url.search = "";
  url.hash = "";
  // A relative input (an href attribute) stays relative.
  return raw.startsWith("/") && own ? url.pathname : url.toString();
}

const URL_KEY = /(url|referrer|href)$/i;
const PATH_KEY = /pathname$/i;
const TITLE_KEY = /^(\$?title|page_title)$/;

/** Whether this URL needs nothing redacted: the only kind replay may see. */
export function urlIsClean(href: string): boolean {
  try {
    const u = new URL(href);
    if (u.hash && u.hash !== "#") return false;
    for (const k of u.searchParams.keys()) if (!k.startsWith("utm_")) return false;
    return cleanPath(u.pathname) === u.pathname && !u.pathname.startsWith("/admin");
  } catch {
    return false;
  }
}

/** A markdrop URL written out in text (`markdrop.in/AbC123`), with or without a scheme. */
const URL_IN_TEXT = /(?:https?:\/\/)?(?:www\.)?(?:markdrop\.in|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)(\/[^\s"'<>)]*)?/g;

export function scrubText(text: string): string {
  if (!text || !/markdrop\.in|localhost|127\.0\.0\.1/.test(text)) return text;
  return text.replace(URL_IN_TEXT, (whole: string, path?: string) => {
    if (!path) return whole;
    const host = whole.slice(0, whole.length - path.length);
    return host + cleanPath(path);
  });
}

function maskTextFn(text: string, element?: HTMLElement | null): string {
  if (element?.closest?.(".ph-mask, title")) return text.replace(/\S/g, "*");
  return scrubText(text);
}

const ATTR_URL = new Set(["href", "src", "action", "data-href", "srcset", "poster"]);

/** Walk rrweb events: URL-bearing attributes and hrefs become route shapes. */
function scrubSnapshot(node: unknown, depth = 0): void {
  if (!node || typeof node !== "object" || depth > 200) return;
  if (Array.isArray(node)) {
    for (const n of node) scrubSnapshot(n, depth + 1);
    return;
  }
  const o = node as Props;
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "string") {
      // <meta content>: descriptions and titles are the document's own words, og:image its slug.
      if (k === "content") o[k] = "";
      else if (k === "href" || (ATTR_URL.has(k) && /^(https?:|\/)/.test(v))) o[k] = cleanUrl(v) ?? "";
      else o[k] = scrubText(v); // title, aria-label, alt, text: links written out as text
    } else if (v && typeof v === "object") {
      scrubSnapshot(v, depth + 1);
    }
  }
}

/** Keys cleanProps handles itself (below) or that hold no URLs worth walking. */
const NESTED_SKIP = new Set(["$snapshot_data", "$heatmap_data", "$elements"]);

/**
 * Nested objects carry URLs too: web vitals report `$web_vitals_FCP_event.navigationURL` and its
 * own `$current_url`. Same rules as the top level, a few levels down.
 */
function cleanNested(v: unknown, titleSafe: boolean, depth: number): void {
  if (!v || typeof v !== "object" || depth > 4) return;
  if (Array.isArray(v)) {
    for (const x of v) cleanNested(x, titleSafe, depth + 1);
    return;
  }
  const o = v as Props;
  for (const [k, x] of Object.entries(o)) {
    if (typeof x === "string") {
      if (PATH_KEY.test(k)) o[k] = cleanPath(x);
      else if (URL_KEY.test(k)) o[k] = cleanUrl(x);
      else if (TITLE_KEY.test(k) && !titleSafe) o[k] = "Markdrop";
    } else if (x && typeof x === "object") {
      cleanNested(x, titleSafe, depth + 1);
    }
  }
}

function cleanProps(props: Props | undefined, titleSafe: boolean): void {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === "string") {
      if (PATH_KEY.test(k)) props[k] = cleanPath(v);
      else if (URL_KEY.test(k)) props[k] = cleanUrl(v);
      else if (TITLE_KEY.test(k) && !titleSafe) props[k] = "Markdrop";
    } else if (v && typeof v === "object" && !NESTED_SKIP.has(k)) {
      cleanNested(v, titleSafe, 1);
    }
  }
  // Autocaptured elements: link targets can be document URLs.
  const els = props.$elements;
  if (Array.isArray(els)) {
    for (const el of els as Props[]) {
      if (el && typeof el === "object") {
        if (typeof el.attr__href === "string") el.attr__href = cleanUrl(el.attr__href);
        if (typeof el.href === "string") el.href = cleanUrl(el.href);
      }
    }
  }
  if (typeof props.$elements_chain === "string") {
    props.$elements_chain = props.$elements_chain.replace(
      /(attr__href|href)="((?:[^"\\]|\\.)*)"/g,
      (_m, a: string, h: string) => `${a}="${String(cleanUrl(h) ?? "")}"`,
    );
  }
  // Replay snapshots: Meta (page URL), $url_changed, and every link attribute in the DOM.
  if (Array.isArray(props.$snapshot_data)) scrubSnapshot(props.$snapshot_data);
  // Heatmaps are keyed by page URL.
  const heat = props.$heatmap_data;
  if (heat && typeof heat === "object" && !Array.isArray(heat)) {
    const out: Record<string, unknown[]> = {};
    for (const [url, points] of Object.entries(heat as Record<string, unknown[]>)) {
      const key = String(cleanUrl(url) ?? "");
      out[key] = [...(out[key] ?? []), ...(Array.isArray(points) ? points : [])];
    }
    props.$heatmap_data = out;
  }
}

function beforeSend(cr: CaptureResult | null): CaptureResult | null {
  if (!cr) return cr;
  const props = cr.properties as Props;
  const path = typeof window !== "undefined" ? window.location.pathname : "/";
  if (path.startsWith("/admin") || trackingDisabled()) return null;
  // Document titles are the documents' own words; only app pages keep theirs.
  const titleSafe = cleanPath(path) === path;
  cleanProps(props, titleSafe);
  // The open document, per event: a registered super property would persist across page loads.
  if (doc && cr.event !== "$snapshot") {
    props.doc_ref = doc.ref;
    props.doc_kind = doc.kind;
    props.doc_access = doc.access;
  }
  cleanProps(cr.$set as Props | undefined, titleSafe);
  cleanProps(cr.$set_once as Props | undefined, titleSafe);
  return cr;
}

// ── PostHog ──────────────────────────────────────────────────────────────────

function loadPostHog(m: AnalyticsMode): Promise<PostHog | null> {
  if (loading) return loading;
  loading = import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.init(POSTHOG_KEY, {
        api_host: POSTHOG_PROXY,
        ui_host: POSTHOG_UI_HOST,
        defaults: "2026-05-30",
        person_profiles: "always",
        // Page views are sent by onRoute, after the document's context is known.
        capture_pageview: false,
        capture_pageleave: true,
        autocapture: true,
        capture_dead_clicks: true,
        capture_heatmaps: true,
        // Undecided (EU) and declined visitors: counted without cookies or storage.
        cookieless_mode: "on_reject",
        opt_out_capturing_by_default: m === "limited",
        // Replay starts only on clean URLs, with consent (syncRecording).
        disable_session_recording: true,
        session_recording: {
          maskAllInputs: true,
          // Every text node passes through maskTextFn: links to documents become route shapes,
          // and page titles and .ph-mask text are masked outright.
          maskTextSelector: "*",
          maskTextFn,
          // Uncompressed, so before_send can scrub link attributes in snapshots (scrubSnapshot).
          // Requests are still gzipped on the wire.
          compress_events: false,
          recordCrossOriginIframes: false,
          recordHeaders: false,
          recordBody: false,
        },
        capture_performance: { network_timing: false, web_vitals: true },
        enable_recording_console_log: false,
        // Not used; skips two script loads.
        disable_surveys: true,
        disable_web_experiments: true,
        before_send: beforeSend,
      });
      ph = posthog;
      // Builds before this one registered doc context as super properties; clear any leftovers.
      for (const k of ["doc_ref", "doc_kind", "doc_access"]) posthog.unregister(k);
      if (m === "full" && !posthog.has_opted_in_capturing()) posthog.opt_in_capturing();
      for (const [name, props] of queued.splice(0)) posthog.capture(name, props);
      return posthog;
    })
    .catch(() => null);
  return loading;
}

function syncRecording() {
  if (!ph) return;
  const on = mode === "full" && urlIsClean(window.location.href);
  try {
    if (on && !ph.sessionRecordingStarted()) ph.startSessionRecording();
    else if (!on && ph.sessionRecordingStarted()) ph.stopSessionRecording();
  } catch {
    /* replay must never break the page */
  }
}

// ── Google Analytics ─────────────────────────────────────────────────────────

type Gtag = (...args: unknown[]) => void;
declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: Gtag;
  }
}

/** Hit parameters that are the reader's or a document's own words: never sent. */
const GA_DROP = new Set(["ep.link_text", "ep.file_name", "ep.search_term", "ep.form_name", "ep.form_id"]);
const GA_TITLE = new Set(["dt", "ep.page_title"]);

/** Clean one GA4 hit (a query string, or one line of a batched body). */
function cleanGaParams(qs: string): string {
  const params = new URLSearchParams(qs);
  const loc = params.get("dl");
  const dirty = loc ? cleanUrl(loc) !== loc.split(/[?#]/)[0] : cleanPath(window.location.pathname) !== window.location.pathname;
  for (const [k, v] of [...params.entries()]) {
    if (GA_DROP.has(k)) params.delete(k);
    else if (GA_TITLE.has(k) && dirty) params.set(k, "Markdrop");
    else if (/^https?:\/\//.test(v)) params.set(k, String(cleanUrl(v) ?? ""));
  }
  return params.toString();
}

function cleanGaUrl(url: string): string {
  const i = url.indexOf("?");
  return i < 0 ? url : `${url.slice(0, i)}?${cleanGaParams(url.slice(i + 1))}`;
}

const isGaHit = (url: string) => /google-analytics\.com\/(g\/)?collect|\/g\/collect/.test(url);

/**
 * Google Analytics reads the browser's URL by itself (on load and on every client navigation),
 * which on Markdrop is a document's slug, and a document page's title is its own words. So every
 * GA hit is cleaned on its way out: sendBeacon and fetch to the collect endpoint are wrapped, URLs
 * become route shapes, titles of document pages become "Markdrop", link text and file names are
 * dropped. Nothing else passes through these wrappers.
 */
function installGaFilter() {
  const nav = navigator as Navigator & { __mdGa?: boolean };
  if (nav.__mdGa) return;
  nav.__mdGa = true;
  if (typeof navigator.sendBeacon === "function") {
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
      const u = String(url);
      if (!isGaHit(u)) return beacon(url, data);
      const body = typeof data === "string" ? data.split("\n").map((l) => (l ? cleanGaParams(l) : l)).join("\n") : data;
      return beacon(cleanGaUrl(u), body);
    };
  }
  const realFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!isGaHit(u)) return realFetch(input, init);
    const body = typeof init?.body === "string" ? init.body.split("\n").map((l) => (l ? cleanGaParams(l) : l)).join("\n") : init?.body;
    return realFetch(cleanGaUrl(u), { ...init, body });
  };
}

function loadGA() {
  if (gaLoaded || !GA_ID) return;
  gaLoaded = true;
  installGaFilter();
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    // gtag reads `arguments`, not an array.
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  };
  window.gtag("js", new Date());
  window.gtag("config", GA_ID);
  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(s);
}

// ── Public API ───────────────────────────────────────────────────────────────

function enabled(): boolean {
  return thirdPartyAnalyticsHost() && !trackingDisabled();
}

/** Start (or switch) analytics. Called by ThirdPartyAnalytics once consent is known. */
export async function startThirdParty(m: AnalyticsMode) {
  if (!enabled()) return;
  const switching = mode !== null && mode !== m;
  mode = m;
  const posthog = await loadPostHog(m);
  if (switching && posthog) {
    if (m === "full" && !posthog.has_opted_in_capturing()) posthog.opt_in_capturing();
    else if (m === "limited" && !posthog.has_opted_out_capturing()) posthog.opt_out_capturing();
  }
  if (m === "full") loadGA();
  else if (gaLoaded) (window as unknown as Record<string, unknown>)[`ga-disable-${GA_ID}`] = true;
  syncRecording();
  if (pendingUser) identifyUser(pendingUser);
  if (currentPath === null) onRoute(window.location.pathname);
}

function pageview() {
  pendingDocView = null;
  const props: Props = {}; // before_send adds the open document's context
  if (ph) ph.capture("$pageview", props);
  else queued.push(["$pageview", props]);
  // GA sends its own page views (cleaned by installGaFilter).
}

/**
 * Called from a layout effect on every route change, before the recorder's MutationObserver
 * delivers the new page's DOM: a page that isn't clean stops recording first, so none of it is
 * captured. (onRoute, in a passive effect, would be too late.)
 */
export function pauseRecordingFor(pathname: string) {
  if (!ph || mode === null) return;
  if (cleanPath(pathname) === pathname && !pathname.startsWith("/admin")) return;
  try {
    if (ph.sessionRecordingStarted()) ph.stopSessionRecording();
  } catch {
    /* replay must never break the page */
  }
}

/** Every route change (ThirdPartyAnalytics calls it with usePathname). */
export function onRoute(pathname: string) {
  if (!enabled() || mode === null) return;
  if (pathname === currentPath) return;
  currentPath = pathname;
  if (pendingDocView) clearTimeout(pendingDocView);
  syncRecording();
  if (pathname.startsWith("/admin")) return;
  // On a document, wait briefly for the viewer to say which document it is.
  if (cleanPath(pathname) !== pathname && !doc) pendingDocView = setTimeout(pageview, 2500);
  else pageview();
}

/** The viewer reports the open document (or null when it closes). */
export function setAnalyticsDoc(next: DocContext | null) {
  doc = next;
  if (next && pendingDocView) {
    clearTimeout(pendingDocView);
    pageview();
  }
}

/** A product event, mirrored from lib/track (whose props are already free of slugs and titles). */
export function captureThirdParty(name: string, props?: Props) {
  if (!enabled() || mode === null) return;
  if (ph) ph.capture(name, props);
  else queued.push([name, props]);
  if (gaLoaded && window.gtag) window.gtag("event", name, props ?? {});
}

/** Sign-in: link this browser's history to the account. Limited mode never identifies. */
export function identifyUser(user: User) {
  if (!enabled()) return;
  // Auth usually resolves before analytics has started; apply it once it has.
  pendingUser = user;
  if (mode !== "full") return;
  void loadPostHog(mode).then((p) => {
    p?.identify(user.id, { email: user.email, name: user.name ?? undefined }, { signed_up_at: user.created_at });
  });
  if (gaLoaded && window.gtag) window.gtag("set", { user_id: user.id });
}

/** Sign-out: a fresh anonymous identity, so the next person on this browser isn't merged in. */
export function resetIdentity() {
  pendingUser = null;
  ph?.reset();
}
