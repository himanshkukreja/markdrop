"use client";

import { useState } from "react";
import { ACCENT, TrendChart, bucketLabel, compact } from "./charts";
import { Card, CardTitle } from "./ui";

const GRAY = "#4b5563";

export type Growth = {
  new_visitors: number; creators: number; conversion: number; activation: number;
  median_to_create_s: number; loop_share: number; unit: string;
  groups: { key: string; label: string; visitors: number; creators: number; first_session: number; conversion: number; activation: number }[];
  series: { t: string; loop: number; other: number }[];
};

export type Shares = {
  unit: string; attempts: number; connected: number; success_rate: number; relayed_pct: number;
  failed_no_stun: number; failed_with_stun: number; median_connect_ms: number; median_rtt_ms: number;
  series: { t: string; attempts: number; connected: number; relayed: number }[];
  routes: { key: string; n: number }[]; fail_browsers: { key: string; n: number }[];
  transfers: { count: number; files: number; bytes: number; relay_bytes: number; direct_mbps: number; relay_mbps: number; direct_n: number; relay_n: number };
  shares: number; sizes: { key: string; n: number }[]; file_counts: { key: string; n: number }[];
};

function bytes(n: number) {
  if (n >= 2 ** 40) return `${(n / 2 ** 40).toFixed(2)} TB`;
  if (n >= 2 ** 30) return `${(n / 2 ** 30).toFixed(1)} GB`;
  if (n >= 2 ** 20) return `${(n / 2 ** 20).toFixed(0)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

function span(s: number) {
  if (!s) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} days`;
}

/** A labelled number; `accent` marks the one figure a section is about. */
function Figure({ label, value, foot, accent }: { label: string; value: string; foot?: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl border p-3.5 ${accent ? "border-blue-500/40 bg-blue-500/[0.06]" : "border-gray-800/80 bg-gray-950/40"}`}>
      <p className="text-[11px] font-medium text-gray-400">{label}</p>
      <p className="mt-1 text-xl font-semibold tracking-tight text-gray-50">{value}</p>
      {foot && <p className="mt-0.5 text-[11px] text-gray-500 leading-snug">{foot}</p>}
    </div>
  );
}

/** Horizontal bars for a short ranked list (single series, one hue). */
export function BarList({ rows, format = compact, empty = "No data yet." }: { rows: { key: string; n: number }[]; format?: (n: number) => string; empty?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  if (!rows.some((r) => r.n)) return <p className="py-4 text-xs text-gray-500">{empty}</p>;
  return (
    <ul className="space-y-1">
      {rows.map((r) => (
        <li key={r.key} className="relative flex items-center justify-between h-7 px-2 text-xs">
          <span aria-hidden className="absolute inset-y-0.5 left-0 rounded-[4px]" style={{ width: `${(r.n / max) * 100}%`, background: ACCENT, opacity: 0.16 }} />
          <span className="relative truncate text-gray-200">{r.key}</span>
          <span className="relative tabular-nums font-semibold text-gray-100">{format(r.n)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Two-series stacked columns — the emphasis series in the accent, the rest
 *  in gray — with a 2px surface gap, rounded data ends, and per-column hover. */
function StackedColumns({ series, unit, tz, labels }: {
  series: { t: string; a: number; b: number }[]; unit: string; tz: string; labels: [string, string];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const H = 120;
  const max = Math.max(1, ...series.map((s) => s.a + s.b));
  const every = Math.max(1, Math.ceil(series.length / 6));
  return (
    <div>
      <div className="flex items-center gap-4 mb-2 text-[11px] text-gray-400">
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: ACCENT }} />{labels[0]}</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: GRAY }} />{labels[1]}</span>
      </div>
      <div className="relative">
        <div className="flex items-end gap-[2px] border-b border-gray-800" style={{ height: H }} onPointerLeave={() => setHover(null)}>
          {series.map((s, i) => {
            const ha = (s.a / max) * (H - 4);
            const hb = (s.b / max) * (H - 4);
            return (
              <div key={s.t} className="relative flex-1 h-full flex flex-col justify-end items-center cursor-default"
                onPointerEnter={() => setHover(i)} tabIndex={0} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                aria-label={`${bucketLabel(s.t, unit, tz, true)}: ${s.a} ${labels[0]}, ${s.b} ${labels[1]}`}>
                <div className="w-full max-w-[24px] flex flex-col justify-end gap-[2px]" style={{ opacity: hover === null || hover === i ? 1 : 0.55 }}>
                  {s.a > 0 && <div className="w-full rounded-t-[4px]" style={{ height: ha, background: ACCENT }} />}
                  {s.b > 0 && <div className={`w-full ${s.a > 0 ? "" : "rounded-t-[4px]"}`} style={{ height: hb, background: GRAY }} />}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex gap-[2px] mt-1">
          {series.map((s, i) => (
            <div key={s.t} className="flex-1 text-center text-[10px] text-gray-500 whitespace-nowrap overflow-visible">
              {i % every === 0 ? bucketLabel(s.t, unit, tz) : ""}
            </div>
          ))}
        </div>
        {hover !== null && series[hover] && (
          <div className="pointer-events-none absolute -top-2 z-10 rounded-lg border border-gray-700 bg-gray-950/95 px-2.5 py-1.5 shadow-lg text-[11px]"
            style={{ left: `${Math.min(80, (hover / Math.max(1, series.length - 1)) * 100)}%` }}>
            <p className="text-gray-400 mb-0.5">{bucketLabel(series[hover].t, unit, tz, true)}</p>
            <p className="flex items-center gap-1.5 text-gray-200"><span className="w-3 h-0.5" style={{ background: ACCENT }} /><b className="text-gray-50">{series[hover].a}</b> {labels[0]}</p>
            <p className="flex items-center gap-1.5 text-gray-200"><span className="w-3 h-0.5" style={{ background: GRAY }} /><b className="text-gray-50">{series[hover].b}</b> {labels[1]}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Growth loop ───────────────────────────────────────────────────────────────

export function GrowthCard({ data, tz }: { data: Growth | null; tz: string }) {
  if (!data) return null;
  const loopKeys = new Set(["shared_doc", "shared_files"]);
  const maxConv = Math.max(1, ...data.groups.map((g) => g.conversion));
  return (
    <Card>
      <CardTitle title="Growth loop"
        sub="Do readers become writers? Everyone who first arrived in this range, by what they arrived on — not affected by filters" />
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <Figure accent label="Creators who arrived via someone's link" value={`${data.loop_share}%`}
          foot={`${data.groups.filter((g) => loopKeys.has(g.key)).reduce((n, g) => n + g.creators, 0)} of ${data.creators} new creators`} />
        <Figure label="New visitors who published" value={`${data.conversion}%`} foot={`${compact(data.creators)} of ${compact(data.new_visitors)}`} />
        <Figure label="Published on their first visit" value={`${data.activation}%`} foot="Activation" />
        <Figure label="Typical time to first publish" value={span(data.median_to_create_s)} foot="Median, from first visit" />
      </div>

      <div className="mt-5 grid lg:grid-cols-[1.1fr_1fr] gap-6 [&>*]:min-w-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-gray-500">
                <th className="text-left font-semibold pb-2">Arrived on</th>
                <th className="text-right font-semibold pb-2 px-2">New</th>
                <th className="text-left font-semibold pb-2 pl-3 w-[45%]">Went on to publish</th>
                <th className="text-right font-semibold pb-2 pl-2">1st visit</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {data.groups.map((g) => (
                <tr key={g.key} className="border-t border-gray-800/70">
                  <td className="py-2.5 text-gray-200 whitespace-nowrap">{g.label}</td>
                  <td className="py-2.5 px-2 text-right text-gray-400">{compact(g.visitors)}</td>
                  <td className="py-2.5 pl-3">
                    <div className="flex items-center gap-2">
                      <div className="hidden sm:block flex-1 h-2 rounded-full bg-gray-800/70 overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${(g.conversion / maxConv) * 100}%`, background: loopKeys.has(g.key) ? ACCENT : GRAY }} />
                      </div>
                      <span className="ml-auto w-24 shrink-0 text-right whitespace-nowrap"><b className="text-gray-100">{g.conversion}%</b> <span className="text-gray-500">({g.creators})</span></span>
                    </div>
                  </td>
                  <td className="py-2.5 pl-2 text-right text-gray-400">{g.activation}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-gray-500 leading-relaxed">
            Blue rows are the loop: someone else&apos;s document or file link reaching a new person.
          </p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-2">New creators</p>
          <StackedColumns series={data.series.map((s) => ({ t: s.t, a: s.loop, b: s.other }))} unit={data.unit} tz={tz}
            labels={["via a shared link", "other"]} />
        </div>
      </div>
    </Card>
  );
}

// ── File sharing ──────────────────────────────────────────────────────────────

export function ShareHealthCard({ data, tz }: { data: Shares | null; tz: string }) {
  if (!data) return null;
  const t = data.transfers;
  const relayGB = t.relay_bytes / 2 ** 30;
  const points = data.series.map((s) => ({ t: s.t, v: s.attempts ? Math.round((100 * s.connected) / s.attempts) : 0 }));
  return (
    <Card>
      <CardTitle title="File sharing" sub="Peer-to-peer connections and transfers — not affected by filters" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Figure accent label="Connections that succeeded" value={data.attempts ? `${data.success_rate}%` : "—"}
          foot={`${compact(data.connected)} of ${compact(data.attempts)} attempts`} />
        <Figure label="Needed the relay" value={data.connected ? `${data.relayed_pct}%` : "—"} foot="Of successful connections" />
        <Figure label="Time to connect" value={data.median_connect_ms ? `${(data.median_connect_ms / 1000).toFixed(1)}s` : "—"}
          foot={data.median_rtt_ms ? `Median · ${data.median_rtt_ms} ms round trip` : "Median"} />
        <Figure label="Moved" value={bytes(t.bytes)} foot={`${compact(t.files)} files in ${compact(t.count)} transfers`} />
      </div>

      <div className="mt-5 grid lg:grid-cols-2 gap-6 [&>*]:min-w-0">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-1">Connection success rate</p>
          <TrendChart points={points} unit={data.unit} tz={tz} label="Success rate" height={180} format={(n) => `${n}%`} />
        </div>
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3">
            <Figure label="Direct speed" value={t.direct_n ? `${t.direct_mbps} MB/s` : "—"} foot={`Median of ${t.direct_n} transfers ≥1 MB`} />
            <Figure label="Relayed speed" value={t.relay_n ? `${t.relay_mbps} MB/s` : "—"} foot={`Median of ${t.relay_n} transfers ≥1 MB`} />
          </div>
          <div>
            <div className="flex items-baseline justify-between mb-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Relayed data this range</p>
              <p className="text-[11px] text-gray-500">Cloudflare: 1,000 GB/month free, then $0.05/GB</p>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex-1 h-2 rounded-full bg-blue-950/60 overflow-hidden" title={`${relayGB.toFixed(2)} GB of 1,000 GB`}>
                <div className="h-full rounded-full" style={{ width: `${Math.min(100, relayGB / 10)}%`, minWidth: relayGB > 0 ? 4 : 0, background: ACCENT }} />
              </div>
              <span className="text-xs tabular-nums text-gray-200">{bytes(t.relay_bytes)}</span>
            </div>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5">How peers connected</p>
            <BarList rows={data.routes} empty="No successful connections yet." />
          </div>
        </div>
      </div>

      <div className="mt-5 grid sm:grid-cols-3 gap-6 [&>*]:min-w-0">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5">Why connections failed</p>
          <BarList rows={[
            { key: "No direct path (relay fixes)", n: data.failed_with_stun },
            { key: "STUN unreachable", n: data.failed_no_stun },
          ]} empty="No failures in this range." />
          {data.fail_browsers.length > 0 && (
            <p className="mt-2 text-[11px] text-gray-500">Failed on: {data.fail_browsers.map((b) => `${b.key} (${b.n})`).join(", ")}</p>
          )}
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5">Share size</p>
          <BarList rows={data.sizes} empty="No shares yet." />
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5">Files per share</p>
          <BarList rows={data.file_counts} empty="No shares yet." />
        </div>
      </div>
    </Card>
  );
}
