/**
 * Puts Markdown into a page's editor as its own block(s), after the caret's top-level block (or in
 * place of an empty line), the caret after it. Used by From meetings (memory/MeetingMemory) and Ask
 * Markdrop's Insert (components/assistant). Returns false when the editor can't take it now.
 */
import type { Editor } from "@tiptap/core";

export async function insertAfterCaret(editor: Editor, markdown: string): Promise<boolean> {
  if (editor.isDestroyed || !editor.isEditable) return false;
  const { parseBlocks } = await import("@/components/docs-editor/core/markdown.mjs");
  const parsed = parseBlocks(`${markdown}\n`);
  if (!parsed.length) return false;
  const nodes = parsed.map((b: unknown) => editor.schema.nodeFromJSON(b as never));
  const { state } = editor;
  const index = state.selection.$from.index(0);
  let from = state.doc.content.size;
  let to = from;
  let empty = false;
  state.doc.forEach((n, offset, i) => {
    if (i !== index) return;
    empty = n.type.name === "paragraph" && n.content.size === 0;
    from = empty ? offset : offset + n.nodeSize;
    to = empty ? offset + n.nodeSize : from;
  });
  const tr = state.tr.replaceWith(from, to, nodes);
  const end = from + nodes.reduce((a, n) => a + n.nodeSize, 0);
  editor.view.dispatch(tr);
  try {
    editor.chain().focus().setTextSelection(Math.max(1, end - 1)).run();
  } catch { /* a non-text block last: the caret stays */ }
  return true;
}

const plain = (t: string | null | undefined) => (t || "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Puts Markdown into a page's editor at the end of the section headed `heading` (before the next
 * heading of the same or a higher level), or at the end of the page when there's none: Ask
 * Markdrop's Insert from View mode, where there is no caret (the reader's section in view is the
 * place, as for a classic document: assistantCore.insertAfterSection). The caret goes after it.
 */
export async function insertAfterHeading(editor: Editor, markdown: string, heading: string | null): Promise<boolean> {
  if (editor.isDestroyed || !editor.isEditable) return false;
  const { parseBlocks } = await import("@/components/docs-editor/core/markdown.mjs");
  const parsed = parseBlocks(`${markdown}\n`);
  if (!parsed.length) return false;
  const nodes = parsed.map((b: unknown) => editor.schema.nodeFromJSON(b as never));
  const { state } = editor;
  const want = plain(heading);
  let at = state.doc.content.size;
  let level = 0;
  let found = false;
  let done = false;
  state.doc.forEach((n, offset) => {
    if (done || n.type.name !== "heading") return;
    const l = Number(n.attrs.level) || 1;
    if (found && l <= level) {
      at = offset;
      done = true;
      return;
    }
    if (!found && want && plain(n.textContent) === want) {
      found = true;
      level = l;
    }
  });
  // A trailing empty line takes it in its place (as insertAfterCaret does).
  const last = state.doc.lastChild;
  let to = at;
  if (!done && last && last.type.name === "paragraph" && last.content.size === 0) {
    at = state.doc.content.size - last.nodeSize;
    to = state.doc.content.size;
  }
  editor.view.dispatch(state.tr.replaceWith(at, to, nodes));
  const end = at + nodes.reduce((a, n) => a + n.nodeSize, 0);
  try {
    editor.chain().focus().setTextSelection(Math.max(1, end - 1)).run();
  } catch { /* a non-text block last: the caret stays */ }
  return true;
}
