"use client";

import { useEffect, useRef } from "react";
import { track } from "@/lib/track";

const IGNORED_KEYS = new Set(["Tab", "Shift", "Control", "Alt", "Meta", "Escape", "CapsLock"]);

/**
 * Landing analytics for a toy (REVAMP_BUILD §5.H.9). `toy_play {toy}` on the visitor's first input
 * inside the island (a click, a mouse/pen press, a key other than Tab and modifiers, or typing), once
 * per page view; `toy_done {toy}` when `done` turns true after the visitor has played (a demo that
 * finishes by itself is not a completion). Never sends content: no slugs, notes, names or domains.
 * Clicks on links are CTA clicks (landing_cta, see CtaTracker), not play.
 */
export function useToyEvents(toy: string, done: boolean) {
  const played = useRef(false);
  const doneSent = useRef(false);

  useEffect(() => {
    const root = document.querySelector(`[data-island="${toy}"]`);
    if (!root) return;
    const types = ["pointerdown", "click", "keydown", "input"] as const;
    const first = (e: Event) => {
      if (played.current) return;
      const t = e.target as Element | null;
      if (t?.closest?.("a[href]")) return;
      if (e.type === "keydown" && IGNORED_KEYS.has((e as KeyboardEvent).key)) return;
      if (e.type === "pointerdown" && (e as PointerEvent).pointerType === "touch") return; // a tap arrives as click; a swipe may be a scroll
      played.current = true;
      track("toy_play", { toy });
      types.forEach((ty) => root.removeEventListener(ty, first, true));
    };
    types.forEach((ty) => root.addEventListener(ty, first, true));
    return () => types.forEach((ty) => root.removeEventListener(ty, first, true));
  }, [toy]);

  useEffect(() => {
    if (!done || doneSent.current || !played.current) return;
    doneSent.current = true;
    track("toy_done", { toy });
  }, [done, toy]);
}
