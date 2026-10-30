/**
 * The edge handler's routing over a tiny in-memory store (no build needed; run `node builder/cli.mjs
 * bundle` first). npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createHandler } from "../edge/dist/handler.mjs";

const enc = new TextEncoder();
const objects = new Map();
const put = (text) => {
  const body = enc.encode(text);
  const o = crypto.createHash("sha256").update(body).digest("hex");
  objects.set(o, body);
  return { o, s: body.length };
};

const manifest = {
  format: "markdrop-docs/1",
  site: { id: "acme", name: "Acme", url: "https://docs.acme.test" },
  routes: {
    "/docs-site": { ...put("<html>home</html>"), t: "text/html; charset=utf-8", rsc: put("0:home-rsc") },
    "/docs-site/guide/start": { ...put("<html>start</html>"), t: "text/html; charset=utf-8", rsc: put("0:start-rsc"), h: { "x-nextjs-stale-time": "300" } },
    "/docs-site/md/index": { ...put("# Home"), t: "text/markdown; charset=utf-8" },
    "/docs-site/md/guide/start": { ...put("# Start"), t: "text/markdown; charset=utf-8" },
    "/docs-site/changelog.md": { ...put("# Changes"), t: "text/markdown; charset=utf-8" },
    "/docs-site/llms.txt": { ...put("llms"), t: "text/plain; charset=utf-8", h: { "cache-control": "public, max-age=300" } },
  },
  notFound: { ...put("<html>404</html>"), t: "text/html; charset=utf-8" },
  files: {
    "/docs-assets/a.bin": { ...put("0123456789"), t: "application/octet-stream" },
    "/_next/static/chunks/x.js": { ...put("js"), t: "application/javascript; charset=utf-8", immutable: true },
  },
  redirects: [{ from: "/old-start", to: "/guide/start", status: 301 }],
  mcp: put(JSON.stringify({ files: {} })),
};
const mhash = "m".repeat(64);
const texts = new Map([
  ["hosts/docs.acme.test.json", JSON.stringify({ site: "acme" })],
  ["sites/acme/current.json", JSON.stringify({ manifest: mhash })],
  [`manifests/${mhash}.json`, JSON.stringify(manifest)],
]);
const store = {
  async getText(k) {
    return texts.get(k) ?? null;
  },
  async getObject(h, range) {
    const b = objects.get(h);
    if (!b) return null;
    return { body: range ? b.slice(range.offset, range.offset + range.length) : b, size: b.length };
  },
};
const edge = createHandler(store);
const go = (path, headers = {}, method = "GET") => edge.fetch(new Request(`https://docs.acme.test${path}`, { method, headers }), { waitUntil() {} });

test("pages, RSC payloads and Markdown twins", async () => {
  assert.equal(await (await go("/guide/start")).text(), "<html>start</html>");
  assert.equal(await (await go("/guide/start/")).text(), "<html>start</html>");
  const rsc = await go("/guide/start", { rsc: "1" });
  assert.equal(rsc.headers.get("content-type"), "text/x-component");
  assert.equal(await rsc.text(), "0:start-rsc");
  assert.equal(await (await go("/guide/start.md")).text(), "# Start");
  assert.equal(await (await go("/guide/start", { accept: "text/markdown" })).text(), "# Start");
  assert.equal(await (await go("/", { accept: "text/markdown" })).text(), "# Home");
  assert.equal(await (await go("/changelog/anything", { accept: "text/markdown" })).text(), "# Changes");
  assert.equal(await (await go("/guide/start", { accept: "text/html, text/markdown;q=0.5" })).text(), "<html>start</html>");
});

test("text outputs keep their cache policy; pages revalidate by ETag", async () => {
  assert.equal((await go("/llms.txt")).headers.get("cache-control"), "public, max-age=300");
  const page = await go("/guide/start");
  assert.equal(page.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  assert.equal((await go("/guide/start", { "if-none-match": page.headers.get("etag") })).status, 304);
});

test("files: chunks immutable, site files with Range", async () => {
  assert.match((await go("/_next/static/chunks/x.js")).headers.get("cache-control"), /immutable/);
  const part = await go("/docs-assets/a.bin", { range: "bytes=2-4" });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 2-4/10");
  assert.equal(await part.text(), "234");
  assert.equal((await go("/docs-assets/a.bin", { range: "bytes=20-" })).status, 416);
  assert.equal((await go("/docs-assets/a.bin", {}, "HEAD")).headers.get("content-length"), "10");
});

test("redirects, 404s, unknown hosts", async () => {
  const r = await go("/old-start?x=1");
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("location"), "/guide/start?x=1");
  const nf = await go("/nope");
  assert.equal(nf.status, 404);
  assert.equal(await nf.text(), "<html>404</html>");
  assert.equal((await go("/docs-assets/missing.png")).status, 404);
  const other = await edge.fetch(new Request("https://elsewhere.test/"), {});
  assert.equal(other.status, 404);
  assert.equal((await go("/guide/start", {}, "POST")).status, 405);
});
