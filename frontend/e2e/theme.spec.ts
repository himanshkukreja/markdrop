/**
 * Smoke tests 7 and 10 (REVAMP_PLAN §11.4, REVAMP_BUILD §4.5): the theme system.
 *
 * Guards §5.0 "ISR" (the theme never comes from the request: the server HTML is theme-agnostic and
 * the inline head script resolves it before first paint) and "Fragments" (the theme script never
 * reads or rewrites `location.hash`). `?theme=off` from REVAMP_PLAN §5.3 is not tested: REVAMP_BUILD
 * §4.5 overrides it ("It never reads query params").
 */
import { expect, test, type Page } from "@playwright/test";
import { adminToken, createEncryptedDoc, longMarkdown, uniq } from "./support/stack";
import { getPage, htmlTheme, seedLocalStorage, settle, visit } from "./support/ui";

type Log = [string, string | null, string][];

/** Runs before any page script: records every data-theme value and what the first frame saw. */
function recordTheme(seed: { theme: string | null }) {
  const log: Log = [];
  (window as unknown as { __themeLog: Log }).__themeLog = log;
  const rec = (where: string) => {
    const d = document.documentElement;
    log.push([where, d ? d.getAttribute("data-theme") : null, d ? getComputedStyle(d).backgroundColor : ""]);
  };
  try {
    localStorage.setItem("md_theme_beta", "1");
    if (seed.theme === null) localStorage.removeItem("md_theme");
    else localStorage.setItem("md_theme", seed.theme);
    // The legacy key the old script wrote: the first load must delete it.
    if (!sessionStorage.getItem("__e2e_seeded")) {
      localStorage.setItem("theme", "dark");
      sessionStorage.setItem("__e2e_seeded", "1");
    }
  } catch {
    /* no storage on about:blank */
  }
  new MutationObserver(() => rec("mutation")).observe(document, { attributes: true, attributeFilter: ["data-theme"], subtree: true });
  requestAnimationFrame(() => rec("first-frame"));
}

const CASES: { name: string; stored: string | null; scheme: "light" | "dark"; expected: "light" | "dark" }[] = [
  { name: "md_theme=light (OS dark)", stored: "light", scheme: "dark", expected: "light" },
  { name: "md_theme=dark (OS light)", stored: "dark", scheme: "light", expected: "dark" },
  { name: "system, OS light", stored: null, scheme: "light", expected: "light" },
  { name: "system, OS dark", stored: null, scheme: "dark", expected: "dark" },
  { name: "unknown value falls back to system (OS light)", stored: "sepia", scheme: "light", expected: "light" },
];

test.describe("7 · theme: hard reload per md_theme value, no flash, #k= untouched", () => {
  let slug = "";
  let key = "";

  test.beforeAll(async () => {
    const doc = await createEncryptedDoc(`Theme ${uniq("theme")}`, longMarkdown("Theme check"));
    slug = doc.slug;
    key = doc.key;
  });

  test("server HTML is theme-agnostic and resolves the theme in <head>", async ({ request }) => {
    const html = await (await getPage(request, `/${slug}`)).text();
    const htmlTag = html.match(/<html[^>]*>/)?.[0] ?? "";
    expect(htmlTag, "no theme baked into shared (ISR) HTML").not.toMatch(/data-theme=/);
    const head = html.slice(0, html.indexOf("<body"));
    expect(head, "the inline head script sets data-theme before <body>").toMatch(/<script>[^<]*setAttribute\(\s*['"]data-theme['"]/);
    expect(head, "the head script never touches the fragment").not.toMatch(/location\.hash/);
  });

  for (const c of CASES) {
    test(c.name, async ({ browser }) => {
      const ctx = await browser.newContext({ colorScheme: c.scheme });
      await ctx.addInitScript(recordTheme, { theme: c.stored });
      const page = await ctx.newPage();

      const check = async (label: string) => {
        await expect(page.getByRole("heading", { name: "Third section" }).first()).toBeVisible();
        await settle(page);
        const log = await page.evaluate(() => (window as unknown as { __themeLog: Log }).__themeLog);
        const first = log.find(([w]) => w === "first-frame");
        expect(first?.[1], `${label}: data-theme is set before the first frame`).toBe(c.expected);
        const seen = log.map(([, t]) => t).filter((t): t is string => t !== null);
        expect(new Set(seen), `${label}: data-theme never flips (log: ${JSON.stringify(log)})`).toEqual(new Set([c.expected]));
        expect(await htmlTheme(page)).toBe(c.expected);
        const finalBg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
        expect(first?.[2], `${label}: the first frame already has the final page background`).toBe(finalBg);
        expect(await page.evaluate(() => location.hash), `${label}: #k= untouched`).toBe(`#k=${key}`);
        expect(await page.evaluate(() => localStorage.getItem("theme")), `${label}: legacy theme key removed`).toBeNull();
      };

      await visit(page, `/${slug}#k=${key}`);
      await check("first load");
      await page.reload({ waitUntil: "domcontentloaded" });
      await check("reload");
      await ctx.close();
    });
  }
});

/** The theme the nearest scope stamps on an element (a portal root carries its island's). */
function scopeTheme(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => el.closest("[data-theme]")?.getAttribute("data-theme") ?? null);
}

test("10 · portals inside a dark island (admin) render dark while the site is light", async ({ browser }) => {
  const token = await adminToken();
  test.skip(!token, "needs admin credentials: E2E_FIXTURES (admin) or E2E_ADMIN_USER/E2E_ADMIN_PASSWORD");

  const ctx = await browser.newContext({ colorScheme: "light" });
  await seedLocalStorage(ctx, { md_theme: "light", md_theme_beta: "1", markdrop_admin_token: token! });
  const page = await ctx.newPage();
  await visit(page, "/admin?tab=documents");

  const actions = page.getByRole("button", { name: /^Actions for / }).first();
  await expect(actions).toBeVisible();
  await settle(page);
  expect(await htmlTheme(page), "the site itself is light").toBe("light");

  // A menu (portalled to <body>, outside the island's DOM).
  await actions.click();
  const menu = page.getByRole("menu").first();
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((el) => !!el.closest("main")), "the menu is portalled out of the island").toBe(false);
  expect(await scopeTheme(page, '[role="menu"]')).toBe("dark");
  await actions.click(); // close it again (toggle)
  await expect(menu).toBeHidden();

  // A dialog: the document drawer opened from a row.
  await page.getByRole("row").filter({ has: page.getByRole("button", { name: /^Actions for / }) }).first().getByRole("cell").first().click();
  const dialog = page.getByRole("dialog").first();
  await expect(dialog).toBeVisible();
  expect(await scopeTheme(page, '[role="dialog"]')).toBe("dark");
  expect(await htmlTheme(page), "opening them didn't change the site theme").toBe("light");
  await ctx.close();
});
