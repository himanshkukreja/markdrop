"use client";

/**
 * Hand-written SVG charts for creator analytics. Rules (dataviz skill + the boards): one series
 * colour (--chart-1, a second series --chart-2 dashed), thin marks, one y-axis, text in text
 * tokens, a crosshair or per-mark tooltip on hover AND keyboard focus (arrow keys, Home/End), and
 * every chart has role="img", a summary aria-label and a visually hidden data table. Charts draw at
 * their measured pixel width, so text never stretches.
 */
import { useEffect, useId, useRef, useState } from "react";
import { cx } from "@/components/ui";
import { clock, day, longDay, num, pct } from "./format";

const SERIES = "var(--chart-1)";
const SERIES_2 = "var(--chart-2)";
const SOFT = "color-mix(in srgb, var(--chart-1) 55%, transparent)";
const GRID = "var(--chart-grid)";
const AXIS = "var(--chart-axis)";
const CROSS = "var(--chart-crosshair)";

/* ── Shared bits ──────────────────────────────────────────────────────── */

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(Math.floor(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Hover / keyboard scrubbing over n positions. */
function useScrub(n: number) {
  const [i, setI] = useState<number | null>(null);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!n) return;
    const step = e.shiftKey ? Math.max(1, Math.round(n / 10)) : 1;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const dir = e.key === "ArrowRight" ? 1 : -1;
      setI((c) => Math.max(0, Math.min(n - 1, (c ?? (dir > 0 ? -1 : n)) + dir * step)));
    } else if (e.key === "Home") { e.preventDefault(); setI(0); }
    else if (e.key === "End") { e.preventDefault(); setI(n - 1); }
    else if (e.key === "Escape") setI(null);
  };
  return { i, setI, onKeyDown, clear: () => setI(null) };
}

/** Top of the y-axis: a "nice" round number that clears the data. */
export function niceMax(v: number): number {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return Math.ceil(v);
}

function Tip({ x, width, children }: { x: number; width: number; children: React.ReactNode }) {
  const align = x > width * 0.7 ? "-100%" : x < width * 0.3 ? "0%" : "-50%";
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute top-0 z-10 rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-caption whitespace-nowrap text-text shadow-lg"
      style={{ left: x, transform: `translate(${align}, 0)` }}
    >
      {children}
    </div>
  );
}

function HiddenTable({ caption, head, rows }: { caption: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="md-visually-hidden">
      <caption>{caption}</caption>
      <thead><tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => (j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j}>{c}</td>))}</tr>)}</tbody>
    </table>
  );
}

function Live({ text }: { text: string }) {
  return <span className="md-visually-hidden" aria-live="polite">{text}</span>;
}

const svgFocus = "block touch-pan-y overflow-visible rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--border-focus)";

/* ── Views per day ────────────────────────────────────────────────────── */

export function fillDays<T extends { date: string }>(rows: T[], range: string, blank: (date: string) => T): T[] {
  const DAY = 86400000;
  const by = new Map(rows.map((r) => [r.date.slice(0, 10), r]));
  const todayT = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const lastT = rows.length ? Math.max(todayT, Date.parse(rows[rows.length - 1]!.date.slice(0, 10) + "T00:00:00Z")) : todayT;
  let first: number;
  if (range === "all") {
    if (!rows.length) return [];
    first = Math.max(Date.parse(rows[0]!.date.slice(0, 10) + "T00:00:00Z"), lastT - 365 * DAY);
  } else {
    first = lastT - ((range === "7d" ? 7 : range === "90d" ? 90 : 30) - 1) * DAY;
  }
  const out: T[] = [];
  for (let t = first; t <= lastT; t += DAY) {
    const d = new Date(t).toISOString().slice(0, 10);
    out.push(by.get(d) ?? blank(d));
  }
  return out;
}

export function DailyViewsChart({ daily, marks, height = 180 }: {
  daily: { date: string; views: number; people: number }[];
  marks: { date: string; version: number }[];
  height?: number;
}) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const n = daily.length;
  const scrub = useScrub(n);
  const titleId = useId();
  const PADT = 14, PADB = 4, PADR = 0;
  const plotH = height - PADT - PADB;
  const peak = daily.reduce((b, d, i) => (d.views > daily[b]!.views ? i : b), 0);
  const max = niceMax(Math.max(1, daily[peak]?.views ?? 0));
  const slot = n ? (W - PADR) / n : 0;
  const bw = Math.max(1, Math.min(24, slot * 0.78));
  const x = (i: number) => i * slot + (slot - bw) / 2;
  const y = (v: number) => PADT + plotH - (v / max) * plotH;
  const markBy = new Map(marks.map((m) => [m.date.slice(0, 10), m.version]));
  const total = daily.reduce((a, d) => a + d.views, 0);
  const summary = n
    ? `Views per day: ${num(total)} in total, highest on ${day(daily[peak]!.date)} with ${num(daily[peak]!.views)}.`
    : "No views in this period.";
  const h = scrub.i;
  const active = h ?? peak;

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    if (!n || !slot) return;
    scrub.setI(Math.max(0, Math.min(n - 1, Math.floor((e.clientX - r.left) / slot))));
  }

  return (
    <figure className="m-0 flex flex-col gap-1.5">
      <div ref={ref} className="relative" style={{ height }}>
        {W > 0 && (
          <svg
            width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="img" aria-labelledby={titleId} tabIndex={0}
            className={svgFocus} onPointerMove={onMove} onPointerLeave={scrub.clear} onBlur={scrub.clear} onKeyDown={scrub.onKeyDown}
          >
            <title id={titleId}>{summary} Use the arrow keys to read each day.</title>
            <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke={GRID} />
            <line x1={0} x2={W} y1={y(max / 2)} y2={y(max / 2)} stroke={GRID} strokeDasharray="2 4" />
            <text x={W - 2} y={y(max / 2) - 4} textAnchor="end" fontSize={11} fill={AXIS}>{num(max / 2)}</text>
            {daily.map((d, i) => {
              const top = y(d.views);
              const bh = Math.max(d.views > 0 ? 2 : 0, y(0) - top);
              return <rect key={d.date} x={x(i)} y={y(0) - bh} width={bw} height={bh} rx={Math.min(2, bw / 2)} fill={i === active ? SERIES : SOFT} />;
            })}
            {daily.map((d, i) => {
              const v = markBy.get(d.date.slice(0, 10));
              if (v == null) return null;
              const cx = x(i) + bw / 2;
              return (
                <g key={`m${d.date}`} aria-hidden>
                  <line x1={cx} x2={cx} y1={PADT - 2} y2={y(0)} stroke={CROSS} strokeDasharray="3 3" />
                  <text x={cx + 4} y={PADT + 6} fontSize={11} fill={AXIS}>v{v}</text>
                </g>
              );
            })}
          </svg>
        )}
        {h != null && W > 0 && (
          <Tip x={x(h) + bw / 2} width={W}>
            <strong className="block text-body-strong">{num(daily[h]!.views)} {daily[h]!.views === 1 ? "view" : "views"}</strong>
            <span className="text-text-muted">
              {longDay(daily[h]!.date)} · {num(daily[h]!.people)} {daily[h]!.people === 1 ? "person" : "people"}
              {markBy.has(daily[h]!.date.slice(0, 10)) ? ` · version ${markBy.get(daily[h]!.date.slice(0, 10))} went live` : ""}
            </span>
          </Tip>
        )}
        <Live text={h != null ? `${longDay(daily[h]!.date)}: ${num(daily[h]!.views)} views` : ""} />
      </div>
      {n > 0 && (
        <div className="flex justify-between text-micro text-text-muted" aria-hidden>
          <span>{day(daily[0]!.date)}</span>
          {n > 2 && <span>{day(daily[Math.floor((n - 1) / 2)]!.date)}</span>}
          {n > 1 && <span>{day(daily[n - 1]!.date)}</span>}
        </div>
      )}
      <HiddenTable caption="Views per day" head={["Day", "Views", "People"]} rows={daily.map((d) => [longDay(d.date), d.views, d.people])} />
    </figure>
  );
}

/* ── Retention ────────────────────────────────────────────────────────── */

export interface RetentionMark { t: number; label: string }

export function RetentionChart({ points, dur, marks = [], height = 240, compact, noun = "watching" }: {
  points: { t: number; pct: number }[];
  dur: number;
  marks?: RetentionMark[];
  height?: number;
  compact?: boolean;
  /** "watching" or "listening". */
  noun?: string;
}) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const n = points.length;
  const scrub = useScrub(n);
  const titleId = useId();
  const PADL = compact ? 0 : 40, PADR = 2, PADT = 10, PADB = compact ? 6 : 26;
  const plotW = Math.max(0, W - PADL - PADR), plotH = height - PADT - PADB;
  const D = Math.max(1, dur || points[n - 1]?.t || 1);
  const x = (t: number) => PADL + (Math.min(t, D) / D) * plotW;
  const y = (p: number) => PADT + plotH - (Math.max(0, Math.min(100, p)) / 100) * plotH;
  const at = (t: number) => {
    let best = points[0];
    for (const p of points) { if (p.t <= t) best = p; else break; }
    return best?.pct ?? 0;
  };
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.pct).toFixed(1)}`).join(" ");
  const area = n ? `${line} L${x(points[n - 1]!.t).toFixed(1)} ${y(0)} L${x(points[0]!.t).toFixed(1)} ${y(0)} Z` : "";
  const end = points[n - 1]?.pct ?? 0;
  const summary = n
    ? `Share still ${noun} over the ${clock(D)} runtime: ${pct(points[0]!.pct)} at the start, ${pct(at(30))} at 0:30, ${pct(end)} at the end.${marks.length ? ` Marked: ${marks.map((m) => `${clock(m.t)} ${m.label}`).join("; ")}.` : ""}`
    : "No one has pressed play in this period.";
  const h = scrub.i;
  // The hidden table: at most ~60 rows.
  const every = Math.max(1, Math.ceil(n / 60));

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    if (!n || !plotW) return;
    const t = ((e.clientX - r.left - PADL) / plotW) * D;
    let best = 0;
    for (let i = 0; i < n; i++) if (Math.abs(points[i]!.t - t) < Math.abs(points[best]!.t - t)) best = i;
    scrub.setI(best);
  }

  return (
    <figure className="m-0">
      <div ref={ref} className="relative" style={{ height }}>
        {W > 0 && (
          <svg width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="img" aria-labelledby={titleId} tabIndex={0}
            className={svgFocus} onPointerMove={onMove} onPointerLeave={scrub.clear} onBlur={scrub.clear} onKeyDown={scrub.onKeyDown}>
            <title id={titleId}>{summary} Use the arrow keys to move through the video.</title>
            {!compact && [100, 50].map((v) => <line key={v} x1={PADL} x2={W - PADR} y1={y(v)} y2={y(v)} stroke={GRID} strokeDasharray="2 4" />)}
            <line x1={PADL} x2={W - PADR} y1={y(0)} y2={y(0)} stroke={GRID} />
            {!compact && [100, 50, 0].map((v) => (
              <text key={v} x={PADL - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill={AXIS}>{v ? `${v}%` : "0"}</text>
            ))}
            {n > 1 && <path d={area} fill={SERIES} fillOpacity={0.12} />}
            {n > 1 && <path d={line} fill="none" stroke={SERIES} strokeWidth={2} strokeLinejoin="round" />}
            {marks.map((m) => (
              <g key={m.t} aria-hidden>
                <line x1={x(m.t)} x2={x(m.t)} y1={PADT} y2={y(0)} stroke={AXIS} strokeOpacity={0.6} strokeDasharray="3 3" />
                <circle cx={x(m.t)} cy={y(at(m.t))} r={5} fill={SERIES} stroke="var(--surface)" strokeWidth={2} />
              </g>
            ))}
            {h != null && (
              <g aria-hidden>
                <line x1={x(points[h]!.t)} x2={x(points[h]!.t)} y1={PADT} y2={y(0)} stroke={CROSS} />
                <circle cx={x(points[h]!.t)} cy={y(points[h]!.pct)} r={4} fill={SERIES} stroke="var(--surface)" strokeWidth={2} />
              </g>
            )}
            {!compact && (
              <>
                <text x={PADL} y={height - 6} fontSize={11} fill={AXIS}>0:00</text>
                <text x={PADL + plotW / 2} y={height - 6} textAnchor="middle" fontSize={11} fill={AXIS}>{clock(D / 2)}</text>
                <text x={W - PADR} y={height - 6} textAnchor="end" fontSize={11} fill={AXIS}>{clock(D)}</text>
              </>
            )}
          </svg>
        )}
        {h != null && W > 0 && (
          <Tip x={x(points[h]!.t)} width={W}>
            <strong className="block text-body-strong">{pct(points[h]!.pct)} still {noun}</strong>
            <span className="text-text-muted">at {clock(points[h]!.t)}</span>
          </Tip>
        )}
        <Live text={h != null ? `${clock(points[h]!.t)}: ${pct(points[h]!.pct)} still ${noun}` : ""} />
      </div>
      <HiddenTable caption={`Share still ${noun}`} head={["Time", `Still ${noun}`]}
        rows={points.filter((_, i) => i % every === 0 || i === n - 1).map((p) => [clock(p.t), pct(p.pct)])} />
    </figure>
  );
}

/* ── Two versions, first minute ───────────────────────────────────────── */

export function CompareChart({ a, b, height = 200, noun = "watching" }: {
  /** The current version (solid). */
  a: { label: string; points: { t: number; pct: number }[] };
  /** The one before (dashed). */
  b: { label: string; points: { t: number; pct: number }[] };
  height?: number;
  noun?: string;
}) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const ts = a.points.map((p) => p.t);
  const n = ts.length;
  const scrub = useScrub(n);
  const titleId = useId();
  const PADT = 10, PADB = 22;
  const plotH = height - PADT - PADB;
  const T = 60;
  const x = (t: number) => (t / T) * W;
  const y = (p: number) => PADT + plotH - (Math.max(0, Math.min(100, p)) / 100) * plotH;
  const val = (pts: { t: number; pct: number }[], t: number) => {
    let best = pts[0];
    for (const p of pts) { if (p.t <= t) best = p; else break; }
    return best?.pct ?? 0;
  };
  const path = (pts: { t: number; pct: number }[]) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.pct).toFixed(1)}`).join(" ");
  const a30 = val(a.points, 30), b30 = val(b.points, 30);
  const summary = `At 30 seconds, ${pct(a30)} are still ${noun} ${a.label.toLowerCase()} versus ${pct(b30)} for ${b.label.toLowerCase()}.`;
  const h = scrub.i;
  const aAbove = a30 >= b30;

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    if (!n || !W) return;
    const t = ((e.clientX - r.left) / W) * T;
    let best = 0;
    for (let i = 0; i < n; i++) if (Math.abs(ts[i]! - t) < Math.abs(ts[best]! - t)) best = i;
    scrub.setI(best);
  }

  return (
    <figure className="m-0">
      <div ref={ref} className="relative" style={{ height }}>
        {W > 0 && (
          <svg width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="img" aria-labelledby={titleId} tabIndex={0}
            className={svgFocus} onPointerMove={onMove} onPointerLeave={scrub.clear} onBlur={scrub.clear} onKeyDown={scrub.onKeyDown}>
            <title id={titleId}>{summary}</title>
            <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke={GRID} />
            <line x1={x(30)} x2={x(30)} y1={PADT} y2={y(0)} stroke={GRID} strokeDasharray="2 4" />
            <path d={path(b.points)} fill="none" stroke={SERIES_2} strokeWidth={2} strokeDasharray="6 4" />
            <path d={path(a.points)} fill="none" stroke={SERIES} strokeWidth={2} />
            <circle cx={x(30)} cy={y(a30)} r={5} fill={SERIES} stroke="var(--surface)" strokeWidth={2} />
            <circle cx={x(30)} cy={y(b30)} r={5} fill={SERIES_2} stroke="var(--surface)" strokeWidth={2} />
            <text x={x(30) + 10} y={y(a30) + (aAbove ? -8 : 18)} fontSize={12} fontWeight={600} fill="var(--text)">{pct(a30)}</text>
            <text x={x(30) + 10} y={y(b30) + (aAbove ? 18 : -8)} fontSize={12} fontWeight={600} fill="var(--text)">{pct(b30)}</text>
            <text x={2} y={height - 4} fontSize={11} fill={AXIS}>0:00</text>
            <text x={x(30)} y={height - 4} textAnchor="middle" fontSize={11} fill={AXIS}>0:30</text>
            <text x={W - 2} y={height - 4} textAnchor="end" fontSize={11} fill={AXIS}>1:00</text>
            {h != null && <line x1={x(ts[h]!)} x2={x(ts[h]!)} y1={PADT} y2={y(0)} stroke={CROSS} aria-hidden />}
          </svg>
        )}
        {h != null && W > 0 && (
          <Tip x={x(ts[h]!)} width={W}>
            <strong className="block text-body-strong">At {clock(ts[h]!)}</strong>
            <span className="block text-text-secondary">{a.label}: {pct(val(a.points, ts[h]!))}</span>
            <span className="block text-text-secondary">{b.label}: {pct(val(b.points, ts[h]!))}</span>
          </Tip>
        )}
        <Live text={h != null ? `${clock(ts[h]!)}: ${a.label} ${pct(val(a.points, ts[h]!))}, ${b.label} ${pct(val(b.points, ts[h]!))}` : ""} />
      </div>
      <HiddenTable caption={`Still ${noun} in the first minute`} head={["Time", a.label, b.label]}
        rows={ts.map((t) => [clock(t), pct(val(a.points, t)), pct(val(b.points, t))])} />
    </figure>
  );
}

/* ── Per-page bars (PDF) ──────────────────────────────────────────────── */

export function PageBars({ values, highlight, highlightLabel, format, label, caption, valueHead, height = 200 }: {
  values: { page: number; v: number }[];
  highlight: number | null;
  highlightLabel?: string;
  format: (v: number) => string;
  /** aria summary. */
  label: string;
  caption: string;
  valueHead: string;
  height?: number;
}) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const n = values.length;
  const scrub = useScrub(n);
  const titleId = useId();
  const PADT = 18, PADB = 22;
  const plotH = height - PADT - PADB;
  const max = Math.max(1, ...values.map((d) => d.v));
  const slot = n ? W / n : 0;
  const bw = Math.max(1, Math.min(38, slot * 0.82));
  const x = (i: number) => i * slot + (slot - bw) / 2;
  const y = (v: number) => PADT + plotH - (v / max) * plotH;
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(W / 28))));
  const h = scrub.i;

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    if (!n || !slot) return;
    scrub.setI(Math.max(0, Math.min(n - 1, Math.floor((e.clientX - r.left) / slot))));
  }

  return (
    <figure className="m-0">
      <div ref={ref} className="relative" style={{ height }}>
        {W > 0 && (
          <svg width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="img" aria-labelledby={titleId} tabIndex={0}
            className={svgFocus} onPointerMove={onMove} onPointerLeave={scrub.clear} onBlur={scrub.clear} onKeyDown={scrub.onKeyDown}>
            <title id={titleId}>{label}</title>
            <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke={GRID} />
            {values.map((d, i) => {
              const bh = Math.max(d.v > 0 ? 2 : 0, y(0) - y(d.v));
              return (
                <g key={d.page}>
                  <rect x={x(i)} y={y(0) - bh} width={bw} height={bh} rx={Math.min(3, bw / 2)} fill={i === highlight || i === h ? SERIES : SOFT} />
                  {(i % labelEvery === 0 || i === highlight) && (
                    <text x={x(i) + bw / 2} y={height - 4} textAnchor="middle" fontSize={11} fill={AXIS}>{d.page}</text>
                  )}
                </g>
              );
            })}
            {highlight != null && highlightLabel && values[highlight] && (
              <text x={x(highlight) + bw / 2} y={y(values[highlight]!.v) - 6} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--text)">{highlightLabel}</text>
            )}
          </svg>
        )}
        {h != null && W > 0 && (
          <Tip x={x(h) + bw / 2} width={W}>
            <strong className="block text-body-strong">Page {values[h]!.page}</strong>
            <span className="text-text-muted">{format(values[h]!.v)}</span>
          </Tip>
        )}
        <Live text={h != null ? `Page ${values[h]!.page}: ${format(values[h]!.v)}` : ""} />
      </div>
      <HiddenTable caption={caption} head={["Page", valueHead]} rows={values.map((d) => [d.page, format(d.v)])} />
    </figure>
  );
}

/* ── Sparkline ────────────────────────────────────────────────────────── */

export function Sparkline({ values, label, width = 80, height = 24 }: { values: number[]; label: string; width?: number; height?: number }) {
  const max = Math.max(1, ...values);
  const n = values.length;
  const pts = values.map((v, i) => `${(n <= 1 ? width / 2 : 2 + (i * (width - 4)) / (n - 1)).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={label} className="block">
      <polyline points={pts} fill="none" stroke={SERIES} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** "Rising, peak on day 10" style words for a sparkline's label. */
export function trendWords(values: number[]): string {
  if (values.length < 2) return "Not enough data for a trend";
  const half = Math.floor(values.length / 2);
  const a = values.slice(0, half).reduce((s, v) => s + v, 0) / Math.max(1, half);
  const b = values.slice(half).reduce((s, v) => s + v, 0) / Math.max(1, values.length - half);
  const max = Math.max(...values);
  const total = values.reduce((s, v) => s + v, 0);
  const spike = max > 0 && max > (total / values.length) * 2.5;
  const word = b > a * 1.25 ? "Rising" : b < a * 0.75 ? "Falling" : "Steady";
  return spike ? `${word}, with a spike` : word;
}

/* ── Rewatch / skip heat strip ────────────────────────────────────────── */

export function HeatStrip({ values, dur }: { values: number[]; dur: number }) {
  const n = values.length;
  const seg = dur / Math.max(1, n);
  const range = (i: number) => `${clock(i * seg)}–${clock((i + 1) * seg)}`;
  const top = values.reduce((b, v, i) => (v > values[b]! ? i : b), 0);
  const skipped = values.map((v, i) => (v <= 0 ? i : -1)).filter((i) => i >= 0);
  const label = n
    ? `Most rewatched around ${range(top)}.${skipped.length ? ` Skipped: ${skipped.length} of ${n} stretches.` : " Nothing was mostly skipped."}`
    : "No rewatch data.";
  const word = (v: number) => (v <= 0 ? "skipped" : v >= 0.7 ? "rewatched a lot" : v >= 0.4 ? "some rewatching" : "watched once");
  return (
    <figure className="m-0">
      <div className="flex h-3.5 gap-0.5" role="img" aria-label={label}>
        {values.map((v, i) => (
          <span key={i} title={`${range(i)}: ${word(v)}`} className="flex-1 rounded-[2px]"
            style={v <= 0 ? { background: "var(--chart-track)" } : { background: SERIES, opacity: Math.max(0.12, Math.min(1, v)) }} />
        ))}
      </div>
      <HiddenTable caption="Rewatched and skipped" head={["Stretch", "Rewatching"]} rows={values.map((v, i) => [range(i), word(v)])} />
    </figure>
  );
}

/* ── Horizontal bar list (sources, devices, speeds) ───────────────────── */

export function BarList({ rows, labelWidth, className }: {
  rows: { key: string; label: React.ReactNode; value: number; display: string; extra?: React.ReactNode }[];
  /** Fixed label column (e.g. 52) or a stacked layout when omitted. */
  labelWidth?: number;
  className?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (labelWidth) {
    return (
      <ul className={cx("m-0 flex list-none flex-col gap-2.5 p-0", className)}>
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-2.5 text-[13px]">
            <span className="shrink-0 text-text" style={{ width: labelWidth }}>{r.label}</span>
            <span className="h-2 flex-1 rounded-full bg-(--chart-track)" aria-hidden>
              <span className="block h-2 rounded-full bg-(--chart-1)" style={{ width: `${(r.value / max) * 100}%` }} />
            </span>
            <strong className="w-11 shrink-0 text-right font-semibold tabular-nums text-text">{r.display}</strong>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className={cx("m-0 flex list-none flex-col gap-3 p-0", className)}>
      {rows.map((r) => (
        <li key={r.key} className="flex flex-col gap-1">
          <span className="flex items-baseline gap-2 text-[13px]">
            <span className="min-w-0 flex-1 truncate text-text">{r.label}</span>
            {r.extra}
            <strong className="font-semibold tabular-nums text-text">{r.display}</strong>
          </span>
          <span className="h-1.5 rounded-full bg-(--chart-track)" aria-hidden>
            <span className="block h-1.5 rounded-full bg-(--chart-1)" style={{ width: `${Math.max(1, (r.value / max) * 100)}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}
