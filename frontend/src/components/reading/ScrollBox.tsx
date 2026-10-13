"use client";

import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject } from "react";

/**
 * Horizontal overflow state for a scroll box: whether it overflows, and whether there is more
 * content to the right (drives the right-edge fade, which hides once the end is reached).
 */
export function useOverflowFade<T extends HTMLElement>(): [RefObject<T | null>, { overflowing: boolean; more: boolean }] {
  const ref = useRef<T | null>(null);
  const [state, setState] = useState({ overflowing: false, more: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const overflowing = el.scrollWidth > el.clientWidth + 1;
      const more = overflowing && el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setState((s) => (s.overflowing === overflowing && s.more === more ? s : { overflowing, more }));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener("scroll", schedule, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", schedule);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return [ref, state];
}

export interface ScrollBoxProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
  /** Class for the scrolling element (the outer element carries `className`). */
  scrollClassName?: string;
  /** Accessible name for the scroll region when it overflows (keyboard users can focus it). */
  label?: string;
}

/**
 * An `overflow-x: auto` box with a right-edge fade while more content is hidden. Becomes a
 * focusable, named region only when it actually scrolls, so keyboard users can reach the overflow.
 */
export function ScrollBox({ children, className, scrollClassName, label, ...rest }: ScrollBoxProps) {
  const [ref, { overflowing, more }] = useOverflowFade<HTMLDivElement>();
  return (
    <div className={["md-scrollbox not-prose", className].filter(Boolean).join(" ")} data-more={more ? "" : undefined} {...rest}>
      <div
        ref={ref}
        className={["md-scrollbox__scroller", scrollClassName].filter(Boolean).join(" ")}
        tabIndex={overflowing ? 0 : undefined}
        role={overflowing && label ? "region" : undefined}
        aria-label={overflowing && label ? label : undefined}
      >
        {children}
      </div>
      <span className="md-scrollbox__fade" aria-hidden />
    </div>
  );
}
