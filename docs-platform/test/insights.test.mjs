/**
 * The edge's page views for Markdrop Guides Insights (edge/insights.mjs, handler.mjs countView):
 * which requests count, what is sent and where, and that nothing is sent without the manifest's
 * flag, the secret, or with Insights off. npm test (bundles first).
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createHandler } from "../edge/dist/handler.mjs";
import { EDGE_KEY_LABEL, edgeKey, isPageView, viewBody } from "../edge/insights.mjs";

const SECRET = "s".repeat(40);
const SITE = "6650f2c4a1b2c3d4e5f60718";
const enc = new TextEncoder();
const objects = new Map();
const put = (text) => {
  const body = enc.encode(text);
  const o = crypto.createHash("sha256").update(body).digest("hex");
  objects.set(o, body);
  return { o, s: body.length };
};

function manifest(site) {
  return {
    format: "markdrop-docs/1",
    site,
    routes: {
      "/docs-site": { ...put("<html>home</html>"), t: "text/html; charset=utf-8", rsc: put("0:home") },
      "/docs-site/start": { ...put("<html>start</html>"), t: "text/html; charset=utf-8", rsc: put("0:start") },
      "/docs-site/md/start": { ...put("# Start"), t: "text/markdown; charset=utf-8" },
      "/docs-site/llms.txt": { ...put("llms"), t: "text/plain; charset=utf-8" },
    },
    notFound: { ...put("<html>404</html>"), t: "text/html; charset=utf-8" },
    files: { "/docs-assets/a.png": { ...put("png"), t: "image/png" } },
    redirects: [{ from: "/old", to: "/start", status: 301 }],
    mcp: put(JSON.stringify({ files: {} })),
  };
}

const texts = new Map();
function addSite(host, id, site) {
  const h = crypto.createHash("sha256").update(id).digest("hex");
  texts.set(`hosts/${host}.json`, JSON.stringify({ site: id }));
  texts.set(`sites/${id}/current.json`, JSON.stringify({ manifest: h }));
  texts.set(`manifests/${h}.json`, JSON.stringify(manifest(site)));
}
addSite("acme.guides.markdrop.in", SITE, { id: SITE, name: "Acme", url: "https://acme.guides.markdrop.in", insights: true });
addSite("quiet.guides.markdrop.in", "q".repeat(24), { id: "q", name: "Quiet", url: "https://quiet.guides.markdrop.in" });
const store = {
  async getText(k) {
    return texts.get(k) ?? null;
  },
  async getObject(h) {
    const b = objects.get(h);
    return b ? { body: b, size: b.length } : null;
  },
};

function edgeWith(options = {}) {
  const sent = [];
  const pending = [];
  const fetchFn = async (url, init) => {
    sent.push({ url, init, body: JSON.parse(init.body) });
    return new Response(null, { status: 202 });
  };
  const edge = createHandler(store, { access: { secret: SECRET, apiOrigin: "https://api.test" }, fetch: fetchFn, ...options });
  const go = async (path, headers = {}, { host = "acme.guides.markdrop.in", method = "GET", cf } = {}) => {
    const req = new Request(`https://${host}${path}`, { method, headers });
    if (cf) Object.defineProperty(req, "cf", { value: cf });
    const res = await edge.fetch(req, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending.splice(0));
    return res;
  };
  return { sent, go };
}

const BROWSER = { "user-agent": "Mozilla/5.0 Chrome/130", "sec-fetch-dest": "document", "cf-connecting-ip": "203.0.113.7" };

test("the edge key matches the API's derivation (HMAC-SHA256 of the label, hex)", async () => {
  const want = crypto.createHmac("sha256", SECRET).update(EDGE_KEY_LABEL).digest("hex");
  assert.equal(await edgeKey(SECRET), want);
  assert.equal(EDGE_KEY_LABEL, "markdrop-docs-insights/v1"); // backend services/guide_insights.EDGE_KEY_CONTEXT
});

test("a page load is reported once, after the response, with what the API needs", async () => {
  const { sent, go } = edgeWith();
  const res = await go("/start?utm_source=x", { ...BROWSER, referer: "https://www.google.com/search?q=a", dnt: "1" }, { cf: { country: "DE" } });
  assert.equal(await res.text(), "<html>start</html>");
  assert.equal(sent.length, 1);
  const [s] = sent;
  assert.equal(s.url, `https://api.test/api/v1/docs/insights/${SITE}/hit`);
  assert.equal(s.init.headers.authorization, `Bearer ${await edgeKey(SECRET)}`);
  assert.equal(s.init.headers["x-docs-reader-ip"], "203.0.113.7");
  assert.deepEqual(s.body, {
    path: "/start", host: "acme.guides.markdrop.in", ref: "https://www.google.com/search?q=a",
    ua: "Mozilla/5.0 Chrome/130", country: "DE", dnt: true,
  });
  assert.ok(!s.init.body.includes("203.0.113.7")); // the address travels in the header only
  // A revalidation (304) is a view too.
  await go("/", { ...BROWSER, "if-none-match": res.headers.get("etag") });
  await go("/", { ...BROWSER, "if-none-match": `"${"0".repeat(64)}"` });
  assert.equal(sent.length, 3);
});

test("payloads, prefetches, HEAD, Markdown, files, text outputs, redirects and 404s are not views", async () => {
  const { sent, go } = edgeWith();
  await go("/start", { ...BROWSER, rsc: "1" });
  await go("/start", { ...BROWSER, rsc: "1", "next-router-prefetch": "1" });
  await go("/start", { ...BROWSER, "sec-purpose": "prefetch;prerender" });
  await go("/start", { ...BROWSER, purpose: "prefetch" });
  await go("/start", { ...BROWSER, "sec-fetch-dest": "iframe" });
  await go("/start", BROWSER, { method: "HEAD" });
  await go("/start.md", BROWSER);
  await go("/start", { ...BROWSER, accept: "text/markdown" });
  await go("/llms.txt", BROWSER);
  await go("/docs-assets/a.png", BROWSER);
  await go("/old", BROWSER);
  await go("/nope", BROWSER);
  assert.equal(sent.length, 0);
});

test("nothing is sent without the manifest flag, the secret, or with Insights off", async () => {
  let e = edgeWith();
  await e.go("/start", BROWSER, { host: "quiet.guides.markdrop.in" });
  assert.equal(e.sent.length, 0);
  e = edgeWith({ access: { apiOrigin: "https://api.test" } });
  await e.go("/start", BROWSER);
  assert.equal(e.sent.length, 0);
  e = edgeWith({ insights: false });
  await e.go("/start", BROWSER);
  assert.equal(e.sent.length, 0);
});

test("a failing API never breaks the page", async () => {
  const edge = createHandler(store, {
    access: { secret: SECRET, apiOrigin: "https://api.test" },
    fetch: async () => {
      throw new Error("down");
    },
  });
  const pending = [];
  const res = await edge.fetch(new Request("https://acme.guides.markdrop.in/start", { headers: BROWSER }), { waitUntil: (p) => pending.push(p) });
  assert.equal(res.status, 200);
  await Promise.all(pending);
});

test("isPageView and viewBody", () => {
  assert.equal(isPageView(new Request("https://x.test/a")), true); // no Sec-Fetch-Dest: an old browser
  assert.equal(isPageView(new Request("https://x.test/a", { method: "POST" })), false);
  const body = viewBody(new Request("https://X.test/a", { headers: { "sec-gpc": "1" } }), new URL("https://X.test/a"));
  assert.deepEqual(body, { path: "/a", host: "x.test", ref: null, ua: "", country: null, dnt: true });
});
