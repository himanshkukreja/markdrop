/**
 * Idle editor tabs must not lock pages (fix/edit-lock-idle; Senseloaf 2026-11-05), on the REAL stack,
 * on markdrop.in and on the workspace's own domain:
 *
 *   - opening a page (and clicking in it) takes nothing: an AI app's writes go through;
 *   - typing takes the lock: other writers are refused with who / idle / unsaved / releases-in;
 *   - idle (no change) and hidden (tab in the background) release it; the next change takes it again;
 *   - Edit anyway (owner / admin) takes it over: the other editor is told and its unsaved text is kept
 *     in version history; an AI app's take_over: true does the same; a member gets no Edit anyway.
 *
 * Start the API with short lock timers (api_run.py; the editor reads them from the lock answers):
 *   PB_LOCK_IDLE_S=12 PB_LOCK_HIDDEN_S=6 PB_LOCK_TTL_S=20 zsh up.sh restart-api
 *   PB_STACK_ID=46 PB_WORK=… [BROWSER=webkit] node editlock.mjs
 */
import { APP, TENANT, log, fail, reseed, api, mcp, mcpToken, docOf, launch, ctx, shot, stepper, waitSaved } from "./lib.mjs";

const S = reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const browser = await launch();
const { step, results } = stepper(browser);
const ada = mcpToken("ada@acme.test");
const ben = mcpToken("ben@acme.test");

const newPage = async (title, body) =>
  (await api("POST", "/api/v1/pages", T.owner, { title, workspace: S.ws, folder: S.folder, content: body, auto_cover: false })).body.document.slug;
const content = async (slug) => (await docOf(slug, T.owner)).content;
const holder = async (slug) => (await api("GET", `/api/v1/documents/${slug}/lock`, T.owner)).body?.holder?.name ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHolder(slug, want, timeout = 40000) {
  const t0 = Date.now();
  for (;;) {
    const h = await holder(slug);
    if (h === want) return Date.now() - t0;
    if (Date.now() - t0 > timeout) fail(`lock holder is ${h}, waited for ${want}`);
    await sleep(500);
  }
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
/** Pretend the tab went to the background (or came back): what a browser does on a tab switch. */
const setHidden = (p, hidden) =>
  p.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
async function mcpAppend(slug, text, extra = {}) {
  const d = await docOf(slug, T.owner);
  return mcp(ada, "update_page", { document: slug, markdown: `${d.content.replace(/\s+$/, "")}\n\n${text}\n`, base_rev: d.rev, ...extra });
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

const timers = (await api("GET", `/api/v1/documents/${await newPage("Timers", "x\n")}/lock`, T.owner)).body?.timers;
log("lock timers", JSON.stringify(timers));
if (!timers || timers.idle_s > 30) fail("start the API with short lock timers (see the header)");

/** The core story, on markdrop.in or on the workspace's domain (`where`). */
async function story(where) {
  const slug = await newPage(`Feature register ${where}`, "# Feature register\n\nFirst line.\n");
  const d = await docOf(slug, T.owner);
  const url = where === "tenant" ? `${TENANT}/${[...(d.folder_path || []), slug].join("/")}` : `${APP}/${slug}?edit=1`;
  const b = await ctx(browser, { token: T.member });
  if (where === "tenant") await tenantSignIn(b.p, url);
  await openEditor(b.p, url);

  // 1. Open and idle (a click too): nothing is locked; an AI app's write goes through and shows up.
  await b.p.locator(".pb-live .ProseMirror p").first().click();
  await b.p.waitForTimeout(2500);
  if (await holder(slug)) fail("opening or clicking took the lock");
  let r = await mcpAppend(slug, "From AI one.");
  if (r.isError) fail(`MCP write refused while the page was only open: ${r.text}`);
  await b.p.getByText("From AI one.").waitFor({ timeout: 15000 });

  // 2. Typing takes it: a write is refused with who, how idle, unsaved, when it releases.
  await typeAtEnd(b.p, "Ben was here.");
  await waitHolder(slug, "Ben Member", 10000);
  await waitSaved(b.p);
  r = await mcpAppend(slug, "Nope.");
  log(`${where}: refused →`, r.text.slice(0, 200));
  if (!r.isError || r.data?.error !== "locked") fail(`write while typing wasn't refused as locked: ${r.text}`);
  if (r.data.holder?.name !== "Ben Member" || typeof r.data.idle_s !== "number" || typeof r.data.releases_in_s !== "number") fail(`refusal fields: ${JSON.stringify(r.data)}`);
  if (r.data.can_take_over !== true) fail("the page's owner should be offered take_over");
  if (!/Ben Member is editing this page \(.*\)\. It releases in about/.test(r.text)) fail(`refusal text: ${r.text}`);
  const rb = await mcp(ben, "get_page", { document: slug });
  if (rb.isError) fail(rb.text);

  // 3. Idle: no change for idle_s releases it (the tab stays open, in front).
  const idleMs = await waitHolder(slug, null, (timers.idle_s + timers.heartbeat_s + 10) * 1000);
  log(`${where}: released after ${(idleMs / 1000).toFixed(1)} s idle`);
  r = await mcpAppend(slug, "From AI two.");
  if (r.isError) fail(`write after idle release refused: ${r.text}`);
  await b.p.getByText("From AI two.").waitFor({ timeout: 15000 });
  // The next change takes it again, on top of what the AI wrote.
  await typeAtEnd(b.p, "Ben is back.");
  await waitHolder(slug, "Ben Member", 10000);
  await waitSaved(b.p);
  let md = await content(slug);
  for (const t of ["From AI one.", "Ben was here.", "From AI two.", "Ben is back."]) if (!md.includes(t)) fail(`missing ${t}: ${JSON.stringify(md)}`);
  if (md.includes("Nope.")) fail("a refused write landed");

  // 4. Hidden: the tab in the background releases it after hidden_s; back and typing takes it again.
  await setHidden(b.p, true);
  const hidMs = await waitHolder(slug, null, (timers.hidden_s + timers.heartbeat_s + 10) * 1000);
  log(`${where}: released ${(hidMs / 1000).toFixed(1)} s after the tab was hidden`);
  if (hidMs > (timers.idle_s - 1) * 1000) fail("hidden released no sooner than idle");
  await setHidden(b.p, false);
  await b.p.waitForTimeout(1500);
  if (await holder(slug)) fail("coming back took the lock without a change");
  await typeAtEnd(b.p, "Ben again.");
  await waitHolder(slug, "Ben Member", 10000);
  await waitSaved(b.p);
  await shot(b.p, `editlock-${where}-ben-editing`);
  return { slug, url, b };
}

await step("markdrop", async () => {
  const { slug, url, b } = await story("app");

  // 5. A member gets no Edit anyway; the banner says how idle and whether there are unsaved changes.
  // Ben's saves fail from now on (offline), so he has unsaved changes.
  await b.p.route(`**/api/v1/documents/${slug}`, (rt) => (rt.request().method() === "PUT" ? rt.abort() : rt.continue()));
  await typeAtEnd(b.p, "Unsaved words of Ben.");
  await b.p.waitForTimeout((timers.heartbeat_s + 1.5) * 1000);
  const r = await mcpAppend(slug, "Nope two.");
  if (!r.isError || r.data?.dirty !== true) fail(`the refusal doesn't say there are unsaved changes: ${JSON.stringify(r.data)}`);

  const w = await ctx(browser, { token: T.admin });
  await w.p.goto(url, { waitUntil: "networkidle" });
  const banner = w.p.locator(".pb-banner").filter({ hasText: "Ben Member" });
  await banner.waitFor({ timeout: 20000 });
  log("admin sees:", (await banner.innerText()).replace(/\s+/g, " "));
  const editAnyway = w.p.getByRole("button", { name: "Edit anyway" });
  await editAnyway.waitFor({ timeout: 20000 });
  await shot(w.p, "editlock-admin-sees-edit-anyway");

  // 6. Edit anyway: Wes has it; Ben is told and his unsaved text is in version history.
  await editAnyway.click();
  await w.p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 15000 });
  await waitHolder(slug, "Wes Admin", 10000);
  const told = b.p.locator(".pb-banner").filter({ hasText: "took over editing" });
  await told.waitFor({ timeout: 20000 });
  const tt = (await told.innerText()).replace(/\s+/g, " ");
  log("Ben sees:", tt);
  if (!/Wes Admin took over editing/.test(tt) || !/Version history \(version \d+\)/.test(tt)) fail(`Ben's notice: ${tt}`);
  await shot(b.p, "editlock-ben-taken-over");
  const n = Number(/version (\d+)/.exec(tt)[1]);
  const v = await api("GET", `/api/v1/documents/${slug}/versions/${n}`, T.owner);
  if (v.status !== 200 || !v.body.markdown.includes("Unsaved words of Ben.")) fail(`kept version ${n}: ${v.status} ${JSON.stringify(v.body).slice(0, 300)}`);
  if (!/took over editing/.test(v.body.event?.text || "")) fail(`kept version label: ${JSON.stringify(v.body.event)}`);
  if ((await content(slug)).includes("Unsaved words of Ben.")) fail("Ben's unsaved text went into the page itself");
  if (!(await b.p.locator('.pb-live .ProseMirror[contenteditable="false"]').count())) fail("Ben's editor isn't read only after the take-over");
  await b.p.unroute(`**/api/v1/documents/${slug}`);
  await typeAtEnd(w.p, "Wes took it.");
  await waitSaved(w.p);
  await b.p.getByText("Wes took it.").waitFor({ timeout: 15000 });
  await w.c.close();

  // 7. A member on someone else's edit: no Edit anyway. (Ada edits, Ben looks.)
  await waitHolder(slug, null, (timers.idle_s + timers.heartbeat_s + 10) * 1000);
  const a = await ctx(browser, { token: T.owner });
  await openEditor(a.p, url);
  await typeAtEnd(a.p, "Ada edits.");
  await waitHolder(slug, "Ada Owner", 10000);
  await b.p.reload({ waitUntil: "networkidle" });
  await b.p.locator(".pb-banner").filter({ hasText: "Ada Owner" }).waitFor({ timeout: 20000 });
  if (await b.p.getByRole("button", { name: "Edit anyway" }).count()) fail("a member was offered Edit anyway");

  // 8. An AI app's take_over: true (Ada's own app takes her editor's lock): her editor is told.
  const r2 = await mcpAppend(slug, "AI took over.", { take_over: true });
  if (r2.isError) fail(`take_over refused: ${r2.text}`);
  await a.p.locator(".pb-banner").filter({ hasText: "took over editing" }).waitFor({ timeout: 20000 });
  await a.p.getByText("AI took over.").waitFor({ timeout: 15000 });
  await shot(a.p, "editlock-ai-took-over");
  if (await holder(slug)) fail("an MCP take-over left a lock");
  // A member's app can't take over.
  await typeAtEnd(a.p, "Ada again.");
  await waitHolder(slug, "Ada Owner", 10000);
  const d = await docOf(slug, T.owner);
  const r3 = await mcp(ben, "update_page", { document: slug, markdown: d.content + "\nNo.\n", base_rev: d.rev, take_over: true });
  if (!r3.isError || r3.data?.error !== "take_over_forbidden") fail(`a member's take_over: ${r3.text}`);
});

await step("tenant", async () => {
  await story("tenant");
});

await browser.close();
console.log("\n" + results.map(([n, s, ms]) => `${s === "ok" ? "✓" : "✗"} ${n} ${s === "ok" ? "" : s} (${(ms / 1000).toFixed(1)} s)`).join("\n"));
process.exit(results.some(([, s]) => s !== "ok") ? 1 : 0);
