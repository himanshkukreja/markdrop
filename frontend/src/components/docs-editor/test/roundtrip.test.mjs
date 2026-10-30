/**
 * Every page of every corpus: Markdown → editor (schema-checked ProseMirror JSON) → Markdown must
 * be byte-identical, and the fully canonical serialization (no source reuse at all, i.e. what you'd
 * get if every block had been edited) must read back as the same content.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { corpus, read, throughEditor, sameContent, DOCS_DIR } from "./helpers.mjs";
import { parseMarkdown, serializeMarkdown } from "../core/markdown.mjs";

function countRaw(n) {
  return (n.type === "rawBlock" || n.type === "rawInline" ? 1 : 0) + (n.content ?? []).reduce((s, k) => s + countRaw(k), 0);
}

for (const { name, files } of corpus()) {
  test(`round trip: ${name} (${files.length} pages)`, async (t) => {
    let identical = 0;
    let canonicalIdentical = 0;
    for (const f of files) {
      const src = read(f);
      const rel = path.relative(path.dirname(DOCS_DIR), f);
      const { state, json, out } = throughEditor(src);
      assert.equal(out, src, `${rel}: not byte-identical after the round trip`);
      identical++;
      const canonical = serializeMarkdown({ ...state, doc: json }, { preserve: false });
      if (canonical === src) canonicalIdentical++;
      assert.ok(sameContent(canonical, src), `${rel}: canonical Markdown reads back differently`);
      // Canonical output is a fixed point: serializing it again changes nothing.
      const again = parseMarkdown(canonical);
      assert.equal(serializeMarkdown(again, { preserve: false }), canonical, `${rel}: canonical form is not stable`);
    }
    t.diagnostic(`${identical}/${files.length} byte-identical; ${canonicalIdentical}/${files.length} identical even when fully re-serialized`);
  });
}

test("content/docs pages need no raw (Markdown-only) blocks", () => {
  const [{ files }] = corpus();
  for (const f of files) {
    const { doc } = parseMarkdown(read(f));
    assert.equal(countRaw(doc), 0, `${path.basename(f)} has raw blocks`);
  }
});
