"use client";

/**
 * Page editing helpers around the document:
 *   - SelectionBar: with blocks selected, "N blocks" and Turn into, Colour, Copy, Cut, Duplicate,
 *     Delete (the same as the keys and the block menu, for the mouse and for touch);
 *   - BlockMarquee: dragging from the margin draws a rectangle that selects the blocks it touches;
 *   - TouchBar: on touch screens, "+" (the block menu of "/") and "⋮⋮" (the block's menu) above the
 *     keyboard, since there's no hover to show the handle;
 *   - useEditorAnchor: `#b-…` in the address scrolls to that block and flashes it while editing too.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { Icon, useToast } from "@/components/ui";
import { BlockSelection, duplicateBlocks, selectBlocks } from "./blockSelection";
import { blockColor, colorBlock, colorable, findAnchor } from "./blockOps";
import { ColorList, type ColorChoice } from "./ColorMenu";
import { turnBlocks, type TurnInto } from "../pageKeys";
import type { BlockMenuApi } from "./BlockHandle";

const TURN: Array<[TurnInto, string]> = [
  ["text", "Text"], ["h1", "Heading 1"], ["h2", "Heading 2"], ["h3", "Heading 3"], ["todo", "To-do list"],
  ["bullet", "Bulleted list"], ["numbered", "Numbered list"], ["toggle", "Toggle"], ["quote", "Quote"],
];

export function SelectionBar({ editor }: { editor: Editor }) {
  const toast = useToast();
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const s = e.state.selection;
      return s instanceof BlockSelection ? { from: s.from, to: s.to, n: s.blocks().length } : null;
    },
    equalityFn: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });
  const [menu, setMenu] = useState<null | "turn" | "color">(null);
  useEffect(() => setMenu(null), [st?.from, st?.to]);
  if (!st || !editor.isEditable) return null;
  const blocks = () => (editor.state.selection instanceof BlockSelection ? editor.state.selection.blocks() : []);
  const clip = (cut: boolean) => {
    editor.view.focus();
    const ok = document.execCommand(cut ? "cut" : "copy");
    if (ok) toast.success(cut ? `Cut ${st.n === 1 ? "1 block" : `${st.n} blocks`}` : `Copied ${st.n === 1 ? "1 block" : `${st.n} blocks`}`);
  };
  const color = (c: ColorChoice) => {
    const tr = editor.state.tr;
    for (const b of blocks()) colorBlock(tr, b.pos, c);
    if (tr.docChanged) editor.view.dispatch(tr);
    editor.view.focus();
  };
  const canColor = blocks().some((b) => colorable(b.node));
  const one = blocks().length === 1 ? blocks()[0] : null;
  return (
    <div className="dxe-selbar" role="toolbar" aria-label="Selected blocks" onMouseDown={(e) => e.target instanceof HTMLInputElement || e.preventDefault()}>
      <span className="dxe-selbar__count" aria-live="polite">{st.n === 1 ? "1 block" : `${st.n} blocks`}</span>
      <span style={{ position: "relative" }}>
        <button type="button" className="dxe-selbar__btn" aria-haspopup="menu" aria-expanded={menu === "turn"} onClick={() => setMenu(menu === "turn" ? null : "turn")}>
          <Icon name="refresh" size={14} aria-hidden /> Turn into
        </button>
        {menu === "turn" && (
          <div className="dxe-selbar__menu pb-colors" role="menu" aria-label="Turn into">
            {TURN.map(([k, label]) => (
              <button key={k} type="button" role="menuitem" className="pb-colors__row" onClick={() => { setMenu(null); turnBlocks(editor, blocks(), k); editor.view.focus(); }}>
                {label}
              </button>
            ))}
          </div>
        )}
      </span>
      {canColor && (
        <span style={{ position: "relative" }}>
          <button type="button" className="dxe-selbar__btn" aria-haspopup="menu" aria-expanded={menu === "color"} onClick={() => setMenu(menu === "color" ? null : "color")}>
            <Icon name="palette" size={14} aria-hidden /> Colour
          </button>
          {menu === "color" && (
            <div className="dxe-selbar__menu">
              <ColorList current={one ? blockColor(one.node) : null} onPick={color} onClose={() => setMenu(null)} />
            </div>
          )}
        </span>
      )}
      <button type="button" className="dxe-selbar__btn" onClick={() => clip(false)} title="Copy (⌘C)">
        <Icon name="copy" size={14} aria-hidden /> Copy
      </button>
      <button type="button" className="dxe-selbar__btn" onClick={() => clip(true)} title="Cut (⌘X)">
        Cut
      </button>
      <button type="button" className="dxe-selbar__btn" onClick={() => editor.state.selection instanceof BlockSelection && duplicateBlocks(editor.view, editor.state.selection)} title="Duplicate (⌘D)">
        Duplicate
      </button>
      <button type="button" className="dxe-selbar__btn dxe-selbar__btn--danger" onClick={() => { editor.view.dispatch(editor.state.tr.deleteSelection().scrollIntoView()); editor.view.focus(); }} title="Delete (Del)">
        <Icon name="trash" size={14} aria-hidden /> Delete
      </button>
    </div>
  );
}

/** Drag-select: from the margin (or the empty space beside blocks), a rectangle selects blocks. */
export function BlockMarquee({ editor, container }: { editor: Editor; container: RefObject<HTMLDivElement | null> }) {
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  useEffect(() => {
    const wrap = container.current;
    if (!wrap) return;
    const view = editor.view;
    const root = document;
    const startOk = (e: MouseEvent) => {
      if (e.button !== 0 || e.shiftKey || !editor.isEditable) return false;
      const t = e.target as HTMLElement | null;
      if (!t || !(t instanceof HTMLElement)) return false;
      if (t.closest("button, input, textarea, select, a, label, [role=menu], [role=dialog], [role=toolbar], header, nav, aside, .dxe-handle, .dxe-selbar, .pb-head, .pb-editor__bar")) return false;
      // Inside the text column only on the editor's own padding, not on a block.
      if (view.dom.contains(t) && t !== view.dom) return false;
      // In the margins beside the blocks (the same rows as the editor), or on its padding.
      const r = view.dom.getBoundingClientRect();
      if (e.clientY < r.top - 24 || e.clientY > r.bottom + 40) return false;
      return e.clientX < r.left || e.clientX > r.right || t === view.dom;
    };
    let start: { x: number; y: number } | null = null;
    let moved = false;
    const down = (e: MouseEvent) => {
      if (!startOk(e)) return;
      start = { x: e.clientX, y: e.clientY };
      moved = false;
      e.preventDefault();
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up, { once: true });
    };
    const blocksIn = (x1: number, y1: number, x2: number, y2: number) => {
      const out: number[] = [];
      let pos = 0;
      view.state.doc.forEach((n, off) => {
        pos = off;
        const dom = view.nodeDOM(pos);
        if (!(dom instanceof HTMLElement)) return;
        const r = dom.getBoundingClientRect();
        if (r.bottom >= y1 && r.top <= y2 && r.right >= x1 && r.left <= x2) out.push(pos);
      });
      return out;
    };
    const move = (e: MouseEvent) => {
      if (!start) return;
      if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6) return;
      moved = true;
      const w = wrap.getBoundingClientRect();
      const x1 = Math.min(start.x, e.clientX), x2 = Math.max(start.x, e.clientX);
      const y1 = Math.min(start.y, e.clientY), y2 = Math.max(start.y, e.clientY);
      setBox({ x: x1 - w.left, y: y1 - w.top, w: x2 - x1, h: y2 - y1 });
      // The text column's horizontal extent counts as touched when the rectangle starts in a margin.
      const r = view.dom.getBoundingClientRect();
      const hit = blocksIn(Math.min(x1, r.right - 1), y1, Math.max(x2, r.left + 1), y2);
      if (hit.length) {
        if (!view.hasFocus()) view.focus();
        selectBlocks(view, hit[0], hit[hit.length - 1]);
      }
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      start = null;
      setBox(null);
    };
    root.addEventListener("mousedown", down);
    return () => {
      root.removeEventListener("mousedown", down);
      document.removeEventListener("mousemove", move);
    };
  }, [editor, container]);
  if (!box) return null;
  return <div className="dxe-marquee" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} aria-hidden />;
}

/** Touch screens: "+" opens the "/" menu on a new line, "⋮⋮" the menu of the block at the caret. */
export function TouchBar({ editor }: { editor: Editor }) {
  const [touch, setTouch] = useState(false);
  const focused = useEditorState({ editor, selector: ({ editor: e }) => e.isFocused && e.isEditable });
  useEffect(() => {
    const mq = window.matchMedia("(hover: none) and (pointer: coarse)");
    const up = () => setTouch(mq.matches);
    up();
    mq.addEventListener("change", up);
    return () => mq.removeEventListener("change", up);
  }, []);
  const blur = useRef(0);
  if (!touch || !focused) return null;
  const blockMenu = () => {
    const api = (editor.storage as unknown as { dxeBlockMenu?: BlockMenuApi }).dxeBlockMenu;
    const s = editor.state.selection;
    const pos = s instanceof BlockSelection ? s.headBlock : (() => {
      const $f = s.$from;
      for (let d = $f.depth; d >= 1; d--) if ($f.node(d - 1).type.name === "doc") return $f.before(d);
      return null;
    })();
    if (pos !== null && api) api.open(pos);
  };
  return (
    <div className="dxe-touchbar" role="toolbar" aria-label="Blocks" onMouseDown={(e) => e.preventDefault()} onTouchStart={() => window.clearTimeout(blur.current)}>
      <button
        type="button"
        className="dxe-touchbar__btn"
        aria-label="Add a block"
        onClick={() => {
          const { $from } = editor.state.selection;
          const empty = $from.parent.type.name === "paragraph" && !$from.parent.content.size;
          if (empty) editor.chain().focus().insertContent("/").run();
          else editor.chain().focus().command(({ tr }) => {
            const end = $from.end();
            tr.split(end);
            return true;
          }).insertContent("/").run();
        }}
      >
        <Icon name="plus" size={18} aria-hidden /> Block
      </button>
      <button type="button" className="dxe-touchbar__btn" aria-label="Block menu" onClick={blockMenu}>
        <Icon name="grip" size={18} aria-hidden />
      </button>
      <button type="button" className="dxe-touchbar__btn" aria-label="Select this block" onClick={() => editor.commands.keyboardShortcut("Escape")}>
        <Icon name="checkSquare" size={18} aria-hidden />
      </button>
    </div>
  );
}

/** `#b-…` while editing: scroll to the block and flash it. */
export function useEditorAnchor(editor: Editor | null) {
  useEffect(() => {
    if (!editor) return;
    const go = () => {
      const m = /^#(b-[a-z0-9]{4,12})$/.exec(window.location.hash);
      if (!m) return;
      const pos = findAnchor(editor.state.doc, m[1]);
      if (pos === null) return;
      const dom = editor.view.nodeDOM(pos);
      if (!(dom instanceof HTMLElement)) return;
      dom.scrollIntoView({ block: "center", behavior: "smooth" });
      // An overlay, not a class on the block: ProseMirror owns the block's DOM and would undo it.
      const host = dom.closest(".dxe-visual") as HTMLElement | null;
      if (!host) return;
      host.querySelector(":scope > .dxe-flash")?.remove();
      const flash = document.createElement("div");
      flash.className = "dxe-flash pb-flash";
      const place = () => {
        const r = dom.getBoundingClientRect();
        const h = host.getBoundingClientRect();
        Object.assign(flash.style, { top: `${r.top - h.top}px`, left: `${r.left - h.left}px`, width: `${r.width}px`, height: `${r.height}px` });
      };
      place();
      host.append(flash);
      const t2 = window.setInterval(place, 100);
      window.setTimeout(() => {
        window.clearInterval(t2);
        flash.remove();
      }, 2400);
    };
    const t = window.setTimeout(go, 300);
    window.addEventListener("hashchange", go);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("hashchange", go);
    };
  }, [editor]);
}
