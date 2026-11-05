/**
 * Meetings UX on the REAL stack (up.sh with PB_FAKE_MEETINGS_AI=1 and PB_FAKE_ASK_AI=1, so Meetings AI and
 * Ask Markdrop run against the fake models in api_run.py). Seeds a realistic workspace (two series over two
 * months, one-offs, a restricted 1:1) and then:
 *
 *   hub       the Meetings hub: month headers, cards (cover, summary, counts, people, badges), series
 *             filter, sort, search; light/dark × desktop/tablet/phone
 *   across    Ask across meetings: the chat streams (typing state, stop button), [n] citations open the
 *             sources rail with the moment (speaker, time, quote) and jump to the transcript line,
 *             follow-ups, copy; Enter sends, Shift+Enter is a new line; phone: a full-screen sheet
 *   one       Ask this meeting on a meeting page (the panel), its header (series, organizer, people,
 *             Transcript, Ask)
 *   home      Ask Markdrop on the home (/dashboard) for comparison
 *
 *   PB_FAKE_MEETINGS_AI=1 PB_FAKE_ASK_AI=1 PB_STACK_ID=52 PB_WORK=… zsh up.sh start
 *   PB_STACK_ID=52 PB_WORK=… BROWSER=chromium|webkit [ONLY=hub,across] [SHOTS_ONLY=1] node meetings-ux.mjs
 *
 * Screenshots go to $UX_SHOTS (default <PB_WORK>/../ux-shots). SHOTS_ONLY=1 skips the assertions that
 * only the new UI passes (the "before" audit run).
 */
import fs from "node:fs";
import path from "node:path";
import { APP, BROWSER, WORK, log, fail, reseed, seedNow, api, launch, ctx, stepper } from "./lib.mjs";

const browser = await launch();
const { step, results } = stepper(browser);
const S = process.env.NO_RESEED ? seedNow() : reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const OUT = process.env.UX_SHOTS || path.resolve(WORK, "..", "ux-shots");
const AUDIT = !!process.env.SHOTS_ONLY;
fs.mkdirSync(OUT, { recursive: true });
const ok = (r, what) => { if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const HUB = `${APP}/meetings/${WS}`;
const SIZES = [[1440, 900, "desk"], [834, 1112, "tablet"], [390, 844, "phone"]];

async function snap(p, name, full = false) {
  await p.waitForTimeout(450);
  const file = path.join(OUT, `${BROWSER}-${name}.png`);
  await p.screenshot({ path: file, fullPage: full });
  log("shot", path.basename(file));
}

// ── The world: two series over two months, one-offs, a restricted 1:1 ─────────
const call = (title, day, time, lines, attendees = "Ada Owner, Ben Member, Vic Viewer") => `${title} (${day} ${time} GMT+05:30) - Transcript
Attendees
${attendees}
Transcript
This editable transcript was computer generated and might contain errors. People can also change the text after it was created.
${lines.join("\n")}
Transcription ended after 00:24:10
`;
const STANDUP = (day, extra) => call("Daily standup", day, "09:30", [
  "Ada Owner: Morning everyone, quick round please.",
  `Ben Member: Yesterday I fixed the export bug. ${extra}`,
  "Vic Viewer: I will finish the staging migration dry run today.",
  "Ada Owner: We agree the release candidate is cut on Thursday.",
  "00:05:00",
  "Ben Member: Is the pricing page copy blocked on finance?",
]);
const MEETINGS = [
  STANDUP("2026-11-04", "Today I'm on the onboarding emails."),
  STANDUP("2026-11-03", "Today I'm pairing with Vic on search."),
  STANDUP("2026-10-28", "Today I'm on the importer retries."),
  call("Sprint planning", "2026-11-02", "11:00", [
    "Ada Owner: Two things today, the release date and the pricing page.",
    "Ben Member: QA signed off last night, so we can ship the release on Friday.",
    "Vic Viewer: Haan, theek hai, but the migration needs one more dry run on staging.",
    "Ada Owner: Then we agree to ship the release on Friday if the staging dry run passes.",
    "Vic Viewer: Yes, I will run the staging dry run tomorrow morning.",
    "00:05:00",
    "Ben Member: I will update the onboarding docs with the new screenshots.",
    "Ada Owner: Do we show the annual discount on the pricing page?",
  ]),
  call("Sprint planning", "2026-10-19", "11:00", [
    "Ada Owner: Goal for this sprint is the new importer.",
    "Ben Member: We decide to drop the CSV v1 format, nobody uses it.",
    "Vic Viewer: I will write the migration for old imports.",
    "Ada Owner: Who owns the customer email about the change?",
  ]),
  call("Pricing review with finance", "2026-10-30", "16:00", [
    "Ada Owner: Finance wants the annual discount at 20 percent.",
    "Ben Member: We agree on 20 percent for annual plans, monthly stays the same.",
    "Ada Owner: I will update the pricing page copy by Monday.",
    "Ben Member: Do we grandfather existing customers?",
  ], "Ada Owner, Ben Member, Wes Admin"),
  call("Acme onboarding call", "2026-10-22", "14:30", [
    "Ada Owner: Acme wants SSO before they roll out to 400 seats.",
    "Ben Member: I will send them the SSO setup guide today.",
    "Ada Owner: We decide to give Acme a two week pilot.",
  ]),
];

const seeded = [];
await step("seed", async () => {
  for (const text of MEETINGS) {
    const name = text.split("\n")[0];
    const r = ok(await api("POST", "/api/v1/meetings/import", T.owner, { workspace: WS, wait: true, sources: [{ name, text }] }), `import ${name}`);
    seeded.push(r.meetings[0]);
  }
  const oneOnOne = call("Ada / Ben 1:1", "2026-11-01", "10:00", [
    "Ada Owner: How is the workload this month?",
    "Ben Member: Busy but fine, I will take Friday off.",
  ], "Ada Owner, Ben Member");
  ok(await api("POST", "/api/v1/meetings/import", T.owner, { workspace: WS, wait: true, restricted: true,
    sources: [{ name: oneOnOne.split("\n")[0], text: oneOnOne }] }), "1:1");
  const list = ok(await api("GET", `/api/v1/meetings?workspace=${WS}`, T.owner), "list");
  log("meetings", list.meetings.length, "series", [...new Set(list.meetings.map((m) => m.series).filter(Boolean))].join(", "));
});
const planning = () => seeded.find((m) => m.title === "Sprint planning" && m.date === "2026-11-02");

async function openAcross(p) {
  // New UI: the Ask button / the composer on the hub; old UI: the .mt-ask box.
  const box = p.locator("[data-testid='ask-across'], .mt-ask").first();
  await box.waitFor({ timeout: 20000 });
  return box;
}

await step("hub", async () => {
  for (const theme of ["light", "dark"]) {
    for (const [w, h, tag] of SIZES) {
      const { p } = await ctx(browser, { token: T.owner, theme, width: w, height: h, mobile: tag !== "desk" });
      await p.goto(HUB);
      await p.getByTestId("meetings-list").waitFor({ timeout: 20000 });
      await snap(p, `hub-${theme}-${tag}`);
      if (tag === "desk" && theme === "light") await snap(p, `hub-${theme}-${tag}-full`, true);
      if (!AUDIT && tag === "desk" && theme === "light") {
        const cards = p.getByTestId("meeting-card");
        if ((await cards.count()) < 7) fail(`only ${await cards.count()} cards`);
        const first = cards.first();
        for (const tid of ["card-summary", "card-when"]) {
          if (!(await first.getByTestId(tid).count())) fail(`card lacks ${tid}`);
        }
        if (!(await p.getByTestId("month-header").count())) fail("no month headers");
        // Search filters the cards; the series filter narrows them.
        await p.getByRole("searchbox", { name: "Filter meetings" }).fill("pricing");
        await p.waitForTimeout(250);
        if ((await cards.count()) !== 1) fail(`search left ${await cards.count()} cards`);
        await p.getByRole("searchbox", { name: "Filter meetings" }).fill("");
      }
    }
  }
});

await step("across", async () => {
  for (const theme of ["light", "dark"]) {
    for (const [w, h, tag] of SIZES) {
      if (tag === "tablet" && theme === "dark") continue;
      const { p } = await ctx(browser, { token: T.owner, theme, width: w, height: h, mobile: tag !== "desk" });
      await p.goto(HUB);
      const box = await openAcross(p);
      if (!AUDIT) await box.click();
      await p.waitForTimeout(300);
      await snap(p, `across-empty-${theme}-${tag}`);
      const field = p.locator("textarea[aria-label='Your question']:visible").first();
      await field.fill("When do we ship the release?");
      await field.press("Enter");
      await p.locator(".mt-cite, .ch-cite").first().waitFor({ timeout: 25000 });
      await p.waitForTimeout(1200);
      await snap(p, `across-answer-${theme}-${tag}`);
      if (!AUDIT) {
        await p.locator(".ch-cite").first().click();
        await p.getByTestId("chat-sources").waitFor({ timeout: 5000 });
        await snap(p, `across-sources-${theme}-${tag}`);
      }
    }
  }
});

await step("one", async () => {
  const m = planning();
  if (!m) fail("no planning meeting");
  for (const theme of ["light", "dark"]) {
    for (const [w, h, tag] of SIZES) {
      if (tag === "tablet") continue;
      const { p } = await ctx(browser, { token: T.owner, theme, width: w, height: h, mobile: tag !== "desk" });
      await p.goto(`${APP}/${m.slug}`);
      await p.getByTestId("meeting-pill").waitFor({ timeout: 20000 });
      await snap(p, `page-${theme}-${tag}`);
      await p.getByTestId("meeting-pill").click();
      await p.waitForTimeout(350);
      await snap(p, `one-empty-${theme}-${tag}`);
      const field = p.locator("textarea[aria-label='Your question']:visible").first();
      await field.fill("When do we ship the release?");
      await field.press("Enter");
      await p.locator(".mt-cite, .ch-cite").first().waitFor({ timeout: 25000 });
      await p.waitForTimeout(1200);
      await snap(p, `one-answer-${theme}-${tag}`);
    }
  }
});

await step("home", async () => {
  for (const theme of ["light", "dark"]) {
    for (const [w, h, tag] of SIZES) {
      if (tag === "tablet") continue;
      const { p } = await ctx(browser, { token: T.owner, theme, width: w, height: h, mobile: tag !== "desk" });
      await p.goto(`${APP}/dashboard`);
      await p.waitForTimeout(2500);
      await snap(p, `home-${theme}-${tag}`);
      const field = p.locator("textarea:visible").first();
      if (await field.count()) {
        await field.fill("When do we ship the release?");
        await field.press("Enter");
        await p.waitForTimeout(5000);
        await snap(p, `home-answer-${theme}-${tag}`);
      }
    }
  }
});

console.log("\nRESULTS", BROWSER);
for (const [n, s, ms] of results) console.log(`  ${s === "ok" ? "✓" : "✗"} ${n} ${s === "ok" ? "" : s} (${(ms / 1000).toFixed(1)} s)`);
await browser.close();
process.exit(results.some(([, s]) => s !== "ok") ? 1 : 0);
