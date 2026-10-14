"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Alert, Button, CopyButton, Drawer, Skeleton, Tabs, cx } from "@/components/ui";
import { StatTile } from "@/components/kit/StatTile";
import { getAnalytics, type Analytics, type MyDocListItem } from "@/lib/api";
import { parseApiDate, plural, readTime } from "./format";
import { usePhone } from "./hooks";
import styles from "./dashboard.module.css";

type Range = "7d" | "30d" | "all";
const RANGES: { value: Range; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "all", label: "All time" },
];
/** The panel never spins forever: a request that hasn't answered in this long becomes an error. */
const TIMEOUT_MS = 15000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

const dayFmt = (iso: string) => {
  const d = parseApiDate(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : iso;
};

/**
 * The API lists only days that had views. A line needs every day, so 7/30-day ranges are padded
 * with zero days up to today (UTC); "All time" is padded from the first day with views.
 */
function fillDays(series: { date: string; views: number }[], range: Range): { date: string; views: number }[] {
  const byDay = new Map(series.map((s) => [s.date.slice(0, 10), s.views]));
  const DAY = 86400000;
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").getTime();
  const last = series.length ? Math.max(today, Date.parse(series[series.length - 1]!.date.slice(0, 10) + "T00:00:00Z")) : today;
  let first: number;
  if (range === "all") {
    if (!series.length) return [];
    first = Date.parse(series[0]!.date.slice(0, 10) + "T00:00:00Z");
    first = Math.max(first, last - 365 * DAY);
  } else {
    first = last - ((range === "7d" ? 7 : 30) - 1) * DAY;
  }
  const out: { date: string; views: number }[] = [];
  for (let t = first; t <= last; t += DAY) {
    const d = new Date(t).toISOString().slice(0, 10);
    out.push({ date: d, views: byDay.get(d) ?? 0 });
  }
  return out;
}

/** "https://app.slack.com/client" → "app.slack.com"; anything else as-is. */
function refLabel(r: string): string {
  if (!r) return "Direct or unknown";
  try {
    return new URL(r).host || r;
  } catch {
    return r;
  }
}

/* ── Views over time ──────────────────────────────────────────────────── */

/**
 * The views series as an area + line in chart-1, drawn in over 400ms. Colours are CSS variables
 * resolved by the browser at paint, so the chart follows the theme without re-rendering. Hover or
 * arrow keys move a crosshair + tooltip; the numbers are also in a visually hidden table.
 */
function ViewsChart({ series }: { series: { date: string; views: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const titleId = useId();
  const W = 360, H = 120, PADL = 26, PADR = 6, PADT = 10, PADB = 4;
  const max = Math.max(1, ...series.map((s) => s.views));
  const mid = Math.round(max / 2);
  const n = series.length;
  const x = (i: number) => (n <= 1 ? (PADL + W - PADR) / 2 : PADL + (i * (W - PADL - PADR)) / (n - 1));
  const y = (v: number) => PADT + (1 - v / max) * (H - PADT - PADB);
  const line = series.map((s, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(s.views).toFixed(1)}`).join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)} ${H - PADB} L${x(0).toFixed(1)} ${H - PADB} Z`;
  const total = series.reduce((a, s) => a + s.views, 0);
  const peakI = series.reduce((b, s, i) => (s.views > series[b]!.views ? i : b), 0);
  const summary = `Views per day: ${plural(total, "view")} in total, highest on ${dayFmt(series[peakI]!.date)} with ${series[peakI]!.views}.`;
  const h = hover ?? null;

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r || n === 0) return;
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - PADL) / (W - PADL - PADR)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  }
  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      setHover((cur) => {
        const c = cur ?? (e.key === "ArrowRight" ? -1 : n);
        return Math.max(0, Math.min(n - 1, c + (e.key === "ArrowRight" ? 1 : -1)));
      });
    } else if (e.key === "Home") { e.preventDefault(); setHover(0); }
    else if (e.key === "End") { e.preventDefault(); setHover(n - 1); }
  }

  const tipLeft = h != null ? `${(x(h) / W) * 100}%` : "0";
  const tipAlign = h != null && x(h) > W * 0.66 ? "-100%" : h != null && x(h) < W * 0.33 ? "0%" : "-50%";

  return (
    <figure className="m-0 flex flex-col gap-1">
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="block h-32 w-full touch-pan-y overflow-visible rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--border-focus)"
          preserveAspectRatio="none"
          role="img"
          aria-labelledby={titleId}
          tabIndex={0}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onBlur={() => setHover(null)}
          onKeyDown={onKey}
        >
          <title id={titleId}>{summary} Use the arrow keys to read each day.</title>
          {[0, mid, max].map((v, i) => (
            <line key={i} x1={PADL} x2={W - PADR} y1={y(v)} y2={y(v)} stroke="var(--chart-grid)" strokeWidth={1} vectorEffect="non-scaling-stroke" strokeDasharray={v === 0 ? undefined : "2 3"} />
          ))}
          <text x={0} y={y(max) + 4} fill="var(--chart-axis)" fontSize={11} style={{ fontVariantNumeric: "tabular-nums" }}>{max}</text>
          {mid > 0 && mid < max && <text x={0} y={y(mid) + 4} fill="var(--chart-axis)" fontSize={11}>{mid}</text>}
          {n > 1 && <path d={area} fill="var(--chart-1)" fillOpacity={0.14} className={styles.area} />}
          {n > 1 && (
            <path d={line} fill="none" stroke="var(--chart-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" pathLength={1} className={styles.line} />
          )}
          {n === 1 && <circle cx={x(0)} cy={y(series[0]!.views)} r={3} fill="var(--chart-1)" />}
          {h != null && (
            <>
              <line x1={x(h)} x2={x(h)} y1={PADT} y2={H - PADB} stroke="var(--chart-crosshair)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <circle cx={x(h)} cy={y(series[h]!.views)} r={3.5} fill="var(--chart-1)" stroke="var(--surface)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" className={styles.dot} />
            </>
          )}
        </svg>
        {h != null && (
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 rounded-md border border-border bg-surface-raised px-2 py-1 text-micro whitespace-nowrap text-text shadow-md"
            style={{ left: tipLeft, transform: `translate(${tipAlign}, -110%)` }}
          >
            {dayFmt(series[h]!.date)} · {plural(series[h]!.views, "view")}
          </div>
        )}
        <span className="md-visually-hidden" aria-live="polite">
          {h != null ? `${dayFmt(series[h]!.date)}: ${plural(series[h]!.views, "view")}` : ""}
        </span>
      </div>
      <div className="flex justify-between pl-6.5 text-micro text-text-muted" aria-hidden>
        <span>{dayFmt(series[0]!.date)}</span>
        {n > 2 && <span>{dayFmt(series[Math.floor((n - 1) / 2)]!.date)}</span>}
        {n > 1 && <span>{dayFmt(series[n - 1]!.date)}</span>}
      </div>
      <table className="md-visually-hidden">
        <caption>Views per day</caption>
        <thead><tr><th scope="col">Day</th><th scope="col">Views</th></tr></thead>
        <tbody>
          {series.map((s) => (
            <tr key={s.date}><th scope="row">{dayFmt(s.date)}</th><td>{s.views}</td></tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/* ── Read depth ───────────────────────────────────────────────────────── */

const REACHED_LABEL: Record<number, string> = { 25: "A quarter", 50: "Halfway", 75: "Three quarters", 100: "To the end" };

function ReadDepth({ r }: { r: NonNullable<Analytics["reading"]> }) {
  if (!r.reads) {
    return <p className="text-caption text-text-muted">Nobody has read it since tracking began.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-3">
        <div>
          <dt className="text-caption text-text-muted">Average read time</dt>
          <dd className="text-h3 text-text tabular-nums">{readTime(r.avg_seconds)}</dd>
        </div>
        <div>
          <dt className="text-caption text-text-muted">Read to the end</dt>
          <dd className="text-h3 text-text tabular-nums">{Math.round(r.finished)}%</dd>
        </div>
      </dl>
      <ul className="flex flex-col gap-1.5" aria-label={`How far ${plural(r.reads, "reader")} got`}>
        {r.reached.map((x, i) => {
          const pct = Math.max(0, Math.min(100, Math.round(x.pct)));
          const label = REACHED_LABEL[x.at] ?? `${x.at}% in`;
          return (
            <li key={x.at} className="grid grid-cols-[6.5rem_1fr_2.75rem] items-center gap-2 text-caption">
              <span className="text-text-secondary">{label}</span>
              <span className="h-2 overflow-hidden rounded-full bg-(--chart-track)" aria-hidden>
                <span
                  className={cx("block h-full rounded-full bg-(--chart-1)", styles.bar)}
                  style={{ width: `${pct}%`, animationDelay: `${i * 20}ms` }}
                />
              </span>
              <span className="text-right text-text tabular-nums">{pct}%</span>
            </li>
          );
        })}
      </ul>
      <p className="text-micro text-text-muted">{plural(r.reads, "reading session")}</p>
    </div>
  );
}

/* ── Top countries / referrers ────────────────────────────────────────── */

let regionNames: Intl.DisplayNames | null = null;
function countryName(code: string): string {
  if (!/^[A-Z]{2}$/i.test(code)) return code || "Unknown";
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

function TopTable({ caption, head, rows }: { caption: string; head: string; rows: { key: string; label: string; views: number; mono?: boolean }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.views));
  return (
    <div className="md-table-wrap">
      <table className="md-table md-table--compact">
        <caption className="md-visually-hidden">{caption}</caption>
        <thead>
          <tr><th scope="col">{head}</th><th scope="col" style={{ textAlign: "right", width: "4.5rem" }}>Views</th></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key}>
              <td className="max-w-0">
                <span className="relative block min-w-0">
                  <span
                    aria-hidden
                    className={cx("absolute inset-y-0 left-0 rounded-sm bg-(--chart-wash)", styles.bar)}
                    style={{ width: `${Math.max(4, (r.views / max) * 100)}%`, animationDelay: `${i * 20}ms` }}
                  />
                  <span className={cx("relative block truncate px-1.5 py-0.5 text-text", r.mono && "font-mono")} title={r.label}>{r.label}</span>
                </span>
              </td>
              <td className="md-td--num tabular-nums">{r.views.toLocaleString("en-US")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Drawer ───────────────────────────────────────────────────────────── */

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-border pt-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-body-strong text-text">{title}</h3>
        {aside && <span className="text-micro text-text-muted">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * Per-document analytics in a right Drawer (420px; a bottom sheet on phones). A reskin of the old
 * inline panel: range tabs, four StatTiles, views over time, read depth, top countries/referrers.
 * Loading shows skeletons; a failure or a 15s stall shows an inline Alert with "Try again".
 */
export default function AnalyticsDrawer({
  doc, title, address, copyText, onClose,
}: {
  doc: MyDocListItem | null;
  title: string;
  address: string;
  /** What Copy link copies (null for E2E without a key on this device). */
  copyText: string | null;
  onClose: () => void;
}) {
  const phone = usePhone();
  const [range, setRange] = useState<Range>("30d");
  const [data, setData] = useState<Analytics | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const slug = doc?.slug ?? null;
  const lastSlug = useRef<string | null>(null);
  if (slug) lastSlug.current = slug;

  useEffect(() => {
    if (!slug) return;
    let live = true;
    setState("loading");
    withTimeout(getAnalytics(slug, range), TIMEOUT_MS)
      .then((d) => { if (live) { setData(d); setState("ok"); } })
      .catch(() => { if (live) setState("error"); });
    return () => { live = false; };
  }, [slug, range, attempt]);

  // A new document starts on 30 days with nothing stale on screen.
  useEffect(() => {
    if (slug) { setRange("30d"); setData(null); }
  }, [slug]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  const t = data?.totals;
  const loading = state === "loading" && !data;
  const countries = useMemo(
    () => (data?.countries ?? []).slice(0, 8).map((c) => ({ key: c.country, label: countryName(c.country), views: c.views })),
    [data],
  );
  const referrers = useMemo(
    () => (data?.referrers ?? []).slice(0, 8).map((r) => ({ key: r.referrer || "direct", label: refLabel(r.referrer), views: r.views, mono: !!r.referrer })),
    [data],
  );

  return (
    <Drawer
      open={!!doc}
      onClose={onClose}
      side={phone ? "bottom" : "right"}
      width={420}
      title={<span className="block truncate" dir="auto">{title}</span>}
      description={<span className="font-mono">{address}</span>}
      bodyClassName="flex flex-col gap-4 [&>*]:shrink-0"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          {copyText ? <CopyButton text={copyText} label="Copy link" announceText="Link copied" /> : <span />}
          <Button variant="ghost" size="sm" iconRight="external" href={`/${lastSlug.current ?? ""}`}>Open document</Button>
        </div>
      }
    >
      <Tabs
        variant="pill"
        size="sm"
        aria-label="Time range"
        items={RANGES}
        value={range}
        onChange={(v) => setRange(v as Range)}
      />

      {state === "error" && (
        <Alert
          tone="danger"
          title="Couldn't load analytics"
          actions={<Button size="sm" variant="secondary" iconLeft="refresh" onClick={retry}>Try again</Button>}
        >
          Check your connection and try again.
        </Alert>
      )}

      {state !== "error" && (
        <div aria-busy={state === "loading"} className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2">
            <StatTile size="sm" label="Views" value={t ? t.views.toLocaleString("en-US") : "—"} loading={loading} />
            <StatTile size="sm" label="Unique visitors" value={t ? t.unique_visitors.toLocaleString("en-US") : "—"} loading={loading} />
            <StatTile size="sm" label="PDF exports" value={t ? t.export_pdf.toLocaleString("en-US") : "—"} loading={loading} />
            <StatTile size="sm" label="Link copies" value={t ? t.copy_url.toLocaleString("en-US") : "—"} loading={loading} />
          </div>

          <Section title="Views over time" aside={range === "all" ? "Daily, all time" : "Daily"}>
            {loading ? (
              <Skeleton variant="rect" height={128} />
            ) : data && data.timeseries.some((d) => d.views > 0) ? (
              <ViewsChart key={`${slug}-${range}`} series={fillDays(data.timeseries, range)} />
            ) : (
              <p className="text-caption text-text-muted">No views in this period.</p>
            )}
          </Section>

          <Section title="How people read it">
            {loading ? (
              <Skeleton variant="rect" height={96} />
            ) : data?.reading ? (
              <ReadDepth r={data.reading} />
            ) : (
              <p className="text-caption text-text-muted">Nobody has read it since tracking began.</p>
            )}
          </Section>

          <Section title="Top countries">
            {loading ? (
              <Skeleton variant="rect" height={72} />
            ) : countries.length ? (
              <TopTable caption="Top countries by views" head="Country" rows={countries} />
            ) : (
              <p className="text-caption text-text-muted">No location data yet.</p>
            )}
          </Section>

          <Section title="Top referrers">
            {loading ? (
              <Skeleton variant="rect" height={72} />
            ) : referrers.length ? (
              <TopTable caption="Top referrers by views" head="Source" rows={referrers} />
            ) : (
              <p className="text-caption text-text-muted">No referrers yet.</p>
            )}
          </Section>
        </div>
      )}
    </Drawer>
  );
}
