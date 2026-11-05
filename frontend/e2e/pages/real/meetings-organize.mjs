/**
 * Meetings release requests (2026-11-05) on the REAL stack (up.sh, with PB_FAKE_MEETINGS_AI=1):
 *   covers      every meeting page has a gallery cover; one per series (both spellings of a series share
 *               it), a one-off has the generic one
 *   one-item    a meeting is one item: its Transcript is not a row of the folder's List view, the items
 *               API or search (a word only in the transcript finds the meeting page); still the page's child
 *   series      "Daily Syncup" and "Daily Sync Up" are one series folder; "Daily Standup" is not merged
 *   organize    Organize meetings (admin) says how many meetings and series
 *   sort        the hub's sort: meeting date newest (default) / oldest / title / recently imported,
 *               remembered after a reload; a series folder opens on its table sorted by Date
 *
 *   PB_FAKE_MEETINGS_AI=1 PB_STACK_ID=49 PB_WORK=… BROWSER=chromium|webkit [ONLY=covers,sort] node meetings-organize.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { APP, BROWSER, WORK, log, fail, reseed, seedNow, api, launch, ctx, stepper } from "./lib.mjs";

const browser = await launch();
const { step, results } = stepper(browser);
const S = process.env.NO_RESEED ? seedNow() : reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const OUT = process.env.MEETINGS_SHOTS || path.resolve(WORK, "..", "organize-shots");
fs.mkdirSync(OUT, { recursive: true });
const ok = (r, what) => { if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const HUB = `${APP}/meetings/${WS}`;

async function snap(p, name) {
  await p.waitForTimeout(400);
  const file = path.join(OUT, `${BROWSER}-${name}.png`);
  await p.screenshot({ path: file });
  log("shot", path.basename(file));
}

const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const talk = (word) => `Ada Owner: Morning, quick sync on the ${word} rollout.\nBen Member: The ${word} work is on track.\nVic Viewer: Good, ship it Friday.\n`;
const M = {};
async function imp(key, title, ago, word) {
  const r = ok(await api("POST", "/api/v1/meetings/import", T.owner, {
    workspace: WS, wait: true, title, date: day(ago), sources: [{ name: `${title}.txt`, text: talk(word) }],
  }), `import ${key}`);
  M[key] = r.meetings[0];
}
await imp("kickoff", "Kickoff", 20, "zebrafinch");
await imp("syncA", "Daily Syncup", 12, "otterglass");
await imp("syncB", "Daily Sync Up", 5, "quokkabell");
await imp("standup", "Daily Standup", 4, "lynxpaper");
// The meeting, with the folder its page is in (the meeting's own shape doesn't carry it).
const row = async (k) => {
  const m = ok(await api("GET", `/api/v1/meetings/${M[k].id}`, T.owner), `meeting ${k}`);
  const items = ok(await api("GET", `/api/v1/workspaces/${WS}/items?folder=all&limit=100`, T.owner), "items").items;
  const it = items.find((i) => i.slug === M[k].slug);
  return { ...m, folder_id: it?.folder_id || it?.folder?.id || null };
};

await step("series", async () => {
  const [a, b, s] = [await row("syncA"), await row("syncB"), await row("standup")];
  if (!a.series || a.series !== b.series) fail(`one series for both spellings: ${a.series} / ${b.series}`);
  if (!a.folder_id || a.folder_id !== b.folder_id) fail(`both spellings in one folder: ${a.folder_id} / ${b.folder_id}`);
  if (s.folder_id === a.folder_id) fail("Daily Standup filed with Daily Syncup");
  if (s.series) fail(`Daily Standup joined a series: ${s.series}`);
});

await step("covers", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  const srcOf = async (slug) => {
    await p.goto(`${APP}/${slug}`);
    const img = p.locator(".pb-cover-img__img, .pb-cover-img img").first();
    await img.waitFor({ timeout: 30000 });
    return (await img.getAttribute("src")) || "";
  };
  const a = await srcOf(M.syncA.slug), b = await srcOf(M.syncB.slug), k = await srcOf(M.kickoff.slug);
  if (!/page-covers/.test(a)) fail(`not a gallery cover: ${a}`);
  if (a !== b) fail(`one cover per series: ${a} vs ${b}`);
  if (a === k) fail("a one-off has the series' cover");
  await snap(p, "cover");
});

await step("one-item", async () => {
  const a = await row("syncA");
  const items = ok(await api("GET", `/api/v1/workspaces/${WS}/items?folder=${a.folder_id}`, T.owner), "items").items.map((i) => i.slug);
  if (items.length !== 2 || items.includes(M.syncA.transcript_slug)) fail(`one row per meeting: ${JSON.stringify(items)}`);
  const all = ok(await api("GET", `/api/v1/workspaces/${WS}/items?folder=all&limit=100`, T.owner), "all items").items.map((i) => i.slug);
  for (const k of Object.keys(M)) if (all.includes(M[k].transcript_slug)) fail(`transcript listed: ${k}`);
  const kids = ok(await api("GET", `/api/v1/documents/${M.syncA.slug}/children`, T.owner), "children");
  if (!kids.some((c) => c.slug === M.syncA.transcript_slug)) fail("the transcript is still the page's child");
  // The folder's List view: the meeting, not its transcript.
  const { c, p } = await ctx(browser, { token: T.owner });
  await c.addInitScript(() => { try { localStorage.setItem("md_ws_view", "list"); } catch { /* */ } });
  await p.goto(`${APP}/w/${WS}/f/${a.folder_id}?view=list`);
  await p.locator(`#main a[href*="${M.syncA.slug}"]`).first().waitFor({ timeout: 30000 });
  if (await p.locator(`#main a[href*="${M.syncA.transcript_slug}"]`).count()) fail("the List view shows the transcript");
  await snap(p, "one-item-list");
  // Search: a word only said in the call (the transcript) finds the meeting page.
  let found = [];
  for (let i = 0; i < 20 && !found.includes(M.syncB.slug); i++) {
    found = ok(await api("GET", "/api/v1/search?q=quokkabell", T.owner), "search").items.map((x) => x.slug);
    if (!found.includes(M.syncB.slug)) await p.waitForTimeout(1000);
  }
  if (!found.includes(M.syncB.slug)) fail(`search didn't find the meeting: ${JSON.stringify(found)}`);
  if (found.includes(M.syncB.transcript_slug)) fail("search lists the transcript");
});

await step("organize", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(HUB);
  await p.getByTestId("organize-meetings").click();
  await p.getByRole("dialog").getByRole("button", { name: "Organize" }).click();
  await p.getByText(/(\d+ of )?4 meetings?( filed in \d+ folders?)?.*1 series|already in its folder \(4 meetings · 1 series\)/).first().waitFor({ timeout: 30000 });
  await snap(p, "organized");
  const a = await row("syncA");
  const folder = ok(await api("GET", `/api/v1/workspaces/${WS}/tree`, T.owner), "tree").folders.find((f) => f.id === a.folder_id);
  if (!folder || folder.name !== a.series) fail(`series folder: ${JSON.stringify(folder)}`);
});

await step("sort", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(HUB);
  const titles = async () => p.getByTestId("meeting-card").locator(".mt-card__title").allInnerTexts();
  await p.getByTestId("meeting-card").first().waitFor({ timeout: 30000 });
  const first = async () => ((await titles())[0] || "").trim();
  if (!(await first()).startsWith("Daily Standup")) fail(`default: newest meeting first, got ${await titles()}`);
  await p.getByTestId("meetings-sort").selectOption("date_asc");
  if (!(await first()).startsWith("Kickoff")) fail(`oldest first: ${await titles()}`);
  await p.reload();
  await p.getByTestId("meeting-card").first().waitFor({ timeout: 30000 });
  if ((await p.getByTestId("meetings-sort").inputValue()) !== "date_asc") fail("the sort isn't remembered");
  if (!(await first()).startsWith("Kickoff")) fail(`remembered order: ${await titles()}`);
  await p.getByTestId("meetings-sort").selectOption("title");
  const t = (await titles()).map((x) => x.trim());
  const sorted = [...t].sort((x, y) => x.localeCompare(y, undefined, { sensitivity: "base" }));
  if (JSON.stringify(t) !== JSON.stringify(sorted)) fail(`by title: ${t}`);
  await snap(p, "sorted");
  await p.getByTestId("meetings-sort").selectOption("date_desc");
  // A series folder opens on its table, sorted by Date: one row per meeting.
  const a = await row("syncA");
  await p.goto(`${APP}/w/${WS}/f/${a.folder_id}`);
  const th = p.locator("th", { hasText: "Date" }).first();
  await th.waitFor({ timeout: 30000 });
  if (!(await th.locator(".pp-th__sort").count())) fail("the Date column isn't the sort");
  const rows = await p.locator("table tbody tr:not(.pp-group):not(.pp-newrow)").count();
  if (rows !== 2) fail(`table rows: ${rows} (one per meeting)`);
  await snap(p, "series-table");
});

console.log("\nRESULTS", BROWSER);
for (const [n, st, ms] of results) console.log(`  ${st === "ok" ? "✓" : "✗"} ${n} ${st === "ok" ? "" : st} (${(ms / 1000).toFixed(1)} s)`);
await browser.close();
process.exit(results.some(([, st]) => st !== "ok") ? 1 : 0);
