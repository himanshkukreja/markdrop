/**
 * Dragging blocks by their handle (BlockHandle starts it):
 *   - a ghost: a see-through copy of the block(s) follows the pointer (the browser's own drag image
 *     is a blank pixel, so the copy looks the same in every browser and in screen recordings);
 *   - the drop line: a 3 px accent line with rounded ends between the blocks the drop goes between,
 *     gliding from place to place (transform only, 80 ms); a caret-like bar for text;
 *   - the drop: decided by geometry (dropPlace.ts: over a block's top half, above it; bottom half,
 *     below), the blocks in between slide aside and the dropped block glides from the ghost into
 *     place (FLIP, motion.ts).
 * ProseMirror's own drop cursor is off (core/schema.mjs); this replaces it for every drag, text or
 * files included. Escape or a drop outside puts the ghost back where the block is.
 */
import { Extension } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { Fragment, Slice } from "@tiptap/pm/model";
import { dropPoint } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";
import { BlockSelection } from "./blockSelection";
import { moveSlice, placeDrop, type DropCandidate, type DropPlace } from "./dropPlace";
import { EASE, flip, reducedMotion } from "./motion";

export const dndKey = new PluginKey("dxeDnd");

/** Table parts and list items' first lines aren't places of their own. */
const SKIP = new Set(["tableRow", "tableCell", "tableHeader"]);

interface Drag {
  view: EditorView;
  from: number;
  to: number;
  many: boolean;
  /** The pointer's offset in the first dragged block's box, at the start. */
  grab: { x: number; y: number };
  at: { x: number; y: number };
  ghost: HTMLElement;
  sources: HTMLElement[];
  raf: number;
  off: () => void;
}

let drag: Drag | null = null;

/** A transparent pixel for the browser's drag image (the ghost is ours). */
let blank: HTMLImageElement | null = null;
function blankImage() {
  if (!blank && typeof Image !== "undefined") {
    blank = new Image(1, 1);
    blank.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  }
  return blank;
}
if (typeof window !== "undefined") blankImage();

const wholeBlocks = (slice: Slice | null | undefined) => !!slice && slice.openStart === 0 && slice.openEnd === 0 && slice.content.childCount > 0 && slice.content.firstChild!.isBlock;

/** The blocks under the point, innermost first, as drop candidates (not the dragged blocks' insides). */
function candidates(view: EditorView, x: number, y: number): DropCandidate[] {
  const box = view.dom.getBoundingClientRect();
  const found = view.posAtCoords({ left: Math.min(Math.max(x, box.left + 24), box.right - 8), top: Math.min(Math.max(y, box.top + 2), box.bottom - 2) });
  if (!found) return [];
  const { doc } = view.state;
  const out: DropCandidate[] = [];
  const inDrag = (pos: number) => !!drag && drag.view === view && pos > drag.from && pos < drag.to;
  const add = (pos: number) => {
    if (inDrag(pos)) return;
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return;
    const r = dom.getBoundingClientRect();
    out.push({ pos, top: r.top, bottom: r.bottom });
  };
  if (found.inside >= 0) {
    const n = doc.nodeAt(found.inside);
    if (n && n.isBlock && n.isAtom) add(found.inside);
  }
  const $p = doc.resolve(found.pos);
  for (let d = $p.depth; d >= 1; d--) {
    const node = $p.node(d);
    if (!node.isBlock || SKIP.has(node.type.name)) continue;
    // A list item's own line: the item is the place.
    if ($p.node(d - 1).type.name === "listItem" && $p.index(d - 1) === 0) continue;
    add($p.before(d));
  }
  return out;
}

/** Where the dragged blocks (`slice`) would land for a pointer at (x, y), or null (ProseMirror decides). */
export function blockDropAt(view: EditorView, x: number, y: number, slice?: Slice | null): DropPlace | null {
  const s = slice ?? new Slice(Fragment.from(view.state.schema.nodes.paragraph.create()), 0, 0);
  if (!wholeBlocks(s)) return null;
  return placeDrop(view.state.doc, s, candidates(view, x, y), y);
}

/* ── the drop line ─────────────────────────────────────────────────────── */

class DropLine {
  el: HTMLElement | null = null;
  shown = false;
  show(x: number, y: number, w: number, h: number, inline: boolean) {
    let el = this.el;
    if (!el) {
      el = document.createElement("div");
      el.className = "dxe-dropline";
      el.setAttribute("aria-hidden", "true");
      document.body.appendChild(el);
      this.el = el;
    }
    el.classList.toggle("dxe-dropline--inline", inline);
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    const t = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    if (!this.shown) {
      // Appears in place, then glides.
      el.style.transition = "none";
      el.style.transform = t;
      void getComputedStyle(el).transform;
      el.style.transition = "";
      el.dataset.on = "";
      this.shown = true;
    } else if (el.style.transform !== t) el.style.transform = t;
  }
  hide() {
    if (!this.el || !this.shown) return;
    delete this.el.dataset.on;
    this.shown = false;
  }
  destroy() {
    this.el?.remove();
    this.el = null;
    this.shown = false;
  }
}

/** The line between the block before `place.pos` and the one after it. */
function lineFor(view: EditorView, place: DropPlace) {
  const dom = view.nodeDOM(place.candidate.pos);
  if (!(dom instanceof HTMLElement)) return null;
  const r = dom.getBoundingClientRect();
  const sib = place.before ? dom.previousElementSibling : dom.nextElementSibling;
  const s = sib instanceof HTMLElement && sib.offsetParent !== null && !sib.classList.contains("ProseMirror-widget") ? sib.getBoundingClientRect() : null;
  let y: number;
  if (place.before) y = s && s.bottom <= r.top + 1 ? (s.bottom + r.top) / 2 : r.top - 3;
  else y = s && s.top >= r.bottom - 1 ? (r.bottom + s.top) / 2 : r.bottom + 3;
  return { x: r.left, y: y - 1.5, w: r.width };
}

/* ── the ghost ─────────────────────────────────────────────────────────── */

function placeGhost() {
  const d = drag;
  if (!d) return;
  d.raf = 0;
  d.ghost.style.transform = `translate3d(${d.at.x - d.grab.x}px, ${d.at.y - d.grab.y}px, 0)`;
}

function endDrag(cancelled: boolean) {
  const d = drag;
  if (!d) return;
  drag = null;
  d.off();
  cancelAnimationFrame(d.raf);
  for (const s of d.sources) s.classList.remove("dxe-dragsource");
  const g = d.ghost;
  const first = d.sources[0];
  if (cancelled && first?.isConnected && !reducedMotion()) {
    // Back to where the block is.
    const r = first.getBoundingClientRect();
    const a = g.animate([{ transform: g.style.transform, opacity: 0.7 }, { transform: `translate3d(${r.left}px, ${r.top}px, 0)`, opacity: 0 }], { duration: 150, easing: EASE, fill: "forwards" });
    a.onfinish = () => g.remove();
    setTimeout(() => g.remove(), 260);
  } else g.remove();
}

/**
 * Starts a handle drag of the blocks `from`–`to` (whole blocks of one parent): the ghost, the
 * dimmed originals, and the blank drag image. Call from the handle's dragstart.
 */
export function startBlockDrag(view: EditorView, e: DragEvent, from: number, to: number) {
  endDrag(false);
  const { doc } = view.state;
  const $f = doc.resolve(from);
  const sources: HTMLElement[] = [];
  let pos = from;
  for (let i = $f.index(); i < $f.parent.childCount && pos < to; i++) {
    const dom = view.nodeDOM(pos);
    if (dom instanceof HTMLElement) sources.push(dom);
    pos += $f.parent.child(i).nodeSize;
  }
  if (!sources.length) return;
  const r = sources[0].getBoundingClientRect();
  const ghost = document.createElement("div");
  ghost.className = "dxe-dragghost";
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.width = `${Math.min(r.width, 720)}px`;
  const prose = document.createElement("div");
  prose.className = view.dom.className.replace(/\bProseMirror(-\S+)?\b/g, "").trim();
  for (const s of sources.slice(0, 3)) {
    const c = s.cloneNode(true) as HTMLElement;
    c.removeAttribute("id");
    c.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
    c.classList.remove("dxe-block-sel", "ProseMirror-selectednode");
    prose.appendChild(c);
  }
  ghost.appendChild(prose);
  if (sources.length > 3) {
    const more = document.createElement("div");
    more.className = "dxe-dragghost__more";
    more.textContent = `+${sources.length - 3} more`;
    ghost.appendChild(more);
  }
  if (sources.length > 1) ghost.dataset.count = String(sources.length);
  document.body.appendChild(ghost);
  const img = blankImage();
  if (img && e.dataTransfer) e.dataTransfer.setDragImage(img, 0, 0);
  const move = (ev: DragEvent) => {
    const d = drag;
    if (!d || (ev.clientX === 0 && ev.clientY === 0)) return;
    d.at = { x: ev.clientX, y: ev.clientY };
    if (!d.raf) d.raf = requestAnimationFrame(placeGhost);
  };
  const end = (ev: Event) => endDrag(ev.type === "dragend" && (ev as DragEvent).dataTransfer?.dropEffect === "none");
  document.addEventListener("dragover", move, true);
  document.addEventListener("dragend", end, true);
  document.addEventListener("drop", end);
  drag = {
    view,
    from,
    to,
    many: sources.length > 1,
    grab: { x: e.clientX - r.left, y: e.clientY - r.top },
    at: { x: e.clientX, y: e.clientY },
    ghost,
    sources,
    raf: 0,
    off: () => {
      document.removeEventListener("dragover", move, true);
      document.removeEventListener("dragend", end, true);
      document.removeEventListener("drop", end);
    },
  };
  placeGhost();
  // The originals dim once the browser has taken its (blank) picture.
  requestAnimationFrame(() => {
    if (drag?.sources === sources) for (const s of sources) s.classList.add("dxe-dragsource");
  });
}

/* ── the extension ─────────────────────────────────────────────────────── */

export const BlockDnd = Extension.create({
  name: "dxeBlockDnd",
  addProseMirrorPlugins() {
    let line: DropLine | null = null;
    const update = (view: EditorView, e: DragEvent) => {
      if (!view.editable || document.body.classList.contains("dxe-sidedrop")) return line?.hide();
      const dragging = (view as unknown as { dragging: { slice: Slice } | null }).dragging;
      const slice = dragging?.slice ?? null;
      // Blocks (a handle drag, or files from outside): between blocks.
      if (!slice || wholeBlocks(slice)) {
        const place = blockDropAt(view, e.clientX, e.clientY, slice);
        if (place && drag && drag.view === view && place.pos >= drag.from && place.pos <= drag.to) return line?.hide();
        const at = place && lineFor(view, place);
        if (at) return line?.show(at.x, at.y, at.w, 3, false);
      }
      // Text, or a block ProseMirror places itself: a bar at the drop point.
      const found = view.posAtCoords({ left: e.clientX, top: e.clientY });
      if (!found) return line?.hide();
      let pos = found.pos;
      if (slice) {
        const p = dropPoint(view.state.doc, pos, slice);
        if (p != null) pos = p;
      }
      const $pos = view.state.doc.resolve(pos);
      if (!$pos.parent.inlineContent) {
        const dom = view.nodeDOM(pos) ?? view.nodeDOM(pos - ($pos.nodeBefore?.nodeSize ?? 0));
        if (dom instanceof HTMLElement) {
          const r = dom.getBoundingClientRect();
          return line?.show(r.left, ($pos.nodeAfter ? r.top : r.bottom) - 1.5, r.width, 3, false);
        }
        return line?.hide();
      }
      const c = view.coordsAtPos(pos);
      line?.show(c.left - 1, c.top, 2, c.bottom - c.top, true);
    };
    return [
      new Plugin({
        key: dndKey,
        view() {
          line = new DropLine();
          return {
            destroy() {
              line?.destroy();
              line = null;
              if (drag) endDrag(false);
            },
          };
        },
        props: {
          handleDOMEvents: {
            dragover(view, e) {
              update(view, e);
              return false;
            },
            dragleave(view, e) {
              if (!view.dom.contains(e.relatedTarget as Node | null)) line?.hide();
              return false;
            },
            drop() {
              line?.hide();
              return false;
            },
            dragend() {
              line?.hide();
              return false;
            },
          },
          handleDrop(view, event, slice, moved) {
            const d = drag;
            if (!moved || !d || d.view !== view || !wholeBlocks(slice)) return false;
            const place = blockDropAt(view, event.clientX, event.clientY, slice);
            if (!place) return false;
            const from = { x: d.at.x - d.grab.x, y: d.at.y - d.grab.y };
            let done: { from: number; to: number } | null = null;
            flip(
              view,
              () => {
                const tr = view.state.tr;
                done = moveSlice(tr, slice, d.from, d.to, place.pos);
                if (!done) return;
                const first = tr.doc.nodeAt(done.from);
                if (d.many) {
                  const last = tr.doc.resolve(done.to).nodeBefore;
                  if (last) tr.setSelection(BlockSelection.create(tr.doc, done.from, done.to - last.nodeSize));
                } else if (first && NodeSelection.isSelectable(first)) tr.setSelection(NodeSelection.create(tr.doc, done.from));
                view.focus();
                view.dispatch(tr.setMeta("uiEvent", "drop"));
              },
              { from, find: () => (done ? (view.nodeDOM(done.from) as HTMLElement | null) : null) },
            );
            endDrag(false);
            return true;
          },
        },
      }),
    ];
  },
});
