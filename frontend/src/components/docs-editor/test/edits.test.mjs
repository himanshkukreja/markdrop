/**
 * Simulated editing over the whole corpus: whatever the editor does to the document (re-typing a
 * block, typing into it, dragging blocks around, moving blocks between containers, deleting), the
 * Markdown it writes must read back as exactly the edited document, and an edit must not rewrite
 * the parts of the page it didn't touch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { corpus, read, schema, blocks, containers, clone, rng, shuffle, blockPrints } from "./helpers.mjs";
import { fp, parseMarkdown, serializeMarkdown } from "../core/markdown.mjs";

const pages = corpus().flatMap((c) => c.files);
const SAMPLE = Number(process.env.DOCS_EDITOR_SAMPLE ?? 12);

/** The editor's view of a page: schema-normalized JSON. */
function load(src) {
  const state = parseMarkdown(src);
  return { state, doc: schema.nodeFromJSON(state.doc).toJSON() };
}

/** Writes `doc`, reads it back, and checks the blocks match `doc`'s (ProseMirror-normalized). */
function check(state, doc, label) {
  const normalized = schema.nodeFromJSON(doc);
  normalized.check();
  const json = normalized.toJSON();
  const out = serializeMarkdown({ ...state, doc: json });
  const back = parseMarkdown(out, { verify: false }).doc;
  const a = blockPrints(back), b = blockPrints(json);
  if (a.join() !== b.join()) {
    const i = a.findIndex((x, k) => x !== b[k]);
    const blocksOf = (d) => (d.content ?? []).filter((n) => !(n.type === "paragraph" && !(n.content ?? []).length));
    const show = (n) => (n ? JSON.stringify(n, (k, v) => (k === "md" ? undefined : v)).slice(0, 1500) : "(none)");
    assert.fail(`${label}: written Markdown reads back differently at block ${i}\nexpected: ${show(blocksOf(json)[i])}\nactual:   ${show(blocksOf(back)[i])}`);
  }
  return out;
}

/** Lines that differ between two texts, after removing the common prefix and suffix. */
function changedLines(a, b) {
  const x = a.split("\n"), y = b.split("\n");
  let s = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let e = 0;
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  return x.length - s - e;
}

test("re-typing any block (same content, canonical form) keeps the page's meaning", () => {
  const rand = rng(1);
  let n = 0;
  for (const f of pages) {
    const src = read(f);
    const { state, doc } = load(src);
    const all = blocks(doc);
    for (const pick of shuffle(all.map((_, i) => i), rand).slice(0, SAMPLE)) {
      const d = clone(doc);
      const target = blocks(d)[pick].node;
      target.attrs.md = { ...target.attrs.md, fp: "stale" };
      check(state, d, `${path.basename(f)} block #${pick} (${target.type})`);
      n++;
    }
  }
  assert.ok(n > 500, `only ${n} blocks exercised`);
});

/** The first and last text nodes of a textblock, if any. */
function lastText(n) {
  const kids = n.content ?? [];
  for (let i = kids.length - 1; i >= 0; i--) if (kids[i].type === "text") return kids[i];
  return null;
}

test("typing into a paragraph, heading or table cell rewrites only that block", () => {
  const rand = rng(2);
  let n = 0;
  for (const f of pages) {
    const src = read(f);
    const { state, doc } = load(src);
    const targets = [];
    const visit = (node, top) => {
      for (const k of node.content ?? []) {
        const t = top ?? k;
        if ((k.type === "paragraph" || k.type === "heading" || k.type === "tableCell" || k.type === "tableHeader") && lastText(k)) targets.push({ k, t });
        visit(k, t);
      }
    };
    visit(doc, null);
    for (const pick of shuffle(targets.map((_, i) => i), rand).slice(0, SAMPLE)) {
      const d = clone(doc);
      const found = [];
      visit.call(null, d, null);
      const again = [];
      const walk = (node, top) => {
        for (const k of node.content ?? []) {
          const t = top ?? k;
          if ((k.type === "paragraph" || k.type === "heading" || k.type === "tableCell" || k.type === "tableHeader") && lastText(k)) again.push({ k, t });
          walk(k, t);
        }
      };
      walk(d, null);
      void found;
      const { k, t } = again[pick];
      // Characters Markdown would read as syntax must come back as the literal text typed.
      lastText(k).text += " — edited *x* [y] `z` <b> | 10:30 :kbd[k] $5 \\ #1";
      const out = check(state, d, `${path.basename(f)} text #${pick}`);
      const top = t.attrs?.md?.src ?? "";
      assert.ok(changedLines(src, out) <= top.split("\n").length, `${path.basename(f)}: edit changed lines outside its block`);
      n++;
    }
  }
  assert.ok(n > 300, `only ${n} edits exercised`);
});

test("dragging blocks into any order (top level and inside containers)", () => {
  const rand = rng(3);
  for (const f of pages) {
    const src = read(f);
    const { state, doc } = load(src);
    for (let round = 0; round < 4; round++) {
      const d = clone(doc);
      for (const c of containers(d)) {
        if (c.type === "listItem") continue; // a list item's first child must stay its paragraph
        if (round === 0 && c.type !== "doc") continue; // round 0: top level only
        c.content = shuffle(c.content, rand);
      }
      check(state, d, `${path.basename(f)} shuffle ${round}`);
    }
  }
});

test("moving blocks between containers, and deleting blocks", () => {
  const rand = rng(4);
  for (const f of pages) {
    const src = read(f);
    const { state, doc } = load(src);
    for (let round = 0; round < 6; round++) {
      const d = clone(doc);
      const all = blocks(d).filter((b) => b.node.type !== "tab" && b.node.type !== "card" && b.node.type !== "tableRow");
      if (!all.length) continue;
      const from = all[Math.floor(rand() * all.length)];
      const [moved] = from.arr.splice(from.i, 1);
      if (!from.arr.length) from.arr.push({ type: "paragraph", attrs: { md: null }, content: [] });
      if (round % 3 === 2) {
        check(state, d, `${path.basename(f)} delete ${moved.type}`);
        continue;
      }
      // Targets: free flow containers (not list items: two paragraphs in a tight item make it loose).
      const targets = containers(d).filter((c) => c.type !== "listItem" && !isInside(c, moved));
      const to = targets[Math.floor(rand() * targets.length)];
      to.content.splice(Math.floor(rand() * (to.content.length + 1)), 0, moved);
      check(state, d, `${path.basename(f)} move ${moved.type} → ${to.type}`);
    }
  }
});

function isInside(c, moved) {
  if (c === moved) return true;
  return (moved.content ?? []).some((k) => isInside(c, k));
}

test("an untouched page stays byte-identical after unrelated edits elsewhere are undone", () => {
  // Editing a block and restoring its text brings its fingerprint back, so its source is reused.
  for (const f of pages.slice(0, 30)) {
    const src = read(f);
    const { state, doc } = load(src);
    const d = clone(doc);
    const t = blocks(d).find((b) => b.node.type === "paragraph" && lastText(b.node));
    if (!t) continue;
    const text = lastText(t.node);
    const before = text.text;
    text.text += " edited";
    assert.notEqual(serializeMarkdown({ ...state, doc: d }), src);
    text.text = before;
    assert.equal(serializeMarkdown({ ...state, doc: d }), src);
    assert.equal(fp(t.node), t.node.attrs.md.fp);
  }
});
