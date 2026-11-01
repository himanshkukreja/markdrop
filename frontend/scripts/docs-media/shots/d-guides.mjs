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
/** A theme card in Design › Theme, by its name (the filter has tabs with the same words). */
const themeCard = (h, name) => h.page.locator("fieldset label").filter({ has: h.page.getByText(name, { exact: true }) }).first();
/** A guide's own domain in a state (seed_extra_studio.py --guide-domain): live, pending or remove. */
const guideDomain = (key, host, state) => extra("--guide-domain", key, host, state);
/** Settings › <section> of a guide. */
const settingsOf = (key) => (h, section) => `/guides/${fxS()[key]}/settings/${section}`;
const SET = settingsOf("acme");
/** The settings card (section) whose heading is `title`, marked for a crop. */
const cardWith = (h, name, title) => mark(h, name, (t) => [...document.querySelectorAll("main h2")].find((e) => e.textContent.trim() === t)?.closest("section"), title);
/** The studio header and the site bar under it. */
const CHROME = { box: { x: 0, y: 0, width: 1440, height: 108 } };

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

/** Select a paragraph of the open page (a triple click), so the formatting bar shows. */
async function selectParagraph(h, text) {
  const p = h.page.locator(".dxe-content p", { hasText: text }).first();
  await p.scrollIntoViewIfNeeded();
  await p.click({ clickCount: 3 });
  await h.loc("[role=toolbar][aria-label='Format text']").waitFor();
  await h.sleep(300);
}

/** A crop around a paragraph of the page and the editor's own pop-ups next to it. */
async function editorCrop(h, text, more, pad = 28) {
  // A box, not a marked element: ProseMirror puts back any attribute set on its own nodes.
  const boxes = [await h.page.locator(".dxe-content p", { hasText: text }).first().boundingBox()];
  for (const sel of more) boxes.push(await h.loc(sel).boundingBox());
  const x1 = Math.min(...boxes.map((b) => b.x)) - pad, y1 = Math.min(...boxes.map((b) => b.y)) - pad;
  const x2 = Math.max(...boxes.map((b) => b.x + b.width)) + pad, y2 = Math.max(...boxes.map((b) => b.y + b.height)) + pad;
  return { box: { x: Math.max(0, x1), y: Math.max(0, y1), width: Math.min(1440, x2) - Math.max(0, x1), height: y2 - Math.max(0, y1) } };
}

/** The editor's page panel from its tabs down to `last` (the panel is as tall as the window). */
async function panelCrop(h, last) {
  const a = await h.loc("aside[aria-label='Page panel']").boundingBox();
  const b = await h.loc(last).boundingBox();
  return { box: { x: a.x, y: a.y, width: a.width, height: Math.ceil(b.y + b.height + 20 - a.y) } };
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

/** One line more (or less) in acme-themes' release notes: a change to publish (Jordan's). */
async function toggleReleaseNote(h) {
  const id = fxS().themes;
  const pid = await pageId(h, "themes", "/help/release-notes", "jordan");
  const page = await api(h, "GET", `/api/v1/docs-sites/${id}/pages/${pid}`, null, "jordan");
  const line = "- Workflows can call a webhook with a custom header.";
  const md = page.markdown.includes(line) ? page.markdown.replace(`\n${line}`, "") : page.markdown.replace("- The CLI's", `${line}\n- The CLI's`);
  await api(h, "PUT", `/api/v1/docs-sites/${id}/pages/${pid}`, { base_rev: page.rev, markdown: md, title: page.title, description: page.description }, "jordan");
  await api(h, "DELETE", `/api/v1/docs-sites/${id}/pages/${pid}/lock`, null, "jordan");
  return md.includes(line) ? "Release notes: webhook headers" : "Release notes: a line moved to 2.5";
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

/** A page of dated release notes (fictional: the Northwind API), which the changelog offers to turn into entries. */
const NORTHWIND_RELEASE_NOTES = `Changes to the Northwind API, newest first.

## October 20, 2026 · Webhooks v2

Webhooks are signed with a timestamped HMAC, and a failed delivery is retried for 24 hours.

## September 29, 2026 · Cursor pagination

List endpoints take a \`cursor\` instead of \`page\`, so results don't shift while you page through them.

## September 8, 2026 · Fixed rate limit headers

\`X-RateLimit-Remaining\` counted down twice for batch requests. It counts once.

## August 18, 2026 · Metrics query API

Query any metric over a time range with \`POST /v3/metrics/query\`.
`;

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
  {
    // The guide switcher in the header: every guide with its logo (or initial), All guides, New guide.
    id: "guide-switcher",
    page: P("overview"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(S(h, "/publish"));
      await h.page.getByText(/ready to publish/).first().waitFor();
      await h.loc({ role: "button", name: /switch guide/ }).click();
      await h.loc("[role=menu]").waitFor();
      await h.sleep(500);
      await h.page.mouse.move(5, 300);
    },
    crop: async (h) => {
      const m = await h.loc("[role=menu]").boundingBox();
      return { box: { x: 0, y: 0, width: Math.ceil(m.x + m.width + 28), height: Math.ceil(m.y + m.height + 20) } };
    },
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
    // The bar (Visual · Markdown) over the tree, the page and its panel.
    crop: async (h) => {
      return { box: { x: 0, y: 56, width: 1440, height: 700 } };
    },
    after: async (h) => {
      await h.page.evaluate(() => localStorage.setItem("md_docs_editor_mode", "visual")).catch(() => {});
    },
  },
  {
    id: "image-block",
    page: P("editor"),
    kind: "screenshot",
    keepScroll: true,
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(`${DEV(h)}?page=${await pageId(h, "developers", "/getting-started/authentication")}`);
      await editorReady(h);
      const fig = h.page.locator(".dxe-figure").first();
      // Near the top of the window, clear of the status bar pinned to its bottom (keepScroll).
      await fig.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 140));
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
    crop: async (h) => ({ box: { x: 0, y: 56, width: 1440, height: 470 } }),
    after: async (h) => {
      const id = fxS().acme;
      const pid = await pageId(h, "acme", "/guides/connect-postgres");
      await api(h, "DELETE", `/api/v1/docs-sites/${id}/pages/${pid}/lock`, null, "alex");
    },
  },

  {
    // Select a paragraph, then Ask AI: the formatting bar and the AI actions.
    id: "editor-ai-menu",
    page: P("editor"),
    kind: "screenshot",
    keepScroll: true,
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(`${S(h)}?page=${await keepPage(h, "acme", "/getting-started/quickstart")}`);
      await editorReady(h);
      await selectParagraph(h, "You need an Acme account");
      await h.loc({ role: "button", name: "Ask AI" }).click();
      await h.loc({ role: "menu", name: "Ask AI" }).waitFor();
      await h.sleep(400);
    },
    crop: async (h) => editorCrop(h, "You need an Acme account", ["[role=toolbar][aria-label='Format text']", "[role=menu][aria-label='Ask AI']"], 16),
    after: async (h) => restorePage(h, "acme", "/getting-started/quickstart"),
  },
  {
    // Make it shorter: the suggestion under the passage, with Accept, Try again and Discard.
    id: "editor-ai-suggestion",
    page: P("editor"),
    kind: "screenshot",
    keepScroll: true,
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(`${S(h)}?page=${await keepPage(h, "acme", "/getting-started/quickstart")}`);
      await editorReady(h);
      await selectParagraph(h, "You need an Acme account");
      await h.loc({ role: "button", name: "Ask AI" }).click();
      await h.loc({ role: "menuitem", name: "Make it shorter" }).click();
      await h.loc({ role: "button", name: "Accept" }).waitFor({ timeout: 30_000 });
      await h.sleep(500);
      await h.page.mouse.move(5, 5);
    },
    crop: async (h) => editorCrop(h, "You need an Acme account", [".dxe-content h2:has-text('Before you start')", "[role=region][aria-label='AI suggestion']"]),
    after: async (h) => restorePage(h, "acme", "/getting-started/quickstart"),
  },
  {
    // ⌘F: Find and replace over the page, with the replace row open.
    id: "editor-find-replace",
    page: P("editor"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(`${S(h)}?page=${await pageId(h, "acme", "/getting-started/quickstart")}`);
      await editorReady(h);
      await h.loc({ role: "button", name: /Find and replace/ }).first().click();
      await h.loc("input[aria-label='Find']").fill("workspace");
      await h.loc({ role: "button", name: "Show replace" }).click();
      await h.loc("input[aria-label='Replace with']").fill("team");
      await h.sleep(500);
      await h.page.mouse.move(5, 5);
    },
    crop: async (h) => {
      const bar = await h.loc("[role=search][aria-label='Find and replace']").boundingBox();
      const main = await h.loc(".dxe-content").first().boundingBox();
      const x = Math.min(main.x, bar.x) - 24;
      return { box: { x, y: 108, width: Math.ceil(Math.max(main.x + main.width, bar.x + bar.width) + 24 - x), height: 480 } };
    },
  },
  {
    id: "editor-shortcuts",
    page: P("editor"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    viewport: { width: 1440, height: 1000 },
    prepare: async (h) => {
      await h.goto(`${S(h)}?page=${await pageId(h, "acme", "/getting-started/quickstart")}`);
      await editorReady(h);
      await h.loc({ role: "button", name: /Shortcuts/ }).first().click();
      await h.loc({ role: "dialog", name: "Keyboard shortcuts" }).waitFor();
      await h.sleep(600);
    },
    crop: { selector: "[role=dialog]", pad: 0 },
  },
  {
    // Checks: a link to a page that doesn't exist and an image without a description (Acme Developers).
    id: "editor-checks",
    page: P("editor"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    viewport: { width: 1440, height: 1000 },
    prepare: async (h) => {
      const id = fxS().developers;
      const pid = await keepPage(h, "developers", "/getting-started/authentication");
      const page = await api(h, "GET", `/api/v1/docs-sites/${id}/pages/${pid}`);
      const md = page.markdown
        .replace("![Where to create a key in Settings]", "![]")
        .replace("in the `Authorization` header.", "in the `Authorization` header. If a key leaks, [rotate it](/guides/key-rotation) at once.");
      await api(h, "PUT", `/api/v1/docs-sites/${id}/pages/${pid}`, { base_rev: page.rev, markdown: md, title: page.title, description: page.description });
      await api(h, "DELETE", `/api/v1/docs-sites/${id}/pages/${pid}/lock`).catch(() => {});
      await h.goto(`${DEV(h)}?page=${pid}`);
      await editorReady(h);
      await h.page.getByText("Link to a page that doesn't exist").first().waitFor({ timeout: 15_000 });
      await h.page.locator(".dxe-content img").first().evaluate((img) => img.complete || new Promise((r) => { img.onload = r; img.onerror = r; }));
      await settle(h, 900);
    },
    crop: async (h) => {
      const main = await h.loc(".dxe-content").first().boundingBox();
      const x = Math.max(0, Math.round(main.x - 40));
      return { box: { x, y: 108, width: 1440 - x, height: 640 } };
    },
    after: async (h) => restorePage(h, "developers", "/getting-started/authentication"),
  },
  {
    // A review comment on Quickstart (Noah's, with Alex's reply), opened from the Comments tab.
    id: "editor-comments",
    page: P("editor"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      const id = fxS().acme;
      const pid = await pageId(h, "acme", "/getting-started/quickstart");
      const path = `/api/v1/docs-sites/${id}/pages/${pid}/comments`;
      for (const c of (await api(h, "GET", path)).comments) await api(h, "DELETE", `${path}/${c.id}`);
      const c = await api(h, "POST", path, {
        quote: "A read-only user is enough.",
        prefix: "the address of a database Acme can reach. ",
        body: "Can we say which permissions? Support gets this question every week.",
      }, "noah");
      await api(h, "POST", `${path}/${c.id}/replies`, { body: "Good call. I'll link to the read-only user steps in Connect Postgres." }, "alex");
      await h.goto(`${S(h)}?page=${pid}`);
      await editorReady(h);
      await h.loc({ role: "tab", name: /^Comments/ }).click();
      await h.page.getByText("Support gets this question every week.").first().click();
      await h.sleep(700);
      await h.page.mouse.move(5, 5);
    },
    crop: async (h) => {
      const p = await h.page.locator(".dxe-content p", { hasText: "You need an Acme account" }).first().boundingBox();
      const x = Math.max(0, Math.round(p.x - 40));
      const y = 108; // the page from its top: the panel's tabs and the open thread stay in view
      return { box: { x, y, width: 1440 - x, height: Math.min(Math.ceil(p.y + p.height + 160 - y), 900 - y) } };
    },
    after: async (h) => {
      const id = fxS().acme;
      const pid = await pageId(h, "acme", "/getting-started/quickstart");
      const path = `/api/v1/docs-sites/${id}/pages/${pid}/comments`;
      for (const c of (await api(h, "GET", path)).comments) await api(h, "DELETE", `${path}/${c.id}`);
    },
  },
  {
    // Who else is here: Alex (editing Connect Postgres) and Maya (on Quickstart) in the header.
    id: "editor-presence",
    page: P("editor"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      const id = fxS().acme;
      const pg = await pageId(h, "acme", "/guides/connect-postgres");
      const qs = await pageId(h, "acme", "/getting-started/quickstart");
      await api(h, "POST", `/api/v1/docs-sites/${id}/pages/${pg}/lock`, null, "alex");
      await api(h, "POST", `/api/v1/docs-sites/${id}/presence`, { session: "demo-alex-tab-1", page_id: pg }, "alex");
      await api(h, "POST", `/api/v1/docs-sites/${id}/presence`, { session: "demo-maya-tab-1", page_id: qs }, "maya");
      await h.goto(`${S(h)}?page=${qs}`);
      await editorReady(h);
      await h.page.getByText(/^(Alex and Maya|Maya and Alex) are here$/).waitFor({ timeout: 15_000 });
      await settle(h, 600);
    },
    // The studio header's right side: the two avatars and "… are here".
    crop: async (h) => {
      const b = await h.loc("[aria-label='Also on this guide']").boundingBox();
      const x = Math.max(0, Math.round(b.x - 24));
      return { box: { x, y: 0, width: 1440 - x, height: 56 } };
    },
    after: async (h) => {
      const id = fxS().acme;
      const pg = await pageId(h, "acme", "/guides/connect-postgres");
      await api(h, "DELETE", `/api/v1/docs-sites/${id}/presence?session=demo-alex-tab-1`, null, "alex").catch(() => {});
      await api(h, "DELETE", `/api/v1/docs-sites/${id}/presence?session=demo-maya-tab-1`, null, "maya").catch(() => {});
      await api(h, "DELETE", `/api/v1/docs-sites/${id}/pages/${pg}/lock`, null, "alex").catch(() => {});
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
    crop: async (h) => ({ box: { x: 0, y: 108, width: Math.floor((await h.loc("main#main").boundingBox()).x), height: 700 } }),
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
      await h.loc({ role: "tab", name: "Page", exact: true }).click();
      await h.loc({ label: "Address" }).waitFor();
      await settle(h);
    },
    // The panel from its tabs down to Show in the sidebar (not the empty space under it).
    crop: async (h) => panelCrop(h, { text: "Show in the sidebar", exact: true }),
  },
  {
    id: "redirects",
    page: P("pages-and-navigation"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    // Settings › Redirects: one Markdrop added when a published page moved, one added here, and a
    // new row whose page doesn't exist (marked).
    prepare: async (h) => {
      await api(h, "PATCH", `/api/v1/docs-sites/${fxS().acme}`, { settings: { redirects: [
        { from: "/guides/postgres", to: "/guides/connect-postgres", why: "moved" },
        { from: "/docs/alerts", to: "/guides/alert-rules", why: "added" },
      ] } });
      await h.goto(SET(h, "redirects"));
      const card = h.page.locator("#redirects");
      await card.getByLabel("Old address 2").waitFor();
      await card.getByRole("button", { name: "Add a redirect" }).click();
      await card.getByLabel("Old address 3").fill("/setup");
      await card.getByLabel("Goes to 3").fill("/getting-started/install");
      await h.sleep(500);
      await card.getByRole("button", { name: /^Save/ }).click({ timeout: 1500 }).catch(() => {});
      await h.sleep(700);
      await h.page.mouse.move(5, 5);
    },
    crop: { selector: "#redirects", pad: 0 },
    after: async (h) => api(h, "PATCH", `/api/v1/docs-sites/${fxS().acme}`, { settings: { redirects: [] } }),
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
      await h.loc({ role: "tab", name: "History", exact: true }).click();
      await h.page.getByText("Every save is kept").waitFor();
      await h.page.locator("aside[aria-label='Page panel'] li").nth(1).waitFor();
      await settle(h);
    },
    crop: async (h) => panelCrop(h, "aside[aria-label='Page panel'] li:last-of-type"),
  },
  {
    id: "publishes-list",
    page: P("history"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(S(h, "/publish"));
      await h.loc({ role: "heading", name: "Publish history" }).waitFor();
      await h.page.getByText("First version").waitFor();
      await settle(h);
    },
    crop: async (h) => {
      const sel = await mark(h, "hist", () => document.querySelector("#history"));
      return { selector: sel, pad: 12 };
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // Themes: the published site in each preset (Jordan's acme-themes copy)
  // ════════════════════════════════════════════════════════════════════════════
  // The fourteen presets. Midnight and Terminal open in dark for a reader who hasn't picked a mode,
  // so their shots (light and dark) show what a first-time reader sees.
  ...["clean", "editorial", "technical", "minimal", "playful", "helpcenter",
    "midnight", "paper", "terminal", "corporate", "studio", "academic", "atlas", "pastel"].map((preset) => ({
    id: `theme-${preset}`,
    page: P("themes"),
    kind: "screenshot",
    auth: "jordan",
    url: null,
    viewport: { width: 1440, height: 860 },
    prepare: async (h) => {
      await themeSite(h, preset);
      if (preset === "midnight" || preset === "terminal") {
        await h.context.addInitScript(() => {
          if (location.hostname.endsWith(".guides.markdrop.in")) localStorage.removeItem("md_theme");
        });
      }
      const home = preset === "helpcenter" || preset === "atlas";
      await h.goto(h.studioSite("acme-themes", home ? "/" : "/getting-started/quickstart"), { settle: 1200 });
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
    crop: { box: { x: 0, y: 56, width: 1440, height: 800 } },
  },
  {
    // Theme › New: the eight newer themes.
    id: "design-theme-filter",
    page: P("themes"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    viewport: { width: 1440, height: 1100 },
    prepare: async (h) => {
      await h.goto(S(h, "/design"));
      await h.loc({ role: "heading", name: "Match my brand" }).waitFor();
      await h.loc({ role: "tab", name: /^New/ }).click();
      await settle(h, 900);
    },
    crop: { selector: "main fieldset", pad: 16 },
  },
  {
    // Save design: the banner that offers to publish.
    id: "design-saved",
    page: P("themes"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(S(h, "/design"));
      await h.loc({ role: "heading", name: "Match my brand" }).waitFor();
      await themeCard(h, "Editorial").click();
      await h.loc({ role: "button", name: "Save design" }).click();
      await h.page.getByText("Design saved", { exact: true }).waitFor();
      await settle(h, 900);
    },
    crop: async (h) => {
      const sel = await mark(h, "saved", () => [...document.querySelectorAll("[role=status]")].find((e) => /Design saved/.test(e.textContent)));
      const b = await h.loc(sel).boundingBox();
      return { box: { x: 0, y: 0, width: 1440, height: Math.ceil(b.y + b.height + 16) } };
    },
    after: async (h) => api(h, "PATCH", `/api/v1/docs-sites/${fxS().acme}`, { settings: { theme: { preset: "clean" } } }),
  },
  {
    // Reset design: the warning dialog listing what goes back (Acme's design changed first, put back after).
    id: "design-reset",
    page: P("themes"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await api(h, "PATCH", `/api/v1/docs-sites/${fxS().acme}`, { settings: { theme: {
        preset: "midnight", fonts: { heading: "fraunces", body: null, mono: null },
        custom: { light: null, dark: null, buttons: "pill", cards: "raised" },
      } } });
      await h.goto(S(h, "/design"));
      await h.loc({ role: "heading", name: "Reset design" }).waitFor();
      await h.page.locator("main").getByRole("button", { name: "Reset design" }).click();
      await h.loc({ role: "dialog" }).waitFor();
      await h.page.mouse.move(5, 5);
      await settle(h, 800);
    },
    crop: { selector: "[role=dialog]", pad: 24 },
    after: async (h) => api(h, "PATCH", `/api/v1/docs-sites/${fxS().acme}`, { settings: { theme: {
      preset: "clean", fonts: { heading: null, body: null, mono: null }, custom: null,
    } } }),
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
      for (const name of ["Editorial", "Help center"]) {
        await h.click(themeCard(h, name), { after: 900 });
      }
      await h.click({ role: "tab", name: /^New/ }, { after: 600 });
      for (const name of ["Midnight", "Atlas"]) {
        await h.click(themeCard(h, name), { after: 900 });
      }
      await h.click({ role: "radio", name: "Dark", exact: true }, { after: 1100 });
      await h.click({ role: "button", name: "Discard changes" }, { after: 600 });
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
      await h.page.mouse.move(5, 5);
    },
    // The four settings (the preview is at the top of the page, far from them since the theme list grew).
    crop: async (h) => ({ selector: await mark(h, "fonts", () => document.querySelector("main section[aria-label='Design settings'] > div.grid")), pad: 16 }),
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
    crop: { box: { x: 0, y: 56, width: 1440, height: 598 } },
  },
  {
    // The bar under the header on every screen of a guide (here on Insights).
    id: "site-bar",
    page: P("publishing"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(S(h, "/insights?range=7d"));
      await h.loc({ role: "button", name: "Publish 4 changes" }).first().waitFor();
      await settle(h);
    },
    crop: CHROME,
  },
  {
    // A publish running (acme-themes, Jordan's): the steps and how far along it is.
    id: "publish-progress",
    page: P("publishing"),
    kind: "screenshot",
    auth: "jordan",
    url: null,
    viewport: { width: 1440, height: 1000 },
    prepare: async (h) => {
      await themeSite(h, "clean");
      const note = await toggleReleaseNote(h);
      await h.goto(`/guides/${fxS().themes}/publish`);
      await h.page.getByText("1 change ready to publish").waitFor();
      await h.loc({ label: "What changed (optional)" }).fill(note);
      await h.loc({ role: "button", name: "Publish 1 change", exact: true, nth: 1 }).click();
      await h.loc({ role: "heading", name: "Publishing your guide" }).waitFor({ timeout: 60_000 });
      await h.page.waitForFunction(() => {
        const p = document.querySelector("main [role=progressbar]");
        const n = Number(p?.getAttribute("aria-valuenow"));
        return n >= 15 && n <= 90;
      }, null, { timeout: 120_000, polling: 100 });
      await h.sleep(1500);
      await h.page.mouse.move(5, 5);
    },
    settle: 0,
    crop: { selector: "main", pad: 0 },
    after: async (h) => waitLive(h, "themes", "jordan"),
  },
  {
    // Nothing waiting: the live guide, Finish setting up and the history (acme-themes).
    id: "publish-live",
    page: P("publishing"),
    kind: "screenshot",
    auth: "jordan",
    url: null,
    viewport: { width: 1440, height: 1300 },
    prepare: async (h) => {
      await themeSite(h, "clean");
      await h.goto(`/guides/${fxS().themes}/publish`);
      await h.loc({ role: "heading", name: "Your guide is live" }).waitFor();
      await settle(h);
    },
    crop: { selector: "main", pad: 0 },
  },
  {
    // What changed: the live publish against the drafts, Quickstart's lines.
    id: "publish-compare",
    page: P("publishing"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(S(h, "/publish/compare"));
      await h.loc({ role: "heading", name: "What changed" }).waitFor();
      await h.page.getByText(/unchanged lines/).first().waitFor();
      await settle(h);
    },
    crop: { selector: "main", pad: 0, maxHeight: 600 },
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
      await h.page.getByText("1 change ready to publish").waitFor();
      await settle(h);
    },
    steps: async (h) => {
      await h.type(h.loc({ label: "What changed (optional)" }), "Release notes: webhook headers", { speed: 2 });
      await h.click({ role: "button", name: "Publish 1 change", exact: true, nth: 1 }, { after: 2600 });
      await h.cut(async () => {
        await h.page.getByText(/Publish #\d+ is live/).waitFor({ timeout: 240_000 });
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
      await h.goto(HELP(h, "/settings/people"));
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
      const sel = await mark(h, "left", () => document.querySelector("main aside"));
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
        await h.page.getByText(/Publish #\d+ is live/).waitFor({ timeout: 240_000 });
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
      await h.goto(HELP(h, "/settings/people"));
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
      await h.goto(SET(h, "people"));
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
    // Settings › General, with the section list on the left.
    id: "settings-general",
    page: P("site-settings"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    viewport: { width: 1440, height: 1000 },
    prepare: async (h) => {
      await h.goto(SET(h, "general"));
      await h.page.locator("#address").waitFor();
      await settle(h);
    },
    crop: { box: { x: 168, y: 108, width: 1104, height: 850 } },
  },
  {
    id: "settings-address",
    page: P("site-settings"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(SET(h, "general"));
      await h.page.locator("#address").waitFor();
      await settle(h);
    },
    crop: { selector: "#address", pad: 0 },
  },
  {
    // Settings › Domains: the guide's own domain (live) and its free address.
    id: "settings-domains",
    page: P("site-settings"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      guideDomain("acme", "learn.acme.com", "live");
      await h.goto(SET(h, "domains"));
      await h.page.getByText("learn.acme.com", { exact: true }).first().waitFor();
      await settle(h);
    },
    crop: { selector: "#domains", pad: 0 },
    after: async () => guideDomain("acme", "learn.acme.com", "remove"),
  },
  {
    // Add a domain, step 1: the subdomain.
    id: "domain-add",
    page: P("site-settings"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      guideDomain("acme", "learn.acme.com", "remove");
      await h.goto(SET(h, "domains/new"));
      await h.loc("#domain input").fill("learn.acme.com");
      await h.sleep(400);
      await h.page.mouse.move(5, 5);
    },
    crop: { union: ["main ol[aria-label=Steps]", "#domain"], pad: 12 },
  },
  {
    // Add a domain, step 2: who runs the DNS, and the record in their words.
    id: "domain-setup",
    page: P("site-settings"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    viewport: { width: 1440, height: 1400 },
    prepare: async (h) => {
      guideDomain("acme", "learn.acme.com", "remove");
      await h.goto(SET(h, "domains/new"));
      await h.loc("#domain input").fill("learn.acme.com");
      await h.loc({ role: "button", name: "Continue" }).click();
      await h.page.getByText(/DNS is at Cloudflare/).first().waitFor({ timeout: 30_000 });
      await settle(h, 900);
    },
    crop: async (h) => {
      const steps = await h.loc("main ol[aria-label=Steps]").boundingBox();
      const rec = await h.loc("#handoff").boundingBox();
      return { box: { x: steps.x - 12, y: steps.y - 12, width: steps.width + 24, height: rec.y - steps.y + 4 } };
    },
    after: async () => guideDomain("acme", "learn.acme.com", "remove"),
  },
  {
    // Someone else runs the DNS: the message to send, and the status.
    id: "domain-handoff",
    page: P("site-settings"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    viewport: { width: 1440, height: 1600 },
    prepare: async (h) => {
      guideDomain("acme", "learn.acme.com", "pending");
      await h.goto(SET(h, "domains/learn.acme.com"));
      await h.page.locator("#handoff").waitFor({ timeout: 30_000 });
      await settle(h, 900);
    },
    crop: async (h) => {
      const status = await cardWith(h, "status", "Status");
      return { union: ["#handoff", status], pad: 12 };
    },
    after: async () => guideDomain("acme", "learn.acme.com", "remove"),
  },
  {
    id: "settings-access",
    page: P("site-settings"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(SET(h, "access"));
      await h.page.locator("#access").waitFor();
      await settle(h);
    },
    crop: async (h) => {
      const seo = await mark(h, "seo", () => document.querySelector("[aria-label='Show in search engines']")?.closest("section"));
      return { union: ["#access", seo], pad: 0 };
    },
  },
  {
    id: "settings-danger",
    page: P("site-settings"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(SET(h, "danger"));
      await h.page.locator("#danger").waitFor();
      await settle(h);
    },
    crop: { selector: "#danger", pad: 0 },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // API reference (Acme Developers, with the Acme API's OpenAPI file)
  // ════════════════════════════════════════════════════════════════════════════
  {
    id: "api-reference-checked",
    page: P("api-reference"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(settingsOf("developers")(h, "api-reference"));
      await h.page.locator("#result").waitFor({ timeout: 30_000 });
      await settle(h);
    },
    crop: { selector: "#result", pad: 0 },
  },
  {
    id: "api-reference-endpoints",
    page: P("api-reference"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    viewport: { width: 1440, height: 1700 },
    prepare: async (h) => {
      await h.goto(settingsOf("developers")(h, "api-reference"));
      await h.page.locator("#options").waitFor({ timeout: 30_000 });
      await settle(h);
    },
    crop: async (h) => {
      const get = await cardWith(h, "get", "What readers will get");
      return { union: [get, "#options"], pad: 0 };
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // Insights (Acme, the last 7 days; acme-themes for a live guide with no readers yet)
  // ════════════════════════════════════════════════════════════════════════════
  {
    id: "insights-overview",
    page: P("insights"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(S(h, "/insights?range=7d"));
      await h.loc("section[aria-label=Summary]").waitFor();
      await h.loc({ role: "heading", name: "Readers per day" }).waitFor();
      await settle(h, 900);
    },
    crop: async (h) => {
      const chart = await cardWith(h, "chart", "Readers per day");
      const title = await mark(h, "ins-title", () => document.querySelector("main h1")?.parentElement?.parentElement);
      return { union: [title, chart], pad: 12 };
    },
  },
  {
    id: "insights-pages",
    page: P("insights"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    viewport: { width: 1440, height: 1400 },
    prepare: async (h) => {
      await h.goto(S(h, "/insights?range=7d"));
      await h.page.getByText("What readers couldn't find").waitFor();
      await settle(h, 900);
    },
    crop: async (h) => {
      const a = await cardWith(h, "top", "Top pages");
      const b = await cardWith(h, "missing", "What readers couldn't find");
      return { union: [a, b], pad: 12 };
    },
  },
  {
    id: "insights-feedback",
    page: P("insights"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    viewport: { width: 1440, height: 1800 },
    prepare: async (h) => {
      await h.goto(S(h, "/insights?range=7d"));
      await h.page.getByText("Reader feedback").waitFor();
      await settle(h, 900);
    },
    crop: async (h) => ({ selector: await cardWith(h, "fb", "Reader feedback"), pad: 12 }),
  },
  {
    id: "insights-sources",
    page: P("insights"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    viewport: { width: 1440, height: 2200 },
    prepare: async (h) => {
      await h.goto(S(h, "/insights?range=7d"));
      await h.page.getByText("Where readers come from").waitFor();
      await settle(h, 900);
    },
    crop: async (h) => {
      const a = await cardWith(h, "from", "Where readers come from");
      const b = await cardWith(h, "look", "What readers look for");
      return { union: [a, b], pad: 12 };
    },
  },
  {
    // A live guide nobody has read yet.
    id: "insights-empty",
    page: P("insights"),
    kind: "screenshot",
    auth: "jordan",
    url: null,
    prepare: async (h) => {
      await themeSite(h, "clean");
      await h.goto(`/guides/${fxS().themes}/insights`);
      await h.loc("main h1").first().waitFor();
      await settle(h, 900);
    },
    crop: { selector: "main", pad: 0 },
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
      await h.goto(SET(h, "ask-ai"));
      await h.page.getByText("Ask AI on your guide").waitFor();
      await settle(h);
    },
    // The name and suggested questions (not the usage meter above them: no plan numbers in the docs).
    crop: async (h) => {
      const card = await cardWith(h, "ai", "Ask AI on your guide");
      const fields = await mark(h, "ai-fields", (c) => document.querySelector(c).querySelector("div.grid"), card);
      const tags = await mark(h, "ai-tags", (c) => document.querySelector(c).querySelector("ul[aria-label='Suggested questions']"), card);
      const b = await h.loc(fields).boundingBox();
      const c = await h.loc(tags).boundingBox();
      const box = await h.loc(card).boundingBox();
      return { box: { x: box.x, y: b.y - 10, width: box.width, height: c.y + c.height + 14 - (b.y - 10) } };
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
      // From the article's own column (the breadcrumb), so no edge of the sidebar's current page shows.
      const crumbs = await h.loc(".dx-crumbs").first().boundingBox();
      const x = Math.max(0, Math.round(crumbs.x - 40), menu.x - 560);
      return { box: { x, y: 60, width: Math.min(1440 - x, Math.ceil(menu.x + menu.width + 24 - x)), height: menu.y + menu.height + 24 - 60 } };
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // Changelog (Acme's: "What's new", six entries live since publish #4)
  // ════════════════════════════════════════════════════════════════════════════
  {
    id: "changelog-empty",
    page: P("changelog"),
    kind: "screenshot",
    auth: "jordan",
    url: null,
    prepare: async (h) => {
      await h.goto(`/guides/${fxS().themes}/changelog`);
      await h.loc({ role: "heading", name: "Tell readers what's new" }).waitFor();
      await settle(h, 900);
    },
    crop: { selector: "main", pad: 0 },
  },
  {
    id: "changelog-list",
    page: P("changelog"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    viewport: { width: 1440, height: 1120 },
    prepare: async (h) => {
      await h.goto(S(h, "/changelog"));
      await h.loc({ role: "heading", name: "What's new", exact: true }).waitFor();
      await settle(h, 900);
    },
    // The site bar (its tabs and the publish button) and the screen.
    crop: { union: [{ css: 'nav[aria-label="Guide"]' }, { css: 'nav[aria-label="Guide"] ~ div' }, "main"], pad: 0 },
  },
  {
    id: "changelog-editor",
    page: P("changelog"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    viewport: { width: 1440, height: 1000 },
    prepare: async (h) => {
      const { entries } = await api(h, "GET", `/api/v1/docs-sites/${fxS().acme}/changelog`);
      const e = entries.find((x) => x.slug === "workflows-beta");
      await h.goto(S(h, `/changelog?entry=${e.id}`));
      await h.loc('[aria-label="Details of this entry"]').waitFor({ timeout: 60_000 });
      await settle(h, 1200);
    },
    crop: "viewport",
  },
  {
    id: "changelog-settings",
    page: P("changelog"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(S(h, "/changelog"));
      await h.loc({ role: "heading", name: "What's new", exact: true }).waitFor();
      await h.click({ role: "button", name: "Edit", nth: 0 }); // Coming next
      await h.loc({ role: "heading", name: "Coming next", exact: true }).last().waitFor();
      await settle(h, 900);
    },
    crop: { selector: ".md-drawer", pad: 0 },
  },
  {
    id: "changelog-preview",
    page: P("changelog"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      await h.goto(S(h, "/changelog"));
      await h.loc({ role: "heading", name: "What's new", exact: true }).waitFor();
      await h.click({ role: "button", name: "Preview" });
      await h.loc('[data-testid="changelog-preview"]').waitFor();
      await settle(h, 2200);
    },
    crop: "viewport",
  },
  {
    id: "changelog-release-notes",
    page: P("changelog"),
    kind: "screenshot",
    auth: "owner",
    url: null,
    prepare: async (h) => {
      extra("--drop-sites", "Northwind");
      const site = await api(h, "POST", "/api/v1/docs-sites", { workspace_id: northwind(h), name: "Northwind API", slug: "northwind-api", source: { kind: "blank" } });
      await api(h, "POST", `/api/v1/docs-sites/${site.id}/pages`, { path: "/release-notes", title: "Release notes", markdown: NORTHWIND_RELEASE_NOTES });
      await h.goto(`/guides/${site.id}/changelog`);
      await h.loc({ role: "region", name: "Release notes found" }).waitFor({ timeout: 30_000 });
      await settle(h, 900);
    },
    crop: { selector: 'section[aria-label="Release notes found"]', pad: 16 },
    after: async () => extra("--drop-sites", "Northwind"),
  },
  {
    id: "changelog-reader",
    page: P("changelog"),
    kind: "screenshot",
    auth: "anon",
    url: null,
    viewport: { width: 1440, height: 1480 },
    prepare: async (h) => {
      await h.goto(h.studioSite("acme", "/changelog"), { settle: 1400 });
      await h.page.mouse.move(5, 5);
    },
    crop: "viewport",
  },
  {
    id: "changelog-reader-entry",
    page: P("changelog"),
    kind: "screenshot",
    auth: "anon",
    url: null,
    viewport: { width: 1440, height: 1000 },
    prepare: async (h) => {
      await h.goto(h.studioSite("acme", "/changelog/workflows-beta"), { settle: 1400 });
      await h.page.mouse.move(5, 5);
    },
    crop: "viewport",
  },
  {
    id: "changelog-reader-subscribe",
    page: P("changelog"),
    kind: "screenshot",
    auth: "anon",
    url: null,
    viewport: { width: 1440, height: 640 },
    prepare: async (h) => {
      await h.goto(h.studioSite("acme", "/changelog"), { settle: 1400 });
      await h.click({ role: "button", name: "Subscribe" });
      await h.sleep(500);
    },
    crop: "viewport",
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
      // A new guide opens in the editor.
      await editorReady(h);
      await h.caption("It opens in the editor. Drafts save themselves", 600);
      await h.click(await endOfFirstParagraph(h), { after: 300 });
      await h.press("Enter", 200);
      await h.type(null, "Northwind keeps your team's runbooks in one place.", { speed: 2 });
      // The bar goes Unsaved changes, Saving…, then Saved.
      await h.page.getByText("Unsaved changes").waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});
      await h.page.getByText("Saved", { exact: true }).first().waitFor({ timeout: 20_000 });
      await h.sleep(1200);
      await h.caption("");
      await h.click({ role: "link", name: "Design", exact: true }, { after: 600 });
      await h.loc({ role: "heading", name: "Match my brand" }).waitFor({ timeout: 60_000 });
      // The window keeps the editor's scroll across the tab change: start Design at its top (Theme, the filter).
      await h.page.evaluate(() => window.scrollTo(0, 0));
      await h.caption("Pick a theme. The preview updates as you go", 600);
      await h.settle(800);
      await h.click(themeCard(h, "Help center"), { after: 1300 });
      await h.click(themeCard(h, "Editorial"), { after: 1100 });
      await h.click({ role: "button", name: "Save design" }, { after: 1300 });
      await h.caption("");
      await h.click({ role: "link", name: /^Publish/ }, { after: 1200 });
      await h.caption("Publish: every publish is numbered, and you can go back", 600);
      await h.type(h.loc({ label: "What changed (optional)" }), "First version", { speed: 2 });
      await h.click({ role: "button", name: /^Publish \d+ change/, nth: 1 }, { after: 2400 });
      await h.cut(async () => {
        await h.page.getByText(/Publish #\d+ is live/).waitFor({ timeout: 240_000 });
      });
      await h.sleep(1800);
      await h.caption("Live at northwind-help.guides.markdrop.in", 600);
      await h.goto(h.studioSite("northwind-help", "/"), { settle: 1500 });
      await h.sleep(2600);
      await h.caption("");
    },
    after: async () => extra("--drop-sites", "Northwind"),
    poster: 41, // Your guide is live
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
