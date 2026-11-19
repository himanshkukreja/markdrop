/**
 * Docs media: the team backlog (/teams/backlog). Shot format: ../shots.mjs.
 *
 * The demo world (seed.py) plus backlog_setup.py: Sales (Riya lead, Alex member), three calls (Northwind renewal,
 * Globex intro, Q4 pipeline review) and the "Sales — Backlog" page sorted into categories.
 *
 *   STACK_ID=9 backend/.venv/bin/python frontend/scripts/docs-media/seed.py
 *   STACK_ID=9 backend/.venv/bin/python frontend/scripts/docs-media/backlog_setup.py
 *   STACK_ID=9 npm run docs:media -- backlog-page backlog-fill
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PAGE = "/teams/backlog";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STACK_ID = Number(process.env.STACK_ID || 0);
const data = () => JSON.parse(readFileSync(path.join(process.env.DOCS_MEDIA_DATA || path.join(HERE, "..", ".data"),
  STACK_ID ? String(STACK_ID) : "", "backlog.json"), "utf8"));

/** Every theme starts from the same list: "Send the renewal pricing deck" open again (the call's item too). */
const reopen = async (h) => {
  const team = data().team;
  await h.page.evaluate(async ({ api, ws, team }) => {
    const auth = { Authorization: `Bearer ${localStorage.getItem("markdrop_token")}`, "Content-Type": "application/json" };
    const r = await fetch(`${api}/api/v1/workspaces/${ws}/teams/${team}/backlog/items`, { headers: auth });
    const it = (await r.json()).items.find((i) => i.text.startsWith("Send the renewal pricing deck"));
    if (it && it.status !== "open") await fetch(`${api}/api/v1/backlog/items/${it.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ status: "open" }) });
  }, { api: h.fx.api, ws: h.fx.workspace.id, team });
};

const open = async (h) => {
  await h.goto(`/${data().slug}?space=team:${data().team}&ws=${h.fx.workspace.id}`);
  await h.loc("[data-testid='backlog-bar']").waitFor({ timeout: 60000 });
  await h.page.getByText("Export usage reports to CSV").first().waitFor({ timeout: 30000 });
};

export default [
  {
    id: "backlog-page",
    page: PAGE,
    name: "page",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1280, height: 1000 },
    prepare: async (h) => {
      await open(h);
      await reopen(h);
      await h.page.reload();
      await h.loc("[data-testid='backlog-bar']").waitFor({ timeout: 60000 });
      await h.settle(900);
      await h.page.mouse.move(5, 995);
    },
    crop: async (h) => {
      const bar = await h.loc("[data-testid='backlog-bar']").boundingBox();
      const y = Math.max(0, (bar?.y ?? 200) - 120);
      return { box: { x: 0, y, width: 1280, height: Math.min(1000 - y, 860) } };
    },
  },
  {
    id: "backlog-fill",
    page: PAGE,
    name: "fill",
    kind: "clip",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1280, height: 800 },
    themes: ["light", "dark"],
    tail: 400,
    prepare: async (h) => {
      await open(h);
      await reopen(h);
      await h.page.reload();
      await h.loc("[data-testid='backlog-bar']").waitFor({ timeout: 60000 });
      await h.settle(600);
      await h.page.mouse.move(640, 420);
    },
    steps: async (h) => {
      await h.sleep(500);
      const chip = (name) => h.page.locator("[data-testid='backlog-bar'] .bl-chip", { hasText: name }).first();
      await h.click(chip("Bug"));
      await h.sleep(900);
      await h.click(chip("Feature request"));
      await h.sleep(900);
      await h.type(h.page.getByTestId("backlog-search"), "csv");
      await h.sleep(1400);
      await h.click(h.page.getByRole("button", { name: "Clear filters" }));
      await h.sleep(900);
      const line = h.page.locator("li:visible", { hasText: "Send the renewal pricing deck" }).first();
      await line.scrollIntoViewIfNeeded();
      await h.sleep(500);
      await h.click(line.locator("input[type='checkbox']").first());
      await h.sleep(1500);
      const link = h.page.locator("li:visible", { hasText: "Send the renewal pricing deck" }).first()
        .locator(`a[href^="/${data().meetings["Northwind renewal call"]}"]`).first();
      // The link wraps onto two lines: aim at its first letters, not its middle.
      const box = await link.boundingBox();
      if (box) await h.page.mouse.move(box.x + 8, box.y + 6, { steps: 12 });
      await h.sleep(300);
      await link.evaluate((a) => a.click());
      await h.page.waitForURL((u) => u.pathname.includes(data().meetings["Northwind renewal call"]), { timeout: 15000 });
      await h.page.getByText("Action items").first().waitFor({ timeout: 20000 });
      await h.settle(500);
      await h.sleep(1800);
    },
  },
];
