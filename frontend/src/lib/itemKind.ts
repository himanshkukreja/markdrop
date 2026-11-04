/**
 * What kind of thing an item is, in words: "Page", "Doc", "HTML file"… Two items in one folder can
 * share a title (a page and the HTML file it was made from), so every list and every delete dialog
 * names the kind next to the title. Plain module: no React, no imports.
 */

/** The three kinds of document the API names on a delete or in the trash. */
export type DocKindWord = "page" | "document" | "file";

/** From a listing row: `kind` ("markdown" | "artifact"), `editor` ("blocks" on a page) and, on a
 *  file, the API's `type_label` ("HTML file", "PDF"…). */
export function docKindOf(x: { kind?: string | null; editor?: string | null }): DocKindWord {
  if (x.kind === "artifact" || x.kind === "file") return "file";
  if (x.kind === "page" || x.editor === "blocks") return "page";
  return "document";
}

/** The short word for a row's meta line: "Page", "Doc", the file's type ("HTML file", "PDF"), else "File". */
export function kindLabel(x: { kind?: string | null; editor?: string | null; type_label?: string | null }): string {
  const k = docKindOf(x);
  if (k === "page") return "Page";
  if (k === "document") return "Doc";
  return x.type_label?.trim() || "File";
}

// Type labels that are ordinary nouns read lower-case mid-sentence ("the image"); the others are
// names or acronyms ("the PDF", "the HTML file", "the Excel spreadsheet").
const COMMON = new Set(["image", "video", "audio", "text", "web", "file"]);

/** The kind as a noun inside a sentence: "page", "document", "folder", "HTML file", "image", "file". */
export function kindNoun(kind: DocKindWord | "folder" | string | null | undefined, typeLabel?: string | null): string {
  if (kind === "page") return "page";
  if (kind === "folder") return "folder";
  if (kind === "file") {
    const t = typeLabel?.trim();
    if (!t) return "file";
    const first = t.split(/\s+/)[0]!.toLowerCase();
    if (COMMON.has(first)) return t.charAt(0).toLowerCase() + t.slice(1);
    return t;
  }
  return "document";
}
