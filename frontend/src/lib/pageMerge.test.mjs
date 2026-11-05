import test from "node:test";
import assert from "node:assert/strict";
import { diffLines, merge3 } from "./pageMerge.mjs";

const apply = (a, edits) => {
  const out = [];
  let i = 0;
  for (const e of edits) {
    while (i < e.start) out.push(a[i++]);
    out.push(...e.lines);
    i = e.end;
  }
  while (i < a.length) out.push(a[i++]);
  return out;
};

test("diffLines turns a into b (random cases)", () => {
  let seed = 7;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let t = 0; t < 400; t++) {
    const a = Array.from({ length: rnd(14) }, () => "abcde"[rnd(5)]);
    const b = a.slice();
    for (let k = rnd(5); k > 0; k--) {
      const op = rnd(3), at = rnd(b.length + 1);
      if (op === 0) b.splice(at, 0, "xyz"[rnd(3)]);
      else if (op === 1 && b.length) b.splice(Math.min(at, b.length - 1), 1);
      else if (b.length) b[Math.min(at, b.length - 1)] = "q";
    }
    const edits = diffLines(a, b);
    assert.deepEqual(apply(a, edits), b, JSON.stringify({ a, b, edits }));
    for (let i = 1; i < edits.length; i++) assert.ok(edits[i].start > edits[i - 1].end, "edits never touch");
  }
});

test("diffLines: identical and empty", () => {
  assert.deepEqual(diffLines(["a"], ["a"]), []);
  assert.deepEqual(diffLines([], ["a"]), [{ start: 0, end: 0, lines: ["a"] }]);
  assert.deepEqual(diffLines(["a"], []), [{ start: 0, end: 1, lines: [] }]);
});

const BASE = "---\nicon: 📄\n---\n# Plan\n\nIntro paragraph.\n\n## Goals\n\n- one\n- two\n- three\n\n## Notes\n\nLast words.\n";

test("trivial cases", () => {
  assert.equal(merge3(BASE, BASE, BASE).content, BASE);
  assert.equal(merge3(BASE, BASE + "x", BASE).content, BASE + "x");
  assert.equal(merge3(BASE, BASE, BASE + "y").content, BASE + "y");
  assert.equal(merge3(BASE, "same", "same").content, "same");
});

test("edits to different paragraphs both survive", () => {
  const mine = BASE.replace("Intro paragraph.", "Intro paragraph, edited by Ada.");
  const theirs = BASE.replace("Last words.", "Last words, edited by an AI app.");
  const r = merge3(BASE, mine, theirs);
  assert.equal(r.clean, true);
  assert.match(r.content, /edited by Ada/);
  assert.match(r.content, /edited by an AI app/);
});

test("neighbouring list items merge", () => {
  const mine = BASE.replace("- one", "- one (Ada)");
  const theirs = BASE.replace("- two", "- two (Ben)");
  const r = merge3(BASE, mine, theirs);
  assert.equal(r.clean, true);
  assert.match(r.content, /- one \(Ada\)\n- two \(Ben\)\n- three/);
});

test("front matter keys changed on both sides merge", () => {
  const mine = BASE.replace("icon: 📄\n", "icon: 📄\ncover: gallery:dunes\n");
  const theirs = BASE.replace("# Plan", "# Plan v2");
  const r = merge3(BASE, mine, theirs);
  assert.equal(r.clean, true);
  assert.match(r.content, /cover: gallery:dunes/);
  assert.match(r.content, /# Plan v2/);
});

test("two appends at the end: theirs then mine, nothing lost", () => {
  const mine = BASE + "\nMy new paragraph.\n";
  const theirs = BASE + "\nAppended by the AI.\n";
  const r = merge3(BASE, mine, theirs);
  assert.equal(r.clean, true);
  const a = r.content.indexOf("Appended by the AI."), b = r.content.indexOf("My new paragraph.");
  assert.ok(a > 0 && b > a, r.content);
});

test("same appended text on both sides is kept once", () => {
  const r = merge3(BASE, BASE + "\nSame.\n", BASE + "\nSame.\n");
  assert.equal(r.content.split("Same.").length, 2);
});

test("the same line changed differently is a conflict; both versions are kept", () => {
  const mine = BASE.replace("Intro paragraph.", "Intro by Ada.");
  const theirs = BASE.replace("Intro paragraph.", "Intro by the AI.");
  const r = merge3(BASE, mine, theirs);
  assert.equal(r.clean, false);
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual(r.conflicts[0], { base: "Intro paragraph.", mine: "Intro by Ada.", theirs: "Intro by the AI." });
  assert.match(r.content, /Intro by the AI\./);
  assert.doesNotMatch(r.content, /Intro by Ada/);
  assert.match(r.mineContent, /Intro by Ada\./);
  assert.match(r.bothContent, /Intro by the AI\.\n\nIntro by Ada\./);
});

test("a conflict elsewhere doesn't stop clean stretches merging", () => {
  const mine = BASE.replace("Intro paragraph.", "Intro by Ada.").replace("- three", "- three (Ada)");
  const theirs = BASE.replace("Intro paragraph.", "Intro by the AI.").replace("Last words.", "Final words.");
  const r = merge3(BASE, mine, theirs);
  assert.equal(r.clean, false);
  for (const s of [r.content, r.mineContent]) {
    assert.match(s, /- three \(Ada\)/);
    assert.match(s, /Final words\./);
  }
});

test("one side deletes a section the other edited: conflict", () => {
  const mine = BASE.replace("## Notes\n\nLast words.\n", "");
  const theirs = BASE.replace("Last words.", "Last words, longer.");
  const r = merge3(BASE, mine, theirs);
  assert.equal(r.clean, false);
  assert.match(r.content, /Last words, longer/);
});

test("one side deletes a section the other didn't touch: deleted", () => {
  const mine = BASE.replace("## Notes\n\nLast words.\n", "");
  const theirs = BASE.replace("Intro paragraph.", "Intro, changed.");
  const r = merge3(BASE, mine, theirs);
  assert.equal(r.clean, true);
  assert.doesNotMatch(r.content, /Last words/);
  assert.match(r.content, /Intro, changed/);
});

test("large page with small edits at both ends stays fast and exact", () => {
  const lines = Array.from({ length: 20000 }, (_, i) => `Line ${i} of a long transcript.`);
  const base = lines.join("\n");
  const mine = ["Top edit", ...lines.slice(1)].join("\n");
  const theirs = [...lines.slice(0, -1), "Bottom edit"].join("\n");
  const t0 = Date.now();
  const r = merge3(base, mine, theirs);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(r.clean, true);
  assert.ok(r.content.startsWith("Top edit\n") && r.content.endsWith("\nBottom edit"));
});

test("everything rewritten on both sides: one conflict, both kept", () => {
  const base = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n");
  const mine = Array.from({ length: 3000 }, (_, i) => `m${i}`).join("\n");
  const theirs = Array.from({ length: 3000 }, (_, i) => `t${i}`).join("\n");
  const r = merge3(base, mine, theirs);
  assert.equal(r.clean, false);
  assert.equal(r.content, theirs);
  assert.equal(r.mineContent, mine);
  assert.equal(r.bothContent, `${theirs}\n\n${mine}`);
});
