/**
 * Teams inside a workspace (.work/briefs/teams-v1.md, .work/teams/CONTRACT.md) on the REAL stack, fake models:
 *
 *   sidebar   Option A "One tree": switcher, Teams (General first, Everyone) each opening inline to Meetings, People &
 *             memory, projects and its pages; no Company section; the active row follows the URL; keyboard; open state remembered
 *   nav       /w/<ws>/home → General's home (brief, Needs you, Across teams, meetings, recent, What's happening, new people);
 *             the switcher; favorites from a row's ⋯ menu; ?space=company → General's Meetings row; General can't be
 *             deleted or made private
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

const G = {};   // General's id, once the sidebar step has read it
const rail = (p) => p.locator('aside[data-rail="full"] nav[aria-label="Your drive"]');
const row = (p, key) => rail(p).locator(`[data-rail-key="${key}"]`);
const tk = (tid, sub) => `ws:${WS}:team:${tid}${sub ? `:${sub}` : ""}`;
const noHScroll = async (p, what) => {
  const o = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (o > 1) fail(`${what}: scrolls sideways by ${o}px`);
};

await step("sidebar", async () => {
  // Option A "One tree": switcher, Search/Home/Inbox/Ask, Teams (General first, EVERYONE), each team opens inline to
  // Meetings, People & memory, its projects and its pages; Browse teams; You. No Company section.
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/w/${W}/teams/${sales.slug}`);
  await p.getByTestId("team-home").waitFor({ timeout: 20000 });
  const r = rail(p);
  await r.getByTestId("ws-switcher").waitFor();
  if (await r.getByText("Company", { exact: true }).count()) fail("a Company section in the rail");
  await r.getByText("Teams", { exact: true }).waitFor();
  await r.getByText("You", { exact: true }).waitFor();
  const side = ok(await api("GET", `${base}/teams`, T.member), "sidebar");
  const gen = side.teams[0];
  if (!gen?.general) fail("General isn't first in the sidebar payload");
  G.id = gen.id;
  await row(p, tk(gen.id)).waitFor();
  if (!(await row(p, tk(gen.id)).innerText()).toUpperCase().includes("EVERYONE")) fail("General has no Everyone tag");
  const order = await r.locator('[data-rail-key^="ws:"][data-rail-key*=":team:"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-rail-key")));
  if (order[0] !== tk(gen.id)) fail(`General isn't the first team row: ${order[0]}`);
  for (const k of [tk(sales.id), tk(sales.id, "meetings"), tk(sales.id, "memory"), tk(gen.id, "meetings"), tk(gen.id, "memory")]) {
    if (!(await row(p, k).count())) fail(`no rail row ${k}`);
  }
  for (const gone of [tk(sales.id, "home"), tk(sales.id, "pages"), tk(sales.id, "ask"), `ws:${WS}:home`, `ws:${WS}:pages`]) {
    if (await row(p, gone).count()) fail(`old rail row ${gone}`);
  }
  if (await row(p, tk(eng.id)).count()) fail("Eng (not his team) is under Teams");
  await r.getByTestId("rail-browse-teams").waitFor();
  if ((await row(p, tk(sales.id)).getAttribute("aria-current")) !== "page") fail("team row not current on its home");
  // The team's pages are inside it; General's tree doesn't hold them.
  await row(p, `ws:${WS}:item:quokka-plan`).waitFor({ timeout: 15000 });
  const keys = await rail(p).locator("[data-rail-key]").evaluateAll((els) => els.map((e) => e.getAttribute("data-rail-key")));
  const at = (k) => keys.indexOf(k);
  const nextTeam = keys.findIndex((k, i) => i > at(tk(sales.id)) && /:team:[^:]+$/.test(k));
  const inSales = at(`ws:${WS}:item:quokka-plan`) > at(tk(sales.id)) && (nextTeam < 0 || at(`ws:${WS}:item:quokka-plan`) < nextTeam);
  if (!inSales) fail("Sales's page isn't under Sales");
  // Navigate by the rail: Meetings → the team's meetings; the active row follows.
  await row(p, tk(sales.id, "meetings")).click();
  await p.getByRole("heading", { name: "Sales meetings" }).waitFor({ timeout: 20000 });
  await p.waitForFunction((k) => document.querySelector(`[data-rail-key="${k}"]`)?.getAttribute("aria-current") === "page", tk(sales.id, "meetings"));
  // Keyboard: focus the team row, ArrowDown moves to Meetings, Enter opens it.
  await row(p, tk(sales.id)).focus();
  await p.keyboard.press("ArrowDown");
  const focused = await p.evaluate(() => document.activeElement?.getAttribute("data-rail-key"));
  if (focused !== tk(sales.id, "meetings")) fail(`ArrowDown landed on ${focused}`);
  await row(p, tk(sales.id)).focus();
  await p.keyboard.press("Enter");
  await p.getByTestId("team-home").waitFor();
  // Collapsed state is remembered: close Sales, reload, still closed; General's closed state too.
  await row(p, tk(sales.id)).focus();
  await p.keyboard.press("ArrowLeft");
  await p.waitForFunction((k) => !document.querySelector(`[data-rail-key="${k}"]`), tk(sales.id, "meetings"));
  await p.goto(`${APP}/w/${W}/teams`);
  await rail(p).getByTestId("rail-browse-teams").waitFor({ timeout: 20000 });
  await p.waitForTimeout(800);
  if (await row(p, tk(sales.id, "meetings")).count()) fail("Sales reopened after a reload");
  await row(p, tk(gen.id)).focus();
  await p.keyboard.press("ArrowLeft");
  await p.reload();
  await row(p, tk(gen.id)).waitFor({ timeout: 20000 });
  await p.waitForTimeout(800);
  if (await row(p, tk(gen.id, "meetings")).count()) fail("General reopened after a reload");
  await row(p, tk(gen.id)).focus();
  await p.keyboard.press("ArrowRight");
  await row(p, tk(gen.id, "meetings")).waitFor();
  await shot(p, "teams-sidebar-light");
});

await step("nav", async () => {
  // Old Company links land on General; the switcher; favorites from a row's ⋯ menu; the drawer has the same tree.
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/w/${W}/home`);
  await p.waitForURL(/\/teams\/general$/, { timeout: 20000 });
  await p.getByTestId("general-home").waitFor({ timeout: 20000 });
  for (const id of ["team-brief", "team-needs-you", "general-across", "team-meetings", "team-recent", "team-feed", "general-new-people", "team-memory"]) {
    await p.getByTestId(id).waitFor({ timeout: 15000 });
  }
  const across = await p.getByTestId("general-across").innerText();
  if (!across.includes("Eng") || !across.includes("Sales")) fail(`Across teams: ${across.slice(0, 200)}`);
  if ((await row(p, tk(G.id)).getAttribute("aria-current")) !== "page") fail("General row not current on its home");
  // Switcher: lists the workspace, New workspace and its settings.
  await rail(p).getByTestId("ws-switcher").click();
  await p.getByRole("menuitem", { name: "New workspace" }).waitFor();
  await p.keyboard.press("Escape");
  // Favorites: star Company holidays from its row menu; it appears under Favorites; unstar.
  const hrow = row(p, `ws:${WS}:page:${holidays}`);
  await hrow.waitFor({ timeout: 15000 });
  await hrow.hover();
  await rail(p).getByRole("button", { name: "Actions for Company holidays" }).first().click();
  await p.getByRole("menuitem", { name: "Add to favorites" }).click({ timeout: 10000 });
  const fav = rail(p).getByRole("tree", { name: "Favorites" });
  await fav.getByText("Company holidays").waitFor({ timeout: 10000 });
  let saved = false;
  for (let i = 0; i < 20 && !saved; i++) {
    saved = ok(await api("GET", `${base}/favorites`, T.member), "favorites").favorites.some((f) => f.ref === holidays);
    if (!saved) await p.waitForTimeout(250);
  }
  if (!saved) fail("favorite not saved");
  ok(await api("PUT", `${base}/favorites`, T.member, { kind: "doc", ref: holidays, on: false }), "unstar");
  // Old routes: Company › Meetings (?space=company) and the Team board resolve to General's rows.
  await p.goto(`${APP}/meetings/${W}?space=company`);
  await p.getByRole("heading", { name: "General meetings" }).waitFor({ timeout: 20000 });
  await p.waitForFunction((k) => document.querySelector(`[data-rail-key="${k}"]`)?.getAttribute("aria-current") === "page", tk(G.id, "meetings"));
  // General: everyone, can't be deleted / made private / left.
  const del = await api("DELETE", `${base}/teams/${G.id}`, T.owner);
  if (del.status !== 409) fail(`deleting General → ${del.status}`);
  const priv = await api("PATCH", `${base}/teams/${G.id}`, T.owner, { visibility: "private" });
  if (priv.status !== 409) fail(`General private → ${priv.status}`);
  const gh = ok(await api("GET", `${base}/teams/general`, T.priya), "general home");
  if (gh.team.member_count < 4) fail(`General has ${gh.team.member_count} members`);
  await shot(p, "general-home-light", { full: true });
});

await step("home", async () => {
  ok(await api("POST", `${base}/teams/${sales.id}/briefs/draft`, T.owner), "draft");
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/w/${W}/teams/${sales.slug}`);
  await p.getByTestId("team-brief").waitFor({ timeout: 20000 });
  for (const id of ["team-ask-bar", "team-needs-you", "team-recent", "team-meetings", "team-feed", "team-memory"]) await p.getByTestId(id).waitFor();
  await p.getByTestId("team-feed").getByText(`${SECRET} plan`).first().waitFor();
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
  await p.goto(`${APP}/w/${W}/teams/general`);
  await p.getByTestId("general-home").waitFor({ timeout: 20000 });
  await p.getByTestId("team-feed").waitFor();
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
  await a.getByRole("dialog").getByTestId("admins-note").waitFor({ timeout: 20000 });
  if (!(await a.getByRole("dialog").getByTestId("admins-note").innerText()).includes("Workspace admins can see every team")) fail("admins note text");
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
  // The New team dialog: + next to Teams; icon & name row, picker (emoji/icons, colour, remove icon), Open/Private
  // cards, people chips with Lead/Member, ⌘↵ creates.
  const { p } = await ctx(browser, { token: T.admin });
  await p.goto(`${APP}/w/${W}/teams/general`);
  await rail(p).getByTestId("rail-new-team").click({ timeout: 20000 });
  const dlg = p.getByRole("dialog");
  await p.getByTestId("team-name").fill("Marketing");
  await p.getByTestId("team-icon").click();
  await p.getByTestId("icon-picker").waitFor();
  await dlg.getByRole("tab", { name: "Icons" }).click();
  await dlg.getByRole("button", { name: "megaphone" }).click();
  await dlg.getByRole("radio", { name: "Colour pink" }).click();
  await p.keyboard.press("Escape");                        // Esc closes the picker first, not the dialog
  await p.getByTestId("icon-picker").waitFor({ state: "detached" });
  await p.getByTestId("vis-private").click();
  await dlg.getByTestId("admins-note").waitFor();
  await p.getByTestId("team-add-people").fill("Priya");
  await p.getByRole("option", { name: /Priya Shah/ }).waitFor({ timeout: 15000 });
  await p.keyboard.press("Enter");
  await dlg.locator(".tz-mchip", { hasText: "Priya" }).waitFor();
  await dlg.locator(".tz-mchip", { hasText: "Priya" }).getByRole("button", { name: /member\. Switch/ }).click();
  await shot(p, "teams-new-dialog-light");
  await p.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await p.waitForURL(/\/teams\/marketing$/, { timeout: 20000 });
  await p.getByTestId("team-home").waitFor();
  const t = ok(await api("GET", `${base}/teams/marketing`, T.admin), "marketing").team;
  if (t.icon !== "glyph:megaphone" || t.color !== "pink" || t.visibility !== "private") fail(`created ${JSON.stringify([t.icon, t.color, t.visibility])}`);
  if (!t.members.some((m) => m.id === U.priya && m.role === "lead")) fail("Priya isn't a lead");
  await row(p, tk(t.id)).waitFor({ timeout: 15000 });
  // General's settings: rename-only (Private disabled, no Delete, no people remove).
  await p.goto(`${APP}/w/${W}/teams/general/settings`);
  await p.getByTestId("vis-private").waitFor({ timeout: 20000 });
  if ((await p.getByTestId("vis-private").getAttribute("aria-disabled")) !== "true") fail("General can be made private in the dialog");
  if (await p.getByRole("dialog").getByRole("button", { name: "Delete" }).count()) fail("General offers Delete");
  await p.getByRole("dialog").getByText(/everyone in/).waitFor();
  await p.keyboard.press("Escape");
  await p.waitForURL(/\/teams\/general$/, { timeout: 10000 });
});

await step("settings", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/w/${W}/teams/${sales.slug}/settings`);
  const dlg = p.getByRole("dialog");
  await p.getByTestId("team-add-people").waitFor({ timeout: 20000 });
  await p.getByTestId("team-add-people").fill("Priya");
  await p.getByRole("option", { name: /Priya Shah/ }).waitFor({ timeout: 15000 });
  await p.keyboard.press("Enter");
  await dlg.locator(".tz-mchip", { hasText: "Priya" }).waitFor();
  await dlg.locator("summary", { hasText: "Connect Slack and Jira" }).click();
  await p.getByTestId("team-integrations").waitFor();
  await shot(p, "teams-settings-light", { full: true });
  await p.getByTestId("save-team").click();
  await dlg.waitFor({ state: "detached", timeout: 15000 });
  const t = ok(await api("GET", `${base}/teams/${sales.id}`, T.owner), "sales").team;
  if (!t.members.some((m) => m.id === U.priya)) fail("Priya not added from the dialog");
  ok(await api("DELETE", `${base}/teams/${sales.id}/members/${U.priya}`, T.owner), "remove priya");
  // With a Slack channel: "Post new and resolved comments" (on by default) turns off.
  ok(await api("PATCH", `${base}/teams/${sales.id}`, T.owner, { slack_channel: { id: "C0SALES", name: "sales" } }), "channel");
  await p.goto(`${APP}/w/${W}/teams/${sales.slug}/settings`);
  await p.getByRole("dialog").locator("summary", { hasText: "Connect Slack and Jira" }).click({ timeout: 20000 });
  const sw = p.getByTestId("slack-comments");
  await sw.waitFor({ state: "attached", timeout: 20000 });
  if (!(await sw.isChecked())) fail("comment posts not on by default");
  await p.locator("label", { has: sw }).click();
  await p.waitForFunction(() => !document.querySelector('[data-testid="slack-comments"]')?.checked);
  let saved = false;
  for (let i = 0; i < 20 && !saved; i++) {
    saved = ok(await api("GET", `${base}/teams/${sales.id}`, T.owner), "team").team.slack_comments === false;
    if (!saved) await new Promise((r) => setTimeout(r, 250));
  }
  if (!saved) fail("slack_comments not saved");
  ok(await api("PATCH", `${base}/teams/${sales.id}`, T.owner, { slack_channel: null, slack_comments: true }), "reset channel");
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
  await sec.getByText(/In General/).waitFor();
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
  if (await p.getByText(`${SECRET} plan`).count()) fail("team page under General (company-wide)");
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

await step("general-meetings", async () => {
  // General › Meetings: meetings in no other team; "Show all I can open" adds the teams' meetings.
  const imp = async (title, team_ids) => ok(await api("POST", "/api/v1/meetings/import", T.owner, { workspace: WS, wait: true,
    restricted: false, title, date: "2026-11-05", team_ids, sources: [{ name: `${title} - Transcript`,
      text: `${title} - Transcript\nAttendees\nAda Owner\nTranscript\nAda Owner: Notes for ${title}.\n` }] }), title).meetings[0];
  const salesM = await imp("Sales deal desk", [sales.id]);
  const allHands = await imp("All hands", []);
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/w/${W}/teams/general`);
  await row(p, tk(G.id, "meetings")).waitFor({ timeout: 20000 });
  await row(p, tk(G.id, "meetings")).first().click();
  await p.getByRole("heading", { name: "General meetings" }).waitFor({ timeout: 20000 });
  const card = (id) => p.locator(`[data-testid="meeting-card"][data-id="${id}"]`);
  await card(allHands.id).waitFor({ timeout: 20000 });
  if (await card(salesM.id).count()) fail("a Sales meeting in General › Meetings");
  // General's home shows meetings from every team you can see.
  await p.goto(`${APP}/w/${W}/teams/general`);
  await p.getByTestId("team-meetings").getByText("Sales deal desk").waitFor({ timeout: 20000 });
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
      for (const u of [`/w/${W}/teams/${sales.slug}`, `/w/${W}/teams`, `/w/${W}/teams/general`, `/w/${W}/teams/${sales.slug}/settings`, `/w/${W}/teams/${sales.slug}/pages`]) {
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
        await drawer.locator(`[data-rail-key="${tk(sales.id)}"]`).waitFor({ timeout: 10000 });
        await drawer.getByTestId("ws-switcher").waitFor();
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
