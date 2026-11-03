"use client";

/**
 * The handle beside the block under the pointer: "+" opens the block menu on a new line below,
 * the grip drags the block (drop anywhere; the drop cursor shows where) or, clicked, opens Move up /
 * Move down / Duplicate / Delete. Alt+Shift+↑/↓ moves the block at the cursor from the keyboard.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Extension, type Editor } from "@tiptap/core";
import { NodeSelection, type EditorState } from "@tiptap/pm/state";
import { Fragment, type Node as PMNode, type ResolvedPos } from "@tiptap/pm/model";
import { Dropdown, Icon, copyText, useToast, type MenuEntry } from "@/components/ui";
import { slugify } from "@/components/reading/slug";
import { useHost } from "../host";
import { turnBlocks, type TurnInto } from "../pageKeys";
import { serializeFlow } from "../core/markdown.mjs";
import { openSlashAt } from "./slash";
import { anchorable, anchors, blockColor, colorBlock, colorable, ensureAnchor, withoutAnchors } from "./blockOps";
import { BlockSelection, duplicateBlocks } from "./blockSelection";
import { ColorGrid, type ColorChoice } from "./ColorMenu";
import { startBlockDrag } from "./dnd";
import { flip, ghostOut } from "./motion";

/** Containers whose children can be reordered freely. */
const FLOW = new Set(["doc", "callout", "steps", "details", "private", "tab", "card", "blockquote", "column", "indent", "button"]);

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
  // The block and its neighbour trade places, sliding (FLIP).
  const view = editor.view;
  const old = view.nodeDOM(t.pos);
  const r = old instanceof HTMLElement ? old.getBoundingClientRect() : null;
  flip(view, () => view.dispatch(tr.scrollIntoView()), r ? { from: { x: r.left, y: r.top }, find: () => view.nodeDOM(at) as HTMLElement | null } : undefined);
  view.focus();
  return true;
}

export function duplicate(editor: Editor, t: BlockTarget) {
  const at = t.pos + t.node.nodeSize;
  // The copy gets no anchor of its own until someone copies a link to it.
  editor.view.dispatch(editor.state.tr.insert(at, withoutAnchors(Fragment.from(t.node), anchors(editor.state.doc))).scrollIntoView());
}

export function remove(editor: Editor, t: BlockTarget) {
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
  /** Opened by a long press (touch) or from the touch bar: the handle sits at the block's right. */
  touch?: boolean;
}

/** The address of this page at a block (what "Copy link to block" copies). */
function blockLink(id: string) {
  return `${window.location.origin}${window.location.pathname.replace(/\/$/, "")}#${id}`;
}

/** The block menu, opened from outside (the touch bar): `editor.storage.dxeBlockMenu.open(pos)`. */
export interface BlockMenuApi {
  open: (pos: number) => void;
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
  private: "private section",
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

/** Where the empty line with the caret is (it gets a "+" without hovering), relative to `wrap`. */
function emptyLineAt(editor: Editor, wrap: HTMLElement): { pos: number; top: number; left: number } | null {
  const { state, view } = editor;
  const sel = state.selection;
  if (!sel.empty || !view.hasFocus()) return null;
  const $p = sel.$from;
  const node = $p.parent;
  if (node.type.name !== "paragraph" || node.content.size > 0 || $p.depth < 1) return null;
  if (!FLOW.has($p.node($p.depth - 1).type.name)) return null;
  const dom = view.nodeDOM($p.before());
  if (!(dom instanceof HTMLElement)) return null;
  const r = dom.getBoundingClientRect();
  const w = wrap.getBoundingClientRect();
  const line = Math.min(parseFloat(getComputedStyle(dom).lineHeight) || 24, 40);
  return { pos: $p.before(), top: r.top - w.top + Math.max(0, (line - 24) / 2), left: r.left - w.left };
}

/** A page's "Turn into" (the block handle menu): kind, label, icon, shortcut. */
const TURN: Array<[TurnInto, string, string, string]> = [
  ["text", "Text", "lines", "⌘ ⌥ 0"],
  ["h1", "Heading 1", "heading", "⌘ ⌥ 1"],
  ["h2", "Heading 2", "heading", "⌘ ⌥ 2"],
  ["h3", "Heading 3", "heading", "⌘ ⌥ 3"],
  ["todo", "To-do list", "checkSquare", "⌘ ⌥ 4"],
  ["bullet", "Bulleted list", "list", "⌘ ⌥ 5"],
  ["numbered", "Numbered list", "list", "⌘ ⌥ 6"],
  ["toggle", "Toggle list", "chevronRight", "⌘ ⌥ 7"],
  ["code", "Code", "code", "⌘ ⌥ 8"],
  ["quote", "Quote", "message", "⌘ ⌥ 9"],
];
const turnable = (n: PMNode) => n.isTextblock && n.type.name !== "codeBlock" ? true : n.type.name === "listItem" || n.type.name === "blockquote" ? !!n.firstChild?.isTextblock : false;

export function BlockHandle({ editor, container }: { editor: Editor; container: RefObject<HTMLDivElement | null> }) {
  const host = useHost();
  const [t, setT] = useState<Placed | null>(null);
  const [caret, setCaret] = useState<{ pos: number; top: number; left: number } | null>(null);

  // The caret on an empty line: a "+" there opens the block menu on that line.
  useEffect(() => {
    const wrap = container.current;
    if (!wrap) return;
    const update = () => setCaret(editor.isEditable ? emptyLineAt(editor, wrap) : null);
    const later = () => window.setTimeout(update, 0);
    editor.on("selectionUpdate", update);
    editor.on("update", update);
    editor.on("focus", update);
    editor.on("blur", later);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("update", update);
      editor.off("focus", update);
      editor.off("blur", later);
    };
  }, [editor, container]);
  const [menu, setMenu] = useState(false);
  const frozen = useRef(false);
  frozen.current = menu;
  const toast = useToast();

  // Touch: a long press on a block opens its menu; the touch bar opens it for the caret's block.
  useEffect(() => {
    const wrap = container.current;
    if (!wrap) return;
    const view = editor.view;
    const openAt = (pos: number) => {
      const n = view.state.doc.nodeAt(pos);
      const dom = view.nodeDOM(pos);
      if (!n || !(dom instanceof HTMLElement) || !editor.isEditable) return;
      const r = dom.getBoundingClientRect();
      const w = wrap.getBoundingClientRect();
      frozen.current = true;
      setT({ pos, node: n, top: r.top - w.top, left: Math.min(r.right, w.right) - w.left - 28, touch: true });
      setMenu(true);
    };
    (editor.storage as unknown as { dxeBlockMenu?: BlockMenuApi }).dxeBlockMenu = { open: openAt };
    let timer = 0;
    let start: { x: number; y: number } | null = null;
    let fired = false;
    const down = (e: TouchEvent) => {
      if (e.touches.length !== 1 || !editor.isEditable) return;
      const p = e.touches[0];
      start = { x: p.clientX, y: p.clientY };
      fired = false;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!start) return;
        const found = view.posAtCoords({ left: start.x, top: start.y });
        if (!found) return;
        const target = targetFrom(view.state, view.state.doc.resolve(found.pos), found.inside);
        if (!target) return;
        fired = true;
        navigator.vibrate?.(8);
        openAt(target.pos);
      }, 520);
    };
    const move = (e: TouchEvent) => {
      const p = e.touches[0];
      if (start && p && Math.hypot(p.clientX - start.x, p.clientY - start.y) > 8) {
        window.clearTimeout(timer);
        start = null;
      }
    };
    const up = (e: TouchEvent) => {
      window.clearTimeout(timer);
      start = null;
      if (fired) e.preventDefault();
    };
    const ctx = (e: Event) => {
      if (fired) e.preventDefault();
    };
    wrap.addEventListener("touchstart", down, { passive: true });
    wrap.addEventListener("touchmove", move, { passive: true });
    wrap.addEventListener("touchend", up);
    wrap.addEventListener("contextmenu", ctx);
    return () => {
      window.clearTimeout(timer);
      wrap.removeEventListener("touchstart", down);
      wrap.removeEventListener("touchmove", move);
      wrap.removeEventListener("touchend", up);
      wrap.removeEventListener("contextmenu", ctx);
    };
  }, [editor, container]);

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
      const top = Math.round(r.top - w.top + padTop + Math.max(0, (line - 24) / 2));
      const left = Math.round(r.left - w.left);
      // The same block where it was: nothing to redraw (the pointer moves every frame).
      setT((cur) => (cur && !cur.touch && cur.pos === target.pos && cur.node === target.node && cur.top === top && cur.left === left ? cur : { ...target, top, left }));
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

  // The handle stays drawn (faded out) at the last block it was on, so it can fade back in there or
  // glide to the next block: it follows the pointer from block to block (transform, 120 ms) and
  // appears in place after being hidden.
  const lastT = useRef<Placed | null>(null);
  if (t) lastT.current = t;
  const shown = t ?? lastT.current;
  const handleRef = useRef<HTMLDivElement>(null);
  const wasOn = useRef(false);
  useLayoutEffect(() => {
    const el = handleRef.current;
    if (el && t && !wasOn.current) {
      el.dataset.jump = "";
      requestAnimationFrame(() => requestAnimationFrame(() => delete el.dataset.jump));
    }
    wasOn.current = !!t;
  }, [t]);

  if (!editor.isEditable) return null;
  const caretHandle =
    !t && caret ? (
      <div className="dxe-handle dxe-handle--caret" style={{ transform: `translate(calc(${caret.left}px - 100% - 6px), ${caret.top}px)` }} contentEditable={false}>
        <button
          type="button"
          className="dxe-handle__btn"
          aria-label="Add a block on this line"
          title="Add a block (or type /)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const n = editor.state.doc.nodeAt(caret.pos);
            if (!n || n.type.name !== "paragraph" || n.content.size) return;
            editor.chain().focus().setTextSelection(caret.pos + 1).insertContent("/").run();
          }}
        >
          <Icon name="plus" />
        </button>
      </div>
    ) : null;
  if (!shown) return caretHandle;
  const what = LABEL[shown.node.type.name] ?? "block";
  const pageMode = !!host.pages;
  const current = (): BlockTarget | null => {
    const n = editor.state.doc.nodeAt(shown.pos);
    return n ? { pos: shown.pos, node: n } : null;
  };
  // A block selection that includes this block: the menu and the drag act on all of it.
  const sel = editor.state.selection;
  const inSel = sel instanceof BlockSelection && shown.pos >= sel.from && shown.pos < sel.to ? sel : null;
  const many = inSel && inSel.blocks().length > 1 ? inSel.blocks().length : 0;
  const targets = () => (inSel ? (editor.state.selection instanceof BlockSelection ? editor.state.selection.blocks() : []) : current() ? [current()!] : []);
  const label = many ? `${many} blocks` : `this ${what}`;
  const close = () => {
    setMenu(false);
    setT(null);
  };

  const color = (c: ColorChoice) => {
    const tr = editor.state.tr;
    for (const b of targets()) colorBlock(tr, b.pos, c);
    if (tr.docChanged) editor.view.dispatch(tr);
    close();
    editor.view.focus();
  };
  const canColor = pageMode && targets().some((b) => colorable(b.node));

  const items: MenuEntry[] = [
    ...(many
      ? [
          { label: "Duplicate", icon: "copy", kbd: "⌘ D", onClick: () => { const s = editor.state.selection; if (s instanceof BlockSelection) duplicateBlocks(editor.view, s); } },
        ]
      : [
          { label: "Move up", icon: "arrowUp", kbd: "Alt ⇧ ↑", onClick: () => { const c = current(); if (c) moveBlock(editor, c, -1); } },
          { label: "Move down", icon: "arrowDown", kbd: "Alt ⇧ ↓", onClick: () => { const c = current(); if (c) moveBlock(editor, c, 1); } },
          { label: "Duplicate", icon: "copy", kbd: pageMode ? "⌘ D" : undefined, onClick: () => { const c = current(); if (c) duplicate(editor, c); } },
        ]),
    ...(pageMode && !many && anchorable(editor.state.doc, shown.pos)
      ? [{
          label: "Copy link to block",
          icon: "link",
          onClick: () => {
            const id = ensureAnchor(editor, shown.pos);
            if (!id) return;
            void copyText(blockLink(id)).then((ok) => (ok ? toast.success("Link to block copied") : toast.error("Couldn't copy the link")));
          },
        }]
      : []),
    ...(pageMode && !many && shown.node.type.name === "heading" && shown.node.textContent.trim()
      ? [{ label: "Copy link to section", icon: "hash", onClick: () => { void copyText(`${window.location.origin}${window.location.pathname.replace(/\/$/, "")}#user-content-${slugify(shown.node.textContent)}`); } }]
      : []),
    ...(canColor
      ? [
          { header: "Colour", separated: true },
          { custom: <ColorGrid current={many ? null : blockColor(shown.node)} onPick={color} /> },
        ]
      : []),
    ...(pageMode && targets().some((b) => turnable(b.node))
      ? [
          { header: "Turn into", separated: true },
          ...TURN.map(([kind, lbl, icon, keys]) => ({
            label: lbl,
            icon,
            kbd: keys,
            onClick: () => {
              const list = targets().filter((b) => turnable(b.node));
              editor.commands.focus();
              turnBlocks(editor, list, kind);
            },
          })),
        ]
      : []),
    {
      label: `Delete ${many ? `${many} blocks` : what}`,
      icon: "trash",
      danger: true,
      separated: true,
      kbd: pageMode ? "Del" : undefined,
      onClick: () => {
        const s = editor.state.selection;
        if (inSel && s instanceof BlockSelection) editor.view.dispatch(editor.state.tr.deleteSelection().scrollIntoView());
        else {
          const c = current();
          if (c) remove(editor, c);
        }
        setT(null);
      },
    },
  ];

  return (
    <>
    {caretHandle}
    <div
      ref={handleRef}
      className={`dxe-handle${shown.touch ? " dxe-handle--touch" : ""}`}
      data-on={t ? "" : undefined}
      style={{ transform: shown.touch ? `translate(${shown.left}px, ${shown.top}px)` : `translate(calc(${shown.left}px - 100% - 6px), ${shown.top}px)` }}
      contentEditable={false}
    >
      {!shown.touch && (
        <button
          type="button"
          className="dxe-handle__btn"
          aria-label={`Add a block below ${label}`}
          title="Add a block below"
          onClick={() => {
            const c = current();
            if (c) openSlashAt(editor, c.pos + c.node.nodeSize);
            setT(null);
          }}
        >
          <Icon name="plus" />
        </button>
      )}
      <Dropdown
        open={menu}
        onOpenChange={(o) => {
          // The menu fades out (a copy of it: the UI kit's menu goes at once).
          if (!o) ghostOut(document.querySelector(".dxe-blockmenu"));
          setMenu(o);
          if (!o && shown.touch) setT(null);
        }}
        // On a touch screen the handle sits at the block's right edge: the menu opens leftwards.
        align={shown.touch ? "right" : "left"}
        portal
        minWidth={240}
        menuClassName="dxe-blockmenu"
        aria-label={`${many ? `${many} blocks` : what} actions`}
        trigger={
          <button
            type="button"
            className="dxe-handle__btn dxe-handle__grip"
            aria-label={`Move or change ${label}`}
            title="Drag to move · click for options"
            draggable={!shown.touch}
            onDragStart={(e) => {
              const c = current();
              if (!c) return;
              const view = editor.view;
              // The whole block selection when this block is part of it, else this block.
              const s = view.state.selection;
              const dragSel = s instanceof BlockSelection && c.pos >= s.from && c.pos < s.to ? s : NodeSelection.create(view.state.doc, c.pos);
              if (dragSel !== s) view.dispatch(view.state.tr.setSelection(dragSel));
              const slice = dragSel.content();
              (view as unknown as { dragging: unknown }).dragging = { slice, move: true, node: dragSel instanceof NodeSelection ? dragSel : undefined };
              e.dataTransfer.effectAllowed = "copyMove";
              e.dataTransfer.clearData();
              e.dataTransfer.setData("text/plain", serializeFlow(slice.content.toJSON() as never));
              // The ghost, the dimmed originals and the drop line: dnd.ts.
              startBlockDrag(view, e.nativeEvent, dragSel.from, dragSel.to);
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
        items={items}
      />
    </div>
    </>
  );
}
