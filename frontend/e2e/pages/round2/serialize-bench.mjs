/**
 * Node benchmark: what the editor's autosave costs on the 300-block page. Parse once, then type a
 * character in the 40th paragraph and serialize (preserve mode, as the editor does), many times.
 *   node serialize-bench.mjs
 */
import { performance } from "node:perf_hooks";
import inspector from "node:inspector";
import { parseMarkdown, serializeMarkdown } from "../../../src/components/docs-editor/core/markdown.mjs";
import { schema } from "../../../src/components/docs-editor/test/helpers.mjs";
import { page300 } from "./page300.mjs";

const src = page300();
let t = performance.now();
const state = parseMarkdown(src);
const parseMs = performance.now() - t;
const warm = [];
const session = process.env.PROFILE ? new inspector.Session() : null;
if (session) {
  session.connect();
  await new Promise((r) => session.post("Profiler.enable", () => session.post("Profiler.start", r)));
}
for (let i = 0; i < 5; i++) {
  t = performance.now();
  parseMarkdown(src);
  warm.push(performance.now() - t);
}
if (session) {
  // Where parsing spends its time: inclusive time per function (each once per sample).
  const { profile } = await new Promise((r) => session.post("Profiler.stop", (_e, v) => r(v)));
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const incl = new Map();
  profile.samples.forEach((id, i) => {
    const seen = new Set();
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
      const f = nodes.get(cur).callFrame;
      const key = `${f.functionName || "(anonymous)"} ${f.url.split("/").slice(-2).join("/")}:${f.lineNumber + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      incl.set(key, (incl.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
    }
  });
  console.log([...incl.entries()].filter(([k]) => !/^\(root\)|^\(program\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${v.toFixed(1)} ms  ${k}`).join("\n"));
}
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
console.log(JSON.stringify({ chars: src.length, parse_cold_ms: +parseMs.toFixed(1), parse_warm_ms: warm.map((x) => +x.toFixed(1)), serialize_unchanged_ms: +firstMs.toFixed(1), serialize_after_edit_ms: { median: +times[20].toFixed(2), max: +times[39].toFixed(2) } }, null, 1));
