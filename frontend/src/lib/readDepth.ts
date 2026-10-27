"use client";

import { useEffect, useRef } from "react";
import { trackingDisabled } from "@/lib/track";
import { captureThirdParty } from "@/lib/thirdPartyAnalytics";

const API = process.env.NEXT_PUBLIC_API_URL ?? "https://api.markdrop.in";
const IDLE_MS = 60_000;
const REPORT_EVERY_MS = 15_000;

function randomId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * How far a reader got through a document, and for how long they were
 * actually reading — reported to the document's analytics (owners see it in
 * their dashboard; admins across all documents).
 *
 * Depth is the furthest point of the content element the bottom of the
 * viewport has reached, so it works whether the page or a full-screen reader
 * container is the thing scrolling. Time only accrues while the tab is
 * visible *and* the reader has scrolled, moved or typed within the last
 * minute: a tab left open over lunch is not an hour of reading.
 *
 * One reading session = one id; the server keeps the furthest depth and the
 * longest time it has been told, so periodic and final reports never double
 * count.
 */
export function useReadDepth(
  slug: string,
  el: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  /** The document's `read_ticket` (sent as `t`); required for non-public documents (§2.7). */
  ticket?: string | null,
) {
  // Read at send time, so a ticket that arrives (or is refreshed) mid-session is used without
  // starting a new reading session.
  const ticketRef = useRef<string | null>(ticket ?? null);
  ticketRef.current = ticket ?? null;
  useEffect(() => {
    if (!enabled || trackingDisabled()) return;
    const rid = randomId();
    const url = `${API}/api/v1/documents/${encodeURIComponent(slug)}/read`;
    let depth = 0;
    let activeMs = 0;
    let lastActivity = Date.now();
    let lastSent = "";
    let mirrored = false;
    let raf = 0;

    const measure = () => {
      raf = 0;
      const node = el.current;
      if (!node) return;
      const r = node.getBoundingClientRect();
      if (r.height <= 0) return;
      const seen = (window.innerHeight - r.top) / r.height;
      depth = Math.max(depth, Math.max(0, Math.min(100, Math.round(seen * 100))));
    };
    const onActivity = () => {
      lastActivity = Date.now();
      if (!raf) raf = requestAnimationFrame(measure);
    };

    const report = (final: boolean) => {
      const seconds = Math.round(activeMs / 1000);
      if (seconds < 2) return;
      const key = `${depth}:${seconds}`;
      if (key === lastSent) return;
      lastSent = key;
      // Once per reading session, to PostHog/GA: the document is identified by its registered
      // doc_ref there, never by this slug.
      if (final && !mirrored) {
        mirrored = true;
        captureThirdParty("document_read", { depth, seconds });
      }
      // text/plain, no credentials: a CORS "simple" request, so it needs no
      // preflight — which matters when this is the page's last act.
      const t = ticketRef.current;
      const body = JSON.stringify(t ? { rid, depth, seconds, t } : { rid, depth, seconds });
      try {
        if (final && navigator.sendBeacon?.(url, new Blob([body], { type: "text/plain" }))) return;
        void fetch(url, { method: "POST", body, keepalive: true, headers: { "Content-Type": "text/plain" } }).catch(() => {});
      } catch {
        /* analytics must never break reading */
      }
    };

    const tick = setInterval(() => {
      if (document.visibilityState === "visible" && Date.now() - lastActivity < IDLE_MS) activeMs += 1000;
    }, 1000);
    const periodic = setInterval(() => report(false), REPORT_EVERY_MS);
    const onHide = () => { if (document.visibilityState === "hidden") report(true); else lastActivity = Date.now(); };
    const onPageHide = () => report(true);

    document.addEventListener("scroll", onActivity, { capture: true, passive: true });
    window.addEventListener("pointermove", onActivity, { passive: true });
    window.addEventListener("keydown", onActivity);
    window.addEventListener("resize", onActivity);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    // Content (diagrams, maths) settles after first paint; a short document
    // may be read in full without a single scroll.
    measure();
    const settle = setTimeout(measure, 800);

    return () => {
      report(true); // client-side navigation away
      clearInterval(tick);
      clearInterval(periodic);
      clearTimeout(settle);
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("scroll", onActivity, { capture: true });
      window.removeEventListener("pointermove", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("resize", onActivity);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [slug, el, enabled]);

  useReadProgress(el, enabled);
}

// ── read_progress (PostHog only) ─────────────────────────────────────────────

const MARKS = [25, 50, 75, 100] as const;
const ACTIVE_WINDOW_MS = 90_000;
const WORDS_PER_MINUTE = 230;

/**
 * Seconds of actual reading: a second counts only while the tab is visible and the reader did
 * something (scroll, wheel, pointer, key, touch, selection) in the last 90 s, or text-to-speech is
 * speaking. Each tick is capped at 2 s, so a sleeping laptop is never credited.
 */
function startEngagedClock(): { seconds: () => number; stop: () => void } {
  let secs = 0;
  let lastActivity = Date.now();
  let lastTick = Date.now();
  const onActivity = () => {
    lastActivity = Date.now();
  };
  const events = ["scroll", "wheel", "pointermove", "pointerdown", "keydown", "touchstart"] as const;
  for (const e of events) window.addEventListener(e, onActivity, { passive: true, capture: true });
  document.addEventListener("selectionchange", onActivity);
  const id = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(2, (now - lastTick) / 1000);
    lastTick = now;
    const speaking = typeof speechSynthesis !== "undefined" && speechSynthesis.speaking;
    if (document.visibilityState === "visible" && (now - lastActivity < ACTIVE_WINDOW_MS || speaking)) secs += dt;
  }, 1000);
  return {
    seconds: () => Math.round(secs),
    stop: () => {
      clearInterval(id);
      for (const e of events) window.removeEventListener(e, onActivity, { capture: true });
      document.removeEventListener("selectionchange", onActivity);
    },
  };
}

/** Engaged seconds a mark needs: a quarter of the expected reading time up to it, at least 8 s
 *  and at most 2 min per 25%. Scrolling to the end in a second earns nothing. */
export function secondsForMark(mark: number, minutes: number): number {
  const q = mark / 25;
  return Math.min(120 * q, Math.max(8 * q, minutes * 60 * 0.25 * (mark / 100)));
}

/**
 * `read_progress` at 25/50/75/100% of a document, each once per page and in order, only once the
 * reader has spent enough engaged time to have plausibly read that far. Sent to PostHog through
 * lib/thirdPartyAnalytics (consent, redaction and the document's opaque `doc_ref` apply there);
 * the first-party read beacons above are separate and unchanged.
 */
function useReadProgress(el: React.RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    if (!enabled || trackingDisabled()) return;
    const clock = startEngagedClock();
    let next = 0;
    let words = 0;
    let raf = 0;

    const countWords = () => {
      const text = el.current?.textContent ?? "";
      words = text.split(/\s+/).filter(Boolean).length;
    };
    const check = () => {
      raf = 0;
      const node = el.current;
      if (!node || next >= MARKS.length) return;
      const r = node.getBoundingClientRect();
      if (r.height < 50) return;
      const pct = Math.max(0, Math.min(100, ((window.innerHeight - r.top) / r.height) * 100));
      const minutes = Math.max(1, words / WORDS_PER_MINUTE);
      const secs = clock.seconds();
      while (next < MARKS.length) {
        const m = MARKS[next]!;
        if (pct < m || secs < secondsForMark(m, minutes)) break;
        next += 1;
        captureThirdParty("read_progress", { pct: m, engaged_sec: secs, est_minutes: Math.round(minutes) }, { ga: false });
      }
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(check);
    };

    countWords();
    // Diagrams and maths settle after first paint.
    const settle = setTimeout(countWords, 1500);
    const tick = setInterval(check, 2000);
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      clock.stop();
      clearTimeout(settle);
      clearInterval(tick);
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [el, enabled]);
}
