"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

function scrollFraction(s: Element): number {
  const max = s.scrollHeight - s.clientHeight;
  return max > 0 ? Math.min(1, Math.max(0, s.scrollTop / max)) : 0;
}

/** Calls `fn(fraction)` whenever the scroller (default: the page) scrolls or resizes, at most once a frame. */
function watchScroll(scroller: HTMLElement | null, fn: (f: number) => void): () => void {
  const s = scroller ?? document.scrollingElement ?? document.documentElement;
  const target: HTMLElement | Window = scroller ?? window;
  let raf = 0;
  const update = () => {
    raf = 0;
    fn(scrollFraction(s));
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(update);
  };
  update();
  target.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  // Content height changes too (images load, a diagram renders).
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
  ro?.observe(scroller?.firstElementChild ?? document.body);
  return () => {
    target.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    ro?.disconnect();
    if (raf) cancelAnimationFrame(raf);
  };
}

/** Whole-percent reading progress of the page or a scroll container, for captions ("38% done"). */
export function useReadingProgress(scroller?: RefObject<HTMLElement | null>): number {
  const [pct, setPct] = useState(0);
  useEffect(() => watchScroll(scroller?.current ?? null, (f) => setPct(Math.round(f * 100))), [scroller]);
  return pct;
}

export interface ReadingProgressProps {
  /** The scroll container (the immersive layer). Omit for the page. */
  scroller?: RefObject<HTMLElement | null>;
  className?: string;
}

/**
 * The 2px reading-progress hairline at the top (REVAMP_PLAN 7.6, D34). Page scroll uses a CSS
 * scroll timeline where supported (no JS per frame); a scroll container, or a browser without
 * scroll timelines, gets a rAF-throttled listener. It tracks scroll position, so it is not motion
 * and keeps updating under reduced motion. Decorative (aria-hidden): the percentage is spoken
 * where the viewer prints it as text (useReadingProgress).
 */
export function ReadingProgress({ scroller, className }: ReadingProgressProps) {
  const bar = useRef<HTMLSpanElement>(null);
  const [timeline, setTimeline] = useState(false);
  useEffect(() => {
    const el = scroller?.current ?? null;
    if (!el && typeof CSS !== "undefined" && CSS.supports?.("animation-timeline: scroll()")) {
      setTimeline(true);
      return;
    }
    setTimeline(false);
    return watchScroll(el, (f) => {
      if (bar.current) bar.current.style.transform = `scaleX(${f})`;
    });
  }, [scroller]);
  return (
    <div className={["md-reading-progress no-print", timeline && "md-reading-progress--timeline", className].filter(Boolean).join(" ")} aria-hidden>
      <span ref={bar} className="md-reading-progress__bar" />
    </div>
  );
}
