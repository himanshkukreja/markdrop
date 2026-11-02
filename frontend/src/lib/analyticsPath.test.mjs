// Route shapes and replay eligibility. Run: node --test src/lib/analyticsPath.test.mjs
// (Node >= 22.18 strips the types from analyticsPath.ts; it has no imports.)
import test from "node:test";
import assert from "node:assert/strict";
import { DOCS_ROUTE, docsRoute, hashIsRecordable, isAnalyticsHost, isDocumentRoute, isRecordable, redactPath, redactUrl } from "./analyticsPath.ts";

const SITE = "6650f2c4a1b2c3d4e5f60718";

test("documents and capabilities keep their shapes", () => {
  assert.equal(redactPath("/bkwJuG4"), "/[slug]");
  assert.equal(redactPath("/share/room123"), "/share/[id]");
  assert.equal(redactPath("/invite/tok"), "/invite/[token]");
  assert.equal(redactPath("/f/abc/x"), "/f/[share]");
  assert.equal(redactPath("/w/ws1"), "/w/[workspace]");
  assert.equal(redactPath("/dashboard"), "/dashboard");
});

test("Guides screens are app routes, not documents", () => {
  for (const root of ["guides", "docs-studio"]) {
    assert.equal(redactPath(`/${root}`), `/${root}`);
    assert.equal(redactPath(`/${root}/new`), `/${root}/new`);
    assert.equal(redactPath(`/${root}/members`), `/${root}/members`);
    assert.equal(redactPath(`/${root}/home`), `/${root}/home`);
    assert.equal(redactPath(`/${root}/${SITE}`), `/${root}/[site]`);
    for (const s of ["design", "publish", "settings", "import"]) assert.equal(redactPath(`/${root}/${SITE}/${s}`), `/${root}/[site]/${s}`);
    assert.equal(redactPath(`/${root}/${SITE}/whatever`), `/${root}/[site]/[other]`);
    assert.equal(redactPath(`/${root}/${SITE}/pages/p1/x`), `/${root}/[site]/[other]`);
    for (const s of ["general", "domains", "redirects"]) assert.equal(redactPath(`/${root}/${SITE}/settings/${s}`), `/${root}/[site]/settings/${s}`);
    // A domain's setup page names a customer's domain.
    assert.equal(redactPath(`/${root}/${SITE}/settings/domains/help.acme.com`), `/${root}/[site]/[other]`);
    assert.equal(redactPath(`/${root}/${SITE}/settings/nope`), `/${root}/[site]/[other]`);
    for (const s of ["fixes", "changelog", "insights"]) assert.equal(redactPath(`/${root}/${SITE}/${s}`), `/${root}/[site]/${s}`);
    assert.equal(redactPath(`/${root}/${SITE}/publish/compare`), `/${root}/[site]/publish/compare`);
  }
});

test("a domain check page never names the domain", () => {
  assert.equal(redactPath("/d/check/help.acme.com"), "/d/check/[host]");
  assert.equal(redactUrl("https://markdrop.in/d/check/help.acme.com"), "https://markdrop.in/d/check/[host]");
});

test("site ids never reach a report", () => {
  assert.equal(redactUrl(`https://markdrop.in/guides/${SITE}/design?new=1`), "https://markdrop.in/guides/[site]/design");
  assert.equal(redactUrl(`https://markdrop.in/docs-studio/${SITE}?page=abc`), "https://markdrop.in/docs-studio/[site]");
});

test("pages below an app route: literal pages kept, ids and anything unknown never", () => {
  assert.equal(redactPath("/settings/account"), "/settings/account");
  assert.equal(redactPath("/dashboard/live"), "/dashboard/live");
  assert.equal(redactPath("/oauth/consent"), "/oauth/consent");
  // A document's own analytics page carries its slug.
  assert.equal(redactPath("/dashboard/analytics/bkwJuG4"), "/dashboard/analytics/[slug]");
  assert.equal(redactPath("/settings/workspaces/ws1"), "/settings/workspaces/[id]");
  assert.equal(redactPath("/settings/workspaces/ws1/x"), "/settings/workspaces/[other]");
  assert.equal(redactPath("/dashboard/bkwJuG4"), "/dashboard/[other]");
  assert.equal(redactPath("/bkwJuG4/x"), "/[slug]/[other]");
});

test("the docs site: every page is public, reported under its own route", () => {
  assert.equal(DOCS_ROUTE, "/docs-site");
  assert.equal(docsRoute("/"), "/docs-site");
  assert.equal(docsRoute("/guides/overview"), "/docs-site/guides/overview");
  assert.equal(docsRoute("/guides/overview?x=1#y"), "/docs-site/guides/overview");
  assert.equal(docsRoute("/docs-site/get-started"), "/docs-site/get-started");
  // Kept as they are, and never mistaken for the studio (/guides/[site]) or a document (/[slug]).
  for (const p of ["/docs-site", "/docs-site/get-started", "/docs-site/guides/overview", "/docs-site/api/documents/create"]) {
    assert.equal(redactPath(p), p);
    assert.ok(isRecordable(p), p);
  }
});

test("replay records every page: documents, share rooms, invites, folders, workspaces, Guides", () => {
  for (const p of [
    "/", "/guides", "/mcp", "/enterprise", "/privacy", "/dashboard", "/recent", "/shared", "/new", "/builder", "/upload", "/login",
    "/bkwJuG4", "/share", "/share/room", "/invite/tok", "/w/ws1", "/w/ws1/f/fold1", "/f/share", "/f/share/a/b", "/requests/r1",
    "/settings/tokens", "/dashboard/analytics/bkwJuG4", "/oauth/consent", "/extension/authorize", "/d/check/help.acme.com",
    `/guides/${SITE}`, `/guides/${SITE}/whatever`, "/guides/home",
  ]) assert.ok(isRecordable(p), p);
  // Their own query keys are fine (reports drop the query anyway).
  assert.ok(isRecordable("/dashboard", ["utm_campaign", "tab"]));
  assert.ok(isRecordable(`/guides/${SITE}`, ["page", "ws"]));
  assert.ok(isRecordable("/new", ["sample"]));
});

test("replay never records /admin, sign-in hand-offs, or an address carrying a secret", () => {
  assert.ok(!isRecordable("/admin"));
  assert.ok(!isRecordable("/admin", ["tab"]));
  for (const p of ["/auth/callback", "/auth/handoff", "/auth/docs-access"]) assert.ok(!isRecordable(p), p);
  for (const k of ["token", "t", "k", "key", "state", "code", "access_token", "Token"]) assert.ok(!isRecordable("/dashboard", [k]), k);
  // Fragments: a plain anchor is fine; a key or token never (#k= is an encrypted document's key).
  assert.ok(hashIsRecordable("") && hashIsRecordable("#") && hashIsRecordable("#a-heading"));
  for (const h of ["#k=abc", "#x=1&k=abc", "#token=jwt&next=/d", "#mdt=t&mds=s"]) assert.ok(!hashIsRecordable(h), h);
});

test("a document's page waits for the viewer's context; nothing else does", () => {
  assert.ok(isDocumentRoute("/bkwJuG4"));
  for (const p of ["/", "/dashboard", "/share/room", "/docs-site/get-started", `/guides/${SITE}`]) assert.ok(!isDocumentRoute(p), p);
});

test("third-party analytics run on Markdrop's own hosts only, never a published guide or a customer's domain", () => {
  const prod = new Set(["markdrop.in", "www.markdrop.in", "guides.markdrop.in", "docs.markdrop.in"]);
  const local = new Set(["localhost", "127.0.0.1", "guides.localhost", "docs.localhost"]);
  for (const h of prod) assert.ok(isAnalyticsHost(h, prod, local, false), h);
  for (const h of ["acme.guides.markdrop.in", "help.acme.com", "docs.acme.com", "markdrop-docs-edge.example.workers.dev", "markdrop-git-x.vercel.app", "evilmarkdrop.in"]) {
    assert.ok(!isAnalyticsHost(h, prod, local, true), h);
  }
  assert.ok(!isAnalyticsHost("docs.localhost", prod, local, false));
  assert.ok(isAnalyticsHost("docs.localhost", prod, local, true));
});
