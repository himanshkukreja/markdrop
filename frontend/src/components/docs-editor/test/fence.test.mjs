/** Code-fence meta and directive label helpers used by the block forms. */
import test from "node:test";
import assert from "node:assert/strict";
import { readMeta, setMetaTitle, setMetaWrap, labelText, textLabel } from "../core/fence.mjs";
import { parseMarkdown, serializeMarkdown } from "../core/markdown.mjs";

test("reads title and wrap like the renderer", () => {
  assert.deepEqual(readMeta('title="Install it" wrap {2}'), { title: "Install it", wrap: true });
  assert.deepEqual(readMeta("title='a b'"), { title: "a b", wrap: false });
  assert.deepEqual(readMeta('title="wrap"'), { title: "wrap", wrap: false });
  assert.deepEqual(readMeta(null), { title: "", wrap: false });
});

test("changes one part of the meta and keeps the rest", () => {
  assert.equal(setMetaTitle('title="Old" {1,3} wrap', "New"), 'title="New" {1,3} wrap');
  assert.equal(setMetaTitle("{2}", "T"), '{2} title="T"');
  assert.equal(setMetaTitle('title="Old" wrap', ""), "wrap");
  assert.equal(setMetaTitle(null, 'Say "hi"'), "title=\"Say 'hi'\"");
  assert.equal(setMetaWrap('title="x"', true), 'title="x" wrap');
  assert.equal(setMetaWrap('title="x" wrap {2}', false), 'title="x" {2}');
  assert.equal(setMetaWrap("wrap", false), null);
});

test("labels typed with brackets stay inside their brackets", () => {
  const label = textLabel("Step [1] \\ done");
  assert.equal(labelText(label), "Step [1] \\ done");
  const st = parseMarkdown(":::note\nBody\n:::\n");
  st.doc.content[0].attrs.label = label;
  const out = serializeMarkdown(st);
  const back = parseMarkdown(out).doc.content[0];
  assert.equal(back.type, "callout");
  assert.equal(labelText(back.attrs.label), "Step [1] \\ done");
  assert.equal(textLabel(""), null);
});
