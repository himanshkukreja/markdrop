"use client";

import { useEffect } from "react";
import { trackingDisabled } from "@/lib/track";

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
export function useReadDepth(slug: string, el: React.RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    if (!enabled || trackingDisabled()) return;
    const rid = randomId();
    const url = `${API}/api/v1/documents/${encodeURIComponent(slug)}/read`;
    let depth = 0;
    let activeMs = 0;
    let lastActivity = Date.now();
    let lastSent = "";
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
      // text/plain, no credentials: a CORS "simple" request, so it needs no
      // preflight — which matters when this is the page's last act.
      const body = JSON.stringify({ rid, depth, seconds });
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
}
