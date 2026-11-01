/**
 * The Fix list's pure half (fixesModel.ts).
 * Runs on node's TypeScript type stripping (node ≥ 22.18); skipped without it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

let mod = null;
try {
  mod = await import("./fixesModel.ts");
} catch (e) {
  if (!/Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION|strip/i.test(String(e?.message ?? e))) throw e;
}
const t = mod ? test : test.skip;

t("words per type", () => {
  const { readersWords, TYPE_META, FIX_TYPES, badgeWords } = mod;
  assert.equal(readersWords("drop", 45), "45 readers left here");
  assert.equal(readersWords("search", 1), "1 search found nothing");
  assert.equal(readersWords("ask", 1234.4), "1,234 unanswered questions");
  assert.equal(readersWords("video", 0), "0 viewers lost");
  for (const ty of FIX_TYPES) {
    assert.ok(TYPE_META[ty].label && TYPE_META[ty].icon && TYPE_META[ty].draft && TYPE_META[ty].watches, ty);
  }
  assert.equal(badgeWords(0), "Nothing to fix");
  assert.equal(badgeWords(1), "1 thing to fix");
  assert.equal(badgeWords(12), "12 things to fix");
});

t("clock and bars", () => {
  const { clock, impactWidth } = mod;
  assert.equal(clock(42), "0:42");
  assert.equal(clock(42.6), "0:43");
  assert.equal(clock(600), "10:00");
  assert.equal(clock(3725), "1:02:05");
  assert.equal(clock(NaN), "0:00");
  assert.equal(impactWidth(50, 100), "50%");
  assert.equal(impactWidth(1, 100), "6%");
  assert.equal(impactWidth(0, 0), "6%");
  assert.equal(impactWidth(200, 100), "100%");
});

t("filters", () => {
  const { matches } = mod;
  const open = { type: "drop", path: "/a", status: "open" };
  const doing = { type: "ask", path: null, status: "in_progress" };
  const fixed = { type: "drop", path: "/a", status: "fixed" };
  assert.equal(matches(open, {}), true);
  assert.equal(matches(doing, {}), true);
  assert.equal(matches(fixed, {}), false);
  assert.equal(matches(fixed, { status: "fixed" }), true);
  assert.equal(matches(fixed, { status: "all" }), true);
  assert.equal(matches(open, { type: "ask" }), false);
  assert.equal(matches(open, { path: "/a" }), true);
  assert.equal(matches(doing, { path: "/a" }), false);
});

t("diff of a drafted fix", () => {
  const { diffLines, diffCounts } = mod;
  const before = "## Sign in\n\nRun `acme login`.\nPaste the code.";
  const after = "## Sign in\n\n1. Run `acme login`.\n2. Paste the code.\n\nBehind a proxy? Set HTTPS_PROXY.";
  const d = diffLines(before, after);
  assert.deepEqual(d.slice(0, 2), [{ op: " ", text: "## Sign in" }, { op: " ", text: "" }]);
  assert.deepEqual(diffCounts(d), { added: 4, removed: 2 });
  assert.deepEqual(diffLines("", "new"), [{ op: "+", text: "new" }]);
  assert.deepEqual(diffLines("same", "same"), [{ op: " ", text: "same" }]);
  const big = Array.from({ length: 700 }, (_, i) => `l${i}`).join("\n");
  assert.equal(diffCounts(diffLines(big, "x")).removed, 700);
});

t("retention points and addresses", () => {
  const { retentionPoints, editorHref, draftUsesAi, draftLabel } = mod;
  const pts = retentionPoints([100, 50, 25, 10], 40);
  assert.deepEqual(pts, [{ x: 5, y: 100 }, { x: 15, y: 50 }, { x: 25, y: 25 }, { x: 35, y: 10 }]);
  assert.equal(editorHref("/guides/s1", "p 1", "f1"), "/guides/s1?page=p%201&fix=f1");
  assert.equal(draftUsesAi("broken"), false);
  assert.equal(draftUsesAi("drop"), true);
  assert.equal(draftLabel("ask"), "Write an answer");
});

t("the sample list is ranked, fictional and complete", () => {
  const { demoItems, FIX_TYPES } = mod;
  const items = demoItems(Date.UTC(2026, 10, 2));
  assert.ok(items.length >= 6);
  const sorted = [...items].sort((a, b) => b.impact - a.impact);
  assert.equal(sorted[0].type, "drop");
  for (const it of items) {
    assert.ok(FIX_TYPES.includes(it.type));
    // impact = readers x severity x recency, as the backend scores it.
    assert.ok(Math.abs(it.impact - it.readers * it.severity * it.recency) / it.impact < 0.12, it.id);
    assert.ok(!/senseloaf/i.test(JSON.stringify(it)));
  }
  assert.equal(items[0].evidence.curve.length, 6);
});
