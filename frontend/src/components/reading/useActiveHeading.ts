"use client";

import { useEffect, useState } from "react";

/**
 * Scroll-spy: the id of the heading the reader is in (the last heading whose top has crossed a
 * line `offset` of the way down the viewport). IntersectionObserver wakes it when a heading
 * crosses that line; a passive scroll listener only covers the end of the page (the last heading
 * may never reach the line). Works with the window or any scroll container (the immersive layer).
 */
export function useActiveHeading(ids: string[], { offset = 0.3 }: { offset?: number } = {}): string | null {
  const key = ids.join("\n");
  const [active, setActive] = useState<string | null>(ids[0] ?? null);

  useEffect(() => {
    const list = key ? key.split("\n") : [];
    if (!list.length) {
      setActive(null);
      return;
    }
    let raf = 0;
    let atEnd = false;
    const compute = () => {
      raf = 0;
      if (atEnd) {
        setActive(list[list.length - 1]);
        return;
      }
      const line = window.innerHeight * offset;
      let current: string | null = null;
      for (const id of list) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.getBoundingClientRect().top - 1 <= line) current = id;
        else break;
      }
      setActive(current ?? list[0]);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(compute);
    };

    const io = typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver(schedule, { rootMargin: `0px 0px -${Math.round((1 - offset) * 100)}% 0px`, threshold: 0 })
      : null;
    const observed = new Set<string>();
    const attach = () => {
      for (const id of list) {
        if (observed.has(id)) continue;
        const el = document.getElementById(id);
        if (el) {
          io?.observe(el);
          observed.add(id);
        }
      }
      return observed.size === list.length;
    };
    // Content can arrive after the list (an E2E document decrypts later): retry for a few seconds.
    let tries = 0;
    const retry = attach() ? undefined : setInterval(() => {
      if (attach() || ++tries > 20) clearInterval(retry);
      schedule();
    }, 250);

    const onScroll = (e: Event) => {
      const t = e.target;
      const s = t instanceof Element ? t : document.scrollingElement;
      // Only vertical scrollers count (a code block scrolling sideways says nothing about reading).
      if (!s || s.scrollHeight - s.clientHeight < 2) return;
      const end = s.scrollHeight - s.clientHeight - s.scrollTop < 4;
      if (end !== atEnd) {
        atEnd = end;
        schedule();
      } else if (!io) schedule();
    };
    document.addEventListener("scroll", onScroll, { passive: true, capture: true });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      io?.disconnect();
      if (retry) clearInterval(retry);
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [key, offset]);

  return active;
}
