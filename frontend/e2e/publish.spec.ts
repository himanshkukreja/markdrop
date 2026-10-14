/**
 * Smoke test 1 (REVAMP_PLAN §11.4): anonymous publish → `?new=1` shows the link and the edit
 * secret → copy both → edit with the secret.
 *
 * Guards §5.0 "Edit secret" (still shown; kept in sessionStorage `secret:<slug>`, never in the URL)
 * and "Fragments"/Copy link (copies `shareUrl`).
 */
import { expect, test } from "@playwright/test";
import { readDoc, uniq } from "./support/stack";
import { clipboardText, copyLinkButton, openEditor, settle, shownSecret, unlockWithSecret, visit } from "./support/ui";

test("1 · anonymous publish shows the link and the edit secret, and the secret opens the editor", async ({ browser }) => {
  const marker = uniq("publish");
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();

  // ── Publish from /new, signed out ──────────────────────────────────────────
  await visit(page, "/new");
  await settle(page);
  await page.getByPlaceholder("Untitled document").fill(`Title ${marker}`);
  await page.locator("textarea").first().fill(`# Heading ${marker}\n\nBody text for ${marker}.`);
  const publish = page.getByRole("button", { name: /^Publish(?!\s*settings)/i }).first();
  // Enabled only once React has the content: proves the page hydrated before we click.
  await expect(publish).toBeEnabled();
  await publish.click();

  await page.waitForURL(/\/[A-Za-z0-9_-]+\?new=1$/, { timeout: 120_000 });
  const slug = new URL(page.url()).pathname.slice(1);
  expect(page.url(), "the secret never rides in the URL").not.toContain("sk_");

  // ── ?new=1: the edit secret, and the link ─────────────────────────────────
  await expect(page.getByRole("heading", { name: `Heading ${marker}` }).first()).toBeVisible();
  const stored = await page.evaluate((s) => sessionStorage.getItem(`secret:${s}`), slug);
  expect(stored, "publish keeps the secret in sessionStorage secret:<slug>").toMatch(/^sk_[0-9a-f]+$/);
  await expect.poll(() => shownSecret(page), { message: "?new=1 shows the edit secret" }).toBe(stored);

  // Copy link copies the share URL.
  await copyLinkButton(page).click();
  await expect.poll(() => clipboardText(page)).toMatch(new RegExp(`/${slug}$`));

  // Copy the secret ("Copy secret" in the spec; "Copy" next to it today).
  await page.getByRole("button", { name: /^Copy( secret)?$/ }).first().click();
  await expect.poll(() => clipboardText(page)).toBe(stored);

  // The secret survives a reload of this tab (it's in sessionStorage; REVAMP §7.6 SecretReveal).
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => shownSecret(page)).toBe(stored);
  await ctx.close();

  // ── Edit with the secret, from a browser that never saw it ─────────────────
  const fresh = await browser.newContext();
  const editor = await fresh.newPage();
  await visit(editor, `/${slug}?edit=1`);
  await settle(editor);
  await expect(editor.getByRole("heading", { name: `Heading ${marker}` }).first()).toBeVisible();
  await openEditor(editor);
  await unlockWithSecret(editor, stored!);

  const body = editor.locator("textarea").first();
  await expect(body).toHaveValue(new RegExp(`Body text for ${marker}`));
  await body.fill(`# Heading ${marker}\n\nEdited with the secret ${marker}.`);
  await editor.getByRole("button", { name: /^Save( changes)?$/ }).click();

  await expect(editor.getByText(`Edited with the secret ${marker}.`).first()).toBeVisible();
  await expect.poll(async () => (await readDoc(slug)).body?.content).toContain(`Edited with the secret ${marker}.`);
  await fresh.close();
});
