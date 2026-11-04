/**
 * Video, audio and file blocks on a page: the file is uploaded to Markdrop as an item of its own
 * (in the page's workspace and folder) and embedded with `::markdrop{src=<slug>}`, so it plays and
 * previews the way every Markdrop file does. (Page assets are images only for now; see DEVIATIONS.)
 *
 * The block goes in where "/video" was typed once the upload is done; the place is kept through
 * any edits made meanwhile.
 */
import type { Editor, Range } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import type { PagesEditorHost } from "../types";

export type MediaKind = "video" | "audio" | "file";

const ACCEPT: Record<MediaKind, string> = { video: "video/*", audio: "audio/*", file: "" };

/** What VisualEditor leaves on `editor.storage` for blocks that need the host. */
export interface EditorServices {
  pages?: PagesEditorHost;
  toast?: { success: (m: string) => void; error: (m: string) => void; info?: (m: string) => void };
  /** AI's "/" commands (blocks.ts AI_ITEMS). */
  ai?: (e: Editor, r: Range, command: "write" | "actions" | "summary") => void;
}

export function services(editor: Editor): EditorServices {
  return ((editor.storage as unknown as { dxeServices?: EditorServices }).dxeServices ??= {});
}

/** A position that follows the document's edits until `stop()`. */
function tracked(editor: Editor, pos: number) {
  const box = { pos, deleted: false };
  const on = ({ transaction }: { transaction: Transaction }) => {
    const r = transaction.mapping.mapResult(box.pos, -1);
    box.pos = r.pos;
  };
  editor.on("transaction", on);
  return { box, stop: () => editor.off("transaction", on) };
}

export function uploadMedia(editor: Editor, range: Range, kind: MediaKind) {
  const s = services(editor);
  editor.chain().focus().deleteRange(range).run();
  const upload = s.pages?.uploadFile;
  if (!upload) {
    // No uploads here: pick an existing Markdrop file instead.
    editor.chain().focus().insertContent({ type: "directiveLeaf", attrs: { name: "markdrop", attributes: {} } }).run();
    return;
  }
  const input = document.createElement("input");
  input.type = "file";
  if (ACCEPT[kind]) input.accept = ACCEPT[kind];
  const at = tracked(editor, editor.state.selection.from);
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return at.stop();
    s.toast?.info?.(`Uploading ${f.name}…`);
    try {
      const { slug } = await upload(f);
      const pos = Math.min(at.box.pos, editor.state.doc.content.size);
      editor.chain().insertContentAt(pos, { type: "directiveLeaf", attrs: { name: "markdrop", attributes: { src: slug } } }).run();
      s.toast?.success(`${f.name} added`);
    } catch (e) {
      s.toast?.error(e instanceof Error && e.message ? e.message : `Couldn't upload ${f.name}.`);
    } finally {
      at.stop();
    }
  };
  input.addEventListener("cancel", () => at.stop());
  input.click();
}
