/**
 * Mocked-API docs clips (record.mjs). World: world.mjs (Acme; Riya Sharma is signed in, owns the workspace
 * and leads Sales). Each clip's handlers answer what its steps change (a new team, an edited line…).
 */
import * as W from "./world.mjs";
import NOV19 from "./clips2.mjs";

const { WS, people, teams, iso, ymd } = W;

/** The sidebar's open rows (localStorage md_rail_tree). General closes with "<key>!closed". */
const rail = (open = [], generalOpen = false) => ({
  md_rail_tree: JSON.stringify([...open.map((t) => `ws:${WS}:team:${t}`), ...(generalOpen ? [] : [`ws:${WS}:team:t_gen!closed`])]),
});
const body = (req) => { try { return req.postDataJSON() || {}; } catch { return {}; } };
const text = (t) => async (h) => { await h.page.getByText(t, { exact: false }).first().waitFor({ timeout: 60_000 }); };

/* ── Teams › Create and manage: New team ── */
const created = { team: null };
const csHome = (t) => ({
  team: W.teamFull(t, [{ ...people.riya, role: "lead" }, { ...people.maya, role: "member" }]),
  brief: null, recent: [], meetings: [], memory: { highlights: [], people: [people.riya, people.maya].map((x) => ({ ...x, status: null })) },
  jira: { projects: [] }, projects: [], can_read: true,
});
const createFlow = {
  id: "teams-create", page: "/teams/create-and-manage", name: "create-flow", url: `/w/${WS}/teams`,
  viewport: { width: 1280, height: 860 }, storage: rail([]), tail: 1000, cursor: [700, 400],
  handlers: [
    [`/api/v1/workspaces/${WS}/teams/browse`, () => ({ teams: Object.values(teams).map((t) => (t.id === "t_mkt" ? { ...t, my_role: null } : t)) })],
    [`/api/v1/workspaces/${WS}/teams`, (u, m, req) => {
      if (m === "POST") {
        const b = body(req);
        created.team = { ...teams.marketing, id: "t_cs", name: b.name, slug: "customer-success", icon: b.icon, color: b.color, visibility: b.visibility,
          description: b.description || "", lead_ids: ["u_riya"], my_role: "lead", member_count: 2, linked: [] };
        return W.teamFull(created.team, [{ ...people.riya, role: "lead" }, { ...people.maya, role: "member" }]);
      }
      return { ...W.teamsSidebar, teams: [...W.teamsSidebar.teams, ...(created.team ? [created.team] : [])], projects: [W.project] };
    }],
    [new RegExp(`^/api/v1/workspaces/${WS}/teams/(t_cs|customer-success)$`), () => csHome(created.team)],
  ],
  prepare: async (h) => { created.team = null; await h.loc("[data-testid='new-team']").waitFor({ timeout: 60_000 }); await h.settle(500); },
  steps: async (h) => {
    await h.click("[data-testid='new-team']");
    await h.type("[data-testid='team-name']", "Customer Success", { speed: 2.4 });
    await h.click("[data-testid='team-icon']");
    await h.sleep(500);
    await h.click(h.page.getByRole("button", { name: "🤝" }));
    await h.click(h.page.getByRole("radio", { name: "Colour pink" }));
    await h.sleep(500);
    await h.click(h.page.getByRole("dialog").getByRole("button", { name: "Done" }));
    await h.click("[data-testid='vis-private']");
    await h.sleep(700);
    await h.type("[data-testid='team-add-people']", "Maya", { speed: 2.4 });
    await h.sleep(500);
    await h.page.keyboard.press("Enter");
    await h.sleep(500);
    await h.click("[data-testid='create-team']");
    await h.loc("[data-testid='team-home']").waitFor({ timeout: 20000 });
    await h.sleep(900);
  },
};

/* ── Ask: context, suggestions, an answer ── */
const askContext = {
  scopes: [{ kind: "everything", label: "Everything", sub: null }, { kind: "workspace", label: "Acme", sub: null }, { kind: "mine", label: "My files", sub: null }],
  default: "workspace", page: null, workspace: { id: WS, name: "Acme" }, workspaces: [{ id: WS, name: "Acme" }], folder: null, meeting: null,
  series: [], can_insert: false, status: { search: { enabled: true, reason: null, message: null }, meetings: { enabled: true, reason: null, message: null } },
};
const personal = [
  { label: "Your action items", question: "What are my open action items?", intent: "my_actions", icon: "check" },
  { label: "Catch up", question: "Catch me up on Northwind — pricing and rollout plan (today)", intent: "catch_up", icon: "mic" },
];
const teamSugg = {
  t_sales: [
    { topic: "Northwind", question: "What did we agree with Northwind on the rollout?", label: "Northwind" },
    { topic: "Globex", question: "What does Globex need before the pilot?", label: "Globex" },
    { topic: "Renewals", question: "What's our discount cap on two-year renewals?", label: "Renewals" },
    { topic: "Demo", question: "What's still open on the enterprise demo script?", label: "Demo" },
  ],
  all: [
    { topic: "Pipeline", question: "What did we decide in the Weekly pipeline review?", label: "Pipeline" },
    { topic: "Launch", question: "What's still open on the Q4 launch plan?", label: "Launch" },
    { topic: "Northwind", question: "What did we agree with Northwind on the rollout?", label: "Northwind" },
    { topic: "Release", question: "When does release 2.6 freeze?", label: "Release" },
    { topic: "Globex", question: "What does Globex need before the pilot?", label: "Globex" },
  ],
};
const asked = { q: null };
const askHandlers = (answer) => [
  ["/api/v1/ask/context", () => askContext],
  ["/api/v1/ask/threads", () => ({ threads: asked.q ? [{ id: "th1", title: asked.q, turns: 1, updated_at: iso(0, 0) }] : [] })],
  ["/api/v1/ask/suggestions", (u) => {
    const t = u.searchParams.get("team");
    return { workspace: { id: WS, name: "Acme" }, team_scope: t ? { id: t, name: "Sales" } : null, quiet: false, team: teamSugg[t ? "t_sales" : "all"],
      personal, updated_at: iso(0, 0.4), refreshing: false, ai_off: false, status: { enabled: true, reason: null, message: null } };
  }],
  ["/api/v1/ask", (u, m, req) => {
    if (m !== "POST") return undefined;
    const q = body(req).question || "";
    asked.q = q;
    const ev = (o) => `data: ${JSON.stringify(o)}\n\n`;
    const a = answer(q);
    return { __delay: 1400, body: { __raw: [
      ev({ type: "status", stage: "searching" }),
      ev({ type: "results", items: a.citations.map((c, i) => ({ n: i + 1, key: c.label, title: c.title, subtitle: c.subtitle, kind: "page", slug: c.slug, url: `https://markdrop.in/${c.slug}` })) }),
      ev({ type: "done", request_id: "r1", thread_id: "th1", intent: "ask", answer: a.text, citations: a.citations, ranked: [], scope: { kind: "workspace", label: "Workspace · Acme" } }),
    ].join(""), type: "text/event-stream" } };
  }],
];
const cite = (label, title, date, slug, quote) => ({ label, key: label, title, url: `https://markdrop.in/${slug}`, slug, kind: "meeting", source_kind: "meeting",
  meeting_id: `m_${label}`, subtitle: `${date} · ${title}`, quote });

/* ── Teams › Ask and search: Ask the whole company ── */
const askToggle = {
  id: "teams-ask", page: "/teams/ask-and-search", name: "ask-toggle", url: `/ask?workspace=${WS}`,
  viewport: { width: 1280, height: 800 }, storage: rail([]), tail: 900,
  handlers: askHandlers(() => ({ text: "", citations: [] })),
  prepare: async (h) => {
    await h.loc("[data-testid='ask-teams']").waitFor({ timeout: 60_000 });
    await h.page.getByTestId("ask-team-sales").click();
    await text("Ask anything about Sales")(h).catch(() => {});
    await h.settle(800);
    await h.page.mouse.move(380, 160);
  },
  cursor: [380, 160],
  steps: async (h) => {
    await h.sleep(700);
    const sw = h.page.locator("label", { has: h.page.getByTestId("ask-whole-company") });
    await h.click(sw);
    await h.sleep(1500);
    await h.click(sw);
    await h.sleep(1100);
  },
};

/* ── Workspaces › Ask Markdrop: a live suggestion, asked with one click ── */
const askSuggestion = {
  id: "ask-suggestion", page: "/workspaces/ask-markdrop", name: "suggestion", url: `/ask?workspace=${WS}`,
  viewport: { width: 1440, height: 900 }, storage: rail([]), tail: 400,
  handlers: askHandlers(() => ({
    text: "Three decisions came out of the last two pipeline reviews:\n\n- **Two-year renewals get up to 15% off**, no more; three-year deals need CFO sign-off [1].\n- **Globex moves to Presentation scheduled**, and Hana owns the enterprise demo script for Thursday [1].\n- **The Q4 forecast holds at $1.2M**, with two deals slipping to January [2].",
    citations: [
      cite("1", "Weekly pipeline review", "Nov 18, 2026", "weekly-pipeline-review-2", "Two-year renewals: fifteen percent is the cap."),
      cite("2", "Weekly pipeline review", "Nov 11, 2026", "weekly-pipeline-review-6", "We hold the forecast at one point two."),
    ],
  })),
  prepare: async (h) => {
    asked.q = null;
    await h.loc("[data-testid='ask-page-chat'] [data-testid='chat-starters'] button").waitFor({ timeout: 60_000 });
    await h.settle(800);
  },
  steps: async (h) => {
    await h.sleep(700);
    await h.click(h.page.locator("[data-testid='ask-page-chat'] [data-testid='chat-starters'] button").first());
    await h.page.locator("[data-testid='ask-page-chat'] ol[aria-label='Conversation'] > li[data-state='done'] .ch-md:not([data-streaming])").first().waitFor({ timeout: 40000 });
    await h.move([980, 640]);
    await h.sleep(2600);
  },
};

/* ── Teams › Team home: edit and hide brief lines ── */
const brief = { now: null };
const briefEdit = {
  id: "teams-brief-edit", page: "/teams/team-home", name: "brief-edit", url: `/w/${WS}/teams/sales`,
  viewport: { width: 1200, height: 720 }, storage: rail(["t_sales"]), tail: 700,
  handlers: [
    [new RegExp(`^/api/v1/workspaces/${WS}/teams/(t_sales|sales)$`), () => ({ ...W.salesHome, brief: brief.now })],
    [new RegExp(`^/api/v1/workspaces/${WS}/teams/t_sales/briefs/b1/lines/(\\w+)$`), (u, m, req, hit) => {
      if (m !== "PATCH") return undefined;
      const b = body(req);
      brief.now = { ...brief.now, lines: brief.now.lines.map((l) => (l.id !== hit[1] ? l : { ...l, ...(b.text != null ? { text: b.text, edited: true } : {}), ...(b.hidden != null ? { hidden: b.hidden } : {}) })) };
      return brief.now;
    }],
  ],
  prepare: async (h) => {
    brief.now = structuredClone(W.salesHome.brief);
    await h.goto(`/w/${WS}/teams/sales`);
    await h.loc(".tz-brief__line").first().waitFor({ timeout: 60_000 });
    await h.settle(700);
    await h.page.mouse.move(900, 300);
  },
  cursor: [900, 300],
  steps: async (h) => {
    const line = h.page.locator(".tz-brief__line", { hasText: "Globex needs SSO" }).first();
    await h.hover(line);
    await h.sleep(400);
    await h.click(line.getByRole("button", { name: "Edit line" }));
    const box = h.page.getByRole("textbox", { name: "Line text" });
    await box.evaluate((el) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
    await h.type(null, " Engineering ships it Thursday.", { speed: 2.2 });
    await h.click(h.page.locator(".tz-brief__line form").getByRole("button", { name: "Save" }));
    await h.sleep(900);
    const other = h.page.locator(".tz-brief__line", { hasText: "enterprise demo script" }).first();
    await h.hover(other);
    await h.sleep(400);
    await h.click(other.getByRole("button", { name: "Hide line" }));
    await h.sleep(900);
  },
};

/* ── Workspaces › Team: the board (filters) and your own page (Mark done) ── */
const P = (k) => ({ id: people[k].id, name: people[k].name, avatar_url: null });
const src = (title, dAgo, kind = "meeting") => ({ title, href: `/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, kind, date: ymd(-dAgo) });
const ST = {
  on: (fact, dAgo, s) => ({ state: "on_track", label: "On track", reason: null, fact, since: ymd(-dAgo), waiting_on: null, source: s }),
  wait: (fact, who, dAgo, s) => ({ state: "waiting", label: "Waiting on someone", reason: fact, fact, since: ymd(-dAgo), waiting_on: { id: people[who].id, name: people[who].name }, source: s }),
  quiet: () => ({ state: "quiet", label: "Quiet lately", reason: null, fact: null, since: null, waiting_on: null, source: null }),
};
const tgt = (id, text, due, state, s) => ({ id, text, due: ymd(due), state, source: s });
const card = (k, role, title, status, now, targets, extra = {}) => ({
  id: people[k].id, name: people[k].name, avatar_url: null, role, title, you: k === "riya", status, own_status: null,
  now: now ? { text: now, focus: false, when: ymd(-1), fact: null } : null, targets, open_items: targets.length + (extra.more ?? 1),
  due_week: targets.filter((t) => t.state === "due_soon").length, week_due: targets.filter((t) => t.state === "due_soon").length,
  week_overdue: targets.filter((t) => t.state === "overdue").length, overdue: targets.filter((t) => t.state === "overdue").length,
  activity: extra.activity || [0, 1, 0, 2, 1, 0, 0, 1, 2, 0, 1, 3, 1, 0], projects: extra.projects || [], updated_at: iso(extra.ago ?? 1),
  last_source: status.source, groups: extra.groups || [],
});
const sPipe = src("Weekly pipeline review", 1), sGlobex = src("Globex — security review prep", 2), sStand = src("Sales standup", 3), sLaunch = src("Q4 launch sync", 1);
const cards = [
  card("riya", "owner", "Head of Sales", ST.on("Q1 territory plan", 1, sPipe), "The Q1 territory plan", [tgt("f_r1", "Send Northwind the revised order form", 1, "due_soon", src("Northwind — pricing and rollout plan", 0))], { groups: ["g_sales"], projects: [{ key: "q4-launch", name: "Q4 launch" }], activity: [1, 2, 0, 1, 2, 1, 0, 2, 3, 1, 2, 1, 2, 1] }),
  card("alex", "member", "Account executive", ST.wait("SSO through Okta for the Globex pilot", "sam", 2, sGlobex), "Globex security review", [tgt("f_a1", "SOC 2 report to Globex IT", 0, "due_soon", sGlobex)], { groups: ["g_sales"] }),
  card("hana", "member", "Solutions engineer", ST.on("Enterprise demo script", 1, sPipe), "The enterprise demo script for Thursday", [tgt("f_h1", "Globex demo", 0, "due_soon", sPipe), tgt("f_h2", "Refresh the demo environment", -2, "overdue", sStand)], { groups: ["g_sales"] }),
  card("priya", "member", "Account executive", ST.on("Competitive battlecards", 3, sStand), "Battlecards for the three main competitors", [], { groups: ["g_sales"], more: 2 }),
  card("maya", "member", "Marketing lead", ST.on("Q4 launch campaign", 1, sLaunch), "The 1 December launch campaign", [tgt("f_m1", "Pricing page copy to legal", 4, "upcoming", sLaunch)], { groups: ["g_launch"], projects: [{ key: "q4-launch", name: "Q4 launch" }] }),
  card("sam", "member", "Engineering lead", ST.on("SSO for the enterprise workspace", 1, sLaunch), "Release 2.6 and the SSO rollout", [tgt("f_s1", "Release 2.6 freeze", 7, "upcoming", sLaunch)], { groups: ["g_launch"], projects: [{ key: "q4-launch", name: "Q4 launch" }] }),
  card("diego", "member", "Designer", ST.quiet(), null, [], { groups: ["g_launch"], more: 0, activity: [1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], ago: 9 }),
];
const WP = (k) => ({ id: people[k].id, name: people[k].name, avatar_url: null });
const boardData = {
  enabled: true, ai_on: true, workspace: { id: WS, name: "Acme" }, paused: null, gathering: false, today: ymd(0), week_end: ymd(3),
  people: cards, former: [],
  projects: [{ key: "q4-launch", name: "Q4 launch", status: "On track for 1 December", people: [P("maya"), P("sam"), P("riya")].map(({ id, name }) => ({ id, name })), people_count: 3, facts: 14, blockers: 0, updated_at: iso(1) },
    { key: "globex-pilot", name: "Globex pilot", status: "Waiting on SSO", people: [P("alex"), P("hana")].map(({ id, name }) => ({ id, name })), people_count: 2, facts: 6, blockers: 1, updated_at: iso(2) }],
  lanes: [],
  blockers: [{ person: P("alex"), text: "SSO through Okta for the Globex pilot", waiting_on: { id: "u_sam", name: "Sam Lee" }, since: ymd(-2), state: "waiting", source: sGlobex }],
  totals: { open_items: 14, due_week: 3, overdue: 1, week_due: 3, week_overdue: 1, blocked: 1, on_track: 5, quiet: 1 },
  you: "u_riya", role: "owner", since: ymd(-30),
  groups: [{ id: "g_sales", name: "Sales", member_ids: ["u_riya", "u_alex", "u_hana", "u_priya"] }, { id: "g_launch", name: "Launch crew", member_ids: ["u_maya", "u_sam", "u_diego"] }],
  can_manage: true,
  this_week: { week: "2026-W47", from: ymd(-3), to: ymd(3), today: ymd(0), window: "week", at: iso(0, 1), live: true,
    highlights: [
      { text: "Two-year renewals get up to 15% off, no more.", kind: "decision", person: WP("riya"), day: ymd(-1), sources: [sPipe] },
      { text: "Northwind agreed to a phased rollout; the CFO signs in January.", kind: "update", person: WP("alex"), day: ymd(0), sources: [src("Northwind — pricing and rollout plan", 0)] },
      { text: "Release 2.6 freezes on 26 November.", kind: "decision", person: WP("sam"), day: ymd(-1), sources: [sLaunch] },
    ],
    blockers: [{ person: WP("alex"), text: "SSO through Okta for the Globex pilot", waiting_on: "Sam Lee", since: ymd(-2), source: sGlobex }],
    due: [{ id: "f_h1", person: WP("hana"), text: "Globex demo", due: ymd(0), days: 0, source: sPipe }, { id: "f_r1", person: WP("riya"), text: "Send Northwind the revised order form", due: ymd(1), days: 1, source: sPipe }],
    overdue: [{ id: "f_h2", person: WP("hana"), text: "Refresh the demo environment", due: ymd(-2), days: -2, source: sStand }],
  },
};
const line = (id, kind, label, text, dAgo, s, extra = {}) => ({ id, kind, label, text, corrected: false, wrong: false, when: ymd(-dAgo), day: ymd(-dAgo),
  project: null, sources: [{ ...s, slug: s.href.slice(1) }], hidden: false, can_correct: true, subject: "u_riya", ...extra });
const sNorth = src("Northwind — pricing and rollout plan", 0);
const riyaLines = {
  working_on: [line("w1", "working_on", "Working on", "The Q1 territory plan", 1, sPipe), line("w2", "working_on", "Working on", "Northwind's 3-year order form", 0, sNorth)],
  targets: [
    line("f_r1", "target", "Target", "Send Northwind the revised order form", 0, sNorth, { due: ymd(1), due_state: "due_soon" }),
    line("f_r2", "target", "Target", "Review the enterprise demo script with Hana", 1, sPipe, { due: ymd(0), due_state: "due_soon" }),
  ],
};
const done = new Set();
const personData = () => {
  const targets = riyaLines.targets.filter((l) => !done.has(l.id));
  return {
    person: { id: "u_riya", name: "Riya Sharma", avatar_url: null, role: "owner", title: "Head of Sales", you: true, archived: false },
    status: cards[0].status, own_status: null, quiet_days: null, focus: { text: "Closing Northwind before the CFO change", at: iso(0, 3) },
    now: { text: "Closing Northwind before the CFO change", focus: true, when: ymd(0), fact: null },
    working_on: riyaLines.working_on, targets, updates: [line("u1", "update", "Update", "Globex moves to Presentation scheduled.", 1, sPipe)],
    action_items: [], decisions: [line("d1", "decision", "Decision", "Two-year renewals get up to 15% off, no more.", 1, sPipe)],
    timeline: [
      { day: ymd(0), items: [riyaLines.working_on[1], ...targets.filter((t) => t.id === "f_r1")] },
      { day: ymd(-1), items: [riyaLines.working_on[0], line("d1", "decision", "Decision", "Two-year renewals get up to 15% off, no more.", 1, sPipe), ...targets.filter((t) => t.id === "f_r2")] },
    ],
    activity: [1, 2, 0, 1, 2, 1, 0, 2, 3, 1, 2, 1, 2, 1, 0, 1, 2, 0, 1, 1, 2, 0, 1, 3, 1, 0, 2, 1, 2, 1],
    documents: [{ slug: "q4-pricing-playbook", title: "Q4 pricing playbook", href: "/q4-pricing-playbook", updated_at: iso(0, 2), kind: "markdown", mine: true },
      { slug: "renewal-playbook", title: "Renewal playbook", href: "/renewal-playbook", updated_at: iso(3), kind: "markdown", mine: true }],
    meetings: [
      { slug: "northwind-call-1", title: "Northwind — pricing and rollout plan", date: ymd(0), series: null, href: "/northwind-call-1" },
      { slug: "weekly-pipeline-review-2", title: "Weekly pipeline review", date: ymd(-1), series: "Weekly pipeline review", href: "/weekly-pipeline-review-2" },
      { slug: "sales-standup-4", title: "Sales standup", date: ymd(-3), series: "Sales standup", href: "/sales-standup-4" },
    ],
    hidden: [], updated_at: iso(0, 1), last_source: sNorth, comment_tasks: [],
  };
};
const teamHandlers = [
  [`/api/v1/team/${WS}`, () => boardData],
  [`/api/v1/team/${WS}/people/u_riya`, () => personData()],
  [`/api/v1/team/${WS}/groups`, () => ({ groups: boardData.groups, suggestions: [] })],
  [new RegExp(`^/api/v1/team/${WS}/facts/(\\w+)/done$`), (u, m, req, hit) => { if (m === "POST") done.add(hit[1]); else done.delete(hit[1]); return { id: hit[1], done: m === "POST" }; }],
];
const teamFilters = {
  id: "team-filters", page: "/workspaces/team", name: "filters", url: `/team/${WS}`,
  viewport: { width: 1440, height: 900 }, storage: rail([], true), tail: 900, handlers: teamHandlers,
  prepare: async (h) => {
    await h.loc("[data-testid='team-filter-status']").waitFor({ timeout: 60_000 });
    await h.settle(800);
    await h.scrollTo("[data-testid='team-filter-status']", { block: "start" });
    await h.page.mouse.wheel(0, -90);
    await h.settle(500);
  },
  steps: async (h) => {
    await h.sleep(500);
    const pick = async (testid, label) => {
      await h.move(`[data-testid='${testid}']`);
      await h.sleep(300);
      await h.page.getByTestId(testid).selectOption({ label });
      await h.sleep(1400);
    };
    await pick("team-filter-status", "Blocked or waiting");
    await pick("team-filter-status", "Any status");
    await pick("team-filter-group", "Launch crew");
  },
};
const markDone = {
  id: "team-mark-done", page: "/workspaces/team", name: "mark-done", url: `/team/${WS}/people/u_riya`,
  viewport: { width: 1440, height: 900 }, storage: rail([], true), tail: 600, handlers: teamHandlers,
  prepare: async (h) => { done.clear(); await h.loc("[data-testid='team-person']").waitFor({ timeout: 60_000 }); await h.settle(800); },
  steps: async (h) => {
    const target = h.page.locator("[data-testid='team-person'] [data-testid='team-line'][data-kind='target']").first();
    await h.move(target);
    await h.sleep(500);
    await h.click(target.locator("[data-testid='team-line-menu']"));
    await h.sleep(800);
    await h.click({ css: "[role='menuitem']:has-text('Mark done')" });
    await h.sleep(2400);
  },
};

/* ── Workspaces › Meetings auto-import: Check for new meetings ── */
const checked = { on: false };
const hooli = W.meeting("Hooli — kickoff call", 0, { time: "16:30", duration_s: 1680, attendees: [{ name: "Riya Sharma", user_id: "u_riya" }, { name: "Hana Kim", user_id: "u_hana" }, { name: "Gavin Belson", user_id: null }],
  summary: "Hooli wants campus hiring live by February; Hana sends the sandbox invite today.", source: "meet", has_recording: false,
  deal: { id: "9100259", name: "Campus hiring season", company: "Hooli", href: `/deals/${WS}/9100259` } });
const checkNow = {
  id: "meet-check-now", page: "/workspaces/meetings-auto-import", name: "check-now", url: `/meetings/${WS}?space=all`,
  viewport: { width: 1440, height: 900 }, storage: rail([]), tail: 600,
  handlers: [
    ["/api/v1/meetings/connection", () => ({ ...W.meetConnection, connection: { ...W.meetConnection.connection, ...(checked.on ? { last_received_at: iso(0, 0), last_imported_at: iso(0, 0), received: 42, imported: 39 } : {}),
      check_now: { ready: true, last_at: checked.on ? iso(0, 0) : iso(0, 0.6), last: null } } })],
    ["/api/v1/meetings/check-now", (u, m) => {
      if (m !== "POST") return undefined;
      checked.on = true;
      return { __delay: 2200, body: { ok: true, message: "Found 1 new meeting.", checked: 1, failed: 0, not_set_up: 0, imported: 1, attached: 0, updated: 0, not_ready: 0, writing: 0, remaining: 0,
        connections: [{ connected_by: { id: "u_riya", name: "Riya Sharma" }, mine: true, ok: true, found: 1, sent: 1, imported: 1 }] } };
    }],
    ["/api/v1/meetings/series", () => (checked.on ? { ...W.series, total: 9, one_offs: 5 } : W.series)],
    ["/api/v1/meetings", () => {
      const list = checked.on ? [hooli, ...W.meetings] : W.meetings;
      return { meetings: list, next_cursor: null, total: list.length, hidden: [], folder_id: "f_meet" };
    }],
  ],
  prepare: async (h) => { checked.on = false; await text("Check for new meetings")(h); await h.settle(800); },
  cursor: [760, 420],
  steps: async (h) => {
    await h.sleep(600);
    await h.click("[data-testid='check-now']");
    await text("Hooli — kickoff call")(h);
    await h.move([900, 520]);
    await h.sleep(2600);
  },
};

/* ── Workspaces › Create: a new workspace ── */
const NEW = "6a3c0ffee0acbe0000000002";
const made = { ws: null };
const newWs = (name) => ({ ...W.workspace, id: NEW, name, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), member_count: 1, item_count: 0,
  branding: { ...W.workspace.branding, site_name: name }, primary_host: null, domains: [], domain_count: 0 });
const newGeneral = () => ({ ...teams.general, id: "t_gen2", member_count: 1, lead_ids: ["u_riya"], my_role: "lead" });
const newWorkspace = {
  id: "new-workspace", page: "/workspaces/create", name: "new-workspace", url: `/w/${WS}/teams/general`,
  viewport: { width: 1280, height: 800 }, storage: rail([], false), tail: 400, poster: 9,
  handlers: [
    ["/api/v1/workspaces", (u, m, req) => {
      if (m === "POST") { made.ws = newWs(body(req).name || "Acme Labs"); return made.ws; }
      return { workspaces: [W.workspace, ...(made.ws ? [made.ws] : [])] };
    }],
    [new RegExp(`^/api/v1/workspaces/${NEW}(/.*)?$`), (u, m, req, hit) => {
      const rest = hit[1] || "";
      if (!rest) return made.ws;
      if (rest === "/teams") return { my_role: "owner", can_create: true, teams: [newGeneral()], projects: [], browse: { open: 0, private: 0 }, suggested: [], review: null };
      if (rest === "/tree") return { workspace: { id: NEW, name: made.ws.name, role: "owner", primary_host: null, default_access: "workspace" }, folders: [], unfiled_count: 0, root_exposure: null };
      if (/^\/teams\/(t_gen2|general)$/.test(rest)) return { ...W.generalHome, team: W.teamFull(newGeneral(), [{ ...people.riya, role: "lead" }]), brief: null, recent: [], meetings: [], across: [],
        activity: { items: [], meetings: [] }, new_people: [], memory: { highlights: [], people: [] } };
      if (rest === "/items") return { items: [], next_cursor: null };
      if (rest === "/members") return { members: [{ user_id: "u_riya", ...people.riya, role: "owner", joined_at: new Date().toISOString() }], invites: [] };
      if (rest === "/favorites") return { favorites: [] };
      if (rest === "/nav") return { items: [], more: {} };
      return undefined;
    }],
  ],
  prepare: async (h) => {
    made.ws = null;
    await text("Across teams")(h);
    // The new workspace is dated by the browser's real now: its Get set up checklist shows only while it's new.
    await h.page.clock.setSystemTime(new Date());
    await h.settle(800);
    await h.page.mouse.move(700, 500);
  },
  cursor: [700, 500],
  steps: async (h) => {
    await h.click("aside [data-testid='ws-switcher']", { after: 700 });
    await h.click({ role: "menuitem", name: "New workspace" }, { after: 1200 });
    await h.loc("main").getByRole("button", { name: "New workspace" }).waitFor();
    await h.click(h.loc("main").getByRole("button", { name: "New workspace" }), { after: 700 });
    await h.type({ label: "Name" }, "Acme Labs", { speed: 1.2 });
    await h.sleep(400);
    await h.click({ role: "button", name: "Create workspace" }, { after: 600 });
    await h.loc("section[aria-labelledby='md-setup-h']").waitFor({ timeout: 20_000 });
    await h.move([900, 600]);
    await h.sleep(900);
  },
};

/* ── Documents › Addresses: Change URL ── */
const slugNow = { s: "q3-plan-internal" };
const q3 = () => ({ ...W.myDocs[0], id: "md_q3", slug: slugNow.s, url: `https://markdrop.in/${slugNow.s}`, title: "Q3 plan — internal notes", views: 0,
  updated_at: iso(0, 5), folder_id: null, folder_path: [], access_level: "private", shared_with_count: 1, icon: null });
const changeUrl = {
  id: "change-url", page: "/documents/addresses", name: "change-url", url: "/dashboard/files",
  viewport: { width: 1280, height: 720 }, storage: rail([]), tail: 400, poster: 6.5,
  handlers: [
    ["/api/v1/me/documents", () => {
      const docs = [W.myDocs[0], q3(), ...W.myDocs.slice(1)];
      return { documents: docs, total: docs.length, page: 1, pages: 1, count_all: docs.length, count_markdown: 3, count_artifact: 6,
        count_by_type: { document: 3, pdf: 1, video: 1, image: 1, sheet: 1, slides: 1, html: 1 } };
    }],
    [/^\/api\/v1\/documents\/([\w-]+)\/slug$/, (u, m, req) => {
      if (m !== "PATCH") return undefined;
      slugNow.s = body(req).new_slug;
      return { ...q3(), content: "", document_id: "md_q3" };
    }],
  ],
  prepare: async (h) => { slugNow.s = "q3-plan-internal"; await text("Q3 plan — internal notes")(h); await h.settle(700); await h.page.mouse.move(640, 420); },
  cursor: [640, 420],
  steps: async (h) => {
    await h.click({ role: "button", name: "Actions for Q3 plan — internal notes" }, { after: 700 });
    await h.click({ role: "menuitem", name: "Change URL" }, { after: 700 });
    await h.click({ role: "textbox", name: "New link" }, { after: 200 });
    await h.press(process.platform === "darwin" ? "Meta+A" : "Control+A", 150);
    await h.type(null, "q3-plan-final", { speed: 0.9 });
    await h.sleep(700);
    await h.click(h.page.getByRole("button", { name: "Change URL", exact: true }).last(), { after: 1700 });
  },
};

export default [...NOV19, createFlow, askToggle, askSuggestion, briefEdit, teamFilters, markDone, checkNow, newWorkspace, changeUrl];
