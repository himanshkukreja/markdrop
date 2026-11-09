/**
 * Teams inside a workspace (.work/briefs/teams-v1.md, .work/teams/CONTRACT.md) on the REAL stack, fake models:
 *
 *   sidebar   COMPANY (Home · Pages · People) + YOUR TEAMS (each: Home, Pages, Meetings, Memory, Ask <team>, its
 *             projects) + Browse teams; the active row follows the URL; keyboard (arrow keys move, Enter opens)
 *   home      a team's home: brief (the lead edits and hides a line), recent pages, meetings, memory, members
 *   leak      Priya (not in private Sales): its name + brief only — the home is locked, its page is in no listing, rail,
 *             search, company home or API body she receives; Wes (workspace admin) reads it and the settings say so
 *   browse    Browse teams: Ben joins open Eng (it appears in his sidebar); Sales shows "Brief only" to Priya
 *   create    the admin creates a private team from the dialog ("Workspace admins can see this team's content")
 *   settings  the lead adds a member; Slack / Jira / digest section; visibility is the admin's
 *   share     the Share dialog's Teams row: Ben adds a company page to Sales and takes it out again
 *   ask       Ask Sales (team scope) ⇄ "Ask the whole company" toggle; the request carries the scope
 *   search    the Team filter (Sales / Company-wide only) on /search narrows the results
 *   import    the meeting importer offers Teams, starting on the team you came from
 *   project   a lead creates a project linked to Sales and Eng; it appears under both teams in the sidebar
 *   review    the guided review (admins) lists company-wide items and moves one into a team
 *   phone     the same tree in the phone drawer (390 px); team pages have no sideways scroll at 360 / 390; dark shots
 *
 *   PB_FAKE_MEETINGS_AI=1 PB_FAKE_TEAM_AI=1 PB_FAKE_ASK_AI=1 PB_STACK_ID=17 PB_WORK=… zsh up.sh start
 *   PB_STACK_ID=17 PB_WORK=… BROWSER=chromium|webkit [ONLY=sidebar,leak] node teams.mjs
 */
import fs from "node:fs";
import { APP, API, SHOTS, log, fail, reseed, seedNow, api, launch, ctx, captureApi, stepper, shot } from "./lib.mjs";

fs.mkdirSync(SHOTS, { recursive: true });
const browser = await launch();
const { step, results } = stepper(browser);
const S = process.env.NO_RESEED ? seedNow() : reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const U = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.id]));
const WS = S.ws;
const W = encodeURIComponent(WS);
const base = `/api/v1/workspaces/${WS}`;
const ok = (r, what) => { if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const SECRET = "Quokka pricing";

// ── The world: Priya (member), private Sales (Ada lead, Ben), open Eng (Priya lead, Vic) ─────────────────
const priya = ok(await api("POST", "/__sandbox/user", null, { email: "priya@acme.test", name: "Priya Shah" }), "priya");
ok(await api("POST", "/__sandbox/team-memory/member", null, { workspace_id: WS, user_id: priya.id, role: "member" }), "member");
T.priya = priya.token; U.priya = priya.id;
const sales = ok(await api("POST", `${base}/teams`, T.owner, { name: "Sales", icon: "💼", color: "green", visibility: "private",
  description: "Pipeline, deals and customer calls.", lead_ids: [U.owner], member_ids: [U.owner, U.member] }), "sales");
const eng = ok(await api("POST", `${base}/teams`, T.owner, { name: "Eng", icon: "🛠", color: "blue", visibility: "open",
  lead_ids: [U.priya], member_ids: [U.priya, U.reader] }), "eng");
const mk = async (token, title, slug, content) => ok(await api("POST", "/api/v1/documents", token, {
  title, custom_slug: slug, expires_in: "never", workspace: WS, access_level: "workspace", content }), title);
await mk(T.owner, `${SECRET} plan`, "quokka-plan", `# ${SECRET} plan\n\nThe Quokka discount ladder for Q4 deals.\n`);
ok(await api("PUT", `${base}/items/quokka-plan/teams`, T.owner, { team_ids: [sales.id], project_ids: [] }), "into sales");
await mk(T.priya, "Eng runbook", "eng-runbook", "# Eng runbook\n\nDeploys, on-call and the Quokka-free incident process.\n");
ok(await api("PUT", `${base}/items/eng-runbook/teams`, T.priya, { team_ids: [eng.id], project_ids: [] }), "into eng");
const holidays = ok(await api("POST", "/api/v1/pages", T.member, { title: "Company holidays", workspace: WS, content: "Everyone gets the 24th off.\n", auto_cover: false }), "holidays page").document.slug;
const wsNow = ok(await api("GET", base, T.owner), "ws");
ok(await api("PUT", base, T.owner, { name: wsNow.name, settings: { ...(wsNow.settings || {}), team_memory: true } }), "team memory on");
log("world", JSON.stringify({ sales: sales.id, eng: eng.id }));

const rail = (p) => p.locator('aside[data-rail="full"] nav[aria-label="Your drive"]');
const row = (p, key) => rail(p).locator(`[data-rail-key="${key}"]`);
const tk = (tid, sub) => `ws:${WS}:team:${tid}${sub ? `:${sub}` : ""}`;
const noHScroll = async (p, what) => {
  const o = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (o > 1) fail(`${what}: scrolls sideways by ${o}px`);
};

await step("sidebar", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/w/${W}/teams/${sales.slug}`);
  await p.getByTestId("team-home").waitFor({ timeout: 20000 });
  const r = rail(p);
  await r.getByText("Company", { exact: true }).waitFor();
  await r.getByText("Your teams", { exact: true }).waitFor();
  for (const k of [`ws:${WS}:home`, `ws:${WS}:pages`, tk(sales.id), tk(sales.id, "pages"), tk(sales.id, "meetings"), tk(sales.id, "memory"), tk(sales.id, "ask"), `ws:${WS}:browse`]) {
    if (!(await row(p, k).count())) fail(`no rail row ${k}`);
  }
  if (await row(p, tk(eng.id)).count()) fail("Eng (not his team) is under Your teams");
  if ((await row(p, tk(sales.id, "home")).getAttribute("aria-current")) !== "page") fail("team home row not current");
  if (!(await row(p, tk(sales.id, "ask")).innerText()).includes("Ask Sales")) fail("Ask Sales label");
  // Navigate by the rail: Pages → the team's pages; the active row follows.
  await row(p, tk(sales.id, "pages")).click();
  await p.getByTestId("team-pages").waitFor();
  await p.getByText(`${SECRET} plan`).first().waitFor();
  await p.waitForFunction((k) => document.querySelector(`[data-rail-key="${k}"]`)?.getAttribute("aria-current") === "page", tk(sales.id, "pages"));
  // Keyboard: focus the team row, ArrowDown moves to Home, Enter opens it.
  await row(p, tk(sales.id)).focus();
  await p.keyboard.press("ArrowDown");
  const focused = await p.evaluate(() => document.activeElement?.getAttribute("data-rail-key"));
  if (focused !== tk(sales.id, "home")) fail(`ArrowDown landed on ${focused}`);
  await p.keyboard.press("Enter");
  await p.getByTestId("team-home").waitFor();
  // Company › Pages holds the company tree, not the team page.
  if (await row(p, `ws:${WS}:page:quokka-plan`).count()) fail("team page in Company › Pages");
  await shot(p, "teams-sidebar-light");
});

await step("home", async () => {
  ok(await api("POST", `${base}/teams/${sales.id}/briefs/draft`, T.owner), "draft");
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/w/${W}/teams/${sales.slug}`);
  await p.getByTestId("team-brief").waitFor({ timeout: 20000 });
  for (const id of ["team-recent", "team-meetings", "team-memory", "team-members"]) await p.getByTestId(id).waitFor();
  await p.getByTestId("team-recent").getByText(`${SECRET} plan`).waitFor();
  const lines = p.locator(".tz-brief__line");
  if (await lines.count()) {
    await lines.first().hover();
    await lines.first().getByRole("button", { name: "Hide line" }).click();
    await p.locator('.tz-brief__line[data-hidden="true"]').first().waitFor();
    // A member who isn't a lead doesn't see the hidden line.
    const b = ok(await api("GET", `${base}/teams/${sales.id}/briefs/latest`, T.member), "brief");
    if (b.lines.some((l) => l.hidden)) fail("hidden line reached a member");
  } else {
    await p.getByRole("button", { name: "Add a line" }).click();
    await p.getByRole("textbox", { name: "New line" }).fill("Closed the Northwind renewal.");
    await p.getByRole("button", { name: "Add", exact: true }).click();
    await p.getByText("Closed the Northwind renewal.").waitFor();
  }
  await shot(p, "teams-home-light");
});

await step("leak", async () => {
  const { p } = await ctx(browser, { token: T.priya });
  const bodies = captureApi(p);
  await p.goto(`${APP}/w/${W}/teams/${sales.slug}`);
  await p.getByText("This is a private team").waitFor({ timeout: 20000 });
  if (await p.getByTestId("team-recent").count()) fail("locked home shows recent pages");
  await p.goto(`${APP}/w/${W}/home`);
  await p.getByTestId("company-home").waitFor();
  await p.goto(`${APP}/w/${W}`);
  await p.waitForTimeout(1500);
  await p.goto(`${APP}/search?q=Quokka`);
  await p.waitForTimeout(2500);
  await p.goto(`${APP}/w/${W}/teams/${eng.slug}/pages`);
  await p.getByText("Eng runbook").first().waitFor({ timeout: 15000 });
  const text = await p.locator("body").innerText();
  if (text.includes(SECRET)) fail("Sales page title on Priya's screen");
  await p.waitForTimeout(800);
  const leaked = bodies.filter((b) => b.body.includes("Quokka discount") || b.body.includes(`${SECRET} plan`));
  if (leaked.length) fail(`leaked in ${leaked.map((b) => b.url).join(", ")}`);
  const d = await api("GET", "/api/v1/documents/quokka-plan", T.priya);
  if (d.status < 400) fail(`Priya reads the Sales page: ${d.status}`);
  // The workspace admin reads it, and the private team's settings say so.
  const { p: a } = await ctx(browser, { token: T.admin });
  await a.goto(`${APP}/w/${W}/teams/${sales.slug}/settings`);
  await a.getByTestId("admins-note").waitFor({ timeout: 20000 });
  if (!(await a.getByTestId("admins-note").innerText()).includes("Workspace admins can see this team's content")) fail("admins note text");
  if ((await api("GET", "/api/v1/documents/quokka-plan", T.admin)).status !== 200) fail("admin can't read");
});

await step("browse", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/w/${W}/teams`);
  const card = p.getByTestId(`team-card-${eng.slug}`);
  await card.waitFor({ timeout: 20000 });
  await card.getByRole("button", { name: "Join" }).click();
  await row(p, tk(eng.id)).waitFor({ timeout: 15000 });
  const t = ok(await api("GET", `${base}/teams/${eng.id}`, T.member), "eng home");
  if (!t.team.members.some((m) => m.id === U.member)) fail("not joined");
  const { p: q } = await ctx(browser, { token: T.priya });
  await q.goto(`${APP}/w/${W}/teams`);
  await q.getByTestId(`team-card-${sales.slug}`).getByText("Brief only").waitFor({ timeout: 20000 });
  await shot(q, "teams-browse-light");
});

await step("create", async () => {
  const { p } = await ctx(browser, { token: T.admin });
  await p.goto(`${APP}/w/${W}/teams`);
  await p.getByTestId("new-team").click();
  await p.getByTestId("team-name").fill("Marketing");
  await p.getByRole("dialog").locator("label", { hasText: "Only members see" }).click();
  await p.getByRole("dialog").getByTestId("admins-note").waitFor();
  await p.getByTestId("create-team").click();
  await p.waitForURL(/\/teams\/marketing$/, { timeout: 20000 });
  await p.getByTestId("team-home").waitFor();
  await row(p, `ws:${WS}:browse`).waitFor();
});

await step("settings", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/w/${W}/teams/${sales.slug}/settings`);
  await p.getByTestId("team-members-settings").waitFor({ timeout: 20000 });
  await p.getByTestId("add-members").click();
  const dlg = p.getByRole("dialog");
  await dlg.locator("label", { hasText: "Priya Shah" }).click();
  await dlg.getByTestId("add-members-confirm").click();
  await p.getByTestId("team-members-settings").getByText("Priya Shah").waitFor();
  await p.getByTestId("team-integrations").waitFor();
  // Ada owns the workspace (admin): visibility is enabled for her.
  await shot(p, "teams-settings-light", { full: true });
  ok(await api("DELETE", `${base}/teams/${sales.id}/members/${U.priya}`, T.owner), "remove priya");
});

await step("share", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/${holidays}`, { waitUntil: "networkidle" });
  await p.locator(".pb-paper").first().waitFor({ timeout: 30000 });
  await p.getByRole("button", { name: /^Share/ }).first().click({ timeout: 20000 });
  const sec = p.getByTestId("share-teams");
  await sec.waitFor({ timeout: 15000 });
  await sec.getByTestId("share-teams-add").click();
  await p.getByRole("menuitem", { name: "Sales" }).click();
  await sec.getByText("Sales").waitFor();
  let it = ok(await api("GET", `${base}/items/${holidays}/teams`, T.member), "item teams");
  if (!it.team_ids.includes(sales.id)) fail("not in Sales");
  await shot(p, "teams-share-light");
  await sec.getByRole("button", { name: "Remove from Sales" }).click();
  await sec.getByText(/Company-wide/).waitFor();
  it = ok(await api("GET", `${base}/items/${holidays}/teams`, T.member), "item teams");
  if (it.team_ids.length) fail("still in a team");
});

await step("ask", async () => {
  const { p } = await ctx(browser, { token: T.member });
  const sent = [];
  p.on("request", (r) => { if (r.url().endsWith("/api/v1/ask") && r.method() === "POST") sent.push(r.postDataJSON()); });
  await p.goto(`${APP}/ask?workspace=${W}&team=${sales.id}`);
  await p.getByTestId("ask-title").filter({ hasText: "Ask Sales" }).waitFor({ timeout: 20000 });
  await p.getByTestId("ask-teams").waitFor();
  const box = p.getByRole("textbox").last();
  await box.fill("What did we decide about discounts?");
  await box.press("Enter");
  await p.waitForTimeout(1500);
  if (!sent.some((b) => b.scope?.kind === "team" && b.scope?.team === sales.id)) fail(`team scope not sent: ${JSON.stringify(sent.map((b) => b.scope))}`);
  await p.locator("label", { has: p.getByTestId("ask-whole-company") }).click();
  await p.waitForFunction(() => /team=/.test(location.search) === false);
  const title = await p.getByTestId("ask-title").innerText();
  if (title.includes("Sales")) fail(`whole company title: ${title}`);
  await shot(p, "teams-ask-light");
});

await step("search", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/search?q=Quokka&scope=${W}`);
  const sel = p.getByTestId("search-team");
  await sel.waitFor({ timeout: 20000 });
  await p.getByText(`${SECRET} plan`).first().waitFor({ timeout: 15000 });
  await sel.selectOption("company");
  await p.waitForFunction(() => location.search.includes("space=company"));
  await p.waitForTimeout(1500);
  if (await p.getByText(`${SECRET} plan`).count()) fail("team page under Company-wide only");
  await sel.selectOption(`team:${sales.id}`);
  await p.getByText(`${SECRET} plan`).first().waitFor({ timeout: 15000 });
});

await step("import", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/meetings/${W}?space=${encodeURIComponent(`team:${sales.id}`)}`);
  await p.getByRole("heading", { name: "Sales meetings" }).waitFor({ timeout: 20000 });
  await p.getByTestId("import-meeting").click();
  const t = p.getByTestId("import-teams");
  await t.waitFor({ timeout: 10000 });
  if (!(await t.getByRole("checkbox", { name: "Sales" }).isChecked())) fail("importer didn't start on Sales");
  // From the company's Meetings: the attendees (Ada and Ben, both in Sales) suggest Sales.
  await p.goto(`${APP}/meetings/${W}`);
  await p.getByTestId("import-meeting").click({ timeout: 20000 });
  await p.locator("textarea#mt-paste").fill("Deal desk - Transcript\nAttendees\nAda Owner, Ben Member\nTranscript\nAda Owner: Northwind wants two years.\nBen Member: I'll draft it.\n");
  await p.waitForFunction(() => document.querySelector('[data-testid="import-teams"]')?.textContent?.includes("Suggested"), null, { timeout: 15000 });
  if (!(await p.getByTestId("import-teams").getByRole("checkbox", { name: "Sales" }).isChecked())) fail("Sales not suggested from the attendees");
});

await step("project", async () => {
  ok(await api("POST", `${base}/teams/${eng.id}/members`, T.priya, { user_ids: [U.owner] }), "ada into eng");
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/w/${W}/teams/${sales.slug}`);
  await p.getByTestId("new-project").click({ timeout: 20000 });
  const dlg = p.getByRole("dialog");
  await dlg.getByRole("textbox", { name: /Name/ }).fill("Q4 launch");
  await dlg.locator(".tz-picklist label", { hasText: "Eng" }).click();
  await dlg.getByTestId("create-project").click();
  await p.getByTestId("project-home").waitFor({ timeout: 20000 });
  const side = ok(await api("GET", `${base}/teams`, T.owner), "sidebar");
  const pr = side.projects.find((x) => x.name === "Q4 launch");
  if (!pr) fail("project missing");
  await row(p, tk(sales.id, `project:${pr.id}`)).waitFor({ timeout: 10000 });
  if (!(await row(p, tk(eng.id, `project:${pr.id}`)).count())) {
    await row(p, tk(eng.id)).locator("..").getByRole("button", { name: /Expand|Open/ }).first().click().catch(() => {});
  }
});

await step("review", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/w/${W}/teams-review`);
  await p.getByTestId("teams-review").waitFor({ timeout: 20000 });
  await p.getByRole("tab", { name: /Pages/ }).click();
  const rows = p.locator(".tz-rv");
  if (await rows.count()) {
    await rows.first().getByRole("combobox").selectOption({ label: "Eng" });
    await p.getByTestId("review-apply").click();
    await p.getByText(/Moved \d+ item/).waitFor({ timeout: 10000 });
  }
  await shot(p, "teams-review-light");
});

await step("phone", async () => {
  for (const width of [360, 390]) {
    for (const theme of ["light", "dark"]) {
      const { p, c } = await ctx(browser, { token: T.owner, width, height: 800, mobile: true, theme });
      for (const u of [`/w/${W}/teams/${sales.slug}`, `/w/${W}/teams`, `/w/${W}/home`, `/w/${W}/teams/${sales.slug}/settings`, `/w/${W}/teams/${sales.slug}/pages`]) {
        await p.goto(`${APP}${u}`);
        await p.waitForTimeout(1800);
        await noHScroll(p, `${u} @${width} ${theme}`);
      }
      if (width === 390) {
        await p.goto(`${APP}/w/${W}/teams/${sales.slug}`);
        await p.getByTestId("team-home").waitFor({ timeout: 20000 });
        await shot(p, `teams-home-phone-${theme}`);
        await p.getByRole("button", { name: "Menu" }).first().click();
        const drawer = p.locator('[role="dialog"] nav[aria-label="Your drive"]');
        await drawer.locator(`[data-rail-key="${tk(sales.id, "home")}"]`).waitFor({ timeout: 10000 });
        await shot(p, `teams-drawer-phone-${theme}`);
      }
      await c.close();
    }
  }
  const { p } = await ctx(browser, { token: T.owner, theme: "dark" });
  await p.goto(`${APP}/w/${W}/teams/${sales.slug}`);
  await p.getByTestId("team-home").waitFor({ timeout: 20000 });
  await shot(p, "teams-home-dark");
});

await browser.close();
console.log("\n" + results.map(([n, s, ms]) => `${s === "ok" ? "✓" : "✗"} ${n} ${s === "ok" ? "" : s} (${(ms / 1000).toFixed(1)} s)`).join("\n"));
if (results.some(([, s]) => s !== "ok")) process.exit(1);
void API;
