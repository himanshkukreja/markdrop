/**
 * The page builder's Playwright pass on the REAL stack (up.sh): the worktree's backend on the
 * test Mongo (fake R2 on disk), the real artifact Worker under Node, and a production build of the
 * frontend. Ported from mock/run.mjs, plus inherited access, move, delete with children, the edit
 * lock with MCP, a custom domain, page properties and a real bookmark.
 *
 * Pages are always editable: the owner and members land in the editor (no Done), and the edit lock
 * is taken on the first key or click. Reader checks run as Vic, a workspace viewer.
 *
 *   BROWSER=chromium|webkit [ONLY=create,member] node real.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { APP, TENANT, API, WORKER, SHOTS, BROWSER, log, fail, reseed, seedNow, mcpToken, api, mcp, docOf, launch, ctx, captureApi, shot, stepper, pngBytes, waitSaved } from "./lib.mjs";

const browser = await launch();
const { step, results } = stepper(browser);
const S = process.env.NO_RESEED ? seedNow() : reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const FOLDER = S.folder;
const statePath = path.join(SHOTS, "state.json");
const state = process.env.NO_RESEED && fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const SECRET_TITLES = ["Team offsite photo", "Q3 report", "Pricing calculator", "Launch plan"];
const content = async (slug) => (await docOf(slug, T.owner)).content;

/** Page images load lazily (WebKit only near the viewport): bring each into view first. */
async function scrollToImages(p) {
  for (const el of await p.locator(".pb-page img").all()) {
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await p.waitForTimeout(400);
  }
  await p.evaluate(() => window.scrollTo(0, 0));
}

async function slashPick(p, q) {
  await p.keyboard.type(`/${q}`);
  await p.locator(".dxe-slash").first().waitFor({ timeout: 5000 });
  await p.keyboard.press("Enter");
}

/* ── 1. create from a template in a folder; slash; mention; embeds; paste + drop images ── */
await step("create", async () => {
  let { c, p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/w/${WS}/f/${FOLDER}`, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "New page" }).first().waitFor({ timeout: 30000 });
  await shot(p, "01-folder-new-page");
  await p.getByRole("button", { name: "New page" }).first().click();
  await p.getByRole("dialog").getByText("Feature guide / release notes", { exact: true }).click();
  await p.getByRole("dialog").getByLabel("Title").fill("Page builder launch");
  await shot(p, "02-template-gallery", { wait: 800 });
  await p.getByRole("dialog").getByRole("button", { name: "Create page" }).click();
  await p.waitForURL(/\?edit=1/, { timeout: 30000 });
  state.slug = new URL(p.url()).pathname.split("/").pop();
  save();
  log("page", state.slug, p.url());
  const ed = p.locator(".pb-live .ProseMirror");
  await ed.waitFor({ timeout: 30000 });
  await p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 15000 });
  await p.waitForTimeout(1500);
  await ed.getByText("Announcement sent").click();
  await p.waitForTimeout(250); // ProseMirror reads a click's caret on the next selectionchange
  await p.keyboard.press("End");
  await p.keyboard.press("Enter");
  await p.keyboard.press("Enter");
  await p.keyboard.type("Read the plan first: ");
  await p.keyboard.type("/");
  await p.locator(".dxe-slash").first().waitFor();
  await shot(p, "04-slash-menu");
  await p.keyboard.type("mention");
  await p.keyboard.press("Enter");
  const dlg = p.getByRole("dialog");
  await dlg.waitFor();
  await dlg.getByRole("tab", { name: "Acme" }).click();
  await dlg.getByLabel("Search items").fill("launch");
  await dlg.getByText("Launch plan").first().waitFor();
  await shot(p, "05-mention-picker");
  await dlg.getByText("Launch plan").first().click();
  await dlg.waitFor({ state: "hidden" });
  await p.waitForTimeout(400);
  await p.keyboard.press("End");
  await p.keyboard.type(" — then check the numbers.");
  await p.keyboard.press("Enter");

  for (const [q, title, mode] of [["offsite", "Team offsite photo", "Live"], ["q3", "Q3 report", "Live"], ["pricing", "Pricing calculator", "Live"], ["launch", "Launch plan", "Card"]]) {
    await p.keyboard.type("/embed");
    await p.locator(".dxe-slash").first().waitFor();
    await p.keyboard.press("Enter");
    await dlg.waitFor();
    await dlg.getByRole("tab", { name: "Acme" }).click();
    await dlg.getByLabel("Search items").fill(q);
    await dlg.getByText(title).first().waitFor({ timeout: 15000 });
    if (title === "Q3 report") await shot(p, "06-embed-picker");
    await dlg.getByRole("radio", { name: mode }).click().catch(() => log("no mode radio", mode));
    await dlg.getByText(title).first().click();
    await dlg.waitFor({ state: "hidden" });
    await p.waitForTimeout(800);
    await p.keyboard.press("Enter");
  }
  await p.keyboard.type("/warn");
  await p.locator(".dxe-slash").first().waitFor();
  await p.keyboard.press("Enter");
  await p.keyboard.type("Ship the docs before the announcement.");

  // Paste an image.
  const bytes = await pngBytes(browser);
  await ed.evaluate((el, b) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(b)], "screenshot.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, bytes);
  await p.locator(".dxe-figure img").first().waitFor({ timeout: 15000 });
  // Drop another image at the end.
  const bytes2 = await pngBytes(browser, "Dropped diagram", ["#2150d8", "#14b8a6"]);
  await p.waitForTimeout(800);
  const box = await ed.boundingBox();
  await ed.evaluate((el, [b, x, y]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(b)], "diagram.png", { type: "image/png" }));
    const at = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y };
    el.dispatchEvent(new DragEvent("dragenter", at));
    el.dispatchEvent(new DragEvent("dragover", at));
    el.dispatchEvent(new DragEvent("drop", at));
  }, [bytes2, box.x + 200, box.y + box.height - 10]);
  await p.waitForFunction(() => document.querySelectorAll(".dxe-figure img").length >= 2, null, { timeout: 15000 });
  await waitSaved(p);
  await p.waitForTimeout(1500);
  await shot(p, "07-editor-written", { full: true, wait: 1500 });
  const md = await content(state.slug);
  fs.writeFileSync(path.join(SHOTS, "page.md"), md);
  for (const want of [":markdrop[Launch plan]{src=\"launch-plan\"}", '::markdrop{src="team-photo"}', '::markdrop{src="q3-report"}', '::markdrop{src="pricing-calc"}', ":::warning", "(asset:"]) {
    if (!md.includes(want)) fail(`saved Markdown lacks ${want}\n${md}`);
  }
  const assetIds = [...md.matchAll(/\(asset:([A-Za-z0-9_-]+)\)/g)].map((m) => m[1]);
  if (assetIds.length < 2) fail(`expected two page images, got ${assetIds.length}\n${md}`);
  state.assets = assetIds;
  save();
  // Always editable: no Done. A reload opens the editor again, as saved.
  await p.goto(`${APP}/${state.slug}`, { waitUntil: "networkidle" });
  await p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 30000 });
  if (!(await p.locator(".pb-live").innerText()).includes("Read the plan first")) fail("the reloaded editor lacks what was typed");
  await shot(p, "08-owner-editor-after-reload", { wait: 2000 });
  await c.close();
  // A reader (a workspace viewer): the page images, served by the Worker, really loaded.
  ({ c, p } = await ctx(browser, { token: T.reader }));
  await p.goto(`${APP}/${state.slug}`, { waitUntil: "networkidle" });
  await p.locator(".pb-page .pb-embed__img").first().waitFor({ timeout: 15000 });
  if (await p.locator(".pb-live").count()) fail("a viewer got the editor");
  await scrollToImages(p);
  const imgs = await p.locator(".pb-page figure img, .pb-page img").evaluateAll((els) => els.map((e) => ({ src: e.currentSrc || e.src, w: e.naturalWidth })));
  const pageImgs = imgs.filter((i) => i.src.includes("/pa/") || i.src.includes("pa%2F"));
  log("page images", JSON.stringify(pageImgs.map((i) => [i.src.slice(0, 80), i.w])));
  if (pageImgs.length < 2 || pageImgs.some((i) => !i.w)) fail(`page images not loaded from the Worker: ${JSON.stringify(imgs)}`);
  await shot(p, "08-reader-view", { full: true, wait: 3000 });
  await c.close();
});

/* The page is "workspace" (the folder's default); open it to anyone with the link for the reader checks. */
await step("open-link", async () => {
  const r = await api("PUT", `/api/v1/documents/${state.slug}/access/level`, T.owner, { level: "link" });
  if (r.status !== 204) fail(`access level → ${r.status} ${JSON.stringify(r.body)}`);
});

/* ── 2. member, stranger, anonymous ── */
await step("member", async () => {
  // A member can edit: the page opens in the editor, every item in place.
  const { c, p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/${state.slug}`, { waitUntil: "networkidle" });
  await p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 20000 });
  await p.locator(".pb-live .pb-embed__img").first().waitFor({ timeout: 20000 });
  const inEditor = await p.locator(".pb-live").innerText();
  for (const t of SECRET_TITLES) if (!inEditor.includes(t)) fail(`member's editor lacks ${t}`);
  await shot(p, "09a-member-editor", { wait: 2500 });
  await c.close();
});

await step("reader", async () => {
  const { c, p } = await ctx(browser, { token: T.reader });
  await p.goto(`${APP}/${state.slug}`, { waitUntil: "networkidle" });
  await p.locator(".pb-embed__img").first().waitFor({ timeout: 20000 });
  await p.locator(".pb-mention").first().waitFor();
  const body = await p.locator(".pb-page").innerText();
  for (const t of SECRET_TITLES) if (!body.includes(t)) fail(`the reader doesn't see ${t}`);
  if (await p.locator(".pb-locked").count()) fail("the reader sees a locked placeholder");
  // The PDF and HTML frames are really there and loaded.
  const frames = await p.locator(".pb-page iframe").evaluateAll((els) => els.map((e) => ({ src: e.src, h: e.getBoundingClientRect().height })));
  log("frames", JSON.stringify(frames.map((f) => [f.src.slice(0, 70), Math.round(f.h)])));
  if (frames.length < 2 || frames.some((f) => f.h < 200)) fail(`frames missing or collapsed: ${JSON.stringify(frames)}`);
  await shot(p, "09-reader-1440-light", { full: true, wait: 4000 });
  await c.close();
});

for (const [who, key, want] of [["stranger", "stranger", "Not available"], ["anonymous", null, "Sign in to see this"]]) {
  await step(who, async () => {
    const { c, p } = await ctx(browser, { token: key ? T[key] : null });
    const bodies = captureApi(p);
    const scripts = [];
    p.on("response", async (r) => {
      if (r.request().resourceType() !== "script") return;
      try {
        const t = await r.text();
        // ProseMirror's and Tiptap's own messages: only their library code has them.
        if (/Called contentMatchAt on a node with invalid content|\[tiptap warn\]/.test(t)) scripts.push(r.url());
      } catch {}
    });
    await p.goto(`${APP}/${state.slug}`, { waitUntil: "networkidle" });
    await p.locator(".pb-locked").first().waitFor({ timeout: 20000 });
    await p.waitForTimeout(1500);
    const body = await p.locator(".pb-page").innerText();
    for (const t of SECRET_TITLES) if (body.includes(t)) fail(`${who} sees the title ${t}`);
    if (!body.includes(want)) fail(`${who} doesn't see “${want}”`);
    if (!body.includes("Restricted item")) fail(`${who}'s mention isn't restricted`);
    const html = await p.content();
    for (const t of SECRET_TITLES) if (html.includes(t)) fail(`${who}: “${t}” is in the HTML`);
    for (const b of bodies) for (const t of SECRET_TITLES) if (b.body.includes(t)) fail(`${who}: “${t}” is in the response of ${b.url}`);
    for (const b of bodies) if (/\/r\/art\/|viewer_url|artifact_url"\s*:\s*"http/.test(b.body)) fail(`${who}: an item URL is in ${b.url}`);
    if (await p.locator(".pb-embed__img").count()) fail(`${who} got an embedded image`);
    await scrollToImages(p);
    const n = await p.locator(".pb-page img").evaluateAll((els) => els.filter((e) => e.naturalWidth > 0).length);
    if (n < 2) fail(`${who} doesn't see the page images (the page is public): ${n}`);
    if (scripts.length) fail(`${who} loaded the editor: ${scripts.join(", ")}`);
    await shot(p, `10-${who}-locked`, { full: true, wait: 1500 });
    await c.close();
  });
}

/* ── 3. sub-pages: create, breadcrumbs, inherited access, move, delete with children ── */
await step("subpage", async () => {
  const { c, p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/${state.slug}`, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Add a sub-page" }).first().click();
  const dlg = p.getByRole("dialog");
  await dlg.getByText("Meeting notes", { exact: true }).click();
  await dlg.getByLabel("Title").fill("Launch sync, Nov 3");
  await shot(p, "11-subpage-gallery");
  await dlg.getByRole("button", { name: "Create page" }).click();
  await p.waitForURL(/\?edit=1/, { timeout: 30000 });
  state.child = new URL(p.url()).pathname.split("/").pop();
  save();
  await p.locator(".pb-live .ProseMirror").waitFor();
  await p.locator(".pb-crumbs").waitFor();
  await shot(p, "12-subpage-editor-breadcrumbs");
  await c.close();
  const v = await ctx(browser, { token: T.reader });
  await v.p.goto(`${APP}/${state.child}`, { waitUntil: "networkidle" });
  await v.p.locator(".pb-page").waitFor();
  await shot(v.p, "13-subpage-view", { full: true });
  await v.c.close();
  const d = await docOf(state.child, T.owner);
  if (!d.access_inherit || d.parent?.slug !== state.slug) fail(`child doesn't inherit: ${JSON.stringify({ ai: d.access_inherit, parent: d.parent })}`);
  // Anonymous can read it: it inherits the parent's "anyone with the link".
  const a = await ctx(browser, {});
  await a.p.goto(`${APP}/${state.child}`, { waitUntil: "networkidle" });
  await a.p.locator(".pb-crumbs").waitFor({ timeout: 15000 });
  const crumbs = await a.p.locator(".pb-crumbs").innerText();
  if (!crumbs.includes("Page builder launch")) fail("breadcrumb missing the parent");
  await shot(a.p, "14-subpage-anonymous-breadcrumbs");
  // The parent narrows to the workspace: the sub-page follows (anonymous now meets the sign-in gate).
  const r = await api("PUT", `/api/v1/documents/${state.slug}/access/level`, T.owner, { level: "workspace" });
  if (r.status !== 204) fail(`narrow parent → ${r.status}`);
  await a.p.reload({ waitUntil: "networkidle" });
  await a.p.waitForTimeout(1500);
  if (await a.p.locator(".pb-page").count()) fail("anonymous still reads the sub-page after the parent narrowed");
  const gate = await a.p.locator("body").innerText();
  if (!/sign in/i.test(gate)) fail(`no sign-in gate on the sub-page: ${gate.slice(0, 200)}`);
  if (gate.includes("Launch sync")) fail("the gate shows the sub-page's title");
  await shot(a.p, "14b-subpage-follows-parent-gate");
  const anonGet = await api("GET", `/api/v1/documents/${state.child}`);
  if (anonGet.status === 200) fail("anonymous API read of the sub-page still 200");
  await api("PUT", `/api/v1/documents/${state.slug}/access/level`, T.owner, { level: "link" });
  await a.c.close();
  // The parent lists it.
  const o = await ctx(browser, { token: T.reader });
  await o.p.goto(`${APP}/${state.slug}`, { waitUntil: "networkidle" });
  await o.p.locator(".pb-children__item").first().waitFor({ timeout: 15000 });
  await o.p.locator(".pb-children").scrollIntoViewIfNeeded();
  await shot(o.p, "15-parent-pages-inside");
  await o.c.close();
});

await step("move", async () => {
  await api("PUT", `/api/v1/documents/${state.slug}/access/level`, T.owner, { level: "link" });
  // A private, top-level page of Ada's own (no workspace) and one in the workspace.
  const priv = await api("POST", "/api/v1/pages", T.owner, { title: "Private notebook" });
  if (priv.status !== 201) fail(`create private → ${priv.status} ${JSON.stringify(priv.body)}`);
  state.priv = priv.body.document.slug;
  await api("PUT", `/api/v1/documents/${state.priv}/access/level`, T.owner, { level: "private" });
  const ws2 = await api("POST", "/api/v1/pages", T.owner, { title: "Move target", workspace: WS, folder: FOLDER });
  state.target = ws2.body.document.slug;
  const kid = await api("POST", "/api/v1/pages", T.owner, { title: "Mover", parent: state.slug });
  if (kid.status !== 201) fail(`create kid → ${kid.status} ${JSON.stringify(kid.body)}`);
  state.mover = kid.body.document.slug;
  save();
  // Into the workspace page (link → workspace): readers change → 409 access_change, then confirmed.
  let r = await api("PUT", `/api/v1/documents/${state.mover}/parent`, T.owner, { parent: state.target });
  if (r.status !== 409 || r.body.code !== "access_change") fail(`move w/o confirm → ${r.status} ${JSON.stringify(r.body)}`);
  log("access_change:", r.body.readers_before, "→", r.body.readers_after);
  if (!r.body.detail || !r.body.readers_before || !r.body.readers_after) fail("access_change lacks the sentences");
  r = await api("PUT", `/api/v1/documents/${state.mover}/parent`, T.owner, { parent: state.target, confirm_access_change: true });
  if (r.status !== 200) fail(`confirmed move → ${r.status} ${JSON.stringify(r.body)}`);
  if (r.body.parent?.slug !== state.target) fail("moved page's parent is wrong");
  if ((await api("GET", `/api/v1/documents/${state.mover}`)).status === 200) fail("anonymous still reads the moved page");
  // The member can't move Ada's page under her private notebook (no edit there).
  r = await api("PUT", `/api/v1/documents/${state.mover}/parent`, T.member, { parent: state.priv, confirm_access_change: true });
  if (![403, 404].includes(r.status)) fail(`member move into a private page → ${r.status}`);
  // A sub-page can't go to another workspace's / personal page: 409/422.
  r = await api("PUT", `/api/v1/documents/${state.mover}/parent`, T.owner, { parent: state.priv, confirm_access_change: true });
  log("move ws → personal:", r.status, r.body?.detail);
  // Back to top level.
  r = await api("PUT", `/api/v1/documents/${state.mover}/parent`, T.owner, { parent: null, confirm_access_change: true });
  if (r.status !== 200 || r.body.parent) fail(`to top level → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
});

await step("delete-children", async () => {
  // A parent with two children and a grandchild; delete it lifting them, then another deleting them.
  const mk = async (title, parent) => (await api("POST", "/api/v1/pages", T.owner, { title, workspace: parent ? undefined : WS, folder: parent ? undefined : FOLDER, parent })).body.document.slug;
  const top = await mk("Delete me (lift)");
  const k1 = await mk("Kid one", top);
  const k2 = await mk("Kid two", top);
  const g1 = await mk("Grandkid", k1);
  let r = await api("DELETE", `/api/v1/documents/${top}`, T.owner);
  if (r.status !== 409 || r.body.code !== "has_children" || r.body.count !== 2) fail(`delete w/o children= → ${r.status} ${JSON.stringify(r.body)}`);
  const { c, p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/${top}?edit=1`, { waitUntil: "networkidle" });
  await p.locator(".pb-live .ProseMirror").waitFor({ timeout: 20000 });
  await p.getByRole("button", { name: "Page options" }).click();
  await p.getByRole("menuitem", { name: /Delete page/ }).click();
  const dlg = p.getByRole("dialog");
  await dlg.getByText("It has 2 sub-pages").waitFor();
  await shot(p, "25-delete-with-children");
  await dlg.getByRole("button", { name: "Delete page" }).click();
  await p.waitForURL((u) => !u.pathname.endsWith(top), { timeout: 20000 });
  log("after delete →", p.url());
  if ((await api("GET", `/api/v1/documents/${top}`, T.owner)).status !== 404) fail("parent still there");
  const kd = await docOf(k1, T.owner);
  if (kd.parent) fail(`lifted child still has a parent: ${JSON.stringify(kd.parent)}`);
  if ((await docOf(g1, T.owner)).parent?.slug !== k1) fail("grandchild lost its parent");
  // Delete k1 with its child.
  await p.goto(`${APP}/${k1}?edit=1`, { waitUntil: "networkidle" });
  await p.locator(".pb-live .ProseMirror").waitFor({ timeout: 20000 });
  await p.getByRole("button", { name: "Page options" }).click();
  await p.getByRole("menuitem", { name: /Delete page/ }).click();
  await dlg.getByText("Delete the sub-page too").click();
  await dlg.getByRole("button", { name: "Delete page" }).click();
  await p.waitForURL((u) => !u.pathname.endsWith(k1), { timeout: 20000 });
  for (const s of [k1, g1]) if ((await api("GET", `/api/v1/documents/${s}`, T.owner)).status !== 404) fail(`${s} not deleted`);
  if ((await api("GET", `/api/v1/documents/${k2}`, T.owner)).status !== 200) fail("sibling gone");
  await c.close();
});

/* ── 4. themes and widths ── */
for (const [theme, width] of [["dark", 1440], ["light", 390], ["dark", 390]]) {
  await step(`view-${theme}-${width}`, async () => {
    const { c, p } = await ctx(browser, { token: T.reader, theme, width, height: width < 500 ? 844 : 900 });
    await p.goto(`${APP}/${state.slug}`, { waitUntil: "networkidle" });
    await p.locator(".pb-embed__img").first().waitFor({ timeout: 20000 });
    const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 1) fail(`horizontal overflow ${over}px at ${width}`);
    await shot(p, `16-reader-${width}-${theme}`, { full: true, wait: 3000 });
    await c.close();
  });
}
await step("editor-dark-390", async () => {
  const { c, p } = await ctx(browser, { token: T.owner, theme: "dark", width: 390, height: 844 });
  await p.goto(`${APP}/${state.slug}?edit=1`, { waitUntil: "networkidle" });
  await p.locator(".pb-live .ProseMirror").waitFor({ timeout: 20000 });
  await shot(p, "17-editor-390-dark", { wait: 2000 });
  await c.close();
});
await step("anonymous-dark", async () => {
  const { c, p } = await ctx(browser, { theme: "dark" });
  await p.goto(`${APP}/${state.slug}`, { waitUntil: "networkidle" });
  await p.locator(".pb-locked").first().waitFor({ timeout: 20000 });
  await shot(p, "18-anonymous-1440-dark", { full: true, wait: 1500 });
  await c.close();
});

/* ── 5. the edit lock, MCP update (423) and append (live) ── */
await step("lock-mcp", async () => {
  const tok = mcpToken("ada@acme.test");
  const { c, p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/${state.slug}?edit=1`, { waitUntil: "networkidle" });
  await p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 20000 });
  await p.waitForTimeout(1500);
  // Opening takes nothing: the first click takes the lock.
  if ((await api("POST", `/api/v1/documents/${state.slug}/lock`, T.admin)).status !== 200) fail("opening the editor took the lock");
  await api("DELETE", `/api/v1/documents/${state.slug}/lock`, T.admin);
  await p.locator(".pb-live .ProseMirror p").first().click();
  await p.waitForTimeout(1500);
  // A second editor (Ben, a member) is told "Ada Owner is editing" (now, or on his first click) and stays read only.
  const b = await ctx(browser, { token: T.member });
  await b.p.goto(`${APP}/${state.slug}?edit=1`, { waitUntil: "networkidle" });
  await b.p.locator(".pb-live .ProseMirror").waitFor({ timeout: 20000 });
  await b.p.waitForTimeout(1500);
  if (!(await b.p.locator(".pb-banner").getByText("Ada Owner is editing").count())) await b.p.locator(".pb-live .ProseMirror p").first().click();
  await b.p.locator(".pb-banner").getByText("Ada Owner is editing").waitFor({ timeout: 20000 });
  if (!(await b.p.locator('.pb-live .ProseMirror[contenteditable="false"]').count())) fail("the second editor isn't read only");
  await shot(b.p, "20-locked-read-only", { wait: 1500 });
  // MCP update_page during the lock → refused (423 locked, as a tool error).
  const before = await docOf(state.slug, T.owner);
  const up = await mcp(tok, "update_page", { document: state.slug, markdown: before.content + "\nNope\n", base_rev: before.rev });
  log("update_page while locked:", up.status, up.isError, up.text.slice(0, 120));
  if (!up.isError || !/editing|423|locked/i.test(up.text)) fail(`update_page during the lock wasn't refused: ${up.text}`);
  const rs = await mcp(tok, "replace_section", { document: state.slug, heading: "Known limits", markdown: "## Known limits\n\nNope\n" });
  if (!rs.isError) fail("replace_section during the lock wasn't refused");
  // append_blocks goes through and shows up in the open editor, and in Ben's read-only one.
  const ap = await mcp(tok, "append_blocks", { document: state.slug, markdown: "## Added by Claude\n\n- [ ] Draft the announcement email\n- [ ] Record the demo video" });
  if (ap.isError) fail(`append_blocks refused: ${ap.text}`);
  await p.getByText("Added by Claude").waitFor({ timeout: 10000 });
  await p.getByText("Added by Claude").scrollIntoViewIfNeeded();
  await b.p.getByText("Added by Claude").waitFor({ timeout: 15000 });
  await shot(p, "19-editor-live-appended", { wait: 3500 });
  // Keep typing after the append: no lost or doubled text.
  await p.locator(".pb-live .ProseMirror").getByText("Record the demo video").click();
  await p.waitForTimeout(250);
  await p.keyboard.press("End");
  await p.keyboard.type(" Typed after the append.");
  await waitSaved(p);
  await p.waitForTimeout(1000);
  const md = await content(state.slug);
  if ((md.match(/Added by Claude/g) || []).length !== 1) fail("the appended section is missing or doubled");
  if (!md.includes("Typed after the append.")) fail("typing after the append was lost");
  if (md.includes("Nope")) fail("a refused MCP write landed");
  // Leaving the page lets go of the lock: then update_page works (with the fresh rev).
  await p.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
  await p.waitForTimeout(1500);
  const now = await docOf(state.slug, T.owner);
  const up2 = await mcp(tok, "update_page", { document: state.slug, markdown: now.content + "\nAfter the lock.\n", base_rev: now.rev });
  if (up2.isError) fail(`update_page after leaving refused: ${up2.text}`);
  const stale = await mcp(tok, "update_page", { document: state.slug, markdown: "stale", base_rev: now.rev });
  if (!stale.isError || !/rev|changed|stale|409/i.test(stale.text)) fail(`stale base_rev not refused: ${stale.text}`);
  await b.c.close();
  await c.close();
});

/* ── 6. a custom domain: a member reads the page with its embeds through the tenant token ── */
await step("tenant", async () => {
  const { c, p } = await ctx(browser, { token: T.member });
  // Signed in on the app first (localStorage there), then the workspace's domain.
  await p.goto(`${APP}/robots.txt`);
  const d = await docOf(state.slug, T.owner);
  const addr = `${TENANT}/${[...(d.folder_path || []), state.slug].join("/")}`;
  log("tenant address", addr);
  // Each run reseeds a new workspace behind the same host: drop Next's cached host lookup (production
  // never moves a host to another workspace without this purge).
  await fetch(`${APP}/api/revalidate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: "host:acme.localhost" }) });
  const bodies = captureApi(p);
  await p.goto(addr, { waitUntil: "networkidle" });
  // A public page: read anonymously until the reader signs in to the workspace's domain
  // (handoff to the app and back with a tenant token).
  await p.locator(".pb-locked").first().waitFor({ timeout: 20000 });
  await shot(p, "26-tenant-before-sign-in");
  await p.getByRole("button", { name: /Sign in to read/ }).or(p.getByRole("link", { name: /Sign in to read/ })).first().click();
  await p.waitForURL((u) => u.hostname === "acme.localhost" && !u.hash.includes("mdt="), { timeout: 30000 }).catch(() => {});
  log("after sign-in", p.url().replace(/#.*/, "#…"));
  await p.locator(".pb-embed__img").first().waitFor({ timeout: 30000 });
  const body = await p.locator(".pb-page").innerText();
  for (const t of SECRET_TITLES) if (!body.includes(t)) fail(`tenant member doesn't see ${t}`);
  const embedCall = bodies.find((b) => b.url.includes("/embeds"));
  if (!embedCall || embedCall.status !== 200) fail(`embeds on the tenant host → ${embedCall?.status}`);
  await shot(p, "27-tenant-member", { full: true, wait: 3000 });
  // The sub-page's tenant address works too.
  const cd = await docOf(state.child, T.owner);
  await p.goto(`${TENANT}/${[...(cd.folder_path || []), state.child].join("/")}`, { waitUntil: "networkidle" });
  await p.locator(".pb-crumbs").waitFor({ timeout: 20000 });
  await shot(p, "28-tenant-subpage");
  await c.close();
});

/* ── 6b. editing on the custom domain: a member edits and saves there; a reader there sees the change
   and can ask to edit; management stays on markdrop.in (owner decision 2026-11-04) ── */
async function tenantSignIn(p, addr) {
  await fetch(`${APP}/api/revalidate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: "host:acme.localhost" }) });
  await p.goto(`${APP}/robots.txt`);
  await p.goto(addr, { waitUntil: "networkidle" });
  const signIn = p.getByRole("button", { name: /Sign in to read/ }).or(p.getByRole("link", { name: /Sign in to read/ }))
    .or(p.getByRole("link", { name: /^Sign in$/ })).or(p.getByRole("button", { name: /^Sign in$/ }));
  await signIn.first().click({ timeout: 20000 });
  await p.waitForURL((u) => u.hostname === "acme.localhost" && !u.hash.includes("mdt="), { timeout: 30000 }).catch(() => {});
  await p.waitForLoadState("networkidle");
}
/** The page's ⋯ menu (reader or editor). */
const pageMenu = (p) => p.getByRole("button", { name: /Page options|More options|^More$/ }).last().click({ timeout: 10000 });
await step("tenant-edit", async () => {
  const d = await docOf(state.slug, T.owner);
  const addr = `${TENANT}/${[...(d.folder_path || []), state.slug].join("/")}`;
  const marker = `Edited on acme.localhost ${Date.now().toString(36)}`;
  // Ben (a member) on the workspace's domain: the page opens in the editor, he types, it saves.
  const m = await ctx(browser, { token: T.member });
  const calls = captureApi(m.p);
  await tenantSignIn(m.p, addr);
  await m.p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 30000 });
  if (await m.p.getByText("only works for documents on that workspace").count()) fail("the domain session was refused");
  await m.p.locator(".pb-live .ProseMirror > p").last().click();
  await m.p.keyboard.press("End");
  await m.p.keyboard.press("Enter");
  await m.p.keyboard.type(marker);
  await waitSaved(m.p);
  await shot(m.p, "29-tenant-member-editing", { wait: 1200 });
  const md = await content(state.slug);
  if (!md.includes(marker)) fail("the edit made on the domain didn't reach the page");
  const put = calls.find((b) => b.url.endsWith(`/api/v1/documents/${state.slug}`) && b.status === 200 && b.body.includes(marker));
  if (!put) log("(no PUT seen in the capture; the content check above passed)");
  const lock = calls.find((b) => b.url.includes(`/documents/${state.slug}/lock`));
  if (!lock || lock.status !== 200) fail(`lock on the domain → ${lock?.status}`);
  if (calls.some((b) => b.status === 401 && /documents\/[^/]+(\/lock|\/assets)?$/.test(new URL(b.url).pathname))) fail("a 401 on an editing route on the domain");
  // Leaving the page lets go of the lock (the close beacon carries the domain's session).
  await m.p.goto(`${TENANT}/robots.txt`);
  await m.p.waitForTimeout(1500);
  const free = await api("POST", `/api/v1/documents/${state.slug}/lock`, T.admin);
  if (free.status !== 200) fail(`the lock outlived leaving the domain page → ${free.status} ${JSON.stringify(free.body)}`);
  await api("DELETE", `/api/v1/documents/${state.slug}/lock`, T.admin);
  await m.c.close();

  // Vic (a workspace viewer) on the domain: reads the new text, may ask to edit.
  const r = await ctx(browser, { token: T.reader });
  await tenantSignIn(r.p, addr);
  await r.p.locator(".pb-page").getByText(marker).waitFor({ timeout: 30000 });
  if (await r.p.locator('.pb-live .ProseMirror[contenteditable="true"]').count()) fail("a viewer got the editor on the domain");
  await shot(r.p, "30-tenant-reader-sees-edit", { wait: 1000 });
  await pageMenu(r.p);
  await r.p.getByRole("menuitem", { name: /Request edit access/ }).click({ timeout: 10000 });
  await r.p.getByRole("dialog").getByLabel(/Message/).fill("I'd like to fix the rollout dates.");
  await shot(r.p, "31-tenant-request-edit-dialog", { wait: 500 });
  await r.p.getByRole("dialog").getByRole("button", { name: "Send request" }).click();
  await r.p.getByText(/Request sent/).first().waitFor({ timeout: 15000 });
  await shot(r.p, "32-tenant-request-sent", { wait: 300 });
  await r.c.close();
  const reqs = await api("GET", "/api/v1/me/access-requests", T.owner);
  const mine = (reqs.body?.requests || []).find((x) => x.document?.slug === state.slug && x.role_requested === "editor");
  if (!mine) fail(`the owner has no edit request: ${JSON.stringify(reqs.body).slice(0, 300)}`);
  // The owner approves on markdrop.in; Vic edits on the domain after that.
  const ok = await api("POST", `/api/v1/access-requests/${mine.id}/decision`, T.owner, { decision: "edit" });
  if (ok.status !== 200 || ok.body.role_granted !== "editor") fail(`approve → ${ok.status} ${JSON.stringify(ok.body)}`);
  const r2 = await ctx(browser, { token: T.reader });
  await tenantSignIn(r2.p, addr);
  await r2.p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 30000 });
  await shot(r2.p, "33-tenant-reader-approved-editor", { wait: 1200 });
  await r2.c.close();

  // The owner on the domain: delete / access / link open markdrop.in.
  const o = await ctx(browser, { token: T.owner });
  await tenantSignIn(o.p, addr);
  await o.p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 30000 });
  await pageMenu(o.p);
  await o.p.getByRole("menuitem", { name: /General access on markdrop\.in/ }).or(o.p.getByRole("link", { name: /General access on markdrop\.in/ })).waitFor({ timeout: 10000 });
  if (await o.p.getByRole("menuitem", { name: /^Delete page$/ }).count()) fail("Delete page is offered on the domain");
  await shot(o.p, "34-tenant-owner-menu", { wait: 500 });
  await o.p.keyboard.press("Escape");
  // Share with people right on the domain (2026-11-04): the dialog's people-only mode.
  const shareCalls = captureApi(o.p);
  await o.p.getByRole("button", { name: "Share", exact: true }).first().click({ timeout: 10000 });
  const dlg = o.p.getByRole("dialog");
  await dlg.getByText(/Change general access on markdrop\.in/).waitFor({ timeout: 15000 });
  if (await dlg.getByText("Who can open it", { exact: true }).count()) fail("the access level is offered on the domain");
  if (await dlg.getByRole("radio", { name: /Anyone with the link/ }).count()) fail("the access level is offered on the domain");
  const who = `domain-share-${Date.now().toString(36)}@example.com`;
  await dlg.getByPlaceholder("Add people by email").fill(who);
  await dlg.getByPlaceholder("Add people by email").press("Enter");   // a tag input: Enter adds it
  const added = o.p.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/documents/${state.slug}/access/people`), { timeout: 15000 });
  await dlg.getByRole("button", { name: /^Share$/ }).click({ timeout: 10000 });
  const res = await added;
  if (res.status() !== 201) fail(`share on the domain → ${res.status()} ${await res.text()}`);
  await shot(o.p, "35-tenant-share-people", { wait: 500 });
  if (shareCalls.some((b) => b.status === 401 && /\/access/.test(new URL(b.url).pathname))) fail("a 401 on a sharing route on the domain");
  const acc = await api("GET", `/api/v1/documents/${state.slug}/access`, T.owner);
  if (!(acc.body?.grants || []).some((g) => g.email === who)) fail(`the person added on the domain has no grant: ${JSON.stringify(acc.body).slice(0, 300)}`);
  if (acc.body?.level !== d.access_level && d.access_level) log(`(level ${d.access_level} → ${acc.body?.level})`);
  await api("DELETE", `/api/v1/documents/${state.slug}/access/people/${encodeURIComponent(who)}`, T.owner);
  await o.c.close();
});

/* ── 7. page properties: icon, cover upload + reposition, full width, font, lock ── */
await step("properties", async () => {
  const mk = await api("POST", "/api/v1/pages", T.owner, { title: "Properties", workspace: WS, folder: FOLDER });
  const slug = mk.body.document.slug;
  state.props = slug;
  save();
  const { c, p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/${slug}?edit=1`, { waitUntil: "networkidle" });
  await p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 30000 });
  await p.locator(".pb-head").hover();
  await p.getByRole("button", { name: "Add icon" }).click();
  await p.getByLabel("Search emoji").fill("rocket");
  await p.getByRole("button", { name: "rocket" }).first().click();
  await p.locator(".pb-head").hover();
  await p.getByRole("button", { name: "Add cover" }).click();
  await p.getByRole("tab", { name: "Upload" }).click();
  const cover = await pngBytes(browser, "Cover photo", ["#0ea5e9", "#a855f7"]);
  const chooser = p.waitForEvent("filechooser");
  await p.getByText("Upload an image").click();
  await (await chooser).setFiles({ name: "cover.png", mimeType: "image/png", buffer: Buffer.from(cover) });
  await p.waitForFunction(() => (document.querySelector(".pb-cover-img__img")?.naturalWidth ?? 0) > 0, null, { timeout: 20000 });
  // Reposition: drag the image down 60 px (shows more of its top), then save the position.
  await p.locator(".pb-cover-img").hover();
  await p.getByRole("button", { name: "Reposition" }).click();
  const cb = await p.locator(".pb-cover-img").boundingBox();
  await p.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await p.mouse.down();
  await p.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2 + 60, { steps: 8 });
  await p.mouse.up();
  await p.getByRole("button", { name: "Save position" }).click();
  await p.getByRole("button", { name: "Page options" }).click();
  await p.locator(".pb-toggles").getByText("Full width").click();
  await p.getByRole("radio", { name: /Serif/ }).click();
  await p.keyboard.press("Escape");
  await p.getByRole("button", { name: "Page options" }).click();
  await p.getByRole("menuitem", { name: /Lock page/ }).click();
  await waitSaved(p);
  await p.waitForTimeout(1500);
  const md = await content(slug);
  fs.writeFileSync(path.join(SHOTS, "props.md"), md);
  for (const re of [/icon: 🚀/, /cover: asset:/, /cover_y: \d+/, /full_width: true/, /font: serif/, /locked: true/]) if (!re.test(md)) fail(`properties lack ${re}\n${md.slice(0, 300)}`);
  const y = Number(/cover_y: (\d+)/.exec(md)[1]);
  if (y >= 50) fail(`reposition didn't move the focal point: ${y}`);
  const d = await docOf(slug, T.member);
  if (!d.page?.cover_url || !d.page.locked) fail(`page props: ${JSON.stringify(d.page)}`);
  await shot(p, "29-properties-editor", { wait: 1000 });
  await c.close();
  // A reader sees the uploaded cover, full width and serif.
  const rv = await ctx(browser, { token: T.reader });
  await rv.p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  await rv.p.waitForFunction(() => (document.querySelector(".pb-cover-img__img")?.naturalWidth ?? 0) > 0, null, { timeout: 15000 });
  await shot(rv.p, "29b-properties-view", { wait: 2000 });
  await rv.c.close();
  // Ben (a member who could edit) can't: the page is locked.
  const m = await ctx(browser, { token: T.member });
  await m.p.goto(`${APP}/${slug}?edit=1`, { waitUntil: "networkidle" });
  await m.p.getByText(/locked/i).first().waitFor({ timeout: 20000 });
  if (await m.p.locator('.pb-live .ProseMirror[contenteditable="true"]').count()) fail("a member can edit a locked page");
  await shot(m.p, "29c-locked-member");
  const put = await api("PUT", `/api/v1/documents/${slug}`, T.member, { content: md + "\nx\n", base_rev: d.rev });
  if (put.status !== 423) fail(`member PUT on a locked page → ${put.status}`);
  await m.c.close();
});

/* ── 8. a real bookmark preview ── */
await step("bookmark", async () => {
  const r = await api("POST", "/api/v1/link-preview", T.owner, { url: "https://example.com/" });
  log("link-preview:", r.status, JSON.stringify(r.body).slice(0, 200));
  if (r.status !== 200 || !r.body.title) fail(`link-preview → ${r.status}`);
  state.bookmarkFetched = r.body.fetched;
  const bad = await api("POST", "/api/v1/link-preview", T.owner, { url: `${API}/__sandbox/health` });
  if (bad.status !== 422) fail(`SSRF to loopback → ${bad.status}`);
  save();
});

/* ── 9. Open in block editor; Create menu; the rail ── */
await step("to-blocks", async () => {
  const before = await docOf("public-handbook", T.member);
  const { c, p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/public-handbook`, { waitUntil: "networkidle" });
  await p.waitForTimeout(1500);
  await p.keyboard.press("Escape");
  await p.getByRole("button", { name: "More actions" }).first().click();
  await p.getByRole("menuitem", { name: /Open in block editor/ }).click();
  await shot(p, "21-open-in-block-editor");
  await p.getByRole("button", { name: "Open in block editor" }).click();
  await p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 20000 });
  await p.waitForTimeout(4000);
  await shot(p, "22-classic-doc-in-block-editor", { wait: 1200 });
  const after = await docOf("public-handbook", T.member);
  if (after.content !== before.content) fail(`untouched Markdown changed on switch:\n--- before\n${before.content}\n--- after\n${after.content}`);
  if (after.rev !== before.rev) log(`note: rev ${before.rev} → ${after.rev} without an edit`);
  await c.close();
});

await step("create-menu", async () => {
  const { c, p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: /Create/ }).first().click();
  await p.getByRole("menuitem", { name: /Page/ }).first().waitFor();
  await shot(p, "23-create-menu-page");
  await c.close();
});

await step("rail", async () => {
  const { c, p } = await ctx(browser, { token: T.owner });
  await c.addInitScript(([ws, f]) => localStorage.setItem("md_rail_tree", JSON.stringify([`ws:${ws}:root`, `ws:${ws}:folder:${f}`])), [WS, FOLDER]);
  await p.goto(`${APP}/w/${WS}/f/${FOLDER}`, { waitUntil: "networkidle" });
  await p.waitForTimeout(2500);
  const rail = await p.locator("nav").first().innerText().catch(() => "");
  if (!rail.includes("Page builder launch")) log("rail text lacks the page:", rail.slice(0, 300));
  await shot(p, "24-rail-pages", { wait: 1500 });
  await c.close();
});

// The rail's tree: one outline request per workspace, the current folder highlighted, hover
// actions, and a rename in another tab showing up in place (no reload, no new request).
await step("rail-live", async () => {
  const made = await api("POST", "/api/v1/pages", T.owner, { title: "Rail rename probe", workspace: WS, folder: FOLDER });
  if (made.status !== 200 && made.status !== 201) fail(`create → ${made.status}`);
  const slug = made.body.document.slug;
  const { c, p } = await ctx(browser, { token: T.owner });
  await c.addInitScript(([ws, f]) => localStorage.setItem("md_rail_tree", JSON.stringify([`ws:${ws}:root`, `ws:${ws}:folder:${f}`])), [WS, FOLDER]);
  const calls = [];
  p.on("request", (r) => { if (r.url().startsWith(API) && r.method() === "GET") calls.push(new URL(r.url()).pathname); });
  await p.goto(`${APP}/w/${WS}/f/${FOLDER}`, { waitUntil: "networkidle" });
  const tree = p.locator('aside nav[aria-label="Your drive"]');
  const row = tree.locator(`[data-rail-key="ws:${WS}:page:${slug}"]`);
  await row.waitFor({ timeout: 10000 });
  const navCalls = calls.filter((u) => u.endsWith("/nav")).length;
  if (navCalls !== 1) fail(`expected one /nav request for the open workspace, saw ${navCalls}: ${calls.join(", ")}`);
  // The current folder: aria-current and inside the rail's visible area.
  const cur = tree.locator(`[data-rail-key="ws:${WS}:folder:${FOLDER}"]`);
  if ((await cur.getAttribute("aria-current")) !== "page") fail("the current folder isn't marked aria-current");
  const seen = await cur.evaluate((el) => { const r = el.getBoundingClientRect(), a = el.closest("aside").getBoundingClientRect(); return r.top >= a.top && r.bottom <= a.bottom; });
  if (!seen) fail("the current folder isn't scrolled into view");
  // Row height and hover actions (+ and ⋯ only while hovered).
  const h = await row.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  if (h < 28 || h > 30) fail(`rail rows are ${h} px`);
  const add = tree.getByRole("link", { name: "Add a page inside Rail rename probe" });
  if (await add.count()) fail("the + shows without hover");
  await row.hover();
  await add.waitFor({ timeout: 3000 });
  await shot(p, "24b-rail-hover");
  // Rename it in a second tab of the same browser: the first tab's rail follows without a request.
  calls.length = 0;
  const p2 = await c.newPage();
  await p2.goto(`${APP}/${slug}?edit=1`, { waitUntil: "networkidle" });
  await p2.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 30000 });
  await p2.getByLabel("Page title").click();
  await p2.keyboard.press("ControlOrMeta+a");
  await p2.keyboard.type("Rail renamed live");
  await waitSaved(p2);
  await p.bringToFront();
  const renamed = await row.filter({ hasText: "Rail renamed live" }).waitFor({ timeout: 8000 }).then(() => true, () => false);
  if (!renamed) fail(`the other tab's rail still says “${await row.innerText().catch(() => "?")}”`);
  const refetched = calls.filter((u) => u.endsWith("/nav") || u.endsWith("/children"));
  if (refetched.length) fail(`a rename refetched: ${refetched.join(", ")}`);
  await shot(p, "24c-rail-renamed");
  await c.close();
});

/* ── 10. Notion-style editing ── */
await step("parity", async () => {
  const r = await api("POST", "/api/v1/pages", T.owner, { title: "Notion parity", workspace: WS, folder: FOLDER });
  const d = r.body.document;
  state.parity = d.slug;
  save();
  const { c, p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/${d.slug}?edit=1`, { waitUntil: "networkidle" });
  const ed = p.locator(".pb-live .ProseMirror");
  await p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 30000 });
  await p.locator(".pb-empty").waitFor({ timeout: 10000 });
  await shot(p, "30-empty-page-helpers");
  await p.locator(".pb-head").hover();
  await p.getByRole("button", { name: "Add icon" }).click();
  await p.getByLabel("Search emoji").fill("rocket");
  await p.getByRole("button", { name: "rocket" }).first().click();
  await p.locator(".pb-head").hover();
  await p.getByRole("button", { name: "Add cover" }).click();
  await p.getByRole("tab", { name: "Calm" }).click();
  await p.getByRole("button", { name: "Sage" }).click();
  await p.getByLabel("Page title").click();
  await p.keyboard.press("End");
  await p.keyboard.press("Enter");
  await p.keyboard.type("## Plan");
  await p.keyboard.press("Enter");
  await p.keyboard.type("[] Book the venue");
  await p.keyboard.press("Enter");
  await p.keyboard.type("Send invites");
  await p.keyboard.press("ControlOrMeta+Enter");
  await p.keyboard.press("Enter");
  await p.keyboard.press("Enter");
  await p.keyboard.type("Launch day :rock");
  await p.locator(".dxe-slash").filter({ hasText: ":rocket:" }).first().waitFor();
  await p.keyboard.press("Enter");
  await p.keyboard.type(" is **Monday** with `v2`.");
  await p.keyboard.press("Enter");
  await p.keyboard.type("Make this a heading");
  await p.keyboard.press("ControlOrMeta+Alt+3");
  await p.keyboard.press("Enter");
  await p.keyboard.type("\" Quote via shortcut");
  await p.keyboard.press("Enter");
  await p.keyboard.press("Enter");
  await p.keyboard.type("/toggle");
  await p.locator(".dxe-slash").first().waitFor();
  await p.keyboard.press("Enter");
  await p.keyboard.type("Hidden detail");
  await waitSaved(p);
  await p.waitForTimeout(1000);
  const md = await content(d.slug);
  fs.writeFileSync(path.join(SHOTS, "parity.md"), md);
  for (const want of ["icon: 🚀", "cover: gallery:sage", "## Plan", "- [ ] Book the venue", "- [x] Send invites", "Launch day 🚀 is **Monday** with `v2`.", "### Make this a heading", "> Quote via shortcut", ':::details{summary="More details"}', "Hidden detail"]) {
    if (!md.includes(want)) fail(`parity markdown lacks ${want}\n${md}`);
  }
  await shot(p, "34-parity-editor", { full: true, wait: 800 });
  // A local draft survives a reload before the autosave runs.
  await ed.click();
  await p.keyboard.press("ControlOrMeta+End");
  await p.keyboard.type(" Unsaved tail.");
  p.on("dialog", (dl) => void dl.accept());
  await p.reload({ waitUntil: "networkidle" });
  await p.getByText("Unsaved changes from this browser").waitFor({ timeout: 20000 });
  await shot(p, "36-draft-restore");
  await p.getByRole("button", { name: "Restore them" }).click();
  await waitSaved(p);
  await p.waitForTimeout(1000);
  if (!(await content(d.slug)).includes("Unsaved tail.")) fail("the restored draft wasn't saved");
  await c.close();
  const rv = await ctx(browser, { token: T.reader });
  await rv.p.goto(`${APP}/${d.slug}`, { waitUntil: "networkidle" });
  await rv.p.locator(".pb-page").waitFor();
  await shot(rv.p, "37-parity-view", { full: true, wait: 1000 });
  await rv.c.close();
  await c.close();
});

/* ── 11. more blocks ── */
await step("blocks", async () => {
  const r = await api("POST", "/api/v1/pages", T.owner, { title: "All the blocks", workspace: WS, folder: FOLDER });
  const d = r.body.document;
  state.blocks = d.slug;
  save();
  const { c, p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/${d.slug}?edit=1`, { waitUntil: "networkidle" });
  await p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 30000 });
  await p.getByLabel("Page title").click();
  await p.keyboard.press("End");
  await p.keyboard.press("Enter");
  const lastLine = async () => {
    await p.locator(".ProseMirror > p").last().click();
    await p.keyboard.press("End");
  };
  await slashPick(p, "toc");
  await p.keyboard.type("## Overview");
  await p.keyboard.press("Enter");
  await p.keyboard.type("Due ");
  await slashPick(p, "date");
  await p.keyboard.type("for ");
  await slashPick(p, "person");
  await p.getByLabel("Search people").fill("ben");
  await p.getByRole("dialog", { name: "Mention someone" }).getByRole("button", { name: "Ben Member" }).click();
  await p.keyboard.press("End");
  await p.keyboard.press("Enter");
  await p.keyboard.type("/toggle");
  await p.locator(".dxe-slash").first().waitFor();
  await p.keyboard.press("ArrowDown");
  await p.keyboard.press("ArrowDown");
  await p.keyboard.press("Enter");
  await p.keyboard.type("FAQ");
  await p.keyboard.press("Enter");
  await p.keyboard.type("Answers go here.");
  await p.keyboard.press("Enter");
  await p.keyboard.press("Enter");
  await slashPick(p, "bookmark");
  await p.getByLabel("Bookmark link").fill("https://example.com/");
  await p.getByRole("button", { name: "Create bookmark" }).click();
  await p.locator(".pb-bookmark").waitFor({ timeout: 20000 });
  await lastLine();
  await slashPick(p, "youtube");
  await p.getByLabel("Embed link").fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await p.getByRole("button", { name: "Embed", exact: true }).click();
  await p.locator(".pb-webembed iframe").waitFor();
  await lastLine();
  await slashPick(p, "page");
  await p.locator(".pb-card").first().waitFor({ timeout: 15000 });
  await lastLine();
  await slashPick(p, "callout");
  await p.keyboard.type("Coloured callout with an emoji.");
  await p.getByRole("button", { name: /callout: change type/ }).last().click();
  await p.getByRole("menuitem", { name: /Blue/ }).click();
  await p.getByRole("button", { name: /callout: change type/ }).last().click();
  await p.getByRole("menuitem", { name: /Choose an icon/ }).click();
  await p.getByLabel("Search emoji").fill("bulb");
  await p.getByRole("button", { name: "bulb" }).first().click();
  await waitSaved(p);
  await p.waitForTimeout(1000);
  await shot(p, "40-blocks-editor", { full: true, wait: 1000 });
  const md = await content(d.slug);
  fs.writeFileSync(path.join(SHOTS, "blocks.md"), md);
  const ben = S.users.member.id;
  for (const want of ["::toc", "## Overview", ":date[", `:person[Ben Member]{id="${ben}"}`, 'summary="FAQ" heading="2"', "Answers go here.", '::bookmark{url="https://example.com/"', '::embed{src="https://www.youtube.com/watch?v=dQw4w9WgXcQ"}', "::page{src=", 'color="blue"', 'icon="💡"']) {
    if (!md.includes(want)) fail(`blocks markdown lacks ${want}\n${md}`);
  }
  if (!/::bookmark\{[^}]*title="[^"]+"/.test(md)) fail(`the bookmark has no title (preview not fetched)\n${md}`);
  await c.close();
  const rv = await ctx(browser, { token: T.reader });
  await rv.p.goto(`${APP}/${d.slug}`, { waitUntil: "networkidle" });
  await rv.p.locator(".pb-bookmark").waitFor({ timeout: 15000 });
  await shot(rv.p, "41-blocks-view", { full: true, wait: 2000 });
  await rv.c.close();
  await c.close();
});

await browser.close();
fs.writeFileSync(path.join(SHOTS, "results.json"), JSON.stringify(results, null, 1));
console.log(`\nResults (${BROWSER}):`);
for (const [n, r] of results) console.log(`  ${r === "ok" ? "✓" : "✗"} ${n}: ${r}`);
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
