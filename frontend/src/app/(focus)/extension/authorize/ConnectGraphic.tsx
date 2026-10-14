"use client";

import { forwardRef, useImperativeHandle, useRef } from "react";
import { Icon, MarkdropMark, VSCodeIcon } from "@/components/ui";

export interface ConnectGraphicHandle {
  /** Sends the key packet once from Markdrop to VS Code. Resolves when it lands (at once under reduced motion). */
  send: () => Promise<void>;
}

/**
 * VS Code ⇠ dashed connector ⇠ Markdrop (REVAMP_PLAN 7.15). Static while waiting: nothing is
 * connecting yet, so nothing moves. On authorize a packet carrying a key glyph travels once from
 * Markdrop to VS Code (400ms, the reveal duration), then rests beside VS Code. Decorative.
 */
export const ConnectGraphic = forwardRef<ConnectGraphicHandle, { landed?: boolean }>(function ConnectGraphic({ landed }, ref) {
  const track = useRef<HTMLDivElement>(null);
  const packet = useRef<HTMLSpanElement>(null);

  useImperativeHandle(ref, () => ({
    send: () => new Promise<void>((resolve) => {
      const el = packet.current, lane = track.current;
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (!el || !lane || reduce || typeof el.animate !== "function") { resolve(); return; }
      const css = getComputedStyle(document.documentElement);
      const duration = parseFloat(css.getPropertyValue("--duration-reveal")) || 400;
      const easing = css.getPropertyValue("--ease-out").trim() || "ease-out";
      const dist = lane.clientWidth - el.offsetWidth;
      const a = el.animate(
        [
          { transform: `translateX(${dist}px) scale(.9)`, opacity: 0 },
          { transform: `translateX(${dist * 0.85}px) scale(1)`, opacity: 1, offset: 0.15 },
          { transform: "translateX(0) scale(1)", opacity: 1 },
        ],
        { duration, easing, fill: "backwards" },
      );
      a.onfinish = () => resolve();
      a.oncancel = () => resolve();
    }),
  }));

  return (
    <div className="flex items-center justify-center gap-3" aria-hidden="true">
      <span className="grid size-14 flex-none place-items-center rounded-xl border border-border bg-surface-raised text-cat-sync shadow-(--shadow-sm)">
        <VSCodeIcon size={32} />
      </span>
      <div ref={track} className="relative flex h-8 w-24 min-w-0 items-center sm:w-32">
        <span className="absolute inset-x-0 top-1/2 border-t-2 border-dashed border-border-strong" />
        <span
          ref={packet}
          className={[
            "relative grid size-7 place-items-center rounded-full bg-accent text-on-accent shadow-(--shadow-sm)",
            landed ? "visible" : "invisible",
          ].join(" ")}
        >
          <Icon name="key" size={14} />
        </span>
      </div>
      <span className="grid size-14 flex-none place-items-center rounded-xl border border-border bg-surface-raised shadow-(--shadow-sm)">
        <MarkdropMark size={32} />
      </span>
    </div>
  );
});
