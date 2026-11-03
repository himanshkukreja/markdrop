/**
 * Fuzz: random edit sequences on pages (the round 2 constructs — colours, underline, block
 * attributes and anchors, image width/alignment, columns, nesting, table layout and cell colours,
 * code captions, buttons — mixed with everything else), then serialize → parse → compare, then a
 * "reload" (the saved Markdown parsed and written again must not change).
 *
 *   DOCS_EDITOR_FUZZ=2000 npm run docs:editor-test   (more runs; the default is quick)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { schema, read, rng, clone, blockPrints, FIXTURES_DIR } from "./helpers.mjs";
import path from "node:path";
import fs from "node:fs";
import { parseMarkdown, serializeMarkdown } from "../core/markdown.mjs";
import { COLORS, captionText } from "../core/attrs.mjs";

const RUNS = Number(process.env.DOCS_EDITOR_FUZZ ?? 300);
const STEPS = 12;

const WORDS = ["alpha", "beta", "Gamma", "delta", "x", "42", "a:b", "{note}", "#tag", "1.", "-", "*star*", "under_score", "back`tick", "50%", "q?", "end.", "naïve", "🚀", "[x]", "a|b", "{#b-abc123}", `{color="red"}`];

function pick(r, list) {
  return list[Math.floor(r() * list.length)];
}

function words(r, n = 1 + Math.floor(r() * 5)) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(pick(r, WORDS));
  return out.join(" ");
}

function marksFor(r) {
  const m = [];
  if (r() < 0.2) m.push({ type: "bold" });
  // (No italic: bold and italic side by side hit an old emphasis-writing limit, see DEVIATIONS.)
  if (r() < 0.15) m.push({ type: "underline" });
  if (r() < 0.2) m.push({ type: "span", attrs: { attributes: r() < 0.5 ? { color: pick(r, COLORS) } : { bg: pick(r, COLORS) } } });
  if (r() < 0.1) m.push({ type: "code" });
  return m;
}

function inline(r, { noCode = false } = {}) {
  const out = [];
  const n = 1 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const t = words(r);
    const m = marksFor(r).filter((x) => !(noCode && x.type === "code"));
    // Inline code can't hold a backtick run reliably next to other marks; keep it plain words.
    const text = m.some((x) => x.type === "code") ? t.replace(/[`|]/g, "") || "code" : t;
    // Runs are separated by plain spaces (a mark starting or ending on a space is an old
    // limitation of Markdown emphasis, not what this fuzz is about).
    if (i) out.push({ type: "text", text: " " });
    out.push({ type: "text", text, ...(m.length ? { marks: m } : {}) });
  }
  return out;
}

let anchorN = 0;
const anchor = () => `b-f${(anchorN++).toString(36).padStart(4, "0")}`;

function battrs(r, kind) {
  const a = {};
  if (r() < 0.3) a.id = anchor();
  if (kind === "text") {
    if (r() < 0.3) a.color = pick(r, COLORS);
    else if (r() < 0.2) a.bg = pick(r, COLORS);
  }
  return Object.keys(a).length ? a : null;
}

const para = (r) => ({ type: "paragraph", attrs: { battrs: battrs(r, "text") }, content: inline(r) });

function block(r, depth = 0) {
  const k = r();
  if (k < 0.3) return para(r);
  if (k < 0.38) return { type: "heading", attrs: { level: 1 + Math.floor(r() * 3), battrs: battrs(r, "text") }, content: inline(r) };
  if (k < 0.44) {
    const a = battrs(r, "x") ?? {};
    if (r() < 0.6) a.width = `${10 + Math.floor(r() * 90)}%`;
    if (r() < 0.6) a.align = pick(r, ["left", "center", "right"]);
    return { type: "figure", attrs: { src: `asset:img${Math.floor(r() * 1e6)}`, alt: words(r, 2).replace(/[[\]\\`]/g, ""), title: r() < 0.5 ? "A caption" : null, battrs: Object.keys(a).length ? a : null } };
  }
  if (k < 0.5) {
    const cols = 2 + Math.floor(r() * 2);
    const w = r() < 0.5;
    const row = (header) => ({
      type: "tableRow",
      content: Array.from({ length: cols }, (_, i) => ({
        type: header ? "tableHeader" : "tableCell",
        attrs: { colwidth: header && w && i === 0 ? [80 + Math.floor(r() * 200)] : null, battrs: r() < 0.25 ? (r() < 0.5 ? { bg: pick(r, COLORS) } : { color: pick(r, COLORS) }) : null },
        content: inline(r, { noCode: true }).map((t) => ({ ...t, text: t.text.replace(/\|/g, "/") })),
      })),
    });
    const a = battrs(r, "x") ?? {};
    if (r() < 0.4) a["header-column"] = "";
    if (r() < 0.2) a["header-row"] = "off";
    return { type: "table", attrs: { align: Array(cols).fill(null), battrs: Object.keys(a).length ? a : null }, content: [row(true), row(false), row(false)] };
  }
  if (k < 0.55) {
    const a = battrs(r, "x") ?? {};
    if (r() < 0.6) a.caption = captionText(words(r, 3));
    return { type: "codeBlock", attrs: { language: r() < 0.5 ? "js" : null, battrs: Object.keys(a).length ? a : null }, content: [{ type: "text", text: "const a = 1;" }] };
  }
  if (k < 0.58) return { type: "horizontalRule", attrs: { battrs: battrs(r, "x") } };
  if (k < 0.65) {
    const item = () => ({ type: "listItem", attrs: { checked: r() < 0.3 ? r() < 0.5 : null }, content: [para(r), ...(r() < 0.2 && depth < 2 ? [{ type: "indent", attrs: { attributes: {} }, content: [para(r)] }] : [])] });
    return { type: r() < 0.5 ? "bulletList" : "orderedList", content: [item(), item()] };
  }
  if (depth < 2 && k < 0.73) {
    const n = 2 + Math.floor(r() * 3);
    return { type: "columns", attrs: { attributes: r() < 0.2 ? { id: anchor() } : {} }, content: Array.from({ length: n }, () => ({ type: "column", attrs: { attributes: r() < 0.5 ? { width: `${Math.round(100 / n)}%` } : {} }, content: [block(r, depth + 1), ...(r() < 0.4 ? [block(r, depth + 1)] : [])] })) };
  }
  if (depth < 2 && k < 0.8) return { type: "indent", attrs: { attributes: {} }, content: [block(r, depth + 1), ...(r() < 0.4 ? [block(r, depth + 1)] : [])] };
  if (depth < 2 && k < 0.86) {
    const a = { summary: words(r, 2).replace(/"/g, "") };
    if (r() < 0.3) a.color = pick(r, COLORS);
    if (r() < 0.3) a.id = anchor();
    return { type: "details", attrs: { label: null, attributes: a }, content: [block(r, depth + 1)] };
  }
  if (depth < 2 && k < 0.9) return { type: "button", attrs: { label: null, attributes: { label: "Add" } }, content: [para(r)] };
  if (depth < 2 && k < 0.95) return { type: "callout", attrs: { kind: pick(r, ["note", "tip", "warning", "danger"]), label: null, attributes: r() < 0.5 ? { color: pick(r, COLORS) } : {} }, content: [para(r)] };
  return { type: "blockquote", content: [para(r)] };
}

/** Flow lists (arrays of blocks) anywhere in the document, for edits. */
function flows(doc) {
  const out = [];
  const visit = (n) => {
    if (["doc", "column", "indent", "details", "button", "callout", "blockquote"].includes(n.type) && n.content) out.push(n.content);
    (n.content ?? []).forEach(visit);
  };
  visit(doc);
  return out;
}

function edit(r, doc) {
  const fl = flows(doc);
  const list = pick(r, fl);
  const op = r();
  const i = Math.floor(r() * (list.length + 1));
  if (op < 0.35 || !list.length) list.splice(i, 0, block(r, list === doc.content ? 0 : 1));
  else if (op < 0.5 && list.length > 1) list.splice(Math.min(i, list.length - 1), 1);
  else if (op < 0.65) {
    // Move a block somewhere else (maybe into another container).
    const from = Math.min(i, list.length - 1);
    const [b] = list.splice(from, 1);
    if (!list.length) list.push({ type: "paragraph", content: [] });
    const to = pick(r, flows(doc));
    to.splice(Math.floor(r() * (to.length + 1)), 0, b);
  } else if (op < 0.8) {
    // Recolour / re-anchor a text block.
    const b = list[Math.min(i, list.length - 1)];
    if (b && (b.type === "paragraph" || b.type === "heading")) b.attrs = { ...(b.attrs ?? {}), battrs: battrs(r, "text") };
  } else if (op < 0.9) {
    // Tab: wrap a block in an indent.
    const at = Math.min(i, list.length - 1);
    list.splice(at, 1, { type: "indent", attrs: { attributes: {} }, content: [list[at]] });
  } else {
    // Type into a paragraph.
    const b = list[Math.min(i, list.length - 1)];
    if (b?.type === "paragraph") b.content = [...(b.content ?? []), { type: "text", text: " " }, ...inline(r)];
  }
}

function check(state, doc, label) {
  const node = schema.nodeFromJSON(doc);
  node.check();
  const json = node.toJSON();
  const out = serializeMarkdown({ ...state, doc: json });
  const back = parseMarkdown(out);
  const a = blockPrints(back.doc), b = blockPrints(json);
  if (a.join() !== b.join()) {
    const at = a.findIndex((x, k) => x !== b[k]);
    const strip = (k, v) => (k === "md" ? undefined : v);
    const blocksOf = (d) => (d.content ?? []).filter((n) => !(n.type === "paragraph" && !(n.content ?? []).length));
    if (process.env.DOCS_EDITOR_FUZZ_DUMP) fs.writeFileSync(process.env.DOCS_EDITOR_FUZZ_DUMP, JSON.stringify(blocksOf(json)[at]));
    assert.fail(`${label}: reads back differently at block ${at}\nexpected ${JSON.stringify(blocksOf(json)[at], strip)?.slice(0, 1200)}\nactual   ${JSON.stringify(blocksOf(back.doc)[at], strip)?.slice(0, 1200)}\n--- markdown ---\n${out.slice(0, 3000)}`);
  }
  // The reload: what was saved, opened again and saved, is the same text.
  const again = serializeMarkdown({ ...back, doc: schema.nodeFromJSON(back.doc).toJSON() });
  assert.equal(again, out, `${label}: not stable after a reload`);
  return { state: back, doc: schema.nodeFromJSON(back.doc).toJSON() };
}

test(`fuzz: ${RUNS} random edit sequences round-trip and survive a reload`, () => {
  const seeds = [read(path.join(FIXTURES_DIR, "pages.md")), "", "Just a line.\n"];
  for (let run = 0; run < RUNS; run++) {
    const r = rng(1000 + run);
    let { doc, ...state } = (() => {
      const s = parseMarkdown(seeds[run % seeds.length]);
      return { ...s, doc: schema.nodeFromJSON(s.doc).toJSON() };
    })();
    for (let s = 0; s < STEPS; s++) {
      const d = clone(doc);
      edit(r, d);
      const res = check(state, d, `run ${run} step ${s}`);
      state = res.state;
      doc = res.doc;
    }
  }
});
