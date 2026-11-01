/**
 * The runner's GitHub import (runner/lib.mjs runGithubImport): where the tarball may come from, the
 * download, unpacking only the folder, the converter run, the result the API stores (pages, nav,
 * origins, OpenAPI candidates, the commit, uploaded files). No network: the tarball is served from
 * a loopback server (the local stack's codeload stand-in) or handed in directly.
 * npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { FsStore } from "../builder/store.mjs";
import { CODELOAD, checkTarballUrl, codeloadBase, configFromEnv, runGithubImport, runImport } from "../runner/lib.mjs";
import { githubTarball } from "../../frontend/scripts/docs-import/test/github-tar-helper.mjs";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const SHA = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
// A 1×1 PNG.
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4ca0000000049454e44ae426082", "hex");

const REPO = {
  "README.md": "# Acme\n\nNot in the docs folder.\n",
  "src/app.js": "console.log('not docs')\n",
  "docs/docs.json": JSON.stringify({
    name: "Acme", colors: { primary: "#2563EB" },
    navigation: { groups: [{ group: "Get started", pages: ["index", "quickstart"] }] },
    openapi: "openapi.yaml",
  }),
  "docs/index.mdx": "---\ntitle: Welcome\ndescription: Acme in one page.\n---\n\n<Note>Acme is fictional.</Note>\n\n![Shot](/images/shot.png)\n",
  "docs/quickstart.mdx": "---\ntitle: Quickstart\n---\n\n<Steps>\n  <Step title=\"Install\">\n    Run the installer.\n  </Step>\n</Steps>\n\nA plain paragraph   with odd  spacing stays as it is.\n",
  "docs/images/shot.png": PNG,
  "docs/openapi.yaml": "openapi: 3.0.0\ninfo: {title: Acme, version: '1'}\npaths: {}\n",
};

function cfgFor(work, codeload = CODELOAD) {
  return { ...configFromEnv({ MARKDROP_DOCS_WORK_DIR: work }), codeload };
}

test("codeload base: GitHub's, or loopback http for the local stack; nothing else", () => {
  assert.equal(codeloadBase(undefined), CODELOAD);
  assert.equal(codeloadBase("https://codeload.github.com/"), CODELOAD);
  assert.equal(codeloadBase("http://127.0.0.1:8250/__fakegh/codeload"), "http://127.0.0.1:8250/__fakegh/codeload");
  assert.equal(codeloadBase("http://localhost:9000"), "http://localhost:9000");
  for (const bad of ["https://evil.test", "http://10.0.0.1:80", "http://127.0.0.1", "https://127.0.0.1:443", "http://u:p@127.0.0.1:1", "ftp://127.0.0.1:21", "nonsense"]) {
    assert.throws(() => codeloadBase(bad), /MARKDROP_DOCS_GITHUB_CODELOAD/, bad);
  }
  assert.equal(checkTarballUrl("https://codeload.github.com/acme/docs/tar.gz/main"), "https://codeload.github.com/acme/docs/tar.gz/main");
  assert.equal(checkTarballUrl("https://codeload.github.com/acme/docs/legacy.tar.gz/abc?token=x"), "https://codeload.github.com/acme/docs/legacy.tar.gz/abc?token=x");
  for (const bad of ["https://codeload.github.com.evil.test/x", "https://evil.test/acme/docs", "http://codeload.github.com/a/b", "", "https://codeload.github.com"]) {
    assert.throws(() => checkTarballUrl(bad), /must come from|invalid/, bad);
  }
  assert.throws(() => checkTarballUrl("https://codeload.github.com/a/b", "http://127.0.0.1:1"), /must come from/);
});

test("a GitHub import end to end, from a loopback codeload: pages, nav, origins, OpenAPI, commit, files", async () => {
  const tarball = githubTarball(REPO, { sha: SHA });
  let asked = null;
  const server = http.createServer((req, res) => {
    asked = req.url;
    res.writeHead(200, { "content-type": "application/x-gzip", "content-length": tarball.length });
    res.end(tarball);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/codeload`;
  const work = tmp("gh-work-");
  const storeDir = tmp("gh-store-");
  const store = new FsStore(storeDir);
  const steps = [];
  try {
    const spec = {
      job: { id: "job1", kind: "import" },
      import: { kind: "github", site_id: "site1", repo: { owner: "acme", name: "docs" }, branch: "main", ref: "main", path: "docs",
                format: "auto", tarball_url: `${base}/acme/docs/tar.gz/main`, sync: false },
    };
    const res = await runImport(spec, { store, cfg: cfgFor(work, base), progress: (p) => steps.push(p.step) });
    assert.equal(asked, "/codeload/acme/docs/tar.gz/main");
    assert.equal(res.commit, SHA);
    assert.deepEqual(res.pages.map((p) => p.path).sort(), ["/", "/quickstart"]);
    assert.deepEqual(res.origins, { "/": "docs/index.mdx", "/quickstart": "docs/quickstart.mdx" });
    assert.deepEqual(res.nav, [{ group: "Get started", pages: ["/quickstart"] }]);
    assert.ok(res.openapi.some((o) => o.path === "docs/openapi.yaml"), JSON.stringify(res.openapi));
    const home = res.pages.find((p) => p.path === "/");
    assert.match(home.markdown, /:::note\nAcme is fictional\.\n:::/);
    assert.match(home.markdown, /!\[Shot\]\(\/docs-assets\/import\/docs\/images\/shot(@1x)?\.png\)/);
    const qs = res.pages.find((p) => p.path === "/quickstart");
    assert.match(qs.markdown, /A plain paragraph {3}with odd {2}spacing stays as it is\./);
    assert.equal(res.assets.files, 1);
    assert.ok(fs.readdirSync(path.join(storeDir, "sites", "site1", "assets", "import", "docs", "images")).length === 1);
    assert.equal(res.report.repoFormat, "mintlify");
    assert.ok(steps.includes("fetch") && steps.includes("upload"));
    // The work folder is cleaned up, the repository with it.
    assert.deepEqual(fs.readdirSync(path.join(work, "jobs")), []);
  } finally {
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

test("only the folder (and the top level) is unpacked; bad specs and hostile tarballs are refused", async () => {
  const work = tmp("gh-work-");
  const store = new FsStore(tmp("gh-store-"));
  const base = { job: { id: "j2" }, import: { kind: "github", site_id: "site1", repo: { owner: "acme", name: "docs" }, path: "docs", tarball_url: "https://codeload.github.com/acme/docs/tar.gz/main" } };
  let seen = [];
  const download = async () => githubTarball({ ...REPO, "secret/key.pem": "-----BEGIN-----" }, { sha: SHA });
  const cfg = cfgFor(work);
  const res = await runGithubImport(base, { store, cfg, download: async (...a) => { const b = await download(...a); return b; } });
  seen = res.unpacked;
  assert.equal(seen.files, 6); // README.md + the five docs/ files; src/ and secret/ never written
  for (const bad of [
    { repo: { owner: "acme", name: "../x" } },
    { path: "docs/../../etc" },
    { format: "jekyll" },
    { tarball_url: "https://evil.test/acme/docs.tar.gz" },
  ]) {
    await assert.rejects(runGithubImport({ ...base, import: { ...base.import, ...bad } }, { store, cfg, download }), /invalid|must come from/, JSON.stringify(bad));
  }
  // A folder with no pages: the converter's own refusal comes back as the job's error.
  await assert.rejects(runGithubImport({ ...base, import: { ...base.import, path: "src" } }, { store, cfg, download }), /no pages|No pages|exited/i);
  fs.rmSync(work, { recursive: true, force: true });
});
