/**
 * Password and members-only sites at the edge (edge/access.mjs + handler.mjs): every route type is
 * gated, the sign-in grant and the session cookie can't be forged, replayed elsewhere or outlive a
 * policy change, and no policy object is ever served. Run `node builder/cli.mjs bundle` first (npm test).
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createHandler } from "../edge/dist/handler.mjs";
import {
  GRANT_PURPOSE, SESSION_COOKIE, SESSION_PURPOSE, STATE_COOKIE, parsePolicy, readToken, safeNext, signToken, stateHash,
} from "../edge/access.mjs";

const SECRET = "edge-test-secret-0123456789abcdef-0123456789";
const API = "https://api.example.test";
const APP = "https://app.example.test";
const HOST = "docs.acme.test";
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
  site: { id: "acme", name: "Acme <Docs>", url: `https://${HOST}`, brand: { logo: { light: "/docs-assets/logo.svg", alt: "Acme" }, accent: "#ff0000", favicon: "/docs-assets/logo.svg" } },
  routes: {
    "/docs-site": { ...put("<html>home SECRET-CONTENT</html>"), t: "text/html; charset=utf-8", rsc: put("0:home-rsc") },
    "/docs-site/guide/start": { ...put("<html>start SECRET-CONTENT</html>"), t: "text/html; charset=utf-8", rsc: put("0:start-rsc") },
    "/docs-site/md/guide/start": { ...put("# Start SECRET-CONTENT"), t: "text/markdown; charset=utf-8" },
    "/docs-site/llms.txt": { ...put("llms SECRET-CONTENT"), t: "text/plain; charset=utf-8", h: { "cache-control": "public, max-age=300" } },
    "/docs-site/search-index.json": { ...put('{"SECRET-CONTENT":1}'), t: "application/json" },
    "/docs-site/og/guide/start": { ...put("PNG SECRET-CONTENT"), t: "image/png" },
  },
  notFound: { ...put("<html>404</html>"), t: "text/html; charset=utf-8" },
  files: {
    "/docs-assets/logo.svg": { ...put("<svg>logo</svg>"), t: "image/svg+xml" },
    "/docs-assets/secret.png": { ...put("SECRET-CONTENT png"), t: "image/png" },
    "/_next/static/chunks/x.js": { ...put("js"), t: "application/javascript; charset=utf-8", immutable: true },
    "/_next/static/BUILD/_buildManifest.js": { ...put("self.__BUILD_MANIFEST SECRET-CONTENT"), t: "application/javascript; charset=utf-8" },
  },
  redirects: [{ from: "/old-start", to: "/guide/start", status: 301 }],
  mcp: put(JSON.stringify({ files: {} })),
};
const mhash = "a".repeat(64);
const texts = new Map([
  [`hosts/${HOST}.json`, JSON.stringify({ site: "acme" })],
  ["sites/acme/current.json", JSON.stringify({ manifest: mhash })],
  [`manifests/${mhash}.json`, JSON.stringify(manifest)],
]);
const setPolicy = (level, v) => (level === null ? texts.delete("sites/acme/access.json") : texts.set("sites/acme/access.json", JSON.stringify({ site: "acme", level, policy_version: v })));
const cacheFlags = [];
const store = {
  async getText(k) {
    return texts.get(k) ?? null;
  },
  async getObject(h, range, _ctx, opts) {
    cacheFlags.push(opts?.cache);
    const b = objects.get(h);
    if (!b) return null;
    return { body: range ? b.slice(range.offset, range.offset + range.length) : b, size: b.length };
  },
};
const opts = { pointerTtlMs: -1, access: { secret: SECRET, apiOrigin: API, appOrigin: APP } };
const edge = createHandler(store, opts);
const go = (path, headers = {}, method = "GET", body, h = edge) =>
  h.fetch(new Request(`https://${HOST}${path}`, { method, headers, body }), { waitUntil() {} });
const page = (path, extra = {}) => go(path, { accept: "text/html,application/xhtml+xml", "sec-fetch-dest": "document", ...extra });

/** A grant as the API mints it (backend/app/services/docs_site_access.mint_grant). */
async function grant(over = {}, secret = SECRET) {
  return signToken(secret, GRANT_PURPOSE, { s: "acme", h: HOST, k: "password", v: 1, sh: over.state ? await stateHash(over.state) : "", exp: Math.floor(Date.now() / 1000) + 120, n: "x", ...over, state: undefined });
}
const cookieOf = (res, name) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
const valueOf = (c) => c.split(";")[0].split("=").slice(1).join("=");

/** The whole sign-in: the gate's state cookie → a grant → /_access/session → the session cookie. */
async function signIn(grantOver = {}) {
  const gate = await page("/guide/start");
  const state = valueOf(cookieOf(gate, STATE_COOKIE));
  const g = await grant({ state, ...grantOver });
  const res = await go("/_access/session", { cookie: `${STATE_COOKIE}=${state}`, "content-type": "application/x-www-form-urlencoded", origin: `https://${HOST}` }, "POST", new URLSearchParams({ g, next: "/guide/start" }).toString());
  return { res, state };
}

test("a site with no policy object is public: nothing changes", async () => {
  setPolicy(null);
  const r = await page("/guide/start");
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "<html>start SECRET-CONTENT</html>");
  assert.equal(r.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  assert.equal(r.headers.get("x-robots-tag"), null);
  // /_access/* is just a path on a public site; policy objects are never served.
  assert.equal((await page("/_access/callback")).status, 404);
  for (const k of ["/sites/acme/access.json", "/sites/acme/current.json", `/manifests/${mhash}.json`, `/hosts/${HOST}.json`]) assert.equal((await go(k)).status, 404, k);
});

test("a password site gates every route type", async () => {
  setPolicy("password", 1);
  const cases = [
    ["/", {}], ["/guide/start", {}], ["/guide/start.md", {}], ["/guide/start", { accept: "text/markdown" }],
    ["/guide/start", { rsc: "1", accept: "*/*" }], ["/guide/start", { rsc: "1", "next-router-prefetch": "1" }],
    ["/llms.txt", {}], ["/search-index.json", {}], ["/og/guide/start", {}], ["/docs-assets/secret.png", {}],
    ["/_next/static/chunks/x.js", {}], ["/_next/static/BUILD/_buildManifest.js", {}], ["/old-start", {}], ["/nope", {}],
    ["/api/geo", {}], ["/sites/acme/access.json", {}], [`/manifests/${mhash}.json`, {}],
  ];
  for (const [path, headers] of cases) {
    for (const method of ["GET", "HEAD"]) {
      const r = await go(path, headers, method);
      assert.equal(r.status, 401, `${method} ${path}`);
      assert.equal(r.headers.get("cache-control"), "private, no-store", path);
      assert.match(r.headers.get("x-robots-tag"), /noindex/, path);
      if (method === "GET") assert.doesNotMatch(await r.text(), /SECRET-CONTENT|password_hash/, path);
    }
  }
  for (const method of ["POST", "GET", "DELETE", "OPTIONS"]) {
    const r = await go("/mcp", { "content-type": "application/json", accept: "application/json, text/event-stream" }, method, method === "POST" ? '{"jsonrpc":"2.0","id":1,"method":"initialize"}' : undefined);
    assert.equal(r.status, 401, `${method} /mcp`);
  }
  // A browser navigation gets the branded sign-in page, nothing else.
  const g = await page("/guide/start?tab=2");
  assert.equal(g.status, 401);
  const html = await g.text();
  assert.doesNotMatch(html, /SECRET-CONTENT/);
  assert.match(html, /Acme &lt;Docs&gt; is password protected/);
  assert.match(html, new RegExp(`action="${API}/api/v1/docs-access/password\\?site=acme"`));
  assert.match(html, new RegExp(`name="host" value="${HOST}"`));
  assert.match(html, /name="next" value="\/guide\/start\?tab=2"/);
  assert.match(html, /--accent:#ff0000/);
  assert.match(html, /<img src="\/docs-assets\/logo.svg" alt="Acme">/);
  assert.match(g.headers.get("content-security-policy"), new RegExp(`form-action 'self' ${API}`));
  const sc = cookieOf(g, STATE_COOKIE);
  assert.match(sc, /^__Host-docs_state=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=1800; HttpOnly; Secure; SameSite=Lax$/);
  // The form carries the state's hash, never the state.
  assert.ok(html.includes(`name="sh" value="${await stateHash(valueOf(sc))}"`));
  assert.ok(!html.includes(valueOf(sc)));
  // The sign-in page's own logo is readable; robots are told to stay out.
  assert.equal((await go("/docs-assets/logo.svg")).status, 200);
  const robots = await go("/robots.txt");
  assert.equal(await robots.text(), "User-agent: *\nDisallow: /\n");
});

test("members-only: the sign-in page sends the reader to markdrop.in with the state hash", async () => {
  setPolicy("members", 2);
  const g = await page("/guide/start");
  const html = await g.text();
  assert.match(html, /Sign in with Markdrop/);
  const href = /href="([^"]+auth\/docs-access[^"]+)"/.exec(html)[1].replace(/&amp;/g, "&");
  const u = new URL(href);
  assert.equal(u.origin, APP);
  assert.equal(u.searchParams.get("site"), "acme");
  assert.equal(u.searchParams.get("host"), HOST);
  assert.equal(u.searchParams.get("next"), "/guide/start");
  assert.equal(u.searchParams.get("sh"), await stateHash(valueOf(cookieOf(g, STATE_COOKIE))));
  assert.doesNotMatch(html, /type="password"/);
});

test("sign-in: a good grant sets a host-only 12-hour session; the site then serves, privately and uncached", async () => {
  setPolicy("password", 1);
  const { res } = await signIn();
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/guide/start");
  const sc = cookieOf(res, SESSION_COOKIE);
  assert.match(sc, /^__Host-docs_access=[^;]+; Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=Lax$/);
  assert.ok(!/Domain=/i.test(sc));
  assert.match(cookieOf(res, STATE_COOKIE), /Max-Age=0/);
  const session = valueOf(sc);
  const payload = await readToken(SECRET, SESSION_PURPOSE, session);
  assert.equal(payload.s, "acme");
  assert.equal(payload.v, 1);
  const withCookie = { cookie: `${SESSION_COOKIE}=${session}` };
  cacheFlags.length = 0;
  for (const [path, headers, want] of [
    ["/guide/start", { accept: "text/html" }, "<html>start SECRET-CONTENT</html>"],
    ["/guide/start", { rsc: "1" }, "0:start-rsc"],
    ["/guide/start.md", {}, "# Start SECRET-CONTENT"],
    ["/llms.txt", {}, "llms SECRET-CONTENT"],
    ["/docs-assets/secret.png", {}, "SECRET-CONTENT png"],
  ]) {
    const r = await go(path, { ...headers, ...withCookie });
    assert.equal(r.status, 200, path);
    assert.equal(await r.text(), want);
    assert.equal(r.headers.get("cache-control"), "private, no-store", path);
    assert.match(r.headers.get("x-robots-tag"), /noindex/);
  }
  assert.ok(cacheFlags.length > 0 && cacheFlags.every((c) => c === false), "no private object goes through the colo cache");
  const mcp = await go("/mcp", { ...withCookie, "content-type": "application/json", accept: "application/json, text/event-stream" }, "POST", '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}');
  assert.equal(mcp.status, 200);
  assert.equal((await go("/old-start", withCookie)).status, 301);
  // Sign out.
  const out = await go("/_access/logout", withCookie);
  assert.equal(out.status, 303);
  assert.match(cookieOf(out, SESSION_COOKIE), /Max-Age=0/);
});

test("grants: forged, tampered, expired, elsewhere, stale, or from another browser are refused", async () => {
  setPolicy("password", 1);
  const gate = await page("/");
  const state = valueOf(cookieOf(gate, STATE_COOKIE));
  const otherState = "B".repeat(43);
  const post = (g, { cookieState = state, origin = `https://${HOST}` } = {}) =>
    go("/_access/session", { cookie: `${STATE_COOKIE}=${cookieState}`, "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) }, "POST", new URLSearchParams({ g, next: "/" }).toString());
  const good = await grant({ state });
  const [body, mac] = good.split(".");
  const tampered = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url")), s: "other" })).toString("base64url")}.${mac}`;
  const cases = {
    forged: await grant({ state }, "another-secret-0123456789abcdef-0123456789"),
    tampered,
    garbage: "not-a-token",
    expired: await grant({ state, exp: Math.floor(Date.now() / 1000) - 1 }),
    tooLong: await grant({ state, exp: Math.floor(Date.now() / 1000) + 86400 }),
    otherSite: await grant({ state, s: "globex" }),
    otherHost: await grant({ state, h: "evil.test" }),
    oldVersion: await grant({ state, v: 0 }),
    otherLevel: await grant({ state, k: "members" }),
    sessionAsGrant: await signToken(SECRET, SESSION_PURPOSE, { s: "acme", h: HOST, k: "password", v: 1, sh: await stateHash(state), exp: Math.floor(Date.now() / 1000) + 60 }),
    otherBrowser: await grant({ state: otherState }),
  };
  for (const [why, g] of Object.entries(cases)) {
    const r = await post(g);
    assert.equal(r.status, 403, why);
    assert.equal(cookieOf(r, SESSION_COOKIE), undefined, why);
    assert.match(await r.text(), /role="alert"/, why);
  }
  // No state cookie at all (a grant URL opened in another browser).
  assert.equal((await go("/_access/session", { "content-type": "application/x-www-form-urlencoded" }, "POST", new URLSearchParams({ g: good }).toString())).status, 403);
  // Cross-site POST.
  assert.equal((await post(good, { origin: "https://evil.test" })).status, 403);
  // The good one works, and only lands on this host.
  const ok = await go("/_access/session", { cookie: `${STATE_COOKIE}=${state}`, "content-type": "application/x-www-form-urlencoded" }, "POST", new URLSearchParams({ g: good, next: "//evil.test/x" }).toString());
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("location"), "/");
});

test("sessions: forged, expired, for another site, or from before a policy change are refused", async () => {
  setPolicy("password", 1);
  const now = Math.floor(Date.now() / 1000);
  const mk = (over = {}, secret = SECRET) => signToken(secret, SESSION_PURPOSE, { s: "acme", v: 1, k: "password", exp: now + 3600, ...over });
  const get = async (value) => (await page("/guide/start", { cookie: `${SESSION_COOKIE}=${value}` })).status;
  assert.equal(await get(await mk()), 200);
  assert.equal(await get(await mk({}, "another-secret-0123456789abcdef-0123456789")), 401);
  assert.equal(await get(await mk({ exp: now - 1 })), 401);
  assert.equal(await get(await mk({ exp: now + 30 * 86400 })), 401);
  assert.equal(await get(await mk({ s: "globex" })), 401);
  assert.equal(await get(await mk({ k: "members" })), 401);
  assert.equal(await get((await mk()).replace(/.$/, "A")), 401);
  assert.equal(await get(await grant({ state: "A".repeat(43) })), 401); // a grant isn't a session
  // A new password (policy_version 2) signs everyone out; so does a new level.
  const { res } = await signIn();
  const session = valueOf(cookieOf(res, SESSION_COOKIE));
  assert.equal(await get(session), 200);
  setPolicy("password", 2);
  assert.equal(await get(session), 401);
  setPolicy("members", 1);
  assert.equal(await get(session), 401);
  setPolicy("public", 3);
  assert.equal(await get("anything"), 200);
});

test("fail closed: no secret, an unknown level, or an unreadable policy never serves the site", async () => {
  setPolicy("password", 1);
  const noSecret = createHandler(store, { pointerTtlMs: -1 });
  const r = await go("/guide/start", { accept: "text/html" }, "GET", undefined, noSecret);
  assert.equal(r.status, 503);
  assert.doesNotMatch(await r.text(), /SECRET-CONTENT/);
  const weak = createHandler(store, { pointerTtlMs: -1, access: { secret: "short" } });
  assert.equal((await go("/llms.txt", {}, "GET", undefined, weak)).status, 503);
  texts.set("sites/acme/access.json", JSON.stringify({ level: "everyone", policy_version: 1 }));
  assert.equal((await page("/guide/start")).status, 503);
  texts.set("sites/acme/access.json", "{not json");
  assert.equal((await page("/guide/start")).status, 503);
  const broken = createHandler({ ...store, async getText(k) { if (k.endsWith("access.json")) throw new Error("R2 down"); return store.getText(k); } }, opts);
  await assert.rejects(go("/guide/start", {}, "GET", undefined, broken));
  assert.deepEqual(parsePolicy(null), { level: "public", version: 0 });
  assert.deepEqual(parsePolicy('{"level":"password","policy_version":-1}'), { level: "locked", version: -1 });
});

test("sign-in pages: the callback hands the fragment over with a nonce'd script; errors show; next stays on the host", async () => {
  setPolicy("password", 1);
  const cb = await go("/_access/callback");
  assert.equal(cb.status, 200);
  const csp = cb.headers.get("content-security-policy");
  const nonce = /'nonce-([^']+)'/.exec(csp)[1];
  const html = await cb.text();
  assert.ok(html.includes(`<script nonce="${nonce}">`));
  assert.match(html, /action="\/_access\/session"/);
  assert.equal(cb.headers.get("referrer-policy"), "same-origin"); // no-referrer makes browsers send Origin: null
  const wrong = await go("/_access/login?e=wrong&next=%2Fguide%2Fstart");
  assert.match(await wrong.text(), /That password isn&#39;t right|That password isn't right/);
  const xss = await go("/_access/login?e=%3Cscript%3E&next=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E");
  const x = await xss.text();
  assert.doesNotMatch(x, /<script>alert/);
  assert.match(x, /name="next" value="\/"/);
  for (const bad of ["//evil.test", "/\\evil.test", "https://evil.test", "evil", "/ok\nSet-Cookie: x", "/_access/session"]) assert.equal(safeNext(bad), "/", bad);
  assert.equal(safeNext("/guide/start?x=1#y"), "/guide/start?x=1#y");
});

test("tokens: the API's format (a grant minted by backend/app/services/docs_site_access.py verifies here)", async () => {
  // Generated with docs_site_access.sign(GRANT_PURPOSE, …) and secret "test-vector-secret-0123456789abcdef-xyz".
  const fromApi = "eyJleHAiOjQxMDI0NDQ4MDAsImgiOiJkb2NzLnZlYy50ZXN0IiwiayI6InBhc3N3b3JkIiwibiI6Im5vbmNlIiwicyI6InZlYyIsInNoIjoiQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSIsInYiOjN9.xboPOF-ynnHc6GpL6yPZC9SgkqbOvJlF4ImDtLFNfYk";
  const p = await readToken("test-vector-secret-0123456789abcdef-xyz", GRANT_PURPOSE, fromApi);
  assert.deepEqual(p, { exp: 4102444800, h: "docs.vec.test", k: "password", n: "nonce", s: "vec", sh: "A".repeat(43), v: 3 });
  assert.equal(await readToken("test-vector-secret-0123456789abcdef-xyz", SESSION_PURPOSE, fromApi), null);
});
