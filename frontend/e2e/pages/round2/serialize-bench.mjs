/**
 * Node benchmark: what the editor's autosave costs on the 300-block page. Parse once, then type a
 * character in the 40th paragraph and serialize (preserve mode, as the editor does), many times.
 *   node serialize-bench.mjs
 */
import { performance } from "node:perf_hooks";
import { parseMarkdown, serializeMarkdown } from "../../../src/components/docs-editor/core/markdown.mjs";
import { schema } from "../../../src/components/docs-editor/test/helpers.mjs";
import { page300 } from "./page300.mjs";

const src = page300();
let t = performance.now();
const state = parseMarkdown(src);
const parseMs = performance.now() - t;
let doc = schema.nodeFromJSON(state.doc).toJSON();
t = performance.now();
const first = serializeMarkdown({ ...state, doc });
const firstMs = performance.now() - t;
if (first !== src) console.log("note: the unchanged page doesn't serialize to its source");

// Edit: append a character to the 40th paragraph, then serialize; repeat.
let paras = 0;
const target = doc.content.findIndex((n) => n.type === "paragraph" && paras++ === 40);
const times = [];
for (let i = 0; i < 40; i++) {
  const p = doc.content[target];
  const last = p.content[p.content.length - 1];
  p.content = [...p.content.slice(0, -1), { ...last, text: last.text + "x" }];
  doc = { ...doc, content: [...doc.content] };
  t = performance.now();
  serializeMarkdown({ ...state, doc });
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
console.log(JSON.stringify({ chars: src.length, parse_ms: +parseMs.toFixed(1), serialize_unchanged_ms: +firstMs.toFixed(1), serialize_after_edit_ms: { median: +times[20].toFixed(2), max: +times[39].toFixed(2) } }, null, 1));
