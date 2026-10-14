"use client";

import { useState } from "react";
import { Badge, Meter } from "@/components/ui";
import { RELAY_PRICING, relayPricingCopy } from "../shared";
import { C, SeriesTable, TableToggle, TrendChart, bucketLabel, compact } from "./charts";
import { Card, CardTitle, Eyebrow, Figure } from "./ui";

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

/** Horizontal bars for a short ranked list (single series, one hue); the value is always printed. */
export function BarList({ rows, format = compact, empty = "No data yet.", label }: {
  rows: { key: string; n: number; icon?: React.ReactNode }[]; format?: (n: number) => string; empty?: string; label?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  if (!rows.some((r) => r.n)) return <p className="py-4 text-caption text-text-secondary">{empty}</p>;
  return (
    <ul className="flex flex-col gap-1" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key} className="relative flex h-8 min-w-0 items-center justify-between gap-3 px-2 text-caption">
          <span aria-hidden className="absolute inset-y-0.5 left-0 rounded-sm" style={{ width: `${(r.n / max) * 100}%`, background: C.wash }} />
          <span className="relative flex min-w-0 items-center gap-2 truncate text-text">{r.icon}<span className="truncate">{r.key}</span></span>
          <span className="relative shrink-0 font-semibold tabular-nums text-text">{format(r.n)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Two-series stacked columns (the emphasis series in `chart-1`, the rest `chart-other`), with a
 *  legend, per-column hover/focus and a table view. */
function StackedColumns({ series, unit, tz, labels }: {
  series: { t: string; a: number; b: number }[]; unit: string; tz: string; labels: [string, string];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const H = 120;
  const max = Math.max(1, ...series.map((s) => s.a + s.b));
  const every = Math.max(1, Math.ceil(series.length / 6));
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-4 text-micro text-text-secondary">
          <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-2.5 rounded-xs" style={{ background: C.series }} />{labels[0]}</span>
          <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-2.5 rounded-xs" style={{ background: C.other }} />{labels[1]}</span>
        </div>
        <TableToggle table={table} onToggle={() => setTable((t) => !t)} />
      </div>
      {table ? (
        <SeriesTable label={labels.map((l) => l.charAt(0).toUpperCase() + l.slice(1))}
          rows={series.map((s) => ({ period: bucketLabel(s.t, unit, tz, true), values: [String(s.a), String(s.b)] }))} />
      ) : (
        <div className="relative">
          <div className="flex items-end gap-0.5 border-b border-border" style={{ height: H }} onPointerLeave={() => setHover(null)}>
            {series.map((s, i) => {
              const ha = (s.a / max) * (H - 4);
              const hb = (s.b / max) * (H - 4);
              return (
                <div key={s.t} className="md-focus relative flex h-full flex-1 cursor-default flex-col items-center justify-end rounded-xs"
                  onPointerEnter={() => setHover(i)} tabIndex={0} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                  role="img" aria-label={`${bucketLabel(s.t, unit, tz, true)}: ${s.a} ${labels[0]}, ${s.b} ${labels[1]}`}>
                  <div className="flex w-full max-w-6 flex-col justify-end gap-0.5" style={{ opacity: hover === null || hover === i ? 1 : 0.55 }}>
                    {s.a > 0 && <div className="w-full rounded-t-sm" style={{ height: ha, background: C.series }} />}
                    {s.b > 0 && <div className={`w-full ${s.a > 0 ? "" : "rounded-t-sm"}`} style={{ height: hb, background: C.other }} />}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-1 flex gap-0.5" aria-hidden>
            {series.map((s, i) => (
              <div key={s.t} className="flex-1 overflow-visible whitespace-nowrap text-center text-micro text-text-muted">
                {i % every === 0 ? bucketLabel(s.t, unit, tz) : ""}
              </div>
            ))}
          </div>
          {hover !== null && series[hover] && (
            <div aria-hidden className="pointer-events-none absolute -top-2 rounded-lg border border-border-strong bg-surface-raised px-2.5 py-1.5 text-micro shadow-md"
              style={{ left: `${Math.min(70, (hover / Math.max(1, series.length - 1)) * 100)}%` }}>
              <p className="mb-0.5 text-text-secondary">{bucketLabel(series[hover].t, unit, tz, true)}</p>
              <p className="flex items-center gap-1.5 text-text"><span className="h-0.5 w-3" style={{ background: C.series }} /><b>{series[hover].a}</b> {labels[0]}</p>
              <p className="flex items-center gap-1.5 text-text"><span className="h-0.5 w-3" style={{ background: C.other }} /><b>{series[hover].b}</b> {labels[1]}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Growth loop ───────────────────────────────────────────────────────────────

const LOOP_KEYS = new Set(["shared_doc", "shared_files"]);

export function GrowthCard({ data, tz }: { data: Growth; tz: string }) {
  const maxConv = Math.max(1, ...data.groups.map((g) => g.conversion));
  return (
    <Card aria-labelledby="growth-h">
      <CardTitle id="growth-h" title="Growth loop"
        sub="Do readers become writers? Everyone who first arrived in this range, by what they arrived on. Not affected by filters." />
      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
        <Figure accent label="Creators who arrived via someone's link" value={`${data.loop_share}%`}
          foot={`${data.groups.filter((g) => LOOP_KEYS.has(g.key)).reduce((n, g) => n + g.creators, 0)} of ${data.creators} new creators`} />
        <Figure label="New visitors who published" value={`${data.conversion}%`} foot={`${compact(data.creators)} of ${compact(data.new_visitors)}`} />
        <Figure label="Published on their first visit" value={`${data.activation}%`} foot="Activation" />
        <Figure label="Typical time to first publish" value={span(data.median_to_create_s)} foot="Median, from first visit" />
      </div>

      <div className="mt-5 grid gap-6 lg:grid-cols-[1.1fr_1fr] [&>*]:min-w-0">
        <div className="overflow-x-auto">
          <table className="w-full text-caption">
            <caption className="md-visually-hidden">New visitors by what they arrived on</caption>
            <thead>
              <tr className="text-left text-text-secondary">
                <th scope="col" className="pb-2 font-medium">Arrived on</th>
                <th scope="col" className="px-2 pb-2 text-right font-medium">New</th>
                <th scope="col" className="w-[45%] pb-2 pl-3 font-medium">Went on to publish</th>
                <th scope="col" className="pb-2 pl-2 text-right font-medium">1st visit</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {data.groups.map((g) => {
                const loop = LOOP_KEYS.has(g.key);
                return (
                  <tr key={g.key} className="border-t border-border">
                    <td className="whitespace-nowrap py-2.5 text-text">
                      {g.label}{loop && <Badge size="sm" tone="info" className="ml-2">Loop</Badge>}
                    </td>
                    <td className="px-2 py-2.5 text-right text-text-secondary">{compact(g.visitors)}</td>
                    <td className="py-2.5 pl-3">
                      <div className="flex items-center gap-2">
                        <div aria-hidden className="hidden h-2 flex-1 overflow-hidden rounded-full sm:block" style={{ background: C.track }}>
                          <div className="h-full rounded-full" style={{ width: `${(g.conversion / maxConv) * 100}%`, background: loop ? C.series : C.other }} />
                        </div>
                        <span className="ml-auto w-24 shrink-0 whitespace-nowrap text-right"><b className="text-text">{g.conversion}%</b> <span className="text-text-secondary">({g.creators})</span></span>
                      </div>
                    </td>
                    <td className="py-2.5 pl-2 text-right text-text-secondary">{g.activation}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-micro text-text-secondary">
            Rows marked Loop are someone else&apos;s document or file link reaching a new person.
          </p>
        </div>
        <div>
          <Eyebrow>New creators</Eyebrow>
          <StackedColumns series={data.series.map((s) => ({ t: s.t, a: s.loop, b: s.other }))} unit={data.unit} tz={tz}
            labels={["via a shared link", "other"]} />
        </div>
      </div>
    </Card>
  );
}

// ── File sharing (Product health) ─────────────────────────────────────────────

export function ShareHealthCard({ data, tz, right }: { data: Shares; tz: string; right?: React.ReactNode }) {
  const t = data.transfers;
  const relayGB = t.relay_bytes / 2 ** 30;
  const points = data.series.map((s) => ({ t: s.t, v: s.attempts ? Math.round((100 * s.connected) / s.attempts) : 0 }));
  return (
    <Card aria-labelledby="sharing-h">
      <CardTitle id="sharing-h" title="File sharing" sub="Peer-to-peer connections and transfers in this range. Not affected by filters." right={right} />
      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
        <Figure accent label="Connections that succeeded" value={data.attempts ? `${data.success_rate}%` : "—"}
          foot={`${compact(data.connected)} of ${compact(data.attempts)} attempts`} />
        <Figure label="Needed the relay" value={data.connected ? `${data.relayed_pct}%` : "—"} foot="Of successful connections" />
        <Figure label="Time to connect" value={data.median_connect_ms ? `${(data.median_connect_ms / 1000).toFixed(1)}s` : "—"}
          foot={data.median_rtt_ms ? `Median · ${data.median_rtt_ms} ms round trip` : "Median"} />
        <Figure label="Moved" value={bytes(t.bytes)} foot={`${compact(t.files)} files in ${compact(t.count)} transfers`} />
      </div>

      <div className="mt-5 grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <div>
          <Eyebrow>Connection success rate</Eyebrow>
          <TrendChart points={points} unit={data.unit} tz={tz} label="Success rate" height={180} format={(n) => `${n}%`} />
        </div>
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
            <Figure label="Direct speed" value={t.direct_n ? `${t.direct_mbps} MB/s` : "—"} foot={`Median of ${t.direct_n} transfers of 1 MB or more`} />
            <Figure label="Relayed speed" value={t.relay_n ? `${t.relay_mbps} MB/s` : "—"} foot={`Median of ${t.relay_n} transfers of 1 MB or more`} />
          </div>
          <div>
            <Meter
              label="Relayed data this range"
              value={Math.min(relayGB, RELAY_PRICING.freeGbPerMonth)}
              max={RELAY_PRICING.freeGbPerMonth}
              threshold={RELAY_PRICING.warnAt}
              meta={<span className="tabular-nums">{bytes(t.relay_bytes)} of {RELAY_PRICING.freeGbPerMonth.toLocaleString("en")} GB</span>}
              valueText={`${relayGB.toFixed(2)} GB of the ${RELAY_PRICING.freeGbPerMonth.toLocaleString("en")} GB monthly allowance`}
            />
            <p className="mt-1.5 text-micro text-text-secondary">
              {relayPricingCopy()}. Warning tone from {Math.round(RELAY_PRICING.warnAt * 100)}% of the allowance.
            </p>
          </div>
          <div>
            <Eyebrow>How peers connected</Eyebrow>
            <BarList rows={data.routes} empty="No successful connections yet." label="How peers connected" />
          </div>
        </div>
      </div>

      <div className="mt-5 grid gap-6 sm:grid-cols-3 [&>*]:min-w-0">
        <div>
          <Eyebrow>Why connections failed</Eyebrow>
          <BarList label="Why connections failed" rows={[
            { key: "No direct path (the relay fixes these)", n: data.failed_with_stun },
            { key: "STUN unreachable", n: data.failed_no_stun },
          ]} empty="No failures in this range." />
          {data.fail_browsers.length > 0 && (
            <p className="mt-2 text-micro text-text-secondary">Failed on: {data.fail_browsers.map((b) => `${b.key} (${b.n})`).join(", ")}</p>
          )}
        </div>
        <div>
          <Eyebrow>Share size</Eyebrow>
          <BarList rows={data.sizes} empty="No shares yet." label="Share size" />
        </div>
        <div>
          <Eyebrow>Files per share</Eyebrow>
          <BarList rows={data.file_counts} empty="No shares yet." label="Files per share" />
        </div>
      </div>
    </Card>
  );
}
