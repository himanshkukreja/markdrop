/**
 * Comments, Track C (reach) on the real stack (up.sh):
 *   word       Export → Word with "Include comments" (margin): a .docx whose comments sit on the quoted words
 *   markdown   Export → Markdown with comments: the Comments section, in page order; "Open threads only"
 *   pdf        Export → PDF with margin notes, then notes at the end: numbered markers on the text, the notes
 *   panel      the comments panel's ⋯ → Comment insights (the numbers); ⋯ → Export with comments… opens the
 *              Export dialog with comments on
 *   analytics  the page's analytics → Comments tab
 *   settings   Settings › Account › Email: the two comment rows and the daily comments digest switch
 *   phone      the Export dialog's comment options at 390 px (screenshot)
 * Threads are made through the API (as different people). Screens in <PB_WORK>/real-shots/<browser>/reach-*.png.
 *
 *   PB_WORK=… PB_STACK_ID=31 [BROWSER=webkit] [ONLY=word,pdf] node reach.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { APP, SHOTS, log, fail, reseed, api, launch, ctx, stepper, shot } from "./lib.mjs";

const S = reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const browser = await launch();
const { step, results } = stepper(browser);
const run = Date.now().toString(36).slice(-5);
const OUT = path.join(SHOTS, "reach");
fs.mkdirSync(OUT, { recursive: true });

const BODY = `We will ship the new editor on Monday, after the final review with the design team.

## Rollout

Rollout happens in three waves, starting with the Acme workspace and then everyone else.

- Write the release notes
- Record the walkthrough video

## Risks

The payments API is still flaky under load.
`;

async function page(title) {
  const r = await api("POST", "/api/v1/pages", T.owner, { title, workspace: S.ws, folder: S.folder, content: BODY, auto_cover: false });
  if (r.status >= 300) fail(`create ${title} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body.document.slug;
}

async function thread(slug, who, exact, body) {
  const anchor = exact ? { type: "text", quote: { exact } } : { type: "page" };
  const r = await api("POST", `/api/v1/documents/${slug}/comments`, T[who], { anchor, body });
  if (r.status !== 201) fail(`comment → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
}

async function reply(slug, who, id, body) {
  const r = await api("POST", `/api/v1/documents/${slug}/comments/${id}/replies`, T[who], { body });
  if (r.status !== 201) fail(`reply → ${r.status}`);
}

/** A page with four threads: on the page, on two quotes (one answered), one resolved. */
async function discussed(title) {
  const slug = await page(`${title} ${run}`);
  await thread(slug, "member", null, "Overall this reads well.");
  const a = await thread(slug, "member", "ship the new editor on Monday", "Is Monday realistic?");
  await reply(slug, "owner", a.id, "Yes, the build is green.");
  await thread(slug, "admin", "payments API", "Load test it first.");
  const done = await thread(slug, "member", "three waves", "Why three?");
  const rr = await api("POST", `/api/v1/documents/${slug}/comments/${done.id}/resolve`, T.owner);
  if (rr.status !== 200) fail(`resolve → ${rr.status}`);
  return slug;
}

async function openMenu(p) {
  const btn = p.getByRole("button", { name: /^(Page options|More actions)$/ }).filter({ visible: true }).last();
  await btn.waitFor({ timeout: 20000 });
  await btn.click();
  await p.locator('[role="menu"]').last().waitFor({ timeout: 5000 });
}

async function stubPrint(c) {
  await c.addInitScript(() => {
    window.__printed = false;
    window.print = () => {
      window.__printed = true;
    };
  });
}

async function openExport(p) {
  await openMenu(p);
  await p.getByRole("menuitem", { name: /^Export/ }).first().click();
  const dlg = p.getByRole("dialog", { name: /Export page/ });
  await dlg.waitFor({ timeout: 10000 });
  return dlg;
}

async function flip(dlg, name, want) {
  const sw = dlg.getByRole("switch", { name });
  await sw.waitFor({ state: "attached", timeout: 10000 });
  if ((await sw.isChecked()) !== want) await dlg.getByText(name, { exact: true }).click();
  if ((await sw.isChecked()) !== want) fail(`couldn't set ${name}`);
}

async function download(p, dlg) {
  const go = dlg.getByRole("button", { name: /^Download/ });
  const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 30000 }), go.click()]);
  const file = path.join(OUT, `${Date.now().toString(36)}-${dl.suggestedFilename()}`);
  await dl.saveAs(file);
  return { file, name: dl.suggestedFilename() };
}

function unzip(file, member) {
  return execFileSync("unzip", ["-p", file, member], { encoding: "utf8" });
}

async function openPage(slug, who = "owner", opts = {}) {
  const { c, p } = await ctx(browser, { token: T[who], ...opts });
  await stubPrint(c);
  await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  await p.locator(".pb-title").first().waitFor({ timeout: 30000 });
  return { c, p };
}

await step("word", async () => {
  const slug = await discussed("Word export");
  const { c, p } = await openPage(slug);
  const dlg = await openExport(p);
  await dlg.getByRole("radio", { name: /^Word/ }).click();
  await flip(dlg, "Include comments", true);
  await dlg.getByText("4 threads, 3 open.").waitFor({ timeout: 5000 });
  await shot(p, "reach-export-word");
  const got = await download(p, dlg);
  if (!/\.docx$/.test(got.name)) fail(`file ${got.name}`);
  const doc = unzip(got.file, "word/document.xml");
  const comments = unzip(got.file, "word/comments.xml");
  const starts = (doc.match(/<w:commentRangeStart/g) || []).length;
  if (starts !== 4) fail(`${starts} margin comments`);
  if (!comments.includes("Is Monday realistic?") || !comments.includes("Yes, the build is green.")) fail("comment text missing");
  log(`word → ${got.name}, ${starts} margin comments`);
  // Footnotes instead, open threads only.
  const dlg2 = await openExport(p);
  await dlg2.getByRole("radio", { name: /^Word/ }).click();
  await flip(dlg2, "Include comments", true);
  await dlg2.getByRole("radio", { name: "Footnotes" }).click();
  await flip(dlg2, "Open threads only", true);
  const got2 = await download(p, dlg2);
  const notes = (unzip(got2.file, "word/document.xml").match(/<w:footnoteReference/g) || []).length;
  if (notes !== 3) fail(`${notes} footnotes`);
  log(`word footnotes, open only → ${notes} footnotes`);
  await c.close();
});

await step("markdown", async () => {
  const slug = await discussed("Markdown export");
  const { c, p } = await openPage(slug);
  const dlg = await openExport(p);
  await dlg.getByRole("radio", { name: /^Markdown/ }).click();
  await flip(dlg, "Include comments", true);
  if (await dlg.getByRole("radio", { name: "Footnotes" }).count()) fail("Markdown offers a comment style");
  await dlg.getByText(/Comments section at the end/).waitFor({ timeout: 5000 });
  const got = await download(p, dlg);
  const md = fs.readFileSync(got.file, "utf8");
  const appendix = md.split("## Comments")[1] || fail("no Comments section");
  const order = ["On the whole page", "ship the new editor on Monday", "three waves", "payments API"].map((s) => appendix.indexOf(s));
  if (order.some((i) => i < 0) || order.join() !== [...order].sort((a, b) => a - b).join()) fail(`order ${order}`);
  log(`markdown → ${got.name} with the Comments section in page order`);
  await c.close();
});

await step("pdf", async () => {
  const slug = await discussed("PDF export");
  const { c, p } = await openPage(slug);
  for (const style of ["Margin notes", "Notes at the end"]) {
    const dlg = await openExport(p);
    await dlg.getByRole("radio", { name: /^PDF/ }).click();
    await flip(dlg, "Include comments", true);
    await dlg.getByRole("radio", { name: style }).click();
    await dlg.getByRole("button", { name: /^Print to PDF/ }).click();
    await p.waitForFunction(() => window.__printed === true, null, { timeout: 30000 });
    const marks = await p.locator(".pbx-print .pbx-cmark").count();
    const margin = await p.locator(".pbx-print aside.pbx-cnote").count();
    const end = await p.locator(".pbx-print .pbx-cnotes li").count();
    if (marks !== 4) fail(`${style}: ${marks} markers`);
    if (style === "Margin notes" && margin !== 4) fail(`${margin} margin notes`);
    if (style === "Notes at the end" && end !== 4) fail(`${end} notes at the end`);
    const firstText = await p.locator(".pbx-print .pbx-cmark").nth(1).evaluate((el) => el.previousSibling?.textContent ?? "");
    if (!/Monday$/.test(firstText.trim())) fail(`marker after "${firstText.slice(-30)}"`);
    await p.emulateMedia({ media: "print" });
    console.log("  dbg", await p.evaluate(() => {
      const m = document.querySelector(".pbx-print .pbx-cmark"), a = document.querySelector(".pbx-print aside.pbx-cnote");
      const sec = document.querySelector(".pbx-print__page");
      const cs = (e) => (e ? (({ color, float, width, marginRight, display }) => ({ color, float, width, marginRight, display }))(getComputedStyle(e)) : null);
      return JSON.stringify({ sec: sec.className, body: sec.querySelector(".pb-body")?.className, pad: getComputedStyle(sec.querySelector(".pb-body") || sec).paddingRight, m: cs(m), a: cs(a), ap: a?.parentElement?.tagName, r: a?.getBoundingClientRect() });
    }));
    await shot(p, `reach-pdf-${style.startsWith("Margin") ? "margin" : "end"}`);
    await p.emulateMedia({ media: "screen" });
    log(`pdf ${style}: ${marks} markers, ${margin} margin notes, ${end} at the end`);
    await p.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    await p.locator(".pbx-print").waitFor({ state: "detached", timeout: 10000 });
    await p.evaluate(() => (window.__printed = false));
  }
  await c.close();
});

await step("panel", async () => {
  const slug = await discussed("Panel insights");
  const { c, p } = await openPage(slug, "member");
  await p.waitForTimeout(500);
  if (!(await p.locator("aside.mdc-panel").count())) await p.locator(".mdc-topbtn").first().click();
  const panel = p.locator("aside.mdc-panel");
  await panel.waitFor({ timeout: 10000 });
  await panel.getByRole("button", { name: "More" }).click();
  await p.getByRole("menuitem", { name: "Comment insights" }).click();
  const dlg = p.getByRole("dialog", { name: "Comment insights" });
  await dlg.waitFor({ timeout: 10000 });
  await dlg.getByText(/4 comment threads \(3 open, 1 resolved/).waitFor({ timeout: 10000 });
  await dlg.getByText("Most discussed").waitFor();
  await shot(p, "reach-panel-insights");
  await dlg.getByRole("button", { name: "Close" }).first().click();
  await dlg.waitFor({ state: "detached", timeout: 5000 });
  await panel.getByRole("button", { name: "More" }).click();
  await p.getByRole("menuitem", { name: /Export with comments/ }).click();
  const ex = p.getByRole("dialog", { name: /Export page/ });
  await ex.waitFor({ timeout: 10000 });
  if (!(await ex.getByRole("switch", { name: "Include comments" }).isChecked())) fail("Export with comments opened with comments off");
  log("panel: insights dialog, Export with comments… opens the dialog with comments on");
  await c.close();
});

await step("analytics", async () => {
  const slug = await discussed("Analytics tab");
  const { c, p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/dashboard/analytics/${slug}?tab=comments`, { waitUntil: "networkidle" });
  await p.getByRole("tab", { name: "Comments" }).waitFor({ timeout: 30000 });
  const box = p.locator("[data-testid=comment-insights]");
  await box.waitFor({ timeout: 20000 });
  await box.getByText("Open threads", { exact: true }).waitFor();
  await box.getByText("Most active").waitFor();
  await shot(p, "reach-analytics-comments");
  log("analytics: Comments tab");
  await c.close();
});

await step("settings", async () => {
  const { c, p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/settings/account#email`, { waitUntil: "networkidle" });
  const act = p.locator("#email-comment-activity");
  await act.waitFor({ timeout: 30000 });
  if ((await act.inputValue()) !== "instant") fail("activity default");
  const label = await act.locator("option[value=instant]").textContent();
  if (label !== "Every 15 minutes") fail(`label ${label}`);
  await act.selectOption("hourly");
  await p.waitForTimeout(800);
  const me = await api("GET", "/api/v1/auth/me", T.member);
  if (me.body.email_notify.comment_activity !== "hourly") fail("activity not saved");
  const sw = p.getByRole("switch", { name: "Daily comments digest" });
  await sw.waitFor({ state: "attached" });
  if (!(await sw.isChecked())) fail("digest default off");
  await sw.evaluate((el) => el.click());   // the row's label is a <p>: the switch itself
  await p.waitForTimeout(800);
  const d = await api("GET", "/api/v1/comments/digest/settings", T.member);
  if (d.body.on !== false) fail("digest not turned off");
  await p.locator("#email-comment-mentions").scrollIntoViewIfNeeded();
  await shot(p, "reach-settings-email");
  await api("PUT", "/api/v1/comments/digest/settings", T.member, { on: true });
  log("settings: comment rows + digest switch");
  await c.close();
});

await step("phone", async () => {
  const slug = await discussed("Phone export");
  const { c, p } = await openPage(slug, "owner", { width: 390, height: 844, mobile: true });
  const dlg = await openExport(p);
  await dlg.getByRole("radio", { name: /^Word/ }).click();
  await flip(dlg, "Include comments", true);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) fail("the page scrolls sideways at 390 px");
  await shot(p, "reach-export-phone");
  await c.close();
});

await browser.close();
const bad = results.filter((r) => r[1] !== "ok");
console.log(JSON.stringify(results, null, 1));
process.exit(bad.length ? 1 : 0);
