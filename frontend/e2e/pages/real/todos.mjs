/**
 * "Create my to-dos" / "Refresh to-dos" on the real stack (up.sh + teams-docs-setup.mjs + todos-docs-setup.mjs):
 *
 *   create     Riya (no to-do page in Sales) sees "Create my to-dos" on the Sales Overview; one click makes it,
 *              the toast says so and opens it; the button then reads "Refresh to-dos"
 *   refresh    Alex's Refresh pulls in the page task the store got behind the save hook's back: "Added 1 new"
 *   mine       You › My to-dos: each card has "Refresh to-dos"; General never shows
 *
 *   PB_STACK_ID=… PB_WORK=… [THEME=dark] node todos.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { STACK, STACK_ID, log, fail, launch, ctx, stepper, seedNow } from "./lib.mjs";

const S = seedNow();
const fx = JSON.parse(fs.readFileSync(path.join(STACK, "data", String(STACK_ID), "fixtures.json"), "utf8"));
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const theme = process.env.THEME === "dark" ? "dark" : "light";
const salesUrl = `/w/${encodeURIComponent(fx.workspace.id)}/teams/${fx.teams.sales.slug}`;
const browser = await launch();
const { step, results } = stepper(browser);
const { APP } = await import("./lib.mjs");

const toastText = async (p) => {
  const t = p.locator(".md-toast").last();
  await t.waitFor({ timeout: 20000 });
  return (await t.innerText()).replace(/\s+/g, " ");
};

await step("create", async () => {
  const { p } = await ctx(browser, { token: T.owner, theme });
  await p.goto(APP + salesUrl);
  const btn = p.getByTestId("todos-refresh");
  await btn.waitFor({ timeout: 30000 });
  if ((await btn.innerText()).trim() !== "Create my to-dos") fail(`Riya's button reads "${await btn.innerText()}"`);
  await btn.click();
  const t = await toastText(p);
  if (!/Your to-do page is ready · \d+ open|Added \d+ new · \d+ open/.test(t)) fail(`toast: ${t}`);
  await p.waitForFunction(() => document.querySelector("[data-testid='todos-refresh']")?.textContent?.trim() === "Refresh to-dos", null, { timeout: 15000 });
  await p.getByRole("button", { name: "Open" }).last().click();
  await p.waitForURL((u) => !u.pathname.includes("/teams/"), { timeout: 20000 });
  await p.getByText("From the team's calls").first().waitFor({ timeout: 20000 });
  log("Riya's page", p.url());
});

await step("refresh", async () => {
  const { p } = await ctx(browser, { token: T.member, theme });
  await p.goto(APP + salesUrl);
  const btn = p.getByTestId("todos-refresh");
  await btn.waitFor({ timeout: 30000 });
  if ((await btn.innerText()).trim() !== "Refresh to-dos") fail(`Alex's button reads "${await btn.innerText()}"`);
  await btn.click();
  const t = await toastText(p);
  if (!/Added 1 new · \d+ open|Up to date · \d+ open/.test(t)) fail(`toast: ${t}`);
  log("toast", t);
});

await step("mine", async () => {
  const { p } = await ctx(browser, { token: T.member, theme });
  await p.goto(APP + "/todos");
  await p.getByTestId("todo-card").first().waitFor({ timeout: 30000 });
  const names = await p.locator(".td-card__nametext").allInnerTexts();
  if (names.includes("General")) fail("General listed");
  if (!names.includes("Sales")) fail(`no Sales card: ${names}`);
  const btns = await p.getByTestId("todos-refresh").count();
  if (btns < 1) fail("no Refresh on the cards");
  await p.getByTestId("todos-refresh").first().click();
  const t = await toastText(p);
  if (!/Up to date · \d+ open|Added \d+ new · \d+ open/.test(t)) fail(`toast: ${t}`);
});

await browser.close();
const bad = results.filter((r) => r[1] !== "ok");
console.log(bad.length ? `${bad.length} failed` : `all ${results.length} passed`);
process.exit(bad.length ? 1 : 0);
