"use client";

/**
 * Row / column controls shown above a table while the cursor is in it: add and delete rows and
 * columns, align the current column (GFM `:--`, `:-:`, `--:`), delete the table.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { CellSelection } from "@tiptap/pm/tables";
import { useHost } from "../host";
import { cleanAttrs } from "../core/attrs.mjs";
import { ColorList, type ColorChoice } from "./ColorMenu";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { IconButton } from "@/components/ui";
import { cx } from "../views/shared";
import { ghostOut } from "./motion";

interface Where {
  tablePos: number;
  col: number;
  cols: number;
  align: Array<string | null>;
  battrs: Record<string, string> | null;
  cellBg: ColorChoice;
}

function where(editor: Editor): Where | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === "table") {
      let col = 0;
      for (let k = d + 1; k <= $from.depth; k++) if ($from.node(k).type.name === "tableRow") col = $from.index(k);
      let cols = 0;
      n.forEach((row) => (cols = Math.max(cols, row.childCount)));
      let cell: ColorChoice = null;
      for (let k = $from.depth; k > d; k--) {
        const c = $from.node(k);
        if (c.type.name === "tableCell" || c.type.name === "tableHeader") {
          const b = c.attrs.battrs as Record<string, string> | null;
          cell = b?.bg ? { bg: b.bg } : b?.color ? { color: b.color } : null;
        }
      }
      return { tablePos: $from.before(d), col, cols, align: (n.attrs.align as Array<string | null> | null) ?? [], battrs: (n.attrs.battrs as Record<string, string> | null) ?? null, cellBg: cell };
    }
  }
  return null;
}

export function TableBar({ editor, container }: { editor: Editor; container: RefObject<HTMLDivElement | null> }) {
  const host = useHost();
  const [colors, setColors] = useState(false);
  const w = useEditorState({ editor, selector: ({ editor: e }) => (e.isEditable ? where(e) : null), equalityFn: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  // Leaving the table, the bar fades out where it was (a copy: this one is gone by then).
  const barEl = useRef<HTMLDivElement | null>(null);
  const barRect = useRef<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (w && barEl.current) barRect.current = barEl.current.getBoundingClientRect();
    else if (!w && barEl.current) {
      ghostOut(barEl.current, barRect.current);
      barEl.current = null;
    }
  });
  if (!w || !container.current) return null;
  const dom = editor.view.nodeDOM(w.tablePos);
  if (!(dom instanceof HTMLElement)) return null;
  const r = dom.getBoundingClientRect();
  const c = container.current.getBoundingClientRect();
  const align = w.align[w.col] ?? null;
  const setAlign = (a: string | null) => {
    const next = Array.from({ length: w.cols }, (_, i) => (i === w.col ? a : w.align[i] ?? null));
    editor
      .chain()
      .command(({ tr }) => {
        const n = tr.doc.nodeAt(w.tablePos);
        if (!n) return false;
        tr.setNodeMarkup(w.tablePos, undefined, { ...n.attrs, align: next });
        return true;
      })
      .run();
  };
  const setTable = (patch: Record<string, string | null>) => {
    const tr = editor.state.tr;
    const n = tr.doc.nodeAt(w.tablePos);
    if (!n) return;
    tr.setNodeMarkup(w.tablePos, undefined, { ...n.attrs, battrs: cleanAttrs({ ...(n.attrs.battrs ?? {}), ...patch }) });
    editor.view.dispatch(tr);
  };
  /** The selected cells' (or the caret's cell's) colour. */
  const colorCells = (c: ColorChoice) => {
    const { state } = editor;
    const tr = state.tr;
    const set = (pos: number) => {
      const cell = tr.doc.nodeAt(pos);
      if (!cell) return;
      const b = { ...(cell.attrs.battrs ?? {}) } as Record<string, string | null>;
      delete b.bg;
      delete b.color;
      tr.setNodeMarkup(pos, undefined, { ...cell.attrs, battrs: cleanAttrs({ ...b, ...(c ?? {}) }) });
    };
    const sel = state.selection;
    if (sel instanceof CellSelection) sel.forEachCell((_n, pos) => set(pos));
    else {
      const $f = sel.$from;
      for (let d = $f.depth; d > 0; d--) {
        const name = $f.node(d).type.name;
        if (name === "tableCell" || name === "tableHeader") {
          set($f.before(d));
          break;
        }
      }
    }
    editor.view.dispatch(tr);
    editor.view.focus();
  };
  const run = (fn: (ch: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => fn(editor.chain().focus()).run();
  return (
    <div ref={(el) => { if (el) barEl.current = el; }} className="dxe-tablebar" role="toolbar" aria-label="Table" style={{ top: r.top - c.top - 40, left: r.left - c.left }} contentEditable={false} onMouseDown={(e) => e.preventDefault()}>
      <IconButton icon="plus" label="Add row below" size="sm" onClick={() => run((ch) => ch.addRowAfter())} />
      <IconButton icon="minus" label="Delete row" size="sm" onClick={() => run((ch) => ch.deleteRow())} />
      <span className="dxe-tb__sep" aria-hidden />
      <IconButton icon="columns" label="Add column right" size="sm" onClick={() => run((ch) => ch.addColumnAfter())} />
      <IconButton icon="x" label="Delete column" size="sm" onClick={() => run((ch) => ch.deleteColumn())} />
      <span className="dxe-tb__sep" aria-hidden />
      {(["left", "center", "right"] as const).map((a) => (
        <button
          key={a}
          type="button"
          className={cx("dxe-tb__btn", align === a && "dxe-tb__btn--on")}
          aria-pressed={align === a}
          aria-label={`Align column ${a}`}
          title={`Align column ${a}`}
          onClick={() => setAlign(align === a ? null : a)}
        >
          <span className={cx("dxe-align", `dxe-align--${a}`)} aria-hidden>
            <i />
            <i />
            <i />
          </span>
        </button>
      ))}
      {host.pages && (
        <>
          <span className="dxe-tb__sep" aria-hidden />
          <button type="button" className={cx("dxe-tb__btn dxe-tb__btn--text", w.battrs?.["header-row"] !== "off" && "dxe-tb__btn--on")} aria-pressed={w.battrs?.["header-row"] !== "off"} title="Header row" onClick={() => setTable({ "header-row": w.battrs?.["header-row"] === "off" ? null : "off" })}>
            Header row
          </button>
          <button type="button" className={cx("dxe-tb__btn dxe-tb__btn--text", w.battrs?.["header-column"] !== undefined && "dxe-tb__btn--on")} aria-pressed={w.battrs?.["header-column"] !== undefined} title="Header column" onClick={() => setTable({ "header-column": w.battrs?.["header-column"] !== undefined ? null : "" })}>
            Header column
          </button>
          <span className="dxe-tb__group">
            <button type="button" className="dxe-tb__btn" aria-haspopup="menu" aria-expanded={colors} aria-label="Cell colour" title="Cell colour" onClick={() => setColors(!colors)}>
              <span className="dxe-tb__color" data-color={w.cellBg && "color" in w.cellBg ? w.cellBg.color : undefined} data-bg={w.cellBg && "bg" in w.cellBg ? w.cellBg.bg : undefined} aria-hidden>A</span>
            </button>
            {colors && (
              <div className="dxe-tb__menu dxe-tb__menu--color">
                <ColorList current={w.cellBg} onPick={colorCells} onClose={() => setColors(false)} label="Cell colour" />
              </div>
            )}
          </span>
        </>
      )}
      <span className="dxe-tb__sep" aria-hidden />
      <IconButton icon="trash" label="Delete table" size="sm" onClick={() => run((ch) => ch.deleteTable())} />
    </div>
  );
}
