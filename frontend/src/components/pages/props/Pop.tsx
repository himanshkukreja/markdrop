"use client";

/**
 * A popover anchored to an element (fixed, portalled, flips above when there's no room), or a
 * bottom sheet on phones. Esc and a click outside close it; focus goes into it on open and back to
 * the anchor on close. Enters over 140 ms (sheet 220 ms); instant with reduced motion (props.css).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "@/components/ui";
import { useMediaQuery } from "@/components/dashboard/hooks";

export const PHONE = "(max-width: 640px)";

export function usePhoneProps(): boolean {
  return useMediaQuery(PHONE);
}

export interface PopProps {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: React.ReactNode;
  /** The sheet's heading on phones (and the dialog's name). */
  title: string;
  width?: number;
  align?: "start" | "end";
  className?: string;
  /** Keep the anchor's width (a cell editor). */
  matchWidth?: boolean;
}

export function Pop({ anchor, onClose, children, title, width = 300, align = "start", className, matchWidth }: PopProps) {
  const phone = usePhoneProps();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; up: boolean } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    if (phone || !anchor) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const el = ref.current;
      const h = el?.offsetHeight ?? 320;
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const w = Math.min(Math.max(width, matchWidth ? a.width : 0), vw - 16);
      const below = vh - a.bottom;
      const up = below < h + 12 && a.top > below;
      let left = align === "end" ? a.right - w : a.left;
      left = Math.max(8, Math.min(left, vw - w - 8));
      setPos(up ? { bottom: vh - a.top + 4, left, up } : { top: a.bottom + 4, left, up });
    };
    place();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    if (ref.current) ro?.observe(ref.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, phone, width, align, matchWidth]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close.current();
      }
    };
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      // A click inside another of our popovers (a nested editor) isn't outside.
      if ((t as HTMLElement).closest?.(".pp-pop, .pp-sheet")) return;
      close.current();
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", down, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", down, true);
    };
  }, [anchor]);

  // Focus in on open (the first field, else the panel); back to the anchor on close.
  useEffect(() => {
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>("input, textarea, [data-autofocus]") ?? el;
    first?.focus({ preventScroll: true });
    const back = anchor;
    return () => {
      if (back && document.activeElement && (document.activeElement === document.body || ref.current?.contains(document.activeElement))) back.focus({ preventScroll: true });
    };
  }, [anchor]);

  if (typeof document === "undefined") return null;
  if (phone) {
    return createPortal(
      <>
        <div className="pp-sheet-backdrop" onClick={() => close.current()} aria-hidden />
        <div ref={ref} className={cx("pp-sheet pp-scope", className)} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
          <span className="pp-sheet__grab" aria-hidden />
          <div className="pp-sheet__title">{title}</div>
          {children}
        </div>
      </>,
      document.body,
    );
  }
  const w = Math.max(width, matchWidth && anchor ? anchor.getBoundingClientRect().width : 0);
  return createPortal(
    <div
      ref={ref}
      className={cx("pp-pop pp-scope", pos?.up && "pp-pop--up", className)}
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      style={{ width: w, top: pos?.top, bottom: pos?.bottom, left: pos?.left ?? -9999, visibility: pos ? undefined : "hidden" }}
    >
      {children}
    </div>,
    document.body,
  );
}
