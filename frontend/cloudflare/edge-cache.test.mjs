// Edge-copy rules of the Cloudflare Worker. Run: node --test cloudflare/edge-cache.test.mjs (Node >= 22.18 strips types)
import test from "node:test";
import assert from "node:assert/strict";
import { ISR_TTL, NOT_FOUND_TTL, STATIC_TTL, bypassReason, edgeCopy, edgeKey, edgeTtl, fromCopy, purgeKeys } from "./edge-cache.ts";

const H = (o = {}) => new Headers(o);
const u = (s) => new URL(s);

test("only anonymous GETs of pages may use the edge cache", () => {
  assert.equal(bypassReason("GET", H(), u("https://www.markdrop.in/")), null);
  assert.equal(bypassReason("GET", H({ cookie: "ph_x=1; _ga=2" }), u("https://www.markdrop.in/")), null);
  assert.equal(bypassReason("HEAD", H(), u("https://www.markdrop.in/")), "method");
  assert.equal(bypassReason("POST", H(), u("https://www.markdrop.in/api/revalidate")), "method");
  assert.equal(bypassReason("GET", H({ authorization: "Bearer x" }), u("https://www.markdrop.in/")), "auth");
  assert.equal(bypassReason("GET", H({ cookie: "a=1; md_si=1" }), u("https://www.markdrop.in/")), "signed-in");
  assert.equal(bypassReason("GET", H({ cookie: "md_si=1" }), u("https://www.markdrop.in/abc")), "signed-in");
  for (const h of ["rsc", "next-router-prefetch", "next-router-state-tree", "next-router-segment-prefetch", "next-url"]) {
    assert.equal(bypassReason("GET", H({ [h]: "1" }), u("https://www.markdrop.in/abc")), "rsc", h);
  }
  assert.equal(bypassReason("GET", H(), u("https://www.markdrop.in/abc?_rsc=x1")), "rsc");
  assert.equal(bypassReason("GET", H(), u("https://www.markdrop.in/api/geo")), "route");
  assert.equal(bypassReason("GET", H(), u("https://www.markdrop.in/_next/data/x.json")), "route");
});

test("keys: per deployment, host and flavour; tracking parameters ignored, others kept in order", () => {
  const k = (url, accept = "text/html", v = "v1", origin = new URL(url).origin) => edgeKey(origin, u(url), accept, v).url;
  assert.equal(k("https://www.markdrop.in/abc?utm_source=x&fbclid=1"), k("https://www.markdrop.in/abc"));
  assert.equal(k("https://www.markdrop.in/abc?b=2&a=1"), k("https://www.markdrop.in/abc?a=1&b=2"));
  assert.notEqual(k("https://www.markdrop.in/abc?a=1"), k("https://www.markdrop.in/abc"));
  assert.notEqual(k("https://www.markdrop.in/abc", "text/markdown"), k("https://www.markdrop.in/abc"));
  assert.notEqual(k("https://www.markdrop.in/abc", "text/html", "v2"), k("https://www.markdrop.in/abc"));
  // the test header picks the host Next sees: the key stays on the request's own origin, the host goes in the key
  const t = k("https://docs.markdrop.in/x", "text/html", "v1", "https://next.markdrop.in");
  assert.ok(t.startsWith("https://next.markdrop.in/x?"));
  assert.match(decodeURIComponent(t), /__edge=v1\|docs\.markdrop\.in\|html/);
  assert.notEqual(t, k("https://next.markdrop.in/x"));
});

test("lifetimes: docs + prerendered for the deployment, ISR briefly, 404s a minute, never cookies or private", () => {
  const ttl = (status, h, docs = false) => edgeTtl(status, H(h), docs);
  assert.equal(ttl(200, { "cache-control": "s-maxage=31536000, stale-while-revalidate=2592000" }), STATIC_TTL);
  assert.equal(ttl(200, { "cache-control": "s-maxage=60, stale-while-revalidate=31535940" }), ISR_TTL);
  assert.equal(ttl(200, { "cache-control": "s-maxage=5, stale-while-revalidate=2592000" }), 5);
  assert.equal(ttl(200, { "cache-control": "s-maxage=0" }), 0);
  assert.equal(ttl(200, { "cache-control": "public, max-age=0, must-revalidate" }), 0);
  assert.equal(ttl(200, { "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate" }), 0);
  assert.equal(ttl(200, { "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate" }, true), 0);
  assert.equal(ttl(200, { "cache-control": "public, max-age=300, s-maxage=3600" }, true), STATIC_TTL);
  assert.equal(ttl(200, { "cache-control": "s-maxage=31536000", "set-cookie": "a=1" }), 0);
  assert.equal(ttl(404, { "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate" }), NOT_FOUND_TTL);
  assert.equal(ttl(404, { "set-cookie": "a=1" }), 0);
  for (const s of [301, 307, 308, 500, 503]) assert.equal(ttl(s, { "cache-control": "s-maxage=31536000" }), 0, String(s));
});

test("copy round trip: Cloudflare gets the TTL, the browser gets max-age=0 + its Vary + the debug header", async () => {
  const res = new Response("<html>hi</html>", {
    status: 200,
    headers: { "cache-control": "s-maxage=31536000", "cdn-cache-control": "s-maxage=31536000", vary: "RSC, Next-Url", "content-type": "text/html" },
  });
  const copy = edgeCopy(res, 900);
  assert.equal(copy.headers.get("cache-control"), "public, s-maxage=900");
  assert.equal(copy.headers.get("cdn-cache-control"), null);
  assert.equal(copy.headers.get("vary"), null);
  assert.equal(await res.text(), "<html>hi</html>", "the original body is still readable");
  const out = fromCopy(copy, false);
  assert.equal(out.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  assert.equal(out.headers.get("vary"), "RSC, Next-Url");
  assert.equal(out.headers.get("x-md-vary"), null);
  assert.equal(out.headers.get("x-md-edge"), "HIT");
  assert.equal(await out.text(), "<html>hi</html>");
  const nf = fromCopy(edgeCopy(new Response("nope", { status: 404 }), 60), true);
  assert.equal(nf.status, 404);
  assert.match(nf.headers.get("cache-control"), /no-store/);
  assert.equal(nf.headers.get("vary"), "Accept");
});

test("a document's revalidation drops both flavours on the app host and the host it arrived on", () => {
  const keys = purgeKeys("abc123", "next.markdrop.in", "v1").map((r) => r.url);
  assert.equal(keys.length, 4);
  const want = (host, accept) => edgeKey(`https://${host}`, u(`https://${host}/abc123`), accept, "v1").url;
  for (const h of ["www.markdrop.in", "next.markdrop.in"]) for (const a of ["text/html", "text/markdown"]) assert.ok(keys.includes(want(h, a)));
  assert.equal(purgeKeys("abc123", "www.markdrop.in", "v1").length, 2);
});
