/** The page header edits single frontmatter keys and leaves everything else as written. */
import test from "node:test";
import assert from "node:assert/strict";
import { readMeta, writeFrontmatter, splitFrontmatter, yamlScalar } from "../core/frontmatter.mjs";
import { parse } from "yaml";

const FRONT = "---\n# a comment\ntitle: Old title\ndescription: >-\n  Folded\n  over lines\nupdated: 2026-10-30\nkeywords: [a, b]\n---\n";

test("reads title, description and icon", () => {
  assert.deepEqual(readMeta(FRONT), { title: "Old title", description: "Folded over lines", icon: "" });
  assert.deepEqual(readMeta(""), { title: "", description: "", icon: "" });
});

test("rewrites a key in place, including a multi-line value", () => {
  const out = writeFrontmatter(FRONT, { title: "New title", description: "One line" });
  assert.equal(out, "---\n# a comment\ntitle: New title\ndescription: One line\nupdated: 2026-10-30\nkeywords: [a, b]\n---\n");
});

test("adds a missing key before the closing fence, removes an emptied one", () => {
  assert.equal(writeFrontmatter(FRONT, { icon: "zap" }), FRONT.replace("keywords: [a, b]\n", "keywords: [a, b]\nicon: zap\n"));
  assert.equal(writeFrontmatter("---\ntitle: T\nicon: zap\n---\n", { icon: "" }), "---\ntitle: T\n---\n");
});

test("creates a frontmatter block when there is none", () => {
  assert.equal(writeFrontmatter("", { title: "Hello" }), "---\ntitle: Hello\n---\n");
  assert.equal(writeFrontmatter("", { title: "" }), "");
});

test("quotes values YAML would misread", () => {
  for (const v of ["Setup: the basics", "#1 guide", "yes", "2026", "- dash", "trailing ", "it's \"quoted\"", "a #comment", "[x]", "@user", "plain words"]) {
    const line = `title: ${yamlScalar(v)}`;
    assert.equal(parse(line).title, v, line);
  }
  assert.equal(yamlScalar("plain words"), "plain words");
});

test("keeps CRLF and splits a page", () => {
  assert.equal(writeFrontmatter("---\r\ntitle: A\r\n---\r\n", { title: "B" }), "---\r\ntitle: B\r\n---\r\n");
  assert.deepEqual(splitFrontmatter("---\ntitle: A\n---\nBody\n"), { front: "---\ntitle: A\n---\n", body: "Body\n" });
  assert.deepEqual(splitFrontmatter("Body\n"), { front: "", body: "Body\n" });
});
