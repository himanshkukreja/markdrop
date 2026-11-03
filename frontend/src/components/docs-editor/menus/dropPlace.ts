/**
 * Where a dragged block lands (menus/dnd.ts), kept free of the DOM so the tests run it in Node.
 *
 * ProseMirror's own drop point comes from the text position under the pointer: over a short line
 * ("One"), a pointer right of its last letter is "the end of the line", which is the line's second
 * half, so the block went below it even with the pointer on the line's top edge. A block drop is
 * decided by geometry instead, the way Notion does it: over a block's top half it goes above that
 * block, over its bottom half below. The candidates are the blocks under the pointer, innermost
 * first; the first one whose container can take the dragged blocks there wins.
 */
import type { Node as PMNode, Slice } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

export interface DropCandidate {
  /** The block's position (before it). */
  pos: number;
  /** Its box on screen, top and bottom. */
  top: number;
  bottom: number;
}

export interface DropPlace {
  /** Where the blocks go. */
  pos: number;
  /** Above the candidate (else below it). */
  before: boolean;
  candidate: DropCandidate;
}

/** The place for a drop at `y` (see the module comment), or null when no candidate can take `slice`. */
export function placeDrop(doc: PMNode, slice: Slice, candidates: DropCandidate[], y: number): DropPlace | null {
  for (const c of candidates) {
    const node = doc.nodeAt(c.pos);
    if (!node) continue;
    const before = y < (c.top + c.bottom) / 2;
    const at = before ? c.pos : c.pos + node.nodeSize;
    const $at = doc.resolve(at);
    const index = $at.index();
    if ($at.parent.canReplace(index, index, slice.content)) return { pos: at, before, candidate: c };
  }
  return null;
}

/**
 * Moves the dragged blocks (`from`–`to`, the slice's source) to `pos`: deletes them, then inserts the
 * slice where `pos` now is. Returns where they start and end now, or null when it changes nothing
 * (dropped on itself).
 */
export function moveSlice(tr: Transaction, slice: Slice, from: number, to: number, pos: number): { from: number; to: number } | null {
  if (pos >= from && pos <= to) return null;
  tr.delete(from, to);
  const at = tr.mapping.map(pos, pos <= from ? -1 : 1);
  tr.insert(at, slice.content);
  return { from: at, to: at + slice.content.size };
}
