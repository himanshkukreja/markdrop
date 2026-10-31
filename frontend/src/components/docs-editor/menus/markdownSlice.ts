/**
 * Markdown ⇄ slices of the document: pasting Markdown as blocks, copying blocks as Markdown, and
 * the selection as Markdown for Ask AI (and its answer back into the document).
 */
import type { Editor } from "@tiptap/core";
import { Fragment, Slice, type Schema } from "@tiptap/pm/model";
import { parseBlocks, serializeFlow } from "../core/markdown.mjs";

/** Pasted plain text is Markdown: callouts, tables and all come in as blocks. */
export function markdownSlice(text: string, schema: Schema, plain: boolean): Slice {
  if (plain) {
    const paras = text.split(/\n{2,}/).map((t) => schema.nodes.paragraph.create(null, t ? schema.text(t) : undefined));
    return Slice.maxOpen(Fragment.from(paras));
  }
  try {
    const blocks = parseBlocks(text.replace(/\r\n?/g, "\n"), { verify: true });
    if (!blocks.length) return Slice.empty;
    return Slice.maxOpen(Fragment.fromJSON(schema, blocks));
  } catch {
    return Slice.maxOpen(Fragment.from(schema.nodes.paragraph.create(null, schema.text(text))));
  }
}

/** Copied blocks go to the clipboard's text as docs Markdown. */
export function sliceMarkdown(slice: Slice): string {
  const json = slice.content.toJSON() as Array<{ type: string }> | null;
  if (!json?.length) return "";
  const inlineOnly = slice.content.childCount > 0 && slice.content.firstChild!.isInline;
  if (inlineOnly) return slice.content.textBetween(0, slice.content.size, "\n\n");
  return serializeFlow(json as never);
}

/** The selection as Markdown, marks and all (a part of a paragraph is written as a paragraph). */
export function selectionMarkdown(editor: Editor, from: number, to: number): string {
  const slice = editor.state.doc.slice(from, to);
  const json = slice.content.toJSON() as Array<{ type: string }> | null;
  if (!json?.length) return "";
  if (slice.content.firstChild?.isInline) return serializeFlow([{ type: "paragraph", content: json }] as never).trim();
  return serializeFlow(json as never, { preserve: false }).trim();
}

/**
 * Puts Markdown in place of [from, to): inside one line of text, a one-paragraph answer goes in as
 * text (the line keeps its type: a heading stays a heading); anything else goes in as blocks.
 */
export function replaceWithMarkdown(editor: Editor, from: number, to: number, markdown: string): boolean {
  const { state } = editor;
  if (from < 0 || to > state.doc.content.size || to < from) return false;
  const slice = markdownSlice(markdown, state.schema, false);
  const $from = state.doc.resolve(from);
  const $to = state.doc.resolve(to);
  const tr = state.tr;
  const one = slice.content.childCount === 1 ? slice.content.firstChild : null;
  if ($from.sameParent($to) && $from.parent.isTextblock && one && one.type.name === "paragraph") {
    tr.replaceWith(from, to, one.content);
  } else {
    tr.replaceRange(from, to, slice);
  }
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}
