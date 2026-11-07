/**
 * Viewer analytics on the REAL stack (backend services/doc_views.py, lib/engage.ts, the Worker's
 * bridge): a Markdown document, a PDF and a video, each opened by a signed-in reader (Cy Stranger)
 * and by an anonymous one, with real interactions (scrolling, turning pages, playing and seeking);
 * then the owner's Viewers tab shows both views with their timelines. Plus who may see it (a
 * workspace editor in full, a viewer the counts), the owner's own views (hidden by default), the
 * CSV and the MCP tools. Screenshots in light and dark at 1440, a tablet in portrait and a phone.
 *
 *   PB_STACK_ID=43 PB_WORK=… zsh up.sh start
 *   PB_STACK_ID=43 PB_WORK=… PB_FIXTURES=… BROWSER=chromium|webkit [ONLY=doc,pdf] node viewers.mjs
 *
 * Shots go to $VIEWERS_SHOTS (default <main checkout>/.work/viewer-analytics/shots).
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit } from "@playwright/test";
import { APP, BROWSER, here, log, fail, reseed, api, mcp, mcpToken, ctx, stepper, uploadFile } from "./lib.mjs";

const ROOT = path.resolve(here, "../../../..").split("/.claude/worktrees/")[0].replace(/\/\.work\/wt\/[^/]+$/, "");
const OUT = process.env.VIEWERS_SHOTS || path.join(ROOT, ".work", "viewer-analytics", "shots");
fs.mkdirSync(OUT, { recursive: true });
const FIX = process.env.PB_FIXTURES || path.join(ROOT, "frontend", "scripts", "docs-media", ".data", "fixtures");
// Headless Chromium says "HeadlessChrome", which the beacons drop as a bot, and a per-context UA
// doesn't reach a beacon sent while a page unloads: set it for the whole browser.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const browser = BROWSER === "webkit" ? await webkit.launch() : await chromium.launch({ args: [`--user-agent=${UA}`] });
const { step, results } = stepper(browser);

const S = reseed();
const ada = S.users.owner.token, cy = S.users.stranger.token, ben = S.users.member.token, vic = S.users.reader.token;
const filing = { workspace: S.ws, folder: S.folder, access_level: "link" };

const MD = [
  "# Field guide", "", "Why this exists, in one paragraph. ".repeat(8), "",
  ...["Setup", "Usage", "Pricing", "Support"].flatMap((h) => [`## ${h}`, "", `${h} details. `.repeat(60), "", "```sh\nmarkdrop publish notes.md\n```", ""]),
].join("\n");
const doc = await api("POST", "/api/v1/documents", ada, { title: "Field guide", custom_slug: "field-guide", expires_in: "never", content: MD, ...filing });
if (doc.status >= 300) fail(`doc → ${doc.status} ${JSON.stringify(doc.body).slice(0, 200)}`);
await uploadFile(ada, { bytes: fs.readFileSync(path.join(FIX, "q3-board-deck-v1.pdf")), filename: "board-deck.pdf", mime: "application/pdf", title: "Board deck", slug: "board-deck", ...filing });
await uploadFile(ada, { bytes: fs.readFileSync(path.join(FIX, "product-demo-v1.mp4")), filename: "demo.mp4", mime: "video/mp4", title: "Product demo", slug: "demo-video", ...filing });
log("seeded field-guide, board-deck, demo-video");

const frame = (p) => p.frameLocator("iframe").first();

// Where each reader is: Cloudflare's visitor-location headers on the way to the API (the sandbox has
// no GeoIP database; the backend falls back to these, as it does behind Cloudflare).
const PLACES = {
  anon: { "cf-ipcountry": "IN", "cf-ipcity": "Mumbai", "cf-region": "Maharashtra" },
  cy: { "cf-ipcountry": "DE", "cf-ipcity": "Berlin", "cf-region": "Berlin" },
};

/** Open a link as `token` (null: anonymous), do `act`, then leave so the final beacon goes. */
async function viewAs(slug, token, act) {
  const { c, p } = await ctx(browser, { token });
  const place = token === cy ? PLACES.cy : token ? null : PLACES.anon;
  if (place) {
    await c.route(/\/api\/v1\/documents\/[^/]+\/engage$/, (r) =>
      r.continue({ headers: { ...r.request().headers(), "x-markdrop-test": "1", ...place } }));
  }
  await p.goto(`${APP}/${slug}`);
  await p.waitForLoadState("networkidle").catch(() => {});
  await p.waitForTimeout(1800); // the first send (~1.2 s in) puts the view on the list
  await act(p);
  await p.waitForTimeout(1200);
  // Leaving the page (pagehide) sends the last of it.
  await p.goto("about:blank");
  await p.waitForTimeout(800);
  await c.close();
}

async function readDoc(p) {
  for (let i = 0; i < 14; i++) {
    await p.mouse.move(400 + i, 400);
    await p.mouse.wheel(0, 500);
    await p.waitForTimeout(450);
  }
}

async function turnPages(p) {
  const f = frame(p);
  await f.locator("canvas, .page, #out").first().waitFor({ timeout: 30000 });
  await p.locator("iframe").first().click({ position: { x: 300, y: 300 } }).catch(() => {});
  for (let i = 0; i < 6; i++) {
    await p.keyboard.press("PageDown");
    await p.mouse.wheel(0, 700);
    await p.waitForTimeout(700);
  }
}

async function watch(p) {
  const f = frame(p);
  const v = f.locator("video");
  await v.waitFor({ timeout: 30000 });
  await v.evaluate((el) => { el.muted = true; return el.play(); });
  await p.waitForTimeout(3500);
  await v.evaluate((el) => el.pause());
  await p.waitForTimeout(500);
  await v.evaluate((el) => { el.currentTime = Math.min(20, (el.duration || 30) * 0.6); return el.play(); });
  await p.waitForTimeout(2500);
  await v.evaluate((el) => el.pause());
}

const ITEMS = { doc: ["field-guide", readDoc, /Read |Scrolled to/], pdf: ["board-deck", turnPages, /page \d/i], video: ["demo-video", watch, /Watched \d/] };

async function viewersTab(token, slug, { theme = "light", width = 1440, height = 1000, mobile = false } = {}) {
  const { p } = await ctx(browser, { token, theme, width, height, mobile });
  await p.goto(`${APP}/dashboard/analytics/${slug}?tab=viewers`);
  await p.getByText(/Every view|You can see how many people/).first().waitFor({ timeout: 30000 });
  return p;
}

async function shot(p, name) {
  await p.waitForTimeout(500);
  await p.screenshot({ path: path.join(OUT, `${BROWSER}-${name}.png`) });
  log("shot", name);
}

async function noHScroll(p, what) {
  const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 1) fail(`${what}: ${over}px horizontal scroll`);
}

for (const [kind, [slug, act, stepRe]] of Object.entries(ITEMS)) {
  await step(kind, async () => {
    await viewAs(slug, cy, act);
    await viewAs(slug, null, act);
    // The owner looks too: her own view is hidden by default.
    await viewAs(slug, ada, async () => {});
    const r = await api("GET", `/api/v1/me/documents/${slug}/analytics/viewers?range=7d`, ada);
    if (r.status !== 200) fail(`viewers → ${r.status}`);
    const names = r.body.views.map((v) => v.viewer.name);
    log(kind, "views:", names.join(", "), "| own hidden:", r.body.totals.own_hidden);
    if (!names.includes("Cy Stranger")) fail(`no Cy Stranger view: ${names}`);
    if (!names.some((n) => /^Visitor [0-9A-F]{4}$/.test(n))) fail(`no anonymous view: ${names}`);
    if (r.body.totals.own_hidden < 1) fail("the owner's own view wasn't kept apart");
    const cyView = r.body.views.find((v) => v.viewer.name === "Cy Stranger");
    if (cyView.viewer.email !== "cy@else.test") fail("no email for the signed-in viewer");
    const anon = r.body.views.find((v) => v.viewer.type === "anonymous");
    if (anon.viewer.email) fail("an anonymous viewer has an email");
    if (!cyView.system.browser || !cyView.system.viewport || !cyView.location.timezone) fail(`system/location missing: ${JSON.stringify(cyView.system)} ${JSON.stringify(cyView.location)}`);

    // The UI: both rows; Cy's timeline in the drawer.
    const p = await viewersTab(ada, slug);
    await p.getByRole("button", { name: /Cy Stranger/ }).first().waitFor({ timeout: 20000 });
    await p.getByRole("button", { name: /Visitor [0-9A-F]{4}/ }).first().waitFor({ timeout: 20000 });
    await p.getByRole("button", { name: /Cy Stranger/ }).first().click();
    const drawer = p.getByRole("dialog");
    await drawer.getByText("What they did").waitFor({ timeout: 20000 });
    await drawer.getByText(/^Opened/).first().waitFor();
    const steps = await drawer.locator('ol[aria-label="What they did"] > li').allInnerTexts();
    log(kind, "timeline:", steps.map((s) => s.split("\n")[0]).join(" | "));
    if (!steps.some((s) => stepRe.test(s))) fail(`${kind}: no ${stepRe} step in ${steps.join(" / ")}`);
    if (!new URL(p.url()).searchParams.get("view")) fail("the open view isn't in the URL");
    await shot(p, `${kind}-timeline-light-1440`);
    await p.keyboard.press("Escape");
    await shot(p, `${kind}-list-light-1440`);
    // Own views: shown, marked You, when the switch is off.
    await p.getByText("Hide my own views", { exact: true }).click();
    await p.getByText("You", { exact: true }).first().waitFor({ timeout: 15000 });
    await p.context().close();
  });
}

await step("screens", async () => {
  for (const theme of ["light", "dark"]) {
    for (const [w, h, mobile, name] of [[1440, 1000, false, "1440"], [820, 1180, true, "tablet"], [390, 844, true, "phone"]]) {
      if (theme === "light" && name === "1440") continue; // above
      const p = await viewersTab(ada, "field-guide", { theme, width: w, height: h, mobile });
      await p.getByRole("button", { name: /Cy Stranger/ }).first().waitFor({ timeout: 20000 });
      await noHScroll(p, `${theme} ${name}`);
      await shot(p, `doc-list-${theme}-${name}`);
      await p.getByRole("button", { name: /Cy Stranger/ }).first().click();
      await p.getByRole("dialog").getByText("What they did").waitFor({ timeout: 20000 });
      await noHScroll(p, `${theme} ${name} drawer`);
      await shot(p, `doc-timeline-${theme}-${name}`);
      await p.context().close();
    }
  }
});

await step("filters-and-people", async () => {
  const p = await viewersTab(ada, "demo-video");
  await p.getByLabel("Who").selectOption("anonymous");
  await p.waitForFunction(() => !document.body.innerText.includes("Cy Stranger"), null, { timeout: 15000 });
  await p.getByLabel("Who").selectOption("all");
  await p.getByRole("button", { name: /Cy Stranger/ }).first().waitFor({ timeout: 15000 });
  await p.getByRole("radio", { name: "By person" }).or(p.getByRole("button", { name: "By person" })).first().click();
  await p.getByText(/view(s)? ·/).first().waitFor({ timeout: 15000 });
  await shot(p, "video-people-light-1440");
  const csv = await api("GET", `/api/v1/me/documents/demo-video/analytics/viewers.csv?range=7d`, ada);
  if (csv.status !== 200 || !String(csv.body).includes("cy@else.test")) fail("CSV has no signed-in row");
  await p.context().close();
});

await step("who-sees-what", async () => {
  // Ben (a workspace member, so an editor) sees everything, on the viewers-only page.
  const p = await viewersTab(ben, "board-deck");
  await p.getByRole("button", { name: /Cy Stranger/ }).first().waitFor({ timeout: 20000 });
  await shot(p, "pdf-editor-view-light-1440");
  await p.context().close();
  // Vic (a workspace viewer) sees the counts.
  const q = await viewersTab(vic, "board-deck");
  await q.getByText(/You can see how many people viewed this/).waitFor({ timeout: 20000 });
  if (await q.getByText("Cy Stranger").count()) fail("a workspace viewer sees names");
  await shot(q, "pdf-viewer-counts-light-1440");
  await q.context().close();
  // Cy (the viewer himself, not in the workspace) sees nothing.
  const r = await api("GET", `/api/v1/me/documents/board-deck/analytics/viewers`, cy);
  if (r.status !== 403) fail(`a stranger → ${r.status}`);
});

await step("mcp", async () => {
  const tok = mcpToken("ada@acme.test", true);
  const res = await mcp(tok, "get_document_viewers", { document: "field-guide", range: "7d" });
  if (res.isError) fail(res.text);
  if (!res.text.includes("Cy Stranger")) fail(`MCP list: ${res.text.slice(0, 300)}`);
  const id = res.data.views.find((v) => v.viewer.name === "Cy Stranger").id;
  const tl = await mcp(tok, "get_view_timeline", { document: "field-guide", view_id: id });
  if (tl.isError || !tl.data.steps.length) fail(`MCP timeline: ${tl.text.slice(0, 300)}`);
  log("mcp timeline:", tl.text.split("\n").slice(0, 4).join(" | "));
});

await browser.close();
console.log("\n" + results.map(([n, r, ms]) => `${r === "ok" ? "PASS" : "FAIL"}  ${n}  ${(ms / 1000).toFixed(1)} s${r === "ok" ? "" : "  " + r}`).join("\n"));
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
