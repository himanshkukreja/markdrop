/**
 * Senseloaf P2 smoke on the real stack (up.sh): the four features of the P2 release, end to end.
 *   notify    a mention on a page notifies the person: their bell's unread count goes up, the bell lists the page
 *   signoff   a sign-off block naming Ben: Ben signs it from the page; it records Ben, and Ada can't sign it
 *   board     a folder with a Status select: its Board view groups the pages by Status
 *   cover     a new page gets an automatic cover (the stack has no AI key: the keyword fallback), shown in the editor
 * Uses the existing seed (never reseeds; run real.mjs first) and makes its own pages and folder.
 *
 *   [BROWSER=webkit] [ONLY=notify,cover] node p2.mjs
 */
import { APP, log, fail, seedNow, api, docOf, launch, ctx, stepper, shot } from "./lib.mjs";

const S = seedNow();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const ID = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.id]));
const WS = S.ws;
const browser = await launch();
const { step, results } = stepper(browser);
const run = Date.now().toString(36).slice(-5);

async function newPage(title, content, extra = {}) {
  const r = await api("POST", "/api/v1/pages", T.owner, { title, workspace: WS, folder: S.folder, content, ...extra });
  if (r.status >= 300) fail(`create ${title} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body.document.slug;
}
const unread = async (who) => {
  const r = await api("GET", "/api/v1/notifications/unread-count", T[who]);
  if (r.status !== 200) fail(`unread-count → ${r.status}`);
  return r.body.unread_count;
};
async function until(fn, what, timeout = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) fail(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

/* ── 1. a mention notifies: Ben's bell count goes up and lists the page ── */
await step("notify", async () => {
  const title = `Launch checklist ${run}`;
  const slug = await newPage(title, "Draft.\n", { auto_cover: false });
  const before = await unread("member");
  const d = await docOf(slug, T.owner);
  const md = `${d.content.trimEnd()}\n\nCan you check the rollout, :person[Ben Member]{id="${ID.member}"}? {#b-p2men01}\n`;
  const put = await api("PUT", `/api/v1/documents/${slug}`, T.owner, { title, content: md, base_rev: d.rev });
  if (put.status !== 200) fail(`save with a mention → ${put.status} ${JSON.stringify(put.body).slice(0, 200)}`);
  const after = await until(async () => { const n = await unread("member"); return n > before ? n : 0; }, "Ben's unread count");
  if (after !== before + 1) fail(`unread ${before} → ${after} (want +1)`);
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
  const bell = p.getByRole("button", { name: new RegExp(`^Notifications, ${after} unread$`) });
  await bell.waitFor({ timeout: 20000 });
  await bell.click();
  await p.getByText(title).first().waitFor({ timeout: 10000 });
  await shot(p, "p2-01-bell");
  // The mentioner isn't notified of their own mention.
  const mine = await api("GET", "/api/v1/notifications?limit=50", T.owner);
  if (JSON.stringify(mine.body).includes(slug)) fail("Ada was notified of her own mention");
});

/* ── 2. a sign-off block signs as the named person ── */
await step("signoff", async () => {
  const label = `Launch approval ${run}`;
  const slug = await newPage(`Sign-off ${run}`, `The plan.\n\n:::signoff{#b-p2sig01 person="${ID.member}" label="${label}" options="Approved|Not approved"}\nQA passed on staging.\n:::\n`, { auto_cover: false });
  // Ada (the owner) isn't the named person: no buttons for her, and the API refuses her.
  const a = await ctx(browser, { token: T.owner });
  await a.p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  await a.p.locator(".pb-signoff").first().waitFor({ timeout: 20000 });
  if (await a.p.getByRole("group", { name: `Sign off: ${label}` }).count()) fail("the owner sees sign buttons");
  await a.c.close();
  const refused = await api("POST", `/api/v1/documents/${slug}/signoffs/b-p2sig01`, T.owner, { option: "Approved" });
  if (refused.status < 400) fail(`the owner signed someone else's sign-off → ${refused.status}`);
  // Ben signs from the page.
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  const group = p.getByRole("group", { name: `Sign off: ${label}` });
  await group.waitFor({ timeout: 20000 });
  await group.getByRole("button", { name: "Approved", exact: true }).click();
  await p.locator(".pb-signoff").getByText(/signed off/).first().waitFor({ timeout: 10000 });
  await shot(p, "p2-02-signed");
  const r = await api("GET", `/api/v1/documents/${slug}/signoffs`, T.owner);
  const s = (r.body.signoffs || []).find((x) => x.block === "b-p2sig01");
  if (!s) fail(`no sign-off in ${JSON.stringify(r.body).slice(0, 300)}`);
  if (s.option !== "Approved" || s.signed_by?.id !== ID.member) fail(`signed as ${JSON.stringify(s.signed_by)} with ${s.option}`);
  log("signed by", s.signed_by.name, s.option);
});

/* ── 3. a folder's Board view groups by Status ── */
await step("board", async () => {
  const f = await api("POST", `/api/v1/workspaces/${WS}/folders`, T.owner, { name: `Roadmap ${run}` });
  if (f.status >= 300) fail(`folder → ${f.status} ${JSON.stringify(f.body).slice(0, 200)}`);
  const folder = f.body.id ?? f.body.folder?.id;
  const schema = await api("PUT", `/api/v1/workspaces/${WS}/folders/${folder}/properties`, T.owner, {
    properties: [{ key: "status", name: "Status", type: "select", options: [{ name: "Planned", color: "gray" }, { name: "In build", color: "blue" }, { name: "Shipped", color: "green" }] }],
  });
  if (schema.status !== 200) fail(`schema → ${schema.status} ${JSON.stringify(schema.body).slice(0, 300)}`);
  const want = { "Search v2": "In build", "Bulk export": "In build", "SSO": "Shipped" };
  for (const [title, status] of Object.entries(want)) {
    const r = await api("POST", "/api/v1/pages", T.owner, { title, workspace: WS, folder, auto_cover: false });
    if (r.status >= 300) fail(`page ${title} → ${r.status}`);
    const v = await api("PATCH", `/api/v1/documents/${r.body.document.slug}/properties`, T.owner, { values: { status } });
    if (v.status !== 200) fail(`values ${title} → ${v.status} ${JSON.stringify(v.body).slice(0, 300)}`);
  }
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/w/${WS}/f/${folder}?view=board`, { waitUntil: "networkidle" });
  const board = p.getByRole("list", { name: "Pages by Status" });
  await board.waitFor({ timeout: 30000 });
  await board.getByRole("listitem", { name: "In build: 2 pages" }).waitFor({ timeout: 10000 });
  await board.getByRole("listitem", { name: "Shipped: 1 page" }).waitFor({ timeout: 10000 });
  const col = board.getByRole("listitem", { name: "In build: 2 pages" });
  for (const t of ["Search v2", "Bulk export"]) if (!(await col.getByText(t).count())) fail(`${t} isn't under In build`);
  if (!(await board.getByRole("listitem", { name: "Shipped: 1 page" }).getByText("SSO").count())) fail("SSO isn't under Shipped");
  await shot(p, "p2-03-board");
});

/* ── 3b. with no Select yet, the Board still shows the folder's pages (one "All pages" column) ── */
await step("board-no-select", async () => {
  const f = await api("POST", `/api/v1/workspaces/${WS}/folders`, T.owner, { name: `Notes ${run}` });
  if (f.status >= 300) fail(`folder → ${f.status} ${JSON.stringify(f.body).slice(0, 200)}`);
  const folder = f.body.id ?? f.body.folder?.id;
  const r = await api("POST", "/api/v1/pages", T.owner, { title: `Kickoff notes ${run}`, workspace: WS, folder, auto_cover: false });
  if (r.status >= 300) fail(`page → ${r.status}`);
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/w/${WS}/f/${folder}?view=board`, { waitUntil: "networkidle" });
  const col = p.getByRole("list", { name: "Pages" }).getByRole("listitem", { name: "All pages: 1 page" });
  await col.waitFor({ timeout: 30000 });
  if (!(await col.getByText(`Kickoff notes ${run}`).count())) fail("the page isn't on the board");
  await p.getByRole("button", { name: "Add a Select property" }).waitFor({ timeout: 10000 });
  await shot(p, "p2-03b-board-no-select");
});

/* ── 4. a new page gets an automatic cover ── */
await step("cover", async () => {
  const slug = await newPage(`Security incident runbook ${run}`, "## On call\n\nRotate the keys, page the security lead, and write the incident report.\n");
  const st = await until(async () => {
    const r = await api("GET", `/api/v1/pages/${slug}/cover`, T.owner);
    return r.status === 200 && r.body.cover ? r.body : null;
  }, "the auto cover");
  if (!/^gallery:/.test(st.cover) || st.cover_auto !== true) fail(`cover ${JSON.stringify(st)}`);
  const d = await docOf(slug, T.owner);
  if (!d.content.includes(`cover: ${st.cover}`)) fail(`the cover isn't in the page: ${d.content.slice(0, 200)}`);
  log("auto cover", st.cover);
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/${slug}?edit=1`, { waitUntil: "networkidle" });
  await p.waitForFunction(() => (document.querySelector(".pb-cover-img__img")?.naturalWidth ?? 0) > 0, null, { timeout: 20000 });
  await shot(p, "p2-04-auto-cover");
  // A user's removal sticks: Remove, and it isn't picked again.
  const cur = await docOf(slug, T.owner);
  const bare = cur.content.replace(/^cover: .*\n/m, "").replace(/^---\n---\n/, "");
  const put = await api("PUT", `/api/v1/documents/${slug}`, T.owner, { title: cur.title, content: bare, base_rev: cur.rev });
  if (put.status !== 200) fail(`remove the cover → ${put.status}`);
  await new Promise((r) => setTimeout(r, 3000));
  const again = await api("GET", `/api/v1/pages/${slug}/cover`, T.owner);
  if (again.body.cover) fail(`a removed cover came back: ${again.body.cover}`);
});

await browser.close();
console.log("\nResults (P2 smoke):");
for (const [n, r, ms] of results) console.log(`  ${r === "ok" ? "✓" : "✗"} ${n}: ${r}${ms ? ` (${(ms / 1000).toFixed(1)} s)` : ""}`);
process.exit(results.every(([, r]) => r === "ok") ? 0 : 1);
