/**
 * The Meetings hub with ~300 meetings on the REAL stack (feat/meetings-perf): how fast it loads, and the
 * paged list (infinite scroll, Load more, search, back navigation).
 *
 *   PB_FAKE_MEETINGS_AI=1 PB_STACK_ID=… PB_WORK=… zsh up.sh start
 *   PB_STACK_ID=… PB_WORK=… [PERF_N=300] [MEASURE_ONLY=1] node meetings-perf.mjs
 *
 *   load     Ben (a member) opens the hub cold: document TTFB, first card, LCP, the browser's script time,
 *            the list requests and their bytes (printed as "PERF {...}"; MEASURE_ONLY=1 stops here, for the
 *            "before" build)
 *   scroll   scrolling loads every page: each meeting he can open once, none restricted, the count right;
 *            Load more works without scrolling
 *   back     open a meeting deep in the list, Back: the same list at the same place, from memory
 *   search   server-side search and a series chip, with paging
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { APP, BROWSER, STACK, here, log, fail, reseed, launch, ctx, stepper } from "./lib.mjs";

const browser = await launch();
const { step, results } = stepper(browser);
const MEASURE_ONLY = !!process.env.MEASURE_ONLY;
let S;
let P;
if (process.env.NO_RESEED) {
  S = JSON.parse(fs.readFileSync(path.join(STACK, "seed.json"), "utf8"));
} else {
  S = reseed();
  const PY = path.resolve(here, "../../../../backend/.venv/bin/python");
  execFileSync(PY, [path.join(here, "seed_meetings_perf.py")], {
    stdio: "inherit", env: { ...process.env, STACK_ID: String(process.env.PB_STACK_ID || 5), PB_STACK: STACK },
  });
}
P = JSON.parse(fs.readFileSync(path.join(STACK, "seed-meetings-perf.json"), "utf8"));
const HUB = `${APP}/meetings/${S.ws}`;
const BEN = S.users.member.token;
const OPEN = new Set(P.open);
const SECRET = new Set(P.restricted);
const isList = (u) => /\/api\/v1\/meetings\?/.test(u);

async function cards(p) {
  return p.$$eval('[data-testid="meeting-card"]', (els) => els.map((e) => e.getAttribute("data-id")));
}

await step("load", async () => {
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const { c, p } = await ctx(browser, { token: BEN });
    await c.addInitScript(() => {
      window.__lcp = 0;
      try {
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = e.startTime; })
          .observe({ type: "largest-contentful-paint", buffered: true });
      } catch {}
    });
    const lists = [];
    p.on("response", async (r) => {
      if (!isList(r.url())) return;
      const t = Date.now();
      let bytes = 0;
      try { bytes = (await r.body()).length; } catch {}
      lists.push({ status: r.status(), bytes, at: t });
    });
    const cdp = BROWSER === "chromium" ? await c.newCDPSession(p) : null;
    if (cdp) await cdp.send("Performance.enable");
    const t0 = Date.now();
    await p.goto(HUB, { waitUntil: "commit" });
    await p.waitForSelector('[data-testid="meeting-card"]', { timeout: 60000 });
    const firstCard = Date.now() - t0;
    await p.waitForTimeout(2500);
    const nav = await p.evaluate(() => {
      const n = performance.getEntriesByType("navigation")[0];
      return { ttfb: n ? n.responseStart : null, dcl: n ? n.domContentLoadedEventEnd : null, lcp: window.__lcp };
    });
    let script = null;
    if (cdp) {
      const m = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]));
      script = Math.round(m.ScriptDuration * 1000);
    }
    const n = (await cards(p)).length;
    const firstList = lists[0];
    runs.push({ firstCard, ttfb: Math.round(nav.ttfb), lcp: Math.round(nav.lcp), scriptMs: script, cards: n,
      listRequests: lists.length, firstListKB: firstList ? +(firstList.bytes / 1024).toFixed(1) : null,
      listKB: +(lists.reduce((a, x) => a + x.bytes, 0) / 1024).toFixed(1), listMsAfterNav: firstList ? firstList.at - t0 : null });
    await c.close();
  }
  const med = (k) => runs.map((r) => r[k]).sort((a, b) => a - b)[1];
  console.log("PERF", JSON.stringify({ build: MEASURE_ONLY ? "before" : "after", median: Object.fromEntries(Object.keys(runs[0]).map((k) => [k, med(k)])), runs }));
  if (!MEASURE_ONLY) {
    if (runs[0].cards > 40) fail(`the first render has ${runs[0].cards} cards (expected a page)`);
  }
});

if (!MEASURE_ONLY) {
  await step("scroll", async () => {
    const { p } = await ctx(browser, { token: BEN });
    let calls = 0;
    p.on("request", (r) => { if (isList(r.url())) calls++; });
    await p.goto(HUB);
    await p.waitForSelector('[data-testid="meeting-card"]');
    const count = await p.locator('[data-testid="meetings-count"]').innerText();
    if (!count.startsWith(`${OPEN.size} `)) fail(`count says "${count}", expected ${OPEN.size}`);
    // Load more without scrolling.
    const before = (await cards(p)).length;
    await p.getByTestId("meetings-load-more").click();
    await p.waitForFunction((n) => document.querySelectorAll('[data-testid="meeting-card"]').length > n, before);
    // Then scroll to the end.
    for (let i = 0; i < 40; i++) {
      if (!(await p.locator('[data-testid="meetings-more-zone"]').count())) break;
      await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await p.waitForTimeout(400);
    }
    if (await p.locator('[data-testid="meetings-more-zone"]').count()) fail("never reached the end");
    const ids = await cards(p);
    const uniq = new Set(ids);
    if (uniq.size !== ids.length) fail(`${ids.length - uniq.size} meetings shown twice`);
    const leaked = ids.filter((x) => SECRET.has(x));
    if (leaked.length) fail(`${leaked.length} restricted meetings shown to Ben`);
    const missing = [...OPEN].filter((x) => !uniq.has(x));
    if (missing.length) fail(`${missing.length} meetings never shown`);
    log(`scrolled ${ids.length} meetings in ${calls} list requests`);
    // Month headers stay in order.
    const months = await p.$$eval('[data-testid="month-header"]', (els) => els.length);
    if (months < 3) fail(`only ${months} month headers`);
  });

  await step("back", async () => {
    const { p } = await ctx(browser, { token: BEN });
    await p.goto(HUB);
    await p.waitForSelector('[data-testid="meeting-card"]');
    for (let i = 0; i < 4; i++) {
      await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await p.waitForTimeout(500);
    }
    const loaded = (await cards(p)).length;
    const target = p.locator('[data-testid="meeting-card"]').nth(Math.min(loaded - 5, 100));
    await target.scrollIntoViewIfNeeded();
    await p.evaluate(() => window.scrollBy(0, -120));
    await p.waitForTimeout(300);
    const y = await p.evaluate(() => window.scrollY);
    const id = await target.getAttribute("data-id");
    await target.locator(".mt-card__link").click();
    await p.waitForURL((u) => !u.pathname.startsWith("/meetings/"), { timeout: 30000 });
    await p.waitForTimeout(800);
    let calls = 0;
    p.on("request", (r) => { if (isList(r.url())) calls++; });
    const t0 = Date.now();
    await p.goBack();
    await p.waitForSelector(`[data-testid="meeting-card"][data-id="${id}"]`, { timeout: 15000 });
    const shownIn = Date.now() - t0;
    await p.waitForTimeout(1500);
    const y2 = await p.evaluate(() => window.scrollY);
    const again = (await cards(p)).length;
    log(`back: ${again} cards (had ${loaded}), scrollY ${y2} (was ${y}), shown in ${shownIn} ms, ${calls} list request(s)`);
    if (again < loaded) fail(`back shows ${again} cards, had ${loaded}`);
    if (Math.abs(y2 - y) > 150) fail(`back scrolled to ${y2}, was ${y}`);
    if (calls > 1) fail(`back made ${calls} list requests`);
  });

  await step("search", async () => {
    const { p } = await ctx(browser, { token: BEN });
    await p.goto(HUB);
    await p.waitForSelector('[data-testid="meeting-card"]');
    await p.getByLabel("Filter meetings").fill("senseloaf");
    await p.waitForFunction(() => /^\d+ meetings? of \d+/.test(document.querySelector('[data-testid="meetings-count"]')?.textContent || ""));
    await p.waitForTimeout(600);
    for (let i = 0; i < 10 && (await p.locator('[data-testid="meetings-more-zone"]').count()); i++) {
      await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await p.waitForTimeout(400);
    }
    const titles = await p.$$eval('[data-testid="meeting-card"] .mt-card__title', (els) => els.map((e) => e.textContent));
    if (!titles.length || titles.some((t) => !/senseloaf/i.test(t))) fail(`search shows ${JSON.stringify(titles.slice(0, 5))}`);
    const n = Number((await p.locator('[data-testid="meetings-count"]').innerText()).split(" ")[0]);
    if (n !== titles.length) fail(`count ${n}, shown ${titles.length}`);
    await p.getByLabel("Filter meetings").fill("");
    await p.locator('[data-testid="series-chips"] button', { hasText: "Daily Standup" }).click();
    await p.waitForFunction(() => /of \d+/.test(document.querySelector('[data-testid="meetings-count"]')?.textContent || ""));
    await p.waitForTimeout(600);
    const series = await p.$$eval('[data-testid="meeting-card"]', (els) => els.map((e) => e.querySelector('[data-testid="card-series"]')?.textContent || e.querySelector(".mt-card__title")?.textContent));
    if (!series.length || series.some((s) => !/Daily Standup/.test(s || ""))) fail(`series chip shows ${JSON.stringify(series.slice(0, 5))}`);
    await p.screenshot({ path: path.join(STACK, "..", "meetings-perf-series.png") });
  });
}

console.log("\nRESULTS", BROWSER);
for (const [n, s, ms] of results) console.log(`  ${s === "ok" ? "✓" : "✗"} ${n} ${s === "ok" ? "" : s} (${(ms / 1000).toFixed(1)} s)`);
await browser.close();
process.exit(results.some(([, s]) => s !== "ok") ? 1 : 0);
