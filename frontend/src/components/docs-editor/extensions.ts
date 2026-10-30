/**
 * The editor's extensions: the shared schema (core/schema.mjs) with React node views, the slash
 * menu, placeholders, block moving and a few shortcuts.
 */
import { Extension, type AnyExtension, type Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import type { ComponentType } from "react";
import { Placeholder } from "@tiptap/extensions";
import { baseExtensions, withOverrides } from "./core/schema.mjs";
import { CalloutView, CardView, CardsView, DetailsView, StepsView, TabsView } from "./views/containers";
import { FigureView, LeafView } from "./views/media";
import { CodeBlockView, InlineMathView, MathBlockView, RawBlockView } from "./views/code";
import { SlashCommand, type SlashStore } from "./menus/slash";
import { MoveBlockKeys } from "./menus/BlockHandle";

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
                if (typeof pos !== "number" || !editor.isEditable) return;
                editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !!box?.checked }));
              });
              li.prepend(box);
            }
            box.checked = checked;
            box.disabled = !editor.isEditable;
            li.dataset.task = "";
          } else {
            box?.remove();
            box = null;
            delete li.dataset.task;
          }
        };
        li.append(content);
        render();
        return {
          dom: li,
          contentDOM: content,
          update(n: PMNode) {
            if (n.type !== node.type) return false;
            node = n;
            render();
            return true;
          },
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

function placeholderFor({ node, editor, pos }: { node: PMNode; editor: Editor; pos: number }, empty: string) {
  if (editor.isEmpty) return empty;
  if (node.type.name === "heading") {
    const $p = editor.state.doc.resolve(pos);
    if ($p.parent.type.name === "steps") return "Step title";
    return `Heading ${node.attrs.level}`;
  }
  if (node.type.name === "codeBlock") return "Code";
  if (node.type.name === "mathBlock") return "LaTeX, e.g. E = mc^2";
  return "Type / for blocks";
}

export function buildExtensions({ slash, listboxId, placeholder }: { slash: SlashStore; listboxId: string; placeholder?: string }): AnyExtension[] {
  const overrides = {
    callout: view(CalloutView),
    steps: view(StepsView),
    tabs: view(TabsView),
    cards: view(CardsView),
    card: view(CardView),
    details: view(DetailsView),
    directiveLeaf: view(LeafView),
    figure: view(FigureView),
    rawBlock: view(RawBlockView),
    mathBlock: view(MathBlockView),
    codeBlock: view(CodeBlockView),
    inlineMath: view(InlineMathView, { as: "span" }),
    listItem: taskItemView(),
  };
  return [
    ...withOverrides(baseExtensions(), overrides as unknown as Record<string, Record<string, unknown>>),
    Placeholder.configure({
      placeholder: (p) => placeholderFor(p as never, placeholder ?? "Start writing, or type / to add a block"),
      includeChildren: true,
      showOnlyCurrent: true,
    }),
    SlashCommand(slash, listboxId),
    MoveBlockKeys,
    DocsKeys,
  ];
}
