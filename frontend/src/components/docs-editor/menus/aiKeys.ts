/**
 * AI's keys: ⌘/Ctrl J opens Ask AI on the selection (the format toolbar's AI menu), or the "/ai"
 * prompt when nothing is selected; on a page, Space on an empty line opens the prompt too (as in
 * Notion; a space typed at the start of an empty line does nothing in Markdown anyway).
 *
 * What the keys call lives on `editor.storage.dxeAi` (VisualEditor sets it once AI is available),
 * so this module has no runtime imports and the editor works the same without AI.
 */
import { Extension, type Editor } from "@tiptap/core";
import type { AiPick } from "./aiMenu";
import { TextSelection } from "@tiptap/pm/state";

export interface AiHooks {
  /** AI can be asked here (false when it's off: ⌘J still opens the menu, which says why). */
  on: boolean;
  /** Space on an empty line opens the prompt (pages). */
  space: boolean;
  /** Ask AI on the selection (the toolbar's menu, or a bottom sheet on phones). */
  menu: () => boolean;
  /** The "/ai" prompt at the caret. */
  prompt: () => boolean;
  /** Something AI is already showing (a suggestion, the prompt): keys leave it alone. */
  busy: () => boolean;
  /** Runs a pick from an Ask AI menu on the selection (text or blocks). */
  pick: (p: AiPick) => void;
}

export const aiHooks = (e: Editor): AiHooks | null => (e.storage as unknown as { dxeAi?: AiHooks }).dxeAi ?? null;

/** Is the caret on an empty paragraph where a prompt can go (not in a list, a table or code)? */
export function onEmptyLine(e: Editor): boolean {
  const { selection } = e.state;
  if (!selection.empty || !(selection instanceof TextSelection)) return false;
  const { $from } = selection;
  const p = $from.parent;
  if (p.type.name !== "paragraph" || p.content.size > 0) return false;
  for (let d = $from.depth - 1; d > 0; d--) {
    const n = $from.node(d).type.name;
    if (n === "listItem" || n === "tableCell" || n === "tableHeader") return false;
  }
  return true;
}

export const AiKeys = Extension.create({
  name: "dxeAiKeys",
  addKeyboardShortcuts() {
    return {
      "Mod-j": () => {
        const ai = aiHooks(this.editor);
        if (!ai || !this.editor.isEditable) return false;
        if (ai.busy()) return true;
        const s = this.editor.state.selection;
        const text = !s.empty && this.editor.state.doc.textBetween(s.from, s.to, " ").trim();
        return text ? ai.menu() : ai.prompt();
      },
    };
  },
  onCreate() {
    // Space: handled in a DOM keydown (before the input rules see the space).
    const editor = this.editor;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== " " || ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey || ev.isComposing || editor.view.composing) return;
      const ai = aiHooks(editor);
      if (!ai?.on || !ai.space || !editor.isEditable || ai.busy() || !onEmptyLine(editor)) return;
      if (ai.prompt()) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };
    editor.view.dom.addEventListener("keydown", onKey, true);
    (this.storage as { off?: () => void }).off = () => editor.view.dom.removeEventListener("keydown", onKey, true);
  },
  onDestroy() {
    (this.storage as { off?: () => void }).off?.();
  },
  addStorage() {
    return {} as { off?: () => void };
  },
});
