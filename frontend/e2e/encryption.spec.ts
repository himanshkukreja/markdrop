/**
 * Smoke tests 2 and 8 (REVAMP_PLAN §11.4): end-to-end encrypted documents.
 *
 * Guards §5.0 "E2E" (seal before send, never render the envelope) and "Fragments" (`#k=` is never
 * read, stripped or rewritten by anchors, the TOC or router calls).
 */
import { expect, test, type Page } from "@playwright/test";
import { createEncryptedDoc, longMarkdown, readDoc, uniq } from "./support/stack";
import { settle, visit } from "./support/ui";

const NO_KEY_COPY = /This document is end-to-end encrypted/i;

async function expectNoEnvelope(page: Page) {
  // The ciphertext is never rendered (REVAMP §7.3 "Publishing", §10.3 E2E).
  expect(await page.evaluate(() => document.body.innerText.includes("mdx1."))).toBe(false);
}

test("2 · encrypted publish keeps #k=, reload decrypts, a no-key URL shows the missing-key state", async ({ browser }) => {
  const marker = uniq("sealed");
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await visit(page, "/new");
  await settle(page);
  await page.getByPlaceholder("Untitled document").fill(`Secret title ${marker}`);
  await page.locator("textarea").first().fill(`# Sealed ${marker}\n\nOnly the link can read ${marker}.`);

  // Turn on "Encrypt in this browser" (the "Encrypt" setting chip opens its panel; its accessible
  // name may carry a "Encryption:" prefix).
  await page.getByRole("button", { name: /(^|:\s*)Encrypt(ed)?$/ }).first().click();
  const toggle = page.getByLabel(/Encrypt in this browser/).first();
  // The native input under a styled switch is visually hidden: click its visible label.
  await page.getByText("Encrypt in this browser", { exact: true }).first().click();
  await expect(toggle).toBeChecked();
  await page.keyboard.press("Escape");

  const publish = page.getByRole("button", { name: /^Publish(?!\s*settings)/i }).first();
  await expect(publish).toBeEnabled();
  const createReq = page.waitForRequest((r) => r.method() === "POST" && /\/api\/v1\/documents\/?$/.test(r.url()));
  await publish.click();

  // Seal before send: only an envelope and a null title leave the tab.
  const sent = (await createReq).postDataJSON() as { title: string | null; content: string; encrypted: boolean };
  expect(sent.encrypted).toBe(true);
  expect(sent.title).toBeNull();
  expect(sent.content).toMatch(/^mdx1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  expect(sent.content).not.toContain(marker);

  // The URL keeps the key in the fragment.
  await page.waitForURL(/\/[A-Za-z0-9_-]+\?new=1#k=[A-Za-z0-9_-]{43}$/, { timeout: 120_000 });
  const url = new URL(page.url());
  const slug = url.pathname.slice(1);
  const hash = url.hash;
  await expect(page.getByRole("heading", { name: `Sealed ${marker}` }).first()).toBeVisible();
  await expectNoEnvelope(page);
  expect((await readDoc(slug)).body?.content).toMatch(/^mdx1\./);

  // Reload decrypts, and nothing rewrote the fragment.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: `Sealed ${marker}` }).first()).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe(hash);

  // The plain reader URL with the key decrypts too.
  await visit(page, `/${slug}${hash}`);
  await expect(page.getByRole("heading", { name: `Sealed ${marker}` }).first()).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe(hash);
  await ctx.close();

  // A browser without the key (and no device copy of it) gets the missing-key state.
  const stranger = await browser.newContext();
  const other = await stranger.newPage();
  await visit(other, `/${slug}`);
  await expect(other.getByText(NO_KEY_COPY).first()).toBeVisible();
  await expect(other.getByText(`Only the link can read ${marker}.`)).toHaveCount(0);
  await expectNoEnvelope(other);
  await stranger.close();
});

test.describe("8 · in-page navigation on an encrypted document keeps #k=", () => {
  let slug = "";
  let key = "";
  const marker = uniq("toc");

  test.beforeAll(async () => {
    const doc = await createEncryptedDoc(`Contents ${marker}`, longMarkdown(`Contents ${marker}`));
    slug = doc.slug;
    key = doc.key;
  });

  async function open(page: Page) {
    await visit(page, `/${slug}#k=${key}`);
    await expect(page.getByRole("heading", { name: "Third section" }).first()).toBeVisible();
    await settle(page);
  }
  const hashOf = (page: Page) => page.evaluate(() => location.hash);

  test("8a · heading and in-document link clicks keep #k=, reload still decrypts", async ({ page }) => {
    await open(page);

    // A markdown link to a section (#third-section) scrolls without touching the hash.
    await page.getByRole("link", { name: "jump to the third section" }).first().click();
    await expect(page.getByRole("heading", { name: "Third section" }).first()).toBeInViewport();
    expect(await hashOf(page)).toBe(`#k=${key}`);

    // Clicking a heading (and its anchor, if one is offered) leaves the hash alone.
    await page.getByRole("heading", { name: "Second section" }).first().click();
    const anchor = page.getByRole("button", { name: /Copy link to section/i });
    if (await anchor.first().isVisible().catch(() => false)) await anchor.first().click();
    expect(await hashOf(page)).toBe(`#k=${key}`);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Third section" }).first()).toBeVisible();
    expect(await hashOf(page)).toBe(`#k=${key}`);
  });

  test("8b · a Contents item click keeps #k=, reload still decrypts", async ({ page }) => {
    await open(page);
    // Immersive shows TocTicks, framed (≥1280) the Contents rail: both are labelled "Contents".
    const contents = page
      .getByRole("navigation", { name: "Contents" })
      .or(page.getByRole("complementary", { name: "Contents" }))
      .first();
    await expect(contents).toBeAttached();
    const item = contents
      .getByRole("button", { name: "Fourth section" })
      .or(contents.getByRole("link", { name: "Fourth section" }))
      .first();
    await contents.hover().catch(() => {});
    await item.click();
    await expect(page.getByRole("heading", { name: "Fourth section" }).first()).toBeInViewport();
    expect(await hashOf(page)).toBe(`#k=${key}`);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Third section" }).first()).toBeVisible();
    expect(await hashOf(page)).toBe(`#k=${key}`);
  });
});
