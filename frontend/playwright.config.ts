import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * Guardrail smoke suite (REVAMP_BUILD §4.2, REVAMP_PLAN §11.4).
 *
 * Runs against a LOCAL stack only (REVAMP_BUILD §8.2): an already-running `next dev` (or
 * `next start`) and a sandbox API. Nothing here starts or stops a server.
 *
 *   E2E_BASE_URL     the app            (default http://localhost:3150)
 *   E2E_API_URL      the sandbox API    (default http://127.0.0.1:8091)
 *   E2E_AUTH_SECRET  the API's MARKDROP_AUTH_SECRET, to mint user JWTs
 *   E2E_FIXTURES     a seeded fixtures.json (users + admin); tests that need users skip without it
 *   E2E_ONLINE=1     also run the read-only production check (smoke test 11)
 *   E2E_PROD_SERVER=1  the app is `next start`: also run the visual no-JS check (smoke test 6)
 *   E2E_OUTPUT_DIR   traces/screenshots (default: the OS temp dir, so nothing lands in the repo)
 *
 * Serial on purpose: the dev server is shared and compiles routes on first hit, so timeouts are
 * generous and there is one worker.
 */
const baseURL = process.env.E2E_BASE_URL || "http://localhost:3150";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  // One retry: a shared `next dev` that other work is recompiling can serve a half-written chunk
  // ("Invalid or unexpected token") and the page never hydrates. Playwright reports such a test as
  // "flaky", not "passed", so a real regression still shows.
  retries: 1,
  timeout: 600_000,
  expect: { timeout: 60_000 },
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  outputDir: process.env.E2E_OUTPUT_DIR || path.join(os.tmpdir(), "markdrop-e2e-results"),
  use: {
    baseURL,
    actionTimeout: 30_000,
    navigationTimeout: 300_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
});
