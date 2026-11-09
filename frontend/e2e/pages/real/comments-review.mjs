/**
 * Comments, review power (Track B) on the real stack (up.sh; the API with PB_FAKE_COMMENTS_AI=1):
 *   accept     a suggested edit with the thread → the editor sees it struck through / replaced → Accept → the page says it
 *   propose    "Suggest an edit" and "Draft with AI" on a thread → Suggest → the card shows it
 *   offer      someone else holds the page → Accept says it waits for them → they Apply it
 *   files      attach an image to a reply → it shows (signed link) for another member
 *   ask        "Ask Markdrop AI" → the AI's answer lands in the thread
 *   tone       a harsh reply → "Before you post" → Post the rewrite
 *   summary    the panel's ⋯ → Summarize discussion → its lines open their threads
 *   signoff    signing with an open thread asks first; the block records it
 *   phone      the suggestion card and files at 390 px
 * Uses the existing seed (run real.mjs or seed.py first) and makes its own pages.
 *
 *   [BROWSER=webkit] [ONLY=accept,files] node comments-review.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { APP, log, fail, seedNow, api, docOf, launch, ctx, stepper, shot, pngBytes, STACK } from "./lib.mjs";

const S = seedNow();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const ID = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.id]));
const browser = await launch();
const { step, results } = stepper(browser);
const run = Date.now().toString(36).slice(-5);
const LINE = "We will ship the new editor on Monday.";
const QUOTE = { type: "text", quote: { exact: "the new editor", prefix: "ship ", suffix: " on" } };

async function newPage(title, content, as = "owner") {
  const r = await api("POST", "/api/v1/pages", T[as], { title, workspace: S.ws, folder: S.folder, content });
  if (r.status >= 300) fail(`create ${title} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body.document.slug;
}
async function thread(slug, as, body, extra = {}) {
  const r = await api("POST", `/api/v1/documents/${slug}/comments`, T[as], { anchor: QUOTE, body, ...extra });
  if (r.status !== 201) fail(`thread → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
}
const content = async (slug) => (await docOf(slug, T.owner)).content;
const card = (p, tid) => p.locator(`article.mdc-thread[data-thread-id="${tid}"]`);

async function open(p, slug, tid) {
  await p.goto(`${APP}/${slug}${tid ? `#c-${tid}` : ""}`, { waitUntil: "networkidle" });
  if (tid) await card(p, tid).waitFor({ timeout: 20000 });
}
async function until(fn, what, timeout = 15000) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeout) fail(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/* ── 1. Accept a suggestion that came with the thread ── */
await step("accept", async () => {
  const slug = await newPage(`Review ${run} a`, `# Launch\n\n${LINE}\n`);
  const t = await thread(slug, "member", "Say redesigned?", { suggestion: "the redesigned editor" });
  const { p } = await ctx(browser, { token: T.owner });
  await open(p, slug, t.id);
  const c = card(p, t.id).locator('[data-testid="suggestion-card"]');
  await c.waitFor();
  if ((await c.locator("del").innerText()) !== "the new editor") fail("the quote isn't struck through");
  if ((await c.locator("ins").innerText()) !== "the redesigned editor") fail("the replacement isn't shown");
  await shot(p, "cr01-suggestion-card");
  await c.getByRole("button", { name: "Accept" }).click();
  await until(async () => (await content(slug)).includes("ship the redesigned editor on Monday"), "the page says it");
  await until(async () => (await c.innerText()).includes("Accepted by"), "the card says accepted");
  await shot(p, "cr02-accepted");
  const v = await api("GET", `/api/v1/documents/${slug}/versions`, T.owner);
  if (v.body.versions[0].event?.thread_id !== t.id) fail(`history doesn't link the thread: ${JSON.stringify(v.body.versions[0]).slice(0, 300)}`);
  await p.context().close();
});

/* ── 2. Suggest an edit and Draft with AI from a thread ── */
await step("propose", async () => {
  const slug = await newPage(`Review ${run} b`, `# Launch\n\n${LINE}\n`);
  const t = await thread(slug, "owner", 'Please call it "the faster editor".');
  const { p } = await ctx(browser, { token: T.member });
  await open(p, slug, t.id);
  await card(p, t.id).getByRole("button", { name: "Apply with AI" }).click();
  const ed = card(p, t.id).locator('[data-testid="suggestion-editor"]');
  await ed.waitFor();
  await until(async () => (await ed.locator("textarea").inputValue()) === "the faster editor", "the AI draft fills the editor");
  await shot(p, "cr03-ai-draft");
  await ed.getByRole("button", { name: "Suggest" }).click();
  const c = card(p, t.id).locator('[data-testid="suggestion-card"]');
  await c.waitFor();
  if (!(await c.innerText()).includes("AI draft")) fail("the AI badge is missing");
  if ((await c.locator("ins").innerText()) !== "the faster editor") fail("not proposed");
  // A viewer-level member can't accept; the member (an editor) can, but it's theirs: Withdraw is offered.
  if (!(await c.getByRole("button", { name: "Withdraw" }).count())) fail("no Withdraw for its author");
  await p.context().close();
});

/* ── 3. Someone else is editing: it waits for them, they apply it ── */
await step("offer", async () => {
  const slug = await newPage(`Review ${run} c`, `# Launch\n\n${LINE}\n`);
  const t = await thread(slug, "member", "Tweak", { suggestion: "the calm editor" });
  const lock = await api("POST", `/api/v1/documents/${slug}/lock`, T.admin, {});
  if (lock.status >= 300) fail(`lock → ${lock.status}`);
  const { p } = await ctx(browser, { token: T.owner });
  await open(p, slug, t.id);
  const c = card(p, t.id).locator('[data-testid="suggestion-card"]');
  await c.waitFor();
  await until(async () => (await c.innerText()).includes("is editing the page"), "it says someone is editing");
  await c.getByRole("button", { name: "Accept" }).click();
  await until(async () => (await c.innerText()).includes("Waiting for them"), "it waits for the holder");
  if ((await content(slug)).includes("calm editor")) fail("applied over the holder's lock");
  await shot(p, "cr04-offered");
  const { p: q } = await ctx(browser, { token: T.admin });
  await open(q, slug, t.id);
  const c2 = card(q, t.id).locator('[data-testid="suggestion-card"]');
  await until(async () => (await c2.innerText()).includes("accepted this while you're editing"), "the holder sees the offer");
  await shot(q, "cr05-offer-for-holder");
  await c2.getByRole("button", { name: "Apply" }).click();
  await until(async () => (await content(slug)).includes("the calm editor"), "the holder applied it");
  await p.context().close();
  await q.context().close();
});

/* ── 4. Files: an image in a reply, seen by another member ── */
await step("files", async () => {
  const slug = await newPage(`Review ${run} d`, `# Launch\n\n${LINE}\n`);
  const t = await thread(slug, "owner", "Screenshot?");
  const { p } = await ctx(browser, { token: T.member });
  await open(p, slug, t.id);
  await card(p, t.id).getByRole("button", { name: "Reply" }).click();
  const file = path.join(STACK, `cr-${run}.png`);
  fs.writeFileSync(file, Buffer.from(await pngBytes(browser, "Comment screenshot")));
  await card(p, t.id).locator('[data-testid="comment-file-input"]').setInputFiles(file);
  await card(p, t.id).locator(".cr-draft-file").first().waitFor();
  await card(p, t.id).locator("textarea").first().fill("Here it is");
  await card(p, t.id).getByRole("button", { name: "Reply", exact: true }).last().click();
  const files = card(p, t.id).locator('[data-testid="comment-files"] img');
  await files.first().waitFor({ timeout: 15000 });
  await until(async () => (await files.first().evaluate((i) => i.complete && i.naturalWidth > 0)), "the image loads");
  await shot(p, "cr06-file-in-reply");
  const { p: q } = await ctx(browser, { token: T.owner });
  await open(q, slug, t.id);
  const img = card(q, t.id).locator('[data-testid="comment-files"] img').first();
  await img.waitFor({ timeout: 15000 });
  await until(async () => (await img.evaluate((i) => i.complete && i.naturalWidth > 0)), "the owner sees it");
  const src = await img.getAttribute("src");
  if (!src?.includes("?t=")) fail(`the link isn't signed: ${src}`);
  await p.context().close();
  await q.context().close();
});

/* ── 5. Ask Markdrop AI in a thread ── */
await step("ask", async () => {
  const slug = await newPage(`Review ${run} e`, `# Launch\n\n${LINE}\n`);
  const t = await thread(slug, "owner", "When?");
  const { p } = await ctx(browser, { token: T.member });
  await open(p, slug, t.id);
  await card(p, t.id).getByRole("button", { name: "Ask Markdrop AI" }).click();
  const box = card(p, t.id).locator('[data-testid="ask-ai"] textarea');
  await box.fill("When do we ship?");
  await box.press("Enter");
  await until(async () => (await card(p, t.id).innerText()).includes("From the page:"), "the AI answer shows");
  await shot(p, "cr07-ask-ai");
  await p.context().close();
});

/* ── 6. Tone check before posting ── */
await step("tone", async () => {
  const slug = await newPage(`Review ${run} f`, `# Launch\n\n${LINE}\n`);
  const t = await thread(slug, "owner", "Thoughts?");
  const { p } = await ctx(browser, { token: T.member });
  await open(p, slug, t.id);
  await card(p, t.id).getByRole("button", { name: "Reply" }).click();
  await card(p, t.id).locator("textarea").first().fill("This is STUPID and lazy!!!");
  await card(p, t.id).getByRole("button", { name: "Reply", exact: true }).last().click();
  const dlg = p.getByRole("dialog", { name: "Before you post" });
  await dlg.waitFor({ timeout: 15000 });
  await shot(p, "cr08-tone-dialog");
  await dlg.getByRole("button", { name: "Post the rewrite" }).click();
  await until(async () => (await card(p, t.id).innerText()).includes("Could we take another look at this part?"), "the rewrite is posted");
  if ((await card(p, t.id).innerText()).includes("STUPID")) fail("the original was posted");
  await p.context().close();
});

/* ── 7. Summarize discussion ── */
await step("summary", async () => {
  const slug = await newPage(`Review ${run} g`, `# Launch\n\n${LINE}\n`);
  const t1 = await thread(slug, "owner", "First point");
  await thread(slug, "member", "Second point");
  const { p } = await ctx(browser, { token: T.member });
  await open(p, slug, t1.id);
  await p.getByRole("complementary", { name: "Comments" }).getByRole("button", { name: "More" }).click().catch(async () => {
    await p.locator('[aria-label="Comments"]').getByRole("button", { name: "More" }).click();
  });
  await p.getByRole("menuitem", { name: "Summarize discussion" }).click();
  const dlg = p.locator('[data-testid="discussion-summary"]');
  await dlg.waitFor();
  await until(async () => (await dlg.innerText()).includes("Settled in 2 thread(s)"), "the summary shows");
  await shot(p, "cr09-summary");
  await dlg.getByRole("button", { name: "open thread" }).first().click();
  await until(async () => (await card(p, t1.id).getAttribute("class"))?.includes("is-active"), "the line opens its thread");
  await p.context().close();
});

/* ── 8. Sign-off with an open thread ── */
await step("signoff", async () => {
  const block = `:::signoff{#b-cr${run} person="${ID.member}" label="Release" options="Approved|Not approved"}\nQA passed.\n:::`;
  const slug = await newPage(`Review ${run} h`, `# Launch\n\n${LINE}\n\n${block}\n`);
  await thread(slug, "owner", "Still open");
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  const so = p.locator(".pb-signoff").first();
  await so.getByRole("button", { name: "Approved" }).click();
  const confirm = so.locator(".pb-signoff__confirm");
  await confirm.waitFor();
  if (!(await confirm.innerText()).includes("1 comment thread is still open")) fail(`no warning: ${await confirm.innerText()}`);
  await shot(p, "cr10-signoff-warning");
  await confirm.getByRole("button", { name: /Sign off anyway/ }).click();
  await until(async () => (await so.innerText()).includes("still open"), "the record line shows");
  await shot(p, "cr11-signoff-recorded");
  await p.context().close();
});

/* ── 9. Phone ── */
await step("phone", async () => {
  const slug = await newPage(`Review ${run} i`, `# Launch\n\n${LINE}\n`);
  const t = await thread(slug, "member", "Reword", { suggestion: "a much longer replacement for the new editor that wraps on a phone" });
  const { p } = await ctx(browser, { token: T.owner, width: 390, height: 844, mobile: true });
  await open(p, slug, t.id);
  const c = card(p, t.id).locator('[data-testid="suggestion-card"]');
  await c.waitFor();
  const box = await c.boundingBox();
  if (!box || box.x < 0 || box.x + box.width > 391) fail(`the card overflows the phone: ${JSON.stringify(box)}`);
  const sw = await p.evaluate(() => document.documentElement.scrollWidth);
  if (sw > 392) fail(`horizontal scroll on the phone: ${sw}`);
  await shot(p, "cr12-phone");
  await p.context().close();
});

await browser.close();
const bad = results.filter(([, r]) => r !== "ok");
for (const [n, r, ms] of results) log(`${r === "ok" ? "✓" : "✗"} ${n} ${r === "ok" ? "" : r} (${(ms / 1000).toFixed(1)} s)`);
log(`comments review: ${results.length - bad.length}/${results.length} passed`);
process.exit(bad.length ? 1 : 0);
