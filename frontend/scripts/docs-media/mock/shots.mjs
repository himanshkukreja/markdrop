/** Mocked-API docs shots (shoot.mjs). World: world.mjs (Acme; Riya Sharma is signed in and leads Sales). */
import { WS, D0 } from "./world.mjs";

const aside = `aside[data-rail="full"]`;
const sidebarCrop = async (h) => {
  const b = await h.page.locator(aside).first().boundingBox();
  return { box: { x: 0, y: b.y, width: b.width, height: b.height } };
};
/** The sidebar's open rows (localStorage md_rail_tree). General closes with "<key>!closed". */
const rail = (open = ["t_sales"], generalOpen = false) => ({
  md_rail_tree: JSON.stringify([...open.map((t) => `ws:${WS}:team:${t}`), ...(generalOpen ? [] : [`ws:${WS}:team:t_gen!closed`])]),
});
/** The page right of the sidebar, from below the top bar. */
const main = (height, width = 1440) => ({ box: { x: 248, y: 56, width: width - 248, height } });
const full = (height, width = 1440) => ({ box: { x: 0, y: 56, width, height } });
const text = (t) => async (h) => { await h.page.getByText(t, { exact: false }).first().waitFor({ timeout: 60_000 }); };
/** The smallest box around an element found by its text, grown to its nearest card. */
const cardOf = (t, pad = 0) => async (h) => {
  const el = h.page.getByText(t, { exact: true }).first();
  const b = await el.evaluate((n) => {
    let x = n;
    while (x && x.parentElement && !(getComputedStyle(x).borderTopLeftRadius !== "0px" && getComputedStyle(x).borderTopWidth !== "0px" && x.getBoundingClientRect().width > 400)) x = x.parentElement;
    const r = x.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  return { box: { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad } };
};

export default [
  // ── Get started › tour ──
  { id: "tour-home", page: "/get-started/tour", name: "home", url: "/dashboard", viewport: { width: 1440, height: 1100 },
    storage: rail([], true), prepare: text("Continue where you left off"), crop: full(1040) },
  { id: "tour-sidebar", page: "/get-started/tour", name: "sidebar", url: "/dashboard", viewport: { width: 1440, height: 1060 },
    storage: rail([], true), prepare: async (h) => { await h.loc(aside).waitFor(); }, crop: sidebarCrop },

  // ── Teams › overview ──
  { id: "teams-hero", page: "/teams/overview", name: "hero", url: `/w/${WS}/teams/sales`, viewport: { width: 1440, height: 900 },
    storage: rail(["t_sales"]), prepare: text("This week in Sales"), crop: full(780) },
  { id: "teams-sidebar", page: "/teams/overview", name: "sidebar", url: `/w/${WS}/teams/sales`, viewport: { width: 1440, height: 900 },
    storage: rail(["t_sales"]), prepare: text("This week in Sales"),
    crop: async (h) => {
      const top = await h.page.locator(`${aside} [data-testid="ws-switcher"]`).first().boundingBox().catch(() => null);
      const end = await h.page.getByText("Browse teams").first().boundingBox();
      const y = top ? top.y - 8 : 64;
      return { box: { x: 0, y, width: 248, height: end.y + end.height - y + 14 } };
    } },
  { id: "teams-general", page: "/teams/overview", name: "general", url: `/w/${WS}/teams/general`, viewport: { width: 1600, height: 1000 },
    storage: rail([], true), prepare: text("Across teams"), crop: full(900, 1600) },
  { id: "teams-phone", page: "/teams/overview", name: "phone", url: `/w/${WS}/teams/sales`, viewport: { width: 390, height: 844 }, mobile: true,
    storage: rail(["t_sales"]),
    prepare: async (h) => {
      await text("This week in Sales")(h);
      await h.page.getByRole("button", { name: /menu/i }).first().click();
      await h.settle(800);
    } },
  { id: "teams-files", page: "/teams/share-and-projects", name: "files-and-pages", url: `/w/${WS}/teams/sales/pages`, viewport: { width: 1440, height: 760 },
    storage: rail(["t_sales"]),
    prepare: async (h) => {
      await text("Sales team charter")(h);
      for (const f of ["Playbooks", "Proposals"]) {
        const b = await h.page.locator("main").getByText(f, { exact: true }).first().boundingBox();
        await h.page.mouse.click(b.x - 36, b.y + b.height / 2); await h.settle(500);
      }
      await text("Northwind proposal 2027")(h);
    },
    crop: full(700) },

  // ── Meetings ──
  { id: "meetings-section", page: "/workspaces/meetings", name: "meetings-section", url: `/meetings/${WS}?space=all`, viewport: { width: 1440, height: 940 },
    storage: rail([], false), prepare: text("Northwind — pricing and rollout plan"), crop: main(880) },
  { id: "zoom-review", page: "/integrations/zoom", name: "review", url: `/meetings/${WS}?space=all&tab=review`, viewport: { width: 1440, height: 900 },
    storage: rail([], false), prepare: text("Keep it just for me"), crop: async (h) => {
      const l = await h.page.locator('[data-testid="zoom-review-list"]').first().boundingBox();
      return { box: { x: l.x - 16, y: l.y - 124, width: l.width + 32, height: l.height + 140 } };
    } },
  { id: "zoom-card", page: "/integrations/zoom", name: "card", url: `/settings/workspaces/${WS}/integrations/zoom`, viewport: { width: 1440, height: 2000 },
    prepare: text("Meetings go to"), crop: cardOf("Meetings go to", 8) },
  { id: "zoom-me", page: "/integrations/zoom", name: "my-setting", url: "/settings/account", viewport: { width: 1440, height: 2400 },
    prepare: async (h) => { await h.loc('[data-testid="zoom-me"]').waitFor({ timeout: 60_000 }); },
    crop: cardOf("Zoom", 8) },

  // ── HubSpot ──
  { id: "hubspot-card", page: "/integrations/hubspot", name: "card", url: `/settings/workspaces/${WS}/integrations/hubspot`, viewport: { width: 1440, height: 2000 },
    prepare: async (h) => { await h.loc('[data-testid="hubspot-card"]').waitFor({ timeout: 60_000 }); },
    crop: { selector: '[data-testid="hubspot-card"]', pad: 8 } },
  { id: "deals-board", page: "/integrations/hubspot", name: "deals-board", url: `/deals/${WS}?space=team:t_sales`, viewport: { width: 1440, height: 960 },
    storage: rail(["t_sales"]), prepare: async (h) => { await h.loc('[data-testid="deals-section"]').waitFor({ timeout: 60_000 }); },
    crop: main(860) },
  { id: "deals-list", page: "/integrations/hubspot", name: "deals-list", url: `/deals/${WS}?space=team:t_sales`, viewport: { width: 1440, height: 960 },
    storage: { ...rail(["t_sales"]), [`md_deals_view:${WS}`]: JSON.stringify({ view: "list" }) },
    prepare: async (h) => { await h.loc('[data-testid="deals-section"]').waitFor({ timeout: 60_000 }); }, crop: main(900) },
  { id: "deal-page", page: "/integrations/hubspot", name: "deal-page", url: `/deals/${WS}/${D0.id}`, viewport: { width: 1440, height: 1100 },
    storage: rail(["t_sales"]), prepare: async (h) => { await h.loc('[data-testid="deal-page"]').waitFor({ timeout: 60_000 }); await text("Across all calls")(h); },
    crop: main(1040) },
  { id: "deal-calls", page: "/integrations/hubspot", name: "deal-calls", url: `/deals/${WS}/${D0.id}?tab=calls`, viewport: { width: 1440, height: 900 },
    storage: rail(["t_sales"]), prepare: text("Log to HubSpot"), crop: main(760) },
];
