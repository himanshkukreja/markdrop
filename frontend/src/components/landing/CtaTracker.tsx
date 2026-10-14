"use client";

import { useEffect } from "react";
import { track } from "@/lib/track";

/**
 * landing_cta {id, section} for every `[data-cta]` link or button on the landing page (REVAMP_BUILD
 * §5.H.9), from one document-level listener, so CTAs in server HTML are counted before any island has
 * loaded. `section` is the id of the closest <section> (hero, render-bench, …, start). Ids only: never
 * the typed slug or any other content.
 */
export default function CtaTracker() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.("[data-cta]");
      if (!el) return;
      const id = el.getAttribute("data-cta") || "unknown";
      const section = el.closest("section[id]")?.id || "page";
      track("landing_cta", { id, section });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  return null;
}
