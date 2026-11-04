/**
 * Block-level operations on pages, for one block or a selection of blocks: colour, the block's
 * anchor (Copy link to block), nesting (Tab / Shift+Tab) and Turn into. Pure ProseMirror; the
 * menus and keys call these.
 */
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Fragment } from "@tiptap/pm/model";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { cleanAttrs, newAnchor, ANCHOR_RE } from "../core/attrs.mjs";
import type { ColorChoice } from "./ColorMenu";

export interface Block {
  pos: number;
  node: PMNode;
}

const TEXTISH = new Set(["paragraph", "heading"]);
const BATTR_TYPES = new Set(["paragraph", "heading", "figure", "codeBlock", "horizontalRule", "mathBlock", "table"]);
const ATTR_CONTAINERS = new Set(["details", "callout", "columns", "indent", "directiveLeaf"]);

/* ── colour ──────────────────────────────────────────────────────────────── */

/** The current colour of a block (its first text line's), for the menus' check mark. */
export function blockColor(node: PMNode): ColorChoice {
  const from = (o: Record<string, string> | null | undefined): ColorChoice => (o?.color ? { color: o.color } : o?.bg ? { bg: o.bg } : null);
  if (TEXTISH.has(node.type.name)) return from(node.attrs.battrs);
  if (node.type.name === "details") return from(node.attrs.attributes);
  if (node.type.name === "callout") return node.attrs.attributes?.color ? { bg: node.attrs.attributes.color } : null;
  const first = node.type.name === "listItem" || node.type.name === "blockquote" ? node.firstChild : node.type.name === "bulletList" || node.type.name === "orderedList" ? node.firstChild?.firstChild : null;
  return first && TEXTISH.has(first.type.name) ? from(first.attrs.battrs) : null;
}

/** Whether a block takes a colour (text blocks, lists, quotes, toggles, callouts). */
export function colorable(node: PMNode): boolean {
  return TEXTISH.has(node.type.name) || ["listItem", "blockquote", "bulletList", "orderedList", "details", "callout"].includes(node.type.name);
}

function withColor(o: Record<string, unknown> | null | undefined, c: ColorChoice) {
  const next: Record<string, unknown> = { ...(o ?? {}) };
  delete next.color;
  delete next.bg;
  if (c) Object.assign(next, c);
  return next;
}

/** Sets the colour of a block at `pos` in `tr` (lists: every item; quotes: every line). */
export function colorBlock(tr: Transaction, pos: number, c: ColorChoice) {
  const node = tr.doc.nodeAt(pos);
  if (!node) return;
  const name = node.type.name;
  if (TEXTISH.has(name)) {
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, battrs: cleanAttrs(withColor(node.attrs.battrs, c)) });
  } else if (name === "details") {
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, attributes: withColor(node.attrs.attributes, c) });
  } else if (name === "callout") {
    // A callout's colour is its background (`:::note{color=blue}`); text colours go to its lines.
    if (!c || "bg" in c) {
      const a = { ...(node.attrs.attributes ?? {}) };
      if (c && "bg" in c) a.color = c.bg;
      else delete a.color;
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, attributes: a });
    }
    if (!c || "color" in c) node.forEach((k, off) => TEXTISH.has(k.type.name) && colorBlock(tr, pos + 1 + off, c));
  } else if (name === "listItem") {
    if (node.firstChild && TEXTISH.has(node.firstChild.type.name)) colorBlock(tr, pos + 1, c);
  } else if (name === "blockquote" || name === "bulletList" || name === "orderedList") {
    node.forEach((k, off) => colorBlock(tr, pos + 1 + off, c));
  }
}

/* ── anchors ─────────────────────────────────────────────────────────────── */

/** Where a block keeps its anchor: itself, its first line (lists, quotes), or nowhere. */
function anchorHolder(doc: PMNode, pos: number): Block | null {
  const node = doc.nodeAt(pos);
  if (!node) return null;
  const name = node.type.name;
  if (BATTR_TYPES.has(name) || ATTR_CONTAINERS.has(name)) return { pos, node };
  if (name === "listItem" || name === "blockquote") return node.firstChild && TEXTISH.has(node.firstChild.type.name) ? { pos: pos + 1, node: node.firstChild } : null;
  if (name === "bulletList" || name === "orderedList") return anchorHolder(doc, pos + 1);
  return null;
}

function anchorOf(node: PMNode): string | null {
  const id = BATTR_TYPES.has(node.type.name) ? node.attrs.battrs?.id : node.attrs.attributes?.id;
  return typeof id === "string" && ANCHOR_RE.test(id) ? id : null;
}

/** Every anchor on the page. */
export function anchors(doc: PMNode): Set<string> {
  const out = new Set<string>();
  doc.descendants((n) => {
    const id = n.isBlock ? anchorOf(n) : null;
    if (id) out.add(id);
    return !n.isTextblock;
  });
  return out;
}

/** Whether "Copy link to block" works for this block. */
export function anchorable(doc: PMNode, pos: number) {
  return !!anchorHolder(doc, pos);
}

/** The block's anchor, added (`{#b-xxxxxx}`) the first time it's asked for. */
export function ensureAnchor(editor: Editor, pos: number): string | null {
  const h = anchorHolder(editor.state.doc, pos);
  if (!h) return null;
  const have = anchorOf(h.node);
  if (have) return have;
  const id = newAnchor(anchors(editor.state.doc));
  const attrs = BATTR_TYPES.has(h.node.type.name)
    ? { ...h.node.attrs, battrs: cleanAttrs({ ...(h.node.attrs.battrs ?? {}), id }) }
    : { ...h.node.attrs, attributes: { id, ...(h.node.attrs.attributes ?? {}) } };
  editor.view.dispatch(editor.state.tr.setNodeMarkup(h.pos, undefined, attrs).setMeta("addToHistory", true));
  return id;
}

/** The anchor of the innermost block around `pos` (an inline position), added when missing: a
 *  person mention gets one so the notification it sends links straight to its block. */
export function ensureAnchorAround(editor: Editor, pos: number): string | null {
  const doc = editor.state.doc;
  if (pos < 0 || pos > doc.content.size) return null;
  const $pos = doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    const at = $pos.before(d);
    if (anchorHolder(doc, at)) return ensureAnchor(editor, at);
  }
  return null;
}

/** The position of the block holding an anchor, or null. */
export function findAnchor(doc: PMNode, id: string): number | null {
  let at: number | null = null;
  doc.descendants((n, pos) => {
    if (at !== null) return false;
    if (n.isBlock && anchorOf(n) === id) {
      at = pos;
      return false;
    }
    return !n.isTextblock;
  });
  return at;
}

/** A copy of blocks with their anchors taken out (duplicates must not share a link). */
export function withoutAnchors(frag: Fragment, taken: Set<string>): Fragment {
  const nodes: PMNode[] = [];
  frag.forEach((n) => nodes.push(stripAnchor(n, taken)));
  return Fragment.from(nodes);
}

function stripAnchor(n: PMNode, taken: Set<string>): PMNode {
  if (n.isText) return n;
  const id = n.isBlock ? anchorOf(n) : null;
  let attrs = n.attrs;
  if (id && taken.has(id)) {
    if (BATTR_TYPES.has(n.type.name)) attrs = { ...attrs, battrs: cleanAttrs({ ...(attrs.battrs ?? {}), id: null }) };
    else {
      const a = { ...(attrs.attributes ?? {}) };
      delete a.id;
      attrs = { ...attrs, attributes: a };
    }
  }
  const kids: PMNode[] = [];
  n.content.forEach((k) => kids.push(stripAnchor(k, taken)));
  return n.type.create(attrs, kids.length ? Fragment.from(kids) : n.content, n.marks);
}

/* ── nesting: Tab / Shift+Tab ────────────────────────────────────────────── */

const NEST_INTO = new Set(["indent", "details", "callout"]);
const FLOW = new Set(["doc", "callout", "details", "column", "indent", "blockquote", "button", "steps", "private", "tab", "card"]);

/** Blocks [first, last] in one parent (`from` = before the first, `to` = after the last). */
export interface Run {
  from: number;
  to: number;
  parentPos: number; // -1 for the doc
  index: number; // of the first block in its parent
  count: number;
}

export function runOf(state: EditorState, from: number, to: number): Run | null {
  const $f = state.doc.resolve(from);
  const parent = $f.parent;
  if (!FLOW.has(parent.type.name) && parent.type.name !== "listItem") return null;
  const index = $f.index();
  let count = 0;
  let p = from;
  while (p < to && index + count < parent.childCount) {
    p += parent.child(index + count).nodeSize;
    count++;
  }
  if (!count) return null;
  return { from, to: p, parentPos: $f.depth ? $f.before() : -1, index, count };
}

/**
 * Tab: the blocks go under the block before them — into a list's last item (a list item's
 * children, plain Markdown), at the end of a toggle, callout or indent before them, or else into a
 * new `:::indent` after it. False when there's no block before them.
 */
export function indentRun(editor: Editor, run: Run): boolean {
  const { state } = editor;
  if (run.index === 0) return false;
  const $f = state.doc.resolve(run.from);
  const parent = $f.parent;
  const prev = parent.child(run.index - 1);
  const prevPos = run.from - prev.nodeSize;
  const blocks = state.doc.slice(run.from, run.to).content;
  const tr = state.tr;
  const caret = state.selection;
  let insertAt: number;
  if (prev.type.name === "bulletList" || prev.type.name === "orderedList") {
    const item = prev.lastChild!;
    insertAt = prevPos + prev.nodeSize - 2; // inside the last item, at its end
    if (!item.type.validContent(item.content.append(blocks))) return false;
  } else if (NEST_INTO.has(prev.type.name)) {
    insertAt = prevPos + prev.nodeSize - 1;
    if (!prev.type.validContent(prev.content.append(blocks))) return false;
  } else {
    const indent = state.schema.nodes.indent;
    if (!indent) return false;
    tr.replaceWith(run.from, run.to, indent.create({ label: null, attributes: {} }, blocks));
    restore(tr, caret, run.from, run.to, run.from + 1);
    editor.view.dispatch(tr.scrollIntoView());
    return true;
  }
  tr.delete(run.from, run.to);
  tr.insert(insertAt, blocks);
  restore(tr, caret, run.from, run.to, insertAt);
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** Puts the caret (or the block selection) back on the moved blocks. */
function restore(tr: Transaction, sel: EditorState["selection"], from: number, to: number, newFrom: number) {
  const shift = (p: number) => newFrom + (p - from);
  if (sel.from >= from && sel.to <= to) {
    const ctor = sel.constructor as unknown as { create?: (doc: PMNode, a: number, b: number) => EditorState["selection"] };
    try {
      if (sel instanceof TextSelection) tr.setSelection(TextSelection.create(tr.doc, shift(sel.anchor), shift(sel.head)));
      else if (ctor.create && (sel as unknown as { anchorBlock?: number }).anchorBlock !== undefined) {
        const s = sel as unknown as { anchorBlock: number; headBlock: number };
        tr.setSelection(ctor.create(tr.doc, shift(s.anchorBlock), shift(s.headBlock)));
      }
    } catch {
      /* the mapping's own selection is fine */
    }
  }
}

/**
 * Shift+Tab: the blocks leave the indent, toggle or callout they're in and follow it; blocks after
 * them in an indent come along as their children (a new indent), the way Notion outdents.
 */
export function outdentRun(editor: Editor, run: Run): boolean {
  const { state } = editor;
  if (run.parentPos < 0) return false;
  const parent = state.doc.nodeAt(run.parentPos)!;
  if (!NEST_INTO.has(parent.type.name) && parent.type.name !== "listItem") return false;
  const $p = state.doc.resolve(run.parentPos);
  const grand = $p.parent;
  if (parent.type.name === "listItem") {
    // A block nested in a list item (not its first line): after the whole list.
    if (run.index === 0) return false;
    const listPos = $p.before();
    const list = $p.parent;
    const $l = state.doc.resolve(listPos);
    if (!FLOW.has($l.parent.type.name)) return false;
    const blocks = state.doc.slice(run.from, run.to).content;
    const tr = state.tr;
    const caret = state.selection;
    const after = listPos + list.nodeSize;
    tr.insert(after, blocks);
    tr.delete(run.from, run.to);
    restore(tr, caret, run.from, run.to, tr.mapping.map(after, -1));
    editor.view.dispatch(tr.scrollIntoView());
    return true;
  }
  if (!FLOW.has(grand.type.name)) return false;
  const blocks = state.doc.slice(run.from, run.to).content;
  const restAfter = state.doc.slice(run.to, run.parentPos + parent.nodeSize - 1).content;
  const before = run.index > 0;
  const tr = state.tr;
  const caret = state.selection;
  const end = run.parentPos + parent.nodeSize;
  let out = blocks;
  if (restAfter.size && parent.type.name === "indent") out = out.append(Fragment.from(state.schema.nodes.indent.create({ label: null, attributes: {} }, restAfter)));
  else if (restAfter.size) {
    // In a toggle or callout, the blocks after stay where they are.
    tr.insert(end, blocks);
    tr.delete(run.from, run.to);
    restore(tr, caret, run.from, run.to, tr.mapping.map(end, -1));
    editor.view.dispatch(tr.scrollIntoView());
    return true;
  }
  tr.insert(end, out);
  if (before) tr.delete(run.from, run.parentPos + parent.nodeSize - 1);
  else tr.delete(run.parentPos, run.parentPos + parent.nodeSize);
  const newFrom = tr.mapping.map(end, -1);
  restore(tr, caret, run.from, run.to, newFrom);
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}
