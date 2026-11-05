/**
 * Markdrop for Slack's settings on the REAL stack (up.sh with PB_FAKE_SLACK=1: the API talks to the fake
 * Slack in api_run.py; the browser's trips to slack.fake are intercepted here and sent back to the
 * callback page, as Slack would):
 *
 *   connect    Workspace settings › Integrations › Add to Slack (the owner) → back connected, the
 *              installer linked; pick the meetings channel (saved), a Slack Connect channel is marked
 *   member     a member sees the card read-only (no Add / Disconnect, the channel picker locked) and
 *              links their own Slack account (Sign in with Slack) → their DM switches; one turned off
 *   linkpage   /integrations/slack/link?team=… (the button /markdrop shows) → Continue with Slack → linked
 *   cancel     Slack says access_denied → "You cancelled in Slack", nothing connected
 *   disconnect Disconnect Slack… → confirm → Add to Slack again
 *   shots      light/dark × desktop/phone of the Integrations tab
 *
 *   PB_FAKE_SLACK=1 PB_STACK_ID=38 PB_WORK=… BROWSER=chromium|webkit [ONLY=connect,member] node slack.mjs
 *
 * Screenshots go to $SLACK_SHOTS (default <PB_WORK>/../shots).
 */
import fs from "node:fs";
import path from "node:path";
import { APP, BROWSER, WORK, log, fail, reseed, seedNow, api, launch, ctx, stepper } from "./lib.mjs";

const browser = await launch();
const { step, results } = stepper(browser);
const S = process.env.NO_RESEED ? seedNow() : reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const OUT = process.env.SLACK_SHOTS || path.resolve(WORK, "..", "shots");
fs.mkdirSync(OUT, { recursive: true });
const TAB = `${APP}/settings/workspaces/${WS}?tab=integrations`;
const ok = (r, what) => { if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const status = async (who) => ok(await api("GET", `/api/v1/slack/status?workspace_id=${WS}`, T[who]), "status");

/** Slack's pages: send the browser straight back to the callback with a code (or an error), like Slack does. */
async function fakeSlack(c, { deny = false } = {}) {
  let n = 0;
  await c.route(/^https:\/\/slack\.fake\//, (r) => {
    const u = new URL(r.request().url());
    const back = new URL(`${APP}/integrations/slack/callback`);
    back.searchParams.set("state", u.searchParams.get("state") || "");
    if (deny) back.searchParams.set("error", "access_denied");
    else back.searchParams.set("code", `code${++n}${Math.random().toString(36).slice(2, 6)}`);
    return BROWSER === "webkit"
      ? r.fulfill({ status: 200, contentType: "text/html", body: `<script>location.replace(${JSON.stringify(back.toString())})</script>` })
      : r.fulfill({ status: 302, headers: { location: back.toString() } });
  });
}

async function snap(p, name, full = false) {
  await p.waitForTimeout(500);
  const file = path.join(OUT, `${BROWSER}-slack-${name}.png`);
  await p.screenshot({ path: file, fullPage: full });
  log("shot", path.basename(file));
}

async function connect() {
  const { c, p } = await ctx(browser, { token: T.owner });
  await fakeSlack(c);
  await p.goto(TAB);
  const card = p.getByTestId("slack-card");
  await card.waitFor({ timeout: 30000 });
  await card.getByRole("button", { name: "Add to Slack" }).click();
  await p.waitForURL(/tab=integrations/, { timeout: 30000 });
  await card.getByText("Connected", { exact: true }).waitFor({ timeout: 20000 });
  await p.getByTestId("slack-team").getByText("Acme Slack").waitFor();
  return { c, p };
}

await step("connect", async () => {
  const { p } = await connect();
  const st = await status("owner");
  if (st.install?.team_name !== "Acme Slack") fail(`install: ${JSON.stringify(st.install)}`);
  if (!st.me.linked) fail("the installer isn't linked");
  // The channel picker: Slack's channels, a shared one marked.
  const sel = p.getByTestId("slack-channel");
  await p.waitForFunction(() => document.querySelectorAll('[data-testid="slack-channel"] option').length > 2, null, { timeout: 15000 });
  const labels = await sel.locator("option").allTextContents();
  if (!labels.includes("#meetings") || !labels.some((l) => l.includes("partners") && l.includes("shared with another organization"))) fail(`options: ${labels}`);
  await sel.selectOption("C2");
  await p.getByText("Meeting notes go to that channel now.").waitFor({ timeout: 10000 });
  const st2 = await status("owner");
  if (st2.install.meetings_channel?.name !== "meetings") fail(`channel: ${JSON.stringify(st2.install.meetings_channel)}`);
  await p.getByRole("switch", { name: "Post new meetings automatically" }).waitFor();
  await p.getByTestId("slack-me").getByRole("button", { name: "Unlink" }).waitFor();
});

await step("member", async () => {
  if (!(await status("owner")).install) await (await connect()).c.close();
  const { c, p } = await ctx(browser, { token: T.member });
  await fakeSlack(c);
  await p.goto(TAB);
  const card = p.getByTestId("slack-card");
  await card.waitFor({ timeout: 30000 });
  if (await card.getByRole("button", { name: /Add to Slack|Disconnect/ }).count()) fail("a member sees Add / Disconnect");
  if ((await p.getByTestId("slack-channel").getAttribute("aria-disabled")) !== "true") fail("the channel picker isn't locked");
  const me = p.getByTestId("slack-me");
  await me.getByRole("button", { name: "Link my Slack account" }).click();
  await p.waitForURL(/slack=linked/, { timeout: 30000 });
  await me.getByText("Direct messages from Markdrop").waitFor({ timeout: 20000 });
  const sw = p.getByRole("switch", { name: "Mentions" });
  if (!(await sw.isChecked())) fail("Mentions starts off");
  await sw.click();
  await p.waitForFunction(() => {
    const el = [...document.querySelectorAll('[role="switch"]')].find((s) => s.getAttribute("aria-labelledby") === "slack-pref-mention-label");
    return el && !el.checked;
  }, null, { timeout: 10000 });
  const st = await status("member");
  if (!st.me.linked || st.me.prefs.mention !== false || st.me.prefs.shared !== true) fail(`me: ${JSON.stringify(st.me)}`);
  // The non-admin can't change the channel through the API either.
  const r = await api("PATCH", "/api/v1/slack/settings", T.member, { workspace_id: WS, meetings_channel_id: "C1" });
  if (r.status !== 403) fail(`member PATCH settings → ${r.status}`);
});

await step("linkpage", async () => {
  if (!(await status("owner")).install) await (await connect()).c.close();
  const team = (await status("owner")).install.team_id;
  const { c, p } = await ctx(browser, { token: T.stranger });
  await fakeSlack(c);
  await p.goto(`${APP}/integrations/slack/link?team=${team}`);
  await p.getByRole("heading", { name: "Link your Slack account" }).waitFor({ timeout: 30000 });
  await p.getByText("Acme Slack").first().waitFor();
  await p.getByRole("button", { name: "Continue with Slack" }).click();
  // Not a member of the workspace: no settings to go back to, just "linked".
  await p.getByRole("heading", { name: "Your Slack account is linked" }).waitFor({ timeout: 30000 });
  const info = ok(await api("GET", `/api/v1/slack/link/info?team_id=${team}`, T.stranger), "link info");
  if (!info.linked) fail("the stranger isn't linked");
});

await step("cancel", async () => {
  const { c, p } = await ctx(browser, { token: T.admin });
  await fakeSlack(c, { deny: true });
  const r = ok(await api("POST", "/api/v1/slack/install", T.admin, { workspace_id: WS }), "install url");
  await p.goto(r.url.replace(/^https:\/\/slack\.fake/, "https://slack.fake"));
  await p.getByText("You cancelled in Slack. Nothing changed.").waitFor({ timeout: 30000 });
  await p.getByRole("link", { name: "Back to settings" }).waitFor();
});

await step("disconnect", async () => {
  if (!(await status("owner")).install) await (await connect()).c.close();
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(TAB);
  await p.getByRole("button", { name: "Disconnect Slack…" }).click();
  await p.getByRole("dialog").getByRole("button", { name: "Disconnect" }).click();
  await p.getByText("Slack is disconnected.").waitFor({ timeout: 15000 });
  await p.getByTestId("slack-card").getByRole("button", { name: "Add to Slack" }).waitFor();
  const st = await status("owner");
  if (st.install !== null || st.me.linked) fail(`after disconnect: ${JSON.stringify(st)}`);
});

await step("shots", async () => {
  if (!(await status("owner")).install) {
    const { p, c } = await connect();
    await p.getByTestId("slack-channel").selectOption("C2").catch(() => {});
    await c.close();
  }
  for (const theme of ["light", "dark"]) {
    for (const [w, h, tag] of [[1440, 900, "desktop"], [390, 844, "phone"]]) {
      const { p } = await ctx(browser, { token: T.owner, theme, width: w, height: h });
      await p.goto(TAB);
      await p.getByTestId("slack-me").waitFor({ timeout: 30000 });
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) fail(`${tag} ${theme}: the page scrolls sideways by ${overflow}px`);
      await snap(p, `${theme}-${tag}`, true);
      await p.context().close();
    }
  }
});

console.log("\nRESULTS", BROWSER);
for (const [n, s, ms] of results) console.log(`  ${s === "ok" ? "✓" : "✗"} ${n} ${s === "ok" ? "" : s} (${(ms / 1000).toFixed(1)} s)`);
await browser.close();
process.exit(results.some(([, s]) => s !== "ok") ? 1 : 0);
