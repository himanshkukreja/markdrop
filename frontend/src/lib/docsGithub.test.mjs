import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGithubUrl, repoLabel } from "./githubUrl.mjs";

test("repository addresses and owner/name", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/acme/docs"), { owner: "acme", name: "docs" });
  assert.deepEqual(parseGithubUrl("  https://www.github.com/acme/docs/  "), { owner: "acme", name: "docs" });
  assert.deepEqual(parseGithubUrl("github.com/acme/docs.git"), { owner: "acme", name: "docs" });
  assert.deepEqual(parseGithubUrl("http://github.com/Acme-Inc/docs.site"), { owner: "Acme-Inc", name: "docs.site" });
  assert.deepEqual(parseGithubUrl("acme/docs"), { owner: "acme", name: "docs" });
  assert.deepEqual(parseGithubUrl("acme/docs.git"), { owner: "acme", name: "docs" });
  assert.deepEqual(parseGithubUrl("https://github.com/acme/docs?tab=readme#install"), { owner: "acme", name: "docs" });
  assert.deepEqual(parseGithubUrl("https://github.com/acme/docs/pulls"), { owner: "acme", name: "docs" });
});

test("ssh addresses", () => {
  assert.deepEqual(parseGithubUrl("git@github.com:acme/docs.git"), { owner: "acme", name: "docs" });
  assert.deepEqual(parseGithubUrl("git@github.com:acme/docs"), { owner: "acme", name: "docs" });
  assert.deepEqual(parseGithubUrl("ssh://git@github.com/acme/docs.git"), { owner: "acme", name: "docs" });
});

test("branch and folder from tree and blob addresses", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/acme/docs/tree/main"), { owner: "acme", name: "docs", branch: "main" });
  assert.deepEqual(parseGithubUrl("https://github.com/acme/docs/tree/main/website/docs"), { owner: "acme", name: "docs", branch: "main", path: "website/docs" });
  assert.deepEqual(parseGithubUrl("https://github.com/acme/docs/tree/v2/docs/"), { owner: "acme", name: "docs", branch: "v2", path: "docs" });
  assert.deepEqual(parseGithubUrl("https://github.com/acme/docs/blob/main/docs/intro.md"), { owner: "acme", name: "docs", branch: "main", path: "docs" });
  assert.deepEqual(parseGithubUrl("https://github.com/acme/docs/blob/main/README.md"), { owner: "acme", name: "docs", branch: "main" });
  assert.deepEqual(parseGithubUrl("https://github.com/acme/docs/tree/main/a%20b"), { owner: "acme", name: "docs", branch: "main", path: "a b" });
});

test("not a repository", () => {
  for (const bad of [
    "", "   ", null, undefined, 42, "acme", "https://github.com/acme", "https://github.com/",
    "https://gitlab.com/acme/docs", "https://github.com.evil.com/acme/docs", "https://evil.com/github.com/acme/docs",
    "ftp://github.com/acme/docs", "javascript:alert(1)", "github.com/orgs/acme", "https://github.com/settings/profile",
    "acme docs/x", "-acme/docs", "acme/..", "acme/.", "a/b/c", "git@gitlab.com:acme/docs.git",
  ]) assert.equal(parseGithubUrl(bad), null, String(bad));
});

test("repoLabel", () => {
  assert.equal(repoLabel({ owner: "acme", name: "docs" }), "acme/docs");
  assert.equal(repoLabel(null), "");
});
