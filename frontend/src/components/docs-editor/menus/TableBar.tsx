"use client";

/**
 * Row / column controls shown above a table while the cursor is in it: add and delete rows and
 * columns, align the current column (GFM `:--`, `:-:`, `--:`), delete the table.
 */
import type { RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { IconButton } from "@/components/ui";
import { cx } from "../views/shared";

interface Where {
  tablePos: number;
  col: number;
  cols: number;
  align: Array<string | null>;
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
      return { tablePos: $from.before(d), col, cols, align: (n.attrs.align as Array<string | null> | null) ?? [] };
    }
  }
  return null;
}

export function TableBar({ editor, container }: { editor: Editor; container: RefObject<HTMLDivElement | null> }) {
  const w = useEditorState({ editor, selector: ({ editor: e }) => (e.isEditable ? where(e) : null), equalityFn: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
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
  const run = (fn: (ch: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => fn(editor.chain().focus()).run();
  return (
    <div className="dxe-tablebar" role="toolbar" aria-label="Table" style={{ top: r.top - c.top - 40, left: r.left - c.left }} contentEditable={false} onMouseDown={(e) => e.preventDefault()}>
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
      <span className="dxe-tb__sep" aria-hidden />
      <IconButton icon="trash" label="Delete table" size="sm" onClick={() => run((ch) => ch.deleteTable())} />
    </div>
  );
}
