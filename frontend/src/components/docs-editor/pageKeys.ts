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
import { NodeSelection, Plugin, TextSelection } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import type { Node as PMNode } from "@tiptap/pm/model";
import { blockAtCursor, duplicate, moveBlock } from "./menus/BlockHandle";
import { BlockSelection, blockStartAt, currentBlock, siblings } from "./menus/blockSelection";
import { indentRun, outdentRun, runOf } from "./menus/blockOps";
import type { ColorChoice } from "./menus/ColorMenu";
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

/**
 * Turn into for several blocks (a block selection): one text selection over all of them, then the
 * same command (a toggle is made per block); the result stays selected as blocks.
 */
export function turnBlocks(editor: Editor, blocks: Array<{ pos: number; node: PMNode }>, kind: TurnInto): boolean {
  if (!blocks.length) return false;
  if (blocks.length === 1 || kind === "toggle") {
    let ok = false;
    // Last first: earlier positions don't move.
    for (const b of [...blocks].reverse()) {
      const n = editor.state.doc.nodeAt(b.pos);
      if (!n) continue;
      const inside = firstText(editor.state.doc, b.pos);
      if (inside === null) continue;
      editor.chain().setTextSelection(inside).run();
      ok = turnInto(editor, kind) || ok;
    }
    return ok;
  }
  const first = firstText(editor.state.doc, blocks[0].pos);
  const lastB = blocks[blocks.length - 1];
  const last = lastText(editor.state.doc, lastB.pos, lastB.pos + lastB.node.nodeSize);
  if (first === null || last === null) return false;
  editor.chain().setTextSelection({ from: first, to: last }).run();
  const ok = turnInto(editor, kind);
  const { from, to } = editor.state.selection;
  const a = blockStartAt(editor.state.doc.resolve(from));
  const b = blockStartAt(editor.state.doc.resolve(to));
  if (a !== null && b !== null) {
    const pair = siblings(editor.state.doc, a, b);
    if (pair) editor.view.dispatch(editor.state.tr.setSelection(BlockSelection.create(editor.state.doc, pair[0], pair[1])));
  }
  return ok;
}

function firstText(doc: PMNode, pos: number): number | null {
  let at: number | null = null;
  const n = doc.nodeAt(pos);
  if (!n) return null;
  if (n.isTextblock) return pos + 1;
  doc.nodesBetween(pos, pos + n.nodeSize, (k, p) => {
    if (at !== null) return false;
    if (k.isTextblock && k.type.name !== "codeBlock") {
      at = p + 1;
      return false;
    }
    return true;
  });
  return at;
}

function lastText(doc: PMNode, from: number, to: number): number | null {
  let at: number | null = null;
  doc.nodesBetween(from, to, (k, p) => {
    if (k.isTextblock && k.type.name !== "codeBlock") at = p + 1 + k.content.size;
    return true;
  });
  return at;
}

/** Tab / Shift+Tab on the block at the caret: nest it under the block before it, or take it out. */
function nest(editor: Editor, dir: 1 | -1): boolean {
  const { state } = editor;
  const { $from } = state.selection;
  if ($from.parent.type.name === "codeBlock" || $from.parent.type.name === "tableCell" || $from.parent.type.name === "tableHeader") return false;
  const at = currentBlock(state);
  const n = at === null ? null : state.doc.nodeAt(at);
  if (at === null || !n) return true;
  // A list item's first line: the list's own Tab (sink / lift) already had its say.
  if (n.type.name === "listItem") return true;
  const run = runOf(state, at, at + n.nodeSize);
  if (run) (dir > 0 ? indentRun : outdentRun)(editor, run);
  return true;
}

/** The last colour used with the format toolbar (⌘⇧H applies it). */
export const lastColor = {
  get(): ColorChoice {
    try {
      const v = localStorage.getItem("dxe_last_color");
      return v ? (JSON.parse(v) as ColorChoice) : { bg: "yellow" };
    } catch {
      return { bg: "yellow" };
    }
  },
  set(c: ColorChoice) {
    try {
      localStorage.setItem("dxe_last_color", JSON.stringify(c));
    } catch {
      /* private mode */
    }
  },
};

/** The selected text's colour (`:span`), or none. */
export function setTextColor(editor: Editor, c: ColorChoice) {
  if (c) {
    editor.chain().focus().setMark("span", { attributes: c }).run();
    lastColor.set(c);
  } else editor.chain().focus().unsetMark("span").run();
}

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
      Tab: () => nest(this.editor, 1),
      "Shift-Tab": () => nest(this.editor, -1),
      "Mod-u": () => this.editor.commands.toggleMark("underline"),
      "Mod-Shift-h": () => {
        if (this.editor.state.selection.empty) return false;
        setTextColor(this.editor, lastColor.get());
        return true;
      },
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
  addProseMirrorPlugins() {
    return [
      // Enter at the end of a done to-do starts an open one (the split copies "checked").
      new Plugin({
        appendTransaction: (trs, _old, state) => {
          if (!trs.some((t) => t.steps.some((s) => s instanceof ReplaceStep))) return null;
          const { $from, empty } = state.selection;
          if (!empty) return null;
          for (let d = $from.depth; d > 0; d--) {
            const n = $from.node(d);
            if (n.type.name !== "listItem") continue;
            if (n.attrs.checked !== true || n.textContent.length) return null;
            const idx = $from.index(d - 1);
            if (idx === 0) return null;
            return state.tr.setNodeMarkup($from.before(d), undefined, { ...n.attrs, checked: false });
          }
          return null;
        },
      }),
    ];
  },
  addInputRules() {
    const atLineStart = (state: Editor["state"], range: Range) => state.doc.resolve(range.from).parent.type.name === "paragraph";
    return [
      // [] or [ ] or [x] then a space: a to-do.
      new InputRule({
        find: /^\[([ xX]?)\]\s$/,
        handler: ({ state, range, match, chain }) => {
          if (!atLineStart(state, range)) return null;
          const checked = /x/i.test(match[1] ?? "");
          chain()
            .deleteRange(range)
            .toggleBulletList()
            .command(({ tr }) => {
              const $f = tr.selection.$from;
              for (let d = $f.depth; d > 0; d--) {
                if ($f.node(d).type.name === "listItem") {
                  tr.setNodeMarkup($f.before(d), undefined, { ...$f.node(d).attrs, checked });
                  return true;
                }
              }
              return false;
            })
            .run();
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
