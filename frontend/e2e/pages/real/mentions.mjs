/**
 * People mentions on the real stack (up.sh): the `@` picker and "/person" (docs-editor/menus/people.tsx).
 *   person    "/person" lists the workspace's members (avatar, name, email); typing filters; Enter inserts
 *   at        "@" + a fuzzy query filters, ↓ and Enter insert; it saves as :person[…]{id}, and renders after a reload
 *   keys      Esc closes and keeps the text; Backspace past "@" closes; "a@b.com" never opens it; the mouse picks
 *   code      no picker in a code block, a Mermaid block or inline code
 *   table     "@" and "/" in a table cell: the people picker, and a "/" menu of inline items (Date, /person)
 *   member    a member sees the same list, with addresses
 *   personal  a page in no workspace says there's no one to mention
 *   tenant    on the workspace's own domain the list has names, never addresses
 *   phone     at 390 px the popup stays inside the screen
 * Uses the existing seed (never reseeds; run real.mjs or seed.py first) and makes its own pages.
 *
 *   [BROWSER=webkit] [ONLY=at,table] node mentions.mjs
 */
import { APP, TENANT, log, fail, seedNow, api, docOf, launch, ctx, stepper, shot, waitSaved } from "./lib.mjs";

const S = seedNow();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const ID = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.id]));
const browser = await launch();
const { step, results } = stepper(browser);
const run = Date.now().toString(36).slice(-5);

async function newPage(title, content, { personal = false, as = "owner" } = {}) {
  const body = personal ? { title, content } : { title, workspace: S.ws, folder: S.folder, content };
  const r = await api("POST", "/api/v1/pages", T[as], body);
  if (r.status >= 300) fail(`create ${title} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body.document.slug;
}
const content = async (slug) => (await docOf(slug, T.owner)).content;

/** Opens a page in the editor and puts the caret at the end of the text `at`. */
async function openAt(p, url, at) {
  await p.goto(url, { waitUntil: "networkidle" });
  const ed = p.locator('.pb-live .ProseMirror[contenteditable="true"]');
  await ed.waitFor({ timeout: 30000 });
  await p.waitForTimeout(1200);
  await caretAfter(p, at);
  return ed;
}
async function caretAfter(p, at) {
  await p.locator(".pb-live .ProseMirror").getByText(at, { exact: false }).first().click();
  await p.waitForTimeout(250); // ProseMirror reads a click's caret on the next selectionchange
  await p.keyboard.press("End");
}
const popup = (p) => p.locator(".dxe-people");
const rows = (p) => p.locator(".dxe-people [role=option]");
async function rowNames(p) {
  return (await p.locator(".dxe-people .dxe-people__name").allInnerTexts()).map((t) => t.replace(/\s*\(you\)$/, "").trim());
}
async function waitRows(p, n = 1) {
  await popup(p).waitFor({ timeout: 8000 });
  await p.waitForFunction((k) => document.querySelectorAll(".dxe-people [role=option]").length >= k, n, { timeout: 8000 });
}
const closed = async (p) => {
  await p.waitForTimeout(300);
  return (await popup(p).count()) === 0;
};

/* ── 1. /person lists the workspace's members; typing filters; Enter inserts ── */
await step("person", async () => {
  const slug = await newPage(`Mentions ${run}`, "Hello there\n");
  const { p } = await ctx(browser, { token: T.owner });
  await openAt(p, `${APP}/${slug}`, "Hello there");
  await p.keyboard.type(" /person");
  await p.locator(".dxe-slash").first().waitFor();
  await p.keyboard.press("Enter");
  await waitRows(p, 4);
  const names = await rowNames(p);
  for (const n of ["Ada Owner", "Ben Member", "Wes Admin", "Vic Viewer"]) if (!names.includes(n)) fail(`/person doesn't list ${n}: ${names}`);
  const text = await popup(p).innerText();
  if (!text.includes("ben@acme.test")) fail(`no email in the list: ${text.slice(0, 200)}`);
  if (!(await popup(p).locator(".md-avatar").count())) fail("no avatars");
  await shot(p, "m01-person-lists-members");
  await p.keyboard.type("ben");
  await p.waitForTimeout(250);
  const filtered = await rowNames(p);
  if (filtered[0] !== "Ben Member") fail(`"ben" → ${filtered}`);
  await p.keyboard.press("Enter");
  await p.locator(".pb-live .pb-mention--person", { hasText: "Ben Member" }).waitFor({ timeout: 5000 });
  if (!(await closed(p))) fail("the picker stayed open after Enter");
  await waitSaved(p);
  const md = await content(slug);
  if (!md.includes(`:person[Ben Member]{id="${ID.member}"}`) && !md.includes(`:person[Ben Member]{id=${ID.member}}`)) fail(`saved: ${md}`);
  log("saved", md.trim().split("\n")[0]);
});

/* ── 2. @ filters (fuzzy), arrows and Enter insert; save, reload, it renders ── */
await step("at", async () => {
  const slug = await newPage(`At mentions ${run}`, "First line\n");
  const { p } = await ctx(browser, { token: T.owner });
  await openAt(p, `${APP}/${slug}`, "First line");
  await p.keyboard.press("Enter");
  await p.keyboard.type("Ask @");
  await waitRows(p, 4);
  await shot(p, "m02-at-opens");
  await p.keyboard.type("wsad"); // letters in order → Wes Admin
  await p.waitForTimeout(250);
  const n1 = await rowNames(p);
  if (n1[0] !== "Wes Admin") fail(`"@wsad" → ${n1}`);
  await shot(p, "m03-at-fuzzy");
  await p.keyboard.press("Enter");
  await p.locator(".pb-live .pb-mention--person", { hasText: "Wes Admin" }).waitFor({ timeout: 5000 });
  // A second one with the arrows: "@" + "vic" by email-ish, ↓ ↑ then Tab.
  await p.keyboard.type("and @v");
  await waitRows(p, 1);
  const n2 = await rowNames(p);
  if (n2[0] !== "Vic Viewer") fail(`"@v" → ${n2}`);
  await p.keyboard.press("ArrowDown");
  await p.keyboard.press("ArrowUp");
  await p.keyboard.press("Tab");
  await p.locator(".pb-live .pb-mention--person", { hasText: "Vic Viewer" }).waitFor({ timeout: 5000 });
  await p.keyboard.type("today.");
  await waitSaved(p);
  const md = await content(slug);
  if (!new RegExp(`Ask :person\\[Wes Admin\\]\\{id="?${ID.admin}"?\\} and :person\\[Vic Viewer\\]\\{id="?${ID.reader}"?\\} today\\.`).test(md)) fail(`saved: ${md}`);
  if (!/\{#b-[a-z0-9]+\}/.test(md)) fail(`the mention's block has no anchor: ${md}`);
  await p.reload({ waitUntil: "networkidle" });
  await p.locator(".pb-live .ProseMirror").waitFor({ timeout: 30000 });
  await p.locator(".pb-mention--person", { hasText: "Wes Admin" }).first().waitFor({ timeout: 15000 });
  await p.locator(".pb-mention--person", { hasText: "Vic Viewer" }).first().waitFor({ timeout: 15000 });
  await shot(p, "m04-at-after-reload");
  // A reader (Vic) sees the chips too.
  const r = await ctx(browser, { token: T.reader });
  await r.p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  await r.p.locator(".pb-mention--person", { hasText: "Wes Admin" }).first().waitFor({ timeout: 20000 });
});

/* ── 3. Esc keeps the text; Backspace past @ closes; a@b.com never opens it; the mouse picks ── */
await step("keys", async () => {
  const slug = await newPage(`Mention keys ${run}`, "Keys line\n");
  const { p } = await ctx(browser, { token: T.owner });
  await openAt(p, `${APP}/${slug}`, "Keys line");
  await p.keyboard.type(" @be");
  await waitRows(p, 1);
  await p.keyboard.press("Escape");
  if (!(await closed(p))) fail("Esc didn't close the picker");
  // Typing on after Esc doesn't bring it back for this @.
  await p.keyboard.type("n");
  if (!(await closed(p))) fail("the picker came back after Esc");
  const line = await p.locator(".pb-live .ProseMirror p", { hasText: "Keys line" }).first().innerText();
  if (!line.includes("Keys line @ben")) fail(`Esc lost the text: ${JSON.stringify(line)}`);
  // Backspace past the @ closes it.
  await p.keyboard.type(" @w");
  await waitRows(p, 1);
  await p.keyboard.press("Backspace");
  await popup(p).waitFor({ timeout: 3000 });
  await p.keyboard.press("Backspace");
  if (!(await closed(p))) fail("Backspace past @ didn't close the picker");
  // An email address never opens it.
  await p.keyboard.type(" mail ana@example.com");
  if (!(await closed(p))) fail("a@b opened the picker");
  // A word that matches nobody, then a space: closes, text kept.
  await p.keyboard.type(" @nobody");
  await popup(p).getByText("No one matches").waitFor({ timeout: 5000 });
  await shot(p, "m05-no-one-matches");
  await p.keyboard.type(" else");
  if (!(await closed(p))) fail("no match + space kept the picker open");
  // The mouse: open, click the second row.
  await p.keyboard.type(" @");
  await waitRows(p, 2);
  const second = (await rowNames(p))[1];
  await rows(p).nth(1).click();
  await p.locator(".pb-live .pb-mention--person", { hasText: second }).waitFor({ timeout: 5000 });
  await waitSaved(p);
  const md = await content(slug);
  if (!md.includes("Keys line @ben") || !md.includes("ana@example.com") || !md.includes("@nobody else")) fail(`saved: ${md}`);
});

/* ── 4. no picker in code ── */
await step("code", async () => {
  const slug = await newPage(`Mention code ${run}`, "Intro text\n\n```js\nconst x = 1;\n```\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nUse `inline code` here.\n");
  const { p } = await ctx(browser, { token: T.owner });
  await openAt(p, `${APP}/${slug}`, "const x = 1;");
  await p.keyboard.type(" @be");
  if (!(await closed(p))) fail("@ opened the picker in a code block");
  await shot(p, "m06-no-picker-in-code");
  // Mermaid: the diagram until clicked, then its code (views/code.tsx).
  const mermaid = p.locator('.pb-live .dxe-code[data-lang="mermaid"]').first();
  await mermaid.locator(".md-diagram__canvas > svg").first().click();
  await p.waitForTimeout(400);
  await p.keyboard.press("End");
  await p.keyboard.type(" @be");
  if (!(await closed(p))) fail("@ opened the picker in a Mermaid block");
  await p.keyboard.press("Escape"); // Mermaid's own Esc: shows the diagram again; the picker isn't involved
  await p.waitForTimeout(400);
  // Inline code: the caret inside `inline code`.
  await p.locator(".pb-live .ProseMirror code", { hasText: "inline code" }).first().click();
  await p.waitForTimeout(250);
  await p.keyboard.type(" @be");
  if (!(await closed(p))) fail("@ opened the picker in inline code");
  await waitSaved(p);
  const md = await content(slug);
  if (!md.includes("const x = 1; @be") || md.includes(":person[")) fail(`saved: ${md}`);
});

/* ── 5. @ and / in a table cell ── */
await step("table", async () => {
  const slug = await newPage(`Mention table ${run}`, "Owners:\n\n| Task | Owner | Due |\n| --- | --- | --- |\n| Launch | Lead | Soon |\n| Docs | Writer | Later |\n");
  const { p } = await ctx(browser, { token: T.owner });
  await openAt(p, `${APP}/${slug}`, "Lead");
  await p.keyboard.type(" @ben");
  await waitRows(p, 1);
  await shot(p, "m07-at-in-table-cell");
  await p.keyboard.press("Enter");
  await p.locator(".pb-live td .pb-mention--person", { hasText: "Ben Member" }).waitFor({ timeout: 5000 });
  // "/" in a cell: only inline items.
  await caretAfter(p, "Soon");
  await p.keyboard.type(" /");
  const menu = p.locator(".dxe-slash").first();
  await menu.waitFor({ timeout: 5000 });
  const labels = await menu.locator(".dxe-slash__label").allInnerTexts();
  for (const want of ["Mention a person", "Date", "Emoji"]) if (!labels.includes(want)) fail(`the cell's / menu lacks ${want}: ${labels}`);
  for (const no of ["Table", "Heading 1", "Code", "Columns", "Image"]) if (labels.includes(no)) fail(`the cell's / menu offers ${no}`);
  await shot(p, "m08-slash-in-table-cell");
  await p.keyboard.type("date");
  await p.keyboard.press("Enter");
  await p.locator(".pb-live td .pb-mention--date").first().waitFor({ timeout: 5000 });
  // "/person" in a cell opens the same picker.
  await caretAfter(p, "Writer");
  await p.keyboard.type(" /person");
  await menu.waitFor();
  await p.keyboard.press("Enter");
  await waitRows(p, 2);
  await p.keyboard.type("wes");
  await p.keyboard.press("Enter");
  await p.locator(".pb-live td .pb-mention--person", { hasText: "Wes Admin" }).waitFor({ timeout: 5000 });
  await waitSaved(p);
  const md = await content(slug);
  if (!/\| Launch \| Lead :person\[Ben Member\]\{id="?[0-9a-f]+"?\} *\| Soon :date\[\d{4}-\d{2}-\d{2}\]/.test(md)) fail(`saved row 1: ${md}`);
  if (!/\| Docs \| Writer :person\[Wes Admin\]\{id="?[0-9a-f]+"?\}/.test(md)) fail(`saved row 2: ${md}`);
  await p.reload({ waitUntil: "networkidle" });
  await p.locator(".pb-live td .pb-mention--person", { hasText: "Wes Admin" }).waitFor({ timeout: 20000 });
  await shot(p, "m09-table-after-reload");
});

/* ── 6. a member sees the same list ── */
await step("member", async () => {
  const slug = await newPage(`Member mention ${run}`, "Member line\n");
  const { p } = await ctx(browser, { token: T.member });
  await openAt(p, `${APP}/${slug}`, "Member line");
  await p.keyboard.type(" @");
  await waitRows(p, 4);
  const text = await popup(p).innerText();
  if (!text.includes("Ben Member (you)") || !text.includes("ada@acme.test")) fail(`member's list: ${text.slice(0, 300)}`);
  await shot(p, "m10-member-list");
});

/* ── 7. a page in no workspace ── */
await step("personal", async () => {
  const slug = await newPage(`Personal mention ${run}`, "Personal line\n", { personal: true });
  const { p } = await ctx(browser, { token: T.owner });
  await openAt(p, `${APP}/${slug}`, "Personal line");
  await p.keyboard.type(" @");
  await popup(p).getByText("isn't in a workspace").waitFor({ timeout: 8000 });
  await shot(p, "m11-personal-page");
  await p.keyboard.type("x y");
  if (!(await closed(p))) fail("the personal note stayed open after a space");
});

/* ── 8. on the workspace's own domain: names, never addresses ── */
await step("tenant", async () => {
  const slug = await newPage(`Tenant mention ${run}`, "Domain line\n");
  const d = await docOf(slug, T.owner);
  const addr = `${TENANT}/${[...(d.folder_path || []), slug].join("/")}`;
  const { p } = await ctx(browser, { token: T.member });
  await fetch(`${APP}/api/revalidate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: "host:acme.localhost" }) });
  await p.goto(`${APP}/robots.txt`);
  await p.goto(addr, { waitUntil: "networkidle" });
  const ed = p.locator('.pb-live .ProseMirror[contenteditable="true"]');
  if (!(await ed.count())) {
    const signIn = p.getByRole("button", { name: /Sign in to read/ }).or(p.getByRole("link", { name: /Sign in to read/ }))
      .or(p.getByRole("link", { name: /^Sign in$/ })).or(p.getByRole("button", { name: /^Sign in$/ }));
    await signIn.first().click({ timeout: 20000 });
    await p.waitForURL((u) => u.hostname === "acme.localhost" && !u.hash.includes("mdt="), { timeout: 30000 }).catch(() => {});
    await p.waitForLoadState("networkidle");
  }
  await ed.waitFor({ timeout: 30000 });
  await p.waitForTimeout(1200);
  await caretAfter(p, "Domain line");
  await p.keyboard.type(" @");
  await waitRows(p, 4);
  const text = await popup(p).innerText();
  if (text.includes("@acme.test")) fail(`an address on the domain: ${text.slice(0, 300)}`);
  if (!text.includes("Wes Admin")) fail(`domain list: ${text.slice(0, 300)}`);
  await shot(p, "m12-tenant-names-only");
  await p.keyboard.type("wes");
  await p.keyboard.press("Enter");
  await p.locator(".pb-live .pb-mention--person", { hasText: "Wes Admin" }).waitFor({ timeout: 5000 });
  await waitSaved(p);
  if (!(await content(slug)).includes(`:person[Wes Admin]`)) fail("the domain's mention didn't save");
});

/* ── 9. phone width: inside the screen ── */
await step("phone", async () => {
  const slug = await newPage(`Phone mention ${run}`, "A long line of text that reaches the right edge of a phone screen\n");
  const { p } = await ctx(browser, { token: T.owner, width: 390, height: 844, mobile: true });
  await openAt(p, `${APP}/${slug}`, "phone screen");
  await p.keyboard.type(" @");
  await waitRows(p, 4);
  await p.waitForTimeout(300);
  const box = await popup(p).boundingBox();
  if (!box || box.x < 0 || box.x + box.width > 390 + 0.5 || box.y < 0 || box.y + box.height > 844 + 0.5) fail(`off screen: ${JSON.stringify(box)}`);
  await shot(p, "m13-phone");
  await p.keyboard.type("ada");
  await p.keyboard.press("Enter");
  await p.locator(".pb-live .pb-mention--person", { hasText: "Ada Owner" }).waitFor({ timeout: 5000 });
});

await browser.close();
console.log("\n" + results.map(([n, r, ms]) => `${r === "ok" ? "✓" : "✗"} ${n.padEnd(10)} ${r} (${(ms / 1000).toFixed(1)} s)`).join("\n"));
if (results.some(([, r]) => r !== "ok")) process.exit(1);
