"use client";

import { useSyncExternalStore } from "react";
import { BETA_KEY, LIGHT_ENABLED, THEME_COLOR, THEME_KEY, type ResolvedTheme, type ThemeChoice } from "./themeScript";

export { BETA_KEY, LIGHT_ENABLED, THEME_KEY, themeScript, type ResolvedTheme, type ThemeChoice } from "./themeScript";

/**
 * Theme plumbing (REVAMP_PLAN 5.1–5.3).
 *
 * The choice lives in localStorage `md_theme` = "system" | "light" | "dark". Nothing stored means
 * light (the default since 2026-10-28; it was "system", decision D1), so "system" is stored explicitly. The resolved theme is written to <html data-theme> (tokens) and the `.dark` class
 * (legacy `dark:` variants) by the inline head script before first paint, and by `setTheme` after.
 *
 * Nothing here may read cookies, headers or search params on the server: `/[slug]` is ISR and its
 * HTML is shared by every visitor, so the theme is always resolved client-side. Nothing here ever
 * reads or writes `location.hash` (it carries E2E keys and tenant tokens).
 */

/** Light is available when the build launched it or this browser joined the beta. */
export function lightAvailable(): boolean {
  if (LIGHT_ENABLED) return true;
  try {
    return localStorage.getItem(BETA_KEY) === "1";
  } catch {
    return false;
  }
}

function readChoice(): ThemeChoice {
  if (!lightAvailable()) return "dark";
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "light";
  } catch {
    return "light";
  }
}

function systemTheme(): ResolvedTheme {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (!lightAvailable()) return "dark";
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
    if (e.key !== THEME_KEY && e.key !== BETA_KEY) return;
    apply(resolveTheme(readChoice()));
    emit();
  });
}

export function setTheme(choice: ThemeChoice) {
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    /* private mode: still switch for this page */
  }
  apply(resolveTheme(choice));
  emit();
}

/** Join or leave the light-theme beta in this browser (the /settings/account switch). */
export function setLightBeta(on: boolean) {
  try {
    if (on) localStorage.setItem(BETA_KEY, "1");
    else localStorage.removeItem(BETA_KEY);
  } catch {
    /* private mode */
  }
  apply(resolveTheme(readChoice()));
  emit();
}

function subscribe(cb: () => void) {
  wire();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

type Snapshot = { choice: ThemeChoice; resolved: ResolvedTheme; available: boolean; beta: boolean };
let cache: Snapshot | undefined;
function snapshot(): Snapshot {
  const choice = readChoice();
  const resolved = (document.documentElement.getAttribute("data-theme") as ResolvedTheme) || resolveTheme(choice);
  const available = lightAvailable();
  let beta = false;
  try {
    beta = localStorage.getItem(BETA_KEY) === "1";
  } catch {}
  if (!cache || cache.choice !== choice || cache.resolved !== resolved || cache.available !== available || cache.beta !== beta)
    cache = { choice, resolved, available, beta };
  return cache;
}

/**
 * The current theme. `undefined` on the server and during hydration, so nothing theme-dependent
 * renders into shared HTML. Components that must render both states (the toggle's sun and moon)
 * render both and let CSS pick by `[data-theme]`.
 */
export function useTheme(): {
  choice: ThemeChoice | undefined;
  resolved: ResolvedTheme | undefined;
  setTheme: typeof setTheme;
  /** Light can be chosen here: launched (NEXT_PUBLIC_LIGHT_THEME=true) or this browser is in the beta. */
  lightEnabled: boolean;
  /** This browser joined the light beta (only meaningful while light isn't launched). */
  lightBeta: boolean;
  /** The build launched light for everyone. */
  lightLaunched: boolean;
  setLightBeta: typeof setLightBeta;
} {
  const snap = useSyncExternalStore(subscribe, snapshot, () => undefined);
  return {
    choice: snap?.choice,
    resolved: snap?.resolved,
    setTheme,
    lightEnabled: snap?.available ?? LIGHT_ENABLED,
    lightBeta: snap?.beta ?? false,
    lightLaunched: LIGHT_ENABLED,
    setLightBeta,
  };
}

/** Reads a CSS custom property from the current theme (charts, Mermaid). Client only. */
export function cssVar(name: string, el: Element = document.documentElement): string {
  return getComputedStyle(el).getPropertyValue(name.startsWith("--") ? name : `--${name}`).trim();
}
