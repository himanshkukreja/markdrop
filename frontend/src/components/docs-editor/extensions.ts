/**
 * The editor's extensions: the shared schema (core/schema.mjs) with React node views, the slash
 * menu, placeholders, block moving and a few shortcuts.
 */
import { Extension, type AnyExtension, type Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import type { ComponentType } from "react";
import { Placeholder } from "@tiptap/extensions";
import { columnResizing } from "@tiptap/pm/tables";
import { baseExtensions, withOverrides } from "./core/schema.mjs";
import { CalloutView, CardView, CardsView, DetailsView, PrivateView, StepsView, TabsView } from "./views/containers";
import { FigureView, LeafView } from "./views/media";
import { CodeBlockView, InlineMathView, MathBlockView, RawBlockView, mermaidKeys } from "./views/code";
import { MentionView } from "./views/pageItems";
import { itemsFor } from "./blocks";
import { EmojiCommand, PageKeys } from "./pageKeys";
import { SlashCommand, type SlashStore } from "./menus/slash";
import { PeopleMention, type PeopleStore } from "./menus/people";
import { MoveBlockKeys } from "./menus/BlockHandle";
import { BlockDnd } from "./menus/dnd";
import { BlockSelectionExt } from "./menus/blockSelection";
import { ColumnsExt, columnView, columnsView } from "./menus/columns";
import { ButtonView } from "./views/ButtonView";
import { SignoffView } from "./views/SignoffView";
import { signoffLockPlugin } from "./views/signoffLock";
import { AiKeys, aiHooks } from "./menus/aiKeys";

const view = (component: ComponentType<ReactNodeViewProps>, options?: Parameters<typeof ReactNodeViewRenderer>[1]) => ({
  addNodeView() {
    return ReactNodeViewRenderer(component, options);
  },
});

/** A list item with a real checkbox when it is a GFM task (`- [ ]` / `- [x]`). Plain DOM: lists can be long. */
function taskItemView() {
  return {
    addNodeView() {
      return ({ node: initial, getPos, editor }: { node: PMNode; getPos: () => number | undefined; editor: Editor }) => {
        let node = initial;
        const li = document.createElement("li");
        const content = document.createElement("div");
        content.className = "dxe-li";
        let box: HTMLInputElement | null = null;
        const render = () => {
          const checked = node.attrs.checked;
          if (typeof checked === "boolean") {
            if (!box) {
              box = document.createElement("input");
              box.type = "checkbox";
              box.className = "dxe-task";
              box.contentEditable = "false";
              box.setAttribute("aria-label", "Done");
              box.addEventListener("mousedown", (e) => e.preventDefault());
              box.addEventListener("change", () => {
                const pos = getPos();
                // Read only (a page opens so until its edit lock is taken): the box stays as it is.
                // (Not `disabled`: the node view isn't redrawn when the editor becomes editable.)
                if (typeof pos !== "number" || !editor.isEditable) {
                  if (box) box.checked = node.attrs.checked === true;
                  return;
                }
                editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !!box?.checked }));
              });
              box.addEventListener("animationend", () => box?.classList.remove("dxe-task--pop"));
              li.prepend(box);
            } else if (checked && li.dataset.checked === undefined) {
              // Checked just now: the box pops (docs-editor.css; nothing with reduced motion).
              box.classList.add("dxe-task--pop");
            }
            box.checked = checked;
            li.dataset.task = "";
            if (checked) li.dataset.checked = "";
            else delete li.dataset.checked;
          } else {
            box?.remove();
            box = null;
            delete li.dataset.task;
            delete li.dataset.checked;
          }
        };
        li.append(content);
        render();
        // A page opens read only until its edit lock is taken: setEditable emits "update", and
        // the box follows (node views aren't redrawn for it).
        const sync = () => {
          if (box && box.disabled === editor.isEditable) box.disabled = !editor.isEditable;
        };
        editor.on("update", sync);
        return {
          dom: li,
          contentDOM: content,
          update(n: PMNode) {
            if (n.type !== node.type) return false;
            node = n;
            render();
            return true;
          },
          destroy: () => editor.off("update", sync),
          stopEvent: (e: Event) => e.target === box,
          ignoreMutation: (m: { target: Node; type: string }) => !!box && (m.target === box || (m.type === "childList" && m.target === li)),
        };
      };
    },
  };
}

/** Ctrl/⌘ K: link (the toolbar's form), Ctrl/⌘ Shift K: keyboard key. */
const DocsKeys = Extension.create({
  name: "docsKeys",
  addKeyboardShortcuts() {
    return {
      "Mod-k": () => {
        if (this.editor.state.selection.empty) return false;
        (this.editor.storage as unknown as { docsLink?: { open?: () => void } }).docsLink?.open?.();
        return true;
      },
      "Mod-Shift-k": () => this.editor.commands.toggleMark("kbd"),
      // Tables hold one line per cell in Markdown: Enter moves to the next row instead of breaking.
      "Shift-Enter": () => {
        const { $from } = this.editor.state.selection;
        return $from.parent.type.name === "tableCell" || $from.parent.type.name === "tableHeader";
      },
    };
  },
});

/** The parent at `pos`, or null. The placeholder plugin can ask about a document that isn't
 *  `editor.state.doc` yet (an undo or redo that shortens it): a position past its end throws. */
function parentAt(editor: Editor, node: PMNode, pos: number): PMNode | null {
  const doc = editor.state.doc;
  if (pos < 0 || pos > doc.content.size || doc.nodeAt(pos) !== node) return null;
  return doc.resolve(pos).parent;
}

function placeholderFor({ node, editor, pos }: { node: PMNode; editor: Editor; pos: number }, empty: string) {
  if (editor.isEmpty) {
    const ai = aiHooks(editor);
    return ai?.on && ai.space ? "Press Space for AI, or / for commands" : empty;
  }
  if (node.type.name === "heading") {
    if (parentAt(editor, node, pos)?.type.name === "steps") return "Step title";
    return `Heading ${node.attrs.level}`;
  }
  if (node.type.name === "paragraph") {
    const parent = parentAt(editor, node, pos);
    if (!parent) return "Type / for blocks";
    if (parent.type.name === "listItem") return typeof parent.attrs.checked === "boolean" ? "To-do" : "List";
    if (parent.type.name === "blockquote") return "Empty quote";
    if (parent.type.name === "details") return "Empty toggle. Click or drop blocks inside.";
  }
  if (node.type.name === "codeBlock") return "Code";
  if (node.type.name === "mathBlock") return "LaTeX, e.g. E = mc^2";
  // A page with AI: the empty line says Space asks it (as the key does, menus/aiKeys.ts).
  const ai = aiHooks(editor);
  if (ai?.on && ai.space && node.type.name === "paragraph") return "Press Space for AI, or / for blocks";
  return "Type / for blocks";
}

/** The React node views (the same in the editor and in an AI suggestion's preview). */
function viewOverrides() {
  return {
    callout: view(CalloutView),
    steps: view(StepsView),
    tabs: view(TabsView),
    cards: view(CardsView),
    card: view(CardView),
    details: view(DetailsView),
    private: view(PrivateView),
    directiveLeaf: view(LeafView),
    figure: view(FigureView),
    rawBlock: view(RawBlockView),
    mathBlock: view(MathBlockView),
    codeBlock: view(CodeBlockView),
    inlineMath: view(InlineMathView, { as: "span" }),
    mention: view(MentionView, { as: "span" }),
    listItem: taskItemView(),
    columns: columnsView(),
    column: columnView(),
    button: view(ButtonView),
    // Sign-offs: the card, and signed blocks (and the sections they lock) kept as they are.
    signoff: {
      ...view(SignoffView),
      addProseMirrorPlugins(this: { parent?: () => unknown[]; editor: import("@tiptap/core").Editor }) {
        return [...((this.parent?.() as unknown[]) ?? []), signoffLockPlugin(this.editor)];
      },
    },
  };
}

/** Esc in a mermaid block's code shows its diagram, Enter edits it again (views/code.tsx); ahead of the page's Esc. */
const MermaidKeys = Extension.create({
  name: "mermaidKeys",
  priority: 1000,
  addKeyboardShortcuts() {
    return mermaidKeys(this.editor);
  },
});

export function buildExtensions({ slash, listboxId, placeholder, blocks, emoji, people }: {
  slash: SlashStore;
  listboxId: string;
  placeholder?: string;
  blocks?: readonly string[];
  /** A page: Notion-style keys and Markdown shortcuts, and the `:emoji` menu in this store. */
  emoji?: { store: SlashStore; listboxId: string } | null;
  /** A page: the `@` people picker (menus/people.tsx), in this store. */
  people?: { store: PeopleStore; listboxId: string } | null;
}): AnyExtension[] {
  const overrides = viewOverrides();
  const page = !!emoji;
  const base = withOverrides(baseExtensions(), overrides as unknown as Record<string, Record<string, unknown>>).map((e) =>
    // Pages: table columns resize by dragging their edges (widths are written as `{widths=…}`).
    // (The resizing plugin is added always: a page opens read only until its edit lock is taken,
    // and TipTap only adds it to an editor that is editable when created; it checks itself.)
    page && e.name === "table"
      ? (e as unknown as { extend: (o: Record<string, unknown>) => AnyExtension }).extend({
          addProseMirrorPlugins(this: { parent?: () => unknown[] }) {
            return [columnResizing({ handleWidth: 6, cellMinWidth: 64, defaultCellMinWidth: 64, lastColumnResizable: false, View: null }), ...((this.parent?.() as unknown[]) ?? []).filter((pl) => !(pl as { spec?: { key?: unknown } }).spec?.key || !String((pl as { spec: { key: { key?: string } } }).spec.key.key ?? "").startsWith("tableColumnResizing"))];
          },
        })
      : e,
  );
  return [
    ...base,
    ...(page ? [BlockSelectionExt, ColumnsExt] : []),
    Placeholder.configure({
      placeholder: (p) => placeholderFor(p as never, placeholder ?? "Start writing, or type / to add a block"),
      includeChildren: true,
      showOnlyCurrent: true,
    }),
    SlashCommand(slash, listboxId, itemsFor(blocks)),
    ...(emoji ? [PageKeys, EmojiCommand(emoji.store, emoji.listboxId)] : []),
    ...(people ? [PeopleMention(people.store, people.listboxId)] : []),
    MermaidKeys,
    MoveBlockKeys,
    BlockDnd,
    DocsKeys,
    AiKeys,
  ];
}

/**
 * A read-only editor's extensions: the schema and node views, nothing interactive (an AI
 * suggestion's preview draws its answer with them, exactly as Accept will put it in).
 */
export function previewExtensions(): AnyExtension[] {
  return withOverrides(baseExtensions(), viewOverrides() as unknown as Record<string, Record<string, unknown>>);
}
