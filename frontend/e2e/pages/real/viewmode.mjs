/**
 * Pages: View mode first, Edit on demand (owner decision 2026-11-05), on the real stack (up.sh).
 *   view      the owner opens a page: the reading view (no editor, no caret), Edit in the bar; a link and a
 *             page mention open their page on a click
 *   keys      E opens the editor (not while typing in a field); typing saves; Done saves, lets go of the
 *             lock and comes back to reading with the new text
 *   flows     ?edit=1 opens straight in the editor (Done drops it from the address); an empty page opens
 *             in the editor; a page made from a template (New page) opens in the editor
 *   tick      in View mode an editor ticks a checklist box and it saves; a reader's boxes don't tick
 *   reader    a workspace viewer gets no Edit (and E does nothing)
 *   tenant    a member on the workspace's own domain: View mode, Edit, type, Done
 *   phone     390 px, touch: Edit and Done are 44 px targets in the bar
 * Uses the existing seed (never reseeds; run real.mjs first) and makes its own pages.
 *
 *   [BROWSER=webkit] [ONLY=view,keys] node viewmode.mjs
 */
import { APP, TENANT, log, fail, seedNow, api, docOf, launch, ctx, stepper, shot, waitSaved, editPage, donePage } from "./lib.mjs";

const S = seedNow();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const browser = await launch();
const { step, results } = stepper(browser);
const run = Date.now().toString(36).slice(-5);

async function newPage(title, content, extra = {}) {
  const r = await api("POST", "/api/v1/pages", T.owner, { title, workspace: WS, folder: S.folder, content, auto_cover: false, ...extra });
  if (r.status >= 300) fail(`create ${title} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body.document.slug;
}
const content = async (slug) => (await docOf(slug, T.owner)).content;
async function until(fn, what, timeout = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) fail(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}
/** The reading view is on screen: the page, the bar's Edit, and no editor. */
async function inView(p, timeout = 30000) {
  await p.locator('[data-page-mode="edit"]').first().waitFor({ timeout });
  await p.locator(".pb-page").first().waitFor({ timeout });
  if (await p.locator(".pb-live").count()) fail("the editor is on screen in View mode");
  if (await p.locator('.ProseMirror[contenteditable="true"]').count()) fail("an editable ProseMirror in View mode");
}

const target = await newPage(`View target ${run}`, "The target page.\n");
const linkMd = (t) => `Intro line.\n\nSee [the target page](/${t}) for more.\n\nOr the mention :markdrop[Target]{src="${t}"} inline.\n\n- [ ] Ship it\n- [x] Plan it\n`;

/* ── 1. the owner opens a page: reading view, links open ── */
await step("view", async () => {
  const slug = await newPage(`View mode ${run}`, linkMd(target));
  for (const theme of ["light", "dark"]) {
    const { c, p } = await ctx(browser, { token: T.owner, theme });
    await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
    await inView(p);
    await p.waitForTimeout(2500); // the editor's code prefetch must not mount it
    if (await p.locator(".pb-live, .pb-preload").count()) fail("the editor mounted in View mode");
    await shot(p, `vm-01-owner-view-${theme}`);
    await c.close();
  }
  const { c, p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  await inView(p);
  await p.locator(".pb-page a", { hasText: "the target page" }).first().click();
  await p.waitForURL((u) => u.pathname.endsWith(`/${target}`), { timeout: 20000, waitUntil: "commit" });
  await p.getByText("The target page.").first().waitFor({ timeout: 20000 });
  await p.goBack({ waitUntil: "networkidle" });
  await inView(p);
  // A page mention is a plain link in View mode (to the item's own address: here the workspace's
  // domain, which this stack doesn't serve, so the address is checked rather than followed).
  const mention = p.locator(".pb-page a.pb-mention").first();
  const href = await mention.getAttribute("href", { timeout: 20000 });
  if (!href || !href.endsWith(`/${target}`)) fail(`the mention links to ${href}`);
  if (await p.locator(".pb-page .pb-mention[contenteditable], .pb-page [contenteditable=true]").count()) fail("something is editable in View mode");
  await c.close();
});

/* ── 2. E and Edit / Done ── */
await step("keys", async () => {
  const slug = await newPage(`Keys ${run}`, "First line.\n");
  const { c, p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  await inView(p);
  // Shift+E, Ctrl+E: nothing.
  await p.keyboard.press("Shift+E");
  await p.waitForTimeout(800);
  if (await p.locator(".pb-live, .pb-preload").count()) fail("Shift+E opened the editor");
  await p.keyboard.press("e");
  await p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 30000 });
  // Done takes the focus where Edit was.
  await until(() => p.evaluate(() => document.activeElement?.getAttribute("data-page-mode") === "done"), "focus on Done", 5000);
  await shot(p, "vm-02-editing");
  // Typing "e" in the editor types it.
  await p.locator(".pb-live .ProseMirror").getByText("First line.").click();
  await p.waitForTimeout(250);
  await p.keyboard.press("End");
  const typed = ` Added ${run} here.`;
  await p.keyboard.type(typed);
  // Done straight after typing: what's pending is saved first.
  await donePage(p);
  await inView(p);
  await p.locator(".pb-page").getByText(`Added ${run} here.`).waitFor({ timeout: 10000 });
  if (!(await content(slug)).includes(`Added ${run} here.`)) fail("Done didn't save what was typed");
  await until(() => p.evaluate(() => document.activeElement?.getAttribute("data-page-mode") === "edit"), "focus on Edit", 5000);
  // The lock is let go: someone else can take it at once.
  const lock = await api("POST", `/api/v1/documents/${slug}/lock`, T.admin);
  if (lock.status !== 200) fail(`the lock outlived Done → ${lock.status} ${JSON.stringify(lock.body)}`);
  await api("DELETE", `/api/v1/documents/${slug}/lock`, T.admin);
  await shot(p, "vm-03-after-done");
  // The Edit button does the same as E.
  await editPage(p);
  await donePage(p);
  await c.close();
});

/* ── 3. straight into Edit: ?edit=1, an empty page, a new page from a template ── */
await step("flows", async () => {
  const slug = await newPage(`Flag ${run}`, "Some text.\n");
  let { c, p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/${slug}?edit=1`, { waitUntil: "networkidle" });
  await p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 30000 });
  await donePage(p);
  if (new URL(p.url()).searchParams.get("edit")) fail(`Done kept ?edit=1: ${p.url()}`);
  await c.close();

  const empty = await newPage(`Empty ${run}`, "");
  ({ c, p } = await ctx(browser, { token: T.owner }));
  await p.goto(`${APP}/${empty}`, { waitUntil: "networkidle" });
  await p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 30000 });
  await shot(p, "vm-04-empty-opens-in-edit");
  await c.close();

  ({ c, p } = await ctx(browser, { token: T.owner }));
  await p.goto(`${APP}/w/${WS}/f/${S.folder}`, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "New page" }).first().click({ timeout: 30000 });
  await p.getByRole("dialog").getByText("Meeting notes", { exact: true }).first().click();
  await p.getByRole("dialog").getByLabel("Title").fill(`From template ${run}`);
  await p.getByRole("dialog").getByRole("button", { name: "Create page" }).click();
  await p.waitForURL(/\?edit=1/, { timeout: 30000 });
  await p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 30000 });
  await shot(p, "vm-05-template-opens-in-edit");
  await c.close();
});

/* ── 4. a checklist ticks in View mode for editors (and saves); a reader's doesn't ── */
await step("tick", async () => {
  const slug = await newPage(`Tick ${run}`, linkMd(target));
  const { c, p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  await inView(p);
  const box = p.locator(".pb-page li", { hasText: "Ship it" }).locator("input[type=checkbox]");
  if (await box.isChecked()) fail("Ship it starts ticked");
  await box.click({ force: true });
  await until(async () => /- \[x\] Ship it/.test(await content(slug)), "the tick saved");
  if (!(await box.isChecked())) fail("the box isn't ticked on screen");
  // Untick the other one.
  await p.locator(".pb-page li", { hasText: "Plan it" }).locator("input[type=checkbox]").click({ force: true });
  await until(async () => /- \[ \] Plan it/.test(await content(slug)), "the untick saved");
  const md = await content(slug);
  if (!md.includes("Intro line.") || !md.includes(`:markdrop[Target]{src="${target}"}`)) fail(`a tick changed more than the box:\n${md}`);
  await shot(p, "vm-06-ticked-in-view");
  // Someone else editing: the tick is refused and the box goes back.
  const held = await api("POST", `/api/v1/documents/${slug}/lock`, T.member);
  if (held.status !== 200) fail(`member lock → ${held.status}`);
  const before = await content(slug);
  await box.click({ force: true });
  await p.getByText(/is editing this page|Someone else is editing/).first().waitFor({ timeout: 10000 });
  await p.waitForTimeout(500);
  if (!(await box.isChecked())) fail("a refused untick left the box unticked");
  if ((await content(slug)) !== before) fail("a refused tick changed the page");
  await api("DELETE", `/api/v1/documents/${slug}/lock`, T.member);
  await c.close();
  // A reader: the boxes are read only.
  const r = await ctx(browser, { token: T.reader });
  await r.p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  await r.p.locator(".pb-page").first().waitFor({ timeout: 30000 });
  const rb = r.p.locator(".pb-page li", { hasText: "Ship it" }).locator("input[type=checkbox]");
  if (!(await rb.isDisabled())) fail("a reader's checkbox isn't disabled");
  await r.c.close();
});

/* ── 5. a reader: no Edit, E does nothing ── */
await step("reader", async () => {
  const slug = await newPage(`Reader ${run}`, "For readers.\n");
  const { c, p } = await ctx(browser, { token: T.reader });
  await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  await p.getByText("For readers.").first().waitFor({ timeout: 30000 });
  await p.waitForTimeout(1500);
  if (await p.locator('[data-page-mode]').count()) fail("a reader has Edit");
  await p.keyboard.press("e");
  await p.waitForTimeout(1500);
  if (await p.locator(".pb-live, .pb-preload").count()) fail("E opened an editor for a reader");
  await c.close();
});

/* ── 6. the workspace's own domain ── */
await step("tenant", async () => {
  const slug = await newPage(`Domain view ${run}`, "On the domain.\n");
  const d = await docOf(slug, T.owner);
  const addr = `${TENANT}/${[...(d.folder_path || []), slug].join("/")}`;
  const { c, p } = await ctx(browser, { token: T.member });
  await fetch(`${APP}/api/revalidate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: "host:acme.localhost" }) });
  await p.goto(`${APP}/robots.txt`);
  await p.goto(addr, { waitUntil: "networkidle" });
  const signIn = p.getByRole("button", { name: /Sign in to read/ }).or(p.getByRole("link", { name: /Sign in to read/ }))
    .or(p.getByRole("link", { name: /^Sign in$/ })).or(p.getByRole("button", { name: /^Sign in$/ }));
  // Signed in on markdrop.in: the domain may sign in on its own (a silent handoff).
  await p.locator('[data-page-mode="edit"]').or(signIn).first().waitFor({ timeout: 30000 });
  if (!(await p.locator('[data-page-mode="edit"]').count())) {
    await signIn.first().click({ timeout: 20000 });
    await p.waitForURL((u) => u.hostname === "acme.localhost" && !u.hash.includes("mdt="), { timeout: 30000 }).catch(() => {});
    await p.waitForLoadState("networkidle");
  }
  await inView(p);
  await shot(p, "vm-07-tenant-view");
  await editPage(p);
  await p.locator(".pb-live .ProseMirror").getByText("On the domain.").click();
  await p.waitForTimeout(250);
  await p.keyboard.press("End");
  await p.keyboard.type(` Domain edit ${run}.`);
  await waitSaved(p);
  await donePage(p);
  await inView(p);
  await p.locator(".pb-page").getByText(`Domain edit ${run}.`).waitFor({ timeout: 10000 });
  if (!(await content(slug)).includes(`Domain edit ${run}.`)) fail("the domain edit didn't save");
  await shot(p, "vm-08-tenant-after-done");
  await c.close();
});

/* ── 7. phones: Edit and Done are 44 px targets ── */
await step("phone", async () => {
  const slug = await newPage(`Phone view ${run}`, "On a phone.\n");
  for (const theme of ["light", "dark"]) {
    const { c, p } = await ctx(browser, { token: T.owner, theme, width: 390, height: 844, mobile: true });
    await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
    await inView(p);
    const eb = await p.locator('[data-page-mode="edit"]').first().boundingBox();
    if (!eb || eb.width < 44 || eb.height < 44) fail(`Edit is ${eb?.width}×${eb?.height} on a phone`);
    await shot(p, `vm-09-phone-view-${theme}`);
    await p.locator('[data-page-mode="edit"]').first().tap();
    await p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 30000 });
    const db = await p.locator('[data-page-mode="done"]').first().boundingBox();
    if (!db || db.width < 44 || db.height < 44) fail(`Done is ${db?.width}×${db?.height} on a phone`);
    await shot(p, `vm-10-phone-edit-${theme}`);
    await p.locator('[data-page-mode="done"]').first().tap();
    await inView(p);
    await c.close();
  }
});

await browser.close();
console.log("\nResults (view mode):");
for (const [n, r] of results) console.log(`  ${r === "ok" ? "✓" : "✗"} ${n}: ${r}`);
log("done");
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
