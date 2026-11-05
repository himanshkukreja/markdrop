/**
 * Working together on a page (fix/collab-audit), on the REAL stack: two people in two browser
 * contexts, and AI apps writing through the hosted MCP endpoint, on one page at once.
 *
 *   PB_STACK_ID=48 PB_WORK=… [BROWSER=webkit] [ONLY=a,b] node collab.mjs
 *
 * Every step states what SHOULD happen; a failure is a collaboration bug (see
 * .work/collab-audit/REPORT.md). The edit lock itself is fix/edit-lock-idle's; the steps that
 * need it out of the way expire it in the database (a laptop that slept past the lock's TTL).
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { APP, TENANT, STACK, STACK_ID, log, fail, reseed, api, mcp, mcpToken, docOf, launch, ctx, stepper, shot, waitSaved } from "./lib.mjs";

const S = reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const ID = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.id]));
const BEN_MCP = mcpToken("ben@acme.test");
const ADA_MCP = mcpToken("ada@acme.test");
const browser = await launch();
const { step, results } = stepper(browser);
const run = Date.now().toString(36).slice(-5);
const ROOT_PY = "/Users/himanshukukreja/markdrop/backend/.venv/bin/python";

const BODY = "Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.\n";

async function newPage(title, content = BODY, as = "owner") {
  const r = await api("POST", "/api/v1/pages", T[as], { title, workspace: S.ws, folder: S.folder, content, auto_cover: false });
  if (r.status >= 300) fail(`create ${title} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body.document.slug;
}
const doc = (slug) => docOf(slug, T.owner);
const content = async (slug) => (await doc(slug)).content;
const editor = (p) => p.locator('.pb-live .ProseMirror[contenteditable="true"]');
const edText = (p) => p.locator(".pb-live .ProseMirror").innerText();

async function open(p, url) {
  await p.goto(url, { waitUntil: "networkidle" });
  await editor(p).waitFor({ timeout: 30000 });
  await p.waitForTimeout(1200);
}
async function caretAfter(p, at) {
  await p.locator(".pb-live .ProseMirror").getByText(at, { exact: false }).first().click();
  await p.waitForTimeout(250);
  await p.keyboard.press("End");
}
/** Wait until the editor shows `text` (true) or `ms` passes (false). */
async function shows(p, text, ms = 10000) {
  try {
    await p.locator(".pb-live .ProseMirror").getByText(text, { exact: false }).first().waitFor({ timeout: ms });
    return true;
  } catch {
    return false;
  }
}
async function until(fn, ms = 15000, every = 300) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return v;
    await new Promise((r) => setTimeout(r, every));
  }
}
/** Mongo, directly (the stack's own database). */
function mongo(js) {
  const code = `import json,sys\nfrom datetime import datetime,timezone,timedelta\nfrom pymongo import MongoClient\ndb=MongoClient("mongodb://127.0.0.1:27019")["markdrop_docs_demo_${STACK_ID}"]\n${js}`;
  return execFileSync(ROOT_PY, ["-c", code], { encoding: "utf8" }).trim();
}
/** The lock's TTL ran out (a laptop asleep for minutes): nobody holds the page any more. */
const expireLock = (slug) => mongo(`db["documents"].update_one({"slug": ${JSON.stringify(slug)}, "edit_lock": {"$ne": None}}, {"$set": {"edit_lock.expires_at": datetime.now(timezone.utc) - timedelta(seconds=5)}})`);
const banner = (p) => p.locator(".pb-banner, [role=alert]").allInnerTexts().then((t) => t.join(" | "));

/* ── 1. An AI app rewrites the page while someone has it open (not typing) ── */
await step("mcp-while-open", async () => {
  const slug = await newPage(`MCP while open ${run}`);
  const { p } = await ctx(browser, { token: T.owner });
  await open(p, `${APP}/${slug}`);
  const d = await doc(slug);
  const r = await mcp(BEN_MCP, "update_page", { document: slug, markdown: (d.content).replace("Beta paragraph.", "Beta rewritten by AI."), base_rev: d.rev });
  if (r.isError) fail(`update_page: ${r.text}`);
  if (!(await shows(p, "Beta rewritten by AI.", 8000))) fail("the open editor never showed the AI's change");
  await caretAfter(p, "Alpha paragraph.");
  await p.keyboard.type(" Ada was here.");
  await waitSaved(p);
  const c = await content(slug);
  if (!c.includes("Ada was here.")) fail("Ada's edit didn't save");
  if (!c.includes("Beta rewritten by AI.")) fail("Ada's save dropped the AI's change");
});

/* ── 2. The socket was down when the page changed (sleep, Wi-Fi): the editor catches up ── */
await step("catch-up-after-offline", async () => {
  const slug = await newPage(`Catch up ${run}`);
  const { c, p } = await ctx(browser, { token: T.owner });
  await open(p, `${APP}/${slug}`);
  await c.setOffline(true);
  await p.waitForTimeout(1500);
  const d = await doc(slug);
  const r = await mcp(BEN_MCP, "update_page", { document: slug, markdown: d.content.replace("Gamma paragraph.", "Gamma changed while you slept."), base_rev: d.rev });
  if (r.isError) fail(`update_page: ${r.text}`);
  await p.waitForTimeout(1500);
  await c.setOffline(false);
  if (!(await shows(p, "Gamma changed while you slept.", 20000))) fail("after reconnecting, the editor still shows the old page");
});

/* ── 3. Typed while offline, someone else changed another paragraph meanwhile: both kept ── */
await step("offline-edit-merge", async () => {
  const slug = await newPage(`Offline edit ${run}`);
  const { c, p } = await ctx(browser, { token: T.owner });
  await open(p, `${APP}/${slug}`);
  await caretAfter(p, "Alpha paragraph.");
  await p.keyboard.type(" First.");
  await waitSaved(p);
  await c.setOffline(true);
  await p.waitForTimeout(500);
  await p.keyboard.type(" Typed offline.");
  await p.waitForTimeout(3000);
  expireLock(slug);
  const d = await doc(slug);
  const r = await mcp(BEN_MCP, "update_page", { document: slug, markdown: d.content.replace("Gamma paragraph.", "Gamma by Ben's AI."), base_rev: d.rev });
  if (r.isError) fail(`update_page (lock expired) refused: ${r.text}`);
  await c.setOffline(false);
  const ok = await until(async () => {
    const x = await content(slug);
    return x.includes("Typed offline.") && x.includes("Gamma by Ben's AI.");
  }, 25000);
  const x = await content(slug);
  await shot(p, "c03-offline-merge");
  if (!ok) fail(`after reconnecting: server has offline text=${x.includes("Typed offline.")}, AI change=${x.includes("Gamma by Ben's AI.")}; banner: ${await banner(p)}`);
  if (!(await shows(p, "Gamma by Ben's AI.", 5000))) fail("the editor doesn't show the AI's change after the merge");
});

/* ── 4. A save meets a newer version that changed other lines: merged, no question ── */
await step("conflict-merge", async () => {
  const slug = await newPage(`Conflict ${run}`);
  const { p } = await ctx(browser, { token: T.owner });
  await open(p, `${APP}/${slug}`);
  // Ben's change lands while Ada's socket hears nothing (simulates a missed event): write directly.
  await caretAfter(p, "Alpha paragraph.");
  await p.keyboard.type(" A");
  await waitSaved(p);
  expireLock(slug);
  // A change straight in the database bumps rev without telling anyone (a missed event).
  mongo(`d=db["documents"].find_one({"slug": ${JSON.stringify(slug)}}); db["documents"].update_one({"_id": d["_id"]}, {"$set": {"content": d["content"].replace("Gamma paragraph.", "Gamma edited elsewhere.")}, "$inc": {"rev": 1}})`);
  await p.keyboard.type("B");
  const ok = await until(async () => {
    const x = await content(slug);
    return x.includes("Alpha paragraph. AB") && x.includes("Gamma edited elsewhere.");
  }, 20000);
  await shot(p, "c04-conflict");
  if (!ok) fail(`server: ${JSON.stringify((await content(slug)).slice(0, 200))}; banner: ${await banner(p)}`);
});

/* ── 5. Same paragraph changed on both sides: nothing silently lost ── */
await step("true-conflict", async () => {
  const slug = await newPage(`True conflict ${run}`);
  const { p } = await ctx(browser, { token: T.owner });
  await open(p, `${APP}/${slug}`);
  await caretAfter(p, "Beta paragraph.");
  await p.keyboard.type(" X");
  await waitSaved(p);
  expireLock(slug);
  mongo(`d=db["documents"].find_one({"slug": ${JSON.stringify(slug)}}); db["documents"].update_one({"_id": d["_id"]}, {"$set": {"content": d["content"].replace("Beta paragraph. X", "Beta rewritten elsewhere.")}, "$inc": {"rev": 1}})`);
  await p.keyboard.type("Y");
  await p.waitForTimeout(4000);
  const b = await banner(p);
  await shot(p, "c05-true-conflict");
  log("banner:", b);
  if (!/changed|conflict/i.test(b)) fail(`no conflict notice: ${b}`);
  // Whatever the choice, the other version must stay reachable: keep mine.
  const keep = p.getByRole("button", { name: /Keep mine|Keep both|Keep my version/ }).first();
  await keep.click();
  await waitSaved(p).catch(() => {});
  const x = await content(slug);
  const v = await api("GET", `/api/v1/documents/${slug}/versions`, T.owner);
  const hist = JSON.stringify(v.body);
  if (!x.includes("Beta paragraph. XY")) fail("Keep mine didn't keep mine");
  if (!x.includes("Beta rewritten elsewhere.") && !hist.includes("Beta rewritten elsewhere")) fail("their version is gone (not on the page, not in history)");
});

/* ── 6. Renamed (set_slug) while open: the tab follows, typing still saves ── */
await step("rename-while-open", async () => {
  const slug = await newPage(`Rename ${run}`);
  const { p } = await ctx(browser, { token: T.owner });
  await open(p, `${APP}/${slug}`);
  const to = `${slug}-renamed`;
  const r = await mcp(ADA_MCP, "set_slug", { document: slug, slug: to });
  if (r.isError) fail(`set_slug: ${r.text}`);
  await p.waitForTimeout(4000);
  log("url after rename:", p.url());
  await caretAfter(p, "Alpha paragraph.");
  await p.keyboard.type(" After rename.");
  await p.waitForTimeout(6000);
  const x = (await docOf(to, T.owner)).content;
  await shot(p, "c06-rename");
  if (!x.includes("After rename.")) fail(`typing after the rename didn't save (url ${p.url()}, state ${await p.locator(".pb-save").first().getAttribute("data-state").catch(() => null)}, banner ${await banner(p)})`);
  if (!p.url().includes(to)) fail(`the tab still shows the old address ${p.url()}`);
});

/* ── 7. Deleted while open: the editor says so ── */
await step("delete-while-open", async () => {
  const slug = await newPage(`Delete ${run}`);
  const { p } = await ctx(browser, { token: T.member });
  await open(p, `${APP}/${slug}`);
  const r = await api("DELETE", `/api/v1/documents/${slug}`, T.owner);
  if (r.status >= 300) fail(`delete → ${r.status}`);
  await p.waitForTimeout(5000);
  const txt = await p.locator("body").innerText();
  await shot(p, "c07-deleted");
  if (!/deleted|trash|isn't here|not found|no longer/i.test(txt)) fail("nothing says the page was deleted");
});

/* ── 8. Removed from the workspace while editing: no further saves, told why ── */
await step("lose-access", async () => {
  const slug = await newPage(`Lose access ${run}`);
  const { p } = await ctx(browser, { token: T.member });
  await open(p, `${APP}/${slug}`);
  const r = await api("DELETE", `/api/v1/workspaces/${S.ws}/members/${ID.member}`, T.owner);
  if (r.status >= 300) fail(`remove member → ${r.status} ${JSON.stringify(r.body)}`);
  try {
    await p.waitForTimeout(3000);
    await caretAfter(p, "Alpha paragraph.").catch(() => {});
    await p.keyboard.type(" Should not save.");
    await p.waitForTimeout(5000);
    const x = await content(slug);
    const txt = await p.locator("body").innerText();
    await shot(p, "c08-lose-access");
    if (x.includes("Should not save.")) fail("a removed member's edit saved");
    if (!/can't edit|sign in|no access|don't have access|not saved|removed/i.test(txt)) fail("nothing tells the removed member");
  } finally {
    mongo(`db["memberships"].insert_one({"workspace_id": ${JSON.stringify(S.ws)}, "user_id": ${JSON.stringify(ID.member)}, "role": "member", "created_at": datetime.now(timezone.utc), "email": "ben@acme.test", "name": "Ben Member"}) if not db["memberships"].find_one({"workspace_id": ${JSON.stringify(S.ws)}, "user_id": ${JSON.stringify(ID.member)}}) else None`);
  }
});

/* ── 9. A stale local draft restored over a newer version: merged, not overwritten ── */
await step("stale-draft", async () => {
  const slug = await newPage(`Draft ${run}`);
  let { c, p } = await ctx(browser, { token: T.owner });
  await open(p, `${APP}/${slug}`);
  await caretAfter(p, "Alpha paragraph.");
  await c.setOffline(true);
  await p.keyboard.type(" Draft text.");
  await p.waitForTimeout(3000);
  await c.close();
  expireLock(slug);
  const d = await doc(slug);
  const r = await mcp(BEN_MCP, "update_page", { document: slug, markdown: d.content.replace("Gamma paragraph.", "Gamma newer on the server."), base_rev: d.rev });
  if (r.isError) fail(`update_page: ${r.text}`);
  // The same browser profile again: the draft is in its localStorage. (A new context has none,
  // so carry it over.)
  ({ c, p } = await ctx(browser, { token: T.owner }));
  await p.goto(`${APP}/robots.txt`);
  const key = `md_page_draft:u:${ID.owner}:${slug}`;
  const draft = { title: d.title, content: d.content.replace("Alpha paragraph.", "Alpha paragraph. Draft text."), rev: d.rev, at: Date.now() - 60000, uid: ID.owner };
  await p.evaluate(([k, v]) => localStorage.setItem(k, v), [key, JSON.stringify(draft)]);
  await open(p, `${APP}/${slug}`);
  const restore = p.getByRole("button", { name: "Restore them" });
  await restore.waitFor({ timeout: 10000 });
  await restore.click();
  await p.waitForTimeout(500);
  await editor(p).click();
  await waitSaved(p).catch(() => {});
  await p.waitForTimeout(1500);
  const x = await content(slug);
  await shot(p, "c09-stale-draft");
  if (!x.includes("Draft text.")) fail("the draft wasn't saved");
  if (!x.includes("Gamma newer on the server.")) fail("restoring the stale draft overwrote a newer change");
});

/* ── 10. Two people, one after the other: the second sees the first's text live ── */
await step("two-people", async () => {
  const slug = await newPage(`Two people ${run}`);
  const a = await ctx(browser, { token: T.owner });
  const b = await ctx(browser, { token: T.member });
  await open(a.p, `${APP}/${slug}`);
  await open(b.p, `${APP}/${slug}`);
  await caretAfter(a.p, "Alpha paragraph.");
  await a.p.keyboard.type(" Ada typed this.");
  await waitSaved(a.p);
  if (!(await shows(b.p, "Ada typed this.", 8000))) fail("Ben's open editor didn't show Ada's saved text");
  // Ada leaves; Ben edits another paragraph: both survive.
  await a.p.close();
  await b.p.waitForTimeout(1500);
  await caretAfter(b.p, "Gamma paragraph.");
  await b.p.keyboard.type(" Ben typed this.");
  await waitSaved(b.p);
  const x = await content(slug);
  if (!x.includes("Ada typed this.") || !x.includes("Ben typed this.")) fail(`lost an edit: ${x}`);
});

/* ── 11. Presence: a closed tab leaves the list; a slept one goes too ── */
await step("presence", async () => {
  const slug = await newPage(`Presence ${run}`);
  const a = await ctx(browser, { token: T.owner });
  const b = await ctx(browser, { token: T.member });
  await open(a.p, `${APP}/${slug}`);
  await open(b.p, `${APP}/${slug}`);
  const label = () => a.p.locator("[aria-label*='viewing'], [aria-label*='Viewing']").first().getAttribute("aria-label").catch(() => "");
  const two = await until(async () => /Ben Member/.test((await label()) || ""), 10000);
  if (!two) fail(`Ada doesn't see Ben: ${await label()}`);
  await b.c.close();
  const gone = await until(async () => !/Ben Member/.test((await label()) || ""), 10000);
  if (!gone) fail(`Ben still listed after closing his tab: ${await label()}`);
});

/* ── 12. Version history names each editor ── */
await step("history", async () => {
  const slug = await newPage(`History ${run}`);
  const { p } = await ctx(browser, { token: T.owner });
  await open(p, `${APP}/${slug}`);
  await caretAfter(p, "Alpha paragraph.");
  await p.keyboard.type(" Ada.");
  await waitSaved(p);
  await p.close();
  await new Promise((r) => setTimeout(r, 1500));
  const d = await doc(slug);
  const r = await mcp(BEN_MCP, "update_page", { document: slug, markdown: d.content.replace("Beta paragraph.", "Beta by Ben's AI."), base_rev: d.rev });
  if (r.isError) fail(`update_page: ${r.text}`);
  const v = await api("GET", `/api/v1/documents/${slug}/versions`, T.owner);
  const s = JSON.stringify(v.body);
  if (!s.includes("Ada Owner") || !s.includes("Ben Member")) fail(`history authors: ${s.slice(0, 600)}`);
});

/* ── 13. Classic Markdown documents: a stale second editor is refused, not saved over ── */
await step("classic", async () => {
  const r0 = await api("POST", "/api/v1/documents", T.owner, { title: "Classic two", content: "# Classic\n\nOne.\n", expires_in: "never", workspace: S.ws, folder: S.folder, access_level: "workspace" });
  const slug = r0.body.slug;
  const d = await doc(slug);
  const a = await api("PUT", `/api/v1/documents/${slug}`, T.owner, { title: "Classic two", content: "# Classic\n\nOne. Ada.\n", base_rev: d.rev });
  if (a.status !== 200) fail(`first save → ${a.status}`);
  const b = await api("PUT", `/api/v1/documents/${slug}`, T.member, { title: "Classic two", content: "# Classic\n\nOne. Ben.\n", base_rev: d.rev });
  if (b.status !== 409) fail(`stale classic save → ${b.status} (want 409)`);
  // Without base_rev (the public API, the generic MCP update_document): last write wins.
  const m = await mcp(BEN_MCP, "update_document", { document: slug, content: "# Classic\n\nOverwritten by an AI that read rev 1.\n", base_rev: d.rev });
  if (!m.isError) fail("MCP update_document with a stale base_rev overwrote the newer version");
});

/* ── 14. On the workspace's own domain: an AI change reaches the open editor ── */
await step("tenant", async () => {
  const slug = await newPage(`Tenant ${run}`);
  const d0 = await doc(slug);
  const addr = `${TENANT}/${[...(d0.folder_path || []), slug].join("/")}`;
  const { p } = await ctx(browser, { token: T.member });
  await fetch(`${APP}/api/revalidate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: "host:acme.localhost" }) });
  await p.goto(`${APP}/robots.txt`);
  await p.goto(addr, { waitUntil: "networkidle" });
  if (!(await editor(p).count())) {
    const signIn = p.getByRole("button", { name: /Sign in to read/ }).or(p.getByRole("link", { name: /Sign in to read/ }))
      .or(p.getByRole("link", { name: /^Sign in$/ })).or(p.getByRole("button", { name: /^Sign in$/ }));
    await signIn.first().click({ timeout: 20000 });
    await p.waitForURL((u) => u.hostname === "acme.localhost" && !u.hash.includes("mdt="), { timeout: 30000 }).catch(() => {});
    await p.waitForLoadState("networkidle");
  }
  await editor(p).waitFor({ timeout: 30000 });
  await p.waitForTimeout(1200);
  const d = await doc(slug);
  const r = await mcp(ADA_MCP, "update_page", { document: slug, markdown: d.content.replace("Beta paragraph.", "Beta from Ada's AI."), base_rev: d.rev });
  if (r.isError) fail(`update_page: ${r.text}`);
  if (!(await shows(p, "Beta from Ada's AI.", 8000))) fail("the domain's open editor never showed the change");
  await caretAfter(p, "Alpha paragraph.");
  await p.keyboard.type(" Ben on the domain.");
  await waitSaved(p);
  const x = await content(slug);
  if (!x.includes("Ben on the domain.") || !x.includes("Beta from Ada's AI.")) fail(`domain save: ${x}`);
});

await browser.close();
console.log("\n" + results.map(([n, r, ms]) => `${r === "ok" ? "✓" : "✗"} ${n.padEnd(24)} ${r} (${(ms / 1000).toFixed(1)} s)`).join("\n"));
if (results.some(([, r]) => r !== "ok")) process.exit(1);
