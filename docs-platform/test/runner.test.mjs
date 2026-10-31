/**
 * The job runner's steps without a build: the content folder, which site files a build fetches,
 * the asset cache, reading an imported folder, uploading its files, the restore pointer, media.json.
 * npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { FsStore, pointSite, publish, writeAccess } from "../builder/store.mjs";
import { mediaManifest } from "../builder/media.mjs";
import { fetchAssets, importFileAllowed, readImportFolder, readPageFile, referencedAssets, safeRel, uploadImportAssets, writeContent } from "../runner/lib.mjs";
import { httpsUrl, readRedirects, sitePath } from "../builder/build.mjs";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const PNG = "\x89PNG\r\n\x1a\n\0\0\0\rIHDR"; // a PNG's first bytes (latin1)
// A tiny YAML subset for the tests (the runner uses the engine's `yaml` package).
const parseYaml = (s) => Object.fromEntries(s.split("\n").filter(Boolean).map((l) => {
  const i = l.indexOf(":");
  const v = l.slice(i + 1).trim();
  return [l.slice(0, i).trim(), v.startsWith("{") || v.startsWith('"') ? JSON.parse(v) : v];
}));

test("content paths: relative, no traversal, no hidden segments, nothing under public/", () => {
  assert.equal(safeRel("guide/start.md"), "guide/start.md");
  for (const bad of ["", "/etc/passwd", "../x.md", "a/../../x", "a//b", ".env", "a/.git/config", "a\\b", "a\0b"]) assert.equal(safeRel(bad), null, bad);
  const dir = tmp("content-");
  assert.equal(writeContent({ "site.json": "{}", "guide/start.md": "x" }, dir), 2);
  assert.equal(fs.readFileSync(path.join(dir, "guide/start.md"), "utf8"), "x");
  assert.throws(() => writeContent({ "../evil.md": "x" }, dir), /bad content path/);
  assert.throws(() => writeContent({ "public/docs-assets/x.png": "x" }, dir), /bad content path/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a build fetches the files the content refers to, with dark variants and clip parts", () => {
  const p = "sites/s1/assets/";
  const objects = ["a.png", "a.dark.png", "unused.png", "clip.mp4", "clip.webm", "clip.webp", "clip.dark.mp4", "g/b.jpg", "../x.png"].map((k) => ({ key: p + k, size: 1, etag: "e" }));
  objects.push({ key: "sites/s2/assets/a.png", size: 1, etag: "e" });
  const text = 'see ![a](/docs-assets/a.png) and ::clip{src="/docs-assets/clip"} and /docs-assets/g/b.jpg';
  assert.deepEqual(referencedAssets(objects, "s1", text).map((o) => o.key.slice(p.length)).sort(), ["a.dark.png", "a.png", "clip.dark.mp4", "clip.mp4", "clip.webm", "clip.webp", "g/b.jpg"]);
});

test("fetchAssets: downloads once into the cache, links into the content folder", async () => {
  const root = tmp("store-");
  const store = new FsStore(root);
  await store.put("sites/s1/assets/a.png", "PNG-A");
  await store.put("sites/s1/assets/sub/b.png", "PNG-B");
  await store.put("sites/s1/assets/unused.png", "U");
  const cache = tmp("cache-");
  const text = "/docs-assets/a.png /docs-assets/sub/b.png";
  for (const expectFetched of [2, 0]) {
    const content = tmp("content-");
    const res = await fetchAssets({ store, siteId: "s1", contentDir: content, text, cacheDir: cache });
    assert.equal(res.used, 2);
    assert.equal(res.listed, 3);
    assert.equal(res.fetched, expectFetched);
    assert.equal(fs.readFileSync(path.join(content, "public/docs-assets/sub/b.png"), "utf8"), "PNG-B");
    assert.ok(!fs.existsSync(path.join(content, "public/docs-assets/unused.png")));
    fs.rmSync(content, { recursive: true, force: true });
  }
  // Same key, new bytes (a re-import): a new ETag, so a new download.
  await store.put("sites/s1/assets/a.png", "PNG-A2");
  const content = tmp("content-");
  const res = await fetchAssets({ store, siteId: "s1", contentDir: content, text, cacheDir: cache });
  assert.equal(res.fetched, 1);
  assert.equal(fs.readFileSync(path.join(content, "public/docs-assets/a.png"), "utf8"), "PNG-A2");
  for (const d of [root, cache, content]) fs.rmSync(d, { recursive: true, force: true });
});

test("listObjects gives size and the MD5 ETag", async () => {
  const root = tmp("store-");
  const store = new FsStore(root);
  await store.put("sites/s/assets/x", "hello");
  assert.deepEqual(await store.listObjects("sites/s/assets/"), [{ key: "sites/s/assets/x", size: 5, etag: crypto.createHash("md5").update("hello").digest("hex") }]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("an imported folder reads back as pages, nav, brand, redirects and the report", () => {
  const dir = tmp("import-");
  const w = (rel, s) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), s);
  };
  w("site.json", JSON.stringify({ name: "S Docs", headline: "Hi", nav: [{ group: "G", icon: "home", pages: ["/g/a"] }], pages: { icons: true }, brand: { name: "S", accent: "#123456" } }));
  w("index.md", "---\ntitle: S Docs\ndescription: Home\nupdated: 2026-10-31\n---\n\nHome body");
  w("g/a.md", '---\ntitle: A\ndescription: About A\nupdated: 2026-10-31\nicon: zap\nnav: Short A\nanchors: {"old-id": "new-id"}\n---\n\n## A\n');
  w("g/hidden.md", "---\ntitle: H\ndescription: d\nupdated: 2026-10-31\n---\n\nx");
  w("_IMPORT_REPORT.md", "# report");
  w("public/docs-assets/x/a.md", "not a page");
  w("redirects.json", JSON.stringify({ "/old": "/g/a" }));
  w("_import-report.json", JSON.stringify({ counts: { pages: 3 } }));
  const data = readImportFolder(dir, { parseYaml });
  assert.deepEqual(data.pages.map((p) => [p.path, p.hidden]), [["/g/a", false], ["/g/hidden", true], ["/", false]]);
  const a = data.pages[0];
  assert.deepEqual([a.title, a.description, a.icon, a.updated], ["A", "About A", "zap", "2026-10-31"]);
  assert.deepEqual(a.frontmatter_extra, { nav: "Short A", anchors: { "old-id": "new-id" } });
  assert.equal(a.markdown, "## A\n");
  assert.deepEqual(data.nav, [{ group: "G", icon: "home", pages: ["/g/a"] }]);
  assert.equal(data.site.headline, "Hi");
  assert.deepEqual(data.site.brand, { name: "S", accent: "#123456" });
  assert.deepEqual(data.redirects, { "/old": "/g/a" });
  assert.deepEqual(data.report, { counts: { pages: 3 } });
  assert.equal(readPageFile("no frontmatter", parseYaml).markdown, "no frontmatter");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("import upload: only files the bucket doesn't already have with the same bytes", async () => {
  const dir = tmp("import-");
  const root = tmp("store-");
  const store = new FsStore(root);
  fs.mkdirSync(path.join(dir, "public/docs-assets/import/g"), { recursive: true });
  const A = PNG + "A";
  const B = PNG + "B";
  fs.writeFileSync(path.join(dir, "public/docs-assets/import/g/a.png"), A, "latin1");
  fs.writeFileSync(path.join(dir, "public/docs-assets/import/b.png"), B, "latin1");
  await store.put("sites/s1/assets/import/b.png", Buffer.from(B, "latin1"));
  const res = await uploadImportAssets({ store, siteId: "s1", dir });
  const sha = (s) => crypto.createHash("sha256").update(Buffer.from(s, "latin1")).digest("hex");
  assert.deepEqual(res, { files: 2, bytes: 2 * A.length, uploaded: 1, uploaded_bytes: A.length, skipped: [], items: [
    { rel: "import/b.png", size: B.length, sha256: sha(B), content_type: "image/png" },
    { rel: "import/g/a.png", size: A.length, sha256: sha(A), content_type: "image/png" },
  ] });
  assert.equal(fs.readFileSync(store.file("sites/s1/assets/import/g/a.png"), "latin1"), A);
  assert.equal((await uploadImportAssets({ store, siteId: "s1", dir })).uploaded, 0);
  for (const d of [dir, root]) fs.rmSync(d, { recursive: true, force: true });
});


test("import upload: only images, PDFs and video whose bytes match their name, under import/", async () => {
  const dir = tmp("import-");
  const root = tmp("store-");
  const store = new FsStore(root);
  const files = {
    "import/g/shot.png": PNG,
    "import/g/doc.pdf": "%PDF-1.7\n%....",
    "import/g/clip.mp4": "\0\0\0\x18ftypisom\0\0\0\0",
    "import/g/page.html": "<!doctype html><script>alert(document.cookie)</script>",
    "import/g/logo.svg": '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    "import/g/feed.xml": '<?xml version="1.0"?><x/>',
    "import/g/app.js": "alert(1)",
    "import/g/x.xhtml": "<html/>",
    "import/g/fake.png": "<html><script>alert(1)</script></html>",
    "import/g/fake.pdf": PNG,
    "import/g/noext": PNG,
    "elsewhere/a.png": PNG,
  };
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, "public/docs-assets", rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, "public/docs-assets", rel), body, "latin1");
  }
  const res = await uploadImportAssets({ store, siteId: "s1", dir });
  assert.deepEqual(res.items.map((i) => i.rel), ["import/g/clip.mp4", "import/g/doc.pdf", "import/g/shot.png"]);
  assert.deepEqual(res.skipped, ["elsewhere/a.png", "import/g/app.js", "import/g/fake.pdf", "import/g/fake.png", "import/g/feed.xml", "import/g/logo.svg", "import/g/noext", "import/g/page.html", "import/g/x.xhtml"]);
  assert.equal(res.files, 3);
  assert.deepEqual((await store.listObjects("sites/s1/assets/")).map((o) => o.key).sort(), ["sites/s1/assets/import/g/clip.mp4", "sites/s1/assets/import/g/doc.pdf", "sites/s1/assets/import/g/shot.png"]);
  assert.equal(importFileAllowed("import/../x.png", Buffer.from(PNG, "latin1")), false);
  assert.equal(importFileAllowed("import/.x/a.png", Buffer.from(PNG, "latin1")), false);
  assert.equal(importFileAllowed("import/a.JPEG", Buffer.from("\xff\xd8\xff\xe0" + "\0".repeat(12), "latin1")), true);
  for (const d of [dir, root]) fs.rmSync(d, { recursive: true, force: true });
});

test("redirects.json: a target that isn't a site path or an https URL never reaches the edge", () => {
  const dir = tmp("redirects-");
  fs.writeFileSync(path.join(dir, "redirects.json"), JSON.stringify({
    "/a": "/guide/a", "/b": "https://acme.test/b", "/c": "//evil.test/x", "/d": "/\\evil.test", "/e": "javascript:alert(1)",
    "/f": "http://evil.test/", "/g": "/x\ny", "/h": "https://u:p@evil.test/", "//i": "/guide/a", "/j": "data:text/html,x", "/k": "evil.test",
  }));
  const tos = readRedirects(dir).filter((r) => !r.from.endsWith(".md")).map((r) => [r.from, r.to]);
  assert.deepEqual(tos, [["/a", "/guide/a"], ["/b", "https://acme.test/b"]]);
  fs.writeFileSync(path.join(dir, "redirects.json"), JSON.stringify({ redirects: [{ from: "/x", to: "//evil.test" }, { from: "/y", to: "/ok" }] }));
  assert.deepEqual(readRedirects(dir), [{ from: "/y", to: "/ok", status: 308 }]);
  for (const [v, want] of [["/ok", true], ["//x", false], ["/\\x", false], ["/a b", false], ["x", false], [null, false]]) assert.equal(sitePath(v), want, String(v));
  for (const [v, want] of [["https://a.test/x", true], ["HTTPS://a.test", true], ["http://a.test", false], ["https://", false], ["https://a.test/\\x", false]]) assert.equal(httpsUrl(v), want, v);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("point: a restore flips the pointer to a manifest the store has, of the same site", async () => {
  const root = tmp("store-");
  const store = new FsStore(root);
  const h1 = "1".repeat(64);
  const h2 = "2".repeat(64);
  await store.put(`manifests/${h1}.json`, JSON.stringify({ site: { id: "s1" }, engine: "e1" }));
  await store.put(`manifests/${h2}.json`, JSON.stringify({ site: { id: "s1" }, engine: "e2" }));
  await store.put("sites/s1/current.json", JSON.stringify({ manifest: h2, engine: "e2", previous: h1 }));
  const res = await pointSite({ store, site: "s1", manifest: h1 });
  assert.deepEqual([res.unchanged, res.previous, res.engine], [false, h2, "e1"]);
  const ptr = JSON.parse(await store.getText("sites/s1/current.json"));
  assert.deepEqual([ptr.manifest, ptr.previous, ptr.engine, ptr.restored], [h1, h2, "e1", true]);
  assert.equal((await pointSite({ store, site: "s1", manifest: h1 })).unchanged, true);
  await assert.rejects(pointSite({ store, site: "s2", manifest: h1 }), /belongs to site "s1"/);
  await assert.rejects(pointSite({ store, site: "s1", manifest: "3".repeat(64) }), /not in the store/);
  await assert.rejects(pointSite({ store, site: "s1", manifest: "nope" }), /sha256/);
  await assert.rejects(pointSite({ store, site: "../x", manifest: h1 }), /bad site id/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("access policy: written before the pointer flips, never to a lower version, never for a plain public site", async () => {
  const root = tmp("store-");
  const store = new FsStore(root);
  const dist = tmp("dist-");
  const body = Buffer.from("<html>x</html>");
  const o = crypto.createHash("sha256").update(body).digest("hex");
  fs.mkdirSync(path.join(dist, "objects"));
  fs.writeFileSync(path.join(dist, "objects", o), body);
  fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify({ site: { id: "s1" }, engine: "e", routes: { "/docs-site": { o, s: body.length, t: "text/html" } }, files: {}, redirects: [] }));
  // A plain public site gets no object (no object = public at the edge).
  let res = await publish({ distDir: dist, store, site: "s1", access: { level: "public", policy_version: 0 } });
  assert.equal(await store.getText("sites/s1/access.json"), null);
  assert.deepEqual([res.access.level, res.access.written], ["public", false]);
  // A password site: the policy is there by the time the pointer is.
  const writes = [];
  const spy = Object.assign(Object.create(Object.getPrototypeOf(store)), store, { put: async (k, b) => (writes.push(k), store.put(k, b)) });
  res = await publish({ distDir: dist, store: spy, site: "s1", access: { level: "password", policy_version: 2 } });
  assert.equal(res.unchanged, true); // same manifest: only the policy changed
  assert.deepEqual(writes, ["sites/s1/access.json"]);
  const { site, level, policy_version: v, ...rest } = JSON.parse(await store.getText("sites/s1/access.json"));
  assert.deepEqual([site, level, v, Object.keys(rest)], ["s1", "password", 2, ["updatedAt"]]); // nothing else: no hash, no password
  // A build that carries an older policy (the API changed it meanwhile) keeps the newer one.
  assert.deepEqual(await writeAccess(store, "s1", { level: "public", policy_version: 1 }), { level: "password", policy_version: 2, written: false });
  assert.equal(JSON.parse(await store.getText("sites/s1/access.json")).level, "password");
  assert.equal((await writeAccess(store, "s1", { level: "members", policy_version: 3 })).written, true);
  // First publish of a private site: policy first, then the pointer.
  writes.length = 0;
  await publish({ distDir: dist, store: spy, site: "s2", access: { level: "members", policy_version: 1 } });
  assert.ok(writes.indexOf("sites/s2/access.json") < writes.indexOf("sites/s2/current.json"));
  await assert.rejects(writeAccess(store, "s1", { level: "everyone", policy_version: 1 }), /bad access policy/);
  await assert.rejects(writeAccess(store, "s1", { level: "password" }), /bad access policy/);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dist, { recursive: true, force: true });
});

test("media.json: sizes, posters next to clips, nothing for other files", () => {
  const pub = tmp("public-");
  const d = path.join(pub, "docs-assets/s1");
  fs.mkdirSync(d, { recursive: true });
  // A 1x1 PNG header is enough for the measuring function.
  const png = Buffer.alloc(32);
  png.writeUInt32BE(0x89504e47, 0);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(360, 20);
  fs.writeFileSync(path.join(d, "shot.png"), png);
  fs.writeFileSync(path.join(d, "clip.mp4"), "mp4");
  fs.writeFileSync(path.join(d, "clip.webp"), "RIFF");
  fs.writeFileSync(path.join(d, "notes.pdf"), "%PDF");
  const imageSize = (buf) => (buf.readUInt32BE(0) === 0x89504e47 ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : null);
  const { manifest, problems } = mediaManifest(pub, { imageSize, videoInfo: () => ({ w: 1280, h: 720, duration: 4.2 }) });
  assert.deepEqual(manifest, {
    "/docs-assets/s1/clip.mp4": { w: 1280, h: 720, duration: 4.2, bytes: 3, kind: "clip" },
    "/docs-assets/s1/clip.webp": { bytes: 4, kind: "poster" },
    "/docs-assets/s1/shot.png": { w: 640, h: 360, bytes: 32, kind: "image" },
  });
  assert.deepEqual(problems, ["/docs-assets/s1/clip.webp: couldn't read the image size"]);
  fs.rmSync(pub, { recursive: true, force: true });
});

test("a token minted by the runner is the API's format", async () => {
  const { mintToken } = await import("../runner/run-job.mjs");
  const tok = mintToken("job1", "s3cret", 60);
  const [exp, sig] = tok.split(".");
  assert.ok(Number(exp) > Date.now() / 1000);
  assert.equal(sig, crypto.createHmac("sha256", "s3cret").update(`docs-job:job1:${exp}`).digest("base64url"));
});
