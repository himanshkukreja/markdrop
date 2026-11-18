/**
 * The visual editor and the Markdown its host holds (VisualEditor.tsx). The editor hands its
 * Markdown up debounced (typing), so at any moment it may hold a change the host hasn't seen yet.
 *
 * - `incomingValue`: a new value from outside (another version loaded, a teammate's or an AI
 *   app's change merged in by the page's edit session) while such a change waits: the waiting
 *   change is taken as typing and merged on top, line by line (lib/pageMerge), never dropped.
 * - `appendTr`: a live `appended` (an AI app's append_blocks) going in at the end. The host has
 *   already counted it as part of the page (usePageEditSession moves its base on), so the editor
 *   must hand it up AT ONCE, never leave it waiting: left waiting, the next value from outside
 *   (the same section replaced a moment later) would merge it back in as typing, and both
 *   having only added at the end, the merge keeps both — the section twice (fix/merge-duplicate-lines).
 *
 * Plain JS so node --test runs it (test/liveSync.test.mjs).
 */
import { merge3 } from "../../../lib/pageMerge.mjs";
import { parseBlocks } from "./markdown.mjs";

/**
 * @param {string} lastEmitted the Markdown last handed up
 * @param {string | null} pending the editor's Markdown now when a change of its own waits (else null)
 * @param {string} value the new value from outside
 * @returns {{ incoming: string, typed: string | null }} what the editor shows, and (when that isn't
 *   `value`) what to hand up as an ordinary change
 */
export function incomingValue(lastEmitted, pending, value) {
  if (pending === null || pending === lastEmitted) return { incoming: value, typed: null };
  const m = merge3(lastEmitted, pending, value);
  const incoming = m.clean ? m.content : m.bothContent;
  return { incoming, typed: incoming !== value ? incoming : null };
}

/**
 * A transaction adding `markdown`'s blocks at the very end of `state`'s document (the caret stays
 * where the author is typing), or null when there's nothing to add.
 */
export function appendTr(state, markdown) {
  const add = String(markdown ?? "").replace(/^\s+|\s+$/g, "");
  if (!add) return null;
  const blocks = parseBlocks(`${add}\n`);
  if (!blocks.length) return null;
  return state.tr.insert(state.doc.content.size, blocks.map((b) => state.schema.nodeFromJSON(b)));
}
