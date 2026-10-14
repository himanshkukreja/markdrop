"use client";

import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { ISLANDS, type IslandName } from "./islands";

/**
 * Server-rendered static frame first, interactive game second (REVAMP_BUILD 2.5).
 *
 * `children` is the static first frame (server HTML, no JS). The game chunk loads when the section
 * comes within 400px of the viewport (`when="visible"`), or once the browser is idle after first
 * paint (`when="idle"`, the hero), and immediately on pointer, touch or keyboard intent. If a control
 * inside the static frame had focus, focus moves to the control with the same `id` in the game.
 */
export default function LazyIsland({
  name,
  children,
  when = "visible",
  className,
}: {
  name: IslandName;
  children: ReactNode;
  when?: "visible" | "idle";
  className?: string;
}) {
  const [Game, setGame] = useState<ComponentType | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const focusId = useRef<string | null>(null);

  const load = useCallback(() => {
    if (started.current) return;
    started.current = true;
    ISLANDS[name]()
      .then((m) => setGame(() => m.default))
      .catch(() => {
        started.current = false; // a failed chunk load leaves the static frame; intent retries
      });
  }, [name]);

  useEffect(() => {
    if (when === "idle") {
      const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
      if (w.requestIdleCallback) {
        const id = w.requestIdleCallback(load, { timeout: 2500 });
        return () => w.cancelIdleCallback?.(id);
      }
      const t = window.setTimeout(load, 800);
      return () => window.clearTimeout(t);
    }
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      load();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          load();
        }
      },
      { rootMargin: "400px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [load, when]);

  useEffect(() => {
    if (!Game || !focusId.current) return;
    const el = ref.current?.querySelector<HTMLElement>(`#${CSS.escape(focusId.current)}`);
    el?.focus();
    focusId.current = null;
  }, [Game]);

  return (
    <div
      ref={ref}
      className={className}
      data-island={name}
      data-ready={Game ? "" : undefined}
      onPointerEnter={load}
      onTouchStart={load}
      onFocusCapture={(e) => {
        if (!Game) focusId.current = (e.target as HTMLElement).id || null;
        load();
      }}
    >
      {Game ? <Game /> : children}
    </div>
  );
}
