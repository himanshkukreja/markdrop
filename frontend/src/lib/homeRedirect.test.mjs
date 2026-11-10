// Signed in → markdrop.in/ is the dashboard. Run: node --test src/lib/homeRedirect.test.mjs
// (Node >= 22.18 strips the types from homeRedirect.ts; it has no imports.)
import test from "node:test";
import assert from "node:assert/strict";
import {
  HOME_BOOT_SCRIPT, SIGNED_IN_COOKIE, hintCookie, homeRedirect, isAppHomeHost, isPageLoad, tokenExpiry,
} from "./homeRedirect.ts";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.sig`;
const NOW = 1_800_000_000_000;
const NAV = { fetchMode: "navigate", accept: "text/html,application/xhtml+xml,*/*;q=0.8" };

test("the cookie is md_si", () => assert.equal(SIGNED_IN_COOKIE, "md_si"));

test("host matrix × cookie × path", () => {
  const app = ["markdrop.in", "www.markdrop.in", "WWW.Markdrop.in.", "markdrop.in:443", "localhost", "localhost:3450", "127.0.0.1:3000", "markdrop-git-x.vercel.app"];
  const never = ["docs.markdrop.in", "guides.markdrop.in", "guides.localhost:3000", "docs.localhost", "acme.localhost:3450", "docs.acme.com", "acme.guides.markdrop.in", "evilmarkdrop.in", "markdrop.in.evil.com", "", null];
  for (const host of app) assert.ok(isAppHomeHost(host), host);
  for (const host of never) assert.ok(!isAppHomeHost(host), String(host));

  const paths = ["/", "/enterprise", "/privacy", "/guides", "/enterprise", "/dashboard", "/abc123", "/login"];
  for (const host of [...app, ...never]) {
    for (const cookie of ["1", undefined, "", "0", "yes"]) {
      for (const pathname of paths) {
        const got = homeRedirect({ host, method: "GET", pathname, search: "", cookie, ...NAV });
        const want = pathname === "/" && cookie === "1" && isAppHomeHost(host) ? "/dashboard" : null;
        assert.equal(got, want, `${host} ${cookie} ${pathname}`);
      }
    }
  }
});

test("query kept; ?home=1 is the escape hatch; only GET/HEAD page loads", () => {
  const r = (search, method = "GET") => homeRedirect({ host: "www.markdrop.in", method, pathname: "/", search, cookie: "1", ...NAV });
  assert.equal(r("?utm_source=x&utm_medium=y"), "/dashboard?utm_source=x&utm_medium=y");
  assert.equal(r("?home=1"), null);
  assert.equal(r("?utm_source=x&home=1"), null);
  assert.equal(r("?home=0"), "/dashboard?home=0");
  assert.equal(r("", "HEAD"), "/dashboard");
  assert.equal(r("", "POST"), null);
});

test("only page loads redirect, never a router fetch (RSC payload, prefetch)", () => {
  const r = (fetchMode, accept) => homeRedirect({ host: "markdrop.in", method: "GET", pathname: "/", search: "", cookie: "1", fetchMode, accept });
  assert.equal(r("navigate", "text/html"), "/dashboard");
  assert.equal(r("navigate", "*/*"), "/dashboard");
  assert.equal(r(null, "text/html,application/xhtml+xml"), "/dashboard"); // no Sec-Fetch-* (older browsers)
  assert.equal(r("cors", "*/*"), null); // Next's router fetch
  assert.equal(r("cors", "text/html"), null);
  assert.equal(r("no-cors", null), null);
  assert.equal(r(null, "*/*"), null);
  assert.equal(r(null, null), null);
  assert.ok(isPageLoad("navigate", null));
  assert.ok(!isPageLoad("same-origin", "text/html"));
});

test("tokenExpiry", () => {
  assert.equal(tokenExpiry(jwt({ sub: "u", exp: 1234 })), 1234);
  assert.equal(tokenExpiry(jwt({ sub: "u" })), null);
  assert.equal(tokenExpiry("not-a-jwt"), null);
  assert.equal(tokenExpiry("a.%%%.c"), null);
  assert.equal(tokenExpiry(null), null);
});

test("hintCookie: 400 days, bounded by the token, off when expired or cleared", () => {
  assert.equal(hintCookie(true, null, true, NOW), "md_si=1; Max-Age=34560000; Path=/; SameSite=Lax; Secure");
  assert.equal(hintCookie(true, null, false, NOW), "md_si=1; Max-Age=34560000; Path=/; SameSite=Lax");
  assert.equal(hintCookie(true, NOW / 1000 + 7200, true, NOW), "md_si=1; Max-Age=7200; Path=/; SameSite=Lax; Secure");
  assert.equal(hintCookie(true, NOW / 1000 - 1, false, NOW), "md_si=; Max-Age=0; Path=/; SameSite=Lax");
  assert.equal(hintCookie(false, null, true, NOW), "md_si=; Max-Age=0; Path=/; SameSite=Lax; Secure");
});

/** Run the boot script against a fake page; returns what it did. */
function boot({ href, token }) {
  const u = new URL(href);
  const did = { cookie: null, replaced: null, hidden: false };
  const location = {
    hostname: u.hostname, pathname: u.pathname, search: u.search, hash: u.hash, protocol: u.protocol,
    replace: (to) => { did.replaced = to; },
  };
  const document = {
    set cookie(v) { did.cookie = v; },
    documentElement: { style: { set visibility(v) { did.hidden = v === "hidden"; } } },
  };
  const localStorage = { getItem: (k) => (k === "markdrop_token" ? token ?? null : null) };
  const DateFake = { now: () => NOW };
  new Function("location", "document", "localStorage", "Date", "atob", "URLSearchParams", HOME_BOOT_SCRIPT)(
    location, document, localStorage, DateFake, atob, URLSearchParams,
  );
  return did;
}

test("boot script: a stored session on / goes to the dashboard before paint", () => {
  const live = jwt({ sub: "u", typ: "access", exp: NOW / 1000 + 3600 });
  const d = boot({ href: "https://www.markdrop.in/?utm_source=x#top", token: live });
  assert.equal(d.replaced, "/dashboard?utm_source=x#top");
  assert.ok(d.hidden);
  assert.equal(d.cookie, hintCookie(true, NOW / 1000 + 3600, true, NOW));
  // No exp: the 400-day hint.
  assert.equal(boot({ href: "http://localhost:3450/", token: "opaque" }).cookie, hintCookie(true, null, false, NOW));
});

test("boot script: does nothing for anonymous visitors, expired sessions, other paths and hosts, ?home=1", () => {
  const live = jwt({ sub: "u", exp: NOW / 1000 + 3600 });
  const expired = jwt({ sub: "u", exp: NOW / 1000 - 5 });
  const none = { cookie: null, replaced: null, hidden: false };
  assert.deepEqual(boot({ href: "https://markdrop.in/", token: null }), none);
  assert.deepEqual(boot({ href: "https://markdrop.in/", token: expired }), none);
  assert.deepEqual(boot({ href: "https://markdrop.in/?home=1", token: live }), none);
  assert.deepEqual(boot({ href: "https://markdrop.in/pricing", token: live }), none);
  assert.deepEqual(boot({ href: "https://markdrop.in/guides", token: live }), none);
  assert.deepEqual(boot({ href: "https://docs.acme.com/", token: live }), none);
  assert.deepEqual(boot({ href: "https://docs.markdrop.in/", token: live }), none);
  assert.deepEqual(boot({ href: "https://guides.markdrop.in/", token: live }), none);
  assert.deepEqual(boot({ href: "http://acme.localhost:3450/", token: live }), none);
});

test("boot script: storage that throws is a no-op", () => {
  const location = { hostname: "markdrop.in", pathname: "/", search: "", hash: "", protocol: "https:", replace: () => assert.fail("replaced") };
  const localStorage = { getItem: () => { throw new Error("blocked"); } };
  new Function("location", "localStorage", HOME_BOOT_SCRIPT)(location, localStorage);
});
