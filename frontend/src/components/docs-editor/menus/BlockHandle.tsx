"use client";

/**
 * The handle beside the block under the pointer: "+" opens the block menu on a new line below,
 * the grip drags the block (drop anywhere; the drop cursor shows where) or, clicked, opens Move up /
 * Move down / Duplicate / Delete. Alt+Shift+↑/↓ moves the block at the cursor from the keyboard.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { Extension, type Editor } from "@tiptap/core";
import { NodeSelection, type EditorState } from "@tiptap/pm/state";
import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import { Dropdown, Icon } from "@/components/ui";
import { serializeFlow } from "../core/markdown.mjs";
import { openSlashAt } from "./slash";

/** Containers whose children can be reordered freely. */
const FLOW = new Set(["doc", "callout", "steps", "details", "tab", "card", "blockquote"]);

function movable(node: PMNode, parent: PMNode) {
  if (!node.isBlock) return false;
  if (FLOW.has(parent.type.name)) return true;
  return (node.type.name === "tab" && parent.type.name === "tabs") || (node.type.name === "card" && parent.type.name === "cards") || node.type.name === "listItem";
}

export interface BlockTarget {
  pos: number;
  node: PMNode;
}

/** The innermost movable block at a resolved position (the block itself when `inside` points at one). */
function targetFrom(state: EditorState, $pos: ResolvedPos, inside?: number): BlockTarget | null {
  if (inside !== undefined && inside >= 0) {
    const n = state.doc.nodeAt(inside);
    const $in = state.doc.resolve(inside);
    if (n && n.isBlock && n.isAtom && movable(n, $in.parent)) return { pos: inside, node: n };
  }
  for (let d = $pos.depth; d >= 1; d--) {
    const node = $pos.node(d);
    if (movable(node, $pos.node(d - 1))) return { pos: $pos.before(d), node };
  }
  return null;
}

export function blockAtCursor(state: EditorState): BlockTarget | null {
  const sel = state.selection;
  if (sel instanceof NodeSelection && sel.node.isBlock) {
    const $p = state.doc.resolve(sel.from);
    if (movable(sel.node, $p.parent)) return { pos: sel.from, node: sel.node };
  }
  return targetFrom(state, sel.$from);
}

export function moveBlock(editor: Editor, t: BlockTarget, dir: -1 | 1): boolean {
  const { state } = editor;
  const $pos = state.doc.resolve(t.pos);
  const index = $pos.index();
  const parent = $pos.parent;
  const j = index + dir;
  if (j < 0 || j >= parent.childCount) return false;
  const other = parent.child(j);
  const tr = state.tr.delete(t.pos, t.pos + t.node.nodeSize);
  const at = dir < 0 ? t.pos - other.nodeSize : t.pos + other.nodeSize;
  tr.insert(at, t.node);
  tr.setSelection(NodeSelection.create(tr.doc, at));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

function duplicate(editor: Editor, t: BlockTarget) {
  const at = t.pos + t.node.nodeSize;
  editor.view.dispatch(editor.state.tr.insert(at, t.node.copy(t.node.content)).scrollIntoView());
}

function remove(editor: Editor, t: BlockTarget) {
  editor.view.dispatch(editor.state.tr.delete(t.pos, t.pos + t.node.nodeSize));
  editor.view.focus();
}

/** Alt+Shift+↑ / ↓ move the block at the cursor. */
export const MoveBlockKeys = Extension.create({
  name: "docsMoveBlock",
  addKeyboardShortcuts() {
    const go = (dir: -1 | 1) => () => {
      const t = blockAtCursor(this.editor.state);
      return t ? moveBlock(this.editor, t, dir) : false;
    };
    return { "Alt-Shift-ArrowUp": go(-1), "Alt-Shift-ArrowDown": go(1) };
  },
});

interface Placed extends BlockTarget {
  top: number;
  left: number;
}

const LABEL: Record<string, string> = {
  paragraph: "paragraph",
  heading: "heading",
  callout: "callout",
  steps: "steps",
  tabs: "tabs",
  tab: "tab",
  cards: "cards",
  card: "card",
  details: "details",
  codeBlock: "code block",
  table: "table",
  figure: "image",
  directiveLeaf: "block",
  bulletList: "list",
  orderedList: "list",
  listItem: "list item",
  blockquote: "quote",
  mathBlock: "math",
  rawBlock: "Markdown block",
  horizontalRule: "divider",
};

export function BlockHandle({ editor, container }: { editor: Editor; container: RefObject<HTMLDivElement | null> }) {
  const [t, setT] = useState<Placed | null>(null);
  const [menu, setMenu] = useState(false);
  const frozen = useRef(false);
  frozen.current = menu;

  useEffect(() => {
    const wrap = container.current;
    if (!wrap) return;
    const view = editor.view;
    let raf = 0;
    const place = (x: number, y: number) => {
      if (frozen.current || !editor.isEditable) return;
      const box = view.dom.getBoundingClientRect();
      // Probe a little inside the text column so the gutter left of it still finds the block.
      const found = view.posAtCoords({ left: Math.max(x, box.left + 24), top: y });
      if (!found) return;
      const $pos = view.state.doc.resolve(found.pos);
      const target = targetFrom(view.state, $pos, found.inside);
      if (!target) return setT(null);
      const dom = view.nodeDOM(target.pos);
      if (!(dom instanceof HTMLElement)) return setT(null);
      const r = dom.getBoundingClientRect();
      const w = wrap.getBoundingClientRect();
      const cs = getComputedStyle(dom);
      const line = Math.min(parseFloat(cs.lineHeight) || 24, 40);
      const padTop = parseFloat(cs.paddingTop) || 0;
      setT({ ...target, top: r.top - w.top + padTop + Math.max(0, (line - 24) / 2), left: r.left - w.left });
    };
    const onMove = (e: MouseEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => place(e.clientX, e.clientY));
    };
    const onLeave = (e: MouseEvent) => {
      if (!frozen.current && !wrap.contains(e.relatedTarget as Node | null)) setT(null);
    };
    const onKey = () => !frozen.current && setT(null);
    wrap.addEventListener("mousemove", onMove);
    wrap.addEventListener("mouseleave", onLeave);
    view.dom.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      wrap.removeEventListener("mousemove", onMove);
      wrap.removeEventListener("mouseleave", onLeave);
      view.dom.removeEventListener("keydown", onKey);
    };
  }, [editor, container]);

  if (!t || !editor.isEditable) return null;
  const what = LABEL[t.node.type.name] ?? "block";
  const current = (): BlockTarget | null => {
    const n = editor.state.doc.nodeAt(t.pos);
    return n ? { pos: t.pos, node: n } : null;
  };

  return (
    <div className="dxe-handle" style={{ top: t.top, left: t.left }} contentEditable={false}>
      <button
        type="button"
        className="dxe-handle__btn"
        aria-label={`Add a block below this ${what}`}
        title="Add a block below"
        onClick={() => {
          const c = current();
          if (c) openSlashAt(editor, c.pos + c.node.nodeSize);
          setT(null);
        }}
      >
        <Icon name="plus" />
      </button>
      <Dropdown
        open={menu}
        onOpenChange={setMenu}
        align="left"
        portal
        aria-label={`${what} actions`}
        trigger={
          <button
            type="button"
            className="dxe-handle__btn dxe-handle__grip"
            aria-label={`Move or change this ${what}`}
            title="Drag to move · click for options"
            draggable
            onDragStart={(e) => {
              const c = current();
              if (!c) return;
              const view = editor.view;
              const sel = NodeSelection.create(view.state.doc, c.pos);
              view.dispatch(view.state.tr.setSelection(sel));
              const slice = sel.content();
              (view as unknown as { dragging: unknown }).dragging = { slice, move: true, node: sel };
              e.dataTransfer.effectAllowed = "copyMove";
              e.dataTransfer.clearData();
              e.dataTransfer.setData("text/plain", serializeFlow(slice.content.toJSON() as never));
              const dom = view.nodeDOM(c.pos);
              if (dom instanceof HTMLElement) e.dataTransfer.setDragImage(dom, 0, 0);
            }}
            onDragEnd={() => {
              const view = editor.view as unknown as { dragging: unknown };
              const d = view.dragging;
              window.setTimeout(() => {
                if (view.dragging === d) view.dragging = null;
              }, 50);
              setT(null);
            }}
          >
            <Icon name="grip" />
          </button>
        }
        items={[
          { label: "Move up", icon: "arrowUp", kbd: "Alt ⇧ ↑", onClick: () => { const c = current(); if (c) moveBlock(editor, c, -1); } },
          { label: "Move down", icon: "arrowDown", kbd: "Alt ⇧ ↓", onClick: () => { const c = current(); if (c) moveBlock(editor, c, 1); } },
          { label: "Duplicate", icon: "copy", onClick: () => { const c = current(); if (c) duplicate(editor, c); } },
          { label: `Delete ${what}`, icon: "trash", danger: true, separated: true, onClick: () => { const c = current(); if (c) remove(editor, c); setT(null); } },
        ]}
      />
    </div>
  );
}
