"use client";

import { useSyncExternalStore } from "react";
import { LIGHT_ENABLED, THEME_COLOR, THEME_KEY, type ResolvedTheme, type ThemeChoice } from "./themeScript";

export { LIGHT_ENABLED, THEME_KEY, themeScript, type ResolvedTheme, type ThemeChoice } from "./themeScript";

/**
 * Theme plumbing (REVAMP_PLAN 5.1–5.3).
 *
 * The choice lives in localStorage `md_theme` = "system" | "light" | "dark" (default "system",
 * decision D1). The resolved theme is written to <html data-theme> (tokens) and the `.dark` class
 * (legacy `dark:` variants) by the inline head script before first paint, and by `setTheme` after.
 *
 * Nothing here may read cookies, headers or search params on the server: `/[slug]` is ISR and its
 * HTML is shared by every visitor, so the theme is always resolved client-side. Nothing here ever
 * reads or writes `location.hash` (it carries E2E keys and tenant tokens).
 */

function readChoice(): ThemeChoice {
  if (!LIGHT_ENABLED) return "dark";
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function systemTheme(): ResolvedTheme {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (!LIGHT_ENABLED) return "dark";
  return choice === "system" ? systemTheme() : choice;
}

function apply(resolved: ResolvedTheme) {
  const d = document.documentElement;
  if (d.getAttribute("data-theme") === resolved) return;
  // One frame without transitions, so 200+ transition-colors elements don't smear across the swap.
  d.classList.add("theme-switching");
  d.setAttribute("data-theme", resolved);
  d.classList.toggle("dark", resolved === "dark");
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
  if (!meta) {
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = THEME_COLOR[resolved];
  requestAnimationFrame(() => requestAnimationFrame(() => d.classList.remove("theme-switching")));
}

const listeners = new Set<() => void>();
function emit() {
  listeners.forEach((l) => l());
}

let wired = false;
function wire() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  // Follow the OS live while the choice is "system".
  matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => {
    if (readChoice() === "system") {
      apply(resolveTheme("system"));
      emit();
    }
  });
  // Keep tabs in step.
  window.addEventListener("storage", (e) => {
    if (e.key !== THEME_KEY) return;
    apply(resolveTheme(readChoice()));
    emit();
  });
}

export function setTheme(choice: ThemeChoice) {
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    /* private mode: still switch for this page */
  }
  apply(resolveTheme(choice));
  emit();
}

function subscribe(cb: () => void) {
  wire();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

type Snapshot = { choice: ThemeChoice; resolved: ResolvedTheme };
let cache: Snapshot | undefined;
function snapshot(): Snapshot {
  const choice = readChoice();
  const resolved = (document.documentElement.getAttribute("data-theme") as ResolvedTheme) || resolveTheme(choice);
  if (!cache || cache.choice !== choice || cache.resolved !== resolved) cache = { choice, resolved };
  return cache;
}

/**
 * The current theme. `undefined` on the server and during hydration, so nothing theme-dependent
 * renders into shared HTML. Components that must render both states (the toggle's sun and moon)
 * render both and let CSS pick by `[data-theme]`.
 */
export function useTheme(): { choice: ThemeChoice | undefined; resolved: ResolvedTheme | undefined; setTheme: typeof setTheme; lightEnabled: boolean } {
  const snap = useSyncExternalStore(subscribe, snapshot, () => undefined);
  return { choice: snap?.choice, resolved: snap?.resolved, setTheme, lightEnabled: LIGHT_ENABLED };
}

/** Reads a CSS custom property from the current theme (charts, Mermaid). Client only. */
export function cssVar(name: string, el: Element = document.documentElement): string {
  return getComputedStyle(el).getPropertyValue(name.startsWith("--") ? name : `--${name}`).trim();
}
