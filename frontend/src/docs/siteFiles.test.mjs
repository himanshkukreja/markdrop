/**
 * A docs site's own assets and redirects (siteFiles.mjs).
 *   node --test src/docs/siteFiles.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cacheControlOf,
  contentTypeOf,
  docsHostsFromEnv,
  escapeSource,
  expandRedirects,
  hasSiteAssets,
  hostPattern,
  IMMUTABLE,
  isHashedName,
  nextRedirects,
  parseRange,
  readRedirects,
  resolveAsset,
  SHORT,
} from "./siteFiles.mjs";

function site(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-site-"));
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  return dir;
}

test("content types and cache headers", () => {
  assert.equal(contentTypeOf("a/b/shot@1x.png"), "image/png");
  assert.equal(contentTypeOf("clip.MP4"), "video/mp4");
  assert.equal(contentTypeOf("chapters.vtt"), "text/vtt; charset=utf-8");
  assert.equal(contentTypeOf("logo.svg"), "image/svg+xml");
  assert.equal(contentTypeOf("template.csv"), "text/csv; charset=utf-8");
  assert.equal(contentTypeOf("page.html"), "application/octet-stream");
  assert.equal(contentTypeOf("noext"), "application/octet-stream");
  assert.ok(isHashedName("logo.3f9a1c2e.png"));
  assert.ok(isHashedName("clip-5d41402abc4b2a76.mp4"));
  assert.ok(!isHashedName("step-1@1x.png"));
  assert.ok(!isHashedName("2024-10-30.png"));
  assert.equal(cacheControlOf("logo.3f9a1c2e.png"), IMMUTABLE);
  assert.equal(cacheControlOf("logo.png"), SHORT);
});

test("resolveAsset stays inside <public>/docs-assets", () => {
  const dir = site({ "public/docs-assets/acme/a.png": "png", "public/secret.txt": "no", "public/docs-assets/acme/.hidden": "no", "site.json": "{}" });
  const pub = path.join(dir, "public");
  const hit = resolveAsset(pub, ["acme", "a.png"]);
  assert.ok(hit);
  assert.equal(hit.size, 3);
  assert.equal(resolveAsset(pub, ["..", "secret.txt"]), null);
  assert.equal(resolveAsset(pub, ["acme", "..", "..", "secret.txt"]), null);
  assert.equal(resolveAsset(pub, ["acme/../../secret.txt"]), null);
  assert.equal(resolveAsset(pub, ["acme\\..\\..\\secret.txt"]), null);
  assert.equal(resolveAsset(pub, ["acme", ".hidden"]), null);
  assert.equal(resolveAsset(pub, ["acme", "a.png\0.txt"]), null);
  assert.equal(resolveAsset(pub, ["acme"]), null, "a folder is not a file");
  assert.equal(resolveAsset(pub, []), null);
  assert.equal(resolveAsset(pub, ["acme", "missing.png"]), null);
  // A symlink that leads out of docs-assets is refused.
  fs.symlinkSync(path.join(dir, "public", "secret.txt"), path.join(pub, "docs-assets", "acme", "link.txt"));
  assert.equal(resolveAsset(pub, ["acme", "link.txt"]), null);
});

test("hasSiteAssets: only a content folder with public/docs-assets", () => {
  assert.ok(hasSiteAssets(site({ "public/docs-assets/x/a.png": "1" })));
  assert.ok(!hasSiteAssets(site({ "site.json": "{}" })));
});

test("Range headers", () => {
  assert.equal(parseRange(null, 100), null);
  assert.deepEqual(parseRange("bytes=0-", 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseRange("bytes=90-500", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.equal(parseRange("bytes=100-", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=20-10", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=0-1,5-6", 100), null, "several ranges: the whole file");
  assert.equal(parseRange("items=0-1", 100), null);
});

test("redirects: variants, explicit keys win, bad entries reported", () => {
  const { redirects, problems } = expandRedirects({
    "/old/page": "/new/page",
    "/old/page.md": "/elsewhere.md",
    "/moved/": "/new/other#setup",
    "/gone": "https://example.com/x",
    "/readme": "/",
    "/": "/welcome",
    "old": "/x",
    "/same": "/same/",
    "/q?x=1": "/x",
    "/bad": "javascript:alert(1)",
    "/bad2": 3,
  });
  const map = Object.fromEntries(redirects.map((r) => [r.from, r.to]));
  assert.equal(map["/old/page"], "/new/page");
  assert.equal(map["/old/page/"], "/new/page");
  assert.equal(map["/old/page.md"], "/elsewhere.md", "an explicit .md key wins over the generated one");
  assert.equal(map["/moved"], "/new/other#setup");
  assert.equal(map["/moved/"], "/new/other#setup");
  assert.equal(map["/moved.md"], "/new/other.md", "the .md form drops the anchor");
  assert.equal(map["/gone"], "https://example.com/x");
  assert.equal(map["/gone.md"], undefined, "no .md form for an external target");
  assert.equal(map["/readme.md"], "/index.md", "the home's Markdown twin is /index.md");
  assert.equal(map["/"], undefined);
  assert.equal(problems.length, 6, problems.join("\n"));
  assert.ok(problems.some((p) => p.includes("home page")));
  assert.ok(problems.some((p) => p.includes("redirects to itself")));
  assert.deepEqual(expandRedirects([]).redirects, []);
  assert.equal(expandRedirects("x").problems.length, 1);
});

test("readRedirects / nextRedirects: Next.js 308s limited to the docs hosts", () => {
  const none = site({ "site.json": "{}" });
  assert.deepEqual(readRedirects(none), { redirects: [], problems: [], missing: true });
  assert.deepEqual(nextRedirects(none, ["docs.example.com"]), []);
  const bad = site({ "redirects.json": "{ nope" });
  assert.match(readRedirects(bad).problems[0], /invalid JSON/);
  const dir = site({ "redirects.json": JSON.stringify({ "/a(1)": "/b", "/c:d": "/e" }) });
  const out = nextRedirects(dir, ["docs.example.com", "docs.localhost"]);
  const a = out.find((r) => r.destination === "/b" && !r.source.endsWith("/") && !r.source.endsWith(".md"));
  assert.equal(a.source, "/a\\(1\\)");
  assert.equal(a.permanent, true);
  assert.deepEqual(a.has, [{ type: "host", value: "(?:docs\\.example\\.com|docs\\.localhost)" }]);
  assert.ok(out.some((r) => r.source === "/c\\:d"));
  assert.deepEqual(nextRedirects(dir, []), []);
});

test("escapeSource and host helpers", () => {
  assert.equal(escapeSource("/a/b-c_d.e"), "/a/b-c_d.e");
  assert.equal(escapeSource("/a*b+c?{x}"), "/a\\*b\\+c\\?\\{x\\}");
  assert.equal(hostPattern(["docs.x.com"]), "docs\\.x\\.com");
  assert.deepEqual(docsHostsFromEnv({}), ["docs.markdrop.in", "docs.localhost"]);
  assert.deepEqual(docsHostsFromEnv({ NEXT_PUBLIC_DOCS_HOST: "Docs.Acme.com:443", NEXT_PUBLIC_DOCS_HOSTS: "help.acme.com., " }), ["docs.acme.com", "docs.localhost", "help.acme.com"]);
});
