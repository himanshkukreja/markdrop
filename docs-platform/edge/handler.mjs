/**
 * The docs edge: one fetch handler that serves every published site from the object store.
 * Runs as the Cloudflare Worker (edge/worker.mjs, store = R2) and inside the self-host server
 * (server/server.mjs, store = a folder). Bundled by builder/bundle.mjs.
 *
 * Per request: hostname → site (hosts/<host>.json, cached) → pointer (sites/<site>/current.json,
 * cached a few seconds) → manifest (immutable, cached by hash) → one object read. Routing reuses
 * the frontend's own middleware logic (src/docs/host.ts: docsRewritePath, Accept negotiation), so
 * an address means the same thing here as on docs.markdrop.in:
 *
 *   /_next/static/*                      framework chunks (immutable)
 *   pass-through paths (/docs-assets/…)  the site's files (Range supported, for video), with
 *                                        nosniff and a sandboxing CSP (fileHeaders): an HTML,
 *                                        XML or SVG file never runs as a page of the site
 *   everything else                      the engine's route: HTML, or its RSC payload for the
 *                                        client router (`RSC: 1`), or the Markdown twin
 *                                        (`.md` / `Accept: text/markdown`), text outputs, OG cards
 *   /mcp                                 the docs MCP server (the engine's route, run here)
 *   /api/geo                             the consent banner's country check (the app's route)
 *   no match                             redirects.json, else the engine's 404 page
 *
 * A Markdrop Guides site with Insights on (manifest site.insights) also has each page view counted:
 * one POST to the API after the response is sent (insights.mjs). Nothing runs in the browser for it.
 *
 * A password or members-only site (sites/<site>/access.json, see access.mjs) answers every one of
 * those only to a browser with its session cookie: anything else gets the branded sign-in page
 * (a navigation) or a bare 401, and /_access/* runs the sign-in. Its responses are
 * `private, no-store` and noindex, and its objects never go into the colo cache.
 */
import { docsRewritePath, DOCS_INTERNAL } from "@/docs/host";
import { normalizeHost } from "@/components/tenant/hosts";
import { GET as geoGET } from "@/app/api/geo/route";
import { createMcpEngine } from "./dist/mcp-engine.mjs";
import {
  SECRET_MIN, SESSION_COOKIE, SESSION_TTL, STATE_COOKIE, STATE_TTL, brandFiles, b64url, callbackPage, cookie, gatePage,
  grantProblem, mintSession, newState, parseCookies, parsePolicy, privatePage, safeNext, sessionValid, stateHash, validState,
} from "./access.mjs";
import { agentVia, isPageView, sendAgent, sendView } from "./insights.mjs";
import { READER_COOKIE, READER_TTL, aiToken, allowed, allowedRules, lockPage, mergeReader, mintReader, parseReaders, readerGrant, readerOf } from "./readers.mjs";

const RSC_VARY = "RSC, Next-Router-State-Tree, Next-Router-Prefetch, Next-Router-Segment-Prefetch, Accept";
const MCP_ROUTE = `${DOCS_INTERNAL}/mcp`;

const CACHE = {
  immutable: "public, max-age=31536000, immutable",
  page: "public, max-age=0, must-revalidate",
  file: "public, max-age=3600",
  notFound: "public, max-age=60",
};

/** A tiny LRU (Map keeps insertion order). */
class Lru {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }
  get(k) {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k, v) {
    this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}

function text(body, status, extra = {}) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra } });
}

function html(body, status, extra = {}) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extra } });
}

/** Every response of a non-public site: never stored by a browser or a shared cache, never indexed. */
function privateResponse(res) {
  const out = new Response(res.body, res);
  out.headers.set("cache-control", "private, no-store");
  out.headers.set("x-robots-tag", "noindex, nofollow");
  if (!out.headers.has("referrer-policy")) out.headers.set("referrer-policy", "same-origin");
  return out;
}

/** Every response of a public site with search indexing off (manifest site.noindex): readable, not indexed. */
function noindexResponse(res) {
  const out = new Response(res.body, res);
  out.headers.set("x-robots-tag", "noindex");
  return out;
}

/**
 * A page's Content-Security-Policy (manifest site.frames, from builder/build.mjs frameOrigins): it
 * may frame only itself, Markdrop's artifact origin (`::markdrop` blocks, which put author HTML in
 * an opaque sandbox there) and the site's embed hosts; no plugins. Nothing else is restricted
 * here (the engine's scripts, styles, fonts and API calls are unchanged). A manifest from before
 * frames existed gets no header.
 */
export function pageCsp(site) {
  if (!Array.isArray(site?.frames)) return null;
  const frames = site.frames.filter((f) => typeof f === "string" && /^https?:\/\/[^\s;,'"]+$/.test(f));
  return `frame-src 'self' ${frames.join(" ")}`.trim() + "; object-src 'none'";
}

/** The sandboxing policy of a site file: nothing loads, nothing runs, no origin (an SVG still works as an <img>). */
export const FILE_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'; sandbox";

/**
 * Headers every site file (anything the manifest lists outside /_next/) is served with, set over
 * whatever the build recorded. A site file is uploaded or imported content, served from the site's
 * own origin: the browser must never sniff it into something else, and a document type (HTML, any
 * XML, SVG) must never run there as a page. HTML and XML are downloads outright; SVG keeps working
 * as an image. A PDF gets no CSP: Chrome's viewer refuses a sandboxed PDF (it runs no script of
 * the origin anyway).
 */
export function fileHeaders(type) {
  const base = String(type || "").split(";")[0].trim().toLowerCase();
  const h = { "x-content-type-options": "nosniff" };
  if (base !== "application/pdf") h["content-security-policy"] = FILE_CSP;
  const xml = base === "text/xml" || base === "application/xml" || (base.endsWith("+xml") && base !== "image/svg+xml");
  if (base === "text/html" || base === "application/xhtml+xml" || xml) h["content-disposition"] = "attachment";
  return h;
}

/** `bytes=a-b` → {offset, length} within size, or null (whole body), or false (unsatisfiable). */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start;
  let end;
  if (m[1] === "") {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return false;
  return { offset: start, length: end - start + 1 };
}

/**
 * store: { getText(key) → string|null, getObject(hash, range?) → {body, size}|null }
 * options.fixedSite: serve this site on every hostname (self-host); otherwise hosts/<host>.json.
 * options.pointerTtlMs: how long an isolate trusts the pointer it read (publish → live delay).
 * options.onServe(info): observer for request accounting (tests, logs).
 * options.access: { secret, apiOrigin, appOrigin } for password and members-only sites (the Worker's
 *   DOCS_ACCESS_SECRET, MARKDROP_API_ORIGIN, MARKDROP_APP_ORIGIN). Without a secret such a site
 *   answers only "private" (it is never served open).
 * options.insights: false turns page-view counting off (the Worker's INSIGHTS = "off"); it also
 *   needs access.secret (the edge key is derived from it). options.fetch: the fetch it sends with.
 */
export function createHandler(store, options = {}) {
  const pointerTtl = options.pointerTtlMs ?? 5000;
  const hostTtl = options.hostTtlMs ?? 60_000;
  const hosts = new Map();
  const pointers = new Map();
  const policies = new Map();
  const accessCfg = options.access || {};
  const secret = typeof accessCfg.secret === "string" && accessCfg.secret.length >= SECRET_MIN ? accessCfg.secret : null;
  const apiOrigin = String(accessCfg.apiOrigin || "https://api.markdrop.in").replace(/\/+$/, "");
  const appOrigin = String(accessCfg.appOrigin || "https://markdrop.in").replace(/\/+$/, "");
  /* Requests of a non-public site: their objects skip the colo cache. */
  const privateReqs = new WeakSet();
  const manifests = new Lru(16);
  const engines = new Lru(8);
  /* The Worker ctx of each request, for the store's waitUntil (cache writes). */
  const ctxOf = new WeakMap();
  const insightsOn = options.insights !== false && !!secret;
  const fetchFn = options.fetch || ((...a) => fetch(...a));

  /** A Markdrop Guides site's page view, counted after the response (insights.mjs). */
  function countView(req, url, site, m) {
    if (!insightsOn || !m.site?.insights || !isPageView(req)) return;
    options.onServe?.({ kind: "view", status: 0, size: 0 });
    sendView({ req, url, site, apiOrigin, secret, ctx: ctxOf.get(req), fetchFn });
  }

  /** An agent read of a machine-readable output (a Markdown twin, llms.txt, MCP), after the response. */
  function countAgent(req, url, site, m, via) {
    if (!insightsOn || !m.site?.insights || !via) return;
    sendAgent({ req, url, site, apiOrigin, secret, via, ctx: ctxOf.get(req), fetchFn });
  }

  async function siteFor(host) {
    if (options.fixedSite) return options.fixedSite;
    const hit = hosts.get(host);
    if (hit && Date.now() - hit.at < hostTtl) return hit.site;
    const raw = await store.getText(`hosts/${host}.json`);
    const site = raw ? JSON.parse(raw).site : null;
    hosts.set(host, { site, at: Date.now() });
    return site;
  }

  async function manifestFor(site) {
    let ptr = pointers.get(site);
    if (!ptr || Date.now() - ptr.at > pointerTtl) {
      const raw = await store.getText(`sites/${site}/current.json`);
      ptr = { hash: raw ? JSON.parse(raw).manifest : null, at: Date.now() };
      pointers.set(site, ptr);
    }
    if (!ptr.hash) return null;
    let m = manifests.get(ptr.hash);
    if (!m) {
      const raw = await store.getText(`manifests/${ptr.hash}.json`);
      if (!raw) return null;
      m = JSON.parse(raw);
      m.hash = ptr.hash;
      m.redirectMap = new Map(m.redirects.map((r) => [r.from, r]));
      manifests.set(ptr.hash, m);
    }
    return m;
  }

  /** sites/<site>/access.json, trusted as long as the pointer. A read error throws (500): never open. */
  async function policyFor(site) {
    return (await accessFor(site)).policy;
  }

  /** The site-wide policy and the private pages' rules (readers.mjs), from the one object. */
  async function accessFor(site) {
    let hit = policies.get(site);
    if (!hit || Date.now() - hit.at > pointerTtl) {
      const raw = await store.getText(`sites/${site}/access.json`);
      hit = { policy: parsePolicy(raw), readers: parseReaders(raw), at: Date.now() };
      policies.set(site, hit);
    }
    return hit;
  }

  /** Serve one object with its type and headers; ETag is the object hash. */
  async function serve(req, entry, { type, cache, status = 200, headers = {}, locked = {}, range = false, kind }) {
    const etag = `"${entry.o}"`;
    const h = new Headers({ "content-type": type, "cache-control": cache, etag, ...headers, ...(entry.h || {}), ...locked });
    if (range) h.set("accept-ranges", "bytes");
    options.onServe?.({ kind, status, size: entry.s });
    if (status === 200 && req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: h });
    let r = null;
    if (range && req.headers.has("range")) {
      r = parseRange(req.headers.get("range"), entry.s);
      if (r === false) {
        h.set("content-range", `bytes */${entry.s}`);
        return new Response(null, { status: 416, headers: h });
      }
    }
    if (req.method === "HEAD") {
      h.set("content-length", String(r ? r.length : entry.s));
      return new Response(null, { status: r ? 206 : status, headers: h });
    }
    const obj = await store.getObject(entry.o, r || undefined, ctxOf.get(req), { cache: !privateReqs.has(req) });
    if (!obj) return text("Object missing\n", 502);
    if (r) {
      h.set("content-range", `bytes ${r.offset}-${r.offset + r.length - 1}/${entry.s}`);
      h.set("content-length", String(r.length));
      return new Response(obj.body, { status: 206, headers: h });
    }
    h.set("content-length", String(entry.s));
    return new Response(obj.body, { status, headers: h });
  }

  function notFound(req, m) {
    if (!m.notFound) return text("Not found\n", 404);
    return serve(req, m.notFound, { type: m.notFound.t, cache: CACHE.notFound, status: 404, kind: "404" });
  }

  async function mcp(req, site, m, ctx) {
    let engine = engines.get(m.hash);
    if (!engine) {
      const obj = await store.getObject(m.mcp.o, undefined, ctx, { cache: !privateReqs.has(req) });
      if (!obj) return text("MCP data missing\n", 502);
      const snap = JSON.parse(await new Response(obj.body).text());
      const hooks = { after: (task) => void Promise.resolve().then(task).catch(() => {}) };
      engine = { route: createMcpEngine(snap.files, hooks).route, hooks };
      engines.set(m.hash, engine);
    }
    if (ctx?.waitUntil) engine.hooks.after = (task) => ctx.waitUntil(Promise.resolve().then(task).catch(() => {}));
    options.onServe?.({ kind: "mcp", status: 200, size: 0 });
    if (req.method === "POST") countAgent(req, new URL(req.url), site, m, "mcp");
    const fn = engine.route[req.method];
    if (typeof fn !== "function") return text("Method not allowed\n", 405, { allow: "POST, GET, DELETE, OPTIONS" });
    return fn(req);
  }

  /* ── password and members-only sites ─────────────────────────────── */

  /** The sign-in page, with this browser's state (kept, or a new one) in its HttpOnly cookie. */
  async function signIn(req, url, site, m, policy, { next, error = null, status = 401 }) {
    let state = parseCookies(req.headers.get("cookie")).get(STATE_COOKIE);
    if (!validState(state)) state = newState();
    const body = gatePage({ manifest: m, policy, site, host: url.host.toLowerCase(), next, state: await stateHash(state), error, apiOrigin, appOrigin });
    const csp = `default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; form-action 'self' ${apiOrigin}; frame-ancestors 'none'; base-uri 'none'`;
    options.onServe?.({ kind: "gate", status, size: 0 });
    return html(req.method === "HEAD" ? null : body, status, { "content-security-policy": csp, "set-cookie": cookie(STATE_COOKIE, state, STATE_TTL) });
  }

  /** /_access/*: the sign-in steps of a non-public site. */
  async function accessRoute(req, url, site, m, policy) {
    const path = url.pathname;
    if (path === "/_access/callback" && (req.method === "GET" || req.method === "HEAD")) {
      const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
      const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;
      // same-origin, not no-referrer: under no-referrer the browser sends `Origin: null` on the POST it makes.
      return html(callbackPage(nonce), 200, { "content-security-policy": csp, "referrer-policy": "same-origin" });
    }
    if (path === "/_access/login" && (req.method === "GET" || req.method === "HEAD")) {
      return signIn(req, url, site, m, policy, { next: safeNext(url.searchParams.get("next")), error: url.searchParams.get("e") });
    }
    if (path === "/_access/session" && req.method === "POST") {
      const origin = req.headers.get("origin");
      if (origin && origin !== url.origin) return text("Cross-site sign-in refused.\n", 403);
      if (Number(req.headers.get("content-length") || 0) > 16384) return text("Too large.\n", 413);
      let form;
      try {
        form = await req.formData();
      } catch {
        return text("Bad request.\n", 400);
      }
      const next = safeNext(String(form.get("next") || "/"));
      const state = parseCookies(req.headers.get("cookie")).get(STATE_COOKIE);
      const problem = await grantProblem(secret, String(form.get("g") || ""), { site, host: url.host.toLowerCase(), policy, state });
      if (problem) return signIn(req, url, site, m, policy, { next, error: problem, status: 403 });
      const h = new Headers({ location: next, "cache-control": "no-store" });
      h.append("set-cookie", cookie(SESSION_COOKIE, await mintSession(secret, site, policy), SESSION_TTL));
      h.append("set-cookie", cookie(STATE_COOKIE, "", 0));
      options.onServe?.({ kind: "signin", status: 303, size: 0 });
      return new Response(null, { status: 303, headers: h });
    }
    if (path === "/_access/logout" && (req.method === "GET" || req.method === "POST")) {
      const h = new Headers({ location: "/", "cache-control": "no-store" });
      h.append("set-cookie", cookie(SESSION_COOKIE, "", 0));
      h.append("set-cookie", cookie(READER_COOKIE, "", 0));
      return new Response(null, { status: 303, headers: h });
    }
    if (m.access) return readerRoute(req, url, site, m);
    return text("Not found\n", 404);
  }

  /* ── private pages and sections (readers.mjs) ────────────────────── */

  /** The reader of a request (cached on it) and the site's rules. */
  const readerCache = new WeakMap();
  async function readerFor(req, site) {
    let hit = readerCache.get(req);
    if (!hit) {
      const { readers } = await accessFor(site);
      hit = { readers, reader: await readerOf(secret, req, site, readers) };
      readerCache.set(req, hit);
    }
    return hit;
  }

  function isNavigation(req) {
    const accept = req.headers.get("accept") || "";
    return (req.method === "GET" || req.method === "HEAD") && req.headers.get("rsc") !== "1" && (req.headers.get("sec-fetch-dest") === "document" || accept.includes("text/html"));
  }

  /** The lock page for `ruleId` (with this browser's state cookie, kept or new), or a bare 401. */
  async function lockedResponse(req, url, site, m, ruleId, { next, message = null, status = 401, section = false }) {
    privateReqs.add(req);
    if (!isNavigation(req) && !url.pathname.startsWith("/_access/")) {
      options.onServe?.({ kind: "denied", status: 401, size: 0 });
      return text("This page is private. Open it in a browser to sign in.\n", 401, { "cache-control": "private, no-store" });
    }
    const { readers, reader } = await readerFor(req, site);
    let state = parseCookies(req.headers.get("cookie")).get(STATE_COOKIE);
    if (!validState(state)) state = newState();
    const body = lockPage({
      manifest: m, rule: readers.rules.get(ruleId), ruleId, reader, site, host: url.host.toLowerCase(), next, state: await stateHash(state), message,
      apiOrigin, appOrigin, section,
    });
    const csp = `default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; form-action 'self' ${apiOrigin}; frame-ancestors 'none'; base-uri 'none'`;
    options.onServe?.({ kind: "lock", status, size: 0 });
    return html(req.method === "HEAD" ? null : body, status, {
      "content-security-policy": csp, "set-cookie": cookie(STATE_COOKIE, state, STATE_TTL), "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow",
    });
  }

  /** The rule protecting a page address (its route's `a`), if any. */
  function ruleOfPath(m, pathname, accept) {
    const internal = docsRewritePath(pathname, accept || "text/html");
    return internal ? m.routes[internal]?.a : undefined;
  }

  /** /_access/{page,callback,reader,me}: the reader sign-in of a site with private pages. */
  async function readerRoute(req, url, site, m) {
    privateReqs.add(req);
    const path = url.pathname;
    const read = req.method === "GET" || req.method === "HEAD";
    if (!secret) return html(privatePage(m.site?.name || "Docs"), 503);
    if (path === "/_access/page" && read) {
      const next = safeNext(url.searchParams.get("next") || "/");
      const asked = url.searchParams.get("rule");
      const pageRule = ruleOfPath(m, next.split("?")[0]);
      const ruleId = pageRule || (asked && m.access.rules.includes(asked) ? asked : null);
      if (!ruleId) return new Response(null, { status: 303, headers: { location: next, "cache-control": "no-store" } });
      const { readers, reader } = await readerFor(req, site);
      // Already in (a section's rule, after signing in elsewhere): straight back.
      if (allowed(readers, reader, ruleId) && !url.searchParams.get("m")) return new Response(null, { status: 303, headers: { location: next, "cache-control": "no-store" } });
      return lockedResponse(req, url, site, m, ruleId, { next, message: url.searchParams.get("m"), status: 200, section: !pageRule });
    }
    if (path === "/_access/callback" && read) {
      const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
      const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;
      return html(callbackPage(nonce), 200, { "content-security-policy": csp, "referrer-policy": "same-origin" });
    }
    if (path === "/_access/reader" && req.method === "POST") {
      const origin = req.headers.get("origin");
      if (origin && origin !== url.origin) return text("Cross-site sign-in refused.\n", 403);
      if (Number(req.headers.get("content-length") || 0) > 16384) return text("Too large.\n", 413);
      let form;
      try {
        form = await req.formData();
      } catch {
        return text("Bad request.\n", 400);
      }
      const next = safeNext(String(form.get("next") || "/"));
      const { readers, reader } = await readerFor(req, site);
      const state = parseCookies(req.headers.get("cookie")).get(STATE_COOKIE);
      const res = await readerGrant(secret, String(form.get("g") || ""), { site, host: url.host.toLowerCase(), readers, state });
      const ruleId = ruleOfPath(m, next.split("?")[0]) || m.access.rules[0];
      if (res.problem) return lockedResponse(req, url, site, m, ruleId, { next, message: res.problem, status: 403 });
      const merged = mergeReader(reader, res.add);
      const h = new Headers({ location: next, "cache-control": "no-store" });
      h.append("set-cookie", cookie(READER_COOKIE, await mintReader(secret, site, readers, merged), READER_TTL));
      h.append("set-cookie", cookie(STATE_COOKIE, "", 0));
      options.onServe?.({ kind: "reader-signin", status: 303, size: 0 });
      return new Response(null, { status: 303, headers: h });
    }
    if (path === "/_access/logout" && (read || req.method === "POST")) {
      const h = new Headers({ location: safeNext(url.searchParams.get("next") || "/"), "cache-control": "no-store" });
      h.append("set-cookie", cookie(READER_COOKIE, "", 0));
      return new Response(null, { status: 303, headers: h });
    }
    if (path === "/_access/me" && read) {
      const { readers, reader } = await readerFor(req, site);
      const rules = allowedRules(readers, reader, m.access.rules);
      const body = JSON.stringify({
        signed_in: reader.signedIn, email: reader.e, member: reader.m, rules,
        ...(rules.length ? { ai_token: await aiToken(secret, site, rules) } : {}),
      });
      return new Response(req.method === "HEAD" ? null : body, { status: 200, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
    }
    return text("Not found\n", 404);
  }

  /** A response that depended on who the reader is: never stored by a browser or a shared cache. */
  function readerResponse(res) {
    const out = new Response(res.body, res);
    out.headers.set("cache-control", "private, no-store");
    if (!out.headers.has("referrer-policy")) out.headers.set("referrer-policy", "same-origin");
    return out;
  }

  /** A non-public site: the reader's session, or the sign-in page / a 401. */
  async function gated(req, url, site, m, policy, ctx) {
    if (!secret || policy.level === "locked") {
      options.onServe?.({ kind: "private", status: 503, size: 0 });
      return html(privatePage(m.site?.name || "Docs"), 503);
    }
    privateReqs.add(req);
    if (url.pathname.startsWith("/_access/")) return accessRoute(req, url, site, m, policy);
    if (url.pathname === "/robots.txt") return text("User-agent: *\nDisallow: /\n", 200);
    const session = parseCookies(req.headers.get("cookie")).get(SESSION_COOKIE);
    if (await sessionValid(secret, session, site, policy)) return route(req, url, site, m, ctx);
    const read = req.method === "GET" || req.method === "HEAD";
    let pathname = url.pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      /* not a brand file */
    }
    // The sign-in page's own logo and favicon.
    if (read && brandFiles(m).has(pathname)) return route(req, url, site, m, ctx);
    const accept = req.headers.get("accept") || "";
    const page = read && req.headers.get("rsc") !== "1" && (req.headers.get("sec-fetch-dest") === "document" || accept.includes("text/html"));
    if (!page) {
      options.onServe?.({ kind: "denied", status: 401, size: 0 });
      return text("This docs site is private. Open it in a browser to sign in.\n", 401);
    }
    return signIn(req, url, site, m, policy, { next: safeNext(url.pathname + url.search) });
  }

  /** The site's own routing (pages, payloads, files, /mcp, redirects, 404). */
  async function route(req, url, site, m, ctx) {
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return notFound(req, m);
    }
    if (pathname === "/api/geo") {
      // The app's own route, with Cloudflare's country in the header it reads on Vercel.
      const headers = new Headers(req.headers);
      const country = req.cf?.country || req.headers.get("cf-ipcountry");
      if (country) headers.set("x-vercel-ip-country", country);
      return geoGET(new Request(req.url, { headers }));
    }

    const internal = pathname.startsWith("/_next/") ? null : docsRewritePath(pathname, req.headers.get("accept"));
    if (internal === MCP_ROUTE) return mcp(req, site, m, ctx);
    if (req.method !== "GET" && req.method !== "HEAD") return text("Method not allowed\n", 405, { allow: "GET, HEAD" });

    if (internal === null) {
      const f = m.files[pathname];
      if (f) {
        const immutable = !!f.immutable;
        const fh = pathname.startsWith("/_next/") ? {} : fileHeaders(f.t);
        // A file only private content uses: for readers of any of its rules (readers.mjs).
        if (Array.isArray(f.a)) {
          const { readers, reader } = await readerFor(req, site);
          privateReqs.add(req);
          if (!f.a.some((id) => allowed(readers, reader, id))) {
            options.onServe?.({ kind: "denied", status: 401, size: 0 });
            return text("This file is private.\n", 401, { ...fileHeaders("text/plain"), "cache-control": "private, no-store" });
          }
          return readerResponse(await serve(req, f, { type: f.t, cache: CACHE.file, locked: fh, range: true, kind: "file" }));
        }
        return serve(req, f, { type: f.t, cache: immutable ? CACHE.immutable : CACHE.file, locked: fh, range: !immutable, kind: immutable ? "chunk" : "file" });
      }
    } else {
      let r = m.routes[internal];
      // A variant (a page with its private sections revealed) is never served at its own address.
      if (r?.variant) r = undefined;
      if (r) {
        let personal = false;
        // A private page (and its payload, .md twin, OG card): only for readers its rule lets in.
        if (r.a) {
          const { readers, reader } = await readerFor(req, site);
          if (!allowed(readers, reader, r.a)) return lockedResponse(req, url, site, m, r.a, { next: safeNext(url.pathname + url.search) });
          privateReqs.add(req);
          personal = true;
        }
        // A page with private sections: the variant this reader may see, else the public page.
        if (Array.isArray(r.sec) && r.sec.length) {
          const { readers, reader } = await readerFor(req, site);
          const set = allowedRules(readers, reader, r.sec);
          const v = set.length ? m.routes[`${DOCS_INTERNAL}/x-access/${[...set].sort().join(".")}${internal.slice(DOCS_INTERNAL.length)}`] : null;
          if (v) {
            privateReqs.add(req);
            r = v;
          }
          personal = true;
        }
        const out = personal ? readerResponse : (x) => x;
        const isPage = !!r.rsc;
        if (isPage && req.headers.get("rsc") === "1") {
          const v = (req.headers.get("next-router-prefetch") === "1" && r.prefetch) || r.rsc;
          return out(await serve(req, v, { type: "text/x-component", cache: CACHE.page, headers: { vary: RSC_VARY }, kind: "rsc" }));
        }
        // Text outputs keep the cache policy the engine gave them; pages revalidate by ETag.
        const cache = r.h?.["cache-control"] || CACHE.page;
        const csp = isPage ? pageCsp(m.site) : null;
        const res = await serve(req, r, { type: r.t, cache, headers: { vary: isPage ? RSC_VARY : "Accept", ...(csp ? { "content-security-policy": csp } : {}) }, kind: isPage ? "page" : r.t.startsWith("image/") ? "og" : "text" });
        if (isPage && (res.status === 200 || res.status === 304)) countView(req, url, site, m);
        else if (!isPage && req.method === "GET" && (res.status === 200 || res.status === 304)) countAgent(req, url, site, m, agentVia(internal, r.t));
        return out(res);
      }
    }

    const redirect = m.redirectMap.get(pathname) || m.redirectMap.get(pathname.replace(/\/+$/, "") || "/");
    if (redirect) {
      options.onServe?.({ kind: "redirect", status: redirect.status, size: 0 });
      return new Response(null, { status: redirect.status, headers: { location: redirect.to + url.search, "cache-control": CACHE.file } });
    }
    // A missing site file: the engine's plain 404 (src/app/docs-site/docs-assets), not a page.
    if (pathname.startsWith("/docs-assets/")) {
      options.onServe?.({ kind: "404", status: 404, size: 0 });
      return text("Not found", 404, fileHeaders("text/plain"));
    }
    return notFound(req, m);
  }

  return {
    async fetch(req, ctx) {
      ctxOf.set(req, ctx);
      const url = new URL(req.url);
      // The URL carries the hostname the client asked for (on Workers it is the Host header).
      const host = normalizeHost(url.host);
      const site = await siteFor(host);
      if (!site) return text("No docs site at this address.\n", 404);
      const [m, policy] = await Promise.all([manifestFor(site), policyFor(site)]);
      if (!m) return text("This site has not been published yet.\n", 404);
      if (policy.level === "public") {
        // Private pages' sign-in (readers.mjs); every other address is the site's own.
        const res = m.access && url.pathname.startsWith("/_access/") ? await readerRoute(req, url, site, m) : await route(req, url, site, m, ctx);
        return m.site?.noindex ? noindexResponse(res) : res;
      }
      return privateResponse(await gated(req, url, site, m, policy, ctx));
    },
  };
}
