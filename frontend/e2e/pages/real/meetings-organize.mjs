/**
 * Meetings release requests (2026-11-05) on the REAL stack (up.sh, with PB_FAKE_MEETINGS_AI=1):
 *   covers      every meeting page has a gallery cover; one per series (both spellings of a series share
 *               it), a one-off has the generic one
 *   one-item    a meeting is one item: its Transcript is not a row of the folder's List view, the items
 *               API or search (a word only in the transcript finds the meeting page); still the page's child
 *   series      "Daily Syncup" and "Daily Sync Up" are one series folder; "Daily Standup" is not merged
 *   organize    Organize meetings (admin): the ⋯ menu → the dialog's preview → Organize → the summary
 *   menu        the hub's ⋯ menu: icons + labels + descriptions, inside the viewport, keyboard (Enter, arrows,
 *               Escape back to the trigger); a bottom sheet with 44px rows on a phone
 *   many        ≥80 meetings as a cut-off run left them (in the Meetings folder itself, no series, a duplicate
 *               empty series folder): Organize is a background job — no request takes 10 s, the dialog shows
 *               "Organizing N of M…", then the summary; every meeting lands in its series' folder, no duplicates
 *   sort        the hub's sort: meeting date newest (default) / oldest / title / recently imported,
 *               remembered after a reload; a series folder opens on its table sorted by Date
 *
 *   PB_FAKE_MEETINGS_AI=1 PB_STACK_ID=49 PB_WORK=… BROWSER=chromium|webkit [ONLY=covers,sort] node meetings-organize.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { APP, BROWSER, WORK, STACK_ID, log, fail, reseed, seedNow, api, launch, ctx, stepper } from "./lib.mjs";

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
  await p.getByTestId("meetings-more").click();
  await p.getByRole("menuitem", { name: /Organize meetings/ }).click();
  const dlg = p.getByTestId("organize-dialog");
  await dlg.getByText("in Other meetings").waitFor({ timeout: 30000 });
  await snap(p, "organize-preview");
  await p.getByTestId("organize-start").click();
  const sum = p.getByTestId("organize-summary");
  await sum.waitFor({ timeout: 60000 });
  if (!/\b4 meetings?\b|of 4\b/.test(await sum.innerText())) fail(`summary: ${await sum.innerText()}`);
  await snap(p, "organized");
  await p.getByTestId("organize-done").click();
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

/** Mongo, directly (the stack's own database). */
const ROOT_PY = path.join(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../..").split("/.claude/worktrees/")[0], "backend", ".venv", "bin", "python");
function mongo(js) {
  const py = ROOT_PY;
  const code = `import json,sys\nfrom datetime import datetime,timezone,timedelta\nfrom bson import ObjectId\nfrom pymongo import MongoClient\ndb=MongoClient("mongodb://127.0.0.1:27019")["markdrop_docs_demo_${STACK_ID}"]\n${js}`;
  return execFileSync(py, ["-c", code], { encoding: "utf8" }).trim();
}

await step("menu", async () => {
  // Desktop: a proper menu — icons, labels, descriptions — inside the viewport, and keyboard driven.
  const { p } = await ctx(browser, { token: T.owner, width: 1280, height: 800 });
  await p.goto(HUB);
  await p.getByTestId("meeting-card").first().waitFor({ timeout: 30000 });
  const trig = p.getByTestId("meetings-more");
  await trig.focus();
  await p.keyboard.press("Enter");
  const menu = p.getByRole("menu");
  await menu.waitFor({ timeout: 10000 });
  const items = menu.getByRole("menuitem");
  const n = await items.count();
  if (n < 2) fail(`menu items: ${n}`);
  const box = await menu.boundingBox();
  if (!box || box.x < 0 || box.y < 0 || box.x + box.width > 1280 || box.y + box.height > 800) fail(`menu clipped: ${JSON.stringify(box)}`);
  if (box.width < 280) fail(`menu too narrow: ${box.width}`);
  for (let i = 0; i < n; i++) {
    const it = items.nth(i);
    if (!(await it.locator("svg").count())) fail(`menu item ${i} has no icon`);
    const h = (await it.boundingBox()).height;
    if (h < 32) fail(`menu item ${i} is ${h}px tall`);
  }
  const focused = await p.evaluate(() => document.activeElement?.getAttribute("role"));
  if (focused !== "menuitem") fail(`Enter didn't focus the first item (${focused})`);
  await p.keyboard.press("ArrowDown");
  await snap(p, "menu-desk");
  await p.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden", timeout: 5000 });
  if (!(await p.evaluate(() => document.activeElement?.getAttribute("data-testid") === "meetings-more"))) fail("Escape didn't return focus to ⋯");
  // Phone: a bottom sheet, rows of at least 44px, nothing cut off.
  const ph = await ctx(browser, { token: T.owner, width: 390, height: 844, mobile: true });
  await ph.p.goto(HUB);
  await ph.p.getByTestId("meeting-card").first().waitFor({ timeout: 30000 });
  await ph.p.getByTestId("meetings-more").click();
  const sheet = ph.p.getByRole("menu");
  await sheet.waitFor({ timeout: 10000 });
  const rows = sheet.getByRole("menuitem");
  for (let i = 0; i < (await rows.count()); i++) {
    const b = await rows.nth(i).boundingBox();
    if (b.height < 44) fail(`phone row ${i} is ${b.height}px`);
    if (b.y + b.height > 844 || b.x < 0 || b.x + b.width > 390) fail(`phone row ${i} off screen: ${JSON.stringify(b)}`);
  }
  if (!(await rows.filter({ hasText: "Import past meetings" }).count())) fail("the phone menu lacks Import past meetings (its button is hidden there)");
  await snap(ph.p, "menu-phone");
});

await step("many", async () => {
  const N = 80;
  const titles = [];
  const series = ["Daily Sync Up", "Weekly ops review", "Design crit", "Sales pipeline"];
  for (let i = 0; i < N; i++) {
    const t = i < 60 ? series[i % 4] : `One-off ${["alpha", "beta", "gamma", "delta", "epsilon"][i % 5]} ${i}`;
    const r = await api("POST", "/api/v1/meetings/import", T.owner, {
      workspace: WS, wait: true, title: t, date: day(2 + Math.floor(i / 4) + (i >= 60 ? 30 : 0)),
      sources: [{ name: `${t} ${i}.txt`, text: talk(`w${i}x`) }],
    });
    ok(r, `import ${i}`);
    titles.push({ id: r.body.meetings[0].id, series: i < 60 ? series[i % 4] : null });
  }
  log(`${N} meetings imported`);
  // As before folders, after a cut-off run: all in the Meetings folder itself, no series; a duplicate
  // empty "Design crit" folder made by an overlapping run.
  const out = mongo(`
ws = ${JSON.stringify(WS)}
root = db["folders"].find_one({"workspace_id": ws, "meetings": True}, sort=[("created_at", 1)])
ids = [ObjectId(x) for x in ${JSON.stringify(titles.map((x) => x.id))}]
n = 0
for r in db["meetings"].find({"_id": {"$in": ids}}):
    db["meetings"].update_one({"_id": r["_id"]}, {"$set": {"series": None, "series_from": None, "folder_id": str(root["_id"])}, "$unset": {"organize_run": ""}})
    for d in (r.get("doc_id"), r.get("transcript_doc_id")):
        if d: db["documents"].update_one({"_id": d}, {"$set": {"folder_id": str(root["_id"]), "folder_path": [root.get("slug") or str(root["_id"])]}})
    n += 1
sub = db["folders"].find_one({"workspace_id": ws, "parent_id": str(root["_id"]), "meetings_series": "design crit"})
if sub:
    db["folders"].insert_one({"workspace_id": ws, "parent_id": str(root["_id"]), "name": "Design crit", "slug": "design-crit-2",
        "meetings_sub": True, "meetings_series": "design crit", "meetings_views": True, "properties": root.get("properties") or [],
        "created_at": sub["created_at"] + timedelta(seconds=1), "updated_at": datetime.now(timezone.utc)})
print(json.dumps({"moved": n, "root": str(root["_id"])}))`);
  const root = JSON.parse(out).root;
  log("unorganized", out);
  const { p } = await ctx(browser, { token: T.owner });
  // Every API request this page makes: none may take 10 s (the old Organize took > 60 s and nginx cut it).
  const started = new Map();
  const slow = [];
  p.on("request", (r) => started.set(r, Date.now()));
  p.on("requestfinished", (r) => { const t0 = started.get(r); if (t0 && Date.now() - t0 > 10000 && /\/api\/v1\//.test(r.url())) slow.push(`${r.method()} ${r.url()} ${Date.now() - t0} ms`); });
  p.on("requestfailed", (r) => { if (/\/api\/v1\/meetings\/organize/.test(r.url())) slow.push(`FAILED ${r.method()} ${r.url()}`); });
  await p.goto(HUB);
  await p.getByTestId("meeting-card").first().waitFor({ timeout: 30000 });
  await p.getByTestId("meetings-more").click();
  await p.getByRole("menuitem", { name: /Organize meetings/ }).click();
  const dlg = p.getByTestId("organize-dialog");
  await dlg.getByText(/\b8\d meetings\b/).first().waitFor({ timeout: 30000 });
  await snap(p, "many-preview");
  const t0 = Date.now();
  await p.getByTestId("organize-start").click();
  await p.getByTestId("organize-progress").waitFor({ timeout: 10000 });
  let sawCount = false;
  for (let i = 0; i < 600 && !(await p.getByTestId("organize-summary").count()); i++) {
    const txt = await p.getByTestId("organize-dialog").innerText().catch(() => "");
    if (/Organizing \d+ of \d+ meetings/.test(txt)) { if (!sawCount) await snap(p, "many-progress"); sawCount = true; }
    await p.waitForTimeout(200);
  }
  const sum = p.getByTestId("organize-summary");
  await sum.waitFor({ timeout: 120000 });
  log(`organized in ${((Date.now() - t0) / 1000).toFixed(1)} s; saw "Organizing N of M": ${sawCount}`);
  await snap(p, "many-summary");
  if (slow.length) fail(`slow or failed requests: ${slow.join("; ")}`);
  // The final layout: each meeting in its series' folder (or Other meetings), one folder per name.
  const tree = ok(await api("GET", `/api/v1/workspaces/${WS}/tree`, T.owner), "tree").folders;
  const subs = tree.filter((f) => (f.parent_id || f.parentId) === root);
  const names = subs.map((f) => f.name);
  if (new Set(names).size !== names.length) fail(`duplicate folders: ${names}`);
  const byId = Object.fromEntries(tree.map((f) => [f.id, f.name]));
  const rows = JSON.parse(mongo(`print(json.dumps({str(r["_id"]): r.get("folder_id") for r in db["meetings"].find({"_id": {"$in": [ObjectId(x) for x in ${JSON.stringify(titles.map((x) => x.id))}]}})}))`));
  for (const t of titles) {
    const want = t.series || "Other meetings";
    if (byId[rows[t.id]] !== want) fail(`${t.id} in ${byId[rows[t.id]]}, want ${want}`);
  }
  await p.getByTestId("organize-done").click();
  await p.getByTestId("meeting-card").first().waitFor({ timeout: 30000 });
});

console.log("\nRESULTS", BROWSER);
for (const [n, st, ms] of results) console.log(`  ${st === "ok" ? "✓" : "✗"} ${n} ${st === "ok" ? "" : st} (${(ms / 1000).toFixed(1)} s)`);
await browser.close();
process.exit(results.some(([, st]) => st !== "ok") ? 1 : 0);
