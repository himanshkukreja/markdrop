/**
 * Markdrop for Slack's settings on the REAL stack (up.sh with PB_FAKE_SLACK=1: the API talks to the fake
 * Slack in api_run.py; the browser's trips to slack.fake are intercepted here and sent back to the
 * callback page, as Slack would):
 *
 *   connect    Workspace settings › Integrations › Add to Slack (the owner) → back connected, the
 *              installer linked; pick the meetings channel (saved), a Slack Connect channel is marked
 *   member     a member sees the card read-only (no Add / Disconnect, the channel picker locked) and
 *              links their own Slack account (Sign in with Slack) → still "Slack notifications: Off"
 *   optin      Settings › Account › Slack notifications: off by default; Ben turns it on → found by his
 *              email (Found, as "Ben in Slack"), per-kind switches; Wes isn't in Slack → Not found + the
 *              link fallback; a stranger (no workspace with Slack) never sees the card
 *   bell       Vic's bell (a mention, no push on this server): "Get these in Slack" → Turn on; Not now
 *              hides it for good on the device
 *   linkpage   /integrations/slack/link?team=… (the button /markdrop shows) → Continue with Slack → linked
 *   cancel     Slack says access_denied → "You cancelled in Slack", nothing connected
 *   actionitems a meeting with action items for Ben (a member) and Zara (not in Markdrop): after the
 *              minute, Ben's message has Open the notes and Done, Zara's only her items; the admin's
 *              switch and preview on the Integrations tab; Ben's own switch in Settings › Account
 *   disconnect Disconnect Slack… → confirm → Add to Slack again
 *   shots      light/dark × desktop/phone of the Integrations tab, and of the Slack notifications card
 *
 *   PB_FAKE_SLACK=1 PB_STACK_ID=38 PB_WORK=… BROWSER=chromium|webkit [ONLY=connect,member] node slack.mjs
 *
 * Without PB_FAKE_SLACK (the API started with no MARKDROP_SLACK_* keys, as production is until the owner
 * creates the Slack app) only `unset` runs: the card says "Not set up yet" calmly (no Add to Slack, no
 * error), for the owner and a member, light/dark × desktop/phone, and the Slack routes answer 503.
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
// Slack's own page under Workspace settings › Integrations (the grid's Details).
const TAB = `${APP}/settings/workspaces/${WS}/integrations/slack`;
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
  await p.waitForURL(/\/integrations\/slack\?slack=connected/, { timeout: 30000 });
  await card.locator(".md-badge", { hasText: "Connected" }).waitFor({ timeout: 20000 });
  await p.getByTestId("slack-team").getByText("Acme Slack").waitFor();
  return { c, p };
}

const FAKE = !!process.env.PB_FAKE_SLACK;

if (!FAKE) await step("unset", async () => {
  const st = await status("owner");
  if (st.configured !== false || st.install !== null) fail(`status without Slack keys: ${JSON.stringify(st)}`);
  for (const [path, body] of [["/api/v1/slack/install", { workspace_id: WS }], ["/api/v1/slack/link/start", { workspace_id: WS }]]) {
    const r = await api("POST", path, T.owner, body);
    if (r.status !== 503) fail(`POST ${path} without Slack keys → ${r.status}`);
  }
  for (const [who, theme, w, h, tag] of [["owner", "light", 1440, 900, "desktop"], ["owner", "dark", 1440, 900, "desktop"],
    ["owner", "light", 390, 844, "phone"], ["owner", "dark", 390, 844, "phone"], ["member", "light", 1440, 900, "desktop"]]) {
    const { p } = await ctx(browser, { token: T[who], theme, width: w, height: h });
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(TAB);
    const card = p.getByTestId("slack-card");
    await card.waitFor({ timeout: 30000 });
    await card.locator(".md-badge", { hasText: "Not set up yet" }).waitFor({ timeout: 15000 });
    await card.getByText("isn't switched on for this server yet").waitFor();
    if (await p.getByRole("button", { name: /Add to Slack|Disconnect|Link my Slack account/ }).count()) fail(`${who}: a Slack action shows while Slack isn't set up`);
    if (await p.getByText("Couldn't load Slack").count()) fail(`${who}: an error shows while Slack isn't set up`);
    if (await p.getByTestId("slack-me").count()) fail(`${who}: "Your Slack account" shows while Slack isn't set up`);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) fail(`${tag} ${theme}: the page scrolls sideways by ${overflow}px`);
    if (errors.length) fail(`page errors: ${errors.join(" | ").slice(0, 300)}`);
    if (who === "owner") await snap(p, `unset-${theme}-${tag}`, true);
    await p.context().close();
  }
});

if (FAKE) await step("connect", async () => {
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
  await p.getByRole("switch", { name: "Post new meetings automatically" }).waitFor({ state: "attached" });
  await p.getByTestId("slack-me").getByRole("button", { name: "Unlink" }).waitFor();
  // The fake install grants only some scopes: an admin is asked to update the app (one click).
  if (!st.install.can_find_by_email) {
    await p.getByTestId("slack-needs-update").waitFor({ timeout: 10000 });
    await p.getByRole("button", { name: "Update permissions" }).waitFor();
  }
  // Linked as the installer, but Slack notifications stay off until turned on.
  if (st.me.on !== false) fail(`the installer's Slack notifications are on by default: ${JSON.stringify(st.me)}`);
  await p.getByTestId("slack-me-notify").getByText("Off").waitFor();
});

if (FAKE) await step("member", async () => {
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
  await me.getByRole("button", { name: "Unlink" }).waitFor({ timeout: 20000 });
  // Linking doesn't turn Slack notifications on: the tab says Off and points at Settings › Account.
  await p.getByTestId("slack-me-notify").getByText("Off").waitFor();
  await p.getByTestId("slack-me-notify").getByRole("link", { name: /Turn on in Settings/ }).waitFor();
  if (await me.getByRole("switch").count()) fail("per-kind DM switches still show on the Integrations tab");
  const st = await status("member");
  if (!st.me.linked || st.me.on !== false) fail(`me: ${JSON.stringify(st.me)}`);
  // The non-admin can't change the channel through the API either.
  const r = await api("PATCH", "/api/v1/slack/settings", T.member, { workspace_id: WS, meetings_channel_id: "C1" });
  if (r.status !== 403) fail(`member PATCH settings → ${r.status}`);
});

const ACCOUNT = `${APP}/settings/account`;
const meOf = async (who) => ok(await api("GET", "/api/v1/slack/me", T[who]), "slack me");

if (FAKE) await step("optin", async () => {
  if (!(await status("owner")).install) await (await connect()).c.close();
  // Ben: off by default; turning it on finds him by his email (the fake Slack knows ben@acme.test).
  await api("PUT", "/api/v1/slack/me/notifications", T.member, { on: false });
  await api("DELETE", `/api/v1/slack/link?workspace_id=${WS}`, T.member);   // linked by `member` (Sign in with Slack)
  const { c, p } = await ctx(browser, { token: T.member });
  await fakeSlack(c);
  await p.goto(`${ACCOUNT}#slack`);
  const card = p.getByTestId("slack-notify-card");
  await card.waitFor({ timeout: 30000 });
  await card.getByText("ben@acme.test").waitFor();
  if (await card.getByRole("switch", { name: "Mentions" }).count()) fail("per-kind switches show while off");
  await card.getByRole("switch", { name: "Get notifications in Slack" }).dispatchEvent("click");
  const teams = p.getByTestId("slack-teams");
  await teams.getByText("Found").waitFor({ timeout: 15000 });
  await teams.getByText("Ben in Slack").waitFor();
  await teams.getByText("(by your email)").waitFor();
  await card.getByRole("switch", { name: "Mentions" }).waitFor({ state: "attached" });
  const me = await meOf("member");
  if (!me.on || me.teams[0]?.match !== "email" || !me.teams[0]?.linked) fail(`Ben after turning on: ${JSON.stringify(me)}`);
  // A kind off, saved.
  await card.getByRole("switch", { name: "Shared with you" }).dispatchEvent("click");
  await p.waitForFunction(() => {
    const el = [...document.querySelectorAll('[role="switch"]')].find((x) => x.getAttribute("aria-labelledby") === "slack-pref-shared-label");
    return el && !el.checked;
  }, null, { timeout: 10000 });
  if ((await meOf("member")).prefs.shared !== false) fail("Shared with you didn't save");
  await api("PATCH", "/api/v1/slack/me/prefs", T.member, { shared: true });
  // The Integrations tab now says On.
  await p.goto(TAB);
  await p.getByTestId("slack-me-notify").getByText("On", { exact: true }).waitFor({ timeout: 20000 });
  await c.close();

  // Wes isn't in Acme Slack under his email: Not found, the sentence, and Link my Slack account.
  await api("PUT", "/api/v1/slack/me/notifications", T.admin, { on: false });
  const w = await ctx(browser, { token: T.admin });
  await w.p.goto(ACCOUNT);
  const wcard = w.p.getByTestId("slack-notify-card");
  await wcard.waitFor({ timeout: 30000 });
  await wcard.getByRole("switch", { name: "Get notifications in Slack" }).dispatchEvent("click");
  await w.p.getByTestId("slack-team-note").getByText("No one in Acme Slack uses wes@acme.test. Link your Slack account instead.").waitFor({ timeout: 15000 });
  await w.p.getByTestId("slack-teams").getByText("Not found").waitFor();
  await w.p.getByTestId("slack-teams").getByRole("button", { name: "Link my Slack account" }).waitFor();
  await wcard.getByRole("button", { name: "Look again" }).waitFor();
  await w.c.close();

  // Someone in no workspace with Slack: no card, and turning it on through the API is refused.
  const s = await ctx(browser, { token: T.stranger });
  await s.p.goto(ACCOUNT);
  await s.p.getByRole("heading", { name: "Profile" }).waitFor({ timeout: 30000 });
  await s.p.waitForLoadState("networkidle");
  if (await s.p.getByTestId("slack-notify-card").count()) fail("the stranger sees the Slack notifications card");
  const r = await api("PUT", "/api/v1/slack/me/notifications", T.stranger, { on: true });
  if (r.status !== 409) fail(`stranger turn on → ${r.status}`);
  await s.c.close();
});

if (FAKE) await step("bell", async () => {
  if (!(await status("owner")).install) await (await connect()).c.close();
  await api("PUT", "/api/v1/slack/me/notifications", T.reader, { on: false });
  // A mention for Vic, so the bell offers notifications (no push keys on this server: Slack's turn).
  const title = `Slack nudge ${Date.now()}`;
  const made = ok(await api("POST", "/api/v1/pages", T.owner, { title, workspace: WS, folder: S.folder, content: "# Plan\n" }), "page");
  ok(await api("PUT", `/api/v1/documents/${made.document.slug}`, T.owner, {
    title, content: `# Plan\n\nPing :person[${S.users.reader.name}]{id="${S.users.reader.id}"} about it.\n`,
  }), "save");
  const NUDGE = '[data-testid="slack-prompt-bell"]';
  const open = async (p) => {
    await p.locator('header button[aria-label^="Notifications"]').first().click();
    await p.locator('[aria-busy="true"][aria-label="Loading notifications"]').waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  };
  const { c, p } = await ctx(browser, { token: T.reader, width: 1280, height: 860 });
  await p.goto(`${APP}/dashboard`);
  await open(p);
  await p.locator(NUDGE).waitFor({ timeout: 15000 });
  if (await p.locator('[data-testid="push-prompt-bell"]').count()) fail("both nudges show");
  await snap(p, "bell-nudge");
  await p.locator(NUDGE).getByRole("button", { name: "Not now" }).click();
  if (await p.locator(NUDGE).count()) fail("Not now didn't hide it");
  await p.reload();
  await open(p);
  await p.waitForTimeout(1500);
  if (await p.locator(NUDGE).count()) fail("Not now didn't stick on this device");
  await c.close();
  // Another device: Turn on. Vic isn't in Acme Slack under his email, so the toast says so (with Settings).
  const d = await ctx(browser, { token: T.reader, width: 1280, height: 860 });
  await d.p.goto(`${APP}/dashboard`);
  await open(d.p);
  await d.p.locator(NUDGE).getByRole("button", { name: "Turn on" }).click();
  await d.p.getByText("No one in Acme Slack uses vic@acme.test").waitFor({ timeout: 15000 });
  if (!(await meOf("reader")).on) fail("the bell's Turn on didn't turn it on");
  await d.p.waitForTimeout(500);
  if (await d.p.locator(NUDGE).count()) fail("the nudge stays after turning on");
  await d.c.close();
  await api("PUT", "/api/v1/slack/me/notifications", T.reader, { on: false });
});

if (FAKE) await step("linkpage", async () => {
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

if (FAKE) await step("cancel", async () => {
  const { c, p } = await ctx(browser, { token: T.admin });
  await fakeSlack(c, { deny: true });
  const r = ok(await api("POST", "/api/v1/slack/install", T.admin, { workspace_id: WS }), "install url");
  await p.goto(r.url.replace(/^https:\/\/slack\.fake/, "https://slack.fake"));
  await p.getByText("You cancelled in Slack. Nothing changed.").waitFor({ timeout: 30000 });
  await p.getByRole("link", { name: "Back to settings" }).waitFor();
});

if (FAKE) await step("disconnect", async () => {
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

if (FAKE) await step("actionitems", async () => {
  if (!(await status("owner")).install) await (await connect()).c.close();
  await api("PATCH", "/api/v1/slack/me/prefs", T.member, { action_items: true });
  const d = new Date();
  const mon = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const notes = `# Daily Syncup\n${mon} ${d.getUTCDate()}, ${d.getUTCFullYear()}\n`
    + "Invited Ada Owner <ada@acme.test>, Ben Member <ben@acme.test>, Zara Khan <zara@outside.test>\n\n"
    + "## Summary\nThe team went through the launch checklist. INTERNAL-ONLY-SUMMARY.\n\n"
    + "## Details\n- **Launch**: on track (00:00:20).\n\n"
    + "## Suggested next steps\n- [ ] Zara Khan will send the pricing sheet to finance by Friday.\n"
    + "- [ ] Ben Member will update the onboarding docs.\n- [ ] Zara Khan will book the demo room.\n";
  const imp = ok(await api("POST", "/api/v1/meetings/import", T.owner, {
    workspace: WS, wait: true, date: d.toISOString().slice(0, 10),
    sources: [{ name: "Daily Syncup - Notes by Gemini", text: notes }] }), "import");
  const callsFile = path.join(WORK, "stack", "slack-calls.jsonl");
  const before = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").split("\n").length : 0;
  const sent = ok(await api("POST", "/__sandbox/slack/flush", T.owner, {}), "flush");
  const calls = fs.readFileSync(callsFile, "utf8").split("\n").slice(before - 1).filter(Boolean).map((l) => JSON.parse(l));
  const dm = (id) => calls.find((x) => x.method === "chat.postMessage" && x.data.channel === id);
  const zara = dm("U-ZARA"), ben = dm("U-BEN-EMAIL");
  if (!zara || !ben) fail(`DMs: sent ${JSON.stringify(sent)}; ${calls.map((x) => `${x.method}:${x.data.channel || ""}`).join(", ")}`);
  const zt = JSON.stringify(zara.data);
  if (!zt.includes("Send the pricing sheet to finance by Friday.") || !zt.includes("Book the demo room.")) fail(`Zara's items: ${zt.slice(0, 400)}`);
  if (zt.includes("onboarding") || zt.includes("INTERNAL-ONLY-SUMMARY") || zt.includes("Open the notes") || zt.includes(imp.meetings[0].slug)) fail("Zara's message holds more than her items");
  if (!zt.includes("Notes are in Markdrop (ask Ada Owner for access)")) fail(`Zara's ask line: ${zt.slice(0, 400)}`);
  const bt = JSON.stringify(ben.data);
  if (!bt.includes("Update the onboarding docs.") || !bt.includes("Open the notes") || !bt.includes("md_ai_done") || bt.includes("pricing")) fail(`Ben's message: ${bt.slice(0, 400)}`);

  // The admin's switch, the last meeting's line and the preview.
  for (const theme of ["light", "dark"]) {
    for (const [w, h, tag] of [[1440, 900, "desktop"], [390, 844, "phone"]]) {
      const { p } = await ctx(browser, { token: T.owner, theme, width: w, height: h });
      await p.goto(TAB);
      const box = p.getByTestId("slack-action-items");
      await box.waitFor({ timeout: 30000 });
      await box.getByRole("switch", { name: "Send each person their action items after meetings" }).waitFor({ state: "attached" });
      await p.getByTestId("slack-ai-preview").getByText("Notes are in Markdrop (ask Ada Owner for access)").waitFor({ timeout: 15000 });
      await p.getByTestId("slack-ai-people").getByText("Zara Khan").waitFor();
      await p.getByTestId("slack-ai-last").getByText(/2 of 3 people messaged|2 of 2 people messaged/).waitFor();
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) fail(`action items ${tag} ${theme}: the page scrolls sideways by ${overflow}px`);
      await p.waitForTimeout(400);
      const file = path.join(OUT, `${BROWSER}-slack-action-items-${theme}-${tag}.png`);
      await box.screenshot({ path: file });
      log("shot", path.basename(file));
      if (theme === "light" && tag === "desktop") {
        await box.getByRole("switch", { name: "Send each person their action items after meetings" }).dispatchEvent("click");
        await p.getByText("Action items aren't sent to people now.").waitFor({ timeout: 10000 });
        if ((await status("owner")).install.action_item_dms !== false) fail("the switch didn't save");
        await box.getByRole("switch", { name: "Send each person their action items after meetings" }).dispatchEvent("click");
        await p.getByText("Each person gets their action items after meetings.").waitFor({ timeout: 10000 });
      }
      await p.context().close();
    }
  }
  // A member sees the switch locked, and no preview.
  {
    const { p } = await ctx(browser, { token: T.member });
    await p.goto(TAB);
    await p.getByTestId("slack-action-items").waitFor({ timeout: 30000 });
    if (await p.getByTestId("slack-ai-preview").count()) fail("a member sees the preview");
    const r = await api("GET", `/api/v1/slack/action-items/preview?workspace_id=${WS}`, T.member);
    if (r.status !== 403) fail(`member preview → ${r.status}`);
    await p.context().close();
  }
  // Ben's own switch: on by default (his Slack notifications may be off), saved when turned off.
  {
    const { p } = await ctx(browser, { token: T.member });
    await p.goto(`${ACCOUNT}#slack`);
    const sw = p.getByTestId("slack-action-items-pref").getByRole("switch", { name: "Action items after meetings" });
    await sw.waitFor({ state: "attached", timeout: 30000 });
    if (!(await sw.isChecked())) fail("Action items after meetings isn't on by default");
    await sw.dispatchEvent("click");
    await p.waitForFunction(() => {
      const el = [...document.querySelectorAll('[role="switch"]')].find((x) => x.getAttribute("aria-labelledby") === "slack-pref-action-items-label");
      return el && !el.checked;
    }, null, { timeout: 10000 });
    if ((await meOf("member")).action_items !== false) fail("Ben's switch didn't save");
    await p.waitForTimeout(300);
    await p.getByTestId("slack-action-items-pref").screenshot({ path: path.join(OUT, `${BROWSER}-slack-action-items-pref.png`) });
    await api("PATCH", "/api/v1/slack/me/prefs", T.member, { action_items: true });
    await p.context().close();
  }
});

if (FAKE) await step("shots", async () => {
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
  // The Slack notifications card, on (Ben, found by email), for the docs.
  await api("PUT", "/api/v1/slack/me/notifications", T.member, { on: true });
  for (const theme of ["light", "dark"]) {
    for (const [w, h, tag] of [[1440, 900, "desktop"], [390, 844, "phone"]]) {
      const { p } = await ctx(browser, { token: T.member, theme, width: w, height: h });
      await p.goto(`${ACCOUNT}#slack`);
      const card = p.getByTestId("slack-notify-card");
      await card.waitFor({ timeout: 30000 });
      await p.getByTestId("slack-teams").getByText("Found").waitFor({ timeout: 15000 });
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) fail(`account ${tag} ${theme}: the page scrolls sideways by ${overflow}px`);
      await p.waitForTimeout(500);
      const file = path.join(OUT, `${BROWSER}-slack-notify-${theme}-${tag}.png`);
      await p.locator("#slack").screenshot({ path: file });
      log("shot", path.basename(file));
      await p.context().close();
    }
  }
});

console.log("\nRESULTS", BROWSER);
for (const [n, s, ms] of results) console.log(`  ${s === "ok" ? "✓" : "✗"} ${n} ${s === "ok" ? "" : s} (${(ms / 1000).toFixed(1)} s)`);
await browser.close();
process.exit(results.some(([, s]) => s !== "ok") ? 1 : 0);
