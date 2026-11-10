/**
 * The Integrations grids and each integration's page, on the REAL stack (owner 2026-11-11: "every
 * integration as a card with basic info, keep a grid; clicking Details opens that integration's own page"):
 *
 *   workspace  Workspace settings › Integrations: the grid (Zoom, Google Meet, Slack, Jira, each with a status);
 *              Details → Slack's, Zoom's and Jira's pages (their settings card is there) → back to the grid
 *   account    Settings › Integrations: the grid; Claude's Details → its page (server URL, steps) → back
 *   keyboard   Tab reaches a card's Details; Enter opens the page; the back link works from the keyboard
 *   member     a member sees "Admin only" (or Not available) on workspace integrations and no Connect
 *   redirects  old URLs land on the new pages: ?tab=slack|jira|zoom, ?tab=integrations&slack=connected,
 *              ?tab=integrations&jira=pick, /settings/account#slack and #jira (with ?jira=connected)
 *   looks      light and dark, desktop and phone: no sideways scroll; brand marks load (white ones in dark)
 *
 *   PB_FAKE_SLACK=1 PB_FAKE_JIRA=1 PB_FAKE_ZOOM=1 PB_STACK_ID=72 PB_WORK=… zsh up.sh start
 *   PB_STACK_ID=72 PB_WORK=… BROWSER=chromium [ONLY=workspace,redirects] node integrations.mjs
 */
import { APP, ctx, fail, launch, reseed, seedNow, shot, stepper } from "./lib.mjs";

const browser = await launch();
const { step, results } = stepper(browser);
const S = process.env.NO_RESEED ? seedNow() : reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const GRID = `${APP}/settings/workspaces/${WS}?tab=integrations`;
const DETAIL = (id) => `${APP}/settings/workspaces/${WS}/integrations/${id}`;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function noOverflow(p, what) {
  const o = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (o > 1) fail(`${what}: the page scrolls sideways by ${o}px`);
}

async function statusOf(card) {
  const chip = card.locator("[data-status]").first();
  await chip.waitFor({ timeout: 30000 });
  return chip.getAttribute("data-status");
}

await step("workspace", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(GRID);
  const grid = p.getByTestId("integrations-grid");
  await grid.waitFor({ timeout: 30000 });
  for (const id of ["zoom", "google-meet", "slack", "jira"]) {
    const card = grid.getByTestId(`integration-card-${id}`);
    await card.waitFor();
    const s = await statusOf(card);
    if (!["connected", "off", "attention", "admin", "unavailable"].includes(s)) fail(`${id}: status ${s}`);
  }
  const groups = await grid.locator("h2").allTextContents();
  if (groups.join(",") !== "Meetings,Chat,Work tracking") fail(`groups: ${groups.join(",")}`);
  await shot(p, "integrations-ws-grid");

  for (const [id, settings] of [["slack", "slack-card"], ["zoom", "zoom-card"], ["jira", "jira-card"]]) {
    await p.getByTestId(`integration-details-${id}`).click();
    await p.waitForURL(new RegExp(`${esc(`/settings/workspaces/${WS}/integrations/${id}`)}$`), { timeout: 20000 });
    const page = p.getByTestId(`integration-detail-${id}`);
    await page.waitFor({ timeout: 20000 });
    for (const h of ["What it does", "Settings", "Set up", "Troubleshooting"]) {
      await page.getByRole("heading", { name: h, exact: true }).waitFor();
    }
    const steps = await page.getByTestId("integration-steps").locator("li").count();
    if (steps < 3) fail(`${id}: ${steps} setup steps`);
    await page.getByTestId(settings).first().waitFor({ timeout: 20000 });
    await page.getByTestId("integration-status").locator("[data-status]").waitFor({ timeout: 20000 });
    if (id === "zoom") await shot(p, "integrations-ws-zoom", { full: true });
    await p.getByTestId("integration-back").click();
    await p.waitForURL(/tab=integrations/, { timeout: 20000 });
    await grid.waitFor({ timeout: 20000 });
  }
});

await step("account", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/settings/integrations`);
  const grid = p.getByTestId("integrations-grid");
  await grid.waitFor({ timeout: 30000 });
  for (const id of ["claude", "chatgpt", "cursor", "ai-apps", "slack", "jira", "google-docs", "github", "vscode", "cli"]) {
    await statusOf(grid.getByTestId(`integration-card-${id}`));
  }
  if ((await p.locator("main h1").first().textContent())?.trim() !== "Integrations") fail("account grid h1");
  await shot(p, "integrations-account-grid");
  await grid.getByTestId("integration-details-claude").click();
  await p.waitForURL(/\/settings\/integrations\/claude$/, { timeout: 20000 });
  const page = p.getByTestId("integration-detail-claude");
  await page.waitFor({ timeout: 20000 });
  const url = await page.getByTestId("mcp-server-url").textContent();
  if (!url?.startsWith("https://") || !url.endsWith("/mcp")) fail(`server url: ${url}`);
  await shot(p, "integrations-account-claude", { full: true });
  await p.getByTestId("integration-back").click();
  await p.waitForURL(/\/settings\/integrations$/, { timeout: 20000 });
  await grid.waitFor();
  // Settings › Account points here now.
  await p.goto(`${APP}/settings/account`);
  await p.getByTestId("account-integrations-link").click();
  await p.waitForURL(/\/settings\/integrations$/, { timeout: 20000 });
});

await step("keyboard", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(GRID);
  const details = p.getByTestId("integration-details-zoom");
  await details.waitFor({ timeout: 30000 });
  // Walk the focus order from the card's action to its Details.
  await p.getByTestId("integration-card-zoom").locator("[data-status]").waitFor();
  await details.focus();
  await p.keyboard.press("Shift+Tab");
  await p.keyboard.press("Tab");
  const focused = await p.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  if (focused !== "integration-details-zoom") fail(`focus after Tab: ${focused}`);
  await p.keyboard.press("Enter");
  await p.waitForURL(/\/integrations\/zoom$/, { timeout: 20000 });
  const back = p.getByTestId("integration-back");
  await back.focus();
  await p.keyboard.press("Enter");
  await p.waitForURL(/tab=integrations/, { timeout: 20000 });
});

await step("member", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(GRID);
  const grid = p.getByTestId("integrations-grid");
  await grid.waitFor({ timeout: 30000 });
  for (const id of ["zoom", "slack", "jira"]) {
    const card = grid.getByTestId(`integration-card-${id}`);
    const s = await statusOf(card);
    if (s === "off") fail(`${id}: a member sees Not connected (wants Admin only)`);
    if (s === "admin" && (await card.getByTestId(`integration-action-${id}`).count())) fail(`${id}: a member gets a Connect button`);
  }
  await shot(p, "integrations-ws-grid-member");
});

await step("redirects", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  const cases = [
    [`${APP}/settings/workspaces/${WS}?tab=slack`, new RegExp(`${esc(`/settings/workspaces/${WS}/integrations/slack`)}$`)],
    [`${APP}/settings/workspaces/${WS}?tab=jira`, new RegExp(`${esc(`/settings/workspaces/${WS}/integrations/jira`)}$`)],
    [`${APP}/settings/workspaces/${WS}?tab=zoom`, new RegExp(`${esc(`/settings/workspaces/${WS}/integrations/zoom`)}$`)],
    [`${APP}/settings/workspaces/${WS}?tab=integrations&slack=connected`, new RegExp(`${esc(`/integrations/slack?slack=connected`)}$`)],
    [`${APP}/settings/workspaces/${WS}?tab=integrations&jira=pick`, new RegExp(`${esc(`/integrations/jira?jira=pick`)}$`)],
    [`${APP}/settings/account#slack`, /\/settings\/integrations\/slack$/],
    [`${APP}/settings/account#jira`, /\/settings\/integrations\/jira$/],
    [`${APP}/settings/account#jira?jira=connected`, /\/settings\/integrations\/jira\?jira=connected$/],
    [`${APP}/settings/integrations/nope`, /\/settings\/integrations$/],
    [`${APP}/settings/workspaces/${WS}/integrations/nope`, /tab=integrations$/],
  ];
  for (const [from, to] of cases) {
    await p.goto(from);
    await p.waitForURL(to, { timeout: 20000 }).catch(() => fail(`${from} → ${p.url()} (wanted ${to})`));
  }
  // Untouched: other account anchors stay on the account page.
  await p.goto(`${APP}/settings/account#email`);
  await p.locator("#email").waitFor({ timeout: 20000 });
  if (!p.url().includes("/settings/account")) fail(`#email moved to ${p.url()}`);
});

await step("looks", async () => {
  for (const theme of ["light", "dark"]) {
    for (const [w, h, mobile] of [[1440, 900, false], [768, 1024, true], [390, 844, true]]) {
      const { c, p } = await ctx(browser, { token: T.owner, theme, width: w, height: h, mobile });
      for (const [name, url] of [["ws-grid", GRID], ["ws-slack", DETAIL("slack")], ["account-grid", `${APP}/settings/integrations`],
        ["account-chatgpt", `${APP}/settings/integrations/chatgpt`]]) {
        await p.goto(url);
        await p.locator("[data-testid=integrations-grid], [data-testid^=integration-detail-]").first().waitFor({ timeout: 30000 });
        await p.locator("[data-status]").first().waitFor({ timeout: 30000 });
        await noOverflow(p, `${name} ${theme} ${w}`);
        // Every visible brand mark loaded (a broken image has naturalWidth 0).
        const broken = await p.evaluate(() => [...document.querySelectorAll("[data-brand] img")]
          .filter((i) => i.getBoundingClientRect().width > 0 && !(i.complete && i.naturalWidth > 0)).map((i) => i.getAttribute("src")));
        if (broken.length) fail(`${name} ${theme} ${w}: marks didn't load: ${broken.join(", ")}`);
        // In dark, the dark-only (white) marks show and the colour ones they replace don't.
        if (theme === "dark") {
          const wrong = await p.evaluate(() => [...document.querySelectorAll("[data-brand] img")]
            .filter((i) => i.getBoundingClientRect().width > 0 && /\/(jira|zoom|github|chatgpt|cursor)\.svg$/.test(i.getAttribute("src") || ""))
            .map((i) => i.getAttribute("src")));
          if (wrong.length) fail(`${name} dark: colour marks shown instead of white: ${wrong.join(", ")}`);
        }
        if (w !== 768) await shot(p, `integrations-${name}-${w}-${theme}`);
      }
      await c.close();
    }
  }
});

await browser.close();
console.log("\n" + results.map(([n, r, ms]) => `${r === "ok" ? "✓" : "✗"} ${n.padEnd(12)} ${r} (${(ms / 1000).toFixed(1)} s)`).join("\n"));
if (results.some(([, r]) => r !== "ok")) process.exit(1);
