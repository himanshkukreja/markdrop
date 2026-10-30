#!/usr/bin/env node
/**
 * Worker requests per page view: load a page in headless Chromium against the Miniflare proxy
 * (test/miniflare.mjs), let it idle (Next prefetches links in view), scroll, open search, click a
 * sidebar link, and read the proxy's counters after each step. Also lists other origins the page
 * called (trackers, APIs).
 *
 *   node test/pageview.mjs --origin http://markdrop.docs.localhost:3563 --path /cli/install
 *
 * Uses Playwright from the frontend's node_modules.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(HERE, "..", "..", "frontend", "package.json"));
const { chromium } = require("playwright");

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (i % 2 ? a : [...a, [v.replace(/^--/, ""), arr[i + 1]]]), []));
const origin = args.origin;
const proxy = `http://127.0.0.1:${new URL(origin).port}`;
const stats = async () => (await fetch(`${proxy}/__stats`)).json();
const reset = () => fetch(`${proxy}/__reset`);

const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const others = new Map();
page.on("request", (r) => {
  const u = new URL(r.url());
  if (u.origin !== origin) others.set(`${r.method()} ${u.origin}${u.pathname}`, (others.get(`${r.method()} ${u.origin}${u.pathname}`) || 0) + 1);
});
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
console.log(JSON.stringify({ path: args.path, cumulativeFirstView: steps, clientNavigation: nav, repeatView: repeat, otherOrigins: Object.fromEntries(others) }, null, 2));
await browser.close();
