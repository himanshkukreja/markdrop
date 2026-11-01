/**
 * Private pages and sections at the edge (edge/readers.mjs + handler.mjs): a protected page, its RSC
 * payload, .md twin and OG card, a variant with private sections and a private file are served only
 * to readers the page's rule lets in; reader grants and cookies can't be forged, moved to another
 * site or outlive a change; a missing rule locks. Run `node builder/cli.mjs bundle` first (npm test).
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createHandler } from "../edge/dist/handler.mjs";
import { STATE_COOKIE, readToken, signToken, stateHash } from "../edge/access.mjs";
import { AI_TOKEN, READER_COOKIE, READER_GRANT, READER_SESSION, allowed, mergeReader, parseReaders } from "../edge/readers.mjs";

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
const HTML = "text/html; charset=utf-8";

const manifest = {
  format: "markdrop-docs/1",
  site: { id: "acme", name: "Acme Docs", url: `https://${HOST}`, brand: { accent: "#2563eb" } },
  access: { rules: ["members", "northwind", "partners"] },
  routes: {
    "/docs-site": { ...put("<html>home</html>"), t: HTML, rsc: put("0:home") },
    "/docs-site/guides/start": { ...put("<html>start PUBLIC-PLACEHOLDER</html>"), t: HTML, rsc: put("0:start PUBLIC-PLACEHOLDER"), sec: ["northwind", "partners"] },
    "/docs-site/x-access/northwind/guides/start": { ...put("<html>start NW-SECTION</html>"), t: HTML, rsc: put("0:NW-SECTION"), variant: true },
    "/docs-site/x-access/partners/guides/start": { ...put("<html>start PARTNER-SECTION</html>"), t: HTML, rsc: put("0:PARTNER-SECTION"), variant: true },
    "/docs-site/x-access/northwind.partners/guides/start": { ...put("<html>start NW-SECTION PARTNER-SECTION</html>"), t: HTML, rsc: put("0:BOTH"), variant: true },
    "/docs-site/enterprise/sso": { ...put("<html>SSO-SECRET page</html>"), t: HTML, rsc: put("0:SSO-SECRET"), prefetch: put("0:SSO-SECRET-PREFETCH"), a: "northwind" },
    "/docs-site/md/enterprise/sso": { ...put("# SSO-SECRET"), t: "text/markdown; charset=utf-8", a: "northwind" },
    "/docs-site/og/enterprise/sso": { ...put("PNG SSO-SECRET"), t: "image/png", a: "northwind" },
    "/docs-site/partners/pricing": { ...put("<html>PRICING-SECRET</html>"), t: HTML, rsc: put("0:PRICING-SECRET"), a: "partners" },
    "/docs-site/team/runbook": { ...put("<html>RUNBOOK-SECRET</html>"), t: HTML, rsc: put("0:RUNBOOK-SECRET"), a: "members" },
    "/docs-site/ghost/page": { ...put("<html>GHOST-SECRET</html>"), t: HTML, rsc: put("0:GHOST-SECRET"), a: "ghost" },
    "/docs-site/search-index.json": { ...put('[{"href":"/guides/start"}]'), t: "application/json" },
  },
  notFound: { ...put("<html>404</html>"), t: HTML },
  files: {
    "/docs-assets/sso-diagram.png": { ...put("PNG SSO-DIAGRAM"), t: "image/png", a: ["northwind"] },
    "/docs-assets/public.png": { ...put("PNG public"), t: "image/png" },
  },
  redirects: [],
  mcp: put(JSON.stringify({ files: {} })),
};
const mhash = "b".repeat(64);
const texts = new Map([
  [`hosts/${HOST}.json`, JSON.stringify({ site: "acme" })],
  ["sites/acme/current.json", JSON.stringify({ manifest: mhash })],
  [`manifests/${mhash}.json`, JSON.stringify(manifest)],
]);
const RULES = {
  members: { kind: "members", name: "Team members" },
  northwind: { kind: "people", name: "Northwind", emails: ["jane@partner.io"], domains: ["northwind.com"] },
  partners: { kind: "password", name: "Partners", pv: 1 },
};
function setPolicy({ level = "public", v = 0, rv = 0, rules = RULES } = {}) {
  texts.set("sites/acme/access.json", JSON.stringify({ site: "acme", level, policy_version: v, readers: { version: 1, rv, rules } }));
}
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
const edge = createHandler(store, { pointerTtlMs: -1, access: { secret: SECRET, apiOrigin: API, appOrigin: APP } });
const go = (path, headers = {}, method = "GET", body) => edge.fetch(new Request(`https://${HOST}${path}`, { method, headers, body }), { waitUntil() {} });
const page = (path, extra = {}) => go(path, { accept: "text/html,application/xhtml+xml", "sec-fetch-dest": "document", ...extra });
const now = () => Math.floor(Date.now() / 1000);
const cookieOf = (res, name) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
const valueOf = (c) => c.split(";")[0].split("=").slice(1).join("=");

/** A reader grant as the API mints it (backend docs_page_access.mint_reader_grant). */
async function grant(over = {}, secret = SECRET) {
  const { state, ...rest } = over;
  return signToken(secret, READER_GRANT, { s: "acme", h: HOST, rv: 0, ...(state ? { sh: await stateHash(state) } : {}), exp: now() + 120, n: "x", ...rest });
}

/** Lock page → state cookie → grant → /_access/reader → the reader cookie (or the refusal). */
async function signIn(grantOver = {}, { cookie: prior = "", next = "/enterprise/sso" } = {}) {
  const lock = await page(next, prior ? { cookie: prior } : {});
  const state = valueOf(cookieOf(lock, STATE_COOKIE));
  const g = await grant({ state, ...grantOver });
  const res = await go("/_access/reader", {
    cookie: [prior, `${STATE_COOKIE}=${state}`].filter(Boolean).join("; "), "content-type": "application/x-www-form-urlencoded", origin: `https://${HOST}`,
  }, "POST", new URLSearchParams({ g, next }).toString());
  const c = cookieOf(res, READER_COOKIE);
  return { res, cookie: c ? `${READER_COOKIE}=${valueOf(c)}` : "" };
}

test("signed out: protected pages, payloads, twins, cards and files never leave the edge", async () => {
  setPolicy();
  const cases = [
    ["/enterprise/sso", { rsc: "1", accept: "*/*" }], ["/enterprise/sso", { rsc: "1", "next-router-prefetch": "1" }],
    ["/enterprise/sso.md", {}], ["/enterprise/sso", { accept: "text/markdown" }], ["/og/enterprise/sso", {}],
    ["/docs-assets/sso-diagram.png", {}], ["/partners/pricing", { rsc: "1" }], ["/team/runbook", { accept: "*/*" }],
  ];
  for (const [path, headers] of cases) {
    for (const method of ["GET", "HEAD"]) {
      const r = await go(path, headers, method);
      assert.equal(r.status, 401, `${method} ${path} ${JSON.stringify(headers)}`);
      assert.equal(r.headers.get("cache-control"), "private, no-store", path);
      if (method === "GET") assert.doesNotMatch(await r.text(), /SECRET|SSO-DIAGRAM/, path);
    }
  }
  // Public things still are.
  assert.equal((await page("/")).status, 200);
  assert.equal((await go("/docs-assets/public.png")).status, 200);
  assert.equal((await go("/search-index.json")).status, 200);
});

test("the lock page names the way in for each kind, posts only to the API, and keeps no secrets", async () => {
  setPolicy();
  const nw = await page("/enterprise/sso");
  assert.equal(nw.status, 401);
  const body = await nw.text();
  assert.doesNotMatch(body, /SSO-SECRET|jane@partner|northwind\.com/);
  assert.match(body, /Only people at Northwind/);
  assert.ok(body.includes(`action="${API}/api/v1/docs-access/email-link?site=acme"`));
  assert.ok(body.includes(`action="${API}/api/v1/docs-access/request?site=acme"`));
  assert.match(body, /name="next" value="\/enterprise\/sso"/);
  assert.match(nw.headers.get("content-security-policy"), new RegExp(`form-action 'self' ${API.replace(/\./g, "\\.")}`));
  assert.match(cookieOf(nw, STATE_COOKIE), /HttpOnly; Secure; SameSite=Lax/);
  const pw = await (await page("/partners/pricing")).text();
  assert.ok(pw.includes(`${API}/api/v1/docs-access/page-password?site=acme`));
  assert.match(pw, /type="password"/);
  const team = await (await page("/team/runbook")).text();
  assert.ok(team.includes(`${APP}/auth/docs-access?`));
  assert.match(team, /mode=reader/);
});

test("variants are never served at their own address; the public page has the placeholders", async () => {
  setPolicy();
  for (const p of ["/x-access/northwind/guides/start", "/x-access/northwind.partners/guides/start", "/x-access/partners/guides/start.md"]) {
    const r = await page(p);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(await r.text(), /SECTION/, p);
  }
  const r = await page("/guides/start");
  assert.equal(await r.text(), "<html>start PUBLIC-PLACEHOLDER</html>");
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.equal(await (await go("/guides/start", { rsc: "1" })).text(), "0:start PUBLIC-PLACEHOLDER");
});

test("an emailed link: a listed domain opens the customer's page, its sections and its files", async () => {
  setPolicy();
  const { res, cookie } = await signIn({ e: "ana@northwind.com", x: "email", exp: now() + 120 });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/enterprise/sso");
  assert.match(cookieOf(res, READER_COOKIE), /^__Host-docs_reader=[^;]+; Path=\/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax$/);
  const p = await page("/enterprise/sso", { cookie });
  assert.equal(p.status, 200);
  assert.equal(await p.text(), "<html>SSO-SECRET page</html>");
  assert.equal(p.headers.get("cache-control"), "private, no-store");
  assert.equal(await (await go("/enterprise/sso", { cookie, rsc: "1", "next-router-prefetch": "1" })).text(), "0:SSO-SECRET-PREFETCH");
  assert.equal((await go("/enterprise/sso.md", { cookie })).status, 200);
  assert.equal((await go("/docs-assets/sso-diagram.png", { cookie })).status, 200);
  assert.equal(await (await page("/guides/start", { cookie })).text(), "<html>start NW-SECTION</html>");
  assert.equal(await (await go("/guides/start", { cookie, rsc: "1" })).text(), "0:NW-SECTION");
  // Not the partners' page, and not the team's.
  const other = await page("/partners/pricing", { cookie });
  assert.equal(other.status, 401);
  const team = await (await page("/team/runbook", { cookie })).text();
  assert.match(team, /Signed in as <strong>ana@northwind\.com<\/strong>, which can't open this/);
  // A listed address outside the domain works too; another address doesn't.
  assert.equal((await page("/enterprise/sso", { cookie: (await signIn({ e: "jane@partner.io", x: "email" })).cookie })).status, 200);
  assert.equal((await page("/enterprise/sso", { cookie: (await signIn({ e: "eve@northwind.co", x: "email" })).cookie })).status, 401);
});

test("removing a domain or an address closes the page within the policy's lifetime", async () => {
  setPolicy();
  const { cookie } = await signIn({ e: "ana@northwind.com", x: "email" });
  assert.equal((await page("/enterprise/sso", { cookie })).status, 200);
  setPolicy({ rules: { ...RULES, northwind: { ...RULES.northwind, domains: [] } } });
  assert.equal((await page("/enterprise/sso", { cookie })).status, 401);
  assert.equal(await (await page("/guides/start", { cookie })).text(), "<html>start PUBLIC-PLACEHOLDER</html>");
});

test("a page password opens that rule only, until the password changes", async () => {
  setPolicy();
  const { cookie } = await signIn({ pw: [["partners", 1]] }, { next: "/partners/pricing" });
  assert.equal((await page("/partners/pricing", { cookie })).status, 200);
  assert.equal(await (await page("/guides/start", { cookie })).text(), "<html>start PARTNER-SECTION</html>");
  assert.equal((await page("/enterprise/sso", { cookie })).status, 401);
  // Passwords add up with a later identity.
  const both = await signIn({ e: "ana@northwind.com", x: "email" }, { cookie });
  assert.equal(await (await page("/guides/start", { cookie: both.cookie })).text(), "<html>start NW-SECTION PARTNER-SECTION</html>");
  setPolicy({ rules: { ...RULES, partners: { ...RULES.partners, pv: 2 } } });
  assert.equal((await page("/partners/pricing", { cookie })).status, 401);
});

test("a team member opens everything; signing everyone out (rv) ends every reader session", async () => {
  setPolicy();
  const { cookie } = await signIn({ m: true, e: "dev@acme.test" }, { next: "/team/runbook" });
  for (const p of ["/team/runbook", "/enterprise/sso", "/partners/pricing"]) assert.equal((await page(p, { cookie })).status, 200, p);
  setPolicy({ rv: 1 });
  assert.equal((await page("/team/runbook", { cookie })).status, 401);
  // An old grant (rv 0) is refused after the change.
  const late = await signIn({ m: true }, { next: "/team/runbook" });
  assert.equal(late.res.status, 403);
  assert.equal(late.cookie, "");
});

test("fail closed: a rule the policy doesn't have, a missing policy, a bad policy", async () => {
  setPolicy();
  const { cookie } = await signIn({ m: true });
  // Even a member: "ghost" isn't in the policy.
  assert.equal((await page("/ghost/page", { cookie })).status, 401);
  texts.delete("sites/acme/access.json");
  assert.equal((await page("/enterprise/sso", { cookie })).status, 401);
  assert.equal(await (await page("/guides/start")).text(), "<html>start PUBLIC-PLACEHOLDER</html>");
  texts.set("sites/acme/access.json", JSON.stringify({ site: "acme", level: "public", policy_version: 0, readers: { rules: { northwind: { kind: "everyone" } } } }));
  assert.equal((await page("/enterprise/sso", { cookie: (await signIn({ e: "ana@northwind.com", x: "email" })).cookie })).status, 401);
});

test("forged, moved, expired and replayed grants and cookies are refused", async () => {
  setPolicy();
  const bad = [
    [{ e: "ana@northwind.com", x: "email" }, "OTHER-SECRET-0123456789abcdef-0123456789"],
    [{ e: "ana@northwind.com", x: "email", s: "other" }],
    [{ e: "ana@northwind.com", x: "email", h: "evil.test" }],
    [{ e: "ana@northwind.com", x: "email", exp: now() - 1 }],
    [{ e: "ana@northwind.com", x: "email", exp: now() + 600 }], // emailed grants live at most 3 minutes
    [{ e: "ana@northwind.com", state: "A".repeat(43) }], // not this browser's state
  ];
  for (const [over, secret] of bad) {
    const lock = await page("/enterprise/sso");
    const state = valueOf(cookieOf(lock, STATE_COOKIE));
    const g = await grant({ state: over.state === undefined ? undefined : over.state, ...over }, secret || SECRET);
    const res = await go("/_access/reader", { cookie: `${STATE_COOKIE}=${state}`, "content-type": "application/x-www-form-urlencoded", origin: `https://${HOST}` }, "POST", new URLSearchParams({ g, next: "/enterprise/sso" }).toString());
    assert.equal(res.status, 403, JSON.stringify(over));
    assert.equal(cookieOf(res, READER_COOKIE), undefined);
  }
  // Cross-site posts are refused.
  const xs = await go("/_access/reader", { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.test" }, "POST", "g=x");
  assert.equal(xs.status, 403);
  // A cookie signed for another site, or with another purpose, is nobody.
  const forged = await signToken(SECRET, READER_SESSION, { s: "other", rv: 0, m: true, exp: now() + 3600 });
  assert.equal((await page("/team/runbook", { cookie: `${READER_COOKIE}=${forged}` })).status, 401);
  const wrongPurpose = await signToken(SECRET, READER_GRANT, { s: "acme", rv: 0, m: true, exp: now() + 3600 });
  assert.equal((await page("/team/runbook", { cookie: `${READER_COOKIE}=${wrongPurpose}` })).status, 401);
  const tooLong = await signToken(SECRET, READER_SESSION, { s: "acme", rv: 0, m: true, exp: now() + 90 * 86400 });
  assert.equal((await page("/team/runbook", { cookie: `${READER_COOKIE}=${tooLong}` })).status, 401);
});

test("/_access/me tells the page who is reading and hands Ask AI a short token for their rules", async () => {
  setPolicy();
  const out = await (await go("/_access/me")).json();
  assert.deepEqual(out, { signed_in: false, email: null, member: false, rules: [] });
  const { cookie } = await signIn({ e: "ana@northwind.com", x: "email" });
  const me = await go("/_access/me", { cookie });
  assert.equal(me.headers.get("cache-control"), "private, no-store");
  const j = await me.json();
  assert.deepEqual(j.rules, ["northwind"]);
  const t = await readToken(SECRET, AI_TOKEN, j.ai_token);
  assert.deepEqual(t.r, ["northwind"]);
  assert.equal(t.s, "acme");
  assert.ok(t.exp <= now() + 600);
  // /_access/page sends a reader who's already in straight back.
  const back = await go("/_access/page?rule=northwind&next=/guides/start", { cookie });
  assert.equal(back.status, 303);
  assert.equal(back.headers.get("location"), "/guides/start");
  const lock = await page("/_access/page?rule=partners&next=/guides/start");
  assert.equal(lock.status, 200);
  assert.match(await lock.text(), /This section is password protected/);
  // An open redirect is not a way out.
  assert.equal((await go("/_access/page?rule=northwind&next=//evil.test", { cookie })).headers.get("location"), "/");
  // Sign out clears the reader cookie.
  const lo = await go("/_access/logout?next=/guides/start", { cookie });
  assert.equal(lo.status, 303);
  assert.match(cookieOf(lo, READER_COOKIE), /Max-Age=0/);
});

test("a members-only guide: the site gate first, then the page's rule", async () => {
  setPolicy({ level: "members", v: 3 });
  const r = await page("/enterprise/sso");
  assert.equal(r.status, 401);
  assert.match(await r.text(), /Sign in to read Acme Docs/); // the site-wide gate
  const lock = await page("/_access/page?rule=northwind&next=/guides/start");
  assert.equal(lock.status, 200);
});

test("readers.mjs: rule parsing and merging", () => {
  const rs = parseReaders(JSON.stringify({ readers: { rv: 2, rules: { a: { kind: "people", emails: [" X@Y.com "], domains: ["@Acme.com"] }, "B!": { kind: "people" }, c: { kind: "nope" } } } }));
  assert.equal(rs.rv, 2);
  assert.deepEqual([...rs.rules.keys()], ["a"]);
  assert.ok(allowed(rs, { e: "x@y.com", m: false, pw: new Map() }, "a"));
  assert.ok(allowed(rs, { e: "z@acme.com", m: false, pw: new Map() }, "a"));
  assert.ok(!allowed(rs, { e: "z@acme.com.evil", m: false, pw: new Map() }, "a"));
  assert.equal(parseReaders("not json").rules.size, 0);
  const merged = mergeReader({ e: "a@b.c", m: false, pw: new Map([["p", 1]]) }, { e: null, m: false, pw: new Map([["q", 2]]) });
  assert.equal(merged.e, "a@b.c");
  assert.deepEqual([...merged.pw], [["p", 1], ["q", 2]]);
});
