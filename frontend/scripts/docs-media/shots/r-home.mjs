/**
 * Docs media: the customizable Home (/workspaces/customize-home). Shot format: ../shots.mjs.
 *
 * The demo world (seed.py) plus backlog_setup.py (Sales with three calls and its backlog), so the Meetings,
 * Team backlog and to-do cards have something in them.
 *
 *   STACK_ID=9 backend/.venv/bin/python frontend/scripts/docs-media/seed.py
 *   STACK_ID=9 backend/.venv/bin/python frontend/scripts/docs-media/backlog_setup.py
 *   STACK_ID=9 npm run docs:media -- home-default home-customize home-clip
 */
const PAGE = "/workspaces/customize-home";

/** Riya's Home for Acme set from here (null: back to Default), and the sidebar on Acme. */
const layout = async (h, body) => {
  await h.page.evaluate(async ({ api, ws, body }) => {
    localStorage.setItem("md_rail_ws", ws);
    localStorage.removeItem("md_home_layout_v1");
    const auth = { Authorization: `Bearer ${localStorage.getItem("markdrop_token")}`, "Content-Type": "application/json" };
    if (body) await fetch(`${api}/api/v1/me/dashboard`, { method: "PUT", headers: auth, body: JSON.stringify({ workspace: ws, ...body }) });
    else await fetch(`${api}/api/v1/me/dashboard?workspace=${ws}`, { method: "DELETE", headers: auth });
  }, { api: h.fx.api, ws: h.fx.workspace.id, body });
};

const open = async (h) => {
  await h.page.reload();
  await h.loc("[data-testid='home-dashboard']:not([data-source='loading'])").waitFor({ timeout: 60000 });
  await h.loc("[data-testid='home-meetings-list'], [data-testid='home-w-meetings']").first().waitFor({ timeout: 30000 }).catch(() => {});
  await h.settle(1200);
  await h.page.mouse.move(5, 5);
};

export default [
  {
    id: "home-default",
    page: PAGE,
    name: "default",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1440, height: 1000 },
    prepare: async (h) => { await layout(h, null); await open(h); },
    crop: { union: [".hm-hello", "[data-testid='home-dashboard']"], pad: 16 },
  },
  {
    id: "home-customize",
    page: PAGE,
    name: "edit",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1440, height: 1000 },
    prepare: async (h) => {
      await layout(h, { preset: "sales" });
      await open(h);
      await h.loc("[data-testid='home-customize']").click();
      await h.settle(700);
    },
    crop: { selector: "[data-testid='home-dashboard']", pad: 12 },
  },
  {
    id: "home-clip",
    page: PAGE,
    name: "customize",
    kind: "clip",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1280, height: 800 },
    themes: ["light", "dark"],
    tail: 400,
    prepare: async (h) => {
      await layout(h, { main: [{ type: "recent" }, { type: "workspaces" }], side: [{ type: "needs_you" }, { type: "todos" }] });
      await open(h);
      await h.page.mouse.move(640, 300);
    },
    steps: async (h) => {
      await h.sleep(300);
      await h.click(h.page.getByTestId("home-customize"));
      await h.sleep(400);
      await h.click(h.page.getByTestId("home-add-side"));
      await h.sleep(500);
      await h.click(h.page.getByTestId("home-pick-meetings"));
      await h.sleep(600);
      const meet = h.page.locator("[data-testid='home-widget'][data-widget='meetings']");
      await h.click(meet.getByTestId("home-w-across"));
      await h.sleep(500);
      await h.click(meet.getByTestId("home-w-up"));
      await h.sleep(700);
      await h.click(h.page.getByTestId("home-templates"));
      await h.sleep(400);
      await h.click(h.page.getByRole("menuitem", { name: /Sales/ }));
      await h.page.locator("[data-testid='home-w-backlog']").waitFor({ timeout: 20000 });
      await h.sleep(500);
      await h.click(h.page.getByTestId("home-customize-done"));
      await h.settle(400);
      await h.sleep(1000);
    },
  },
];
