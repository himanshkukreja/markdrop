/**
 * A guide on its own domain (Cloudflare for SaaS custom hostnames, README "Own domains"): the request
 * reaches this Worker with the customer's hostname, which is mapped like any other address
 * (hosts/<host>.json). The free address keeps working beside it, a host spelled differently is the
 * same host, an unmapped one is a plain 404, and a password site's sign-in is per host (host-only
 * __Host- cookies, grants bound to the host they were minted for). Run `node builder/cli.mjs bundle`
 * first (npm test).
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createHandler } from "../edge/dist/handler.mjs";
import { GRANT_PURPOSE, SESSION_COOKIE, STATE_COOKIE, signToken, stateHash } from "../edge/access.mjs";

const SECRET = "edge-test-secret-0123456789abcdef-0123456789";
const FREE = "acme.guides.markdrop.in";
const OWN = "help.acme.com";
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
  site: { id: "acme", name: "Acme", url: `https://${OWN}` },
  routes: {
    "/docs-site": { ...put("<html>home</html>"), t: "text/html; charset=utf-8", rsc: put("0:home") },
    "/docs-site/guide/start": { ...put("<html>start</html>"), t: "text/html; charset=utf-8", rsc: put("0:start") },
  },
  notFound: { ...put("<html>404</html>"), t: "text/html; charset=utf-8" },
  files: {},
  redirects: [],
  mcp: put(JSON.stringify({ files: {} })),
};
const mhash = "d".repeat(64);
const texts = new Map([
  [`hosts/${FREE}.json`, JSON.stringify({ site: "acme" })],
  [`hosts/${OWN}.json`, JSON.stringify({ site: "acme" })],
  ["sites/acme/current.json", JSON.stringify({ manifest: mhash })],
  [`manifests/${mhash}.json`, JSON.stringify(manifest)],
]);
const store = {
  async getText(k) {
    return texts.get(k) ?? null;
  },
  async getObject(h) {
    const b = objects.get(h);
    return b ? { body: b, size: b.length } : null;
  },
};
const edge = createHandler(store, { pointerTtlMs: -1, hostTtlMs: -1, access: { secret: SECRET, apiOrigin: "https://api.example.test", appOrigin: "https://app.example.test" } });
const at = (url, headers = {}, method = "GET", body) => edge.fetch(new Request(url, { method, headers, body }), { waitUntil() {} });
const cookieOf = (res, name) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
const valueOf = (c) => c.split(";")[0].split("=").slice(1).join("=");
const page = { accept: "text/html", "sec-fetch-dest": "document" };

test("the own domain serves the guide, and so does the free address", async () => {
  texts.delete("sites/acme/access.json");
  for (const url of [`https://${OWN}/guide/start`, `https://${FREE}/guide/start`, "https://HELP.Acme.COM/guide/start", `https://${OWN}.:443/guide/start`, `https://${OWN}:8443/guide/start`]) {
    const r = await at(url);
    assert.equal(r.status, 200, url);
    assert.equal(await r.text(), "<html>start</html>", url);
  }
});

test("an unmapped domain (pending, or removed) is a plain 404, never another guide", async () => {
  const r = await at("https://docs.globex.com/guide/start");
  assert.equal(r.status, 404);
  assert.equal(await r.text(), "No docs site at this address.\n");
  texts.delete(`hosts/${OWN}.json`);
  assert.equal((await at(`https://${OWN}/guide/start`)).status, 404);
  assert.equal((await at(`https://${FREE}/guide/start`)).status, 200);
  texts.set(`hosts/${OWN}.json`, JSON.stringify({ site: "acme" }));
});

test("a password guide: sign-in on the own domain is that host's own (host-only cookie, grant bound to the host)", async () => {
  texts.set("sites/acme/access.json", JSON.stringify({ site: "acme", level: "password", policy_version: 1 }));
  const gate = await at(`https://${OWN}/guide/start`, page);
  assert.equal(gate.status, 401);
  assert.match(await gate.text(), new RegExp(`name="host" value="${OWN.replace(/\./g, "\\.")}"`));
  const stateCookie = cookieOf(gate, STATE_COOKIE);
  assert.match(stateCookie, /^__Host-docs_state=/);
  assert.ok(!/Domain=/i.test(stateCookie));
  const state = valueOf(stateCookie);
  const grant = async (h) => signToken(SECRET, GRANT_PURPOSE, { s: "acme", h, k: "password", v: 1, sh: await stateHash(state), exp: Math.floor(Date.now() / 1000) + 120, n: "x" });
  const post = async (g) => at(`https://${OWN}/_access/session`, { cookie: `${STATE_COOKIE}=${state}`, "content-type": "application/x-www-form-urlencoded", origin: `https://${OWN}` }, "POST", new URLSearchParams({ g, next: "/guide/start" }).toString());
  // A grant minted for the free address doesn't sign in on the own domain.
  assert.equal((await post(await grant(FREE))).status, 403);
  const ok = await post(await grant(OWN));
  assert.equal(ok.status, 303);
  const session = cookieOf(ok, SESSION_COOKIE);
  assert.match(session, /^__Host-docs_access=[^;]+; Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=Lax$/);
  const r = await at(`https://${OWN}/guide/start`, { cookie: `${SESSION_COOKIE}=${valueOf(session)}` });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  texts.delete("sites/acme/access.json");
});
