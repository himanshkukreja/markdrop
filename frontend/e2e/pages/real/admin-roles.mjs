/**
 * Admin roles on the real stack (up.sh): the Admin link in the app, and owners adding/removing admins.
 *
 *   link      the owner (MARKDROP_ADMIN_EMAILS' default address) sees "Admin" in the account menu and
 *             the sidebar and reaches the console; someone else sees neither, and /auth/me says nothing
 *   phone     the owner's phone drawer (Browse) carries Admin too; no sideways scroll on Admins
 *   add       the owner adds an admin in Admin › Admins (search → pick → confirm); they see the link,
 *             the console, and Admins read-only (no Add / Remove)
 *   remove    the owner removes them (confirm); their link and console are gone
 *
 * Screenshots in <PB_WORK>/real-shots/<browser>/admin-roles-*.png.
 * Run after the stack is up and seeded: PB_STACK_ID=N PB_WORK=… [BROWSER=webkit] node admin-roles.mjs
 */
import fs from "node:fs";
import { APP, SHOTS, api, ctx, fail, launch, log, shot, stepper } from "./lib.mjs";

fs.mkdirSync(SHOTS, { recursive: true });
const OWNER = process.env.E2E_ADMIN_EMAIL || "kukreja.him@gmail.com";
const NEW_ADMIN = `dee.${Date.now().toString(36)}@else.test`;

const mk = async (email, name) => {
  const r = await api("POST", "/__sandbox/user", null, { email, name });
  if (!r.body?.token) throw new Error(`sandbox user ${email}: is the stack up? (${r.status})`);
  return r.body;
};
const owner = await mk(OWNER, "Site Owner");
const other = await mk(`cy.${Date.now().toString(36)}@else.test`, "Cy Stranger");
const dee = await mk(NEW_ADMIN, "Dee Admin");

/** The sidebar's Admin link that is on screen (the full sidebar and the collapsed rail both render one). */
const railAdmin = (p) => p.locator('[data-testid="rail-admin"]:visible').first();
const me = async (token) => (await api("GET", "/api/v1/auth/me", token)).body;
const browser = await launch();
const { step, results } = stepper(browser);

/** The account menu's items (opened from the avatar). */
async function accountMenu(p) {
  await p.getByRole("button", { name: /^Account menu for / }).first().click();
  const menu = p.getByRole("menu").first();
  await menu.waitFor({ timeout: 10000 });
  return menu;
}

await step("link", async () => {
  if ((await me(owner.token)).admin !== "owner") fail("owner: /auth/me has no admin flag");
  const m = await me(other.token);
  if ("admin" in m) fail("someone else: /auth/me carries an admin key");

  const { p } = await ctx(browser, { token: owner.token });
  await p.goto(`${APP}/dashboard`);
  await railAdmin(p).waitFor({ timeout: 30000 });
  const menu = await accountMenu(p);
  const item = menu.getByRole("menuitem", { name: "Admin" });
  if (!(await item.isVisible())) fail("owner: no Admin in the account menu");
  await shot(p, "admin-roles-account-menu");
  await p.keyboard.press("Escape");
  await railAdmin(p).click();
  await p.waitForURL(/\/admin/, { timeout: 20000 });
  await p.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 30000 });
  if (!/Admin console/.test(await p.title())) fail("the sidebar's Admin link didn't open the console");

  const o = await ctx(browser, { token: other.token });
  await o.p.goto(`${APP}/dashboard`);
  await o.p.getByRole("button", { name: /^Account menu for / }).first().waitFor({ timeout: 30000 });
  await o.p.waitForTimeout(800);
  if (await o.p.getByTestId("rail-admin").count()) fail("someone else: Admin in the sidebar");
  const om = await accountMenu(o.p);
  if (await om.getByRole("menuitem", { name: "Admin" }).count()) fail("someone else: Admin in the account menu");
});

await step("phone", async () => {
  const { p } = await ctx(browser, { token: owner.token, width: 390, height: 844, mobile: true });
  await p.goto(`${APP}/dashboard`);
  await p.getByRole("button", { name: /^Account menu for / }).first().waitFor({ timeout: 30000 });
  const browse = p.getByRole("button", { name: /^(Browse|Menu|Open the menu)/ }).first();
  if (await browse.count()) {
    await browse.click();
    const link = p.getByRole("dialog").getByTestId("rail-admin");
    await link.waitFor({ timeout: 10000 });
    await shot(p, "admin-roles-phone-drawer");
    await p.keyboard.press("Escape");
  } else {
    log("(no Browse button at phone width: checked the account menu only)");
  }
  const menu = await accountMenu(p);
  await menu.getByRole("menuitem", { name: "Admin" }).waitFor({ timeout: 10000 });
  await p.goto(`${APP}/admin?tab=admins`);
  await p.getByRole("heading", { level: 1, name: "Admins" }).waitFor({ timeout: 30000 });
  await p.waitForTimeout(600);
  const sw = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (sw > 0) fail(`Admins at 390px: ${sw}px sideways scroll`);
  await shot(p, "admin-roles-admins-phone", { full: true });
});

await step("add", async () => {
  const { p } = await ctx(browser, { token: owner.token });
  await p.goto(`${APP}/admin?tab=admins`);
  await p.getByRole("heading", { level: 1, name: "Admins" }).waitFor({ timeout: 30000 });
  await p.getByTestId("admins-list").waitFor({ timeout: 20000 });
  await shot(p, "admin-roles-admins-owner");
  await p.getByRole("button", { name: "Add admin" }).click();
  const dlg = p.getByRole("dialog");
  await dlg.getByRole("searchbox").fill(NEW_ADMIN.split("@")[0]);
  const pick = dlg.getByRole("button", { name: /Dee Admin/ });
  await pick.waitFor({ timeout: 10000 });
  await shot(p, "admin-roles-add-search");
  await pick.click();
  await dlg.getByLabel(/Note/).fill("Runs support");
  await dlg.getByRole("button", { name: "Continue" }).click();
  await dlg.getByText("This is full read access").waitFor({ timeout: 5000 });
  await shot(p, "admin-roles-add-confirm");
  await dlg.getByRole("button", { name: "Make admin" }).click();
  await p.getByText(`${NEW_ADMIN} is now an admin.`).waitFor({ timeout: 15000 });
  await p.locator(`[data-email="${NEW_ADMIN}"]`).waitFor({ timeout: 10000 });
  await p.getByText("Recent changes").waitFor();
  await shot(p, "admin-roles-added", { full: true });
  if ((await me(dee.token)).admin !== "admin") fail("the new admin's /auth/me has no admin flag");

  const d = await ctx(browser, { token: dee.token });
  await d.p.goto(`${APP}/dashboard`);
  await railAdmin(d.p).click({ timeout: 30000 });
  await d.p.waitForURL(/\/admin/, { timeout: 20000 });
  await d.p.goto(`${APP}/admin?tab=admins`);
  await d.p.getByRole("heading", { level: 1, name: "Admins" }).waitFor({ timeout: 30000 });
  await d.p.getByText("Only an owner can add or remove admins.").waitFor({ timeout: 10000 });
  if (await d.p.getByRole("button", { name: "Add admin" }).count()) fail("an admin sees Add admin");
  if (await d.p.getByRole("button", { name: /^Remove / }).count()) fail("an admin sees Remove");
  await shot(d.p, "admin-roles-admins-readonly");
});

await step("remove", async () => {
  const { p } = await ctx(browser, { token: owner.token });
  await p.goto(`${APP}/admin?tab=admins`);
  await p.getByRole("button", { name: `Remove ${NEW_ADMIN} as admin` }).click({ timeout: 30000 });
  await p.getByRole("dialog").getByText(/Their next request to the console is refused/).waitFor({ timeout: 5000 });
  await shot(p, "admin-roles-remove-confirm");
  await p.getByRole("dialog").getByRole("button", { name: "Remove admin" }).click();
  await p.getByText(`${NEW_ADMIN} is no longer an admin.`).waitFor({ timeout: 15000 });
  if (await p.locator(`[data-email="${NEW_ADMIN}"]`).count()) fail("still listed after removal");
  if ("admin" in (await me(dee.token))) fail("removed admin: /auth/me still has the flag");

  const d = await ctx(browser, { token: dee.token });
  await d.p.goto(`${APP}/admin`);
  await d.p.getByRole("heading", { level: 1, name: "Nothing at this link" }).waitFor({ timeout: 30000 });
  await d.p.goto(`${APP}/dashboard`);
  await d.p.getByRole("button", { name: /^Account menu for / }).first().waitFor({ timeout: 30000 });
  await d.p.waitForTimeout(800);
  if (await d.p.getByTestId("rail-admin").count()) fail("removed admin: Admin still in the sidebar");
});

await browser.close();
console.log("\n" + results.map(([n, s, ms]) => `${s === "ok" ? "✓" : "✗"} ${n} ${s === "ok" ? "" : s} (${(ms / 1000).toFixed(1)} s)`).join("\n"));
if (results.some(([, s]) => s !== "ok")) process.exit(1);
