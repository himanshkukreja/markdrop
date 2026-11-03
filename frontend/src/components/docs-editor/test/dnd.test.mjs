/**
 * Dragging blocks (menus/dropPlace.ts): where a drop lands, from the blocks under the pointer, and
 * the move itself. Regression: a block dropped on the top edge of the page's first block went
 * below it (ProseMirror's drop point came from the text position, the end of a short line).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@tiptap/pm/state";
import { placeDrop, moveSlice } from "../menus/dropPlace.ts";
import { schema } from "./helpers.mjs";
import { parseMarkdown, serializeMarkdown } from "../core/markdown.mjs";

const docOf = (md) => schema.nodeFromJSON(parseMarkdown(md).doc);
const texts = (doc) => {
  const out = [];
  doc.forEach((n) => out.push(n.textContent));
  return out;
};
/** Each top-level block, laid out 30px tall from y=100, as drop candidates. */
const rows = (doc) => {
  const out = [];
  let i = 0;
  doc.forEach((_n, pos) => {
    out.push({ pos, top: 100 + i * 30, bottom: 124 + i * 30 });
    i++;
  });
  return out;
};

function drag(md, index, y) {
  const doc = docOf(md);
  const cand = rows(doc);
  const src = cand[index];
  const node = doc.nodeAt(src.pos);
  const slice = doc.slice(src.pos, src.pos + node.nodeSize);
  const under = cand.filter((c) => y >= c.top - 6 && y <= c.bottom + 6).slice(0, 1);
  const place = placeDrop(doc, slice, under.length ? under : [cand[0]], y);
  assert.ok(place, "a place");
  const state = EditorState.create({ doc });
  const tr = state.tr;
  moveSlice(tr, slice, src.pos, src.pos + node.nodeSize, place.pos);
  return { place, doc: tr.doc };
}

test("a block dropped on the top edge of the first block goes above it", () => {
  for (const y of [100, 101, 102, 105, 111]) {
    const { place, doc } = drag("One\n\nTwo\n\nThree\n", 2, y);
    assert.equal(place.before, true, `y=${y}`);
    assert.equal(place.pos, 0);
    assert.deepEqual(texts(doc), ["Three", "One", "Two"], `y=${y}`);
  }
});

test("over a block's bottom half it goes below; between other blocks as before", () => {
  assert.deepEqual(texts(drag("One\n\nTwo\n\nThree\n", 2, 120).doc), ["One", "Three", "Two"]);
  assert.deepEqual(texts(drag("One\n\nTwo\n\nThree\n", 0, 150).doc), ["Two", "One", "Three"]);
  // Over the next block's top half: right where it is.
  assert.deepEqual(texts(drag("One\n\nTwo\n\nThree\n", 0, 135).doc), ["One", "Two", "Three"]);
  assert.deepEqual(texts(drag("One\n\nTwo\n\nThree\n", 0, 175).doc), ["Two", "Three", "One"]);
  // On itself: nothing changes.
  const doc = docOf("One\n\nTwo\n");
  const slice = doc.slice(0, doc.firstChild.nodeSize);
  const tr = EditorState.create({ doc }).tr;
  assert.equal(moveSlice(tr, slice, 0, doc.firstChild.nodeSize, 0), null);
  assert.equal(tr.docChanged, false);
});

test("a container that can't take the block passes to the next candidate", () => {
  // A paragraph dragged over a list item: not into the list (lists hold items), beside the list.
  const doc = docOf("Intro\n\n- a\n- b\n\nEnd\n");
  const listPos = doc.firstChild.nodeSize;
  const list = doc.nodeAt(listPos);
  const itemPos = listPos + 1;
  const slice = doc.slice(0, doc.firstChild.nodeSize);
  const place = placeDrop(doc, slice, [{ pos: itemPos, top: 130, bottom: 154 }, { pos: listPos, top: 130, bottom: 184 }], 132);
  assert.equal(place.pos, listPos);
  assert.ok(list);
  // Dropped there, the Markdown is the list after the paragraph, unchanged (the paragraph stays first).
  const tr = EditorState.create({ doc }).tr;
  assert.equal(moveSlice(tr, slice, 0, doc.firstChild.nodeSize, place.pos), null);
  const md = serializeMarkdown({ ...parseMarkdown("Intro\n\n- a\n- b\n\nEnd\n"), doc: tr.doc.toJSON() });
  assert.equal(md, "Intro\n\n- a\n- b\n\nEnd\n");
});
