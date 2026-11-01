/**
 * Owner decision 2 (2026-11): PostHog and Google Analytics never run on an encrypted document's
 * page — even opened without #k= (the key coming from this browser's store) — and arriving at one
 * by client-side navigation after they loaded sends nothing while it's open.
 *
 * Opt-in: needs `next dev` started with NEXT_PUBLIC_ANALYTICS_DEV=1 (analytics only run on
 * markdrop.in otherwise) and E2E_ANALYTICS_DEV=1 here. Every third-party request is ABORTED by the
 * test, so nothing reaches PostHog or Google; the test only counts the attempts.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import * as e2e from "../src/lib/e2e";
import { createDoc, uniq } from "./support/stack";
import { visit } from "./support/ui";

test.skip(process.env.E2E_ANALYTICS_DEV !== "1", "needs next dev with NEXT_PUBLIC_ANALYTICS_DEV=1");

const THIRD_PARTY = /\/mdp\/|googletagmanager\.com|google-analytics\.com|analytics\.google\.com|posthog\.com/;

async function trap(context: BrowserContext) {
  const attempts: { at: number; url: string }[] = [];
  await context.route(THIRD_PARTY, (route) => {
    attempts.push({ at: Date.now(), url: route.request().url() });
    return route.abort();
  });
  // Consent given (full mode: PostHog with cookies, and GA), and the light theme irrelevant here.
  await context.addInitScript(() => { try { localStorage.setItem("md_consent", "granted"); } catch { /* */ } });
  return attempts;
}

async function encryptedDoc() {
  const key = e2e.generateKey();
  const m = uniq("ana");
  const envelope = await e2e.seal(key, { title: `Secret ${m}`, content: `# Secret ${m}\n\nHidden.` });
  const doc = await createDoc({ title: null, content: envelope, encrypted: true });
  return { slug: doc.slug, key: e2e.exportKey(key), title: `Secret ${m}` };
}

const quiet = (page: Page, ms: number) => page.waitForTimeout(ms);

test("a plain page loads analytics (control)", async ({ browser }) => {
  const ctx = await browser.newContext();
  const attempts = await trap(ctx);
  const page = await ctx.newPage();
  const plain = await createDoc({ content: `# Plain ${uniq("p")}\n\nText.` });
  await visit(page, `/${plain.slug}`);
  await expect.poll(() => attempts.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await ctx.close();
});

test("an encrypted page opened with the key from this browser's store (no #k=) loads nothing; leaving for a plain page starts analytics", async ({ browser }) => {
  const doc = await encryptedDoc();
  const ctx = await browser.newContext();
  const attempts = await trap(ctx);
  await ctx.addInitScript(([s, k]) => { try { localStorage.setItem("markdrop_doc_keys", JSON.stringify({ [s]: k })); } catch { /* */ } }, [doc.slug, doc.key] as const);
  const page = await ctx.newPage();
  await visit(page, `/${doc.slug}`);
  await expect(page.getByRole("heading", { name: doc.title }).first()).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe("");
  await quiet(page, 8000);
  expect(attempts).toEqual([]);

  // Client-side navigation away: the deferred start runs on the first page that isn't encrypted.
  await page.evaluate(() => (window as unknown as { next: { router: { push: (u: string) => void } } }).next.router.push("/new"));
  await page.waitForURL(/\/new$/);
  await expect.poll(() => attempts.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await ctx.close();
});

test("arriving at an encrypted page by client-side navigation after analytics loaded sends nothing while it's open", async ({ browser }) => {
  const doc = await encryptedDoc();
  const ctx = await browser.newContext();
  const attempts = await trap(ctx);
  await ctx.addInitScript(([s, k]) => { try { localStorage.setItem("markdrop_doc_keys", JSON.stringify({ [s]: k })); } catch { /* */ } }, [doc.slug, doc.key] as const);
  const page = await ctx.newPage();
  await visit(page, "/new");
  await expect.poll(() => attempts.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await quiet(page, 3000);
  await page.evaluate((s) => (window as unknown as { next: { router: { push: (u: string) => void } } }).next.router.push(`/${s}`), doc.slug);
  await expect(page.getByRole("heading", { name: doc.title }).first()).toBeVisible();
  const arrived = Date.now();
  // Read, scroll, click about on the encrypted page.
  await page.mouse.wheel(0, 400);
  await page.getByRole("heading", { name: doc.title }).first().click();
  await quiet(page, 8000);
  const during = attempts.filter((a) => a.at > arrived + 500);
  expect(during, during.map((a) => a.url).join("\n")).toEqual([]);
  await ctx.close();
});
