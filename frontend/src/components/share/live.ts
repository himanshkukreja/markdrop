"use client";

/**
 * Small client helpers shared by the send (/share) and receive (/share/[id]) pages.
 * Pure UI: they only read the public snapshots of lib/p2p (never touch the transport).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DeviceKind } from "@/components/kit/DeviceGlyph";

/** "iPhone · Safari" → phone; "iPad · Safari" → tablet; anything else is a computer. */
export function deviceKindOf(label: string | null | undefined): DeviceKind {
  const l = label ?? "";
  if (/iPhone|Android phone/.test(l)) return "phone";
  if (/iPad|tablet/.test(l)) return "tablet";
  return "laptop";
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "about 40 s left" / "about 3 min left" / "about 1 h left". Coarse on purpose. */
export function etaText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 10) return "a few seconds left";
  if (seconds < 60) return `about ${Math.round(seconds / 5) * 5} s left`;
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} min left`;
  return `about ${Math.round(seconds / 360) / 10} h left`;
}

/** D28: above this total, phones (iOS above all) struggle to hold everything at once. */
export const PHONE_LARGE_BYTES = 400 * 1024 * 1024;

/**
 * Apply library snapshots at most ~twice a second (REVAMP §6.2 rule 5: rate and ETA update at most
 * twice a second), except when `urgent(prev, next)` says something structural changed (a status, a
 * person joining, a file finishing), which renders at once. The library itself keeps ticking at 5Hz;
 * this only decides when React re-renders.
 */
export function useSnapshotState<T>(initial: T, urgent: (prev: T, next: T) => boolean, minMs = 450) {
  const [snap, setSnap] = useState<T>(initial);
  const shown = useRef<T>(initial);
  const latest = useRef<T>(initial);
  const lastAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const urgentRef = useRef(urgent);
  urgentRef.current = urgent;

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    lastAt.current = Date.now();
    shown.current = latest.current;
    setSnap(latest.current);
  }, []);

  const push = useCallback((next: T) => {
    latest.current = next;
    const wait = minMs - (Date.now() - lastAt.current);
    if (wait <= 0 || urgentRef.current(shown.current, next)) flush();
    else if (!timer.current) timer.current = setTimeout(flush, wait);
  }, [flush, minMs]);

  /** Replace the snapshot immediately (a reset, a new share). */
  const reset = useCallback((next: T) => {
    latest.current = next;
    flush();
  }, [flush]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return [snap, push, reset] as const;
}

interface Track { bytes: number; rose: number; rateSince: number | null }

/**
 * Which transfers are really moving. A packet may only travel while that peer's byte count rises
 * (§6.2 "animate only what is true"): `active` is true for 3 s after the last rise, then the path
 * parks ("stalled"). `etaReady` is true once the rate has been non-zero for 3 s straight, so an ETA
 * never flickers in from a single sample. While `ticking`, a 1 s clock re-renders so a stall is
 * noticed even when the library stops emitting (it only emits on change).
 */
export function useActivity(samples: Array<{ id: string; bytes: number; rate: number }>, ticking: boolean) {
  const mem = useRef(new Map<string, Track>());
  const [, setTick] = useState(0);
  const now = Date.now();
  for (const s of samples) {
    const m = mem.current.get(s.id);
    if (!m) {
      mem.current.set(s.id, { bytes: s.bytes, rose: s.bytes > 0 ? now : 0, rateSince: s.rate > 0 ? now : null });
      continue;
    }
    if (s.bytes > m.bytes) { m.bytes = s.bytes; m.rose = now; }
    else if (s.bytes < m.bytes) m.bytes = s.bytes; // a new batch started from zero
    if (s.rate > 0) { if (m.rateSince === null) m.rateSince = now; }
    else m.rateSince = null;
  }
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  return (id: string) => {
    const m = mem.current.get(id);
    return {
      active: !!m && m.rose > 0 && now - m.rose < 3000,
      stalled: !!m && m.rose > 0 && now - m.rose >= 3000,
      etaReady: !!m && m.rateSince !== null && now - m.rateSince >= 3000,
    };
  };
}

const reducedQuery = "(prefers-reduced-motion: reduce)";
function subscribeReduced(cb: () => void) {
  const mq = window.matchMedia(reducedQuery);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
/** True under prefers-reduced-motion (false on the server). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, () => window.matchMedia(reducedQuery).matches, () => false);
}

const phoneQuery = "(max-width: 639.98px)";
function subscribePhone(cb: () => void) {
  const mq = window.matchMedia(phoneQuery);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
/** True below 640px (false on the server), for choosing a bottom sheet over a dialog. */
export function usePhone(): boolean {
  return useSyncExternalStore(subscribePhone, () => window.matchMedia(phoneQuery).matches, () => false);
}

/** Width of an element, tracked with ResizeObserver (`fallback` before mount). */
export function useWidth<E extends HTMLElement>(fallback: number) {
  const ref = useRef<E | null>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    setW(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}
