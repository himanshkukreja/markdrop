import { test } from "node:test";
import assert from "node:assert/strict";
import { askSegments, blocksOf, chipOf, sourcesOf } from "./askCore.mjs";

const CITES = [
  { label: "3", title: "Release notes", url: "https://x/rel", kind: "doc", slug: "rel" },
  { label: "1-s4", title: "Weekly sync · Nov 4", url: "https://x/t#b-t0004", kind: "page", slug: "t", moment: "Ada, 2:49" },
  { label: "1", title: "Weekly sync · Nov 4", url: "https://x/w", kind: "page", slug: "w" },
  { label: "1-s9", title: "Weekly sync · Nov 4", url: "https://x/t#b-t0009", kind: "page", slug: "t", moment: "Bo, 5:10" },
];

test("segments keep only known labels", () => {
  const segs = askSegments("Ship Friday [3] as said [1-s4]. Not [7] nor [1-s99].", ["3", "1-s4"]);
  assert.deepEqual(segs.map((s) => s.cite ?? null), [null, "3", null, "1-s4", null]);
  assert.equal(segs[4].text, ". Not [7] nor [1-s99].");
  assert.equal(segs[3].n, 1);
});

test("sources are numbered in first-cited order with moments nested", () => {
  const answer = "Ship Friday [3]. Ada said so [1-s4] and Bo agreed [1-s9], see the notes [1].";
  const src = sourcesOf(answer, CITES);
  assert.deepEqual(src.map((s) => [s.n, s.shown, s.title]), [[3, 1, "Release notes"], [1, 2, "Weekly sync · Nov 4"]]);
  assert.deepEqual(src[1].moments.map((m) => m.label), ["1-s4", "1-s9"]);
  assert.equal(src[1].url, "https://x/w");
  assert.equal(chipOf(src, "3"), "1");
  assert.equal(chipOf(src, "1-s9"), "2·2");
  assert.equal(chipOf(src, "1"), "2");
});

test("a moment alone opens its transcript", () => {
  const src = sourcesOf("Said here [1-s4].", CITES);
  assert.equal(src[0].url, "https://x/t#b-t0004");
  assert.equal(src[0].title, "Weekly sync");
});

test("blocks: paragraphs and bullet lists", () => {
  const b = blocksOf("You have 2 items.\n- Email Senseloaf [1]\n- Update docs [2]\n  by Wednesday\n\nThat's all.");
  assert.deepEqual(b, [
    { type: "p", text: "You have 2 items." },
    { type: "ul", items: ["Email Senseloaf [1]", "Update docs [2] by Wednesday"] },
    { type: "p", text: "That's all." },
  ]);
});
