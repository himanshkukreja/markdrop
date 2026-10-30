#!/usr/bin/env node
/**
 * Worker requests per page view: load a page in headless Chromium, let it idle (Next prefetches
 * links in view, or on hover since the engine prefetches on intent), scroll, open search, hover and
 * click a sidebar link, and read the request counters after each step. Also lists other origins the
 * page called (trackers, APIs).
 *
 * Two ways to count:
 *   - Against the Miniflare proxy (test/miniflare.mjs): its /__stats counters (every request it
 *     forwards is one Worker invocation).
 *       node test/pageview.mjs --origin http://markdrop.docs.localhost:3563 --path /cli/install
 *   - Against a deployed Worker (--live): the browser's own network log. A request counts when it
 *     left the browser (not served from its HTTP cache). It is a Worker invocation unless Workers
 *     Static Assets answered it; those responses lack the header the Worker sets on every response
 *     of a preview host (`--worker-header`, default x-robots-tag), and are counted as `assets`.
 *       node test/pageview.mjs --live --origin https://markdrop-docs-edge.markdrop-docs.workers.dev --path /cli/install
 *
 * Uses Playwright from the frontend's node_modules.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(HERE, "..", "..", "frontend", "package.json"));
const { chromium } = require("playwright");

const argv = process.argv.slice(2);
const live = argv.includes("--live");
const rest = argv.filter((a) => a !== "--live");
const args = Object.fromEntries(rest.reduce((a, v, i, arr) => (i % 2 ? a : [...a, [v.replace(/^--/, ""), arr[i + 1]]]), []));
const origin = args.origin;
const workerHeader = (args["worker-header"] || "x-robots-tag").toLowerCase();

const kindOf = (pathname, headers, status) => {
  if (pathname.startsWith("/_next/static/")) return "chunk";
  if (headers.rsc === "1") return headers["next-router-prefetch"] === "1" ? "rsc-prefetch" : "rsc";
  if (status === 404) return "404";
  if (pathname === "/mcp") return "mcp";
  if (pathname.startsWith("/docs-assets/")) return "file";
  if (pathname.startsWith("/og/")) return "og";
  if (/\.(json|txt|md|xml|rss)$/.test(pathname)) return "text";
  return "page";
};

const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const others = new Map();
page.on("request", (r) => {
  const u = new URL(r.url());
  if (u.origin !== origin) others.set(`${r.method()} ${u.origin}${u.pathname}`, (others.get(`${r.method()} ${u.origin}${u.pathname}`) || 0) + 1);
});

let stats, reset;
if (live) {
  // The browser's network log, through CDP: requestWillBeSent → responseReceived (fromDiskCache etc.)
  // or requestServedFromCache (memory cache).
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  const reqs = new Map();
  let counts = {};
  const add = (k, p) => {
    counts[k] = (counts[k] || 0) + 1;
    if (p) (counts[`${k}Paths`] ||= []).push(p);
  };
  cdp.on("Network.requestWillBeSent", (e) => {
    const u = new URL(e.request.url);
    if (u.origin !== origin) return;
    const h = Object.fromEntries(Object.entries(e.request.headers).map(([k, v]) => [k.toLowerCase(), v]));
    reqs.set(e.requestId, { url: u, headers: h, cached: false });
  });
  cdp.on("Network.requestServedFromCache", (e) => {
    const r = reqs.get(e.requestId);
    if (r) r.cached = true;
  });
  cdp.on("Network.responseReceived", (e) => {
    const r = reqs.get(e.requestId);
    if (!r) return;
    reqs.delete(e.requestId);
    const res = e.response;
    if (r.cached || res.fromDiskCache || res.fromPrefetchCache || res.fromServiceWorker || res.fromMemoryCache) return add("browserCache");
    const rh = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), v]));
    if (!(workerHeader in rh)) return add("assets", rh && res.status !== 200 ? `${res.status} ${r.url.pathname}` : undefined);
    const kind = kindOf(r.url.pathname, r.headers, res.status);
    add(kind, kind === "404" || kind === "text" || kind === "chunk" ? r.url.pathname : undefined);
    counts.total = (counts.total || 0) + 1;
  });
  stats = async () => JSON.parse(JSON.stringify(counts));
  reset = async () => {
    counts = {};
  };
} else {
  const proxy = `http://127.0.0.1:${new URL(origin).port}`;
  stats = async () => (await fetch(`${proxy}/__stats`)).json();
  reset = () => fetch(`${proxy}/__reset`);
}

const steps = {};
await reset();
await page.goto(`${origin}${args.path || "/"}`, { waitUntil: "load" });
steps.load = await stats();
await page.waitForTimeout(3000);
steps.afterIdle3s = await stats();
await page.mouse.wheel(0, 20000);
await page.waitForTimeout(1500);
steps.afterScroll = await stats();
await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
await page.waitForTimeout(1500);
steps.afterSearchOpen = await stats();
await page.keyboard.press("Escape");
await reset();
const link = page.locator("nav a[href^='/']").nth(3);
const href = await link.getAttribute("href").catch(() => null);
if (href) {
  // A reader's click: the pointer arrives first (hover prefetch), then the press.
  await link.hover();
  await page.waitForTimeout(300);
  await link.click();
  await page.waitForURL((u) => u.pathname === href.split("#")[0], { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);
}
const nav = { href, url: page.url(), ...(await stats()) };
// A second view of the same page in the same browser (HTTP cache warm).
await reset();
await page.goto(`${origin}${args.path || "/"}`, { waitUntil: "load" });
await page.waitForTimeout(3000);
const repeat = await stats();
console.log(JSON.stringify({ path: args.path, live, cumulativeFirstView: steps, clientNavigation: nav, repeatView: repeat, otherOrigins: Object.fromEntries(others) }, null, 2));
await browser.close();
