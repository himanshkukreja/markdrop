/**
 * The artifact Worker's isolation headers (src/index.js), with an in-memory R2:
 *   node --test worker/test/worker.test.mjs
 *
 * - A docs page frames author HTML with `?sb=1`: the response carries the sandbox as a CSP header
 *   (no allow-same-origin, no top navigation), so the file runs in an opaque origin even if it is
 *   framed without the iframe attribute or opened on its own.
 * - Everywhere else (markdrop.in's own viewer, a link opened on its own) author HTML / SVG carries
 *   the same opaque sandbox (plus allow-popups-to-escape-sandbox): no file ever runs with this
 *   shared origin, so none can reach another's storage, cookies or windows. An HTML page load gets
 *   an in-memory localStorage / sessionStorage / cookie stand-in before its first script.
 * - A viewer page opened as a page of its own is sandboxed too; the sheet and Word viewers sanitise
 *   what their parsers produce.
 * - Public bytes answer CORS `*` without credentials (an opaque-origin page's own module scripts
 *   and fetches); guarded bytes answer the app's origins and opaque ones (`null`, Markdrop's
 *   sandboxed viewer frames), and still need a token.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
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
      return { size: new TextEncoder().encode(o.body).length, httpEtag: '"e"', httpMetadata: { contentType: o.type }, customMetadata: o.meta ?? {} };
    },
    async get(key, opts = {}) {
      const o = objects[key];
      if (!o) return null;
      const bytes = new TextEncoder().encode(o.body);
      if (opts.range) return { body: new Blob([bytes.subarray(opts.range.offset, opts.range.offset + opts.range.length)]).stream() };
      // `chunk` splits the body into pieces of that many bytes (a stream's chunk boundaries).
      if (!o.chunk) return { body: new Blob([bytes]).stream() };
      const parts = [];
      for (let i = 0; i < bytes.length; i += o.chunk) parts.push(bytes.slice(i, i + o.chunk));
      return {
        body: new ReadableStream({
          pull(c) {
            if (parts.length) c.enqueue(parts.shift());
            else c.close();
          },
        }),
      };
    },
  };
}

/** An HTML page with a doctype and charset ahead of its first script (served in 7-byte chunks). */
const APP = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>App</title><SCRIPT>localStorage.x=1</SCRIPT></head><body></body></html>';
const SHIM_RE = /<script>\(function\(\)\{var w=window;.*?<\/script>/s;

const env = {
  ARTIFACT_SIGNING_KEY: "k",
  ARTIFACTS: bucket({
    "art/u1/page.html": { type: "text/html", body: "<script>localStorage.x=1</script>", meta: { public: "1" } },
    "art/u1/app.js": { type: "text/javascript", body: "export default 1", meta: { public: "1" } },
    "art/u1/doc.pdf": { type: "application/pdf", body: "%PDF-1.7", meta: { public: "1" } },
    "art/u2/secret.html": { type: "text/html", body: "<p>secret</p>", meta: {} },
    "art/u2/secret.pdf": { type: "application/pdf", body: "%PDF-1.7 secret", meta: {} },
    "art/u3/app.html": { type: "text/html", body: APP, meta: { public: "1" }, chunk: 7 },
    "art/u3/plain.html": { type: "text/html", body: "<!doctype html><p>No script here</p>", meta: { public: "1" } },
    "art/u3/pic.svg": { type: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>", meta: { public: "1" } },
  }),
};

const get = (p, headers = {}) => worker.fetch(new Request(ORIGIN + p, { headers }), env);

/** A token the way the API signs one (HS256 over {k, exp}) with the test key. */
async function sign(claims, key = "k") {
  const b64 = (b) => Buffer.from(b).toString("base64url");
  const data = `${b64(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64(JSON.stringify(claims))}`;
  const ck = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${data}.${b64(new Uint8Array(await crypto.subtle.sign("HMAC", ck, new TextEncoder().encode(data))))}`;
}

test("framed by a docs page (?sb=1): author HTML carries the sandbox as a CSP header", async () => {
  const r = await get("/r/art/u1/page.html?sb=1", { "sec-fetch-dest": "iframe" });
  assert.equal(r.status, 200);
  const csp = r.headers.get("content-security-policy");
  assert.equal(csp, "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads");
  for (const never of ["allow-same-origin", "allow-top-navigation", "allow-popups-to-escape-sandbox"]) assert.ok(!csp.includes(never), never);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
});

test("everywhere else, author HTML and SVG still never run with this origin", async () => {
  for (const [p, h] of [
    ["/r/art/u1/page.html", { "sec-fetch-dest": "iframe" }], // markdrop.in's own viewer
    ["/r/art/u1/page.html", { "sec-fetch-dest": "document" }], // opened on its own
    ["/r/art/u1/page.html", {}], // a fetch
    ["/r/art/u3/pic.svg", { "sec-fetch-dest": "iframe" }],
  ]) {
    const csp = (await get(p, h)).headers.get("content-security-policy");
    assert.equal(csp, "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox", p);
    for (const never of ["allow-same-origin", "allow-top-navigation"]) assert.ok(!csp.includes(never), never);
  }
  // Not author markup: no CSP (a PDF must stay viewable by the browser's own viewer).
  assert.equal((await get("/r/art/u1/doc.pdf")).headers.get("content-security-policy"), null);
});

test("an HTML page load gets the storage stand-in before its first script; anything else gets the file", async () => {
  const page = await get("/r/art/u3/app.html", { "sec-fetch-dest": "iframe" });
  const html = await page.text();
  const at = html.search(SHIM_RE);
  assert.ok(at > 0, "shim inserted");
  // Doctype and charset keep their place; the shim sits right before the page's own first script
  // (found across the 7-byte chunk boundaries, in upper case).
  assert.equal(html.slice(0, at), '<!DOCTYPE html><html><head><meta charset="utf-8"><title>App</title>');
  assert.ok(html.slice(at).replace(SHIM_RE, "").startsWith("<SCRIPT>localStorage.x=1</SCRIPT>"));
  assert.equal(html.replace(SHIM_RE, ""), APP);
  assert.equal(page.headers.get("content-length"), null);
  assert.equal(page.headers.get("etag"), '"e-s"');
  assert.match(page.headers.get("vary"), /Sec-Fetch-Dest/);
  // A navigation without fetch metadata (Accept: text/html) is a page too.
  assert.match(await (await get("/r/art/u3/app.html", { accept: "text/html" })).text(), SHIM_RE);

  // The app's download fetch, a range, a download link: the stored bytes, exactly.
  for (const h of [{}, { "sec-fetch-dest": "empty" }]) {
    const r = await get("/r/art/u3/app.html", h);
    assert.equal(await r.text(), APP);
    assert.equal(r.headers.get("etag"), '"e"');
    assert.match(r.headers.get("vary"), /Sec-Fetch-Dest/);
  }
  assert.equal(await (await get("/r/art/u3/app.html", { "sec-fetch-dest": "iframe", range: "bytes=0-14" })).text(), "<!DOCTYPE html>");
  const dl = await get("/r/art/u3/app.html?dl=1&fn=app.html", { "sec-fetch-dest": "document" });
  assert.equal(await dl.text(), APP);
  assert.match(dl.headers.get("content-disposition"), /^attachment/);
  // No script tag: nothing to protect, nothing added.
  assert.equal(await (await get("/r/art/u3/plain.html", { "sec-fetch-dest": "iframe" })).text(), "<!doctype html><p>No script here</p>");
});

test("the storage stand-in: in-memory localStorage, sessionStorage and cookies where the real ones throw", async () => {
  const html = await (await get("/r/art/u3/app.html", { "sec-fetch-dest": "iframe" })).text();
  const code = SHIM_RE.exec(html)[0].replace(/^<script>/, "").replace(/<\/script>$/, "");
  const deny = () => {
    throw new Error("SecurityError: The document is sandboxed and lacks the 'allow-same-origin' flag.");
  };
  const window = {};
  Object.defineProperty(window, "localStorage", { configurable: true, get: deny });
  Object.defineProperty(window, "sessionStorage", { configurable: true, get: deny });
  const document = {};
  Object.defineProperty(document, "cookie", { configurable: true, get: deny, set: deny });
  vm.runInNewContext(code, { window, document });
  const ls = window.localStorage;
  ls.setItem("todos", JSON.stringify(["a"]));
  ls.setItem(1, 2);
  assert.equal(ls.getItem("todos"), '["a"]');
  assert.equal(ls.getItem("1"), "2");
  assert.equal(ls.length, 2);
  assert.equal(ls.key(0), "todos");
  assert.equal(ls.key(5), null);
  assert.equal(ls.getItem("missing"), null);
  ls.removeItem("todos");
  assert.equal(ls.length, 1);
  ls.clear();
  assert.equal(ls.length, 0);
  assert.notEqual(window.sessionStorage, ls);
  document.cookie = "theme=dark; path=/";
  document.cookie = "seen=1";
  assert.equal(document.cookie, "theme=dark; seen=1");
  document.cookie = "seen=; max-age=0";
  document.cookie = "theme=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  assert.equal(document.cookie, "");

  // Where the real storage works, it is left alone.
  const real = { localStorage: { length: 0, mine: true }, sessionStorage: { length: 0 } };
  const doc2 = { cookie: "a=1" };
  vm.runInNewContext(code, { window: real, document: doc2 });
  assert.equal(real.localStorage.mine, true);
  assert.equal(doc2.cookie, "a=1");
});

test("public bytes: CORS * without credentials, so an opaque-origin page can load its own modules", async () => {
  const r = await get("/r/art/u1/app.js", { Origin: "null" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.equal(r.headers.get("access-control-allow-credentials"), null);
  assert.match(r.headers.get("access-control-expose-headers"), /accept-ranges/);
  // A script is never rendered as a page.
  assert.equal(r.headers.get("content-disposition"), "attachment");
  // No Origin header (a plain <script>, an <img>): no CORS header needed.
  assert.equal((await get("/r/art/u1/doc.pdf")).headers.get("access-control-allow-origin"), null);
});

test("guarded bytes: still a token; CORS for the app and for opaque origins only", async () => {
  const r = await get("/r/art/u2/secret.html?sb=1", { Origin: "https://acme.guides.markdrop.in" });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  const page = await get("/r/art/u2/secret.html", { "sec-fetch-dest": "iframe" });
  assert.equal(page.status, 403);
  assert.doesNotMatch(await page.text(), /secret/);
  // No token from an opaque origin either: still 403.
  assert.equal((await get("/r/art/u2/secret.pdf", { Origin: "null" })).status, 403);

  // With its token: a sandboxed viewer frame (Origin: null) may read it, and see the range headers.
  const t = await sign({ k: "art/u2/secret.pdf", exp: Math.floor(Date.now() / 1000) + 60 });
  const ok = await get(`/r/art/u2/secret.pdf?t=${t}`, { Origin: "null" });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("access-control-allow-origin"), "null");
  assert.equal(ok.headers.get("access-control-allow-credentials"), null);
  assert.match(ok.headers.get("access-control-expose-headers"), /accept-ranges/);
  assert.match(ok.headers.get("vary"), /Origin/);
  assert.equal(ok.headers.get("cache-control"), "private, no-store");
  assert.equal(await ok.text(), "%PDF-1.7 secret");
  // The app, as before; any other site, no CORS.
  assert.equal((await get(`/r/art/u2/secret.pdf?t=${t}`, { Origin: "https://markdrop.in" })).headers.get("access-control-allow-origin"), "https://markdrop.in");
  assert.equal((await get(`/r/art/u2/secret.pdf?t=${t}`, { Origin: "https://evil.example" })).headers.get("access-control-allow-origin"), null);
  // A token for another object is refused.
  assert.equal((await get(`/r/art/u2/secret.html?t=${t}`, { Origin: "null" })).status, 403);
  // Preflight from an opaque origin (a ranged read).
  const pre = await worker.fetch(new Request(ORIGIN + "/r/art/u2/secret.pdf", { method: "OPTIONS", headers: { Origin: "null" } }), env);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "null");
  assert.match(pre.headers.get("access-control-allow-headers"), /range/);
});

test("the PDF viewer page is Markdrop's own and fetches only /r/ on this origin", async () => {
  const r = await get("/v/pdf/art/u1/doc.pdf?theme=dark");
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /\/r\/art\/u1\/doc\.pdf/);
  assert.match(html, /data-theme="dark"/);
});

test("a viewer page opened on its own runs sandboxed; framed, the frame's sandbox applies", async () => {
  for (const v of ["pdf", "sheet", "docx", "text", "video", "audio"]) {
    const top = await get(`/v/${v}/art/u1/doc.pdf`, { "sec-fetch-dest": "document" });
    const csp = top.headers.get("content-security-policy");
    assert.equal(csp, "sandbox allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox", v);
    assert.ok(!csp.includes("allow-same-origin"));
    assert.match(top.headers.get("vary"), /Sec-Fetch-Dest/);
    assert.equal((await get(`/v/${v}/art/u1/doc.pdf`, { "sec-fetch-dest": "iframe" })).headers.get("content-security-policy"), null, v);
  }
});

test("the sheet and Word viewers sanitise what their parsers build", async () => {
  const sheet = await (await get("/v/sheet/art/u1/doc.pdf")).text();
  const docx = await (await get("/v/docx/art/u1/doc.pdf")).text();
  for (const html of [sheet, docx]) {
    assert.match(html, /function safeFragment\(html\)/);
    assert.doesNotMatch(html, /innerHTML = (XLSX|value)/);
  }
  assert.match(sheet, /holder\.appendChild\(safeFragment\(XLSX\.utils\.sheet_to_html/);
  assert.match(docx, /out\.replaceChildren\(safeFragment\(value\)\)/);
});
