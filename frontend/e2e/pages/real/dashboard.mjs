/**
 * The customizable Home (/dashboard; brief .work/briefs/custom-dashboard.md) on the REAL stack (up.sh + seed.py):
 *
 *   default    Ada's Home is Default: Recent, Meetings, Workspaces beside Needs you and My to-dos (two columns)
 *   customize  Customize → + Add widget (side) → Quick actions lands on top of the side column; ↓ moves it down,
 *              "Move to main" moves it across; it survives a reload (saved, source "mine")
 *   settings   adding Team backlog asks for a team first; picking Sales shows "Sales backlog"
 *   template   Templates → Manager replaces the layout (Team brief first); Undo brings the last one back;
 *              Reset to default goes back to Default
 *   unavailable Ben's Team brief for Sales after he leaves Sales: "not available", no team name, Remove removes it
 *   wsdefault  Wes (admin) sets the workspace default; Vic (never customized) gets it; a member can't set it
 *   phone      390 px: one column (main, then side), no sideways scroll, Customize still works
 *   mcp        get_dashboard / set_dashboard over the hosted MCP endpoint
 *
 *   PB_STACK_ID=… PB_WORK=… BROWSER=chromium|webkit [ONLY=default,customize] [THEME=dark] node dashboard.mjs
 */
import { APP, log, fail, reseed, api, launch, ctx, stepper, mcp, mcpToken } from "./lib.mjs";

const S = reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const theme = process.env.THEME === "dark" ? "dark" : "light";
const ok = (r, what) => { if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };

const sales = ok(await api("POST", `/api/v1/workspaces/${WS}/teams`, T.admin, {
  name: "Sales", visibility: "private", lead_ids: [S.users.owner.id], member_ids: [S.users.owner.id, S.users.member.id],
}), "create Sales");
log("Sales", sales.id);

const browser = await launch();
const { step, results } = stepper(browser);

const home = async (token, opts = {}) => {
  const { p } = await ctx(browser, { token, theme, ...opts });
  // Every run starts from what the server says (no copy from an earlier context on this device).
  await p.addInitScript((ws) => { try { localStorage.setItem("md_rail_ws", ws); } catch {} }, WS);
  await p.goto(`${APP}/dashboard`);
  await p.getByTestId("home-dashboard").waitFor({ timeout: 60000 });
  await p.waitForFunction(() => document.querySelector("[data-testid='home-dashboard']")?.getAttribute("data-source") !== "loading", null, { timeout: 30000 });
  return p;
};
const cols = (p) => p.evaluate(() => Object.fromEntries(["main", "side"].map((c) => [c,
  [...document.querySelectorAll(`[data-testid='home-col-${c}'] > [data-testid='home-widget']`)].map((e) => e.getAttribute("data-widget"))])));
const source = (p) => p.getByTestId("home-dashboard").getAttribute("data-source");
const same = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${what}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };
const saved = async (p) => { await p.waitForTimeout(900); await p.waitForLoadState("networkidle").catch(() => {}); };

await step("default", async () => {
  const p = await home(T.owner);
  if (await source(p) !== "default") fail(`source ${await source(p)}`);
  same(await cols(p), { main: ["recent", "meetings", "workspaces"], side: ["needs_you", "todos"] }, "Default");
  // Side by side at 1440.
  const [m, s] = await Promise.all(["main", "side"].map((c) => p.getByTestId(`home-col-${c}`).boundingBox()));
  if (!m || !s || s.x <= m.x + m.width - 1) fail(`columns not side by side: ${JSON.stringify([m, s])}`);
  await p.getByTestId("home-ask").waitFor();
});

await step("customize", async () => {
  const p = await home(T.owner);
  await p.getByTestId("home-customize").click();
  await p.getByTestId("home-add-side").click();
  await p.getByTestId("home-pick-quick").click();
  await p.getByTestId("home-w-quick").waitFor({ timeout: 20000 });
  same((await cols(p)).side, ["quick", "needs_you", "todos"], "added on top of the side");
  const quick = p.locator("[data-testid='home-widget'][data-widget='quick']");
  await quick.getByTestId("home-w-down").click();
  same((await cols(p)).side, ["needs_you", "quick", "todos"], "moved down");
  await quick.getByTestId("home-w-across").click();
  same(await cols(p), { main: ["recent", "quick", "meetings", "workspaces"], side: ["needs_you", "todos"] }, "moved to main");
  await p.getByTestId("home-customize-done").click();
  await saved(p);
  await p.reload();
  await p.getByTestId("home-w-quick").waitFor({ timeout: 30000 });
  if (await source(p) !== "mine") fail(`after reload: source ${await source(p)}`);
  same((await cols(p)).main, ["recent", "quick", "meetings", "workspaces"], "kept after reload");
  // Quick actions work (and nothing in Customize mode is clickable through).
  await p.getByTestId("home-quick-page").waitFor();
});

await step("settings", async () => {
  const p = await home(T.owner);
  await p.getByTestId("home-customize").click();
  await p.getByTestId("home-add-main").click();
  await p.getByTestId("home-pick-backlog").click();
  const dlg = p.getByTestId("home-settings");
  await dlg.waitFor({ timeout: 10000 });
  if (!(await p.getByTestId("home-settings-save").isDisabled())) fail("Save enabled with no team");
  await p.getByTestId("home-set-team").selectOption(sales.id);
  await p.getByTestId("home-settings-save").click();
  await p.getByTestId("home-customize-done").click();
  await p.getByTestId("home-w-backlog").getByText("Sales backlog").waitFor({ timeout: 20000 });
  await saved(p);
  const d = ok(await api("GET", `/api/v1/me/dashboard?workspace=${WS}`, T.owner), "GET");
  if (d.main[0].type !== "backlog" || d.main[0].settings.team !== sales.id) fail(`saved ${JSON.stringify(d.main[0])}`);
});

await step("template", async () => {
  const p = await home(T.owner);
  const before = await cols(p);
  await p.getByTestId("home-customize").click();
  await p.getByTestId("home-templates").click();
  await p.getByRole("menuitem", { name: /Manager/ }).click();
  await p.waitForFunction(() => document.querySelector("[data-testid='home-col-main'] > [data-widget]")?.getAttribute("data-widget") === "brief", null, { timeout: 20000 });
  same((await cols(p)).main, ["brief", "memory", "activity"], "Manager");
  await p.getByRole("button", { name: "Undo" }).click();
  await p.waitForFunction((want) => [...document.querySelectorAll("[data-testid='home-col-main'] > [data-widget]")].map((e) => e.getAttribute("data-widget")).join() === want,
    before.main.join(), { timeout: 20000 });
  await p.getByTestId("home-reset").click();
  await p.waitForFunction(() => document.querySelector("[data-testid='home-dashboard']")?.getAttribute("data-source") === "default", null, { timeout: 20000 });
  same(await cols(p), { main: ["recent", "meetings", "workspaces"], side: ["needs_you", "todos"] }, "reset");
});

await step("unavailable", async () => {
  ok(await api("PUT", "/api/v1/me/dashboard", T.member, { workspace: WS, main: [{ type: "brief", settings: { team: sales.id } }, { type: "recent" }], side: [] }), "Ben's layout");
  ok(await api("DELETE", `/api/v1/workspaces/${WS}/teams/${sales.id}/members/${S.users.member.id}`, T.admin), "Ben leaves Sales");
  const p = await home(T.member);
  const na = p.getByTestId("home-w-unavailable");
  await na.waitFor({ timeout: 20000 });
  const text = await na.innerText();
  if (/Sales/.test(text)) fail(`the team's name shows: ${text}`);
  if (!/can't open this team/.test(text)) fail(`note: ${text}`);
  // One column when the side is empty.
  if (await p.getByTestId("home-col-side").count()) fail("an empty side column is drawn");
  await na.getByTestId("home-w-na-remove").click();
  await na.waitFor({ state: "detached", timeout: 10000 });
  await saved(p);
  const d = ok(await api("GET", `/api/v1/me/dashboard?workspace=${WS}`, T.member), "GET");
  same(d.main.map((w) => w.type), ["recent"], "removed on the server");
});

await step("wsdefault", async () => {
  const r = await api("PUT", `/api/v1/workspaces/${WS}/dashboard-default`, T.member, { preset: "writer" });
  if (r.status !== 403) fail(`a member set the default: ${r.status}`);
  const p = await home(T.admin);
  await p.getByTestId("home-customize").click();
  await p.getByTestId("home-add-main").click();
  await p.getByTestId("home-pick-activity").click();
  await p.getByTestId("home-ws-default").click();
  await p.getByRole("menuitem", { name: /Set as workspace default/ }).click();
  await p.getByText("Members who haven't customized now see this Home").waitFor({ timeout: 20000 });
  const v = await home(T.reader);
  if (await source(v) !== "workspace") fail(`Vic sees ${await source(v)}`);
  if ((await cols(v)).main[0] !== "activity") fail(`Vic's main: ${(await cols(v)).main}`);
  ok(await api("DELETE", `/api/v1/workspaces/${WS}/dashboard-default`, T.admin), "clear");
});

await step("phone", async () => {
  const p = await home(T.owner, { width: 390, height: 844, mobile: true });
  const [m, s] = await Promise.all(["main", "side"].map((c) => p.getByTestId(`home-col-${c}`).boundingBox()));
  if (!m || !s || s.y < m.y + m.height - 1) fail(`not one column (main, then side): ${JSON.stringify([m, s])}`);
  const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (over > 1) fail(`sideways scroll ${over}px`);
  await p.getByTestId("home-customize").click();
  await p.getByTestId("home-add-main").waitFor();
  const over2 = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (over2 > 1) fail(`sideways scroll in Customize ${over2}px`);
});

await step("mcp", async () => {
  const tok = mcpToken(S.users.owner.email);
  const got = await mcp(tok, "get_dashboard", { workspace: WS });
  if (got.isError || !/Main column:/.test(got.text)) fail(`get_dashboard: ${got.text}`);
  const set = await mcp(tok, "set_dashboard", { workspace: WS, preset: "meetings" });
  if (set.isError || set.data?.main?.[0]?.type !== "meetings") fail(`set_dashboard: ${set.text}`);
  const back = await mcp(tok, "set_dashboard", { workspace: WS, reset: true });
  if (back.isError || back.data?.source !== "default") fail(`reset: ${back.text}`);
});

await browser.close();
const bad = results.filter((r) => r[1] !== "ok");
console.log(`\n${results.length - bad.length}/${results.length} ok`);
for (const r of bad) console.log("  ✗", r[0], r[1]);
process.exit(bad.length ? 1 : 0);
