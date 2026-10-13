"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";

/**
 * The current query string, read on the client only, without `useSearchParams` (REVAMP_PLAN 4.2:
 * nothing the shell mounts may use it, so static pages stay static and the viewer stays ISR).
 *
 * Next's App Router moves between URLs with history.pushState / replaceState and never fires an
 * event for it, so the first subscriber wraps both once and re-broadcasts a "md:locationchange"
 * event (in a microtask: Next calls pushState from an insertion effect, where React forbids
 * scheduling updates). popstate covers back/forward. The server snapshot is "" and so is the first
 * client render, so hydration never mismatches.
 */
const EVENT = "md:locationchange";
let patched = false;

function patchHistory() {
  if (patched || typeof window === "undefined") return;
  patched = true;
  for (const key of ["pushState", "replaceState"] as const) {
    const original = window.history[key];
    window.history[key] = function (this: History, ...args: Parameters<History["pushState"]>) {
      const result = original.apply(this, args);
      queueMicrotask(() => window.dispatchEvent(new Event(EVENT)));
      return result;
    } as History["pushState"];
  }
}

function subscribe(cb: () => void) {
  patchHistory();
  window.addEventListener(EVENT, cb);
  window.addEventListener("popstate", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("popstate", cb);
  };
}

/** `location.search` ("" on the server and during hydration). */
export function useLocationSearch(): string {
  return useSyncExternalStore(subscribe, () => window.location.search, () => "");
}

/** true after the first client effect: for markup that must match the server HTML first. */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

/** A `next` value is a same-origin path: it must start with one "/" (never "//" or a scheme). */
export function safeNext(path: string | null | undefined): string | null {
  if (!path || !path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return null;
  return path;
}

/**
 * "/login?next=<where you are>". The path comes from usePathname (server-safe) and the query is
 * added after mount. Never points back at the sign-in or auth pages themselves.
 */
export function useSignInHref(): string {
  const pathname = usePathname() || "/";
  const search = useLocationSearch();
  if (/^\/(login|auth)(\/|$)/.test(pathname)) return "/login";
  const next = safeNext(pathname + search);
  return next && next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/login";
}
