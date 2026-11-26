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
import { page as slackPage } from "./i-slack.mjs";

const PAGE = "/teams/backlog";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SLACK = JSON.parse(readFileSync(path.resolve(HERE, "../slack/payloads.json"), "utf8"));
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

const open = async (h, query = "") => {
  await h.goto(`/${data().slug}?space=team:${data().team}&ws=${h.fx.workspace.id}${query}`);
  await h.loc("[data-testid='backlog-bar']").waitFor({ timeout: 60000 });
  await h.page.getByText("Export usage reports to CSV").first().waitFor({ timeout: 30000 });
};

/** "Share two customer references" back to Medium before the priority clip (the clip makes it Urgent). */
const resetPriority = async (h) => {
  const team = data().team;
  await h.page.evaluate(async ({ api, ws, team }) => {
    const auth = { Authorization: `Bearer ${localStorage.getItem("markdrop_token")}`, "Content-Type": "application/json" };
    const r = await fetch(`${api}/api/v1/workspaces/${ws}/teams/${team}/backlog/items`, { headers: auth });
    const it = (await r.json()).items.find((i) => i.text.startsWith("Share two customer references"));
    if (it && it.priority !== "medium") {
      await fetch(`${api}/api/v1/workspaces/${ws}/teams/${team}/backlog/priorities`, { method: "POST", headers: auth,
        body: JSON.stringify({ changes: [{ id: it.id, priority: "medium" }] }) });
    }
  }, { api: h.fx.api, ws: h.fx.workspace.id, team });
};

export default [
  {
    id: "backlog-filters",
    page: PAGE,
    name: "filters",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1280, height: 1100 },
    prepare: async (h) => {
      await open(h, "&priority=urgent%2Chigh&since=90d&group=priority");
      await reopen(h);
      await h.page.reload();
      await h.loc("[data-testid='backlog-groups']").waitFor({ timeout: 60000 });
      await h.settle(900);
      await h.page.mouse.move(5, 1095);
    },
    crop: { selector: "[data-testid='backlog-bar']", pad: 16 },
  },
  {
    id: "backlog-slack",
    page: PAGE,
    name: "slack",
    kind: "screenshot",
    auth: "anon",
    url: "/robots.txt",
    viewport: { width: 760, height: 900 },
    prepare: async (h) => {
      const theme = await h.page.evaluate(() => localStorage.getItem("md_theme") || "light");
      await h.page.setContent(slackPage({ ...SLACK.backlog_priorities }, theme), { waitUntil: "load" });
      await h.page.evaluate(() => document.fonts && document.fonts.ready);
      await h.sleep(200);
    },
    crop: { selector: ".illus", pad: 0 },
  },
  {
    id: "backlog-priorities",
    page: PAGE,
    name: "priorities",
    kind: "clip",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1280, height: 860 },
    themes: ["light", "dark"],
    tail: 400,
    prepare: async (h) => {
      await open(h);
      await resetPriority(h);
      await h.page.reload();
      await h.loc("[data-testid='backlog-bar']").waitFor({ timeout: 60000 });
      await h.settle(600);
      await h.page.mouse.move(640, 420);
    },
    steps: async (h) => {
      await h.sleep(500);
      const prio = (name) => h.page.locator("[data-testid='backlog-priorities'] .bl-chip", { hasText: name }).first();
      await h.click(prio("Urgent"));
      await h.sleep(700);
      await h.click(prio("High"));
      await h.sleep(1100);
      await h.page.getByTestId("backlog-since").selectOption("30d");
      await h.sleep(1100);
      await h.click(prio("Urgent"));
      await h.click(prio("High"));
      await h.page.getByTestId("backlog-since").selectOption("");
      await h.sleep(500);
      await h.page.getByTestId("backlog-group").selectOption("priority");
      await h.loc("[data-testid='backlog-groups']").waitFor({ timeout: 10000 });
      await h.sleep(1200);
      const item = h.page.locator("[data-testid='backlog-group-item']", { hasText: "Share two customer references" }).first();
      await item.scrollIntoViewIfNeeded();
      await h.sleep(400);
      await h.click(item.getByTestId("backlog-prio"));
      await h.sleep(600);
      await h.click(h.page.getByRole("menuitem", { name: "Urgent" }).first());
      await h.sleep(2200);
    },
  },
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
