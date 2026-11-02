/**
 * Docs media, group E: the short silent loops on the Markdrop Guides landing page (markdrop.in/guides).
 * Recorded like the docs clips (capture.mjs), then cut into seamless loops and encoded for the page
 * by ../landing-loops.mjs (MP4 + WebM + poster, into frontend/public/guides-landing/).
 *
 *   STACK_ID=51 npm run docs:media -- --keep-raw --no-manifest landing-fix
 *   node scripts/docs-media/landing-loops.mjs landing-fix
 *
 * The world: seed.py + seed_extra_studio.py (Acme, Riya owner; Acme's Fix list). The hero clip shows
 * the whole Fix list loop on Acme: the top item, its evidence, Draft a fix, the suggestion in the
 * editor, Accept, Publish, and the item closed by that publish. The sandbox has no AI key: the draft
 * is the one seed_extra_studio.py writes "as the AI would", handed back when Draft a fix is pressed.
 *
 * No shot id or asset path may contain the letters g-i-t (see d-guides.mjs).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEDIA = path.resolve(HERE, "..");
const REPO = path.resolve(MEDIA, "../../..");
const STACK_ID = Number(process.env.STACK_ID || 0);
const DATA = path.join(process.env.DOCS_MEDIA_DATA || path.join(MEDIA, ".data"), STACK_ID ? String(STACK_ID) : "");
const PY = process.env.DOCS_MEDIA_PYTHON || path.join(REPO, "backend/.venv/bin/python");
const EXTRA = path.join(MEDIA, "seed_extra_studio.py");

const fxS = () => JSON.parse(readFileSync(path.join(DATA, "fixtures_studio.json"), "utf8"));
function extra(...args) {
  const r = spawnSync(PY, [EXTRA, ...args], { env: { ...process.env, STACK_ID: String(STACK_ID) }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`seed_extra_studio.py ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}
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
/**
 * Acme Cloud, the guide the private-section and live-demo clips read, served by the stack's site
 * server at acme-cloud.guides.localhost (a secure context, so the reader sign-in's cookie sticks; the
 * API knows that address as one of the guide's domains). Seeded by landing_seed.py.
 */
const cloud = (p) => `http://acme-cloud.guides.localhost:${3405 + 10 * STACK_ID}${p}`;
const outboxLines = () => {
  try {
    return readFileSync(path.join(DATA, "outbox.jsonl"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const settle = async (h, ms = 700) => {
  await h.settle(ms);
};

/**
 * The drop item ("Readers leave at Install the CLI") without its seeded draft until Draft a fix is
 * pressed: the list and the item come back without it, the draft call answers with it.
 */
async function draftOnPress(h) {
  const site = fxS().acme;
  const { items } = await api(h, "GET", `/api/v1/docs-sites/${site}/fixes`);
  const drop = items.find((i) => i.type === "drop" && /Install the CLI/.test(i.title));
  if (!drop) throw new Error("no Install the CLI item");
  const full = await api(h, "GET", `/api/v1/docs-sites/${site}/fixes/${drop.id}`);
  let drafted = false;
  const strip = (it) => (it && it.id === drop.id ? { ...it, draft: null, has_draft: false } : it);
  await h.page.route(`**/api/v1/docs-sites/${site}/fixes**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === "POST" && url.pathname.endsWith(`/fixes/${drop.id}/draft`)) {
      await new Promise((r) => setTimeout(r, 1300));
      drafted = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...full, has_draft: true }) });
    }
    if (req.method() !== "GET" || drafted) return route.continue();
    const res = await route.fetch();
    const json = await res.json().catch(() => null);
    if (!json) return route.fulfill({ response: res });
    const body = Array.isArray(json.items) ? { ...json, items: json.items.map(strip) } : strip(json);
    return route.fulfill({ response: res, json: body });
  });
  return drop;
}

/** The editor clip's page as it was, put back after the clip. */
let restore = null;

export default [
  {
    // The hero: the whole loop, in the laptop.
    id: "landing-fix",
    page: "/guides/fix-list",
    dir: "../guides-landing/raw",
    kind: "clip",
    auth: "owner",
    url: null,
    viewport: { width: 1280, height: 800 },
    out: 1600,
    themes: ["light", "dark"],
    prepare: async (h) => {
      extra("--fix-list");
      await draftOnPress(h);
      await h.goto(`/guides/${fxS().acme}/fixes`);
      await h.page.getByText("Readers leave at", { exact: false }).first().waitFor();
      await settle(h, 900);
    },
    steps: async (h) => {
      await h.sleep(300);
      await h.click(h.page.getByText("Readers leave at", { exact: false }).first(), { after: 700 });
      await h.loc(".md-drawer").waitFor();
      await h.sleep(700);
      await h.click({ role: "button", name: /Draft a fix|Rewrite/ }, { after: 300 });
      await h.page.getByRole("link", { name: "Open in editor" }).waitFor({ timeout: 20_000 });
      await h.sleep(1000);
      await h.click({ role: "link", name: "Open in editor" }, { after: 0 });
      await h.cut(async () => {
        await h.loc(".dxe-assist").waitFor({ timeout: 60_000 });
        await h.sleep(700);
      });
      await h.sleep(900);
      await h.click(h.page.locator(".dxe-assist").getByRole("button", { name: "Accept" }), { after: 600 });
      // Publish: the item closes with the publish that carries the fix.
      await h.click({ role: "link", name: /^Publish \d+ change/ }, { after: 0 });
      await h.cut(async () => {
        await h.page.getByRole("button", { name: /^Publish \d+ change/ }).last().waitFor({ timeout: 60_000 });
        await h.sleep(500);
      });
      await h.click(h.page.getByRole("button", { name: /^Publish \d+ change/ }).last(), { after: 300 });
      await h.cut(async () => {
        await h.page.getByText(/Publish #\d+ is live/).first().waitFor({ timeout: 240_000 });
        await h.sleep(300);
      });
      await h.sleep(500);
      await h.click({ role: "link", name: /^Fix list/ }, { after: 0 });
      await h.cut(async () => {
        await h.page.getByRole("tab", { name: /^Fixed/ }).first().waitFor({ timeout: 60_000 });
        await h.sleep(400);
      });
      await h.click(h.page.getByRole("tab", { name: /^Fixed/ }).first(), { after: 600 });
      await h.click(h.page.getByText("Readers leave at", { exact: false }).first(), { after: 300 });
      await h.loc(".md-drawer").waitFor();
      await h.sleep(1300);
    },
    tail: 300,
  },
  {
    // The Fix list section: the drafted fix as a suggestion in the editor, and Accept. Puts the page
    // back afterwards, so the clip (and the hero's) can be recorded again.
    id: "landing-editor",
    page: "/guides/fix-list",
    dir: "../guides-landing/raw",
    kind: "clip",
    auth: "owner",
    url: null,
    viewport: { width: 1200, height: 760 },
    out: 1200,
    themes: ["light", "dark"],
    prepare: async (h) => {
      extra("--fix-list");
      const site = fxS().acme;
      const { items } = await api(h, "GET", `/api/v1/docs-sites/${site}/fixes`);
      const drop = items.find((i) => i.type === "drop" && /Install the CLI/.test(i.title));
      const page = await api(h, "GET", `/api/v1/docs-sites/${site}/pages/${drop.page_id}`);
      restore = { site, page: drop.page_id, markdown: page.markdown };
      await h.goto(`/guides/${site}?page=${encodeURIComponent(drop.page_id)}&fix=${encodeURIComponent(drop.id)}`);
      await h.loc(".dxe-assist").waitFor({ timeout: 60_000 });
      await settle(h, 1200);
      // The suggestion's card near the bottom of the window, its heading in view.
      await h.page.evaluate(() => {
        const r = document.querySelector(".dxe-assist").getBoundingClientRect();
        window.scrollBy(0, r.bottom - (window.innerHeight - 70));
      });
      await h.sleep(500);
    },
    steps: async (h) => {
      await h.sleep(1400);
      await h.hover(h.page.locator(".dxe-assist").getByRole("button", { name: "Accept" }), 700);
      await h.click(h.page.locator(".dxe-assist").getByRole("button", { name: "Accept" }), { after: 2200 });
    },
    after: async (h) => {
      const r = restore;
      restore = null;
      if (!r) return;
      await h.page.goto("about:blank").catch(() => {});
      await api(h, "DELETE", `/api/v1/docs-sites/${r.site}/pages/${r.page}/lock`).catch(() => {});
      const now = await api(h, "GET", `/api/v1/docs-sites/${r.site}/pages/${r.page}`);
      await api(h, "PUT", `/api/v1/docs-sites/${r.site}/pages/${r.page}`, { base_rev: now.rev, markdown: r.markdown });
      await api(h, "DELETE", `/api/v1/docs-sites/${r.site}/pages/${r.page}/lock`).catch(() => {});
      extra("--fix-list");
    },
    tail: 200,
  },
  {
    // A live demo in a docs page: the calculator embedded in Acme Cloud's pricing page.
    id: "landing-calc",
    page: "/guides/embed-files",
    dir: "../guides-landing/raw",
    kind: "clip",
    auth: "anon",
    url: null,
    viewport: { width: 800, height: 640 },
    out: 800,
    realClock: true,
    themes: ["light", "dark"],
    prepare: async (h) => {
      await h.goto(cloud("/billing/pricing"), { settle: 1500 });
      await h.page.frameLocator("iframe").first().getByText("Scale", { exact: true }).waitFor({ timeout: 30_000 });
      await h.page.evaluate(() => window.scrollTo(0, 286));
      await h.sleep(500);
    },
    steps: async (h) => {
      const f = h.page.frameLocator("iframe").first();
      await h.sleep(500);
      await h.click(f.getByText("Scale", { exact: true }), { after: 700 });
      // Drag the seats slider from 12 to about 40.
      const slider = f.locator("input[type=range]").first();
      const b = await slider.boundingBox();
      const y = b.y + b.height / 2;
      const x0 = b.x + b.width * 0.06;
      await h.move([x0, y]);
      await h.page.mouse.down();
      for (let i = 1; i <= 24; i++) {
        const x = x0 + (b.width * 0.36 * i) / 24;
        await h.page.mouse.move(x, y);
        await h.page.evaluate(([a, c]) => window.__mdcap?.move(a, c), [x, y]).catch(() => {});
        await h.sleep(28);
      }
      await h.page.mouse.up();
      await h.sleep(700);
      await h.click(f.getByText("Monthly", { exact: true }), { after: 900 });
      await h.click(f.getByText("Team", { exact: true }), { after: 1100 });
    },
    tail: 300,
  },
  {
    // A private section opening for a Northwind reader (emailed sign-in link).
    id: "landing-private",
    page: "/guides/private-pages",
    dir: "../guides-landing/raw",
    kind: "clip",
    auth: "anon",
    url: null,
    viewport: { width: 800, height: 600 },
    out: 800,
    realClock: true,
    themes: ["light", "dark"],
    prepare: async (h) => {
      await h.goto(cloud("/guides/single-sign-on"), { settle: 1200 });
      await h.loc(".dx-locked").waitFor();
    },
    steps: async (h) => {
      const before = outboxLines().length;
      await h.sleep(700);
      await h.click(h.page.locator(".dx-locked").getByText("Sign in with email"), { after: 0 });
      await h.cut(async () => {
        await h.loc("input[type=email]").waitFor();
        await h.sleep(300);
      });
      await h.type("input[type=email]", "jane@northwind.com", { speed: 2.2 });
      await h.sleep(250);
      await h.click({ role: "button", name: /Email me a sign-in link/ }, { after: 0 });
      await h.page.waitForURL(/m=sent/);
      await h.sleep(900);
      await h.cut(async () => {
        let link = null;
        for (let i = 0; i < 40 && !link; i++) {
          const mail = outboxLines().slice(before).map((l) => JSON.parse(l)).reverse().find((m) => (m.to || []).includes("jane@northwind.com"));
          link = mail && /href="([^"]*email-link\/[^"]+)"/.exec(mail.html)?.[1];
          if (!link) await h.sleep(250);
        }
        if (!link) throw new Error("no sign-in email");
        await h.page.goto(link.replace(/&amp;/g, "&"));
        await h.page.locator("button[type=submit]").click();
        await h.page.waitForURL(/single-sign-on/);
        await h.loc(".dx-private").waitFor();
        await h.settle(600);
        await h.page.evaluate(() => window.scrollTo(0, 0));
        await h.page.mouse.move(770, 150);
        await h.page.evaluate(() => window.__mdcap?.move(770, 150)).catch(() => {});
        await h.sleep(300);
      });
      await h.sleep(2200);
    },
    tail: 200,
  },
];
