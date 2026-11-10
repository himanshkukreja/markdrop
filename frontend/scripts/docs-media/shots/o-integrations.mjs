/**
 * Docs media, group O: the Integrations pages (/integrations/overview): the workspace grid, the account
 * grid and one integration's page. Shot format: ../shots.mjs.
 */
const PAGE = "/integrations/overview";
const still = async (h) => { await h.settle(600); await h.page.mouse.move(5, 895); };
const statuses = async (h) => {
  await h.loc("[data-testid='integrations-grid']").waitFor({ timeout: 30000 });
  await h.page.waitForFunction(() => document.querySelectorAll("[data-testid='integrations-grid'] [data-status]").length
    === document.querySelectorAll("[data-testid='integrations-grid'] > li").length, null, { timeout: 30000 });
};

export default [
  {
    id: "integrations-workspace-grid",
    page: PAGE,
    name: "workspace-grid",
    kind: "screenshot",
    auth: "owner",
    url: (fx) => `/settings/workspaces/${fx.workspace.id}?tab=integrations`,
    prepare: async (h) => { await statuses(h); await still(h); },
    crop: { selector: "[data-testid='integrations-grid']", pad: 12 },
  },
  {
    id: "integrations-account-grid",
    page: PAGE,
    name: "account-grid",
    kind: "screenshot",
    auth: "owner",
    url: "/settings/integrations",
    viewport: { width: 1440, height: 1200 },
    prepare: async (h) => { await statuses(h); await still(h); },
    crop: { selector: "[data-testid='integrations-grid']", pad: 12 },
  },
  {
    id: "integrations-detail",
    page: PAGE,
    name: "detail",
    kind: "screenshot",
    auth: "owner",
    url: "/settings/integrations/claude",
    viewport: { width: 1440, height: 1300 },
    prepare: async (h) => {
      await h.loc("[data-testid='integration-detail-claude'] [data-status]").waitFor({ timeout: 30000 });
      await h.loc("[data-testid='mcp-server-url']").waitFor({ timeout: 30000 });
      await still(h);
    },
    crop: { selector: "[data-testid='integration-detail-claude']", pad: 16 },
  },
];
