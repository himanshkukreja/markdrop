"use client";

import { useSyncExternalStore } from "react";

/**
 * Single-key keyboard shortcuts (F for full screen, / for search…), on or off per browser.
 *
 * Stored in localStorage `md_shortcuts`: "0" = off, anything else (or nothing) = on, so every
 * existing visitor keeps today's behaviour. People who use screen readers or voice control can turn
 * them off in Settings › Account, because a bare letter key is easy to fire by accident (WCAG 2.1.4).
 *
 * Surfaces that bind single keys should check `shortcutsEnabled()` inside their keydown handler
 * (cheap, always current) or render from `useShortcutsEnabled()`. Modified shortcuts (Cmd+K) and
 * Escape are not covered: they stay on.
 */

export const SHORTCUTS_KEY = "md_shortcuts";
const EVENT = "md:shortcuts";

/** Current value, read fresh each call. Defaults to on (and on the server). */
export function shortcutsEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return localStorage.getItem(SHORTCUTS_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Turn single-key shortcuts on or off for this browser (all tabs follow). */
export function setShortcutsEnabled(on: boolean): void {
  try {
    if (on) localStorage.removeItem(SHORTCUTS_KEY);
    else localStorage.setItem(SHORTCUTS_KEY, "0");
  } catch {
    /* private mode: still applies to this page through the event below */
  }
  memo = on;
  window.dispatchEvent(new Event(EVENT));
}

let memo: boolean | undefined;

function subscribe(cb: () => void) {
  const onStorage = (e: StorageEvent) => {
    if (e.key === SHORTCUTS_KEY || e.key === null) {
      memo = undefined;
      cb();
    }
  };
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", onStorage);
  };
}

function snapshot(): boolean {
  // localStorage can throw in private mode; the memo keeps an in-page toggle working anyway.
  try {
    return localStorage.getItem(SHORTCUTS_KEY) !== "0";
  } catch {
    return memo ?? true;
  }
}

/**
 * `[enabled, setEnabled]`. `enabled` is `undefined` on the server and during hydration (a Switch
 * should render unchecked-and-inert until then rather than guess), then the stored value.
 */
export function useShortcutsEnabled(): [boolean | undefined, (on: boolean) => void] {
  const on = useSyncExternalStore<boolean | undefined>(subscribe, snapshot, () => undefined);
  return [on, setShortcutsEnabled];
}

/**
 * The whole single-key rule (REVAMP_PLAN 7.6 "Keys", WCAG 2.1.4) for a keydown handler: shortcuts
 * are on, no modifier is held, the key isn't already handled, focus is not in a text field
 * (input, textarea, select, contenteditable) and no modal dialog is open.
 *
 *   if (e.key === "f" && singleKeyAllowed(e)) enterFullScreen();
 */
export function singleKeyAllowed(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return false;
  if (!shortcutsEnabled()) return false;
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return false;
  if (typeof document !== "undefined" && document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"]')) return false;
  return true;
}
