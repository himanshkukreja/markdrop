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
 *  - Anything at all on an end-to-end encrypted document's page — with or without its #k= key in
 *    the address. PostHog and GA never load when the page opens on one (the server-rendered
 *    `data-md-e2e` marker, read before anything loads); arriving at one later by client-side
 *    navigation drops every event, stops replay and turns GA off until the reader leaves it.
 *
 * Session replay runs only while the current URL is "clean": nothing in it needed redacting, so no
 * document page, invite, share room or sign-in link is ever recorded. On those pages events (clicks,
 * scroll depth, reading time) still flow, sanitised. The Meta events inside recordings carry the
 * page URL too, so `$snapshot` batches are sanitised as well, as a second line of defence.
 *
 * The one exception is a Guides screen (/guides/<site>…, lib/analyticsPath isRecordable): a site
 * id isn't a secret, so that dashboard is recorded, reported as its route shape, with the
 * customer's words in it blocked or masked (`ph-no-capture` on the editor, previews and lists of
 * pages, sites, redirects and questions; `ph-sensitive ph-mask` on names and addresses). Readers
 * of a published guide meet none of this: those sites run none of Markdrop's trackers
 * (docs/client/AppTrackers).
 *
 * Consent (lib/consent): "full" = cookies + replay + GA; "limited" = PostHog in cookieless mode
 * (counted, never linked across visits, never recorded) and no GA.
 *
 * posthog-js (~60 kB) loads with a dynamic import after the page is idle, so it never weighs on
 * first load.
 */
import type { CaptureResult, PostHog } from "posthog-js";
import { GA_ID, POSTHOG_KEY, POSTHOG_PROXY, POSTHOG_UI_HOST, thirdPartyAnalyticsHost } from "@/lib/analyticsConfig";
import { isRecordable, redactPath } from "@/lib/analyticsPath";
import { analyticsRoute, isStudioHost, studioPathOf } from "@/lib/studioHost";
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
/** Consent was known on an encrypted page, so nothing loaded; started on the first page that isn't one. */
let deferredMode: AnalyticsMode | null = null;
/** On an encrypted document right now (analytics already loaded): everything is dropped. */
let encryptedPause = false;
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

/**
 * A path as reported: its route shape. On the studio host (guides.markdrop.in, whose paths have no
 * /guides; `host` defaults to this page's) it is the app route it stands for: /guides/[site]/fixes.
 */
export function cleanPath(pathname: string, host?: string): string {
  try {
    return redactPath(analyticsRoute(pathname.split(/[?#]/)[0] || "/", host));
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
  // A studio-host URL keeps its own (unprefixed) shape: guides.markdrop.in/[site]/fixes.
  if (own) url.pathname = isStudioHost(url.hostname) ? (studioPathOf(cleanPath(url.pathname, url.hostname)) ?? "/") : cleanPath(url.pathname, url.hostname);
  url.search = "";
  url.hash = "";
  // A relative input (an href attribute) stays relative.
  return raw.startsWith("/") && own ? url.pathname : url.toString();
}

const URL_KEY = /(url|referrer|href)$/i;
const PATH_KEY = /pathname$/i;
const TITLE_KEY = /^(\$?title|page_title)$/;

/**
 * Whether this URL needs nothing redacted (or only a Guides site id, lib/analyticsPath
 * isRecordable): the only kind replay may see.
 */
export function urlIsClean(href: string): boolean {
  try {
    const u = new URL(href);
    if (u.hash && u.hash !== "#") return false;
    return isRecordable(analyticsRoute(u.pathname, u.hostname), u.searchParams.keys()) && !u.pathname.startsWith("/admin");
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
    return host + cleanPath(path, "markdrop.in"); // markdrop.in or localhost: never the studio host
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
  // An encrypted document's page sends nothing at all, not even sanitised.
  if (encryptedPause || onEncryptedPage()) return null;
  // Document titles are the documents' own words; only app pages keep theirs.
  const route = analyticsRoute(path);
  const titleSafe = cleanPath(route) === route;
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
      scrubStoredHashesBeforeInit();
      posthog.init(POSTHOG_KEY, {
        api_host: POSTHOG_PROXY,
        ui_host: POSTHOG_UI_HOST,
        defaults: "2026-05-30",
        // Never keep the part of an address after # (an encrypted document's key, #k=…): without
        // this, these defaults store the first page's full URL in PostHog's cookie and send it with
        // every flags request (neither passes through before_send).
        disable_capture_url_hashes: true,
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
      scrubStoredHashes(posthog);
      // Builds before this one registered doc context as super properties; clear any leftovers.
      for (const k of ["doc_ref", "doc_kind", "doc_access"]) posthog.unregister(k);
      if (m === "full" && !posthog.has_opted_in_capturing()) posthog.opt_in_capturing();
      for (const [name, props] of queued.splice(0)) posthog.capture(name, props);
      return posthog;
    })
    .catch(() => null);
  return loading;
}

/** Any URL-looking string with a # part (an encrypted document's key), minus that part. */
function dropHashes(v: unknown): unknown {
  if (typeof v === "string") return /^https?:\/\//.test(v) && v.includes("#") ? v.slice(0, v.indexOf("#")) : v;
  if (Array.isArray(v)) return v.map(dropHashes);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dropHashes(x)]));
  return v;
}

/**
 * Browsers that visited before disable_capture_url_hashes kept their first page's full URL
 * (`$initial_person_info`, the session's entry URL) in PostHog's storage and cookie: rewrite
 * those without the # part.
 */
function scrubStoredHashes(posthog: PostHog) {
  try {
    const stores = posthog as unknown as Record<string, { props?: Record<string, unknown>; save?: () => void } | undefined>;
    for (const name of ["persistence", "sessionPersistence"]) {
      const store = stores[name];
      if (!store?.props) continue;
      let changed = false;
      for (const [k, v] of Object.entries(store.props)) {
        const clean = dropHashes(v);
        if (JSON.stringify(clean) !== JSON.stringify(v)) {
          store.props[k] = clean;
          changed = true;
        }
      }
      if (changed) store.save?.();
    }
  } catch {
    /* analytics must never break the page */
  }
}

/**
 * The same, before PostHog starts (its first requests go out during init): the localStorage copy
 * is rewritten without # parts, and a cookie holding one is deleted (PostHog rebuilds it from
 * localStorage, which keeps the same ids).
 */
function scrubStoredHashesBeforeInit() {
  const name = `ph_${POSTHOG_KEY}_posthog`;
  try {
    const raw = localStorage.getItem(name);
    if (raw?.includes("#")) localStorage.setItem(name, JSON.stringify(dropHashes(JSON.parse(raw))));
  } catch {
    /* storage blocked or unreadable */
  }
  try {
    const cookie = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`));
    if (cookie && decodeURIComponent(cookie.slice(name.length + 1)).includes("#")) {
      const expire = `${name}=; path=/; max-age=0`;
      document.cookie = expire;
      const parts = window.location.hostname.split(".");
      for (let i = 0; i < parts.length - 1; i++) document.cookie = `${expire}; domain=.${parts.slice(i).join(".")}`;
    }
  } catch {
    /* cookies blocked */
  }
}

/** The address carries an encrypted document's key (#k=…): no third-party script runs on it. */
export function hasDocumentKey(hash: string): boolean {
  return /(^#|&)k=/.test(hash);
}

/**
 * This page shows (or is about to show) an end-to-end encrypted document: a key in the address,
 * the server-rendered `data-md-e2e` marker (there even when the key came from this browser's
 * store, or isn't here at all), or the viewer's own report. Synchronous, so it can decide before
 * anything loads.
 */
export function onEncryptedPage(): boolean {
  if (typeof window === "undefined") return false;
  if (hasDocumentKey(window.location.hash)) return true;
  if (doc?.access === "encrypted") return true;
  try {
    return !!document.querySelector("[data-md-e2e]");
  } catch {
    return false;
  }
}

/** Entering or leaving an encrypted document after analytics loaded: pause or resume everything. */
function applyEncryptedPause() {
  const on = onEncryptedPage();
  if (on === encryptedPause) return;
  encryptedPause = on;
  const w = window as unknown as Record<string, unknown>;
  if (on) {
    try {
      if (ph?.sessionRecordingStarted()) ph.stopSessionRecording();
    } catch {
      /* replay must never break the page */
    }
    if (gaLoaded && GA_ID) w[`ga-disable-${GA_ID}`] = true;
  } else {
    if (gaLoaded && GA_ID && mode === "full") w[`ga-disable-${GA_ID}`] = false;
    syncRecording();
  }
}

function syncRecording() {
  if (!ph) return;
  const on = mode === "full" && urlIsClean(window.location.href) && !onEncryptedPage();
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
// The link_* parameters of outbound clicks name where a link inside a document points.
const GA_DROP = new Set([
  "ep.link_text", "ep.file_name", "ep.search_term", "ep.form_name", "ep.form_id",
  "ep.link_url", "ep.link_domain", "ep.link_id", "ep.link_classes", "ep.file_extension",
]);
const GA_TITLE = new Set(["dt", "ep.page_title"]);

/** Clean one GA4 hit (a query string, or one line of a batched body). */
function cleanGaParams(qs: string): string {
  const params = new URLSearchParams(qs);
  const loc = params.get("dl");
  const here = analyticsRoute(window.location.pathname);
  const dirty = loc ? cleanUrl(loc) !== loc.split(/[?#]/)[0] : cleanPath(here) !== here;
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
      if (onEncryptedPage()) return true; // dropped: GA's own history listener fires on arrival
      const body = typeof data === "string" ? data.split("\n").map((l) => (l ? cleanGaParams(l) : l)).join("\n") : data;
      return beacon(cleanGaUrl(u), body);
    };
  }
  const realFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!isGaHit(u)) return realFetch(input, init);
    if (onEncryptedPage()) return Promise.resolve(new Response(null, { status: 204 }));
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
  // Nothing loads on an encrypted document's page (owner decision 2). Remember the choice and
  // start on the first page that isn't one.
  if (mode === null && onEncryptedPage()) {
    deferredMode = m;
    return;
  }
  deferredMode = null;
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
  if (currentPath === null) onRoute(analyticsRoute(window.location.pathname));
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
  if (isRecordable(pathname) && !pathname.startsWith("/admin")) return;
  try {
    if (ph.sessionRecordingStarted()) ph.stopSessionRecording();
  } catch {
    /* replay must never break the page */
  }
}

/** Every route change (ThirdPartyAnalytics calls it with usePathname). */
export function onRoute(pathname: string) {
  if (!enabled()) return;
  if (mode === null) {
    // Opened on an encrypted document, now somewhere else: start as consent said.
    if (deferredMode && !onEncryptedPage()) void startThirdParty(deferredMode);
    return;
  }
  applyEncryptedPause();
  if (pathname === currentPath) return;
  currentPath = pathname;
  if (pendingDocView) clearTimeout(pendingDocView);
  syncRecording();
  if (pathname.startsWith("/admin")) return;
  // On a document, wait briefly for the viewer to say which document it is.
  if (!isRecordable(pathname) && !doc) pendingDocView = setTimeout(pageview, 2500);
  else pageview();
}

/** The viewer reports the open document (or null when it closes). */
export function setAnalyticsDoc(next: DocContext | null) {
  doc = next;
  if (mode !== null) applyEncryptedPause();
  else if (!next && deferredMode && !onEncryptedPage()) void startThirdParty(deferredMode);
  if (next && pendingDocView) {
    clearTimeout(pendingDocView);
    pageview();
  }
}

/**
 * A product event, mirrored from lib/track (whose props are already free of slugs and titles).
 * `ga: false` keeps it to PostHog (fine-grained events GA has no use for, like read_progress).
 */
export function captureThirdParty(name: string, props?: Props, opts?: { ga?: boolean }) {
  if (!enabled() || mode === null) return;
  if (ph) ph.capture(name, props);
  else queued.push([name, props]);
  if (opts?.ga !== false && gaLoaded && window.gtag) window.gtag("event", name, props ?? {});
}

/** What this browser last identified as, so a page load doesn't re-send it (each is a billable $set). */
const IDENT_KEY = "md_ph_ident";

function storedIdent(): string | null {
  try {
    return localStorage.getItem(IDENT_KEY);
  } catch {
    return null;
  }
}

/** Sign-in: link this browser's history to the account. Limited mode never identifies. */
export function identifyUser(user: User) {
  if (!enabled()) return;
  // Auth usually resolves before analytics has started; apply it once it has.
  pendingUser = user;
  if (mode !== "full") return;
  void loadPostHog(mode).then((p) => {
    if (!p) return;
    const sig = `${user.id}|${user.email}|${user.name ?? ""}`;
    if (p.get_distinct_id() === user.id && storedIdent() === sig) return;
    p.identify(user.id, { email: user.email, name: user.name ?? undefined }, { signed_up_at: user.created_at });
    try {
      localStorage.setItem(IDENT_KEY, sig);
    } catch {
      /* storage blocked: identify again next time */
    }
  });
  if (gaLoaded && window.gtag) window.gtag("set", { user_id: user.id });
}

/** Sign-out: a fresh anonymous identity, so the next person on this browser isn't merged in. */
export function resetIdentity() {
  pendingUser = null;
  try {
    localStorage.removeItem(IDENT_KEY);
  } catch {
    /* storage blocked */
  }
  ph?.reset();
}
