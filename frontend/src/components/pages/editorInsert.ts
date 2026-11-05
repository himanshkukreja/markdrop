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
