/**
 * The admin console on the real stack (up.sh): who it opens for, and every tab in both themes.
 *
 *   1. Signed out: /admin goes to /login?next=/admin.
 *   2. Signed in as someone else: the site's ordinary 404 ("Nothing at this link"), no admin title.
 *   3. Signed in as the admin (the sandbox account for MARKDROP_ADMIN_EMAILS' default address):
 *      straight in, no password form. Light by default (no md_theme stored, even on a dark OS); the
 *      shell's toggle switches to dark and the choice is remembered.
 *   4. Screenshots: every tab (and the email sub-views), light and dark, desktop 1440 and tablet 834,
 *      into $SHOTS_OUT (default <PB_WORK>/admin-shots).
 *
 * Run after seed.py and seed_admin.py: PB_STACK_ID=N PB_WORK=… node admin-sso.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { APP, WORK, api, log } from "./lib.mjs";

const OUT = process.env.SHOTS_OUT || path.join(WORK, "admin-shots");
fs.mkdirSync(OUT, { recursive: true });
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || "kukreja.him@gmail.com";
const ONLY_SHOTS = process.env.NO_SHOTS ? false : true;

const failures = [];
const check = (ok, what) => {
  if (ok) log("ok  ", what);
  else {
    failures.push(what);
    console.log("✗ FAIL", what);
  }
};

const admin = (await api("POST", "/__sandbox/user", null, { email: ADMIN_EMAIL, name: "Site Admin" })).body;
const other = (await api("POST", "/__sandbox/user", null, { email: "cy@else.test", name: "Cy Stranger" })).body;
if (!admin?.token || !other?.token) throw new Error("sandbox users: is the stack up?");

const browser = await chromium.launch();

/** A context with this session (or none) and, when given, a stored theme choice. */
async function open({ token = null, theme = null, colorScheme = "light", width = 1440, height = 900 } = {}) {
  const c = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme });
  await c.addInitScript(([t, th]) => {
    try {
      if (!sessionStorage.getItem("__seeded")) {
        if (t) localStorage.setItem("markdrop_token", t);
        else localStorage.removeItem("markdrop_token");
        if (th) localStorage.setItem("md_theme", th);
        else localStorage.removeItem("md_theme");
        localStorage.setItem("md_consent", "denied");
        localStorage.setItem("md_install_dismissed", "1");
        sessionStorage.setItem("__seeded", "1");
      }
    } catch {}
  }, [token, theme]);
  const p = await c.newPage();
  p.on("pageerror", (e) => console.log("  [pageerror]", e.message.slice(0, 300)));
  return { c, p };
}
const htmlTheme = (p) => p.evaluate(() => document.documentElement.getAttribute("data-theme"));

async function settle(p) {
  await p.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await p.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(700);
}

// ── 1. Signed out ──
{
  const { c, p } = await open();
  await p.goto(`${APP}/admin?tab=users`);
  await p.waitForURL(/\/login\?next=/, { timeout: 15000 }).catch(() => {});
  const u = new URL(p.url());
  check(u.pathname === "/login" && u.searchParams.get("next") === "/admin?tab=users", `signed out → /login?next=/admin?tab=users (got ${p.url()})`);
  await settle(p);
  await p.screenshot({ path: path.join(OUT, "signed-out-login.png") });
  await c.close();
}

// ── 2. Someone else signed in ──
{
  const { c, p } = await open({ token: other.token });
  await p.goto(`${APP}/admin`);
  const h1 = p.getByRole("heading", { level: 1, name: "Nothing at this link" });
  await h1.waitFor({ timeout: 15000 }).catch(() => {});
  check(await h1.isVisible(), "another signed-in user sees the ordinary 404 page");
  const title = await p.title();
  check(!/admin/i.test(title), `no admin in the title (${title})`);
  check(!(await p.getByText(/admin console/i).count()), "nothing on the page says admin");
  await p.screenshot({ path: path.join(OUT, "other-user-404.png") });
  await c.close();
}

// ── 3. The admin: in, light by default, the toggle ──
{
  const { c, p } = await open({ token: admin.token, colorScheme: "dark" });
  await p.goto(`${APP}/admin`);
  await p.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 20000 });
  await settle(p);
  check(!(await p.locator('input[type="password"]').count()), "no password form");
  check((await htmlTheme(p)) === "light", "light by default (nothing stored, dark OS)");
  check(/Admin console/.test(await p.title()), "the console sets its title once open");
  check(await p.getByText(ADMIN_EMAIL).first().isVisible(), "the rail names the signed-in admin");
  await p.getByRole("button", { name: "Switch to dark theme" }).first().click();
  await p.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark");
  check((await p.evaluate(() => localStorage.getItem("md_theme"))) === "dark", "the toggle stores dark");
  await p.reload();
  await p.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 20000 });
  check((await htmlTheme(p)) === "dark", "dark survives a reload");
  await c.close();
}

// ── 4. Every tab, both themes, desktop + tablet ──
const VIEWS = [
  ["overview", "/admin"],
  ["live", "/admin?tab=live"],
  ["health", "/admin?tab=health"],
  ["journeys", "/admin?tab=journeys"],
  ["ai", "/admin?tab=ai"],
  ["documents", "/admin?tab=documents"],
  ["reports", "/admin?tab=reports"],
  ["users", "/admin?tab=users"],
  ["feedback", "/admin?tab=feedback"],
  ["email", "/admin?tab=email"],
  ["email-senders", "/admin?tab=email&et=senders"],
  ["email-usage", "/admin?tab=email&et=usage"],
  ["email-sent", "/admin?tab=email&et=sent"],
  ["email-compose", "/admin?tab=email&campaign=new&template=newsletter"],
];
const SIZES = process.env.SIZES ? process.env.SIZES.split(",") : ["desktop", "tablet"];
const DIM = { desktop: [1440, 900], tablet: [834, 1112] };
if (ONLY_SHOTS) {
  for (const theme of ["light", "dark"]) {
    for (const size of SIZES) {
      const [width, height] = DIM[size];
      const { c, p } = await open({ token: admin.token, theme, colorScheme: theme, width, height });
      for (const [name, url] of VIEWS) {
        await p.goto(`${APP}${url}`);
        await p.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 20000 }).catch(() => log("no h1 on", name));
        await settle(p);
        check((await htmlTheme(p)) === theme, `${name} ${size} renders ${theme}`);
        await p.screenshot({ path: path.join(OUT, `${theme}-${size}-${name}.png`), fullPage: true });
      }
      // A dialog and a menu (portals) on Documents.
      await p.goto(`${APP}/admin?tab=documents`);
      const actions = p.getByRole("button", { name: /^Actions for / }).first();
      if (await actions.waitFor({ timeout: 15000 }).then(() => true).catch(() => false)) {
        await settle(p);
        await actions.click();
        await p.getByRole("menu").first().waitFor({ timeout: 5000 }).catch(() => {});
        await p.screenshot({ path: path.join(OUT, `${theme}-${size}-documents-menu.png`) });
        await p.keyboard.press("Escape");
        await p.getByRole("row").filter({ has: p.getByRole("button", { name: /^Actions for / }) }).first().getByRole("cell").first().click();
        await p.getByRole("dialog").first().waitFor({ timeout: 8000 }).catch(() => {});
        await p.waitForTimeout(500);
        await p.screenshot({ path: path.join(OUT, `${theme}-${size}-documents-drawer.png`) });
      }
      await c.close();
      log("shots", theme, size);
    }
  }
}

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED:\n- ${failures.join("\n- ")}` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
