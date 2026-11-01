/**
 * Dragging a card by its grip: a pointer drag (not the browser's drag and drop, which the editor
 * uses for blocks and whose drop cursor would offer every gap on the page) that only offers places
 * between cards: in its own grid or in another one. A line shows where it lands, the card being
 * moved fades, Escape cancels, and the page scrolls near its edges.
 *
 * The move itself is `moveCard` (core/cards.mjs), one transaction, Markdown kept verbatim.
 */
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { moveCard, stepCard } from "../core/cards.mjs";

interface Target {
  grid: HTMLElement;
  index: number;
}

const START_PX = 4;
const EDGE_PX = 56;

/** The card elements of a grid (`.dxe-cards__grid`), in document order. */
function cardsOf(grid: HTMLElement): HTMLElement[] {
  const box = grid.querySelector<HTMLElement>(":scope > [data-node-view-content-react]") ?? grid;
  return Array.from(box.children).filter((c): c is HTMLElement => c instanceof HTMLElement && !!c.querySelector(".dxe-card"));
}

/** The card element (the node view's outer element) holding `el`, among `grid`'s cards. */
const outerOf = (grid: HTMLElement, el: Element) => cardsOf(grid).find((c) => c.contains(el)) ?? null;

/** True when the grid lays its cards out in one column (1 column chosen, or a narrow screen). */
function oneColumn(grid: HTMLElement): boolean {
  const box = grid.querySelector<HTMLElement>(":scope > [data-node-view-content-react]") ?? grid;
  return getComputedStyle(box).gridTemplateColumns.trim().split(/\s+/).length <= 1;
}

/** The position of the `cards` node whose grid element is `grid`. */
function gridPosOf(editor: Editor, grid: HTMLElement): number | null {
  let found: number | null = null;
  editor.state.doc.descendants((n, pos) => {
    if (found !== null) return false;
    if (n.type.name !== "cards") return true;
    const dom = editor.view.nodeDOM(pos);
    if (dom instanceof HTMLElement && dom.querySelector(".dxe-cards__grid") === grid) found = pos;
    return true;
  });
  return found;
}

function scrollBox(el: HTMLElement): HTMLElement {
  let box = el.parentElement;
  while (box && box !== document.body) {
    const oy = getComputedStyle(box).overflowY;
    if (/(auto|scroll)/.test(oy) && box.scrollHeight > box.clientHeight) return box;
    box = box.parentElement;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

/** Puts focus back on the moved card's grip once its node view has rendered. */
export function focusGripAt(editor: Editor, pos: number) {
  let tries = 0;
  const go = () => {
    const dom = editor.view.nodeDOM(pos);
    const grip = dom instanceof HTMLElement ? dom.querySelector<HTMLElement>(".dxe-card__grip") : null;
    if (grip) grip.focus({ preventScroll: false });
    else if (tries++ < 5) requestAnimationFrame(go);
  };
  requestAnimationFrame(go);
}

/** Moves the card at `pos` one place earlier or later. Returns the new position, or null. */
export function stepCardIn(editor: Editor, pos: number, dir: -1 | 1): number | null {
  const tr = editor.state.tr;
  const at = stepCard(tr, pos, dir);
  if (at === null) return null;
  tr.setSelection(NodeSelection.create(tr.doc, at));
  editor.view.dispatch(tr);
  return at;
}

/**
 * Starts watching a pointer press on a card's grip; past a few pixels it becomes a drag. Returns
 * nothing: the drag cleans up after itself (drop, Escape, pointer cancel).
 */
export function pressCardGrip(e: React.PointerEvent<HTMLElement>, editor: Editor, getPos: () => number | undefined, title: string) {
  if (e.button !== 0 || !editor.isEditable) return;
  const grip = e.currentTarget;
  const source = grip.closest<HTMLElement>(".dxe-card");
  const sourceGrid = source?.closest<HTMLElement>(".dxe-cards__grid");
  if (!source || !sourceGrid) return;
  const sourceOuter = outerOf(sourceGrid, source);
  const x0 = e.clientX, y0 = e.clientY;
  let x = x0, y = y0;
  let dragging = false;
  let target: Target | null = null;
  let line: HTMLDivElement | null = null;
  let ghost: HTMLDivElement | null = null;
  let raf = 0;
  const box = scrollBox(editor.view.dom as HTMLElement);
  const pointerId = e.pointerId;
  try { grip.setPointerCapture(pointerId); } catch { /* not capturable: window listeners still work */ }

  const hide = () => line && (line.style.display = "none");

  /** Where a drop at (x, y) would put the card, and the line that says so. */
  const locate = () => {
    target = null;
    const hit = document.elementFromPoint(x, y);
    const grid = hit?.closest<HTMLElement>(".dxe-cards__grid");
    if (!grid || !editor.view.dom.contains(grid) || source.contains(grid)) return hide();
    const cards = cardsOf(grid);
    if (!cards.length) return hide();
    let best = 0, bestD = Infinity;
    cards.forEach((c, k) => {
      const r = c.getBoundingClientRect();
      const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom);
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = k; }
    });
    const r = cards[best]!.getBoundingClientRect();
    const vertical = oneColumn(grid);
    const before = vertical ? y < r.top + r.height / 2 : x < r.left + r.width / 2;
    const index = before ? best : best + 1;
    const from = grid === sourceGrid && sourceOuter ? cards.indexOf(sourceOuter) : -1;
    if (from >= 0 && (index === from || index === from + 1)) return hide();
    target = { grid, index };
    if (!line) return;
    const gap = parseFloat(getComputedStyle(grid.querySelector(":scope > [data-node-view-content-react]") ?? grid).columnGap) || 12;
    const s = line.style;
    s.display = "block";
    if (vertical) {
      s.left = `${r.left}px`;
      s.width = `${r.width}px`;
      s.height = "3px";
      s.top = `${(before ? r.top : r.bottom) + (before ? -1 : 1) * (gap / 2) - 1.5}px`;
    } else {
      s.top = `${r.top}px`;
      s.height = `${r.height}px`;
      s.width = "3px";
      s.left = `${(before ? r.left : r.right) + (before ? -1 : 1) * (gap / 2) - 1.5}px`;
    }
  };

  const tick = () => {
    raf = 0;
    if (!dragging) return;
    const b = box === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : box.getBoundingClientRect();
    const up = y - Math.max(b.top, 0), down = Math.min(b.bottom, window.innerHeight) - y;
    const speed = up < EDGE_PX ? -Math.ceil((EDGE_PX - up) / 4) : down < EDGE_PX ? Math.ceil((EDGE_PX - down) / 4) : 0;
    if (speed) {
      box.scrollTop += speed;
      locate();
      raf = requestAnimationFrame(tick);
    }
  };

  const begin = () => {
    dragging = true;
    source.classList.add("dxe-card--dragging");
    document.body.classList.add("dxe-card-dragging");
    window.getSelection()?.removeAllRanges();
    line = document.createElement("div");
    line.className = "dxe-card-drop";
    line.setAttribute("aria-hidden", "true");
    ghost = document.createElement("div");
    ghost.className = "dxe-card-ghost";
    ghost.setAttribute("aria-hidden", "true");
    ghost.textContent = title || "Card";
    // Inside the editor's root, so its theme tokens apply (it is position: fixed).
    const host = (editor.view.dom as HTMLElement).closest(".dxe-root") ?? document.body;
    host.append(line, ghost);
  };

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    x = ev.clientX;
    y = ev.clientY;
    if (!dragging) {
      if (Math.hypot(x - x0, y - y0) < START_PX) return;
      begin();
    }
    ev.preventDefault();
    if (ghost) ghost.style.transform = `translate(${x + 14}px, ${y + 10}px)`;
    locate();
    if (!raf) raf = requestAnimationFrame(tick);
  };

  const finish = (drop: boolean) => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    window.removeEventListener("keydown", onKey, true);
    cancelAnimationFrame(raf);
    try { grip.releasePointerCapture(pointerId); } catch { /* already released */ }
    if (!dragging) return;
    source.classList.remove("dxe-card--dragging");
    document.body.classList.remove("dxe-card-dragging");
    line?.remove();
    ghost?.remove();
    // The click that follows the drop is not a click on the grip (it would open its menu).
    const swallow = (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); };
    window.addEventListener("click", swallow, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    const t = target as Target | null;
    if (!drop || !t) return;
    const from = getPos();
    const gridPos = gridPosOf(editor, t.grid);
    if (typeof from !== "number" || gridPos === null) return;
    const tr = editor.state.tr;
    const at = moveCard(tr, from, gridPos, t.index);
    if (at === null) return;
    tr.setSelection(NodeSelection.create(tr.doc, at));
    editor.view.dispatch(tr);
  };
  const onUp = (ev: PointerEvent) => ev.pointerId === pointerId && finish(true);
  const onCancel = (ev: PointerEvent) => ev.pointerId === pointerId && finish(false);
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !dragging) return;
    ev.preventDefault();
    ev.stopPropagation();
    finish(false);
  };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  window.addEventListener("keydown", onKey, true);
}
