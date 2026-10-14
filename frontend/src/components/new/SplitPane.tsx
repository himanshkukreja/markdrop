"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { cx } from "@/components/ui";

/**
 * Two panes side by side, 50/50 by default, with a draggable divider (REVAMP_PLAN 7.3, /new Split).
 *
 * The divider is a focusable `separator` (WAI-ARIA window splitter): Left/Right move it by 5%,
 * Home/End jump to the limits, Enter or a double-click puts it back in the middle. Pointer drags use
 * pointer capture, so a fast drag that leaves the divider keeps working.
 */
export interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  /** Accessible name of the divider. */
  label?: string;
  /** id of the left pane (the separator `aria-controls` it). */
  leftId?: string;
  min?: number;
  max?: number;
  className?: string;
}

export function SplitPane({ left, right, label = "Resize the editor and the preview", leftId, min = 0.25, max = 0.75, className }: SplitPaneProps) {
  const [ratio, setRatio] = useState(0.5);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));

  function fromPointer(e: PointerEvent<HTMLDivElement>) {
    const box = rootRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    setRatio(clamp((e.clientX - box.left) / box.width));
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = ratio - 0.05;
    else if (e.key === "ArrowRight") next = ratio + 0.05;
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    else if (e.key === "Enter") next = 0.5;
    if (next === null) return;
    e.preventDefault();
    setRatio(clamp(next));
  }

  const pct = Math.round(ratio * 100);
  return (
    <div ref={rootRef} className={cx("flex h-full min-h-0 min-w-0", className)}>
      <div id={leftId} className="h-full min-h-0 min-w-0" style={{ flexBasis: `${pct}%`, flexGrow: 0, flexShrink: 0 }}>
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-controls={leftId}
        aria-valuemin={Math.round(min * 100)}
        aria-valuemax={Math.round(max * 100)}
        aria-valuenow={pct}
        aria-valuetext={`Editor ${pct}%, preview ${100 - pct}%`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onDoubleClick={() => setRatio(0.5)}
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          e.preventDefault();
        }}
        onPointerMove={(e) => { if (dragging.current) fromPointer(e); }}
        onPointerUp={(e) => {
          dragging.current = false;
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        className="md-focus group relative w-px shrink-0 cursor-col-resize touch-none bg-border outline-offset-0"
      >
        {/* A 12px hit area around the 1px rule, and a grip that shows on hover and focus. */}
        <span aria-hidden className="absolute inset-y-0 -left-1.5 -right-1.5" />
        <span
          aria-hidden
          className="absolute top-1/2 left-1/2 h-8 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border-strong bg-surface-raised opacity-0 transition-opacity duration-(--duration-fast) group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </div>
      <div className="h-full min-h-0 min-w-0 flex-1">{right}</div>
    </div>
  );
}

export default SplitPane;
