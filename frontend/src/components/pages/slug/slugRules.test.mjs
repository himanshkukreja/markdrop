import { test } from "node:test";
import assert from "node:assert/strict";
import { RESERVED, cleanSlugInput, shortBase, slugFromTitle, slugProblem, splitLink } from "./slugRules.mjs";

test("slugProblem follows the API's custom-slug rules", () => {
  assert.equal(slugProblem("sl-template-prd"), null);
  assert.equal(slugProblem("A_b-9"), null);
  assert.match(slugProblem(""), /Type a link/);
  assert.match(slugProblem("ab"), /at least 3/);
  assert.match(slugProblem("x".repeat(51)), /at most 50/);
  assert.match(slugProblem("a b"), /only letters/);
  assert.match(slugProblem("a/b"), /only letters/);
  assert.match(slugProblem("Dashboard"), /Markdrop's own/);
  assert.equal(slugProblem("x".repeat(50)), null);
});

test("the reserved list matches the backend's", async () => {
  const { readFile } = await import("node:fs/promises");
  const py = await readFile(new URL("../../../../../backend/app/utils/slug.py", import.meta.url), "utf8").catch(() => null);
  if (!py) return; // the frontend alone (Vercel) has no backend folder
  const block = py.slice(py.indexOf("RESERVED_SLUGS = frozenset("), py.indexOf("APP_ONLY_SLUGS"))
    .split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  const names = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((n) => /^[A-Za-z0-9_-]+$/.test(n));
  for (const n of names) assert.ok(RESERVED.has(n), `${n} is reserved by the API`);
});

test("cleanSlugInput takes the last part of a pasted link and turns spaces into hyphens", () => {
  assert.equal(cleanSlugInput("my new page"), "my-new-page");
  assert.equal(cleanSlugInput("https://docs.acme.com/product-hub/templates/sl-prd?x=1#h"), "sl-prd");
  assert.equal(cleanSlugInput("markdrop.in/abc"), "abc");
});

test("slugFromTitle", () => {
  assert.equal(slugFromTitle("Q3 PRD: Search — Résumé"), "q3-prd-search-resume");
  assert.equal(slugFromTitle("!!"), "");
});

test("splitLink and shortBase", () => {
  const s = splitLink("https://docs.acme.com/product-hub/templates/sl-prd");
  assert.deepEqual(s, { host: "docs.acme.com", folders: ["product-hub", "templates"], base: "docs.acme.com/product-hub/templates/", slug: "sl-prd" });
  assert.equal(splitLink("https://markdrop.in/abc").base, "markdrop.in/");
  assert.equal(shortBase("markdrop.in/"), "markdrop.in/");
  assert.equal(shortBase("docs.acme.com/product-hub/templates/"), "docs.acme.com/…/templates/");
  assert.equal(splitLink("not a url").slug, "");
});
