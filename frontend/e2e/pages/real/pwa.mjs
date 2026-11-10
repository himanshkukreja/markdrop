/**
 * Markdrop as an installed app (lib/pwa.ts), on the real stack (up.sh, a production build):
 *
 *   manifest     both manifests are valid and installable (Chromium: no installability errors),
 *                icons are real PNGs of the right size, the studio host gets Markdrop Guides',
 *                a workspace's own domain gets neither, nor /sw.js
 *   sw           an app screen registers /sw.js and it controls the page; the landing page and a
 *                document never register it
 *   offline      with the network gone, a page load shows the branded offline page; back online, the app
 *   never-cache  after using the app, the caches hold only build assets and the offline page: no API
 *                response, no page HTML, no RSC payload; API responses never come from the worker
 *   update       a new build's worker waits, the page offers "A new version of Markdrop is ready",
 *                Reload hands over to it
 *   standalone   the installed app skips the landing page: "/" → the dashboard (signed out: sign-in)
 *   install      "Install app" in the account menu: the browser's prompt (Chromium), the
 *                Add to Home Screen sheet (WebKit on an iPhone); hidden when running installed
 *   ios          WebKit at 390 × 844 with an iPhone UA: viewport-fit=cover, the iOS metas and icon,
 *                no sideways scroll, and the bars move clear of simulated insets
 *
 *   BROWSER=chromium|webkit [ONLY=…] node pwa.mjs      (uses the existing seed)
 */
import fs from "node:fs";
import path from "node:path";
import { APP, API, TENANT, NEXT_PORT, BROWSER, WORK, log, fail, seedNow, launch, ctx, stepper } from "./lib.mjs";

const OUT = path.join(WORK, "real-shots", "pwa", BROWSER);
fs.mkdirSync(OUT, { recursive: true });
const S = seedNow();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const browser = await launch();
const { step, results } = stepper(browser);
const chromium = BROWSER === "chromium";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const STUDIO = `http://guides.localhost:${NEXT_PORT}`;

async function shot(p, name, opts = {}) {
  await p.waitForTimeout(opts.wait ?? 400);
  await p.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: !!opts.full });
  log("shot", name);
}

/** Width and height from a PNG's IHDR. */
function pngSize(buf) {
  if (buf.length < 24 || buf.toString("ascii", 1, 4) !== "PNG") return null;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

/** The page's worker state: registration script, whether it controls the page, and the build it reports. */
const swState = (p) =>
  p.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return { supported: false };
    const regs = await navigator.serviceWorker.getRegistrations();
    const reg = regs[0];
    const active = reg?.active ?? null;
    let version = null;
    if (active) {
      version = await new Promise((res) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => res(e.data);
        active.postMessage({ type: "VERSION" }, [ch.port2]);
        setTimeout(() => res(null), 2000);
      });
    }
    return {
      supported: true,
      regs: regs.length,
      script: active?.scriptURL ?? reg?.installing?.scriptURL ?? null,
      waiting: !!reg?.waiting,
      controlled: !!navigator.serviceWorker.controller,
      version,
    };
  });

async function controlled(p, timeout = 20000) {
  await p.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  if (!(await p.evaluate(() => !!navigator.serviceWorker.controller))) {
    // The first load registers; clients.claim() takes the page over (or the next load does).
    await p.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout }).catch(() => {});
  }
  if (!(await p.evaluate(() => !!navigator.serviceWorker.controller))) {
    await p.reload({ waitUntil: "networkidle" });
    await p.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout });
  }
}

async function openDashboard(p) {
  await p.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
  await p.locator("main#main").first().waitFor({ timeout: 30000 });
}

/* ── manifest ─────────────────────────────────────────────────────────── */
await step("manifest", async () => {
  const { c, p } = await ctx(browser, { token: T.owner });
  const r = await c.request.get(`${APP}/manifest.webmanifest`);
  if (r.status() !== 200) fail(`manifest → ${r.status()}`);
  if (!/application\/manifest\+json/.test(r.headers()["content-type"] || "")) fail(`manifest content-type ${r.headers()["content-type"]}`);
  const m = await r.json();
  const want = { name: "Markdrop", short_name: "Markdrop", display: "standalone", scope: "/", start_url: "/dashboard?source=pwa", id: "/" };
  for (const [k, v] of Object.entries(want)) if (m[k] !== v) fail(`manifest ${k}: ${JSON.stringify(m[k])} ≠ ${JSON.stringify(v)}`);
  if (!/^#[0-9a-f]{6}$/i.test(m.theme_color) || !/^#[0-9a-f]{6}$/i.test(m.background_color)) fail("manifest colours");
  const icons = m.icons.filter((i) => i.type === "image/png");
  for (const [size, purpose] of [["192x192", "any"], ["512x512", "any"], ["192x192", "maskable"], ["512x512", "maskable"]]) {
    if (!icons.some((i) => i.sizes === size && i.purpose === purpose)) fail(`no ${purpose} ${size} icon`);
  }
  const shortcuts = (m.shortcuts || []).map((s) => s.name);
  for (const n of ["New page", "Search", "Markdrop Guides", "Analytics"]) if (!shortcuts.includes(n)) fail(`no shortcut ${n}: ${shortcuts}`);
  const files = [...icons.map((i) => [i.src, i.sizes]), ...m.shortcuts.flatMap((s) => s.icons.map((i) => [i.src, i.sizes])), ["/apple-icon.png", "180x180"]];
  for (const [src, sizes] of files) {
    const ir = await c.request.get(`${APP}${src}`);
    if (ir.status() !== 200) fail(`${src} → ${ir.status()}`);
    const dims = pngSize(Buffer.from(await ir.body()));
    if (!dims || `${dims[0]}x${dims[1]}` !== sizes) fail(`${src} is ${dims} not ${sizes}`);
  }
  // The page links it, and (Chromium) the browser finds nothing in the way of installing.
  await openDashboard(p);
  const link = await p.locator('link[rel="manifest"]').getAttribute("href");
  if (link !== "/manifest.webmanifest") fail(`manifest link ${link}`);
  if (chromium) {
    await controlled(p);
    const cdp = await c.newCDPSession(p);
    const { errors } = await cdp.send("Page.getAppManifest");
    if (errors?.length) fail(`manifest parse errors: ${JSON.stringify(errors)}`);
    const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
    if (installabilityErrors.length) fail(`not installable: ${JSON.stringify(installabilityErrors)}`);
    log("installable: no installability errors");
  }
  // Markdrop Guides on the studio host; nothing on a workspace's own domain.
  if (chromium) {
    const sp = await c.newPage();
    const sr = await sp.goto(`${STUDIO}/manifest.webmanifest`);
    const sm = JSON.parse(await sr.text());
    if (sm.name !== "Markdrop Guides" || sm.start_url !== "/?source=pwa" || sm.display !== "standalone") fail(`studio manifest ${JSON.stringify(sm).slice(0, 200)}`);
    const sw = await sp.goto(`${STUDIO}/sw.js`);
    if (sw.status() !== 200) fail(`studio sw.js → ${sw.status()}`);
    for (const f of ["/manifest.webmanifest", "/sw.js", "/offline.html", "/studio.webmanifest"]) {
      const tr = await sp.goto(`${TENANT}${f}`);
      if (tr.status() !== 404) fail(`tenant ${f} → ${tr.status()}`);
    }
    await sp.close();
  }
  await c.close();
});

/* ── sw ───────────────────────────────────────────────────────────────── */
await step("sw", async () => {
  const r = await fetch(`${APP}/sw.js`);
  const src = await r.text();
  if (r.status !== 200 || !/javascript/.test(r.headers.get("content-type") || "")) fail(`/sw.js → ${r.status} ${r.headers.get("content-type")}`);
  const build = /var VERSION = "([\w.-]+)";/.exec(src)?.[1];
  if (!build || build === "dev") fail(`sw.js build id ${build}`);
  if (!/max-age=0/.test(r.headers.get("cache-control") || "")) fail(`sw.js cache-control ${r.headers.get("cache-control")}`);

  // Landing page and a document: no worker.
  {
    const { c, p } = await ctx(browser, { token: null });
    for (const u of [`${APP}/`, `${APP}/enterprise`, `${APP}/guides`]) {
      await p.goto(u, { waitUntil: "networkidle" });
      await p.waitForTimeout(800);
      const st = await swState(p);
      if (st.regs) fail(`${u} registered a worker`);
    }
    await c.close();
  }
  const { c, p } = await ctx(browser, { token: T.owner });
  await openDashboard(p);
  await controlled(p);
  const st = await swState(p);
  log("dashboard worker", JSON.stringify(st));
  if (!st.controlled || !String(st.script).endsWith("/sw.js")) fail(`not controlled: ${JSON.stringify(st)}`);
  if (st.version !== build) fail(`worker build ${st.version} ≠ ${build}`);
  // Moving around the app keeps it in control.
  await p.goto(`${APP}/settings/account`, { waitUntil: "networkidle" });
  if (!(await p.evaluate(() => !!navigator.serviceWorker.controller))) fail("settings not controlled");
  await c.close();
});

/* ── offline ──────────────────────────────────────────────────────────── */
await step("offline", async () => {
  const { c, p } = await ctx(browser, { token: T.owner, theme: "light" });
  await openDashboard(p);
  await controlled(p);
  if (!chromium) {
    // Playwright's WebKit can't go offline under a service worker (its offline mode refuses the
    // navigation before the worker sees it). Check what the worker would answer with: the precached
    // page, and that it renders. Chromium (and pwa.test.mjs) run the real fallback.
    const pre = await p.evaluate(async () => {
      for (const n of await caches.keys()) if (await (await caches.open(n)).match("/offline.html")) return n;
      return null;
    });
    if (!pre?.startsWith("md-shell-")) fail(`offline page not precached (${pre})`);
    await p.goto(`${APP}/offline.html`);
    await p.getByRole("heading", { name: "You're offline" }).waitFor({ timeout: 15000 });
    await shot(p, "01-offline-light");
    await c.close();
    return;
  }
  await c.setOffline(true);
  await p.goto(`${APP}/settings/account`).catch(() => {});
  await p.getByRole("heading", { name: "You're offline" }).waitFor({ timeout: 15000 });
  if (!(await p.getByRole("button", { name: "Try again" }).isVisible())) fail("no Try again");
  await shot(p, "01-offline-light");
  {
    const d = await ctx(browser, { token: T.owner, theme: "dark" });
    await openDashboard(d.p);
    await controlled(d.p);
    await d.c.setOffline(true);
    await d.p.goto(`${APP}/dashboard`).catch(() => {});
    await d.p.getByRole("heading", { name: "You're offline" }).waitFor({ timeout: 15000 });
    if ((await d.p.evaluate(() => document.documentElement.dataset.theme)) !== "dark") fail("offline page ignores the dark theme");
    await shot(d.p, "02-offline-dark");
    await d.c.close();
  }
  // Back online, the page reloads by itself into the app.
  await c.setOffline(false);
  await p.waitForURL(/\/settings\/account/, { timeout: 15000 });
  await p.locator("main#main").first().waitFor({ timeout: 30000 });
  if (await p.getByRole("heading", { name: "You're offline" }).isVisible().catch(() => false)) fail("still offline after reconnecting");
  await c.close();
});

/* ── never-cache ──────────────────────────────────────────────────────── */
await step("never-cache", async () => {
  const { c, p } = await ctx(browser, { token: T.owner });
  const fromWorker = [];
  p.on("response", (r) => {
    const u = r.url();
    if ((u.startsWith(API) || /\/api\//.test(u)) && r.fromServiceWorker()) fromWorker.push(u);
  });
  await openDashboard(p);
  await controlled(p);
  for (const u of ["/dashboard", "/settings/account", "/search", "/dashboard", "/settings/workspaces"]) {
    await p.goto(`${APP}${u}`, { waitUntil: "networkidle" });
  }
  // A client-side navigation too (RSC payloads).
  await p.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
  const link = p.locator('a[href="/settings/account"]').first();
  if (await link.count()) await link.click().catch(() => {});
  await p.waitForTimeout(1500);
  const cached = await p.evaluate(async () => {
    const out = {};
    for (const name of await caches.keys()) out[name] = (await (await caches.open(name)).keys()).map((r) => r.url);
    return out;
  });
  const all = Object.values(cached).flat();
  log(`cached: ${Object.entries(cached).map(([k, v]) => `${k}=${v.length}`).join(", ")}`);
  if (!all.some((u) => u.includes("/_next/static/"))) fail("no build assets cached");
  const allowed = (u) => {
    const x = new URL(u);
    if (x.origin !== APP) return false;
    return x.pathname.startsWith("/_next/static/") || x.pathname.startsWith("/icons/") || ["/icon.svg", "/apple-icon.png", "/offline.html"].includes(x.pathname);
  };
  const bad = all.filter((u) => !allowed(u));
  if (bad.length) fail(`cached what it must not: ${bad.slice(0, 5).join(", ")}`);
  if (fromWorker.length) fail(`API answered by the worker: ${fromWorker.slice(0, 3).join(", ")}`);
  await c.close();
});

/* ── update ───────────────────────────────────────────────────────────── */
// A deploy, replayed: the worker this page first installs is an older build's (its script is served
// with another build id), then the server's real /sw.js is the new one. A page that already is the
// new build lets it take over quietly; an older page (its build id rewritten in its JS) offers Reload.
const BUILD = /var VERSION = "([\w.-]+)";/.exec(await (await fetch(`${APP}/sw.js`)).text())[1];
async function olderWorker(c) {
  const swRoute = /\/sw\.js(\?.*)?$/;
  await c.route(swRoute, async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: (await res.text()).split(BUILD).join(`${BUILD}-old`) });
  });
  return () => c.unroute(swRoute);
}
const checkForUpdate = (p) => p.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()).catch(() => {}));

await step("update", async () => {
  // This page is the new build: no toast, the new worker just takes over.
  {
    const { c, p } = await ctx(browser, { token: T.owner });
    const done = await olderWorker(c);
    await openDashboard(p);
    await controlled(p);
    if ((await swState(p)).version !== `${BUILD}-old`) fail(`setup: worker is ${(await swState(p)).version}`);
    await done();
    await checkForUpdate(p);
    await p.waitForFunction(async (b) => {
      const ch = new MessageChannel();
      const v = await new Promise((res) => { ch.port1.onmessage = (e) => res(e.data); navigator.serviceWorker.controller?.postMessage({ type: "VERSION" }, [ch.port2]); setTimeout(() => res(null), 1000); });
      return v === b;
    }, BUILD, { timeout: 20000, polling: 1000 });
    if (await p.locator(".md-toast", { hasText: "A new version" }).count()) fail("toast shown to a page that already is the new build");
    await c.close();
  }
  // An older page (open since before the deploy): the toast, and Reload hands over.
  const { c, p } = await ctx(browser, { token: T.owner });
  const done = await olderWorker(c);
  const chunks = /\/_next\/static\/chunks\/.+\.js(\?.*)?$/;
  await c.route(chunks, async (route) => {
    const res = await route.fetch();
    const body = await res.text();
    await route.fulfill({ response: res, body: body.includes(BUILD) ? body.split(BUILD).join("page-old") : body });
  });
  await openDashboard(p);
  await controlled(p);
  await done();
  await c.unroute(chunks);
  await checkForUpdate(p);
  const toast = p.locator(".md-toast", { hasText: "A new version of Markdrop is ready" });
  await toast.waitFor({ timeout: 20000 });
  const st = await swState(p);
  if (!st.waiting) fail("the new worker didn't wait");
  if (st.version !== `${BUILD}-old`) fail(`the new worker took over before Reload (${st.version})`);
  await shot(p, "03-update-toast");
  await Promise.all([p.waitForEvent("load", { timeout: 20000 }), toast.getByRole("button", { name: "Reload" }).click()]);
  await p.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
  const after = await swState(p);
  if (after.version !== BUILD) fail(`after Reload the worker is ${after.version}, not ${BUILD}`);
  await c.close();
});

/* ── standalone ───────────────────────────────────────────────────────── */
async function standaloneCtx(token) {
  const r = await ctx(browser, { token });
  await r.c.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { get: () => true, configurable: true });
  });
  return r;
}
await step("standalone", async () => {
  {
    const { c, p } = await standaloneCtx(T.owner);
    await p.goto(`${APP}/`);
    await p.waitForURL(/\/dashboard/, { timeout: 15000 });
    await p.locator("main#main").first().waitFor({ timeout: 30000 });
    // Running installed: no "Install app".
    await p.getByRole("button", { name: /Account menu/ }).first().click();
    await p.getByRole("menu").first().waitFor();
    if (await p.getByRole("menuitem", { name: "Install app" }).count()) fail("Install app shown inside the installed app");
    await c.close();
  }
  {
    const { c, p } = await standaloneCtx(null);
    await p.goto(`${APP}/`);
    await p.waitForURL(/\/login\?next=%2Fdashboard/, { timeout: 20000 });
    await c.close();
  }
  // In a browser tab, signed in, "/" is the dashboard too (lib/homeRedirect); /?home=1 stays the landing page.
  const { c, p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/?home=1`, { waitUntil: "networkidle" });
  if (new URL(p.url()).pathname !== "/") fail(`browser "/?home=1" moved to ${p.url()}`);
  await c.close();
});

/* ── install ──────────────────────────────────────────────────────────── */
await step("install", async () => {
  if (chromium) {
    // The browser's prompt, as Chrome fires it when the app is installable.
    const { c, p } = await ctx(browser, { token: T.owner });
    await openDashboard(p);
    const menu = async () => {
      await p.getByRole("button", { name: /Account menu/ }).first().click();
      await p.getByRole("menu").first().waitFor();
    };
    await menu();
    if (await p.getByRole("menuitem", { name: "Install app" }).count()) fail("Install app before the browser offered it");
    await p.keyboard.press("Escape");
    await p.evaluate(() => {
      const e = new Event("beforeinstallprompt", { cancelable: true });
      e.prompt = () => { window.__prompted = (window.__prompted || 0) + 1; return Promise.resolve(); };
      e.userChoice = Promise.resolve({ outcome: "accepted" });
      window.dispatchEvent(e);
      window.__prevented = e.defaultPrevented;
    });
    if (!(await p.evaluate(() => window.__prevented))) fail("the mini-infobar wasn't held back");
    await menu();
    await shot(p, "04-menu-install");
    await p.getByRole("menuitem", { name: "Install app" }).click();
    await p.waitForFunction(() => window.__prompted === 1, null, { timeout: 5000 });
    await p.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
    await p.locator(".md-toast", { hasText: "Markdrop is installed" }).waitFor({ timeout: 5000 });
    await menu();
    if (await p.getByRole("menuitem", { name: "Install app" }).count()) fail("Install app still shown after installing");
    await c.close();
  } else {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, userAgent: IPHONE_UA, colorScheme: "light" });
    await c.addInitScript((t) => {
      localStorage.setItem("markdrop_token", t);
      localStorage.setItem("md_theme", "light");
      localStorage.setItem("md_consent", "denied");
    }, T.owner);
    const p = await c.newPage();
    await openDashboard(p);
    await p.getByRole("button", { name: /Account menu/ }).first().click();
    await p.getByRole("menuitem", { name: "Install app" }).click();
    const sheet = p.getByRole("dialog", { name: /Install Markdrop on your iPhone/ });
    await sheet.waitFor({ timeout: 5000 });
    for (const t of ["Share", "Add to Home Screen", "Open as Web App"]) if (!(await sheet.getByText(t, { exact: false }).first().isVisible())) fail(`sheet without ${t}`);
    await shot(p, "05-ios-install-sheet");
    await sheet.getByRole("button", { name: "Got it" }).click();
    await sheet.waitFor({ state: "detached", timeout: 5000 });
    await c.close();
  }
});

/* ── ios ──────────────────────────────────────────────────────────────── */
await step("ios", async () => {
  if (chromium) return log("ios: WebKit only");
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, userAgent: IPHONE_UA, colorScheme: "light" });
  await c.addInitScript((t) => {
    localStorage.setItem("markdrop_token", t);
    localStorage.setItem("md_theme", "light");
    localStorage.setItem("md_consent", "denied");
  }, T.owner);
  const p = await c.newPage();
  await openDashboard(p);
  const head = await p.evaluate(() => ({
    viewport: document.querySelector('meta[name="viewport"]')?.content,
    capable: document.querySelector('meta[name="mobile-web-app-capable"]')?.content,
    status: document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.content,
    touchIcon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href"),
    theme: document.querySelector('meta[name="theme-color"]')?.content,
  }));
  log("head", JSON.stringify(head));
  if (!/viewport-fit=cover/.test(head.viewport || "")) fail(`viewport ${head.viewport}`);
  if (head.capable !== "yes" || head.status !== "default") fail(`iOS metas ${JSON.stringify(head)}`);
  if (!head.touchIcon?.startsWith("/apple-icon.png")) fail(`apple-touch-icon ${head.touchIcon}`);
  const overflow = async () => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if ((await overflow()) > 1) fail(`dashboard scrolls sideways by ${await overflow()}px`);
  const header = () => p.evaluate(() => { const r = document.querySelector("header")?.getBoundingClientRect(); return r ? [Math.round(r.top), Math.round(r.height)] : null; });
  const [top0, h0] = await header();
  if (top0 !== 0 || h0 !== 56) fail(`header at ${top0} × ${h0}`);
  await shot(p, "06-ios-dashboard");
  // A notch and home indicator (simulated: WebKit reports no insets here): the bars move clear.
  await p.addStyleTag({ content: ":root{--safe-top:47px;--safe-bottom:34px;--safe-left:0px;--safe-right:0px}" });
  await p.waitForTimeout(300);
  const [, h1] = await header();
  if (h1 !== 56 + 47) fail(`header with a 47px inset is ${h1}px`);
  const logoTop = await p.evaluate(() => Math.round(document.querySelector("header")?.lastElementChild?.getBoundingClientRect().top ?? -1));
  if (logoTop < 47) fail(`header content under the status bar (top ${logoTop})`);
  await shot(p, "07-ios-dashboard-insets");
  if ((await overflow()) > 1) fail("sideways scroll with insets");
  // Settings and a toast on a phone.
  await p.goto(`${APP}/settings/account`, { waitUntil: "networkidle" });
  if ((await overflow()) > 1) fail(`settings scrolls sideways by ${await overflow()}px`);
  await shot(p, "08-ios-settings");
  await c.close();
});

await browser.close();
console.log("\n" + results.map(([n, r, ms]) => `${r === "ok" ? "✓" : "✗"} ${n.padEnd(12)} ${(ms / 1000).toFixed(1).padStart(5)} s  ${r === "ok" ? "" : r}`).join("\n"));
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
