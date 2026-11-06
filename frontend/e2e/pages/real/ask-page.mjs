/**
 * The Ask page and live suggestions (.work/briefs/ask-page.md) on the REAL stack, with the fake models in
 * api_run.py (PB_FAKE_ASK_AI answers Ask and writes the suggestions: one question per meeting / page it was
 * sent, so a source that must never be sent would show up in the list).
 *
 *   suggest   GET /ask/suggestions: built in the background, the same list for a member and a viewer, never
 *             from the restricted meeting; a stranger gets 404
 *   page      /ask?workspace=: "Ask Acme", the scope chips, live suggestions with "Updated", a click asks at
 *             once; the conversation lands in the list and in the URL; chips rename the title (Ask my files, Ask)
 *   rail      the sidebar's Ask opens the page on the workspace you're in; ⌘J on the page focuses its box
 *   panel     the panel is "Ask Acme" on a workspace, has a chip per workspace + My files, Open full page → /ask
 *   home      the home's Ask bar: a scope chip, live team chips; one asks on the Ask page
 *   phone     390 px: History opens the conversations drawer, no sideways scroll, 44 px chips, 16 px field
 *   tablet    768 px portrait: the drawer; 1180 landscape: the conversations column
 *   shots     light/dark desktop stills
 *
 *   source .work/ask-page/env.sh; zsh $R/up.sh start
 *   BROWSER=chromium|webkit [ONLY=page,phone] node ask-page.mjs
 */
import fs from "node:fs";
import { APP, BROWSER, SHOTS, log, fail, reseed, seedNow, api, launch, ctx, stepper, shot } from "./lib.mjs";

fs.mkdirSync(SHOTS, { recursive: true });
const browser = await launch();
const { step, results } = stepper(browser);
const S = process.env.NO_RESEED ? seedNow() : reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const ok = (r, what) => { if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const SECRET = "Heron";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SYNC = `Sourcing sync (2026-11-05 10:00 GMT+05:30) - Transcript
Attendees
Ada Owner, Ben Member, Wes Admin
Transcript
Ada Owner: Sourcing today: the vendor shortlist and the pilot.
Ben Member: We shortlist three vendors for the sourcing pilot.
Wes Admin: Then we agree to start the sourcing pilot with two vendors next week.
Ben Member: I will send the vendors the pilot brief by Friday.
Transcription ended after 00:10:00
`;
const BOARD = `${SECRET} board (2026-11-05 16:00 GMT+05:30) - Transcript
Attendees
Ada Owner, Ben Member
Transcript
Ada Owner: The ${SECRET} acquisition stays between us.
Ben Member: We decide to close ${SECRET} on Friday.
Transcription ended after 00:05:00
`;
ok(await api("POST", "/api/v1/meetings/import", T.owner, { workspace: WS, wait: true, restricted: false, sources: [{ name: "Sourcing sync (2026-11-05 10:00 GMT+05:30) - Transcript", text: SYNC }] }), "team meeting");
const board = ok(await api("POST", "/api/v1/meetings/import", T.owner, { workspace: WS, wait: true, restricted: true, sources: [{ name: `${SECRET} board (2026-11-05 16:00 GMT+05:30) - Transcript`, text: BOARD }] }), "restricted meeting").meetings[0];
if (!board.restricted) fail("the board meeting isn't restricted");
ok(await api("POST", "/api/v1/pages", T.admin, { title: "Vendor shortlist", workspace: WS, folder: S.folder, auto_cover: false,
  content: "# Vendor shortlist\n\n## Criteria\n\nPrice and lead time.\n\n## Pilot\n\nTwo vendors.\n" }), "page");
await sleep(2000); // the content index follows each save off the request

/** The suggestions once built (the first GET starts the build in the background). */
async function built(token) {
  for (let i = 0; i < 40; i++) {
    const r = ok(await api("GET", `/api/v1/ask/suggestions?workspace=${WS}`, token), "suggestions");
    if (r.team.length) return r;
    await sleep(500);
  }
  fail("the suggestions were never built");
}

const panel = (p) => p.getByTestId("assistant");
const page = (p) => p.getByTestId("ask-page");
const chatOf = (p) => p.getByTestId("ask-page-chat");
async function answered(root, n = 1, timeout = 30000) {
  await root.locator('ol[aria-label="Conversation"] > li[data-state="done"] .ch-md:not([data-streaming])').nth(n - 1).waitFor({ timeout });
}
const titleOf = (p) => p.getByTestId("ask-title").innerText();
async function waitTitle(p, re, timeout = 10000) {
  const t0 = Date.now();
  for (;;) {
    const t = (await titleOf(p)).trim();
    if (re.test(t)) return t;
    if (Date.now() - t0 > timeout) fail(`title: ${t}`);
    await sleep(100);
  }
}
/** The scope the open conversation's last answer used (from the URL's ?c=). */
async function lastScope(p, token) {
  const c = new URL(p.url()).searchParams.get("c");
  if (!c) fail("no conversation in the URL");
  const t = ok(await api("GET", `/api/v1/ask/threads/${c}`, token), "thread");
  return t.turns[t.turns.length - 1].scope;
}
async function noSideways(p, what) {
  const wide = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 1) fail(`${what}: sideways scroll ${wide}px`);
}

await step("suggest", async () => {
  const first = ok(await api("GET", `/api/v1/ask/suggestions?workspace=${WS}`, T.member), "first");
  if (!first.workspace || first.workspace.id !== WS) fail("no workspace in the answer");
  const m = await built(T.member);
  const v = ok(await api("GET", `/api/v1/ask/suggestions?workspace=${WS}`, T.reader), "viewer");
  if (JSON.stringify(m.team) !== JSON.stringify(v.team)) fail("a member and a viewer see different team lists");
  const text = JSON.stringify(m.team);
  if (text.includes(SECRET)) fail(`the restricted meeting reached the suggestions: ${text}`);
  if (!/Sourcing sync/.test(text) || !/Vendor shortlist/.test(text)) fail(`missing sources: ${text}`);
  if (!m.updated_at) fail("no updated_at");
  if (!m.personal.length || m.personal[0].intent !== "my_actions") fail(`personal: ${JSON.stringify(m.personal)}`);
  const s = await api("GET", `/api/v1/ask/suggestions?workspace=${WS}`, T.stranger);
  if (s.status !== 404) fail(`a stranger got ${s.status}`);
});

await step("page", async () => {
  await built(T.member);
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/ask?workspace=${WS}`, { waitUntil: "networkidle" });
  await page(p).waitFor({ timeout: 20000 });
  await p.getByTestId("ask-scope-workspace-" + WS).waitFor({ timeout: 15000 });
  await waitTitle(p, /^Ask Acme$/);
  if ((await p.getByTestId("ask-scope-workspace-" + WS).getAttribute("aria-checked")) !== "true") fail("the workspace chip isn't on");
  const starters = chatOf(p).getByTestId("chat-starters");
  await starters.waitFor({ timeout: 20000 });
  const first = starters.locator("button").first();
  const label = await first.innerText();
  if (!/Sourcing|Vendor/.test(label)) fail(`first suggestion: ${label}`);
  if (!(await chatOf(p).locator(".ch-empty__sub").innerText()).includes("Updated")) fail("no Updated line");
  const placeholder = await chatOf(p).locator("textarea").getAttribute("placeholder");
  if (placeholder !== "Ask anything about Acme…") fail(`placeholder: ${placeholder}`);
  await shot(p, "ap01-page-empty");
  await first.click();
  await answered(chatOf(p));
  await p.waitForURL(/[?&]c=[0-9a-f]{24}/, { timeout: 10000 });
  const sc = await lastScope(p, T.member);
  if (sc?.kind !== "workspace") fail(`asked on ${JSON.stringify(sc)}, not the workspace`);
  await p.getByTestId("ask-history").getByTestId("ask-thread").first().waitFor({ timeout: 10000 });
  await shot(p, "ap02-page-answer");
  // A reload keeps the conversation (?c=).
  await p.reload({ waitUntil: "networkidle" });
  await answered(chatOf(p));
  // The chips rename the page: My files, Everything.
  await p.getByTestId("ask-scope-mine").click();
  if ((await titleOf(p)) !== "Ask my files") fail(`My files title: ${await titleOf(p)}`);
  await p.getByTestId("ask-scope-everything").click();
  if ((await titleOf(p)) !== "Ask") fail(`Everything title: ${await titleOf(p)}`);
  // New chat empties it.
  await p.getByTestId("ask-new").click();
  await chatOf(p).getByTestId("chat-starters").waitFor({ timeout: 10000 });
  await noSideways(p, "desktop");
});

await step("rail", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/w/${WS}`, { waitUntil: "networkidle" });
  const rail = p.locator('[data-rail="full"]').getByTestId("rail-ask");
  await rail.waitFor({ timeout: 20000 });
  if ((await rail.innerText()).trim() !== "Ask") fail(`rail label: ${await rail.innerText()}`);
  await rail.click();
  await p.waitForURL(new RegExp(`/ask\\?workspace=${WS}`), { timeout: 10000 });
  await page(p).waitFor({ timeout: 15000 });
  await waitTitle(p, /^Ask Acme$/);
  // ⌘J on the page goes to its question box, not the panel.
  await p.locator("body").click({ position: { x: 5, y: 400 } }).catch(() => {});
  await p.keyboard.press("ControlOrMeta+j");
  await sleep(400);
  if (await panel(p).count()) fail("⌘J opened the panel on the Ask page");
  const focused = await p.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  if (focused !== "Your question") fail(`⌘J focused ${focused}`);
});

await step("panel", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/w/${WS}`, { waitUntil: "networkidle" });
  await p.getByTestId("assistant-button").first().waitFor({ timeout: 20000 });
  await p.getByTestId("assistant-button").first().click();
  await panel(p).waitFor({ timeout: 15000 });
  await panel(p).getByTestId("assistant-scope-workspace").waitFor({ timeout: 15000 });
  const t = await panel(p).getByTestId("assistant-title").innerText();
  if (!/Ask Acme/.test(t)) fail(`panel title: ${t}`);
  const chips = await panel(p).locator('[role="radio"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  for (const want of ["assistant-scope-workspace", "assistant-scope-mine", "assistant-scope-everything"]) if (!chips.includes(want)) fail(`chips: ${chips}`);
  // The workspace scope's live suggestions in the empty panel.
  await panel(p).getByTestId("chat-new").click({ timeout: 2000 }).catch(() => {});
  await panel(p).getByTestId("chat-starters").waitFor({ timeout: 15000 });
  await shot(p, "ap03-panel");
  await panel(p).getByTestId("assistant-scope-mine").click();
  if (!/Ask my files/.test(await panel(p).getByTestId("assistant-title").innerText())) fail("My files didn't rename the panel");
  await panel(p).getByTestId("assistant-scope-workspace").click();
  await panel(p).getByTestId("assistant-full-page").click();
  await p.waitForURL(new RegExp(`/ask\\?workspace=${WS}`), { timeout: 10000 });
  await page(p).waitFor({ timeout: 15000 });
});

await step("home", async () => {
  await built(T.member);
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
  await p.getByTestId("home-ask").waitFor({ timeout: 20000 });
  await p.getByTestId("home-ask-scope").waitFor({ timeout: 15000 });
  const live = p.getByTestId("home-ask-live");
  await live.first().waitFor({ timeout: 15000 });
  if ((await live.count()) > 3) fail("more than 3 live chips");
  await shot(p, "ap04-home");
  await live.first().click();
  await p.waitForURL(/\/ask\?/, { timeout: 10000 });
  await answered(chatOf(p));
  await p.waitForURL(/[?&]c=[0-9a-f]{24}/, { timeout: 10000 });
  const sc = await lastScope(p, T.member);
  if (sc?.kind !== "workspace") fail(`a live chip asked on ${JSON.stringify(sc)}, not the workspace`);
});

async function phoneOrTablet(width, height, theme, name, { drawer }) {
  const { c, p } = await ctx(browser, { token: T.member, theme, width, height, mobile: true });
  await p.goto(`${APP}/ask?workspace=${WS}`, { waitUntil: "networkidle" });
  await page(p).waitFor({ timeout: 20000 });
  await chatOf(p).getByTestId("chat-starters").waitFor({ timeout: 20000 });
  await noSideways(p, name);
  const font = await chatOf(p).locator("textarea").evaluate((el) => getComputedStyle(el).fontSize);
  if (parseFloat(font) < 16) fail(`${name}: field font ${font}`);
  const small = await p.evaluate(() => [...document.querySelectorAll('[data-testid="ask-page"] button')]
    .filter((b) => b.offsetParent && b.closest('[data-testid="ask-scopes"], header'))
    .map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0 && r.height < 43.5).length);
  if (small) fail(`${name}: ${small} header buttons under 44px`);
  const btn = p.getByTestId("ask-history-open");
  if (drawer) {
    await btn.click();
    const dlg = p.getByRole("dialog", { name: "Conversations" });
    await dlg.waitFor({ timeout: 5000 });
    await dlg.getByTestId("ask-thread").first().waitFor({ timeout: 10000 });
    await shot(p, `ap05-${name}-history-${theme}`);
    await dlg.getByTestId("ask-thread").first().click();
    await dlg.waitFor({ state: "detached", timeout: 5000 });
    await answered(chatOf(p));
  } else {
    if (await btn.isVisible()) fail(`${name}: History button shown beside the column`);
    if (!(await p.getByTestId("ask-history").first().isVisible())) fail(`${name}: no conversations column`);
  }
  await shot(p, `ap06-${name}-${theme}`);
  await c.close();
}

await step("phone", async () => {
  for (const theme of ["light", "dark"]) await phoneOrTablet(390, 844, theme, "phone", { drawer: true });
  await phoneOrTablet(360, 780, "light", "phone360", { drawer: true });
});

await step("tablet", async () => {
  await phoneOrTablet(768, 1024, "light", "tablet-portrait", { drawer: true });
  await phoneOrTablet(1180, 820, "dark", "tablet-landscape", { drawer: false });
});

await step("shots", async () => {
  for (const theme of ["light", "dark"]) {
    const { c, p } = await ctx(browser, { token: T.member, theme });
    await p.goto(`${APP}/ask?workspace=${WS}`, { waitUntil: "networkidle" });
    await chatOf(p).getByTestId("chat-starters").waitFor({ timeout: 20000 });
    await shot(p, `ap07-desktop-${theme}`);
    await c.close();
  }
});

console.log("\n" + results.map(([n, r, ms]) => `${r === "ok" ? "✓" : "✗"} ${n.padEnd(9)} ${r} (${(ms / 1000).toFixed(1)} s)`).join("\n"));
log("browser", BROWSER, "shots", SHOTS);
await browser.close();
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
