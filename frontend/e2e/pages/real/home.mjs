/**
 * Home (/dashboard) and the sidebar on the REAL stack (feat/home-redesign; .work/home/SPEC.md). Run with
 * PB_FAKE_ASK_AI=1 PB_FAKE_MEETINGS_AI=1 (up.sh) so meetings get notes and action items from the fake model.
 *
 *   sections   greeting, Ask bar, Continue (with previews), Today, Action items, Meetings, Workspaces
 *   ask        the Ask bar sends its question to the assistant panel; a chip asks too
 *   continue   a Continue card opens the item
 *   tick       ticking an action item marks the line done on its page (and it leaves the list)
 *   meetings   the Meetings section's cards open meetings; "Open Meetings" opens the hub, no dialog;
 *              Import meeting opens the hub's import dialog
 *   sidebar    Home / My files / Meetings (under a workspace) in the sidebar; Meetings opens the hub
 *              without the import dialog; collapse to the icon rail and back (remembered)
 *   files      /dashboard?kind=… (old links) forward to /dashboard/files; My files keeps its list
 *   empty      a new account gets "Get started"
 *   tasks      the usability tasks, each ≤ 2 clicks/taps from Home, on desktop, tablet and phone
 *   audit      phone-360/393, iPad mini portrait, iPad Air landscape (+ desktop), light and dark: no
 *              sideways scroll, nothing cut off, 44 px targets, 16 px inputs, no hover-only controls;
 *              the phone drawer and tablet rail show Meetings
 *   standalone the installed app (display-mode: standalone): Home is the start screen, fits the screen
 *   shots      the review set: phone light/dark, tablet portrait/landscape, desktop light/dark, empty state
 *
 *   PB_STACK_ID=56 PB_WORK=… BROWSER=chromium|webkit [ONLY=sections,tick] [NO_RESEED=1] node home.mjs
 * Screenshots: $HOME_SHOTS (default <PB_WORK>/../shots/after).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { APP, BROWSER, STACK, STACK_ID, WORK, log, fail, reseed, seedNow, api, launch, ctx, stepper } from "./lib.mjs";
import { measure } from "./mobile-shell-measure.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "../../../..").split("/.claude/worktrees/")[0];
const PY = path.join(ROOT, "backend", ".venv", "bin", "python");
const OUT = process.env.HOME_SHOTS || path.resolve(WORK, "..", "shots", "after");
fs.mkdirSync(OUT, { recursive: true });

const browser = await launch();
const { step, results } = stepper(browser);
const ok = (r, what) => { if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const pad = (n) => String(n).padStart(2, "0");
const day = (offset = 0) => { const d = new Date(Date.now() - offset * 86_400_000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/* ── The world ────────────────────────────────────────────────────────── */

const EXTRA = path.join(STACK, "seed-home.json");
let S, T, WS, X;
if (process.env.NO_RESEED && fs.existsSync(EXTRA)) {
  S = seedNow();
  X = JSON.parse(fs.readFileSync(EXTRA, "utf8"));
} else {
  S = reseed();
  execFileSync(PY, [path.join(HERE, "seed_listing.py")], { stdio: "pipe", env: { ...process.env, STACK_ID: String(STACK_ID), PB_STACK: STACK } });
}
T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
WS = S.ws;

const call = (title, d, time, lines, attendees = "Ada Owner, Ben Member, Vic Viewer") => `${title} (${d} ${time} GMT+05:30) - Transcript
Attendees
${attendees}
Transcript
This editable transcript was computer generated and might contain errors. People can also change the text after it was created.
${lines.join("\n")}
Transcription ended after 00:21:40
`;

if (!X) {
  const adaId = S.users.owner.id;
  const meetings = [
    call("Daily standup", day(0), "09:30", [
      "Ada Owner: Morning everyone, quick round please.",
      "Ben Member: Yesterday I fixed the export bug. Today I'm on the onboarding emails.",
      "Ada Owner: I will review the launch post before lunch.",
      "Ada Owner: We agree the release candidate is cut on Thursday.",
      "Vic Viewer: Is the pricing page copy blocked on finance?",
    ]),
    call("Sprint planning", day(1), "11:00", [
      "Ada Owner: Two things today, the release date and the pricing page.",
      "Ben Member: QA signed off last night, so we can ship the release on Friday.",
      "Ada Owner: Then we agree to ship the release on Friday if the staging dry run passes.",
      "Ada Owner: I will send the customer email about the new importer.",
      "Ben Member: I will update the onboarding docs with the new screenshots.",
    ]),
    call("Pricing review with finance", day(3), "16:00", [
      "Ada Owner: Finance wants the annual discount at 20 percent.",
      "Ben Member: We agree on 20 percent for annual plans, monthly stays the same.",
      "Ada Owner: I will update the pricing page copy by Monday.",
    ], "Ada Owner, Ben Member"),
  ];
  X = { meetings: [] };
  for (const text of meetings) {
    const r = ok(await api("POST", "/api/v1/meetings/import", T.owner, { workspace: WS, wait: true, sources: [{ name: text.split("\n")[0], text }] }), "import");
    X.meetings.push(r.meetings[0]);
  }
  // A page of Ben's in Acme that gives Ada two to-dos (mentions notify her too).
  const pg = ok(await api("POST", "/api/v1/pages", T.member, {
    title: "Launch week plan", workspace: WS,
    content: `# Launch week plan\n\n- [ ] :person[Ada Owner]{id="${adaId}"} Approve the launch budget {#b-hmhm0001}\n- [ ] :person[Ada Owner]{id="${adaId}"} Record the product demo voice-over {#b-hmhm0002}\n- [ ] :person[Ben Member]{id="${S.users.member.id || ""}"} Book the venue {#b-hmhm0003}\n`,
  }), "plan page");
  X.plan = pg.document.slug;
  // Recent: Ada opens a few things (pages first, newest last).
  const L = JSON.parse(fs.readFileSync(path.join(STACK, "seed-listing.json"), "utf8"));
  const gal = L.gallery || {};
  for (const k of ["csv", "pdf", "dash", "md", "page2", "page"]) if (gal[k]) await api("GET", `/api/v1/documents/${gal[k]}`, T.owner);
  await api("GET", `/api/v1/documents/${X.meetings[0].slug}`, T.owner);
  await api("GET", `/api/v1/documents/${X.plan}`, T.owner);
  // Someone asks Ada for access to her private draft (Today: an access request).
  if (gal.private) await api("POST", `/api/v1/documents/${gal.private}/access-requests`, T.stranger, { message: "Could I read this?" });
  // A brand-new account for the empty state: Cy (stranger) with nothing opened.
  execFileSync(PY, ["-c", `
from pymongo import MongoClient
db = MongoClient("mongodb://127.0.0.1:27019")["markdrop_docs_demo_${STACK_ID}"]
u = db.users.find_one({"email": "${S.users.stranger.email}"})
db.recent_views.delete_many({"user_id": str(u["_id"])})
`]);
  fs.writeFileSync(EXTRA, JSON.stringify(X));
  await new Promise((r) => setTimeout(r, 1500));
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

async function snap(p, name, full = false) {
  await p.waitForTimeout(500);
  const file = path.join(OUT, `${BROWSER}-${name}.png`);
  await p.screenshot({ path: file, fullPage: full });
  log("shot", path.basename(file));
}

async function home(p) {
  await p.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
  await p.getByTestId("home").waitFor({ timeout: 20000 });
  // Every section loaded (skeletons gone).
  await p.waitForFunction(() => !document.querySelector('[data-testid="home"] [aria-hidden="true"] .md-skeleton, [data-testid="home"] li[aria-hidden="true"]'), null, { timeout: 20000 }).catch(() => {});
  await p.waitForTimeout(300);
}

const DEVICES = {
  "phone-360": { w: 360, h: 780, mobile: true },
  "phone-393": { w: 393, h: 852, mobile: true },
  "ipad-mini": { w: 744, h: 1133, mobile: true },
  "ipad-air": { w: 820, h: 1180, mobile: true },
  "ipad-air-land": { w: 1180, h: 820, mobile: true },
  desktop: { w: 1440, h: 900, mobile: false },
};

async function device(name, { token = T.owner, theme = "light", standalone = false } = {}) {
  const d = DEVICES[name];
  const c = await browser.newContext({
    viewport: { width: d.w, height: d.h }, deviceScaleFactor: d.mobile ? 2 : 1, colorScheme: theme,
    ...(d.mobile ? { hasTouch: true, isMobile: BROWSER !== "webkit" ? true : undefined } : {}),
  });
  await c.addInitScript(([t, th, sa]) => {
    try {
      if (t) localStorage.setItem("markdrop_token", t);
      localStorage.setItem("md_theme", th);
      localStorage.setItem("md_theme_beta", "1");
      localStorage.setItem("md_consent", "denied");
      localStorage.setItem("md_install_dismissed", "1");
      if (!sessionStorage.getItem("hm_fresh")) { localStorage.removeItem("md_rail_collapsed"); sessionStorage.setItem("hm_fresh", "1"); }
    } catch {}
    if (sa) {
      const mm = window.matchMedia.bind(window);
      window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false } : mm(q));
      Object.defineProperty(navigator, "standalone", { get: () => true });
    }
  }, [token, theme, standalone]);
  const p = await c.newPage();
  p.on("pageerror", (e) => log("  [pageerror]", name, e.message.slice(0, 200)));
  return { c, p, d };
}

/** Every animation finished (a drawer's slide-in scales its text while it runs). */
async function settled(p) {
  await p.waitForTimeout(250);
  await p.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity), null, { timeout: 5000 }).catch(() => {});
  await p.waitForTimeout(150);
}

const isPhone = (name) => name.startsWith("phone");
const isTablet = (name) => name.startsWith("ipad") && DEVICES[name].w < 1024;

/* ── Steps ────────────────────────────────────────────────────────────── */

await step("sections", async () => {
  const { p } = await device("desktop");
  await home(p);
  const h1 = (await p.locator("main h1").first().innerText()).trim();
  if (!/^Good (morning|afternoon|evening), Ada$/.test(h1)) fail(`greeting: ${h1}`);
  for (const id of ["home-ask", "home-continue", "home-today", "home-actions", "home-meetings", "home-workspaces"]) {
    if (!(await p.getByTestId(id).isVisible())) fail(`${id} not shown`);
  }
  const cards = await p.getByTestId("home-continue-card").count();
  if (cards < 4) fail(`only ${cards} Continue cards`);
  // Previews arrive for the cards on screen (pages: their cover / blocks).
  await p.waitForFunction(() => document.querySelectorAll('[data-testid="home-continue"] .wl-card__band:not([data-pv="icon"])').length >= 2, null, { timeout: 15000 });
  const facts = await p.getByTestId("home-facts").innerText();
  if (!/1 meeting today/.test(facts) || !/open action item/.test(facts)) fail(`facts line: ${facts}`);
  const today = await p.getByTestId("home-today-meeting").count();
  if (today !== 1) fail(`${today} meetings in Today`);
  const actions = await p.getByTestId("home-action").allInnerTexts();
  if (!actions.some((a) => /Approve the launch budget/.test(a))) fail(`actions: ${actions.join(" | ")}`);
  if (actions.some((a) => /Book the venue/.test(a))) fail("Ben's to-do is on Ada's list");
  if (actions.some((a) => /^@Ada/.test(a.trim()))) fail("own mention left in the text");
  const meet = await p.getByTestId("home-meeting-card").count();
  if (meet < 3) fail(`${meet} meeting cards`);
  const ws = await p.getByTestId("home-workspace").allInnerTexts();
  if (!ws.some((t) => /Acme/.test(t)) || !ws.some((t) => /Senseloaf/.test(t))) fail(`workspaces: ${ws}`);
  // Order: greeting, Ask, Continue, Today | Actions, Meetings, Workspaces.
  const order = await p.evaluate(() => ["home-ask", "home-continue", "home-today", "home-meetings", "home-workspaces"]
    .map((id) => document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect().top));
  if (order.some((t, i) => i && t < order[i - 1])) fail(`sections out of order: ${order}`);
  await snap(p, "desktop-light");
  await snap(p, "desktop-light-full", true);
});

await step("ask", async () => {
  const { p } = await device("desktop");
  await home(p);
  await p.getByTestId("home-ask-input").fill("When do we ship the release?");
  await p.getByTestId("home-ask-input").press("Enter");
  const panel = p.getByTestId("assistant");
  await panel.waitFor({ timeout: 10000 });
  await p.waitForFunction(() => /When do we ship the release\?/.test(document.querySelector('[data-testid="assistant"]')?.innerText || ""), null, { timeout: 15000 });
  await snap(p, "ask-panel");
  await p.getByTestId("assistant-close").click();
  await panel.waitFor({ state: "hidden", timeout: 5000 });
  // A chip asks too.
  await p.getByTestId("home-ask").getByRole("button", { name: /Catch me up/ }).click();
  await panel.waitFor({ timeout: 10000 });
  await p.waitForFunction(() => /Catch me up/i.test(document.querySelector('[data-testid="assistant"]')?.innerText || ""), null, { timeout: 15000 });
});

await step("continue", async () => {
  const { p } = await device("desktop");
  await home(p);
  const card = p.getByTestId("home-continue-card").first();
  const href = await card.getAttribute("href");
  // An item in a workspace with a live domain opens there (openHref, like Recent); the rest here.
  const slug = new URL(href, APP).pathname;
  await card.click();
  await p.waitForURL((u) => u.pathname !== "/dashboard", { timeout: 15000 });
  await p.waitForFunction((s) => location.href.includes(s.slice(1)) || location.hostname !== "localhost", slug, { timeout: 15000 });
});

await step("tick", async () => {
  const { p } = await device("desktop");
  await home(p);
  const row = p.getByTestId("home-action").filter({ hasText: "Approve the launch budget" });
  await row.getByTestId("home-action-tick").click();
  await p.getByText("Marked done").first().waitFor({ timeout: 8000 });
  await row.waitFor({ state: "detached", timeout: 5000 });
  if (!/open action item/.test(await p.getByTestId("home-facts").innerText())) fail("facts line lost its count");
  const doc = ok(await api("GET", `/api/v1/documents/${X.plan}`, T.owner), "plan");
  if (!/- \[x\] :person\[Ada Owner\][^\n]*Approve the launch budget/.test(doc.content)) fail("the line wasn't ticked on the page");
  if (/- \[x\][^\n]*Record the product demo/.test(doc.content)) fail("the wrong line was ticked");
  // Undo (the toast's action) opens it again, and it comes back to the list.
  await p.getByRole("button", { name: "Undo" }).first().click();
  await p.getByTestId("home-action").filter({ hasText: "Approve the launch budget" }).waitFor({ timeout: 8000 });
  const again = ok(await api("GET", `/api/v1/documents/${X.plan}`, T.owner), "plan");
  if (!/- \[ \] :person\[Ada Owner\][^\n]*Approve the launch budget/.test(again.content)) fail("Undo didn't open the line again");
});

await step("meetings", async () => {
  const { p } = await device("desktop");
  await home(p);
  const card = p.getByTestId("home-meeting-card").first();
  const href = await card.getAttribute("href");
  if (!href || !X.meetings.some((m) => href === `/${m.slug}`)) fail(`first meeting card links to ${href}`);
  const open = p.getByTestId("home-open-meetings").first();
  if ((await open.getAttribute("href")) !== `/meetings/${WS}`) fail(`Open Meetings → ${await open.getAttribute("href")}`);
  await open.click();
  await p.waitForURL(`${APP}/meetings/${WS}`, { timeout: 15000 });
  await p.waitForTimeout(1200);
  if (await p.locator('[role="dialog"]').isVisible().catch(() => false)) fail("the hub opened a dialog");
  // Import meeting (two workspaces: a menu) opens the hub's import dialog.
  await home(p);
  await p.getByTestId("home-import-meeting").click();
  await p.getByRole("menuitem", { name: "Acme" }).click();
  await p.waitForURL(/\/meetings\/[0-9a-f]{24}\?import=1/, { timeout: 15000 });
  await p.locator('[role="dialog"]').first().waitFor({ timeout: 10000 });
});

await step("sidebar", async () => {
  const { p } = await device("desktop");
  await home(p);
  const rail = p.locator('aside[data-rail="full"] nav[aria-label="Your drive"]');
  if ((await rail.getByRole("link", { name: "Home" }).getAttribute("aria-current")) !== "page") fail("Home isn't current");
  // Open Acme in the tree: Meetings is its first entry.
  const acme = rail.getByRole("treeitem", { name: /Acme/ }).first();
  if ((await acme.getAttribute("aria-expanded")) !== "true") await acme.locator("button[aria-label*='Expand'], [data-tree-toggle]").first().click().catch(async () => { await acme.press("ArrowRight"); });
  const meetings = rail.locator(`a[href="/meetings/${WS}"]`);
  await meetings.waitFor({ timeout: 10000 });
  await meetings.click();
  await p.waitForURL(`${APP}/meetings/${WS}`, { timeout: 15000 });
  await p.waitForTimeout(1200);
  if (await p.locator('[role="dialog"]').isVisible().catch(() => false)) fail("the hub opened a dialog from the sidebar");
  if ((await rail.locator(`a[href="/meetings/${WS}"]`).getAttribute("aria-current")) !== "page") fail("Meetings isn't current in the sidebar");
  await rail.getByRole("link", { name: "My files" }).click();
  await p.waitForURL(`${APP}/dashboard/files`, { timeout: 15000 });
  await p.locator("main h1", { hasText: "My files" }).waitFor({ timeout: 15000 });
  // Collapse to the icon rail; remembered after a reload; expand again.
  await p.getByTestId("rail-collapse").click();
  await p.locator('aside[data-rail="collapsed"]').waitFor({ timeout: 5000 });
  await snap(p, "desktop-rail-collapsed");
  await p.reload({ waitUntil: "networkidle" });
  await p.locator('aside[data-rail="collapsed"]').waitFor({ timeout: 5000 });
  await p.locator('aside[data-rail="collapsed"]').getByTestId("rail-expand").click();
  await p.locator('aside[data-rail="full"]').waitFor({ timeout: 5000 });
});

await step("files", async () => {
  const { p } = await device("desktop");
  await p.goto(`${APP}/dashboard?kind=document`, { waitUntil: "networkidle" });
  await p.waitForURL(`${APP}/dashboard/files?kind=document`, { timeout: 15000 });
  await p.locator("main h1", { hasText: "Documents" }).waitFor({ timeout: 15000 });
  const rows = await p.locator('main ul[aria-label="Documents"] > li').count();
  if (rows < 5) fail(`only ${rows} rows in My files › Documents`);
  await snap(p, "files-desktop");
});

await step("empty", async () => {
  for (const [dev, theme] of [["desktop", "light"], ["phone-393", "light"], ["phone-393", "dark"]]) {
    const { c, p } = await device(dev, { token: T.stranger, theme });
    await home(p);
    await p.getByTestId("home-get-started").waitFor({ timeout: 10000 });
    for (const id of ["home-start-page", "home-start-upload", "home-start-workspace", "home-start-connect"]) {
      if (!(await p.getByTestId(id).isVisible())) fail(`${id} missing (${dev})`);
    }
    if (await p.getByTestId("home-continue").count()) fail("Continue shown to a new account");
    await snap(p, `empty-${dev}-${theme}`, true);
    await c.close();
  }
});

/** Clicks from Home to each task's goal (counted by what the test does), per device. */
await step("tasks", async () => {
  const report = [];
  for (const dev of ["desktop", "ipad-mini", "phone-393"]) {
    const run = async (name, fn) => {
      const { c, p } = await device(dev);
      await home(p);
      const clicks = await fn(p);
      report.push([dev, name, clicks]);
      if (clicks > 2) fail(`${dev}: "${name}" took ${clicks} clicks`);
      await c.close();
    };
    const tap = async (loc) => { await loc.scrollIntoViewIfNeeded(); await loc.click(); };
    await run("continue my last page", async (p) => {
      await tap(p.getByTestId("home-continue-card").first());
      await p.waitForURL((u) => !u.pathname.startsWith("/dashboard"), { timeout: 15000 });
      return 1;
    });
    await run("find today's meeting", async (p) => {
      await tap(p.getByTestId("home-today-meeting").first());
      await p.waitForURL(`${APP}/${X.meetings[0].slug}`, { timeout: 15000 });
      return 1;
    });
    await run("ask a question", async (p) => {
      await p.getByTestId("home-ask-input").fill("What did we decide about pricing?");
      await p.getByTestId("home-ask-input").press("Enter");
      await p.getByTestId("assistant").waitFor({ timeout: 10000 });
      return 1;
    });
    await run("see my action items", async (p) => {
      await p.getByTestId("home-action").first().scrollIntoViewIfNeeded();
      if (!(await p.getByTestId("home-action").first().isVisible())) fail("no action items visible");
      return 0;
    });
    await run("open a workspace", async (p) => {
      await tap(p.getByTestId("home-workspace").first());
      await p.waitForURL(/\/w\/[0-9a-f]{24}/, { timeout: 15000 });
      return 1;
    });
    await run("create a page", async (p) => {
      await p.locator("header .md-create, header [aria-label='Create'], header button:has-text('Create')").first().click();
      await p.getByRole("menuitem", { name: /New page|Page/ }).first().click();
      await p.waitForURL(/\/pages\/new|\/new/, { timeout: 15000 });
      return 2;
    });
    await run("import a meeting", async (p) => {
      await tap(p.getByTestId("home-import-meeting"));
      let n = 1;
      const item = p.getByRole("menuitem", { name: "Acme" });
      if (await item.isVisible().catch(() => false)) { await item.click(); n++; }
      await p.waitForURL(/\/meetings\/[0-9a-f]{24}\?import=1/, { timeout: 15000 });
      return n;
    });
    await run("open My files", async (p) => {
      let n = 0;
      if (isPhone(dev)) { await p.getByTestId("app-menu").click(); n++; }
      const nav = isPhone(dev) ? p.locator('[role="dialog"] nav[aria-label="Your drive"]') : p.locator(`aside[data-rail="${isTablet(dev) ? "tablet" : "full"}"] nav[aria-label="Your drive"]`);
      await nav.locator('a[href="/dashboard/files"]').click();
      n++;
      await p.waitForURL(`${APP}/dashboard/files`, { timeout: 15000 });
      return n;
    });
  }
  fs.writeFileSync(path.join(OUT, `tasks-${BROWSER}.json`), JSON.stringify(report, null, 1));
  log("tasks", report.map(([d, n, c]) => `${d}: ${n} = ${c}`).join("; "));
});

await step("audit", async () => {
  const findings = [];
  const plan = [
    ["phone-360", "light"], ["phone-360", "dark"], ["phone-393", "light"], ["phone-393", "dark"],
    ["ipad-mini", "light"], ["ipad-mini", "dark"], ["ipad-air-land", "light"], ["ipad-air-land", "dark"],
  ];
  for (const [dev, theme] of plan) {
    const { c, p } = await device(dev, { theme });
    await home(p);
    for (const f of await p.evaluate(measure, { checkTargets: true })) findings.push({ dev, theme, state: "home", ...f });
    await snap(p, `${dev}-${theme}`);
    if (theme === "light") await snap(p, `${dev}-${theme}-full`, true);
    if (isPhone(dev)) {
      await p.getByTestId("app-menu").click();
      const drawer = p.locator('[role="dialog"]').filter({ has: p.locator('nav[aria-label="Your drive"]') });
      await drawer.waitFor({ timeout: 5000 });
      const acme = drawer.getByRole("treeitem", { name: /Acme/ }).first();
      if ((await acme.getAttribute("aria-expanded")) !== "true") await acme.press("ArrowRight").catch(() => {});
      await drawer.locator(`a[href="/meetings/${WS}"]`).waitFor({ timeout: 8000 }).catch(() => fail(`${dev}: no Meetings in the drawer`));
      // The keyboard focus (it shows the row's + and ⋯) goes; the slide-in finishes.
      await p.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      await settled(p);
      for (const f of await p.evaluate(measure, { checkTargets: true })) findings.push({ dev, theme, state: "drawer", ...f });
      await snap(p, `${dev}-${theme}-drawer`);
    } else if (isTablet(dev)) {
      const rail = p.locator('aside[data-rail="tablet"]');
      if (!(await rail.isVisible())) fail(`${dev}: no icon rail`);
      if (!(await rail.getByTestId("rail-meetings").isVisible())) fail(`${dev}: no Meetings in the rail`);
      await rail.getByTestId("rail-expand").click();
      const drawer = p.locator('[role="dialog"]').filter({ has: p.locator('nav[aria-label="Your drive"]') });
      await drawer.waitFor({ timeout: 5000 });
      await settled(p);
      for (const f of await p.evaluate(measure, { checkTargets: true })) findings.push({ dev, theme, state: "drawer", ...f });
      await snap(p, `${dev}-${theme}-drawer`);
    }
    await c.close();
  }
  fs.writeFileSync(path.join(OUT, `audit-${BROWSER}.json`), JSON.stringify(findings, null, 1));
  if (findings.length) fail(`${findings.length} audit findings: ${findings.slice(0, 8).map((f) => `${f.dev}/${f.theme}/${f.state} ${f.rule} ${f.who} ${f.detail}`).join(" | ")}`);
});

await step("standalone", async () => {
  for (const dev of ["phone-393", "ipad-mini"]) {
    const { c, p } = await device(dev, { standalone: true });
    await p.goto(`${APP}/dashboard?source=pwa`, { waitUntil: "networkidle" });
    await p.getByTestId("home").waitFor({ timeout: 20000 });
    if (!(await p.getByTestId("home-ask-input").isVisible())) fail(`${dev}: the Ask bar isn't on the first screen`);
    const box = await p.getByTestId("home-ask").boundingBox();
    if (!box || box.y + box.height > DEVICES[dev].h) fail(`${dev}: Ask bar below the fold`);
    const sw = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (sw > 1) fail(`${dev}: scrolls sideways by ${sw}`);
    if (!/[?&]source=pwa/.test(p.url()) && !p.url().startsWith(`${APP}/dashboard`)) fail(`left the home: ${p.url()}`);
    await snap(p, `standalone-${dev}`);
    await c.close();
  }
});

await step("shots", async () => {
  const set = [["phone-393", "light"], ["phone-393", "dark"], ["ipad-mini", "light"], ["ipad-air-land", "light"], ["desktop", "light"], ["desktop", "dark"]];
  for (const [dev, theme] of set) {
    const { c, p } = await device(dev, { theme });
    await home(p);
    await snap(p, `review-${dev}-${theme}`);
    await snap(p, `review-${dev}-${theme}-full`, true);
    await c.close();
  }
});

await browser.close();
console.log("\n" + results.map(([n, r, ms]) => `${r === "ok" ? "✓" : "✗"} ${n} ${r === "ok" ? "" : r} (${(ms / 1000).toFixed(1)} s)`).join("\n"));
if (results.some(([, r]) => r !== "ok")) process.exit(1);
