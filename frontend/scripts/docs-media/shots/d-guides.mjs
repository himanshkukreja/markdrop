/**
 * Docs media, group D: the Markdrop Guides tab of docs.markdrop.in (/guides/**). Shot format:
 * ../shots.mjs. Extra seed data: ../seed_extra_studio.py (run it after seed.py, with the whole stack
 * up: Markdrop Guides publishes here are real builds, served at http://<slug>.guides.markdrop.in:<3405+10N>).
 *
 * No shot id or asset path may contain the letters g-i-t (a command guard on the capture machine
 * refuses any command line with them): the GitBook import and GitHub sync shots write to
 * guides/import/ and guides/repo-sync/ through `dir`.
 *
 *   STACK_ID=13 npm run docs:media -- $(npm run -s docs:media -- --list | awk '/ \/guides\//{print $1}')
 *
 * The world: Acme (Riya owner, Maya admin → Guides admins; Noah reviewer; Alex editor, Viewer
 * on Acme Developers; Sam viewer; Priya no workspace-wide role, Editor on the Help Center; Omar no
 * access) with three sites: Acme (live, 4 publishes, Alex's unpublished edits), Acme Help Center
 * (reviews required, Priya's open review), Acme Developers (a GitBook import, not published). Jordan's
 * personal "acme-themes" copy is what the Themes shots republish in each preset. The videos and a few
 * shots create sites in the empty Northwind workspace and drop them afterwards.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEDIA = path.resolve(HERE, "..");
const REPO = path.resolve(MEDIA, "../../..");
const STACK_ID = Number(process.env.STACK_ID || 0);
const DATA = path.join(process.env.DOCS_MEDIA_DATA || path.join(MEDIA, ".data"), STACK_ID ? String(STACK_ID) : "");
const PY = process.env.DOCS_MEDIA_PYTHON || path.join(REPO, "backend/.venv/bin/python");
const EXTRA = path.join(MEDIA, "seed_extra_studio.py");

/** Ids seed_extra_studio.py wrote (it runs once when they're missing). */
function fxS() {
  const file = path.join(DATA, "fixtures_studio.json");
  if (!existsSync(file)) extra();
  return JSON.parse(readFileSync(file, "utf8"));
}

function extra(...args) {
  const r = spawnSync(PY, [EXTRA, ...args], { env: { ...process.env, STACK_ID: String(STACK_ID) }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`seed_extra_studio.py ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** Calls the sandbox API as a demo user. */
async function api(h, method, p, body, who = "riya") {
  const { token } = await h.sandbox("/__sandbox/mint", { email: h.fx.users[who].email });
  const res = await fetch(`${h.API}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

const S = (h, path = "") => `/guides/${fxS().acme}${path}`;
const site = (key) => (h, p = "") => `/guides/${fxS()[key]}${p}`;
const HELP = site("help");
const DEV = site("developers");
const northwind = (h) => h.fx.northwind.id;

/** The id of a page of a site, by path. */
async function pageId(h, key, p, who = "riya") {
  const { pages } = await api(h, "GET", `/api/v1/docs-sites/${fxS()[key]}/pages`, null, who);
  const hit = pages.find((x) => x.path === p);
  if (!hit) throw new Error(`no page ${p}`);
  return hit.id;
}

const settle = async (h, ms = 700) => {
  await h.settle(ms);
  await h.page.mouse.move(5, 5);
};
const vis = (h, text) => h.page.getByText(text, { exact: true }).filter({ visible: true }).first();

/** Mark an element (found in the page) so a crop can use it as a selector. */
async function mark(h, name, fn, arg) {
  const handle = await h.page.evaluateHandle(fn, arg);
  const el = handle.asElement();
  if (!el) throw new Error(`mark ${name}: not found`);
  await el.evaluate((e, n) => e.setAttribute("data-mdcap", n), name);
  return `[data-mdcap="${name}"]`;
}

/** Wait for the editor to have the page open for editing (lock taken, content rendered). */
async function editorReady(h) {
  await h.loc(".dxe-content").waitFor({ timeout: 60_000 });
  await h.page.getByText("Opening for editing…").waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
  // The page opens read-only and becomes editable once the lock is ours (owners and editors).
  await h.page.locator(".dxe-content[contenteditable=true]").waitFor({ timeout: 15_000 }).catch(() => {});
  await h.sleep(600);
}

/** Where to click to put the caret at the end of the first paragraph (just after its last letter). */
async function endOfFirstParagraph(h) {
  const p = h.page.locator(".dxe-content p").first();
  await p.scrollIntoViewIfNeeded();
  return p.evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const rects = [...r.getClientRects()];
    const last = rects[rects.length - 1];
    return [last.right - 1, last.top + last.height / 2];
  });
}

/** The newest build of a site, waiting while one runs. */
async function waitLive(h, key, who = "riya", timeout = 240_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const builds = await api(h, "GET", `/api/v1/docs-sites/${fxS()[key]}/builds`, null, who);
    if (builds.length && !["queued", "building", "publishing"].includes(builds[0].status)) return builds[0];
    await h.sleep(1500);
  }
  throw new Error(`no build finished on ${key}`);
}

/** acme-themes in a preset, published (skipped when it already is). */
async function themeSite(h, preset) {
  const id = fxS().themes;
  const s = await api(h, "GET", `/api/v1/docs-sites/${id}`, null, "jordan");
  const changes = await api(h, "GET", `/api/v1/docs-sites/${id}/changes`, null, "jordan");
  if (s.settings.theme.preset === preset && s.status === "live" && changes.count === 0) return;
  if (s.settings.theme.preset !== preset) {
    await api(h, "PATCH", `/api/v1/docs-sites/${id}`, { settings: { theme: { preset } } }, "jordan");
  }
  await api(h, "POST", `/api/v1/docs-sites/${id}/publish`, { note: `Theme: ${preset}` }, "jordan");
  await waitLive(h, "themes", "jordan");
}

/** An open review on the Help Center (Priya's), made again when a shot approved the last one. */
async function ensureReview(h) {
  const hid = fxS().help;
  const open = await api(h, "GET", `/api/v1/docs-sites/${hid}/reviews?status=open`, null, "priya");
  if (open.length) return;
  const pid = await pageId(h, "help", "/billing/refunds", "priya");
  const page = await api(h, "GET", `/api/v1/docs-sites/${hid}/pages/${pid}`, null, "priya");
  const md = page.markdown.includes("in 5 to 10 working days")
    ? page.markdown.replace("in 5 to 10 working days", "within 10 working days")
    : page.markdown.replace("within 10 working days", "in 5 to 10 working days");
  await api(h, "PUT", `/api/v1/docs-sites/${hid}/pages/${pid}`, { base_rev: page.rev, markdown: md, title: page.title, description: page.description }, "priya");
  await api(h, "DELETE", `/api/v1/docs-sites/${hid}/pages/${pid}/lock`, null, "priya");
  await api(h, "POST", `/api/v1/docs-sites/${hid}/reviews`, { note: "Annual plans: the refund window is now 90 days (was 60), per Finance. Also added what to do if you lose your phone." }, "priya");
}

// ── Ask AI on a published site: a scripted answer stream, no model call ─────────

function stubAskAi() {
  const realFetch = window.fetch.bind(window);
  const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const base = location.origin;
  const answer = [
    "Give Acme a read-only Postgres user, then add the source with the CLI [S1]:\n\n",
    "1. Create a role like `acme_reader` that can only `SELECT` [S1].\n",
    "2. Run `acme sources add postgres` with your host and that user. The CLI asks for the password and never echoes it [S1].\n",
    "3. Check it with `acme sources test postgres`: a good connection lists the tables Acme can read [S1].\n\n",
    "Allow Acme's addresses in your firewall first, or the first check times out [S2].",
  ];
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/api/v1/docs/ai/status")) {
      return new Response(JSON.stringify({ available: true }), { headers: { "content-type": "application/json" } });
    }
    if (url.includes("/api/v1/docs/ask") && !url.includes("feedback")) {
      const enc = new TextEncoder();
      const chunks = [];
      chunks.push([200, sse("status", { phase: "searching", label: "Searching the docs…" })]);
      chunks.push([450, sse("status", { phase: "reading", label: "Reading Connect Postgres…" })]);
      chunks.push([300, sse("citations", { sources: [
        { n: 1, id: "S1", title: "Create a read-only user", section: "Create a read-only user", page: "/guides/connect-postgres", page_title: "Connect Postgres", url: `${base}/guides/connect-postgres#create-a-read-only-user` },
        { n: 2, id: "S2", title: "Add the source", section: "Add the source", page: "/guides/connect-postgres", page_title: "Connect Postgres", url: `${base}/guides/connect-postgres#add-the-source` },
      ] })]);
      for (const part of answer) for (const w of part.match(/\S+\s*/g)) chunks.push([20, sse("delta", { text: w })]);
      chunks.push([200, sse("done", { request_id: "req_demo", outcome: "answered", conversation_id: "conv_demo" })]);
      const body = new ReadableStream({
        async start(ctrl) {
          for (const [ms, c] of chunks) {
            await new Promise((r) => setTimeout(r, ms));
            ctrl.enqueue(enc.encode(c));
          }
          ctrl.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    return realFetch(input, init);
  };
}

/** A page's draft as it was before a shot typed into it, put back afterwards (and its lock let go). */
const kept = new Map();
async function keepPage(h, key, p) {
  const id = fxS()[key];
  const pid = await pageId(h, key, p);
  const page = await api(h, "GET", `/api/v1/docs-sites/${id}/pages/${pid}`);
  kept.set(`${key}:${p}`, { id, pid, markdown: page.markdown, title: page.title, description: page.description });
  return pid;
}
async function restorePage(h, key, p) {
  const k = kept.get(`${key}:${p}`);
  if (!k) return;
  await h.page.goto("about:blank").catch(() => {}); // the editor lets go of the page (and stops autosaving)
  await h.sleep(800);
  await api(h, "DELETE", `/api/v1/docs-sites/${k.id}/pages/${k.pid}/lock`).catch(() => {});
  const page = await api(h, "GET", `/api/v1/docs-sites/${k.id}/pages/${k.pid}`);
  if (page.markdown !== k.markdown) {
    await api(h, "PUT", `/api/v1/docs-sites/${k.id}/pages/${k.pid}`, { base_rev: page.rev, markdown: k.markdown, title: k.title, description: k.description });
    await api(h, "DELETE", `/api/v1/docs-sites/${k.id}/pages/${k.pid}/lock`).catch(() => {});
  }
}

let importProc = null;
function playImport() {
  importProc = spawn(PY, [EXTRA, "--import-run", "--slow"], { env: { ...process.env, STACK_ID: String(STACK_ID) }, stdio: "ignore" });
}
async function waitImport() {
  if (!importProc) return;
  const p = importProc;
  importProc = null;
  if (p.exitCode != null) return;
  await new Promise((r) => p.on("exit", r));
}

const P = (name) => `/guides/${name}`;

export default [
  // ════════════════════════════════════════════════════════════════════════════
  // Overview
  // ════════════════════════════════════════════════════════════════════════════
  {
    id: "studio-home",
    page: P("overview"),
    kind: "screenshot",
    auth: "owner",
    url: "/guides",
    viewport: { width: 1440, height: 1200 },
    prepare: async (h) => {
      await h.loc({ role: "heading", name: "Your guides" }).waitFor();
      await h.loc("article").first().waitFor();
      // The 7-day numbers load after the cards.
      await h.page.waitForFunction(() => !document.querySelector('[aria-label="Loading numbers"]'), null, { timeout: 15_000 });
      await settle(h);
    },
    // The 7-day tiles, the filters and the guides (not the header, title or plan card).
    crop: () => ({ union: [{ css: 'section[aria-label="Across your guides, last 7 days"]' }, { css: 'section[aria-labelledby="list-h"]' }], pad: 20 }),
  },

  // ════════════════════════════════════════════════════════════════════════════
  // Create a site
  // ════════════════════════════════════════════════════════════════════════════
  {
    id: "new-site-template",
    page: P("create-a-site"),
    kind: "screenshot",
    auth: "owner",
    url: (fx) => `/guides/new?ws=${fx.northwind.id}`,
    viewport: { width: 1280, height: 900 },
    prepare: async (h) => {
      await h.loc({ role: "heading", name: "New guide" }).waitFor();
      await vis(h, "From a template").click();
      await vis(h, "Product guide").click();
      await h.loc({ placeholder: "Acme Help Center" }).fill("Northwind Help");
      await h.page.getByText("Available.").waitFor({ timeout: 15_000 }).catch(() => {});
      await settle(h);
    },
    crop: async (h) => ({ union: [{ css: "main form > section" }, { css: "main form > div:last-child" }], pad: 16 }),
  },
  {
    id: "new-site-address-taken",
    page: P("create-a-site"),
    kind: "screenshot",
    auth: "owner",
    url: (fx) => `/guides/new?ws=${fx.northwind.id}`,
    viewport: { width: 1280, height: 900 },
    prepare: async (h) => {
      await h.loc({ role: "heading", name: "New guide" }).waitFor();
      await vis(h, "Blank guide").click();
      await h.loc({ placeholder: "Acme Help Center" }).fill("Acme");
      await h.page.getByText("That address is taken.").waitFor({ timeout: 15_000 });
      await settle(h);
    },
    crop: async (h) => {
      const sel = await mark(h, "name-addr", () => [...document.querySelectorAll("main h2")].find((e) => e.textContent.trim() === "Name and address")?.closest("section"));
      return { selector: sel, pad: 16 };
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // Import from GitBook
  // ════════════════════════════════════════════════════════════════════════════
  {
    id: "import-form",
    page: P("import-from-gitbook"),
    dir: "guides/import",
    kind: "screenshot",
    auth: "owner",
    url: (fx) => `/guides/new?ws=${fx.northwind.id}`,
    viewport: { width: 1280, height: 900 },
    prepare: async (h) => {
      await h.loc({ role: "heading", name: "New guide" }).waitFor();
      await vis(h, "Import from GitBook").click();
      await h.loc({ placeholder: "https://docs.acme.com" }).fill("https://northwind.gitbook.io/docs");
      await h.loc({ placeholder: "Acme Help Center" }).fill("Northwind Help");
      await h.page.getByText("Available.").waitFor({ timeout: 15_000 }).catch(() => {});
      await settle(h);
    },
    crop: async (h) => {
      const a = await mark(h, "src", () => document.querySelector("main form fieldset"));
      const b = await mark(h, "gb", () => [...document.querySelectorAll("main h2")].find((e) => e.textContent.trim() === "Your GitBook site")?.closest("section"));
      return { union: [a, b], pad: 16 };
    },
  },
  {
    id: "import-report",
    page: P("import-from-gitbook"),
    dir: "guides/import",
    kind: "screenshot",
    auth: "owner",
    url: (fx) => DEV(null, "/import"),
    prepare: async (h) => {
      await h.loc({ role: "heading", name: "Your pages are here" }).waitFor({ timeout: 30_000 });
      await h.loc({ role: "button", name: "Show links" }).click();
      await settle(h);
    },
    crop: { selector: "main", pad: 0 },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // GitHub sync (coming soon)
  // ════════════════════════════════════════════════════════════════════════════
  {
    id: "repo-coming-soon",
    page: P("github-sync"),
    dir: "guides/repo-sync",
    kind: "screenshot",
    auth: "owner",
    url: (fx) => `/guides/new?ws=${fx.northwind.id}`,
    viewport: { width: 1280, height: 900 },
    prepare: async (h) => {
      await h.loc({ role: "heading", name: "New guide" }).waitFor();
      await vis(h, "Connect a GitHub repo").click();
      await settle(h);
    },
    crop: async (h) => {
      const a = await mark(h, "src", () => document.querySelector("main form fieldset"));
      const b = await mark(h, "gh", () => [...document.querySelectorAll("main h2")].find((e) => e.textContent.trim() === "GitHub repository")?.closest("section"));
      return { union: [a, b], pad: 16 };
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // The editor
  // ════════════════════════════════════════════════════════════════════════════
  {
    id: "editor-overview",
    page: P("editor"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(`${S(h)}?page=${await pageId(h, "acme", "/getting-started/quickstart")}`);
      await editorReady(h);
      await settle(h, 900);
    },
    crop: "viewport",
  },
  {
    id: "editor-slash-callout",
    page: P("editor"),
    kind: "clip",
    auth: "owner",
    url: null,
    viewport: { width: 1280, height: 760 },
    out: 1440,
    prepare: async (h) => {
      await h.goto(`${S(h)}?page=${await keepPage(h, "acme", "/guides/invite-your-team")}`);
      await editorReady(h);
      await h.page.locator(".dxe-content p").first().scrollIntoViewIfNeeded();
    },
    steps: async (h) => {
      await h.click(await endOfFirstParagraph(h), { after: 300 });
      await h.press("Enter", 300);
      await h.type(null, "/", { speed: 1 });
      await h.sleep(700);
      await h.type(null, "tip", { speed: 0.8 });
      await h.sleep(800);
      await h.press("Enter", 600);
      await h.type(null, "Invite people before you share a dashboard: they get the link in the same email.", { speed: 2.2 });
      await h.sleep(1600);
    },
    after: async (h) => restorePage(h, "acme", "/guides/invite-your-team"),
    trim: { start: 0.6 },
    tail: 500,
    poster: 6,
  },
  {
    id: "editor-markdown",
    page: P("editor"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.page.addInitScript(() => localStorage.setItem("md_docs_editor_mode", "markdown"));
      await h.goto(`${S(h)}?page=${await pageId(h, "acme", "/getting-started/quickstart")}`);
      await h.loc("main textarea, main .cm-editor").first().waitFor({ timeout: 60_000 });
      await settle(h, 900);
    },
    crop: { selector: "main#main", pad: 0, maxHeight: 720 },
    after: async (h) => {
      await h.page.evaluate(() => localStorage.setItem("md_docs_editor_mode", "visual")).catch(() => {});
    },
  },
  {
    id: "image-block",
    page: P("editor"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(`${DEV(h)}?page=${await pageId(h, "developers", "/getting-started/authentication")}`);
      await editorReady(h);
      const fig = h.page.locator(".dxe-figure").first();
      await fig.scrollIntoViewIfNeeded();
      await fig.locator("img").first().click();
      await h.sleep(500);
      await h.page.mouse.move(5, 5);
    },
    crop: async (h) => ({ selector: ".dxe-figure", pad: 16 }),
  },
  {
    id: "page-locked",
    page: P("editor"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      const id = fxS().acme;
      const pid = await pageId(h, "acme", "/guides/connect-postgres");
      await api(h, "POST", `/api/v1/docs-sites/${id}/pages/${pid}/lock`, null, "alex");
      await h.goto(`${S(h)}?page=${pid}`);
      await h.page.getByText("Alex Chen is editing this page").waitFor({ timeout: 30_000 });
      await settle(h);
    },
    crop: async (h) => ({ box: { x: 0, y: 56, width: 1140, height: 470 } }),
    after: async (h) => {
      const id = fxS().acme;
      const pid = await pageId(h, "acme", "/guides/connect-postgres");
      await api(h, "DELETE", `/api/v1/docs-sites/${id}/pages/${pid}/lock`, null, "alex");
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // Pages and navigation
  // ════════════════════════════════════════════════════════════════════════════
  {
    id: "page-tree",
    page: P("pages-and-navigation"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(`${S(h)}?page=${await pageId(h, "acme", "/guides/alert-rules")}`);
      await editorReady(h);
      const row = h.page.locator("nav[aria-label=Pages] div.group\\/row", { hasText: "Alert rules" }).first();
      await row.hover();
      await row.getByRole("button", { name: /More for Alert rules/ }).click();
      await h.sleep(500);
    },
    crop: async (h) => ({ box: { x: 0, y: 108, width: 360, height: 700 } }),
  },
  {
    id: "new-page-dialog",
    page: P("pages-and-navigation"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(`${S(h)}?page=${await pageId(h, "acme", "/guides/alert-rules")}`);
      await editorReady(h);
      await h.loc({ role: "button", name: "New page" }).first().click();
      await h.loc({ placeholder: "Alert rules" }).fill("Slack notifications");
      await h.sleep(600);
    },
    crop: { selector: "[role=dialog]", pad: 0 },
  },
  {
    id: "page-settings",
    page: P("pages-and-navigation"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(`${S(h)}?page=${await pageId(h, "acme", "/getting-started/quickstart")}`);
      await editorReady(h);
      await h.page.getByText("See all versions").waitFor();
      await settle(h);
    },
    crop: { selector: "aside[aria-label='Page settings']", pad: 0, maxHeight: 520 },
  },
  {
    id: "redirects",
    page: P("pages-and-navigation"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(S(h, "/settings"));
      const card = h.page.locator("#redirects");
      await card.scrollIntoViewIfNeeded();
      await card.getByRole("button", { name: "Add a redirect" }).click();
      await card.getByLabel("Old address 1").fill("/guides/postgres");
      await card.getByLabel("Goes to 1").fill("/guides/connect-postgres");
      await card.getByRole("button", { name: "Add a redirect" }).click();
      await card.getByLabel("Old address 2").fill("/setup");
      await card.getByLabel("Goes to 2").fill("/getting-started/install");
      await h.sleep(500);
      await h.page.mouse.move(5, 5);
    },
    crop: { selector: "#redirects", pad: 0 },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // History and versions
  // ════════════════════════════════════════════════════════════════════════════
  {
    id: "versions-drawer",
    page: P("history"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(`${S(h)}?page=${await pageId(h, "acme", "/getting-started/quickstart")}`);
      await editorReady(h);
      await h.page.getByText("See all versions").click();
      await h.loc({ role: "dialog" }).waitFor();
      await h.sleep(700);
    },
    crop: { selector: "[role=dialog]", pad: 0, maxHeight: 430 },
  },
  {
    id: "publishes-list",
    page: P("history"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(S(h, "/publish"));
      await h.loc({ role: "heading", name: "Publishes" }).waitFor();
      await h.page.getByText("First version").waitFor();
      await settle(h);
    },
    crop: async (h) => {
      const sel = await mark(h, "hist", () => document.querySelector("main section:last-of-type"));
      return { selector: sel, pad: 12 };
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // Themes: the published site in each preset (Jordan's acme-themes copy)
  // ════════════════════════════════════════════════════════════════════════════
  ...["clean", "editorial", "technical", "minimal", "playful", "helpcenter"].map((preset) => ({
    id: `theme-${preset}`,
    page: P("themes"),
    kind: "screenshot",
    auth: "jordan",
    url: null,
    viewport: { width: 1440, height: 860 },
    prepare: async (h) => {
      await themeSite(h, preset);
      await h.goto(h.studioSite("acme-themes", preset === "helpcenter" ? "/" : "/getting-started/quickstart"), { settle: 1200 });
      await h.page.mouse.move(5, 5);
    },
    crop: "viewport",
  })),
  {
    id: "design-panel",
    page: P("themes"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(S(h, "/design"));
      await h.loc({ role: "heading", name: "Match my brand" }).waitFor();
      await settle(h, 1200);
    },
    crop: { box: { x: 0, y: 56, width: 1440, height: 760 } },
  },
  {
    id: "design-switch-themes",
    page: P("themes"),
    kind: "clip",
    auth: "owner",
    url: null,
    viewport: { width: 1440, height: 820 },
    out: 1440,
    prepare: async (h) => {
      await h.goto(S(h, "/design"));
      await h.loc({ role: "heading", name: "Match my brand" }).waitFor();
      await settle(h, 1200);
    },
    steps: async (h) => {
      for (const name of ["Editorial", "Technical", "Playful", "Help center"]) {
        await h.click(vis(h, name), { after: 1000 });
      }
      await h.click({ role: "radio", name: "Dark", exact: true }, { after: 1100 });
      await h.click({ role: "radio", name: "Light", exact: true }, { after: 500 });
      await h.click({ role: "button", name: "Reset" }, { after: 600 });
    },
    trim: { start: 0.5 },
    tail: 400,
    poster: 3,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // Brand and style
  // ════════════════════════════════════════════════════════════════════════════
  {
    id: "match-brand",
    page: P("brand-and-style"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(S(h, "/design"));
      await h.loc({ role: "heading", name: "Match my brand" }).waitFor();
      await settle(h, 1000);
    },
    crop: async (h) => {
      const sel = await mark(h, "brand", () => [...document.querySelectorAll("main h2")].find((e) => e.textContent.trim() === "Match my brand")?.parentElement?.parentElement);
      return { selector: sel, pad: 12 };
    },
  },
  {
    id: "fonts-mode-corners",
    page: P("brand-and-style"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    viewport: { width: 1440, height: 1000 },
    prepare: async (h) => {
      await h.goto(S(h, "/design"));
      await h.loc({ role: "heading", name: "Match my brand" }).waitFor();
      await h.page.getByLabel("Headings font").selectOption("lora");
      await h.page.getByLabel("Body font").selectOption("inter");
      await h.page.getByLabel("Corners").selectOption("round");
      await settle(h, 1200);
    },
    crop: async (h) => {
      const a = await mark(h, "fonts", () => document.querySelector("main section[aria-label='Design settings'] > div.grid"));
      return { union: [a, "section[aria-label='Preview']"], pad: 12 };
    },
  },
  {
    id: "custom-css",
    page: P("brand-and-style"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(S(h, "/design"));
      await h.loc({ role: "heading", name: "Match my brand" }).waitFor();
      await vis(h, "Custom CSS").click();
      await h.page.getByLabel("Custom CSS", { exact: true }).fill(".dx-callout { border-radius: 0; }\n@import url(https://fonts.example.com/brand.css);");
      await h.sleep(500);
      await h.page.mouse.move(5, 5);
    },
    crop: { selector: "main details", pad: 12 },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // Publishing
  // ════════════════════════════════════════════════════════════════════════════
  {
    id: "publish-screen",
    page: P("publishing"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(S(h, "/publish"));
      await h.page.getByText("First version").waitFor();
      await settle(h);
    },
    crop: { box: { x: 0, y: 56, width: 1440, height: 720 } },
  },
  {
    id: "restore-dialog",
    page: P("publishing"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(S(h, "/publish"));
      await h.page.getByText("Postgres guide and alert rules").waitFor();
      const row = h.page.locator("li", { hasText: "Postgres guide and alert rules" });
      await row.getByRole("button", { name: "Restore" }).click();
      await h.loc({ role: "alertdialog" }).or(h.loc({ role: "dialog" })).first().waitFor();
      await h.sleep(600);
    },
    crop: { selector: "[role=alertdialog], [role=dialog]", pad: 0 },
  },
  {
    // On acme-themes (Jordan's), so Acme's own history stays as seeded.
    id: "publish-to-live",
    page: P("publishing"),
    kind: "clip",
    auth: "jordan",
    url: null,
    viewport: { width: 1280, height: 760 },
    out: 1440,
    prepare: async (h) => {
      await themeSite(h, "clean");
      const id = fxS().themes;
      const pid = await pageId(h, "themes", "/help/release-notes", "jordan");
      const page = await api(h, "GET", `/api/v1/docs-sites/${id}/pages/${pid}`, null, "jordan");
      const line = "- Workflows can call a webhook with a custom header.";
      const md = page.markdown.includes(line) ? page.markdown.replace(`\n${line}`, "") : page.markdown.replace("- The CLI's", `${line}\n- The CLI's`);
      await api(h, "PUT", `/api/v1/docs-sites/${id}/pages/${pid}`, { base_rev: page.rev, markdown: md, title: page.title, description: page.description }, "jordan");
      await api(h, "DELETE", `/api/v1/docs-sites/${id}/pages/${pid}/lock`, null, "jordan");
      await h.goto(`/guides/${id}/publish`);
      await h.page.getByText("1 change since the last publish").waitFor();
      await settle(h);
    },
    steps: async (h) => {
      await h.type(h.loc({ label: "What changed (optional)" }), "Release notes: webhook headers", { speed: 2 });
      await h.click({ role: "button", name: "Publish", exact: true }, { after: 2600 });
      await h.cut(async () => {
        await h.page.getByText(/Published\. Live at/).waitFor({ timeout: 240_000 });
      });
      await h.sleep(2200);
    },
    trim: { start: 0.5 },
    tail: 600,
    poster: 9,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // Reviews
  // ════════════════════════════════════════════════════════════════════════════
  {
    id: "review-setting",
    page: P("reviews"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(HELP(h, "/settings"));
      await h.page.locator("#review").scrollIntoViewIfNeeded();
      await settle(h);
    },
    crop: { selector: "#review", pad: 0 },
  },
  {
    id: "review-submit",
    page: P("reviews"),
    kind: "screenshot",
    auth: "alex",
    url: null,
    prepare: async (h) => {
      await ensureReview(h);
      await h.goto(HELP(h, "/publish"));
      await h.page.getByText("This guide requires a review").waitFor();
      await h.loc({ label: "Note for the reviewer" }).fill("Clarify how long a card refund takes.");
      await settle(h);
    },
    crop: async (h) => {
      const sel = await mark(h, "left", () => document.querySelector("main section"));
      return { selector: sel, pad: 12 };
    },
  },
  {
    id: "review-waiting",
    page: P("reviews"),
    kind: "screenshot",
    auth: "noah",
    url: null,
    prepare: async (h) => {
      await ensureReview(h);
      await h.goto(HELP(h, "/publish"));
      await h.page.getByText(/Priya wants to publish/).waitFor();
      await settle(h);
    },
    crop: async (h) => {
      const sel = await mark(h, "review", () => [...document.querySelectorAll("main strong")].find((e) => /wants to publish/.test(e.textContent))?.closest("div.rounded-xl"));
      return { selector: sel, pad: 12 };
    },
  },
  {
    id: "request-changes",
    page: P("reviews"),
    kind: "screenshot",
    auth: "noah",
    url: null,
    prepare: async (h) => {
      await ensureReview(h);
      await h.goto(HELP(h, "/publish"));
      await h.page.getByText(/Priya wants to publish/).waitFor();
      await h.loc({ role: "button", name: "Request changes" }).click();
      await h.loc({ label: "What should change" }).fill("Finance asked us to say “working days”, not days. Can you also link to Change your plan?");
      await h.sleep(500);
    },
    crop: { selector: "[role=dialog]", pad: 0 },
  },
  {
    id: "review-approve",
    page: P("reviews"),
    kind: "clip",
    auth: "noah",
    url: null,
    viewport: { width: 1280, height: 720 },
    out: 1440,
    prepare: async (h) => {
      await ensureReview(h);
      await h.goto(HELP(h, "/publish"));
      await h.page.getByText(/Priya wants to publish/).waitFor();
      await settle(h);
    },
    steps: async (h) => {
      await h.hover(h.page.getByText(/“Annual plans/), 900);
      await h.click({ role: "button", name: "Approve and publish" }, { after: 2600 });
      await h.cut(async () => {
        await h.page.getByText(/Published\. Live at/).waitFor({ timeout: 240_000 });
      });
      await h.sleep(2200);
    },
    after: async (h) => ensureReview(h),
    trim: { start: 0.5 },
    tail: 600,
    poster: 6,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // Members and roles
  // ════════════════════════════════════════════════════════════════════════════
  {
    id: "studio-members",
    page: P("members-and-roles"),
    kind: "screenshot",
    auth: "owner",
    url: (fx) => `/guides/members?ws=${fx.workspace.id}`,
    viewport: { width: 1440, height: 1000 },
    prepare: async (h) => {
      await h.page.getByText("Omar Haddad").waitFor();
      await settle(h);
    },
    crop: async (h) => {
      const sel = await mark(h, "list", () => document.querySelector("main section[aria-labelledby='members-h']"));
      return { selector: sel, pad: 12 };
    },
  },
  {
    id: "roles-matrix",
    page: P("members-and-roles"),
    kind: "screenshot",
    auth: "owner",
    url: (fx) => `/guides/members?ws=${fx.workspace.id}`,
    viewport: { width: 1440, height: 1000 },
    prepare: async (h) => {
      await h.loc({ role: "heading", name: "Who can do what" }).waitFor();
      await settle(h);
    },
    crop: { selector: "section[aria-labelledby='roles-explainer-h']", pad: 0 },
  },
  {
    id: "site-people",
    page: P("members-and-roles"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(HELP(h, "/settings#people"));
      const card = h.page.locator("#people");
      await card.getByText(/Different on this guide/).waitFor();
      await card.scrollIntoViewIfNeeded();
      await settle(h);
    },
    crop: { selector: "#people", pad: 0 },
  },
  {
    id: "site-role-override",
    page: P("members-and-roles"),
    kind: "clip",
    auth: "owner",
    url: null,
    viewport: { width: 1280, height: 760 },
    out: 1440,
    prepare: async (h) => {
      const id = fxS().acme;
      await api(h, "DELETE", `/api/v1/docs-sites/${id}/members/${h.fx.users.omar.id}`).catch(() => {});
      await h.goto(S(h, "/settings"));
      await h.page.locator("#people").getByText(/No one has a different role|Different on this guide/).waitFor();
      await h.page.locator("#people").evaluate((e) => e.scrollIntoView({ block: "start" }));
      await h.page.evaluate(() => window.scrollBy(0, -80));
      await settle(h);
    },
    steps: async (h) => {
      const card = h.page.locator("#people");
      await h.click(card.getByRole("button", { name: "Add person" }), { after: 800 });
      const dialog = h.page.getByRole("dialog");
      const who = dialog.locator("select").first();
      await h.hover(who, 400);
      await who.selectOption(await who.locator("option", { hasText: "Omar Haddad" }).getAttribute("value"));
      await h.sleep(700);
      await h.hover(dialog.locator("select").nth(1), 400);
      await dialog.locator("select").nth(1).selectOption("editor");
      await h.sleep(700);
      await h.click(dialog.getByRole("button", { name: "Save" }), { after: 1800 });
    },
    after: async (h) => {
      await api(h, "DELETE", `/api/v1/docs-sites/${fxS().acme}/members/${h.fx.users.omar.id}`).catch(() => {});
    },
    trim: { start: 0.5 },
    tail: 700,
    poster: 7,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // Site settings
  // ════════════════════════════════════════════════════════════════════════════
  {
    id: "settings-address",
    page: P("site-settings"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(S(h, "/settings"));
      await h.page.locator("#domain").waitFor();
      await settle(h);
    },
    crop: { union: ["#address", "#domain"], pad: 0 },
  },
  {
    id: "settings-danger",
    page: P("site-settings"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(S(h, "/settings"));
      await h.page.locator("#danger").scrollIntoViewIfNeeded();
      await settle(h);
    },
    crop: { selector: "#danger", pad: 0 },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // Ask AI
  // ════════════════════════════════════════════════════════════════════════════
  {
    id: "settings-ask-ai",
    page: P("ask-ai"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(S(h, "/settings#ai"));
      await h.page.locator("#ai").scrollIntoViewIfNeeded();
      await settle(h);
    },
    // The name and suggested questions (not the usage meter above them: no plan numbers in the docs).
    crop: async (h) => {
      const fields = await mark(h, "ai-fields", () => document.querySelector("#ai div.grid"));
      const tags = await mark(h, "ai-tags", () => document.querySelector("#ai ul") || document.querySelector("#ai div.grid"));
      const b = await h.loc(fields).boundingBox();
      const c = await h.loc(tags).boundingBox();
      const card = await h.loc("#ai").boundingBox();
      return { box: { x: card.x, y: b.y - 16, width: card.width, height: c.y + c.height + 20 - (b.y - 16) } };
    },
  },
  {
    id: "reader-ask-ai",
    page: P("ask-ai"),
    kind: "clip",
    auth: "anon",
    url: null,
    viewport: { width: 1280, height: 800 },
    out: 1440,
    prepare: async (h) => {
      await h.goto(h.studioSite("acme", "/guides/connect-postgres"), { settle: 1200 });
      await h.page.evaluate(stubAskAi);
    },
    steps: async (h) => {
      await h.click({ role: "button", name: "Ask Acme", exact: true }, { after: 700 });
      const box = h.page.getByRole("textbox").last();
      await h.type(box, "How do I connect our Postgres database?", { speed: 2.6 });
      await h.press("Enter", 200);
      await h.sleep(3400);
      await h.click(h.loc(".dx-cite__btn").first(), { after: 1900 });
    },
    trim: { start: 0.8 },
    tail: 300,
    poster: 9,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // What readers get
  // ════════════════════════════════════════════════════════════════════════════
  {
    id: "reader-page",
    page: P("what-readers-get"),
    kind: "screenshot",
    auth: "anon",
    url: null,
    viewport: { width: 1440, height: 860 },
    prepare: async (h) => {
      await h.goto(h.studioSite("acme", "/getting-started/quickstart"), { settle: 1200 });
      await h.page.mouse.move(5, 5);
    },
    crop: "viewport",
  },
  {
    id: "reader-search",
    page: P("what-readers-get"),
    kind: "screenshot",
    auth: "anon",
    url: null,
    viewport: { width: 1440, height: 860 },
    prepare: async (h) => {
      await h.goto(h.studioSite("acme", "/getting-started/quickstart"), { settle: 1200 });
      await h.page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
      await h.sleep(400);
      await h.page.keyboard.type("postgres", { delay: 40 });
      await h.sleep(900);
    },
    crop: "viewport",
  },
  {
    id: "reader-copy-page",
    page: P("what-readers-get"),
    kind: "screenshot",
    auth: "anon",
    url: null,
    viewport: { width: 1440, height: 860 },
    prepare: async (h) => {
      await h.goto(h.studioSite("acme", "/guides/connect-postgres"), { settle: 1200 });
      await h.loc({ role: "button", name: "More ways to use this page" }).first().click();
      await h.sleep(600);
    },
    crop: async (h) => {
      const menu = await h.loc("[role=menu]").first().boundingBox();
      return { box: { x: Math.max(0, menu.x - 520), y: 60, width: Math.min(1440 - Math.max(0, menu.x - 520), menu.width + 560), height: menu.y + menu.height + 24 - 60 } };
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // Videos (Northwind: an empty workspace where Riya is an admin)
  // ════════════════════════════════════════════════════════════════════════════
  {
    id: "guides-first-guide",
    page: P("overview"),
    kind: "video",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      extra("--drop-sites", "Northwind");
      // Starts on New guide (the home page's plan box has numbers the docs don't advertise).
      await h.goto(`/guides/new?ws=${northwind(h)}`);
      await h.loc({ role: "heading", name: "New guide" }).waitFor();
      await settle(h);
    },
    steps: async (h) => {
      await h.caption("Markdrop Guides: help centers and product guides", 2200);
      await h.caption("Start blank, from a template, or import from GitBook", 600);
      await h.click(vis(h, "From a template"), { after: 700 });
      await h.click(vis(h, "Product guide"), { after: 700 });
      await h.type({ placeholder: "Acme Help Center" }, "Northwind Help", { speed: 1.6 });
      await h.sleep(1200);
      await h.caption("The free address is checked as you type", 1800);
      await h.caption("");
      await h.click({ role: "button", name: "Create guide" }, { after: 1500 });
      await h.loc({ role: "heading", name: "Match my brand" }).waitFor({ timeout: 60_000 });
      await h.caption("Pick a theme. The preview updates as you go", 600);
      await h.settle(800);
      await h.click(vis(h, "Editorial"), { after: 1300 });
      await h.click(vis(h, "Clean"), { after: 1100 });
      await h.click({ role: "button", name: "Save design" }, { after: 1300 });
      await h.caption("");
      await h.click({ role: "link", name: "Pages", exact: true }, { after: 600 });
      await editorReady(h);
      await h.caption("Write in the visual editor. Drafts save themselves", 600);
      await h.click(await endOfFirstParagraph(h), { after: 300 });
      await h.press("Enter", 200);
      await h.type(null, "Northwind keeps your team's runbooks in one place.", { speed: 2 });
      await h.page.getByText(/Draft · saved/).waitFor({ timeout: 20_000 });
      await h.sleep(1200);
      await h.caption("");
      await h.click({ role: "link", name: "Publish…" }, { after: 1200 });
      await h.caption("Publish: every publish is numbered, and you can go back", 600);
      await h.type(h.loc({ label: "What changed (optional)" }), "First version", { speed: 2 });
      await h.click({ role: "button", name: "Publish", exact: true }, { after: 2400 });
      await h.cut(async () => {
        await h.page.getByText(/Published\. Live at/).waitFor({ timeout: 240_000 });
      });
      await h.sleep(1800);
      await h.caption("Live at northwind-help.guides.markdrop.in", 600);
      await h.goto(h.studioSite("northwind-help", "/"), { settle: 1500 });
      await h.sleep(2600);
      await h.caption("");
    },
    after: async () => extra("--drop-sites", "Northwind"),
    poster: 3,
  },
  {
    id: "guides-import-video",
    page: P("import-from-gitbook"),
    kind: "video",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      extra("--drop-sites", "Northwind");
      await h.goto(`/guides/new?ws=${northwind(h)}`);
      await h.loc({ role: "heading", name: "New guide" }).waitFor();
      await settle(h);
    },
    steps: async (h) => {
      await h.caption("Import from GitBook: paste its public address", 600);
      await h.click(vis(h, "Import from GitBook"), { after: 600 });
      await h.type({ placeholder: "https://docs.acme.com" }, "https://northwind.gitbook.io/docs", { speed: 1.8 });
      await h.type({ placeholder: "Acme Help Center" }, "Northwind Help", { speed: 1.6 });
      await h.sleep(1200);
      await h.caption("");
      await h.click({ role: "button", name: "Import" }, { after: 1200 });
      await h.loc({ role: "heading", name: "Bringing your pages across" }).waitFor({ timeout: 60_000 });
      playImport();
      await h.caption("Pages, images, navigation and old links come across", 600);
      await h.loc({ role: "heading", name: "Your pages are here" }).waitFor({ timeout: 120_000 });
      await waitImport();
      await h.sleep(1500);
      await h.caption("The report lists what needs a look before you publish", 1200);
      await h.scrollTo({ role: "heading", name: "Needs a look before you publish" }, { block: "start" });
      await h.click({ role: "button", name: "Show links" }, { after: 2200 });
      await h.click({ role: "button", name: "Review" }, { after: 2200 });
      await h.caption("Everything is a draft until you publish", 600);
      await h.scrollTo({ role: "heading", name: "Your pages are here" }, { block: "start" });
      await h.click({ role: "link", name: "Open the editor" }, { after: 1200 });
      await editorReady(h);
      await h.sleep(2600);
      await h.caption("");
    },
    after: async () => {
      await waitImport();
      extra("--drop-sites", "Northwind");
    },
    poster: 14,
  },
];
