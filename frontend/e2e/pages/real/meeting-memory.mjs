/**
 * Meeting memory while writing (.work/meeting-memory/SPEC.md) on the REAL stack, with the fake models in
 * api_run.py (PB_FAKE_MEETINGS_AI writes each meeting's decisions from its "agree"/"decide" lines and answers
 * the AI check; PB_FAKE_ASK_AI answers Ask; PB_FAKE_PAGES_AI makes Page AI count as set up):
 *
 *   panel     a PRD titled after a meeting's topic: "From meetings" shows the decision with its date, meeting
 *             and moment; a search finds the rest
 *   hint      a section that names another weekday than the decision: the AI check's card (Include / Dismiss)
 *   insert    Insert puts a dated, cited line in the page (a mention of the meeting + the moment), saved
 *   reader    a reader of the PRD follows the inserted citation to the meeting page
 *   slash     "/meetings" opens the panel with its search
 *   ask       Ask Markdrop (This doc) in the page cites the meeting; its source link opens the meeting
 *   leak      a meeting restricted to its attendees never reaches anyone else (panel, search, Ask, API)
 *   prefs     "Show by itself" off hides the button (kept after a reload); /meetings still opens the panel
 *   phone     390 px, writing: the editing toolbar's "From meetings" button (44 px; the pill steps aside
 *             while the toolbar is up) opens the sheet, no sideways scroll
 *   view      View mode: "From meetings" in the page's bar opens the same panel for the section in view (no
 *             hints, no editor); Insert opens Edit with the line after that section, saved; a workspace
 *             reader gets the panel without Insert, and never the restricted meeting
 *   viewphone View mode at 390 px: the bar's button and the sheet's buttons are 44 px targets
 *
 *   PB_FAKE_MEETINGS_AI=1 PB_FAKE_ASK_AI=1 PB_FAKE_PAGES_AI=1 PB_STACK_ID=50 PB_WORK=… zsh up.sh start
 *   PB_STACK_ID=50 PB_WORK=… BROWSER=chromium|webkit [ONLY=panel,insert] node meeting-memory.mjs
 */
import fs from "node:fs";
import { APP, SHOTS, log, fail, reseed, seedNow, api, docOf, launch, ctx, captureApi, stepper, shot, waitSaved, mcp, mcpToken, editPage } from "./lib.mjs";

fs.mkdirSync(SHOTS, { recursive: true });
const browser = await launch();
const { step, results } = stepper(browser);
const S = process.env.NO_RESEED ? seedNow() : reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const ok = (r, what) => { if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const SECRET = "zebra";

// ── The world: a team meeting, a restricted one (Wes wasn't there), a PRD ─────
const TEAM = `Checkout sync (2026-11-03 10:00 GMT+05:30) - Transcript
Attendees
Ada Owner, Ben Member, Wes Admin
Transcript
Ada Owner: Checkout redesign today, the payments step and the launch date.
Ben Member: Stripe hosted payments passed the security review yesterday.
Wes Admin: Then we agree to ship the checkout redesign with Stripe hosted payments on Friday.
Ben Member: I will update the payments runbook before the launch.
Ada Owner: Do we keep the old checkout as a fallback for a week?
Wes Admin: Thanks, everyone.
Transcription ended after 00:12:40
`;
const BOARD = `Pricing board (2026-11-04 16:00 GMT+05:30) - Transcript
Attendees
Ada Owner, Ben Member
Transcript
Ada Owner: The ${SECRET} plan pricing for checkout, between us.
Ben Member: We decide to price the ${SECRET} plan at ninety nine dollars for checkout.
Ada Owner: Thanks.
Transcription ended after 00:05:00
`;
const team = ok(await api("POST", "/api/v1/meetings/import", T.owner, { workspace: WS, wait: true, sources: [{ name: "Checkout sync (2026-11-03 10:00 GMT+05:30) - Transcript", text: TEAM }] }), "team meeting").meetings[0];
const board = ok(await api("POST", "/api/v1/meetings/import", T.owner, { workspace: WS, wait: true, restricted: true, sources: [{ name: "Pricing board (2026-11-04 16:00 GMT+05:30) - Transcript", text: BOARD }] }), "restricted meeting").meetings[0];
if (!board.restricted) fail("the board meeting isn't restricted");

// Facts are written with the summary; the search rows follow. Wait until Ben (in both) sees both.
const related = (token, body) => api("POST", "/api/v1/meeting-memory/related", token, { workspace: WS, ...body });
for (let i = 0; ; i++) {
  const r = ok(await related(T.member, { q: "checkout", limit: 30 }), "related");
  const ids = new Set(r.facts.map((f) => f.meeting.id));
  if (ids.has(team.id) && ids.has(board.id)) break;
  if (i > 40) fail(`facts never showed: ${JSON.stringify(r).slice(0, 400)}`);
  await new Promise((res) => setTimeout(res, 500));
}

const newPage = async (title, content, as = "admin") => {
  const r = await api("POST", "/api/v1/pages", T[as], { title, workspace: WS, folder: S.folder, content, auto_cover: false });
  if (r.status >= 300) fail(`create ${title} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body.document.slug;
};
const PRD = await newPage("Checkout redesign PRD", "# Goals\n\nA faster checkout.\n\n## Payments\n\nCustomers pay on a hosted page.\n\n## Rollout\n\n");
// A long page, so a section can be scrolled to the top in View mode.
const FILLER = Array.from({ length: 24 }, (_, i) => `Appendix note ${i + 1}: details for the support team and the release notes.`).join("\n\n");
const VIEWPRD = await newPage("Checkout payments notes", `# Goals\n\nA faster checkout.\n\n## Payments\n\nCustomers pay on a hosted page.\n\n## Rollout\n\nIn two waves.\n\n## Appendix\n\n${FILLER}\n`);
const HINT = await newPage("Checkout launch plan", "## Launch\n\nWe launch the new checkout on Monday next week, after the design review and the final round of usability tests with ten customers from the beta group, so support can prepare.\n");

const editorOf = (p) => p.locator('.pb-live .ProseMirror[contenteditable="true"]');
async function openAt(p, slug, at) {
  await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  await editPage(p);
  await editorOf(p).waitFor({ timeout: 30000 });
  await p.waitForTimeout(1000);
  await p.locator(".pb-live .ProseMirror").getByText(at, { exact: false }).first().click();
  await p.waitForTimeout(250);
  await p.keyboard.press("End");
}
const panel = (p) => p.locator(".mm[data-open] .mm__panel");
async function openPanel(p) {
  const pill = p.locator(".mm-pill");
  await pill.waitFor({ timeout: 20000 });
  await pill.click();
  await panel(p).waitFor({ timeout: 5000 });
}
const factOf = (p, text) => panel(p).locator(".mm-fact", { hasText: text }).first();

// ── Steps ────────────────────────────────────────────────────────────────────

await step("panel", async () => {
  const { p } = await ctx(browser, { token: T.admin });
  await openAt(p, PRD, "Customers pay on a hosted page");
  const pill = p.locator(".mm-pill");
  await p.waitForFunction(() => Number(document.querySelector(".mm-pill__count")?.textContent || 0) > 0, null, { timeout: 20000 });
  await shot(p, "mm01-pill");
  await openPanel(p);
  const f = factOf(p, "ship the checkout redesign");
  await f.waitFor({ timeout: 10000 });
  const top = await panel(p).locator(".mm-fact").first().innerText();
  if (!/ship the checkout redesign/i.test(top)) fail(`the decision isn't first: ${top}`);
  if (!/Decision/.test(top) || !/Nov 3, 2026/.test(top) || !/Checkout sync/.test(top)) fail(`no kind/date/meeting: ${top}`);
  const moment = await f.locator("a.mm-btn").first().getAttribute("href");
  if (!moment || !/#b-t\d{4}/.test(moment)) fail(`no moment link: ${moment}`);
  await shot(p, "mm02-panel");
  // A search finds anything else (an action item), and the filters narrow it.
  await panel(p).locator(".mm__search-input").fill("runbook");
  await factOf(p, "payments runbook").waitFor({ timeout: 8000 });
  await panel(p).getByRole("radio", { name: "Decisions" }).click();
  await p.waitForTimeout(800);
  if (await factOf(p, "payments runbook").count()) fail("the Decisions filter kept an action item");
  await panel(p).getByRole("radio", { name: "All" }).click();
  // A moment opens the transcript there.
  await panel(p).locator(".mm__search-clear").click();
  await f.waitFor({ timeout: 8000 });
  await f.locator("a.mm-btn").first().click();
  await p.waitForURL(new RegExp(`${team.transcript_slug}.*#b-t\\d{4}`), { timeout: 15000 });
  void pill;
});

await step("hint", async () => {
  const { p } = await ctx(browser, { token: T.admin });
  await openAt(p, HINT, "so support can prepare");
  const card = p.locator(".mm-hint");
  await card.waitFor({ timeout: 25000 });
  const text = await card.innerText();
  if (!/On Nov 3, 2026 the team decided/.test(text)) fail(`hint: ${text}`);
  log("hint:", text.replace(/\s+/g, " ").slice(0, 160));
  await shot(p, "mm03-hint");
  await card.getByRole("button", { name: "Dismiss" }).click();
  await p.waitForTimeout(600);
  if (await card.count()) fail("Dismiss kept the card");
  // Nothing in the page changed.
  if (/Decided on/.test((await docOf(HINT, T.admin)).content)) fail("the hint edited the page");
});

await step("insert", async () => {
  const { p } = await ctx(browser, { token: T.admin });
  await openAt(p, PRD, "Customers pay on a hosted page");
  await openPanel(p);
  const f = factOf(p, "ship the checkout redesign");
  await f.waitFor({ timeout: 10000 });
  await f.getByRole("button", { name: /Insert/ }).click();
  await p.locator(".pb-live .ProseMirror").getByText(/Decided on Nov 3, 2026/).waitFor({ timeout: 8000 });
  await waitSaved(p);
  const md = (await docOf(PRD, T.admin)).content;
  const line = md.split("\n").find((l) => l.includes("Decided on Nov 3, 2026"));
  if (!line) fail(`not saved: ${md.slice(0, 600)}`);
  if (!line.includes(`:markdrop[`) || !line.includes(team.slug)) fail(`no mention of the meeting: ${line}`);
  // The moment: its clock time (this fake transcript has none, so its line number) and the transcript link.
  if (!new RegExp(`\\[[^\\]]+\\]\\(/${team.transcript_slug}#b-t\\d{4}\\)`).test(line)) fail(`no moment link: ${line}`);
  // Right after the Payments paragraph, before Rollout.
  if (md.indexOf("Decided on") < md.indexOf("hosted page") || md.indexOf("Decided on") > md.indexOf("## Rollout")) fail(`inserted in the wrong place: ${md}`);
  await shot(p, "mm04-inserted");
});

await step("reader", async () => {
  // Vic (a workspace viewer) reads the PRD and follows the citation to the meeting.
  const { p } = await ctx(browser, { token: T.reader });
  await p.goto(`${APP}/${PRD}`, { waitUntil: "networkidle" });
  const link = p.locator(`a.pb-mention[href*="${team.slug}"]`).first();
  await link.waitFor({ timeout: 20000 });
  if (!/Checkout sync/.test(await link.innerText())) fail(`the citation's chip: ${await link.innerText()}`);
  await shot(p, "mm05-reader");
  // The seeded workspace has a live custom domain (docs.acme.com), where mentions point: follow the
  // same address here, and the moment link (a path) in place.
  await p.goto(`${APP}/${team.slug}`, { waitUntil: "networkidle" });
  await p.getByText("Checkout sync").first().waitFor({ timeout: 15000 });
  await p.goto(`${APP}/${PRD}`, { waitUntil: "networkidle" });
  await p.locator(`a[href*="${team.transcript_slug}#b-t"]`).first().click({ timeout: 15000 });
  await p.waitForURL(new RegExp(`${team.transcript_slug}.*#b-t\\d{4}`), { timeout: 15000 });
});

await step("slash", async () => {
  const { p } = await ctx(browser, { token: T.admin });
  await openAt(p, PRD, "A faster checkout");
  await p.keyboard.press("Enter");
  await p.keyboard.type("/meetings");
  const item = p.locator(".dxe-slash__opt", { hasText: /From meetings/ }).first();
  await item.waitFor({ timeout: 8000 });
  await p.keyboard.press("Enter");
  await panel(p).waitFor({ timeout: 8000 });
  const focused = await p.waitForFunction(() => document.activeElement?.classList.contains("mm__search-input"), null, { timeout: 2000 }).then(() => true, () => false);
  if (!focused) fail(`the search isn't focused (${await p.evaluate(() => document.activeElement?.className)})`);
  if (/\/meetings/.test(await editorOf(p).innerText())) fail("the slash text stayed in the page");
  await p.keyboard.type("fallback");
  await factOf(p, "old checkout").waitFor({ timeout: 8000 });
  await shot(p, "mm06-slash");
});

await step("ask", async () => {
  const { p } = await ctx(browser, { token: T.admin });
  await p.goto(`${APP}/${PRD}`, { waitUntil: "networkidle" });
  // Ask Markdrop (✦ Ask in the bar) on This doc: the page, then the workspace's meetings.
  await p.getByTestId("assistant-button").first().click({ timeout: 20000 });
  const box = p.getByTestId("assistant");
  await box.getByTestId("assistant-scope-doc").waitFor({ timeout: 15000 });
  if ((await box.getByTestId("assistant-scope-doc").getAttribute("aria-checked")) !== "true") fail("This doc isn't the scope in a page");
  await box.locator("textarea").fill("When did we decide to ship the checkout redesign?");
  await box.locator("textarea").press("Enter");
  await box.locator('ol[aria-label="Conversation"] > li[data-state="done"]').first().waitFor({ timeout: 25000 });
  if (!(await box.getByTestId("chat-cite").count())) fail("no citation chips in the answer");
  await box.getByTestId("chat-sources-btn").first().click();
  const src = box.getByTestId("chat-sources");
  const text = await src.innerText();
  if (!/Checkout sync/.test(text)) fail(`the meeting isn't cited: ${text.slice(0, 600)}`);
  await shot(p, "mm07-ask");
  const href = await src.locator(".ch-src", { hasText: "Checkout sync" }).first().getByTestId("chat-source-link").getAttribute("href");
  if (!href || !href.includes(team.slug)) fail(`the meeting's source link: ${href}`);
});

await step("leak", async () => {
  // API: Vic and Wes never get the restricted meeting's facts; Ben (an attendee) does.
  for (const who of ["reader", "admin"]) {
    const r = ok(await related(T[who], { q: `${SECRET} plan pricing`, limit: 30 }), `${who} related`);
    if (JSON.stringify(r).includes(SECRET) || r.facts.some((f) => f.meeting.id === board.id)) fail(`${who} sees the restricted meeting`);
  }
  const ben = ok(await related(T.member, { q: `${SECRET} plan pricing` }), "ben related");
  if (!ben.facts.some((f) => f.meeting.id === board.id)) fail("Ben (an attendee) doesn't see it");
  // MCP: the same.
  const wesMcp = mcpToken("wes@acme.test", true);
  const out = await mcp(wesMcp, "meeting_context", { workspace: WS, topic: `${SECRET} plan pricing` });
  if (JSON.stringify(out).includes(SECRET)) fail("meeting_context leaked it to Wes");
  // The UI: Wes's panel, search and Ask with meetings never carry it.
  const { p } = await ctx(browser, { token: T.admin });
  const bodies = captureApi(p);
  await openAt(p, PRD, "Customers pay on a hosted page");
  await openPanel(p);
  await panel(p).locator(".mm__search-input").fill("plan pricing");
  await p.waitForTimeout(1500);
  await panel(p).locator(".mm__search-input").fill("ninety nine dollars");
  await p.waitForTimeout(1500);
  await shot(p, "mm08-leak-panel");
  await p.goto(`${APP}/${PRD}`, { waitUntil: "networkidle" });
  await p.getByTestId("assistant-button").first().click({ timeout: 20000 });
  const box = p.getByTestId("assistant");
  await box.getByTestId("assistant-scope-doc").waitFor({ timeout: 15000 });
  await box.locator("textarea").fill("What did we decide about the plan pricing?");
  await box.locator("textarea").press("Enter");
  await box.locator('ol[aria-label="Conversation"] > li:not([data-state="streaming"])').first().waitFor({ timeout: 25000 });
  await p.waitForTimeout(2500);
  for (const b of bodies) if (b.body.toLowerCase().includes(SECRET)) fail(`an API response to Wes carried the secret: ${b.url}`);
});

await step("prefs", async () => {
  const { p } = await ctx(browser, { token: T.admin });
  await openAt(p, PRD, "Customers pay on a hosted page");
  await openPanel(p);
  await panel(p).locator("label.md-switch", { hasText: "Show by itself" }).click();
  await p.waitForTimeout(800);
  await panel(p).getByRole("button", { name: "Close" }).click();
  await p.waitForTimeout(500);
  if (await p.locator(".mm-pill").count()) fail("the button stayed with Show by itself off");
  const prefs = ok(await api("GET", "/api/v1/meeting-memory/prefs", T.admin), "prefs");
  if (prefs.panel !== false || prefs.hints !== true) fail(`prefs: ${JSON.stringify(prefs)}`);
  await p.reload({ waitUntil: "networkidle" });
  await editPage(p);
  await editorOf(p).waitFor({ timeout: 30000 });
  await p.waitForTimeout(3000);
  if (await p.locator(".mm-pill").count()) fail("the button came back after a reload");
  // /meetings still opens the panel, where the switch is.
  await p.locator(".pb-live .ProseMirror").getByText("A faster checkout", { exact: false }).first().click();
  await p.keyboard.press("End");
  await p.keyboard.press("Enter");
  await p.keyboard.type("/meetings");
  await p.locator(".dxe-slash__opt", { hasText: /From meetings/ }).first().waitFor({ timeout: 8000 });
  await p.keyboard.press("Enter");
  await panel(p).waitFor({ timeout: 8000 });
  await shot(p, "mm09-prefs-off");
  ok(await api("PATCH", "/api/v1/meeting-memory/prefs", T.admin, { panel: true }), "prefs back on");
});

await step("phone", async () => {
  const { p } = await ctx(browser, { token: T.admin, width: 390, height: 844, mobile: true });
  await openAt(p, PRD, "Customers pay on a hosted page");
  // The caret is in the page: the editing toolbar is up, the pill steps aside and the toolbar has the button.
  const btn = p.getByTestId("mm-phonebar");
  await btn.waitFor({ timeout: 20000 });
  const bb = await btn.boundingBox();
  if (!bb || bb.width < 44 || bb.height < 44) fail(`the toolbar's button is ${bb?.width}x${bb?.height}`);
  await p.waitForFunction(() => Number(document.querySelector(".pb-phonebar__count")?.textContent || 0) > 0, null, { timeout: 20000 });
  await btn.click();
  await panel(p).waitFor({ timeout: 5000 });
  await factOf(p, "ship the checkout redesign").waitFor({ timeout: 10000 });
  const wide = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 1) fail(`sideways scroll: ${wide}px`);
  const box = await panel(p).boundingBox();
  if (!box || box.width > 391) fail(`sheet width ${box?.width}`);
  await shot(p, "mm10-phone");
});

await step("view", async () => {
  // Wes (can edit) reads the page: no editor, no pill, no hint; the bar's button opens the panel.
  const { p } = await ctx(browser, { token: T.admin });
  const bodies = captureApi(p);
  await p.goto(`${APP}/${VIEWPRD}`, { waitUntil: "networkidle" });
  const btn = p.getByTestId("mm-bar");
  await btn.waitFor({ timeout: 20000 });
  if (await p.locator('.pb-live .ProseMirror[contenteditable="true"]').count()) fail("the page opened in Edit");
  // The section in view: Payments at the top (the panel follows the reader's scroll).
  await p.locator(".pb-frame h2", { hasText: "Payments" }).first().evaluate((h) => window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY - 100));
  await p.waitForTimeout(1200);
  await p.waitForFunction(() => Number(document.querySelector(".mm-barbtn__count")?.textContent || 0) > 0, null, { timeout: 20000 });
  await btn.click();
  await panel(p).waitFor({ timeout: 5000 });
  if ((await btn.getAttribute("aria-expanded")) !== "true") fail("the bar's button doesn't say the panel is open");
  await p.waitForFunction(() => /Payments/.test(document.querySelector(".mm[data-open] .mm__titles p")?.textContent || ""), null, { timeout: 8000 })
    .catch(async () => fail(`not the section in view: ${await panel(p).locator(".mm__titles p").innerText()}`));
  const f = factOf(p, "ship the checkout redesign");
  await f.waitFor({ timeout: 10000 });
  const text = await f.innerText();
  if (!/Decision/.test(text) || !/Nov 3, 2026/.test(text) || !/Checkout sync/.test(text)) fail(`no kind/date/meeting: ${text}`);
  const moment = await f.locator("a.mm-btn").first().getAttribute("href");
  if (!moment || !/#b-t\d{4}/.test(moment)) fail(`no moment link: ${moment}`);
  if (await p.locator(".mm-pill, .mm-hint").count()) fail("View mode shows the editor's pill or a hint");
  await shot(p, "mm11-view");
  // Escape closes it and gives the focus back to the bar's button.
  await panel(p).locator(".mm__search-input").focus();
  await p.keyboard.press("Escape");
  await p.waitForFunction(() => !document.querySelector(".mm[data-open]"), null, { timeout: 3000 });
  if (!(await btn.evaluate((b) => b === document.activeElement))) fail("Escape didn't return the focus to the button");
  // Insert from View mode: Edit opens with the cited line after the section in view, and it saves.
  await btn.click();
  await f.waitFor({ timeout: 10000 });
  await f.getByRole("button", { name: /Insert/ }).click();
  await p.locator('.pb-live .ProseMirror[contenteditable="true"]').getByText(/Decided on Nov 3, 2026/).waitFor({ timeout: 30000 });
  await waitSaved(p);
  const md = (await docOf(VIEWPRD, T.admin)).content;
  const at = md.indexOf("Decided on Nov 3, 2026");
  if (at < 0) fail(`not saved: ${md.slice(0, 400)}`);
  if (at < md.indexOf("hosted page") || at > md.indexOf("## Rollout")) fail(`not after the section in view: ${md.slice(0, 500)}`);
  const line = md.slice(at).split("\n")[0];
  if (!line.includes(":markdrop[") || !line.includes(team.slug)) fail(`no mention of the meeting: ${line}`);
  await shot(p, "mm12-view-inserted");
  for (const b of bodies) if (b.body.toLowerCase().includes(SECRET)) fail(`an API response to Wes carried the secret: ${b.url}`);

  // Vic (a workspace viewer, can't edit): the same panel, no Insert, never the restricted meeting.
  const { p: r } = await ctx(browser, { token: T.reader });
  const rb = captureApi(r);
  await r.goto(`${APP}/${VIEWPRD}`, { waitUntil: "networkidle" });
  await r.getByTestId("mm-bar").click({ timeout: 20000 });
  await factOf(r, "ship the checkout redesign").waitFor({ timeout: 10000 });
  if (await panel(r).getByRole("button", { name: /Insert/ }).count()) fail("a reader who can't edit got Insert");
  await panel(r).locator(".mm__search-input").fill("ninety nine dollars");
  await r.waitForTimeout(1500);
  for (const b of rb) if (b.body.toLowerCase().includes(SECRET)) fail(`an API response to Vic carried the secret: ${b.url}`);
  await shot(r, "mm13-view-reader");
});

await step("viewphone", async () => {
  const { p } = await ctx(browser, { token: T.admin, width: 390, height: 844, mobile: true });
  await p.goto(`${APP}/${PRD}`, { waitUntil: "networkidle" });
  const btn = p.getByTestId("mm-bar");
  await btn.waitFor({ timeout: 20000 });
  const bb = await btn.boundingBox();
  if (!bb || bb.width < 44 || bb.height < 44) fail(`the bar's button is ${bb?.width}x${bb?.height}`);
  await btn.click();
  await panel(p).waitFor({ timeout: 5000 });
  const f = factOf(p, "ship the checkout redesign");
  await f.waitFor({ timeout: 10000 });
  await p.waitForTimeout(400);
  const small = await panel(p).evaluate((el) => [...el.querySelectorAll(".mm-btn, .mm-chip, .mm__close, .mm__search-input")]
    .map((b) => [b.className, b.getBoundingClientRect().height]).filter(([, h]) => h > 0 && h < 44));
  if (small.length) fail(`targets under 44 px: ${JSON.stringify(small).slice(0, 300)}`);
  const wide = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 1) fail(`sideways scroll: ${wide}px`);
  const box = await panel(p).boundingBox();
  if (!box || box.width > 391 || box.y < 40) fail(`not a bottom sheet: ${JSON.stringify(box)}`);
  await shot(p, "mm14-view-phone");
});

console.log("\n" + results.map(([n, r, ms]) => `${r === "ok" ? "✓" : "✗"} ${n.padEnd(8)} ${r} (${(ms / 1000).toFixed(1)} s)`).join("\n"));
await browser.close();
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
