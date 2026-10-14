"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One autoplaying sequence at a time (REVAMP_BUILD §5.H.7, the amended REVAMP §6.2 rule 8).
 *
 * A module-level registry, so every island's Game can use it without a provider in the server page.
 * Each island registers the element whose visibility matters (the hero section, a toy's stage) and
 * whether it currently wants to run an attract/demo loop. The coordinator grants "attract" to at most
 * ONE island: the one that wants it with the largest visible ratio ≥ 0.5 (ties: the one nearer the
 * viewport centre). A hidden tab grants nothing. Islands that are not granted stay frozen on their
 * current frame (the poster frame until they first play).
 *
 * Visible ratio = visible height / min(element height, viewport height), so a stage taller than the
 * screen still counts as "fully visible" when it fills the viewport.
 *
 * An explicit Play press calls `claim()`: that island keeps the grant while any of it is on screen and
 * it still wants it, so pressing Play always plays.
 *
 * Dev only: every grant change is logged with console.debug("[play] …"), and `window.__mdPlay`
 * exposes { grant, running } so the M7 gate can check that exactly one loop runs at any moment.
 */

type Entry = {
  id: string;
  el: () => Element | null;
  wants: boolean;
  notify: (granted: boolean) => void;
};

const entries = new Map<string, Entry>();
const running = new Set<string>();
let grant: string | null = null;
let pinned: string | null = null;
let raf = 0;
let listening = false;
const DEV = process.env.NODE_ENV !== "production";

function ratioOf(el: Element | null, vh: number): { r: number; d: number } {
  if (!el) return { r: 0, d: Infinity };
  const b = el.getBoundingClientRect();
  if (!b.height || !b.width) return { r: 0, d: Infinity };
  const vis = Math.max(0, Math.min(b.bottom, vh) - Math.max(b.top, 0));
  return { r: vis / Math.min(b.height, vh), d: Math.abs((b.top + b.bottom) / 2 - vh / 2) };
}

function debug() {
  if (!DEV || typeof window === "undefined") return;
  (window as unknown as { __mdPlay?: unknown }).__mdPlay = { grant, running: [...running] };
}

function compute() {
  raf = 0;
  if (typeof document === "undefined") return;
  let next: string | null = null;
  if (document.visibilityState !== "hidden") {
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const pin = pinned ? entries.get(pinned) : undefined;
    if (pin && pin.wants && ratioOf(pin.el(), vh).r > 0) next = pin.id;
    else {
      pinned = null;
      let best = { r: 0, d: Infinity };
      for (const e of entries.values()) {
        if (!e.wants) continue;
        const m = ratioOf(e.el(), vh);
        if (m.r < 0.5) continue;
        if (m.r > best.r + 0.001 || (Math.abs(m.r - best.r) <= 0.001 && m.d < best.d)) {
          best = m;
          next = e.id;
        }
      }
    }
  }
  if (next === grant) return;
  const prev = grant;
  grant = next;
  if (DEV) console.debug("[play] grant", next ?? "none", prev ? `(was ${prev})` : "");
  if (prev) entries.get(prev)?.notify(false);
  if (next) entries.get(next)?.notify(true);
  debug();
}

function schedule() {
  if (raf || typeof window === "undefined") return;
  raf = window.requestAnimationFrame(compute);
}

function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  document.addEventListener("visibilitychange", () => {
    // Hidden: stop at once (rAF does not run in hidden tabs).
    if (document.visibilityState === "hidden") compute();
    else schedule();
  });
}

/**
 * Ask the coordinator whether this island may run its attract/demo loop.
 *
 * @param id     unique island id (e.g. "hero", "key-lab")
 * @param el     the element whose visibility decides (called lazily on every check)
 * @param wants  whether the island has an attract/demo loop it would run right now
 * @returns      [granted, claim]: claim() pins the grant here after an explicit Play press
 */
export function usePlayGrant(id: string, el: () => Element | null, wants: boolean): [boolean, () => void] {
  const [granted, setGranted] = useState(false);
  const elRef = useRef(el);
  elRef.current = el;

  useEffect(() => {
    listen();
    entries.set(id, { id, el: () => elRef.current(), wants: false, notify: setGranted });
    return () => {
      entries.delete(id);
      running.delete(id);
      if (pinned === id) pinned = null;
      if (grant === id) grant = null;
      debug();
      schedule();
    };
  }, [id]);

  useEffect(() => {
    const e = entries.get(id);
    if (!e) return;
    e.wants = wants;
    if (!wants && pinned === id) pinned = null;
    // Synchronous on a change of intent, so a loop that ends hands over in the same frame.
    compute();
  }, [id, wants]);

  const claim = useCallback(() => {
    pinned = id;
    // The island's `wants` flips true on the same press; compute after React applies it.
    schedule();
  }, [id]);

  return [granted, claim];
}

/** Dev bookkeeping: report whether this island's loop interval is actually running. */
export function useLoopReport(id: string, on: boolean) {
  useEffect(() => {
    if (!DEV) return;
    if (on) running.add(id);
    else running.delete(id);
    if (running.size > 1) console.warn("[play] more than one loop running:", [...running]);
    debug();
    return () => {
      running.delete(id);
      debug();
    };
  }, [id, on]);
}
