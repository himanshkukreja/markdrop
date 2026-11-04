/**
 * Analytics AI on the analytics home, on the REAL stack (up.sh with PB_FAKE_ANALYTICS_AI=1, so the model
 * is the fake in api_run.py): ✦ Insights shows a story whose links open the right analytics page,
 * Refresh writes it again, Ask streams an answer whose link opens the document's analytics, Write this
 * next shows a gap to the workspace owner (never to a member, not even through the API) and "Create page
 * from this outline" makes and opens the page, and a workspace search is logged without who ran it.
 *
 *   PB_FAKE_ANALYTICS_AI=1 PB_STACK_ID=32 PB_WORK=… BROWSER=chromium|webkit [ONLY=story,ask] node analytics-ai.mjs
 *
 * Screenshots (light and dark at 1440, 820 and 390) go to $AI_SHOTS.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { APP, BROWSER, WORK, STACK_ID, here, log, fail, reseed, seedNow, api, mcp, mcpToken, launch, ctx, stepper } from "./lib.mjs";

const browser = await launch();
const { step, results } = stepper(browser);
const S = process.env.NO_RESEED ? seedNow() : reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const U = S.users;
const WS = S.ws;
const OUT = process.env.AI_SHOTS || path.resolve(WORK, "..", "shots");
fs.mkdirSync(OUT, { recursive: true });
const ROOT = path.resolve(here, "..", "..", "..", "..").split("/.work/wt/")[0];
const PY = path.join(ROOT, "backend", ".venv", "bin", "python");
const seed = (...args) => JSON.parse(execFileSync(PY, [path.join(here, "seed_analytics_ai.py"), ...args],
  { env: { ...process.env, STACK_ID: String(STACK_ID) }, encoding: "utf8" }).trim().split("\n").pop());
const ok = (r, what) => { if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };

async function snap(p, name) {
  await p.waitForTimeout(400);
  const file = path.join(OUT, `${BROWSER}-${name}.png`);
  await p.screenshot({ path: file, fullPage: true });
  log("shot", path.basename(file));
}

// ── The world ────────────────────────────────────────────────────────────────
const personal = { access_level: "link", expires_in: "never" };
ok(await api("POST", "/api/v1/documents", T.owner, { ...personal, title: "Launch notes", custom_slug: "launch-notes",
  content: "# Launch notes\n\nWhat shipped this week.\n\n## Details\n\nMore.\n" }), "launch doc");
ok(await api("POST", "/api/v1/documents", T.owner, { ...personal, title: "Pricing FAQ", custom_slug: "pricing-faq",
  content: "# Pricing FAQ\n\nQuestions about plans.\n" }), "pricing doc");
ok(await api("POST", "/api/v1/documents", T.member, { ...personal, title: "Member secret plan", custom_slug: "member-secret",
  content: "# Member secret plan\n" }), "member doc");
seed("views", U.owner.id, "launch-notes:30:https://news.ycombinator.com/item?id=42", "pricing-faq:8");
seed("views", U.member.id, "member-secret:12");
seed("gaps", WS, U.owner.id);

const board = async (p) => {
  await p.goto(`${APP}/dashboard/analytics?range=7d`, { waitUntil: "networkidle" });
  await p.getByTestId("ai-story").waitFor({ timeout: 20000 });
};

// ── Steps ────────────────────────────────────────────────────────────────────

await step("story", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  await board(p);
  const headline = await p.getByTestId("ai-story-headline").innerText();
  if (!/Views are up/.test(headline)) fail(`headline: ${headline}`);
  const bullets = p.getByTestId("ai-story").locator("li");
  if ((await bullets.count()) !== 3) fail(`bullets: ${await bullets.count()}`);
  const first = await bullets.first().innerText();
  if (!/Launch notes/.test(first)) fail(`first bullet: ${first}`);
  if (/Member secret plan/.test(await p.locator('section[aria-labelledby="ah-ai"]').innerText())) fail("another person's doc on the card");
  // Refresh writes it again (a second ledger row), and the link opens the doc's Audience tab.
  const r1 = await api("GET", "/api/v1/me/analytics/ai/story?range=7d", T.owner);
  if (!r1.body.cached) fail("story wasn't kept for the day");
  await p.getByRole("button", { name: "Refresh the insights" }).click();
  await p.waitForTimeout(800);
  await p.getByTestId("ai-story").waitFor();
  await bullets.first().getByRole("link").click();
  await p.waitForURL(/\/dashboard\/analytics\/launch-notes\?tab=audience/, { timeout: 15000 });
});

await step("ask", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  await board(p);
  await p.getByTestId("ai-ask-input").fill("Which link did best this month?");
  await p.getByTestId("ai-ask-submit").click();
  const answer = p.getByTestId("ai-ask-answer");
  await answer.getByRole("link", { name: "Launch notes" }).waitFor({ timeout: 20000 });
  const text = await answer.innerText();
  if (/Let me check/.test(text)) fail("preamble not taken back");
  if (!/33 views|30 views|\d+ views/.test(text)) fail(`answer: ${text}`);
  await answer.getByRole("link", { name: "Launch notes" }).click();
  await p.waitForURL(/\/dashboard\/analytics\/launch-notes$/, { timeout: 15000 });
  // MCP: same answer through ask_analytics, with an absolute link.
  const tok = mcpToken(U.owner.email, true);
  const res = await mcp(tok, "ask_analytics", { question: "Which link did best this month?" });
  if (res.isError || !/http/.test(res.data?.links?.[0]?.url || "")) fail(`mcp ask: ${JSON.stringify(res).slice(0, 300)}`);
});

await step("gaps", async () => {
  // A member never sees it, not even through the API.
  const m = await api("GET", `/api/v1/me/analytics/ai/gaps?scope=${encodeURIComponent(`workspace:${WS}`)}`, T.member);
  if (m.status !== 403) fail(`member gaps → ${m.status}`);
  const st = await api("GET", "/api/v1/me/analytics/ai/status", T.member);
  if (st.body.gap_scopes.length) fail("member has gap scopes");
  {
    const { p } = await ctx(browser, { token: T.member });
    await board(p);
    if (await p.locator("#ah-gaps").count()) fail("member sees Write this next");
  }
  const { p } = await ctx(browser, { token: T.owner });
  await board(p);
  const card = p.getByTestId("ai-gap").first();
  await card.waitFor({ timeout: 20000 });
  const t = await card.innerText();
  if (!/Contractor onboarding/.test(t) || !/7×/.test(t)) fail(`gap card: ${t}`);
  await card.getByRole("button", { name: /Outline/ }).click();
  await card.getByText("Laptop and accounts").waitFor();
  await card.getByTestId("ai-gap-create").click();
  await p.waitForURL(/\?edit=1/, { timeout: 20000 });
  const slug = new URL(p.url()).pathname.slice(1);
  const doc = ok(await api("GET", `/api/v1/documents/${slug}`, T.owner), "created page");
  if (doc.workspace_id !== WS && doc.workspace?.id !== WS) fail(`page not in the workspace: ${JSON.stringify(doc).slice(0, 200)}`);
  if (!/## Laptop and accounts/.test(doc.content || "") || !/Questions people asked/.test(doc.content || "")) fail("outline missing");
});

await step("search-log", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/search?q=${encodeURIComponent("quarterly zebra plan")}&scope=${WS}`, { waitUntil: "networkidle" });
  await p.waitForTimeout(1500);
  const r = seed("searches", WS, "quarterly zebra plan");
  if (r.n !== 1) fail(`logged rows: ${JSON.stringify(r)}`);
  if (r.fields.some((f) => /user|ip|email/.test(f))) fail(`row keeps the person: ${r.fields}`);
});

await step("shots", async () => {
  for (const theme of ["light", "dark"]) {
    for (const [width, height] of [[1440, 1100], [820, 1180], [390, 900]]) {
      const { p, c } = await ctx(browser, { token: T.owner, theme, width, height, mobile: width < 500 });
      await board(p);
      await p.getByTestId("ai-gap").first().waitFor({ timeout: 20000 });
      await p.getByTestId("ai-ask-input").fill("Which link did best this month?");
      await p.getByTestId("ai-ask-submit").click();
      await p.getByTestId("ai-ask-answer").getByRole("link", { name: "Launch notes" }).waitFor({ timeout: 20000 });
      await p.locator("#ah-ai").scrollIntoViewIfNeeded();
      await snap(p, `home-${theme}-${width}`);
      const box = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (box > 1) fail(`horizontal scroll at ${width}: ${box}px`);
      await c?.close?.();
    }
  }
});

await browser.close();
fs.writeFileSync(path.join(OUT, `${BROWSER}-results.json`), JSON.stringify(results, null, 1));
console.log(`\nResults (${BROWSER}):`);
for (const [n, r] of results) console.log(`  ${r === "ok" ? "✓" : "✗"} ${n}: ${r}`);
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
