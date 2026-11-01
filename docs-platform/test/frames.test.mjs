/**
 * What a published page may frame (manifest site.frames → the edge's frame-src): Markdrop's
 * artifact origin, where `::markdrop` blocks render author HTML in an opaque sandbox, and the
 * site's embed hosts. Nothing else; site files keep their own sandboxing CSP.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createHandler, pageCsp } from "../edge/dist/handler.mjs";
import { frameOrigins, manifestSite } from "../builder/build.mjs";

test("frameOrigins: the artifact origin (site.json markdrop.files, else production's) and embed hosts", () => {
  assert.deepEqual(frameOrigins({}), ["https://markdrop-artifacts.markdrop-in.workers.dev"]);
  assert.deepEqual(frameOrigins({ markdrop: { files: "http://127.0.0.1:8797" }, embedHosts: ["www.youtube.com", "Player.Vimeo.com", "bad host", "x.com/evil", 5] }), [
    "http://127.0.0.1:8797",
    "https://player.vimeo.com",
    "https://www.youtube.com",
  ]);
  // A non-loopback http origin, or a script URL, never becomes a frame source.
  assert.deepEqual(frameOrigins({ markdrop: { files: "http://evil.example" } }), ["https://markdrop-artifacts.markdrop-in.workers.dev"]);
  assert.deepEqual(frameOrigins({ markdrop: { files: "javascript:alert(1)" } }), ["https://markdrop-artifacts.markdrop-in.workers.dev"]);
  assert.deepEqual(manifestSite({ id: "a", name: "A", url: "https://a.test" }).frames, ["https://markdrop-artifacts.markdrop-in.workers.dev"]);
});

test("pageCsp: frame-src from the manifest, plugins off; none for an older manifest", () => {
  assert.equal(pageCsp({ frames: ["https://markdrop-artifacts.markdrop-in.workers.dev"] }), "frame-src 'self' https://markdrop-artifacts.markdrop-in.workers.dev; object-src 'none'");
  assert.equal(pageCsp({ frames: ["https://a.test; script-src *", "https://ok.test"] }), "frame-src 'self' https://ok.test; object-src 'none'");
  assert.equal(pageCsp({}), null);
});

const enc = new TextEncoder();
const objects = new Map();
const put = (text) => {
  const body = enc.encode(text);
  const o = crypto.createHash("sha256").update(body).digest("hex");
  objects.set(o, body);
  return { o, s: body.length };
};

test("the edge: pages carry the frame policy, Markdown twins and site files don't", async () => {
  const manifest = {
    format: "markdrop-docs/1",
    site: { id: "acme", name: "Acme", url: "https://docs.acme.test", frames: ["https://markdrop-artifacts.markdrop-in.workers.dev"] },
    routes: {
      "/docs-site/guide/start": { ...put("<html>start</html>"), t: "text/html; charset=utf-8", rsc: put("0:rsc") },
      "/docs-site/md/guide/start": { ...put("# Start"), t: "text/markdown; charset=utf-8" },
    },
    notFound: { ...put("<html>404</html>"), t: "text/html; charset=utf-8" },
    files: { "/docs-assets/page.html": { ...put("<p>x</p>"), t: "text/html; charset=utf-8" } },
    redirects: [],
    mcp: put(JSON.stringify({ files: {} })),
  };
  const h = "f".repeat(64);
  const texts = new Map([
    ["hosts/docs.acme.test.json", JSON.stringify({ site: "acme" })],
    ["sites/acme/current.json", JSON.stringify({ manifest: h })],
    [`manifests/${h}.json`, JSON.stringify(manifest)],
  ]);
  const edge = createHandler({
    async getText(k) {
      return texts.get(k) ?? null;
    },
    async getObject(o) {
      const b = objects.get(o);
      return b ? { body: b, size: b.length } : null;
    },
  });
  const go = (p, headers = {}) => edge.fetch(new Request(`https://docs.acme.test${p}`, { headers }), { waitUntil() {} });
  const page = await go("/guide/start");
  assert.equal(page.headers.get("content-security-policy"), "frame-src 'self' https://markdrop-artifacts.markdrop-in.workers.dev; object-src 'none'");
  assert.equal((await go("/guide/start.md")).headers.get("content-security-policy"), null);
  assert.match((await go("/docs-assets/page.html")).headers.get("content-security-policy"), /sandbox/);
});
