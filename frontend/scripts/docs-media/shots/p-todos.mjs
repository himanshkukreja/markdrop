/**
 * Docs media: personal to-do pages (/teams/to-dos). Shot format: ../shots.mjs.
 *
 * The Teams docs world (n-teams.mjs: teams-docs-setup.mjs) plus e2e/pages/real/todos-docs-setup.mjs: Alex Chen's
 * to-do page in Sales from two customer calls (Northwind, Globex) and the "Q4 renewals tracker" page's tasks, and one
 * page task his page hasn't seen yet (so Refresh adds it).
 *
 *   STACK_ID=… DOCS_MEDIA_DATA=$PB_WORK/stack/data npm run docs:media -- todos-page todos-refresh todos-create-clip
 * (todos-create-clip last: it gives Alex a new to-do page.)
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PAGE = "/teams/to-dos";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PY = path.resolve(HERE, "../../../../backend/.venv/bin/python");
const DB = Number(process.env.STACK_ID || 0) ? `markdrop_docs_demo_${process.env.STACK_ID}` : "markdrop_docs_demo";

/** Alex's page forgets the last page task again, so every theme's Refresh adds one. */
const forgetLastTask = (h) => execFileSync(PY, ["-c", `import pymongo
c = pymongo.MongoClient("mongodb://127.0.0.1:27019")["${DB}"]
d = c["documents"].find_one({"slug": "${h.fx.todos.alex}"})
c["todo_items"].delete_many({"todo_doc_id": d["_id"], "block": "b-td0004"})`], { encoding: "utf8" });

/** Alex has no to-do page in Sales yet (the clip's "Create my to-dos" makes a fresh one each theme). */
const noPageYet = (h) => execFileSync(PY, ["-c", `import pymongo
c = pymongo.MongoClient("mongodb://127.0.0.1:27019")["${DB}"]
c["todo_pages"].delete_many({"user_id": "${h.fx.users.member.id}", "team_id": "${h.fx.teams.sales.id}"})`], { encoding: "utf8" });

export default [
  {
    id: "todos-page",
    page: PAGE,
    name: "page",
    kind: "screenshot",
    auth: "member",
    url: "/dashboard",
    viewport: { width: 1280, height: 900 },
    prepare: async (h) => {
      await h.goto(`/${h.fx.todos.alex}`);
      await h.page.getByText("From the team's pages").first().waitFor({ timeout: 30000 });
      await h.settle(800);
      await h.page.mouse.move(5, 895);
    },
    crop: async (h) => {
      const title = await h.page.getByText("Alex Chen — To-dos").first().boundingBox();
      const end = await h.page.getByText("Markdrop keeps the section above").first().boundingBox();
      const y = Math.max(0, (title?.y ?? 80) - 24);
      return { box: { x: 0, y, width: 1280, height: Math.min(900 - y, (end ? end.y + end.height : 860) - y + 24) } };
    },
  },
  {
    id: "todos-refresh",
    page: PAGE,
    name: "refresh",
    kind: "screenshot",
    auth: "member",
    url: "/dashboard",
    viewport: { width: 1280, height: 760 },
    prepare: async (h) => {
      forgetLastTask(h);
      await h.goto(`/w/${encodeURIComponent(h.fx.workspace.id)}/teams/${h.fx.teams.sales.slug}`);
      await h.loc("[data-testid='team-home']").waitFor({ timeout: 30000 });
      const btn = h.page.getByTestId("todos-refresh");
      await btn.waitFor({ timeout: 30000 });
      await btn.click();
      await h.page.locator(".md-toast").last().waitFor({ timeout: 20000 });
      await h.page.mouse.move(640, 400);
      await h.settle(400);
    },
    crop: "viewport",
  },
  {
    id: "todos-create-clip",
    page: PAGE,
    name: "create",
    kind: "clip",
    auth: "member",
    url: "/dashboard",
    viewport: { width: 1200, height: 720 },
    themes: ["light", "dark"],
    tail: 400,
    prepare: async (h) => {
      noPageYet(h);
      await h.goto(`/w/${encodeURIComponent(h.fx.workspace.id)}/teams/${h.fx.teams.sales.slug}`);
      await h.loc("[data-testid='team-home']").waitFor({ timeout: 30000 });
      await h.page.waitForFunction(() => document.querySelector("[data-testid='todos-refresh']")?.textContent?.trim() === "Create my to-dos",
        null, { timeout: 30000 });
      await h.settle(500);
      await h.page.mouse.move(600, 420);
    },
    steps: async (h) => {
      await h.sleep(250);
      await h.click(h.page.getByTestId("todos-refresh"));
      const toast = h.page.locator(".md-toast").last();
      await toast.waitFor({ timeout: 20000 });
      await h.sleep(1100);
      await h.click(toast.getByRole("button", { name: "Open" }));
      await h.page.getByText("From the team's pages").first().waitFor({ timeout: 30000 });
      await h.settle(300);
      await h.sleep(300);
      await h.wheel(260);
      await h.sleep(900);
      const link = h.page.getByRole("link", { name: /Northwind renewal call/ }).first();
      await h.hover(link, 350);
      await h.click(link);
      await h.page.waitForURL((u) => u.hash.startsWith("#b-"), { timeout: 20000 }).catch(() => {});
      await h.settle(400);
      await h.sleep(1200);
    },
  },
];
