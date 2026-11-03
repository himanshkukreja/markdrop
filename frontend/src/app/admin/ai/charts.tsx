"use client";

import { useState } from "react";
import { SeriesTable, TableToggle } from "../analytics/charts";
import { featureColor, n0, usd } from "./common";

/**
 * Daily columns stacked by AI feature: one categorical colour per feature in a fixed order
 * (common.featureColor), a 2px surface gap between segments, a legend that names every feature,
 * per-column hover and keyboard focus with a tooltip, and a table view so nothing is reachable
 * only by hovering. Days are already the admin's local dates ("YYYY-MM-DD").
 */

export interface DayRow { t: string; by_feature: Record<string, number>; requests_by_feature: Record<string, number> }
export interface FeatureRef { key: string; label: string }
export type Metric = "cost" | "requests";

const dayLabel = (t: string, long = false) =>
  new Date(`${t}T00:00:00Z`).toLocaleDateString("en", { timeZone: "UTC", day: "numeric", month: "short", ...(long ? { weekday: "short" } : {}) });

/** An axis label in dollars, as precise as the tick needs ($0.015, $0.03, $2.5). */
const tickUsd = (n: number) => (n === 0 ? "$0" : `$${Number(n.toFixed(n < 0.1 ? 4 : 2))}`);

/** Top of the axis: a "nice" value just above the data (1, 2, 2.5, 5 × 10ⁿ). */
function niceTop(v: number, whole: boolean): number {
  if (v <= 0) return whole ? 4 : 0.01;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const top = m * p;
    if (top >= v && (!whole || Number.isInteger(top / 4))) return top;
  }
  return Math.ceil(v);
}

export function FeatureLegend({ features }: { features: FeatureRef[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-micro text-text-secondary" aria-label="Legend">
      {features.map((f) => (
        <li key={f.key} className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-xs" style={{ background: featureColor(f.key) }} />{f.label}
        </li>
      ))}
    </ul>
  );
}

export function DailyByFeature({ series, features, metric, height = 180 }: {
  series: DayRow[]; features: FeatureRef[]; metric: Metric; height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const val = (d: DayRow, k: string) => (metric === "cost" ? d.by_feature[k] ?? 0 : d.requests_by_feature[k] ?? 0);
  const fmt = (n: number) => (metric === "cost" ? usd(n) : n0(n));
  const totals = series.map((d) => features.reduce((a, f) => a + val(d, f.key), 0));
  const top = niceTop(Math.max(0, ...totals), metric === "requests");
  const ticks = [0, 0.5, 1].map((f) => f * top);
  const every = Math.max(1, Math.ceil(series.length / 7));
  const label = metric === "cost" ? "Spend" : "Requests";
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <FeatureLegend features={features} />
        <TableToggle table={table} onToggle={() => setTable((t) => !t)} />
      </div>
      {table ? (
        <SeriesTable label={[...features.map((f) => f.label), "Total"]}
          rows={series.map((d, i) => ({ period: dayLabel(d.t, true), values: [...features.map((f) => fmt(val(d, f.key))), fmt(totals[i])] }))} />
      ) : (
        <div className="relative pl-12">
          {/* y-axis: recessive hairlines and labels */}
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0" style={{ height }}>
            {ticks.map((t) => (
              <div key={t} className="absolute inset-x-0 flex items-center" style={{ bottom: `${(t / top) * 100}%`, transform: "translateY(50%)" }}>
                <span className="w-11 shrink-0 pr-2 text-right text-micro tabular-nums text-text-muted">{metric === "cost" ? tickUsd(t) : n0(t)}</span>
                <span className="h-px flex-1" style={{ background: "var(--chart-grid)" }} />
              </div>
            ))}
          </div>
          <div className="relative flex items-end gap-[2px]" style={{ height }} onPointerLeave={() => setHover(null)}>
            {series.map((d, i) => {
              const segs = features.map((f) => ({ f, v: val(d, f.key) })).filter((s) => s.v > 0);
              return (
                <div key={d.t} tabIndex={0} role="img" onPointerEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                  aria-label={`${dayLabel(d.t, true)}: ${segs.length ? segs.map((s) => `${s.f.label} ${fmt(s.v)}`).join(", ") : `no ${label.toLowerCase()}`}`}
                  className="md-focus relative flex h-full min-w-0 flex-1 cursor-default flex-col items-center justify-end rounded-xs">
                  <div className="flex w-full max-w-7 flex-col-reverse gap-[2px]" style={{ opacity: hover === null || hover === i ? 1 : 0.5 }}>
                    {segs.map((s, j) => (
                      <div key={s.f.key} className={j === segs.length - 1 ? "rounded-t-[4px]" : ""}
                        style={{ height: Math.max(2, (s.v / top) * (height - 2 * (segs.length - 1))), background: featureColor(s.f.key) }} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-1 flex gap-[2px]" aria-hidden>
            {series.map((d, i) => (
              <div key={d.t} className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-center text-micro text-text-muted">
                {i % every === 0 ? dayLabel(d.t) : ""}
              </div>
            ))}
          </div>
          {hover !== null && series[hover] && (
            <div aria-hidden className="pointer-events-none absolute -top-1 z-10 min-w-44 rounded-lg border border-border-strong bg-surface-raised px-2.5 py-1.5 text-micro shadow-md"
              // Beside the column, never over it; flips to its left past 60% of the width.
              style={hover / Math.max(1, series.length - 1) < 0.6
                ? { left: `calc(3rem + (100% - 3rem) * ${(hover + 1) / series.length} + 8px)` }
                : { right: `calc((100% - 3rem) * ${(series.length - hover) / series.length} + 8px)` }}>
              <p className="mb-1 text-text-secondary">{dayLabel(series[hover].t, true)}</p>
              {features.map((f) => (
                <p key={f.key} className="flex items-center justify-between gap-3 text-text">
                  <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-xs" style={{ background: featureColor(f.key) }} />{f.label}</span>
                  <b className="tabular-nums">{fmt(val(series[hover], f.key))}</b>
                </p>
              ))}
              <p className="mt-1 flex justify-between gap-3 border-t border-border pt-1 text-text"><span>Total</span><b className="tabular-nums">{fmt(totals[hover])}</b></p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A horizontal share bar per feature (cost), labelled with its value: for small breakdowns. */
export function FeatureBars({ rows, format = usd }: { rows: { key: string; label: string; value: number; sub?: string }[]; format?: (n: number) => string }) {
  const max = Math.max(...rows.map((r) => r.value), 0);
  if (!rows.length || max <= 0) return <p className="py-3 text-caption text-text-secondary">Nothing in this range.</p>;
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <li key={r.key} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3 text-caption">
            <span className="inline-flex min-w-0 items-center gap-1.5 truncate text-text">
              <span aria-hidden className="size-2.5 shrink-0 rounded-xs" style={{ background: featureColor(r.key) }} />{r.label}
            </span>
            <span className="shrink-0 tabular-nums text-text"><b>{format(r.value)}</b>{r.sub && <span className="ml-1.5 text-text-muted">{r.sub}</span>}</span>
          </div>
          <div className="h-1.5 w-full rounded-full" style={{ background: "var(--chart-track)" }}>
            <div className="h-full rounded-full" style={{ width: `${(r.value / max) * 100}%`, background: featureColor(r.key) }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
