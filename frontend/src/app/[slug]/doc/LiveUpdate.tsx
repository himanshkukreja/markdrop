"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { announce, Icon } from "@/components/ui";
import s from "./viewer.module.css";

/** A cheap, stable hash of a block's text (djb2). */
function hash(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return h;
}

function blocksOf(root: HTMLElement | null): HTMLElement[] {
  const prose = root?.querySelector<HTMLElement>(".md-prose");
  return prose ? (Array.from(prose.children) as HTMLElement[]) : [];
}

/**
 * Live update feedback (REVAMP_PLAN 7.6 "Live update"): when the socket brings a new version, an
 * "Updated just now" pill drops in at the top centre, top-level blocks whose text changed get an
 * `accent-soft` highlight that fades over 1.2s (found by index plus a text hash), and "Document
 * updated" is announced politely. Scroll anchoring is the browser's (`overflow-anchor`).
 *
 * `tick` is the hook's `liveUpdate` counter; `content` is what the reader sees.
 */
export function useLiveUpdate(tick: number, content: string, root: RefObject<HTMLElement | null>) {
  const [pill, setPill] = useState(false);
  const snapshot = useRef<number[]>([]);
  const seen = useRef(tick);

  // After every render of new content: highlight what changed on a live update, then snapshot.
  useLayoutEffect(() => {
    const blocks = blocksOf(root.current);
    const next = blocks.map((b) => hash(b.textContent || ""));
    if (tick !== seen.current) {
      seen.current = tick;
      const prev = snapshot.current;
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      blocks.forEach((b, i) => {
        if (prev[i] === next[i]) return;
        b.classList.remove(s.changed);
        // Restart the fade if the same block changes twice in a row.
        void b.offsetWidth;
        b.classList.add(s.changed);
        if (reduced) b.classList.add(s.changedStatic);
        window.setTimeout(() => b.classList.remove(s.changed, s.changedStatic), 1400);
      });
    }
    snapshot.current = next;
  }, [content, tick, root]);

  useEffect(() => {
    if (!tick) return;
    setPill(true);
    announce("Document updated");
    const t = window.setTimeout(() => setPill(false), 4000);
    return () => window.clearTimeout(t);
  }, [tick]);

  return pill;
}

export function LiveUpdatePill({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div className={`no-print ${s.pill}`} aria-hidden>
      <Icon name="refresh" />
      Updated just now
    </div>
  );
}
