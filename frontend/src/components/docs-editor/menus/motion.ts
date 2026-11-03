/**
 * The editor's motion helpers (the CSS is in docs-editor.css, "motion"): menus and popovers come in
 * over 140 ms and go over 100 ms; with prefers-reduced-motion everything is instant.
 *
 *   usePresence(open)   keeps a closing menu mounted for its exit (closing: true meanwhile);
 *   ghostOut(el)        a menu React (or TipTap) removes at once fades out as a copy instead;
 *   flip(view, run)     blocks that move when `run` changes the document slide to their new place.
 */
import { useEffect, useRef, useState } from "react";
import type { EditorView } from "@tiptap/pm/view";

export const EXIT_MS = 100;
export const FLIP_MS = 150;
export const EASE = "cubic-bezier(.16,1,.3,1)";

export function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Mounted while open, and for EXIT_MS after it closes (closing: true then). */
export function usePresence(open: boolean, ms = EXIT_MS): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (open) setMounted(true);
    else if (mounted) {
      if (reducedMotion()) setMounted(false);
      else timer.current = setTimeout(() => setMounted(false), ms);
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- only an open/closed change starts or stops the exit
  return { mounted: open || mounted, closing: !open && mounted };
}

/**
 * Fades out a copy of `el` where it is (the original is about to be removed): for menus whose
 * owner unmounts them at once (the UI kit's Dropdown, TipTap's bubble menu).
 */
export function ghostOut(el: Element | null | undefined) {
  if (!(el instanceof HTMLElement) || !el.isConnected || reducedMotion()) return;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const copy = el.cloneNode(true) as HTMLElement;
  copy.removeAttribute("id");
  copy.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
  copy.setAttribute("aria-hidden", "true");
  copy.setAttribute("inert", "");
  // Fixed where the original is, whatever positioned it.
  Object.assign(copy.style, { position: "fixed", left: `${r.left}px`, top: `${r.top}px`, right: "auto", bottom: "auto", width: `${r.width}px`, height: `${r.height}px`, margin: "0", pointerEvents: "none", visibility: "visible", opacity: "1", zIndex: getComputedStyle(el).zIndex === "auto" ? "1000" : getComputedStyle(el).zIndex, animation: "none", transition: "none" });
  copy.classList.add("dxe-ghostout");
  document.body.appendChild(copy);
  const a = copy.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(4px) scale(.98)" }], { duration: EXIT_MS, easing: "ease-in", fill: "forwards" });
  const done = () => copy.remove();
  a.onfinish = done;
  setTimeout(done, EXIT_MS + 80);
}

/** The blocks a FLIP looks at: the document's top-level blocks and those inside containers, in view. */
function blockEls(view: EditorView): HTMLElement[] {
  const out: HTMLElement[] = [];
  const vh = window.innerHeight;
  const walk = (parent: Element, depth: number) => {
    for (const c of Array.from(parent.children)) {
      if (!(c instanceof HTMLElement)) continue;
      out.push(c);
      if (depth < 2) {
        const inner = c.querySelector(":scope [data-node-view-content-react], :scope > .dxe-li");
        if (inner) walk(inner, depth + 1);
        else if (c.tagName === "UL" || c.tagName === "OL") walk(c, depth + 1);
      }
    }
  };
  walk(view.dom, 0);
  // Only what can be seen (a 300-block page measures a screenful, not the page).
  return out.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > -200 && r.top < vh + 200;
  });
}

let flipping: Animation[] = [];

/**
 * Runs `run` (a change that moves blocks), then slides every block that moved from where it was to
 * where it is now (FLIP: transform only, FLIP_MS). `entering` (optional) is the block that arrived,
 * animated from a point (the drop) instead.
 */
export function flip(view: EditorView, run: () => void, entering?: { from: { x: number; y: number }; find: () => HTMLElement | null }) {
  if (reducedMotion()) return run();
  for (const a of flipping) a.cancel();
  flipping = [];
  const before = new Map<HTMLElement, DOMRect>();
  for (const el of blockEls(view)) before.set(el, el.getBoundingClientRect());
  run();
  const moved: Array<[HTMLElement, number, number]> = [];
  for (const [el, r] of before) {
    if (!el.isConnected) continue;
    const n = el.getBoundingClientRect();
    const dx = r.left - n.left;
    const dy = r.top - n.top;
    if (Math.abs(dy) > 0.5 || Math.abs(dx) > 0.5) moved.push([el, dx, dy]);
  }
  // Nested blocks move with their parent: only animate the outermost that moved.
  const set = new Set(moved.map(([el]) => el));
  for (const [el, dx, dy] of moved) {
    let p = el.parentElement;
    let inside = false;
    while (p && p !== view.dom) {
      if (set.has(p)) {
        inside = true;
        break;
      }
      p = p.parentElement;
    }
    if (inside) continue;
    flipping.push(el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: FLIP_MS, easing: EASE }));
  }
  const el = entering?.find();
  if (el && entering) {
    const n = el.getBoundingClientRect();
    const dx = entering.from.x - n.left;
    const dy = entering.from.y - n.top;
    flipping.push(el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(.98)`, opacity: 0.6 }, { transform: "none", opacity: 1 }], { duration: FLIP_MS + 30, easing: EASE }));
  }
}
