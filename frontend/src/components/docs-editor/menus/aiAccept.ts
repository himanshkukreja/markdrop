/**
 * An AI answer into the document: page Markdown → blocks, through the editor's own parser
 * (core/markdown.mjs), so every block syntax works (`- [ ]` to-dos with `:person[…]{id}` and
 * `:date[…]` chips, `:::note[Summary]` callouts, tables, toggles…). Pure: a ProseMirror state in, a
 * transaction out, so the tests run it in Node (test/ai.test.mjs). The preview in the suggestion
 * card draws exactly what Accept will insert (the same `aiBlocks`).
 *
 * Where the answer goes (`AiTarget`):
 *   replace  the selection: a part of one line → the line keeps its type when the answer is one
 *            paragraph; whole lines → the lines are swapped for the answer's blocks; else the
 *            answer's blocks go in place of the selection;
 *   block    whole blocks [from, to) (the empty line "/ai" was typed on) → the answer's blocks;
 *   insert   a point between blocks (the top of the page, under a block) → the answer's blocks.
 */
import { Fragment, Slice, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { parseBlocks } from "../core/markdown.mjs";
import { cleanAiMarkdown } from "../../../lib/pages-ai/sseCore.mjs";

export type AiTarget = { mode: "replace" | "block"; from: number; to: number } | { mode: "insert"; at: number };

type Json = { type: string; content?: Json[]; attrs?: Record<string, unknown>; text?: string };

/** The answer as editor JSON blocks (an empty list for an empty answer). */
export function aiBlocks(markdown: string, schema: Schema, partial = false): Json[] {
  const md = cleanAiMarkdown(markdown, partial);
  if (!md.trim()) return [];
  try {
    const blocks = parseBlocks(md, { verify: true }) as Json[];
    // Schema-checked: a block the schema refuses would throw at insert time instead.
    Fragment.fromJSON(schema, blocks);
    return blocks;
  } catch {
    return md.split(/\n{2,}/).map((t) => ({ type: "paragraph", content: t.trim() ? [{ type: "text", text: t }] : [] }));
  }
}

export function aiFragment(markdown: string, schema: Schema, partial = false): Fragment {
  return Fragment.fromJSON(schema, aiBlocks(markdown, schema, partial));
}

/** The position right after the top-level block holding `pos` (where "Insert below" puts things). */
export function afterBlock(doc: PMNode, pos: number): number {
  const p = Math.max(0, Math.min(pos, doc.content.size));
  const $p = doc.resolve(p);
  if ($p.depth === 0) return p;
  return $p.after(1);
}

/** The top-level block holding `pos`: [from, to). */
export function blockRange(doc: PMNode, pos: number): { from: number; to: number } | null {
  const p = Math.max(0, Math.min(pos, doc.content.size));
  const $p = doc.resolve(p);
  if ($p.depth === 0) return null;
  return { from: $p.before(1), to: $p.after(1) };
}

/**
 * A selection that covers whole lines (from the start of its first textblock to the end of its
 * last, at the same depth): the lines' own range, so the answer replaces them as blocks.
 */
export function wholeLines(doc: PMNode, from: number, to: number): { from: number; to: number } | null {
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  if (!$from.parent.isTextblock || !$to.parent.isTextblock) return null;
  if ($from.parentOffset !== 0 || $to.parentOffset !== $to.parent.content.size) return null;
  if ($from.depth !== $to.depth) return null;
  return { from: $from.before(), to: $to.after() };
}

/** The transaction that puts the answer in (null: nothing to put, or the target is gone). */
export function acceptTr(state: EditorState, target: AiTarget, markdown: string): Transaction | null {
  const { doc, schema } = state;
  const frag = aiFragment(markdown, schema);
  if (!frag.childCount) return null;
  const tr = state.tr;
  const size = doc.content.size;
  if (target.mode === "insert") {
    const at = Math.max(0, Math.min(target.at, size));
    tr.insert(at, frag);
    return tr;
  }
  const { from, to } = target;
  if (from < 0 || to > size || to < from) return null;
  if (target.mode === "block") {
    tr.replaceRange(from, to, new Slice(frag, 0, 0));
    return tr;
  }
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  // Whole blocks (a block selection): the answer's blocks in their place.
  if (!$from.parent.isTextblock && !$to.parent.isTextblock && $from.depth === $to.depth) {
    tr.replaceRange(from, to, new Slice(frag, 0, 0));
    return tr;
  }
  const one = frag.childCount === 1 ? frag.firstChild : null;
  // Part of one line, answered with one paragraph: the text goes in (a heading stays a heading).
  if ($from.sameParent($to) && $from.parent.isTextblock && one?.type.name === "paragraph") {
    const lines = wholeLines(doc, from, to);
    if (!lines || $from.parent.type.name !== "paragraph") {
      tr.replaceWith(from, to, one.content);
      return tr;
    }
  }
  const lines = wholeLines(doc, from, to);
  if (lines) {
    tr.replaceRange(lines.from, lines.to, new Slice(frag, 0, 0));
    return tr;
  }
  tr.replaceRange(from, to, Slice.maxOpen(frag));
  return tr;
}
