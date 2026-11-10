/**
 * Signed in → markdrop.in/ is the dashboard (lib/homeRedirect), on the real stack (up.sh):
 *
 *   anon        "/" is the landing page, painted (first-contentful-paint), no md_si cookie
 *   signin      signing in (/auth/callback) sets md_si; "/" then answers 307 → /dashboard in the
 *               middleware (query kept, no-store), before any HTML; /enterprise, /guides and /privacy stay put
 *   escape      /?home=1 shows the landing page while signed in; the account menu's "Home page" goes
 *               there; the header logo goes to /dashboard
 *   logout      Sign out clears md_si: "/" is the landing page again
 *   fallback    a session from before the cookie (token, no md_si): "/" reaches /dashboard via the
 *               boot script with NOTHING of the landing page painted (no first-contentful-paint, no
 *               landing node inserted while visible), and the cookie is set for next time
 *   expired     an expired token: without the cookie "/" is the landing page; with a stale cookie
 *               "/" → /dashboard → sign-in (the 401 clears the cookie), then "/" is the landing page; no loop
 *   tenant      a workspace's own domain: "/" with md_si and a session is never sent to /dashboard
 *
 *   BROWSER=chromium|webkit [ONLY=…] node home-redirect.mjs      (uses the existing seed)
 */
import { APP, TENANT, BROWSER, log, fail, seedNow, launch, ctx, stepper } from "./lib.mjs";

const S = seedNow();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const browser = await launch();
const { step, results } = stepper(browser);
const LANDING = "#hero-h1";

/** What a browser sends on a page load (c.request is a plain fetch otherwise, which is never redirected). */
const PAGE = { accept: "text/html,application/xhtml+xml", "sec-fetch-mode": "navigate" };
const cookieOf = async (c, url = APP) => (await c.cookies(url)).find((k) => k.name === "md_si")?.value ?? null;
const path = (p) => { const u = new URL(p.url()); return u.pathname + u.search; };

/** An expired copy of a token (exp in the past; the API refuses it either way). */
function expired(token) {
  const [h, b, s] = token.split(".");
  const j = JSON.parse(Buffer.from(b, "base64url").toString());
  j.exp = Math.floor(Date.now() / 1000) - 60;
  return `${h}.${Buffer.from(JSON.stringify(j)).toString("base64url")}.${s}`;
}

/** Store a session in this origin's localStorage once (lib ctx's token re-stores it on every load). */
async function seedToken(c, origin, token) {
  await c.addInitScript(([o, t]) => {
    try {
      if (location.origin === o && !sessionStorage.getItem("seeded")) {
        localStorage.setItem("markdrop_token", t);
        sessionStorage.setItem("seeded", "1");
      }
    } catch {}
  }, [origin, token]);
}

/**
 * Records, per document at "/", what it painted: paint entries at pagehide, and every element
 * inserted into <body> while <html> wasn't hidden. Kept in sessionStorage (survives the redirect).
 */
async function paintRecorder(c) {
  await c.addInitScript(() => {
    if (location.pathname !== "/") return;
    const rec = { visibleNodes: 0, paints: [] };
    const save = () => {
      try {
        rec.paints = performance.getEntriesByType("paint").map((e) => e.name);
        sessionStorage.setItem("paint:/", JSON.stringify(rec));
      } catch {}
    };
    new MutationObserver((muts) => {
      const hidden = getComputedStyle(document.documentElement).visibility === "hidden";
      for (const m of muts) for (const n of m.addedNodes) {
        if (!hidden && n.nodeType === 1 && document.body && document.body.contains(n)) rec.visibleNodes++;
      }
    }).observe(document, { childList: true, subtree: true });
    addEventListener("pagehide", save);
    addEventListener("load", () => setTimeout(save, 1500));
  });
}
const painted = async (p) => JSON.parse((await p.evaluate(() => sessionStorage.getItem("paint:/"))) || "null");

await step("anon", async () => {
  const { c, p } = await ctx(browser);
  await paintRecorder(c);
  const res = await p.goto(`${APP}/`);
  if (res.request().redirectedFrom()) fail("anonymous / was redirected");
  await p.locator(LANDING).waitFor({ timeout: 30000 });
  if (path(p) !== "/") fail(`anonymous / moved to ${path(p)}`);
  await p.waitForTimeout(2000);
  const r = await painted(p);
  // The recorder sees paints (so "no first-contentful-paint" in the fallback means something).
  if (!r) fail("no paint record from /");
  if (!r.paints.includes("first-contentful-paint")) {
    if (BROWSER === "chromium") fail(`the landing page never painted? ${JSON.stringify(r)}`);
    log(`(no paint entries on ${BROWSER}: ${JSON.stringify(r)})`);
  }
  if (r.visibleNodes === 0) fail("the recorder saw no landing nodes");
  if (await cookieOf(c)) fail("md_si set for an anonymous visitor");
  await c.close();
});

await step("signin", async () => {
  const { c, p } = await ctx(browser);
  await p.goto(`${APP}/auth/callback#token=${encodeURIComponent(T.owner)}&next=%2Fsettings%2Faccount`);
  await p.waitForURL(/\/settings\/account/, { timeout: 30000 });
  if ((await cookieOf(c)) !== "1") fail("signing in didn't set md_si");
  // The middleware answers before any HTML.
  const raw = await c.request.get(`${APP}/?utm_source=x`, { maxRedirects: 0, headers: PAGE });
  if (raw.status() !== 307) fail(`/ → ${raw.status()}, want 307`);
  if (raw.headers().location?.replace(APP, "") !== "/dashboard?utm_source=x") fail(`location ${raw.headers().location}`);
  if (!/no-store/.test(raw.headers()["cache-control"] || "")) fail(`cache-control ${raw.headers()["cache-control"]}`);
  // A router prefetch of "/" is served as is (only page loads redirect: lib/homeRedirect).
  const pre = await c.request.get(`${APP}/?_rsc=x`, { maxRedirects: 0, headers: { rsc: "1", "next-router-prefetch": "1", accept: "*/*", "sec-fetch-mode": "cors" } });
  if (pre.status() === 307) fail("a router prefetch of / was redirected");
  const res = await p.goto(`${APP}/?utm_source=x`);
  if (res.request().redirectedFrom()?.response() == null) log("(no redirect response recorded)");
  await p.waitForURL(/\/dashboard\?utm_source=x/, { timeout: 30000 });
  await p.locator("main#main").first().waitFor({ timeout: 30000 });
  // Only "/": other landing pages stay put.
  for (const other of ["/enterprise", "/guides", "/privacy"]) {
    const r = await c.request.get(`${APP}${other}`, { maxRedirects: 0, headers: PAGE });
    if (r.status() === 307 && /dashboard/.test(r.headers().location || "")) fail(`${other} redirected to the dashboard`);
  }
  await c.close();
});

await step("escape", async () => {
  const { c, p } = await ctx(browser);
  await seedToken(c, APP, T.owner);
  await p.goto(`${APP}/dashboard`);
  await p.locator("main#main").first().waitFor({ timeout: 30000 });
  await p.waitForFunction(() => document.cookie.includes("md_si=1"), null, { timeout: 15000 });
  // The header logo (rendered "/" until the session loads) goes to the dashboard.
  const logos = await p.waitForFunction(() => {
    const a = [...document.querySelectorAll('a[aria-label="Markdrop home"]')].filter((x) => x.offsetParent);
    return a.length === 0 ? "none" : a.every((x) => x.getAttribute("href") === "/dashboard") ? "ok" : false;
  }, null, { timeout: 15000 }).then((h) => h.jsonValue()).catch(() => "wrong");
  if (logos === "wrong") fail("signed-in logo doesn't go to /dashboard");
  if (logos === "none") log("(no header logo on the dashboard)");
  await p.getByRole("button", { name: /Account menu/ }).first().click();
  await p.getByRole("menuitem", { name: "Home page" }).click();
  await p.waitForURL((u) => u.pathname === "/" && u.searchParams.get("home") === "1", { timeout: 30000 });
  await p.locator(LANDING).waitFor({ timeout: 30000 });
  await p.goto(`${APP}/?home=1`);
  await p.locator(LANDING).waitFor({ timeout: 30000 });
  await p.waitForTimeout(1500);
  if (path(p) !== "/?home=1") fail(`/?home=1 moved to ${path(p)}`);
  await c.close();
});

await step("logout", async () => {
  const { c, p } = await ctx(browser);
  await seedToken(c, APP, T.member);
  await p.goto(`${APP}/dashboard`);
  await p.locator("main#main").first().waitFor({ timeout: 30000 });
  await p.waitForFunction(() => document.cookie.includes("md_si=1"), null, { timeout: 15000 });
  await p.getByRole("button", { name: /Account menu/ }).first().click();
  await p.getByRole("menuitem", { name: "Sign out" }).click();
  const confirm = p.getByRole("dialog").getByRole("button", { name: "Sign out" });
  if (await confirm.isVisible({ timeout: 2000 }).catch(() => false)) await confirm.click();
  await p.waitForFunction(() => !localStorage.getItem("markdrop_token"), null, { timeout: 15000 });
  if (await cookieOf(c)) fail("md_si survived sign-out");
  // Home sends a signed-out visitor to sign-in: let that finish first.
  await p.waitForURL(/\/login/, { timeout: 15000 }).catch(() => {});
  await p.waitForLoadState("domcontentloaded");
  await p.goto(`${APP}/`);
  await p.locator(LANDING).waitFor({ timeout: 30000 });
  await p.waitForTimeout(1500);
  if (path(p) !== "/") fail(`after sign-out / moved to ${path(p)}`);
  await c.close();
});

await step("fallback", async () => {
  const { c, p } = await ctx(browser);
  await seedToken(c, APP, T.owner);
  await paintRecorder(c);
  if (await cookieOf(c)) fail("precondition: md_si already set");
  const res = await p.goto(`${APP}/?utm_source=y`);
  await p.waitForURL(/\/dashboard\?utm_source=y/, { timeout: 30000 });
  if (res && res.status() >= 300 && res.status() < 400) fail("expected the boot script, got a server redirect");
  const r = await painted(p);
  if (!r) fail("no paint record from /");
  if (r.paints.includes("first-contentful-paint")) fail(`the landing page painted content before /dashboard: ${JSON.stringify(r)}`);
  if (r.visibleNodes > 0) fail(`${r.visibleNodes} landing node(s) inserted while visible`);
  if (await p.locator(LANDING).count()) fail("landing content in the dashboard");
  if ((await cookieOf(c)) !== "1") fail("the boot script didn't set md_si");
  log("fallback / record:", JSON.stringify(r));
  // Next time it's the middleware.
  const raw = await c.request.get(`${APP}/`, { maxRedirects: 0, headers: PAGE });
  if (raw.status() !== 307) fail(`second visit: / → ${raw.status()}`);
  await c.close();
});

await step("expired", async () => {
  const dead = expired(T.owner);
  {
    const { c, p } = await ctx(browser);
    await seedToken(c, APP, dead);
    await p.goto(`${APP}/`);
    await p.locator(LANDING).waitFor({ timeout: 30000 });
    await p.waitForTimeout(2000);
    if (path(p) !== "/") fail(`expired token, no cookie: / moved to ${path(p)}`);
    await c.close();
  }
  const { c, p } = await ctx(browser);
  await seedToken(c, APP, dead);
  const u = new URL(APP);
  await c.addCookies([{ name: "md_si", value: "1", domain: u.hostname, path: "/" }]);
  const navs = [];
  p.on("framenavigated", (f) => { if (f === p.mainFrame()) navs.push(new URL(f.url()).pathname); });
  await p.goto(`${APP}/`);
  await p.waitForURL(/\/login/, { timeout: 30000 });
  await p.waitForTimeout(3000);
  if (!/\/login/.test(path(p))) fail(`stale cookie ended on ${path(p)}`);
  if (await cookieOf(c)) fail("the 401 didn't clear md_si");
  if (navs.length > 6) fail(`navigation loop? ${navs.join(" → ")}`);
  await p.goto(`${APP}/`);
  await p.locator(LANDING).waitFor({ timeout: 30000 });
  await p.waitForTimeout(1500);
  if (path(p) !== "/") fail(`after the stale cookie / moved to ${path(p)}`);
  await c.close();
});

await step("tenant", async () => {
  const { c, p } = await ctx(browser);
  await seedToken(c, TENANT, T.owner);
  await c.addCookies([{ name: "md_si", value: "1", domain: new URL(TENANT).hostname, path: "/" }]);
  const raw = await c.request.get(`${TENANT}/`, { maxRedirects: 0, headers: PAGE });
  if (raw.status() === 307 && /\/dashboard/.test(raw.headers().location || "")) fail("tenant / redirected to /dashboard");
  await p.goto(`${TENANT}/`);
  await p.waitForTimeout(3000);
  if (/\/dashboard/.test(p.url())) fail(`tenant / moved to ${p.url()}`);
  await c.close();
});

console.log(`\nResults (home redirect, ${process.env.BROWSER || "chromium"}):`);
for (const [n, r] of results) console.log(`  ${r === "ok" ? "✓" : "✗"} ${n}: ${r}`);
await browser.close();
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
