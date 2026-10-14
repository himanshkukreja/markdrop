/**
 * Smoke test 11 (REVAMP_PLAN §11.4, §6.1; REVAMP_BUILD §5.H.8): every markdrop.in slug a mock
 * shows is a real, published sample.
 *
 * The only test that touches production, and only with read-only GETs. Skipped unless E2E_ONLINE=1.
 */
import { expect, test } from "@playwright/test";
import { SAMPLE_SLUGS, SAMPLE_SLUGS_PUBLISHED } from "../src/lib/marketingFlags";
import { ONLINE, PROD_URL } from "./support/stack";

test.describe("11 · SAMPLE_SLUGS return 200 on production", () => {
  test.skip(!ONLINE, "production read-only check: set E2E_ONLINE=1");

  async function status(slug: string): Promise<number> {
    const res = await fetch(`${PROD_URL}/${slug}`, { method: "GET", redirect: "follow", headers: { "User-Agent": "markdrop-e2e-smoke" } });
    return res.status;
  }

  test("every slug rendered as a link (SAMPLE_SLUGS_PUBLISHED) is live", async () => {
    for (const slug of SAMPLE_SLUGS_PUBLISHED) expect(await status(slug), `${PROD_URL}/${slug}`).toBe(200);
  });

  test("every slug a mock shows (SAMPLE_SLUGS) is live", async () => {
    // Until the owner publishes the samples (REVAMP_BUILD Q6), mocks show them as plain text and
    // SAMPLE_SLUGS_PUBLISHED is a strict subset.
    test.fixme(SAMPLE_SLUGS.some((s) => !SAMPLE_SLUGS_PUBLISHED.has(s)), "owner hasn't published every sample slug yet (REVAMP_BUILD Q6)");
    for (const slug of SAMPLE_SLUGS) expect(await status(slug), `${PROD_URL}/${slug}`).toBe(200);
  });
});
