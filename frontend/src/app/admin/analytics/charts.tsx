"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui";

/**
 * Chart primitives for the admin analytics, drawn in plain SVG.
 *
 * Colours are the design-system `chart-*` tokens, read from CSS variables at render (style values,
 * so they resolve inside the admin's dark ThemeScope). One hue for single series, a 2px line, a
 * wash, hairline grid, an X crosshair that snaps to the nearest bucket with a tooltip on hover
 * *and* keyboard focus, and a mandatory "Show table" so no value is reachable only by hovering.
 */

export const C = {
  series: "var(--chart-1)",
  other: "var(--chart-other)",
  grid: "var(--chart-grid)",
  axis: "var(--chart-axis)",
  crosshair: "var(--chart-crosshair)",
  wash: "var(--chart-wash)",
  track: "var(--chart-track)",
  surface: "var(--surface)",
} as const;

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString("en");
}

/** Top of the y-axis: four equal whole-number steps, the smallest "nice" step
 *  (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10ⁿ) that clears the data — so ticks
 *  are whole counts and the line uses most of the plot height. */
function niceMax(v: number): number {
  if (v <= 4) return 4;
  const raw = v / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const step = m * p;
    if (step >= raw && Number.isInteger(step)) return step * 4;
  }
  return Math.ceil(raw) * 4;
}

export function bucketLabel(iso: string, unit: string, tz: string, long = false): string {
  const d = new Date(iso);
  if (unit === "minute") {
    return d.toLocaleString("en", { timeZone: tz, hour: "numeric", minute: "2-digit", ...(long ? { day: "numeric", month: "short" } : {}) });
  }
  if (unit === "hour") {
    return d.toLocaleString("en", { timeZone: tz, hour: "numeric", ...(long ? { weekday: "short", day: "numeric", month: "short" } : {}) });
  }
  const base = d.toLocaleDateString("en", { timeZone: tz, day: "numeric", month: "short", ...(long ? { year: "numeric" } : {}) });
  return unit === "week" && long ? `Week of ${base}` : base;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export interface Point { t: string; v: number }

/** A "Show table" / "Show chart" toggle, used by every chart. */
export function TableToggle({ table, onToggle }: { table: boolean; onToggle: () => void }) {
  return (
    <Button size="sm" variant="ghost" iconLeft={table ? "chart" : "table"} aria-pressed={table} onClick={onToggle}>
      {table ? "Show chart" : "Show table"}
    </Button>
  );
}

/** The table view of a series: period + value, on the card's own scroll (no nested scroller). */
export function SeriesTable({ rows, label }: { rows: { period: string; values: string[] }[]; label: string[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-caption">
        <thead className="bg-surface-inset text-text-secondary">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-medium">Period</th>
            {label.map((l) => <th key={l} scope="col" className="px-3 py-2 text-right font-medium">{l}</th>)}
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((r) => (
            <tr key={r.period} className="border-t border-border">
              <td className="px-3 py-1.5 text-text-secondary">{r.period}</td>
              {r.values.map((v, i) => <td key={i} className="px-3 py-1.5 text-right text-text">{v}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Single-series trend: line + wash, crosshair tooltip, and a table view. */
export function TrendChart({
  points, unit, tz, label, height = 220, format = compact,
}: {
  points: Point[]; unit: string; tz: string; label: string; height?: number; format?: (n: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const pad = { l: 40, r: 12, t: 12, b: 26 };
  const plotW = Math.max(0, width - pad.l - pad.r);
  const plotH = height - pad.t - pad.b;
  const max = niceMax(Math.max(0, ...points.map((p) => p.v)));
  const x = (i: number) => pad.l + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => pad.t + plotH - (v / max) * plotH;
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const area = points.length ? `${line}L${x(points.length - 1)},${pad.t + plotH}L${x(0)},${pad.t + plotH}Z` : "";
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  // ~6 x labels regardless of bucket count
  const every = Math.max(1, Math.ceil(points.length / 6));

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const px = e.clientX - r.left - pad.l;
    const i = Math.round((px / Math.max(1, plotW)) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  }
  function onKey(e: React.KeyboardEvent) {
    if (!points.length) return;
    if (e.key === "ArrowRight") setHover((h) => Math.min(points.length - 1, (h ?? -1) + 1));
    else if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? points.length) - 1));
    else if (e.key === "Home") setHover(0);
    else if (e.key === "End") setHover(points.length - 1);
    else return;
    e.preventDefault();
  }

  const h = hover !== null ? points[hover] : null;
  return (
    <div>
      <div className="-mt-1 mb-1 flex justify-end">
        <TableToggle table={table} onToggle={() => setTable((t) => !t)} />
      </div>
      {table ? (
        <SeriesTable label={[label]} rows={points.map((p) => ({ period: bucketLabel(p.t, unit, tz, true), values: [format(p.v)] }))} />
      ) : (
        <div ref={ref} className="relative" style={{ height }}>
          {width > 0 && (
            <svg width={width} height={height} role="img" aria-label={`${label} over time. Use the arrow keys to read each period, or Show table.`} tabIndex={0}
              onPointerMove={onMove} onPointerLeave={() => setHover(null)} onKeyDown={onKey} onBlur={() => setHover(null)}
              className="md-focus rounded-sm">
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} style={{ stroke: C.grid }} strokeWidth={1} />
                  <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} style={{ fill: C.axis }} className="tabular-nums">{compact(t)}</text>
                </g>
              ))}
              {points.map((p, i) => (i % every === 0 || i === points.length - 1) && (
                <text key={p.t} x={x(i)} y={height - 8} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"} fontSize={11} style={{ fill: C.axis }}>
                  {bucketLabel(p.t, unit, tz)}
                </text>
              ))}
              <path d={area} style={{ fill: C.wash }} />
              <path d={line} fill="none" style={{ stroke: C.series }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {h && (
                <g pointerEvents="none">
                  <line x1={x(hover!)} x2={x(hover!)} y1={pad.t} y2={pad.t + plotH} style={{ stroke: C.crosshair }} strokeWidth={1} />
                  <circle cx={x(hover!)} cy={y(h.v)} r={4.5} style={{ fill: C.series, stroke: C.surface }} strokeWidth={2} />
                </g>
              )}
            </svg>
          )}
          {h && (
            <div role="status" className="pointer-events-none absolute top-1 w-44 rounded-lg border border-border-strong bg-surface-raised px-2.5 py-1.5 shadow-md"
              // Beside the crosshair, never on top of the point it describes;
              // flips to the left side near the right edge.
              style={x(hover!) + 188 < width ? { left: x(hover!) + 12 } : { left: Math.max(0, x(hover!) - 188) }}>
              <p className="text-body-strong tabular-nums text-text">{format(h.v)}</p>
              <p className="flex items-center gap-1.5 text-micro text-text-secondary">
                <span aria-hidden className="inline-block h-0.5 w-3 rounded-sm" style={{ background: C.series }} />
                {label} · {bucketLabel(h.t, unit, tz, true)}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A 2px trend line for stat tiles. Decorative next to its number, so aria-hidden. */
export function Sparkline({ values, width = 120, height = 28 }: { values: number[]; width?: number; height?: number }) {
  const d = useMemo(() => {
    if (values.length < 2) return "";
    const max = Math.max(1, ...values);
    return values.map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * (width - 4) + 2).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`).join("");
  }, [values, width, height]);
  return (
    <svg width={width} height={height} aria-hidden className="overflow-visible">
      <path d={d} fill="none" style={{ stroke: C.series }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Sequential steps for the retention heatmap (`chart-seq-1` lowest … `chart-seq-5` highest).
 * Ink is chosen per step for AA in the admin's dark scope (seq-1 is a deep blue, 2–5 are light).
 * Step 1 is ~2.6:1 against `surface`, so its cells carry a hairline outline.
 */
export function heat(pct: number): { bg: string; fg: string; step: number } {
  const step = Math.min(5, Math.max(1, Math.ceil((pct / 100) * 5)));
  return { bg: `var(--chart-seq-${step})`, fg: step === 1 ? "var(--text)" : "var(--bg)", step };
}
