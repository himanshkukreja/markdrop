/**
 * The in-app workspace listing on the REAL stack (fix/ws-listing): folder-click timing under
 * throttling, the owner on every row (and the privacy matrix), the List / Grid / Cards switch, renames
 * made in another tab or by someone else showing without a reload, screenshots, and opening every kind
 * of item without a flash of other UI (open; seed_open.py). Seeds the busy "Senseloaf" workspace
 * (seed_listing.py) on top of seed.py.
 *
 *   PB_STACK_ID=12 [ONLY=timing,owner,views,privacy,nav,renames,shots,open] [PROFILES=4g,3g] [RUNS=3] node listing.mjs
 *
 * `timing` is selector-agnostic (it clicks folder links by href and watches the page), so it also
 * measures an older build: LABEL=before writes timing-before.json, LABEL=after timing-after.json.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { APP, API, WORKER, BROWSER, SHOTS, STACK, STACK_ID, log, fail, reseed, seedNow, api, launch, ctx, shot, stepper } from "./lib.mjs";
import { armOpenProbe, settledTimeline, foreign, fmt, slow3g, TARGET } from "./openProbe.mjs";

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
  // Network and CPU throttling and request timings come from the DevTools protocol: Chromium only.
  if (BROWSER !== "chromium") return log("timing: Chromium only (CDP), skipped");
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

/* ── Renames elsewhere show without a reload (fix/followups) ─────────── */

await step("renames", async () => {
  // Archive: the busy folder (60 items, so pages of Ben's and documents of Ada's on its first page).
  const archive = L.folders.Archive;
  const rows = (await api("GET", `/api/v1/workspaces/${WS}/items?folder=${archive}&limit=50`, T.member)).body.items;
  const mine = rows.find((i) => i.editor === "blocks" && i.owner?.name === "Ben Member" && i.can.edit);
  const adas = rows.filter((i) => !i.editor && i.kind === "markdown" && i.owner?.name === "Ada Owner");
  if (!mine || adas.length < 2) fail(`seed: no page of Ben's or two documents of Ada's in Archive (${rows.length} rows)`);
  const renameDoc = async (slug, title) => {
    const d = (await api("GET", `/api/v1/documents/${slug}`, T.owner)).body;
    const r = await api("PUT", `/api/v1/documents/${slug}`, T.owner, { title, content: d.content });
    if (r.status !== 200) fail(`rename ${slug} → ${r.status}`);
  };
  const renameFolder = async (id, name) => {
    const r = await api("PATCH", `/api/v1/workspaces/${WS}/folders/${id}`, T.owner, { name });
    if (r.status >= 300) fail(`rename folder → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  };
  const { c, p } = await ctx(browser, { token: T.member });
  const shows = (t, timeout, focus = false) =>
    p.waitForFunction(
      ([t, focus]) => {
        // "Coming back to the window": the event a tab switch or a click into the window fires.
        if (focus) window.dispatchEvent(new Event("focus"));
        return document.querySelector("#main")?.innerText.includes(t);
      },
      [t, focus],
      { timeout, polling: 250 },
    );
  try {
    await p.goto(fUrl(archive), { waitUntil: "networkidle" });
    await p.locator("#main [data-row-kind=item]").first().waitFor({ timeout: 20000 });
    // 1. Ben renames his page in another tab: this tab's row follows at once (the save's event, no poll).
    const tab = await c.newPage();
    await tab.goto(`${APP}/${mine.slug}`, { waitUntil: "networkidle" });
    const title = tab.getByLabel("Page title");
    await title.waitFor({ timeout: 20000 });
    const saved = tab.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/api/v1/documents/${mine.slug}`) && r.ok(), { timeout: 20000 });
    await title.fill(`${mine.title} (renamed in a tab)`);
    await saved;
    const t0 = Date.now();
    await shows(`${mine.title} (renamed in a tab)`, 8000);
    log(`another tab's rename: on screen ${Date.now() - t0} ms after its save`);
    await tab.close();
    // 2. Ada renames a document and this folder: they show with no reload and no focus (the poll).
    await renameDoc(adas[0].slug, `${adas[0].title} (renamed by Ada)`);
    await renameFolder(archive, "Archive (renamed)");
    const t1 = Date.now();
    await shows(`${adas[0].title} (renamed by Ada)`, 45000);
    await shows("Archive (renamed)", 45000);
    log(`someone else's renames: on screen in ${Date.now() - t1} ms (no focus)`);
    // 3. Coming back to the window picks one up sooner than the poll would.
    await renameDoc(adas[1].slug, `${adas[1].title} (renamed again)`);
    const t2 = Date.now();
    await shows(`${adas[1].title} (renamed again)`, 15000, true);
    log(`a rename picked up on focus in ${Date.now() - t2} ms`);
    if (Date.now() - t2 > 12000) fail(`focus took ${Date.now() - t2} ms`);
  } finally {
    await renameFolder(archive, "Archive").catch(() => {});
    await c.close();
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

/* ── Opening an item (fix/open-flash) ─────────────────────────────────
   Click each kind from the listing (a page, a document, an HTML / PDF / CSV / MP4 file) as the owner
   and as a member: the new tab goes straight to the item. Nothing in between may wear other chrome
   (the app header, a document's bar over a page or a file, the framed reader before full screen)
   or another theme; a loading state is fine in the item's own chrome. Some on slow 3G. And the
   cover is no way in: a signed-in stranger and a signed-out visitor still get the gate. */

await step("open", async () => {
  execFileSync(PY, [path.join(path.dirname(new URL(import.meta.url).pathname), "seed_open.py")], {
    stdio: "pipe", env: { ...process.env, STACK_ID: String(STACK_ID), PB_STACK: STACK },
  });
  const O = JSON.parse(fs.readFileSync(path.join(STACK, "seed-open.json"), "utf8"));
  const runs = [];
  for (const who of ["owner", "member"]) for (const kind of Object.keys(TARGET)) runs.push({ who, kind, prof: "fast" });
  for (const kind of ["page", "doc", "pdf"]) runs.push({ who: "member", kind, prof: "slow3g" });
  const bad = [];
  for (const { who, kind, prof } of runs) {
    const slug = O.items[kind];
    const { c, p } = await ctx(browser, { token: O.users[who].token });
    await armOpenProbe(c);
    await p.goto(`${APP}/w/${O.ws}`, { waitUntil: "load" });
    const link = p.locator(`#main a[href="/${slug}"]`).first();
    await link.waitFor({ timeout: 30000 });
    if (prof === "slow3g") await slow3g(c, { app: APP, api: API, worker: WORKER });
    const [tab] = await Promise.all([c.waitForEvent("page"), link.click()]);
    const tl = await settledTimeline(tab, { timeout: prof === "slow3g" ? 120000 : 30000 });
    await c.close();
    const end = tl[tl.length - 1];
    const f = foreign(tl);
    const off = !end || end.chrome !== TARGET[kind].chrome || end.body !== TARGET[kind].body;
    log(`${f.length || off ? "✗" : "✓"} open ${who} ${kind} ${prof}: ${fmt(tl)}`);
    if (f.length || off) bad.push(`${who} ${kind} ${prof}: ${fmt(tl)}`);
  }
  // No session, or a session without access: the gate, never the item, and (signed out) no cover.
  for (const who of ["stranger", null]) {
    const token = who ? S0.users[who].token : null;
    const { c, p } = await ctx(browser, { token });
    await armOpenProbe(c);
    await p.goto(`${APP}/${O.items.page}`, { waitUntil: "load" });
    await p.locator("section[aria-labelledby='md-gate-title']").first().waitFor({ timeout: 30000 });
    await p.waitForTimeout(500);
    const tl = await p.evaluate(() => window.__open || []);
    await c.close();
    log(`  open as ${who ?? "signed out"}: ${fmt(tl)}`);
    if (tl.some((e) => e.body === "content" || e.body === "frame")) bad.push(`${who ?? "signed out"} saw the item: ${fmt(tl)}`);
    if (tl[tl.length - 1]?.body !== "gate") bad.push(`${who ?? "signed out"} didn't end on the gate: ${fmt(tl)}`);
    if (!who && tl.some((e) => e.body === "loader" || e.body === "ground")) bad.push(`signed out saw the opening cover: ${fmt(tl)}`);
  }
  if (bad.length) fail(`${bad.length} open(s) flashed:\n  ${bad.join("\n  ")}`);
});

await browser.close();
fs.writeFileSync(path.join(OUT, `results-${LABEL}.json`), JSON.stringify(results, null, 1));
console.log("\nResults (listing):");
for (const [n, r] of results) console.log(`  ${r === "ok" ? "✓" : "✗"} ${n}: ${r}`);
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
