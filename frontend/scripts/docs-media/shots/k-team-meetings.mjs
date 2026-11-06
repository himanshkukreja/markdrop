/**
 * Docs media, group K: Team (/workspaces/team) and the newest Meetings screens (Check for new meetings,
 * "waiting for Gemini's notes", Attendees and Invited). Shot format: ../shots.mjs.
 *
 * Not the demo world of seed.py: the Team world of the real-stack e2e (frontend/e2e/pages/real/team.mjs,
 * with its fake Team and Meetings AI) plus team-meetings-docs-setup.mjs (a Gemini-notes meeting with
 * more people invited than joined, a connected Google Meet script with one meeting waiting, the fixtures
 * capture.mjs reads). Start the stack with the fakes, including the Check now web app:
 *
 *   PB_FAKE_MEETINGS_AI=1 PB_FAKE_TEAM_AI=1 PB_FAKE_ASK_AI=1 PB_FAKE_SLACK=1 PB_FAKE_MEET_SCRIPT=1 \
 *     PB_STACK_ID=66 PB_WORK=… zsh e2e/pages/real/up.sh start
 *   (cd e2e/pages/real; ONLY=enable,board,own,groups,week node team.mjs; NO_RESEED=1 node team-meetings-docs-setup.mjs)
 *   STACK_ID=66 DOCS_MEDIA_DATA=$PB_WORK/stack/data npm run docs:media -- <ids>
 *
 * Users: riya = Ada Owner (owner, connected Google Meet), admin = Wes Admin, member = Ben Member.
 */
import { api, ok } from "./_demo.mjs";

const team = (fx) => `/team/${encodeURIComponent(fx.workspace.id)}`;
const hub = (fx) => `/meetings/${fx.workspace.id}`;
const EXEC = "https://script.google.com/macros/s/AKfycbxDocsMediaCheckNowWebApp0123456789/exec";

/** The page column (.tm-page) from the top bar down, a little wider: the board without the sidebar. */
const pageBox = (height) => async (h) => {
  const b = await h.page.locator(".tm-page").first().boundingBox();
  return { box: { x: Math.max(0, b.x - 16), y: 70, width: b.width + 32, height } };
};

async function board(h) {
  await h.loc("[data-testid='team-cards']").waitFor({ timeout: 30000 });
  await h.settle(700);
  await h.page.mouse.move(5, 895);
}

/** Ben's own Team page, his open target (and anything he marked done) back to open first. */
async function bensPage(h) {
  const me = await ok(h, "GET", `/api/v1/team/${h.fx.workspace.id}/people/${h.fx.users.member.id}`, undefined, "member");
  for (const x of me.hidden || []) await api(h, "DELETE", `/api/v1/team/${h.fx.workspace.id}/facts/${x.id}/hide`, undefined, "member");
  await h.goto(`${team(h.fx)}/people/${h.fx.users.member.id}`);
  await h.loc("[data-testid='team-person']").waitFor({ timeout: 30000 });
  await h.settle(700);
  await h.page.mouse.move(5, 895);
}

async function checkNow(h, on) {
  await api(h, "PUT", "/api/v1/meetings/connection/check-now", { url: on ? EXEC : null });
}

async function hubReady(h) {
  await h.loc("[data-testid='meeting-card']").first().waitFor({ timeout: 30000 });
  await h.loc("[data-testid='meet-connection']").waitFor({ timeout: 30000 }).catch(() => {});
  await h.settle(800);
  await h.page.mouse.move(5, 895);
}

async function openSync(h) {
  const list = await ok(h, "GET", `/api/v1/meetings?workspace=${h.fx.workspace.id}&q=${encodeURIComponent("Weekly product sync")}`);
  await h.goto(`/${list.meetings[0].slug}`);
  await h.loc("[data-testid='meeting-header']").waitFor({ timeout: 30000 });
  await h.settle(700);
  await h.page.mouse.move(5, 895);
}

export default [
  // ── Team ────────────────────────────────────────────────────────────────────
  {
    id: "team-board",
    page: "/workspaces/team",
    name: "board",
    kind: "screenshot",
    auth: "admin",
    url: team,
    viewport: { width: 1440, height: 1000 },
    prepare: board,
    crop: pageBox(900),
  },
  {
    id: "team-this-week",
    page: "/workspaces/team",
    name: "this-week",
    kind: "screenshot",
    auth: "admin",
    url: team,
    prepare: board,
    crop: { selector: "[data-testid='team-this-week']", pad: 12 },
  },
  {
    id: "team-glance",
    page: "/workspaces/team",
    name: "glance",
    kind: "screenshot",
    auth: "admin",
    url: team,
    prepare: board,
    crop: { selector: ".tm-glance", pad: 0 },
  },
  {
    id: "team-person",
    page: "/workspaces/team",
    name: "person",
    kind: "screenshot",
    auth: "admin",
    url: (fx) => `${team(fx)}/people/${fx.team.raj}`,
    viewport: { width: 1440, height: 1000 },
    prepare: async (h) => {
      await h.loc("[data-testid='team-person']").waitFor({ timeout: 30000 });
      await h.settle(700);
      await h.page.mouse.move(5, 995);
    },
    crop: pageBox(860),
  },
  {
    id: "team-status",
    page: "/workspaces/team",
    name: "status",
    kind: "screenshot",
    auth: "member",
    url: team,
    prepare: async (h) => {
      await board(h);
      await h.page.getByTestId("team-set-status").first().click();
      await h.loc(".md-dialog").waitFor({ timeout: 15000 });
      await h.page.locator(".tm-preset", { hasText: "On leave" }).click();
      await h.page.getByTestId("team-status-text").fill("On leave till Monday");
      await h.page.locator("#tm-status-until").selectOption({ index: 3 }).catch(() => {});
      await h.sleep(500);
      await h.page.mouse.move(5, 5);
    },
    crop: { selector: ".md-dialog", pad: 0 },
  },
  {
    id: "team-line-menu",
    page: "/workspaces/team",
    name: "line-menu",
    kind: "screenshot",
    auth: "member",
    url: "/dashboard",
    prepare: async (h) => {
      await bensPage(h);
      const target = h.page.locator("[data-testid='team-person'] [data-testid='team-line'][data-kind='target']").first();
      await target.locator("[data-testid='team-line-menu']").click();
      await h.page.getByRole("menuitem").first().waitFor({ timeout: 10000 });
      await h.sleep(400);
    },
    crop: async (h) => {
      const target = h.page.locator("[data-testid='team-person'] [data-testid='team-line'][data-kind='target']").first();
      const a = await target.boundingBox();
      const m = await h.page.getByRole("menu").first().boundingBox();
      const x = Math.min(a.x, m.x) - 24, y = Math.min(a.y, m.y) - 56;
      return { box: { x, y, width: Math.max(a.x + a.width, m.x + m.width) - x + 24, height: Math.max(a.y + a.height, m.y + m.height) - y + 24 } };
    },
  },
  {
    id: "team-groups",
    page: "/workspaces/team",
    name: "groups",
    kind: "screenshot",
    auth: "admin",
    url: team,
    prepare: async (h) => {
      await board(h);
      await h.page.getByTestId("team-groups").click();
      await h.loc(".md-dialog").waitFor({ timeout: 15000 });
      await h.sleep(600);
      await h.page.mouse.move(5, 5);
    },
    crop: { selector: ".md-dialog", pad: 0 },
  },
  {
    id: "team-board-phone",
    page: "/workspaces/team",
    name: "board-phone",
    kind: "screenshot",
    auth: "admin",
    url: team,
    viewport: { width: 390, height: 844 },
    prepare: async (h) => {
      await h.loc("[data-testid='team-cards']").waitFor({ timeout: 30000 });
      await h.settle(700);
    },
    crop: "viewport",
  },
  {
    id: "team-filters",
    page: "/workspaces/team",
    name: "filters",
    kind: "clip",
    auth: "admin",
    url: team,
    prepare: async (h) => {
      await board(h);
    },
    steps: async (h) => {
      await h.wheel(600);
      await h.sleep(500);
      const pick = async (testid, label) => {
        await h.move(`[data-testid='${testid}']`);
        await h.sleep(300);
        await h.page.getByTestId(testid).selectOption({ label });
        await h.sleep(1300);
      };
      await pick("team-filter-status", "Blocked or waiting");
      await pick("team-filter-status", "Any status");
      const groups = await h.page.getByTestId("team-filter-group").locator("option").allInnerTexts();
      const g = groups.find((t) => !/^Everyone/.test(t));
      if (g) await pick("team-filter-group", g);
    },
  },
  {
    id: "team-mark-done",
    page: "/workspaces/team",
    name: "mark-done",
    kind: "clip",
    auth: "member",
    url: "/dashboard",
    prepare: async (h) => {
      await bensPage(h);
    },
    steps: async (h) => {
      const me = await ok(h, "GET", `/api/v1/team/${h.fx.workspace.id}/people/${h.fx.users.member.id}`, undefined, "member");
      const id = me.targets[0].id;
      const target = h.page.locator("[data-testid='team-person'] [data-testid='team-line'][data-kind='target']").first();
      await h.move(target);
      await h.sleep(500);
      await h.click(target.locator("[data-testid='team-line-menu']"));
      await h.sleep(800);
      await h.click({ css: "[role='menuitem']:has-text('Mark done')" });
      await h.sleep(2400);
      // Open again for the next capture (not recorded after the tail).
      setTimeout(() => api(h, "DELETE", `/api/v1/team/${h.fx.workspace.id}/facts/${id}/done`, undefined, "member"), 3000);
    },
  },

  // ── Meetings: Google Meet connected, Check now, waiting for Gemini's notes ──
  {
    id: "meet-checknow-setup",
    page: "/workspaces/meetings-auto-import",
    name: "check-now-setup",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    prepare: async (h) => {
      await checkNow(h, false);
      await h.goto(hub(h.fx));
      await hubReady(h);
      await h.page.getByTestId("check-now").click();
      await h.loc("[data-testid='checknow-setup']").waitFor({ timeout: 15000 });
      await h.sleep(700);
      await h.page.mouse.move(5, 5);
    },
    crop: { selector: ".md-dialog", pad: 0 },
  },
  {
    id: "meet-connected",
    page: "/workspaces/meetings-auto-import",
    name: "connected",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1440, height: 1000 },
    prepare: async (h) => {
      await checkNow(h, true);
      await h.goto(hub(h.fx));
      await hubReady(h);
    },
    crop: async (h) => {
      const head = await h.page.locator(".mt-hub").first().boundingBox();
      const conn = await h.page.getByTestId("meet-connection").boundingBox();
      return { box: { x: head.x - 8, y: 70, width: head.width + 16, height: conn.y + conn.height - 70 + 24 } };
    },
  },
  {
    id: "meet-check-now",
    page: "/workspaces/meetings-auto-import",
    name: "check-now",
    kind: "clip",
    auth: "owner",
    url: "/dashboard",
    prepare: async (h) => {
      await checkNow(h, true);
      const date = new Date().toISOString().slice(0, 10);
      await h.sandbox("/__sandbox/meet-script/queue", {
        workspace_id: h.fx.workspace.id,
        item: {
          file_id: `docs-media-design-review-${Date.now()}`, kind_hint: "transcript", created: new Date().toISOString(),
          title: `Design review (${date} 15:00 GMT+05:30) - Transcript`,
          text: `Design review (${date} 15:00 GMT+05:30) - Transcript\nAttendees\nAda Owner, Mei Lin, Ben Member\nTranscript\n00:00:00\nMei Lin: Working on: the onboarding checklist redesign. The new empty state is ready.\nBen Member: Looks good. Decision: we ship the new empty state with saved searches.\nAda Owner: Great, thanks both.\nTranscription ended after 00:08:00\n`,
        },
      });
      await h.goto(hub(h.fx));
      await hubReady(h);
    },
    steps: async (h) => {
      await h.sleep(600);
      await h.click("[data-testid='check-now']");
      await h.page.getByText(/Found 1 new meeting|No new meetings/).first().waitFor({ timeout: 40000 });
      await h.sleep(2600);
    },
  },
  {
    id: "meetings-details-invited",
    page: "/workspaces/meetings",
    name: "meeting-details",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    prepare: async (h) => {
      await openSync(h);
      await h.page.locator("[data-testid='meeting-pill']").first().click();
      await h.loc(".mt-panel").waitFor({ timeout: 15000 });
      await h.settle(600);
      await h.page.mouse.move(5, 5);
    },
    crop: { selector: ".mt-panel .pa-ask__panel", pad: 0 },
  },
  {
    id: "meetings-attendees",
    page: "/workspaces/meetings-import",
    name: "attendees",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    prepare: openSync,
    crop: async (h) => {
      const head = h.page.getByRole("heading", { name: "Attendees", exact: true }).first();
      const a = await head.boundingBox();
      const next = await head.evaluate((el) => { const r = el.nextElementSibling.getBoundingClientRect(); return { y: r.y + window.scrollY, h: r.height }; });
      const col = await h.page.locator("[data-testid='meeting-header']").boundingBox();
      return { box: { x: col.x - 12, y: a.y - 16, width: col.width + 24, height: next.y + next.h - a.y + 32 } };
    },
  },
  {
    id: "meetings-hub-phone",
    page: "/workspaces/meetings",
    name: "hub-phone",
    kind: "screenshot",
    auth: "owner",
    url: hub,
    viewport: { width: 390, height: 844 },
    prepare: hubReady,
    crop: "viewport",
  },

  // ── Ask: a live suggestion, asked with one click ────────────────────────────
  {
    id: "ask-suggestion-click",
    page: "/workspaces/ask-markdrop",
    name: "suggestion",
    kind: "clip",
    auth: "admin",
    url: "/dashboard",
    prepare: async (h) => {
      for (let i = 0; i < 40; i++) {
        const r = await ok(h, "GET", `/api/v1/ask/suggestions?workspace=${h.fx.workspace.id}`, undefined, "admin");
        if (r.team?.length) break;
        await h.sleep(500);
      }
      await h.goto(`/ask?workspace=${encodeURIComponent(h.fx.workspace.id)}`);
      await h.loc("[data-testid='ask-page-chat'] [data-testid='chat-starters'] button").waitFor({ timeout: 30000 });
      await h.settle(800);
    },
    steps: async (h) => {
      await h.sleep(600);
      await h.click("[data-testid='ask-page-chat'] [data-testid='chat-starters'] button");
      await h.page.locator("[data-testid='ask-page-chat'] ol[aria-label='Conversation'] > li[data-state='done'] .ch-md:not([data-streaming])")
        .first().waitFor({ timeout: 40000 });
      await h.sleep(2500);
    },
  },
];
