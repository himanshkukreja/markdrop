// "Get set up" visibility. Run: node --test src/components/workspace/folder/setupRule.test.mjs
// (Node >= 22.18 strips the types from setupRule.ts; it has no imports.)
import test from "node:test";
import assert from "node:assert/strict";
import { isNewWorkspace, shouldShowSetup } from "./setupRule.ts";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();
const base = { createdAt: daysAgo(1), itemCount: 0, invited: false, hasFile: false, now: NOW };

test("a brand-new, empty workspace shows it", () => {
  assert.equal(shouldShowSetup(base), true);
});

test("it stays while core steps are left, inside the window and under 3 items", () => {
  assert.equal(shouldShowSetup({ ...base, invited: true }), true);
  assert.equal(shouldShowSetup({ ...base, hasFile: true, itemCount: 2 }), true);
  assert.equal(shouldShowSetup({ ...base, createdAt: daysAgo(13.9) }), true);
});

test("it goes once the three core steps are done (the domain is optional)", () => {
  assert.equal(shouldShowSetup({ ...base, invited: true, hasFile: true, itemCount: 1 }), false);
});

test("never on an established workspace", () => {
  assert.equal(shouldShowSetup({ ...base, createdAt: daysAgo(15) }), false);           // older than 14 days
  assert.equal(shouldShowSetup({ ...base, createdAt: daysAgo(400) }), false);
  assert.equal(shouldShowSetup({ ...base, itemCount: 3, hasFile: true }), false);      // 3+ items
  assert.equal(shouldShowSetup({ ...base, itemCount: 250, hasFile: true }), false);
});

test("an unknown or unreadable creation date counts as established", () => {
  assert.equal(shouldShowSetup({ ...base, createdAt: null }), false);
  assert.equal(shouldShowSetup({ ...base, createdAt: undefined }), false);
  assert.equal(shouldShowSetup({ ...base, createdAt: "not a date" }), false);
});

test("isNewWorkspace: the window edges", () => {
  assert.equal(isNewWorkspace(daysAgo(14), 0, NOW), true);
  assert.equal(isNewWorkspace(daysAgo(14.01), 0, NOW), false);
  assert.equal(isNewWorkspace(daysAgo(0), 2, NOW), true);
  assert.equal(isNewWorkspace(daysAgo(0), 3, NOW), false);
});
