/**
 * Ask Markdrop everywhere (.work/assistant/SPEC.md) on the REAL stack, with the fake models in api_run.py
 * (PB_FAKE_ASK_AI answers Ask Markdrop, PB_FAKE_MEETINGS_AI writes meetings and answers the Meetings scope):
 *
 *   home      the home's box: starters, an answer with numbered sources, ?ask=<id>
 *   continue  the home's conversation continues on a page with ⌘J (This doc), one thread, scopes kept
 *   scopes    chips at the top (This doc · Meetings · Workspace · Everything); Meetings cites a transcript moment
 *   insert    Insert into a Page: blocks after the caret, saved, citations as links
 *   classic   Insert into a classic doc a reader-editor is reading: the editor opens with it; Save keeps it
 *   meeting   a meeting page's "Ask this meeting" opens Meetings on This meeting
 *   leak      a meeting restricted to its attendees never reaches anyone else; a viewer gets no Insert
 *   folder    ✦ Ask on a folder starts on This folder
 *   phone     390 px: the sheet, no sideways scroll, an answer
 *
 *   source .work/assistant/env.sh; zsh $R/up.sh start
 *   BROWSER=chromium|webkit [ONLY=home,insert] node assistant.mjs
 */
import fs from "node:fs";
import { APP, BROWSER, SHOTS, log, fail, reseed, seedNow, api, docOf, launch, ctx, captureApi, stepper, shot, waitSaved } from "./lib.mjs";

fs.mkdirSync(SHOTS, { recursive: true });
const browser = await launch();
const { step, results } = stepper(browser);
const S = process.env.NO_RESEED ? seedNow() : reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const ok = (r, what) => { if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const SECRET = "zebra";

// ── The world: a team meeting, a restricted one (Vic and Wes weren't there), a PRD page, a classic doc ──
const TEAM = `Checkout sync (2026-11-03 10:00 GMT+05:30) - Transcript
Attendees
Ada Owner, Ben Member, Wes Admin
Transcript
Ada Owner: Checkout redesign today, the payments step and the launch date.
Ben Member: Stripe hosted payments passed the security review yesterday.
Wes Admin: Then we agree to ship the checkout redesign with Stripe hosted payments on Friday.
Ben Member: I will update the payments runbook before the launch.
Ada Owner: Do we keep the old checkout as a fallback for a week?
Transcription ended after 00:12:40
`;
const BOARD = `Pricing board (2026-11-04 16:00 GMT+05:30) - Transcript
Attendees
Ada Owner, Ben Member
Transcript
Ada Owner: The ${SECRET} plan pricing for checkout, between us.
Ben Member: We decide to price the ${SECRET} plan at ninety nine dollars for checkout.
Transcription ended after 00:05:00
`;
const team = ok(await api("POST", "/api/v1/meetings/import", T.owner, { workspace: WS, wait: true, restricted: false, sources: [{ name: "Checkout sync (2026-11-03 10:00 GMT+05:30) - Transcript", text: TEAM }] }), "team meeting").meetings[0];
const board = ok(await api("POST", "/api/v1/meetings/import", T.owner, { workspace: WS, wait: true, restricted: true, sources: [{ name: "Pricing board (2026-11-04 16:00 GMT+05:30) - Transcript", text: BOARD }] }), "restricted meeting").meetings[0];
if (!board.restricted) fail("the board meeting isn't restricted");
const PRD = ok(await api("POST", "/api/v1/pages", T.admin, {
  title: "Checkout redesign PRD", workspace: WS, folder: S.folder, auto_cover: false,
  content: "# Goals\n\nA faster checkout.\n\n## Payments\n\nCustomers pay on a hosted checkout page.\n\n## Rollout\n\nIn two weeks.\n",
}), "PRD").document.slug;
const CLASSIC = ok(await api("POST", "/api/v1/documents", T.admin, {
  workspace: WS, access_level: "workspace", expires_in: "never", title: "Checkout release notes", custom_slug: "checkout-release-notes",
  content: "# Checkout release notes\n\n## Payments\n\nThe checkout uses hosted payments.\n\n## Support\n\nSupport gets a runbook.\n",
}), "classic doc").slug;
await new Promise((r) => setTimeout(r, 2000)); // the content index follows each save off the request

const panel = (p) => p.getByTestId("assistant");
const homeBox = (p) => p.getByTestId("ask-home");
const fieldIn = (root) => root.locator('textarea[aria-label="Your question"]');
const turns = (root) => root.locator('ol[aria-label="Conversation"] > li');
async function ask(root, q) {
  await fieldIn(root).fill(q);
  await fieldIn(root).press("Enter");
}
/** Waits for the n-th answer (1-based) in `root` to finish (its tools are there). */
async function answered(root, n = 1, timeout = 30000) {
  await root.locator('ol[aria-label="Conversation"] > li[data-state="done"]').nth(n - 1).waitFor({ timeout });
}
async function openPanel(p, how = "key") {
  if (how === "key") await p.keyboard.press("ControlOrMeta+j");
  else await p.getByTestId("assistant-button").first().click();
  await panel(p).waitFor({ timeout: 15000 });
  await panel(p).locator('[data-testid^="assistant-scope-"]').first().waitFor({ timeout: 15000 });
}
const scopeOn = (p) => panel(p).locator('[role="radio"][aria-checked="true"]').getAttribute("data-testid");
const editorOf = (p) => p.locator('.pb-live .ProseMirror[contenteditable="true"]');

// ── Steps ────────────────────────────────────────────────────────────────────

await step("home", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
  await homeBox(p).waitFor({ timeout: 20000 });
  const starters = await homeBox(p).getByTestId("chat-starters").locator("button").allInnerTexts();
  if (!starters.some((s) => /Catch me up/.test(s))) fail(`starters: ${starters}`);
  await shot(p, "as01-home");
  await ask(homeBox(p), "When do we ship the checkout redesign?");
  await answered(homeBox(p));
  if (!(await homeBox(p).getByTestId("chat-cite").count())) fail("no citation chips");
  if (!/[?&]ask=[0-9a-f]{24}/.test(p.url())) fail(`no ?ask= in ${p.url()}`);
  await shot(p, "as02-home-answer");
});

await step("continue", async () => {
  // One conversation: asked on the home, continued on a page with ⌘J.
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
  await homeBox(p).waitFor({ timeout: 20000 });
  await ask(homeBox(p), "What did the team agree about the checkout?");
  await answered(homeBox(p));
  const tid = new URL(p.url()).searchParams.get("ask");
  await p.goto(`${APP}/${PRD}`, { waitUntil: "networkidle" });
  await p.locator(".pb-frame, .pb-live").first().waitFor({ timeout: 30000 });
  await p.locator("body").click({ position: { x: 5, y: 300 } }).catch(() => {});
  await openPanel(p, "key");
  if ((await scopeOn(p)) !== "assistant-scope-doc") fail(`starts on ${await scopeOn(p)}, not This doc`);
  await turns(panel(p)).first().waitFor({ timeout: 15000 });
  if ((await turns(panel(p)).count()) !== 1) fail("the home's turn isn't in the panel");
  await ask(panel(p), "And what does this doc say about payments?");
  await answered(panel(p), 2);
  const t = ok(await api("GET", `/api/v1/ask/threads/${tid}`, T.member), "thread");
  const kinds = t.turns.map((x) => x.scope?.kind);
  if (t.turns.length !== 2 || kinds[1] !== "doc") fail(`thread turns: ${JSON.stringify(kinds)}`);
  await shot(p, "as03-continue");
  // ⌘J closes it again.
  await p.keyboard.press("ControlOrMeta+j");
  await panel(p).waitFor({ state: "detached", timeout: 5000 });
});

await step("scopes", async () => {
  const { p } = await ctx(browser, { token: T.admin, theme: "dark" });
  await p.goto(`${APP}/${PRD}`, { waitUntil: "networkidle" });
  await editorOf(p).waitFor({ timeout: 30000 });
  await openPanel(p, "button");
  const chips = await panel(p).locator('[role="radio"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  const want = ["assistant-scope-doc", "assistant-scope-meetings", "assistant-scope-workspace", "assistant-scope-everything"];
  if (JSON.stringify(chips) !== JSON.stringify(want)) fail(`chips: ${chips}`);
  await panel(p).getByTestId("assistant-scope-meetings").click();
  await panel(p).getByTestId("chat-scope-period").waitFor({ timeout: 5000 });
  await ask(panel(p), "When did we agree to ship the checkout redesign?");
  await answered(panel(p));
  await panel(p).getByTestId("chat-sources-btn").last().click();
  const src = panel(p).getByTestId("chat-sources");
  await src.waitFor({ timeout: 5000 });
  const jump = src.getByTestId("chat-source-link").filter({ hasText: "Jump to moment" }).first();
  const href = await jump.getAttribute("href");
  if (!href || !new RegExp(`${team.transcript_slug}#b-t\\d{4}`).test(href)) fail(`no moment link: ${href}`);
  await shot(p, "as04-meetings-dark");
  await jump.click();
  await p.waitForURL(new RegExp(`${team.transcript_slug}.*#b-t\\d{4}`), { timeout: 15000 });
});

await step("insert", async () => {
  const { p } = await ctx(browser, { token: T.admin });
  await p.goto(`${APP}/${PRD}`, { waitUntil: "networkidle" });
  await editorOf(p).waitFor({ timeout: 30000 });
  await p.waitForTimeout(800);
  await p.locator(".pb-live .ProseMirror").getByText("Customers pay on a hosted checkout page").first().click();
  await p.keyboard.press("End");
  await openPanel(p, "button");
  if ((await scopeOn(p)) !== "assistant-scope-doc") fail("not on This doc");
  await ask(panel(p), "Summarize the payments section");
  await answered(panel(p));
  const before = (await docOf(PRD, T.admin)).content;
  await panel(p).locator(".ch-tools").last().getByRole("button", { name: /Insert/ }).click();
  await p.locator(".pb-live .ProseMirror").getByText(/From what you can open/).first().waitFor({ timeout: 8000 });
  await waitSaved(p);
  const md = (await docOf(PRD, T.admin)).content;
  if (md === before || !md.includes("From what you can open")) fail(`not saved: ${md.slice(0, 500)}`);
  const at = md.indexOf("From what you can open");
  if (at < md.indexOf("hosted checkout page") || at > md.indexOf("## Rollout")) fail(`inserted in the wrong place:\n${md}`);
  if (!/\[\[1\]\]\(/.test(md)) fail(`no citation links: ${md.slice(at, at + 300)}`);
  await shot(p, "as05-insert-page");
});

await step("classic", async () => {
  const { p } = await ctx(browser, { token: T.admin });
  await p.goto(`${APP}/${CLASSIC}`, { waitUntil: "networkidle" });
  await p.getByText("The checkout uses hosted payments.").first().waitFor({ timeout: 20000 });
  await openPanel(p, "key");
  if ((await scopeOn(p)) !== "assistant-scope-doc") fail("not on This doc");
  await ask(panel(p), "What do these notes say about support?");
  await answered(panel(p));
  await panel(p).locator(".ch-tools").last().getByRole("button", { name: /Insert/ }).click();
  const md = p.locator('textarea[aria-label="Markdown"]');
  await md.waitFor({ timeout: 10000 });
  const text = await md.inputValue();
  if (!text.includes("From what you can open")) fail(`the editor didn't get it: ${text.slice(0, 400)}`);
  if ((await docOf(CLASSIC, T.admin)).content.includes("From what you can open")) fail("it was saved before Save");
  await shot(p, "as06-insert-classic");
  await p.getByRole("button", { name: /Save changes/ }).click();
  for (let i = 0; i < 40; i++) {
    if ((await docOf(CLASSIC, T.admin)).content.includes("From what you can open")) break;
    if (i === 39) fail("Save didn't keep it");
    await p.waitForTimeout(250);
  }
});

await step("meeting", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/${team.slug}`, { waitUntil: "networkidle" });
  await p.getByTestId("meeting-ask").click({ timeout: 20000 });
  await panel(p).waitFor({ timeout: 15000 });
  await p.waitForFunction(() => document.querySelector('[data-testid="assistant-scope-meetings"]')?.getAttribute("aria-checked") === "true", null, { timeout: 15000 });
  const meetingChip = await panel(p).getByTestId("chat-scope-meeting").innerText();
  if (!/This meeting/.test(meetingChip)) fail(`the meeting chip: ${meetingChip}`);
  await ask(panel(p), "Who will update the payments runbook?");
  await answered(panel(p));
  if (!/runbook/i.test(await panel(p).innerText())) fail("the answer doesn't come from the meeting");
  await shot(p, "as07-meeting");
});

await step("leak", async () => {
  // Wes (an admin who wasn't in the board meeting) asks the meetings and the PRD about the secret.
  const { p } = await ctx(browser, { token: T.admin });
  const bodies = captureApi(p);
  await p.goto(`${APP}/meetings/${WS}`, { waitUntil: "networkidle" });
  await p.getByTestId("ask-across-open").click({ timeout: 20000 });
  await panel(p).waitFor({ timeout: 15000 });
  await p.waitForFunction(() => document.querySelector('[data-testid="assistant-scope-meetings"]')?.getAttribute("aria-checked") === "true", null, { timeout: 15000 });
  await ask(panel(p), `What did we decide about the ${SECRET} plan pricing?`);
  await panel(p).locator('ol[aria-label="Conversation"] > li:not([data-state="streaming"])').first().waitFor({ timeout: 30000 });
  await panel(p).getByTestId("assistant-scope-everything").click();
  await ask(panel(p), `What did we decide about the ${SECRET} plan pricing?`);
  await panel(p).locator('ol[aria-label="Conversation"] > li:not([data-state="streaming"])').nth(1).waitFor({ timeout: 30000 });
  await p.waitForTimeout(1500);
  const leaks = bodies.filter((b) => b.body.toLowerCase().includes("ninety nine") || b.body.includes(board.slug));
  if (leaks.length) fail(`a response to Wes carried the restricted meeting: ${leaks[0].url}`);
  // Vic (a viewer) reads the PRD: no Insert.
  const v = await ctx(browser, { token: T.reader });
  await v.p.goto(`${APP}/${PRD}`, { waitUntil: "networkidle" });
  await v.p.locator(".pb-frame").first().waitFor({ timeout: 30000 });
  await openPanel(v.p, "button");
  await ask(panel(v.p), "What is this page about?");
  await answered(panel(v.p));
  if (await panel(v.p).locator(".ch-tools").getByRole("button", { name: /Insert/ }).count()) fail("a viewer got Insert");
});

await step("folder", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/w/${WS}/f/${S.folder}`, { waitUntil: "networkidle" });
  await p.getByTestId("assistant-button").first().click({ timeout: 20000 });
  await panel(p).waitFor({ timeout: 15000 });
  await p.waitForFunction(() => document.querySelector('[data-testid="assistant-scope-folder"]')?.getAttribute("aria-checked") === "true", null, { timeout: 15000 });
  await shot(p, "as08-folder");
});

await step("phone", async () => {
  for (const theme of ["light", "dark"]) {
    const { c, p } = await ctx(browser, { token: T.member, theme, width: 390, height: 844, mobile: true });
    await p.goto(`${APP}/${PRD}`, { waitUntil: "networkidle" });
    await p.locator(".pb-frame, .pb-live").first().waitFor({ timeout: 30000 });
    await openPanel(p, "button");
    if ((await panel(p).getAttribute("data-layout")) !== "sheet") fail("not a sheet on a phone");
    const box = await panel(p).boundingBox();
    if (!box || box.width > 391) fail(`sheet width ${box?.width}`);
    const font = await fieldIn(panel(p)).evaluate((el) => getComputedStyle(el).fontSize);
    if (font !== "16px") fail(`field font ${font}`);
    await ask(panel(p), "Summarize this doc");
    await answered(panel(p));
    const wide = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (wide > 1) fail(`sideways scroll: ${wide}px`);
    await shot(p, `as09-phone-${theme}`);
    await c.close();
  }
});

console.log("\n" + results.map(([n, r, ms]) => `${r === "ok" ? "✓" : "✗"} ${n.padEnd(9)} ${r} (${(ms / 1000).toFixed(1)} s)`).join("\n"));
log("browser", BROWSER);
await browser.close();
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
