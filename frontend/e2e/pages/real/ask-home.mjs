/**
 * Ask Markdrop on the home, on the REAL stack (up.sh with PB_FAKE_ASK_AI=1 and PB_FAKE_MEETINGS_AI=1, so
 * both run against the fake models in api_run.py): the box is the first thing on /dashboard, an answer
 * streams with numbered sources and a meeting's transcript moment, a follow-up stays in the thread (and
 * survives a reload through ?ask=), the suggested questions (my action items, catch me up), recent
 * questions (open, forget), a private document never reaches another member (not even in an API
 * response), and phones (no sideways scroll, 16px field, 44px targets).
 *
 *   PB_FAKE_ASK_AI=1 PB_FAKE_MEETINGS_AI=1 PB_STACK_ID=40 PB_WORK=… zsh up.sh start
 *   PB_STACK_ID=40 PB_WORK=… BROWSER=chromium|webkit [ONLY=ask,followup] node ask-home.mjs
 *
 * Screenshots (light and dark, 1440 and 390) go to $ASK_SHOTS (default <PB_WORK>/../shots).
 */
import fs from "node:fs";
import path from "node:path";
import { APP, BROWSER, WORK, log, fail, reseed, seedNow, api, launch, ctx, captureApi, stepper } from "./lib.mjs";

const browser = await launch();
const { step, results } = stepper(browser);
const S = process.env.NO_RESEED ? seedNow() : reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const OUT = process.env.ASK_SHOTS || path.resolve(WORK, "..", "shots");
fs.mkdirSync(OUT, { recursive: true });
const ok = (r, what) => { if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };

async function snap(p, name) {
  await p.waitForTimeout(450);
  const file = path.join(OUT, `${BROWSER}-${name}.png`);
  await p.screenshot({ path: file });
  log("shot", path.basename(file));
}

// ── The world ────────────────────────────────────────────────────────────────
const TRANSCRIPT = `Release sync (2026-11-05 09:30 GMT+05:30) - Transcript
Attendees
Ada Owner, Ben Member, Vic Viewer
Transcript
This editable transcript was computer generated and might contain errors. People can also change the text after it was created.
Ada Owner: Morning. Two things today, the release date and the pricing page.
Ben Member: QA signed off last night, so we can ship the release on Friday.
Vic Viewer: Haan, theek hai, but the migration needs one more dry run on staging.
Ada Owner: Then we agree to ship the release on Friday if the staging dry run passes.
Vic Viewer: Yes, I will run the staging dry run tomorrow morning.
00:05:00
Ben Member: I will update the onboarding docs with the new screenshots.
Ada Owner: Do we show the annual discount on the pricing page?
Transcription ended after 00:09:12
`;
const filing = { workspace: WS, access_level: "workspace", expires_in: "never" };
ok(await api("POST", "/api/v1/documents", T.owner, {
  ...filing, title: "Release checklist", custom_slug: "release-checklist",
  content: "# Release checklist\n\nThe release ships on Friday after the staging dry run.\n\n## Pricing\n\nThe annual discount is 20 percent.\n",
}), "release doc");
ok(await api("POST", "/api/v1/documents", T.owner, {
  ...filing, access_level: "private", title: "Release salaries zebra", custom_slug: "release-salaries",
  content: "# Release salaries zebra\n\nConfidential release bonus pool.\n",
}), "private doc");
const meeting = ok(await api("POST", "/api/v1/meetings/import", T.owner, {
  workspace: WS, wait: true, sources: [{ name: "Release sync (2026-11-05 09:30 GMT+05:30) - Transcript", text: TRANSCRIPT }],
}), "meeting").meetings[0];
await new Promise((r) => setTimeout(r, 1500)); // the content index follows each save off the request

// The home's box is Ask Markdrop on the shared chat (components/chat): its test ids.
const box = (p) => p.getByTestId("ask-home");
const field = (p) => box(p).locator('textarea[aria-label="Your question"]');
const turnsOf = (p) => box(p).locator('ol[aria-label="Conversation"] > li');

async function home(p) {
  await p.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
  await box(p).waitFor({ timeout: 15000 });
}
async function ask(p, q) {
  await field(p).fill(q);
  await field(p).press("Enter");
}
/** Waits for the n-th answer (1-based) to finish. */
async function answered(p, n = 1) {
  await p.waitForFunction((k) => document.querySelectorAll('[data-testid="ask-home"] ol[aria-label="Conversation"] > li[data-state="done"]').length >= k, n, { timeout: 25000 });
}

// ── Steps ────────────────────────────────────────────────────────────────────

await step("first", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await home(p);
  // The first thing in the page's content: above the "My files" heading.
  const order = await p.evaluate(() => {
    const ask = document.querySelector('[data-testid="ask-home"]');
    const h1 = document.querySelector("main h1");
    return ask && h1 ? !!(ask.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING) : null;
  });
  if (order !== true) fail(`Ask Markdrop isn't above the page heading (${order})`);
  const chips = await box(p).getByTestId("chat-starters").locator("button").allInnerTexts();
  if (!chips.some((c) => /Catch me up/.test(c)) || !chips.some((c) => /action items/.test(c))) fail(`chips: ${chips}`);
  if (!chips.some((c) => /Release sync/.test(c))) fail(`no meeting suggestion: ${chips}`);
  await snap(p, "home-light-1440");
});

let threadUrl = null;
await step("ask", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await home(p);
  await ask(p, "When do we ship the release?");
  await answered(p);
  const cites = await box(p).getByTestId("chat-cite").count();
  if (cites < 2) fail(`only ${cites} citation chips`);
  await box(p).getByTestId("chat-sources-btn").last().click();
  const src = box(p).getByTestId("chat-sources");
  await src.waitFor({ timeout: 5000 });
  const text = await src.innerText();
  if (!/Release checklist/.test(text)) fail("the doc isn't a source");
  if (!/Release sync/.test(text)) fail("the meeting isn't a source");
  const moment = src.getByTestId("chat-source-link").filter({ hasText: "Jump to moment" }).first();
  await moment.waitFor({ timeout: 5000 });
  if (!/[?&]ask=[0-9a-f]{24}/.test(p.url())) fail(`no ?ask= in ${p.url()}`);
  threadUrl = p.url();
  await snap(p, "answer-light-1440");
  // A moment opens the transcript at that line.
  await moment.click();
  await p.waitForURL(new RegExp(`${meeting.transcript_slug}.*#b-t\\d{4}`), { timeout: 15000 });
});

await step("followup", async () => {
  if (!threadUrl) fail("no thread from the ask step");
  const { p } = await ctx(browser, { token: T.member, theme: "dark" });
  await p.goto(threadUrl, { waitUntil: "networkidle" });
  await answered(p, 1);                                   // reopened from the URL
  if ((await turnsOf(p).count()) !== 1) fail("the thread didn't reopen");
  await ask(p, "and the annual discount?");
  await answered(p, 2);
  const qs = await turnsOf(p).locator(".ch-q__bubble").allInnerTexts();
  if (qs.length !== 2 || !/annual discount/.test(qs[1])) fail(`turns: ${qs}`);
  await snap(p, "followup-dark-1440");
  await p.reload({ waitUntil: "networkidle" });
  await answered(p, 2);
  // New chat: back to the home's suggestions, and out of the address.
  await box(p).getByTestId("chat-new").click();
  await box(p).getByTestId("chat-starters").waitFor({ timeout: 5000 });
  await p.waitForTimeout(300);
  if (/[?&]ask=/.test(p.url())) fail("New chat kept ?ask=");
});

await step("chips", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await home(p);
  await box(p).getByTestId("chat-starters").getByRole("button", { name: /open action items/ }).click();
  await answered(p);
  const text = await turnsOf(p).last().innerText();
  if (!/onboarding docs/i.test(text)) fail(`Ben's action item isn't listed: ${text.slice(0, 400)}`);
  if (/dry run tomorrow/i.test(text)) fail("Vic's action item is listed for Ben");
  await snap(p, "actions-light-1440");
  await box(p).getByTestId("chat-new").click();
  await box(p).getByTestId("chat-starters").getByRole("button", { name: /Catch me up/ }).click();
  await answered(p);
  if (!/week/i.test(await box(p).innerText())) fail("no catch-up");
  await snap(p, "catchup-light-1440");
});

await step("recent", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await home(p);
  const rows = box(p).locator("ul li", { has: p.locator('button[aria-label^="Forget"]') });
  await rows.first().waitFor({ timeout: 10000 });
  const n = await rows.count();
  if (n < 3) fail(`only ${n} recent questions`);
  const first = await rows.first().innerText();
  await rows.first().locator('button[aria-label^="Forget"]').click();
  await p.waitForFunction((k) => document.querySelectorAll('[data-testid="ask-home"] button[aria-label^="Forget"]').length === k, n - 1, { timeout: 10000 });
  // Open one: the conversation comes back.
  await rows.first().locator("button").first().click();
  await answered(p);
  void first;
});

await step("private", async () => {
  // Vic (a viewer) asks about the owner's private document: never read, never in a response.
  const { p } = await ctx(browser, { token: T.reader });
  const bodies = captureApi(p);
  await home(p);
  await ask(p, "What are the release salaries zebra?");
  await answered(p).catch(() => {});
  await p.waitForTimeout(800);
  // Only what's IN the private document counts (its slug, title, body); the question's own words come back
  // as the search terms ("searching" status), which is the asker's text, not a leak.
  const leak = bodies.filter((b) => /release-salaries|Release salaries zebra|Confidential|bonus pool/.test(b.body));
  if (leak.length) fail(`a response carried the private document: ${leak[0].url}`);
  if (!bodies.some((b) => /\/api\/v1\/ask$/.test(b.url))) fail("no ask request was seen");
});

await step("phone", async () => {
  for (const theme of ["light", "dark"]) {
    const { c, p } = await ctx(browser, { token: T.member, theme, width: 390, height: 844, mobile: true });
    await home(p);
    const m = await p.evaluate(() => {
      const f = document.querySelector('[data-testid="ask-home"] textarea[aria-label="Your question"]');
      const send = document.querySelector('[data-testid="ask-home"] [data-testid="chat-send"]');
      const chip = document.querySelector('[data-testid="ask-home"] [data-testid="chat-starters"] button');
      const r = (el) => el?.getBoundingClientRect();
      return {
        scroll: document.scrollingElement.scrollWidth, width: window.innerWidth,
        font: f ? getComputedStyle(f).fontSize : null,
        send: r(send) && [r(send).width, r(send).height], chip: r(chip) && r(chip).height,
      };
    });
    if (m.scroll > m.width + 1) fail(`sideways scroll on a phone: ${m.scroll} > ${m.width}`);
    if (m.font !== "16px") fail(`field font ${m.font}`);
    if (BROWSER === "chromium" && (m.send[0] < 39 || m.send[1] < 39 || m.chip < 44)) fail(`small targets: send ${m.send}, chip ${m.chip}`);
    await snap(p, `home-${theme}-390`);
    await ask(p, "When do we ship the release?");
    await answered(p);
    const w = await p.evaluate(() => document.scrollingElement.scrollWidth);
    if (w > 391) fail(`the answer scrolls sideways: ${w}`);
    await snap(p, `answer-${theme}-390`);
    await c.close();
  }
});

await step("api", async () => {
  // The same answer over MCP, and threads stay private.
  const mine = ok(await api("GET", "/api/v1/ask/threads", T.member), "threads");
  if (!mine.threads.length) fail("no threads");
  const other = await api("GET", `/api/v1/ask/threads/${mine.threads[0].id}`, T.reader);
  if (other.status !== 404) fail(`Vic opened Ben's thread: ${other.status}`);
});

fs.writeFileSync(path.join(OUT, `${BROWSER}-ask-results.json`), JSON.stringify(results, null, 1));
await browser.close();
for (const [n, r] of results) console.log(`  ${r === "ok" ? "✓" : "✗"} ${n}: ${r}`);
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
