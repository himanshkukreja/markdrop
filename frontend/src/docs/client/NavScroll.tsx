"use client";

/**
 * The sidebar's scroll container. Every docs page renders its own sidebar, so a click in the
 * sidebar mounts a fresh one scrolled to the top and the reader loses their place. This keeps
 * the scroll position per tab (each tab has its own sidebar) across page changes, in memory for
 * client navigations and in sessionStorage for reloads. When there is nothing to restore, or the
 * current page's row would be out of view, the row is scrolled to the middle of the sidebar.
 */
import { useLayoutEffect, useRef } from "react";

const memory = new Map<string, number>();
const storageKey = (tab: string) => `dx-sidenav:${tab}`;

function saved(tab: string): number | null {
  if (memory.has(tab)) return memory.get(tab)!;
  try {
    const v = sessionStorage.getItem(storageKey(tab));
    return v == null ? null : Number(v) || 0;
  } catch {
    return null;
  }
}

export function NavScroll({ tab = "", className, children }: { tab?: string; className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const top = saved(tab);
    if (top != null) el.scrollTop = top;
    const active = el.querySelector<HTMLElement>('[aria-current="page"]');
    if (active) {
      const box = el.getBoundingClientRect();
      const row = active.getBoundingClientRect();
      if (row.top < box.top || row.bottom > box.bottom) {
        // Not scrollIntoView: that also scrolls the window, and the page should open at its top.
        el.scrollTop += row.top - box.top - (el.clientHeight - row.height) / 2;
      }
    }
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        memory.set(tab, el.scrollTop);
        try {
          sessionStorage.setItem(storageKey(tab), String(Math.round(el.scrollTop)));
        } catch {}
      });
    };
    memory.set(tab, el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", onScroll);
    };
  }, [tab]);

  return (
    <aside ref={ref} className={className}>
      {children}
    </aside>
  );
}
