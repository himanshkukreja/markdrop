/**
 * Smoke tests 3 and 4 (REVAMP_PLAN §11.4): access gates.
 *
 * Guards §5.0 "Gates": `X-Markdrop-Gate` decides password vs sign-in, a signed-in reader is retried
 * with their token before any gate shows, and the denied state names the signed-in address.
 * Copy is matched on the spec wording and the current wording where they differ
 * ("Sign in" → "Sign in to open", "Incorrect password" → "That password didn't open it…").
 */
import { expect, test } from "@playwright/test";
import { createDoc, fixtureUsers, mintAccessToken, uniq } from "./support/stack";
import { settle, signIn, visit } from "./support/ui";

test("3 · password gate: a wrong password is refused, the right one opens the document", async ({ page }) => {
  const marker = uniq("pwd");
  const password = `pw-${marker}`;
  const doc = await createDoc({ title: `Locked ${marker}`, content: `# Locked ${marker}\n\nBehind a password: ${marker}.`, read_password: password });

  await visit(page, `/${doc.slug}`);
  const field = page.locator('input[type="password"]').first();
  await expect(field).toBeVisible();
  await settle(page);
  await expect(page.getByText(`Behind a password: ${marker}.`)).toHaveCount(0);

  // Wrong.
  await field.fill("definitely-not-it");
  await page.getByRole("button", { name: /^Unlock$/ }).click();
  await expect(page.getByText(/Incorrect password|didn.t open it/i).first()).toBeVisible();
  await expect(page.getByText(`Behind a password: ${marker}.`)).toHaveCount(0);

  // Right.
  await field.fill(password);
  await page.getByRole("button", { name: /^Unlock$/ }).click();
  await expect(page.getByText(`Behind a password: ${marker}.`).first()).toBeVisible();
});

test.describe("4 · private document", () => {
  const users = fixtureUsers();
  test.skip(!users, "needs seeded users: set E2E_FIXTURES to the sandbox fixtures.json (users.owner, users.other)");

  let slug = "";
  const marker = uniq("private");
  const body = `Only for the owner: ${marker}.`;

  test.beforeAll(async () => {
    const doc = await createDoc(
      { title: `Private ${marker}`, content: `# Private ${marker}\n\n${body}`, access_level: "private" },
      mintAccessToken(users!.owner)
    );
    slug = doc.slug;
  });

  test("4a · signed out: the sign-in gate, never a password box", async ({ page }) => {
    await visit(page, `/${slug}`);
    const signInCta = page.getByRole("link", { name: /^Sign in( to open)?$/ }).or(page.getByRole("button", { name: /^Sign in( to open)?$/ }));
    // The gate's own CTA (the site header may also carry a "Sign in" link: take the one in main).
    await expect(page.getByRole("main").filter({ has: signInCta }).first()).toBeVisible();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.getByText(body)).toHaveCount(0);
  });

  test("4b · signed in with the wrong account: denied, naming that account", async ({ context, page }) => {
    await signIn(context, mintAccessToken(users!.other));
    await visit(page, `/${slug}`);
    await expect(page.getByText(new RegExp(`Signed in as\\s*${users!.other.email.replace(/[.@]/g, "\\$&")}`)).first()).toBeVisible();
    await expect(page.getByText(/Ask the owner to share it with this address/i).first()).toBeVisible();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.getByText(body)).toHaveCount(0);
  });

  test("4c · signed in as the owner: the token retry opens it, no gate", async ({ context, page }) => {
    await signIn(context, mintAccessToken(users!.owner));
    await visit(page, `/${slug}`);
    await expect(page.getByText(body).first()).toBeVisible();
    await expect(page.getByText(/Signed in as/i)).toHaveCount(0);
  });
});
