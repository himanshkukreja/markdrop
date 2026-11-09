/**
 * Team memory (.work/workspace-memory/SPEC.md) on the REAL stack, with the fake models in api_run.py
 * (PB_FAKE_MEETINGS_AI writes each meeting's notes; PB_FAKE_TEAM_AI reads "Done: / Working on: / Target: … by … /
 * Blocked: … (waiting on …)" sentences; background loops are off, /__sandbox/team-memory/run reads now):
 *
 *   enable    off by default: a member sees "an admin can turn it on"; the admin turns it on from Team
 *   board     cards with derived status (On track / Blocked / Waiting / Quiet lately), Now, target chips with due
 *             dates, open items; the charts (open items per person, activity heatmap, blockers); the sidebar's Team
 *   leak      a viewer who wasn't in the restricted 1:1 never gets its lines (UI and every API body); the attendee does
 *   own       Ben sets his focus and status (they top his card), hides a line and corrects another; Wes sees the
 *             correction and not the hidden line; Ben undoes the hide from "Hidden by you"
 *   filters   status filter "Blocked or waiting", the person search, the project filter
 *   person    a card opens the person page: timeline by day, targets, sources link to the meeting
 *   project   Projects tab: the swimlane; the project page lists people and decisions
 *   groups    the admin makes a group from the meeting-series suggestion; the group filter and its tiles; a member
 *             can't make one
 *   week      "This week so far" shows the week so far (last week's highlights, labelled, before any); the admin's Send now keeps it (team-visible lines only: never the 1:1)
 *   off       the admin turns it off in Settings › Advanced: Team says it's off; the facts are gone
 *   devices   phones (360, 390, 412, landscape) and tablets (744, 820, 1024) on the board and a person page: no sideways
 *             scroll, nothing outside the viewport, touch targets ≥ 44 px, inputs ≥ 16 px; screenshots light + dark
 *
 *   PB_FAKE_MEETINGS_AI=1 PB_FAKE_TEAM_AI=1 PB_FAKE_ASK_AI=1 PB_STACK_ID=52 PB_WORK=… zsh up.sh start
 *   PB_STACK_ID=52 PB_WORK=… BROWSER=chromium|webkit [ONLY=board,own] node team.mjs
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
const ok = (r, what) => { if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const SECRET = "quokka";
const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const run = () => api("POST", "/__sandbox/team-memory/run");
const teamUrl = `${APP}/team/${encodeURIComponent(WS)}`;

// ── The team: three more members ──────────────────────────────────────────────
const more = {};
for (const [k, email, name] of [["priya", "priya@acme.test", "Priya Shah"], ["raj", "raj@acme.test", "Raj Patel"], ["mei", "mei@acme.test", "Mei Lin"]]) {
  more[k] = ok(await api("POST", "/__sandbox/user", null, { email, name }), `user ${name}`);
  ok(await api("POST", "/__sandbox/team-memory/member", null, { workspace_id: WS, user_id: more[k].id, role: "member" }), "member");
}
const meeting = (title, date, lines, extra = {}) => api("POST", "/api/v1/meetings/import", T.owner, {
  workspace: WS, wait: true, date, title, restricted: false, ...extra,
  sources: [{ name: `${title} - Transcript`, text: `${title} - Transcript\nAttendees\n${[...new Set(lines.map((l) => l.split(":")[0]))].join(", ")}\nTranscript\n${lines.join("\n")}\nTranscription ended after 00:15:00\n` }],
});
const standups = [
  [day(9), ["Ada Owner: Status: Sourcing beta is on track for the Senseloaf pilot.",
    "Ben Member: Done: wired the Greenhouse import for sourcing. Working on: candidate search filters for sourcing.",
    "Priya Shah: Working on: the billing export for finance.", "Raj Patel: Done: mobile login screen. Working on: push notifications for the mobile app."]],
  [day(5), ["Ben Member: Working on: candidate search filters for sourcing. Target: ship the sourcing filters by Friday.",
    "Priya Shah: Blocked: the billing export needs the new API keys (waiting on Raj Patel).",
    "Raj Patel: Working on: push notifications for the mobile app. Target: mobile beta build by end of next week.",
    "Wes Admin: Decision: the sourcing beta goes to Senseloaf first."]],
  [day(1), ["Ben Member: Done: sourcing filters behind a flag. Working on: saved searches for sourcing.",
    "Priya Shah: Blocked: still no API keys for the billing export (waiting on Raj Patel).",
    "Mei Lin: Role: leads onboarding design. Working on: the onboarding checklist redesign. Target: onboarding checklist mockups by tomorrow.",
    "Wes Admin: Status: billing export slipped a week."]],
];
const made = [];
for (const [i, [date, lines]] of standups.entries()) made.push(ok(await meeting(`Sourcing standup ${i + 1}`, date, lines), `standup ${i + 1}`).meetings[0]);
// A 1:1 restricted to Ada and Ben: Vic (a viewer) must never see a word of it.
const oneOnOne = ok(await meeting("Ada / Ben 1:1", day(2), [
  `Ben Member: Blocked: the ${SECRET} pricing memo needs legal sign-off (waiting on Ada Owner).`,
  "Ada Owner: Thanks, I will chase legal."], { restricted: true }), "1:1").meetings[0];
if (!oneOnOne.restricted) fail("the 1:1 isn't restricted");
// A page Ben wrote: an @mention line for the fake, and a task line for Raj (a free fact).
const page = ok(await api("POST", "/api/v1/pages", T.member, {
  title: "Mobile launch checklist", workspace: WS, folder: S.folder, auto_cover: false,
  content: `# Mobile launch checklist\n\n@Raj Patel is preparing the mobile app store listing for the beta. ${"Store copy, screenshots and review notes. ".repeat(8)}\n\n- [ ] :person[Raj Patel]{id="${more.raj.id}"} upload the beta build to TestFlight\n`,
}), "page").document;

// More commitments for "This week": three for Mei (one grouped row), one of Raj's due within the last two
// weeks (Overdue) and one due long ago (stale: his page only).
ok(await meeting("Design sync", day(2), ["Mei Lin: Target: onboarding copy review by tomorrow. Target: icon set handoff by tomorrow. Target: usability notes by tomorrow."]), "design sync");
ok(await meeting("Mobile sync", day(10), ["Raj Patel: Target: crash report triage by tomorrow."]), "mobile sync");
ok(await meeting("Mobile kickoff", day(24), ["Raj Patel: Target: store screenshots by tomorrow."]), "mobile kickoff");

await step("enable", async () => {
  const off = ok(await api("GET", `/api/v1/team/${WS}`, T.member), "board as member");
  if (off.enabled !== false || off.can_enable !== false) fail(`expected off for a member: ${JSON.stringify(off)}`);
  {
    const { p } = await ctx(browser, { token: T.member });
    await p.goto(teamUrl);
    await p.getByText("A workspace admin can turn it on.").waitFor({ timeout: 20000 });
  }
  const { p } = await ctx(browser, { token: T.admin });
  await p.goto(teamUrl);
  await p.getByTestId("team-off").waitFor({ timeout: 20000 });
  await shot(p, "team-off");
  await p.getByTestId("team-enable").click();
  await p.getByTestId("team-board").waitFor({ timeout: 20000 });
  const r = ok(await run(), "run");
  if (!r.passes[0].done) fail(`nothing was read: ${JSON.stringify(r)}`);
  log("read", JSON.stringify(r.passes.map((x) => x.done)));
});

await step("board", async () => {
  const { p } = await ctx(browser, { token: T.admin });
  await p.goto(teamUrl);
  await p.getByTestId("team-cards").waitFor({ timeout: 20000 });
  const card = (name) => p.locator(`[data-testid="team-card"][data-person="${name}"]`);
  const state = async (name) => card(name).getByTestId("team-status").getAttribute("data-state");
  if ((await state("Ben Member")) !== "on_track") fail(`Ben: ${await state("Ben Member")}`);
  if ((await state("Priya Shah")) !== "waiting") fail(`Priya: ${await state("Priya Shah")}`);
  if ((await state("Vic Viewer")) !== "quiet") fail(`Vic: ${await state("Vic Viewer")}`);
  await card("Priya Shah").getByText("Waiting on").first().waitFor();
  await card("Ben Member").getByText("Saved searches for sourcing").waitFor();
  await card("Raj Patel").getByTestId("team-target").first().waitFor();
  await p.getByTestId("team-chart-open").waitFor();
  await p.getByTestId("team-chart-activity").waitFor();
  await p.getByTestId("team-blockers").getByText("Priya Shah").waitFor();
  // The sidebar's Team row.
  const nav = p.locator('a[href$="/team/' + WS + '"]').first();
  if (!(await nav.count())) fail("no Team row in the sidebar");
  await shot(p, "team-board-desktop-light", { full: true });
});

await step("leak", async () => {
  // Vic (viewer) wasn't in the 1:1: nothing of it, anywhere.
  const { p } = await ctx(browser, { token: T.reader });
  const bodies = captureApi(p);
  await p.goto(teamUrl);
  await p.getByTestId("team-cards").waitFor({ timeout: 20000 });
  await p.locator(`[data-testid="team-card"][data-person="Ben Member"]`).click();
  await p.getByTestId("team-person").waitFor();
  await p.waitForTimeout(800);
  const all = bodies.map((b) => b.body).join("\n") + (await p.content());
  if (all.toLowerCase().includes(SECRET)) fail("the restricted 1:1 leaked to Vic");
  for (const who of ["reader", "member"]) {
    const r = ok(await api("GET", `/api/v1/team/${WS}/people/${U.member}`, T[who]), `person as ${who}`);
    const has = JSON.stringify(r).includes(SECRET);
    if (who === "reader" && has) fail("API leaked the 1:1 to Vic");
    if (who === "member" && !has) fail("Ben doesn't see his own 1:1 blocker");
  }
  // A stranger: 404.
  const s = await api("GET", `/api/v1/team/${WS}`, T.stranger);
  if (s.status !== 404) fail(`stranger got ${s.status}`);
});

await step("own", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${teamUrl}/people/${U.member}`);
  await p.getByTestId("team-person").waitFor({ timeout: 20000 });
  await p.getByTestId("team-set-focus").click();
  await p.getByTestId("team-focus-text").fill("Shipping saved searches this week");
  await p.getByTestId("team-focus-save").click();
  await p.getByTestId("team-focus").getByText("Shipping saved searches this week").waitFor();
  await p.getByTestId("team-set-status").click();
  await p.getByTestId("team-status-text").fill("Heads down on sourcing");
  await p.getByTestId("team-status-save").click();
  await p.getByText("Heads down on sourcing").first().waitFor();
  // Hide the "Working on" line; correct an update.
  const working = p.getByTestId("team-working").getByTestId("team-line").first();
  const hiddenText = (await working.locator(".tm-line__text").innerText()).trim();
  await working.getByTestId("team-line-menu").click();
  await p.getByRole("menuitem", { name: /Hide this line/ }).click();
  await p.getByTestId("team-hidden").getByText(hiddenText).waitFor();
  const upd = p.getByTestId("team-timeline").locator('[data-kind="update"]').first();
  await upd.getByTestId("team-line-menu").click();
  await p.getByRole("menuitem", { name: /This is wrong/ }).click();
  await p.getByTestId("team-correct-text").fill("Wired the Lever import, not Greenhouse");
  await p.getByTestId("team-correct-save").click();
  await p.getByText("Wired the Lever import, not Greenhouse").first().waitFor();
  await shot(p, "team-person-own-light", { full: true });
  // Wes sees the correction, not the hidden line.
  const w = ok(await api("GET", `/api/v1/team/${WS}/people/${U.member}`, T.admin), "Ben as Wes");
  const txt = JSON.stringify(w);
  if (!txt.includes("Wired the Lever import")) fail("Wes doesn't see the correction");
  if (w.working_on.some((l) => l.text === hiddenText)) fail("Wes still sees the hidden line");
  const board = ok(await api("GET", `/api/v1/team/${WS}`, T.admin), "board");
  const ben = board.people.find((c) => c.id === U.member);
  if (ben.status.state !== "self" || ben.now.text !== "Shipping saved searches this week") fail(`Ben's card: ${JSON.stringify(ben.status)} ${JSON.stringify(ben.now)}`);
  // Undo the hide.
  await p.getByTestId("team-hidden").getByTestId("team-undo").first().click();
  await p.getByTestId("team-working").getByText(hiddenText).waitFor();
});

await step("filters", async () => {
  const { p } = await ctx(browser, { token: T.admin });
  await p.goto(teamUrl);
  await p.getByTestId("team-cards").waitFor({ timeout: 20000 });
  await p.getByTestId("team-filter-status").selectOption("blocked");
  const names = await p.locator('[data-testid="team-card"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-person")));
  if (names.join() !== "Priya Shah") fail(`blocked filter: ${names}`);
  await p.getByTestId("team-filter-status").selectOption("");
  await p.getByTestId("team-search").fill("mei");
  if ((await p.locator('[data-testid="team-card"]').count()) !== 1) fail("search");
  await p.getByTestId("team-search").fill("");
  const opts = await p.getByTestId("team-filter-project").locator("option").allInnerTexts();
  if (!opts.includes("Sourcing")) fail(`projects: ${opts}`);
  await p.getByTestId("team-filter-project").selectOption({ label: "Sourcing" });
  const sourcing = await p.locator('[data-testid="team-card"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-person")));
  if (!sourcing.includes("Ben Member") || sourcing.includes("Raj Patel")) fail(`project filter: ${sourcing}`);
});

await step("person", async () => {
  const { p } = await ctx(browser, { token: T.admin });
  await p.goto(teamUrl);
  await p.locator(`[data-testid="team-card"][data-person="Raj Patel"]`).click();
  await p.getByTestId("team-person").waitFor({ timeout: 20000 });
  await p.getByTestId("team-timeline").waitFor();
  await p.getByTestId("team-targets").getByTestId("team-target").first().waitFor();
  const actions = await p.getByTestId("team-actions").innerText();
  if (!actions.includes("TestFlight")) fail(`Raj's open items: ${actions}`);
  const src = p.getByTestId("team-working").locator(".tm-src__link").first();
  const href = await src.getAttribute("href");
  if (!href || !href.startsWith("/")) fail(`source link ${href}`);
  await shot(p, "team-person-light", { full: true });
  await src.click();
  await p.waitForURL((u) => u.pathname === href, { timeout: 20000 });
});

await step("project", async () => {
  const { p } = await ctx(browser, { token: T.admin });
  await p.goto(teamUrl);
  await p.getByRole("tab", { name: /Projects/ }).click();
  await p.getByTestId("team-lanes").waitFor({ timeout: 20000 });
  await shot(p, "team-projects-light");
  await p.getByTestId("team-lanes").getByRole("link", { name: "Sourcing" }).click();
  await p.getByTestId("team-project").waitFor({ timeout: 20000 });
  await p.getByText("The sourcing beta goes to senseloaf first", { exact: false }).first().waitFor();
});

// ── Phones and tablets: the board and a person page, light and dark ──────────
const DEVICES = [["phone360", 360, 780], ["phone390", 390, 844], ["phone412", 412, 915], ["phoneland", 852, 393],
  ["tab744", 744, 1133], ["tab820", 820, 1180], ["tab1024", 1024, 768]];
async function audit(p, where) {
  return p.evaluate((where) => {
    const out = [];
    const de = document.documentElement;
    if (de.scrollWidth > de.clientWidth + 1) out.push(`${where}: page scrolls sideways (${de.scrollWidth} > ${de.clientWidth})`);
    const vw = window.innerWidth;
    for (const el of document.querySelectorAll(".tm-page a, .tm-page button, .tm-page select, .tm-page input")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const st = getComputedStyle(el);
      if (st.visibility === "hidden" || el.closest(".tm-sr")) continue;
      // A link inside running text (WCAG 2.5.8 exempts inline targets).
      if (st.display === "inline" && el.closest("p")) continue;
      if (r.right > vw + 1 || r.left < -1) out.push(`${where}: outside the viewport: ${el.outerHTML.slice(0, 80)}`);
      const small = el.classList.contains("tm-card__link") ? false : (r.height < 43.5 && !el.closest(".tm-strip"));
      if (small && matchMedia("(pointer: coarse)").matches) out.push(`${where}: ${Math.round(r.height)}px target: ${(el.textContent || el.getAttribute("aria-label") || el.tagName).trim().slice(0, 40)}`);
      if ((el.tagName === "INPUT" || el.tagName === "SELECT") && parseFloat(st.fontSize) < 16 && vw < 640) out.push(`${where}: input font ${st.fontSize}`);
    }
    return out;
  }, where);
}
await step("devices", async () => {
  const problems = [];
  for (const theme of ["light", "dark"]) {
    for (const [name, width, height] of DEVICES) {
      const { c, p } = await ctx(browser, { token: T.admin, theme, width, height, mobile: true });
      await p.goto(teamUrl);
      await p.getByTestId("team-cards").waitFor({ timeout: 20000 });
      await p.waitForTimeout(400);
      problems.push(...await audit(p, `${name} board`));
      if (theme === "light" || ["phone390", "tab820"].includes(name)) await shot(p, `team-board-${name}-${theme}`, { full: name.startsWith("phone") && name !== "phoneland" });
      await p.goto(`${teamUrl}/people/${more.raj.id}`);
      await p.getByTestId("team-person").waitFor({ timeout: 20000 });
      await p.waitForTimeout(300);
      problems.push(...await audit(p, `${name} person`));
      if (["phone390", "tab820"].includes(name)) await shot(p, `team-person-${name}-${theme}`, { full: true });
      await c.close();
    }
  }
  const uniq = [...new Set(problems)];
  if (uniq.length) fail(`${uniq.length} layout problem(s):\n${uniq.slice(0, 40).join("\n")}`);
});

await step("groups", async () => {
  const { p } = await ctx(browser, { token: T.admin });
  await p.goto(teamUrl);
  await p.getByTestId("team-groups").click();
  await p.getByTestId("team-group-use").first().click();
  const name = await p.getByTestId("team-group-name").inputValue();
  if (!/Sourcing standup/.test(name)) fail(`suggested name ${name}`);
  await p.getByTestId("team-group-name").fill("Sourcing team");
  await p.getByTestId("team-group-save").click();
  await p.getByRole("dialog").getByText("Sourcing team").first().waitFor();
  await p.keyboard.press("Escape");
  await p.getByTestId("team-filter-group").waitFor({ timeout: 10000 });
  await p.getByTestId("team-filter-group").selectOption({ label: "Sourcing team" });
  const names = await p.locator('[data-testid="team-card"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-person")));
  if (!names.includes("Ben Member") || names.includes("Vic Viewer")) fail(`group filter: ${names}`);
  const r = await api("POST", `/api/v1/team/${WS}/groups`, T.member, { name: "Mine", member_ids: [] });
  if (r.status !== 403) fail(`member made a group: ${r.status}`);
  await shot(p, "team-group-light");
});

await step("week", async () => {
  const OUT = process.env.WEEK_SHOTS;           // .work/team-thisweek/shots when set
  if (OUT) fs.mkdirSync(OUT, { recursive: true });
  const wshot = async (p, name) => { await shot(p, name); if (OUT) await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: false }); };
  const live = ok(await api("GET", `/api/v1/team/${WS}`, T.admin), "board as Wes").this_week;
  if (!live || !live.live) fail(`this week before sending: ${JSON.stringify(live).slice(0, 200)}`);
  // Mon–Sun; due = this week, overdue = the last two weeks, stale never; no "Name:" prefixes; ≤ 2 a person.
  const mon = new Date(`${live.from}T00:00:00Z`), sun = new Date(`${live.to}T00:00:00Z`);
  if (mon.getUTCDay() !== 1 || (sun - mon) / 864e5 !== 6) fail(`week ${live.from}–${live.to}`);
  for (const x of live.due) if (x.due < live.from || x.due > live.to) fail(`due outside the week: ${x.text} ${x.due}`);
  for (const x of live.overdue) if (x.due >= live.from || x.days < -14) fail(`overdue out of range: ${x.text} ${x.due}`);
  const texts = [...live.due, ...live.overdue].map((x) => x.text);
  if (!live.overdue.some((x) => x.text === "Crash report triage")) fail(`no Crash report triage in overdue: ${JSON.stringify(live.overdue)}`);
  if (texts.includes("Store screenshots")) fail("a stale item is on the card");
  const per = {};
  for (const h of live.highlights) {
    per[h.person?.id] = (per[h.person?.id] ?? 0) + 1;
    if (h.person && h.text.startsWith(h.person.name)) fail(`highlight repeats the name: ${h.text}`);
  }
  if (Object.values(per).some((n) => n > 2)) fail(`more than 2 highlights a person: ${JSON.stringify(per)}`);
  // Stale stays on Raj's page; Raj marks the overdue one done and it leaves the card.
  const raj = ok(await api("GET", `/api/v1/team/${WS}/people/${more.raj.id}`, more.raj.token), "Raj's page");
  if (!raj.targets.some((t) => t.text === "Store screenshots")) fail("the stale item isn't on Raj's page");
  const crash = live.overdue.find((x) => x.text === "Crash report triage");
  ok(await api("POST", `/api/v1/team/${WS}/facts/${crash.id}/done`, more.raj.token), "mark done");
  const after = ok(await api("GET", `/api/v1/team/${WS}`, T.admin), "board").this_week;
  if (after.overdue.some((x) => x.id === crash.id)) fail("a done item is still overdue");
  ok(await api("DELETE", `/api/v1/team/${WS}/facts/${crash.id}/done`, more.raj.token), "undo mark done");

  const { p } = await ctx(browser, { token: T.admin });
  await p.goto(teamUrl);
  const card = p.getByTestId("team-this-week");
  await card.waitFor({ timeout: 20000 });
  for (const id of ["highlights", "due", "overdue"]) await card.getByTestId(`team-week-${id}`).waitFor();
  const head = (await card.locator("h2").textContent()).replace(/\s+/g, " ");
  if (!/This week so far · \w{3} \d+/.test(head)) fail(`header: ${head}`);
  // Desktop: three equal-height columns side by side.
  const boxes = await card.locator(".tm-wk__col").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.top, r.height]; }));
  if (new Set(boxes.map((b) => Math.round(b[0]))).size !== 1 || new Set(boxes.map((b) => Math.round(b[1]))).size !== 1) fail(`columns: ${JSON.stringify(boxes)}`);
  // Mei's three items are one row that opens.
  const group = card.getByTestId("team-week-group").filter({ hasText: "Mei" }).first();
  await group.waitFor();
  await group.getByRole("button").first().click();
  await group.getByText("Icon set handoff").waitFor();
  await wshot(p, "week-1440-light");
  // The page uses the width: content starts near the sidebar, not in a narrow centered column.
  const width = await p.getByTestId("team-board").evaluate((el) => el.getBoundingClientRect().width);
  if (width < 1080) fail(`Team is ${Math.round(width)} px wide at 1440 (a narrow centered column)`);
  // The tiles count like the card.
  const tiles = await p.getByTestId("team-tiles").locator(".tm-tile__n").allInnerTexts();
  if (Number(tiles[2]) !== live.due.length || Number(tiles[3]) !== live.overdue.length) fail(`tiles ${tiles} vs card ${live.due.length}/${live.overdue.length}`);
  await card.getByTestId("team-week-send").click();
  // The card says the summary went out ("Summary sent Mon, Nov 9"; was "Sent …" before the 2026-11-09 labels).
  await card.getByTestId("team-week-note").filter({ hasText: /^Summary sent / }).waitFor({ timeout: 20000 });
  const b = ok(await api("GET", `/api/v1/team/${WS}`, T.reader), "board as Vic");
  if (!b.this_week || b.this_week.live) fail(`this week: ${JSON.stringify(b.this_week).slice(0, 200)}`);
  if (JSON.stringify(b.this_week).toLowerCase().includes(SECRET)) fail("the weekly summary carried the 1:1");
  const m = ok(await api("GET", `/api/v1/team/${WS}`, T.member), "board as Ben");
  if (JSON.stringify(m.this_week).toLowerCase().includes(SECRET)) fail("the weekly summary carried the 1:1 (even for Ben)");
  await shot(p, "team-week-light");
  for (const [w, h, theme, name, mobile] of [[2000, 1100, "light", "board-2000-light"], [1440, 900, "dark", "week-1440-dark"],
    [2000, 1100, "dark", "board-2000-dark"], [820, 1180, "light", "week-tablet-820-light", true], [1180, 820, "dark", "week-tablet-1180-dark", true],
    [390, 844, "light", "week-phone-390-light", true], [390, 844, "dark", "week-phone-390-dark", true]]) {
    const { p: q } = await ctx(browser, { token: T.admin, theme, width: w, height: h, mobile });
    await q.goto(teamUrl);
    await q.getByTestId("team-this-week").waitFor({ timeout: 20000 });
    await q.getByTestId("team-this-week").scrollIntoViewIfNeeded();
    const sw = await q.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (sw > 0) fail(`${name}: ${sw}px sideways scroll`);
    await wshot(q, name);
  }
});

await step("dark", async () => {
  const { p } = await ctx(browser, { token: T.admin, theme: "dark" });
  await p.goto(teamUrl);
  await p.getByTestId("team-cards").waitFor({ timeout: 20000 });
  await shot(p, "team-board-desktop-dark", { full: true });
});

await step("off", async () => {
  const { p } = await ctx(browser, { token: T.admin });
  await p.goto(`${APP}/settings/workspaces/${encodeURIComponent(WS)}?tab=advanced`);
  const sw = p.locator('input[aria-labelledby="ws-team-memory-label"]');
  await sw.waitFor({ state: "attached", timeout: 20000 });
  if (!(await sw.isChecked())) fail("the switch shows off while Team memory is on");
  await sw.evaluate((el) => el.click());
  await p.getByText("Team memory is off. What it gathered is deleted.").waitFor({ timeout: 10000 });
  const b = ok(await api("GET", `/api/v1/team/${WS}`, T.member), "board");
  if (b.enabled !== false) fail("still on");
  const r = await api("GET", `/api/v1/team/${WS}/people/${U.member}`, T.admin);
  if (r.status !== 404) fail(`person after off: ${r.status}`);
});

await browser.close();
console.log("\n" + results.map(([n, s, ms]) => `${s === "ok" ? "✓" : "✗"} ${n} ${s === "ok" ? "" : s} (${(ms / 1000).toFixed(1)} s)`).join("\n"));
if (results.some(([, s]) => s !== "ok")) process.exit(1);
void API; void page; void made;
