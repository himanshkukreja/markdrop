"use client";

import { useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";
import { viewerColor } from "@/lib/presence";
import s from "./presence.module.css";

export interface SectionMarker { color: number; name: string; away: boolean }

/**
 * Where other people are reading, in the reading column's margin: a small coloured dot beside each
 * heading someone is in (used when there's no Contents rail on screen). Absolutely placed inside
 * `root`, which must be `position: relative`. Decorative: the presence list says the same in words.
 */
export function PresenceMargin({
  root, markers, left = -14,
}: {
  root: RefObject<HTMLElement | null>;
  markers: Record<string, SectionMarker[]>;
  /** px from the column's left edge (negative: into the page gutter). */
  left?: number;
}) {
  const [tops, setTops] = useState<Record<string, number>>({});
  const key = Object.keys(markers).sort().join("\n");

  const measure = () => {
    const box = root.current;
    if (!box) return;
    const base = box.getBoundingClientRect().top;
    const next: Record<string, number> = {};
    for (const id of key ? key.split("\n") : []) {
      const el = document.getElementById(id);
      if (!el || !box.contains(el)) continue;
      const r = el.getBoundingClientRect();
      next[id] = Math.round(r.top - base + Math.min(r.height, 28) / 2 - 4);
    }
    setTops(next);
  };

  useLayoutEffect(measure, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const box = root.current;
    if (!box || !key) return;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => measure()) : null;
    ro?.observe(box);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const ids = Object.keys(markers).filter((id) => tops[id] != null);
  if (!ids.length) return null;
  return (
    <div className={`no-print ph-no-capture ${s.margin}`} aria-hidden>
      {ids.map((id) => (
        <span key={id} className={s.marker} style={{ top: tops[id], left }}>
          {markers[id]!.slice(0, 3).map((m, i) => (
            <span key={i} className={`${s.dot} ${m.away ? s.dotAway : ""}`} style={{ "--pc": viewerColor(m.color) } as CSSProperties} />
          ))}
        </span>
      ))}
    </div>
  );
}
