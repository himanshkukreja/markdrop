// What PostHog may record, and what the URLs in its events and recordings become.
// Run: node --test src/lib/thirdPartyAnalytics.test.mjs
// (Node >= 22.18 strips the types. thirdPartyAnalytics.ts imports through the "@/" alias and
// extensionless paths, so a resolve hook maps those the way the bundler does.)
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

const SRC = new URL("../", import.meta.url).href;
const hooks = `
const SRC = ${JSON.stringify(SRC)};
export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) specifier = SRC + specifier.slice(2);
  else if (!/^(\\.{1,2}\\/|file:)/.test(specifier)) return next(specifier, context);
  if (!/\\.(m?js|ts|tsx|json)$/.test(specifier)) {
    for (const ext of [".ts", ".tsx"]) {
      try { return await next(specifier + ext, context); } catch { /* next extension */ }
    }
  }
  return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);
const { cleanPath, cleanUrl, hasDocumentKey, onEncryptedPage, pageRoute, recordableUrl, scrubText } = await import("./thirdPartyAnalytics.ts");

const SITE = "6650f2c4a1b2c3d4e5f60718";

test("docs.markdrop.in: every page is a public page with its own route", () => {
  assert.equal(pageRoute("/", "docs.markdrop.in"), "/docs-site");
  assert.equal(pageRoute("/guides/overview", "docs.markdrop.in"), "/docs-site/guides/overview");
  assert.equal(pageRoute("/docs-site/guides/overview", "docs.markdrop.in"), "/docs-site/guides/overview", "never twice");
  assert.equal(pageRoute("/get-started", "docs.localhost"), "/docs-site/get-started");
  // Not a document's slug, and not the Guides studio's /guides/[site].
  assert.equal(cleanPath("/get-started", "docs.markdrop.in"), "/docs-site/get-started");
  assert.equal(cleanPath("/guides/overview", "docs.markdrop.in"), "/docs-site/guides/overview");
  assert.equal(cleanPath("/api/documents/create", "docs.markdrop.in"), "/docs-site/api/documents/create");
  // Its URLs keep their real address, minus query and fragment.
  assert.equal(cleanUrl("https://docs.markdrop.in/guides/overview?q=x#install"), "https://docs.markdrop.in/guides/overview");
  for (const path of ["/", "/get-started", "/guides/overview", "/guides/overview#install", "/api/documents/create", "/changelog", "/mcp?utm_source=x"]) {
    assert.ok(recordableUrl(`https://docs.markdrop.in${path}`), path);
  }
});

test("documents, share rooms, invites and folders are recorded, reported as their route shapes", () => {
  const pages = {
    "/AbC123": "/[slug]",
    "/share/room-9f2": "/share/[id]",
    "/invite/tok_secret": "/invite/[token]",
    "/f/sh4re/sub/file": "/f/[share]",
    "/w/ws1": "/w/[workspace]",
    "/w/ws1/f/fold1": "/w/[workspace]/f/[folder]",
    "/requests/req1": "/requests/[id]",
    "/dashboard/analytics/AbC123": "/dashboard/analytics/[slug]",
    "/settings/workspaces/ws1": "/settings/workspaces/[id]",
    "/dashboard": "/dashboard",
    "/new": "/new",
    "/oauth/consent": "/oauth/consent",
  };
  for (const [path, shape] of Object.entries(pages)) {
    assert.ok(recordableUrl(`https://markdrop.in${path}`), path);
    assert.equal(cleanPath(path, "markdrop.in"), shape, path);
    assert.equal(cleanUrl(`https://markdrop.in${path}?x=1#frag`), `https://markdrop.in${shape}`, path);
  }
  // The Guides studio, on its own host.
  assert.ok(recordableUrl(`https://guides.markdrop.in/${SITE}/fixes?page=p1`));
  assert.equal(cleanPath(`/${SITE}/fixes`, "guides.markdrop.in"), "/guides/[site]/fixes");
  assert.equal(cleanUrl(`https://guides.markdrop.in/${SITE}/fixes?page=p1`), "https://guides.markdrop.in/[site]/fixes");
  // A plain #anchor is fine.
  assert.ok(recordableUrl("https://markdrop.in/AbC123#a-heading"));
});

test("encrypted documents, sign-in links and secrets in the address are never recorded", () => {
  assert.ok(!recordableUrl("https://markdrop.in/AbC123#k=c2VjcmV0LWtleQ"));
  assert.ok(!recordableUrl("https://markdrop.in/AbC123#x=1&k=c2VjcmV0"));
  assert.ok(hasDocumentKey("#k=abc") && hasDocumentKey("#x=1&k=abc") && !hasDocumentKey("#heading"));
  assert.ok(!recordableUrl("https://markdrop.in/auth/callback#token=jwt&next=/dashboard"));
  assert.ok(!recordableUrl("https://markdrop.in/auth/handoff?host=docs.acme.com&next=/x"));
  assert.ok(!recordableUrl("https://markdrop.in/auth/callback"));
  assert.ok(!recordableUrl(`https://guides.markdrop.in/${SITE}#mdt=tok`));
  assert.ok(!recordableUrl("https://markdrop.in/oauth/consent?client_id=c&state=s&code_challenge=x"));
  assert.ok(!recordableUrl("https://markdrop.in/extension/authorize?state=s&redirect=vscode://x"));
  assert.ok(!recordableUrl("https://markdrop.in/dashboard?token=abc"));
  assert.ok(!recordableUrl("https://docs.markdrop.in/get-started?token=abc"));
});

test("an encrypted document's page is seen before anything loads: key in the address or marker in the DOM", () => {
  const saved = { window: globalThis.window, document: globalThis.document };
  try {
    globalThis.window = { location: { hash: "#k=abc", hostname: "markdrop.in", origin: "https://markdrop.in" } };
    globalThis.document = { querySelector: () => null };
    assert.ok(onEncryptedPage(), "key in the address");
    globalThis.window.location.hash = "";
    assert.ok(!onEncryptedPage(), "a plain document");
    globalThis.document = { querySelector: (s) => (s === "[data-md-e2e]" ? {} : null) };
    assert.ok(onEncryptedPage(), "server-rendered data-md-e2e, no key");
  } finally {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
  }
});

test("/admin is never recorded, on any host", () => {
  assert.ok(!recordableUrl("https://markdrop.in/admin"));
  assert.ok(!recordableUrl("https://markdrop.in/admin?tab=users"));
  assert.ok(!recordableUrl("https://www.markdrop.in/admin/x"));
});

test("Markdrop URLs written in text become route shapes, by the rules of their own host", () => {
  assert.equal(scrubText("open markdrop.in/AbC123?x=1 now"), "open markdrop.in/[slug] now");
  assert.equal(scrubText("https://www.markdrop.in/share/room9"), "https://www.markdrop.in/share/[id]");
  assert.equal(scrubText("http://localhost:3000/invite/tok"), "http://localhost:3000/invite/[token]");
  assert.equal(scrubText("see docs.markdrop.in/guides/overview"), "see docs.markdrop.in/guides/overview");
  assert.equal(scrubText(`guides.markdrop.in/${SITE}/fixes`), "guides.markdrop.in/[site]/fixes");
  // A published guide's own pages are a customer's: shapes only.
  assert.equal(scrubText("acme.guides.markdrop.in/secret-plan"), "acme.guides.markdrop.in/[slug]");
  assert.equal(scrubText("mail me at hi@markdrop.in"), "mail me at hi@markdrop.in");
});
