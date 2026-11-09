/**
 * Comments on the real stack (up.sh; components/comments, backend services/comments).
 *   flow      a member selects text → Comment → posts with an @mention; the owner replies; resolve; reopen
 *   live      two browsers: a comment posted in one appears in the other without a reload
 *   block     a block's margin button comments on the whole block; "Comment on the page"
 *   anon      an anonymous reader of a public page sees a clean page; selecting offers "Sign in to comment"
 *   public    the owner's "Show comments publicly": the anonymous reader sees the threads (read only)
 *   changed   the commented text is edited away: the thread says "text was changed" with the original
 *   editor    an editor sees the highlights in the editor
 *   mobile    at 390 px the panel is a bottom sheet
 *   markdown  a classic markdown document takes comments too
 *   dark      the panel in dark mode (screenshot)
 * Reseeds (seed.py) and makes its own pages. Screens in <PB_WORK>/real-shots/<browser>/comments-*.png.
 *
 *   PB_WORK=… PB_STACK_ID=23 [BROWSER=webkit] [ONLY=flow,live] node comments.mjs
 */
import { APP, log, fail, reseed, api, launch, ctx, stepper, shot, editPage } from "./lib.mjs";

const S = reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const ID = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.id]));
const browser = await launch();
const { step, results } = stepper(browser);
const run = Date.now().toString(36).slice(-5);

const BODY = (n) => `# Launch review ${n}

We will ship the new editor on Monday, after the final review with the design team.

Rollout happens in three waves, starting with the Acme workspace and then everyone else.

- Write the release notes
- Record the walkthrough video

Closing thoughts: keep the customer in the room.
`;

async function newPage(title, { access = "workspace", content = BODY(title) } = {}) {
  const r = await api("POST", "/api/v1/pages", T.owner, { title, workspace: S.ws, folder: S.folder, content, auto_cover: false });
  if (r.status >= 300) fail(`create ${title} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const slug = r.body.document.slug;
  if (access !== "workspace") {
    const a = await api("PUT", `/api/v1/documents/${slug}/access/level`, T.owner, { level: access });
    if (a.status >= 300) fail(`level → ${a.status}`);
  }
  return slug;
}

/** Selects `text` inside the page's rendered body (reader). */
async function selectText(p, text, root = ".pb-paper") {
  await p.evaluate(([t, sel]) => {
    const rootEl = document.querySelector(sel);
    if (!rootEl) throw new Error("no root " + sel);
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.indexOf(t);
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + t.length);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
        document.dispatchEvent(new Event("selectionchange"));
        return;
      }
    }
    throw new Error("text not found: " + t);
  }, [text, root]);
  await p.waitForTimeout(250);
}

const panel = (p) => p.locator("aside.mdc-panel");
/** The panel opens by itself on wide screens when there are open comments; else the top bar's button. */
async function showPanel(p) {
  await p.waitForTimeout(400);
  if (!(await panel(p).count())) await p.locator(".mdc-topbtn").first().click();
  await panel(p).waitFor({ timeout: 8000 });
}
const threads = (p) => p.locator("aside.mdc-panel article.mdc-thread[data-thread-id]");

async function openPage(p, slug) {
  await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  await p.locator(".pb-paper").first().waitFor({ timeout: 30000 });
  await p.waitForTimeout(600);
}

/** Selects `text` and waits for the "Comment" button (it shows once the page knows this reader may comment). */
async function selectForComment(p, text) {
  for (let i = 0; i < 3; i++) {
    await selectText(p, text);
    try {
      await p.locator(".mdc-selbtn").waitFor({ state: "visible", timeout: 5000 });
      return;
    } catch { /* select again: the first selection can land before the page is ready */ }
  }
  await p.locator(".mdc-selbtn").waitFor({ state: "visible", timeout: 5000 });
}

async function comment(p, text, body, { mention = null } = {}) {
  await selectForComment(p, text);
  await p.locator(".mdc-selbtn").click();
  const box = panel(p).locator(".mdc-draft textarea");
  await box.waitFor({ timeout: 8000 });
  await box.type(body);
  if (mention) {
    await box.type(` @${mention.slice(0, 3)}`);
    await p.locator(".mdc-mentions [role=option]").first().waitFor({ timeout: 8000 });
    await p.keyboard.press("Enter");
  }
  await panel(p).locator(".mdc-draft button:has-text('Comment')").click();
  await panel(p).locator(".mdc-draft").waitFor({ state: "detached", timeout: 8000 });
}

await step("flow", async () => {
  const slug = await newPage(`Review ${run}a`);
  const { p } = await ctx(browser, { token: T.member });
  await openPage(p, slug);
  await comment(p, "the new editor", "Is Monday realistic?", { mention: "Ada" });
  await threads(p).first().waitFor();
  const t1 = await threads(p).first().innerText();
  if (!t1.includes("the new editor") || !t1.includes("Is Monday realistic?") || !t1.includes("@Ada")) fail(`thread text: ${t1}`);
  // The highlight is painted (Custom Highlight API) or a fallback box.
  const painted = await p.evaluate(() => {
    const hl = globalThis.CSS?.highlights;
    if (hl) return (hl.get("md-comments")?.size ?? 0) + (hl.get("md-comments-active")?.size ?? 0);
    return document.querySelectorAll(".mdc-box").length;
  });
  if (!painted) fail("no highlight painted");
  await shot(p, "comments-flow-1-created");
  // The owner was mentioned: the bell has it, and the link opens the thread.
  const bell = await api("GET", "/api/v1/notifications", T.owner);
  const note = bell.body.items.find((n) => n.kind === "comment_mention");
  if (!note) fail(`no mention notification: ${JSON.stringify(bell.body.items.map((n) => n.kind))}`);
  const { p: q } = await ctx(browser, { token: T.owner });
  await q.goto(`${APP}${note.href}`, { waitUntil: "networkidle" });
  await threads(q).first().waitFor({ timeout: 15000 });
  const active = q.locator("article.mdc-thread.is-active");
  await active.waitFor({ timeout: 8000 });
  await active.locator("textarea").fill("Yes, the build is green.");
  await active.locator("button:has-text('Reply')").click();
  await active.locator(".mdc-msg").nth(1).waitFor({ timeout: 8000 });
  // Reactions.
  await active.locator(".mdc-msg").first().hover();
  await active.locator(".mdc-reaction--add").first().click();
  await q.locator(".mdc-emoji").first().click();
  await active.locator(".mdc-reaction.is-mine").first().waitFor({ timeout: 8000 });
  await shot(q, "comments-flow-2-replied");
  // Resolve, then it moves to Resolved; reopen.
  await active.locator("button[aria-label='Resolve']").click();
  await q.waitForFunction(() => !document.querySelector("aside.mdc-panel article.mdc-thread[data-thread-id]:not(.mdc-draft)") || document.querySelector("aside.mdc-panel article.is-resolved"), null, { timeout: 8000 });
  await panel(q).getByRole("radio", { name: /Resolved/ }).click().catch(async () => { await panel(q).locator("text=Resolved").first().click(); });
  await q.locator("article.mdc-thread.is-resolved").first().waitFor({ timeout: 8000 });
  await shot(q, "comments-flow-3-resolved");
  await q.locator("article.mdc-thread.is-resolved button[aria-label='Reopen']").first().click();
  await q.waitForTimeout(800);
  const st = await api("GET", `/api/v1/documents/${slug}/comments`, T.owner);
  if (st.body.counts.open !== 1) fail(`counts after reopen: ${JSON.stringify(st.body.counts)}`);
});

await step("live", async () => {
  const slug = await newPage(`Live ${run}`);
  const { p: a } = await ctx(browser, { token: T.owner });
  const { p: b } = await ctx(browser, { token: T.member });
  await openPage(a, slug);
  await openPage(b, slug);
  await comment(a, "three waves", "Can we do two?");
  // The other browser gets it without a reload (live signal → one re-read).
  await b.locator(".mdc-topbtn__n").waitFor({ timeout: 15000 });
  const n = await b.locator(".mdc-topbtn__n").innerText();
  if (n.trim() !== "1") fail(`live count ${n}`);
  await b.locator(".mdc-topbtn").first().click();
  await threads(b).first().waitFor({ timeout: 8000 });
  await threads(b).first().click();
  const tb = b.locator("article.mdc-thread.is-active");
  await tb.locator("textarea").fill("Two works for me.");
  await tb.locator("button:has-text('Reply')").click();
  await a.locator("article.mdc-thread .mdc-msg").nth(1).waitFor({ timeout: 15000 });
  await shot(a, "comments-live-owner-sees-reply");
});

await step("block", async () => {
  const slug = await newPage(`Block ${run}`);
  const { p } = await ctx(browser, { token: T.member });
  await openPage(p, slug);
  await p.locator(".pb-paper li", { hasText: "Record the walkthrough" }).first().hover();
  await p.locator(".mdc-blockbtn").click({ timeout: 8000 });
  const box = panel(p).locator(".mdc-draft textarea");
  await box.fill("Who records it?");
  await panel(p).locator(".mdc-draft button:has-text('Comment')").click();
  await threads(p).first().waitFor();
  if (!(await threads(p).first().innerText()).includes("Record the walkthrough")) fail("block quote missing");
  await panel(p).locator(".mdc-pagebtn").click();
  await panel(p).locator(".mdc-draft textarea").fill("Overall this reads well.");
  await panel(p).locator(".mdc-draft button:has-text('Comment')").click();
  await p.locator("article.mdc-thread", { hasText: "On the page" }).waitFor({ timeout: 8000 });
  await shot(p, "comments-block-and-page");
});

await step("anon", async () => {
  const slug = await newPage(`Public ${run}`, { access: "link" });
  await api("POST", `/api/v1/documents/${slug}/comments`, T.member, { anchor: { type: "page" }, body: "Private chatter" });
  const { p } = await ctx(browser, {});
  const seen = [];
  p.on("response", (r) => { if (r.url().includes("/comments")) seen.push(r.url()); });
  await openPage(p, slug);
  if (await panel(p).count()) fail("anonymous reader sees the panel");
  if ((await p.content()).includes("Private chatter")) fail("comment text leaked to an anonymous reader");
  if (seen.length) fail(`anonymous reader fetched comments: ${seen.join(", ")}`);
  await selectText(p, "three waves");
  await p.locator(".mdc-selbtn", { hasText: "Sign in to comment" }).waitFor({ timeout: 8000 });
  await shot(p, "comments-anon-signin");
});

await step("public", async () => {
  const slug = await newPage(`Shown ${run}`, { access: "link" });
  await api("POST", `/api/v1/documents/${slug}/comments`, T.member, { anchor: { type: "page" }, body: "Visible to everyone" });
  const s = await api("PUT", `/api/v1/documents/${slug}/comments/settings`, T.owner, { public: true });
  if (s.status !== 200) fail(`settings → ${s.status}`);
  const { p } = await ctx(browser, {});
  await openPage(p, slug);
  await showPanel(p);
  await threads(p).first().waitFor({ timeout: 10000 });
  if (await panel(p).locator("textarea").count()) fail("anonymous reader got a composer");
  await shot(p, "comments-public-anon");
});

await step("changed", async () => {
  const slug = await newPage(`Changed ${run}`);
  const t = await api("POST", `/api/v1/documents/${slug}/comments`, T.member, {
    anchor: { type: "text", quote: { exact: "final review" } }, body: "Which review?" });
  if (t.status !== 201) fail(`create → ${t.status} ${JSON.stringify(t.body)}`);
  const d = await api("GET", `/api/v1/documents/${slug}`, T.owner);
  const up = await api("PUT", `/api/v1/documents/${slug}`, T.owner, { title: d.body.title, content: d.body.content.replace("after the final review with the design team", "once QA signs off"), base_rev: d.body.rev });
  if (up.status !== 200) fail(`save → ${up.status}`);
  const { p } = await ctx(browser, { token: T.member });
  await openPage(p, slug);
  await showPanel(p);
  await p.locator(".mdc-changed").waitFor({ timeout: 10000 });
  if (!(await threads(p).first().innerText()).includes("final review")) fail("original quote not shown");
  await shot(p, "comments-changed");
});

await step("editor", async () => {
  const slug = await newPage(`Editor ${run}`);
  await api("POST", `/api/v1/documents/${slug}/comments`, T.member, { anchor: { type: "text", quote: { exact: "release notes" } }, body: "Draft by Friday" });
  const { p } = await ctx(browser, { token: T.owner });
  await openPage(p, slug);
  await editPage(p);
  await p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 30000 });
  await p.waitForFunction(() => {
    const hl = globalThis.CSS?.highlights;
    if (hl) return (hl.get("md-comments-editor")?.size ?? 0) + (hl.get("md-comments-editor-active")?.size ?? 0) > 0;
    return document.querySelectorAll(".mdc-box").length > 0;
  }, null, { timeout: 15000 });
  await shot(p, "comments-editor-highlight");
  // The block menu's "Comment".
  await p.locator(".pb-live .ProseMirror p", { hasText: "Rollout happens" }).first().hover();
  await p.locator(".dxe-handle__grip").first().click({ timeout: 8000 });
  await p.locator(".dxe-blockmenu").getByText("Comment", { exact: true }).click({ timeout: 8000 });
  const box = panel(p).locator(".mdc-draft textarea");
  await box.waitFor({ timeout: 8000 });
  await box.type("From the block menu");
  await panel(p).locator(".mdc-draft button:has-text('Comment')").click();
  await p.locator("article.mdc-thread", { hasText: "From the block menu" }).waitFor({ timeout: 8000 });
  if (!(await p.locator("article.mdc-thread", { hasText: "From the block menu" }).innerText()).includes("Rollout happens")) fail("block menu comment not on its block");
});

await step("mobile", async () => {
  const slug = await newPage(`Phone ${run}`);
  await api("POST", `/api/v1/documents/${slug}/comments`, T.member, { anchor: { type: "text", quote: { exact: "three waves" } }, body: "On a phone" });
  const { p } = await ctx(browser, { token: T.owner, width: 390, height: 844, mobile: true });
  await openPage(p, slug);
  await p.locator(".mdc-topbtn").first().click();
  await p.locator("aside.mdc-panel--sheet").waitFor({ timeout: 8000 });
  const box = await p.locator("aside.mdc-panel--sheet").boundingBox();
  if (!box || box.width > 391 || box.y < 100) fail(`sheet box ${JSON.stringify(box)}`);
  await threads(p).first().waitFor();
  await shot(p, "comments-mobile-sheet");
});

await step("markdown", async () => {
  const r = await api("POST", "/api/v1/documents", T.owner, { title: `Classic ${run}`, content: "# Classic\n\nA plain markdown document with a sentence to discuss.\n\nAnother paragraph.\n", expires_in: "never" });
  if (r.status >= 300) fail(`create → ${r.status}`);
  const slug = r.body.slug;
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  await p.waitForTimeout(800);
  await selectText(p, "a sentence to discuss", "main");
  await p.locator(".mdc-selbtn").waitFor({ state: "visible", timeout: 10000 });
  await p.locator(".mdc-selbtn").click();
  await panel(p).locator(".mdc-draft textarea").fill("Which sentence?");
  await panel(p).locator(".mdc-draft button:has-text('Comment')").click();
  await threads(p).first().waitFor({ timeout: 8000 });
  await shot(p, "comments-markdown-doc");
});

await step("shots", async () => {
  const slug = await newPage(`Shots ${run}`);
  const { p } = await ctx(browser, { token: T.member });
  await openPage(p, slug);
  await selectForComment(p, "final review with the design team");
  await shot(p, "comments-selection-button");
  await p.evaluate(() => window.getSelection()?.removeAllRanges());
  await p.locator(".pb-paper p", { hasText: "Rollout happens" }).first().hover();
  await p.locator(".mdc-blockbtn").waitFor({ timeout: 8000 });
  await shot(p, "comments-block-button");
  // The owner's switches in Share.
  const { p: o } = await ctx(browser, { token: T.owner });
  await openPage(o, slug);
  await o.getByRole("button", { name: /^Share/ }).first().click();
  await o.getByText("Show comments publicly").waitFor({ timeout: 10000 });
  await shot(o, "comments-share-switches");
});

await step("dark", async () => {
  const slug = await newPage(`Dark ${run}`);
  await api("POST", `/api/v1/documents/${slug}/comments`, T.member, { anchor: { type: "text", quote: { exact: "the new editor" } }, body: "Dark mode check" });
  const { p } = await ctx(browser, { token: T.owner, theme: "dark" });
  await openPage(p, slug);
  await showPanel(p);
  await threads(p).first().waitFor();
  await shot(p, "comments-dark");
});

await browser.close();
const bad = results.filter((r) => r[1] !== "ok");
console.log(JSON.stringify(results, null, 1));
process.exit(bad.length ? 1 : 0);
