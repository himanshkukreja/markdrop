"use client";

import { num } from "../format";

const DAY = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });

/**
 * A guide's daily views over the last 7 days: one 2 px line in the accent, its last point marked,
 * scaled to its own peak (a flat line on the baseline when there were none). The numbers are in
 * its accessible name and, per day, in the hover title.
 */
export function Sparkline({ values, days, width = 72, height = 22 }: { values: number[]; days?: string[]; width?: number; height?: number }) {
  const pad = 3;
  const max = Math.max(...values, 0);
  const n = values.length;
  const x = (i: number) => (n <= 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (n - 1));
  const y = (v: number) => (max === 0 ? height - pad : height - pad - (v / max) * (height - 2 * pad));
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const label = `Views per day, last ${n} days: ${values.map((v, i) => (days?.[i] ? `${DAY(days[i]!)} ${num(v)}` : num(v))).join(", ")}`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className="shrink-0 overflow-visible">
      <title>{label}</title>
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" opacity={max === 0 ? 0.45 : 1} />
      {n > 0 && <circle cx={x(n - 1)} cy={y(values[n - 1]!)} r={2.5} fill="var(--accent)" stroke="var(--surface-inset)" strokeWidth={1.5} />}
    </svg>
  );
}

export default Sparkline;
