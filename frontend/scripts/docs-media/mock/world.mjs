/**
 * The Acme demo world for mocked-API docs shots (mock/shoot.mjs): every response the app asks for,
 * built in memory. No backend, no database: Playwright answers each request to the fake API origin.
 * Names are made up (Acme, Riya Sharma, Northwind Health…); keep it that way.
 */
/** A real-looking id: some pages (Ask) accept only 24-hex workspace ids. */
export const WS = "6a3c0ffee0acbe0000000001";
const NOW = Date.parse(process.env.MOCK_NOW || "2026-11-19T10:30:00Z");
const DAY = 86_400_000;
export const iso = (dAgo = 0, h = 0) => new Date(NOW - dAgo * DAY - h * 3600_000).toISOString();
export const ymd = (dFromNow = 0) => new Date(NOW + dFromNow * DAY).toISOString().slice(0, 10);
export { NOW };

export const people = {
  riya: { id: "u_riya", name: "Riya Sharma", email: "riya@acme.com", picture: null },
  alex: { id: "u_alex", name: "Alex Chen", email: "alex@acme.com", picture: null },
  sam: { id: "u_sam", name: "Sam Lee", email: "sam@acme.com", picture: null },
  maya: { id: "u_maya", name: "Maya Patel", email: "maya@acme.com", picture: null },
  priya: { id: "u_priya", name: "Priya Nair", email: "priya@acme.com", picture: null },
  diego: { id: "u_diego", name: "Diego Alvarez", email: "diego@acme.com", picture: null },
  hana: { id: "u_hana", name: "Hana Kim", email: "hana@acme.com", picture: null },
};
export const user = { id: "u_riya", email: "riya@acme.com", name: "Riya Sharma", display_name: "Riya Sharma", picture: null, providers: ["email"], created_at: iso(400), is_admin: false };

export const workspace = {
  id: WS, name: "Acme", owner_id: "u_riya", created_at: iso(300), updated_at: iso(1),
  branding: { site_name: "Acme", favicon_url: null, logo_url: null, accent_color: null, hide_markdrop_branding: false, logo_well: null },
  settings: { viewer_chrome: "full", require_auth_to_view: false, members_can_share_folders: true, default_access: "workspace" },
  default_access: "workspace", privacy: "team", role: "owner", primary_host: null, member_count: 7, pending_invite_count: 0, domain_count: 0, domains: [],
};

const team = (id, name, extra = {}) => ({
  id, name, slug: name.toLowerCase().replace(/\W+/g, "-"), icon: null, color: "blue", description: "", visibility: "open",
  member_count: 3, lead_ids: [], my_role: "member", can_read: true, can_manage: true, can_admin: true, project_ids: [], ...extra,
});
export const teams = {
  general: team("t_gen", "General", { general: true, slug: "general", member_count: 7, icon: "🏛️", color: "gray" }),
  sales: team("t_sales", "Sales", { icon: "💼", color: "green", visibility: "private", lead_ids: ["u_riya"], my_role: "lead", hubspot: true, linked: ["HubSpot", "Zoom", "Slack"], to_review: 2, deals: 12, description: "Pipeline, renewals and customer calls.", member_count: 4 }),
  marketing: team("t_mkt", "Marketing", { icon: "📣", color: "pink", description: "Campaigns, launches and the website.", lead_ids: ["u_maya"] }),
  eng: team("t_eng", "Engineering", { icon: "🛠️", color: "violet", description: "Product, platform and on-call.", lead_ids: ["u_sam"], member_count: 4 }),
};
export const teamsSidebar = {
  my_role: "owner", can_create: true,
  teams: [teams.general, teams.sales, teams.marketing, teams.eng],
  projects: [], browse: { open: 0, private: 0 }, suggested: [], review: null,
};
let _projectsAdded = false;

/* ── Meetings ── */
const A = (...names) => names.map((n) => ({ name: n, user_id: Object.values(people).find((x) => x.name === n)?.id ?? null }));
let mn = 0;
export const meeting = (title, dAgo, extra = {}) => {
  mn += 1;
  const slug = extra.slug || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" + mn;
  const attendees = extra.attendees || A("Riya Sharma", "Alex Chen");
  return {
    id: `m_${mn}`, workspace_id: WS, title, page_title: title, slug, transcript_slug: `${slug}-transcript`,
    date: ymd(-dAgo), time: extra.time || "10:00", duration_s: 1800, type: "meeting", attendees, attendee_count: attendees.length,
    restricted: false, action_items: 3, segments: 120, has_notes: true, has_transcript: true, created_at: iso(dAgo),
    can_delete: true, source: "zoom", history: false, series: null, summary: null, decisions: 2, open_questions: 1, cover: null,
    ai: { state: "done", message: null }, team_ids: ["t_sales"], teams: [{ id: "t_sales", name: "Sales", color: "green", icon: "💼" }],
    routing_state: "auto", deal: null, has_recording: true, ...extra, attendees,
  };
};
const northwind = { id: "9100037", name: "Platform expansion 2027", company: "Northwind Health", href: `/deals/${WS}/9100037` };
const globex = { id: "9100074", name: "Recruiting suite — 300 seats", company: "Globex Logistics", href: `/deals/${WS}/9100074` };
export const meetings = [
  meeting("Northwind — pricing and rollout plan", 0, { time: "15:00", duration_s: 2820, deal: northwind, attendees: A("Riya Sharma", "Alex Chen", "Maya Chen", "Jonas Weber"), series: null, summary: "Agreed on a phased rollout: three hospital sites in Q1, the clinic network in Q2. Budget sign-off moves to the new CFO.", action_items: 4 }),
  meeting("Weekly pipeline review", 1, { time: "09:30", duration_s: 2400, series: "Weekly pipeline review", attendees: A("Riya Sharma", "Alex Chen", "Hana Kim", "Priya Nair"), summary: "Two renewals at risk; Globex moves to Presentation scheduled. Hana owns the enterprise demo script.", source: "zoom" }),
  meeting("Globex — security review prep", 2, { time: "11:00", duration_s: 1980, deal: globex, attendees: A("Alex Chen", "Hana Kim", "Lena Fischer"), summary: "Their IT team needs the SOC 2 report and SSO through Okta before the pilot." }),
  meeting("Sales standup", 3, { time: "09:30", duration_s: 900, series: "Sales standup", has_recording: false, source: "auto", attendees: A("Riya Sharma", "Alex Chen", "Hana Kim") , summary: "Demo environment refresh is done; Alex follows up with Initech."}),
  meeting("Initech — discovery call", 4, { time: "16:00", duration_s: 2100, deal: { id: "9100111", name: "Pilot to annual", company: "Initech", href: `/deals/${WS}/9100111` }, attendees: A("Alex Chen", "Bill Lumbergh"), summary: "Initech runs 40 interviews a week; they want scorecards in their data warehouse." }),
  meeting("Weekly pipeline review", 8, { time: "09:30", duration_s: 2700, series: "Weekly pipeline review", attendees: A("Riya Sharma", "Alex Chen", "Hana Kim", "Priya Nair"), summary: "Q4 forecast holds at $1.2M; two deals slip to January." }),
  meeting("Umbrella Pharma — contract walkthrough", 9, { time: "14:00", duration_s: 3300, deal: { id: "9100148", name: "EMEA rollout", company: "Umbrella Pharma", href: `/deals/${WS}/9100148` }, attendees: A("Riya Sharma", "Priya Nair", "Ada Wong"), summary: "Legal accepts the DPA; they ask for a 60-day termination clause." }),
  meeting("Sales standup", 10, { time: "09:30", duration_s: 840, series: "Sales standup", has_recording: false, source: "auto", attendees: A("Riya Sharma", "Alex Chen", "Hana Kim"), summary: "Pricing page copy is ready for review." }),
];

/* ── Home ── */
const homeMeeting = (m) => ({ ...m, workspace_name: "Acme" });
export const home = {
  attention: {
    notifications: [
      { id: "n1", kind: "mention", read: false, created_at: iso(0, 1), actor: { id: "u_alex", name: "Alex Chen", picture: null }, via_ai: false, text: "Alex Chen mentioned you in Q4 pricing playbook", available: true, page: { slug: "q4-pricing-playbook", title: "Q4 pricing playbook" }, block: null, href: "/q4-pricing-playbook", excerpt: "@Riya Sharma can you confirm the two-year discount cap?", label: null, message: null },
    ],
    unread: 1,
    requests: [{ id: "r1", requester: { email: "dana@globex.com", name: "Dana Park" }, role_requested: "viewer", created_at: iso(0, 3), document: { slug: "globex-proposal", title: "Globex proposal 2027" } }],
    requests_count: 1,
  },
  actions: {
    items: [
      { text: "@Riya Sharma send Northwind the revised order form with 3-year pricing", slug: meetings[0].slug, block: "b1", title: meetings[0].title, url: `/${meetings[0].slug}`, workspace: { id: WS, name: "Acme" }, meeting: true, updated_at: iso(0, 2), date: ymd(0), can_tick: true },
      { text: "@Riya Sharma review the enterprise demo script before Thursday", slug: meetings[1].slug, block: "b2", title: meetings[1].title, url: `/${meetings[1].slug}`, workspace: { id: WS, name: "Acme" }, meeting: true, updated_at: iso(1), date: ymd(-1), can_tick: true },
    ],
    more: false,
  },
  meetings: { items: meetings.slice(0, 3).map(homeMeeting), today: ymd(0) },
  workspaces: [{ id: WS, name: "Acme", role: "owner", branding: workspace.branding, member_count: 7, item_count: 64, meetings: 38, can_import: true,
    people: [people.riya, people.alex, people.sam, people.maya].map((x) => ({ name: x.name, picture: null, is_you: x.id === "u_riya" })) }],
  meet: { connected: true, workspace_id: WS },
};
export const recent = [
  { slug: "q4-pricing-playbook", title: "Q4 pricing playbook", kind: "markdown", editor: "blocks", opened_at: iso(0, 1) },
  { slug: "northwind-proposal-2027", title: "Northwind proposal 2027", kind: "artifact", mime: "application/pdf", opened_at: iso(0, 2) },
  { slug: "enterprise-demo-script", title: "Enterprise demo script", kind: "markdown", editor: "blocks", opened_at: iso(1) },
];


/* ── Items (WorkspaceItem rows) ── */
export const item = (slug, title, extra = {}) => ({
  id: `d_${slug}`, slug, title, kind: "markdown", mime: null, editor: "blocks", url: `https://markdrop.in/${slug}`, markdrop_url: `https://markdrop.in/${slug}`,
  access: "workspace", has_password: false, folder: null, owner: { name: "Riya Sharma", is_you: true, picture: null },
  size_bytes: null, updated_at: iso(1), created_at: iso(20), views: 12, icon: null,
  can: { edit: true, move: true, unshare: true, delete: true, share: true }, type_label: null, original_filename: null, team_ids: ["t_sales"], ...extra,
});
const pdf = { kind: "artifact", mime: "application/pdf", editor: null, type_label: "PDF" };
export const salesItems = [
  item("q4-pricing-playbook", "Q4 pricing playbook", { icon: "📘", updated_at: iso(0, 2) }),
  item("northwind-proposal-2027", "Northwind proposal 2027", { ...pdf, original_filename: "northwind-proposal-2027.pdf", updated_at: iso(0, 5), owner: { name: "Alex Chen", is_you: false } }),
  item("enterprise-demo-script", "Enterprise demo script", { icon: "🎬", updated_at: iso(1), owner: { name: "Hana Kim", is_you: false } }),
  item("renewal-playbook", "Renewal playbook", { icon: "🔁", updated_at: iso(3) }),
  item("competitive-battlecards", "Competitive battlecards", { ...pdf, original_filename: "battlecards.pdf", updated_at: iso(4), owner: { name: "Priya Nair", is_you: false } }),
];
const P = (k) => people[k];
const member = (k, role = "member") => ({ ...P(k), role });
export const teamFull = (t, members) => ({ ...t, members, slack_channel: t.id === "t_sales" ? { id: "C1", name: "sales" } : null, slack_comments: true,
  meetings_by_attendees: true, jira_projects: [], digest: { enabled: true, email: true, slack: true }, admins_can_see: true, created_at: iso(60) });
const line = (id, kind, text, who, src) => ({ id, kind, text, person: P(who), edited: false, sources: [{ title: src, href: "/weekly-pipeline-review-2" }] });
export const salesHome = {
  team: teamFull(teams.sales, [member("riya", "lead"), member("alex"), member("hana"), member("priya")]),
  brief: { id: "b1", team_id: "t_sales", week: "2026-W47", label: "Week of Nov 16", published_at: iso(1), ai: true, can_edit: true, lines: [
    line("l1", "decision", "Two-year renewals get up to 15% off, no more.", "riya", "Weekly pipeline review"),
    line("l2", "update", "Northwind agreed to a phased rollout; the CFO signs in January.", "alex", "Northwind — pricing and rollout plan"),
    line("l3", "focus", "The enterprise demo script, before Thursday's Globex demo.", "hana", "Weekly pipeline review"),
    line("l4", "blocker", "Globex needs SSO through Okta before the pilot.", "alex", "Globex — security review prep"),
    line("l5", "shipped", "New battlecards for the three main competitors.", "priya", "Sales standup"),
  ] },
  recent: salesItems.slice(0, 3),
  meetings: meetings.slice(0, 4),
  memory: { highlights: [], people: [P("riya"), P("alex"), P("hana"), P("priya")].map((x) => ({ ...x, status: null })) },
  jira: { projects: [] }, projects: [], can_read: true,
  activity: { items: salesItems.slice(0, 4), meetings: meetings.slice(0, 2) },
  new_people: [],
};


/* ── Meetings status, Google Meet, Zoom ── */
export const meetStatus = { ai: { enabled: true, reason: null, message: null }, google: { configured: true, connected: true }, folder_id: "f_meet", can_import: true, can_organize: true, types: ["meeting", "standup", "1:1", "interview"] };
export const meetConnection = { connection: { id: "mc1", workspace_id: WS, workspace_name: "Acme", restricted: false, created_at: iso(40), connected_by: { id: "u_riya", name: "Riya Sharma" }, mine: true, last_received_at: iso(0, 1), last_imported_at: iso(0, 1), received: 41, imported: 38, attached: 2, duplicates: 1, ignored: 0, last_error: null }, others: [], endpoint: "https://api.markdrop.in/api/v1/meetings/ingest" };
export const series = { series: [{ name: "Weekly pipeline review", count: 12, last: ymd(-1) }, { name: "Sales standup", count: 31, last: ymd(-3) }], total: 8, one_offs: 4 };
export const zoomHeld = [
  { uuid: "zh1", workspace_id: WS, topic: "Pricing page review", date: ymd(0), time: "12:00", start_time: iso(0, 4), duration_min: 34, people: ["Riya Sharma", "Maya Patel", "Sam Lee"], people_count: 3, reason: "internal", why: "Everyone on the call is from Acme", held_at: iso(0, 3), expires_at: iso(-30), team: "Sales", team_id: "t_sales" },
  { uuid: "zh2", workspace_id: WS, topic: "Q1 territory planning", date: ymd(-1), time: "16:30", start_time: iso(1, 2), duration_min: 52, people: ["Riya Sharma", "Alex Chen", "Hana Kim", "Priya Nair"], people_count: 4, reason: "ask", why: "You asked to review your recorded meetings first", held_at: iso(1), expires_at: iso(-29), team: "Sales", team_id: "t_sales" },
];
export const zoomMe = { share: "ask", held: 2, teams: [{ workspace_id: WS, workspace: "Acme", team: "Sales" }] };
const zt = { id: "t_sales", name: "Sales", visibility: "private", slug: "sales" };
export const zoomStatus = {
  configured: true, can_manage: true, connected: true, can_import: true, app_available: true, mode: "oauth", webhook_url: null, scopes_needed: null, events: null,
  no_transcript_help: "Turn on Create audio transcript in Zoom's recording settings.", media_available: true, media_on: true,
  team: zt, teams: [zt, { id: "t_eng", name: "Engineering", visibility: "open", slug: "engineering" }, { id: "t_mkt", name: "Marketing", visibility: "open", slug: "marketing" }],
  connection: { connected_at: iso(30), last_event_at: iso(0, 1), last_import_at: iso(0, 1), last_sync_at: iso(0, 0.2), verified: true, broken: null,
    imported: 67, ignored: 4, no_transcript: 2, failed: 0, duplicates: 1, from_captions: 3, transcribed: 9, held: 2, skipped: 5,
    account_id: "acme-zoom", client_id: null, connected_by: "Riya Sharma", approved_by: "Sam Lee", missing_scopes: [], test_error: null, last_error: null },
  members: [{ id: "u_riya", name: "Riya Sharma", share: "ask" }, { id: "u_alex", name: "Alex Chen", share: "auto" }, { id: "u_hana", name: "Hana Kim", share: "auto" }, { id: "u_priya", name: "Priya Nair", share: "never" }],
  my_review: 2,
  recent: [
    { uuid: "z1", topic: "Northwind — pricing and rollout plan", date: ymd(0), state: "imported", reason: null, slug: meetings[0].slug, host: "Riya Sharma", via: "webhook", at: iso(0, 1), source: "transcript", recording: "stored" },
    { uuid: "z2", topic: "Pricing page review", date: ymd(0), state: "held", reason: "internal", slug: null, host: "Riya Sharma", via: "webhook", at: iso(0, 3), source: null, recording: null },
    { uuid: "z3", topic: "Globex — security review prep", date: ymd(-2), state: "imported", reason: null, slug: meetings[2].slug, host: "Alex Chen", via: "webhook", at: iso(2), source: "transcribe", recording: "stored" },
    { uuid: "z4", topic: "Personal — dentist reschedule", date: ymd(-3), state: "ignored", reason: "personal", slug: null, host: "Hana Kim", via: "webhook", at: iso(3), source: null, recording: null },
  ],
};


/* ── Deals ── */
const PL = "default";
const stages = [
  ["appointmentscheduled", "Appointment scheduled"], ["qualifiedtobuy", "Qualified to buy"], ["presentationscheduled", "Presentation scheduled"],
  ["decisionmakerboughtin", "Decision maker bought-in"], ["contractsent", "Contract sent"], ["negotiation", "Negotiation"],
].map(([id, label]) => ({ id, label, pipeline: "Sales pipeline", pipeline_id: PL, closed: false }))
  .concat([{ id: "closedwon", label: "Closed won", pipeline: "Sales pipeline", pipeline_id: PL, closed: true }, { id: "closedlost", label: "Closed lost", pipeline: "Sales pipeline", pipeline_id: PL, closed: true }]);
const stageLabel = Object.fromEntries(stages.map((s) => [s.id, s.label]));

let n = 0;
const deal = (company, name, stage, amount, owner, closeIn, calls, lastAgo, extra = {}) => {
  n += 1;
  const id = String(9100000 + n * 37);
  const quiet = calls === 0 || lastAgo >= 14;
  const closed = stage === "closedwon" || stage === "closedlost";
  return {
    id, name, company: company ? { id: `c${n}`, name: company } : null, title: company ? `${company} — ${name}` : name,
    stage_id: stage, stage: stageLabel[stage], pipeline: "Sales pipeline", pipeline_id: PL,
    closed, closed_label: stage === "closedwon" ? "Closed won" : stage === "closedlost" ? "Closed lost" : null,
    amount, currency: amount == null ? null : "USD", owner, owner_id: owner ? `o_${owner.split(" ")[0].toLowerCase()}` : null,
    close_date: closeIn == null ? null : ymd(closeIn), url: `https://app.hubspot.com/contacts/1234/deal/${id}`, folder_id: `f_deal_${n}`,
    calls, last_call: calls ? { date: ymd(-lastAgo), title: `${company ?? name} sync`, slug: `call-${n}` } : null,
    days_quiet: calls ? lastAgo : null, quiet: !closed && quiet, pick: 0, updated_at: iso(1), ...extra,
  };
};
export const deals = [
  deal("Northwind Health", "Platform expansion 2027", "decisionmakerboughtin", 184000, "Alex Chen", 24, 6, 2, { pick: 1 }),
  deal("Globex Logistics", "Recruiting suite — 300 seats", "presentationscheduled", 96000, "Hana Kim", 40, 3, 5),
  deal("Initech", "Pilot to annual", "qualifiedtobuy", 42000, "Alex Chen", 55, 2, 18),
  deal("Umbrella Pharma", "EMEA rollout", "contractsent", 255000, "Riya Sharma", 9, 8, 1),
  deal("Stark Industries", "AI screening add-on", "appointmentscheduled", 18500, "Hana Kim", 70, 0, null),
  deal("Wayne Enterprises", "Talent analytics", "presentationscheduled", 61000, "Priya Nair", 33, 4, 3),
  deal("Hooli", "Campus hiring season", "qualifiedtobuy", 27000, "Riya Sharma", 48, 1, 21),
  deal("Soylent Corp", "HRIS integration", "decisionmakerboughtin", 73500, "Priya Nair", 15, 5, 6),
  deal("Contoso", "Seat expansion Q1", "appointmentscheduled", 12000, "Alex Chen", 80, 1, 9),
  deal("Cyberdyne Systems", "Enterprise agreement", "contractsent", 140000, "Hana Kim", 12, 7, 4),
  deal("Tyrell Corp", "Assessment platform", "qualifiedtobuy", 38000, null, 62, 0, null),
  deal("Massive Dynamic", "Recruiter copilot", "presentationscheduled", 54000, "Priya Nair", 29, 2, 16),
  deal("Oscorp", "Renewal + upsell", "decisionmakerboughtin", 88000, "Riya Sharma", 19, 3, 11),
  deal("Wonka Foods", "Hourly hiring pilot", "qualifiedtobuy", 24000, "Hana Kim", 58, 1, 4),
  deal("Prestige Worldwide", "Agency seats", "qualifiedtobuy", 15500, "Alex Chen", 75, 0, null),
  deal("Gringotts", "Compliance training", "qualifiedtobuy", 33000, "Priya Nair", 66, 2, 7),
  deal(null, "Inbound — mid-market bundle", "appointmentscheduled", null, "Alex Chen", null, 0, null),
  deal("Vandelay Industries", "Import/export hiring", "closedwon", 66000, "Hana Kim", -6, 5, 8),
  deal("Pied Piper", "Compression team hiring", "closedlost", 31000, "Priya Nair", -12, 3, 20),
  deal("Bluth Company", "Seasonal staffing", "closedwon", 22000, "Riya Sharma", -2, 2, 3),
];
export const board = {
  team: { id: "t_sales", name: "Sales", slug: "sales" }, can_sync: true,
  sync: { at: iso(0, 0.2), state: "idle", last_error: null, deals: deals.length, next_at: iso(-0.05) },
  stages, pipelines: [{ id: PL, label: "Sales pipeline" }], deals, missing_scopes: [],
};

export const D0 = deals[0];
const sugg = (id, field, label, kind, display, current, why, quote, speaker) => ({
  id, field, label, kind, value: display, display, current, why, evidence: [{ ref: `e_${id}`, quote, speaker, at: "12:41", href: null }],
  state: "open", error: null, at: iso(2),
});
const call = (i, title, dAgo, extra = {}) => ({
  meeting_id: `m${i}`, title, date: ymd(-dAgo), slug: `northwind-call-${i}`, href: `/northwind-call-${i}`, how: "contacts", confidence: "high",
  logged: null, actions: 0, tasks_created: 0, suggestions_open: 0, ...extra,
});
const L = (text, dAgo, i) => ({ text, date: ymd(-dAgo), slug: `northwind-call-${i}` });
export const dealDetail = {
  deal: {
    ...D0,
    contacts: [
      { id: "ct1", name: "Maya Chen", title: "VP People Operations", email: "maya.chen@northwind.health", url: "https://app.hubspot.com/contacts/1234/contact/1" },
      { id: "ct2", name: "Jonas Weber", title: "Head of Talent Acquisition", email: "jonas.weber@northwind.health", url: "https://app.hubspot.com/contacts/1234/contact/2" },
      { id: "ct3", name: "Rita Alvarez", title: "Procurement lead", email: "r.alvarez@northwind.health", url: null },
    ],
  },
  overview: { slug: "northwind-deal-overview", href: "/northwind-deal-overview", updated_at: iso(1) },
  folder: { id: "f_deal_1", name: D0.title, href: `/w/${WS}/f/f_deal_1` },
  rollup: {
    decisions: [L("Start with the 3 hospital sites in Q1; the clinic network follows in Q2.", 2, 1), L("SSO through Okta is required before go-live.", 9, 3)],
    risks: [L("Budget sign-off moves to the new CFO, who joins in December.", 2, 1), L("Competing offer from Workday Recruiting at a lower per-seat price.", 9, 3)],
    questions: [L("Can interview scorecards be exported to their data warehouse nightly?", 2, 1)],
    next_steps: [L("Send the revised order form with 3-year pricing by Friday.", 2, 1), L("Security review call with their IT team.", 5, 2), L("Share two hospital-system references.", 9, 3)],
    last_call: { date: ymd(-2), title: "Northwind — pricing and rollout plan", slug: "northwind-call-1" },
  },
  calls: [
    call(1, "Northwind — pricing and rollout plan", 2, { actions: 4, suggestions_open: 2 }),
    call(2, "Security review prep with IT", 5, { actions: 2, logged: { at: iso(5) }, tasks_created: 2 }),
    call(3, "Executive demo for Maya Chen", 9, { actions: 3, logged: { at: iso(9) }, tasks_created: 1 }),
    call(4, "Discovery: talent acquisition workflow", 16, { actions: 1, logged: { at: iso(16) } }),
    call(5, "Intro call", 27, { how: "meeting", logged: { at: iso(27) } }),
  ],
  pick: [call(9, "Northwind clinics — hiring forecast", 3, { how: "names", confidence: "medium" })],
  suggestions: [{
    meeting_id: "m1", title: "Northwind — pricing and rollout plan", date: ymd(-2), slug: "northwind-call-1",
    items: [
      sugg("s1", "dealstage", "Stage", "stage", "Contract sent", "Decision maker bought-in", "They asked for the order form and agreed on terms.", "Send us the order form and we'll get it to legal this week.", "Maya Chen"),
      sugg("s2", "closedate", "Close date", "date", ymd(38), ymd(24), "The CFO sign-off moves the signature to January.", "Realistically we sign after the new CFO starts.", "Jonas Weber"),
    ],
  }],
  activity: {
    at: iso(0, 0.3), missing: [],
    items: [
      { kind: "email", id: "a1", at: iso(0, 3), title: "Re: Revised order form", preview: "Thanks Alex — looping in Rita from procurement. Can you confirm the 3-year discount applies to the clinic network too?", direction: "in", owner: "Alex Chen", url: "https://app.hubspot.com/x" },
      { kind: "task", id: "a2", at: iso(0, 5), title: "Send revised order form", preview: null, status: "Completed", owner: "Alex Chen", url: "https://app.hubspot.com/x" },
      { kind: "meeting", id: "a3", at: iso(2, 2), title: "Pricing and rollout plan", preview: "Agreed on phased rollout; CFO sign-off needed.", owner: "Alex Chen", url: "https://app.hubspot.com/x" },
      { kind: "note", id: "a4", at: iso(2, 1), title: "Call notes", preview: "Maya is the champion. Jonas worries about recruiter adoption; offer a 2-week enablement plan.", owner: "Alex Chen", url: "https://app.hubspot.com/x" },
      { kind: "email", id: "a5", at: iso(4, 6), title: "Security questionnaire", preview: "Attached is our completed SIG Lite questionnaire and the SOC 2 Type II report.", direction: "out", owner: "Hana Kim", url: "https://app.hubspot.com/x" },
      { kind: "call", id: "a6", at: iso(5, 4), title: "Call with Jonas Weber", preview: "Left a voicemail about the security review slot.", owner: "Alex Chen", url: null },
      { kind: "task", id: "a7", at: iso(9, 2), title: "Collect two hospital references", preview: null, status: "Not started", owner: "Alex Chen", url: "https://app.hubspot.com/x" },
      { kind: "meeting", id: "a8", at: iso(9, 5), title: "Executive demo", preview: null, owner: "Alex Chen", url: "https://app.hubspot.com/x" },
    ],
  },
  attachments: { items: [{ id: "at1", name: "Northwind_MSA_redlines.pdf", ext: "pdf", size: 482000, at: iso(3), url: "https://app.hubspot.com/x" }], missing: [] },
  can_sync: true, deals_write: "granted",
};

export const hubspotStatus = {
  switches: { auto_log: false, suggest: true, accounts: false, precall: true, approve: true }, deals_write: "granted",
  configured: true, can_manage: true, connected: true, mode: "token", scopes_needed: null,
  team: { id: "t_sales", name: "Sales", visibility: "private", slug: "sales" },
  teams: [{ id: "t_sales", name: "Sales", visibility: "private", slug: "sales" }, { id: "t_eng", name: "Engineering", visibility: "open", slug: "engineering" }],
  auto_log: false, can_use: true,
  connection: { portal_id: "4823156", connected_at: iso(20), broken: null, logged: 41, created: 6, tasks: 58, auto: 0, last_log_at: iso(0, 2), url: "https://app.hubspot.com/home?portalId=4823156",
    connected_by: "Riya Sharma", checked_at: iso(0, 1), missing_scopes: [], unchecked_scopes: [], scopes_from: "token_info", last_error: null },
};
export const hubspotMe = { teams: [{ workspace_id: WS, workspace: "Acme", team: "Sales", team_id: "t_sales" }], precall: true, approve: true };


/* ── Folders and the nav outline ── */
const folder = (id, name, parent = null, extra = {}) => ({ id, name, slug: name.toLowerCase().replace(/\W+/g, "-"), parent_id: parent, path: name, depth: parent ? 1 : 0,
  item_count: 3, total_count: 3, share: null, updated_at: iso(1), people: [], people_count: 2, team_ids: ["t_sales"], ...extra });
export const folders = [
  folder("f_play", "Playbooks"), folder("f_prop", "Proposals"), folder("f_enable", "Enablement"),
  folder("f_cust", "Customer decks", "f_prop"), folder("f_old", "2025 pipeline (archived)"),
  folder("f_handbook", "Handbook", null, { team_ids: [] }), folder("f_meet", "Meetings", null, { team_ids: [], meetings: true }),
];
const nav = (slug, title, kind, folder_id, extra = {}) => ({ slug, title, kind, folder_id, ...extra });
export const navItems = [
  nav("q4-pricing-playbook", "Q4 pricing playbook", "page", "f_play", { icon: "📘", has_children: true }),
  nav("renewal-playbook", "Renewal playbook", "page", "f_play", { icon: "🔁" }),
  nav("discovery-questions", "Discovery questions", "page", "f_play", { icon: "❓" }),
  nav("northwind-proposal-2027", "Northwind proposal 2027", "artifact", "f_prop", { renderer: "pdf", mime: "application/pdf", filename: "northwind-proposal-2027.pdf" }),
  nav("globex-proposal", "Globex proposal 2027", "artifact", "f_prop", { renderer: "pdf", mime: "application/pdf", filename: "globex-proposal.pdf" }),
  nav("pricing-calculator", "Pricing calculator", "artifact", "f_enable", { renderer: "html", mime: "text/html", filename: "pricing.html" }),
  nav("competitive-battlecards", "Competitive battlecards", "artifact", "f_enable", { renderer: "pdf", mime: "application/pdf", filename: "battlecards.pdf" }),
  nav("demo-walkthrough", "Demo walkthrough", "artifact", "f_enable", { renderer: "video", mime: "video/mp4", filename: "demo.mp4" }),
  nav("enterprise-demo-script", "Enterprise demo script", "page", null, { icon: "🎬" }),
  nav("sales-team-charter", "Sales team charter", "page", null, { icon: "🧭" }),
  nav("q4-forecast", "Q4 forecast", "artifact", null, { renderer: "sheet", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: "q4-forecast.xlsx" }),
];


export const generalHome = {
  ...salesHome,
  team: teamFull(teams.general, Object.keys(people).map((k, i) => member(k, i === 0 ? "lead" : "member"))),
  brief: { ...salesHome.brief, id: "bg", team_id: "t_gen", lines: [
    line("g1", "decision", "The office is closed 24–26 December; support runs a rota.", "riya", "All-hands"),
    line("g2", "shipped", "SSO for the enterprise workspace is live.", "sam", "Engineering standup"),
    line("g3", "update", "The Q4 launch campaign starts on 1 December.", "maya", "Marketing sync"),
  ] },
  recent: [item("expense-policy", "Expense policy", { icon: "💳", team_ids: [] }), item("company-holidays-2026", "Company holidays 2026", { icon: "🎄", team_ids: [] }), salesItems[1]],
  across: [
    { team: teams.sales, line: null },
    { team: teams.marketing, line: "The Q4 launch campaign starts on 1 December." },
    { team: teams.eng, line: "SSO for the enterprise workspace is live." },
  ],
};


/* ── Folder contents and card previews ── */
const inFolder = (fid, name) => ({ folder: { id: fid, name, path: name } });
export const folderItems = {
  f_play: [
    item("q4-pricing-playbook", "Q4 pricing playbook", { icon: "📘", updated_at: iso(0, 2), ...inFolder("f_play", "Playbooks") }),
    item("renewal-playbook", "Renewal playbook", { icon: "🔁", updated_at: iso(3), ...inFolder("f_play", "Playbooks") }),
    item("discovery-questions", "Discovery questions", { icon: "❓", updated_at: iso(6), owner: { name: "Hana Kim", is_you: false }, ...inFolder("f_play", "Playbooks") }),
  ],
};
const PREVIEW_TEXT = {
  "q4-pricing-playbook": [{ t: "h1", x: "Q4 pricing playbook" }, { t: "p", x: "How we price renewals, expansions and multi-year deals this quarter." }, { t: "h2", x: "Discounts" }, { t: "li", x: "Two-year renewals: up to 15% off" }, { t: "li", x: "Three-year: up to 20%, with CFO sign-off" }],
  "renewal-playbook": [{ t: "h1", x: "Renewal playbook" }, { t: "p", x: "Start every renewal 90 days out. The account owner runs it; CS joins the second call." }, { t: "h2", x: "90 days out" }, { t: "todo", x: "Usage review with the champion" }, { t: "todo", x: "Confirm the budget owner" }],
  "discovery-questions": [{ t: "h1", x: "Discovery questions" }, { t: "p", x: "Ask these on every first call, in this order." }, { t: "li", x: "How do you hire today, and what breaks?", n: 1 }, { t: "li", x: "Who signs, and when does the budget reset?", n: 2 }],
  "enterprise-demo-script": [{ t: "h1", x: "Enterprise demo script" }, { t: "p", x: "30 minutes: the story, the product, the proof." }, { t: "h2", x: "1. The story (5 min)" }, { t: "li", x: "Their hiring today, in their words" }],
};
export function previews(slugs) {
  const out = {};
  for (const sl of slugs || []) {
    if (PREVIEW_TEXT[sl]) out[sl] = { state: "ok", type: "page", blocks: PREVIEW_TEXT[sl] };
    else if (/proposal|battlecards/.test(sl)) out[sl] = { state: "ok", type: "pdf", pages: 12, blocks: [{ t: "h1", x: sl.includes("battle") ? "Competitive battlecards" : "Proposal 2027" }, { t: "p", x: "Prepared for the leadership team · November 2026" }] };
    else out[sl] = { state: "ok", type: "none" };
  }
  return out;
}


export const project = { id: "p_q4", name: "Q4 launch", slug: "q4-launch", icon: "🚀", color: "amber", description: "Everything for the 1 December launch: pricing, campaign and the release.",
  team_ids: ["t_sales", "t_mkt", "t_eng"], visibility: "open", status: "active", member_count: 6, my_role: "lead", can_read: true, can_manage: true };
export const projectHome = {
  project: { ...project, members: [P("riya"), P("maya"), P("sam"), P("alex"), P("diego"), P("hana")].map((x, i) => ({ ...x, role: i === 0 ? "lead" : "member" })),
    teams: [teams.sales, teams.marketing, teams.eng] },
  recent: [item("q4-launch-plan", "Q4 launch plan", { icon: "🚀", updated_at: iso(0, 3) }), item("launch-pricing-page", "Launch pricing page copy", { icon: "💬", updated_at: iso(1), owner: { name: "Maya Patel", is_you: false } }),
    item("release-checklist", "Release checklist 2.6", { icon: "✅", updated_at: iso(2), owner: { name: "Sam Lee", is_you: false } })],
  meetings: [meeting("Q4 launch sync", 1, { time: "11:00", series: "Q4 launch sync", attendees: A("Riya Sharma", "Maya Patel", "Sam Lee", "Diego Alvarez"), summary: "Pricing page copy is final; the release freezes on 26 November.", deal: null, team_ids: ["t_mkt"], teams: [{ id: "t_mkt", name: "Marketing", color: "pink", icon: "📣" }] })],
  memory: { highlights: [
    { text: "Pricing page copy is final; legal review on Monday.", kind: "update", person: P("maya"), source: { title: "Q4 launch sync", href: "/q4-launch-sync" } },
    { text: "Release 2.6 freezes on 26 November.", kind: "decision", person: P("sam"), source: { title: "Q4 launch sync", href: "/q4-launch-sync" } },
    { text: "Brief the top 20 customers before the 4 December webinar.", kind: "focus", person: P("riya"), source: { title: "Weekly pipeline review", href: "/weekly-pipeline-review-2" } },
  ], people: [P("riya"), P("maya"), P("sam")].map((x) => ({ ...x, status: null })) },
};


/* ── My files ── */
const mydoc = (slug, title, kind, extra = {}) => ({
  id: `md_${slug}`, slug, url: `https://markdrop.in/${slug}`, title, content_preview: "", created_at: iso(30), updated_at: iso(2), expires_at: null,
  views: 12, export_pdf_count: 0, copy_url_count: 3, is_password_protected: false, kind, editor: null, mime: null, renderer: null, type_label: null,
  size_bytes: null, original_filename: null, workspace_id: WS, folder_id: null, folder_path: [], access_level: "workspace", shared_with_count: 0, is_mine: true, ...extra,
});
export const myDocs = [
  mydoc("q4-pricing-playbook", "Q4 pricing playbook", "markdown", { editor: "blocks", updated_at: iso(0, 2), views: 48, folder_id: "f_play", folder_path: ["Playbooks"] }),
  mydoc("northwind-proposal-2027", "Northwind proposal 2027", "artifact", { mime: "application/pdf", renderer: "pdf", type_label: "PDF", size_bytes: 2_400_000, original_filename: "northwind-proposal-2027.pdf", views: 23, folder_id: "f_prop", folder_path: ["Proposals"], access_level: "link" }),
  mydoc("product-demo", "Product demo", "artifact", { mime: "video/mp4", renderer: "video", type_label: "Video", size_bytes: 48_000_000, original_filename: "product-demo.mp4", views: 131, updated_at: iso(3), access_level: "link" }),
  mydoc("q4-forecast", "Q4 forecast", "artifact", { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", renderer: "sheet", type_label: "Spreadsheet", size_bytes: 84_000, original_filename: "q4-forecast.xlsx", views: 17, updated_at: iso(4) }),
  mydoc("board-deck-q4", "Board deck Q4", "artifact", { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", renderer: "pptx", type_label: "PowerPoint", size_bytes: 6_100_000, original_filename: "board-deck-q4.pptx", views: 9, updated_at: iso(5), access_level: "private" }),
  mydoc("pricing-calculator", "Pricing calculator", "artifact", { mime: "text/html", renderer: "html", type_label: "HTML", size_bytes: 38_000, original_filename: "pricing.html", views: 64, folder_id: "f_enable", folder_path: ["Enablement"], updated_at: iso(6) }),
  mydoc("offsite-agenda", "Offsite agenda", "markdown", { views: 7, updated_at: iso(8), workspace_id: null, access_level: "link" }),
  mydoc("logo-refresh", "Logo refresh", "artifact", { mime: "image/png", renderer: "image", type_label: "Image", size_bytes: 420_000, original_filename: "logo-refresh.png", views: 5, updated_at: iso(9), workspace_id: null, access_level: "link" }),
];

const workspaces = [workspace];

/** Extra handlers per shot (set by shoot.mjs): [regex or string, fn(url, method, req) → body]. */
export const extra = [];

export function answer(u, method = "GET", req) {
  const p = u.pathname;
  for (const [m, fn] of extra) {
    const hit = typeof m === "string" ? p === m : m.exec(p);
    if (hit) { const r = fn(u, method, req, hit); if (r !== undefined) return r; }
  }
  if (method === "POST" && p === "/api/v1/beat") return {};
  if (p === "/api/v1/auth/me") return user;
  if (p === "/api/v1/workspaces") return { workspaces };
  if (p === `/api/v1/workspaces/${WS}`) return workspace;
  if (p === `/api/v1/workspaces/${WS}/teams`) return { ...teamsSidebar, projects: [project] };
  if (p === `/api/v1/workspaces/${WS}/tree`) return { workspace: { id: WS, name: "Acme", role: "owner", primary_host: null, default_access: "workspace" }, folders, unfiled_count: 0, root_exposure: null };
  if (p === `/api/v1/workspaces/${WS}/teams/t_sales` || p === `/api/v1/workspaces/${WS}/teams/sales`) return salesHome;
  if (p === `/api/v1/workspaces/${WS}/projects/p_q4` || p === `/api/v1/workspaces/${WS}/projects/q4-launch`) return projectHome;
  if (p === `/api/v1/workspaces/${WS}/projects`) return { projects: [project] };
  if (p === `/api/v1/workspaces/${WS}/teams/t_gen` || p === `/api/v1/workspaces/${WS}/teams/general`) return generalHome;
  if (p === `/api/v1/workspaces/${WS}/teams/t_sales/briefs`) return { briefs: [{ id: "b1", week: "2026-W47", label: "Week of Nov 16", published_at: iso(1), line_count: 5 }] };
  if (p === `/api/v1/workspaces/${WS}/items`) {
    const f = u.searchParams.get("folder") || u.searchParams.get("folder_id");
    return { items: f ? (folderItems[f] || []) : salesItems, next_cursor: null };
  }
  if (method === "POST" && (p === `/api/v1/workspaces/${WS}/items/previews` || p === "/api/v1/me/previews")) {
    let slugs = []; try { slugs = req.postDataJSON().slugs; } catch { /* none */ }
    return { previews: previews(slugs) };
  }
  if (p === "/api/v1/meetings/status") return meetStatus;
  if (p === "/api/v1/meetings/connection") return meetConnection;
  if (p === "/api/v1/meetings/backfill") return { jobs: [] };
  if (p === "/api/v1/meetings/series") return series;
  if (p === "/api/v1/zoom/review") return { meetings: zoomHeld, total: zoomHeld.length };
  if (p === "/api/v1/zoom/me") return zoomMe;
  if (p === "/api/v1/zoom/status") return zoomStatus;
  if (p === `/api/v1/workspaces/${WS}/members`) return { members: Object.values(people).map((x, i) => ({ user_id: x.id, ...x, role: i === 0 ? "owner" : "member", joined_at: iso(60) })), invites: [] };
  if (p === "/api/v1/hubspot/status") return hubspotStatus;
  if (p === "/api/v1/hubspot/me") return hubspotMe;
  if (p === "/api/v1/hubspot/deals/board") return board;
  { const dm = p.match(/^\/api\/v1\/hubspot\/deals\/([^/]+)$/); if (dm) return dm[1] === D0.id ? dealDetail : { ...dealDetail, deal: { ...(deals.find((d) => d.id === dm[1]) ?? D0), contacts: [] } }; }
  if (p === "/api/v1/meetings") return { meetings, next_cursor: null, total: meetings.length, hidden: [], folder_id: "f_meet" };
  if (p === `/api/v1/workspaces/${WS}/nav`) return { items: u.searchParams.get("space") === "team:t_sales" ? navItems : [], more: {} };
  if (p === "/api/v1/me/shared") return { items: [], next_cursor: null };
  if (p === "/api/v1/me/recent") return { items: recent };
  if (p === "/api/v1/home") return home;
  if (p === "/api/v1/me/documents") return { documents: myDocs, total: myDocs.length, page: 1, pages: 1, count_all: myDocs.length, count_markdown: 2, count_artifact: 6,
    count_by_type: { document: 2, pdf: 1, video: 1, image: 1, sheet: 1, slides: 1, html: 1 } };
  if (p === "/api/v1/google/status") return { connected: false, configured: true };
  if (p === "/api/v1/ask/home") return { status: { enabled: true, reason: null, message: null }, suggestions: [], recent: [] };
  if (p === "/api/v1/notifications/unread-count") return { unread_count: 1 };
  if (p === `/api/v1/workspaces/${WS}/favorites`) return { favorites: [{ kind: "doc", ref: "d_playbook", title: "Q4 pricing playbook", href: "/q4-pricing-playbook", icon: "📘", doc_kind: "page", editor: "blocks" }, { kind: "team", ref: "t_sales", title: "Sales", href: `/w/${WS}/teams/sales`, icon: "💼", color: "green" }] };
  if (p.startsWith("/api/v1/notifications")) return { items: [], unread: 0, notifications: [] };
  return undefined;
}
