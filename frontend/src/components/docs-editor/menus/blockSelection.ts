/**
 * Multi-block selection, the way Notion does it: whole blocks highlighted, no caret.
 *
 *   Esc                 selects the block at the caret (Esc again: nothing selected)
 *   Shift+↑ / ↓         extends it (also from a caret on a block's first / last line)
 *   ↑ / ↓               moves it to the block above / below; Enter edits the block
 *   Shift+click         from the caret's block (or the selection) to the clicked one
 *   ⌘A, ⌘A              the block's text, then every block
 *   Delete / Backspace  deletes the blocks; ⌘C / ⌘X copy and cut them (as Markdown and HTML)
 *   ⌘D, ⌘⇧↑/↓, Tab      duplicate, move, nest them
 *
 * A `BlockSelection` covers sibling blocks of one parent, from `anchorBlock` to `headBlock` (the
 * positions before them). It is a real ProseMirror selection: copy, cut, delete, drag and undo
 * all work on it as on any other selection.
 */
import { Extension, type Editor } from "@tiptap/core";
import { Slice, type Node as PMNode, type ResolvedPos } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, Selection, SelectionRange, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Mappable } from "@tiptap/pm/transform";
import { indentRun, outdentRun, runOf, withoutAnchors, anchors } from "./blockOps";

const FLOW = new Set(["doc", "callout", "details", "column", "indent", "blockquote", "button", "steps", "private", "tab", "card", "listItem", "bulletList", "orderedList", "columns"]);

function blockEnd(doc: PMNode, pos: number) {
  const n = doc.nodeAt(pos);
  return n ? pos + n.nodeSize : pos;
}

export class BlockSelection extends Selection {
  readonly anchorBlock: number;
  readonly headBlock: number;

  constructor(doc: PMNode, anchorBlock: number, headBlock: number) {
    const lo = Math.min(anchorBlock, headBlock);
    const hi = blockEnd(doc, Math.max(anchorBlock, headBlock));
    const $from = doc.resolve(lo);
    const $to = doc.resolve(hi);
    super(anchorBlock <= headBlock ? $from : $to, anchorBlock <= headBlock ? $to : $from, [new SelectionRange($from, $to)]);
    this.anchorBlock = anchorBlock;
    this.headBlock = headBlock;
  }

  /** Both positions before a block in the same parent, or null. */
  static valid(doc: PMNode, a: number, b: number): boolean {
    if (a < 0 || b < 0 || a > doc.content.size || b > doc.content.size) return false;
    const $a = doc.resolve(a);
    const $b = doc.resolve(b);
    if (!$a.nodeAfter?.isBlock || !$b.nodeAfter?.isBlock) return false;
    return $a.depth === $b.depth && ($a.depth === 0 || $a.before() === $b.before());
  }

  static create(doc: PMNode, anchorBlock: number, headBlock = anchorBlock): BlockSelection {
    return new BlockSelection(doc, anchorBlock, headBlock);
  }

  map(doc: PMNode, mapping: Mappable): Selection {
    const a = mapping.mapResult(this.anchorBlock, 1);
    const h = mapping.mapResult(this.headBlock, 1);
    if (!a.deleted && !h.deleted && BlockSelection.valid(doc, a.pos, h.pos)) return new BlockSelection(doc, a.pos, h.pos);
    return Selection.near(doc.resolve(Math.min(mapping.map(this.to, -1), doc.content.size)), -1);
  }

  eq(other: Selection): boolean {
    return other instanceof BlockSelection && other.anchorBlock === this.anchorBlock && other.headBlock === this.headBlock;
  }

  content(): Slice {
    return this.$from.doc.slice(this.from, this.to, true);
  }

  toJSON() {
    return { type: "dxe-blocks", anchor: this.anchorBlock, head: this.headBlock };
  }

  static fromJSON(doc: PMNode, json: { anchor: number; head: number }) {
    return new BlockSelection(doc, json.anchor, json.head);
  }

  getBookmark() {
    return new BlockBookmark(this.anchorBlock, this.headBlock);
  }

  /** The selected blocks, in order. */
  blocks(): Array<{ pos: number; node: PMNode }> {
    const out: Array<{ pos: number; node: PMNode }> = [];
    const doc = this.$from.doc;
    let p = this.from;
    while (p < this.to) {
      const n = doc.nodeAt(p);
      if (!n) break;
      out.push({ pos: p, node: n });
      p += n.nodeSize;
    }
    return out;
  }
}
(BlockSelection.prototype as unknown as { visible: boolean }).visible = false;
try {
  Selection.jsonID("dxe-blocks", BlockSelection as never);
} catch {
  /* registered by an earlier copy of this module (hot reload) */
}

class BlockBookmark {
  constructor(readonly anchor: number, readonly head: number) {}
  map(mapping: Mappable) {
    return new BlockBookmark(mapping.map(this.anchor, 1), mapping.map(this.head, 1));
  }
  resolve(doc: PMNode): Selection {
    return BlockSelection.valid(doc, this.anchor, this.head) ? new BlockSelection(doc, this.anchor, this.head) : Selection.near(doc.resolve(Math.min(this.head, doc.content.size)));
  }
}

/* ── finding blocks ──────────────────────────────────────────────────────── */

/** The position before the selectable block around `$pos` (the innermost block in a flow parent). */
export function blockStartAt($pos: ResolvedPos): number | null {
  for (let d = $pos.depth; d >= 1; d--) {
    const parent = $pos.node(d - 1);
    const name = parent.type.name;
    if (name === "bulletList" || name === "orderedList") return $pos.before(d); // the list item
    // A list item's first line stands for the item; blocks nested under it are blocks of their own.
    if (name === "listItem") {
      if ($pos.index(d - 1) === 0) continue;
      return $pos.before(d);
    }
    if (name === "columns") continue;
    if (FLOW.has(name)) return $pos.before(d);
  }
  return null;
}

/** The block the selection is on (a caret, a node selection or a block selection's head). */
export function currentBlock(state: EditorState): number | null {
  const sel = state.selection;
  if (sel instanceof BlockSelection) return sel.headBlock;
  if (sel instanceof NodeSelection && sel.node.isBlock) return sel.from;
  return blockStartAt(sel.$from);
}

/** `a` and `b` lifted to siblings (their ancestors in the deepest common parent). */
export function siblings(doc: PMNode, a: number, b: number): [number, number] | null {
  const $a = doc.resolve(a);
  const $b = doc.resolve(b);
  let d = Math.min($a.depth, $b.depth);
  while (d > 0 && $a.before(d) !== $b.before(d)) d--;
  // Now both are inside the node at depth d; their children there are the siblings.
  const pa = $a.depth > d ? $a.before(d + 1) : a;
  const pb = $b.depth > d ? $b.before(d + 1) : b;
  if (!BlockSelection.valid(doc, pa, pb)) return null;
  const parent = doc.resolve(pa).parent;
  // Never select inside a list (only whole items) or a row: climb to the list / table.
  if (["tableRow", "table", "columns"].includes(parent.type.name)) return siblings(doc, doc.resolve(pa).before(), doc.resolve(pb).before());
  return [pa, pb];
}

export function selectBlocks(view: EditorView, a: number, b = a) {
  const s = siblings(view.state.doc, a, b);
  if (!s) return false;
  view.dispatch(view.state.tr.setSelection(BlockSelection.create(view.state.doc, s[0], s[1])).scrollIntoView());
  return true;
}

/** The top-level blocks, as one selection (⌘A twice). */
function selectAll(view: EditorView) {
  const doc = view.state.doc;
  if (!doc.childCount) return false;
  const last = doc.content.size - doc.lastChild!.nodeSize;
  view.dispatch(view.state.tr.setSelection(BlockSelection.create(doc, 0, last)));
  return true;
}

/** The sibling block before / after `pos` (null at the edge). */
function sibling(doc: PMNode, pos: number, dir: -1 | 1): number | null {
  const $p = doc.resolve(pos);
  const i = $p.index();
  const parent = $p.parent;
  if (dir < 0) return i > 0 ? pos - parent.child(i - 1).nodeSize : null;
  const n = parent.child(i);
  return i + 1 < parent.childCount ? pos + n.nodeSize : null;
}

/** Extends the head one block; at the edge of a container, the container itself is selected. */
function extend(view: EditorView, sel: BlockSelection, dir: -1 | 1): boolean {
  const doc = view.state.doc;
  const next = sibling(doc, sel.headBlock, dir);
  if (next !== null) {
    view.dispatch(view.state.tr.setSelection(BlockSelection.create(doc, sel.anchorBlock, next)).scrollIntoView());
    return true;
  }
  const $a = doc.resolve(sel.anchorBlock);
  if ($a.depth === 0) return true;
  const up = blockStartAt(doc.resolve($a.before()));
  if (up === null) return true;
  view.dispatch(view.state.tr.setSelection(BlockSelection.create(doc, up)).scrollIntoView());
  return true;
}

/** Caret at the end (or start) of a block: the last (first) text position inside it. */
function caretIn(view: EditorView, pos: number, atEnd = true) {
  const doc = view.state.doc;
  const n = doc.nodeAt(pos);
  if (!n) return;
  const sel = atEnd ? Selection.findFrom(doc.resolve(pos + n.nodeSize), -1, true) : Selection.findFrom(doc.resolve(pos), 1, true);
  view.dispatch(view.state.tr.setSelection(sel ?? Selection.near(doc.resolve(pos))).scrollIntoView());
  view.focus();
}

/* ── the plugin ──────────────────────────────────────────────────────────── */

export const blockSelectionKey = new PluginKey("dxeBlockSelection");

function isPrintable(e: KeyboardEvent) {
  return e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey;
}

/** A transaction that deletes the selected blocks, the caret where they were. */
function deleteBlocks(state: EditorState, sel: BlockSelection): Transaction {
  const tr = state.tr.deleteSelection();
  const $p = tr.doc.resolve(Math.min(sel.from, tr.doc.content.size));
  tr.setSelection(Selection.near($p, -1));
  return tr.scrollIntoView();
}

export function duplicateBlocks(view: EditorView, sel: BlockSelection) {
  const copy = withoutAnchors(sel.content().content, anchors(view.state.doc));
  const tr = view.state.tr.insert(sel.to, copy);
  const head = sel.to + (sel.headBlock - sel.from);
  const anchor = sel.to + (sel.anchorBlock - sel.from);
  tr.setSelection(BlockSelection.create(tr.doc, anchor, head));
  view.dispatch(tr.scrollIntoView());
}

export function moveBlocks(view: EditorView, sel: BlockSelection, dir: -1 | 1): boolean {
  const doc = view.state.doc;
  const other = dir < 0 ? sibling(doc, sel.from, -1) : sel.to < doc.resolve(sel.from).end() ? sel.to : null;
  if (other === null) return false;
  const otherNode = doc.nodeAt(other)!;
  const content = sel.content().content;
  const tr = view.state.tr.delete(sel.from, sel.to);
  const at = dir < 0 ? other : sel.from + otherNode.nodeSize;
  tr.insert(at, content);
  tr.setSelection(BlockSelection.create(tr.doc, at + (sel.anchorBlock - sel.from), at + (sel.headBlock - sel.from)));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** The selection as a run of blocks (for nesting). */
export function runOfSelection(state: EditorState) {
  const sel = state.selection;
  if (sel instanceof BlockSelection) return runOf(state, sel.from, sel.to);
  return null;
}

export const BlockSelectionExt = Extension.create({
  name: "dxeBlockSelection",
  priority: 1000,
  addProseMirrorPlugins() {
    const editor = this.editor as Editor;
    let selectAllCount = 0;
    return [
      new Plugin({
        key: blockSelectionKey,
        props: {
          decorations(state) {
            const sel = state.selection;
            if (!(sel instanceof BlockSelection)) return null;
            return DecorationSet.create(state.doc, sel.blocks().map((b) => Decoration.node(b.pos, b.pos + b.node.nodeSize, { class: "dxe-block-sel" })));
          },
          attributes(state): Record<string, string> {
            return state.selection instanceof BlockSelection ? { class: "dxe-has-blocksel" } : {};
          },
          handleKeyDown(view, e) {
            if (!view.editable) return false;
            const { state } = view;
            const sel = state.selection;
            const mod = e.metaKey || e.ctrlKey;
            if (e.key === "a" && mod && !e.shiftKey && !e.altKey) {
              // First ⌘A: the block's text; second: every block.
              if (sel instanceof BlockSelection) return selectAll(view);
              const $f = sel.$from;
              if (sel instanceof TextSelection && $f.parent.isTextblock && $f.sameParent(sel.$to)) {
                const all = sel.from === $f.start() && sel.to === $f.end();
                if (!all && $f.parent.content.size && selectAllCount === 0) {
                  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, $f.start(), $f.end())));
                  selectAllCount = 1;
                  window.setTimeout(() => (selectAllCount = 0), 1500);
                  return true;
                }
              }
              selectAllCount = 0;
              return selectAll(view);
            }
            if (!(sel instanceof BlockSelection)) {
              if (e.key === "Escape" && !mod && !e.shiftKey && !document.querySelector(".dxe-slash")) {
                // Esc: the block at the caret (a selected image, embed… too).
                const at = currentBlock(state);
                if (at === null) return false;
                return selectBlocks(view, at);
              }
              if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.shiftKey && !mod && !e.altKey) {
                // Shift+↓ on a block's last line (↑ on its first): the selection becomes blocks.
                const dir = e.key === "ArrowDown" ? 1 : -1;
                const textAt = sel instanceof TextSelection && sel.$head.parent.isTextblock;
                if (!(sel instanceof NodeSelection) && !(textAt && view.endOfTextblock(dir > 0 ? "down" : "up"))) return false;
                const from = sel instanceof NodeSelection ? sel.from : blockStartAt(sel.$anchor);
                const head = sel instanceof NodeSelection ? sel.from : blockStartAt(sel.$head);
                if (from === null || head === null) return false;
                const pair = siblings(state.doc, from, head);
                if (!pair) return false;
                const next = sibling(state.doc, pair[1], dir as -1 | 1);
                view.dispatch(state.tr.setSelection(BlockSelection.create(state.doc, pair[0], next ?? pair[1])).scrollIntoView());
                return true;
              }
              return false;
            }
            // A block selection.
            if (e.key === "Escape") {
              view.dispatch(state.tr.setSelection(Selection.near(state.doc.resolve(sel.to), -1)));
              (view.dom as HTMLElement).blur();
              return true;
            }
            if (e.key === "Backspace" || e.key === "Delete") {
              view.dispatch(deleteBlocks(state, sel));
              return true;
            }
            if (e.key === "Enter" && !mod) {
              caretIn(view, sel.headBlock, true);
              return true;
            }
            if ((e.key === "ArrowDown" || e.key === "ArrowUp") && mod && e.shiftKey) return moveBlocks(view, sel, e.key === "ArrowUp" ? -1 : 1) || true;
            if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.altKey && e.shiftKey) return moveBlocks(view, sel, e.key === "ArrowUp" ? -1 : 1) || true;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              const dir = e.key === "ArrowDown" ? 1 : -1;
              if (e.shiftKey) return extend(view, sel, dir);
              const next = sibling(state.doc, dir > 0 ? sel.headBlock : Math.min(sel.anchorBlock, sel.headBlock), dir);
              const at = next ?? (dir > 0 ? Math.max(sel.anchorBlock, sel.headBlock) : Math.min(sel.anchorBlock, sel.headBlock));
              view.dispatch(state.tr.setSelection(BlockSelection.create(state.doc, at)).scrollIntoView());
              return true;
            }
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              caretIn(view, e.key === "ArrowLeft" ? Math.min(sel.anchorBlock, sel.headBlock) : Math.max(sel.anchorBlock, sel.headBlock), e.key === "ArrowRight");
              return true;
            }
            if (e.key === "d" && mod) {
              duplicateBlocks(view, sel);
              return true;
            }
            if (e.key === "Tab") {
              const run = runOf(state, sel.from, sel.to);
              if (run) (e.shiftKey ? outdentRun : indentRun)(editor, run);
              return true;
            }
            // Typing doesn't replace selected blocks (Notion): only shortcuts go through.
            if (isPrintable(e)) return true;
            return false;
          },
          handleDOMEvents: {
            mousedown(view, e) {
              if (!(e instanceof MouseEvent) || !e.shiftKey || e.button !== 0 || !view.editable) return false;
              const hit = view.posAtCoords({ left: e.clientX, top: e.clientY });
              if (!hit) return false;
              const target = blockStartAt(view.state.doc.resolve(hit.inside >= 0 ? hit.inside + (view.state.doc.nodeAt(hit.inside)?.isAtom ? 0 : 1) : hit.pos));
              const sel = view.state.selection;
              const anchor = sel instanceof BlockSelection ? sel.anchorBlock : currentBlock(view.state);
              if (target === null || anchor === null) return false;
              if (!(sel instanceof BlockSelection) && target === anchor) return false; // a text selection inside one block
              const pair = siblings(view.state.doc, anchor, target);
              if (!pair) return false;
              e.preventDefault();
              view.dispatch(view.state.tr.setSelection(BlockSelection.create(view.state.doc, pair[0], pair[1])));
              view.focus();
              return true;
            },
          },
          // Pasted blocks keep their anchors only when nothing else on the page has them.
          transformPasted(slice, view) {
            const taken = anchors(view.state.doc);
            if (!taken.size) return slice;
            return new Slice(withoutAnchors(slice.content, taken), slice.openStart, slice.openEnd);
          },
        },
        // A drop of several blocks keeps them selected as blocks.
        appendTransaction(trs, _old, state) {
          const drop = trs.find((t) => t.getMeta("uiEvent") === "drop");
          if (!drop || !(state.selection instanceof TextSelection) || state.selection.empty) return null;
          const { from, to } = state.selection;
          const a = blockStartAt(state.doc.resolve(from + 1));
          const b = blockStartAt(state.doc.resolve(Math.max(from, to - 1)));
          if (a === null || b === null || a === b) return null;
          const pair = siblings(state.doc, a, b);
          return pair ? state.tr.setSelection(BlockSelection.create(state.doc, pair[0], pair[1])) : null;
        },
      }),
    ];
  },
});

/** Every selected block (or the block at the caret), for the menus. */
export function targetBlocks(state: EditorState): Array<{ pos: number; node: PMNode }> {
  const sel = state.selection;
  if (sel instanceof BlockSelection) return sel.blocks();
  const at = currentBlock(state);
  const n = at === null ? null : state.doc.nodeAt(at);
  return n && at !== null ? [{ pos: at, node: n }] : [];
}
