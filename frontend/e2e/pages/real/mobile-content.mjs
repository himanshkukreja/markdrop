/**
 * Pages, the classic Markdown viewer and the file viewers on phones and tablets (fix/mobile-content):
 * the New page flow and its template gallery, a page with a cover, an icon and every kind of block
 * (in the editor and to a reader), its menus and pickers, the classic viewer/editor/gate and each
 * file viewer, at every device size, as the owner, a workspace viewer and a stranger. Each state is
 * measured in the page (mobile-measure.mjs) and flagged automatically:
 *
 *   hscroll    the page scrolls sideways (scrollWidth > clientWidth)
 *   offscreen  a visible control or text is cut off by the viewport's edge (not by its own scroller)
 *   popup      a menu, popover, sheet or dialog doesn't fit inside the viewport
 *   target     an interactive element's touch target is under 44 × 44 px (elementFromPoint probes,
 *              so a larger invisible hit area counts, and a neighbour inside the 44 px box doesn't)
 *   input      a text field's font size is under 16 px (iOS zooms the page on focus)
 *   text       text under 12 px
 *   overlap    two fixed or sticky bars cover each other
 *   hover      a control that only shows on hover (opacity 0 until :hover) on a touch screen
 *   image      an image that overflows or is stretched; a cover that isn't the paper's full width,
 *              is too tall for its width or doesn't fill its box
 *   grid       a grid's cards squeezed under 140 px or overflowing their grid
 *   zoom       the viewport meta disables pinch zoom
 *
 * Screenshots: $PB_WORK/mobile-content/<browser>/<theme>/<device>/<role>-<state>.png; findings in
 * findings-<browser>.json/.txt there. Exit code 1 when anything is flagged (a regression suite).
 *
 *   PB_STACK_ID=35 BROWSER=chromium|webkit [DEVICES=ipad-mini,phone-393] [ROLES=owner,reader,anon]
 *     [THEMES=light,dark] [ONLY=new-gallery,page-edit,…] [NO_RESEED=1] [SHOTS=0] node mobile-content.mjs
 *
 * Dark runs a phone and a tablet (the colours, not the layout, change); light runs every device.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit } from "@playwright/test";
import { APP, BROWSER, STACK, WORK, log, fail, reseed, seedNow, api } from "./lib.mjs";
import { measure } from "./mobile-measure.mjs";

export const DEVICES = [
  { name: "phone-360", w: 360, h: 780, kind: "phone" },
  { name: "phone-375", w: 375, h: 667, kind: "phone" },
  { name: "phone-393", w: 393, h: 852, kind: "phone" },
  { name: "phone-412", w: 412, h: 915, kind: "phone" },
  { name: "phone-land", w: 852, h: 393, kind: "phone" },
  { name: "ipad-mini", w: 744, h: 1133, kind: "tablet" },
  { name: "ipad-768", w: 768, h: 1024, kind: "tablet" },
  { name: "ipad-810", w: 810, h: 1080, kind: "tablet" },
  { name: "ipad-air", w: 820, h: 1180, kind: "tablet" },
  { name: "ipad-pro11", w: 834, h: 1194, kind: "tablet" },
  { name: "android-tab", w: 800, h: 1280, kind: "tablet" },
  { name: "ipad-land", w: 1024, h: 768, kind: "tablet" },
  { name: "ipad-air-land", w: 1180, h: 820, kind: "tablet" },
  { name: "ipad-pro13", w: 1024, h: 1366, kind: "tablet" },
];
const DARK_DEVICES = new Set(["phone-393", "ipad-air"]);

const want = (env, all) => (process.env[env] ? process.env[env].split(",").map((s) => s.trim()).filter(Boolean) : all);
const devices = DEVICES.filter((d) => want("DEVICES", DEVICES.map((x) => x.name)).includes(d.name));
const roles = want("ROLES", ["owner", "reader", "anon"]);
const themes = want("THEMES", ["light", "dark"]);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const SKIP = process.env.SKIP ? new Set(process.env.SKIP.split(",")) : null;
const SHOOT = process.env.SHOTS !== "0";
const SHARED = process.env.SHARED_CSS ? fs.readFileSync(process.env.SHARED_CSS, "utf8") : null;
const OUT = path.join(WORK, "mobile-content", BROWSER);
fs.mkdirSync(OUT, { recursive: true });
const FIX = process.env.PB_FIXTURES || path.join(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../.."), "scripts/docs-media/.data/fixtures");

/* ── Seed ─────────────────────────────────────────────────────────────── */

const EXTRA = path.join(STACK, "seed-mobile-content.json");
const ok = (r, what) => {
  if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
};

async function upload(token, buf, filename, mime, title, filing) {
  const u = ok(await api("POST", "/api/v1/artifacts/upload-url", token, { filename, content_type: mime, size_bytes: buf.length }), `upload-url ${filename}`);
  const put = await fetch(u.upload_url, { method: "PUT", body: buf, headers: { "Content-Type": u.required_content_type } });
  if (!put.ok) fail(`PUT ${filename} → ${put.status}`);
  return ok(await api("POST", "/api/v1/artifacts", token, { blob_key: u.blob_key, title, filename, ...filing }), `artifact ${filename}`);
}

const WIDE_TABLE = [
  "| Region | Owner | Q1 | Q2 | Q3 | Q4 | Target | Status | Notes |",
  "| --- | --- | --: | --: | --: | --: | --: | --- | --- |",
  "| North America | Ada Owner | 1,240 | 1,380 | 1,512 | 1,690 | 6,000 | On track | Renewals up after the pricing change |",
  "| Europe | Ben Member | 880 | 910 | 1,020 | 1,105 | 4,000 | At risk | Two big deals slipped to January |",
  "| Asia Pacific | Wes Admin | 410 | 530 | 640 | 790 | 2,500 | Ahead | New partner in Singapore |",
].join("\n");
const LONG_CODE = "```ts\nexport async function publish(page: Page, { workspace, folder, access = \"workspace\", notify = true }: PublishOptions): Promise<Published> { return api.post(`/pages/${page.slug}/publish`, { workspace, folder, access, notify }); }\n```";
const MERMAID = "```mermaid\nflowchart LR\n  A[Idea from a customer call] --> B{Worth a doc?}\n  B -- yes --> C[Draft in the editor]\n  C --> D[Review by the team]\n  D --> E[Lock the page]\n  E --> F[Publish to the guide]\n  F --> G[Readers]\n```";
const MATH = "$$\n\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2} \\qquad \\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6} \\qquad E = mc^2 + \\frac{p^2}{2m} + V(x, y, z, t)\n$$";

function richBody({ photo, pdf, html, sub, cover = "gallery:ascent" }) {
  return [
    "---", "icon: 🚀", `cover: ${cover}`, "cover_y: 35", "---", "",
    ":::note", "**Release:** 2026-11-10 · **Status:** Draft · **Owner:** Ben", ":::", "",
    "## What's new",
    "",
    "We ship the page builder on November 10. Owners: Ada (frontend), Ben (backend). Rollout in three waves, starting with the Acme workspace, then everyone on a paid plan, then everyone. A long unbroken address: https://markdrop.in/w/acme/f/guides/a-really-long-page-address-that-should-wrap-on-a-phone",
    "",
    "- [ ] Docs updated", "- [x] Support briefed", "- [ ] Announcement sent", "",
    "## The numbers", "", WIDE_TABLE, "",
    "## The code", "", LONG_CODE, "",
    "## The flow", "", MERMAID, "",
    "## The maths", "", MATH, "",
    "## Files", "",
    `::markdrop{src="${photo}" mode="live"}`, "",
    `::markdrop{src="${pdf}" mode="card"}`, "",
    `::markdrop{src="${html}" mode="live"}`, "",
    `Mentioned inline: :markdrop[Q3 report]{src="${pdf}"} and the pricing calculator.`, "",
    "::::columns", ":::column", "### Left", "Text in the left column that wraps across lines.", ":::", ":::column", "### Right", "Text in the right column, beside it on wide screens.", ":::", "::::", "",
    ":::details{summary=\"Changelog entry\"}", "**Page builder**: one line for the changelog.", ":::", "",
    ":::warning", "List anything that doesn't work yet, so nobody finds out the hard way.", ":::", "",
    `::page{src="${sub}"}`, "",
    "That's all for now.", "",
  ].join("\n");
}

async function seedContent(S) {
  const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
  const filing = { workspace: S.ws, folder: S.folder, access_level: "workspace" };
  const slug = (x) => x?.slug ?? x?.artifact?.slug ?? x?.document?.slug;
  const video = await upload(T.owner, fs.readFileSync(path.join(FIX, "product-demo-v1.mp4")), "product-demo.mp4", "video/mp4", "Product demo", filing);
  const csv = ["Region,Owner,Q1,Q2,Q3,Q4,Target,Status,Notes", "North America,Ada,1240,1380,1512,1690,6000,On track,Renewals up", "Europe,Ben,880,910,1020,1105,4000,At risk,Two deals slipped", "Asia Pacific,Wes,410,530,640,790,2500,Ahead,New partner", ...Array.from({ length: 40 }, (_, i) => `Row ${i + 4},Someone,${i},${i * 2},${i * 3},${i * 4},${i * 10},OK,Note ${i}`)].join("\n");
  const sheet = await upload(T.owner, Buffer.from(csv), "forecast.csv", "text/csv", "Forecast", filing);
  const main = ok(await api("POST", "/api/v1/pages", T.owner, { title: "Field guide", ...filing, auto_cover: false }), "page");
  const mainSlug = main.document.slug;
  const sub = ok(await api("POST", "/api/v1/pages", T.owner, { title: "Rollout checklist", parent: mainSlug, auto_cover: false }), "sub-page");
  const files = { image: "team-photo", pdf: "q3-report", html: "pricing-calc", video: slug(video), sheet: slug(sheet) };
  const body = richBody({ photo: files.image, pdf: files.pdf, html: files.html, sub: sub.document.slug });
  ok(await api("PUT", `/api/v1/documents/${mainSlug}`, T.owner, { title: "Field guide", content: body }), "page body");
  const open = ok(await api("POST", "/api/v1/pages", T.owner, { title: "Open house notes", workspace: S.ws, folder: S.folder, access_level: "link", auto_cover: false }), "open page");
  ok(await api("PUT", `/api/v1/documents/${open.document.slug}`, T.owner, { title: "Open house notes", content: richBody({ photo: files.image, pdf: files.pdf, html: files.html, sub: sub.document.slug, cover: "gallery:circuit" }) }), "open body");
  ok(await api("PUT", `/api/v1/documents/${open.document.slug}/access/level`, T.owner, { level: "link" }), "open level");
  const board = ok(await api("POST", `/api/v1/workspaces/${S.ws}/folders`, T.owner, { name: "Roadmap" }), "board folder");
  const boardId = board.id ?? board.folder?.id;
  ok(await api("PUT", `/api/v1/workspaces/${S.ws}/folders/${boardId}/properties`, T.owner, {
    properties: [
      { key: "status", name: "Status", type: "select", options: [{ name: "Planned", color: "gray" }, { name: "In build", color: "blue" }, { name: "Shipped", color: "green" }] },
      { key: "owner", name: "Owner", type: "text" },
      { key: "due", name: "Due", type: "date" },
      { key: "effort", name: "Effort (engineer weeks)", type: "number" },
    ],
  }), "board schema");
  const prop = ok(await api("POST", "/api/v1/pages", T.owner, { title: "Usage-based billing with a long title that wraps", workspace: S.ws, folder: boardId, auto_cover: false }), "prop page");
  ok(await api("PATCH", `/api/v1/documents/${prop.document.slug}/properties`, T.owner, { values: { status: "In build", owner: "Ada Owner", due: "2026-12-01", effort: 6 } }), "prop values");
  const md = `# Release notes\n\nWhat changed this week, for everyone who reads the handbook. A long unbroken address: https://markdrop.in/w/acme/f/guides/a-really-long-page-address-that-should-wrap-on-a-phone\n\n## Numbers\n\n${WIDE_TABLE}\n\n## Code\n\n${LONG_CODE}\n\n## Flow\n\n${MERMAID}\n\n## Maths\n\n${MATH}\n\n> A quote with *emphasis*.\n\n${"More notes follow here, with enough text to make the column feel like a real document. ".repeat(12)}\n`;
  const classic = ok(await api("POST", "/api/v1/documents", T.member, { title: "Release notes", content: md, expires_in: "never" }), "classic");
  const mine = ok(await api("POST", "/api/v1/documents", T.owner, { title: "Draft notes", content: md, expires_in: "never", workspace: S.ws, folder: S.folder, access_level: "workspace" }), "classic mine");
  const gated = ok(await api("POST", "/api/v1/documents", T.owner, { title: "Locked notes", content: md, expires_in: "never", read_password: "open sesame" }), "classic gated");
  const out = { page: mainSlug, sub: sub.document.slug, open: open.document.slug, prop: prop.document.slug, board: boardId, classic: classic.slug, mine: mine.slug, gated: gated.slug, files };
  fs.writeFileSync(EXTRA, JSON.stringify(out, null, 1));
  return out;
}

let S, X;
if (process.env.NO_RESEED && fs.existsSync(EXTRA)) {
  S = seedNow();
  X = JSON.parse(fs.readFileSync(EXTRA, "utf8"));
} else {
  S = reseed();
  X = await seedContent(S);
}
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
log("seeded", JSON.stringify(X));

/* ── Helpers ──────────────────────────────────────────────────────────── */

const tap = async (p, loc, { timeout = 8000, force = false } = {}) => {
  const l = typeof loc === "string" ? p.locator(loc).first() : loc.first();
  await l.waitFor({ state: force ? "attached" : "visible", timeout });
  await l.scrollIntoViewIfNeeded().catch(() => {});
  await l.tap({ timeout, force }).catch(async () => l.click({ timeout, force }));
  await p.waitForTimeout(450);
};
const EDITABLE = '.pb-live .ProseMirror[contenteditable="true"]';
const editorReady = (p) => p.locator(EDITABLE).first();
const pageReady = (p) => p.locator(".pb-page, .pb-live .ProseMirror").first();
/** Put the caret at the end of the paragraph holding `text` (a tap, like a finger). */
async function caretIn(p, text) {
  const para = p.locator(`${EDITABLE} p`, { hasText: text }).first();
  await para.scrollIntoViewIfNeeded();
  const b = await para.boundingBox();
  await p.touchscreen.tap(b.x + Math.min(b.width - 4, 40), b.y + b.height / 2).catch(() => para.click());
  await p.waitForTimeout(300);
  await p.keyboard.press("End");
}
const openPageMenu = async (p) => tap(p, p.getByRole("button", { name: "Page options" }));
const menuItem = async (p, name) => tap(p, p.getByRole("menuitem", { name }));
const tapCover = async (p) => {
  const c = p.locator(".pb-cover-img").first();
  await c.waitFor({ timeout: 8000 });
  const b = await c.boundingBox();
  await p.touchscreen.tap(b.x + b.width / 3, b.y + b.height / 2);
  await p.waitForTimeout(500);
};
const pageUrl = (slug) => `${APP}/${slug}`;
const newUrl = () => `${APP}/pages/new?workspace=${S.ws}&folder=${S.folder}`;
const dialog = (p) => p.getByRole("dialog").first();

/** [name, roles, url, ready(p), action?(p, dev)] — an action returning "skip" skips the state. */
const STATES = [
  // The New page flow: the gallery as the Create menu opens it, a template picked (its preview).
  ["new-gallery", ["owner"], newUrl, dialog],
  ["new-gallery-pick", ["owner"], newUrl, dialog, async (p) => {
    await tap(p, p.getByRole("dialog").locator(".pb-template", { hasText: "Feature guide" }));
    await p.locator(".pb-template-preview").first().waitFor({ timeout: 8000 });
  }],
  ["new-gallery-bottom", ["owner"], newUrl, dialog, async (p) => {
    await tap(p, p.getByRole("dialog").locator(".pb-template", { hasText: "Product spec" }));
    await p.locator(".pb-template-preview").first().waitFor({ timeout: 8000 });
    await p.locator(".pb-template-preview").first().scrollIntoViewIfNeeded();
  }],
  ["new-subpage", ["owner"], () => pageUrl(X.page), editorReady, async (p) => {
    await openPageMenu(p);
    await menuItem(p, /Add a sub-page/);
    await p.getByRole("dialog").locator(".pb-templates").waitFor({ timeout: 8000 });
  }],
  // A page in the editor: the head (cover, icon), the body, the pickers and menus.
  ["page-edit", ["owner"], () => pageUrl(X.page), editorReady],
  ["page-edit-body", ["owner"], () => pageUrl(X.page), editorReady, async (p) => {
    await p.locator(`${EDITABLE} table`).first().scrollIntoViewIfNeeded();
  }],
  ["page-edit-embeds", ["owner"], () => pageUrl(X.page), editorReady, async (p) => {
    await p.locator(".pb-live :is(.pb-embed, .dxe-pembed, .pb-card)").first().scrollIntoViewIfNeeded();
    await p.waitForTimeout(800);
  }],
  ["page-cover", ["owner"], () => pageUrl(X.page), editorReady, tapCover],
  ["page-coverpick", ["owner"], () => pageUrl(X.page), editorReady, async (p) => {
    await tapCover(p);
    await tap(p, p.getByRole("button", { name: "Change cover" }), { force: true });
    await p.locator(".pb-coverpick, .pb-covergal").first().waitFor({ timeout: 6000 });
  }],
  ["page-iconpick", ["owner"], () => pageUrl(X.page), editorReady, async (p) => {
    await tap(p, p.getByRole("button", { name: "Change icon" }));
    await p.locator(".pb-emojipick").first().waitFor({ timeout: 6000 });
  }],
  ["page-slash", ["owner"], () => pageUrl(X.page), editorReady, async (p) => {
    await caretIn(p, "That's all for now");
    await p.keyboard.press("Enter");
    await p.keyboard.type("/");
    await p.locator(".dxe-slash").first().waitFor({ timeout: 6000 });
  }],
  ["page-mention", ["owner"], () => pageUrl(X.page), editorReady, async (p) => {
    await caretIn(p, "That's all for now");
    await p.keyboard.press("Enter");
    await p.keyboard.type("@");
    await p.locator(".dxe-people").first().waitFor({ timeout: 6000 });
  }],
  ["page-table", ["owner"], () => pageUrl(X.page), editorReady, async (p) => {
    const cell = p.locator(`${EDITABLE} td`, { hasText: "Europe" }).first();
    await cell.scrollIntoViewIfNeeded();
    const b = await cell.boundingBox();
    await p.touchscreen.tap(b.x + 10, b.y + b.height / 2);
    await p.waitForTimeout(600);
  }],
  ["page-select", ["owner"], () => pageUrl(X.page), editorReady, async (p) => {
    await caretIn(p, "We ship the page builder");
    await p.keyboard.press("Home");
    for (let i = 0; i < 6; i++) await p.keyboard.press("Shift+ArrowRight");
    await p.waitForTimeout(700);
  }],
  ["page-more", ["owner"], () => pageUrl(X.page), editorReady, openPageMenu],
  ["page-history", ["owner"], () => pageUrl(X.page), editorReady, async (p) => {
    await openPageMenu(p);
    await menuItem(p, /Version history/);
    await p.waitForTimeout(1200);
  }],
  ["page-export", ["owner"], () => pageUrl(X.page), editorReady, async (p) => {
    await openPageMenu(p);
    await menuItem(p, /Export/);
    await p.getByRole("dialog").first().waitFor({ timeout: 6000 });
  }],
  ["page-share", ["owner"], () => pageUrl(X.page), editorReady, async (p) => {
    await tap(p, p.getByRole("button", { name: /^Share/ }));
    await p.getByRole("dialog").first().waitFor({ timeout: 6000 });
  }],
  ["page-props", ["owner"], () => pageUrl(X.prop), editorReady],
  ["page-sub", ["owner"], () => pageUrl(X.sub), editorReady],
  // Readers.
  ["page-read", ["reader"], () => pageUrl(X.page), pageReady],
  ["page-read-body", ["reader"], () => pageUrl(X.page), pageReady, async (p) => {
    await p.locator(".pb-paper table").first().scrollIntoViewIfNeeded();
  }],
  ["page-read-more", ["reader"], () => pageUrl(X.page), pageReady, openPageMenu],
  ["page-anon", ["anon"], () => pageUrl(X.open), pageReady],
  ["page-anon-gate", ["anon"], () => pageUrl(X.page), (p) => p.locator("main, h1").first()],
  // Classic Markdown.
  ["classic-view", ["anon", "owner"], () => pageUrl(X.classic), (p) => p.locator("h1").first()],
  ["classic-view-body", ["anon"], () => pageUrl(X.classic), (p) => p.locator("h1").first(), async (p) => {
    await p.locator("table").first().scrollIntoViewIfNeeded();
  }],
  ["classic-edit", ["owner"], () => `${pageUrl(X.mine)}?edit=1`, (p) => p.locator("textarea, .ProseMirror, [contenteditable=true], .cm-editor").first()],
  ["classic-gate", ["anon"], () => pageUrl(X.gated), (p) => p.locator("input[type=password]").first()],
  // File viewers (the viewer body is the Worker's page in an iframe).
  ["file-image", ["owner"], () => pageUrl(X.files.image), (p) => p.locator("iframe, main img").first()],
  ["file-pdf", ["owner"], () => pageUrl(X.files.pdf), (p) => p.locator("iframe").first(), async (p) => p.waitForTimeout(2500)],
  ["file-html", ["owner"], () => pageUrl(X.files.html), (p) => p.locator("iframe").first()],
  ["file-video", ["owner"], () => pageUrl(X.files.video), (p) => p.locator("iframe, video").first(), async (p) => p.waitForTimeout(1500)],
  ["file-sheet", ["owner"], () => pageUrl(X.files.sheet), (p) => p.locator("iframe").first(), async (p) => p.waitForTimeout(1500)],
];

/** Measure inside the Worker's viewer frame too (sideways scroll, small text, targets). */
async function measureFrames(p) {
  const res = [];
  for (const f of p.frames()) {
    if (f === p.mainFrame()) continue;
    try {
      const r = await f.evaluate(measure, { checkTargets: true });
      for (const x of r) if (["hscroll", "target", "text", "input", "zoom", "image"].includes(x.rule)) res.push({ ...x, who: `frame:${x.who}` });
    } catch {}
  }
  return res;
}

/* ── Run ──────────────────────────────────────────────────────────────── */

const browserType = BROWSER === "webkit" ? webkit : chromium;
const browser = await browserType.launch();
const findings = [];
let states = 0;

async function newContext(dev, theme, role) {
  const token = role === "anon" ? null : T[role];
  const c = await browser.newContext({
    viewport: { width: dev.w, height: dev.h },
    deviceScaleFactor: 2,
    isMobile: BROWSER !== "webkit" ? true : undefined,
    hasTouch: true,
    colorScheme: theme,
  });
  // SHARED_CSS=<file>: inject another branch's shared touch layer (fix/mobile-shell's ui/touch.css) to
  // audit this area as it will be once both land.
  if (SHARED) await c.addInitScript((css) => {
    const add = () => { const s = document.createElement("style"); s.dataset.shared = ""; s.textContent = css; document.head.appendChild(s); };
    if (document.head) add(); else document.addEventListener("DOMContentLoaded", add);
  }, SHARED);
  await c.addInitScript(([t, th]) => {
    try {
      if (t) localStorage.setItem("markdrop_token", t);
      else localStorage.removeItem("markdrop_token");
      localStorage.setItem("md_theme", th);
      localStorage.setItem("md_theme_beta", "1");
      localStorage.setItem("md_consent", "denied");
      localStorage.setItem("md_install_dismissed", "1");
    } catch {}
  }, [token, theme]);
  const p = await c.newPage();
  p.on("pageerror", (e) => log("  [pageerror]", dev.name, e.message.slice(0, 200)));
  return { c, p };
}

for (const theme of themes) {
  for (const dev of devices) {
    if (theme === "dark" && !DARK_DEVICES.has(dev.name)) continue;
    for (const role of roles) {
      const list = STATES.filter(([name, rs]) => rs.includes(role) && (!ONLY || ONLY.has(name)) && !(SKIP && SKIP.has(name)));
      for (const [name, , url, ready, action] of list) {
        // A fresh context per state: no lock, picker or scroll position carries over.
        const { c, p } = await newContext(dev, theme, role);
        const key = `${theme}/${dev.name}/${role}/${name}`;
        const dir = path.join(OUT, theme, dev.name);
        fs.mkdirSync(dir, { recursive: true });
        try {
          await p.goto(url(role), { waitUntil: "domcontentloaded", timeout: 45000 });
          await ready(p).waitFor({ state: "visible", timeout: 30000 });
          await p.waitForTimeout(900);
          if (action) {
            const r = await action(p, dev);
            if (r === "skip") { await c.close(); continue; }
          }
          await p.waitForTimeout(300);
          const res = await p.evaluate(measure, { checkTargets: true });
          if (name.startsWith("file-")) res.push(...(await measureFrames(p)));
          states++;
          for (const f of res) findings.push({ browser: BROWSER, theme, device: dev.name, role, state: name, ...f });
          if (SHOOT) await p.screenshot({ path: path.join(dir, `${role}-${name}.png`) });
          log(`${key}: ${res.length ? [...new Set(res.map((f) => f.rule))].join(",") : "ok"}`);
        } catch (e) {
          findings.push({ browser: BROWSER, theme, device: dev.name, role, state: name, rule: "error", who: "-", detail: e.message.split("\n")[0].slice(0, 200) });
          log(`${key}: ERROR ${e.message.split("\n")[0].slice(0, 200)}`);
          await p.screenshot({ path: path.join(dir, `${role}-${name}-error.png`) }).catch(() => {});
        }
        await c.close();
      }
    }
  }
}

// Orientation change: a phone and two tablets turned with a page (and the gallery) open keep a fitting layout.
if ((!ONLY || ONLY.has("rotate")) && !(SKIP && SKIP.has("rotate"))) {
  for (const [a, b] of [[DEVICES[2], DEVICES[4]], [DEVICES[8], DEVICES[12]], [DEVICES[5], DEVICES[11]]]) {
    const { c, p } = await newContext(a, "light", "owner");
    for (const u of [pageUrl(X.page), newUrl()]) {
      await p.goto(u, { waitUntil: "domcontentloaded" });
      await p.locator(".pb-live .ProseMirror, [role=dialog]").first().waitFor({ timeout: 30000 }).catch(() => {});
      await p.waitForTimeout(700);
      for (const d of [b, a]) {
        await p.setViewportSize({ width: d.w, height: d.h });
        await p.waitForTimeout(700);
        const res = (await p.evaluate(measure, { checkTargets: false })).filter((f) => ["hscroll", "offscreen", "popup", "overlap", "image", "grid"].includes(f.rule));
        states++;
        for (const f of res) findings.push({ browser: BROWSER, theme: "light", device: `${a.name}→${d.name}`, role: "owner", state: `rotate:${u.replace(APP, "").replace(/\?.*/, "")}`, ...f });
      }
    }
    await c.close();
  }
}

await browser.close();

/* ── Report ───────────────────────────────────────────────────────────── */

const tag = process.env.TAG ? `-${process.env.TAG}` : "";
fs.writeFileSync(path.join(OUT, `findings-${BROWSER}${tag}.json`), JSON.stringify(findings, null, 1));
const groups = new Map();
for (const f of findings) {
  const k = `${f.rule}|${f.state}|${f.who}`;
  const g = groups.get(k) ?? { ...f, where: new Set(), details: new Set() };
  g.where.add(`${f.theme[0]}:${f.device}:${f.role}`);
  g.details.add(f.detail);
  groups.set(k, g);
}
const lines = [...groups.values()]
  .sort((a, b) => a.rule.localeCompare(b.rule) || a.state.localeCompare(b.state))
  .map((g) => `${g.rule.padEnd(9)} ${g.state.padEnd(20)} ${g.who}  — ${[...g.details].slice(0, 2).join(" | ")}  [${g.where.size}: ${[...g.where].slice(0, 4).join(" ")}${g.where.size > 4 ? " …" : ""}]`);
fs.writeFileSync(path.join(OUT, `findings-${BROWSER}${tag}.txt`), lines.join("\n") + "\n");
console.log(`\n${states} states, ${findings.length} findings in ${groups.size} groups (${OUT}/findings-${BROWSER}${tag}.txt)`);
const byRule = {};
for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
console.log(byRule);
if (findings.length) process.exit(1);
