/**
 * Smoke test 5 (REVAMP_PLAN §11.4): an artifact upload started signed out is kept as an IndexedDB
 * draft (`upload/pendingUpload.ts`) and restored after sign-in.
 *
 * Needs R2 + the artifact worker, which the local sandbox doesn't have (REVAMP_BUILD §8.2:
 * "Artifacts, email and Google stay unconfigured (they 503)"), so it skips unless
 * `/api/v1/artifacts/status` says `configured: true`. Unverified locally; see the R02 report.
 */
import { expect, test } from "@playwright/test";
import { API_URL, fixtureUsers, mintAccessToken, uniq } from "./support/stack";
import { settle, signIn, visit } from "./support/ui";

test("5 · artifact upload draft survives sign-in", async ({ browser }) => {
  const status = (await (await fetch(`${API_URL}/api/v1/artifacts/status`)).json().catch(() => null)) as { configured?: boolean } | null;
  test.skip(!status?.configured, "R2 is not configured on the local sandbox (artifacts 503), so artifact upload can't run locally");
  const users = fixtureUsers();
  test.skip(!users, "needs seeded users: set E2E_FIXTURES");

  const marker = uniq("artifact");
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await visit(page, "/upload");
  await settle(page);
  await page.locator('input[type="file"]').first().setInputFiles({
    name: `${marker}.html`,
    mimeType: "text/html",
    buffer: Buffer.from(`<!doctype html><title>${marker}</title><h1>${marker}</h1>`),
  });
  await expect(page.getByText(`${marker}.html`).first()).toBeVisible();
  await page.getByRole("button", { name: /^Publish/ }).first().click();
  // Signed out: the sign-in prompt appears and the draft is written to IndexedDB.
  await expect(page.getByRole("dialog").first()).toBeVisible();

  // Sign in (token seeded as the auth flow would) and come back: the draft is restored once.
  await signIn(ctx, mintAccessToken(users!.owner));
  await visit(page, "/upload");
  await expect(page.getByText(`${marker}.html`).first()).toBeVisible();
  await ctx.close();
});
