/**
 * The shared engine files a build copies into the Worker's static assets folder. npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportEngineAssets, isSharedEngineFile, manifestSite } from "../builder/build.mjs";
import { FsStore, syncEngineAssets } from "../builder/store.mjs";

test("manifest site: noindex only when site.json turns search indexing off", () => {
  assert.equal(manifestSite({ id: "a", name: "A", url: "https://a.test/", seo: { index: false } }).noindex, true);
  assert.deepEqual(manifestSite({ id: "a", name: "A", url: "https://a.test/" }), { id: "a", name: "A", url: "https://a.test" });
  assert.equal(manifestSite({ seo: { index: true } }).noindex, undefined);
  assert.equal(manifestSite({ seo: "no" }).noindex, undefined);
});

test("only content-hashed engine output is shared", () => {
  assert.ok(isSharedEngineFile("chunks/1166-5cc8e3c183eeb59f.js"));
  assert.ok(isSharedEngineFile("chunks/app/docs-site/page-e37087faa3315f38.js"));
  assert.ok(isSharedEngineFile("css/0f3c2d1e4b5a6978.css"));
  assert.ok(isSharedEngineFile("media/manrope.4a1b2c3d.woff2"));
  // Per build id: _buildManifest.js carries the site's rewrites.
  assert.ok(!isSharedEngineFile("e811608a6a4dd4632/_buildManifest.js"));
  assert.ok(!isSharedEngineFile("e811608a6a4dd4632/_ssgManifest.js"));
});

test("export is additive, keeps other versions, and refuses a name with other bytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-assets-"));
  const bodies = { a: Buffer.from("chunk a"), b: Buffer.from("chunk b"), m: Buffer.from("per-site"), x: Buffer.from("other bytes") };
  const read = (h) => bodies[h];
  const v1 = { files: { "/_next/static/chunks/a-1.js": { o: "a", shared: true }, "/_next/static/e1/_buildManifest.js": { o: "m" }, "/docs-assets/p.png": { o: "m" } } };
  const v2 = { files: { "/_next/static/chunks/a-1.js": { o: "a", shared: true }, "/_next/static/chunks/b-2.js": { o: "b", shared: true } } };
  assert.deepEqual(exportEngineAssets(v1, read, dir), { written: 1, kept: 0 });
  assert.deepEqual(exportEngineAssets(v2, read, dir), { written: 1, kept: 1 });
  assert.equal(fs.readFileSync(path.join(dir, "_next/static/chunks/a-1.js"), "utf8"), "chunk a");
  assert.equal(fs.readFileSync(path.join(dir, "_next/static/chunks/b-2.js"), "utf8"), "chunk b");
  assert.ok(!fs.existsSync(path.join(dir, "_next/static/e1/_buildManifest.js")));
  assert.ok(!fs.existsSync(path.join(dir, "docs-assets")));
  assert.match(fs.readFileSync(path.join(dir, "_headers"), "utf8"), /immutable/);
  const bad = { files: { "/_next/static/chunks/a-1.js": { o: "x", shared: true } } };
  assert.throws(() => exportEngineAssets(bad, read, dir), /other bytes/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("assets sync: rebuilds the folder from live manifests (current + previous) and prunes the rest", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-store-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-assets-"));
  const store = new FsStore(root);
  const m = (files) => JSON.stringify({ files });
  await store.put("objects/h1", "one");
  await store.put("objects/h2", "two");
  await store.put("objects/h3", "three");
  await store.put("manifests/old.json", m({ "/_next/static/chunks/old-1.js": { o: "h1", shared: true } }));
  await store.put("manifests/new.json", m({ "/_next/static/chunks/new-2.js": { o: "h2", shared: true }, "/_next/static/e2/_buildManifest.js": { o: "h3" } }));
  await store.put("manifests/b.json", m({ "/_next/static/chunks/new-2.js": { o: "h2", shared: true } }));
  await store.put("sites/a/current.json", JSON.stringify({ manifest: "new", previous: "old" }));
  await store.put("sites/b/current.json", JSON.stringify({ manifest: "b", previous: null }));
  const stale = path.join(dir, "_next/static/chunks/gone-0.js");
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, "gone");
  const res = await syncEngineAssets({ store, dir, prune: true });
  assert.equal(res.sites, 2);
  assert.equal(res.shared, 2);
  assert.equal(res.fetched, 2);
  assert.equal(res.removed, 1);
  assert.equal(fs.readFileSync(path.join(dir, "_next/static/chunks/old-1.js"), "utf8"), "one");
  assert.equal(fs.readFileSync(path.join(dir, "_next/static/chunks/new-2.js"), "utf8"), "two");
  assert.ok(!fs.existsSync(stale));
  assert.ok(!fs.existsSync(path.join(dir, "_next/static/e2")));
  assert.match(fs.readFileSync(path.join(dir, "_headers"), "utf8"), /immutable/);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});
