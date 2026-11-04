/**
 * ✦ Insights (Analytics AI per document) on the REAL stack, against the fake model in api_run.py
 * (PB_FAKE_ANALYTICS_AI=1): one step per kind (content, media, pages, versions), plus thin data, the
 * Apply in page round trip, MCP, and what was sent to the model (never a visitor's hash, country
 * or referrer).
 *
 *   PB_FAKE_ANALYTICS_AI=1 PB_STACK_ID=31 PB_WORK=… zsh up.sh start
 *   PB_STACK_ID=31 PB_WORK=… PB_FIXTURES=… BROWSER=chromium|webkit [ONLY=content,media] node analytics-ai-doc.mjs
 *
 * Screenshots (light and dark at 1440 and 390, a tablet in portrait) go to $AI_SHOTS
 * (default <main checkout>/.work/analytics-ai/doc).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { APP, BROWSER, STACK, STACK_ID, here, log, fail, reseed, api, mcp, mcpToken, launch, ctx, stepper } from "./lib.mjs";

const ROOT = path.resolve(here, "../../../..").split("/.claude/worktrees/")[0].replace(/\/\.work\/wt\/[^/]+$/, "");
const OUT = process.env.AI_SHOTS || path.join(ROOT, ".work", "analytics-ai", "doc");
fs.mkdirSync(OUT, { recursive: true });
const PY = path.join(ROOT, "backend", ".venv", "bin", "python");

const browser = await launch();
const { step, results } = stepper(browser);
if (!process.env.NO_RESEED) reseed();
const CALLS = path.join(STACK, "analytics-ai-calls.jsonl");
fs.rmSync(CALLS, { force: true });
const S = JSON.parse(execFileSync(PY, [path.join(here, "seed_analytics_ai_doc.py")], {
  env: { ...process.env, STACK_ID: String(STACK_ID), PB_STACK: STACK }, encoding: "utf8",
}).trim().split("\n").pop());
const T = JSON.parse(fs.readFileSync(path.join(STACK, "seed-analytics-ai-doc.json"), "utf8")).owner.token;
log("seeded", JSON.stringify(S));

async function snap(p, name) {
  await p.waitForTimeout(400);
  const file = path.join(OUT, `${BROWSER}-${name}.png`);
  await p.screenshot({ path: file });
  log("shot", path.basename(file));
}

const panel = (p) => p.locator("section.an-ai").first();
const findings = (p) => panel(p).locator('ol[aria-label="Findings"] > li');

async function open(p, slug, tab) {
  await p.goto(`${APP}/dashboard/analytics/${slug}?tab=${tab}`);
  await panel(p).waitFor({ timeout: 30000 });
}

/** Analyse: the running state shows, then 3 to 5 findings. */
async function analyse(p) {
  const btn = panel(p).getByRole("button", { name: "Analyse", exact: true });
  await btn.waitFor({ timeout: 20000 });
  const box = await btn.boundingBox();
  if (!box || box.height < 44) fail(`Analyse is ${box?.height}px tall (want ≥ 44)`);
  await btn.click();
  await panel(p).locator('[data-state="running"], [role="status"]').first().waitFor({ timeout: 5000 });
  await findings(p).first().waitFor({ timeout: 30000 });
  const n = await findings(p).count();
  if (n < 3 || n > 5) fail(`${n} findings`);
}

/** Screenshots at 1440 and 390 in light and dark (the analysis is cached, so no new call). */
async function shots(slug, tab, name, prep) {
  for (const theme of ["light", "dark"]) {
    for (const [w, h] of [[1440, 1000], [390, 844]]) {
      const { p } = await ctx(browser, { token: T, theme, width: w, height: h, mobile: w < 500 });
      await open(p, slug, tab);
      await findings(p).first().waitFor({ timeout: 20000 });
      if (prep) await prep(p);
      await panel(p).scrollIntoViewIfNeeded();
      if (w < 500) {
        // Phones: no horizontal scroll, and every control at least 44 px tall.
        const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (over > 1) fail(`${name} ${theme} ${w}: ${over}px horizontal scroll`);
        const small = await panel(p).locator("button").evaluateAll((bs) => bs.filter((b) => b.offsetParent && b.getBoundingClientRect().height < 43.5).map((b) => b.textContent?.trim() || b.getAttribute("aria-label")));
        if (small.length) fail(`${name}: small touch targets: ${small.join(", ")}`);
      }
      await snap(p, `${name}-${theme}-${w}`);
      await p.context().close();
    }
  }
}

await step("thin", async () => {
  const { p } = await ctx(browser, { token: T });
  await open(p, S.thin, "content");
  await panel(p).getByText("3 of 20 sessions").waitFor({ timeout: 10000 });
  if (await panel(p).getByRole("button", { name: "Analyse" }).count()) fail("Analyse offered on thin data");
  await snap(p, "thin-light-1440");
});

await step("content", async () => {
  const { p } = await ctx(browser, { token: T });
  await open(p, S.page, "content");
  await panel(p).getByText("never anything about your readers").waitFor();
  await snap(p, "content-empty-light-1440");
  await analyse(p);
  const first = findings(p).first();
  await first.getByText("Readers leave at Configuration").waitFor();
  await first.getByRole("button", { name: "Show a suggested rewrite" }).click();
  await first.getByText("Set your **API key** first", { exact: false }).waitFor();
  await first.getByRole("button", { name: "Copy rewrite" }).waitFor();
  await first.getByRole("button", { name: "Apply in page" }).waitFor();
  await snap(p, "content-ready-light-1440");
  // A second visit reads the cache: no new model call.
  const before = fs.readFileSync(CALLS, "utf8").trim().split("\n").length;
  await p.reload();
  await findings(p).first().waitFor({ timeout: 20000 });
  if (fs.readFileSync(CALLS, "utf8").trim().split("\n").length !== before) fail("a reload called the model again");
  await shots(S.page, "content", "content", async (pg) => {
    await findings(pg).first().getByRole("button", { name: "Show a suggested rewrite" }).click();
  });
});

await step("apply", async () => {
  const { p } = await ctx(browser, { token: T });
  await open(p, S.page, "content");
  const first = findings(p).first();
  await first.getByRole("button", { name: "Show a suggested rewrite" }).click();
  await first.getByRole("button", { name: "Apply in page" }).click();
  await p.waitForURL((u) => u.pathname === `/${S.page}`, { timeout: 20000 });
  await p.getByText("Suggested rewrite of “Configuration”").waitFor({ timeout: 30000 });
  if (new URL(p.url()).searchParams.get("apply")) fail("?apply stayed in the address");
  await snap(p, "apply-suggestion-light-1440");
  // Nothing changed yet: Discard leaves the page as it was.
  const doc0 = (await api("GET", `/api/v1/documents/${S.page}`, T)).body;
  if (!doc0.content.includes("Every option is explained")) fail("the page changed before Accept");
  await p.getByRole("button", { name: /^Discard/ }).first().click();
  await p.waitForTimeout(800);
  if (await p.getByText("Suggested rewrite of “Configuration”").count()) fail("the suggestion stayed after Discard");
  const doc1 = (await api("GET", `/api/v1/documents/${S.page}`, T)).body;
  if (doc1.content !== doc0.content) fail("Discard changed the page");
  // Again, and Accept: the section is rewritten under its own heading; the rest stays.
  await open(p, S.page, "content");
  const again = findings(p).first();
  await again.getByRole("button", { name: "Show a suggested rewrite" }).click();
  await again.getByRole("button", { name: "Apply in page" }).click();
  await p.getByText("Suggested rewrite of “Configuration”").waitFor({ timeout: 30000 });
  await p.getByRole("button", { name: /^Accept/ }).first().click();
  let saved = null;
  for (let i = 0; i < 30 && !saved; i++) {
    await p.waitForTimeout(500);
    const d = (await api("GET", `/api/v1/documents/${S.page}`, T)).body;
    if (d.content.includes("Set your **API key** first")) saved = d.content;
  }
  if (!saved) fail("Accept didn't save the rewrite");
  if (!/## Configuration\s+Set your \*\*API key\*\* first/.test(saved)) fail("the heading wasn't kept above the rewrite");
  if (saved.includes("Every option is explained")) fail("the old section text stayed");
  for (const keep of ["## Install", "## Your first report", "## Troubleshooting", "npm install -g acme-cli"]) {
    if (!saved.includes(keep)) fail(`Accept lost ${keep}`);
  }
  await snap(p, "apply-accepted-light-1440");
});

await step("media", async () => {
  const { p } = await ctx(browser, { token: T });
  await open(p, S.video, "video");
  await analyse(p);
  const chip = panel(p).locator(".an-ai__chip").first();
  await chip.waitFor();
  await chip.click();
  const chart = p.locator('section[aria-labelledby="md-ret"]');
  await chart.locator("svg g[data-highlight]").waitFor({ timeout: 5000 });
  if ((await chip.getAttribute("aria-pressed")) !== "true") fail("the chip isn't pressed");
  await panel(p).getByText("Suggested chapters").waitFor();
  await panel(p).getByRole("button", { name: "Copy chapters" }).waitFor();
  await snap(p, "media-ready-light-1440");
  await chip.click();
  if (await chart.locator("svg g[data-highlight]").count()) fail("a second click didn't clear the mark");
  await shots(S.video, "video", "media", async (pg) => { await panel(pg).locator(".an-ai__chip").first().click(); });
});

await step("pages", async () => {
  const { p } = await ctx(browser, { token: T });
  await open(p, S.pdf, "pages");
  await analyse(p);
  await panel(p).getByText(/^Page \d+$/).first().waitFor();
  await shots(S.pdf, "pages", "pages");
});

await step("versions", async () => {
  const { p } = await ctx(browser, { token: T });
  await open(p, S.video, "versions");
  await analyse(p);
  await panel(p).getByText(/confidence$/).first().waitFor();
  await panel(p).getByText("Markdrop computes this from the numbers, not the AI.", { exact: false }).waitFor();
  await shots(S.video, "versions", "versions");
});

await step("tablet", async () => {
  const { p } = await ctx(browser, { token: T, width: 768, height: 1024, mobile: true });
  await open(p, S.video, "video");
  await findings(p).first().waitFor({ timeout: 20000 });
  const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 1) fail(`tablet: ${over}px horizontal scroll`);
  await snap(p, "media-light-768");
});

await step("stale", async () => {
  // The page changes: the analysis says so, and Re-analyse makes a new one.
  const doc = (await api("GET", `/api/v1/documents/${S.page}`, T)).body;
  const r = await api("PUT", `/api/v1/documents/${S.page}`, T, { content: doc.content + "\nOne more line.\n", base_rev: doc.rev });
  if (r.status >= 300) {
    const r2 = await api("PATCH", `/api/v1/pages/${S.page}`, T, { content: doc.content + "\nOne more line.\n" });
    if (r2.status >= 300) fail(`couldn't change the page: ${r.status} ${r2.status}`);
  }
  const { p } = await ctx(browser, { token: T });
  await open(p, S.page, "content");
  await panel(p).getByText("since this analysis", { exact: false }).waitFor({ timeout: 20000 });
  await snap(p, "content-stale-light-1440");
  const before = fs.readFileSync(CALLS, "utf8").trim().split("\n").length;
  await panel(p).getByRole("button", { name: "Re-analyse" }).click();
  await p.locator('section.an-ai[data-state="running"]').waitFor({ timeout: 5000 });
  await p.locator('section.an-ai[data-state="ready"]').waitFor({ timeout: 30000 });
  if (await panel(p).getByText("since this analysis", { exact: false }).count()) fail("still stale after Re-analyse");
  if (fs.readFileSync(CALLS, "utf8").trim().split("\n").length !== before + 1) fail("Re-analyse didn't call the model once");
});

await step("privacy", async () => {
  const sent = fs.readFileSync(CALLS, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  if (!sent.length) fail("nothing was sent");
  const all = sent.map((c) => c.user).join("\n");
  for (const bad of ["news.example.com", "\"DE\"", "\"FR\"", "ip_hash", "\"ip", "Ada Owner", "ada@acme.test"]) {
    if (all.includes(bad)) fail(`the model was sent ${bad}`);
  }
  if (!all.includes("<untrusted_section")) fail("section text wasn't wrapped as untrusted");
  const media = sent.find((c) => c.user.includes("\"key_moments\""));
  log("media call images:", media?.images);
  if (media && media.images > 6) fail(`${media.images} frames sent (max 6)`);
});

await step("mcp", async () => {
  const tok = mcpToken(JSON.parse(fs.readFileSync(path.join(STACK, "seed-analytics-ai-doc.json"), "utf8")).owner.email, true);
  const r = await mcp(tok, "analyze_document_engagement", { document: S.pdf, kind: "pages" });
  if (r.isError) fail(`MCP: ${r.text.slice(0, 200)}`);
  if (r.data?.state !== "ready" || !r.text.includes("[page ")) fail(`MCP answer: ${r.text.slice(0, 200)}`);
});

await browser.close();
console.log(`\n${BROWSER}:`);
for (const [n, r, ms] of results) console.log(`  ${r === "ok" ? "✓" : "✗"} ${n} ${r === "ok" ? "" : r} (${(ms / 1000).toFixed(1)} s)`);
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
