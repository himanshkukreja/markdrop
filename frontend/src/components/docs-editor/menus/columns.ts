/**
 * Columns on pages (`::::columns` / `:::column{width="40%"}`):
 *   - node views: side by side, a drag divider between two columns (widths stored as %);
 *   - `/columns` (2–5);
 *   - dragging a block to the left or right edge of another puts them side by side (a vertical
 *     bar shows where), or adds a column next to the one dropped beside (up to 5);
 *   - a column emptied by a drag goes away, and columns with one column left become plain blocks.
 */
import { Extension, type Editor } from "@tiptap/core";
import { Fragment, type Node as PMNode, type Slice } from "@tiptap/pm/model";
import { Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

export const MAX_COLUMNS = 5;
const MIN_PCT = 8;

const pct = (n: number) => `${Math.round(n * 10) / 10}%`;

/* ── node views (plain DOM: cheap on long pages) ─────────────────────────── */

export function columnsView() {
  return {
    addNodeView() {
      return () => {
        const dom = document.createElement("div");
        dom.className = "dxe-columns";
        dom.dataset.docs = "columns";
        return { dom, contentDOM: dom, ignoreMutation: (m: { type: string; target: Node }) => m.type === "attributes" && m.target === dom };
      };
    },
  };
}

export function columnView() {
  return {
    addNodeView() {
      return ({ node: initial, getPos, editor }: { node: PMNode; getPos: () => number | undefined; editor: Editor }) => {
        let node = initial;
        const dom = document.createElement("div");
        dom.className = "dxe-column";
        dom.dataset.docs = "column";
        const body = document.createElement("div");
        body.className = "dxe-column__body";
        const handle = document.createElement("div");
        handle.className = "dxe-column__resize";
        handle.contentEditable = "false";
        handle.setAttribute("role", "separator");
        handle.setAttribute("aria-orientation", "vertical");
        handle.setAttribute("aria-label", "Resize columns (arrow keys)");
        handle.tabIndex = 0;
        dom.append(body, handle);
        const apply = () => {
          const w = node.attrs.attributes?.width as string | undefined;
          dom.style.flexBasis = w ?? "0";
          dom.style.flexGrow = w ? "0" : "1";
          dom.style.flexShrink = w ? "0" : "1";
          handle.hidden = !editor.isEditable;
        };
        apply();

        /** This column and the next as {pos, node, px}; the row's width. */
        const pair = () => {
          const pos = getPos();
          if (typeof pos !== "number") return null;
          const $p = editor.state.doc.resolve(pos);
          const parent = $p.parent;
          const i = $p.index();
          if (parent.type.name !== "columns" || i + 1 >= parent.childCount) return null;
          const row = dom.parentElement;
          if (!row) return null;
          const cols = Array.from(row.children) as HTMLElement[];
          const total = row.getBoundingClientRect().width;
          const widths = cols.map((c) => (c.getBoundingClientRect().width / total) * 100);
          return { rowPos: $p.before(), parent, i, widths, total, row };
        };
        const commit = (rowPos: number, widths: number[]) => {
          const tr = editor.state.tr;
          const row = tr.doc.nodeAt(rowPos);
          if (!row) return;
          let p = rowPos + 1;
          row.forEach((col, _o, k) => {
            tr.setNodeMarkup(p, undefined, { ...col.attrs, attributes: { ...(col.attrs.attributes ?? {}), width: pct(widths[k]) } });
            p += col.nodeSize;
          });
          editor.view.dispatch(tr);
        };
        const onDown = (e: PointerEvent) => {
          if (!editor.isEditable || e.button !== 0) return;
          const p = pair();
          if (!p) return;
          e.preventDefault();
          handle.setPointerCapture(e.pointerId);
          const x0 = e.clientX;
          const widths = [...p.widths];
          const a = widths[p.i], b = widths[p.i + 1];
          const cols = Array.from(p.row.children) as HTMLElement[];
          cols.forEach((c, k) => {
            c.style.flexBasis = pct(widths[k]);
            c.style.flexGrow = "0";
            c.style.flexShrink = "0";
          });
          p.row.dataset.resizing = "";
          handle.dataset.active = "";
          const move = (ev: PointerEvent) => {
            const d = ((ev.clientX - x0) / p.total) * 100;
            const na = Math.max(MIN_PCT, Math.min(a + b - MIN_PCT, a + d));
            widths[p.i] = na;
            widths[p.i + 1] = a + b - na;
            cols[p.i].style.flexBasis = pct(widths[p.i]);
            cols[p.i + 1].style.flexBasis = pct(widths[p.i + 1]);
          };
          const up = () => {
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", up);
            handle.removeEventListener("pointercancel", up);
            delete p.row.dataset.resizing;
            delete handle.dataset.active;
            commit(p.rowPos, widths);
          };
          handle.addEventListener("pointermove", move);
          handle.addEventListener("pointerup", up);
          handle.addEventListener("pointercancel", up);
        };
        const onKey = (e: KeyboardEvent) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          const p = pair();
          if (!p) return;
          e.preventDefault();
          const widths = [...p.widths];
          const step = e.shiftKey ? 10 : 2;
          const d = e.key === "ArrowLeft" ? -step : step;
          const s = widths[p.i] + widths[p.i + 1];
          widths[p.i] = Math.max(MIN_PCT, Math.min(s - MIN_PCT, widths[p.i] + d));
          widths[p.i + 1] = s - widths[p.i];
          commit(p.rowPos, widths);
          handle.focus();
        };
        handle.addEventListener("pointerdown", onDown);
        handle.addEventListener("keydown", onKey);
        return {
          dom,
          contentDOM: body,
          update(n: PMNode) {
            if (n.type !== node.type) return false;
            node = n;
            apply();
            return true;
          },
          stopEvent: (e: Event) => handle.contains(e.target as Node),
          ignoreMutation: (m: { type: string; target: Node }) => handle.contains(m.target) || (m.type === "attributes" && m.target === dom),
          destroy() {
            handle.removeEventListener("pointerdown", onDown);
            handle.removeEventListener("keydown", onKey);
          },
        };
      };
    },
  };
}

/* ── commands ────────────────────────────────────────────────────────────── */

function column(state: EditorState, content?: Fragment | PMNode[]) {
  const { column: col, paragraph } = state.schema.nodes;
  return col.create({ label: null, attributes: {} }, content && (Array.isArray(content) ? content.length : content.size) ? content : paragraph.create());
}

/** `/columns`: n empty columns, the caret in the first. */
export function insertColumns(editor: Editor, n: number, range?: { from: number; to: number }) {
  const { state } = editor;
  const node = state.schema.nodes.columns.create({ label: null, attributes: {} }, Array.from({ length: Math.max(2, Math.min(MAX_COLUMNS, n)) }, () => column(state)));
  const chain = editor.chain().focus();
  if (range) chain.deleteRange(range);
  chain.insertContent(node.toJSON()).run();
  // The caret into the first column (just inserted before the caret's new place).
  const s = editor.state;
  let target: number | null = null;
  s.doc.descendants((nd, pos) => {
    if (target !== null) return false;
    if (nd.type.name === "columns" && pos <= s.selection.from && pos + nd.nodeSize >= s.selection.from - 2) {
      target = pos + 3;
      return false;
    }
    return true;
  });
  if (target === null) {
    // Fallback: the last columns block before the caret.
    s.doc.nodesBetween(0, s.selection.from, (nd, pos) => {
      if (nd.type.name === "columns") target = pos + 3;
      return true;
    });
  }
  if (target !== null) editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(target))));
}

/* ── normalising after edits ─────────────────────────────────────────────── */

/**
 * Removes the columns a drag emptied (`emptied`: their positions now), unwraps a row left with one
 * column, resets the widths of a row that lost a column.
 */
function normalise(state: EditorState, emptied: number[]): Transaction | null {
  const rows: Array<{ pos: number; node: PMNode }> = [];
  state.doc.descendants((n, pos) => {
    if (n.type.name === "columns") rows.push({ pos, node: n });
    return !n.isTextblock && !n.isAtom && n.type.name !== "table";
  });
  if (!rows.length) return null;
  let tr: Transaction | null = null;
  // Last first, so earlier positions stay valid.
  for (const { pos, node } of rows.reverse()) {
    const keep: PMNode[] = [];
    let p = pos + 1;
    node.forEach((col) => {
      const empty = col.childCount === 1 && col.firstChild!.type.name === "paragraph" && col.firstChild!.content.size === 0;
      if (!(empty && emptied.includes(p))) keep.push(col);
      p += col.nodeSize;
    });
    const changed = keep.length !== node.childCount;
    if (keep.length <= 1) {
      tr ??= state.tr;
      const inner = keep[0]?.content ?? Fragment.from(state.schema.nodes.paragraph.create());
      tr.replaceWith(pos, pos + node.nodeSize, inner);
    } else if (changed) {
      tr ??= state.tr;
      const cols = keep.map((c) => c.type.create({ ...c.attrs, attributes: { ...(c.attrs.attributes ?? {}), width: undefined } }, c.content));
      tr.replaceWith(pos, pos + node.nodeSize, node.type.create(node.attrs, cols));
    }
  }
  return tr;
}

/* ── dropping beside a block ─────────────────────────────────────────────── */

interface Side {
  pos: number; // the block dropped beside
  node: PMNode;
  side: "left" | "right";
  rect: DOMRect;
}

const SIDE_ZONE = 48;

/** The block under the pointer, if the pointer is in its left or right edge zone. */
function sideAt(view: EditorView, x: number, y: number): Side | null {
  const box = view.dom.getBoundingClientRect();
  const found = view.posAtCoords({ left: Math.max(box.left + 4, Math.min(x, box.right - 4)), top: y });
  if (!found) return null;
  const $p = view.state.doc.resolve(found.inside >= 0 ? found.inside : found.pos);
  // The block: a top-level block, or a block directly in a column.
  let pos: number | null = null;
  if (found.inside >= 0) {
    const $in = view.state.doc.resolve(found.inside);
    if ($in.depth === 0 || $in.parent.type.name === "column") pos = found.inside;
  }
  if (pos === null) {
    for (let d = $p.depth; d >= 1; d--) {
      const parent = $p.node(d - 1).type.name;
      if (d === 1 || parent === "column") {
        pos = $p.before(d);
        break;
      }
    }
  }
  if (pos === null) return null;
  let node = view.state.doc.nodeAt(pos);
  if (!node) return null;
  // Over a whole row of columns (outside any column): beside the row.
  if (node.type.name === "column") return null;
  const dom = view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return null;
  const rect = dom.getBoundingClientRect();
  if (y < rect.top || y > rect.bottom) return null;
  if (x < rect.left + SIDE_ZONE) return { pos, node, side: "left", rect };
  if (x > rect.right - SIDE_ZONE) return { pos, node, side: "right", rect };
  return null;
}

export const columnsKey = new PluginKey("dxeColumns");

/** The indicator element (a vertical bar), placed in the editor's offset parent. */
function bar(view: EditorView): HTMLElement {
  const host = (view.dom.parentElement?.closest(".dxe-visual") as HTMLElement | null) ?? (view.dom.parentElement as HTMLElement);
  let el = host.querySelector<HTMLElement>(":scope > .dxe-coldrop");
  if (!el) {
    el = document.createElement("div");
    el.className = "dxe-coldrop";
    el.hidden = true;
    host.append(el);
  }
  return el;
}

function wholeBlocks(slice: Slice | null | undefined) {
  return !!slice && slice.openStart === 0 && slice.openEnd === 0 && slice.content.childCount > 0 && slice.content.firstChild!.isBlock;
}

export const ColumnsExt = Extension.create({
  name: "dxeColumns",
  priority: 900,
  addProseMirrorPlugins() {
    let side: Side | null = null;
    // The columns the dragged blocks come from (an emptied one goes away after the drop).
    let sources: number[] = [];
    const sourcesOf = (state: EditorState) => {
      const out: number[] = [];
      const $f = state.doc.resolve(state.selection.from);
      for (let d = $f.depth; d >= 1; d--) if ($f.node(d).type.name === "column") out.push($f.before(d));
      // A selection that is the column's block itself sits at the column's content depth.
      const $in = state.doc.resolve(state.selection.from);
      if ($in.parent.type.name === "column" && $in.depth >= 1) out.push($in.before());
      return out;
    };
    const hide = (view: EditorView) => {
      side = null;
      bar(view).hidden = true;
      document.body.classList.remove("dxe-sidedrop");
    };
    return [
      // A table's header column / header row off (its attributes) on the table's wrapper, for CSS:
      // the resizable table's node view doesn't render the node's attributes itself.
      new Plugin({
        props: {
          decorations(state) {
            const decos: Decoration[] = [];
            state.doc.descendants((n, pos) => {
              if (n.type.name === "table") {
                const b = n.attrs.battrs as Record<string, string> | null;
                if (b && (b["header-column"] !== undefined || b["header-row"] === "off"))
                  decos.push(Decoration.node(pos, pos + n.nodeSize, { ...(b["header-column"] !== undefined ? { "data-hcol": "" } : {}), ...(b["header-row"] === "off" ? { "data-hrow": "off" } : {}) }));
                return false;
              }
              return !n.isTextblock && !n.isAtom;
            });
            return decos.length ? DecorationSet.create(state.doc, decos) : null;
          },
        },
      }),
      new Plugin({
        key: columnsKey,
        appendTransaction(trs, _old, state) {
          if (!trs.some((t) => t.docChanged)) return null;
          const dropped = trs.some((t) => t.getMeta("uiEvent") === "drop" || t.getMeta("dxeColumnsDrop"));
          let emptied: number[] = [];
          if (dropped && sources.length) {
            emptied = sources.map((p) => trs.reduce((q, t) => t.mapping.map(q, 1), p));
            sources = [];
          }
          return normalise(state, emptied);
        },
        props: {
          handleDOMEvents: {
            drop(view) {
              sources = (view as unknown as { dragging: unknown }).dragging ? sourcesOf(view.state) : [];
              return false;
            },
            dragover(view, e) {
              const dragging = (view as unknown as { dragging: { slice: Slice } | null }).dragging;
              if (!view.editable || !dragging || !wholeBlocks(dragging.slice)) {
                if (side) hide(view);
                return false;
              }
              const s = sideAt(view, e.clientX, e.clientY);
              if (!s) {
                if (side) hide(view);
                return false;
              }
              // Not beside one of the blocks being dragged.
              const sel = view.state.selection;
              if (s.pos >= sel.from && s.pos < sel.to) {
                hide(view);
                return false;
              }
              const $s = view.state.doc.resolve(s.pos);
              if ($s.parent.type.name === "column" && $s.node($s.depth - 1).childCount >= MAX_COLUMNS) {
                hide(view);
                return false;
              }
              side = s;
              e.preventDefault();
              const el = bar(view);
              const host = el.parentElement!.getBoundingClientRect();
              el.hidden = false;
              el.style.top = `${s.rect.top - host.top}px`;
              el.style.height = `${Math.max(24, s.rect.height)}px`;
              el.style.left = `${(s.side === "left" ? s.rect.left - 10 : s.rect.right + 7) - host.left}px`;
              document.body.classList.add("dxe-sidedrop");
              return true;
            },
            dragleave(view, e) {
              if (side && !view.dom.contains(e.relatedTarget as Node | null)) hide(view);
              return false;
            },
            dragend(view) {
              hide(view);
              return false;
            },
          },
          handleDrop(view, _e, slice, moved) {
            const s = side;
            hide(view);
            if (!s || !moved || !wholeBlocks(slice)) return false;
            const state = view.state;
            const sel = state.selection;
            if (s.pos >= sel.from && s.pos < sel.to) return true;
            const tr = state.tr;
            tr.deleteSelection();
            const at = tr.mapping.map(s.pos, 1);
            const target = tr.doc.nodeAt(at);
            if (!target) return true;
            const $t = tr.doc.resolve(at);
            const fresh = column(state, slice.content);
            if ($t.parent.type.name === "column") {
              // Beside a block in a column: a new column next to that one.
              const colPos = $t.before();
              const col = $t.parent;
              const rowNode = $t.node($t.depth - 1);
              if (rowNode.childCount >= MAX_COLUMNS) return true;
              const insertAt = s.side === "left" ? colPos : colPos + col.nodeSize;
              tr.insert(insertAt, fresh);
              // Equal widths again.
              const rowPos = $t.before($t.depth - 1);
              const row = tr.doc.nodeAt(rowPos)!;
              let p = rowPos + 1;
              row.forEach((c) => {
                tr.setNodeMarkup(p, undefined, { ...c.attrs, attributes: { ...(c.attrs.attributes ?? {}), width: undefined } });
                p += c.nodeSize;
              });
              tr.setSelection(Selection.near(tr.doc.resolve(insertAt + 2)));
            } else {
              const other = column(state, [target]);
              const row = state.schema.nodes.columns.create({ label: null, attributes: {} }, s.side === "left" ? [fresh, other] : [other, fresh]);
              tr.replaceWith(at, at + target.nodeSize, row);
              tr.setSelection(Selection.near(tr.doc.resolve(at + (s.side === "left" ? 3 : 2 + other.nodeSize + 1))));
            }
            tr.setMeta("dxeColumnsDrop", true);
            view.dispatch(tr.scrollIntoView());
            view.focus();
            return true;
          },
        },
      }),
    ];
  },
});
