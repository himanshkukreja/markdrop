// Route shapes and replay eligibility. Run: node --test src/lib/analyticsPath.test.mjs
// (Node >= 22.18 strips the types from analyticsPath.ts; it has no imports.)
import test from "node:test";
import assert from "node:assert/strict";
import { isRecordable, redactPath, redactUrl } from "./analyticsPath.ts";

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
    assert.equal(redactPath(`/${root}/${SITE}`), `/${root}/[site]`);
    for (const s of ["design", "publish", "settings", "import"]) assert.equal(redactPath(`/${root}/${SITE}/${s}`), `/${root}/[site]/${s}`);
    assert.equal(redactPath(`/${root}/${SITE}/whatever`), `/${root}/[site]/[other]`);
    assert.equal(redactPath(`/${root}/${SITE}/pages/p1/x`), `/${root}/[site]/[other]`);
  }
});

test("site ids never reach a report", () => {
  assert.equal(redactUrl(`https://markdrop.in/guides/${SITE}/design?new=1`), "https://markdrop.in/guides/[site]/design");
  assert.equal(redactUrl(`https://markdrop.in/docs-studio/${SITE}?page=abc`), "https://markdrop.in/docs-studio/[site]");
});

test("replay records Guides screens, with their own query keys", () => {
  assert.ok(isRecordable("/guides"));
  assert.ok(isRecordable("/guides", ["ws"]));
  assert.ok(isRecordable(`/guides/${SITE}`, ["page"]));
  assert.ok(isRecordable(`/docs-studio/${SITE}/import`, ["job"]));
  assert.ok(isRecordable(`/guides/${SITE}/design`, ["new", "utm_source"]));
  assert.ok(isRecordable("/guides/new", ["ws"]));
  assert.ok(!isRecordable(`/guides/${SITE}/whatever`));
  assert.ok(!isRecordable(`/guides/${SITE}`, ["token"]));
});

test("replay never records documents or capability links", () => {
  assert.ok(isRecordable("/dashboard"));
  assert.ok(isRecordable("/dashboard", ["utm_campaign"]));
  assert.ok(!isRecordable("/dashboard", ["page"])); // Guides' keys count only on Guides screens
  assert.ok(!isRecordable("/bkwJuG4"));
  assert.ok(!isRecordable("/guides-doc")); // a document slug that merely starts alike
  assert.ok(!isRecordable("/share/room"));
  assert.ok(!isRecordable("/invite/tok"));
  assert.ok(!isRecordable("/w/ws1"));
  assert.ok(!isRecordable("/f/share"));
});
