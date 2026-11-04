/**
 * The in-app workspace listing on the REAL stack (fix/ws-listing): folder-click timing under
 * throttling, the owner on every row (and the privacy matrix), the List / Grid / Cards switch, and
 * screenshots. Seeds the busy "Senseloaf" workspace (seed_listing.py) on top of seed.py.
 *
 *   PB_STACK_ID=12 [ONLY=timing,owner,views,privacy,cards,cards-timing,shots] [PROFILES=4g,3g] [RUNS=3] node listing.mjs
 *
 * `cards` (feat/card-previews) checks the Cards view's previews in the "Gallery" folder: every kind,
 * the access answers, no item markup in the app's origin, the live HTML frame on hover (sandboxed,
 * on the artifact origin, at most three), lazy loading in a 60-item folder, List and Grid unchanged,
 * and screenshots (CARD_SHOTS, default <out>/cards). `cards-timing` compares folder clicks in Cards
 * and List.
 *
 * `timing` is selector-agnostic (it clicks folder links by href and watches the page), so it also
 * measures an older build: LABEL=before writes timing-before.json, LABEL=after timing-after.json.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { APP, API, SHOTS, STACK, STACK_ID, log, fail, reseed, seedNow, api, launch, ctx, shot, stepper } from "./lib.mjs";

const OUT = process.env.LISTING_OUT || SHOTS;
fs.mkdirSync(OUT, { recursive: true });
const LABEL = process.env.LABEL || "after";
const browser = await launch();
const { step, results } = stepper(browser);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../..").split("/.claude/worktrees/")[0];
const PY = path.join(ROOT, "backend", ".venv", "bin", "python");

function seedListing() {
  execFileSync(PY, [path.join(path.dirname(new URL(import.meta.url).pathname), "seed_listing.py")], {
    stdio: "pipe", env: { ...process.env, STACK_ID: String(STACK_ID), PB_STACK: STACK },
  });
  return JSON.parse(fs.readFileSync(path.join(STACK, "seed-listing.json"), "utf8"));
}
const S0 = process.env.NO_RESEED ? seedNow() : reseed();
const L = process.env.NO_RESEED && fs.existsSync(path.join(STACK, "seed-listing.json"))
  ? JSON.parse(fs.readFileSync(path.join(STACK, "seed-listing.json"), "utf8"))
  : seedListing();
const T = Object.fromEntries(Object.entries(L.users).map(([k, u]) => [k, u.token]));
const WS = L.ws;
const wsUrl = `${APP}/w/${WS}`;
const fUrl = (id) => `${APP}/w/${WS}/f/${id}`;

/** The newest item's title in a place (what "content arrived" waits for). */
async function firstTitle(folder) {
  const r = await api("GET", `/api/v1/workspaces/${WS}/items?folder=${folder}&limit=1`, T.member);
  if (r.status !== 200 || !r.body.items.length) fail(`no items in ${folder}: ${r.status}`);
  return r.body.items[0].title;
}

/* ── Timing ─────────────────────────────────────────────────────────── */

const PROFILES = {
  // Chrome DevTools presets ("Fast 4G"-like with 150 ms RTT, and "Fast 3G"), plus 4× CPU.
  "4g": { latency: 150, downloadThroughput: (4 * 1024 * 1024) / 8, uploadThroughput: (3 * 1024 * 1024) / 8 },
  "3g": { latency: 562.5, downloadThroughput: (1.44 * 1024 * 1024) / 8, uploadThroughput: (675 * 1024) / 8 },
};

/** Watches the page from the click: first feedback (URL, heading or a busy marker changes), the
 *  URL, and when `text` (an item of the destination) is on screen. Long tasks are buffered. */
const ARM = ({ want, text }) => {
  const main = () => document.querySelector("#main") || document.body;
  const h1 = () => main().querySelector("h1")?.textContent ?? "";
  window.__m = null;
  window.addEventListener("click", () => {
    const start = performance.now();
    const prevH1 = h1();
    const prevPath = location.pathname;
    const m = (window.__m = { start, feedback: null, url: null, content: null });
    const tick = () => {
      const now = performance.now() - start;
      const busy = main().querySelector('[aria-busy="true"], [data-pending="true"]');
      if (m.url == null && location.pathname.endsWith(want)) m.url = now;
      if (m.feedback == null && (location.pathname !== prevPath || h1() !== prevH1 || busy)) m.feedback = now;
      if (m.content == null && main().innerText.includes(text)) m.content = now;
      if ((m.content == null || m.url == null) && now < 30000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { capture: true, once: true });
};

async function timedClick(p, cdp, selector, { want, text }) {
  const reqs = new Map();
  const onReq = (e) => {
    if (e.request.url.startsWith("data:")) return;
    reqs.set(e.requestId, { url: e.request.url, type: e.type, t0: e.timestamp, t1: null, bytes: 0 });
  };
  const onDone = (e) => { const r = reqs.get(e.requestId); if (r) { r.t1 = e.timestamp; r.bytes = e.encodedDataLength; } };
  const onFail = (e) => { const r = reqs.get(e.requestId); if (r) r.t1 = e.timestamp; };
  const link = p.locator(selector).first();
  await link.scrollIntoViewIfNeeded();
  await link.hover();
  await p.waitForTimeout(150); // a person's hover before the click
  await p.evaluate(ARM, { want, text });
  const t = await cdp.send("Runtime.evaluate", { expression: "performance.timeOrigin", returnByValue: true });
  void t;
  cdp.on("Network.requestWillBeSent", onReq);
  cdp.on("Network.loadingFinished", onDone);
  cdp.on("Network.loadingFailed", onFail);
  const wall0 = Date.now();
  await link.click({ noWaitAfter: true });
  await p.waitForFunction(() => window.__m && window.__m.content != null && window.__m.url != null, null, { timeout: 45000, polling: 100 });
  await p.waitForTimeout(400);
  cdp.off("Network.requestWillBeSent", onReq);
  cdp.off("Network.loadingFinished", onDone);
  cdp.off("Network.loadingFailed", onFail);
  const m = await p.evaluate(() => window.__m);
  const lt = await p.evaluate((s) => (window.__lt || []).filter((x) => x.start >= s.start && x.start <= s.start + (s.content ?? 0) + 50).map((x) => Math.round(x.d)), m);
  const list = [...reqs.values()].filter((r) => r.t0 * 1000 >= 0);
  const base = Math.min(...list.map((r) => r.t0), Infinity);
  const shortUrl = (u) => u.replace(APP, "").replace(API, "API").replace(/[0-9a-f]{24}/g, "…").slice(0, 90);
  return {
    feedback: Math.round(m.feedback), url: m.url == null ? null : Math.round(m.url), content: Math.round(m.content),
    wall: Date.now() - wall0,
    longTasks: lt, longTaskMs: lt.reduce((a, b) => a + b, 0),
    requests: list.map((r) => ({ url: shortUrl(r.url), type: r.type, start: Math.round((r.t0 - base) * 1000), ms: r.t1 ? Math.round((r.t1 - r.t0) * 1000) : null, bytes: r.bytes })),
  };
}

await step("timing", async () => {
  const profiles = (process.env.PROFILES || "4g,3g").split(",");
  const runs = Number(process.env.RUNS || 3);
  const product = L.folders["Product"], archive = L.folders["Archive"], specs = L.nested["Specs"];
  const titles = { product: await firstTitle(product), archive: await firstTitle(archive), specs: await firstTitle(specs), root: await firstTitle("root") };
  const report = {};
  for (const prof of profiles) {
    report[prof] = [];
    for (let i = 0; i < runs; i++) {
      const { c, p } = await ctx(browser, { token: T.member });
      await c.addInitScript(() => {
        window.__lt = [];
        try {
          new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ start: e.startTime, d: e.duration }); }).observe({ type: "longtask", buffered: true });
        } catch {}
      });
      const cdp = await c.newCDPSession(p);
      await cdp.send("Network.enable");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
      await cdp.send("Network.emulateNetworkConditions", { offline: false, ...PROFILES[prof] });
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      const t0 = Date.now();
      await p.goto(wsUrl, { waitUntil: "load", timeout: 90000 });
      await p.locator(`#main a[href$="/f/${product}"]`).first().waitFor({ timeout: 60000 });
      await p.waitForFunction((t) => document.querySelector("#main")?.innerText.includes(t), titles.root, { timeout: 60000 });
      const coldLoad = Date.now() - t0;
      await p.waitForTimeout(2500); // settle (prefetches, idle)
      const run = { coldLoad };
      run.rootToProduct = await timedClick(p, cdp, `#main a[href$="/f/${product}"]`, { want: `/f/${product}`, text: titles.product });
      await p.waitForTimeout(1200);
      run.productToSpecs = await timedClick(p, cdp, `#main a[href$="/f/${specs}"]`, { want: `/f/${specs}`, text: titles.specs });
      await p.waitForTimeout(1200);
      run.specsToRoot = await timedClick(p, cdp, `#main nav a[href$="/w/${WS}"]`, { want: `/w/${WS}`, text: titles.root });
      await p.waitForTimeout(1200);
      run.rootToArchive = await timedClick(p, cdp, `#main a[href$="/f/${archive}"]`, { want: `/f/${archive}`, text: titles.archive });
      report[prof].push(run);
      const brief = Object.entries(run).filter(([k]) => k !== "coldLoad").map(([k, v]) => `${k} fb ${v.feedback} / content ${v.content} ms (${v.requests.length} req, LT ${v.longTaskMs})`);
      log(`${prof} run ${i + 1}: cold ${coldLoad} ms; ${brief.join("; ")}`);
      await c.close();
    }
  }
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const summary = {};
  for (const [prof, runsOf] of Object.entries(report)) {
    summary[prof] = { coldLoad: med(runsOf.map((r) => r.coldLoad)) };
    for (const k of ["rootToProduct", "productToSpecs", "specsToRoot", "rootToArchive"]) {
      summary[prof][k] = {
        feedback: med(runsOf.map((r) => r[k].feedback)), url: med(runsOf.map((r) => r[k].url ?? -1)), content: med(runsOf.map((r) => r[k].content)),
        requests: med(runsOf.map((r) => r[k].requests.length)), kb: Math.round(med(runsOf.map((r) => r[k].requests.reduce((a, q) => a + q.bytes, 0))) / 1024),
        longTaskMs: med(runsOf.map((r) => r[k].longTaskMs)),
      };
    }
  }
  fs.writeFileSync(path.join(OUT, `timing-${LABEL}.json`), JSON.stringify({ summary, report }, null, 1));
  console.log(JSON.stringify(summary, null, 1));
  if (LABEL === "after") {
    for (const [prof, s] of Object.entries(summary)) {
      for (const k of ["rootToProduct", "productToSpecs", "specsToRoot", "rootToArchive"]) {
        if (s[k].feedback > 100) fail(`${prof} ${k}: first feedback ${s[k].feedback} ms (want ≤ 100)`);
      }
    }
  }
});

/* ── Owner on rows, privacy ─────────────────────────────────────────── */

await step("owner", async () => {
  // API: every readable row carries its owner's name (and picture when https); a viewer sees names too.
  for (const who of ["member", "reader", "owner"]) {
    const r = await api("GET", `/api/v1/workspaces/${WS}/items?folder=${L.folders.Product}&limit=50`, T[who]);
    if (r.status !== 200) fail(`${who} items → ${r.status}`);
    if (!r.body.items.length || r.body.items.some((i) => !i.owner?.name)) fail(`${who}: a row has no owner name`);
    const ben = r.body.items.find((i) => i.owner.name === "Ben Member");
    if (!ben?.owner.picture?.startsWith("https://")) fail(`${who}: Ben's row lacks his picture`);
  }
  const { c, p } = await ctx(browser, { token: T.member });
  await p.goto(fUrl(L.folders.Product), { waitUntil: "networkidle" });
  const row = p.locator("#main [data-row-kind=item]").first();
  await row.waitFor({ timeout: 20000 });
  const owners = await p.locator("#main [data-owner]").allInnerTexts();
  if (!owners.some((t) => /Ada Owner/.test(t)) || !owners.some((t) => /You/.test(t))) fail(`owners on rows: ${JSON.stringify(owners.slice(0, 8))}`);
  if (!(await p.locator("#main [data-owner] img").count())) fail("no avatar picture shown for Ben");
  await c.close();
});

await step("privacy", async () => {
  // An outsider (Cy) can't list the workspace at all: no names.
  for (const pth of [`/api/v1/workspaces/${WS}/items?folder=root`, `/api/v1/workspaces/${WS}/tree`, `/api/v1/workspaces/${WS}/nav`]) {
    const r = await api("GET", pth, T.stranger);
    if (r.status < 400) fail(`stranger ${pth} → ${r.status}`);
    if (JSON.stringify(r.body).includes("Ada Owner") || JSON.stringify(r.body).includes("Ben Member")) fail(`stranger sees a name on ${pth}`);
  }
  const anon = await api("GET", `/api/v1/workspaces/${WS}/items?folder=root`, null);
  if (anon.status < 400) fail(`anonymous items → ${anon.status}`);
  // The page shows the outsider no listing (and no names).
  const { c, p } = await ctx(browser, { token: T.stranger });
  await p.goto(wsUrl, { waitUntil: "networkidle" });
  await p.getByText(/isn't available/).waitFor({ timeout: 20000 });
  const text = await p.locator("#main").innerText();
  for (const n of ["Ada Owner", "Ben Member", "Wes Admin"]) if (text.includes(n)) fail(`outsider page shows ${n}`);
  await c.close();
});

/* ── In-place folder navigation ─────────────────────────────────────── */

await step("nav", async () => {
  const { c, p } = await ctx(browser, { token: T.member });
  const h1 = () => p.locator("#main h1").first().innerText();
  const want = async (name, pathEnd) => {
    await p.waitForFunction((n) => document.querySelector("#main h1")?.textContent === n, name, { timeout: 10000 });
    await p.waitForURL((u) => u.pathname.endsWith(pathEnd), { timeout: 15000 });
  };
  await p.goto(wsUrl, { waitUntil: "networkidle" });
  const opened = p.url();
  // A row, then a subfolder, then back and forward.
  await p.locator(`#main a[href$="/f/${L.folders.Product}"]`).first().click();
  if ((await h1()) !== "Product") fail(`the folder didn't switch at once: ${await h1()}`);
  await want("Product", `/f/${L.folders.Product}`);
  await p.locator(`#main a[href$="/f/${L.nested.Specs}"]`).first().click();
  await want("Specs", `/f/${L.nested.Specs}`);
  await p.goBack();
  await want("Product", `/f/${L.folders.Product}`);
  await p.goBack();
  await want("Senseloaf", `/w/${WS}`);
  await p.goForward();
  await want("Product", `/f/${L.folders.Product}`);
  // The rail switches in place too; so does the breadcrumb.
  await p.getByRole("treeitem", { name: "Design" }).first().click();
  if ((await h1()) !== "Design") fail("the rail click didn't switch at once");
  await want("Design", `/f/${L.folders.Design}`);
  await p.locator("#main nav[aria-label=Breadcrumb] a", { hasText: "Senseloaf" }).click();
  await want("Senseloaf", `/w/${WS}`);
  // A search in the URL, then a folder: the search clears.
  await p.goto(`${wsUrl}?q=Roadmap`, { waitUntil: "networkidle" });
  await p.getByText(/Results for/).first().waitFor({ timeout: 15000 });
  await p.getByRole("treeitem", { name: "Legal" }).first().click();
  await want("Legal", `/f/${L.folders.Legal}`);
  if (await p.getByText(/Results for/).count()) fail("the search stayed after opening a folder");
  // A modified click opens a new tab and leaves this one alone.
  const [tab] = await Promise.all([c.waitForEvent("page"), p.locator(`#main a[href$="/f/${L.nested.Specs}"]`).count().then(() => p.locator(`#main nav[aria-label=Breadcrumb] a`).first().click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] }))]);
  await tab.close();
  if (!(await h1()).includes("Legal")) fail("a modified click switched this tab");
  // Another workspace is an ordinary navigation.
  await p.getByRole("treeitem", { name: "Acme" }).first().click();
  await want("Acme", `/w/${S0.ws}`);
  void opened;
  await c.close();
});

/* ── View switch ────────────────────────────────────────────────────── */

await step("views", async () => {
  const { c, p } = await ctx(browser, { token: T.member });
  await p.goto(wsUrl, { waitUntil: "networkidle" });
  const sw = p.getByRole("radiogroup", { name: "View" });
  await sw.waitFor({ timeout: 20000 });
  if ((await p.locator("#main [data-view]").first().getAttribute("data-view")) !== "list") fail("the default view isn't List");
  // Keyboard: arrows move the choice (a radio group).
  await sw.getByRole("radio", { name: "List" }).focus();
  await p.keyboard.press("ArrowRight");
  if ((await p.locator("#main [data-view]").first().getAttribute("data-view")) !== "grid") fail("ArrowRight didn't pick Grid");
  await sw.getByRole("radio", { name: "Cards" }).click();
  if ((await p.locator("#main [data-view]").first().getAttribute("data-view")) !== "cards") fail("Cards didn't apply");
  // Remembered across a reload and on folder pages.
  await p.goto(fUrl(L.folders.Product), { waitUntil: "networkidle" });
  await p.locator("#main [data-view]").first().waitFor();
  if ((await p.locator("#main [data-view]").first().getAttribute("data-view")) !== "cards") fail("the view wasn't remembered on a folder page");
  // A broken localStorage never breaks the page.
  const c2 = await browser.newContext();
  await c2.addInitScript((t) => {
    localStorage.setItem("markdrop_token", t);
    const bad = () => { throw new Error("blocked"); };
    Object.defineProperty(window, "localStorage", { get() { return { getItem: (k) => (k === "markdrop_token" ? t : null), setItem: bad, removeItem: bad }; } });
  }, T.member);
  const p2 = await c2.newPage();
  await p2.goto(wsUrl, { waitUntil: "networkidle" });
  await p2.getByRole("radiogroup", { name: "View" }).getByRole("radio", { name: "Grid" }).click();
  if ((await p2.locator("#main [data-view]").first().getAttribute("data-view")) !== "grid") fail("the switch fails without storage");
  await c2.close();
  await c.close();
});

/* ── Card previews (feat/card-previews) ─────────────────────────────── */

const G = L.gallery || {};
const CARD_OUT = process.env.CARD_SHOTS || path.join(OUT, "cards");
// What each Gallery card's band shows once its preview is in (data-pv on .wl-card__band).
const EXPECT = {
  dash: "html", page: "page", pdf: "pdf", md: "markdown", photo: "image", csv: "sheet", video: "video", page2: "page",
  pricing: "html", docx: "docx", xlsx: "sheet", enc: "lock", md2: "markdown", arch: "image", status: "html", json: "text",
  page3: "page", release: "html", pw: "markdown",
};
const cardOf = (p, slug) => p.locator(`#main li[data-row-kind=item]:has(a[href$="/${slug}"])`).first();
const bandOf = (p, slug) => cardOf(p, slug).locator(".wl-card__band");
const NO_CDP = { on() {}, off() {}, send: async () => ({}) };

/** Requests to the previews endpoint (and the slugs each asked for), from now on. */
function watchPreviews(p) {
  const asked = [];
  p.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/items/previews")) {
      try { asked.push(...(JSON.parse(r.postData() || "{}").slugs || [])); } catch {}
    }
  });
  return asked;
}

await step("cards", async () => {
  if (!G.dash) fail("seed-listing.json has no gallery (reseed: unset NO_RESEED)");
  fs.mkdirSync(CARD_OUT, { recursive: true });
  // API: a preview only for what the caller can open; one answer for everything else.
  const pv = async (who, slugs) => api("POST", `/api/v1/workspaces/${WS}/items/previews`, T[who], { slugs });
  let r = await pv("member", [G.md, G.pw, G.enc, G.private, "no-such-item"]);
  if (r.status !== 200) fail(`member previews → ${r.status}`);
  const got = r.body.previews;
  if (got[G.md].state !== "ok" || got[G.md].type !== "markdown") fail(`markdown preview: ${JSON.stringify(got[G.md]).slice(0, 200)}`);
  if (got[G.pw].state !== "ok") fail("a member's role opens the password-protected doc, so it previews");
  if (JSON.stringify(got[G.enc]) !== '{"state":"encrypted"}') fail(`encrypted: ${JSON.stringify(got[G.enc])}`);
  if (JSON.stringify(got[G.private]) !== '{"state":"locked"}' || JSON.stringify(got["no-such-item"]) !== '{"state":"locked"}') fail("private/unknown must both be locked");
  if (JSON.stringify(got).includes("Not for you")) fail("the private doc's text leaked");
  r = await pv("reader", [G.md, G.private]);
  if (r.body.previews[G.md].state !== "ok" || r.body.previews[G.private].state !== "locked") fail("viewer previews");
  r = await pv("owner", [G.private]);
  if (r.body.previews[G.private].state !== "ok") fail("the owner previews her private doc");
  for (const who of ["stranger", null]) {
    const x = await api("POST", `/api/v1/workspaces/${WS}/items/previews`, who ? T[who] : null, { slugs: [G.md] });
    if (x.status < 400 || JSON.stringify(x.body).includes("API rate limits")) fail(`${who ?? "anonymous"} previews → ${x.status}`);
  }

  // The page: every kind, lazily, with the live HTML frame on hover.
  const { c, p } = await ctx(browser, { token: T.member, width: 1440, height: 900 });
  await c.addInitScript(() => { try { localStorage.setItem("md_ws_view", "cards"); } catch {} });
  const asked = watchPreviews(p);
  await p.goto(fUrl(L.folders.Gallery), { waitUntil: "load" });
  await cardOf(p, G.dash).waitFor({ timeout: 30000 });
  if (await cardOf(p, G.private).count()) fail("Ada's private doc is listed for Ben");
  for (const [k, want] of Object.entries(EXPECT)) {
    const band = bandOf(p, G[k]);
    await band.scrollIntoViewIfNeeded();
    try {
      await p.waitForFunction(([sel, w]) => document.querySelector(sel)?.getAttribute("data-pv") === w,
        [`#main li[data-row-kind=item]:has(a[href$="/${G[k]}"]) .wl-card__band`, want], { timeout: 25000, polling: 150 });
    } catch {
      fail(`${k}: band is ${await band.getAttribute("data-pv")} (want ${want})`);
    }
  }
  await p.evaluate(() => window.scrollTo(0, 0));
  // Nothing from an item renders as markup here: no script, style or iframe in the previews (no live frame yet).
  const markup = await p.locator("#main .wl-card__band script, #main .wl-card__band style, #main .wl-card__band b, #main .wl-card__band iframe").count();
  if (markup) fail(`${markup} element(s) from item content in the previews`);
  if (!(await bandOf(p, G.dash).innerText()).includes("Revenue") && !(await bandOf(p, G.dash).textContent()).includes("Q3 revenue")) fail("the HTML card's static text is missing");
  if (!(await bandOf(p, G.enc).textContent()).includes("End-to-end encrypted")) fail("the encrypted card has no lock");
  const pdfImg = await bandOf(p, G.pdf).locator("img").getAttribute("src");
  if (!pdfImg?.startsWith("data:image/webp;base64,")) fail("the PDF's first page isn't a data: WebP");
  // Owners and the ⋯ menu still work on a card with a picture.
  if (!(await cardOf(p, G.photo).locator("[data-owner]").count())) fail("no owner on the photo card");
  await cardOf(p, G.photo).hover();
  await cardOf(p, G.photo).getByRole("button", { name: /Actions for Team offsite/ }).click();
  await p.getByRole("menu").first().waitFor({ timeout: 5000 });
  await p.keyboard.press("Escape");
  await p.evaluate(() => document.activeElement?.blur());
  await p.mouse.move(5, 5);
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(CARD_OUT, `gallery-light-1440-${process.env.BROWSER || "chromium"}.png`) });

  // Live: hover an HTML card → its own URL in a sandboxed frame on the artifact origin; at most three at once.
  const live = async (k) => {
    await cardOf(p, G[k]).scrollIntoViewIfNeeded();
    await cardOf(p, G[k]).hover({ position: { x: 60, y: 60 } });
    await p.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("data-live") === "true",
      `#main li[data-row-kind=item]:has(a[href$="/${G[k]}"]) .wl-card__band`, { timeout: 20000, polling: 150 });
  };
  await live("dash");
  const frame = bandOf(p, G.dash).locator("iframe");
  const src = await frame.getAttribute("src");
  if ((await frame.getAttribute("sandbox")) !== "allow-scripts") fail(`live frame sandbox: ${await frame.getAttribute("sandbox")}`);
  if (!src || new URL(src).origin === new URL(APP).origin || !new URL(src).pathname.startsWith("/r/")) fail(`live frame src: ${src}`);
  await p.waitForTimeout(700);
  await p.screenshot({ path: path.join(CARD_OUT, `gallery-live-hover-1440-${process.env.BROWSER || "chromium"}.png`) });
  for (const k of ["pricing", "status", "release"]) await live(k);
  const frames = await p.locator("#main iframe").count();
  if (frames > 3) fail(`${frames} live frames (want ≤ 3)`);
  if (await bandOf(p, G.dash).locator("iframe").count()) fail("the oldest live frame wasn't let go");
  await c.close();

  // Lazy: a 60-item folder in Cards asks only for what's on screen, then more as it scrolls.
  {
    const { c: c2, p: p2 } = await ctx(browser, { token: T.member, width: 1440, height: 900 });
    await c2.addInitScript(() => { try { localStorage.setItem("md_ws_view", "cards"); } catch {} });
    const asked2 = watchPreviews(p2);
    await p2.goto(fUrl(L.folders.Archive), { waitUntil: "load" });
    await p2.locator("#main li[data-row-kind=item]").first().waitFor({ timeout: 30000 });
    await p2.waitForTimeout(3500);
    const first = new Set(asked2).size;
    if (first === 0 || first > 30) fail(`Archive asked for ${first} previews on its first screen (want 1–30 of 60)`);
    for (let i = 0; i < 12; i++) { await p2.mouse.wheel(0, 900); await p2.waitForTimeout(250); }
    await p2.waitForTimeout(2500);
    const after = new Set(asked2).size;
    if (after <= first) fail(`scrolling asked for no more previews (${first} → ${after})`);
    log(`lazy: ${first} previews on the first screen, ${after} after scrolling (of 60)`);
    await c2.close();
    // List (the default) and Grid never ask.
    const { c: c4, p: p4 } = await ctx(browser, { token: T.member, width: 1440, height: 900 });
    const asked3 = watchPreviews(p4);
    await p4.goto(fUrl(L.folders.Gallery), { waitUntil: "load" });
    await p4.locator("#main [data-view=list]").first().waitFor({ timeout: 20000 });
    await p4.getByRole("radiogroup", { name: "View" }).getByRole("radio", { name: "Grid" }).click();
    await p4.locator("#main [data-view=grid]").first().waitFor({ timeout: 5000 });
    await p4.waitForTimeout(2500);
    if (asked3.length) fail(`List/Grid asked for ${asked3.length} previews`);
    if (await p4.locator("#main .wl-pv").count()) fail("previews rendered outside Cards");
    await c4.close();
  }
  void asked;

  // Screenshots: desktop and phones, light and dark, the first screen and further down.
  for (const [theme, width] of [["light", 1440], ["dark", 1440], ["light", 390], ["dark", 390]]) {
    const phone = width < 500;
    const { c: c3, p: p3 } = await ctx(browser, { token: T.member, theme, width, height: phone ? 844 : 900, mobile: phone });
    await c3.addInitScript(() => { try { localStorage.setItem("md_ws_view", "cards"); } catch {} });
    await p3.goto(fUrl(L.folders.Gallery), { waitUntil: "load" });
    await cardOf(p3, G.dash).waitFor({ timeout: 30000 });
    const keys = phone ? ["dash", "page", "pdf"] : ["dash", "page", "pdf", "md", "photo", "csv", "video", "page2"];
    for (const k of keys) {
      await p3.waitForFunction(([sel, w]) => document.querySelector(sel)?.getAttribute("data-pv") === w,
        [`#main li[data-row-kind=item]:has(a[href$="/${G[k]}"]) .wl-card__band`, EXPECT[k]], { timeout: 25000, polling: 150 });
    }
    if (phone) {
      if (await p3.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail(`horizontal scroll at ${width}px`);
      await cardOf(p3, G.dash).scrollIntoViewIfNeeded();
    }
    await p3.waitForTimeout(600);
    await p3.screenshot({ path: path.join(CARD_OUT, `gallery-${theme}-${width}-${process.env.BROWSER || "chromium"}.png`) });
    {
      // The rest of the kinds: video, Word, sheets, the encrypted lock, text (desktop); more on phones.
      const more = phone ? ["md", "photo", "csv"] : ["video", "docx", "xlsx", "enc", "md2", "arch", "status", "json"];
      for (const k of more) {
        await cardOf(p3, G[k]).scrollIntoViewIfNeeded();
        await p3.waitForFunction(([sel, w]) => document.querySelector(sel)?.getAttribute("data-pv") === w,
          [`#main li[data-row-kind=item]:has(a[href$="/${G[k]}"]) .wl-card__band`, EXPECT[k]], { timeout: 25000, polling: 150 });
      }
      await cardOf(p3, G[more[0]]).evaluate((el) => el.scrollIntoView({ block: "start" }));
      await p3.evaluate(() => window.scrollBy(0, -24));
      await p3.waitForTimeout(500);
      await p3.screenshot({ path: path.join(CARD_OUT, `gallery-${theme}-${width}-more-${process.env.BROWSER || "chromium"}.png`) });
    }
    await c3.close();
  }
  log("card shots in", CARD_OUT);
});

await step("cards-timing", async () => {
  // Folder clicks stay instant in Cards: first feedback ≤ 100 ms (or within 30 ms of List), and the
  // destination's items no later than in List (+300 ms of slack), on Fast 4G with a 4× slower CPU (Chromium; WebKit has no
  // throttling, so it runs unthrottled).
  const runs = Number(process.env.RUNS || 2);
  const gallery = L.folders.Gallery, product = L.folders.Product, specs = L.nested.Specs;
  const titles = { product: await firstTitle(product), specs: await firstTitle(specs), gallery: await firstTitle(gallery), root: await firstTitle("root") };
  const out = {};
  for (const view of ["list", "cards"]) {
    out[view] = [];
    for (let i = 0; i < runs; i++) {
      const { c, p } = await ctx(browser, { token: T.member });
      await c.addInitScript((v) => { try { localStorage.setItem("md_ws_view", v); } catch {} }, view);
      let cdp = NO_CDP;
      if (process.env.BROWSER !== "webkit") {
        cdp = await c.newCDPSession(p);
        await cdp.send("Network.enable");
        await cdp.send("Network.emulateNetworkConditions", { offline: false, ...PROFILES["4g"] });
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      }
      await p.goto(wsUrl, { waitUntil: "load", timeout: 90000 });
      await p.waitForFunction((t) => document.querySelector("#main")?.innerText.includes(t), titles.root, { timeout: 60000 });
      await p.waitForTimeout(2500);
      const run = {};
      run.rootToGallery = await timedClick(p, cdp, `#main a[href$="/f/${gallery}"]`, { want: `/f/${gallery}`, text: titles.gallery });
      await p.waitForTimeout(2500); // the Gallery's previews load meanwhile (Cards)
      run.galleryToRoot = await timedClick(p, cdp, `#main nav a[href$="/w/${WS}"]`, { want: `/w/${WS}`, text: titles.root });
      await p.waitForTimeout(1200);
      run.rootToProduct = await timedClick(p, cdp, `#main a[href$="/f/${product}"]`, { want: `/f/${product}`, text: titles.product });
      await p.waitForTimeout(1200);
      run.productToSpecs = await timedClick(p, cdp, `#main a[href$="/f/${specs}"]`, { want: `/f/${specs}`, text: titles.specs });
      out[view].push(run);
      log(`${view} run ${i + 1}: ${Object.entries(run).map(([k, v]) => `${k} fb ${v.feedback} / content ${v.content} ms`).join("; ")}`);
      await c.close();
    }
  }
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const summary = {};
  for (const view of ["list", "cards"]) {
    summary[view] = {};
    for (const k of Object.keys(out[view][0])) summary[view][k] = { feedback: med(out[view].map((r) => r[k].feedback)), content: med(out[view].map((r) => r[k].content)) };
  }
  fs.mkdirSync(CARD_OUT, { recursive: true });
  fs.writeFileSync(path.join(CARD_OUT, `timing-cards-${process.env.BROWSER || "chromium"}.json`), JSON.stringify({ summary, out }, null, 1));
  console.log(JSON.stringify(summary, null, 1));
  for (const k of Object.keys(summary.cards)) {
    // ≤ 100 ms, or no worse than List where List itself is slower (a cold folder; navigation's own budget).
    const fbMax = Math.max(100, summary.list[k].feedback + 30);
    if (summary.cards[k].feedback > fbMax) fail(`cards ${k}: first feedback ${summary.cards[k].feedback} ms (want ≤ ${fbMax}; list ${summary.list[k].feedback})`);
    if (summary.cards[k].content > summary.list[k].content + 300) fail(`cards ${k}: content ${summary.cards[k].content} ms vs list ${summary.list[k].content} ms`);
  }
});

/* ── Screenshots ────────────────────────────────────────────────────── */

await step("shots", async () => {
  const dir = process.env.SHOTS_OUT || path.join(OUT, LABEL);
  fs.mkdirSync(dir, { recursive: true });
  for (const theme of ["light", "dark"]) {
    for (const width of [1440, 390]) {
      for (const view of LABEL === "after" ? ["list", "grid", "cards"] : ["-"]) {
        if (width === 390 && view === "cards") continue;
        const { c, p } = await ctx(browser, { token: T.member, theme, width, height: width < 500 ? 844 : 900, mobile: width < 500 });
        if (view !== "-") await c.addInitScript((v) => { try { localStorage.setItem("md_ws_view", v); } catch {} }, view);
        await p.goto(wsUrl, { waitUntil: "networkidle" });
        await p.locator(`#main a[href$="/f/${L.folders.Product}"]`).first().waitFor({ timeout: 20000 });
        await p.waitForTimeout(800);
        const tag = `${view === "-" ? "" : `${view}-`}${theme}-${width}`;
        await p.screenshot({ path: path.join(dir, `root-${tag}.png`), fullPage: false });
        await p.goto(fUrl(L.folders.Product), { waitUntil: "networkidle" });
        await p.waitForTimeout(800);
        await p.screenshot({ path: path.join(dir, `folder-${tag}.png`), fullPage: false });
        await c.close();
      }
    }
  }
  log("shots in", dir);
});

await browser.close();
fs.writeFileSync(path.join(OUT, `results-${LABEL}.json`), JSON.stringify(results, null, 1));
console.log("\nResults (listing):");
for (const [n, r] of results) console.log(`  ${r === "ok" ? "✓" : "✗"} ${n}: ${r}`);
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
