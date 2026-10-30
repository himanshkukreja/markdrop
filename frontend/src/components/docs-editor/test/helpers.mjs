/**
 * Shared test helpers: the corpora, the ProseMirror schema the editor uses, a seeded PRNG and
 * small tree utilities. Run the suite with `npm run docs:editor-test`.
 *
 * Extra corpora (e.g. an imported GitBook site in a scratch folder, never committed) can be added
 * with DOCS_EDITOR_CORPUS=/path/one:/path/two.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSchema } from "@tiptap/core";
import { baseExtensions } from "../core/schema.mjs";
import { fp, parseMarkdown, serializeMarkdown } from "../core/markdown.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FRONTEND = path.resolve(here, "../../../..");
export const DOCS_DIR = path.join(FRONTEND, "content/docs");
export const FIXTURES_DIR = path.join(here, "fixtures");

export function mdFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d).sort()) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".md")) out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

export function corpus() {
  const extra = (process.env.DOCS_EDITOR_CORPUS ?? "").split(":").filter(Boolean);
  return [
    { name: "content/docs", files: mdFiles(DOCS_DIR) },
    { name: "fixtures", files: mdFiles(FIXTURES_DIR) },
    ...extra.map((d) => ({ name: d, files: mdFiles(d) })),
  ];
}

export const read = (f) => fs.readFileSync(f, "utf8");

export const schema = getSchema(baseExtensions());

/** Markdown → editor JSON as ProseMirror stores it (schema-checked) → Markdown. */
export function throughEditor(md) {
  const state = parseMarkdown(md);
  const node = schema.nodeFromJSON(state.doc);
  node.check();
  return { state, json: node.toJSON(), out: serializeMarkdown({ ...state, doc: node.toJSON() }) };
}

/** Fingerprints of a document's blocks, ignoring empty paragraphs (they serialize to nothing). */
export function blockPrints(doc) {
  return (doc.content ?? []).filter((n) => !(n.type === "paragraph" && !(n.content ?? []).length)).map(fp);
}

/** True when two Markdown strings parse to the same blocks. */
export function sameContent(a, b) {
  return blockPrints(parseMarkdown(a, { verify: false }).doc).join() === blockPrints(parseMarkdown(b, { verify: false }).doc).join();
}

export function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

/** mulberry32 */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(list, rand) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Every block node with a `md` attribute (any depth), with its parent array and index. */
export function blocks(doc) {
  const out = [];
  const visit = (n) => {
    (n.content ?? []).forEach((k, i, arr) => {
      if (k.attrs && "md" in k.attrs && k.attrs.md) out.push({ node: k, parent: n, arr, i });
      visit(k);
    });
  };
  visit(doc);
  return out;
}

/** Flow containers whose children are free blocks (doc, callout, steps, details, tab, card, quote, list item). */
export const FLOW = new Set(["doc", "callout", "steps", "details", "tab", "card", "blockquote", "listItem"]);

export function containers(doc) {
  const out = [];
  const visit = (n) => {
    if (FLOW.has(n.type)) out.push(n);
    (n.content ?? []).forEach(visit);
  };
  visit(doc);
  return out;
}

export const p = (text, marks) => ({ type: "paragraph", attrs: { md: null }, content: text ? [{ type: "text", text, ...(marks ? { marks } : {}) }] : [] });
