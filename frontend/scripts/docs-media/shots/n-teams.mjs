/**
 * Docs media, group N: Teams (/teams/*). Shot format: ../shots.mjs.
 *
 * Not the demo world of seed.py: the real-stack e2e world plus teams-docs-setup.mjs (Riya Sharma, Alex Chen, Sam Lee,
 * Maya Patel, Priya Nair, Diego Alvarez and Hana Kim at Acme; Sales (private), Marketing and Engineering (open); the
 * "Q4 launch" project; two routed meetings; a Sales brief). Start the stack with the fakes:
 *
 *   PB_DOCS_WORLD=1 PB_FAKE_MEETINGS_AI=1 PB_FAKE_TEAM_AI=1 PB_FAKE_ASK_AI=1 PB_STACK_ID=17 PB_WORK=… zsh e2e/pages/real/up.sh start
 *   (cd e2e/pages/real; PB_STACK_ID=17 PB_WORK=… node teams-docs-setup.mjs)
 *   STACK_ID=17 DOCS_MEDIA_DATA=$PB_WORK/stack/data npm run docs:media -- <teams-… ids>
 *   backend/.venv/bin/python frontend/scripts/docs-media/teams-covers.py   (the overview's card covers)
 *
 * Users: riya = owner (Sales lead, Marketing member), member = Alex Chen (Sales, Engineering), admin = Sam Lee
 * (workspace admin, Engineering lead), reader = Maya Patel (Marketing).
 */
const OVERVIEW = "/teams/overview";
const HOME = "/teams/team-home";
const MANAGE = "/teams/create-and-manage";
const SHARE = "/teams/share-and-projects";
const MEET = "/teams/meetings-and-memory";
const ASK = "/teams/ask-and-search";
const SETUP = "/teams/set-up";

const WIDE = { width: 1440, height: 900 };
const W = (fx) => encodeURIComponent(fx.workspace.id);
const teamUrl = (fx, t, sub = "") => `/w/${W(fx)}/teams/${fx.teams[t].slug}${sub}`;
const still = async (h) => { await h.settle(700); await h.page.mouse.move(5, 895); };
const home = async (h, t = "sales") => {
  await h.goto(teamUrl(h.fx, t));
  await h.loc("[data-testid='team-home']").waitFor({ timeout: 30000 });
  await h.loc("[data-testid='team-brief']").waitFor({ timeout: 30000 });
  await still(h);
};
/** The page column, from below the top bar. */
const pageCol = (height) => async (h) => {
  const b = await h.page.locator(".tz-page").first().boundingBox();
  return { box: { x: Math.max(0, b.x - 20), y: 64, width: Math.min(1440 - b.x + 20, b.width + 40), height } };
};

export default [
  // ── Overview ────────────────────────────────────────────────────────────────
  {
    id: "teams-hero",
    page: OVERVIEW,
    name: "hero",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: WIDE,
    prepare: async (h) => { await home(h); },
    crop: { box: { x: 0, y: 56, width: 1440, height: 780 } },
  },
  {
    id: "teams-sidebar",
    page: OVERVIEW,
    name: "sidebar",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1440, height: 1100 },
    prepare: async (h) => {
      await home(h);
      await h.loc(`[data-rail-key="ws:${h.fx.workspace.id}:team:${h.fx.teams.sales.id}:project:${h.fx.teams.q4.id}"]`).waitFor({ timeout: 15000 });
    },
    crop: async (h) => {
      const b = await h.page.locator(`aside[data-rail="full"] [data-rail-key="ws:${h.fx.workspace.id}:root"]`).first().boundingBox();
      const end = await h.page.locator(`aside[data-rail="full"] [data-rail-key="ws:${h.fx.workspace.id}:browse"]`).first().boundingBox();
      return { box: { x: 0, y: b.y - 4, width: 248, height: end.y + end.height - b.y + 16 } };
    },
  },

  // ── Team home ───────────────────────────────────────────────────────────────
  {
    id: "teams-brief",
    page: HOME,
    name: "brief",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: WIDE,
    prepare: async (h) => { await home(h); },
    crop: { selector: "[data-testid='team-brief']", pad: 12 },
  },
  {
    id: "teams-brief-edit",
    page: HOME,
    name: "brief-edit",
    kind: "clip",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1200, height: 720 },
    tail: 600,
    prepare: async (h) => { await home(h); },
    steps: async (h) => {
      const line = h.page.locator(".tz-brief__line", { hasText: "demo workspace needs SSO" }).first();
      await h.hover(line);
      await h.sleep(500);
      await h.click(line.getByRole("button", { name: "Edit line" }));
      const box = h.page.getByRole("textbox", { name: "Line text" });
      await box.fill("");
      await h.type(box, "The enterprise demo workspace needs SSO: Engineering ships it Thursday.", { speed: 2.4 });
      await h.click(h.page.locator(".tz-brief__line form").getByRole("button", { name: "Save" }));
      await h.sleep(900);
      const other = h.page.locator(".tz-brief__line", { hasText: "Brief the top 20" }).first();
      await h.hover(other);
      await h.sleep(400);
      await h.click(other.getByRole("button", { name: "Hide line" }));
      await h.sleep(900);
    },
  },
  {
    id: "teams-locked",
    page: HOME,
    name: "private-outsider",
    kind: "screenshot",
    auth: "priya",
    url: "/dashboard",
    viewport: WIDE,
    prepare: async (h) => {
      await h.goto(teamUrl(h.fx, "sales"));
      await h.loc({ text: "This is a private team" }).waitFor({ timeout: 30000 });
      await still(h);
    },
    crop: pageCol(560),
  },

  // ── Create and manage ───────────────────────────────────────────────────────
  {
    id: "teams-browse",
    page: MANAGE,
    name: "browse",
    kind: "screenshot",
    auth: "member",
    url: "/dashboard",
    viewport: WIDE,
    prepare: async (h) => {
      await h.goto(`/w/${W(h.fx)}/teams`);
      await h.loc("[data-testid='browse-teams']").waitFor({ timeout: 30000 });
      await still(h);
    },
    crop: pageCol(620),
  },
  {
    id: "teams-create",
    page: MANAGE,
    name: "create-flow",
    kind: "clip",
    auth: "admin",
    url: "/dashboard",
    viewport: { width: 1280, height: 860 },
    tail: 800,
    prepare: async (h) => {
      await h.goto(`/w/${W(h.fx)}/teams`);
      await h.loc("[data-testid='new-team']").waitFor({ timeout: 30000 });
      await h.page.mouse.move(700, 400);
    },
    steps: async (h) => {
      await h.click("[data-testid='new-team']");
      await h.type("[data-testid='team-name']", "Customer Success", { speed: 2.4 });
      await h.click(h.page.getByRole("radio", { name: "pink" }));
      await h.click(h.page.getByRole("dialog").locator("label", { hasText: "Only members see" }));
      await h.sleep(900);
      await h.click(h.page.getByRole("dialog").locator(".tz-picklist label", { hasText: "Maya Patel" }).last());
      await h.sleep(500);
      await h.click("[data-testid='create-team']");
      await h.loc("[data-testid='team-home']").waitFor({ timeout: 20000 });
      await h.sleep(900);
    },
  },
  {
    id: "teams-settings-private",
    page: MANAGE,
    name: "private-settings",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: WIDE,
    prepare: async (h) => {
      await h.goto(teamUrl(h.fx, "sales", "/settings"));
      await h.loc("[data-testid='team-visibility']").waitFor({ timeout: 30000 });
      await still(h);
    },
    crop: { union: ["[data-testid='team-visibility']", "[data-testid='team-members-settings']"], pad: 12 },
  },

  // ── Share and projects ──────────────────────────────────────────────────────
  {
    id: "teams-share",
    page: SHARE,
    name: "share-flow",
    kind: "clip",
    auth: "member",
    url: "/dashboard",
    viewport: { width: 1280, height: 860 },
    tail: 800,
    prepare: async (h) => {
      await h.goto(`/${h.fx.teams.holidays}`);
      await h.loc(".pb-paper").waitFor({ timeout: 30000 });
      await h.settle(800);
    },
    steps: async (h) => {
      await h.click(h.page.getByRole("button", { name: /^Share/ }).first());
      await h.loc("[data-testid='share-teams']").waitFor({ timeout: 15000 });
      await h.sleep(600);
      await h.click("[data-testid='share-teams-add']");
      await h.sleep(400);
      await h.click(h.page.getByRole("menuitem", { name: "Engineering" }));
      await h.loc("[data-testid='share-teams'] .tz-chip").first().waitFor();
      await h.sleep(1200);
    },
  },
  {
    id: "teams-project",
    page: SHARE,
    name: "project",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: WIDE,
    prepare: async (h) => {
      await h.goto(`/w/${W(h.fx)}/projects/${h.fx.teams.q4.slug}`);
      await h.loc("[data-testid='project-home']").waitFor({ timeout: 30000 });
      await still(h);
    },
    crop: { box: { x: 0, y: 56, width: 1440, height: 640 } },
  },

  // ── Meetings and memory ─────────────────────────────────────────────────────
  {
    id: "teams-import",
    page: MEET,
    name: "import-teams",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1440, height: 1000 },
    prepare: async (h) => {
      await h.goto(`/meetings/${W(h.fx)}?space=${encodeURIComponent(`team:${h.fx.teams.sales.id}`)}`);
      await h.click("[data-testid='import-meeting']");
      await h.loc("[data-testid='import-teams']").waitFor({ timeout: 15000 });
      await h.paste?.("textarea#mt-paste", "Renewal call - Transcript\nAttendees\nRiya Sharma, Alex Chen, Hana Kim\nTranscript\nRiya Sharma: Let's agree the Northwind terms.\nAlex Chen: They sign on Friday.\n");
      await h.settle(1800);
    },
    crop: { selector: "[role='dialog']", pad: 0 },
  },
  {
    id: "teams-meetings",
    page: MEET,
    name: "team-meetings",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: WIDE,
    prepare: async (h) => {
      await h.goto(`/meetings/${W(h.fx)}`);
      await h.loc("[data-testid='card-team']").first().waitFor({ timeout: 30000 });
      await still(h);
    },
    crop: { box: { x: 248, y: 56, width: 1192, height: 560 } },
  },

  // ── Ask and search ──────────────────────────────────────────────────────────
  {
    id: "teams-ask",
    page: ASK,
    name: "ask-toggle",
    kind: "clip",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1280, height: 800 },
    tail: 900,
    prepare: async (h) => {
      await h.goto(`/ask?workspace=${W(h.fx)}&team=${h.fx.teams.sales.id}`);
      await h.loc("[data-testid='ask-teams']").waitFor({ timeout: 30000 });
      await h.settle(800);
    },
    steps: async (h) => {
      await h.sleep(600);
      await h.click(h.page.locator("label", { has: h.page.getByTestId("ask-whole-company") }));
      await h.sleep(1300);
      await h.click(h.page.locator("label", { has: h.page.getByTestId("ask-whole-company") }));
      await h.sleep(1000);
    },
  },
  {
    id: "teams-search",
    page: ASK,
    name: "search-filter",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: WIDE,
    prepare: async (h) => {
      await h.goto(`/search?q=Q4&scope=${W(h.fx)}`);
      await h.loc("[data-testid='search-team']").waitFor({ timeout: 30000 });
      await h.settle(1500);
      await still(h);
    },
    crop: { box: { x: 248, y: 56, width: 1192, height: 600 } },
  },

  // ── Set up ──────────────────────────────────────────────────────────────────
  {
    id: "teams-review",
    page: SETUP,
    name: "review",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: WIDE,
    prepare: async (h) => {
      await h.goto(`/w/${W(h.fx)}/teams-review`);
      await h.loc("[data-testid='teams-review']").waitFor({ timeout: 30000 });
      await still(h);
    },
    crop: pageCol(640),
  },
  {
    id: "teams-phone",
    page: OVERVIEW,
    name: "phone",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 390, height: 844 },
    prepare: async (h) => {
      await h.goto(`/w/${W(h.fx)}/home`);
      await h.loc("[data-testid='company-home']").waitFor({ timeout: 30000 });
      await h.page.getByRole("button", { name: "Menu" }).first().click();
      await h.loc(`[role="dialog"] [data-rail-key="ws:${h.fx.workspace.id}:team:${h.fx.teams.sales.id}"]`).waitFor({ timeout: 10000 });
      await h.settle(700);
    },
    crop: "viewport",
  },
];
