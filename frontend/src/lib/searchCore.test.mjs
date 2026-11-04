import test from "node:test";
import assert from "node:assert/strict";
import { looksLikeQuestion, highlight, citeSegments, pushRecent, shortAgo, whereOf, RECENT_MAX } from "./searchCore.mjs";

test("questions and descriptions run AI; names stay fuzzy", () => {
  for (const q of ["how do we onboard contractors?", "what is our refund policy", "the doc about pricing for EU",
    "notes from the offsite where we planned the launch"]) assert.equal(looksLikeQuestion(q), true, q);
  for (const q of ["onboarding playbook", "Q3 report", "launch", "", null]) assert.equal(looksLikeQuestion(q), false, String(q));
});

test("highlight merges and clamps the server's ranges", () => {
  assert.deepEqual(highlight("Onboarding Playbook", [[0, 10]]), [
    { text: "Onboarding", mark: true }, { text: " Playbook", mark: false }]);
  assert.deepEqual(highlight("abcdef", [[3, 5], [1, 4], [9, 12], "x", [2, 2]]), [
    { text: "a", mark: false }, { text: "bcde", mark: true }, { text: "f", mark: false }]);
  assert.deepEqual(highlight("", []), [{ text: "", mark: false }]);
  assert.deepEqual(highlight("plain", null), [{ text: "plain", mark: false }]);
});

test("citations become chips only for listed items", () => {
  assert.deepEqual(citeSegments("Laptops on day one [2]. See [9] and [1].", [1, 2]), [
    { text: "Laptops on day one " }, { cite: 2 }, { text: ". See [9] and " }, { cite: 1 }, { text: "." }]);
  assert.deepEqual(citeSegments("", [1]), []);
});

test("recent searches dedupe, trim and cap", () => {
  let l = [];
  for (let i = 0; i < 12; i++) l = pushRecent(l, `query ${i}`);
  assert.equal(l.length, RECENT_MAX);
  assert.equal(l[0], "query 11");
  l = pushRecent(l, "  QUERY 5 ");
  assert.equal(l[0], "QUERY 5");
  assert.equal(l.filter((x) => x.toLowerCase() === "query 5").length, 1);
  assert.deepEqual(pushRecent(["a b"], "x"), ["a b"]);
  assert.deepEqual(pushRecent("junk", "hello"), ["hello"]);
});

test("short relative times", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  assert.equal(shortAgo("2026-11-04T11:59:30Z", now), "just now");
  assert.equal(shortAgo("2026-11-04T11:00:00", now), "1h ago");
  assert.equal(shortAgo("2026-11-01T12:00:00Z", now), "3d ago");
  assert.equal(shortAgo("2026-03-04T12:00:00Z", now), "Mar 4");
  assert.equal(shortAgo("2024-03-04T12:00:00Z", now), "Mar 4, 2024");
  assert.equal(shortAgo(null, now), "");
});

test("where an item lives", () => {
  assert.equal(whereOf({ kind: "doc", workspace: { name: "Acme" }, folder: { path: ["Eng", "Runbooks"] } }), "Acme › Eng › Runbooks");
  assert.equal(whereOf({ kind: "doc", owner: { is_you: true } }), "My files");
  assert.equal(whereOf({ kind: "doc", owner: { is_you: false } }), "Shared with me");
  assert.equal(whereOf({ kind: "guide", guide: { name: "Help center" }, path: "/install" }), "Help center · /install");
  assert.equal(whereOf({ kind: "workspace" }), "Workspace");
});
