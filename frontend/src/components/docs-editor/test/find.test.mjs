/** Find and replace: the same matching over the document (visual) and over the text (Markdown). */
import test from "node:test";
import assert from "node:assert/strict";
import { docMatches, nextIndex, replaceAllText, searchRegExp, textMatches } from "../core/find.mjs";
import { parseMarkdown } from "../core/markdown.mjs";
import { schema } from "./helpers.mjs";

const docOf = (md) => schema.nodeFromJSON(parseMarkdown(md).doc);

test("match case and whole word", () => {
  const t = "Order the order. Reorder? ORDER!";
  assert.equal(textMatches(t, "order").length, 4);
  assert.equal(textMatches(t, "order", { matchCase: true }).length, 2);
  assert.equal(textMatches(t, "order", { wholeWord: true }).length, 3);
  assert.equal(textMatches(t, "order", { wholeWord: true, matchCase: true }).length, 1);
  // Letters beyond ASCII are word characters too.
  assert.equal(textMatches("café cafés", "café", { wholeWord: true }).length, 1);
  assert.equal(searchRegExp(""), null);
  // Special characters are literal.
  assert.deepEqual(textMatches("a.b (c) a+b", "(c)"), [{ from: 4, to: 7 }]);
});

test("document matches map to positions inside their block, never across blocks", () => {
  const doc = docOf("# Pay\n\nWe accept **cards** and cards.\n\nCards\n");
  const ms = docMatches(doc, "cards");
  assert.equal(ms.length, 3);
  for (const m of ms) assert.equal(doc.textBetween(m.from, m.to).toLowerCase(), "cards");
  assert.equal(docMatches(doc, "cards and").length, 1);
  assert.equal(docMatches(doc, "Pay We").length, 0);
  // Inside containers too.
  const d2 = docOf(":::note\nA tip about cards\n:::\n");
  const [m] = docMatches(d2, "cards");
  assert.equal(d2.textBetween(m.from, m.to), "cards");
});

test("next and previous wrap around", () => {
  const ms = [{ from: 5, to: 7 }, { from: 20, to: 22 }];
  assert.equal(nextIndex(ms, 0, 1), 0);
  assert.equal(nextIndex(ms, 10, 1), 1);
  assert.equal(nextIndex(ms, 30, 1), 0);
  assert.equal(nextIndex(ms, 10, -1), 0);
  assert.equal(nextIndex(ms, 3, -1), 1);
  assert.equal(nextIndex([], 3, 1), -1);
});

test("replace all in Markdown text", () => {
  assert.deepEqual(replaceAllText("cat, Cat, concat", "cat", "dog", { wholeWord: true }), { text: "dog, dog, concat", count: 2 });
  assert.deepEqual(replaceAllText("x", "y", "z"), { text: "x", count: 0 });
});
