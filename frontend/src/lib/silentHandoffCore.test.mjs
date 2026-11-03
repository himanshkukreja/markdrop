// The silent sign-in check on a workspace's own domain. Run: node --test src/lib/silentHandoffCore.test.mjs
// (Node >= 22.18 strips the types from silentHandoffCore.ts; it has no imports.)
import test from "node:test";
import assert from "node:assert/strict";
import {
  SILENT_HANDOFF_WINDOW_MS, TENANT_TOKEN_MARGIN_MS, silentAttemptDue, silentHandoffKey, tenantTokenUsable, tokenClaims,
} from "./silentHandoffCore.ts";

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(claims)}.sig`;
const tenant = (over = {}) => jwt({ sub: "u1", typ: "tenant", ws: "w1", host: "content.senseloaf.ai", exp: NOW / 1000 + 3600, ...over });

test("claims: read without verifying, null when unreadable", () => {
  assert.equal(tokenClaims(tenant()).typ, "tenant");
  assert.equal(tokenClaims("garbage"), null);
  assert.equal(tokenClaims("a.!!!.c"), null);
  assert.equal(tokenClaims(`x.${Buffer.from("[1,2]").toString("base64url")}.y`), null);
});

test("a live tenant token for this host is usable", () => {
  assert.ok(tenantTokenUsable(tenant(), "content.senseloaf.ai", NOW));
  assert.ok(tenantTokenUsable(tenant({ host: "Content.Senseloaf.AI." }), "content.senseloaf.ai", NOW));
});

test("an expired tenant token is not a session (the bug: it skipped the silent check)", () => {
  assert.ok(!tenantTokenUsable(tenant({ exp: NOW / 1000 - 1 }), "content.senseloaf.ai", NOW));
  // About to expire: treated as expired with the margin the page uses.
  const soon = tenant({ exp: NOW / 1000 + 30 });
  assert.ok(tenantTokenUsable(soon, "content.senseloaf.ai", NOW));
  assert.ok(!tenantTokenUsable(soon, "content.senseloaf.ai", NOW, TENANT_TOKEN_MARGIN_MS));
  assert.ok(!tenantTokenUsable(tenant({ exp: undefined }), "content.senseloaf.ai", NOW), "no exp: not ours");
});

test("another host's token, a full session, or junk is not usable here", () => {
  assert.ok(!tenantTokenUsable(tenant({ host: "docs.other.com" }), "content.senseloaf.ai", NOW));
  assert.ok(!tenantTokenUsable(jwt({ sub: "u1", typ: "access", exp: NOW / 1000 + 3600 }), "content.senseloaf.ai", NOW));
  assert.ok(!tenantTokenUsable("not-a-jwt", "content.senseloaf.ai", NOW));
  assert.ok(!tenantTokenUsable(tenant(), "", NOW));
});

test("attempt marker: one try per page per window, never a permanent flag", () => {
  assert.equal(silentHandoffKey("content.senseloaf.ai", "/a/b"), "md_silent_handoff:content.senseloaf.ai/a/b");
  assert.ok(silentAttemptDue(null, NOW), "never tried");
  assert.ok(!silentAttemptDue(String(NOW - 5_000), NOW), "tried 5 s ago: the round trip just came back");
  assert.ok(!silentAttemptDue(String(NOW - SILENT_HANDOFF_WINDOW_MS + 1), NOW));
  assert.ok(silentAttemptDue(String(NOW - SILENT_HANDOFF_WINDOW_MS), NOW), "window over: ask again");
  assert.ok(silentAttemptDue(String(NOW - 12 * 3600_000), NOW), "hours later (token expired since): ask again");
  // The old per-tab flag ("1") and junk count as long ago.
  assert.ok(silentAttemptDue("1", NOW));
  assert.ok(silentAttemptDue("soon", NOW));
  // A marker from the future (clock moved back) blocks only within the window.
  assert.ok(!silentAttemptDue(String(NOW + 10_000), NOW));
  assert.ok(silentAttemptDue(String(NOW + 24 * 3600_000), NOW));
});
