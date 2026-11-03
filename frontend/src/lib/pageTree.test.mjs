import test from "node:test";
import assert from "node:assert/strict";
import { dropAt, subtree, moveIn, copyTitle, assetIdsIn, rewriteAssets, rewritePageLinks, imageName, readersText, TREE_INDENT } from "./pageTree.mjs";

// root
//   a
//     a1
//   b
const H = 24;
const rows = [
  { slug: "root", depth: 0, parent: null, ancestors: [], open: true, hasKids: true, kids: ["a", "b"] },
  { slug: "a", depth: 1, parent: "root", ancestors: ["root"], open: true, hasKids: true, kids: ["a1"] },
  { slug: "a1", depth: 2, parent: "a", ancestors: ["root", "a"], open: false, hasKids: false, kids: [] },
  { slug: "b", depth: 1, parent: "root", ancestors: ["root"], open: false, hasKids: false, kids: [] },
].map((r, i) => ({ ...r, top: i * H, bottom: (i + 1) * H }));
const at = (row, frac, depthX = 9) => ({ x: depthX * TREE_INDENT + 2, y: row * H + frac * H, left: 0 });
const dragB = { slug: "b", parent: "root", prev: "a", blocked: new Set() };
const dragA = { slug: "a", parent: "root", prev: null, blocked: new Set(["a1"]) };

test("dropAt: inside a row (its last sub-page)", () => {
  const d = dropAt(rows, at(2, 0.5), dragB);
  assert.equal(d.kind, "inside");
  assert.equal(d.parent, "a1");
  assert.equal(d.after, null);
  assert.ok(d.valid && !d.noop);
  const d2 = dropAt(rows, at(1, 0.5), dragB);
  assert.equal(d2.parent, "a");
  assert.equal(d2.after, "a1");
});

test("dropAt: before a row is a sibling above it", () => {
  const d = dropAt(rows, at(1, 0.1), dragB);
  assert.equal(d.kind, "before");
  assert.equal(d.parent, "root");
  assert.equal(d.after, null);
  assert.ok(d.valid && !d.noop);
  assert.equal(d.y, H);
});

test("dropAt: after an open row with sub-pages is its first sub-page", () => {
  const d = dropAt(rows, at(1, 0.9), dragB);
  assert.equal(d.parent, "a");
  assert.equal(d.after, null);
  assert.equal(d.depth, 2);
});

test("dropAt: after the end of a branch, the pointer's x picks the level", () => {
  const deep = dropAt(rows, at(2, 0.9, 9), dragB);
  assert.equal(deep.parent, "a");
  assert.equal(deep.after, "a1");
  const shallow = dropAt(rows, at(2, 0.9, 1), dragB);
  assert.equal(shallow.parent, "root");
  assert.equal(shallow.after, "a");
  // That's where b already is.
  assert.ok(shallow.noop);
  // The very last row: down to the top level.
  const top = dropAt(rows, at(3, 0.9, 0), dragA);
  assert.equal(top.parent, null);
  assert.equal(top.after, "root");
  const topLimited = dropAt(rows, at(3, 0.9, 0), { ...dragA, minDepth: 1 });
  assert.equal(topLimited.parent, "root");
});

test("dropAt: never into itself or its own sub-pages", () => {
  assert.equal(dropAt(rows, at(1, 0.5), dragA).valid, false);
  assert.equal(dropAt(rows, at(2, 0.5), dragA).valid, false);
  assert.equal(dropAt(rows, at(2, 0.1), dragA).valid, false);
  assert.equal(dropAt(rows, at(3, 0.5), dragA).valid, true);
});

test("dropAt: in its own place is a no-op", () => {
  assert.ok(dropAt(rows, at(3, 0.1), dragB).noop);
  assert.ok(dropAt(rows, at(0, 0.5), dragB).noop);
  assert.ok(!dropAt(rows, at(0, 0.5), dragA).noop);
});

test("dropAt: outside the rows clamps to the ends", () => {
  assert.equal(dropAt(rows, { x: 0, y: -10, left: 0 }, dragB).kind, "before");
  assert.equal(dropAt(rows, { x: 0, y: 999, left: 0 }, dragB).kind, "after");
  assert.equal(dropAt([], { x: 0, y: 0, left: 0 }, dragB), null);
});

test("subtree and moveIn", () => {
  const kids = { root: [{ slug: "a" }, { slug: "b" }], a: [{ slug: "a1" }], a1: [] };
  assert.deepEqual([...subtree("root", kids)].sort(), ["a", "a1", "b"]);
  assert.deepEqual([...subtree("a", kids)], ["a1"]);
  const m = moveIn(kids, "b", "root", "a", null);
  assert.deepEqual(m.root.map((k) => k.slug), ["a"]);
  assert.deepEqual(m.a.map((k) => k.slug), ["b", "a1"]);
  const m2 = moveIn(kids, "b", "root", "a", "a1");
  assert.deepEqual(m2.a.map((k) => k.slug), ["a1", "b"]);
  const m3 = moveIn(kids, "a", "root", "root", "b");
  assert.deepEqual(m3.root.map((k) => k.slug), ["b", "a"]);
  const m4 = moveIn(kids, "a1", "a", "root", undefined);
  assert.deepEqual(m4.root.map((k) => k.slug), ["a", "b", "a1"]);
  // The original is untouched.
  assert.deepEqual(kids.root.map((k) => k.slug), ["a", "b"]);
});

test("copyTitle numbers copies like Notion", () => {
  assert.equal(copyTitle("Plan"), "Plan (1)");
  assert.equal(copyTitle("Plan (1)"), "Plan (2)");
  assert.equal(copyTitle("Plan", ["Plan (1)", "Plan (2)"]), "Plan (3)");
  assert.equal(copyTitle(""), "Untitled (1)");
  assert.equal(copyTitle(null), "Untitled (1)");
});

test("page images: find and rewrite ids", () => {
  const md = "---\nicon: asset:ic1\ncover: asset:cv1\n---\n\n![a](asset:im1) ![b](asset\\:im2) ![c](asset:im1)\n\nasset:im10 stays\n";
  assert.deepEqual(assetIdsIn(md), ["ic1", "cv1", "im1", "im2", "im10"]);
  const out = rewriteAssets(md, { ic1: "N1", cv1: "N2", im1: "N3", im2: "N4" });
  assert.match(out, /icon: asset:N1/);
  assert.match(out, /cover: asset:N2/);
  assert.match(out, /!\[a\]\(asset:N3\) !\[b\]\(asset\\:N4\) !\[c\]\(asset:N3\)/);
  assert.match(out, /asset:im10 stays/);
});

test("sub-page links point at the copies", () => {
  const md = "::page{src=old-a}\n\n::page{src=\"old-b\"}\n\n::page{src=other}\n";
  assert.equal(rewritePageLinks(md, { "old-a": "new-a", "old-b": "new-b" }), "::page{src=new-a}\n\n::page{src=\"new-b\"}\n\n::page{src=other}\n");
});

test("imageName and readersText", () => {
  assert.equal(imageName("x", "image/jpeg"), "x.jpg");
  assert.equal(imageName("x", null), "x.png");
  assert.equal(readersText("members of Acme"), "members of Acme");
  assert.equal(readersText(null), "different people");
});
