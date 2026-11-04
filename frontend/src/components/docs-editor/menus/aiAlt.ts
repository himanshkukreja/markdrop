/**
 * Alt text for uploaded images: once an image is uploaded (dropped, pasted, picked), AI is asked
 * to describe it. When it answers, every figure with that address whose description is still the
 * file's name (or empty) gets the suggestion, marked "✦ suggested" (views/media.tsx) until someone
 * edits it. No answer (the model can't see images: 501, a limit, an error) changes nothing, and
 * says nothing: the image just keeps its file-name description.
 *
 * The figure may not be in the document yet when the upload resolves (the caller inserts it
 * next), so the answer is applied whenever it arrives, to whatever figures have that address then.
 */
import { useMemo } from "react";
import type { Editor } from "@tiptap/core";

/** The suggestions shown as "✦ suggested", by image address (alt text as suggested). */
export function suggestedAlts(editor: Editor | null | undefined): Map<string, string> {
  if (!editor) return new Map();
  const st = editor.storage as unknown as { dxeAltSuggested?: Map<string, string> };
  return (st.dxeAltSuggested ??= new Map());
}

/** The description an upload writes from the file's name (until someone types one). */
export const nameAlt = (fileName: string) => fileName.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ");

export function useAltText(altText: ((src: string) => Promise<string | null>) | undefined) {
  return useMemo(() => {
    let editor: Editor | null = null;
    const ref = { altText };
    const apply = (src: string, alt: string, fileName: string) => {
      const fromName = (a: string) => !a.trim() || a === nameAlt(fileName);
      const ed = editor;
      if (!ed || ed.isDestroyed) return;
      const clean = alt.replace(/[\n\r\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
      if (!clean) return;
      const { state } = ed;
      const tr = state.tr;
      let n = 0;
      state.doc.descendants((node, pos) => {
        if ((node.type.name === "figure" || node.type.name === "image") && node.attrs.src === src && fromName(String(node.attrs.alt ?? ""))) {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, alt: clean });
          n++;
        }
        return true;
      });
      if (!n) return;
      suggestedAlts(ed).set(src, clean);
      // Not an undo step of its own: undoing the upload takes the image (and this) away.
      ed.view.dispatch(tr.setMeta("addToHistory", false));
    };
    return {
      set altText(fn: typeof altText) {
        ref.altText = fn;
      },
      attach(e: Editor | null) {
        editor = e;
      },
      /** An image (`fileName`) was uploaded to `src` (its address as the Markdown will write it). */
      uploaded(src: string, fileName: string) {
        const ask = ref.altText;
        if (!ask || !src) return;
        // A moment later: the caller puts the figure in after the upload resolves.
        void ask(src)
          .then((alt) => {
            if (alt) window.setTimeout(() => apply(src, alt, fileName), 0);
          })
          .catch(() => {
            /* silently nothing: no vision, a limit, offline */
          });
      },
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
