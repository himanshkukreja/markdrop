/**
 * The editor's page-address rules (pagePath.ts) match the API's (backend docs_site_pages
 * normalize_path): first segments the build skips as pages are refused as you type.
 * Runs on node's TypeScript type stripping (node ≥ 22.18); skipped without it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

let mod = null;
try {
  mod = await import("./pagePath.ts");
} catch (e) {
  if (!/Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION|strip/i.test(String(e?.message ?? e))) throw e;
}
const t = mod ? test : test.skip;

t("ordinary addresses pass", () => {
  const { pathProblem } = mod;
  for (const p of ["/", "/quickstart", "/getting-started/quickstart", "/api/items/list", "/publications", "/guides/api-reference-tips"]) assert.equal(pathProblem(p), "", p);
});

t("first segments the guide or the build uses are refused with the reason", () => {
  const { pathProblem } = mod;
  for (const seg of ["public", "api-reference", "video-scenes", "docs-assets", "changelog", "mcp", "md", "og"]) {
    assert.match(pathProblem(`/${seg}/x`), new RegExp(`^/${seg} is used by the guide itself`), seg);
    assert.match(pathProblem(`/${seg}`), /used by the guide itself/, seg);
  }
  assert.match(pathProblem("/guides/video-scenes/x"), /video-scenes can't be part/);
  // node_modules and _next already fail the shape rule (no underscores).
  assert.notEqual(pathProblem("/node_modules/x"), "");
});

t("shape rules", () => {
  const { pathProblem } = mod;
  assert.match(pathProblem("quickstart"), /starts with \//);
  assert.match(pathProblem("/a/"), /end with/);
  assert.match(pathProblem("/a//b"), /\/\//);
  assert.match(pathProblem("/A"), /lowercase/);
  assert.match(pathProblem("/a/b/c/d/e/f/g"), /6 levels/);
});

t("the New page suggestion skips a group slug that can't start an address", () => {
  const { suggestedPath } = mod;
  assert.equal(suggestedPath("payments", "guides"), "/guides/payments");
  assert.equal(suggestedPath("payments", "api-reference"), "/payments");
  assert.equal(suggestedPath("v2", "changelog"), "/v2");
  assert.equal(suggestedPath("payments", ""), "/payments");
  assert.equal(suggestedPath("", "guides"), "/guides");
});
