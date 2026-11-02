// The studio's own host: addresses and the middleware's routing. Run: node --test src/lib/studioHost.test.mjs
// (Node >= 22.18 strips the types from studioHost.ts; it has no imports.)
import test from "node:test";
import assert from "node:assert/strict";
import {
  STUDIO_HOST, analyticsRoute, appHref, appOriginFrom, handoffStudioOrigin, isStudioHost, isStudioParentHost, studioHref,
  studioPathOf, studioRoute, studioRouting, toStudioRoute,
} from "./studioHost.ts";

const SITE = "6650f2c4a1b2c3d4e5f60718";
const STUDIO = { hostname: "guides.markdrop.in", port: "", protocol: "https:" };
const APP = { hostname: "markdrop.in", port: "", protocol: "https:" };
const WWW = { hostname: "www.markdrop.in", port: "", protocol: "https:" };
const LOCAL = { hostname: "localhost", port: "3000", protocol: "http:" };
const DEV_STUDIO = { hostname: "guides.localhost", port: "3000", protocol: "http:" };
const PREVIEW = { hostname: "markdrop-git-preview-x.vercel.app", port: "", protocol: "https:" };

test("hosts", () => {
  assert.equal(STUDIO_HOST, "guides.markdrop.in");
  assert.ok(isStudioHost("guides.markdrop.in"));
  assert.ok(isStudioHost("Guides.Markdrop.in.:443"));
  assert.ok(isStudioHost("guides.localhost:3000"));
  assert.ok(!isStudioHost("acme.guides.markdrop.in"), "a published guide is not the studio");
  assert.ok(!isStudioHost("markdrop.in"));
  assert.ok(isStudioParentHost("markdrop.in") && isStudioParentHost("www.markdrop.in"));
  assert.ok(!isStudioParentHost("localhost") && !isStudioParentHost("x.vercel.app") && !isStudioParentHost("evil.in"));
});

test("studio hrefs: no /guides prefix on the studio host", () => {
  assert.equal(studioHref("/", STUDIO), "/");
  assert.equal(studioHref("/new?ws=w1&start=github", STUDIO), "/new?ws=w1&start=github");
  assert.equal(studioHref(`/${SITE}/fixes`, STUDIO), `/${SITE}/fixes`);
  assert.equal(studioHref("/theme-preview", STUDIO), "/theme-preview");
  assert.equal(studioHref("/", DEV_STUDIO), "/");
});

test("studio hrefs from markdrop.in are absolute studio-host addresses", () => {
  assert.equal(studioHref("/", APP), "https://guides.markdrop.in/");
  assert.equal(studioHref("/new", WWW), "https://guides.markdrop.in/new");
  assert.equal(studioHref("/?ws=w1", APP), "https://guides.markdrop.in/?ws=w1");
});

test("studio hrefs on localhost and previews stay under /guides (home: /guides/home)", () => {
  for (const w of [LOCAL, PREVIEW]) {
    assert.equal(studioHref("/", w), "/guides/home");
    assert.equal(studioHref("/?ws=personal", w), "/guides/home?ws=personal");
    assert.equal(studioHref("/new?start=blank", w), "/guides/new?start=blank");
    assert.equal(studioHref(`/${SITE}?page=p1#x`, w), `/guides/${SITE}?page=p1#x`);
  }
});

test("routes and studio paths convert both ways", () => {
  assert.equal(studioRoute("/"), "/guides/home");
  assert.equal(studioRoute("/?ws=1"), "/guides/home?ws=1");
  assert.equal(studioRoute(`/${SITE}/publish`), `/guides/${SITE}/publish`);
  assert.equal(studioPathOf("/guides"), "/");
  assert.equal(studioPathOf("/guides/"), "/");
  assert.equal(studioPathOf("/guides/home?ws=1"), "/?ws=1");
  assert.equal(studioPathOf(`/guides/${SITE}/settings/private#requests`), `/${SITE}/settings/private#requests`);
  assert.equal(studioPathOf("/docs-studio/new"), "/new");
  assert.equal(studioPathOf("/dashboard"), null);
  assert.equal(studioPathOf("/guidesx"), null);
});

test("toStudioRoute: whatever studioHref gave, as the app route (the API's return_to)", () => {
  assert.equal(toStudioRoute("/new?start=github", STUDIO), "/guides/new?start=github");
  assert.equal(toStudioRoute(`/${SITE}/settings/github`, STUDIO), `/guides/${SITE}/settings/github`);
  assert.equal(toStudioRoute("/", STUDIO), "/guides/home");
  assert.equal(toStudioRoute("/guides/new?start=github", LOCAL), "/guides/new?start=github");
  assert.equal(toStudioRoute("https://guides.markdrop.in/new", APP), "/guides/new");
  assert.equal(toStudioRoute("/dashboard", STUDIO), null);
  assert.equal(toStudioRoute("//evil.com/guides", STUDIO), null);
  assert.equal(toStudioRoute("https://evil.com/guides/x", STUDIO), null);
  assert.equal(toStudioRoute("/dashboard", LOCAL), null);
});

test("app links from the studio host are absolute; elsewhere unchanged", () => {
  assert.equal(appOriginFrom(STUDIO), "https://markdrop.in");
  assert.equal(appOriginFrom(DEV_STUDIO), "http://localhost:3000");
  assert.equal(appHref("/dashboard?kind=document", STUDIO), "https://markdrop.in/dashboard?kind=document");
  assert.equal(appHref("/settings/account", DEV_STUDIO), "http://localhost:3000/settings/account");
  assert.equal(appHref("/dashboard", APP), "/dashboard");
  assert.equal(appHref("/dashboard", LOCAL), "/dashboard");
});

test("the hand-off goes back to the studio host of the app it runs on", () => {
  assert.equal(handoffStudioOrigin(APP), "https://guides.markdrop.in");
  assert.equal(handoffStudioOrigin(WWW), "https://guides.markdrop.in");
  assert.equal(handoffStudioOrigin(LOCAL), "http://guides.localhost:3000");
  assert.equal(handoffStudioOrigin(PREVIEW), null);
  assert.equal(handoffStudioOrigin({ hostname: "evil.com" }), null);
});

/* ── the middleware ── */

const r = (host, path, search = "", port = "") => studioRouting(host, path, search, port);

test("studio host: screens rewrite to the app routes", () => {
  assert.deepEqual(r("guides.markdrop.in", "/"), { kind: "rewrite", path: "/guides/home" });
  assert.deepEqual(r("guides.markdrop.in", "/new"), { kind: "rewrite", path: "/guides/new" });
  assert.deepEqual(r("guides.markdrop.in", "/members"), { kind: "rewrite", path: "/guides/members" });
  assert.deepEqual(r("guides.markdrop.in", "/github/installed"), { kind: "rewrite", path: "/guides/github/installed" });
  assert.deepEqual(r("guides.markdrop.in", "/theme-preview"), { kind: "rewrite", path: "/guides/theme-preview" });
  assert.deepEqual(r("guides.markdrop.in", `/${SITE}`), { kind: "rewrite", path: `/guides/${SITE}` });
  assert.deepEqual(r("guides.markdrop.in", `/${SITE}/settings/domains/help.acme.com`), { kind: "rewrite", path: `/guides/${SITE}/settings/domains/help.acme.com` });
  assert.deepEqual(r("guides.localhost:3000", "/"), { kind: "rewrite", path: "/guides/home" });
});

test("studio host: robots, files and handlers", () => {
  assert.deepEqual(r("guides.markdrop.in", "/robots.txt"), { kind: "robots" });
  assert.deepEqual(r("guides.markdrop.in", "/sitemap.xml"), { kind: "not-found" });
  for (const p of ["/favicon.ico", "/icon.svg", "/apple-icon", "/studio-signout.html", "/docs-assets/x/y.webp", "/api/geo", "/_vercel/insights/view", "/__nextjs_original-stack-frame"]) {
    assert.deepEqual(r("guides.markdrop.in", p), { kind: "next" }, p);
  }
});

test("studio host: old prefixed addresses lose the prefix; the rest of Markdrop goes to markdrop.in", () => {
  assert.deepEqual(r("guides.markdrop.in", "/guides"), { kind: "redirect", location: "/" });
  assert.deepEqual(r("guides.markdrop.in", "/guides/home", "?ws=1"), { kind: "redirect", location: "/?ws=1" });
  assert.deepEqual(r("guides.markdrop.in", `/guides/${SITE}/fixes`, "?item=3"), { kind: "redirect", location: `/${SITE}/fixes?item=3` });
  assert.deepEqual(r("guides.markdrop.in", "/home"), { kind: "redirect", location: "/" });
  assert.deepEqual(r("guides.markdrop.in", "/dashboard", "?kind=document"), { kind: "redirect", location: "https://markdrop.in/dashboard?kind=document", temporary: true });
  assert.deepEqual(r("guides.markdrop.in", "/login"), { kind: "redirect", location: "https://markdrop.in/login", temporary: true });
  assert.deepEqual(r("guides.markdrop.in", "/bkwJuG4"), { kind: "redirect", location: "https://markdrop.in/bkwJuG4", temporary: true });
  assert.deepEqual(r("guides.localhost", "/dashboard", "", "3000"), { kind: "redirect", location: "http://localhost:3000/dashboard", temporary: true });
});

test("markdrop.in: /guides is the landing page; every other /guides address moves to the studio host", () => {
  assert.deepEqual(r("markdrop.in", "/guides"), { kind: "next" });
  assert.deepEqual(r("markdrop.in", "/guides", "?utm_source=x"), { kind: "next" });
  assert.deepEqual(r("markdrop.in", "/guides/opengraph-image"), { kind: "next" });
  assert.deepEqual(r("markdrop.in", "/guides/opengraph-image-1a2b3c"), { kind: "next" });
  assert.deepEqual(r("markdrop.in", "/guides/new", "?ws=w1&start=github"), { kind: "redirect", location: "https://guides.markdrop.in/new?ws=w1&start=github" });
  assert.deepEqual(r("www.markdrop.in", `/guides/${SITE}/settings/private`), { kind: "redirect", location: `https://guides.markdrop.in/${SITE}/settings/private` });
  assert.deepEqual(r("markdrop.in", "/guides/home"), { kind: "redirect", location: "https://guides.markdrop.in/" });
  assert.deepEqual(r("markdrop.in", "/guides/github/installed", "?code=c&state=s&installation_id=1"), { kind: "redirect", location: "https://guides.markdrop.in/github/installed?code=c&state=s&installation_id=1" });
  assert.deepEqual(r("markdrop.in", "/guides", "?ws=w1"), { kind: "redirect", location: "https://guides.markdrop.in/?ws=w1" });
  assert.deepEqual(r("markdrop.in", "/docs-studio"), { kind: "redirect", location: "https://guides.markdrop.in/" });
  assert.deepEqual(r("markdrop.in", `/docs-studio/${SITE}/design`), { kind: "redirect", location: `https://guides.markdrop.in/${SITE}/design` });
  assert.deepEqual(r("markdrop.in", "/dashboard"), { kind: "next" });
});

test("the landing page's about addresses are just /guides now", () => {
  for (const host of ["markdrop.in", "localhost"]) {
    assert.deepEqual(r(host, "/guides", "?about=1"), { kind: "redirect", location: "/guides" });
    assert.deepEqual(r(host, "/guides", "?about=1&utm_source=x"), { kind: "redirect", location: "/guides?utm_source=x" });
    assert.deepEqual(r(host, "/guides/about"), { kind: "redirect", location: "/guides" });
  }
});

test("localhost and previews keep the studio under /guides", () => {
  for (const host of ["localhost", "127.0.0.1", "markdrop-git-x.vercel.app"]) {
    assert.deepEqual(r(host, "/guides/new"), { kind: "next" }, host);
    assert.deepEqual(r(host, `/guides/${SITE}/fixes`), { kind: "next" });
    assert.deepEqual(r(host, "/guides/home"), { kind: "next" });
    assert.deepEqual(r(host, "/guides", "?ws=w1"), { kind: "redirect", location: "/guides/home?ws=w1" });
    assert.deepEqual(r(host, "/docs-studio/new"), { kind: "redirect", location: "/guides/new" });
  }
});
test("analytics: a studio-host path is reported as its app route", () => {
  assert.equal(analyticsRoute(`/${SITE}/fixes`, "guides.markdrop.in"), `/guides/${SITE}/fixes`);
  assert.equal(analyticsRoute("/", "guides.markdrop.in"), "/guides/home");
  assert.equal(analyticsRoute("/guides/new", "guides.markdrop.in"), "/guides/new", "never twice");
  assert.equal(analyticsRoute("/dashboard", "markdrop.in"), "/dashboard");
  assert.equal(analyticsRoute("/guides", "markdrop.in"), "/guides");
});
