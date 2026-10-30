/**
 * Docs media for /get-started/** and /documents/** (group A). Same format as ../shots.mjs.
 *
 * Some takes publish at an address the seeded world already uses (q3-plan, q3-board-deck,
 * pricing-faq): they free it with ../seed_extra_a.py first and put the seeded document back in
 * `after`, so every other shot still finds the world seed.py built.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const HELPER = new URL("../seed_extra_a.py", import.meta.url).pathname;
const PY = process.env.DOCS_MEDIA_PYTHON || new URL("../../../../backend/.venv/bin/python", import.meta.url).pathname;
const FIXTURES = new URL("../.data/fixtures/", import.meta.url).pathname;

/** seed_extra_a.py free|restore|reslug <slug…> on this stack instance (STACK_ID is inherited). */
function world(...args) {
  const r = spawnSync(PY, [HELPER, ...args], { encoding: "utf8", env: process.env });
  if (r.status !== 0) throw new Error(`seed_extra_a.py ${args.join(" ")}: ${r.stderr || r.stdout}`);
}

const escapeImmersive = async (h) => {
  // Document and file pages open full screen; Escape brings the top bar back.
  await h.page.keyboard.press("Escape");
  await h.sleep(500);
};

const parkMouse = (h) => h.page.mouse.move(5, h.shot.viewport.height - 5);

/** The floating "Send feedback" button sits on top of the builder's preview: hide it in shots. */
async function hideFloatingFeedback(h) {
  await h.page.evaluate(() => {
    for (const b of document.querySelectorAll("button")) {
      if ((b.getAttribute("aria-label") || b.textContent.trim()) !== "Send feedback") continue;
      let el = b;
      while (el && el !== document.body && getComputedStyle(el).position !== "fixed") el = el.parentElement;
      if (el && el !== document.body) el.style.visibility = "hidden";
    }
  });
}

/**
 * Click a menu button with the recorded cursor; if the menu didn't open (the first pointer click
 * after the cursor crossed a file's frame sometimes doesn't reach the button), click it directly.
 */
async function openMenu(h, button, after = 1200) {
  await h.click(button, { after: 350 });
  const b = h.loc(button);
  if ((await b.getAttribute("aria-expanded")) !== "true") await b.click();
  await h.sleep(after);
}

/** A box (page coordinates relative to the viewport) around the union of some elements. */
async function unionBox(h, specs, { pad = 0, padRight = pad, padBottom = pad, padLeft = pad, padTop = pad } = {}) {
  const boxes = [];
  for (const s of specs) {
    const b = await h.loc(s).boundingBox();
    if (b) boxes.push(b);
  }
  const x1 = Math.min(...boxes.map((b) => b.x)) - padLeft, y1 = Math.min(...boxes.map((b) => b.y)) - padTop;
  const x2 = Math.max(...boxes.map((b) => b.x + b.width)) + padRight, y2 = Math.max(...boxes.map((b) => b.y + b.height)) + padBottom;
  return { box: { x: Math.max(0, x1), y: Math.max(0, y1), width: x2 - Math.max(0, x1), height: y2 - Math.max(0, y1) } };
}

// ── README builder draft (localStorage markdrop:builder:v1) ───────────────────

const F = "```";
const README_SECTIONS = [
  { uid: "sdemo1", templateId: "title-and-description", content: "# acme-cli\n\nThe command-line companion for Acme Cloud: manage metrics as code, run queries and push dashboards from your terminal or CI." },
  { uid: "sdemo2", templateId: "badges", content: "[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](https://choosealicense.com/licenses/mit/)\n[![Version](https://img.shields.io/badge/version-2.4.0-blue.svg)](#)\n[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#)" },
  { uid: "sdemo3", templateId: "installation", content: `## Installation\n\nInstall acme-cli with npm\n\n${F}bash\nnpm install -g @acme/cli\nacme login\n${F}` },
  { uid: "sdemo4", templateId: "features", content: "## Features\n\n- Metrics as YAML, reviewed like code\n- `acme query` with table, CSV or JSON output\n- Push dashboards from CI\n- Works on macOS, Linux and Windows" },
  { uid: "sdemo5", templateId: "mermaid-flowchart", content: `## Flowchart\n\n${F}mermaid\ngraph LR\n  A[metrics.yaml] --> B{acme lint}\n  B -->|ok| C[acme metrics push]\n  B -->|errors| D[Fix and retry]\n  D --> B\n${F}` },
];
const PRICING_FAQ = "# Pricing FAQ (draft)\n\nAnswers for the January 2027 pricing change. Password-protected until the announcement.\n\n## What's changing?\n\nWorkflows becomes part of every plan, with monthly run limits: 100 on Starter, 5,000 on Team and 50,000 on Business.\n\n## Do existing customers pay more?\n\nNo. Annual contracts keep their price until renewal, and monthly plans keep their price for six months.\n";

const Q3_PLAN = "# Q3 plan\n\nOwner: Riya Sharma · Last updated October 2026\n\n## Goals\n\n1. Grow weekly active teams from 4,100 to 5,500\n2. Cut median dashboard load time below 2 seconds\n3. Sign 15 new enterprise customers\n\n## Key results\n\n| Goal | Metric | Target | Status |\n| --- | --- | --- | --- |\n| Activation | Weekly active teams | 5,500 | On track |\n| Performance | Median load (s) | < 2.0 | Done |\n| Revenue | New enterprise logos | 15 | At risk |\n\n## Projects\n\n- [x] Onboarding checklist for new workspaces\n- [x] Move tile queries to the columnar store\n- [ ] Workflows private beta\n- [ ] SSO on the Team plan\n\n## Risks\n\nThe enterprise target depends on two security reviews closing in September. If they slip, we move the goal to Q4 and say so in the board update.\n";

/** Signed out at /new: publish "Q3 plan" at markdrop.in/q3-plan (not recorded; for the Published panel). */
async function publishQ3PlanAnonymously(h) {
  await h.page.evaluate(() => localStorage.removeItem("md_new_draft"));
  await h.page.reload({ waitUntil: "domcontentloaded" });
  await h.settle(600);
  await h.loc({ role: "textbox", name: "Title" }).fill("Q3 plan");
  await h.loc({ role: "textbox", name: "Markdown" }).fill(Q3_PLAN);
  await h.loc({ role: "button", name: "Link: Random link" }).click();
  await h.loc({ role: "dialog", name: "Link" }).getByRole("textbox").fill("q3-plan");
  await h.page.keyboard.press("Escape");
  await h.loc({ role: "button", name: "Publish", exact: true }).click();
  await h.page.waitForURL(/\/q3-plan\?new=1/, { timeout: 30_000 });
  await h.settle(800);
  await h.loc({ role: "region", name: "Published" }).waitFor();
  await h.sleep(600);
}

const builderDraft = (sections = README_SECTIONS) => JSON.stringify({ title: "acme-cli", sections });

/** shields.io badges, drawn locally (the capture browser never leaves localhost). */
function badgeSvg(label, message, color) {
  const colors = { green: "#97ca00", brightgreen: "#4c1", blue: "#007ec6" };
  const w = (s) => Math.round(s.length * 6.4 + 12);
  const lw = w(label), mw = w(message), c = colors[color] || color;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + mw}" height="20" role="img" aria-label="${label}: ${message}"><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${lw + mw}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${mw}" height="20" fill="${c}"/><rect width="${lw + mw}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="14">${label}</text><text x="${lw + mw / 2}" y="14">${message}</text></g></svg>`;
}
async function localBadges(h) {
  await h.context.route(/img\.shields\.io\/badge\//, (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop().replace(/\.svg$/, ""));
    const [label, message, color] = name.replace(/--/g, "\u0000").split("-").map((s) => s.replace(/\u0000/g, "-"));
    return route.fulfill({ contentType: "image/svg+xml", body: badgeSvg(label, message, color) });
  });
}
async function seedBuilder(h, draft = builderDraft()) {
  await localBadges(h);
  await h.page.evaluate((d) => localStorage.setItem("markdrop:builder:v1", d), draft);
  await h.page.reload({ waitUntil: "domcontentloaded" });
  await h.settle(800);
}

export default [
  // ════ /get-started/what-is-markdrop ═════════════════════════════════════════
  {
    id: "what-is-rendered-document",
    page: "/get-started/what-is-markdrop",
    kind: "screenshot",
    auth: "anon",
    url: "/getting-started",
    viewport: { width: 1440, height: 1012 },
    prepare: async (h) => {
      await escapeImmersive(h);
      await h.loc("figure svg").first().waitFor({ timeout: 30_000 });
      await h.page.evaluate(() => {
        const el = [...document.querySelectorAll("h2")].find((e) => e.textContent.includes("Connect a data source"));
        window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 140);
      });
      await h.sleep(800);
      await parkMouse(h);
    },
    keepScroll: true,
    crop: async (h) => ({ box: { x: 0, y: 56, width: 1440, height: h.shot.viewport.height - 56 } }),
  },
  {
    id: "what-is-rendered-html",
    page: "/get-started/what-is-markdrop",
    kind: "screenshot",
    auth: "anon",
    // The landing page rather than q3-dashboard: the dashboard's bar chart clips its widest label.
    url: "/workflows-beta",
    prepare: async (h) => {
      await escapeImmersive(h);
      await h.loc("iframe").first().waitFor();
      await h.sleep(3000); // the page loads in its sandboxed frame
      await parkMouse(h);
    },
    crop: { box: { x: 0, y: 56, width: 1440, height: 844 } },
  },

  // ════ /get-started/accounts ═════════════════════════════════════════════════
  {
    id: "sign-in-options",
    page: "/get-started/accounts",
    kind: "screenshot",
    auth: "anon",
    url: "/login",
    prepare: async (h) => {
      await h.loc({ role: "heading", name: "Sign in to Markdrop" }).waitFor();
      await parkMouse(h);
    },
    // The whole sign-in card: the form and, beside it, what signing in adds.
    crop: async (h) => unionBox(h, [{ role: "region", name: "Sign in" }, { role: "complementary", name: "What signing in adds" }], { pad: 24 }),
  },

  // ════ /get-started/first-document ═══════════════════════════════════════════
  {
    id: "editor-settings-chips",
    page: "/get-started/first-document",
    kind: "screenshot",
    auth: "anon",
    url: "/new",
    prepare: async (h) => {
      await h.page.evaluate(() => localStorage.removeItem("md_new_draft"));
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await h.settle(600);
      await h.loc({ role: "textbox", name: "Title" }).fill("Q3 plan");
      await h.loc({ role: "textbox", name: "Markdown" }).fill("# Q3 plan\n\nOwner: Riya Sharma · Last updated October 2026\n");
      await h.page.locator("body").click({ position: { x: 5, y: 880 } }).catch(() => {});
      await parkMouse(h);
    },
    crop: async (h) => unionBox(h, [{ text: "Publish settings", exact: true }, { role: "group", name: "Publish settings" }, { role: "button", name: "Publish", exact: true }, { role: "textbox", name: "Title" }, { text: "not published yet" }], { pad: 16, padBottom: 12 }),
  },

  {
    id: "published-panel",
    page: "/get-started/first-document",
    kind: "screenshot",
    auth: "anon",
    url: "/new",
    prepare: async (h) => {
      world("free", "q3-plan");
      await publishQ3PlanAnonymously(h);
      await parkMouse(h);
    },
    crop: { selector: { role: "region", name: "Published" }, pad: 16 },
    after: async () => world("restore", "q3-plan"),
  },

  // ════ /get-started/first-file ═══════════════════════════════════════════════
  {
    id: "artifact-actions-menu",
    page: "/get-started/first-file",
    kind: "screenshot",
    auth: "owner",
    url: "/q3-board-deck",
    prepare: async (h) => {
      await escapeImmersive(h);
      await h.loc({ role: "button", name: "More artifact actions" }).click();
      await h.loc({ role: "menu", name: "More artifact actions" }).waitFor();
      await h.sleep(600);
      await h.page.mouse.move(1000, 600);
    },
    crop: async (h) => {
      const bar = await h.loc({ role: "heading", name: "Q3 Board Deck" }).boundingBox();
      const menu = await h.loc({ role: "menu", name: "More artifact actions" }).boundingBox();
      const x = bar.x - 70;
      return { box: { x, y: 56, width: menu.x + menu.width + 24 - x, height: menu.y + menu.height + 24 - 56 } };
    },
  },

  // ════ /get-started/tour ═════════════════════════════════════════════════════
  {
    id: "create-menu",
    page: "/get-started/tour",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    prepare: async (h) => {
      await h.loc({ role: "heading", name: "My files" }).waitFor();
      await h.loc({ role: "button", name: "Create" }).click();
      await h.loc(".md-menu").waitFor();
      await h.sleep(600);
      await h.loc({ role: "menuitem", name: /Markdown document/ }).hover();
      await h.sleep(300);
    },
    crop: async (h) => unionBox(h, [{ role: "button", name: "Create" }, ".md-menu", { role: "button", name: /Account menu/ }], { pad: 16, padLeft: 6 }),
  },
  {
    id: "sidebar",
    page: "/get-started/tour",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1440, height: 800 },
    prepare: async (h) => {
      await h.loc({ role: "heading", name: "My files" }).waitFor();
      const acme = h.loc({ role: "treeitem", name: "Acme" });
      if ((await acme.getAttribute("aria-expanded")) !== "true") {
        await acme.locator("span[aria-hidden='true']").first().click(); // the chevron
        await h.loc({ role: "treeitem", name: "Releases" }).waitFor();
        await h.sleep(600);
      }
      await parkMouse(h);
    },
    crop: { selector: "aside:has(nav[aria-label='Your drive'])", pad: 0 },
  },
  {
    id: "document-bar",
    page: "/get-started/tour",
    kind: "screenshot",
    auth: "owner",
    url: "/getting-started",
    prepare: async (h) => {
      await escapeImmersive(h);
      await h.loc({ role: "button", name: "More actions" }).click();
      await h.loc({ role: "menu", name: "More actions" }).waitFor();
      await h.sleep(600);
      await h.page.mouse.move(700, 700);
    },
    crop: { box: { x: 0, y: 56, width: 1440, height: 440 } },
  },

  // ════ /documents/writing ════════════════════════════════════════════════════
  {
    id: "writing-diagram-math",
    page: "/documents/writing",
    kind: "screenshot",
    auth: "anon",
    url: "/getting-started",
    prepare: async (h) => {
      await escapeImmersive(h);
      await h.loc(".katex-display").waitFor();
      await h.loc("figure svg").first().waitFor();
      await h.sleep(800);
      await parkMouse(h);
    },
    crop: async (h) => {
      const head = await h.loc({ role: "heading", name: "How it fits together" }).boundingBox();
      const math = await h.loc(".katex-display").boundingBox();
      const article = await h.loc("article, .prose, [class*='markdown']").boundingBox();
      const x = (article?.x ?? head.x) - 24;
      return { box: { x, y: head.y - 24, width: (article?.width ?? 700) + 48, height: math.y + math.height + 24 - (head.y - 24) } };
    },
  },

  // ════ /documents/edit-key ═══════════════════════════════════════════════════
  {
    id: "edit-secret-prompt",
    page: "/documents/edit-key",
    kind: "screenshot",
    auth: "anon",
    url: "/q3-plan",
    prepare: async (h) => {
      await escapeImmersive(h);
      await h.loc({ role: "button", name: "More actions" }).click();
      await h.loc({ role: "menuitem", name: "Edit" }).click();
      const field = h.loc({ role: "textbox", name: "Edit secret" });
      await field.waitFor();
      await field.fill("sk_7f3a9c2e41b8d05f6a9e3c7b2d14f8a6");
      await parkMouse(h);
    },
    crop: { selector: ":is(section, div, form):has(> h1:text('Enter your edit secret'))", pad: 40 },
  },

  {
    id: "save-to-my-account",
    page: "/documents/edit-key",
    kind: "screenshot",
    auth: "anon",
    url: "/new",
    prepare: async (h) => {
      world("free", "q3-plan");
      await publishQ3PlanAnonymously(h);
      // Sign in in the same tab: the edit secret stays in this tab's sessionStorage.
      const { token } = await h.sandbox("/__sandbox/mint", { email: h.fx.users.riya.email });
      await h.context.addInitScript((t) => localStorage.setItem("markdrop_token", t), token);
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await h.settle(800);
      await h.loc({ role: "button", name: "Save to my account" }).waitFor();
      await parkMouse(h);
    },
    crop: { selector: { role: "region", name: "Published" }, pad: 16 },
    after: async () => world("restore", "q3-plan"),
  },

  // ════ /documents/link-previews ══════════════════════════════════════════════
  {
    id: "link-preview-cards",
    page: "/documents/link-previews",
    name: "art-preview-card", // "art-": the card is drawn the same in both themes (no .dark)
    kind: "screenshot",
    themes: ["light"],
    auth: "anon",
    url: (fx) => `${fx.api}/api/v1/og/q3-plan.png`,
    viewport: { width: 1200, height: 630 },
    dpr: 1,
    scrub: false,
    crop: { selector: "img", pad: 0 },
  },
  {
    id: "link-preview-private",
    page: "/documents/link-previews",
    name: "art-preview-card-private",
    kind: "screenshot",
    themes: ["light"],
    auth: "anon",
    url: (fx) => `${fx.api}/api/v1/og/sales-playbook.png`,
    viewport: { width: 1200, height: 630 },
    dpr: 1,
    scrub: false,
    crop: { selector: "img", pad: 0 },
  },

  // ════ /documents/passwords-and-expiry ═══════════════════════════════════════
  {
    id: "password-gate",
    page: "/documents/passwords-and-expiry",
    kind: "screenshot",
    auth: "anon",
    url: "/pricing-faq",
    prepare: async (h) => {
      await h.loc({ role: "heading", name: "This document is password protected" }).waitFor();
      await parkMouse(h);
    },
    crop: { selector: "section[aria-labelledby='md-gate-title']", pad: 32 },
  },
  {
    id: "expires-chip",
    page: "/documents/passwords-and-expiry",
    kind: "screenshot",
    auth: "anon",
    url: "/new",
    prepare: async (h) => {
      await h.page.evaluate(() => localStorage.removeItem("md_new_draft"));
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await h.settle(600);
      await h.loc({ role: "textbox", name: "Title" }).fill("Pricing FAQ (draft)");
      await h.loc({ role: "textbox", name: "Markdown" }).fill(PRICING_FAQ);
      await h.loc({ role: "button", name: "Expires: Never expires" }).click();
      const dialog = h.loc({ role: "dialog", name: "Expires" });
      await dialog.waitFor();
      await dialog.getByRole("combobox").selectOption({ label: "In 7 days" });
      await h.sleep(500);
      await parkMouse(h);
    },
    crop: async (h) => unionBox(h, [{ text: "Publish settings", exact: true }, { role: "group", name: "Publish settings" }, ".md-popover"], { pad: 16, padTop: 10 }),
  },

  // ════ /documents/readme-builder ═════════════════════════════════════════════
  {
    id: "builder-layout",
    page: "/documents/readme-builder",
    kind: "screenshot",
    auth: "anon",
    url: "/builder",
    prepare: async (h) => {
      await seedBuilder(h);
      await hideFloatingFeedback(h);
      await h.loc({ role: "list", name: "Your README sections" }).getByRole("button", { name: "Installation", exact: true }).click();
      await h.loc("figure svg, .mermaid svg").first().waitFor({ timeout: 20_000 }).catch(() => {});
      await h.sleep(1000);
      await parkMouse(h);
    },
    crop: { box: { x: 0, y: 56, width: 1440, height: 844 } },
  },

  // ════ Clips ═════════════════════════════════════════════════════════════════
  {
    id: "writing-editor-views",
    page: "/documents/writing",
    kind: "clip",
    auth: "anon",
    url: "/new?sample=diagrams",
    viewport: { width: 1280, height: 760 },
    out: 1440,
    prepare: async (h) => {
      await h.page.evaluate(() => { localStorage.removeItem("md_new_draft"); localStorage.removeItem("md_editor_view"); });
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await h.settle(1500);
      await h.loc({ role: "tab", name: "Write" }).click();
      await h.sleep(600);
      await h.loc({ role: "textbox", name: "Markdown" }).evaluate((el) => el.scrollTo(0, 0));
      await hideFloatingFeedback(h);
    },
    steps: async (h) => {
      await h.sleep(500);
      await h.click({ role: "tab", name: "Split" }, { after: 1600 });
      // Scroll the text: the preview follows.
      await h.move({ role: "textbox", name: "Markdown" });
      await h.wheel(700, 30);
      await h.sleep(1200);
      await h.click({ role: "tab", name: "Preview" }, { after: 1300 });
    },
    poster: 3.4,
    tail: 200,
  },
  {
    id: "link-chip",
    page: "/documents/addresses",
    kind: "clip",
    auth: "anon",
    url: "/new",
    viewport: { width: 1120, height: 560 },
    out: 1440,
    prepare: async (h) => {
      await h.page.evaluate(() => localStorage.removeItem("md_new_draft"));
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await h.settle(600);
      await h.loc({ role: "textbox", name: "Title" }).fill("Q3 plan");
      await h.loc({ role: "textbox", name: "Markdown" }).fill(Q3_PLAN);
      await h.loc({ role: "textbox", name: "Markdown" }).evaluate((el) => { el.blur(); el.setSelectionRange(0, 0); el.scrollTo(0, 0); });
      await hideFloatingFeedback(h);
      await h.page.mouse.move(700, 450);
    },
    steps: async (h) => {
      await h.sleep(500);
      await h.click({ role: "button", name: "Link: Random link" }, { after: 700 });
      await h.type(null, "q3-plan", { speed: 0.8 });
      await h.sleep(1200);
      await h.press("Escape", 300);
      await h.move([760, 420]);
      await h.sleep(900);
    },
    poster: 4.4,
    tail: 300,
  },
  {
    id: "change-url",
    page: "/documents/addresses",
    kind: "clip",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1280, height: 720 },
    out: 1440,
    prepare: async (h) => {
      world("reslug", "q3-plan-internal");
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await h.settle(800);
      await h.loc({ role: "heading", name: "My files" }).waitFor();
    },
    steps: async (h) => {
      await h.click({ role: "button", name: "Actions for Q3 plan — internal notes" }, { after: 700 });
      await h.click({ role: "menuitem", name: "Change URL" }, { after: 700 });
      await h.click({ role: "textbox", name: "New link" }, { after: 200 });
      await h.press(process.platform === "darwin" ? "Meta+A" : "Control+A", 150);
      await h.type(null, "q3-plan-final", { speed: 0.9 });
      await h.sleep(700);
      await h.click({ css: "[role=dialog] button:text-is('Change URL')" }, { after: 1700 });
    },
    after: async () => world("reslug", "q3-plan-internal"),
    poster: 6.5,
    tail: 300,
  },
  {
    id: "builder-reorder",
    page: "/documents/readme-builder",
    kind: "clip",
    auth: "anon",
    url: "/builder",
    viewport: { width: 1080, height: 608 },
    out: 1440,
    prepare: async (h) => {
      await seedBuilder(h);
      await hideFloatingFeedback(h);
      await h.loc({ role: "list", name: "Your README sections" }).getByRole("button", { name: "Title and Description", exact: true }).click();
      await h.sleep(800);
      await h.page.mouse.move(540, 500);
    },
    steps: async (h) => {
      await h.sleep(500);
      const handle = h.loc({ role: "button", name: "Reorder Features" });
      const target = await h.loc({ role: "button", name: "Reorder Installation" }).boundingBox();
      await h.hover(handle, 500);
      await h.page.mouse.down();
      await h.sleep(250);
      const [x, y] = await h.move(handle, { duration: 200 });
      await h.move([x, y - 12], { duration: 250 });
      await h.move([x, target.y + target.height / 2 - 8], { duration: 1300 });
      await h.sleep(600);
      await h.page.mouse.up();
      await h.sleep(1800);
    },
    poster: 2.6,
    tail: 300,
  },

  // ════ Videos ════════════════════════════════════════════════════════════════
  {
    id: "publish-first-document",
    page: "/get-started/first-document",
    kind: "video",
    auth: "anon",
    url: "/new",
    prepare: async (h) => {
      world("free", "q3-plan");
      await h.page.evaluate(() => { localStorage.removeItem("md_new_draft"); localStorage.setItem("md_editor_view", "write"); });
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await h.settle(800);
      await h.loc({ role: "textbox", name: "Markdown" }).waitFor();
      await hideFloatingFeedback(h);
    },
    steps: async (h) => {
      await h.caption("Write: a title, then paste or type Markdown", 600);
      await h.type({ role: "textbox", name: "Title" }, "Q3 plan", { speed: 1.2 });
      await h.sleep(300);
      await h.paste({ role: "textbox", name: "Markdown" }, Q3_PLAN);
      await h.loc({ role: "textbox", name: "Markdown" }).evaluate((el) => { el.setSelectionRange(0, 0); el.scrollTo(0, 0); });
      await h.sleep(900);
      await h.click({ role: "tab", name: "Split" }, { after: 2400 });
      await h.caption("Settings: the chips say who can open it, and where", 1200);
      await h.hover({ role: "group", name: "Publish settings" }, 900);
      await h.click({ role: "button", name: "Link: Random link" }, { after: 600 });
      await h.type(null, "q3-plan", { speed: 0.9 });
      await h.sleep(900);
      await h.press("Escape", 900);
      await h.caption("Publish  ·  ⌘ Enter works too", 500);
      await h.click({ role: "button", name: "Publish", exact: true }, { after: 300 });
      await h.page.waitForURL(/\/q3-plan\?new=1/, { timeout: 30_000 });
      await h.settle(900);
      await h.caption("Copy the link and share it anywhere", 600);
      const panel = h.loc({ role: "region", name: "Published" });
      await h.click(panel.getByRole("button", { name: "Copy link" }), { after: 1600 });
      await h.caption("No account? Keep your edit secret", 600);
      await h.hover(panel.getByRole("textbox").first(), 1200);
      await h.click(panel.getByRole("button", { name: "Copy secret" }), { after: 1800 });
      await h.caption("Show QR code to open it on a phone", 400);
      await h.click(panel.getByRole("button", { name: "Show QR code" }), { after: 2800 });
    },
    after: async () => world("restore", "q3-plan"),
    poster: 9,
  },
  {
    id: "publish-first-file",
    page: "/get-started/first-file",
    kind: "video",
    headed: true, // the PDF preview is Chrome's PDF viewer in a blob iframe
    auth: "owner",
    url: "/upload",
    prepare: async (h) => {
      world("free", "q3-board-deck");
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await h.settle(800);
      await hideFloatingFeedback(h);
      // A slower network, so the progress line is on screen for a moment (the sandbox is instant).
      await h.context.route(/\/__fakes3\//, async (route) => {
        if (route.request().method() === "PUT") await new Promise((r) => setTimeout(r, 4500));
        return route.continue();
      });
    },
    steps: async (h) => {
      await h.caption("Drop or choose a file at markdrop.in/upload", 400);
      await h.hover({ role: "button", name: "Choose a file" }, 700);
      await h.page.locator("input[type=file]").first().setInputFiles({
        name: "Q3 Board Deck.pdf", mimeType: "application/pdf", buffer: readFileSync(`${FIXTURES}q3-board-deck-v1.pdf`),
      });
      await h.sleep(800);
      await h.caption("Preview: drawn in your browser, nothing uploaded yet", 500);
      await h.hover({ role: "region", name: "Preview" }, 4500);
      await h.caption("Title and link come from the file name", 300);
      await h.scrollTo({ role: "textbox", name: "Title" }, { block: "center" });
      await h.hover({ role: "textbox", name: "Title" }, 1300);
      await h.hover({ role: "textbox", name: "Link" }, 1500);
      await h.caption("Who can open it: Anyone with the link", 300);
      await h.scrollTo({ role: "radiogroup", name: "Who can open it" }, { block: "center" });
      await h.hover({ role: "radio", name: /^Anyone with the link/ }, 1800);
      await h.caption("Publish, and keep the tab open while it uploads", 300);
      await h.scrollTo({ role: "button", name: "Publish", exact: true }, { block: "center" });
      await h.click({ role: "button", name: "Publish", exact: true }, { after: 300 });
      await h.page.waitForURL(/\/q3-board-deck\?new=1/, { timeout: 60_000 });
      await h.loc({ role: "region", name: "Published" }).waitFor({ timeout: 30_000 });
      await h.sleep(400);
      await h.caption("It opens at markdrop.in/q3-board-deck", 1500);
      const panel = h.loc({ role: "region", name: "Published" });
      await h.click(panel.getByRole("button", { name: "Copy link" }), { after: 1800 });
      await h.caption("Esc brings back its bar: Copy link, Download, More artifact actions", 300);
      await h.press("Escape", 900);
      await h.hover({ role: "button", name: "More artifact actions" }, 2600);
    },
    after: async () => world("restore", "q3-board-deck"),
    poster: 9,
  },
  {
    id: "app-tour",
    page: "/get-started/tour",
    kind: "video",
    auth: "owner",
    url: "/dashboard",
    prepare: async (h) => {
      await h.loc({ role: "heading", name: "My files" }).waitFor();
      await h.sleep(600);
    },
    steps: async (h) => {
      await h.caption("Create: a document, an artifact, a README, or send a file", 300);
      await h.click({ role: "button", name: "Create" }, { after: 500 });
      for (const name of [/Markdown document/, /^Artifact/, /README builder/, /Send a file/]) await h.hover({ role: "menuitem", name }, 650);
      await h.press("Escape", 500);
      await h.caption("My files: everything you own", 300);
      await h.click({ role: "tab", name: /^Documents/ }, { after: 1100 });
      await h.click({ role: "tab", name: /^Artifacts/ }, { after: 1100 });
      await h.click({ role: "tab", name: /^All/ }, { after: 700 });
      await openMenu(h, { role: "button", name: "Actions for Getting started with Acme" }, 1500);
      await h.press("Escape", 400);
      await h.caption("Shared with me", 200);
      await h.click({ role: "link", name: /^Shared with me/ }, { after: 300 });
      await h.settle(400);
      await h.sleep(1600);
      await h.caption("Analytics: views and engagement across your files", 200);
      await h.click({ role: "link", name: "Analytics", exact: true }, { after: 300 });
      await h.loc({ text: "Your links" }).waitFor({ timeout: 20_000 }).catch(() => {});
      await h.settle(500);
      await h.sleep(2200);
      await h.caption("Workspaces and their folders", 200);
      await h.click({ role: "treeitem", name: "Acme" }, { after: 300 });
      await h.settle(800);
      await h.sleep(2000);
      await h.goto("/getting-started", { settle: 900 });
      await h.caption("On a document: press Esc to bring back the bar", 200);
      await h.sleep(900);
      await h.press("Escape", 700);
      await h.hover({ role: "button", name: "Copy link", exact: true }, 700);
      await h.hover({ role: "button", name: "Share" }, 700);
      await h.hover({ role: "button", name: "Read full screen" }, 700);
      await openMenu(h, { role: "button", name: "More actions" }, 1600);
      await h.press("Escape", 300);
      await h.goto("/q3-board-deck", { settle: 1200 });
      await h.caption("On a file: Copy link, Download, More artifact actions", 200);
      await h.sleep(1200);
      await h.press("Escape", 900);
      await openMenu(h, { role: "button", name: "More artifact actions" }, 1800);
      await h.press("Escape", 300);
      await h.goto("/dashboard", { settle: 600 });
      await h.caption("⌘K searches everything", 200);
      await h.press("Meta+k", 600);
      await h.type(null, "q3", { speed: 0.8 });
      await h.sleep(2600);
      await h.press("Escape", 600);
    },
    poster: 3,
  },
  {
    id: "password-and-expiry",
    page: "/documents/passwords-and-expiry",
    kind: "video",
    auth: "owner",
    url: "/new",
    prepare: async (h) => {
      world("free", "pricing-faq");
      // The server stamps the expiry from its own clock: keep the browser's on it too, or a
      // 7-day expiry reads "in 8 days" when the seeded demo clock lags a few minutes.
      await h.page.clock.setSystemTime(new Date());
      // The reader's "other window": the same app on 127.0.0.1, where nobody is signed in.
      await h.context.addInitScript(() => { if (location.hostname === "127.0.0.1") localStorage.removeItem("markdrop_token"); });
      await h.page.evaluate(() => { localStorage.removeItem("md_new_draft"); localStorage.setItem("md_editor_view", "split"); });
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await h.settle(800);
      await h.loc({ role: "textbox", name: "Title" }).fill("Pricing FAQ (draft)");
      await h.loc({ role: "textbox", name: "Markdown" }).fill(PRICING_FAQ);
      await h.loc({ role: "textbox", name: "Markdown" }).evaluate((el) => { el.blur(); el.setSelectionRange(0, 0); el.scrollTo(0, 0); });
      await hideFloatingFeedback(h);
      await h.page.mouse.move(900, 600);
    },
    steps: async (h) => {
      await h.caption("Owner: choose the Password chip", 600);
      await h.click({ role: "button", name: "Password: No password" }, { after: 600 });
      await h.type(null, "acme-2027", { speed: 0.9 });
      await h.sleep(900);
      await h.press("Escape", 500);
      await h.caption("Expires: pick when the link stops working", 400);
      await h.click({ role: "button", name: "Expires: Never expires" }, { after: 700 });
      const select = h.loc({ role: "dialog", name: "Expires" }).getByRole("combobox");
      await h.hover(select, 400);
      await select.selectOption({ label: "In 7 days" });
      await h.sleep(2400);
      await h.press("Escape", 400);
      await h.click({ role: "button", name: "Link: Random link" }, { after: 500 });
      await h.type(null, "pricing-faq", { speed: 1.2 });
      await h.press("Escape", 500);
      await h.caption("Publish", 300);
      await h.click({ role: "button", name: "Publish", exact: true }, { after: 300 });
      await h.page.waitForURL(/\/pricing-faq\?new=1/, { timeout: 30_000 });
      // Product bug (reported): signed in, a password-protected document at /<slug>?new=1 stays on
      // the loading skeleton (no Published panel). Open its plain address instead, as a reload would.
      const panelUp = await h.loc({ role: "region", name: "Published" }).waitFor({ timeout: 900 }).then(() => true, () => false);
      if (panelUp) {
        await h.click(h.loc({ role: "region", name: "Published" }).getByRole("button", { name: "Copy link" }), { after: 1500 });
      } else {
        await h.page.evaluate(() => sessionStorage.removeItem("secret:pricing-faq"));
        await h.goto("/pricing-faq", { settle: 900 });
        await h.page.evaluate((t) => window.__mdcap?.caption(t), "Publish"); // same chapter, new page
        await h.press("Escape", 700);
        await h.click({ role: "button", name: "Copy link", exact: true }, { after: 1500 });
      }
      await h.goto(`http://127.0.0.1:${new URL(h.APP).port}/pricing-faq`, { settle: 900 });
      await h.caption("Reader: opens the link, signed out", 300);
      await h.loc({ role: "heading", name: "This document is password protected" }).waitFor();
      await h.sleep(1600);
      await h.caption("Reader: types the password, then Unlock", 300);
      await h.type({ role: "textbox", name: "Password" }, "acme-2027", { speed: 0.9 });
      await h.sleep(400);
      await h.click({ role: "button", name: "Unlock" }, { after: 1500 });
      await h.settle(400);
      await h.caption("The document opens", 0);
      await h.press("Escape", 2600);
    },
    after: async () => world("restore", "pricing-faq"),
    poster: 6,
  },
  {
    id: "readme-builder",
    page: "/documents/readme-builder",
    kind: "video",
    auth: "anon",
    url: "/builder",
    prepare: async (h) => {
      await localBadges(h);
      await h.page.evaluate(() => localStorage.removeItem("markdrop:builder:v1"));
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await h.settle(800);
      await hideFloatingFeedback(h);
    },
    steps: async (h) => {
      await h.caption("Name your README", 300);
      await h.type({ role: "textbox", name: "README title (optional)" }, "acme-cli", { speed: 1.1 });
      await h.sleep(700);
      await h.caption("Add sections from the catalog", 300);
      await h.type({ role: "searchbox", name: "Search sections" }, "install", { speed: 1.2 });
      await h.sleep(500);
      await h.click({ role: "button", name: "Add Installation" }, { after: 700 });
      await h.click({ role: "searchbox", name: "Search sections" }, { after: 100 });
      await h.press(process.platform === "darwin" ? "Meta+A" : "Control+A", 100);
      await h.type(null, "feat", { speed: 1.2 });
      await h.sleep(400);
      await h.click({ role: "button", name: "Add Features" }, { after: 700 });
      await h.click({ role: "searchbox", name: "Search sections" }, { after: 100 });
      await h.press(process.platform === "darwin" ? "Meta+A" : "Control+A", 100);
      await h.type(null, "flow", { speed: 1.2 });
      await h.sleep(400);
      await h.click({ role: "button", name: "Add Flowchart" }, { after: 1200 });
      await h.caption("Fill one in: select it and edit its Markdown", 300);
      const list = h.loc({ role: "list", name: "Your README sections" });
      await h.click(list.getByRole("button", { name: "Installation", exact: true }), { after: 700 });
      const editor = h.loc({ role: "textbox", name: "Installation markdown" });
      await h.click(editor, { after: 200 });
      await h.press(process.platform === "darwin" ? "Meta+A" : "Control+A", 100);
      await h.paste(null, "## Installation\n\nInstall acme-cli with npm\n\n```bash\nnpm install -g @acme/cli\nacme login\n```");
      await h.sleep(1500);
      await h.caption("Drag a section by its handle to reorder", 300);
      const handle = h.loc({ role: "button", name: "Reorder Features" });
      const target = await h.loc({ role: "button", name: "Reorder Installation" }).boundingBox();
      await h.hover(handle, 400);
      await h.page.mouse.down();
      await h.sleep(200);
      const [x, y] = await h.move(handle, { duration: 150 });
      await h.move([x, y - 12], { duration: 250 });
      await h.move([x, target.y + target.height / 2 - 8], { duration: 1200 });
      await h.sleep(500);
      await h.page.mouse.up();
      await h.sleep(1200);
      await h.caption("Preview: this section, or the full README", 300);
      await h.click({ role: "tab", name: "This section" }, { after: 1500 });
      await h.click({ role: "tab", name: "Full README" }, { after: 800 });
      await h.move({ role: "region", name: "Preview" });
      await h.wheel(500, 14);
      await h.sleep(1200);
      await h.caption("Publish… makes it a Markdrop link", 300);
      await h.click({ role: "button", name: "Publish…" }, { after: 1800 });
      await h.click(h.loc({ role: "dialog" }).getByRole("button", { name: "Publish", exact: true }), { after: 300 });
      await h.page.waitForURL(/\?new=1/, { timeout: 30_000 });
      await h.settle(900);
      await h.caption("Your README, live at its own link", 2800);
    },
    poster: 14,
  },
];
