/**
 * Global search on the REAL stack (up.sh, with PB_FAKE_SEARCH_AI=1 so AI search runs against the
 * fake model in api_run.py): a typo finds the right document, a private document is found by its
 * owner and never by a member (not even in the API responses), the workspace chip and the results
 * page's filters narrow the scope, Ask AI streams an answer with sources, the keyboard drives the
 * palette, and Trash hits restore.
 *
 *   PB_FAKE_SEARCH_AI=1 PB_STACK_ID=18 PB_WORK=… BROWSER=chromium|webkit [ONLY=typo,private] node search.mjs
 *
 * Screenshots (palette, results page, AI answer; light and dark at 1440 and 390) go to
 * $SEARCH_SHOTS (default <PB_WORK>/../shots).
 */
import fs from "node:fs";
import path from "node:path";
import { APP, BROWSER, WORK, log, fail, reseed, seedNow, api, launch, ctx, captureApi, stepper } from "./lib.mjs";

const browser = await launch();
const { step, results } = stepper(browser);
const S = process.env.NO_RESEED ? seedNow() : reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const OUT = process.env.SEARCH_SHOTS || path.resolve(WORK, "..", "shots");
fs.mkdirSync(OUT, { recursive: true });
const ok = (r, what) => { if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };

async function snap(p, name) {
  await p.waitForTimeout(450);
  const file = path.join(OUT, `${BROWSER}-${name}.png`);
  await p.screenshot({ path: file });
  log("shot", path.basename(file));
}

// ── The world ────────────────────────────────────────────────────────────────
const filing = { workspace: WS, access_level: "workspace", expires_in: "never" };
ok(await api("POST", "/api/v1/documents", T.owner, {
  ...filing, title: "Onboarding Playbook", custom_slug: "onboarding-playbook",
  content: "# Onboarding Playbook\n\nHow we welcome **contractors** and new hires in their first week.\n\n## Laptop and accounts\n\nEvery contractor gets a laptop on day one and an account the same morning.\n\n## Expense policy\n\nSubmit receipts within 30 days.\n",
}), "onboarding doc");
ok(await api("POST", "/api/v1/documents", T.owner, {
  ...filing, access_level: "private", title: "Salary bands zebra", custom_slug: "salary-bands",
  content: "# Salary bands zebra\n\nConfidential compensation ranges.\n",
}), "private doc");
for (let i = 1; i <= 3; i++) {
  ok(await api("POST", "/api/v1/documents", T.owner, { ...filing, title: `Launch checklist ${i}`, custom_slug: `launch-check-${i}`, content: `# Launch checklist ${i}\n\nSteps for wave ${i}.\n` }), "launch doc");
}
const globex = ok(await api("POST", "/api/v1/workspaces", T.owner, { name: "Globex" }), "second workspace");
ok(await api("POST", "/api/v1/documents", T.owner, {
  workspace: globex.id, access_level: "workspace", expires_in: "never", title: "Onboarding at Globex", custom_slug: "globex-onboarding",
  content: "# Onboarding at Globex\n\nA different team's onboarding notes.\n",
}), "globex doc");
await new Promise((r) => setTimeout(r, 1500)); // the content index follows each save off the request

const options = (p) => p.locator('[role="dialog"] [role="option"]');
async function palette(p, q) {
  await p.keyboard.press("Control+k");
  const input = p.getByTestId("search-input");
  await input.waitFor({ timeout: 10000 });
  if (q !== undefined) await input.fill(q);
  return input;
}
/** Runs `action` and returns the URL it opened: this tab, or a new one (a workspace domain opens in a
 *  new tab, as a row click does). The workspace's domain answers locally. */
async function opened(p, action) {
  await p.context().route(/^https:\/\/docs\.acme\.com\//, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<p>domain</p>" }));
  const before = p.url();
  const popup = p.context().waitForEvent("page", { timeout: 15000 }).then(async (pg) => { await pg.waitForLoadState().catch(() => {}); return pg.url(); }).catch(() => null);
  await action();
  const nav = p.waitForURL((u) => u.toString() !== before, { timeout: 15000 }).then(() => p.url()).catch(() => null);
  const url = await Promise.race([popup, nav]);
  return url || (await popup) || (await nav) || "";
}
async function firstTitle(p) {
  await options(p).first().waitFor({ timeout: 10000 });
  return (await options(p).first().innerText()).split("\n")[0];
}

// ── Steps ────────────────────────────────────────────────────────────────────

await step("typo", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
  await palette(p, "onbording plyabook");
  await p.waitForFunction(() => {
    const o = document.querySelector('[role="dialog"] [role="option"]');
    return o && /Onboarding Playbook/.test(o.textContent || "");
  }, null, { timeout: 10000 });
  const marks = await options(p).first().locator("mark").allInnerTexts();
  if (!marks.some((m) => /onboarding/i.test(m))) fail(`no highlight on the title: ${marks}`);
  await snap(p, "palette-light-1440");
  // A body word with a typo finds it too, with the matching snippet.
  await p.getByTestId("search-input").fill("contracters");
  await p.waitForFunction(() => /laptop|contractor/i.test(document.querySelector('[role="dialog"] [role="option"]')?.textContent || ""), null, { timeout: 10000 });
  await p.getByTestId("search-input").fill("onbording plyabook");
  await p.waitForFunction(() => /Onboarding Playbook/.test(document.querySelector('[role="dialog"] [role="option"]')?.textContent || ""), null, { timeout: 10000 });
  const url = await opened(p, () => p.keyboard.press("Enter"));
  if (!/onboarding-playbook/.test(url)) fail(`Enter opened ${url}`);
});

await step("private", async () => {
  const own = await ctx(browser, { token: T.owner });
  await own.p.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
  await palette(own.p, "salary bands");
  if (!/Salary bands zebra/.test(await firstTitle(own.p))) fail("the owner doesn't find their private document");
  await own.c.close();
  const mem = await ctx(browser, { token: T.member });
  const bodies = captureApi(mem.p);
  await mem.p.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
  await palette(mem.p, "salary bands zebra");
  await mem.p.getByText(/Nothing matches/).waitFor({ timeout: 10000 });
  await mem.p.waitForTimeout(800);
  const leak = bodies.filter((b) => /\/search/.test(b.url) && /Salary bands zebra|Confidential compensation/.test(b.body));
  if (leak.length) fail(`a search response carried the private title: ${leak[0].url}`);
  if (!bodies.some((b) => /\/api\/v1\/search\?/.test(b.url))) fail("no search request was seen");
  await mem.c.close();
});

await step("scope", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/w/${WS}`, { waitUntil: "networkidle" });
  await palette(p, "onboarding");
  await p.waitForFunction(() => {
    const t = [...document.querySelectorAll('[role="dialog"] [role="option"]')].map((o) => o.textContent || "").join("|");
    return /Onboarding Playbook/.test(t) && /Onboarding at Globex/.test(t);
  }, null, { timeout: 10000 });
  // The current workspace (Acme) ranks first.
  if (!/Onboarding Playbook/.test(await firstTitle(p))) fail("the current workspace's document isn't first");
  await p.getByRole("button", { name: /Only Acme/ }).click();
  await p.waitForFunction(() => {
    const t = [...document.querySelectorAll('[role="dialog"] [role="option"]')].map((o) => o.textContent || "").join("|");
    return /Onboarding Playbook/.test(t) && !/Onboarding at Globex/.test(t);
  }, null, { timeout: 10000 });
  // The results page: the workspace filter.
  await p.goto(`${APP}/search?q=onboarding&scope=${globex.id}`, { waitUntil: "networkidle" });
  const list = p.locator('ul[aria-label="Results"]');
  await list.getByText("Onboarding at Globex").first().waitFor({ timeout: 10000 });
  if (await list.getByText("Onboarding Playbook").count()) fail("the Globex filter showed an Acme document");
});

await step("ai", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
  await palette(p, "how do we onboard new contractors?");
  // A question runs AI on its own; the fake model cites the first candidates it was sent.
  const card = p.locator('[aria-label="AI answer"]');
  await card.waitFor({ timeout: 15000 });
  await card.getByText(/From your documents/).waitFor({ timeout: 20000 });
  await card.locator('ol[aria-label="Sources"] button').first().waitFor({ timeout: 10000 });
  const sources = await card.locator('ol[aria-label="Sources"]').innerText();
  if (!/Onboarding/.test(sources)) fail(`the sources don't name the onboarding document: ${sources}`);
  if (/Salary/.test(await card.innerText())) fail("the answer named a document outside the question");
  await snap(p, "ai-light-1440");
  // The Ask AI button for a plain query.
  await p.getByTestId("search-input").fill("launch checklist");
  await p.getByTestId("ask-ai").click();
  await card.getByText(/From your documents/).waitFor({ timeout: 20000 });
  // A citation chip opens its source.
  const url = await opened(p, () => card.locator("button").filter({ hasText: /^1$/ }).first().click());
  if (!/launch-check|onboarding/.test(url)) fail(`the citation opened ${url}`);
});

await step("keyboard", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
  const input = await palette(p, "launch checklist");
  await options(p).nth(2).waitFor({ timeout: 10000 });
  const selected = () => p.locator('[role="dialog"] [role="option"][aria-selected="true"]').innerText();
  const first = await selected();
  await p.keyboard.press("ArrowDown");
  const second = await selected();
  if (first === second) fail("ArrowDown didn't move the selection");
  await p.keyboard.press("ArrowUp");
  if ((await selected()) !== first) fail("ArrowUp didn't move back");
  const active = await input.getAttribute("aria-activedescendant");
  if (!active) fail("the combobox has no active descendant");
  // Tab reaches the filters; a chip narrows the results.
  await p.keyboard.press("Tab");
  await p.keyboard.press("Tab");
  await p.keyboard.press("Tab");
  const focused = await p.evaluate(() => document.activeElement?.textContent || "");
  if (!/All|Pages|Documents/.test(focused)) fail(`Tab didn't reach the filters (focus on “${focused}”)`);
  await p.getByRole("button", { name: "Files", exact: true }).click();
  await p.getByText(/Nothing matches/).waitFor({ timeout: 10000 });
  await p.getByRole("button", { name: "All", exact: true }).click();
  await options(p).first().waitFor({ timeout: 10000 });
  await input.focus();
  await p.keyboard.press("ArrowDown");
  const target = (await selected()).split("\n")[0];
  const url = await opened(p, () => p.keyboard.press("Enter"));
  if (!/launch-check-\d/.test(url) || !target.includes("Launch checklist")) fail(`Enter opened ${url} (${target})`);
  if (!p.url().startsWith(APP)) await p.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
  // Esc closes; ⌘K reopens with recent searches.
  await p.keyboard.press("Control+k");
  await p.locator('[role="dialog"] [role="group"][aria-label="Recent searches"]').waitFor({ timeout: 10000 });
  await p.keyboard.press("Escape");
  await p.getByTestId("search-input").waitFor({ state: "detached", timeout: 5000 });
});

await step("trash", async () => {
  ok(await api("POST", "/api/v1/documents", T.owner, { ...filing, title: "Retro notes penguin", custom_slug: "retro-penguin", content: "# Retro notes penguin\n" }), "doc");
  ok(await api("DELETE", "/api/v1/documents/retro-penguin", T.owner), "delete");
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
  await palette(p, "retro penguin");
  await p.getByText("In Trash").first().waitFor({ timeout: 10000 });
  await p.getByRole("button", { name: /Restore/ }).first().click();
  await p.waitForFunction(() => /Retro notes penguin/.test(document.querySelector('[role="dialog"] [role="option"]')?.textContent || "")
    && !/In Trash/.test(document.querySelector('[role="dialog"]')?.textContent || ""), null, { timeout: 15000 });
  const r = await api("GET", "/api/v1/documents/retro-penguin", T.owner);
  if (r.status !== 200) fail(`restore didn't bring it back (${r.status})`);
});

await step("shots", async () => {
  for (const theme of ["light", "dark"]) {
    for (const width of [1440, 390]) {
      const mobile = width < 500;
      const { c, p } = await ctx(browser, { token: T.owner, theme, width, height: mobile ? 844 : 900, mobile });
      await p.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
      if (mobile) {
        await p.evaluate(() => window.dispatchEvent(new CustomEvent("md:cmdk")));
        await p.getByTestId("search-input").waitFor({ timeout: 10000 });
        await p.getByTestId("search-input").fill("onbording");
      } else {
        await palette(p, "onbording");
      }
      await options(p).first().waitFor({ timeout: 10000 });
      if (!(theme === "light" && width === 1440)) await snap(p, `palette-${theme}-${width}`);
      await p.getByTestId("search-input").fill("how do we onboard new contractors?");
      await p.locator('[aria-label="AI answer"]').getByText(/From your documents/).waitFor({ timeout: 20000 });
      await p.waitForTimeout(600);
      if (!(theme === "light" && width === 1440)) await snap(p, `ai-${theme}-${width}`);
      await p.keyboard.press("Escape");
      await p.goto(`${APP}/search?q=onboarding`, { waitUntil: "networkidle" });
      await p.locator('ul[aria-label="Results"]').getByText("Onboarding Playbook").first().waitFor({ timeout: 10000 });
      await snap(p, `results-${theme}-${width}`);
      await p.goto(`${APP}/search?q=what%20is%20our%20expense%20policy%3F`, { waitUntil: "networkidle" });
      await p.locator('[aria-label="AI answer"]').getByText(/From your documents/).waitFor({ timeout: 20000 });
      await snap(p, `results-ai-${theme}-${width}`);
      await c.close();
    }
  }
});

await browser.close();
fs.writeFileSync(path.join(OUT, `${BROWSER}-results.json`), JSON.stringify(results, null, 1));
console.log(`\nResults (${BROWSER}):`);
for (const [n, r] of results) console.log(`  ${r === "ok" ? "✓" : "✗"} ${n}: ${r}`);
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
