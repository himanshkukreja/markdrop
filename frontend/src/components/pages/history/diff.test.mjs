import { test } from "node:test";
import assert from "node:assert/strict";
import { diffBlocks, diffStats, splitBlocks, stripFront } from "./diff.mjs";

test("front matter is not part of the body", () => {
  assert.equal(stripFront("---\nicon: 🚀\n---\n# T\n"), "# T\n");
  assert.equal(stripFront("# T"), "# T");
});

test("blocks keep containers, fences, tables and their options whole", () => {
  const md = [
    "---", "cover: gallery:mist", "---",
    "# Title", "Intro", "", "- a", "- b", "", "  continued", "",
    ":::note", "hello", "", "world", ":::", "",
    "```js", "x", "", "y", "```", "",
    "| a | b |", "|---|---|", "| 1 | 2 |", "", "{header-column}", "",
    "::::columns", ":::column", "one", "", ":::", ":::column", "two", ":::", "::::", "",
    "$$", "x^2", "", "$$", "", "End.",
  ].join("\n");
  assert.deepEqual(splitBlocks(md), [
    "# Title", "Intro", "- a\n- b\n\n  continued", ":::note\nhello\n\nworld\n:::", "```js\nx\n\ny\n```",
    "| a | b |\n|---|---|\n| 1 | 2 |\n\n{header-column}",
    "::::columns\n:::column\none\n\n:::\n:::column\ntwo\n:::\n::::", "$$\nx^2\n\n$$", "End.",
  ]);
});

test("changes: removed first, then added, between the common blocks", () => {
  const segs = diffBlocks("# A\n\nkeep\n\nold\n\ntail", "# A\n\nkeep\n\nnew\n\nextra\n\ntail");
  assert.deepEqual(segs, [
    { kind: "same", blocks: ["# A", "keep"] },
    { kind: "del", blocks: ["old"] },
    { kind: "add", blocks: ["new", "extra"] },
    { kind: "same", blocks: ["tail"] },
  ]);
  assert.deepEqual(diffStats(segs), { added: 2, removed: 1 });
});

test("identical pages and trailing spaces are the same", () => {
  assert.deepEqual(diffBlocks("a  \n\nb", "a\n\nb"), [{ kind: "same", blocks: ["a", "b"] }]);
  assert.deepEqual(diffBlocks("", ""), []);
});

test("moved blocks show as a removal and an addition", () => {
  const segs = diffBlocks("one\n\ntwo\n\nthree", "three\n\none\n\ntwo");
  assert.deepEqual(diffStats(segs), { added: 1, removed: 1 });
});

test("an empty version against a page: all removed", () => {
  assert.deepEqual(diffBlocks("a\n\nb", ""), [{ kind: "del", blocks: ["a", "b"] }]);
});
