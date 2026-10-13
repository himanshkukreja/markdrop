"use client";

import { useSyncExternalStore } from "react";

/** A CSS media query as state; `false` on the server and during hydration. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener?.("change", cb);
      return () => mql.removeEventListener?.("change", cb);
    },
    () => (typeof window !== "undefined" && !!window.matchMedia?.(query).matches),
    () => false,
  );
}

/** Phone layout (below Tailwind's `sm`, 640px). */
export const usePhone = () => useMediaQuery("(max-width: 639.98px)");

/**
 * The "/" search shortcut (REVAMP_PLAN 7.6 "Keys"): only a bare "/" with no modifiers, never while
 * focus is in a field or an editable element, and never while a dialog, drawer or menu is open.
 */
export function shouldHandleSlash(e: KeyboardEvent): boolean {
  if (e.key !== "/" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return false;
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return false;
  const a = document.activeElement as HTMLElement | null;
  if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return false;
  if (document.querySelector('[aria-modal="true"], [role="menu"]')) return false;
  return true;
}
