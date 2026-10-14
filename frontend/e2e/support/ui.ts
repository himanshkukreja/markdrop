/**
 * Page helpers that target behaviour and the spec copy (REVAMP_PLAN §7.6), not markup.
 *
 * The viewer, /new and admin are being rewritten while these tests guard them, so selectors are
 * roles, accessible names and copy. Where the spec renames a control, the matcher accepts both the
 * current and the spec wording (e.g. "Unlock" → "Unlock editor"); the behaviour asserted is the same.
 */
import { expect, type APIRequestContext, type APIResponse, type BrowserContext, type Locator, type Page } from "@playwright/test";

/** Seed localStorage before any page script runs (every navigation, including reloads). */
export async function seedLocalStorage(context: BrowserContext, entries: Record<string, string>): Promise<void> {
  await context.addInitScript((e: Record<string, string>) => {
    try {
      for (const [k, v] of Object.entries(e)) localStorage.setItem(k, v);
    } catch {
      /* about:blank has no storage */
    }
  }, entries);
}

/** Sign a browser context in: the app keeps its session token in localStorage `markdrop_token`. */
export async function signIn(context: BrowserContext, token: string): Promise<void> {
  await seedLocalStorage(context, { markdrop_token: token });
}

/**
 * Navigate without waiting for every dev chunk's `load`: on a shared, recompiling `next dev` that
 * can take minutes. Assertions that follow wait for what they need.
 */
export async function visit(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
}

/** A plain GET of an app page (no JavaScript), patient with a recompiling dev server. */
export function getPage(request: APIRequestContext, path: string): Promise<APIResponse> {
  return request.get(path, { timeout: 300_000 });
}

/**
 * Let a dev-server page finish loading chunks and hydrating. Interactions before hydration are
 * lost on a slow `next dev`; networkidle is a good-enough proxy (the HMR socket doesn't count).
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
}

/** The first `sk_…` edit secret the page shows, as text or as an input's value. */
export async function shownSecret(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const re = /sk_[0-9a-f]{16,}/;
    const inText = document.body.innerText.match(re)?.[0];
    if (inText) return inText;
    for (const el of Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"))) {
      const m = el.value.match(re)?.[0];
      if (m) return m;
    }
    return null;
  });
}

export async function clipboardText(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** "Copy link" (spec + current copy). */
export function copyLinkButton(page: Page): Locator {
  return page.getByRole("button", { name: /^Copy link$/i }).first();
}

/**
 * Open the editor from the reader. The owner or a secret holder sees "Edit" in the bar; others
 * find it in the overflow menu (D19), so fall back to that.
 */
export async function openEditor(page: Page): Promise<void> {
  await leaveImmersive(page);
  const direct = page.getByRole("button", { name: /^Edit$/ });
  if (await direct.first().isVisible().catch(() => false)) {
    await direct.first().click();
    return;
  }
  await page.getByRole("button", { name: /^(More|More actions|Document actions|Options|More options)$/i }).first().click();
  await page.getByRole("menuitem", { name: /^Edit/ }).first().click();
}

/**
 * Immersive reading has exactly one way out (ImmersiveExit, "Show details", or Esc). Leave it when
 * a test needs the framed chrome; a no-op on the framed view.
 */
export async function leaveImmersive(page: Page): Promise<void> {
  const exit = page.getByRole("button", { name: /^(Show details|Exit full screen)/i }).first();
  if (await exit.isVisible().catch(() => false)) {
    await exit.click();
    await expect(exit).toBeHidden();
  }
}

/** The edit-secret unlock form: fill the secret and submit. */
export async function unlockWithSecret(page: Page, secret: string): Promise<void> {
  await expect(page.getByText(/Enter your edit secret/i).first()).toBeVisible();
  const field = page
    .getByLabel(/edit secret/i)
    .or(page.getByPlaceholder(/edit secret/i))
    .first();
  await field.fill(secret);
  await page.getByRole("button", { name: /^Unlock( editor)?$/ }).click();
}

/** The current `data-theme` on <html>. */
export function htmlTheme(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute("data-theme"));
}
