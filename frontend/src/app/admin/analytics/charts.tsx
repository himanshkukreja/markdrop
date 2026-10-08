"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Chart primitives for the analytics tab, drawn in plain SVG.
 *
 * Specs (dataviz method): one hue — slot 1 blue, validated against the admin
 * card surface — 2px line, ~10% area wash, hairline solid grid, an X crosshair
 * that snaps to the nearest bucket with a tooltip on hover *and* keyboard
 * focus, and a table view so no value is reachable only by hovering.
 */

export const ACCENT = "#3987e5";
const GRID = "#1f2937";
const MUTED = "#898781";

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString();
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

/** Single-series trend: line + wash, crosshair tooltip, optional table view. */
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
    else return;
    e.preventDefault();
  }

  const h = hover !== null ? points[hover] : null;
  return (
    <div>
      <div className="flex justify-end -mt-1 mb-1">
        <button onClick={() => setTable((t) => !t)} className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors">
          {table ? "Show chart" : "Show table"}
        </button>
      </div>
      {table ? (
        <div className="max-h-[220px] overflow-y-auto rounded-lg border border-gray-800">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-950"><tr className="text-gray-500"><th className="text-left font-medium px-3 py-1.5">Period</th><th className="text-right font-medium px-3 py-1.5">{label}</th></tr></thead>
            <tbody className="tabular-nums">
              {points.map((p) => (
                <tr key={p.t} className="border-t border-gray-800/70"><td className="px-3 py-1 text-gray-400">{bucketLabel(p.t, unit, tz, true)}</td><td className="px-3 py-1 text-right text-gray-200">{format(p.v)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={ref} className="relative" style={{ height }}>
          {width > 0 && (
            <svg width={width} height={height} role="img" aria-label={`${label} over time`} tabIndex={0}
              onPointerMove={onMove} onPointerLeave={() => setHover(null)} onKeyDown={onKey} onBlur={() => setHover(null)}
              className="outline-none focus-visible:ring-1 focus-visible:ring-blue-500/50 rounded">
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
                  <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={10} fill={MUTED} className="tabular-nums">{compact(t)}</text>
                </g>
              ))}
              {points.map((p, i) => (i % every === 0 || i === points.length - 1) && (
                <text key={p.t} x={x(i)} y={height - 8} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"} fontSize={10} fill={MUTED}>
                  {bucketLabel(p.t, unit, tz)}
                </text>
              ))}
              <path d={area} fill={ACCENT} opacity={0.1} />
              <path d={line} fill="none" stroke={ACCENT} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {h && (
                <g pointerEvents="none">
                  <line x1={x(hover!)} x2={x(hover!)} y1={pad.t} y2={pad.t + plotH} stroke="#4b5563" strokeWidth={1} />
                  <circle cx={x(hover!)} cy={y(h.v)} r={4.5} fill={ACCENT} stroke="#0b1120" strokeWidth={2} />
                </g>
              )}
            </svg>
          )}
          {h && (
            <div className="pointer-events-none absolute top-1 z-10 w-40 rounded-lg border border-gray-700 bg-gray-950/95 px-2.5 py-1.5 shadow-lg"
              // Beside the crosshair, never on top of the point it describes;
              // flips to the left side near the right edge.
              style={x(hover!) + 172 < width ? { left: x(hover!) + 12 } : { left: Math.max(0, x(hover!) - 172) }}>
              <p className="text-sm font-semibold text-gray-50">{format(h.v)}</p>
              <p className="flex items-center gap-1.5 text-[11px] text-gray-400">
                <span className="inline-block w-3 h-0.5 rounded" style={{ background: ACCENT }} />
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
      <path d={d} fill="none" stroke={ACCENT} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Ordinal blue ramp (validated --ordinal against #0b1120), light → dark. */
export const FUNNEL_RAMP = ["#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#1c5cab", "#184f95"];

/** Sequential blue for the retention heatmap: near-zero recedes into the surface. */
export function heat(pct: number): { bg: string; fg: string } {
  const steps = ["#0f1b30", "#0d366b", "#104281", "#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5", "#5598e7", "#86b6ef"];
  const i = Math.min(steps.length - 1, Math.floor((pct / 100) * steps.length));
  return { bg: steps[i], fg: i >= 8 ? "#0b0b0b" : "#ffffff" };
}
