/**
 * Keyboard-first editing for pages (a Markdrop document in the block editor), the way Notion
 * works:
 *
 *   Markdown while typing   [] / [x] → to-do · $$ → equation · " → quote (plus #, -, 1., >, ```, ---
 *                           and **bold**, *italic*, `code`, ~~strike~~ from the base editor)
 *   ⌘/Ctrl ⌥ 0…9            Turn into: text, heading 1–3, to-do, bulleted, numbered, toggle, code, quote
 *   ⌘/Ctrl ⇧ ↑ / ↓          move the block (Alt ⇧ ↑ / ↓ too)
 *   ⌘/Ctrl D                duplicate the block
 *   ⌘/Ctrl Enter            check or uncheck a to-do
 *   Esc                     select the block (then Delete, ⌘C, ⌘D, arrows…)
 *   :name                   emoji (`:rocket` → 🚀)
 */
import { Extension, InputRule, type Editor, type Range } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { blockAtCursor, duplicate, moveBlock } from "./menus/BlockHandle";
import { SuggestMenu, emojiKey, type SlashStore } from "./menus/slash";
import { searchEmoji } from "./emoji";
import type { BlockItem } from "./blocks";

export type TurnInto = "text" | "h1" | "h2" | "h3" | "todo" | "bullet" | "numbered" | "toggle" | "code" | "quote";

/** The text block at the caret becomes another kind of block, keeping its text. */
export function turnInto(editor: Editor, kind: TurnInto): boolean {
  const { state } = editor;
  const { $from } = state.selection;
  if (!$from.parent.isTextblock) return false;
  const c = () => editor.chain().focus();
  switch (kind) {
    case "text":
      return c().clearNodes().setParagraph().run();
    case "h1":
    case "h2":
    case "h3":
      return c().clearNodes().setHeading({ level: Number(kind[1]) as 1 | 2 | 3 }).run();
    case "bullet":
      return c().clearNodes().toggleBulletList().run();
    case "numbered":
      return c().clearNodes().toggleOrderedList().run();
    case "todo": {
      const ok = c().clearNodes().toggleBulletList().run();
      if (ok) setChecked(editor, false);
      return ok;
    }
    case "code":
      return c().clearNodes().setCodeBlock().run();
    case "quote":
      return c().clearNodes().toggleBlockquote().run();
    case "toggle": {
      // The line becomes the toggle's summary; its body starts empty, with the caret in it.
      const text = $from.parent.textContent;
      const from = $from.before();
      const to = $from.after();
      const ok = editor
        .chain()
        .focus()
        .insertContentAt({ from, to }, { type: "details", attrs: { label: null, attributes: { summary: text || "Toggle" } }, content: [{ type: "paragraph" }] })
        .run();
      if (ok) {
        const inside = editor.state.doc.resolve(Math.min(from + 2, editor.state.doc.content.size));
        editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(inside)));
      }
      return ok;
    }
  }
}

/** The list item at the caret becomes a to-do (`checked` false/true), or toggles when `null`. */
function setChecked(editor: Editor, value: boolean | null): boolean {
  const { state } = editor;
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === "listItem") {
      const next = value === null ? (typeof n.attrs.checked === "boolean" ? !n.attrs.checked : null) : value;
      if (next === null) return false;
      editor.view.dispatch(state.tr.setNodeMarkup($from.before(d), undefined, { ...n.attrs, checked: next }));
      return true;
    }
  }
  return false;
}

const TURN_KEYS: TurnInto[] = ["text", "h1", "h2", "h3", "todo", "bullet", "numbered", "toggle", "code", "quote"];

export const PageKeys = Extension.create({
  name: "pageKeys",
  addKeyboardShortcuts() {
    const keys: Record<string, () => boolean> = {
      "Mod-Shift-ArrowUp": () => {
        const t = blockAtCursor(this.editor.state);
        return t ? moveBlock(this.editor, t, -1) : false;
      },
      "Mod-Shift-ArrowDown": () => {
        const t = blockAtCursor(this.editor.state);
        return t ? moveBlock(this.editor, t, 1) : false;
      },
      "Mod-d": () => {
        const t = blockAtCursor(this.editor.state);
        if (!t) return false;
        duplicate(this.editor, t);
        return true;
      },
      "Mod-Enter": () => setChecked(this.editor, null),
      Escape: () => {
        const { state } = this.editor;
        if (state.selection instanceof NodeSelection) return false;
        const t = blockAtCursor(state);
        if (!t) return false;
        this.editor.view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, t.pos)));
        return true;
      },
    };
    TURN_KEYS.forEach((k, i) => {
      keys[`Mod-Alt-${i}`] = () => turnInto(this.editor, k);
    });
    return keys;
  },
  addInputRules() {
    const editor = this.editor;
    const atLineStart = (state: Editor["state"], range: Range) => state.doc.resolve(range.from).parent.type.name === "paragraph";
    return [
      // [] or [ ] or [x] then a space: a to-do.
      new InputRule({
        find: /^\[([ xX]?)\]\s$/,
        handler: ({ state, range, match, chain }) => {
          if (!atLineStart(state, range)) return null;
          const checked = /x/i.test(match[1] ?? "");
          chain().deleteRange(range).toggleBulletList().run();
          setChecked(editor, checked);
        },
      }),
      // $$ then a space: an equation block.
      new InputRule({
        find: /^\$\$\s$/,
        handler: ({ state, range, chain }) => {
          if (!atLineStart(state, range)) return null;
          chain().deleteRange(range).setNode("mathBlock").run();
        },
      }),
      // " then a space: a quote.
      new InputRule({
        find: /^["“]\s$/,
        handler: ({ state, range, chain }) => {
          if (!atLineStart(state, range)) return null;
          chain().deleteRange(range).toggleBlockquote().run();
        },
      }),
    ];
  },
});

/** `:` + at least two letters: the emoji menu (Enter puts the emoji in). */
export function EmojiCommand(store: SlashStore, listboxId: string) {
  return SuggestMenu({
    name: "pageEmoji",
    key: emojiKey,
    char: ":",
    store,
    listboxId,
    minQuery: 2,
    find: (q) =>
      /^[a-z0-9_+-]+$/i.test(q)
        ? searchEmoji(q, 8).map(
            (em): BlockItem => ({
              id: `emoji-${em.n}`,
              label: `:${em.n}:`,
              hint: em.k ?? "",
              icon: "",
              glyph: em.e,
              keywords: "",
              run: (e, r) => {
                e.chain().focus().deleteRange(r).insertContent(em.e).run();
              },
            }),
          )
        : [],
  });
}
