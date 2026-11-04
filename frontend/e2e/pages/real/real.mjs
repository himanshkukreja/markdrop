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
import { APP, TENANT, API, WORKER, SHOTS, BROWSER, log, fail, reseed, seedNow, mcpToken, api, mcp, docOf, launch, ctx, captureApi, shot, stepper, pngBytes, waitSaved, topBars, uploadFile, fileLayout } from "./lib.mjs";

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
  // The owner lands in the editor: it takes the read view's place once ready (its own "Add a
  // sub-page"), so click the one that stays.
  await p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 30000 });
  // Page images keep their room while they load (their size comes with the page): scrolling to the
  // button lazy-loads the ones near it, and unsized they pushed it down between the press and the
  // release, so the click landed on an image (WebKit, now and then).
  const unsized = await p.locator(".pb-live img.dx-fig__img").evaluateAll((els) => els.filter((e) => !(Number(e.getAttribute("width")) > 0 && Number(e.getAttribute("height")) > 0)).map((e) => e.getAttribute("src")));
  if (unsized.length) fail(`page images without a size: ${unsized.join(", ")}`);
  if (!(await p.locator(".pb-live img.dx-fig__img").count())) fail("no page images to check (the create step adds two)");
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

const TRASH_SHOTS = process.env.TRASH_SHOTS || "";
if (TRASH_SHOTS) fs.mkdirSync(TRASH_SHOTS, { recursive: true });
async function tshot(p, name, opts = {}) {
  await shot(p, name, opts);
  if (TRASH_SHOTS) fs.copyFileSync(path.join(SHOTS, `${name}.png`), path.join(TRASH_SHOTS, `${BROWSER}-${name}.png`));
}
const waitStatus = async (slug, want, token = T.owner) => {
  for (let i = 0; i < 60; i++) {
    if ((await api("GET", `/api/v1/documents/${slug}`, token)).status === want) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`${slug} never answered ${want}`);
};

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
  await dlg.getByText(/30 days/).first().waitFor();
  await tshot(p, "25-delete-with-children");
  await dlg.getByRole("button", { name: "Move to Trash" }).click();
  await p.waitForURL((u) => !u.pathname.endsWith(top), { timeout: 20000 });
  log("after delete →", p.url());
  if ((await api("GET", `/api/v1/documents/${top}`, T.owner)).status !== 404) fail("parent still there");
  // In the trash, alone (its sub-pages were lifted, not deleted).
  const tl = (await api("GET", "/api/v1/trash", T.owner)).body;
  const tp = tl?.items?.find((i) => i.slug === top);
  if (!tp || tp.sub_pages !== 0) fail(`lifted parent's trash row: ${JSON.stringify(tp)}`);
  const kd = await docOf(k1, T.owner);
  if (kd.parent) fail(`lifted child still has a parent: ${JSON.stringify(kd.parent)}`);
  if ((await docOf(g1, T.owner)).parent?.slug !== k1) fail("grandchild lost its parent");
  // Delete k1 with its child.
  await p.goto(`${APP}/${k1}?edit=1`, { waitUntil: "networkidle" });
  await p.locator(".pb-live .ProseMirror").waitFor({ timeout: 20000 });
  await p.getByRole("button", { name: "Page options" }).click();
  await p.getByRole("menuitem", { name: /Delete page/ }).click();
  await dlg.getByText("Delete the sub-page too").click();
  await dlg.getByRole("button", { name: "Move to Trash" }).click();
  await p.waitForURL((u) => !u.pathname.endsWith(k1), { timeout: 20000 });
  for (const s of [k1, g1]) if ((await api("GET", `/api/v1/documents/${s}`, T.owner)).status !== 404) fail(`${s} not deleted`);
  if ((await api("GET", `/api/v1/documents/${k2}`, T.owner)).status !== 200) fail("sibling gone");
  // k1 and g1 went to the trash together and come back together.
  const t2 = (await api("GET", "/api/v1/trash", T.owner)).body;
  const tk = t2?.items?.find((i) => i.slug === k1);
  if (!tk || tk.sub_pages !== 1 || t2.items.some((i) => i.slug === g1)) fail(`k1's batch: ${JSON.stringify(t2?.items)}`);
  const rr = await api("POST", `/api/v1/trash/${g1}/restore`, T.owner);
  if (rr.status !== 200 || rr.body.items.map((i) => i.slug).join() !== [k1, g1].join()) fail(`batch restore ${rr.status} ${JSON.stringify(rr.body)}`);
  if ((await docOf(g1, T.owner)).parent?.slug !== k1) fail("restored grandchild lost its parent");
  await c.close();
});

/* ── 3b. trash: delete → toast Undo; delete → Trash page → Restore; the trashed link ── */
await step("trash", async () => {
  // Two items with the same title in one folder: a page and an HTML file (the Senseloaf incident).
  const title = "Product Docs Playbook";
  const page = (await api("POST", "/api/v1/pages", T.owner, { title, workspace: WS, folder: FOLDER })).body.document.slug;
  const adaMcp = mcpToken("ada@acme.test");
  const html = await mcp(adaMcp, "publish_page", {
    filename: "playbook.html", content: `<h1>${title}</h1>`, title, workspace: WS, folder: S.folder_slug || "guides" });
  const file = html.data?.slug;
  log("page", page, "file", file, html.isError ? html.text : "");
  const { c, p } = await ctx(browser, { token: T.owner });

  // Lists tell them apart: each row says its kind (the List view's Kind column; Grid and Cards say it too).
  await p.goto(`${APP}/w/${WS}/f/${FOLDER}`, { waitUntil: "networkidle" });
  const same = p.locator("#main [data-row-kind=item]", { hasText: title });
  await same.nth(1).waitFor({ timeout: 20000 });
  const kinds = (await same.allInnerTexts()).map((t) => (/HTML/.test(t) ? "file" : /\bPage\b/.test(t) ? "page" : "?")).sort();
  if (kinds.join() !== "file,page") fail(`same-title rows don't say their kind: ${JSON.stringify(await same.allInnerTexts())}`);
  await tshot(p, "t0-same-title-in-folder");

  // 1. The page's ⋯ menu: the dialog names exactly what goes; the toast's Undo brings it back.
  await p.goto(`${APP}/${page}?edit=1`, { waitUntil: "networkidle" });
  await p.locator(".pb-live .ProseMirror").waitFor({ timeout: 20000 });
  await p.getByRole("button", { name: "Page options" }).click();
  await p.getByRole("menuitem", { name: /Delete page/ }).click();
  const dlg = p.getByRole("dialog");
  await dlg.getByText(new RegExp(`/${page}`)).first().waitFor({ timeout: 10000 });
  await dlg.getByText(/30 days/).first().waitFor();
  await tshot(p, "t1-delete-dialog-page");
  await dlg.getByRole("button", { name: /Move to Trash/ }).click();
  await p.waitForURL((u) => !u.pathname.endsWith(page), { timeout: 20000 });
  const toast = p.locator(".md-toast", { hasText: /Moved\b.*\bto Trash/ });
  await toast.waitFor({ timeout: 10000 });
  await tshot(p, "t2-moved-to-trash-toast");
  await waitStatus(page, 404);
  if (file && (await api("GET", `/api/v1/documents/${file}`, T.owner)).status !== 200) fail("the same-title file went too");
  await toast.getByRole("button", { name: "Undo" }).click();
  await waitStatus(page, 200);
  log("undo → restored", p.url());

  // 2. Delete again (the dashboard row this time), then Trash → Restore.
  await p.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
  const row = p.locator("li", { hasText: page }).first();
  await row.waitFor({ timeout: 20000 });
  await row.getByRole("button", { name: /^Actions for/ }).click();
  await p.getByRole("menuitem", { name: /^Delete/ }).click();
  await dlg.getByText(new RegExp(`/${page}`)).first().waitFor({ timeout: 10000 });
  await tshot(p, "t3-delete-dialog-dashboard");
  await dlg.getByRole("button", { name: /Move to Trash/ }).click();
  await waitStatus(page, 404);

  // The trashed link: the owner sees "in the trash" with Restore; a reader gets the plain 404.
  await p.goto(`${APP}/${page}`, { waitUntil: "networkidle" });
  await p.getByText(/in the trash/i).first().waitFor({ timeout: 15000 });
  await tshot(p, "t4-trashed-link-owner");
  const rv = await ctx(browser, { token: T.reader });
  await rv.p.goto(`${APP}/${page}`, { waitUntil: "networkidle" });
  await rv.p.getByText("Nothing at this link").waitFor({ timeout: 15000 });
  if (await rv.p.getByText(/in the trash/i).count()) fail("a reader was told it's in the trash");
  await tshot(rv.p, "t5-trashed-link-reader");
  await rv.c.close();

  // The Trash page: what, where it was, who, when, days left; Restore.
  await p.goto(`${APP}/trash`, { waitUntil: "networkidle" });
  const trow = p.locator("li", { hasText: page }).first();
  await trow.waitFor({ timeout: 20000 });
  for (const want of [/days? left|Last day/i, /you|Ada/i]) await trow.getByText(want).first().waitFor();
  await tshot(p, "t6-trash-page", { full: true });
  await trow.getByRole("button", { name: /^Restore/ }).click();
  await waitStatus(page, 200);
  await p.locator(".md-toast", { hasText: /Restored/ }).waitFor({ timeout: 10000 });
  await tshot(p, "t7-restored");
  const back = await docOf(page, T.owner);
  if (back.folder_id !== FOLDER && back.folder?.id !== FOLDER && !(back.folder_path || []).length) log("restored placement", JSON.stringify({ f: back.folder_id, p: back.folder_path }));

  // Phone width.
  await mcp(adaMcp, "delete_document", { document: page });
  const ph = await ctx(browser, { token: T.owner, width: 390, height: 844 });
  await ph.p.goto(`${APP}/trash`, { waitUntil: "networkidle" });
  await ph.p.locator("li", { hasText: page }).first().waitFor({ timeout: 20000 });
  const over = await ph.p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 1) fail(`trash page overflows ${over}px at 390`);
  await tshot(ph.p, "t8-trash-390", { full: true });
  await ph.c.close();
  // Dark.
  const dk = await ctx(browser, { token: T.owner, theme: "dark" });
  await dk.p.goto(`${APP}/trash`, { waitUntil: "networkidle" });
  await dk.p.locator("li", { hasText: page }).first().waitFor({ timeout: 20000 });
  await tshot(dk.p, "t9-trash-dark");
  await dk.c.close();
  const r = await mcp(adaMcp, "restore_document", { document: page });
  if (r.isError) fail(`restore_document: ${r.text}`);

  // A folder with a page in it: the dialog counts what goes; Trash lists the folder; Restore brings both back.
  const fr = await api("POST", `/api/v1/workspaces/${WS}/folders`, T.owner, { name: "Old handbook", parent_id: FOLDER });
  if (fr.status !== 201) fail(`create folder → ${fr.status} ${JSON.stringify(fr.body)}`);
  const sub = fr.body.id;
  const inner = (await api("POST", "/api/v1/pages", T.owner, { title: "Handbook intro", workspace: WS, folder: sub })).body.document.slug;
  await p.goto(`${APP}/w/${WS}/f/${sub}`, { waitUntil: "networkidle" });
  await p.getByText("Handbook intro").first().waitFor({ timeout: 20000 });
  await p.getByRole("button", { name: "More folder actions" }).click();
  await p.getByRole("menuitem", { name: /Delete folder/ }).click();
  await dlg.getByText(/1 item/).first().waitFor({ timeout: 10000 });
  await dlg.getByText(/\/guides\/old-handbook/).first().waitFor();
  await tshot(p, "t10-delete-folder-dialog");
  await dlg.getByRole("button", { name: /Move to Trash/ }).click();
  await p.locator(".md-toast", { hasText: /to Trash/ }).first().waitFor({ timeout: 10000 });
  await waitStatus(inner, 404);
  await p.goto(`${APP}/trash`, { waitUntil: "networkidle" });
  const frow = p.locator("li", { hasText: "Old handbook" }).first();
  await frow.waitFor({ timeout: 20000 });
  await tshot(p, "t11-trash-folder", { full: true });
  await frow.getByRole("button", { name: /^Restore/ }).click();
  await waitStatus(inner, 200);
  const fb = await docOf(inner, T.owner);
  if (!(fb.folder_path || []).join("/").endsWith("old-handbook")) fail(`restored folder item placement: ${JSON.stringify(fb.folder_path)}`);
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
  // A member on the domain may land in the editor (domain editing): the reader view or the editor.
  await p.waitForTimeout(1500);
  const body = await p.locator(".pb-page, .pb-live").first().innerText({ timeout: 30000 });
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
  // auto_cover: false — this step adds its own cover (a new page otherwise gets an automatic one).
  const mk = await api("POST", "/api/v1/pages", T.owner, { title: "Properties", workspace: WS, folder: FOLDER, auto_cover: false });
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

/* ── 9b. a classic (Markdown) document has one top bar, like a page: in view details (framed), in the
   editor and behind a gate, on markdrop.in and on the workspace's domain, wide and on a phone; the
   bar keeps Share, ⋯ (Export PDF, Copy link, Details, Request edit access, General access on
   markdrop.in), presence and Edit; its sidebar toggle hides the Contents and Details rails ── */
await step("classic-onebar", async () => {
  const md = "# Release notes\n\nWhat changed this week.\n\n## Highlights\n\n- One top bar\n\n## Fixes\n\nMore notes.\n\n## Next\n\nThe docs.\n";
  const made = await api("POST", "/api/v1/documents", T.owner, { content: md, title: "Release notes", expires_in: "never", access_level: "link", workspace: WS, folder: FOLDER });
  if (made.status !== 201) fail(`create classic → ${made.status} ${JSON.stringify(made.body)}`);
  const slug = made.body.slug;
  const one = async (p, where) => {
    const bars = await topBars(p);
    if (bars.length !== 1) fail(`${where}: ${bars.length} top bars (${bars.join(" | ")}), want exactly one`);
    if (!(await p.locator("header.md-docbar").isVisible())) fail(`${where}: the one bar isn't the document's bar`);
  };
  const details = async (p) => {
    await p.getByRole("button", { name: "Show details" }).click({ timeout: 20000 });
    await p.locator("header.md-docbar").waitFor({ timeout: 20000 });
    await p.waitForTimeout(600);
  };
  const menuItems = async (p) => {
    await p.locator("header.md-docbar").getByRole("button", { name: "More actions" }).click();
    const items = await p.getByRole("menuitem").allInnerTexts();
    await p.keyboard.press("Escape");
    await p.waitForTimeout(200);
    return items.join(" · ");
  };

  // The owner on markdrop.in, wide: view details, then the editor.
  for (const width of [1440, 390]) {
    const { c, p } = await ctx(browser, { token: T.owner, width, height: width < 500 ? 844 : 900, mobile: width < 500 });
    await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
    if ((await topBars(p)).length !== 0) fail(`full screen (${width}) has a top bar`);
    await details(p);
    await p.mouse.wheel(0, 400);
    await p.waitForTimeout(400);
    await one(p, `owner view details ${width}`);
    await shot(p, `42-classic-details-${width}`);
    const bar = p.locator("header.md-docbar");
    if (width > 500) {
      for (const name of ["Share", "Edit", "Read full screen", "More actions"]) {
        if (!(await bar.getByRole("button", { name, exact: true }).isVisible())) fail(`the bar has no ${name}`);
      }
      const items = await menuItems(p);
      for (const want of ["Copy link", "Export PDF", "Details"]) if (!items.includes(want)) fail(`⋯ lacks ${want}: ${items}`);
      // The sidebar toggle hides both rails (and Contents moves into the bar), remembered, ⌘\ brings them back.
      const rails = () => p.locator("aside.md-docrail:visible").count();
      if ((await rails()) !== 2) fail(`expected the Contents and Details rails, saw ${await rails()}`);
      await bar.getByRole("button", { name: "Hide the sidebar" }).click();
      await p.waitForTimeout(300);
      if ((await rails()) !== 0) fail("the toggle didn't hide the rails");
      if (!(await bar.getByRole("button", { name: /Contents/ }).isVisible())) fail("no Contents in the bar with the rails hidden");
      await p.reload({ waitUntil: "networkidle" });
      await details(p);
      if ((await rails()) !== 0) fail("hidden rails not remembered");
      await p.keyboard.press("ControlOrMeta+Backslash");
      await p.waitForTimeout(300);
      if ((await rails()) !== 2) fail("⌘\\ didn't bring the rails back");
      // The editor: the same bar, nothing above it.
      await bar.getByRole("button", { name: "Edit", exact: true }).click();
      await p.getByRole("button", { name: /Save changes/ }).waitFor({ timeout: 20000 });
      await one(p, "owner editing");
      await shot(p, "43-classic-editing");
    } else {
      // Phones: ⋯ is a sheet with Share first; the bottom action bar is still there.
      await bar.getByRole("button", { name: "More actions" }).click();
      await p.getByRole("dialog").getByRole("menuitem", { name: "Share" }).waitFor({ timeout: 10000 });
      await p.keyboard.press("Escape");
      if (!(await p.getByRole("button", { name: "Copy link" }).last().isVisible())) fail("no Copy link on the phone's bottom bar");
      const sw = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (sw > 0) fail(`the phone scrolls sideways by ${sw}px`);
    }
    await c.close();
  }

  // A workspace viewer: Request edit access in ⋯, presence of the owner in the bar.
  const o = await ctx(browser, { token: T.owner });
  await o.p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  const r = await ctx(browser, { token: T.reader });
  await r.p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  await details(r.p);
  await one(r.p, "reader view details");
  const ritems = await menuItems(r.p);
  if (!/Request edit access/.test(ritems)) fail(`a viewer's ⋯ lacks Request edit access: ${ritems}`);
  await r.p.locator("header.md-docbar .pb-bar__presence").waitFor({ timeout: 15000 });
  await shot(r.p, "44-classic-reader-presence");
  await r.c.close();
  await o.c.close();

  // The workspace's domain: anonymous, then the owner (General access on markdrop.in in ⋯).
  const d = await docOf(slug, T.owner);
  const addr = `${TENANT}/${[...(d.folder_path || []), slug].join("/")}`;
  await fetch(`${APP}/api/revalidate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: "host:acme.localhost" }) });
  for (const width of [1440, 390]) {
    const a = await ctx(browser, { width, height: width < 500 ? 844 : 900, mobile: width < 500 });
    await a.p.goto(addr, { waitUntil: "networkidle" });
    await details(a.p);
    await one(a.p, `tenant anonymous ${width}`);
    if (await a.p.locator("header.md-docbar .md-logo").count()) fail("Markdrop's logo on the workspace's domain");
    await shot(a.p, `45-classic-tenant-${width}`);
    await a.c.close();
  }
  // A classic document opens full screen: sign in from the view details' bar.
  const to = await ctx(browser, { token: T.owner });
  await to.p.goto(`${APP}/robots.txt`);
  await to.p.goto(addr, { waitUntil: "networkidle" });
  await details(to.p);
  await to.p.locator("header.md-docbar").getByRole("link", { name: /Sign in/ }).or(to.p.locator("header.md-docbar").getByRole("button", { name: /Sign in/ })).first().click();
  await to.p.waitForURL((u) => u.hostname === "acme.localhost" && !u.hash.includes("mdt="), { timeout: 30000 }).catch(() => {});
  await to.p.waitForLoadState("networkidle");
  await details(to.p);
  await one(to.p, "tenant owner");
  await to.p.locator("header.md-docbar").getByRole("button", { name: "More actions" }).click();
  await to.p.getByRole("menuitem", { name: /General access on markdrop\.in/ }).or(to.p.getByRole("link", { name: /General access on markdrop\.in/ })).waitFor({ timeout: 10000 });
  await shot(to.p, "46-classic-tenant-owner-menu");
  await to.c.close();

  // Behind a password: the gate under the one bar (the slug and a Password badge).
  const locked = await api("POST", "/api/v1/documents", T.owner, { content: md, title: "Locked notes", expires_in: "never", read_password: "open sesame" });
  if (locked.status !== 201) fail(`create locked → ${locked.status}`);
  const g = await ctx(browser);
  await g.p.goto(`${APP}/${locked.body.slug}`, { waitUntil: "networkidle" });
  await g.p.getByLabel(/Password/).first().waitFor({ timeout: 20000 });
  await one(g.p, "password gate");
  if (!(await g.p.locator("header.md-docbar").getByText("Password", { exact: true }).isVisible())) fail("no Password badge in the gate's bar");
  await shot(g.p, "47-classic-gate");
  await g.c.close();
});

/* ── 9c. a file (artifact) has one top bar too: in its framed view ("Show details"), on markdrop.in
   and on the workspace's domain, wide and on a phone, as the owner and anonymously; the file stays in
   its sandboxed frame on the artifact origin; the bar keeps Share or Copy link, Download, full screen,
   presence and ⋯ (Copy link, Settings, Report, General access on markdrop.in on the domain) ── */
await step("artifact-onebar", async () => {
  // Pricing calculator (HTML) and the Q3 report (PDF), opened up to anyone with the link.
  for (const s of ["pricing-calc", "q3-report"]) {
    const r = await api("PUT", `/api/v1/documents/${s}/access/level`, T.owner, { level: "link" });
    if (r.status !== 204) fail(`access level ${s} → ${r.status}`);
  }
  const SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";
  const bar = (p) => p.locator("header.md-artbar");
  const details = async (p) => {
    await p.getByRole("button", { name: "Show details" }).click({ timeout: 25000 });
    await bar(p).waitFor({ timeout: 20000 });
    await p.locator("main iframe").first().waitFor({ timeout: 25000 });
    await p.waitForTimeout(800);
  };
  const one = async (p, where) => {
    const l = await fileLayout(p);
    if (l.bars.length !== 1) fail(`${where}: ${l.bars.length} top bars (${l.bars.join(" | ")}), want exactly one`);
    if (l.headers.length !== 1 || !(await bar(p).isVisible())) fail(`${where}: headers on screen: ${l.headers.join(", ")} (want the file's bar alone)`);
    if (l.gap == null || l.gap > 32) fail(`${where}: the file starts ${l.gap}px under the bar (a second bar between them?)`);
    // The file is still in its isolated, sandboxed frame on the artifact origin.
    const f = await p.locator("main iframe").first().evaluate((el) => ({ src: el.src, sandbox: el.getAttribute("sandbox"), ref: el.referrerPolicy }));
    if (new URL(f.src).origin !== new URL(WORKER).origin) fail(`${where}: the frame isn't on the artifact origin: ${f.src}`);
    if (f.sandbox !== SANDBOX || f.ref !== "no-referrer") fail(`${where}: the frame's sandbox changed: ${f.sandbox} / ${f.ref}`);
  };
  const menuItems = async (p) => {
    await bar(p).getByRole("button", { name: "More artifact actions" }).click();
    await p.getByRole("menuitem").first().waitFor({ timeout: 10000 });
    const items = await p.getByRole("menuitem").allInnerTexts();
    const head = await p.locator(".md-menu__header, .pb-sheetmenu__header").first().innerText().catch(() => "");
    await p.keyboard.press("Escape");
    await p.waitForTimeout(250);
    return `${head} | ${items.join(" · ")}`;
  };

  // The owner on markdrop.in.
  for (const width of [1440, 390]) {
    const { c, p } = await ctx(browser, { token: T.owner, width, height: width < 500 ? 844 : 900, mobile: width < 500 });
    await p.goto(`${APP}/pricing-calc`, { waitUntil: "networkidle" });
    await p.getByRole("button", { name: "Show details" }).waitFor({ timeout: 25000 });
    if ((await topBars(p)).length !== 0) fail(`full screen (${width}) has a top bar`);
    await details(p);
    await one(p, `owner file ${width}`);
    await shot(p, `48-file-owner-${width}`);
    if (width > 500) {
      for (const name of ["Share", "Download", "Read full screen", "More artifact actions"]) {
        if (!(await bar(p).getByRole("button", { name, exact: true }).isVisible())) fail(`the file's bar has no ${name}`);
      }
      const items = await menuItems(p);
      for (const want of ["Copy link", "Settings", "Delete artifact", "views"]) if (!items.includes(want)) fail(`⋯ lacks ${want}: ${items}`);
      // Settings still holds the versions.
      await bar(p).getByRole("button", { name: "More artifact actions" }).click();
      await p.getByRole("menuitem", { name: /Settings/ }).click();
      await p.getByRole("dialog", { name: "Artifact settings" }).getByText(/Versions/).first().waitFor({ timeout: 15000 });
      await p.keyboard.press("Escape");
      await p.waitForTimeout(400);
      // Full screen and back.
      await bar(p).getByRole("button", { name: "Read full screen" }).click();
      await p.waitForTimeout(600);
      if ((await topBars(p)).length !== 0) fail("full screen from the bar still shows a bar");
      await p.keyboard.press("Escape");
      await bar(p).waitFor({ timeout: 10000 });
      await one(p, "owner after full screen");
    } else {
      // Phones: ⋯ is a sheet with Share first; Copy link and Download are on the bottom dock.
      await bar(p).getByRole("button", { name: "More artifact actions" }).click();
      await p.getByRole("dialog").getByRole("menuitem", { name: "Share" }).waitFor({ timeout: 10000 });
      await p.keyboard.press("Escape");
      const dock = p.getByRole("toolbar", { name: "Artifact actions" });
      for (const name of ["Copy link", "Download"]) if (!(await dock.getByRole("button", { name }).isVisible())) fail(`no ${name} on the phone's dock`);
      const sw = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (sw > 0) fail(`the phone scrolls sideways by ${sw}px`);
    }
    await c.close();
  }

  // Anonymous on markdrop.in: Copy link in the bar, Report in ⋯, Sign in.
  for (const width of [1440, 390]) {
    const { c, p } = await ctx(browser, { width, height: width < 500 ? 844 : 900, mobile: width < 500 });
    await p.goto(`${APP}/q3-report`, { waitUntil: "networkidle" });
    await details(p);
    await one(p, `anonymous file ${width}`);
    await shot(p, `49-file-anon-${width}`);
    if (width > 500) {
      if (!(await bar(p).getByRole("button", { name: "Copy link" }).isVisible())) fail("no Copy link in an anonymous reader's bar");
      if (!(await bar(p).getByRole("button", { name: "Download", exact: true }).isVisible())) fail("no Download in an anonymous reader's bar");
      if (!(await bar(p).getByRole("link", { name: /Sign in/ }).or(bar(p).getByRole("button", { name: /Sign in/ })).first().isVisible())) fail("no Sign in in the bar");
      const items = await menuItems(p);
      if (!items.includes("Report")) fail(`an anonymous reader's ⋯ lacks Report: ${items}`);
    }
    await c.close();
  }

  // Who's viewing: the owner has it open; a reader sees them in the bar.
  const o = await ctx(browser, { token: T.owner });
  await o.p.goto(`${APP}/pricing-calc`, { waitUntil: "networkidle" });
  const r = await ctx(browser, { token: T.reader });
  await r.p.goto(`${APP}/pricing-calc`, { waitUntil: "networkidle" });
  await details(r.p);
  await one(r.p, "reader file");
  await r.p.locator("header.md-artbar .pb-bar__presence").waitFor({ timeout: 15000 });
  await r.c.close();
  await o.c.close();

  // The workspace's domain: anonymous at both widths (its logo, never Markdrop's), then the owner.
  const d = await docOf("pricing-calc", T.owner);
  const addr = `${TENANT}/${[...(d.folder_path || []), "pricing-calc"].join("/")}`;
  await fetch(`${APP}/api/revalidate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: "host:acme.localhost" }) });
  for (const width of [1440, 390]) {
    const a = await ctx(browser, { width, height: width < 500 ? 844 : 900, mobile: width < 500 });
    await a.p.goto(addr, { waitUntil: "networkidle" });
    await details(a.p);
    await one(a.p, `tenant anonymous file ${width}`);
    if (await bar(a.p).locator(".md-logo").count()) fail("Markdrop's logo on the workspace's domain");
    await shot(a.p, `50-file-tenant-${width}`);
    await a.c.close();
  }
  const to = await ctx(browser, { token: T.owner });
  await to.p.goto(`${APP}/robots.txt`);
  await to.p.goto(addr, { waitUntil: "networkidle" });
  await details(to.p);
  // Sign in from the bar: a hop to markdrop.in's handoff and back with a token for the domain.
  await Promise.all([
    to.p.waitForURL((u) => u.hostname !== "acme.localhost", { timeout: 20000 }).catch(() => {}),
    bar(to.p).getByRole("link", { name: /Sign in/ }).or(bar(to.p).getByRole("button", { name: /Sign in/ })).first().click(),
  ]);
  await to.p.waitForURL((u) => u.hostname === "acme.localhost", { timeout: 30000 });
  await to.p.waitForLoadState("networkidle");
  await details(to.p);
  await bar(to.p).getByRole("button", { name: "Share", exact: true }).waitFor({ timeout: 20000 });
  await one(to.p, "tenant owner file");
  await bar(to.p).getByRole("button", { name: "More artifact actions" }).click();
  await to.p.getByRole("menuitem", { name: /General access on markdrop\.in/ }).or(to.p.getByRole("link", { name: /General access on markdrop\.in/ })).waitFor({ timeout: 10000 });
  await shot(to.p, "51-file-tenant-owner-menu");
  await to.c.close();

  // Behind a password: the gate, then the file under one bar.
  const html = Buffer.from("<!doctype html><meta charset=utf-8><title>Locked page</title><h1>Locked page</h1>");
  const locked = await uploadFile(T.owner, { bytes: html, filename: "locked.html", mime: "text/html", title: "Locked page", read_password: "open sesame" });
  const g = await ctx(browser);
  await g.p.goto(`${APP}/${locked.slug}`, { waitUntil: "networkidle" });
  await g.p.getByLabel(/Password/).first().fill("open sesame");
  await g.p.keyboard.press("Enter");
  await details(g.p);
  await one(g.p, "file behind a password");
  await g.c.close();
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
  const r = await api("POST", "/api/v1/pages", T.owner, { title: "Notion parity", workspace: WS, folder: FOLDER, auto_cover: false });
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
  // The `@` picker (docs-editor/menus/people.tsx): type to filter, Enter picks.
  await p.locator(".dxe-people [role=option]").first().waitFor({ timeout: 10000 });
  await p.keyboard.type("ben");
  await p.locator(".dxe-people [role=option]", { hasText: "Ben Member" }).first().waitFor();
  await p.keyboard.press("Enter");
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
