// Markdrop as an installed app: where the worker registers, the install paths, and the service
// worker itself run in a sandbox. Run: node --test src/lib/pwa.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { installPathFor, isAppRoute, pwaSurface } from "./pwa.ts";
import { serviceWorkerSource } from "./pwaWorker.ts";

test("pwaSurface: Markdrop, the Guides studio, or neither", () => {
  assert.equal(pwaSurface("markdrop.in"), "app");
  assert.equal(pwaSurface("www.markdrop.in"), "app");
  assert.equal(pwaSurface("localhost:3730"), "app");
  assert.equal(pwaSurface("127.0.0.1"), "app");
  assert.equal(pwaSurface("guides.markdrop.in"), "studio");
  assert.equal(pwaSurface("guides.localhost:3000"), "studio");
  for (const h of ["docs.markdrop.in", "docs.acme.com", "help.acme.com", "markdrop-git-x.vercel.app", "", null, "evilmarkdrop.in"]) {
    assert.equal(pwaSurface(h), null, String(h));
  }
});

test("isAppRoute: app screens yes; landing pages and documents no", () => {
  for (const p of ["/dashboard", "/dashboard/analytics", "/settings/account", "/pages/new", "/pages/abc", "/w/123/f/1", "/search", "/login", "/new", "/upload", "/admin", "/guides/home", "/guides/6650f2c4a1b2c3d4e5f60718/fixes"]) {
    assert.equal(isAppRoute(p, "app"), true, p);
  }
  for (const p of ["/", "/enterprise", "/mcp", "/privacy", "/guides", "/guides/", "/my-doc", "/f/abc", "/share/xyz", "/h/x"]) {
    assert.equal(isAppRoute(p, "app"), false, p);
  }
  assert.equal(isAppRoute("/", "studio"), true);
  assert.equal(isAppRoute("/new", "studio"), true);
});

test("installPathFor: prompt, iOS, Safari on a Mac, or nothing", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const IPAD_DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  const MAC_SAFARI = IPAD_DESKTOP;
  const MAC_SAFARI_16 = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15";
  const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";
  assert.equal(installPathFor(CHROME_MAC, 0, true), "prompt");
  assert.equal(installPathFor(IPHONE, 5), "ios");
  assert.equal(installPathFor(IPAD_DESKTOP, 5), "ios");
  assert.equal(installPathFor(MAC_SAFARI, 0), "mac-safari");
  assert.equal(installPathFor(MAC_SAFARI_16, 0), null);
  assert.equal(installPathFor(CHROME_MAC, 0, false), null);
  assert.equal(installPathFor(FIREFOX, 0), null);
});

/* ── The service worker, in a sandbox ─────────────────────────────────── */

const ORIGIN = "https://markdrop.in";

function fakeCaches() {
  const stores = new Map();
  const keyOf = (r) => (typeof r === "string" ? new URL(r, ORIGIN).href : r.url);
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      match: async (r) => m.get(keyOf(r))?.clone(),
      put: async (r, res) => void m.set(keyOf(r), res),
      add: async (r) => void m.set(keyOf(r), new Response(`cached ${keyOf(r)}`)),
      addAll: async (rs) => rs.forEach((r) => m.set(keyOf(r), new Response(`cached ${keyOf(r)}`))),
      keys: async () => [...m.keys()].map((k) => new Request(k)),
      delete: async (r) => m.delete(keyOf(r)),
    };
  };
  return { stores, api: { open, keys: async () => [...stores.keys()], delete: async (n) => stores.delete(n) } };
}

function loadWorker({ online = true } = {}) {
  const listeners = {};
  const fetched = [];
  const caches = fakeCaches();
  const state = { online, claimed: false, skipped: false };
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (t, fn) => (listeners[t] = fn),
    registration: { navigationPreload: { enable: async () => {} } },
    clients: { claim: async () => void (state.claimed = true) },
    skipWaiting: () => void (state.skipped = true),
  };
  const fetchFn = async (req) => {
    fetched.push(req.url);
    if (!state.online) throw new TypeError("Failed to fetch");
    return new Response(`net ${req.url}`, { status: 200 });
  };
  // A same-origin network response is "basic"; Node's Response is "default", so mark it.
  const ctx = vm.createContext({
    self, caches: caches.api, URL, Promise, console,
    // The worker's relative URLs resolve against its origin, as in a browser.
    Request: class extends Request { constructor(u, init) { super(typeof u === "string" ? new URL(u, ORIGIN) : u, init); } },
    Response: class extends Response { get type() { return "basic"; } static error() { return Response.error(); } },
    fetch: async (r) => { const res = await fetchFn(r); return Object.defineProperty(res, "type", { value: "basic" }); },
  });
  vm.runInContext(serviceWorkerSource("build-123"), ctx);
  /** Dispatch a fetch: undefined when the worker lets it through, else its response. */
  const dispatch = async (url, init = {}, mode = "cors") => {
    const request = new Request(new URL(url, ORIGIN), init);
    Object.defineProperty(request, "mode", { value: mode });
    let responded;
    const waits = [];
    listeners.fetch({ request, respondWith: (p) => (responded = p), waitUntil: (p) => waits.push(p), preloadResponse: Promise.resolve(undefined) });
    const res = responded ? await responded : undefined;
    await Promise.all(waits);
    return res;
  };
  const lifecycle = async (type) => {
    const waits = [];
    listeners[type]({ waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  return { listeners, fetched, caches, state, dispatch, lifecycle };
}

test("worker: the build id is written in and sanitised", () => {
  const src = serviceWorkerSource("dpl_ABC123");
  assert.match(src, /var VERSION = "dpl_ABC123";/);
  assert.doesNotMatch(src, /__MARKDROP_BUILD__/);
  assert.match(serviceWorkerSource('x";alert(1);"'), /var VERSION = "xalert1";/);
  assert.notEqual(serviceWorkerSource("a"), serviceWorkerSource("b"));
});

test("worker: install precaches the offline page; activate claims and drops old caches", async () => {
  const w = loadWorker();
  w.caches.stores.set("md-shell-old", new Map());
  w.caches.stores.set("someone-else", new Map());
  await w.lifecycle("install");
  assert.ok(w.caches.stores.get("md-shell-build-123").has(`${ORIGIN}/offline.html`));
  await w.lifecycle("activate");
  assert.equal(w.state.claimed, true);
  assert.equal(w.caches.stores.has("md-shell-old"), false);
  assert.equal(w.caches.stores.has("someone-else"), true);
  assert.equal(w.state.skipped, false, "an update waits for Reload");
});

test("worker: build assets are cache-first", async () => {
  const w = loadWorker();
  const a = await w.dispatch("/_next/static/chunks/app-abc123.js");
  assert.equal(await a.text(), `net ${ORIGIN}/_next/static/chunks/app-abc123.js`);
  const b = await w.dispatch("/_next/static/chunks/app-abc123.js");
  assert.ok(b);
  assert.equal(w.fetched.length, 1, "second read comes from the cache");
  for (const p of ["/icons/icon-192.png", "/icon.svg", "/apple-icon.png", "/_next/static/media/font.woff2"]) assert.ok(await w.dispatch(p), p);
});

test("worker: API, analytics, RSC, streams, uploads, ranges and other origins pass through untouched", async () => {
  const w = loadWorker();
  const through = [
    ["/api/geo"],
    ["/mdp/e/"],
    ["/dashboard?_rsc=1x2y"],
    ["/manifest.webmanifest"],
    ["/sw.js"],
    ["https://api.markdrop.in/api/v1/me"],
    ["https://files.markdrop.in/x.pdf"],
    ["/_next/static/chunks/a.js", { method: "POST", body: "x" }],
    ["/_next/static/media/v.mp4", { headers: { range: "bytes=0-" } }],
  ];
  for (const [url, init] of through) assert.equal(await w.dispatch(url, init), undefined, url);
  assert.equal(w.fetched.length, 0);
  assert.equal(w.caches.stores.get("md-static-v1"), undefined, "nothing was cached");
});

test("worker: page loads go to the network, never cached; offline shows the offline page", async () => {
  const w = loadWorker();
  await w.lifecycle("install");
  const res = await w.dispatch("/dashboard", {}, "navigate");
  assert.equal(await res.text(), `net ${ORIGIN}/dashboard`);
  const again = await w.dispatch("/dashboard", {}, "navigate");
  assert.equal(await again.text(), `net ${ORIGIN}/dashboard`);
  assert.equal(w.fetched.length, 2, "every page load reaches the network");
  for (const [name, store] of w.caches.stores) for (const k of store.keys()) assert.doesNotMatch(k, /dashboard/, `${name} stored a page`);
  w.state.online = false;
  const off = await w.dispatch("/settings/account", {}, "navigate");
  assert.equal(await off.text(), `cached ${ORIGIN}/offline.html`);
});

test("worker: answers its version and skips waiting only when told", async () => {
  const w = loadWorker();
  let answered;
  w.listeners.message({ data: { type: "VERSION" }, ports: [{ postMessage: (v) => (answered = v) }] });
  assert.equal(answered, "build-123");
  assert.equal(w.state.skipped, false);
  w.listeners.message({ data: { type: "SKIP_WAITING" } });
  assert.equal(w.state.skipped, true);
});
