"use client";

/**
 * Comments on the page itself: highlights for the threads' text and blocks, the "Comment" button beside a
 * selection (and ⌘⌥M / Ctrl+Alt+M), a margin button on each block, and a click on highlighted text opening
 * its thread. Works over the reader's rendered Markdown and over the editor's DOM alike: highlights use the
 * CSS Custom Highlight API (no DOM changes, so ProseMirror never sees them), with positioned boxes as the
 * fallback where it's missing.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/ui";
import type { Thread } from "@/lib/comments";
import { blockAnchor, blockOf, indexText, resolveAnchor, selectionAnchor } from "./anchorDom";
import { useComments } from "./context";
import "./comments.css";

type HighlightCtor = new (...ranges: Range[]) => unknown;
interface HighlightRegistry { set(name: string, h: unknown): void; delete(name: string): void }

function highlights(): { reg: HighlightRegistry; Ctor: HighlightCtor } | null {
  const css = (globalThis as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Ctor = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;
  return css?.highlights && Ctor ? { reg: css.highlights, Ctor } : null;
}

// The ::highlight() rules live in a <style> that exists only while some layer has highlights: merely having
// them in the stylesheet made every keystroke's layout/selection update about 2x slower (perf-typing).
const HL_STYLE_ID = "md-comments-hl";
const hlOn = new Set<string>();
function highlightCss(name: string, on: boolean) {
  if (typeof document === "undefined") return;
  if (on) hlOn.add(name); else hlOn.delete(name);
  let el = document.getElementById(HL_STYLE_ID);
  if (!hlOn.size) { el?.remove(); return; }
  if (!el) {
    el = document.createElement("style");
    el.id = HL_STYLE_ID;
    el.textContent = ["md-comments", "md-comments-editor"].map((n) =>
      `::highlight(${n}){background-color:var(--mdc-hl)}::highlight(${n}-active){background-color:var(--mdc-hl-active)}`).join("");
    document.head.appendChild(el);
  }
}

/** Where each thread is on screen now (viewport px), for the margin layout. Shared with the panel. */
export type ThreadPositions = Map<string, number>;
const positionListeners = new Set<(p: ThreadPositions) => void>();
let lastPositions: ThreadPositions = new Map();
export function subscribePositions(fn: (p: ThreadPositions) => void): () => void {
  positionListeners.add(fn);
  fn(lastPositions);
  return () => { positionListeners.delete(fn); };
}
function publishPositions(p: ThreadPositions) {
  lastPositions = p;
  positionListeners.forEach((fn) => fn(p));
}

interface Props {
  /** The element holding the item's rendered text (reader) or the editor's `.ProseMirror`. */
  root: HTMLElement | null;
  /** Which highlight names to use (reader and editor can both be on screen while the editor loads). */
  name?: string;
}

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function CommentLayer({ root, name = "md-comments" }: Props) {
  const c = useComments();
  const [sel, setSel] = useState<{ top: number; left: number } | null>(null);
  const [hover, setHover] = useState<{ el: HTMLElement; top: number; left: number } | null>(null);
  const [boxes, setBoxes] = useState<Array<{ id: string; active: boolean; rects: DOMRect[] }>>([]);
  const ranges = useRef<Map<string, Range>>(new Map());
  const hideTimer = useRef(0);
  const [tick, setTick] = useState(0);
  const canComment = !!c?.perms.comment;
  const signInMode = !!c && !c.user && c.enabled;

  const visible: Thread[] = (c?.threads ?? []).filter((t) => t.status === "open" || t.id === c?.activeId);
  // Threads with text on the page to paint. Without any, nothing here needs to read the text: no index,
  // no mutation watching (a long page being typed into stays as fast as without comments).
  const anchored = visible.some((t) => t.anchor.type !== "page" && t.anchor_status !== "changed");

  // Re-resolve when the text changes (a live update, the editor typing): debounced, and at an idle moment
  // so it never lands between two keystrokes.
  useEffect(() => {
    if (!root || !anchored) return;
    let t = 0;
    let idle = 0;
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const cic = (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
    const bump = () => setTick((n) => n + 1);
    const mo = new MutationObserver(() => {
      window.clearTimeout(t);
      t = window.setTimeout(() => { if (ric) idle = ric(bump, { timeout: 1000 }); else bump(); }, 300);
    });
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    return () => { mo.disconnect(); window.clearTimeout(t); if (idle && cic) cic(idle); };
  }, [root, anchored]);

  // Resolve every visible thread's anchor to a Range and paint.
  useLayoutEffect(() => {
    if (!root || !c) return;
    if (!anchored) {
      if (ranges.current.size) ranges.current = new Map();
      const hl = highlights();
      if (hl) { hl.reg.delete(name); hl.reg.delete(`${name}-active`); }
      highlightCss(name, false);
      setBoxes((b) => (b.length ? [] : b));
      return;
    }
    const idx = indexText(root);
    const next = new Map<string, Range>();
    for (const t of visible) {
      if (t.anchor.type === "page" || t.anchor_status === "changed") continue;
      const r = resolveAnchor(root, t.anchor, idx);
      if (r) next.set(t.id, r);
    }
    ranges.current = next;
    const hl = highlights();
    if (hl) {
      const normal = [...next].filter(([id]) => id !== c.activeId).map(([, r]) => r);
      const active = c.activeId && next.get(c.activeId) ? [next.get(c.activeId)!] : [];
      hl.reg.set(name, new hl.Ctor(...normal));
      hl.reg.set(`${name}-active`, new hl.Ctor(...active));
      highlightCss(name, next.size > 0);
      setBoxes([]);
    } else {
      setBoxes([...next].map(([id, r]) => ({ id, active: id === c.activeId, rects: Array.from(r.getClientRects()) })));
    }
    return () => {
      const h = highlights();
      if (h) { h.reg.delete(name); h.reg.delete(`${name}-active`); }
      highlightCss(name, false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, c?.threads, c?.activeId, tick, name, anchored]);

  // Positions for the aligned margin (viewport y of each thread), on scroll / resize, one frame at a time.
  useEffect(() => {
    if (!root) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const p: ThreadPositions = new Map();
      for (const [id, r] of ranges.current) {
        const rect = r.getBoundingClientRect();
        if (rect.height || rect.width) p.set(id, rect.top);
      }
      publishPositions(p);
      if (!highlights()) {
        setBoxes((cur) => cur.map((b) => ({ ...b, rects: Array.from(ranges.current.get(b.id)?.getClientRects() ?? []) })));
      }
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(measure); };
    kick();
    window.addEventListener("scroll", kick, { capture: true, passive: true });
    window.addEventListener("resize", kick);
    const ro = new ResizeObserver(kick);
    ro.observe(root);
    return () => {
      window.removeEventListener("scroll", kick, { capture: true });
      window.removeEventListener("resize", kick);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [root, tick, c?.threads, c?.activeId]);

  // Reveal a thread's text (a `#c-…` link, a click on a card).
  useEffect(() => {
    const onReveal = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      const r = id ? ranges.current.get(id) : null;
      if (!r) return;
      const el = r.startContainer.nodeType === Node.ELEMENT_NODE ? (r.startContainer as Element) : r.startContainer.parentElement;
      el?.scrollIntoView({ block: "center", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    };
    window.addEventListener("md:comments-reveal", onReveal);
    return () => window.removeEventListener("md:comments-reveal", onReveal);
  }, []);

  // The selection: a "Comment" button in the right margin at the selection's line.
  const updateSel = useCallback(() => {
    if (!root || !c || (!canComment && !signInMode)) { setSel(null); return; }
    const s = window.getSelection();
    if (!s || s.isCollapsed || s.rangeCount === 0 || !root.contains(s.getRangeAt(0).commonAncestorContainer)) { setSel(null); return; }
    const rect = s.getRangeAt(0).getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    if (!rect.height && !rect.width) { setSel(null); return; }
    setSel({ top: rect.top, left: Math.min(window.innerWidth - 48, rootRect.right + 8) });
  }, [root, c, canComment, signInMode]);

  // Again whenever what this reader may do changes (the permissions arrive after the selection).
  useEffect(() => { updateSel(); }, [updateSel]);
  // Read the selection when the browser is idle: reading it right after the editor changed the page forces a
  // layout of the whole page between two keystrokes (a long task while typing in a long page).
  useEffect(() => {
    let t = 0;
    let idle = 0;
    const w = window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    const run = () => { idle = 0; updateSel(); };
    const on = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        if (idle) return;
        idle = w.requestIdleCallback ? w.requestIdleCallback(run, { timeout: 250 }) : window.setTimeout(run, 0);
      }, 60);
    };
    document.addEventListener("selectionchange", on);
    window.addEventListener("scroll", on, { capture: true, passive: true });
    return () => {
      document.removeEventListener("selectionchange", on);
      window.removeEventListener("scroll", on, { capture: true });
      window.clearTimeout(t);
      if (idle) { if (w.cancelIdleCallback) w.cancelIdleCallback(idle); else window.clearTimeout(idle); }
    };
  }, [updateSel]);

  const commentOnSelection = useCallback((): boolean => {
    if (!root || !c) return false;
    const anchor = selectionAnchor(root, window.getSelection());
    if (!anchor) return false;
    if (!c.user) { window.location.href = c.signInHref; return true; }
    if (!c.perms.comment) return false;
    c.startDraft(anchor);
    setSel(null);
    return true;
  }, [root, c]);

  // ⌘⌥M / Ctrl+Alt+M: comment on the selection.
  useEffect(() => {
    if (!c || (!canComment && !signInMode)) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyM" || !e.altKey || !(isMac() ? e.metaKey : e.ctrlKey)) return;
      if (commentOnSelection()) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [c, canComment, signInMode, commentOnSelection]);

  // A click on highlighted text opens its thread (unless the click made a selection).
  useEffect(() => {
    if (!root || !c) return;
    const onClick = (e: MouseEvent) => {
      const s = window.getSelection();
      if (s && !s.isCollapsed) return;
      if ((e.target as Element | null)?.closest("a, button, input, textarea, [contenteditable='false']")) return;
      type CaretDoc = Document & {
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      };
      const d = document as CaretDoc;
      let node: Node | null = null;
      let off = 0;
      if (d.caretPositionFromPoint) {
        const p = d.caretPositionFromPoint(e.clientX, e.clientY);
        if (p) { node = p.offsetNode; off = p.offset; }
      } else if (d.caretRangeFromPoint) {
        const r = d.caretRangeFromPoint(e.clientX, e.clientY);
        if (r) { node = r.startContainer; off = r.startOffset; }
      }
      if (!node) return;
      for (const [id, r] of ranges.current) {
        try {
          if (r.isPointInRange(node, off) && r.toString().trim()) {
            c.openPanel(id);
            c.setActive(id);
            return;
          }
        } catch { /* a node from another document */ }
      }
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [root, c]);

  // A block's margin button (hover), for commenting on a whole block.
  useEffect(() => {
    if (!root || !canComment) return;
    const onMove = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target || !root.contains(target)) return;
      const el = blockOf(root, target);
      if (!el || el === root) return;
      const r = el.getBoundingClientRect();
      const rr = root.getBoundingClientRect();
      window.clearTimeout(hideTimer.current);
      setHover((cur) => (cur?.el === el ? cur : { el, top: r.top, left: rr.right + 8 }));
    };
    const onLeave = () => {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setHover(null), 500);
    };
    root.addEventListener("mousemove", onMove);
    root.addEventListener("mouseleave", onLeave);
    const onScroll = () => setHover(null);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      root.removeEventListener("mousemove", onMove);
      root.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [root, canComment]);

  if (!c || typeof document === "undefined") return null;
  const mod = isMac() ? "⌘⌥M" : "Ctrl+Alt+M";
  return createPortal(
    <>
      {boxes.map((b) => b.rects.map((r, i) => (
        <span key={`${b.id}-${i}`} className={`mdc-box${b.active ? " mdc-box--active" : ""}`} aria-hidden
          style={{ top: r.top, left: r.left, width: r.width, height: r.height }} />
      )))}
      {sel && (
        <button type="button" className="mdc-selbtn" data-comments-skip style={{ top: sel.top, left: sel.left }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { commentOnSelection(); }}
          aria-label={c.user ? `Comment (${mod})` : "Sign in to comment"}
          title={c.user ? `Comment (${mod})` : "Sign in to comment"}>
          <Icon name="messagePlus" />
          {!c.user && <span className="mdc-selbtn__label">Sign in to comment</span>}
        </button>
      )}
      {hover && !sel && (
        <button type="button" className="mdc-blockbtn" data-comments-skip style={{ top: hover.top, left: hover.left }}
          aria-label="Comment on this block" title="Comment on this block"
          onMouseEnter={() => window.clearTimeout(hideTimer.current)}
          onMouseLeave={() => { hideTimer.current = window.setTimeout(() => setHover(null), 300); }}
          onClick={() => { c.startDraft(blockAnchor(hover.el)); setHover(null); }}>
          <Icon name="message" />
        </button>
      )}
    </>,
    document.body,
  );
}
