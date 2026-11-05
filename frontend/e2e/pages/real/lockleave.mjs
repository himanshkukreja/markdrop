/**
 * An editor that leaves lets go of the page's edit lock at once (fix/lock-release-on-leave), on the
 * REAL stack, in Chromium and WebKit:
 *
 *   - "Add a sub-page" in the editor, then the new sub-page opens: the parent is free right away;
 *   - typing, then going to another page in the app (client-side): free right away;
 *   - typing, then closing the tab: free within seconds (the close beacon, with the lock's
 *     release token); the browser closing without running any script (a killed tab): free within
 *     page_lock_gone_s (the holder's live socket closed) instead of two minutes;
 *   - on the workspace's own domain: the same;
 *   - an AI app's write right after each goes through.
 *
 *   PB_STACK_ID=54 PB_WORK=… [BROWSER=webkit] [ONLY=subpage,close] node lockleave.mjs
 */
import { APP, TENANT, log, fail, reseed, seedNow, api, mcp, mcpToken, docOf, launch, ctx, stepper, waitSaved } from "./lib.mjs";

const S = process.env.NO_RESEED ? seedNow() : reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const browser = await launch();
const { step, results } = stepper(browser);
const ada = mcpToken("ada@acme.test");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timers = (await api("GET", `/api/v1/documents/${(await api("POST", "/api/v1/pages", T.owner, { title: "Timers", workspace: S.ws, folder: S.folder, content: "x\n", auto_cover: false })).body.document.slug}/lock`, T.owner)).body?.timers;
log("lock timers", JSON.stringify(timers));

const newPage = async (title, body = "# Notes\n\nFirst line.\n") =>
  (await api("POST", "/api/v1/pages", T.owner, { title, workspace: S.ws, folder: S.folder, content: body, auto_cover: false })).body.document.slug;
/** Who holds the page (GET …/lock takes nothing). */
const holder = async (slug) => (await api("GET", `/api/v1/documents/${slug}/lock`, T.admin)).body?.holder?.name ?? null;
/** Free within `ms`: how long it took. */
async function freeWithin(slug, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const h = await holder(slug);
    if (!h) {
      log(`${what}: free after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      return Date.now() - t0;
    }
    if (Date.now() - t0 > ms) fail(`${what}: the lock is still ${h}'s after ${ms / 1000} s`);
    await sleep(250);
  }
}
async function waitHolder(slug, name, ms = 10000) {
  const t0 = Date.now();
  while ((await holder(slug)) !== name) {
    if (Date.now() - t0 > ms) fail(`${name} never took the lock of ${slug}`);
    await sleep(250);
  }
}
/** An AI app's write right after: goes through. */
async function mcpWrites(slug, text) {
  const d = await docOf(slug, T.owner);
  const r = await mcp(ada, "update_page", { document: slug, markdown: `${d.content.replace(/\s+$/, "")}\n\n${text}\n`, base_rev: d.rev });
  if (r.isError) fail(`an AI app's write right after was refused: ${r.text.slice(0, 300)}`);
}
async function openEditor(p, url) {
  await p.goto(url, { waitUntil: "networkidle" });
  await p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 30000 });
  await p.waitForTimeout(1000);
}
async function typeAtEnd(p, text) {
  await p.locator(".pb-live .ProseMirror > p").last().click();
  await p.keyboard.press("End");
  await p.keyboard.press("Enter");
  await p.keyboard.type(text);
}
/** Every lock request the page sends (and when), to say which action took it. */
function lockLog(p) {
  const out = [];
  p.on("request", (r) => {
    if (/\/lock(\?|$)/.test(r.url()) && r.method() === "POST") out.push(`${new Date().toISOString().slice(17, 23)} ${r.url().split("/documents/")[1]}`);
  });
  return out;
}
async function tenantSignIn(p, addr) {
  await fetch(`${APP}/api/revalidate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: "host:acme.localhost" }) });
  await p.goto(`${APP}/robots.txt`);
  await p.goto(addr, { waitUntil: "networkidle" });
  const signIn = p.getByRole("button", { name: /Sign in to read/ }).or(p.getByRole("link", { name: /Sign in to read/ }))
    .or(p.getByRole("link", { name: /^Sign in$/ })).or(p.getByRole("button", { name: /^Sign in$/ }));
  if (await signIn.count()) {
    await signIn.first().click({ timeout: 20000 });
    await p.waitForURL((u) => u.hostname === "acme.localhost" && !u.hash.includes("mdt="), { timeout: 30000 }).catch(() => {});
    await p.waitForLoadState("networkidle");
  }
}
const tenantAddr = async (slug) => {
  const d = await docOf(slug, T.owner);
  return `${TENANT}/${[...(d.folder_path || []), slug].join("/")}`;
};
/** How soon a close beacon must have let go; a close that ran no script waits for the socket check. */
const BEACON_MS = 4000;
const GONE_MS = ((timers?.gone_s ?? 8) + 6) * 1000;

/* ── "Add a sub-page" in the editor: the parent is free as soon as the sub-page opens ── */
for (const typed of [false, true]) {
  await step(typed ? "subpage-typed" : "subpage", async () => {
    const parent = await newPage(`Parent ${typed ? "typed" : "untouched"}`);
    const { p } = await ctx(browser, { token: T.owner });
    const locks = lockLog(p);
    await openEditor(p, `${APP}/${parent}?edit=1`);
    if (typed) {
      await typeAtEnd(p, "Typed before adding a sub-page.");
      await waitHolder(parent, "Ada Owner");
    }
    await p.getByRole("button", { name: "Add a sub-page" }).first().click();
    const dlg = p.getByRole("dialog");
    await dlg.getByText("Meeting notes", { exact: true }).click();
    await dlg.getByLabel("Title").fill("Child");
    await dlg.getByRole("button", { name: "Create page" }).click();
    await p.waitForURL((u) => !u.pathname.endsWith(`/${parent}`) && u.search.includes("edit=1"), { timeout: 30000 });
    await p.locator(".pb-live .ProseMirror").waitFor();
    log("lock requests:", locks.join(" | ") || "none");
    await freeWithin(parent, BEACON_MS, "parent after the sub-page opened");
    if (typed && !(await docOf(parent, T.owner)).content.includes("Typed before adding a sub-page.")) fail("what was typed before leaving wasn't saved");
    await mcpWrites(parent, "AI after the sub-page.");
  });
}

/* ── typing, then another page in the app (client-side navigation): once the lock is taken, and
   straight after the last key (before the editor even handed the text up) ── */
for (const quick of [false, true]) {
  await step(quick ? "navigate-quick" : "navigate", async () => {
    const slug = await newPage(quick ? "Navigate at once" : "Navigate away");
    const text = quick ? "Typed, and away at once." : "Typed, then I went to the folder.";
    const { p } = await ctx(browser, { token: T.owner });
    const calls = [];
    p.on("request", (r) => { if (r.url().includes(`/documents/${slug}`) && r.method() !== "GET") calls.push(`${new Date().toISOString().slice(17, 23)} ${r.method()} ${r.url().split(slug)[1] || "/"}`); });
    await openEditor(p, `${APP}/${slug}?edit=1`);
    await typeAtEnd(p, text);
    if (!quick) await waitHolder(slug, "Ada Owner");
    // Through the app (the page's breadcrumb, a client-side link), before the autosave ran: what's
    // typed is saved on the way out, then the lock goes.
    const from = p.url();
    await p.evaluate(() => { window.__still = true; });
    await p.locator(".pb-crumbs a").first().click();
    await p.waitForURL((u) => u.href !== from, { timeout: 30000 });
    if (!(await p.evaluate(() => window.__still === true))) fail("the breadcrumb loaded a new document (not client-side)");
    if (quick) await sleep(1500);
    await freeWithin(slug, BEACON_MS, "after going to the folder");
    log("calls:", calls.join(" | "));
    const md = (await docOf(slug, T.owner)).content;
    if (!md.includes(text)) fail(`unsaved text lost on the way out: ${JSON.stringify(md)}`);
    await mcpWrites(slug, "AI after navigating.");
  });
}

/* ── typing, then closing the tab (the close beacon) ── */
await step("close-tab", async () => {
  const slug = await newPage("Close the tab");
  const { c, p } = await ctx(browser, { token: T.owner });
  await c.newPage(); // the window stays open (another tab)
  await openEditor(p, `${APP}/${slug}?edit=1`);
  await typeAtEnd(p, "Typed, then I closed the tab.");
  await waitHolder(slug, "Ada Owner");
  await waitSaved(p);
  await p.close({ runBeforeUnload: true });
  await freeWithin(slug, BEACON_MS, "after closing the tab");
  await mcpWrites(slug, "AI after the tab closed.");
});

/* ── the browser goes away without running any script (killed): the socket check ── */
await step("killed", async () => {
  const slug = await newPage("Killed tab");
  const { c, p } = await ctx(browser, { token: T.owner });
  await openEditor(p, `${APP}/${slug}?edit=1`);
  await typeAtEnd(p, "Typed, then the browser died.");
  await waitHolder(slug, "Ada Owner");
  await waitSaved(p);
  // No pagehide, no beacon: drop the beacon route so only the socket check can let go.
  await c.route(/\/lock\/release$/, (r) => r.abort());
  await p.evaluate(() => {
    window.addEventListener("pagehide", (e) => e.stopImmediatePropagation(), { capture: true });
  });
  await c.close();
  const ms = await freeWithin(slug, GONE_MS, "after the browser went away");
  if (ms < 1000) log("(freed by a beacon anyway)");
  await mcpWrites(slug, "AI after the browser died.");
});

/* ── on the workspace's own domain: typing, then leaving; the owner's visit (menu, share) ── */
await step("tenant", async () => {
  const slug = await newPage("Domain page");
  await api("PUT", `/api/v1/documents/${slug}/access/level`, T.owner, { level: "link" });
  const addr = await tenantAddr(slug);
  const m = await ctx(browser, { token: T.member });
  await tenantSignIn(m.p, addr);
  await m.p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 30000 });
  await typeAtEnd(m.p, "Typed on the domain.");
  await waitHolder(slug, "Ben Member");
  await waitSaved(m.p);
  await m.p.close({ runBeforeUnload: true });
  await freeWithin(slug, BEACON_MS, "after closing the domain tab");
  await mcpWrites(slug, "AI after the domain tab closed.");
  await m.c.close();

  // The owner on the domain: opens the page, its menu, Share; types nothing: takes nothing.
  const o = await ctx(browser, { token: T.owner });
  const locks = lockLog(o.p);
  await tenantSignIn(o.p, addr);
  await o.p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 30000 });
  await o.p.waitForTimeout(2000);
  if (await holder(slug)) fail(`opening the page on the domain took the lock (${locks.join(" | ")})`);
  await o.p.getByRole("button", { name: /Page options|More options|^More$/ }).last().click({ timeout: 10000 });
  await o.p.waitForTimeout(500);
  await o.p.keyboard.press("Escape");
  await o.p.waitForTimeout(1500);
  if (await holder(slug)) fail(`the owner's menu took the lock (${locks.join(" | ")})`);
  await o.p.getByRole("button", { name: "Share", exact: true }).first().click({ timeout: 10000 });
  const dlg = o.p.getByRole("dialog");
  await dlg.getByPlaceholder("Add people by email").fill(`lockleave-${Date.now().toString(36)}@example.com`);
  await dlg.getByPlaceholder("Add people by email").press("Enter");
  await dlg.getByRole("button", { name: /^Share$/ }).click({ timeout: 10000 });
  await o.p.waitForTimeout(2000);
  log("owner lock requests:", locks.join(" | ") || "none");
  const h = await holder(slug);
  if (h) log(`(the owner's visit took the lock: ${h})`);
  await o.p.close({ runBeforeUnload: true });
  await freeWithin(slug, BEACON_MS, "after the owner closed the domain tab");
  await mcpWrites(slug, "AI after the owner left the domain.");
});

console.log(`\nResults (lock on leave, ${process.env.BROWSER || "chromium"}):`);
for (const [n, r] of results) console.log(`  ${r === "ok" ? "✓" : "✗"} ${n}: ${r}`);
await browser.close();
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
