/**
 * Docs clips added 2026-11-19 (record.mjs; format in clips.mjs): HubSpot deals, Zoom review, naming speakers,
 * setting up a team, folder sharing and moving, sign-off, sub-pages, export, Jira from a page, branding.
 * Pages (the block editor) read their documents from world.pages; run mock/ssr-stub.mjs on the API port so
 * the server render of /<slug> gets "sign in" and the browser reads through these mocks.
 */
import { readFileSync } from "node:fs";
import * as W from "./world.mjs";

const { WS, people, iso, ymd } = W;
const rail = (open = [], generalOpen = false) => ({
  md_rail_tree: JSON.stringify([...open.map((t) => `ws:${WS}:team:${t}`), ...(generalOpen ? [] : [`ws:${WS}:team:t_gen!closed`])]),
});
const body = (req) => { try { return req.postDataJSON() || {}; } catch { return {}; } };
const text = (t) => async (h) => { await h.page.getByText(t, { exact: false }).first().waitFor({ timeout: 60_000 }); };

/* ── Integrations › HubSpot: Deals board → a deal → its calls ── */
const dealTour = {
  id: "hs-deal-tour", page: "/integrations/hubspot", name: "deal-tour", url: `/deals/${WS}?space=team:t_sales`,
  viewport: { width: 1440, height: 900 }, storage: rail(["t_sales"]), tail: 600, cursor: [900, 300],
  prepare: async (h) => { await h.loc("[data-testid='deals-board']").waitFor({ timeout: 60_000 }); await h.settle(800); await h.page.mouse.move(900, 300); },
  steps: async (h) => {
    await h.sleep(400);
    const card = h.page.locator("[data-testid='deal-card']", { hasText: "Northwind Health" }).first();
    await h.hover(card, 300);
    await h.click(card);
    await h.loc("[data-testid='deal-page']").waitFor({ timeout: 30_000 });
    await text("Across all calls")(h);
    await h.move([1000, 520]);
    await h.sleep(1800);
    await h.click(h.page.getByRole("tab", { name: /Calls/ }));
    await h.loc("[data-testid='deal-calls']").waitFor({ timeout: 20_000 });
    await h.move([1000, 560]);
    await h.sleep(900);
  },
};

/* ── Integrations › HubSpot: Pick the deal (File here) ── */
const filed = { on: false };
const pickDetail = () => {
  const d = W.dealDetail;
  if (!filed.on) return d;
  const moved = { ...d.pick[0], how: "picked", confidence: "high", actions: 2 };
  return { ...d, pick: [], calls: [moved, ...d.calls].sort((a, b) => b.date.localeCompare(a.date)) };
};
const filePick = {
  id: "hs-file-here", page: "/integrations/hubspot", name: "file-here", url: `/deals/${WS}/${W.D0.id}?tab=calls`,
  viewport: { width: 1440, height: 860 }, storage: rail(["t_sales"]), tail: 900, cursor: [1000, 420],
  handlers: [
    [`/api/v1/hubspot/deals/${W.D0.id}`, () => pickDetail()],
    [/^\/api\/v1\/hubspot\/meetings\/([\w-]+)\/match$/, (u, m) => { if (m !== "PUT") return undefined; filed.on = true; return { __delay: 700, body: { deal: { id: W.D0.id } } }; }],
  ],
  prepare: async (h) => { filed.on = false; await h.loc("[data-testid='deal-file-here']").waitFor({ timeout: 60_000 }); await h.settle(800); await h.page.mouse.move(1000, 420); },
  steps: async (h) => {
    await h.sleep(800);
    const row = h.page.locator("[data-testid='deal-pick'] li").first();
    await h.move(row);
    await h.sleep(900);
    await h.click("[data-testid='deal-file-here']");
    await h.page.locator("[data-testid='deal-file-here']").waitFor({ state: "detached", timeout: 20_000 });
    await h.move([1000, 520]);
    await h.sleep(2200);
  },
};

/* ── Integrations › Zoom: a held meeting → Share with Sales → it's in the team's meetings ── */
const zoomShared = { on: false };
const territory = W.meeting("Q1 territory planning", 1, { time: "16:30", duration_s: 3120, attendees: [
  { name: "Riya Sharma", user_id: "u_riya" }, { name: "Alex Chen", user_id: "u_alex" }, { name: "Hana Kim", user_id: "u_hana" }, { name: "Priya Nair", user_id: "u_priya" }],
  summary: "New territories from January: Alex takes healthcare, Hana logistics; Priya keeps the enterprise accounts.", source: "zoom", deal: null });
const zoomShare = {
  id: "zoom-share", page: "/integrations/zoom", name: "share-held", url: `/meetings/${WS}?space=all&tab=review`,
  viewport: { width: 1440, height: 860 }, storage: rail([]), tail: 900, cursor: [900, 360],
  handlers: [
    ["/api/v1/zoom/review", (u, m) => {
      if (m === "POST") { zoomShared.on = true; return { __delay: 600, body: { status: "ok", decision: "share" } }; }
      const left = zoomShared.on ? W.zoomHeld.filter((x) => x.uuid !== "zh2") : W.zoomHeld;
      return { meetings: left, total: left.length };
    }],
    ["/api/v1/zoom/me", () => ({ ...W.zoomMe, held: zoomShared.on ? 1 : 2 })],
    ["/api/v1/meetings", () => {
      const list = zoomShared.on ? [W.meetings[0], territory, ...W.meetings.slice(1)] : W.meetings;
      return { meetings: list, next_cursor: null, total: list.length, hidden: [], folder_id: "f_meet" };
    }],
  ],
  prepare: async (h) => { zoomShared.on = false; await text("Keep it just for me")(h); await h.settle(800); await h.page.mouse.move(900, 360); },
  steps: async (h) => {
    await h.sleep(800);
    const row = h.page.locator("[data-testid='zoom-review-row']", { hasText: "Q1 territory planning" }).first();
    await h.move(row);
    await h.sleep(700);
    await h.click(row.locator("[data-testid='zoom-review-share']"));
    await row.getByRole("status").waitFor({ timeout: 20_000 });
    await h.sleep(900);
    await h.click(h.page.getByRole("tab", { name: /^All/ }));
    await text("New territories from January")(h);
    await h.move(h.page.getByText("Q1 territory planning").first());
    await h.sleep(1100);
  },
};


/* ── Meetings: name a "Speaker N" on a transcript; the transcript then says who it was ── */
const SEG = [
  [12, "Riya Sharma", "Let's get through the territories first, then the January targets."],
  [31, "Speaker 2", "Healthcare is the biggest chunk. Northwind alone is three hospital sites in Q1."],
  [48, "Alex Chen", "I'm happy to take healthcare. I already know the Northwind people."],
  [66, "Speaker 2", "Then I'll take logistics. Globex and Wonka are both there, and I ran their demos."],
  [85, "Speaker 3", "And I keep the enterprise accounts, same as this year?"],
  [97, "Riya Sharma", "Yes. Priya keeps enterprise. Targets next."],
  [118, "Speaker 2", "For logistics I'd say two new logos in Q1 is realistic."],
];
const spk = { names: {} };
const said = (label) => spk.names[label] || label;
const clock = (t) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
const transcriptMd = () => SEG.map(([t, who, line], i) => `**${clock(t)} · ${said(who)}** ${line} {#b-t${String(i + 1).padStart(4, "0")}}`).join("\n\n");
const unnamed = () => ["Speaker 2", "Speaker 3"].filter((l) => !spk.names[l]).length;
const terrMeeting = () => ({
  ...W.meeting("Q1 territory planning", 1, { slug: "q1-territory-planning", time: "16:30", duration_s: 3120, deal: null,
    attendees: [{ name: "Riya Sharma", user_id: "u_riya" }, { name: "Alex Chen", user_id: "u_alex" }, { name: "Hana Kim", user_id: "u_hana" }, { name: "Priya Nair", user_id: "u_priya" }] }),
  id: "m_terr", transcript_slug: "q1-territory-planning-transcript", can_regenerate: true, has_transcript: true, recording: null, has_recording: false,
  unnamed_speakers: unnamed(), speakers_dismissed: false, ai: { state: "done", message: null }, created_by: "u_riya", can_manage: true, invited: [],
  sources: [{ name: "Zoom audio", kind: "zoom", format: "transcribed", segments: 7, speakers: ["Riya Sharma", "Alex Chen", "Speaker 2", "Speaker 3"] }],
});
const speakerRow = (label, lines, talk, samples, guess = null) => ({ label, generic: !spk.names[label] && /^Speaker/.test(label), lines, talk_s: talk,
  samples: samples.map(([t, x], i) => ({ n: i + 1, t, text: x })), guess });
const speakersData = () => ({
  speakers: [
    speakerRow(said("Speaker 2"), 3, 412, [[31, SEG[1][2]], [66, SEG[3][2]]], spk.names["Speaker 2"] ? null : "Hana Kim"),
    speakerRow(said("Speaker 3"), 1, 96, [[85, SEG[4][2]]]),
    speakerRow("Riya Sharma", 2, 640, [[12, SEG[0][2]]]), speakerRow("Alex Chen", 1, 380, [[48, SEG[2][2]]]),
  ],
  unnamed: unnamed(), attendees: terrMeeting().attendees, renames: Object.entries(spk.names).map(([from, to]) => ({ from, to, by: "Riya Sharma", at: iso(0, 0) })),
});
const nameSpeaker = {
  id: "name-speaker", page: "/workspaces/meetings", name: "name-speaker", url: "/q1-territory-planning-transcript",
  viewport: { width: 1280, height: 800 }, storage: rail([]), tail: 600, cursor: [900, 260],
  handlers: [
    ["/api/v1/documents/q1-territory-planning-transcript", (u, m) => (m !== "GET" ? undefined : W.pageDoc("q1-territory-planning-transcript", "Q1 territory planning — transcript", transcriptMd(), {
      meeting: { id: "m_terr", role: "transcript", has_recording: false }, folder_path: ["meetings"], props: { icon: "📝" } }))],
    ["/api/v1/meetings/m_terr", () => terrMeeting()],
    ["/api/v1/meetings/m_terr/speakers", (u, m, req) => {
      if (m === "POST") {
        const b = body(req);
        const to = b.user_id ? Object.values(people).find((x) => x.id === b.user_id)?.name : b.to;
        spk.names[b.from] = to;
        return { __delay: 600, body: { renamed: { from: b.from, to, lines: 3, transcript: "rewritten", unnamed: unnamed() }, meeting: terrMeeting() } };
      }
      return speakersData();
    }],
  ],
  prepare: async (h) => { spk.names = {}; await h.loc("[data-testid='meeting-speakers-banner']").waitFor({ timeout: 60_000 }); await h.settle(800); await h.page.mouse.move(900, 260); },
  steps: async (h) => {
    await h.sleep(800);
    await h.click("[data-testid='meeting-speakers-name']");
    await h.loc("[data-testid='meeting-speaker']").first().waitFor({ timeout: 20_000 });
    await h.sleep(1200);
    const row = h.page.locator("[data-testid='meeting-speaker']", { hasText: "Speaker 2" }).first();
    await h.click(row.getByRole("button").first());
    await h.loc("[data-testid='meeting-speaker-picker']").waitFor();
    await h.sleep(500);
    await h.type({ label: "Who is it?" }, "Hana", { speed: 1.6 });
    await h.sleep(500);
    await h.click(h.page.locator("[data-testid='meeting-speaker-picker'] button", { hasText: "Hana Kim" }).first());
    await text("Speaker 2 is Hana Kim now")(h);
    await h.sleep(1400);
    await h.press("Escape", 300);
    h.live({ type: "changed", rev: 8 });
    await text("1:06 · Hana Kim")(h);
    await h.move(h.page.getByText("1:06 · Hana Kim").first());
    await h.sleep(900);
  },
};

/* ── Pages › Sign-off: the person asked signs off ── */
const sign = { option: null };
const SIGN_ID = "b-rel26a";
const releasePage = () => W.pageDoc("release-2-6-plan", "Release 2.6 plan", [
  "Release 2.6 ships SSO for the enterprise workspace and the new pricing page.",
  "",
  "## Scope",
  "",
  "- SSO through Okta and Google Workspace",
  "- The new pricing page, with the two-year renewal discount",
  "- Faster search in big workspaces",
  "",
  "## Rollout",
  "",
  "Our own team first on 26 November, then everyone on 1 December.",
  "",
  `:::signoff{#${SIGN_ID} person="u_riya" label="Release approval" options="Approved for production|Needs changes" lock=above}`,
  "Sales has checked the pricing page copy and the discount rules.",
  ":::",
].join("\n"), { owner: { name: "Sam Lee" }, is_owner: false, is_owned: false, props: { icon: "🚀" }, folder_path: ["engineering"] });
const signState = () => ({
  block: SIGN_ID, label: "Release approval", options: ["Approved for production", "Needs changes"], lock: "above",
  person: { id: "u_riya", name: "Riya Sharma", picture: null }, option: sign.option, tone: sign.option ? "success" : null,
  signed_at: sign.option ? iso(0, 0) : null, signed_by: sign.option ? { id: "u_riya", name: "Riya Sharma", picture: null } : null,
  can_sign: true, can_remove: false, history: sign.option ? [{ action: "signed", option: sign.option, was: null, by: "Riya Sharma", at: iso(0, 0) }] : [],
  comments: { open_now: 1, record: sign.option ? { open: 1, resolved: 2, resolved_threads: [], open_threads: [{ id: "c1", excerpt: "Should the release notes mention the new discount cap?" }] } : null },
});
const signOff = {
  id: "sign-off", page: "/pages/sign-off", name: "sign-off", url: "/release-2-6-plan",
  viewport: { width: 1280, height: 800 }, storage: rail([]), tail: 1100, cursor: [900, 300],
  handlers: [
    ["/api/v1/documents/release-2-6-plan", (u, m) => (m === "GET" ? releasePage() : undefined)],
    ["/api/v1/documents/release-2-6-plan/signoffs", () => ({ signoffs: [signState()] })],
    [`/api/v1/documents/release-2-6-plan/signoffs/${SIGN_ID}`, (u, m, req) => { if (m === "GET") return signState(); sign.option = body(req).option ?? null; return { __delay: 500, body: signState() }; }],
  ],
  prepare: async (h) => { sign.option = null; await text("Waiting for you")(h); await h.settle(900); await h.page.mouse.move(900, 300); },
  steps: async (h) => {
    await h.sleep(700);
    await h.click(h.page.locator(".pb-signoff-pill").first());
    await h.sleep(1300);
    await h.click(h.page.getByRole("button", { name: "Approved for production" }).last());
    await text("still open on this page")(h);
    await h.sleep(1500);
    await h.click(h.page.getByRole("button", { name: /Sign off anyway/ }));
    await h.page.locator(".pb-signoff-pill--success").first().waitFor({ timeout: 20_000 });
    await h.move([1000, 560]);
    await h.sleep(2200);
  },
};

/* ── Pages › Export: ⋯ › Export… › Word › Download ── */
const exportPage = {
  id: "page-export", page: "/pages/export", name: "export-word", url: "/q4-pricing-playbook",
  viewport: { width: 1280, height: 800 }, storage: rail([]), tail: 900, cursor: [900, 300],
  handlers: [
    ["/api/v1/documents/q4-pricing-playbook/export", () => ({ __delay: 900, body: { __raw: "PK fake docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } })],
  ],
  prepare: async (h) => { await text("Two-year renewals")(h); await h.settle(800); await h.page.mouse.move(900, 300); },
  steps: async (h) => {
    await h.sleep(700);
    await h.click(h.page.getByRole("button", { name: /^(More actions|Page options)$/ }).filter({ visible: true }).first());
    await h.sleep(600);
    await h.click({ role: "menuitem", name: /Export…/ });
    await h.loc(".pbx-formats").waitFor({ timeout: 20_000 });
    await h.sleep(900);
    await h.click(h.page.locator(".pbx-card[data-format='word']"));
    await h.sleep(1000);
    await h.click(h.page.getByRole("button", { name: "Download .docx" }));
    await text("Exported")(h);
    await h.move([900, 420]);
    await h.sleep(1600);
  },
};

/* ── Pages › Sub-pages: Add a sub-page → template → the new page, under its parent ── */
const sub = { made: null };
const subDoc = (title = null, content = "") => W.pageDoc("discount-approvals", title, content, {
  parent: { slug: "q4-pricing-playbook", title: "Q4 pricing playbook" }, breadcrumbs: [{ slug: "q4-pricing-playbook", title: "Q4 pricing playbook" }],
  page_path: ["q4-pricing-playbook"], access_inherit: true, rev: 1 });
const subPage = {
  id: "page-subpage", page: "/pages/sub-pages", name: "add-subpage", url: "/q4-pricing-playbook",
  viewport: { width: 1280, height: 800 }, storage: rail([]), tail: 500, cursor: [900, 300],
  handlers: [
    ["/api/v1/page-templates", () => [
      { id: "blank", name: "Blank page", description: "Start from nothing.", icon: "📄", category: "Basics", content: "" },
      { id: "decision", name: "Decision record", description: "What we decided, why, and who signed off.", icon: "⚖️", category: "Team", content: "## Context\n\n## Decision\n\n## Consequences\n" },
      { id: "meeting", name: "Meeting notes", description: "Agenda, notes and action items.", icon: "🗓️", category: "Team", content: "## Agenda\n\n## Notes\n\n## Action items\n\n- [ ] \n" },
    ]],
    ["/api/v1/pages", (u, m, req) => {
      if (m !== "POST") return undefined;
      const b = body(req);
      sub.made = subDoc(b.title || null, b.template === "decision" ? "## Context\n\n## Decision\n\n## Consequences\n" : "");
      return { __delay: 500, body: { document: sub.made } };
    }],
    ["/api/v1/documents/discount-approvals", (u, m, req) => {
      if (m === "GET") return sub.made || subDoc();
      const b = body(req);
      sub.made = { ...(sub.made || subDoc()), ...(b.title !== undefined ? { title: b.title } : {}), ...(b.content !== undefined ? { content: b.content } : {}), rev: (sub.made?.rev || 1) + 1 };
      return sub.made;
    }],
    ["/api/v1/documents/discount-approvals/lock", (u, m) => (m === "POST" ? { holder: { name: "Riya Sharma" }, mine: true, rev: 1, expires_at: iso(-0.01) } : { holder: { name: "Riya Sharma" }, mine: true, rev: 1 })],
    ["/api/v1/documents/q4-pricing-playbook/children", () => (sub.made ? [{ slug: "discount-approvals", title: sub.made.title, editor: "blocks", updated_at: iso(0, 0), has_children: false, access_inherit: true }] : [])],
  ],
  prepare: async (h) => { sub.made = null; await text("Pages inside")(h); await h.settle(800); await h.page.mouse.move(900, 300); },
  steps: async (h) => {
    await h.sleep(600);
    await h.click(h.page.getByRole("button", { name: "Add a sub-page" }).first());
    await h.sleep(900);
    await h.type(h.page.getByRole("dialog").getByLabel("Title"), "Discount approvals", { speed: 2.4 });
    await h.sleep(400);
    await h.click(h.page.getByRole("dialog").getByText("Decision record").first());
    await h.sleep(1000);
    await h.click(h.page.getByRole("button", { name: /Create page/ }));
    await h.page.waitForURL(/discount-approvals/, { timeout: 20_000 });
    await h.sleep(700);
    await h.move([160, 150]);
    await h.sleep(900);
  },
};

/* ── Integrations › Jira: + Jira on a meeting's action item → the drafted issue → its chip ── */
const jr = { made: false };
const ITEM = "Hana to send Globex the SSO setup guide for Okta by Friday";
const globexMd = [
  "Their IT team needs the SOC 2 report and SSO through Okta before the pilot starts.",
  "",
  "## Decisions",
  "",
  "- The pilot starts once SSO works in their staging tenant {#b-gd0001}",
  "",
  "## Action items",
  "",
  `- [ ] ${ITEM} {#b-ga0001}`,
  "- [ ] Alex to share the SOC 2 Type II report under NDA {#b-ga0002}",
  "- [ ] Riya to confirm the pilot dates with Lena {#b-ga0003}",
  "",
  "## Open questions",
  "",
  "- Do they need SCIM provisioning for the pilot, or only SSO? {#b-gq0001}",
].join("\n");
const jiraIssue = { key: "SEC-42", summary: "Send Globex the Okta SSO setup guide", status: { name: "To Do", category: "new" },
  assignee: { account_id: "a_hana", name: "Hana Kim" }, due: ymd(2), priority: "High", project: { key: "SEC", name: "Security" }, type: "Task",
  url: "https://acme.atlassian.net/browse/SEC-42", blocked: false, updated: iso(0, 0), resolved: null, labels: ["globex", "sso"] };
const jiraCreateClip = {
  id: "jira-create", page: "/integrations/jira", name: "create-from-item", url: "/globex-security-review-prep",
  viewport: { width: 1280, height: 800 }, storage: rail([]), tail: 1000, cursor: [900, 300],
  handlers: [
    ["/api/v1/documents/globex-security-review-prep", (u, m) => (m === "GET" ? W.pageDoc("globex-security-review-prep", "Globex — security review prep", globexMd, {
      meeting: { id: "m_globex", role: "summary", has_recording: false }, folder_path: ["meetings"], props: { icon: "🔐" } }) : undefined)],
    ["/api/v1/meetings/m_globex", () => ({ ...W.meetings[2], id: "m_globex", can_regenerate: true, can_manage: true, created_by: "u_alex", invited: [], sources: [], deal: null, recording: null, has_recording: false, unnamed_speakers: 0 })],
    ["/api/v1/jira/page", () => ({ configured: true, site: { name: "acme", url: "https://acme.atlassian.net" }, connected: true, can_create: true, can_edit: true,
      links: jr.made ? { "b-ga0001": { id: "jl1", key: "SEC-42", block: "b-ga0001", fact_id: null, kind: "action", url: jiraIssue.url, issue: jiraIssue, sync: { state: "ok", message: null } } } : {} })],
    ["/api/v1/jira/draft", (u, m) => (m !== "POST" ? undefined : { __delay: 150, body: {
      source: { slug: "globex-security-review-prep", block: "b-ga0001", offset: null, fact_id: null, kind: "action", kind_label: "Action item", text: ITEM,
        title: "Globex — security review prep", url: "https://markdrop.in/globex-security-review-prep", restricted: false,
        meeting: { id: "m_globex", title: "Globex — security review prep", date: ymd(-2), date_label: "Nov 17, 2026" }, moment: { clock: "14:05", url: "https://markdrop.in/globex-security-review-prep-transcript#t=845" } },
      draft: { project: "SEC", issue_type: "Task", summary: "Send Globex the Okta SSO setup guide", description: "Globex's IT team needs SSO through Okta working in their staging tenant before the pilot starts. Send them our Okta setup guide.",
        priority: "High", assignee: { user_id: "u_hana", name: "Hana Kim", account_id: "a_hana" }, due: ymd(2), labels: ["globex", "sso"] },
      ai: true, note: null, notice: null,
      meta: { projects: [{ key: "SEC", name: "Security" }, { key: "WEB", name: "Website" }, { key: "PAY", name: "Payments" }],
        issue_types: [{ id: "Task", name: "Task" }, { id: "Bug", name: "Bug" }, { id: "Story", name: "Story" }],
        priorities: [{ id: "Highest", name: "Highest" }, { id: "High", name: "High" }, { id: "Medium", name: "Medium" }, { id: "Low", name: "Low" }],
        people: [{ user_id: "u_hana", name: "Hana Kim", account_id: "a_hana" }, { user_id: "u_alex", name: "Alex Chen", account_id: "a_alex" }, { user_id: "u_riya", name: "Riya Sharma", account_id: "a_riya" }],
        site: { name: "acme", url: "https://acme.atlassian.net" }, backlink: "From Globex — security review prep · Nov 17, 2026 at 14:05" },
    } })],
    ["/api/v1/jira/issues", (u, m) => { if (m !== "POST") return undefined; jr.made = true; return { __delay: 900, body: { key: "SEC-42", url: jiraIssue.url, issue: jiraIssue, link: { id: "jl1" } } }; }],
    ["/api/v1/jira/issue-types", () => ({ issue_types: [{ id: "Task", name: "Task" }, { id: "Bug", name: "Bug" }, { id: "Story", name: "Story" }] })],
  ],
  prepare: async (h) => { jr.made = false; await h.loc("[data-testid='jira-add']").first().waitFor({ timeout: 60_000 }); await h.settle(800); await h.page.mouse.move(900, 300); },
  steps: async (h) => {
    await h.sleep(600);
    const li = h.page.locator("li", { hasText: "SSO setup guide" }).first();
    await h.hover(li, 700);
    await h.click(li.locator("[data-testid='jira-add']"));
    await h.loc("[data-testid='jira-summary']").waitFor({ timeout: 20_000 });
    await h.move([700, 420]);
    await h.sleep(2600);
    await h.click("[data-testid='jira-create']");
    await text("SEC-42")(h);
    await h.move(h.page.getByText("SEC-42").first());
    await h.sleep(2000);
  },
};

/* ── Workspaces › Folder access: Who can access… › add a person and a team › Save ── */
const fa = { people: [], teams: [] };
const folderAccess = () => ({
  workspace_id: WS, folder_id: "f_play", name: "Playbooks", path: "playbooks/", restricted: false, restricted_here: false, restricted_by: null,
  people: [{ email: "riya@acme.com", name: "Riya Sharma", role: "editor", inherited_from: null, has_account: true },
    ...fa.people.map((x) => ({ email: x.email, name: Object.values(people).find((y) => y.email === x.email)?.name ?? null, role: x.role, inherited_from: null, has_account: true }))],
  teams: [{ id: "t_sales", name: "Sales", role: "editor", members: 4, exists: true, inherited_from: null },
    ...fa.teams.filter((t) => t.team_id !== "t_sales").map((t) => ({ id: t.team_id, name: W.teams.marketing.name, role: t.role, members: 3, exists: true, inherited_from: null }))],
  default_access: null, effective_default_access: "workspace", summary: "Everyone in Acme can open what's in it; Sales can edit.",
  can_manage: true, team_options: [{ id: "t_mkt", name: "Marketing", members: 3, visibility: "open" }, { id: "t_eng", name: "Engineering", members: 4, visibility: "open" }],
  job: null, log: [{ at: iso(6), by: "Riya Sharma", text: "Created the folder" }],
});
const folderShare = {
  id: "folder-share", page: "/workspaces/folder-access", name: "share-folder", url: `/w/${WS}/f/f_play`,
  viewport: { width: 1280, height: 800 }, storage: rail(["t_sales"]), tail: 500, cursor: [900, 300],
  handlers: [
    [`/api/v1/workspaces/${WS}/folders/f_play/access`, (u, m, req) => {
      if (m === "PUT") {
        const b = body(req);
        fa.people = (b.people || []).filter((x) => x.email !== "riya@acme.com");
        fa.teams = b.teams || [];
        return { __delay: 600, body: { ...folderAccess(), notified: Object.fromEntries(fa.people.map((x) => [x.email, true])) } };
      }
      return folderAccess();
    }],
  ],
  prepare: async (h) => { fa.people = []; fa.teams = []; await text("Discovery questions")(h); await h.settle(800); await h.page.mouse.move(900, 300); },
  steps: async (h) => {
    await h.sleep(600);
    await h.click(h.page.getByRole("button", { name: "More folder actions" }).first());
    await h.sleep(500);
    await h.click({ role: "menuitem", name: /Who can access/ });
    await h.loc("[data-testid='folder-access']").waitFor({ timeout: 20_000 });
    await h.sleep(600);
    await h.type("[data-testid='folder-access-email']", "maya@acme.com", { speed: 2 });
    await h.sleep(300);
    await h.page.locator("section[aria-label='People'] form").getByLabel("Role").selectOption("editor");
    await h.sleep(400);
    await h.click(h.page.locator("section[aria-label='People']").getByRole("button", { name: "Add" }));
    await h.sleep(900);
    await h.click("[data-testid='folder-access-save']");
    await h.sleep(1400);
  },
};

/* ── Teams › Share and projects: Move a folder to another team ── */
const mv = { done: false };
const movePlan = () => ({
  folder: { id: "f_enable", name: "Enablement", path: "enablement/" }, from_teams: [W.teams.sales], to_team: W.teams.marketing, to_team_open: true,
  parent_id: null, parent_path: null, moves_to_top: false, can_move: true, same_team: false,
  counts: { folders: 1, items: 9, pages: 4, documents: 2, files: 3, workspace_to_team: 7, private: 1, public_links: 1, shared_with_people: 2, team_grants_repointed: 1, projects_dropped: 0 },
  public_links: [{ slug: "pricing-calculator", title: "Pricing calculator", kind: "file", password: false }], public_links_more: 0, folder_links: [],
  keeps_inherited_rule: false, background: false, job: null,
});
const moveFolder = {
  id: "folder-move-team", page: "/teams/share-and-projects", name: "move-folder", url: `/w/${WS}/teams/sales/pages`,
  viewport: { width: 1280, height: 800 }, storage: rail(["t_sales"]), tail: 500, cursor: [900, 300],
  handlers: [
    [`/api/v1/workspaces/${WS}/teams/browse`, () => ({ teams: Object.values(W.teams) })],
    [`/api/v1/workspaces/${WS}/folders/f_enable/move-to-team`, (u, m) => {
      if (m === "POST") { mv.done = true; return { __delay: 400, body: { ...movePlan(), moved: true } }; }
      return { __delay: 200, body: movePlan() };
    }],
    [`/api/v1/workspaces/${WS}/tree`, () => ({ workspace: { id: WS, name: "Acme", role: "owner", primary_host: null, default_access: "workspace" },
      folders: W.folders.map((f) => (f.id === "f_enable" && mv.done ? { ...f, team_ids: ["t_mkt"] } : f)), unfiled_count: 0, root_exposure: null })],
    // Enablement's items are left out: the page doesn't read the outline again after a move, and they'd show loose.
    [`/api/v1/workspaces/${WS}/nav`, (u) => ({ items: u.searchParams.get("space") === "team:t_sales" ? W.navItems.filter((x) => x.folder_id !== "f_enable") : [], more: {} })],
  ],
  prepare: async (h) => { mv.done = false; await text("Sales team charter")(h); await h.settle(800); await h.page.mouse.move(900, 300); },
  steps: async (h) => {
    await h.sleep(600);
    await h.hover(h.page.locator("main").getByText("Enablement", { exact: true }).filter({ visible: true }).first(), 400);
    await h.click(h.page.locator("main").getByRole("button", { name: /Enablement/ }).filter({ hasNot: h.page.locator("a") }).last());
    await h.sleep(500);
    await h.click({ role: "menuitem", name: /Move to team/ });
    await h.loc("[data-testid='move-folder-dialog']").waitFor({ timeout: 20_000 });
    await h.sleep(700);
    await h.move("[data-testid='move-folder-team']");
    await h.sleep(300);
    await h.page.getByTestId("move-folder-team").selectOption("t_mkt");
    await text("link keeps working")(h);
    await h.move([640, 470]);
    await h.sleep(1900);
    await h.click("[data-testid='move-folder-confirm']");
    await text("Moved “Enablement” to Marketing")(h);
    await h.sleep(900);
  },
};

/* ── Teams › Set up: New team → people → its home ── */
const made = { team: null };
const setupTeam = {
  id: "team-setup", page: "/teams/set-up", name: "new-team", url: `/w/${WS}/teams`,
  viewport: { width: 1280, height: 800 }, storage: rail([]), tail: 1200, cursor: [700, 400],
  handlers: [
    [`/api/v1/workspaces/${WS}/teams/browse`, () => ({ teams: Object.values(W.teams) })],
    [`/api/v1/workspaces/${WS}/teams`, (u, m, req) => {
      if (m === "POST") {
        const b = body(req);
        made.team = { ...W.teams.marketing, id: "t_part", name: b.name, slug: "partnerships", icon: b.icon || "🤝", color: b.color || "amber", visibility: b.visibility || "open",
          description: b.description || "", lead_ids: ["u_riya"], my_role: "lead", member_count: 3, linked: [] };
        return W.teamFull(made.team, [{ ...people.riya, role: "lead" }, { ...people.maya, role: "member" }, { ...people.diego, role: "member" }]);
      }
      return { ...W.teamsSidebar, teams: [...W.teamsSidebar.teams, ...(made.team ? [made.team] : [])], projects: [W.project] };
    }],
    [new RegExp(`^/api/v1/workspaces/${WS}/teams/(t_part|partnerships)$`), () => ({
      team: W.teamFull(made.team, [{ ...people.riya, role: "lead" }, { ...people.maya, role: "member" }, { ...people.diego, role: "member" }]),
      brief: null, recent: [], meetings: [], memory: { highlights: [], people: [people.riya, people.maya, people.diego].map((x) => ({ ...x, status: null })) },
      jira: { projects: [] }, projects: [], can_read: true, activity: { items: [], meetings: [] }, new_people: [],
    })],
  ],
  prepare: async (h) => { made.team = null; await h.loc("[data-testid='new-team']").waitFor({ timeout: 60_000 }); await h.settle(500); },
  steps: async (h) => {
    await h.click("[data-testid='new-team']");
    await h.type("[data-testid='team-name']", "Partnerships", { speed: 2.2 });
    await h.sleep(400);
    for (const who of ["Maya", "Diego"]) {
      await h.type("[data-testid='team-add-people']", who, { speed: 2.2 });
      await h.sleep(500);
      await h.page.keyboard.press("Enter");
      await h.sleep(500);
    }
    await h.click("[data-testid='create-team']");
    await h.loc("[data-testid='team-home']").waitFor({ timeout: 20000 });
    await h.move([900, 420]);
    await h.sleep(1600);
  },
};

/* ── Workspaces › Branding: a logo and an accent colour, in the preview ── */
const LOGO = readFileSync(new URL("./acme-logo.png", import.meta.url));
const LOGO_URL = "http://127.0.0.1:8799/mock-assets/acme-logo.png";
const brand = { logo: null, accent: null };
const brandWs = () => ({ ...W.workspace, branding: { ...W.workspace.branding, logo_url: brand.logo, accent_color: brand.accent } });
const branding = {
  id: "ws-branding", page: "/workspaces/branding", name: "logo-and-accent", url: `/settings/workspaces/${WS}?tab=look`,
  viewport: { width: 1280, height: 800 }, storage: rail([]), tail: 1000, cursor: [700, 400],
  handlers: [
    ["/mock-assets/acme-logo.png", () => ({ __raw: LOGO, type: "image/png" })],
    [`/api/v1/workspaces/${WS}/branding/logo`, (u, m) => { if (m !== "POST") return undefined; brand.logo = LOGO_URL; return { __delay: 700, body: { url: LOGO_URL } }; }],
    [`/api/v1/workspaces/${WS}`, (u, m, req) => {
      if (m === "PATCH" || m === "PUT") { const b = body(req); if (b.branding) { if ("logo_url" in b.branding) brand.logo = b.branding.logo_url; if ("accent_color" in b.branding) brand.accent = b.branding.accent_color; } return brandWs(); }
      return brandWs();
    }],
  ],
  prepare: async (h) => { brand.logo = null; brand.accent = null; await text("Logo, colours and favicon")(h); await h.scrollTo({ text: "Logo, colours and favicon" }, { block: "start" }); await h.page.mouse.wheel(0, -90); await h.settle(800); },
  steps: async (h) => {
    await h.sleep(700);
    const drop = h.page.locator("input[type='file']").nth(1);
    await h.move(h.page.getByText("Drop an image or click to choose").nth(1));
    await h.sleep(700);
    await drop.setInputFiles({ name: "acme-logo.png", mimeType: "image/png", buffer: LOGO });
    await h.sleep(1800);
    const accent = h.page.getByPlaceholder("#3b82f6").first();
    await h.type(accent, "#0F766E", { clear: true, speed: 1.2 });
    await h.sleep(1600);
    await h.click(h.page.getByRole("button", { name: "Save changes" }));
    await h.sleep(1800);
  },
};

export default [dealTour, filePick, zoomShare, nameSpeaker, signOff, exportPage, subPage, jiraCreateClip, folderShare, moveFolder, setupTeam, branding];
