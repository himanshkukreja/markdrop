/**
 * Docs media, group L: Jira (/integrations/jira). Shot format: ../shots.mjs.
 *
 * Markdrop's own screens only (the settings cards, the create dialog, chips, Team): no Atlassian
 * interface, logo or colours. Not the demo world of seed.py: the world of the real-stack e2e
 * (frontend/e2e/pages/real/jira.mjs, against the fake Atlassian in api_run.py: PB_FAKE_JIRA=1) plus
 * jira-docs-setup.mjs (a meeting whose action items have no issue yet, the fixtures capture.mjs reads):
 *
 *   PB_FAKE_JIRA=1 PB_FAKE_MEETINGS_AI=1 PB_STACK_ID=67 PB_WORK=… zsh e2e/pages/real/up.sh start
 *   (cd e2e/pages/real; node jira.mjs; NO_RESEED=1 node jira-docs-setup.mjs)
 *   STACK_ID=67 DOCS_MEDIA_DATA=$PB_WORK/stack/data npm run docs:media -- <ids>
 *
 * Users: riya = Ada Owner (owner, connected the site), member = Ben Member (connected), admin = Wes Admin
 * (not connected: counts only on Team).
 */
import { ok } from "./_demo.mjs";

const PAGE = "/integrations/jira";
const settings = (fx) => `/settings/workspaces/${fx.workspace.id}?tab=integrations`;
const team = (fx) => `/team/${encodeURIComponent(fx.workspace.id)}`;

async function meeting(h, title) {
  const list = await ok(h, "GET", `/api/v1/meetings?workspace=${h.fx.workspace.id}&q=${encodeURIComponent(title)}`, undefined, "member");
  const m = list.meetings.find((x) => x.title === title);
  if (!m) throw new Error(`run jira.mjs and jira-docs-setup.mjs first (no "${title}")`);
  await h.goto(`/${m.slug}`);
  await h.loc("li:has(input[type=checkbox])").first().waitFor({ timeout: 30000 });
  await h.settle(800);
}

const still = async (h) => { await h.settle(600); await h.page.mouse.move(5, 895); };

export default [
  {
    id: "jira-card-connected",
    page: PAGE,
    name: "card-connected",
    kind: "screenshot",
    auth: "owner",
    url: settings,
    prepare: async (h) => {
      await h.loc("[data-testid='jira-connected']").waitFor({ timeout: 30000 });
      await h.loc("[data-testid='jira-me']").waitFor({ timeout: 30000 });
      await still(h);
    },
    crop: { union: ["[data-testid='jira-card']", "[data-testid='jira-me']"], pad: 12 },
  },
  {
    id: "jira-projects",
    page: PAGE,
    name: "projects",
    kind: "screenshot",
    auth: "owner",
    url: settings,
    prepare: async (h) => {
      await h.loc("[data-testid='jira-edit']").click();
      await h.loc("[data-testid='jira-team-projects-pick']").waitFor({ timeout: 30000 });
      await still(h);
    },
    crop: { selector: "[data-testid='jira-card']", pad: 12 },
  },
  {
    id: "jira-account",
    page: PAGE,
    name: "account",
    kind: "screenshot",
    auth: "member",
    url: "/settings/account#jira",
    prepare: async (h) => {
      await h.loc("[data-testid='jira-account']").waitFor({ timeout: 30000 });
      await h.loc("[data-testid='jira-account']").scrollIntoViewIfNeeded();
      await still(h);
    },
    crop: { selector: "[data-testid='jira-account']", pad: 12 },
  },
  {
    id: "jira-create-dialog",
    page: PAGE,
    name: "create-dialog",
    kind: "screenshot",
    auth: "member",
    url: "/dashboard",
    viewport: { width: 1440, height: 1000 },
    prepare: async (h) => {
      await meeting(h, "Checkout launch sync");
      const li = h.page.locator("li:has(input[type=checkbox])", { hasText: "card payment webhook" }).first();
      await li.hover();
      await li.getByTestId("jira-add").click();
      await h.loc("[data-testid='jira-dialog']").waitFor({ timeout: 30000 });
      await still(h);
    },
    crop: { selector: "[role='dialog']", pad: 0 },
  },
  {
    id: "jira-bulk",
    page: PAGE,
    name: "bulk",
    kind: "screenshot",
    auth: "member",
    url: "/dashboard",
    viewport: { width: 1440, height: 1000 },
    prepare: async (h) => {
      await meeting(h, "Checkout launch sync");
      await h.loc("[data-testid='jira-bulk-open']").click();
      await h.loc("[data-testid='jira-bulk']").waitFor({ timeout: 30000 });
      await still(h);
    },
    crop: { selector: "[role='dialog']", pad: 0 },
  },
  {
    id: "jira-chips",
    page: PAGE,
    name: "chips",
    kind: "screenshot",
    auth: "member",
    url: "/dashboard",
    prepare: async (h) => {
      await meeting(h, "Payments planning");
      await h.loc("[data-testid='jira-chip']").first().waitFor({ timeout: 30000 });
      await h.page.locator("h2", { hasText: "Action items" }).first().scrollIntoViewIfNeeded();
      await still(h);
    },
    crop: { union: [{ css: "h2:has-text('Action items')" }, { css: "ul.contains-task-list" }], pad: 16 },
  },
  {
    id: "jira-team",
    page: PAGE,
    name: "team",
    kind: "screenshot",
    auth: "member",
    url: team,
    viewport: { width: 1440, height: 1200 },
    prepare: async (h) => {
      await h.loc("[data-testid='team-jira'] [data-testid='jira-issue-row']").first().waitFor({ timeout: 30000 });
      await h.loc("[data-testid='team-jira']").scrollIntoViewIfNeeded();
      await still(h);
    },
    crop: { selector: "[data-testid='team-jira']", pad: 12 },
  },
  {
    id: "jira-team-card",
    page: PAGE,
    name: "team-card",
    kind: "screenshot",
    auth: "member",
    url: team,
    prepare: async (h) => {
      await h.loc("[data-testid='team-card'][data-person='Ben Member'] [data-testid='team-card-jira']").waitFor({ timeout: 30000 });
      await still(h);
    },
    crop: { selector: "[data-testid='team-card'][data-person='Ben Member']", pad: 12 },
  },
  {
    id: "jira-team-counts",
    page: PAGE,
    name: "team-counts",
    kind: "screenshot",
    auth: "admin",
    url: team,
    viewport: { width: 1440, height: 1200 },
    prepare: async (h) => {
      await h.loc("[data-testid='team-jira-connect']").waitFor({ timeout: 30000 });
      await h.loc("[data-testid='team-jira']").scrollIntoViewIfNeeded();
      await still(h);
    },
    crop: { selector: "[data-testid='team-jira']", pad: 12 },
  },
];
