/**
 * Jira inside pages on the REAL stack (components/jira/pages, backend services/jira_pages.py), against the fake
 * Atlassian (up.sh with PB_FAKE_JIRA=1 PB_FAKE_MEETINGS_AI=1: backend/tests/_jira_fake.py; no real Atlassian call):
 *
 *   reader    Ben (connected) reads a page with a chip, a card and a live list: live status, assignee, sprint…
 *   anon      a signed-out reader: "KEY · title" only, no status anywhere in what the API sent, the list asks to sign in
 *   noperm    Vic (his Jira sees WEB only): the PAY chip and card stay "KEY · title"; the list has no PAY row
 *   connect   Wes (not connected): "Connect Jira" on the card and the list
 *   status    Ben moves the card's issue through the status menu; Ada's open page follows live (no reload)
 *   required  a step that asks for a resolution: the dialog, then Done; Jira got the field
 *   assign    Ben assigns from the card (people search), comments, edits the title (as himself in Jira)
 *   listrow   a list row's status menu moves that issue
 *   editor    Ada: /jira → picker search → chip; /Jira list → project WEB → live preview; a pasted Jira link → chip;
 *             @PAY-3 → chip; saved as :jira[…] / ::jira-list{…}
 *   select    Ada selects text → Create Jira issue → the text becomes the new issue's chip
 *   thread    a comment thread → Create Jira issue (draft, review, create) → the thread shows the issue
 *   mobile    at 390 px: chip, card and list fit (the list scrolls inside itself); light + dark shots
 *   slashgate Wes (not connected): "/jira my issues" → the Connect Jira prompt → Atlassian (faked) → back in
 *             Edit, and the list goes in where he typed it
 *   presets   Ada: /jira my issues, sprint, bugs, recently updated, epic, card, create, from selection → saved
 *             as ::jira-list{jql=…} / ::jira{…} / :jira[…]
 *
 *   PB_FAKE_JIRA=1 PB_FAKE_MEETINGS_AI=1 PB_STACK_ID=74 PB_WORK=… zsh up.sh start
 *   PB_STACK_ID=74 PB_WORK=… BROWSER=chromium|webkit [ONLY=reader,anon] node jira-pages.mjs
 */
import { APP, BROWSER, log, fail, reseed, api, launch, ctx, stepper, shot, editPage, waitSaved } from "./lib.mjs";

const S = reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const ACC = { owner: "acc-ada", member: "acc-ben", admin: "acc-wes", reader: "acc-vic" };
const ok = (r, what) => { if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const browser = await launch();
const { step, results } = stepper(browser);
const run = Date.now().toString(36).slice(-5);
const issue = async (key) => ok(await api("GET", `/__sandbox/jira/issue/${key}`), `issue ${key}`);

ok(await api("POST", "/__sandbox/jira/reset"), "reset the fake Jira");

async function connectApi(who) {
  const { url } = ok(await api("POST", "/api/v1/jira/connect/start", T[who], { kind: "me", workspace_id: WS }), `start ${who}`);
  const state = new URL(url).searchParams.get("state");
  ok(await api("POST", "/api/v1/jira/connect/finish", T[who], { code: `code-${ACC[who]}`, state }), `finish ${who}`);
}
await connectApi("owner");
ok(await api("PUT", "/api/v1/jira/site", T.owner, { workspace_id: WS, cloud_id: "cloud-acme", projects: ["PAY", "WEB"], default_project: "PAY", default_issue_type: "Task" }), "site");
await connectApi("member");
await connectApi("reader");

const BODY = `# Payments launch ${run}

Card retries are tracked in :jira[PAY-1] and the refund flow is next.

::jira{key=PAY-2}

## Open work

::jira-list{project=PAY cols="status,assignee,priority,due" title="Payments issues"}

We still need to migrate the billing webhooks before Friday.
`;

async function newPage(title, content = BODY) {
  const r = await api("POST", "/api/v1/pages", T.owner, { title, workspace: WS, folder: S.folder, content, auto_cover: false });
  if (r.status >= 300) fail(`create ${title} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const slug = r.body.document.slug;
  // Public link, so a signed-out reader can open it too.
  ok(await api("PUT", `/api/v1/documents/${slug}/access/level`, T.owner, { level: "link" }), "level");
  // The owner's save took the snapshots (titles) under the owner's own Jira.
  return slug;
}
const SLUG = await newPage(`Payments launch ${run}`);
const pageUrl = `${APP}/${SLUG}`;
const chip = (p, key = "PAY-1") => p.locator(`[data-testid="jira-inline"][data-key="${key}"]`).first();
const card = (p, key = "PAY-2") => p.locator(`[data-testid="jira-card"][data-key="${key}"]`).first();
const list = (p) => p.locator('[data-testid="jira-list"]').first();

async function open(who, opts = {}) {
  const { c, p } = await ctx(browser, { token: who ? T[who] : null, ...opts });
  await p.goto(pageUrl, { waitUntil: "domcontentloaded" });
  await p.locator(".pb-page").first().waitFor({ timeout: 30000 });
  return { c, p };
}

async function noOverflow(p, what) {
  const o = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (o > 1) fail(`${what}: the page scrolls sideways by ${o}px`);
}

await step("reader", async () => {
  // Snapshots are taken in the background after the save: wait for the title to be there.
  for (let i = 0; i < 20; i++) {
    const r = ok(await api("GET", `/api/v1/jira/pages/${SLUG}/items`), "items");
    if (r.items["acme.atlassian.net/PAY-1"]?.title) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const { p } = await open("member");
  await chip(p).locator(".jr-status").waitFor({ timeout: 20000 });
  const t = await chip(p).innerText();
  if (!/PAY-1/.test(t) || !/Retry failed card payments/.test(t) || !/In Progress/i.test(t)) fail(`chip: ${t}`);
  await card(p).getByText("Refund flow for annual plans").waitFor({ timeout: 15000 });
  const ct = await card(p).innerText();
  for (const want of ["PAY-2", "To Do", "Ben Member", "Medium"]) if (!ct.includes(want) && !ct.toLowerCase().includes(want.toLowerCase())) fail(`card lacks ${want}: ${ct}`);
  await list(p).locator('[data-testid="jira-list-row"]').first().waitFor({ timeout: 15000 });
  const rows = await list(p).locator('[data-testid="jira-list-row"]').count();
  if (rows !== 3) fail(`list rows: ${rows}`);
  await shot(p, "jira-pages-reader");
  // The chip opens the issue's card.
  await chip(p).click();
  await p.locator('[role="dialog"]').getByText("Retry failed card payments").first().waitFor({ timeout: 8000 });
  await shot(p, "jira-pages-chip-open");
  await p.keyboard.press("Escape");
});

await step("anon", async () => {
  const { c, p } = await ctx(browser, { token: null });
  const bodies = [];
  p.on("response", async (r) => {
    if (r.url().includes("/api/v1/jira/")) bodies.push([r.url(), await r.text().catch(() => "")]);
  });
  await p.goto(pageUrl, { waitUntil: "domcontentloaded" });
  await chip(p).waitFor({ timeout: 30000 });
  await p.waitForTimeout(1500);
  const t = await chip(p).innerText();
  if (!/PAY-1/.test(t) || !/Retry failed card payments/.test(t)) fail(`anon chip: ${t}`);
  if (await chip(p).locator(".jr-status").count()) fail("anon chip shows a status");
  const href = await chip(p).getAttribute("href");
  if (href !== "https://acme.atlassian.net/browse/PAY-1") fail(`anon chip href ${href}`);
  await list(p).getByText("Sign in and connect Jira").waitFor({ timeout: 8000 });
  const urls = bodies.map(([u]) => new URL(u).pathname);
  if (urls.some((u) => !u.endsWith("/items"))) fail(`anon called ${urls}`);
  for (const [, b] of bodies) if (/In Progress|Ben Member|"status"/.test(b)) fail(`anon got issue details: ${b.slice(0, 300)}`);
  await shot(p, "jira-pages-anon");
  await c.close();
});

await step("noperm", async () => {
  const { p } = await open("reader");
  await chip(p).waitFor({ timeout: 30000 });
  await card(p).getByText("Your Jira can't open this issue").waitFor({ timeout: 15000 });
  if (await chip(p).locator(".jr-status").count()) fail("Vic's PAY chip shows a status");
  await list(p).getByText("No issues match").waitFor({ timeout: 15000 });
});

await step("connect", async () => {
  const { p } = await open("admin");
  await card(p).getByTestId("jira-connect").waitFor({ timeout: 30000 });
  await list(p).getByTestId("jira-connect").waitFor({ timeout: 15000 });
  await shot(p, "jira-pages-connect");
});

await step("status", async () => {
  const ben = await open("member");
  const ada = await open("owner");
  await card(ada.p).locator('[data-testid="jira-status"]').waitFor({ timeout: 20000 });
  await card(ben.p).locator('[data-testid="jira-status"]').click();
  await ben.p.getByRole("menuitem", { name: /In Progress/ }).first().click();
  await card(ben.p).locator(".jr-status", { hasText: /In Progress/i }).waitFor({ timeout: 10000 });
  if ((await issue("PAY-2")).fields.status.name !== "In Progress") fail("Jira didn't move");
  // Ada's page follows live (the socket's nudge, re-read under her own Jira).
  await card(ada.p).locator(".jr-status", { hasText: /In Progress/i }).waitFor({ timeout: 15000 });
  await shot(ben.p, "jira-pages-status-menu");
});

await step("required", async () => {
  const { p } = await open("member");
  await card(p).locator('[data-testid="jira-status"]').click();
  await p.getByRole("menuitem", { name: /Resolve/ }).first().click();
  const sel = p.locator('[data-testid="jira-field-resolution"]');
  await sel.waitFor({ timeout: 8000 });
  await shot(p, "jira-pages-required-field");
  await sel.selectOption({ label: "Fixed" });
  await p.getByTestId("jira-step-go").click();
  await card(p).locator(".jr-status", { hasText: /Done/i }).waitFor({ timeout: 10000 });
  const it = await issue("PAY-2");
  if (it.fields.status.name !== "Done" || it.fields.resolution?.id !== "1") fail(`Jira: ${JSON.stringify(it.fields).slice(0, 300)}`);
});

await step("assign", async () => {
  const { p } = await open("member");
  await card(p).locator('[data-testid="jira-assignee"]').click();
  await p.locator('[data-testid="jira-person"]', { hasText: "Wes Admin" }).first().click();
  await card(p).getByText("Wes Admin").waitFor({ timeout: 10000 });
  if ((await issue("PAY-2")).fields.assignee?.accountId !== "acc-wes") fail("not assigned in Jira");
  await card(p).getByTestId("jira-comment").click();
  await p.getByRole("textbox", { name: "Comment" }).fill("Shipping this with the checkout.");
  await p.getByTestId("jira-comment-send").click();
  await p.waitForTimeout(1200);
  const cm = ok(await api("GET", "/__sandbox/jira/comments/PAY-2"), "comments").comments;
  if (cm.length !== 1 || cm[0].by !== "acc-ben") fail(`comment: ${JSON.stringify(cm)}`);
  await card(p).getByTestId("jira-edit").click();
  await p.getByTestId("jira-edit-summary").fill("Refund flow for annual and monthly plans");
  await p.getByTestId("jira-edit-save").click();
  await card(p).getByText("Refund flow for annual and monthly plans").waitFor({ timeout: 10000 });
  if ((await issue("PAY-2")).fields.summary !== "Refund flow for annual and monthly plans") fail("title not saved in Jira");
});

await step("listrow", async () => {
  const { p } = await open("member");
  const row = list(p).locator('[data-testid="jira-list-row"][data-key="PAY-3"]');
  await row.waitFor({ timeout: 20000 });
  await row.locator('[data-testid="jira-status"]').click();
  await p.getByRole("menuitem", { name: /^To Do/ }).first().click();
  await row.locator(".jr-status", { hasText: /To Do/i }).waitFor({ timeout: 10000 });
  if ((await issue("PAY-3")).fields.status.name !== "To Do") fail("row didn't move");
});

await step("listhook", async () => {
  // A page with only a list: an issue changing in Jira (the webhook) re-runs the list for an open reader.
  ok(await api("POST", "/__sandbox/jira/move", null, { key: "PAY-3", status: "To Do", by: ACC.owner, workspace_id: WS }), "PAY-3 to do");
  const slug = await newPage(`Done this week ${run}`, `# Done this week ${run}\n\n::jira-list{jql="project = PAY AND status = Done" title="Done"}\n`);
  const { c, p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/${slug}`, { waitUntil: "domcontentloaded" });
  await list(p).waitFor({ timeout: 30000 });
  const row = list(p).locator('[data-testid="jira-list-row"][data-key="PAY-3"]');
  await p.waitForTimeout(2000);
  if (await row.count()) fail("PAY-3 already in the Done list");
  ok(await api("POST", "/__sandbox/jira/move", null, { key: "PAY-3", status: "Done", by: ACC.owner, workspace_id: WS }), "PAY-3 done");
  await row.waitFor({ timeout: 20000 });
  await c.close();
});

await step("editor", async () => {
  const slug = await newPage(`Jira editor ${run}`, "Start here\n");
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  await editPage(p);
  const ed = p.locator('.pb-live .ProseMirror[contenteditable="true"]');
  await ed.waitFor({ timeout: 30000 });
  await p.waitForTimeout(1200);
  await p.locator(".pb-live .ProseMirror").getByText("Start here").first().click();
  await p.keyboard.press("End");
  // /jira → the picker → search → the chip.
  await p.keyboard.type(" /jira");
  await p.locator(".dxe-slash").first().waitFor();
  await p.locator(".dxe-slash [role=option]", { hasText: "Jira issue" }).first().click();
  const picker = p.getByTestId("jira-picker");
  await picker.waitFor({ timeout: 10000 });
  await picker.getByRole("textbox").fill("refund");
  await picker.getByTestId("jira-pick-row").first().click();
  await p.locator('.pb-live [data-testid="jira-inline"][data-key="PAY-2"]').waitFor({ timeout: 10000 });
  // The caret is back in the page once the picker has gone.
  await p.waitForFunction(() => document.activeElement?.classList.contains("ProseMirror"), null, { timeout: 5000 });
  // A pasted Jira link becomes a chip.
  await p.keyboard.press("End");
  await p.keyboard.press("Enter");
  await p.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "https://acme.atlassian.net/browse/WEB-2");
    document.querySelector('.pb-live .ProseMirror').dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await p.locator('.pb-live [data-testid="jira-inline"][data-key="WEB-2"]').waitFor({ timeout: 10000 });
  // @PAY-3 → its chip.
  // The pasted chip's title arrives a moment later: let it settle before typing, then type the mention.
  await p.locator('.pb-live [data-testid="jira-inline"][data-key="WEB-2"][aria-label*="WEB-2:"]').first().waitFor({ timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(400);
  await p.keyboard.type(" @PAY-3", { delay: 30 });
  await p.locator(".dxe-people [role=option]", { hasText: "PAY-3" }).first().waitFor({ state: "attached", timeout: 8000 });
  await p.keyboard.press("Enter");
  await p.locator('.pb-live [data-testid="jira-inline"][data-key="PAY-3"]').waitFor({ timeout: 10000 });
  // /Jira list → a project → the live preview.
  await p.keyboard.press("Enter");
  await p.keyboard.type("/jql");
  await p.locator(".dxe-slash [role=option]", { hasText: "Jira list" }).first().waitFor({ state: "attached", timeout: 8000 });
  await p.keyboard.press("Enter");
  const form = p.getByTestId("jira-list-form");
  await form.waitFor({ timeout: 10000 });
  await form.getByTestId("jira-list-value").fill("WEB");
  await form.getByTestId("jira-list-save").click();
  await p.locator('.pb-live [data-testid="jira-list-row"]').first().waitFor({ timeout: 15000 });
  await shot(p, "jira-pages-editor");
  await waitSaved(p);
  const md = ok(await api("GET", `/api/v1/documents/${slug}`, T.owner), "doc").content;
  for (const want of [":jira[PAY-2]", ':jira[WEB-2]{site="acme.atlassian.net"}', ":jira[PAY-3]", "::jira-list{project=\"WEB\""])
    if (!md.includes(want)) fail(`saved Markdown lacks ${want}: ${md}`);
});

await step("select", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(pageUrl, { waitUntil: "networkidle" });
  await editPage(p);
  await p.waitForTimeout(1200);
  const target = "migrate the billing webhooks";
  await p.evaluate((t) => {
    const root = document.querySelector(".pb-live .ProseMirror");
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(t);
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + t.length);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
        return;
      }
    }
    throw new Error("not found");
  }, target);
  await p.waitForTimeout(500);
  await p.getByRole("button", { name: "Create Jira issue" }).first().click();
  await p.getByTestId("jira-create").waitFor({ timeout: 20000 });
  await p.getByTestId("jira-create").click();
  await p.locator('.pb-live [data-testid="jira-inline"]', { hasText: "PAY-" }).filter({ hasNotText: "PAY-1" }).last().waitFor({ timeout: 15000 });
  await waitSaved(p);
  const md = ok(await api("GET", `/api/v1/documents/${SLUG}`, T.owner), "doc").content;
  if (md.includes(target)) fail("the selected text is still there");
  if (!/We still need to :jira\[PAY-\d+\] before Friday/.test(md)) fail(`no chip in its place: ${md}`);
});

await step("thread", async () => {
  const r = await api("POST", `/api/v1/documents/${SLUG}/comments`, T.member, {
    anchor: { type: "text", quote: { exact: "refund flow is next" } }, body: "Should this be its own ticket?" });
  if (r.status >= 300) fail(`comment → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const tid = r.body.id;
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${pageUrl}#c-${tid}`, { waitUntil: "domcontentloaded" });
  const th = p.locator(`[data-thread-id="${tid}"]`).first();
  await th.waitFor({ timeout: 30000 });
  // The thread's actions: A's menu (CommentsPanel) offers Track D's "Create Jira issue".
  const more = th.getByRole("button", { name: /more|actions/i }).first();
  if (await more.count()) await more.click();
  await p.getByRole("menuitem", { name: "Create Jira issue" }).or(p.getByRole("button", { name: "Create Jira issue" })).first().click({ timeout: 10000 });
  await p.getByTestId("jira-create").waitFor({ timeout: 20000 });
  await p.getByTestId("jira-create").click();
  await th.getByTestId("jira-thread").waitFor({ timeout: 15000 });
  await shot(p, "jira-pages-thread");
  const links = ok(await api("GET", `/api/v1/jira/pages/${SLUG}/threads`, T.member), "threads").threads;
  if (!links[tid]) fail("thread not linked");
});

await step("mobile", async () => {
  for (const theme of ["light", "dark"]) {
    const { p } = await open("member", { width: 390, height: 844, mobile: true, theme });
    await card(p).locator('[data-testid="jira-status"]').waitFor({ timeout: 20000 });
    await list(p).locator('[data-testid="jira-list-row"]').first().waitFor({ timeout: 15000 });
    await noOverflow(p, `phone ${theme}`);
    await shot(p, `jira-pages-phone-${theme}`);
  }
  const { p } = await open("member", { theme: "dark" });
  await card(p).locator('[data-testid="jira-status"]').waitFor({ timeout: 20000 });
  await shot(p, "jira-pages-dark");
});

/** A new empty line at the end of the page, with the caret in it. */
async function newLine(p) {
  await p.evaluate(() => {
    const ed = document.querySelector('.pb-live .ProseMirror').editor;
    ed.chain().insertContentAt(ed.state.doc.content.size, { type: "paragraph" }).focus("end").run();
  });
  await p.waitForTimeout(150);
}
/** Types a "/" command and picks the menu's first row (Enter). */
async function slash(p, cmd, label) {
  await p.keyboard.type(`/${cmd}`, { delay: 25 });
  await p.locator(".dxe-slash [role=option]").first().filter({ hasText: label }).waitFor({ state: "attached", timeout: 8000 });
  await p.keyboard.press("Enter");
}

await step("slashgate", async () => {
  const slug = await newPage(`Jira connect ${run}`, "Start here\n");
  const { p } = await ctx(browser, { token: T.admin });
  // Atlassian's page, faked: straight back to the callback with Wes's code (the server checks the state).
  await p.route("https://auth.jira.test/**", (r) => {
    const state = new URL(r.request().url()).searchParams.get("state");
    // A page that goes on (WebKit can't fulfill a request with a redirect).
    const to = `${APP}/integrations/jira/callback?code=code-${ACC.admin}&state=${encodeURIComponent(state)}`;
    return r.fulfill({ status: 200, contentType: "text/html", body: `<script>location.replace(${JSON.stringify(to)})</script>` });
  });
  await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  await editPage(p);
  await p.waitForTimeout(1200);
  await newLine(p);
  // Every command is offered, connected or not.
  await p.keyboard.type("/jira", { delay: 25 });
  await p.locator(".dxe-slash [role=option]", { hasText: "Jira sprint" }).first().waitFor({ state: "attached", timeout: 8000 });
  const n = await p.locator(".dxe-slash [role=option]").count();
  if (n < 10) fail(`"/jira" lists ${n} commands`);
  await shot(p, "jira-slash-menu");
  await p.keyboard.type(" my issues", { delay: 25 });
  await p.locator(".dxe-slash [role=option]").first().filter({ hasText: "My Jira issues" }).waitFor({ state: "attached", timeout: 8000 });
  await p.keyboard.press("Enter");
  const gate = p.getByTestId("jira-slash-gate");
  await gate.waitFor({ timeout: 10000 });
  if ((await gate.getAttribute("data-why")) !== "connect") fail(`gate: ${await gate.getAttribute("data-why")}`);
  await shot(p, "jira-slash-connect");
  await p.getByTestId("jira-slash-connect").click();
  // Back on the page, in Edit, and the list goes in.
  await p.waitForURL((u) => u.pathname === `/${slug}` && u.searchParams.get("jira") === "connected" || !u.searchParams.has("jira_add") && u.pathname === `/${slug}` && u.searchParams.has("edit"), { timeout: 30000 });
  await p.locator('.pb-live [data-testid="jira-list"]').first().waitFor({ timeout: 30000 }).catch(async (e) => {
    await shot(p, "jira-slash-connect-fail");
    fail(`after connecting: ${p.url()} ${e.message.split("\n")[0]}`);
  });
  if (new URL(p.url()).searchParams.has("jira_add")) fail(`the command stays in the address: ${p.url()}`);
  await waitSaved(p);
  const md = ok(await api("GET", `/api/v1/documents/${slug}`, T.owner), "doc").content;
  if (!md.includes('::jira-list{jql="assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC"')) fail(`saved: ${md}`);
  if (md.indexOf("Start here") > md.indexOf("::jira-list")) fail(`not where he typed it: ${md}`);
  await shot(p, "jira-slash-connected");
  // Wes is "not connected" again for anything after this.
  ok(await api("DELETE", "/api/v1/jira/me", T.admin), "disconnect");
});

await step("presets", async () => {
  const slug = await newPage(`Jira presets ${run}`, "Start here\n");
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  await editPage(p);
  await p.waitForTimeout(1200);
  const lists = p.locator('.pb-live [data-testid="jira-list"]');
  const project = async (key) => {
    const d = p.getByTestId("jira-slash-project");
    await d.waitFor({ timeout: 10000 });
    await d.getByTestId("jira-slash-project-key").fill(key);
    await p.getByTestId("jira-slash-project-add").click();
  };
  let want = 0;
  const added = async () => {
    want += 1;
    await p.waitForFunction((n) => document.querySelectorAll('.pb-live [data-testid="jira-list"]').length >= n, want, { timeout: 15000 });
  };
  await newLine(p);
  await slash(p, "jira my issues", "My Jira issues");
  await added();
  await newLine(p);
  await slash(p, "jira sprint", "Jira sprint");
  await project("PAY");
  await added();
  await newLine(p);
  await slash(p, "jira bugs", "Jira bugs");
  await project("PAY");
  await added();
  await newLine(p);
  await slash(p, "jira recently updated", "Jira recently updated");
  await project("WEB");
  await added();
  // The epic: its card and its children's list.
  await newLine(p);
  await slash(p, "jira epic", "Jira epic");
  const picker = p.getByTestId("jira-picker");
  await picker.waitFor({ timeout: 10000 });
  await picker.getByRole("textbox").fill("PAY-1");
  // The search's own row (not one from the list shown before it answered).
  await picker.getByTestId("jira-pick-row").filter({ has: p.locator(".jp-chip__key", { hasText: /^PAY-1$/ }) }).first().click();
  await added();
  await p.locator('.pb-live [data-testid="jira-card"][data-key="PAY-1"]').first().waitFor({ timeout: 15000 });
  // A card, through its picker.
  await newLine(p);
  await slash(p, "jira card", "Jira card");
  await picker.waitFor({ timeout: 10000 });
  await picker.getByRole("textbox").fill("refund");
  await picker.getByTestId("jira-pick-row").filter({ hasText: "Refund flow" }).first().click();
  await p.locator('.pb-live [data-testid="jira-card"][data-key="PAY-2"]').first().waitFor({ timeout: 15000 });
  await lists.last().locator('[data-testid="jira-list-row"]').first().waitFor({ timeout: 15000 });
  await shot(p, "jira-slash-presets");
  // "/jira create": the picker, ready to write the new issue.
  await newLine(p);
  await slash(p, "jira create", "New Jira issue");
  await picker.waitFor({ timeout: 10000 });
  await p.keyboard.press("Escape");
  await picker.waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
  // "/jira from selection": the line becomes a new issue, and its chip takes the text's place.
  await newLine(p);
  await p.keyboard.type("Write the rollback runbook /jira from", { delay: 15 });
  await p.locator(".dxe-slash [role=option]").first().filter({ hasText: "Jira issue from text" }).waitFor({ state: "attached", timeout: 8000 });
  await p.keyboard.press("Enter");
  await p.getByTestId("jira-create").waitFor({ timeout: 20000 });
  await p.getByTestId("jira-create").click();
  await waitSaved(p);
  await p.waitForTimeout(1500);
  await waitSaved(p);
  const md = ok(await api("GET", `/api/v1/documents/${slug}`, T.owner), "doc").content;
  for (const w of [
    'jql="assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC"',
    'jql="project = &quot;PAY&quot; AND sprint in openSprints() ORDER BY rank ASC"',
    'jql="project = &quot;PAY&quot; AND issuetype = Bug AND resolution = Unresolved ORDER BY priority DESC, created DESC"',
    'jql="project = &quot;WEB&quot; AND updated >= -7d ORDER BY updated DESC"',
    '::jira{key="PAY-1"}', 'jql="parent = PAY-1 ORDER BY rank ASC"', '::jira{key="PAY-2"}',
  ]) if (!md.includes(w)) fail(`saved Markdown lacks ${w}: ${md}`);
  if (md.includes("Write the rollback runbook")) fail(`the line is still text: ${md}`);
  if (!/\n:jira\[PAY-\d+\]\n/.test(md)) fail(`no chip for the new issue: ${md}`);
});

await browser.close();
console.log(`\n${BROWSER}\n` + results.map(([n, r, ms]) => `${r === "ok" ? "✓" : "✗"} ${n.padEnd(12)} ${r} (${(ms / 1000).toFixed(1)} s)`).join("\n"));
if (results.some(([, r]) => r !== "ok")) process.exit(1);
