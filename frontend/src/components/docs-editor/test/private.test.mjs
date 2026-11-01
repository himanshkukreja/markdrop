/**
 * Private sections in the editor: `:::private[title]{access="<rule>"}` is a block (not raw
 * Markdown), round-trips byte for byte, keeps its rule when edited, and a new one is written the way
 * the docs engine reads it (frontend/src/docs/access.mjs).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, serializeMarkdown } from "../core/markdown.mjs";
import { schema, throughEditor, p } from "./helpers.mjs";

const one = (md) => parseMarkdown(md).doc.content[0];
function write(...content) {
  const doc = schema.nodeFromJSON({ type: "doc", content }).toJSON();
  return serializeMarkdown({ doc, front: "", lead: "", tail: "\n", eol: "\n", bom: "", empty: false });
}

test("a private section is a block with its rule and title", () => {
  const n = one(':::private[Tenant values]{access="northwind"}\nThe id.\n:::\n');
  assert.equal(n.type, "private");
  assert.equal(n.attrs.label, "Tenant values");
  assert.deepEqual(n.attrs.attributes, { access: "northwind" });
  assert.equal(one(":::private\nTeam only.\n:::\n").type, "private");
});

test("round trips, nested containers included", () => {
  for (const md of [
    ':::private[Tenant values]{access="northwind"}\nThe id is `urn:x`.\n:::\n',
    ':::private\nTeam only.\n:::\n',
    '::::private{access="partners"}\n:::warning\nCareful.\n:::\n\nMore.\n::::\n',
    'Before.\n\n:::private{access="northwind"}\n## A heading\n\n- one\n- two\n:::\n\nAfter.\n',
  ]) {
    assert.equal(throughEditor(md).out, md, md);
  }
});

test("a new private section is written for the engine", () => {
  assert.equal(write({ type: "private", attrs: { label: null, attributes: { access: "members" } }, content: [p("Hi")] }), ':::private{access="members"}\nHi\n:::\n');
  assert.equal(write({ type: "private", attrs: { label: "Rates", attributes: { access: "partners" } }, content: [p("X")] }), ':::private[Rates]{access="partners"}\nX\n:::\n');
});
