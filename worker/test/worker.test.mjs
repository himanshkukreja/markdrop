/**
 * The artifact Worker's isolation headers (src/index.js), with an in-memory R2:
 *   node --test worker/test/worker.test.mjs
 *
 * - A docs page frames author HTML with `?sb=1`: the response carries the sandbox as a CSP header
 *   (no allow-same-origin, no top navigation), so the file runs in an opaque origin even if it is
 *   framed without the iframe attribute or opened on its own.
 * - Public bytes answer CORS `*` without credentials (an opaque-origin page's own module scripts
 *   and fetches); guarded bytes keep CORS for the app's origins only, and still need a token.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const { default: worker } = await import(pathToFileURL(path.join(here, "..", "src", "index.js")).href);
const ORIGIN = "https://markdrop-artifacts.markdrop-in.workers.dev";

function bucket(objects) {
  return {
    async head(key) {
      const o = objects[key];
      if (!o) return null;
      return { size: o.body.length, httpEtag: '"e"', httpMetadata: { contentType: o.type }, customMetadata: o.meta ?? {} };
    },
    async get(key) {
      const o = objects[key];
      if (!o) return null;
      return { body: new Blob([o.body]).stream() };
    },
  };
}

const env = {
  ARTIFACT_SIGNING_KEY: "k",
  ARTIFACTS: bucket({
    "art/u1/page.html": { type: "text/html", body: "<script>localStorage.x=1</script>", meta: { public: "1" } },
    "art/u1/app.js": { type: "text/javascript", body: "export default 1", meta: { public: "1" } },
    "art/u1/doc.pdf": { type: "application/pdf", body: "%PDF-1.7", meta: { public: "1" } },
    "art/u2/secret.html": { type: "text/html", body: "<p>secret</p>", meta: {} },
  }),
};

const get = (p, headers = {}) => worker.fetch(new Request(ORIGIN + p, { headers }), env);

test("framed by a docs page (?sb=1): author HTML carries the sandbox as a CSP header", async () => {
  const r = await get("/r/art/u1/page.html?sb=1", { "sec-fetch-dest": "iframe" });
  assert.equal(r.status, 200);
  const csp = r.headers.get("content-security-policy");
  assert.equal(csp, "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads");
  for (const never of ["allow-same-origin", "allow-top-navigation", "allow-popups-to-escape-sandbox"]) assert.ok(!csp.includes(never), never);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  // Without ?sb=1 (markdrop.in's own viewer), nothing changes.
  assert.equal((await get("/r/art/u1/page.html")).headers.get("content-security-policy"), null);
});

test("public bytes: CORS * without credentials, so an opaque-origin page can load its own modules", async () => {
  const r = await get("/r/art/u1/app.js", { Origin: "null" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.equal(r.headers.get("access-control-allow-credentials"), null);
  // A script is never rendered as a page.
  assert.equal(r.headers.get("content-disposition"), "attachment");
  // No Origin header (a plain <script>, an <img>): no CORS header needed.
  assert.equal((await get("/r/art/u1/doc.pdf")).headers.get("access-control-allow-origin"), null);
});

test("guarded bytes: still a token, and CORS only for the app", async () => {
  const r = await get("/r/art/u2/secret.html?sb=1", { Origin: "https://acme.guides.markdrop.in" });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  const page = await get("/r/art/u2/secret.html", { "sec-fetch-dest": "iframe" });
  assert.equal(page.status, 403);
  assert.doesNotMatch(await page.text(), /secret/);
});

test("the PDF viewer page is Markdrop's own and fetches only /r/ on this origin", async () => {
  const r = await get("/v/pdf/art/u1/doc.pdf?theme=dark");
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /\/r\/art\/u1\/doc\.pdf/);
  assert.match(html, /data-theme="dark"/);
});
