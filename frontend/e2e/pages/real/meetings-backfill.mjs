/**
 * Import past meetings + how meetings are organised, on the REAL stack (up.sh, PB_FAKE_MEETINGS_AI=1):
 *
 *   bulk      the hub → Import past meetings → drop 5 files (Google-named transcripts and Gemini notes,
 *             a .vtt, an undated .txt) → the review: notes + transcript of one call paired, dates from
 *             the names, series detected, the undated row flagged until it gets a date → Import → the
 *             progress panel → done: every meeting on its real date, in its series, nobody notified
 *   hub       month headers, series chips (filter), a series on the cards
 *   again     the same files again: "Already imported" in the review, nothing to import
 *   folder    Meetings holds a folder per series and Other meetings; each opens on "All meetings", newest
 *             first, grouped by month
 *   ask       Ask across meetings scoped to a series (the picker) answers from that series only, and says
 *             when and where; a scope read from the question ("in the Daily Standups last month")
 *   shots     light/dark × desktop/phone: the review, the hub, the progress panel
 *   docs-media DOCS_MEDIA=1: the docs' screenshots (review, organised hub) as WebP
 *
 *   PB_FAKE_MEETINGS_AI=1 PB_STACK_ID=43 PB_WORK=… BROWSER=chromium|webkit node meetings-backfill.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { APP, BROWSER, WORK, log, fail, reseed, seedNow, api, launch, ctx, stepper } from "./lib.mjs";

const browser = await launch();
const { step, results } = stepper(browser);
const S = process.env.NO_RESEED ? seedNow() : reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const OUT = process.env.MEETINGS_SHOTS || path.resolve(WORK, "..", "backfill-shots");
const DOCS_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../public/docs-assets/workspaces/meetings-import");
fs.mkdirSync(OUT, { recursive: true });
const ok = (r, what) => { if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const HUB = `${APP}/meetings/${WS}`;

async function snap(p, name, full = false) {
  await p.waitForTimeout(500);
  const file = path.join(OUT, `${BROWSER}-${name}.png`);
  await p.screenshot({ path: file, fullPage: full });
  log("shot", path.basename(file));
}

// Dates: two calls last month, one the month before (so there are at least two months).
const now = new Date();
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// A Google Doc downloaded from Drive keeps its name with "_" for "/" and ":" (a file name can't hold them).
const slash = (d) => ymd(d).replaceAll("-", "_");
const D1 = new Date(now.getFullYear(), now.getMonth() - 1, 10);
const D2 = new Date(now.getFullYear(), now.getMonth() - 1, 20);
const D0 = new Date(now.getFullYear(), now.getMonth() - 2, 14);
const D_UNDATED = new Date(now.getFullYear(), now.getMonth() - 2, 3);
const monthName = (d) => d.toLocaleDateString("en-US", { month: "long", year: "numeric" });

const standup = (extra) => `Ada Owner: Morning all, quick standup.
Ben Member: I will finish the billing migration today${extra}.
Vic Viewer: Then we agree to ship the billing API on Friday.
`;
const NOTES = `# Daily Standup
Summary
The team synced on the billing migration and the API.

Details
- Billing migration is on track.

Suggested next steps
- Ben Member will finish the billing migration.
`;
const VTT = `WEBVTT

1
00:00:01.000 --> 00:00:05.000
<v Ada Owner>Design sync: the onboarding screens are ready for review.

2
00:00:06.000 --> 00:00:10.000
<v Ben Member>I will ship the new onboarding copy next week.
`;
const FILES = [
  [`Daily Standup – ${slash(D1)} 10_00 IST – Transcript.txt`, standup(" (one)")],
  [`Daily Standup – ${slash(D1)} 10_00 IST – Notes by Gemini.txt`, NOTES],
  [`Daily Standup – ${slash(D2)} 10_00 IST – Transcript.txt`, standup(" (two), and the pricing page")],
  [`Design sync ${ymd(D0)}.vtt`, VTT],
  ["hallway.txt", "Ada Owner: Quick hallway chat about the offsite.\nBen Member: I will book the venue for the offsite.\n"],
];

function writeFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtg-bulk-"));
  return FILES.map(([name, text]) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; });
}

async function openReview(p, files) {
  await p.goto(HUB);
  // Desktop: the button in the header; phones: the ⋯ menu.
  const btn = p.locator("[data-testid='import-past']:visible").first();
  if (await btn.count()) await btn.click();
  else {
    await p.getByTestId("meetings-more").click();
    await p.getByRole("menuitem", { name: "Import past meetings" }).click();
  }
  const dlg = p.getByRole("dialog");
  await dlg.getByText("Import past meetings").first().waitFor();
  await dlg.locator('input[type="file"]').setInputFiles(files);
  await dlg.getByTestId("bulk-review").waitFor({ timeout: 30000 });
  return dlg;
}

let meetings = [];

await step("bulk", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  const dlg = await openReview(p, writeFiles());
  const rows = dlg.getByTestId("bulk-row");
  if ((await rows.count()) !== 4) fail(`review rows: ${await rows.count()} (want 4: one standup paired)`);
  const job = ok(await api("GET", `/api/v1/meetings/backfill?workspace=${WS}`, T.owner), "jobs").jobs.find((j) => j.state === "draft");
  if (!job) fail("no draft");
  const paired = job.rows.find((r) => r.date === ymd(D1));
  if (!paired || paired.kinds.join() !== "notes,transcript" || paired.series !== "Daily Standup" || paired.date_from !== "title") fail(`paired row: ${JSON.stringify(paired)}`);
  const d2 = job.rows.find((r) => r.date === ymd(D2));
  if (!d2 || d2.series !== "Daily Standup" || d2.time !== "10:00") fail(`second standup: ${JSON.stringify(d2)}`);
  const design = job.rows.find((r) => r.date === ymd(D0));
  if (!design || design.title !== "Design sync" || design.series) fail(`design sync: ${JSON.stringify(design)}`);
  const undated = job.rows.find((r) => !r.date);
  if (!undated || !undated.needs_date) fail("the undated file isn't flagged");
  // Where each goes, and who sees it: the standups in Meetings › Daily Standup for the team; the
  // two-person hallway chat in Other meetings, for its attendees.
  if (paired.folder !== "Daily Standup" || paired.restricted) fail(`paired folder/visibility: ${paired.folder} ${paired.restricted}`);
  if (undated.folder !== "Other meetings" || !undated.restricted || undated.restricted_from !== "auto") fail(`hallway: ${JSON.stringify(undated)}`);
  if (!(await rows.first().getByTestId("bulk-visibility").innerText()).includes("Attendees")) fail("the hallway row doesn't say Attendees");
  if (!(await rows.first().getByTestId("bulk-folder").innerText()).includes("Other meetings")) fail("the hallway row's folder");
  await dlg.getByText("1 needs a date").waitFor();
  const start = dlg.getByTestId("bulk-start");
  if (await start.isEnabled()) fail("Import is enabled with an undated row");
  if (!(await start.innerText()).includes("Add 1 date first")) fail(`start label: ${await start.innerText()}`);
  await snap(p, "review-flagged-light");
  // Fill the date and the name of the undated one (the first row: undated rows come first).
  const first = rows.first();
  await first.getByTestId("bulk-date").fill(ymd(D_UNDATED));
  await dlg.getByText("1 needs a date").waitFor({ state: "detached", timeout: 15000 });
  await first.getByTestId("bulk-title").fill("Hallway chat");
  await first.getByTestId("bulk-title").press("Enter");
  await p.waitForTimeout(800);
  await dlg.getByTestId("bulk-estimate").waitFor();
  if (!(await start.innerText()).includes("Import 4 meetings")) fail(`start label: ${await start.innerText()}`);
  await snap(p, "review-light");
  await start.click();
  await p.getByTestId("backfill-progress").waitFor({ timeout: 15000 });
  await snap(p, "progress-light");
  // The import runs on the server; the panel follows it.
  await p.locator('[data-testid="backfill-progress"][data-state="done"]').waitFor({ timeout: 90000 });
  await snap(p, "progress-done-light");
  const list = ok(await api("GET", `/api/v1/meetings?workspace=${WS}`, T.owner), "list").meetings;
  meetings = list;
  const want = { [ymd(D0)]: "Design sync", [ymd(D_UNDATED)]: "Hallway chat", [ymd(D1)]: "Daily Standup", [ymd(D2)]: "Daily Standup" };
  for (const [d, t] of Object.entries(want)) {
    const m = list.find((x) => x.date === d);
    if (!m || m.title !== t) fail(`meeting on ${d}: ${JSON.stringify(m)?.slice(0, 200)}`);
    if (!m.history) fail(`${t} on ${d} wasn't imported quietly`);
    if (m.restricted !== (t !== "Daily Standup")) fail(`${t}: restricted ${m.restricted}`);   // two people: attendees only
  }
  const su = list.filter((m) => m.series === "Daily Standup");
  if (su.length !== 2) fail(`Daily Standup series: ${su.length}`);
  if (!su.find((m) => m.date === ymd(D1)).has_notes) fail("the notes weren't paired into the standup");
  // Old action items mention Ben, but nobody was notified.
  const notes = ok(await api("GET", "/api/v1/notifications", T.member), "notifications");
  if ((notes.items || []).some((n) => list.some((m) => n.page?.slug === m.slug))) fail("Ben was notified about a past meeting");
});

await step("hub", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(HUB);
  await p.getByTestId("meetings-list").waitFor({ timeout: 20000 });
  const heads = await p.getByTestId("month-header").allInnerTexts();
  for (const d of [D1, D0]) if (!heads.some((h) => h.startsWith(monthName(d)))) fail(`month headers ${JSON.stringify(heads)} lack ${monthName(d)}`);
  const chips = p.getByTestId("series-chips");
  await chips.getByRole("button", { name: /Daily Standup/ }).click();
  await p.waitForTimeout(300);
  const cards = await p.getByTestId("meeting-card").count();
  if (cards !== 2) fail(`Daily Standup filter shows ${cards}`);
  await snap(p, "hub-series-light");
  await chips.getByRole("button", { name: /^All/ }).click();
});

await step("again", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  const dlg = await openReview(p, writeFiles().slice(0, 3));
  await dlg.getByText("2 already here").waitFor({ timeout: 15000 });
  if (await dlg.getByTestId("bulk-start").isEnabled()) fail("nothing new, yet Import is enabled");
  await snap(p, "review-duplicates-light");
  await dlg.getByRole("button", { name: "Discard" }).click();
});

await step("folder", async () => {
  const tree = ok(await api("GET", `/api/v1/workspaces/${WS}/tree`, T.owner), "tree");
  const root = (tree.folders || []).find((f) => f.meetings);
  const subs = (tree.folders || []).filter((f) => f.parent_id === root.id);
  const su = subs.find((f) => f.name === "Daily Standup");
  const other = subs.find((f) => f.name === "Other meetings");
  if (!su?.meetings_sub || !other?.meetings_sub) fail(`subfolders: ${JSON.stringify(subs.map((f) => f.name))}`);
  const { p } = await ctx(browser, { token: T.owner });
  // Meetings itself: its folders.
  await p.goto(`${APP}/w/${WS}/f/${root.id}`);
  await p.getByTestId("meetings-folderbar").waitFor({ timeout: 20000 });
  await p.getByText("Daily Standup", { exact: true }).first().waitFor({ timeout: 20000 });
  await p.getByText("Other meetings", { exact: true }).first().waitFor();
  await snap(p, "folder-root-light");
  // A series folder opens on All meetings, newest first, by month.
  await p.goto(`${APP}/w/${WS}/f/${su.id}`);
  const tab = p.getByRole("tab", { name: "All meetings" });
  await tab.waitFor({ timeout: 20000 });
  if ((await tab.getAttribute("aria-selected")) !== "true") fail("the series folder doesn't open on All meetings");
  const groups = p.locator(".pp-group");
  await groups.first().waitFor({ timeout: 20000 });
  const labels = (await groups.allInnerTexts()).map((t) => t.trim());
  if (!labels[0].includes(monthName(D1))) fail(`month groups ${JSON.stringify(labels)}`);
  if ((await p.locator("tbody tr:not(.pp-group)").filter({ hasText: "Daily Standup ·" }).count()) !== 2) fail("two standups in their folder");
  await snap(p, "folder-all-light");
  // Other meetings: the one-offs, by month.
  await p.goto(`${APP}/w/${WS}/f/${other.id}`);
  await p.locator(".pp-group").first().waitFor({ timeout: 20000 });
  const ol = (await p.locator(".pp-group").allInnerTexts()).map((t) => t.trim());
  if (!ol[0].includes(monthName(D0))) fail(`Other meetings groups ${JSON.stringify(ol)}`);
  await snap(p, "folder-other-light");
  await p.getByRole("tab", { name: "List" }).click();
  await p.waitForURL((u) => u.searchParams.get("view") === "list", { timeout: 10000 });
});

await step("ask", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(HUB);
  await p.getByTestId("ask-across-open").click();
  const box = p.getByTestId("assistant");
  await box.getByTestId("chat-scope-series").click();
  await p.getByRole("menuitem", { name: "Daily Standup" }).click();
  await box.locator("textarea").fill("What did Ben say about billing?");
  await box.locator("textarea").press("Enter");
  await box.getByTestId("chat-cite").first().waitFor({ timeout: 25000 });
  const scope = await box.getByTestId("chat-scopenote").first().innerText();
  if (!scope.includes("Meetings · Daily Standup")) fail(`scope chip: ${scope}`);
  await box.getByTestId("chat-sources-btn").first().click();
  const sources = await box.getByTestId("chat-sources").locator(".ch-src__title").allInnerTexts();
  if (!sources.length || sources.some((s) => !s.trim().startsWith("Daily Standup"))) fail(`sources: ${JSON.stringify(sources)}`);
  await p.keyboard.press("Escape");
  const answer = await box.locator(".ch-md").first().innerText();
  if (!/^On \d+ \w+, in Daily Standup, /.test(answer.trim())) fail(`answer doesn't say when and where: ${answer.slice(0, 120)}`);
  await snap(p, "ask-series-light");
  // No picker, the question says it.
  await box.getByTestId("chat-scope-series").click();
  await p.getByRole("menuitem", { name: "Any series" }).click();
  await box.locator("textarea").fill("What came up in the Daily Standups last month?");
  await box.locator("textarea").press("Enter");
  const chip = box.getByTestId("chat-scopenote").nth(1);
  await chip.waitFor({ timeout: 25000 });
  const t = await chip.innerText();
  if (!t.includes("From your question") || !t.includes("Daily Standup") || !t.includes(monthName(D1))) fail(`detected scope: ${t}`);
  await snap(p, "ask-detected-light");
});

await step("shots", async () => {
  for (const theme of ["light", "dark"]) {
    for (const [w, h, tag] of [[1440, 900, "desk"], [390, 844, "phone"]]) {
      const mobile = tag !== "desk";
      const { p } = await ctx(browser, { token: T.admin, theme, width: w, height: h, mobile });
      await p.goto(HUB);
      await p.getByTestId("meetings-list").waitFor({ timeout: 20000 });
      await snap(p, `hub-${theme}-${tag}`);
      const dlg = await openReview(p, writeFiles());
      await p.waitForTimeout(500);
      if (tag === "phone") {
        const size = await dlg.getByTestId("bulk-date").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
        if (size < 16) fail(`a date field is ${size}px on a phone`);
      }
      await snap(p, `review-${theme}-${tag}`);
      await dlg.getByRole("button", { name: "Discard" }).click();
    }
  }
});

await step("docs-media", async () => {
  if (!process.env.DOCS_MEDIA) return log("(DOCS_MEDIA unset: docs screenshots skipped)");
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const raw = path.join(OUT, "docs");
  fs.mkdirSync(raw, { recursive: true });
  const webp = (png, name) => {
    let q = 82;
    for (;;) {
      execFileSync("cwebp", ["-quiet", "-q", String(q), png, "-o", path.join(DOCS_DIR, `${name}.webp`)]);
      if (fs.statSync(path.join(DOCS_DIR, `${name}.webp`)).size <= 180 * 1024 || q <= 50) break;
      q -= 8;
    }
    log("docs", `${name}.webp`, fs.statSync(path.join(DOCS_DIR, `${name}.webp`)).size);
  };
  for (const theme of ["light", "dark"]) {
    const suffix = theme === "dark" ? ".dark" : "";
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
    await c.addInitScript(([t, th]) => {
      localStorage.setItem("markdrop_token", t); localStorage.setItem("md_theme", th);
      localStorage.setItem("md_theme_beta", "1"); localStorage.setItem("md_consent", "denied");
    }, [T.admin, theme]);
    const p = await c.newPage();
    // The review: a fresh batch (two new standups, one already here, one undated).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtg-docs-"));
    const later = [new Date(now.getFullYear(), now.getMonth(), Math.max(1, now.getDate() - 3)), new Date(now.getFullYear(), now.getMonth(), Math.max(1, now.getDate() - 2))];
    const files = [
      [`Daily Standup – ${slash(later[0])} 10_00 IST – Transcript.txt`, standup(" (three)")],
      [`Daily Standup – ${slash(later[0])} 10_00 IST – Notes by Gemini.txt`, NOTES],
      [`Daily Standup – ${slash(later[1])} 10_00 IST – Transcript.txt`, standup(" (four)")],
      FILES[0],
      ["retro-notes.txt", "Ada Owner: What went well this sprint?\nBen Member: The billing rollout went smoothly.\n"],
    ].map(([n, t]) => { const f = path.join(dir, n); fs.writeFileSync(f, t); return f; });
    const dlg = await openReview(p, files);
    await p.waitForTimeout(900);
    await p.evaluate(() => document.activeElement?.blur());
    await p.locator(".md-dialog").first().screenshot({ path: path.join(raw, `review${suffix}.png`) });
    webp(path.join(raw, `review${suffix}.png`), `review${suffix}`);
    await dlg.getByRole("button", { name: "Discard" }).click();
    // The organised hub: series chips and the first month.
    await p.goto(HUB);
    await p.getByTestId("month-header").first().waitFor({ timeout: 20000 });
    await p.waitForTimeout(800);
    // The list section: its series chips and every month.
    await p.locator('section[aria-labelledby="mt-list-title"]').screenshot({ path: path.join(raw, `organised${suffix}.png`) });
    webp(path.join(raw, `organised${suffix}.png`), `organised${suffix}`);
    await c.close();
  }
});

console.log("\nRESULTS", BROWSER);
for (const [n, s, ms] of results) console.log(`  ${s === "ok" ? "✓" : "✗"} ${n} ${s === "ok" ? "" : s} (${(ms / 1000).toFixed(1)} s)`);
await browser.close();
process.exit(results.some(([, s]) => s !== "ok") ? 1 : 0);
