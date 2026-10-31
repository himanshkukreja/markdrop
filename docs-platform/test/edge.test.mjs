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
    "/docs-assets/page.html": { ...put("<script>alert(document.cookie)</script>"), t: "text/html; charset=utf-8" },
    "/docs-assets/page.xhtml": { ...put("<html xmlns='http://www.w3.org/1999/xhtml'/>"), t: "application/xhtml+xml" },
    "/docs-assets/feed.xml": { ...put("<x/>"), t: "application/xml" },
    "/docs-assets/atom.xml": { ...put("<x/>"), t: "application/atom+xml" },
    "/docs-assets/logo.svg": { ...put("<svg xmlns='http://www.w3.org/2000/svg'/>"), t: "image/svg+xml" },
    "/docs-assets/guide.pdf": { ...put("%PDF-1.7"), t: "application/pdf" },
    "/docs-assets/sneaky.png": { ...put("<html>"), t: "image/png", h: { "content-security-policy": "default-src *", "x-content-type-options": "" } },
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

test("site files: nosniff and a sandboxing CSP; HTML and XML download, SVG stays an image", async () => {
  const csp = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'; sandbox";
  for (const p of ["/docs-assets/a.bin", "/docs-assets/page.html", "/docs-assets/page.xhtml", "/docs-assets/feed.xml", "/docs-assets/atom.xml", "/docs-assets/logo.svg", "/docs-assets/sneaky.png"]) {
    const r = await go(p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff", p);
    assert.equal(r.headers.get("content-security-policy"), csp, p);
  }
  for (const p of ["/docs-assets/page.html", "/docs-assets/page.xhtml", "/docs-assets/feed.xml", "/docs-assets/atom.xml"]) {
    assert.equal((await go(p)).headers.get("content-disposition"), "attachment", p);
  }
  const svg = await go("/docs-assets/logo.svg");
  assert.equal(svg.headers.get("content-type"), "image/svg+xml");
  assert.equal(svg.headers.get("content-disposition"), null);
  assert.equal((await go("/docs-assets/a.bin")).headers.get("content-disposition"), null);
  // Range, HEAD and 304 answers carry them too.
  assert.equal((await go("/docs-assets/page.html", { range: "bytes=0-1" })).headers.get("content-disposition"), "attachment");
  assert.equal((await go("/docs-assets/page.html", {}, "HEAD")).headers.get("content-security-policy"), csp);
  const etag = svg.headers.get("etag");
  assert.equal((await go("/docs-assets/logo.svg", { "if-none-match": etag })).headers.get("content-security-policy"), csp);
  // A PDF: nosniff, no CSP (Chrome's viewer refuses a sandboxed PDF).
  const pdf = await go("/docs-assets/guide.pdf");
  assert.equal(pdf.headers.get("x-content-type-options"), "nosniff");
  assert.equal(pdf.headers.get("content-security-policy"), null);
  // A missing site file, and framework chunks (the engine's own code) are left alone.
  assert.equal((await go("/docs-assets/missing.svg")).headers.get("x-content-type-options"), "nosniff");
  assert.equal((await go("/_next/static/chunks/x.js")).headers.get("content-security-policy"), null);
});

test("redirects, 404s, unknown hosts", async () => {
  const r = await go("/old-start?x=1");
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("location"), "/guide/start?x=1");
  const nf = await go("/nope");
  assert.equal(nf.status, 404);
  assert.equal(await nf.text(), "<html>404</html>");
  // A missing site file: the engine's plain 404, not the docs (or app) 404 page.
  const nfa = await go("/docs-assets/missing.png");
  assert.equal(nfa.status, 404);
  assert.equal(nfa.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await nfa.text(), "Not found");
  const other = await edge.fetch(new Request("https://elsewhere.test/"), {});
  assert.equal(other.status, 404);
  assert.equal((await go("/guide/start", {}, "POST")).status, 405);
});

test("search indexing off (manifest site.noindex): every response carries X-Robots-Tag noindex", async () => {
  const hidden = { ...manifest, site: { ...manifest.site, id: "quiet", noindex: true } };
  const qhash = "q".repeat(64);
  texts.set("hosts/quiet.acme.test.json", JSON.stringify({ site: "quiet" }));
  texts.set("sites/quiet/current.json", JSON.stringify({ manifest: qhash }));
  texts.set(`manifests/${qhash}.json`, JSON.stringify(hidden));
  const q = (path) => edge.fetch(new Request(`https://quiet.acme.test${path}`), { waitUntil() {} });
  for (const p of ["/guide/start", "/", "/llms.txt", "/docs-assets/a.bin", "/nope", "/old-start"]) {
    assert.equal((await q(p)).headers.get("x-robots-tag"), "noindex", p);
  }
  const page = await q("/guide/start");
  assert.equal(await page.text(), "<html>start</html>");
  assert.equal(page.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  assert.equal((await q("/old-start")).status, 301);
  // Indexing on (the default): no header.
  assert.equal((await go("/guide/start")).headers.get("x-robots-tag"), null);
});
