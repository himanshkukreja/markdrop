/**
 * Docs Markdown <-> editor document (ProseMirror JSON), losslessly.
 *
 * The content format is the docs engine's: CommonMark + GFM + math + remark-directive (callouts,
 * steps, tabs, cards, details, ::video/::clip/::embed, :kbd[…]), parsed here with the same micromark
 * extensions the renderer uses, so both read a page the same way.
 *
 * How the round trip stays byte-identical without a "perfect" serializer: every block remembers
 * where it came from. At parse time each block node gets an `md` attribute holding
 *   - `src`:  its exact source text (dedented when it sat inside a list item or a quote),
 *   - `fp`:   a fingerprint of its content (type, semantic attributes, text, marks, children),
 *   - `gap`:  the exact whitespace between it and the previous sibling,
 *   - `prev`: the previous sibling's fingerprint (a gap without a blank line is only safe there).
 * On the way back, a block whose fingerprint still matches is written as its `src`, verbatim. A
 * block that was edited is written canonically (mdast-util-to-markdown with the corpus' style:
 * `-` bullets, `*` emphasis, `**` strong, backtick fences, `---` rules, compact tables), while its
 * unchanged children, the directive fence, attribute text and table rows it kept are still reused.
 * So an edit only ever rewrites the block it touched.
 *
 * Anything the visual editor can't represent faithfully (an unknown directive, HTML, reference
 * definitions, footnotes, a block whose canonical form wouldn't read back the same) becomes a
 * `rawBlock`/`rawInline` holding the source verbatim: shown as-is, editable in Markdown mode,
 * never dropped.
 *
 * Pure: no DOM, no React. The editor and the tests share it.
 */
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown, defaultHandlers } from "mdast-util-to-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { math } from "micromark-extension-math";
import { mathFromMarkdown, mathToMarkdown } from "mdast-util-math";
import { directive } from "micromark-extension-directive";
import { directiveFromMarkdown, directiveToMarkdown } from "mdast-util-directive";

/* ── vocabulary ──────────────────────────────────────────────────────────── */

export const CALLOUT_KINDS = ["note", "tip", "warning", "danger"];
/** Leaf directives the editor renders as blocks (`api` is the OpenAPI operation placeholder). */
export const LEAF_NAMES = ["video", "clip", "embed", "api"];
/** Container node types that serialize as `:::name` directives. */
const CONTAINER_TYPES = new Set(["callout", "steps", "tabs", "tab", "cards", "card", "details"]);

/** Attributes that carry meaning, per node / mark type (everything else, `md` included, is UI state). */
const SEM = {
  heading: ["level"],
  codeBlock: ["language", "meta"],
  mathBlock: ["meta"],
  bulletList: ["spread"],
  orderedList: ["start", "spread"],
  listItem: ["checked", "spread"],
  table: ["align"],
  figure: ["src", "alt", "title"],
  image: ["src", "alt", "title"],
  callout: ["kind", "label", "attributes"],
  steps: ["label", "attributes"],
  tabs: ["label", "attributes"],
  tab: ["label", "attributes"],
  cards: ["label", "attributes"],
  card: ["label", "attributes"],
  details: ["label", "attributes"],
  directiveLeaf: ["name", "label", "attributes"],
  rawBlock: ["value"],
  rawInline: ["value"],
  inlineMath: ["value"],
};
const MARK_SEM = { link: ["href", "title", "kind"] };
/** Nesting order when marks become mdast wrappers (outermost first); `code` is always the leaf. */
const MARK_ORDER = ["link", "kbd", "bold", "italic", "strike", "code"];

/* ── parsing ─────────────────────────────────────────────────────────────── */

const FRONT = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/;

const PARSE_OPTS = {
  extensions: [gfm(), math(), directive()],
  mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown(), directiveFromMarkdown()],
};

export function parseTree(md) {
  return fromMarkdown(md, PARSE_OPTS);
}

/**
 * Markdown → { doc (ProseMirror JSON), front, lead, tail, eol, bom }. `front` is the frontmatter
 * block exactly as written ("" when none); `lead`/`tail` the whitespace before the first and after
 * the last block. `verify` (default true) turns any block whose canonical Markdown would not read
 * back identically into a raw block.
 */
function parseMarkdownImpl(markdown, { verify = true } = {}) {
  let text = String(markdown ?? "");
  const bom = text.startsWith("﻿") ? "﻿" : "";
  text = text.slice(bom.length);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (text.includes("\r")) text = text.replace(/\r\n?/g, "\n");
  const fm = FRONT.exec(text);
  const front = fm ? fm[0] : "";
  const body = text.slice(front.length);
  const tree = parseTree(body);
  const ctx = { src: body, verify, defs: definitions(tree, body) };
  const kids = tree.children;
  if (!kids.length) return { doc: { type: "doc", content: [paragraph([])] }, front, lead: body, tail: "", eol, bom, empty: true };
  const content = flow(kids, ctx, []);
  const lead = body.slice(0, start(kids[0]));
  const tail = body.slice(end(kids[kids.length - 1]));
  return { doc: { type: "doc", content }, front, lead, tail, eol, bom, empty: false };
}

/** Parses a fragment (a block's Markdown) into block nodes, for verification and paste. */
function parseBlocksImpl(md, { verify = false } = {}) {
  const tree = parseTree(md);
  return flow(tree.children, { src: md, verify, defs: definitions(tree, md) }, []);
}

/**
 * The page's link / footnote definitions, as Markdown to append when a block is re-read on its own
 * (a `[text][ref]` only parses as a reference while `[ref]: …` exists somewhere on the page).
 */
function definitions(tree, src) {
  const out = [];
  const visit = (n) => {
    if (n.type === "definition" || n.type === "footnoteDefinition") {
      out.push(src.slice(start(n), end(n)).split("\n").map((l) => l.replace(/^[ \t>]*/, "")).join("\n"));
      return;
    }
    (n.children ?? []).forEach(visit);
  };
  visit(tree);
  return { suffix: out.length ? "\n\n" + out.join("\n\n") : "", count: out.length };
}

/** Re-reads one block's Markdown in the page's context: exactly one block with this fingerprint? */
function readsAs(md, fpv, ctx) {
  try {
    const defs = ctx.defs ?? { suffix: "", count: 0 };
    const re = parseBlocks(md + defs.suffix);
    return re.length === 1 + defs.count && fp(re[0]) === fpv;
  } catch {
    return false;
  }
}

const start = (n) => n.position.start.offset;
const end = (n) => n.position.end.offset;

/* Line-prefix strippers for blocks inside list items (`indent`) and block quotes (`quote`). */
function stripLine(line, strip) {
  for (const s of strip) {
    if (s.kind === "quote") line = line.replace(/^ {0,3}> ?/, "");
    else {
      let i = 0;
      while (i < s.n && line[i] === " ") i++;
      line = line.slice(i);
    }
  }
  return line;
}

/** A slice's text with the container prefixes removed from every line but the first. */
function dedent(text, strip) {
  if (!strip.length || !text.includes("\n")) return text;
  return text
    .split("\n")
    .map((l, i) => (i === 0 ? l : stripLine(l, strip)))
    .join("\n");
}

function paragraph(content) {
  return { type: "paragraph", attrs: { md: null }, content };
}

function raw(value) {
  return { type: "rawBlock", attrs: { value, md: null } };
}

/**
 * Block children → editor blocks with their `md` (src, fp, gap, prev). `convert` maps one mdast
 * child (default: `block`).
 */
function flow(children, ctx, strip, convert = block) {
  const out = [];
  let prevEnd = null;
  let prevFp = null;
  for (const child of children) {
    const s = start(child), e = end(child);
    const src = dedent(ctx.src.slice(s, e), strip);
    let node = convert(child, ctx, strip, src);
    // A tab or card only reads back inside its tabs/cards parent, which is verified as a whole.
    const nested = node.type === "tab" || node.type === "card";
    if (ctx.verify && node.type !== "rawBlock" && !nested && !readsAs(serializeBlock(node, { preserve: false }), fp(node), ctx)) node = raw(src);
    const fpv = fp(node);
    // Inside a list item / quote the dedent is a heuristic: keep `src` only if it reads back the same.
    const srcOk = !strip.length || node.type === "rawBlock" || (!nested && readsAs(src, fpv, ctx));
    const gap = prevEnd === null ? null : dedent(ctx.src.slice(prevEnd, s), strip);
    node.attrs = { ...node.attrs, md: { src: srcOk ? src : null, fp: fpv, gap, prev: prevFp, ...(node.__md ?? {}) } };
    out.push(node);
    prevEnd = e;
    prevFp = fpv;
  }
  return out;
}


function block(n, ctx, strip, src) {
  switch (n.type) {
    case "paragraph": {
      const only = n.children.length === 1 ? n.children[0] : null;
      if (only && only.type === "image")
        return { type: "figure", attrs: { src: only.url ?? "", alt: altText(only, ctx), title: only.title ?? null, md: null } };
      return paragraph(inline(n.children, ctx));
    }
    case "heading":
      return { type: "heading", attrs: { level: n.depth, md: null }, content: inline(n.children, ctx) };
    case "thematicBreak":
      return { type: "horizontalRule", attrs: { md: null } };
    case "blockquote":
      if (!n.children.length) return raw(src);
      return { type: "blockquote", attrs: { md: null }, content: flow(n.children, ctx, [...strip, { kind: "quote" }]) };
    case "list":
      return list(n, ctx, strip, src);
    case "code":
      return { type: "codeBlock", attrs: { language: n.lang ?? null, meta: n.meta ?? null, md: null }, content: n.value ? [{ type: "text", text: n.value }] : [] };
    case "math":
      return { type: "mathBlock", attrs: { meta: n.meta ?? null, md: null }, content: n.value ? [{ type: "text", text: n.value }] : [] };
    case "table":
      return table(n, ctx, strip, src);
    case "containerDirective":
      return container(n, ctx, strip, src);
    case "leafDirective":
      if (LEAF_NAMES.includes(n.name))
        return { type: "directiveLeaf", attrs: { name: n.name, label: leafLabel(src), attributes: { ...(n.attributes ?? {}) }, md: null } };
      return raw(src);
    default:
      // html, definition, footnoteDefinition, anything new: verbatim.
      return raw(src);
  }
}

function list(n, ctx, strip, src) {
  const items = n.children;
  if (items.some((it) => !it.children.length ? false : it.children[0].type !== "paragraph")) return raw(src);
  const first = src.trimStart();
  const marker = n.ordered ? (/^\d+([.)])/.exec(first)?.[1] ?? ".") : first[0];
  let incr = true;
  if (n.ordered && items.length > 1) {
    const second = ctx.src.slice(start(items[1]), end(items[1]));
    const num = /^\s*(\d+)/.exec(second)?.[1];
    incr = num === undefined ? true : Number(num) !== (n.start ?? 1);
  }
  const content = items.map((it) => {
    const kids = it.children;
    // Content column relative to the item's own column: marker width + spacing.
    const n2 = kids.length ? kids[0].position.start.column - it.position.start.column : 2;
    const inner = kids.length ? flow(kids, ctx, [...strip, { kind: "indent", n: n2 }]) : [paragraph([])];
    return { type: "listItem", attrs: { checked: typeof it.checked === "boolean" ? it.checked : null, spread: !!it.spread, md: null }, content: inner };
  });
  if (n.ordered) return { type: "orderedList", attrs: { start: n.start ?? 1, spread: !!n.spread, marker, incr, md: null }, content };
  return { type: "bulletList", attrs: { spread: !!n.spread, marker, md: null }, content };
}

function table(n, ctx, strip, src) {
  const lines = src.split("\n");
  const rows = n.children.map((row, i) => {
    const cells = row.children.map((c) => ({ type: i === 0 ? "tableHeader" : "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: inline(c.children, ctx) }));
    const node = { type: "tableRow", attrs: { md: null }, content: cells };
    const rsrc = dedent(ctx.src.slice(start(row), end(row)), strip);
    node.attrs.md = { src: rsrc.includes("\n") ? null : rsrc, fp: fp(node) };
    return node;
  });
  const align = (n.align ?? []).map((a) => a ?? null);
  const cols = Math.max(0, ...n.children.map((r) => r.children.length));
  return extraMd({ type: "table", attrs: { align, md: null }, content: rows }, { delim: lines[1] ?? null, align, cols });
}

/* Directives ------------------------------------------------------------------ */

/** The `[label]` of a leaf directive's source line, raw (null when absent). */
function leafLabel(src) {
  const m = /^::[A-Za-z][\w-]*\[/.exec(src);
  if (!m) return null;
  return bracket(src, m[0].length - 1);
}

/** Text inside the bracket opening at `i` (balanced, backslash escapes skipped), or null. */
function bracket(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") { j++; continue; }
    if (c === "\n") return null;
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return s.slice(i + 1, j);
  }
  return null;
}

/** First line, last line and colon count of a container's source; null if it isn't closed. */
function fences(src) {
  const lines = src.split("\n");
  const head = lines[0];
  const close = lines.length > 1 ? lines[lines.length - 1] : null;
  const open = /^(:{3,})/.exec(head);
  if (!open || close === null || !/^\s*:{3,}\s*$/.test(close)) return null;
  if (close.trim().length < open[1].length) return null;
  return { head, close, size: open[1].length };
}

function headLabel(head) {
  const m = /^:{3,}[A-Za-z][\w-]*\[/.exec(head);
  return m ? bracket(head, m[0].length - 1) : null;
}

function container(n, ctx, strip, src) {
  const f = fences(src);
  if (!f) return raw(src);
  const kids = n.children;
  const hasLabel = kids[0]?.data?.directiveLabel === true;
  const body = hasLabel ? kids.slice(1) : kids;
  const label = headLabel(f.head);
  if (hasLabel !== (label !== null)) return raw(src);
  const attributes = { ...(n.attributes ?? {}) };
  const base = { label, attributes };
  const head = { head: f.head, close: f.close, size: f.size, key: headKey(n.name, label, attributes) };
  let node;
  const blocks = () => (body.length ? flow(body, ctx, strip) : [paragraph([])]);
  if (CALLOUT_KINDS.includes(n.name)) node = { type: "callout", attrs: { kind: n.name, ...base }, content: blocks() };
  else if (n.name === "steps" || n.name === "details") node = { type: n.name, attrs: base, content: blocks() };
  else if (n.name === "tabs" || n.name === "cards") {
    const child = n.name === "tabs" ? "tab" : "card";
    if (!body.length || body.some((k) => k.type !== "containerDirective" || k.name !== child)) return raw(src);
    const content = flow(body, ctx, strip, (k, c, s, ksrc) => {
      const kf = fences(ksrc);
      const kl = kf ? headLabel(kf.head) : null;
      const kHas = k.children[0]?.data?.directiveLabel === true;
      if (!kf || kHas !== (kl !== null)) return raw(ksrc);
      const kbody = kHas ? k.children.slice(1) : k.children;
      const ka = { ...(k.attributes ?? {}) };
      return extraMd(
        { type: child, attrs: { label: kl, attributes: ka, md: null }, content: kbody.length ? flow(kbody, c, s) : [paragraph([])] },
        { head: kf.head, close: kf.close, size: kf.size, key: headKey(child, kl, ka) },
      );
    });
    if (content.some((k) => k.type === "rawBlock")) return raw(src);
    node = { type: n.name, attrs: base, content };
  } else return raw(src);
  node.attrs.md = null;
  return extraMd(node, head);
}

/** Extra `md` fields (directive fences, table delimiter row) that `flow` merges in with src/fp. */
function extraMd(node, extra) {
  Object.defineProperty(node, "__md", { value: extra, enumerable: false, configurable: true });
  return node;
}

function headKey(name, label, attributes) {
  return hash(JSON.stringify([name, label, sortObj(attributes)]));
}

/* Inline ---------------------------------------------------------------------- */

function inline(children, ctx, marks = []) {
  const out = [];
  const push = (n) => {
    if (n.type === "text" && !n.text) return;
    if (marks.length) n.marks = marks;
    out.push(n);
  };
  for (const c of children) {
    switch (c.type) {
      case "text":
        push({ type: "text", text: c.value });
        break;
      case "emphasis":
        out.push(...inline(c.children, ctx, [...marks, { type: "italic" }]));
        break;
      case "strong":
        out.push(...inline(c.children, ctx, [...marks, { type: "bold" }]));
        break;
      case "delete":
        out.push(...inline(c.children, ctx, [...marks, { type: "strike" }]));
        break;
      case "inlineCode":
        if (c.value) out.push({ type: "text", text: c.value, marks: [...marks, { type: "code" }] });
        else push({ type: "rawInline", attrs: { value: ctx.src.slice(start(c), end(c)) } });
        break;
      case "link": {
        const s = ctx.src.slice(start(c), end(c));
        const kind = s.startsWith("<") ? "auto" : s.startsWith("[") ? "inline" : "literal";
        const kids = inline(c.children, ctx, [...marks, { type: "link", attrs: { href: c.url ?? "", title: c.title ?? null, kind } }]);
        if (!kids.length) push({ type: "rawInline", attrs: { value: s } });
        else out.push(...kids);
        break;
      }
      case "image":
        push({ type: "image", attrs: { src: c.url ?? "", alt: altText(c, ctx), title: c.title ?? null } });
        break;
      case "break":
        push({ type: "hardBreak" });
        break;
      case "inlineMath":
        push({ type: "inlineMath", attrs: { value: c.value ?? "" } });
        break;
      case "textDirective": {
        const s = ctx.src.slice(start(c), end(c));
        if (c.name === "kbd" && /^:kbd\[[\s\S]*\]$/.test(s) && c.children.length) {
          out.push(...inline(c.children, ctx, [...marks, { type: "kbd" }]));
        } else if (s === `:${c.name}`) {
          // "0:30", "Note:this": a colon before a word is just text (the renderer prints it as such).
          push({ type: "text", text: s });
        } else push({ type: "rawInline", attrs: { value: s } });
        break;
      }
      default:
        // html, references, footnote calls: verbatim.
        push({ type: "rawInline", attrs: { value: ctx.src.slice(start(c), end(c)) } });
    }
  }
  return mergeText(out);
}

/**
 * An image's alt as written, backslash escapes resolved. mdast's `alt` is the label's plain text,
 * which drops anything micromark read as a directive ("0:15" → "0"); the source keeps it.
 */
function altText(img, ctx) {
  const s = ctx.src.slice(start(img), end(img));
  const label = s.startsWith("![") ? bracket(s, 1) : null;
  if (label === null || label.includes("\n")) return img.alt ?? "";
  return label.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

function sameMarks(a = [], b = []) {
  return markKey(a) === markKey(b);
}

function markKey(marks = []) {
  const seen = new Set();
  for (const m of marks) seen.add(m.type + (MARK_SEM[m.type] ? JSON.stringify(MARK_SEM[m.type].map((k) => m.attrs?.[k] ?? null)) : ""));
  return [...seen].sort().join("|");
}

function mergeText(nodes) {
  const out = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.type === "text" && last && last.type === "text" && sameMarks(last.marks, n.marks)) {
      out[out.length - 1] = { ...last, text: last.text + n.text };
    } else out.push(n);
  }
  return out;
}

/* ── fingerprints ────────────────────────────────────────────────────────── */

export function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let h2 = 0x01000193;
  for (let i = s.length - 1; i >= 0; i--) {
    h2 ^= s.charCodeAt(i);
    h2 = Math.imul(h2, 0x811c9dc5);
  }
  return (h >>> 0).toString(36) + (h2 >>> 0).toString(36) + s.length.toString(36);
}

function sortObj(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v ?? null;
  const out = {};
  for (const k of Object.keys(v).sort()) out[k] = v[k];
  return out;
}

/*
 * Fingerprints are memoized per node object, but only within one call of a public function (the
 * "session"): callers may mutate their JSON between calls.
 */
let memo = null;
function session(fn) {
  if (memo) return fn();
  memo = new WeakMap();
  try {
    return fn();
  } finally {
    memo = null;
  }
}

export function parseMarkdown(markdown, options) {
  return session(() => parseMarkdownImpl(markdown, options));
}
export function parseBlocks(md, options) {
  return session(() => parseBlocksImpl(md, options));
}
/** Content fingerprint of an editor node: type, semantic attributes, text, marks, children. */
export function fp(node) {
  return session(() => fpImpl(node));
}
export function serializeMarkdown(state, options) {
  return session(() => serializeMarkdownImpl(state, options));
}
export function serializeFlow(children, options) {
  return session(() => serializeFlowImpl(children, options));
}
export function serializeBlock(node, options) {
  return session(() => serializeBlockImpl(node, options));
}

function fpImpl(node) {
  if (node && typeof node === "object") {
    const hit = memo?.get(node);
    if (hit) return hit;
  }
  const v = hash(signature(node));
  if (memo && node && typeof node === "object") memo.set(node, v);
  return v;
}

/**
 * Loose vs tight as Markdown can express it: an item is loose only with 2+ blocks (always when two
 * paragraphs follow each other), a list only with 2+ items.
 */
function effectiveSpread(node) {
  const kids = (node.content ?? []).filter((k) => !isEmptyParagraph(k));
  if (node.type === "listItem")
    return (!!node.attrs?.spread && kids.length > 1) || kids.some((k, i) => i > 0 && k.type === "paragraph" && kids[i - 1].type === "paragraph");
  return !!node.attrs?.spread && kids.length > 1;
}

function signature(node) {
  const keys = SEM[node.type] ?? [];
  const attrs = keys.map((k) => (k === "spread" ? effectiveSpread(node) : sortObj(node.attrs?.[k] ?? null)));
  const kids = node.content ?? [];
  let body;
  if (kids.length && kids.every(isInline)) {
    // Inline content: merge adjacent text with equal marks, the way ProseMirror stores it.
    body = mergeText(kids.map((k) => ({ ...k, marks: k.marks ?? [] }))).map((k) =>
      k.type === "text" ? ["t", k.text, markKey(k.marks)] : [k.type, (SEM[k.type] ?? []).map((a) => k.attrs?.[a] ?? null), markKey(k.marks)],
    );
  } else body = kids.filter((k) => !isEmptyParagraph(k)).map(fp);
  return JSON.stringify([node.type, attrs, body]);
}

const INLINE = new Set(["text", "hardBreak", "image", "inlineMath", "rawInline"]);
const isInline = (n) => INLINE.has(n.type);

/* ── serializing ─────────────────────────────────────────────────────────── */

/**
 * The editor state → Markdown. `state` is what `parseMarkdown` returned with `doc` replaced by the
 * editor's current JSON (and `front` by the edited frontmatter, if the header changed it).
 */
function serializeMarkdownImpl(state, { preserve = true } = {}) {
  const { doc, front = "", lead = "", tail = "", eol = "\n", bom = "", empty = false } = state;
  const body = serializeFlow(doc.content ?? [], { preserve });
  // A page that had no blocks yet: its whitespace was all `lead`; new content ends with a newline.
  let out = !body ? front + lead + tail : empty ? front + (front ? "\n" : "") + body + "\n" : front + lead + body + tail;
  if (eol !== "\n") out = out.replace(/\n/g, eol);
  return bom + out;
}

const isEmptyParagraph = (n) => n.type === "paragraph" && !(n.content ?? []).length;

/** Blocks joined by their remembered gaps (verbatim when still safe, else one blank line). */
function serializeFlowImpl(children, opts = {}) {
  const preserve = opts.preserve !== false;
  let out = "";
  let prev = null;
  let prevText = null;
  for (const child of children) {
    if (isEmptyParagraph(child)) continue;
    const text = serializeBlock(child, { preserve, prev, prevText });
    if (prev) out += gapFor(child, prev, preserve);
    out += text;
    prev = child;
    prevText = text;
  }
  return out;
}

function gapFor(child, prev, preserve) {
  const md = child.attrs?.md;
  const g = md?.gap;
  if (!preserve || typeof g !== "string" || !/^[ \t]*\n[ \t\n]*$/.test(g)) return "\n\n";
  const blank = (g.match(/\n/g) ?? []).length - 1;
  if (blank === 0) return md.prev === fp(prev) ? g : "\n\n";
  return g;
}

const isList = (n) => n && (n.type === "bulletList" || n.type === "orderedList");

/** One block → Markdown (no trailing newline). */
function serializeBlockImpl(node, opts = {}) {
  const preserve = opts.preserve !== false;
  const md = node.attrs?.md;
  const { prev, prevText } = opts;
  // Two lists in a row merge unless their markers differ: only reuse `src` where it was written.
  const listHazard = isList(node) && isList(prev) && node.type === prev.type && md?.prev !== fp(prev);
  // Indented code right after a list would continue the list's last item.
  const indentHazard = isList(prev) && md?.prev !== fp(prev) && /^[ \t]/.test(md?.src ?? "");
  if (preserve && md && typeof md.src === "string" && md.fp === fp(node) && !listHazard && !indentHazard) return md.src;
  if (node.type === "rawBlock") return node.attrs.value ?? "";
  if (CONTAINER_TYPES.has(node.type)) return serializeContainer(node, preserve);
  if (node.type === "directiveLeaf") return serializeLeaf(node);
  if (node.type === "table") return serializeTable(node, preserve);
  if (isList(node)) {
    let marker = node.attrs.marker;
    if (listHazard && prevText) {
      const used = node.type === "orderedList" ? /^\s*\d+([.)])/.exec(prevText)?.[1] : prevText.trimStart()[0];
      if (used === marker) marker = node.type === "orderedList" ? (marker === "." ? ")" : ".") : marker === "-" ? "*" : "-";
    }
    return mdString(toMdast(node, preserve), listOptions(node, marker));
  }
  return mdString(toMdast(node, preserve));
}

function listOptions(node, marker) {
  if (node.type === "orderedList") return { bulletOrdered: marker === ")" ? ")" : ".", incrementListMarker: node.attrs.incr !== false };
  const b = marker === "*" || marker === "+" ? marker : "-";
  return { bullet: b, bulletOther: b === "-" ? "*" : "-" };
}

/* Containers -------------------------------------------------------------------- */

const CONTAINER_NAME = (node) => (node.type === "callout" ? node.attrs.kind || "note" : node.type);

function colons(text) {
  return /^(:{3,})/.exec(text)?.[1].length ?? 0;
}

/** The fence size a container needs: more colons than any container nested in it. */
function fenceSize(node, preserve) {
  let inner = 0;
  const visit = (n) => {
    for (const k of n.content ?? []) {
      if (CONTAINER_TYPES.has(k.type)) inner = Math.max(inner, fenceSize(k, preserve));
      else if (k.type === "rawBlock") {
        for (const line of (k.attrs.value ?? "").split("\n")) inner = Math.max(inner, colons(line.trimStart()));
      } else visit(k);
    }
  };
  visit(node);
  const own = preserve ? node.attrs?.md?.size ?? 3 : 3;
  return Math.max(own, inner ? inner + 1 : 3);
}

export function directiveAttrs(attributes) {
  const parts = [];
  for (const [k, v] of Object.entries(attributes ?? {})) {
    if (v === undefined || v === null) continue;
    const s = String(v);
    parts.push(s === "" ? k : `${k}="${s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\n/g, "&#xA;")}"`);
  }
  return parts.length ? `{${parts.join(" ")}}` : "";
}

function serializeContainer(node, preserve) {
  const md = node.attrs.md;
  const name = CONTAINER_NAME(node);
  const size = fenceSize(node, preserve);
  const fence = ":".repeat(size);
  const label = node.attrs.label;
  const attributes = node.attrs.attributes ?? {};
  let head, close;
  if (preserve && md?.head && md.key === headKey(name, label ?? null, attributes)) {
    head = md.head.replace(/^:{3,}/, fence);
    close = md.size === size ? md.close : md.close.replace(/:{3,}/, fence);
  } else {
    head = `${fence}${name}${label != null ? `[${label}]` : ""}${directiveAttrs(attributes)}`;
    close = fence;
  }
  const body = serializeFlow(node.content ?? [], { preserve });
  return body ? `${head}\n${body}\n${close}` : `${head}\n${close}`;
}

/** A leaf directive line. (An unchanged leaf never gets here: its `src` is reused whole.) */
function serializeLeaf(node) {
  const { name, label, attributes } = node.attrs;
  return `::${name}${label != null ? `[${label}]` : ""}${directiveAttrs(attributes)}`;
}

/* Tables ---------------------------------------------------------------------------- */

function cellText(cell) {
  const md = mdString({ type: "paragraph", children: phrasing(cell.content ?? []) });
  return md.replace(/\n/g, " ").replace(/(^|[^\\])((?:\\\\)*)\|/g, "$1$2\\|").replace(/(^|[^\\])((?:\\\\)*)\|/g, "$1$2\\|");
}

function delimiter(align, cols) {
  const cells = [];
  for (let i = 0; i < cols; i++) {
    const a = align[i] ?? null;
    cells.push(a === "left" ? ":--" : a === "right" ? "--:" : a === "center" ? ":-:" : "---");
  }
  return `| ${cells.join(" | ")} |`;
}

function serializeTable(node, preserve) {
  const rows = node.content ?? [];
  const cols = Math.max(1, ...rows.map((r) => (r.content ?? []).reduce((n, c) => n + (c.attrs?.colspan ?? 1), 0)));
  const align = node.attrs.align ?? [];
  const md = node.attrs.md;
  const lines = rows.map((row) => {
    const rmd = row.attrs?.md;
    const cells = row.content ?? [];
    if (preserve && rmd && typeof rmd.src === "string" && rmd.fp === fp(row) && cells.length === cols) return rmd.src;
    const texts = [];
    for (const c of cells) {
      texts.push(cellText(c));
      for (let k = 1; k < (c.attrs?.colspan ?? 1); k++) texts.push("");
    }
    while (texts.length < cols) texts.push("");
    return `| ${texts.join(" | ")} |`;
  });
  const sameShape = md && Array.isArray(md.align) && JSON.stringify(md.align) === JSON.stringify(align) && md.cols === cols;
  const delim = preserve && sameShape && typeof md.delim === "string" ? md.delim : delimiter(align, cols);
  return [lines[0] ?? `| ${Array(cols).fill("").join(" | ")} |`, delim, ...lines.slice(1)].join("\n");
}

/* mdast-util-to-markdown bridge -------------------------------------------------------- */

const TO_MD = {
  bullet: "-",
  bulletOther: "*",
  bulletOrdered: ".",
  emphasis: "*",
  strong: "*",
  fence: "`",
  fences: true,
  listItemIndent: "one",
  rule: "-",
  ruleRepetition: 3,
  ruleSpaces: false,
  setext: false,
  closeAtx: false,
  resourceLink: true,
  quote: '"',
  incrementListMarker: true,
  extensions: [gfmToMarkdown({ tablePipeAlign: false }), mathToMarkdown(), directiveToMarkdown()],
  handlers: {
    paragraph(node, parent, state, info) {
      return typeof node.data?.raw === "string" ? node.data.raw : defaultHandlers.paragraph(node, parent, state, info);
    },
    link(node, parent, state, info) {
      const only = node.children.length === 1 ? node.children[0] : null;
      if (node.data?.kind === "auto" && only?.type === "text" && !node.title && (only.value === node.url || `mailto:${only.value}` === node.url))
        return `<${only.value}>`;
      return defaultHandlers.link(node, parent, state, info);
    },
    mdRaw(node) {
      return node.value;
    },
  },
};

function mdString(tree, extra) {
  return toMarkdown(tree, extra ? { ...TO_MD, ...extra } : TO_MD).replace(/\n+$/, "");
}

/** Editor block → mdast. Children that keep their source become raw nodes. */
function toMdast(node, preserve) {
  switch (node.type) {
    case "paragraph":
      return { type: "paragraph", children: phrasing(node.content ?? []) };
    case "heading":
      return { type: "heading", depth: node.attrs.level ?? 2, children: phrasing(node.content ?? []) };
    case "horizontalRule":
      return { type: "thematicBreak" };
    case "codeBlock":
      return { type: "code", lang: node.attrs.language || null, meta: node.attrs.meta || null, value: textContent(node) };
    case "mathBlock":
      return { type: "math", meta: node.attrs.meta || null, value: textContent(node) };
    case "figure":
      return { type: "paragraph", children: [{ type: "image", url: node.attrs.src ?? "", alt: node.attrs.alt ?? "", title: node.attrs.title || null }] };
    case "blockquote":
      return { type: "blockquote", children: (node.content ?? []).filter((k) => !isEmptyParagraph(k)).map((k) => child(k, preserve)) };
    case "bulletList":
    case "orderedList":
      return {
        type: "list",
        ordered: node.type === "orderedList",
        start: node.type === "orderedList" ? node.attrs.start ?? 1 : null,
        spread: !!node.attrs.spread,
        children: (node.content ?? []).map((item) => ({
          type: "listItem",
          spread: !!item.attrs?.spread,
          checked: typeof item.attrs?.checked === "boolean" ? item.attrs.checked : null,
          children: (item.content ?? []).filter((k, i) => i === 0 || !isEmptyParagraph(k)).map((k) => child(k, preserve)),
        })),
      };
    default:
      return { type: "mdRaw", value: serializeBlock(node, { preserve }) };
  }
}

/** A block inside a list item or quote: a paragraph stays a paragraph (task items need one first). */
function child(node, preserve) {
  const md = node.attrs?.md;
  if (node.type === "paragraph") {
    if (preserve && md && typeof md.src === "string" && md.fp === fp(node)) return { type: "paragraph", data: { raw: md.src }, children: [] };
    return toMdast(node, preserve);
  }
  return { type: "mdRaw", value: serializeBlock(node, { preserve }) };
}

function textContent(node) {
  return (node.content ?? []).map((k) => k.text ?? "").join("");
}

function sortMarks(marks = []) {
  const seen = new Set();
  return [...marks]
    .filter((m) => {
      const k = markKey([m]);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => rank(a.type) - rank(b.type));
}

function rank(t) {
  const i = MARK_ORDER.indexOf(t);
  return i < 0 ? MARK_ORDER.length - 1 : i;
}

function wrapperFor(m) {
  switch (m.type) {
    case "bold":
      return { type: "strong", children: [] };
    case "italic":
      return { type: "emphasis", children: [] };
    case "strike":
      return { type: "delete", children: [] };
    case "kbd":
      return { type: "textDirective", name: "kbd", attributes: {}, children: [] };
    case "link":
      return { type: "link", url: m.attrs?.href ?? "", title: m.attrs?.title || null, data: { kind: m.attrs?.kind ?? "inline" }, children: [] };
    default:
      return null;
  }
}

/** Inline editor nodes → mdast phrasing (marks become nested wrappers, outermost first). */
export function phrasing(nodes) {
  const root = { children: [] };
  const stack = [{ mark: null, node: root }];
  for (const n of nodes) {
    const marks = sortMarks(n.marks);
    const wrapping = marks.filter((m) => m.type !== "code" && wrapperFor(m));
    const isCode = marks.some((m) => m.type === "code");
    let keep = 0;
    while (keep < wrapping.length && keep + 1 < stack.length && markKey([stack[keep + 1].mark]) === markKey([wrapping[keep]])) keep++;
    stack.length = keep + 1;
    for (let i = keep; i < wrapping.length; i++) {
      const el = wrapperFor(wrapping[i]);
      stack[stack.length - 1].node.children.push(el);
      stack.push({ mark: wrapping[i], node: el });
    }
    const parent = stack[stack.length - 1].node;
    const last = parent.children[parent.children.length - 1];
    switch (n.type) {
      case "text":
        if (isCode) {
          if (last?.type === "inlineCode") last.value += n.text;
          else parent.children.push({ type: "inlineCode", value: n.text });
        } else if (last?.type === "text") last.value += n.text;
        else parent.children.push({ type: "text", value: n.text });
        break;
      case "hardBreak":
        parent.children.push({ type: "break" });
        break;
      case "image":
        parent.children.push({ type: "image", url: n.attrs?.src ?? "", alt: n.attrs?.alt ?? "", title: n.attrs?.title || null });
        break;
      case "inlineMath":
        parent.children.push({ type: "inlineMath", value: n.attrs?.value ?? "" });
        break;
      case "rawInline":
        parent.children.push({ type: "mdRaw", value: n.attrs?.value ?? "" });
        break;
      default:
        break;
    }
  }
  return literalLinks(root.children);
}

/** A bare-URL link (`https://…` typed as text) goes back as the text it was. */
function literalLinks(children) {
  return children.map((c) => {
    if (c.children) c.children = literalLinks(c.children);
    if (c.type === "link" && c.data?.kind === "literal" && !c.title && c.children.length === 1 && c.children[0].type === "text") {
      const t = c.children[0].value;
      if (c.url === t || c.url === `http://${t}` || c.url === `mailto:${t}`) return { type: "mdRaw", value: t };
    }
    return c;
  });
}
