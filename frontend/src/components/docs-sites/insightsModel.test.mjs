/**
 * The Insights tab's words and tones (insightsModel.ts).
 * Runs on node's TypeScript type stripping (node ≥ 22.18); skipped without it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

let mod = null;
try {
  mod = await import("./insightsModel.ts");
} catch (e) {
  if (!/Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION|strip/i.test(String(e?.message ?? e))) throw e;
}
const t = mod ? test : test.skip;

t("change against the previous period", () => {
  const { change } = mod;
  assert.deepEqual(change(118, 100, "30 days"), { dir: "up", text: "18% vs previous 30 days", tone: "success" });
  assert.deepEqual(change(80, 100, "7 days"), { dir: "down", text: "20% vs previous 7 days", tone: "danger" });
  assert.deepEqual(change(100, 100, "7 days"), { dir: "flat", text: "No change vs previous 7 days", tone: "muted" });
  assert.deepEqual(change(5, 0, "7 days"), { dir: "up", text: "New vs previous 7 days", tone: "success" });
  assert.equal(change(0, 0, "7 days"), null);
  assert.equal(change(5, null, "7 days"), null);
  assert.equal(change(null, 5, "7 days"), null);
  // Percentages change in points.
  assert.deepEqual(change(88, 80, "30 days", true), { dir: "up", text: "8 pts vs previous 30 days", tone: "success" });
  assert.equal(change(88, null, "30 days", true), null);
});

t("helpful tone and the couldn't-find note", () => {
  const { helpfulTone, missingNote } = mod;
  assert.equal(helpfulTone(64), "danger");
  assert.equal(helpfulTone(70), "success");
  assert.equal(helpfulTone(null), "muted");
  assert.equal(missingNote({ searches: 41, unanswered: 0 }), "41 searches, no results");
  assert.equal(missingNote({ searches: 1, unanswered: 0 }), "1 search, no results");
  assert.equal(missingNote({ searches: 0, unanswered: 12 }), "Ask AI had no answer · 12×");
  assert.equal(missingNote({ searches: 1234, unanswered: 2 }), "1,234 searches, no results · Ask AI had no answer · 2×");
});

t("a page title from a query", () => {
  const { titleFromQuery, newPageHref } = mod;
  assert.equal(titleFromQuery("cancel subscription"), "Cancel subscription");
  assert.equal(titleFromQuery("  \"invoice   download\" "), "Invoice download");
  assert.equal(titleFromQuery("Can I change the delivery date?"), "Can I change the delivery date");
  assert.equal(titleFromQuery("sso?!"), "Sso");
  assert.equal(titleFromQuery(""), "");
  const long = titleFromQuery("word ".repeat(60));
  assert.ok(long.length <= 120 && !long.endsWith(" "), long);
  assert.equal(newPageHref("/guides/abc", "Ship to Sri Lanka & more"), "/guides/abc?new=Ship%20to%20Sri%20Lanka%20%26%20more");
});

t("inline bar widths", () => {
  const { barWidth } = mod;
  assert.equal(barWidth(1920, 1920), "100%");
  assert.equal(barWidth(806, 1920), "42%");
  assert.equal(barWidth(1, 10000), "2%");
  assert.equal(barWidth(0, 10), "0%");
  assert.equal(barWidth(3, 0), "0%");
});
