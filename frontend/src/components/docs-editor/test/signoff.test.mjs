/**
 * The sign-off block (`:::signoff{#b-x person=… label=… options="A|B" lock=above}` … `:::`): a
 * container the editor models (never raw), round-tripped byte for byte, written canonically when
 * edited, its body kept, unknown attributes kept, and new blocks given ids of their own.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@tiptap/pm/state";
import { parseMarkdown, serializeMarkdown } from "../core/markdown.mjs";
import { signoffIds } from "../core/schema.mjs";
import { schema, throughEditor, clone } from "./helpers.mjs";

const HEAD = ':::signoff{#b-rel001 person="6650f0c2a1" label="Release approval" options="Approved for production|Not approved" lock=above}';

function find(n, type) {
  if (n.type === type) return n;
  for (const k of n.content ?? []) {
    const hit = find(k, type);
    if (hit) return hit;
  }
  return null;
}

test("a sign-off is a block of its own, with its attributes and body", () => {
  const md = `## Release\n\nNotes.\n\n${HEAD}\nQA passed.\n:::\n`;
  const { json, out } = throughEditor(md);
  assert.equal(out, md);
  const s = find(json, "signoff");
  assert.ok(s, "no signoff node");
  assert.deepEqual(s.attrs.attributes, { id: "b-rel001", person: "6650f0c2a1", label: "Release approval", options: "Approved for production|Not approved", lock: "above" });
  assert.equal(s.content[0].type, "paragraph");
  assert.equal(find(json, "rawBlock"), null);
});

test("empty, nested, unclosed-looking and odd forms round-trip", () => {
  for (const md of [
    ':::signoff{#b-a1b2c3 person="u1"}\n:::\n',
    ':::signoff{person="u1" label="No id yet"}\nBody.\n:::\n',
    ':::signoff{#b-a1b2c3 person="u1" option="Approved" signed_by="Someone"}\nForged text.\n:::\n',
    '::::columns\n:::column\n:::signoff{#b-c1 person="u1"}\n:::\n:::\n\n:::column\nRight.\n:::\n::::\n',
    '- A list\n\n:::signoff{#b-zzzz person="u1" options="Yes|No|Later"}\n- [ ] item\n- [x] done\n:::\n',
  ]) {
    const { out } = throughEditor(md);
    assert.equal(out, md, md);
  }
});

test("editing the label rewrites only the head; the body is kept", () => {
  const md = `Intro.\n\n${HEAD}\nQA *passed*.\n:::\n\nAfter.\n`;
  const state = parseMarkdown(md);
  const doc = clone(schema.nodeFromJSON(state.doc).toJSON());
  const s = find(doc, "signoff");
  s.attrs.attributes = { ...s.attrs.attributes, label: 'Go "live"' };
  const out = serializeMarkdown({ ...state, doc });
  assert.equal(
    out,
    'Intro.\n\n:::signoff{#b-rel001 person="6650f0c2a1" label="Go &quot;live&quot;" options="Approved for production|Not approved" lock="above"}\nQA *passed*.\n:::\n\nAfter.\n',
  );
  // …and it reads back as the same block.
  const again = find(parseMarkdown(out).doc, "signoff");
  assert.equal(again.attrs.attributes.label, 'Go "live"');
  assert.equal(again.attrs.attributes.lock, "above");
});

test("a sign-off inside another container: the outer fence has more colons, also when written canonically", () => {
  const md = '::::details{summary="Approvals"}\n:::signoff{#b-inn1 person="u1"}\nOK?\n:::\n::::\n';
  const { out, state } = throughEditor(md);
  assert.equal(out, md);
  assert.equal(serializeMarkdown(state, { preserve: false }), md);
  assert.ok(find(parseMarkdown(md).doc, "signoff"));
});

test("a sign-off added by an edit gets an id; taken ones are replaced; loads are left alone", () => {
  const md = ':::signoff{#b-same1 person="u1"}\n:::\n';
  const doc = schema.nodeFromJSON(parseMarkdown(md).doc);
  const node = doc.firstChild;
  const plain = schema.nodes.signoff.create({ ...node.attrs, attributes: { person: "u2" }, md: null }, schema.nodes.paragraph.create());
  const start = EditorState.create({ schema, doc, plugins: [signoffIds()] });
  // A copy of the block (same id) and a new one without: both get their own (appendTransaction).
  const res = start.applyTransaction(start.tr.insert(doc.content.size, node.copy(node.content)).insert(doc.content.size + node.nodeSize, plain));
  const out = [];
  res.state.doc.forEach((n) => out.push(n.attrs.attributes?.id));
  assert.equal(out[0], "b-same1");
  assert.equal(out.length, 3);
  assert.ok(out.every((id) => /^b-[a-z0-9]{4,12}$/.test(id)), String(out));
  assert.equal(new Set(out).size, 3);
  // A load (setContent passes preventUpdate) changes nothing.
  const loaded = EditorState.create({ schema, doc, plugins: [signoffIds()] });
  const r2 = loaded.applyTransaction(loaded.tr.insert(doc.content.size, plain).setMeta("preventUpdate", true));
  const kept = [];
  r2.state.doc.forEach((n) => kept.push(n.attrs.attributes?.id));
  assert.deepEqual(kept, ["b-same1", undefined]);
});
