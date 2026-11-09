/**
 * Jira Cloud on the REAL stack (up.sh with PB_FAKE_JIRA=1 PB_FAKE_MEETINGS_AI=1: the API talks to the fake
 * Atlassian in api_run.py — backend/tests/_jira_fake.py — and drafts come from a fake model; the browser's
 * trips to auth.jira.test are intercepted here and sent back to the callback page, as Atlassian would):
 *
 *   connect    Workspace settings › Integrations › Jira: Ada (owner) connects the site → back on the tab with
 *              the picker; default project PAY · Task, no Team projects yet → Connected + "Pick projects for Team"
 *   noprojects Team shows nothing from Jira: the admin is sent to the settings, a member is told an admin chooses
 *   projects   Change projects → PAY and WEB feed Team
 *   me         Ben connects his own Atlassian account from Settings › Account (back: "Connected as Ben Member")
 *   create     a meeting's action item → "+ Jira" → the AI draft (summary, Ben as assignee, the due date) → Ben
 *              edits the summary → Create issue → the item's chip (key · To Do · Ben Member); the issue in Jira
 *              has the edited summary, Ben as reporter and the link back to the meeting
 *   restricted a restricted meeting's dialog says the link only opens for people with access
 *   bulk       "Jira issues" in the meeting bar: the open action items without an issue → Create → chips
 *   sync       Ben ticks the linked to-do → the issue is Done in Jira; Jira moves it back → the box unticks;
 *              Jira moves it to Done → the box ticks (via the signed webhook)
 *   viewer     Vic (his Jira sees WEB only) gets a bare key for the PAY chip, and no issue detail in any body
 *   team       Ben (connected): his card's Jira line and top issues, the overdue list, the per-project table,
 *              his person page grouped; Wes (not connected): counts only, no issue in any body
 *   links      a pasted Jira URL gets a live chip for Ben; none for Vic
 *   editor     Edit mode: select text → the toolbar's "Create Jira issue" opens the dialog
 *   devices    phones: the Integrations tab and the dialog fit (no sideways scroll); shots light + dark
 *
 *   PB_FAKE_JIRA=1 PB_FAKE_MEETINGS_AI=1 PB_STACK_ID=67 PB_WORK=… zsh up.sh start
 *   PB_STACK_ID=67 PB_WORK=… BROWSER=chromium|webkit [ONLY=connect,me] node jira.mjs
 */
import { APP, BROWSER, log, fail, reseed, seedNow, api, launch, ctx, captureApi, stepper, shot } from "./lib.mjs";

const browser = await launch();
const { step, results } = stepper(browser);
const S = process.env.NO_RESEED ? seedNow() : reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const U = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.id]));
const WS = S.ws;
const ok = (r, what) => { if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const TAB = `${APP}/settings/workspaces/${WS}?tab=integrations`;
const teamUrl = `${APP}/team/${encodeURIComponent(WS)}`;
const ACC = { owner: "acc-ada", member: "acc-ben", admin: "acc-wes", reader: "acc-vic" };
const issue = async (key) => ok(await api("GET", `/__sandbox/jira/issue/${key}`), `issue ${key}`);
const TODO = "li:has(input[type=checkbox])";
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

if (!process.env.PB_FAKE_JIRA_KEEP) ok(await api("POST", "/__sandbox/jira/reset"), "reset the fake Jira");

/** Atlassian's consent screen: straight back to the callback with the person's code, as Atlassian does. */
async function fakeAtlassian(c, who, { deny = false } = {}) {
  await c.route(/^https:\/\/auth\.jira\.test\//, (r) => {
    const u = new URL(r.request().url());
    const back = new URL(`${APP}/integrations/jira/callback`);
    back.searchParams.set("state", u.searchParams.get("state") || "");
    if (deny) back.searchParams.set("error", "access_denied");
    else back.searchParams.set("code", `code-${ACC[who]}`);
    return BROWSER === "webkit"
      ? r.fulfill({ status: 200, contentType: "text/html", body: `<script>location.replace(${JSON.stringify(back.toString())})</script>` })
      : r.fulfill({ status: 302, headers: { location: back.toString() } });
  });
}

/** Connect someone's own Atlassian account through the API (the same start → finish the callback page does). */
async function connectApi(who) {
  const { url } = ok(await api("POST", "/api/v1/jira/connect/start", T[who], { kind: "me", workspace_id: WS }), `start ${who}`);
  const state = new URL(url).searchParams.get("state");
  ok(await api("POST", "/api/v1/jira/connect/finish", T[who], { code: `code-${ACC[who]}`, state }), `finish ${who}`);
}

async function site() {
  const st = ok(await api("GET", `/api/v1/jira/status?workspace_id=${WS}`, T.owner), "status");
  return st.site;
}

/** Make sure the site is connected with PAY and WEB on Team (steps can run alone with ONLY=…). */
async function ensureSite(projects = ["PAY", "WEB"]) {
  const s = await site();
  if (s && JSON.stringify(s.projects) === JSON.stringify(projects)) return;
  const me = ok(await api("GET", "/api/v1/jira/me", T.owner), "me");
  if (!me.connected) await connectApi("owner");
  ok(await api("PUT", "/api/v1/jira/site", T.owner, { workspace_id: WS, cloud_id: "cloud-acme", projects, default_project: "PAY", default_issue_type: "Task" }), "site");
}

async function ensureMe(who) {
  const me = ok(await api("GET", "/api/v1/jira/me", T[who]), "me");
  if (!me.connected) await connectApi(who);
}

async function teamOn() {
  const ws = ok(await api("GET", `/api/v1/workspaces/${WS}`, T.owner), "ws");
  if (ws.settings?.team_memory) return;
  ok(await api("PUT", `/api/v1/workspaces/${WS}`, T.owner, { settings: { ...(ws.settings || {}), team_memory: true, timezone: "UTC" } }), "team on");
}

const meetings = {};
async function meeting(name, lines, extra = {}) {
  if (meetings[name]) return meetings[name];
  const r = ok(await api("POST", "/api/v1/meetings/import", T.owner, {
    workspace: WS, wait: true, date: day(-1), title: name, restricted: false, ...extra,
    sources: [{ name: `${name} - Transcript`, text: `${name} - Transcript\nAttendees\nAda Owner, Ben Member, Wes Admin\nTranscript\n${lines.join("\n")}\nTranscription ended after 00:15:00\n` }],
  }), `import ${name}`);
  meetings[name] = r.meetings[0];
  return meetings[name];
}
const PLANNING = ["Ada Owner: Thanks for joining the payments planning.",
  "Ben Member: I will migrate the billing webhooks to v2 due 2026-12-01.",
  "Wes Admin: I will write the rollout runbook for the checkout.",
  "Ada Owner: We agree to ship the new checkout on Friday.",
  "Ada Owner: Who signs off the pricing page?"];
const planning = () => meeting("Payments planning", PLANNING);

async function noOverflow(p, what) {
  const o = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (o > 1) fail(`${what}: the page scrolls sideways by ${o}px`);
}

await step("connect", async () => {
  const { c, p } = await ctx(browser, { token: T.owner });
  await fakeAtlassian(c, "owner");
  await p.goto(TAB);
  const card = p.getByTestId("jira-card");
  await card.waitFor({ timeout: 30000 });
  await shot(p, "jira-integrations-before");
  await card.getByTestId("jira-connect-site").click();
  await p.waitForURL(/jira=pick/, { timeout: 30000 });
  const picker = p.getByTestId("jira-picker");
  await picker.waitFor({ timeout: 20000 });
  await picker.getByText("Acme Jira").waitFor();
  await p.waitForFunction(() => document.querySelectorAll('[data-testid="jira-default-project"] option').length >= 3, null, { timeout: 15000 });
  await p.getByTestId("jira-default-project").selectOption("PAY");
  await shot(p, "jira-picker");
  await p.getByTestId("jira-save-site").click();
  await card.getByTestId("jira-connected").waitFor({ timeout: 20000 });
  const def = await p.getByTestId("jira-default").textContent();
  if (!/PAY · Task/.test(def || "")) fail(`default: ${def}`);
  await p.getByText("Pick projects for Team").waitFor();
  await p.getByTestId("jira-me-state").getByText("Connected as").waitFor();
  const s = await site();
  if (s.projects.length !== 0 || s.default_project !== "PAY") fail(`site: ${JSON.stringify(s)}`);
});

await step("noprojects", async () => {
  await ensureSite([]);
  await teamOn();
  const t = ok(await api("GET", `/api/v1/jira/team/${WS}`, T.member), "team");
  if (t.mode !== "no_projects") fail(`mode without projects: ${t.mode}`);
  {
    const { p } = await ctx(browser, { token: T.owner });
    await p.goto(teamUrl);
    const box = p.getByTestId("team-jira");
    await box.waitFor({ timeout: 30000 });
    await box.getByRole("link", { name: /Integrations › Jira/ }).waitFor();
    if (await p.getByTestId("team-card-jira").count()) fail("cards show Jira without projects");
  }
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(teamUrl);
  await p.getByTestId("team-jira").getByText("A workspace admin chooses which Jira projects show here.").waitFor({ timeout: 30000 });
});

await step("projects", async () => {
  await ensureSite([]);
  const { c, p } = await ctx(browser, { token: T.owner });
  await fakeAtlassian(c, "owner");
  await p.goto(TAB);
  await p.getByTestId("jira-edit").click();
  const pick = p.getByTestId("jira-team-projects-pick");
  await pick.waitFor({ timeout: 20000 });
  await pick.getByText("Payments (PAY)").click();
  await pick.getByText("Website (WEB)").click();
  await p.getByTestId("jira-save-site").click();
  await p.getByTestId("jira-team-projects").getByText("PAY, WEB").waitFor({ timeout: 20000 });
  if (await p.getByText("Pick projects for Team").count()) fail("still asks for projects");
  await shot(p, "jira-integrations-connected");
  const s = await site();
  if (JSON.stringify([...s.projects].sort()) !== '["PAY","WEB"]') fail(`projects: ${s.projects}`);
});

await step("me", async () => {
  await ensureSite();
  const { c, p } = await ctx(browser, { token: T.member });
  await fakeAtlassian(c, "member");
  await p.goto(`${APP}/settings/account#jira`);
  const card = p.getByTestId("jira-account");
  await card.waitFor({ timeout: 30000 });
  await card.getByTestId("jira-account-connect").click();
  await p.waitForURL(/jira=connected/, { timeout: 30000 });
  await p.getByTestId("jira-account").getByText("Ben Member").waitFor({ timeout: 20000 });
  await shot(p, "jira-account-connected");
  const me = ok(await api("GET", "/api/v1/jira/me", T.member), "me");
  if (!me.connected || me.name !== "Ben Member") fail(`me: ${JSON.stringify(me)}`);
  await connectApi("reader");
});

let created = null;
await step("create", async () => {
  await ensureSite();
  await ensureMe("member");
  const m = await planning();
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/${m.slug}`);
  const li = p.locator(TODO, { hasText: "billing webhooks" }).first();
  await li.waitFor({ timeout: 30000 });
  // Offered on the decision, the two action items and the open question; not on the summary, topics or sources.
  // The page's Jira (usePageJira) loads after the list renders: wait for it before counting.
  await p.getByTestId("jira-add").first().waitFor({ timeout: 30000 });
  await p.waitForFunction(() => document.querySelectorAll('[data-testid="jira-add"]').length >= 4, null, { timeout: 15000 }).catch(() => {});
  const adds = await p.getByTestId("jira-add").count();
  if (adds !== 4) fail(`"+ Jira" on ${adds} items (expected 4)`);
  await li.getByTestId("jira-add").click();
  const dlg = p.getByTestId("jira-dialog");
  await dlg.waitFor({ timeout: 30000 });
  const summary = await p.getByTestId("jira-summary").inputValue();
  if (!/^Migrate the billing webhooks/i.test(summary)) fail(`drafted summary: ${summary}`);
  const who = await p.getByTestId("jira-assignee").inputValue();
  if (who !== U.member) fail(`drafted assignee: ${who} (Ben is ${U.member})`);
  const due = await p.getByTestId("jira-due").inputValue();
  if (due !== "2026-12-01") fail(`drafted due: ${due}`);
  if ((await p.getByTestId("jira-project").inputValue()) !== "PAY") fail("default project isn't PAY");
  await shot(p, "jira-create-dialog");
  await p.getByTestId("jira-summary").fill("Move billing webhooks to the v2 API");
  await p.getByTestId("jira-create").click();
  const chip = li.getByTestId("jira-chip");
  await chip.waitFor({ timeout: 20000 });
  created = await chip.getAttribute("data-key");
  await chip.getByText("To Do").waitFor();
  await chip.getByText("Ben Member").waitFor();
  const it = await issue(created);
  if (it.fields.summary !== "Move billing webhooks to the v2 API") fail(`summary in Jira: ${it.fields.summary}`);
  if (it.fields.reporter?.accountId !== "acc-ben") fail(`reporter: ${JSON.stringify(it.fields.reporter)}`);
  if (it.fields.assignee?.accountId !== "acc-ben") fail(`assignee: ${JSON.stringify(it.fields.assignee)}`);
  if (!JSON.stringify(it.fields.description).includes("Payments planning")) fail("no link back to the meeting in the description");
  await shot(p, "jira-chip");
  log("created", created);
});

await step("restricted", async () => {
  await ensureSite();
  await ensureMe("member");
  const m = await meeting("Ada and Ben 1:1", ["Ada Owner: Thanks for the update.", "Ben Member: I will draft the pricing memo for legal."], { restricted: true });
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/${m.slug}`);
  const li = p.locator(TODO, { hasText: "pricing memo" }).first();
  await li.waitFor({ timeout: 30000 });
  await li.getByTestId("jira-add").click();
  await p.getByTestId("jira-restricted").waitFor({ timeout: 30000 });
  await shot(p, "jira-create-restricted");
});

await step("bulk", async () => {
  await ensureSite();
  await ensureMe("member");
  const m = await planning();
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/${m.slug}`);
  await p.getByTestId("jira-bulk-open").click();
  const box = p.getByTestId("jira-bulk");
  await box.waitFor({ timeout: 30000 });
  const n = await box.getByTestId("jira-bulk-item").count();
  if (n < 1) fail("no open action items to draft");
  if (await box.getByTestId("jira-bulk-item").filter({ hasText: /billing webhooks/i }).count()) fail("an item with an issue is offered again");
  await shot(p, "jira-bulk");
  await p.getByTestId("jira-bulk-create").click();
  await p.locator(TODO, { hasText: "rollout runbook" }).first().getByTestId("jira-chip").waitFor({ timeout: 30000 });
});

await step("sync", async () => {
  await ensureSite();
  await ensureMe("member");
  const m = await planning();
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/${m.slug}`);
  const li = p.locator(TODO, { hasText: "billing webhooks" }).first();
  const chip = li.getByTestId("jira-chip");
  await chip.waitFor({ timeout: 30000 });
  const key = await chip.getAttribute("data-key");
  // Tick in Markdrop → Done in Jira (as Ben).
  const box = li.locator('input[type="checkbox"]').first();
  await li.locator(".md-task-check--live").first().waitFor({ timeout: 20000 });
  for (let i = 0; i < 2 && !(await box.isChecked()); i++) {
    await box.click({ force: true });
    await p.waitForFunction((el) => el.checked, await box.elementHandle(), { timeout: 8000 }).catch(() => log(`tick ${i + 1} did not take (WebKit: a click right after the chips load is sometimes lost)`));
  }
  if (!(await box.isChecked())) fail("the box didn't tick");
  let st = null;
  for (let i = 0; i < 40; i++) {
    st = (await issue(key)).fields.status.name;
    if (st === "Done") break;
    await p.waitForTimeout(500);
  }
  if (st !== "Done") fail(`ticking didn't move ${key}: ${st}`);
  // Jira moves it back (Ben, in Jira) → the box unticks.
  const r1 = ok(await api("POST", "/__sandbox/jira/move", null, { key, status: "In Progress", by: "acc-ben", workspace_id: WS }), "move back");
  if (r1.status !== 200) fail(`webhook → ${r1.status} ${JSON.stringify(r1.body)}`);
  await p.waitForTimeout(800);
  await p.reload();
  await li.getByTestId("jira-chip").waitFor({ timeout: 30000 });
  if (await li.locator('input[type="checkbox"]').first().isChecked()) fail("the box is still ticked after Jira reopened the issue");
  if ((await issue(key)).fields.status.name !== "In Progress") fail("Markdrop echoed a transition back to Jira");
  // Jira → Done → ticked.
  const r2 = ok(await api("POST", "/__sandbox/jira/move", null, { key, status: "Done", by: "acc-ben", workspace_id: WS }), "move done");
  if (r2.status !== 200) fail(`webhook → ${r2.status}`);
  await p.waitForTimeout(800);
  await p.reload();
  await li.getByTestId("jira-chip").getByText("Done").waitFor({ timeout: 30000 });
  if (!(await li.locator('input[type="checkbox"]').first().isChecked())) fail("Done in Jira didn't tick the box");
  // A webhook without Jira's signature is refused.
  const bad = await api("POST", `/api/v1/jira/webhook/${WS}`, null, { webhookEvent: "jira:issue_updated" });
  if (bad.status !== 401) fail(`unsigned webhook → ${bad.status}`);
});

await step("viewer", async () => {
  await ensureSite();
  await ensureMe("reader");
  const m = await planning();
  const { p } = await ctx(browser, { token: T.reader });
  const bodies = captureApi(p);
  await p.goto(`${APP}/${m.slug}`);
  const chip = p.locator(TODO, { hasText: "billing webhooks" }).first().getByTestId("jira-chip");
  await chip.waitFor({ timeout: 30000 });
  if (await chip.locator(".jr-status").count()) fail("Vic sees the PAY issue's status");
  if (await p.getByTestId("jira-add").count()) fail("a viewer is offered Create Jira issue");
  await p.waitForTimeout(800);
  const leak = bodies.find((b) => b.body.includes("Move billing webhooks to the v2 API"));
  if (leak) fail(`Vic's API body carries the issue: ${leak.url}`);
});

await step("team", async () => {
  await ensureSite();
  await ensureMe("member");
  await teamOn();
  {
    const { p } = await ctx(browser, { token: T.member });
    await p.goto(teamUrl);
    const card = p.locator('[data-testid="team-card"][data-person="Ben Member"]');
    const line = card.getByTestId("team-card-jira");
    await line.waitFor({ timeout: 30000 });
    await line.getByText("Retry failed card payments").waitFor();
    await line.getByText(/overdue/).first().waitFor();
    const glance = p.getByTestId("team-jira");
    await glance.getByText("Retry failed card payments").first().waitFor();
    await glance.getByTestId("team-jira-projects").getByText("Payments").waitFor();
    if (await glance.getByText("Rotate the signing keys").count()) fail("a SEC issue (not a Team project) shows");
    await glance.scrollIntoViewIfNeeded();
    await shot(p, "jira-team");
    await p.goto(`${APP}/team/${encodeURIComponent(WS)}/people/${U.member}`);
    const sec = p.getByTestId("person-jira");
    await sec.waitFor({ timeout: 30000 });
    await sec.getByText("Refund flow for annual plans").waitFor();
    await sec.scrollIntoViewIfNeeded();
    await shot(p, "jira-person");
  }
  const { p } = await ctx(browser, { token: T.admin });
  const bodies = captureApi(p);
  await p.goto(teamUrl);
  await p.getByTestId("team-jira-connect").waitFor({ timeout: 30000 });
  if (await p.getByTestId("jira-issue-row").count()) fail("Wes (not connected) sees issue rows");
  await p.waitForTimeout(800);
  const leak = bodies.find((b) => b.body.includes("Retry failed card payments"));
  if (leak) fail(`Wes's API body carries an issue: ${leak.url}`);
});

await step("links", async () => {
  await ensureSite();
  await ensureMe("member");
  await ensureMe("reader");
  const doc = ok(await api("POST", "/api/v1/pages", T.member, {
    title: "Checkout launch notes", workspace: WS, folder: S.folder, auto_cover: false,
    content: "# Checkout launch notes\n\nThe retry work is tracked in https://acme.atlassian.net/browse/PAY-1 and the banner in https://acme.atlassian.net/browse/WEB-2.\n",
  }), "page").document;
  {
    const { p } = await ctx(browser, { token: T.member });
    await p.goto(`${APP}/${doc.slug}`);
    const chip = p.locator('[data-testid="jira-chip"][data-key="PAY-1"]');
    await chip.waitFor({ timeout: 30000 });
    await chip.getByText("In Progress").waitFor();
    await shot(p, "jira-link-chips");
  }
  const { p } = await ctx(browser, { token: T.reader });
  await p.goto(`${APP}/${doc.slug}`);
  await p.locator('[data-testid="jira-chip"][data-key="WEB-2"]').waitFor({ timeout: 30000 });
  if (await p.locator('[data-testid="jira-chip"][data-key="PAY-1"]').count()) fail("Vic gets a chip for PAY-1 his Jira can't open");
});

await step("editor", async () => {
  await ensureSite();
  await ensureMe("member");
  const doc = ok(await api("POST", "/api/v1/pages", T.member, {
    title: "Launch risks", workspace: WS, folder: S.folder, auto_cover: false,
    content: "# Launch risks\n\nThe refund emails still go out in English only for EU customers.\n",
  }), "page").document;
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/${doc.slug}?edit=1`, { waitUntil: "networkidle" });
  const para = p.locator(".ProseMirror p", { hasText: "refund emails" }).first();
  await para.waitFor({ timeout: 30000 });
  await p.waitForTimeout(1500);
  await para.click({ clickCount: 3 });
  const btn = p.getByRole("button", { name: "Create Jira issue" });
  await btn.waitFor({ timeout: 15000 });
  await btn.click();
  await p.getByTestId("jira-dialog").waitFor({ timeout: 30000 });
  const s = await p.getByTestId("jira-summary").inputValue();
  if (!/refund emails/i.test(s)) fail(`selection draft: ${s}`);
});

await step("devices", async () => {
  await ensureSite();
  await ensureMe("member");
  const m = await planning();
  for (const theme of ["light", "dark"]) {
    {
      const { p } = await ctx(browser, { token: T.owner, theme, width: 390, height: 844, mobile: true });
      await p.goto(TAB);
      await p.getByTestId("jira-connected").waitFor({ timeout: 30000 });
      await noOverflow(p, `integrations ${theme}`);
      await shot(p, `jira-integrations-phone-${theme}`);
    }
    {
      const { p } = await ctx(browser, { token: T.owner, theme });
      await p.goto(TAB);
      await p.getByTestId("jira-connected").waitFor({ timeout: 30000 });
      await shot(p, `jira-integrations-desktop-${theme}`);
    }
    const { p } = await ctx(browser, { token: T.member, theme, width: 390, height: 844, mobile: true });
    await p.goto(`${APP}/${m.slug}`);
    await p.getByTestId("jira-bulk-open").click();
    await p.getByTestId("jira-bulk").or(p.getByText("No open action items without an issue")).first().waitFor({ timeout: 30000 });
    await noOverflow(p, `bulk dialog ${theme}`);
    await shot(p, `jira-bulk-phone-${theme}`);
  }
});

await browser.close();
console.log("\n" + results.map(([n, r, ms]) => `${r === "ok" ? "✓" : "✗"} ${n.padEnd(12)} ${r} (${(ms / 1000).toFixed(1)} s)`).join("\n"));
if (results.some(([, r]) => r !== "ok")) process.exit(1);
