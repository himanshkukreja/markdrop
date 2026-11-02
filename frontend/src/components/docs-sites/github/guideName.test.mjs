/**
 * The new guide's suggested name on a GitHub import (guideName.ts): the docs' own name first.
 * Runs on node's TypeScript type stripping (node ≥ 22.18); skipped without it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

let mod = null;
try {
  mod = await import("./guideName.ts");
} catch (e) {
  if (!/Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION|strip/i.test(String(e?.message ?? e))) throw e;
}
const t = mod ? test : test.skip;

t("the config's name wins over the repository's", () => {
  const { suggestGuideName } = mod;
  const repo = { owner: "himanshkukreja", name: "markdrop-guides-test" };
  assert.equal(suggestGuideName(repo, "Acme Rockets"), "Acme Rockets");
  assert.equal(suggestGuideName(repo, "  Acme\n  Rockets  "), "Acme Rockets");
  assert.equal(suggestGuideName(repo, "N".repeat(200)), "N".repeat(80));
});

t("no config name: the repository's", () => {
  const { suggestGuideName, nameFromRepo } = mod;
  const repo = { owner: "himanshkukreja", name: "markdrop-guides-test" };
  for (const none of [undefined, null, "", "   "]) assert.equal(suggestGuideName(repo, none), "Markdrop Guides Test");
  assert.equal(nameFromRepo("acme", "docs"), "Acme Docs");
  assert.equal(nameFromRepo("acme", "widget"), "Widget Docs");
  assert.equal(nameFromRepo("acme", "widget-docs.git"), "Widget Docs");
});

t("the address", () => {
  const { slugBaseFor } = mod;
  assert.equal(slugBaseFor("Widget Docs", false), "Widget");
  assert.equal(slugBaseFor("Rocket Docs", true), "Rocket Docs");
  assert.equal(slugBaseFor("Acme Rockets", true), "Acme Rockets");
});
