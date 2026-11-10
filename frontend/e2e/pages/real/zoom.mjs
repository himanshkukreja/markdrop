/**
 * Zoom on the REAL stack (up.sh with PB_FAKE_ZOOM=1 PB_FAKE_MEETINGS_AI=1: the API talks to the fake Zoom in
 * api_run.py — backend/tests/_zoom_fake.py — nothing leaves the machine):
 *
 *   connect   Workspace settings › Integrations › Zoom: Wes (admin) sees the setup steps (scopes, the endpoint URL),
 *             pastes the app's credentials, picks the open Sales team → Connected + "Sales is an open team"
 *             → Make it private → the warning goes
 *   badcreds  a wrong Client Secret: the card says Zoom refused them, nothing is saved
 *   live      Zoom's signed webhook for a recording hosted by Ada (Sales) → the meeting is in Latest from Zoom;
 *             Ben (Sales) lists it, Vic (not in Sales) doesn't
 *   importer  Ada (Sales lead) → Import past meetings → Last 90 days: Ben's and Ada's recordings (never Vic's),
 *             the one without a transcript can't be picked → Import → "2 imported"
 *   phone     the card and the importer fit a phone (no sideways scroll)
 *
 *   PB_FAKE_ZOOM=1 PB_FAKE_MEETINGS_AI=1 PB_STACK_ID=68 PB_WORK=… zsh up.sh start
 *   PB_STACK_ID=68 PB_WORK=… BROWSER=chromium [ONLY=connect,live] node zoom.mjs
 */
import { APP, api, ctx, fail, launch, reseed, seedNow, shot, stepper } from "./lib.mjs";

const browser = await launch();
const { step, results } = stepper(browser);
const S = process.env.NO_RESEED ? seedNow() : reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const U = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.id]));
const WS = S.ws;
const ok = (r, what) => { if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const TAB = `${APP}/settings/workspaces/${WS}?tab=integrations`;
const CREDS = { account: "acct-ZOOM1", client: "zoom-client-1", secret: "zoom-client-secret-1", token: "zoom-secret-token-1" };

ok(await api("POST", "/__sandbox/zoom/reset"), "reset the fake Zoom");

async function salesTeam() {
  const all = ok(await api("GET", `/api/v1/workspaces/${WS}/teams/browse`, T.admin), "teams").teams || [];
  const found = all.find((t) => t.name === "Sales");
  if (found) return found.id;
  return ok(await api("POST", `/api/v1/workspaces/${WS}/teams`, T.admin, { name: "Sales", visibility: "open",
    lead_ids: [U.owner], member_ids: [U.owner, U.member] }), "create Sales").id;
}
const SALES = await salesTeam();

async function ensureConnected() {
  const st = ok(await api("GET", `/api/v1/zoom/status?workspace_id=${WS}`, T.admin), "status");
  if (st.connected && st.team?.id === SALES) return;
  ok(await api("PUT", "/api/v1/zoom/connection", T.admin, { workspace_id: WS, account_id: CREDS.account, client_id: CREDS.client,
    client_secret: CREDS.secret, secret_token: CREDS.token, team_id: SALES }), "connect");
}

async function noOverflow(p, what) {
  const o = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (o > 1) fail(`${what}: the page scrolls sideways by ${o}px`);
}

await step("connect", async () => {
  ok(await api("DELETE", `/api/v1/zoom/connection?workspace_id=${WS}`, T.admin), "start disconnected");
  ok(await api("PATCH", `/api/v1/workspaces/${WS}/teams/${SALES}`, T.admin, { visibility: "open" }), "Sales open");
  const { p } = await ctx(browser, { token: T.admin });
  await p.goto(TAB);
  const card = p.getByTestId("zoom-card");
  await card.waitFor({ timeout: 30000 });
  const setup = card.getByTestId("zoom-setup");
  await setup.waitFor();
  const url = await setup.getByTestId("zoom-webhook-url").textContent();
  if (!url?.endsWith(`/api/v1/zoom/webhook/${WS}`)) fail(`webhook url: ${url}`);
  const scopes = await setup.getByTestId("zoom-scopes").textContent();
  for (const s of ["user:read:list_users:admin", "cloud_recording:read:list_user_recordings:admin",
    "cloud_recording:read:list_recording_files:admin", "meeting:read:list_past_participants:admin"]) {
    if (!scopes?.includes(s)) fail(`scope missing from the steps: ${s}`);
  }
  await setup.scrollIntoViewIfNeeded();
  await shot(p, "zoom-setup");
  await p.getByTestId("zoom-account-id").fill(CREDS.account);
  await p.getByTestId("zoom-client-id").fill(CREDS.client);
  await p.getByTestId("zoom-client-secret").fill(CREDS.secret);
  await p.getByTestId("zoom-secret-token").fill(CREDS.token);
  await p.getByTestId("zoom-team-new").selectOption(SALES);
  await p.getByTestId("zoom-save").click();
  await card.getByTestId("zoom-connected").waitFor({ timeout: 20000 });
  const warn = card.getByTestId("zoom-open-team");
  await warn.waitFor();
  await shot(p, "zoom-connected-open-team");
  await card.getByTestId("zoom-make-private").click();
  await warn.waitFor({ state: "detached", timeout: 15000 });
  const team = await card.getByTestId("zoom-team").textContent();
  if (!/Sales/.test(team || "")) fail(`team: ${team}`);
  const st = ok(await api("GET", `/api/v1/zoom/status?workspace_id=${WS}`, T.admin), "status");
  if (st.team?.visibility !== "private") fail(`visibility: ${st.team?.visibility}`);
  if (JSON.stringify(st).includes(CREDS.secret) || JSON.stringify(st).includes(CREDS.token)) fail("a secret came back");
  await shot(p, "zoom-connected");
});

await step("badcreds", async () => {
  await ensureConnected();
  const { p } = await ctx(browser, { token: T.admin });
  await p.goto(TAB);
  const card = p.getByTestId("zoom-card");
  await card.getByTestId("zoom-edit").click();
  await p.getByTestId("zoom-account-id").fill(CREDS.account);
  await p.getByTestId("zoom-client-id").fill(CREDS.client);
  await p.getByTestId("zoom-client-secret").fill("not-the-secret");
  await p.getByTestId("zoom-save").click();
  const err = await p.getByTestId("zoom-error").textContent({ timeout: 15000 });
  if (!/didn't accept/.test(err || "")) fail(`error: ${err}`);
  const st = ok(await api("GET", `/api/v1/zoom/status?workspace_id=${WS}`, T.admin), "status");
  if (!st.connected || st.connection.broken) fail(`a refused save changed the connection: ${JSON.stringify(st.connection)}`);
});

await step("live", async () => {
  await ensureConnected();
  const r = ok(await api("POST", "/__sandbox/zoom/event", null, { workspace_id: WS, uuid: "z-live" }), "webhook");
  if (r.status !== 200) fail(`webhook status ${r.status}`);
  const { p } = await ctx(browser, { token: T.admin });
  await p.goto(TAB);
  const recent = p.getByTestId("zoom-recent");
  await recent.getByText("Acme renewal call").waitFor({ timeout: 30000 });
  await recent.getByText("Imported").first().waitFor();
  await shot(p, "zoom-latest");
  const listed = async (who) => ok(await api("GET", `/api/v1/meetings?workspace=${WS}`, T[who]), `meetings ${who}`)
    .meetings.some((m) => m.title === "Acme renewal call");
  if (!(await listed("member"))) fail("Ben (Sales) doesn't see the Zoom meeting");
  if (!(await listed("admin"))) fail("Wes (admin) doesn't see the Zoom meeting");
  if (await listed("reader")) fail("Vic (not in Sales) sees the Zoom meeting");
});

await step("importer", async () => {
  await ensureConnected();
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(TAB);
  await p.getByTestId("zoom-import-open").click();
  const dlg = p.getByTestId("zoom-importer");
  await dlg.waitFor();
  await p.getByRole("radio", { name: "Last 90 days" }).click();
  await dlg.getByText("Initech pricing review").waitFor({ timeout: 20000 });
  const rows = dlg.getByTestId("zoom-row");
  const texts = await rows.allTextContents();
  if (texts.some((t) => t.includes("Vic's private sync"))) fail("Vic's meeting is listed");
  for (const want of ["Globex discovery", "Initech pricing review", "Umbrella intro (no transcript)"]) {
    if (!texts.some((t) => t.includes(want))) fail(`missing row ${want}: ${texts.join(" | ")}`);
  }
  const quiet = rows.filter({ hasText: "Umbrella intro" });
  if (!(await quiet.getByRole("checkbox").isDisabled())) fail("a meeting without a transcript can be picked");
  await shot(p, "zoom-importer");
  await p.getByTestId("zoom-import-go").click();
  const res = await p.getByTestId("zoom-import-result").textContent({ timeout: 60000 });
  if (!/2 imported/.test(res || "")) fail(`result: ${res}`);
  await shot(p, "zoom-imported");
  const ms = ok(await api("GET", `/api/v1/meetings?workspace=${WS}`, T.member), "meetings").meetings;
  if (!ms.some((m) => m.title === "Globex discovery")) fail("Globex discovery isn't a meeting");
});

await step("phone", async () => {
  await ensureConnected();
  const { p } = await ctx(browser, { token: T.admin, width: 390, height: 844, mobile: true });
  await p.goto(TAB);
  await p.getByTestId("zoom-card").waitFor({ timeout: 30000 });
  await p.getByTestId("zoom-card").scrollIntoViewIfNeeded();
  await noOverflow(p, "integrations tab");
  await shot(p, "zoom-phone");
  await p.getByTestId("zoom-import-open").click();
  await p.getByTestId("zoom-importer").waitFor();
  await noOverflow(p, "importer");
  await shot(p, "zoom-phone-importer");
});

await browser.close();
console.log("\n" + results.map(([n, r, ms]) => `${r === "ok" ? "✓" : "✗"} ${n.padEnd(12)} ${r} (${(ms / 1000).toFixed(1)} s)`).join("\n"));
if (results.some(([, r]) => r !== "ok")) process.exit(1);
