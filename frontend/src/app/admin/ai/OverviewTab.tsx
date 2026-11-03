"use client";

import { useMemo, useState } from "react";
import { StatTile } from "@/components/kit/StatTile";
import { Alert, Badge, Button, Meter, Progress, SegmentedControl, Table, type Column } from "@/components/ui";
import { Card, CardError, CardSkeleton, CardTitle } from "../analytics/ui";
import { plural } from "../shared";
import { DailyByFeature, type DayRow, type Metric } from "./charts";
import {
  LIMIT_LABEL, RANGE_OPTIONS, capText, featureColor, n0, pct, tokensShort, usd, useAiFetch, useLoad, type RangeKey,
} from "./common";

/** Admin → AI → Overview: every AI feature against its caps and the all-AI cap, and the trend. */

type Tok = { input: number; output: number; cache_read: number; cache_write: number };
interface Agg { requests: number; ok: number; errors: number; limited: number; cost_usd: number; tokens: Tok; total_tokens: number; cache_hit_pct: number | null }
export interface FeatureRow extends Agg {
  key: string; label: string; registered: boolean; enabled: boolean; config_enabled: boolean;
  today_usd: number; month_usd: number; daily_cap_usd: number | null; monthly_cap_usd: number | null; users: number;
}
interface Overview {
  range: RangeKey; configured: boolean; truncated: boolean;
  global: { today_usd: number; month_usd: number; daily_cap_usd: number | null; monthly_cap_usd: number | null };
  kpis: Agg & { users: number; anonymous_requests: number };
  features: FeatureRow[];
  limit_reasons: { feature: string; reason: string; n: number }[];
  series: (DayRow & { t: string; requests: number; cost_usd: number; tokens: number })[];
}

/** A spend meter against a cap; with no cap, just the amount. */
export function SpendMeter({ label, value, cap, size = "md" }: { label: string; value: number; cap: number | null; size?: "sm" | "md" }) {
  if (cap === null) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2 text-caption">
          <span className="text-text-secondary">{label}</span>
          <span className="tabular-nums text-text">{usd(value)} <span className="text-text-muted">· no cap</span></span>
        </div>
        <div className="h-1.5 w-full rounded-full" style={{ background: "var(--chart-track)" }} />
      </div>
    );
  }
  return (
    <Meter size={size} label={label} value={value} max={cap || 0.000001} threshold={0.8}
      meta={`${usd(value)} of ${usd(cap)}`} valueText={`${usd(value)} of ${usd(cap)} cap`} />
  );
}

export function OverviewTab({ token, onOpenUser, onGo }: { token: string; onOpenUser: (id: string) => void; onGo: (t: "budgets" | "users") => void }) {
  const get = useAiFetch(token);
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const [range, setRange] = useState<RangeKey>("30d");
  const [bump, setBump] = useState(0);
  const [metric, setMetric] = useState<Metric>("cost");
  const ov = useLoad(() => get<Overview>("usage/overview", { range, tz }), [get, range, tz, bump]);
  const top = useLoad(() => get<{ items: { user_id: string; email: string; name: string; cost_usd: number; requests: number; anonymous: boolean }[] }>(
    "usage/users", { range, sort: "cost", limit: 5 }), [get, range, bump]);
  const o = ov.data;
  const k = o?.kpis;
  const used = o ? o.features.filter((f) => f.registered || f.requests > 0) : [];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-body text-text-secondary">Spend comes from each request&apos;s real usage (cache and long-context pricing included). Days and months are UTC.</p>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl<RangeKey> size="sm" aria-label="Date range" value={range} onChange={setRange} options={RANGE_OPTIONS} />
          <Button size="sm" variant="secondary" iconLeft="refresh" onClick={() => setBump((b) => b + 1)}>Refresh</Button>
        </div>
      </div>
      {o && !o.configured && (
        <Alert tone="warning" title="AI isn't configured">Set <code>MARKDROP_ANTHROPIC_API_KEY</code> on the API server. Until then no AI feature calls the model.</Alert>
      )}
      {o?.truncated && <Alert tone="info">This range has more requests than the summary reads at once. Pick a shorter range for exact totals.</Alert>}
      {ov.loading && o && <Progress indeterminate size="sm" aria-label="Updating" valueText="Loading" />}

      {ov.error && !o ? <CardError title="AI usage" onRetry={ov.reload} /> : (
        <>
          {!o ? <CardSkeleton title="Spend" height={200} /> : (
            <Card aria-labelledby="ai-spend-h">
              <CardTitle id="ai-spend-h" title="Spend against the caps"
                sub="A feature stops (and says why) when it reaches its own cap or the all-AI cap."
                right={<Button size="sm" variant="ghost" iconRight="arrowRight" onClick={() => onGo("budgets")}>Edit budgets</Button>} />
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <section aria-label="All AI features" className="flex flex-col gap-3 rounded-lg border border-border bg-surface-inset p-3.5">
                  <p className="text-body-strong text-text">All AI features</p>
                  <SpendMeter label="Today" value={o.global.today_usd} cap={o.global.daily_cap_usd} />
                  <SpendMeter label="This month" value={o.global.month_usd} cap={o.global.monthly_cap_usd} />
                </section>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  {used.map((f) => (
                    <section key={f.key} aria-label={f.label} className="flex flex-col gap-3 rounded-lg border border-border p-3.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="inline-flex min-w-0 items-center gap-1.5 truncate text-body-strong text-text">
                          <span aria-hidden className="size-2.5 shrink-0 rounded-xs" style={{ background: featureColor(f.key) }} />{f.label}
                        </p>
                        <Badge size="sm" dot tone={f.enabled ? "success" : "warning"}>{f.enabled ? "On" : "Off"}</Badge>
                      </div>
                      <SpendMeter size="sm" label="Today" value={f.today_usd} cap={f.daily_cap_usd} />
                      <SpendMeter size="sm" label="Month" value={f.month_usd} cap={f.monthly_cap_usd} />
                    </section>
                  ))}
                </div>
              </div>
            </Card>
          )}

          <section aria-label="Key numbers" className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
            <StatTile size="md" icon="chart" loading={!k} label="Cost" value={k ? usd(k.cost_usd) : ""}
              caption={k ? `${usd(k.requests ? k.cost_usd / k.requests : null)} per request` : undefined} />
            <StatTile size="md" icon="message" loading={!k} label="Requests" value={k ? n0(k.requests) : ""}
              caption={k ? `${plural(k.users, "person", "people")} signed in · ${n0(k.anonymous_requests)} anonymous` : undefined} />
            <StatTile size="md" icon="hash" loading={!k} label="Tokens" value={k ? tokensShort(k.total_tokens) : ""}
              caption={k ? `${tokensShort(k.tokens.input + k.tokens.cache_read + k.tokens.cache_write)} in (cache included) · ${tokensShort(k.tokens.output)} out` : undefined} />
            <StatTile size="md" icon="layers" loading={!k} label="Cache hit rate" value={k ? pct(k.cache_hit_pct) : ""}
              caption={k ? `${tokensShort(k.tokens.cache_read)} read · ${tokensShort(k.tokens.cache_write)} written` : undefined} />
          </section>

          {!o ? <CardSkeleton title="Daily" height={240} /> : (
            <Card aria-labelledby="ai-daily-all-h">
              <CardTitle id="ai-daily-all-h" title="Daily, by feature" sub={metric === "cost" ? "Spend each day, in US dollars" : "Requests each day, including refused ones"}
                right={<SegmentedControl<Metric> size="sm" aria-label="Metric" value={metric} onChange={setMetric}
                  options={[{ value: "cost", label: "Cost" }, { value: "requests", label: "Requests" }]} />} />
              <DailyByFeature series={o.series} features={used.map((f) => ({ key: f.key, label: f.label }))} metric={metric} />
            </Card>
          )}

          {o ? <FeaturesTable rows={used} /> : <CardSkeleton title="By feature" />}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Card aria-labelledby="ai-top-h">
              <CardTitle id="ai-top-h" title="Top spenders" sub="In this range"
                right={<Button size="sm" variant="ghost" iconRight="arrowRight" onClick={() => onGo("users")}>All users</Button>} />
              {!top.data ? <CardSkeleton height={160} /> : top.data.items.length === 0 ? <p className="py-3 text-caption text-text-secondary">No AI use in this range.</p> : (
                <ul className="flex flex-col divide-y divide-border">
                  {top.data.items.map((u) => (
                    <li key={u.user_id}>
                      <button type="button" className="md-focus flex w-full min-w-0 items-center justify-between gap-3 rounded-sm py-2 text-left" onClick={() => onOpenUser(u.user_id)}>
                        <span className="min-w-0">
                          <span className="block truncate text-body text-text">{u.anonymous ? "Anonymous visitors" : u.email || u.name || "Deleted account"}</span>
                          <span className="block text-micro text-text-muted">{plural(u.requests, "request")}</span>
                        </span>
                        <span className="shrink-0 text-body-strong tabular-nums text-text">{usd(u.cost_usd)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            {!o ? <CardSkeleton title="Refused requests" /> : (
              <Card aria-labelledby="ai-limits-h">
                <CardTitle id="ai-limits-h" title="Refused requests" sub="Requests a cap, a limit or a switch stopped before the model was called" />
                {o.limit_reasons.length === 0 ? <p className="py-3 text-caption text-text-secondary">Nothing refused in this range.</p> : (
                  <ul className="flex flex-col divide-y divide-border">
                    {o.limit_reasons.slice(0, 10).map((r) => (
                      <li key={`${r.feature}:${r.reason}`} className="flex items-center justify-between gap-3 py-2 text-caption">
                        <span className="inline-flex min-w-0 items-center gap-2">
                          <span aria-hidden className="size-2.5 shrink-0 rounded-xs" style={{ background: featureColor(r.feature) }} />
                          <span className="truncate text-text">{LIMIT_LABEL[r.reason] ?? r.reason}</span>
                          <span className="truncate text-text-muted">{o.features.find((f) => f.key === r.feature)?.label ?? r.feature}</span>
                        </span>
                        <span className="shrink-0 font-semibold tabular-nums text-text">{n0(r.n)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function FeaturesTable({ rows }: { rows: FeatureRow[] }) {
  const cols: Column<FeatureRow>[] = [
    { key: "f", header: "Feature", primary: true, render: (f) => (
      <span className="inline-flex items-center gap-2 whitespace-nowrap"><span aria-hidden className="size-2.5 rounded-xs" style={{ background: featureColor(f.key) }} />{f.label}</span>
    ) },
    { key: "req", header: "Requests", align: "right", render: (f) => n0(f.requests) },
    { key: "users", header: "People", align: "right", render: (f) => n0(f.users) },
    { key: "tok", header: "Tokens in / out", align: "right", render: (f) => `${tokensShort(f.tokens.input + f.tokens.cache_read + f.tokens.cache_write)} / ${tokensShort(f.tokens.output)}` },
    { key: "cache", header: "Cache hit", align: "right", render: (f) => pct(f.cache_hit_pct) },
    { key: "err", header: "Errors", align: "right", render: (f) => (f.errors ? <span className="text-danger-text">{n0(f.errors)}</span> : "0") },
    { key: "lim", header: "Refused", align: "right", render: (f) => n0(f.limited) },
    { key: "cost", header: "Cost", align: "right", render: (f) => usd(f.cost_usd) },
    { key: "cap", header: "Daily cap", align: "right", render: (f) => capText(f.daily_cap_usd) },
  ];
  return (
    <Card aria-labelledby="ai-features-h">
      <CardTitle id="ai-features-h" title="By feature" sub="Requests, tokens and cost in this range" />
      <Table compact hover={false} columns={cols} rows={rows} rowKey={(f) => f.key} caption="AI usage by feature" />
    </Card>
  );
}
