"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StatTile } from "@/components/kit/StatTile";
import {
  Badge, Button, Drawer, Icon, IconButton, Progress, Select, Switch, Table, Tabs, Tag, Tooltip, type Column,
} from "@/components/ui";
import { setTrackingDisabled, trackingDisabled } from "@/lib/track";
import { PageHead, LoadingBlock } from "../shared";
import { C, Sparkline, TableToggle, TrendChart, bucketLabel, compact, heat } from "./charts";
import { RangePicker, rangeParams, rangeVs, useAdminFetch, type RangeValue } from "./controls";
import { GrowthCard, type Growth } from "./sections";
import { Card, CardError, CardSkeleton, CardTitle, Eyebrow, deltaOf } from "./ui";

// ── Types ─────────────────────────────────────────────────────────────────────

type Kpis = {
  visitors: number; pageviews: number; sessions: number; views_per_session: number;
  bounce_rate: number; avg_duration_s: number; new_visitors: number; returning_visitors: number;
  signed_in_visitors: number;
};
type Row = { key: string | null; visitors: number; pageviews?: number; sessions?: number; bounce_rate?: number };
type Overview = {
  range: { since: string; until: string; unit: string; tz: string };
  kpis: Kpis; prev: Kpis;
  series: { t: string; visitors: number; pageviews: number; sessions: number }[];
  breakdowns: Record<string, Row[]>;
};
type Metric = { total: number; prev?: number; series?: { t: string; n: number }[] };
type Product = { range: { unit: string }; metrics: Record<string, Metric> };
type Doc = { doc_id: string; slug: string | null; title: string | null; encrypted: boolean; kind: string; views: number; visitors: number; referrers: { host: string; views: number }[]; reads: number; avg_seconds: number; finished: number };
type Docs = { documents: Doc[]; referrers: { host: string; views: number }[] };
type Realtime = { visitors: number; pages: { key: string; n: number }[]; sources: { key: string; n: number }[]; recent: { path: string; country: string | null; city: string | null; device: string | null; channel: string | null; ts: string }[] };
type EventsRes = { events: { name: string; count: number; visitors: number }[]; props?: Record<string, { value: string; n: number }[]> };
type Step = { t: "visit" | "page" | "event"; v?: string };
type FunnelRes = { steps: (Step & { visitors: number; from_start: number; from_prev: number })[] };
type Retention = { cohorts: { week: string; size: number; cells: { n: number; pct: number }[] }[] };

export type Filters = Record<string, string>;
type Get = <T>(p: string, q: Record<string, string | undefined>) => Promise<T>;

const FILTER_LABELS: Record<string, string> = {
  page: "Page", entry: "Entry page", host: "Host", channel: "Channel", ref: "Referrer",
  utm_source: "UTM source", utm_medium: "UTM medium", utm_campaign: "Campaign",
  country: "Country", city: "City", device: "Device", os: "OS", browser: "Browser",
};

const FUNNEL_PRESETS: { label: string; steps: Step[] }[] = [
  { label: "Visit → write → publish", steps: [{ t: "visit" }, { t: "page", v: "/new" }, { t: "event", v: "doc_published" }] },
  { label: "Visit → upload artifact", steps: [{ t: "visit" }, { t: "page", v: "/upload" }, { t: "event", v: "artifact_uploaded" }] },
  { label: "Visit → sign in", steps: [{ t: "visit" }, { t: "page", v: "/login" }, { t: "event", v: "logged_in" }] },
  { label: "Visit → send files", steps: [{ t: "visit" }, { t: "page", v: "/share" }, { t: "event", v: "share_started" }] },
  { label: "Open share link → download", steps: [{ t: "page", v: "/share/[id]" }, { t: "event", v: "share_download" }] },
  { label: "Guides: new site → publish", steps: [{ t: "page", v: "/guides/new" }, { t: "event", v: "guide_created" }, { t: "event", v: "guide_publish_requested" }] },
];

const EVENT_LABELS: Record<string, string> = {
  doc_published: "Document published", builder_published: "README builder published",
  artifact_uploaded: "Artifact uploaded", logged_in: "Signed in", workspace_created: "Workspace created",
  google_docs_export: "Exported to Google Docs", vscode_connected: "VS Code connected",
  share_started: "File share started", share_files_added: "Files added to a share",
  share_download: "Shared files downloaded", doc_copy_link: "Document link copied",
  doc_export_pdf: "Document exported to PDF",
  hero_play: "Played the hero",
  hero_found: "Found a hero feature",
  hero_finale: "Reached the hero finale",
  landing_cta: "Landing call to action clicked",
  toy_play: "Played a landing toy",
  toy_done: "Finished a landing toy",
  // Markdrop Guides (lib/guidesEvents)
  guide_created: "Guides · site created",
  guide_import_started: "Guides · import started",
  guide_page_created: "Guides · page created",
  guide_page_deleted: "Guides · page deleted",
  guide_page_restored: "Guides · page version restored",
  guide_publish_requested: "Guides · publish requested",
  guide_review_submitted: "Guides · review submitted",
  guide_review_approved: "Guides · review approved",
  guide_review_changes_requested: "Guides · changes requested",
  guide_review_withdrawn: "Guides · review withdrawn",
  guide_restored: "Guides · earlier publish restored",
  guide_design_saved: "Guides · design saved",
  guide_renamed: "Guides · site renamed",
  guide_address_changed: "Guides · address changed",
  guide_ask_ai_toggled: "Guides · Ask AI turned on/off",
  guide_ask_ai_renamed: "Guides · Ask AI renamed",
  guide_ask_ai_questions: "Guides · suggested questions changed",
  guide_access_changed: "Guides · access changed",
  guide_indexing_changed: "Guides · search indexing changed",
  guide_reviews_required: "Guides · review rule changed",
  guide_redirects_saved: "Guides · redirects saved",
  guide_member_role_changed: "Guides · member role changed",
  guide_unpublished: "Guides · site unpublished",
  guide_deleted: "Guides · site deleted",
  guide_domain_added: "Guides · own domain added",
  guide_domain_removed: "Guides · own domain removed",
  guide_domain_live: "Guides · own domain went live",
};

const METRIC_LABEL = { visitors: "Visitors", pageviews: "Page views", sessions: "Sessions" } as const;
type MetricKey = keyof typeof METRIC_LABEL;

const regionNames = typeof Intl !== "undefined" && "DisplayNames" in Intl
  ? new Intl.DisplayNames(["en"], { type: "region" }) : null;
function countryName(code: string | null) {
  if (!code) return "Unknown";
  try { return regionNames?.of(code) ?? code; } catch { return code; }
}

function duration(s: number) {
  if (!s) return "0s";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function ago(iso: string) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

function stepLabel(s: Step) {
  if (s.t === "visit") return "Any visit";
  if (s.t === "page") return `Viewed ${s.v}`;
  return EVENT_LABELS[s.v ?? ""] ?? s.v ?? "";
}

// ── Data: one request per card, settled independently ─────────────────────────

type Slot<T> = { data?: T; error?: boolean };
type Cards = { overview: Slot<Overview>; product: Slot<Product>; documents: Slot<Docs>; events: Slot<EventsRes>; growth: Slot<Growth> };
type CardKey = keyof Cards;
const FILTERED: Record<CardKey, boolean> = { overview: true, product: false, documents: false, events: true, growth: false };

// ── Panel ─────────────────────────────────────────────────────────────────────

export default function AnalyticsPanel({ token, range, onRange, filters, onFilters, onOpenHealth }: {
  token: string;
  range: RangeValue; onRange: (r: RangeValue) => void;
  filters: Filters; onFilters: (f: Filters) => void;
  onOpenHealth: () => void;
}) {
  const get = useAdminFetch(token);
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const [metric, setMetric] = useState<MetricKey>("visitors");
  const [cards, setCards] = useState<Cards>({ overview: {}, product: {}, documents: {}, events: {}, growth: {} });
  const [retention, setRetention] = useState<Slot<Retention>>({});
  const [live, setLive] = useState<Realtime | null>(null);
  const [loading, setLoading] = useState(true);
  const [excluded, setExcluded] = useState(false);
  const [tick, setTick] = useState(0);
  const [sheet, setSheet] = useState(false);

  useEffect(() => setExcluded(trackingDisabled()), []);

  const fKey = JSON.stringify(filters);
  const params = useMemo(() => ({
    ...rangeParams(range, tz),
    filters: Object.keys(filters).length ? fKey : undefined,
  }), [range, tz, fKey, filters]);

  const fetchCard = useCallback(<K extends CardKey>(key: K) => {
    const { filters: _f, ...unfiltered } = params; // product, documents and growth ignore traffic filters
    return get<NonNullable<Cards[K]["data"]>>(key, FILTERED[key] ? params : unfiltered);
  }, [get, params]);

  // Range or filter change: keep the current data on screen, show an indeterminate bar, and settle
  // each card on its own (one failing endpoint never blanks the page).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const keys: CardKey[] = ["overview", "product", "documents", "events", "growth"];
    Promise.allSettled(keys.map((k) => fetchCard(k))).then((results) => {
      if (cancelled) return;
      setCards((prev) => {
        const next = { ...prev } as Cards;
        results.forEach((r, i) => {
          const k = keys[i];
          (next as Record<CardKey, Slot<unknown>>)[k] = r.status === "fulfilled" ? { data: r.value } : { data: prev[k].data, error: true };
        });
        return next;
      });
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [fetchCard, tick]);

  const retry = (k: CardKey) => {
    fetchCard(k)
      .then((d) => setCards((c) => ({ ...c, [k]: { data: d } })))
      .catch(() => setCards((c) => ({ ...c, [k]: { ...c[k], error: true } })));
  };

  const loadRetention = useCallback(() => {
    get<Retention>("retention", { tz, weeks: "8" }).then((d) => setRetention({ data: d })).catch(() => setRetention((r) => ({ ...r, error: true })));
  }, [get, tz]);
  useEffect(() => { loadRetention(); }, [loadRetention, tick]);

  // Realtime: every 15s, paused while the tab is hidden, refreshed as soon as it's visible again.
  useEffect(() => {
    let alive = true;
    const load = () => { if (document.hidden) return; get<Realtime>("realtime", {}).then((r) => alive && setLive(r)).catch(() => {}); };
    load();
    const id = setInterval(load, 15_000);
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { alive = false; clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [get]);

  const addFilter = (k: string, v: string | null) => onFilters({ ...filters, [k]: v ?? "(none)" });
  const removeFilter = (k: string) => { const n = { ...filters }; delete n[k]; onFilters(n); };
  const nFilters = Object.keys(filters).length;
  const vs = rangeVs(range);

  const o = cards.overview.data;
  const chips = Object.entries(filters).map(([k, v]) => (
    <Tag key={k} onRemove={() => removeFilter(k)} removeLabel={`Remove ${FILTER_LABELS[k] ?? k} filter`}>
      <span className="text-text-secondary">{FILTER_LABELS[k] ?? k}</span>&nbsp;
      <span className="max-w-56 truncate font-medium">{k === "country" ? countryName(v) : v === "(none)" ? "none" : v}</span>
    </Tag>
  ));
  const exclude = (
    <span className="inline-flex items-center gap-1.5">
      <Switch label="Exclude my visits" checked={excluded} onChange={() => { setTrackingDisabled(!excluded); setExcluded(!excluded); }} />
      <Tooltip side="left" content="Stops this browser from being counted. Your own visits skew a small site's numbers." focusable>
        <span className="inline-flex text-text-muted"><Icon name="info" size={16} /><span className="md-visually-hidden">About excluding your visits</span></span>
      </Tooltip>
    </span>
  );
  const liveBadge = live !== null && (
    <Badge tone={live.visitors > 0 ? "success" : "neutral"} live={live.visitors > 0} dot={live.visitors === 0} className="tabular-nums">
      {live.visitors} online
    </Badge>
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHead title="Overview" caption={`First-party visits and publishes across Markdrop, in your time zone (${tz}).`} />

      {/* Sticky filter bar (under the phone top bar below 1024px). */}
      <div className="sticky top-14 z-(--z-sticky) -mx-4 border-b border-border bg-bg px-4 py-2 sm:-mx-6 sm:px-6 lg:top-0 lg:-mx-8 lg:px-8">
        <div className="flex flex-wrap items-center gap-2">
          <RangePicker value={range} onChange={onRange} />
          <div className="hidden min-w-0 flex-wrap items-center gap-2 sm:flex">
            {chips}
            {nFilters > 0 && <Button variant="link" size="sm" onClick={() => onFilters({})}>Clear all</Button>}
            {nFilters === 0 && <span className="hidden text-caption text-text-muted md:inline">Choose any row below to filter the whole page</span>}
          </div>
          <Button variant="secondary" className="min-h-11 sm:hidden" iconLeft="filter" onClick={() => setSheet(true)} aria-haspopup="dialog">
            Filters{nFilters ? ` (${nFilters})` : ""}
          </Button>
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            {liveBadge}
            <span className="hidden sm:inline-flex">{exclude}</span>
            <IconButton icon="refresh" label="Refresh" variant="secondary" className="max-sm:hidden" onClick={() => setTick((t) => t + 1)} />
          </div>
        </div>
        {loading && o && <Progress indeterminate size="sm" className="mt-2" aria-label="Updating the overview" valueText="Loading" />}
      </div>

      <Drawer open={sheet} onClose={() => setSheet(false)} side="bottom" title="Filters"
        footer={<Button variant="primary" block onClick={() => setSheet(false)}>Done</Button>}>
        <div className="flex flex-col gap-4">
          {nFilters ? <div className="flex flex-wrap gap-2">{chips}</div> : <p className="text-body text-text-secondary">No filters. Choose any row on the page to filter by it.</p>}
          {nFilters > 0 && <Button variant="secondary" onClick={() => onFilters({})}>Clear all</Button>}
          {exclude}
          <Button variant="secondary" iconLeft="refresh" onClick={() => { setTick((t) => t + 1); setSheet(false); }}>Refresh data</Button>
        </div>
      </Drawer>

      {/* KPI tiles */}
      {cards.overview.error && !o ? (
        <CardError title="Visitors" onRetry={() => retry("overview")} />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-6">
          {(["visitors", "pageviews", "sessions"] as const).map((m) => (
            <StatTile key={m} size="md" loading={!o} label={METRIC_LABEL[m]}
              value={o ? compact(o.kpis[m]) : ""}
              delta={o ? deltaOf(o.kpis[m], o.prev[m], vs) : undefined}
              selected={metric === m} onSelect={() => setMetric(m)}
              caption={o ? (m === "visitors"
                ? (o.kpis.visitors ? `${Math.round((100 * o.kpis.new_visitors) / o.kpis.visitors)}% new · ${o.kpis.signed_in_visitors} signed in` : "No visitors yet")
                : m === "pageviews" ? `${o.kpis.views_per_session} per session` : `${o.kpis.returning_visitors} returning visitors`) : undefined}
              chart={o && o.series.length > 1 ? <span className="max-sm:hidden"><Sparkline values={o.series.map((p) => p[m])} width={72} height={24} /></span> : undefined}
            />
          ))}
          <StatTile size="md" loading={!o} label="Bounce rate" value={o ? `${o.kpis.bounce_rate}%` : ""}
            delta={o ? deltaOf(o.kpis.bounce_rate, o.prev.bounce_rate, vs, true) : undefined} caption="Sessions with one page view" />
          <StatTile size="md" loading={!o} label="Engaged time" value={o ? duration(o.kpis.avg_duration_s) : ""}
            delta={o ? deltaOf(o.kpis.avg_duration_s, o.prev.avg_duration_s, vs) : undefined} caption="Average visible time per session" />
          <StatTile size="md" label="Live now" value={live ? String(live.visitors) : "—"} caption="Visitors in the last 5 minutes" />
        </div>
      )}

      {/* Trend */}
      {!o ? (
        cards.overview.error ? null : <CardSkeleton title={METRIC_LABEL[metric]} height={230} />
      ) : (
        <Card aria-labelledby="trend-h">
          <CardTitle id="trend-h" title={`${METRIC_LABEL[metric]} over time`}
            sub={`${o.range.unit === "hour" ? "Per hour" : o.range.unit === "week" ? "Per week" : "Per day"} · ${tz}`}
            right={<Tabs variant="pill" size="sm" aria-label="Metric" value={metric} onChange={(v) => setMetric(v as MetricKey)}
              items={(Object.keys(METRIC_LABEL) as MetricKey[]).map((k) => ({ value: k, label: METRIC_LABEL[k] }))} />} />
          <TrendChart points={o.series.map((p) => ({ t: p.t, v: p[metric] }))} unit={o.range.unit} tz={tz} label={METRIC_LABEL[metric]} />
        </Card>
      )}

      {/* Breakdowns */}
      {o ? (
        <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
          <Breakdown title="Sources" onPick={addFilter} tabs={[
            { key: "channel", label: "Channels", filter: "channel", rows: o.breakdowns.channel, none: "Direct" },
            { key: "ref_host", label: "Referrers", filter: "ref", rows: o.breakdowns.ref_host, none: "Direct / none", favicon: true },
            { key: "utm_source", label: "UTM source", filter: "utm_source", rows: o.breakdowns.utm_source, none: "(not set)" },
            { key: "utm_medium", label: "Medium", filter: "utm_medium", rows: o.breakdowns.utm_medium, none: "(not set)" },
            { key: "utm_campaign", label: "Campaign", filter: "utm_campaign", rows: o.breakdowns.utm_campaign, none: "(not set)" },
          ]} />
          <Breakdown title="Pages" onPick={addFilter} tabs={[
            { key: "pages", label: "Top pages", filter: "page", rows: o.breakdowns.pages, mono: true },
            { key: "entry", label: "Entry pages", filter: "entry", rows: o.breakdowns.entry, mono: true, sessions: true },
            { key: "exit", label: "Exit pages", filter: "page", rows: o.breakdowns.exit, mono: true, sessions: true },
          ]} />
          <Breakdown title="Locations" onPick={addFilter} tabs={[
            { key: "country", label: "Countries", filter: "country", rows: o.breakdowns.country, render: (k) => (
              <span className="inline-flex items-center gap-2"><span className="w-7 font-mono text-micro text-text-muted">{k ?? "--"}</span>{countryName(k)}</span>
            ) },
            { key: "city", label: "Cities", filter: "city", rows: o.breakdowns.city, none: "Unknown" },
          ]} />
          <Breakdown title="Devices" onPick={addFilter} tabs={[
            { key: "device", label: "Device", filter: "device", rows: o.breakdowns.device },
            { key: "browser", label: "Browser", filter: "browser", rows: o.breakdowns.browser },
            { key: "os", label: "OS", filter: "os", rows: o.breakdowns.os },
            { key: "host", label: "Hosts", filter: "host", rows: o.breakdowns.host, mono: true },
          ]} />
        </div>
      ) : !cards.overview.error && (
        <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
          {["Sources", "Pages", "Locations", "Devices"].map((t) => <CardSkeleton key={t} title={t} height={260} />)}
        </div>
      )}

      {/* Product */}
      {cards.product.data ? <ProductSection product={cards.product.data} vs={vs} />
        : cards.product.error ? <CardError title="Product" onRetry={() => retry("product")} />
        : <CardSkeleton title="Product" height={110} />}

      {/* Growth loop */}
      {cards.growth.data ? <GrowthCard data={cards.growth.data} tz={tz} />
        : cards.growth.error ? <CardError title="Growth loop" onRetry={() => retry("growth")} />
        : <CardSkeleton title="Growth loop" height={260} />}

      <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
        {o ? <FunnelCard get={get} params={params} events={cards.events.data ?? null} pages={o.breakdowns.pages ?? []} />
          : cards.overview.error ? <CardError title="Funnel" onRetry={() => retry("overview")} /> : <CardSkeleton title="Funnel" />}
        {retention.data ? <RetentionCard data={retention.data} tz={tz} />
          : retention.error ? <CardError title="Retention" onRetry={() => { setRetention({}); loadRetention(); }} />
          : <CardSkeleton title="Retention" />}
      </div>

      {/* Into Product health (D29) */}
      <Card className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-body text-text-secondary">
          <span className="font-semibold text-text">Product health</span> has file-sharing success rates, relay use, artifacts by type and feature adoption.
        </p>
        <Button variant="secondary" iconRight="arrowRight" href="/admin?tab=health" onClick={(e) => { e.preventDefault(); onOpenHealth(); }}>Open product health</Button>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
        {cards.events.data ? <EventsCard data={cards.events.data} get={get} params={params} />
          : cards.events.error ? <CardError title="Product events" onRetry={() => retry("events")} />
          : <CardSkeleton title="Product events" />}
        <LiveCard data={live} />
      </div>

      {cards.documents.data ? <DocumentsCard docs={cards.documents.data} />
        : cards.documents.error ? <CardError title="Documents" onRetry={() => retry("documents")} />
        : <CardSkeleton title="Documents" height={260} />}
    </div>
  );
}

// ── Breakdowns ────────────────────────────────────────────────────────────────

type Tab = {
  key: string; label: string; filter: string; rows: Row[]; none?: string; mono?: boolean;
  sessions?: boolean; favicon?: boolean; render?: (k: string | null) => React.ReactNode;
};

function Breakdown({ title, tabs, onPick }: { title: string; tabs: Tab[]; onPick: (k: string, v: string | null) => void }) {
  const [active, setActive] = useState(tabs[0].key);
  const [all, setAll] = useState(false);
  const tab = tabs.find((t) => t.key === active) ?? tabs[0];
  const rows = tab.rows ?? [];
  const valueOf = (r: Row) => (tab.sessions ? r.sessions ?? 0 : r.visitors);
  const max = Math.max(1, ...rows.map(valueOf));
  const name = (r: Row) => (tab.render ? tab.render(r.key) : (r.key ?? tab.none ?? "(none)"));
  const pick = (r: Row) => { setAll(false); onPick(tab.filter, r.key); };
  const id = `bd-${title.toLowerCase()}`;
  const cols: Column<Row>[] = [
    { key: "k", header: tab.label, primary: true, render: (r) => (
      <button type="button" onClick={() => pick(r)} className={`md-focus truncate rounded-sm text-left text-text hover:underline ${tab.mono ? "font-mono text-caption" : ""}`}>{name(r)}</button>
    ) },
    { key: "v", header: tab.sessions ? "Sessions" : "Visitors", align: "right", render: (r) => compact(valueOf(r)) },
    { key: "w", header: tab.sessions ? "Bounce" : "Views", align: "right", render: (r) => (tab.sessions ? `${r.bounce_rate ?? 0}%` : compact(r.pageviews ?? 0)) },
  ];
  return (
    <Card aria-labelledby={id} className="flex flex-col">
      <CardTitle id={id} title={title} right={
        <Tabs variant="pill" size="sm" aria-label={`${title} breakdown`} value={tab.key} className="max-w-full"
          onChange={(k) => { setActive(k); setAll(false); }} items={tabs.map((t) => ({ value: t.key, label: t.label }))} />
      } />
      <div className="flex items-center justify-between px-2 pb-1.5 text-eyebrow uppercase text-text-muted" aria-hidden>
        <span>{tab.label}</span>
        <span className="flex gap-6 tabular-nums">
          <span className="w-14 text-right">{tab.sessions ? "Sessions" : "Visitors"}</span>
          <span className="hidden w-14 text-right sm:inline">{tab.sessions ? "Bounce" : "Views"}</span>
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="py-10 text-center text-caption text-text-secondary">No data for this range yet.</p>
      ) : (
        <ul className="flex flex-col gap-1" aria-label={`${title}: ${tab.label}`}>
          {rows.slice(0, 8).map((r) => {
            const v = valueOf(r);
            return (
              <li key={String(r.key)}>
                <button type="button" onClick={() => pick(r)} aria-label={`Filter by ${tab.label.toLowerCase()}: ${r.key ?? tab.none ?? "none"}, ${compact(v)} ${tab.sessions ? "sessions" : "visitors"}`}
                  className="md-focus group relative flex h-9 w-full items-center justify-between gap-3 rounded-md px-2 text-left text-body hover:bg-surface-hover">
                  <span aria-hidden className="absolute inset-y-0.5 left-0 rounded-sm transition-[width] duration-(--duration-fast)"
                    style={{ width: `${(v / max) * 100}%`, background: C.wash }} />
                  <span className={`relative flex min-w-0 items-center gap-2 truncate text-text ${tab.mono ? "font-mono text-caption" : ""}`}>
                    {tab.favicon && r.key && <HostBadge host={r.key} />}
                    <span className="truncate">{name(r)}</span>
                  </span>
                  <span className="relative flex gap-6 text-caption tabular-nums">
                    <span className="w-14 text-right font-semibold text-text">{compact(v)}</span>
                    <span className="hidden w-14 text-right text-text-secondary sm:inline">
                      {tab.sessions ? `${r.bounce_rate ?? 0}%` : compact(r.pageviews ?? 0)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > 8 && (
        <Button variant="link" size="sm" className="mt-2 self-start" onClick={() => setAll(true)} aria-haspopup="dialog">Show all {rows.length}</Button>
      )}
      <Drawer open={all} onClose={() => setAll(false)} title={`${title}: ${tab.label}`} description="Choose a row to filter the whole page by it." width={520}>
        <Table compact columns={cols} rows={rows} rowKey={(r) => String(r.key)} caption={`${title}: ${tab.label}`} />
      </Drawer>
    </Card>
  );
}

// ── Product ───────────────────────────────────────────────────────────────────

function ProductSection({ product, vs }: { product: Product; vs: string }) {
  const m = product.metrics;
  const items: [string, string][] = [
    ["signups", "New accounts"],
    ["documents", "Documents published"],
    ["artifacts", "Artifacts uploaded"],
    ["file_shares", "File shares"],
    ["workspaces", "Workspaces created"],
  ];
  return (
    <section aria-labelledby="product-h">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h2 id="product-h" className="text-h4 text-text">Product</h2>
        <p className="text-caption text-text-secondary">From Markdrop&apos;s own records — exact, and not affected by filters</p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-6">
        {items.map(([k, label]) => {
          const x = m[k];
          if (!x) return null;
          const values = (x.series ?? []).map((p) => p.n);
          return (
            <StatTile key={k} size="md" label={label} value={compact(x.total)} delta={deltaOf(x.total, x.prev ?? 0, vs)}
              chart={values.length > 1 ? <span className="max-sm:hidden"><Sparkline values={values} width={72} height={24} /></span> : undefined} />
          );
        })}
        <StatTile size="md" label="Active accounts" value={compact(m.active_users?.total ?? 0)} caption="Signed-in people seen or signing in during the range" />
      </div>
    </section>
  );
}

// ── Funnel ────────────────────────────────────────────────────────────────────

function FunnelCard({ get, params, events, pages }: {
  get: Get; params: Record<string, string | undefined>; events: EventsRes | null; pages: Row[];
}) {
  const [preset, setPreset] = useState(0);
  const [steps, setSteps] = useState<Step[]>(FUNNEL_PRESETS[0].steps);
  const [editing, setEditing] = useState(false);
  const [res, setRes] = useState<FunnelRes | null>(null);
  const [failed, setFailed] = useState(false);
  const [n, setN] = useState(0);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    get<FunnelRes>("funnel", { ...params, steps: JSON.stringify(steps) })
      .then((r) => alive && setRes(r))
      .catch(() => { if (alive) { setRes(null); setFailed(true); } });
    return () => { alive = false; };
  }, [get, params, steps, n]);

  const options: { key: string; label: string; step: Step }[] = [
    { key: "visit", label: "Any visit", step: { t: "visit" } },
    ...Array.from(new Set([...Object.keys(EVENT_LABELS), ...(events?.events.map((e) => e.name) ?? [])])).map((nm) => ({ key: `event:${nm}`, label: `Event · ${EVENT_LABELS[nm] ?? nm}`, step: { t: "event" as const, v: nm } })),
    ...Array.from(new Set(["/", "/new", "/upload", "/share", "/share/[id]", "/login", "/dashboard", "/builder", "/[slug]", ...pages.map((p) => p.key ?? "")].filter(Boolean)))
      .map((p) => ({ key: `page:${p}`, label: `Page · ${p}`, step: { t: "page" as const, v: p } })),
  ];
  const keyOf = (s: Step) => (s.t === "visit" ? "visit" : `${s.t}:${s.v}`);
  const first = res?.steps[0]?.visitors ?? 0;
  const overall = res && first ? Math.round((100 * res.steps[res.steps.length - 1].visitors) / first) : 0;

  return (
    <Card aria-labelledby="funnel-h">
      <CardTitle id="funnel-h" title="Funnel" sub={res && first ? `${overall}% of visitors completed every step` : "Visitors who did each step, in order"}
        right={
          <>
            <Select aria-label="Funnel" value={editing ? "-1" : String(preset)} className="max-w-56"
              onChange={(e) => { const i = Number(e.target.value); if (i < 0) return; setPreset(i); setSteps(FUNNEL_PRESETS[i].steps); setEditing(false); }}>
              {editing && <option value="-1">Custom funnel</option>}
              {FUNNEL_PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
            </Select>
            <Button size="sm" variant="secondary" aria-pressed={editing} onClick={() => setEditing((e) => !e)}>{editing ? "Done" : "Edit steps"}</Button>
          </>
        } />

      {editing && (
        <ol className="mb-4 flex flex-col gap-1.5">
          {steps.map((s, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="w-5 text-right text-caption tabular-nums text-text-secondary">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <Select aria-label={`Step ${i + 1}`} value={keyOf(s)}
                  onChange={(e) => { const op = options.find((x) => x.key === e.target.value); if (op) setSteps((st) => st.map((x, j) => (j === i ? op.step : x))); }}>
                  {options.map((op) => <option key={op.key} value={op.key}>{op.label}</option>)}
                </Select>
              </div>
              <IconButton icon="x" label={`Remove step ${i + 1}`} disabled={steps.length <= 2} onClick={() => setSteps((st) => st.filter((_, j) => j !== i))} />
            </li>
          ))}
          {steps.length < 6 && (
            <li><Button size="sm" variant="link" iconLeft="plus" className="ml-7" onClick={() => setSteps((st) => [...st, { t: "event", v: "doc_published" }])}>Add step</Button></li>
          )}
        </ol>
      )}

      {failed ? (
        <div className="flex flex-wrap items-center gap-3 py-6">
          <p className="text-caption text-text-secondary">Couldn&apos;t load the funnel.</p>
          <Button size="sm" variant="secondary" iconLeft="refresh" onClick={() => setN((x) => x + 1)}>Retry</Button>
        </div>
      ) : !res ? (
        <LoadingBlock label="Loading the funnel" minHeight={steps.length * 48} />
      ) : (
        <ol className="flex flex-col gap-3">
          {res.steps.map((s, i) => (
            <li key={i}>
              <div className="flex items-baseline justify-between gap-3 text-caption">
                <span className="truncate text-text"><span className="mr-1.5 tabular-nums text-text-secondary">{i + 1}.</span>{stepLabel(s)}</span>
                <span className="shrink-0 tabular-nums text-text-secondary">
                  <span className="font-semibold text-text">{compact(s.visitors)}</span>
                  <span className="ml-2">{i === 0 ? "100%" : `${s.from_prev}% of previous`}</span>
                </span>
              </div>
              <div aria-hidden className="mt-1.5 h-2.5 overflow-hidden rounded-full" style={{ background: C.track }}>
                <div className="h-full rounded-full transition-[width] duration-(--duration-slow) motion-reduce:transition-none"
                  style={{ width: `${first ? Math.max(s.visitors ? 1.5 : 0, s.from_start) : 0}%`, background: C.series }} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

// ── Retention ─────────────────────────────────────────────────────────────────

function RetentionCard({ data: raw, tz }: { data: Retention; tz: string }) {
  const [table, setTable] = useState(false);
  // Weeks before the first visitor are noise, not information.
  const firstReal = raw.cohorts.findIndex((c) => c.size > 0);
  const data = firstReal > 0 ? { cohorts: raw.cohorts.slice(firstReal) } : raw;
  const weeks = data.cohorts.length;
  return (
    <Card aria-labelledby="retention-h">
      <CardTitle id="retention-h" title="Retention" sub="Share of each week's new visitors who came back in later weeks"
        right={<TableToggle table={table} onToggle={() => setTable((t) => !t)} />} />
      <div className="overflow-x-auto">
        <table className={`w-full border-separate text-micro ${table ? "" : "[border-spacing:2px]"}`}>
          <caption className="md-visually-hidden">Retention by weekly cohort, as percentages</caption>
          <thead>
            <tr className="text-text-secondary">
              <th scope="col" className="sticky left-0 bg-surface pb-1 pr-2 text-left font-medium">Cohort</th>
              <th scope="col" className="pb-1 pr-2 text-right font-medium">New</th>
              {Array.from({ length: weeks }, (_, k) => <th key={k} scope="col" className="w-10 pb-1 font-medium">W{k}</th>)}
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {data.cohorts.map((c) => (
              <tr key={c.week}>
                <th scope="row" className="sticky left-0 whitespace-nowrap bg-surface pr-2 text-left font-normal text-text-secondary">{bucketLabel(c.week, "day", tz)}</th>
                <td className="pr-2 text-right font-medium text-text">{c.size}</td>
                {Array.from({ length: weeks }, (_, k) => {
                  const cell = c.cells[k];
                  if (!cell) return <td key={k}><span className="md-visually-hidden">No data</span></td>;
                  const pct = k === 0 ? 100 : Math.round(cell.pct);
                  const label = `${cell.n} of ${c.size} (${k === 0 ? 100 : cell.pct}%)`;
                  if (table || !c.size) return <td key={k} className="h-7 text-center text-text" title={label}>{c.size ? pct : 0}</td>;
                  if (!cell.n && k > 0) {
                    return <td key={k} className="h-7 rounded-sm text-center text-text-secondary" style={{ background: C.track }} title={label}>0</td>;
                  }
                  const h = heat(pct);
                  return (
                    <td key={k} className="h-7 rounded-sm text-center font-semibold" title={label}
                      style={{ background: h.bg, color: h.fg, boxShadow: h.step === 1 ? "inset 0 0 0 1px var(--border-strong)" : undefined }}>
                      {pct}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-micro text-text-secondary">Percentages. W0 is the week of the first visit; visitors with privacy signals on are excluded.</p>
    </Card>
  );
}

// ── Events ────────────────────────────────────────────────────────────────────

function EventsCard({ data, get, params }: { data: EventsRes; get: Get; params: Record<string, string | undefined> }) {
  const [open, setOpen] = useState<string | null>(null);
  const [props, setProps] = useState<EventsRes["props"] | null>(null);
  useEffect(() => {
    if (!open) return;
    setProps(null);
    get<EventsRes>("events", { ...params, name: open }).then((r) => setProps(r.props ?? {})).catch(() => setProps({}));
  }, [open, get, params]);
  const max = Math.max(1, ...data.events.map((e) => e.count));
  return (
    <Card aria-labelledby="events-h">
      <CardTitle id="events-h" title="Product events" sub="What people did, tracked in the app. Choose one to see its properties." />
      {!data.events.length ? <p className="py-10 text-center text-caption text-text-secondary">No events in this range yet.</p> : (
        <ul className="flex flex-col gap-1">
          {data.events.map((e) => (
            <li key={e.name}>
              <button type="button" aria-expanded={open === e.name} onClick={() => setOpen((o) => (o === e.name ? null : e.name))}
                className="md-focus relative flex h-9 w-full items-center justify-between gap-3 rounded-md px-2 text-left text-body hover:bg-surface-hover">
                <span aria-hidden className="absolute inset-y-0.5 left-0 rounded-sm" style={{ width: `${(e.count / max) * 100}%`, background: C.wash }} />
                <span className="relative truncate text-text">{EVENT_LABELS[e.name] ?? e.name}</span>
                <span className="relative flex gap-4 text-caption tabular-nums">
                  <span className="font-semibold text-text">{compact(e.count)}</span>
                  <span className="w-20 text-right text-text-secondary">{compact(e.visitors)} {e.visitors === 1 ? "person" : "people"}</span>
                </span>
              </button>
              {open === e.name && (
                <div className="mx-2 mb-2 mt-1 rounded-lg border border-border bg-bg p-3">
                  {!props ? <p className="text-caption text-text-secondary">Loading…</p> : !Object.keys(props).length ? (
                    <p className="text-caption text-text-secondary">No properties on this event.</p>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {Object.entries(props).map(([k, vals]) => (
                        <div key={k} className="min-w-0">
                          <Eyebrow className="mb-1">{k}</Eyebrow>
                          {vals.slice(0, 6).map((v) => (
                            <p key={v.value} className="flex justify-between gap-2 text-caption text-text"><span className="truncate">{v.value}</span><span className="tabular-nums text-text-secondary">{v.n}</span></p>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ── Live ──────────────────────────────────────────────────────────────────────

function LiveCard({ data }: { data: Realtime | null }) {
  // New rows slide in; the first paint doesn't animate.
  const seen = useRef<Set<string> | null>(null);
  const keyOf = (r: Realtime["recent"][number]) => `${r.ts}|${r.path}`;
  const fresh = new Set<string>();
  if (data) {
    if (seen.current) for (const r of data.recent) if (!seen.current.has(keyOf(r))) fresh.add(keyOf(r));
  }
  useEffect(() => { if (data) seen.current = new Set(data.recent.map(keyOf)); }, [data]);
  return (
    <Card aria-labelledby="live-h">
      <CardTitle id="live-h" title="Right now" sub="Last 5 minutes · refreshes every 15 seconds while this tab is visible"
        right={<span className="text-h3 tabular-nums text-text">{data?.visitors ?? "—"}<span className="ml-1 text-caption font-normal text-text-secondary">online</span></span>} />
      {!data || (!data.pages.length && !data.recent.length) ? (
        <p className="py-10 text-center text-caption text-text-secondary">Nobody on the site right now.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <Eyebrow>On page</Eyebrow>
            {data.pages.map((p) => (
              <p key={p.key} className="flex justify-between gap-2 py-0.5 text-caption"><span className="truncate font-mono text-text">{p.key}</span><span className="font-semibold tabular-nums text-text">{p.n}</span></p>
            ))}
            <Eyebrow className="mt-3">From</Eyebrow>
            {data.sources.map((s) => (
              <p key={s.key} className="flex justify-between gap-2 py-0.5 text-caption"><span className="truncate text-text">{s.key}</span><span className="font-semibold tabular-nums text-text">{s.n}</span></p>
            ))}
          </div>
          <div className="min-w-0">
            <Eyebrow>Latest page views</Eyebrow>
            <ul className="flex flex-col gap-1.5">
              {data.recent.slice(0, 12).map((r, i) => (
                <li key={`${keyOf(r)}#${i}`} className={`text-caption ${fresh.has(keyOf(r)) ? "motion-safe:animate-rise" : ""}`}>
                  <p className="flex justify-between gap-2"><span className="truncate font-mono text-text">{r.path}</span><span className="shrink-0 text-text-secondary">{ago(r.ts)}</span></p>
                  <p className="truncate text-micro text-text-secondary">{[r.city, countryName(r.country)].filter(Boolean).join(", ")} · {r.device} · {r.channel}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Card>
  );
}

// ── Documents ─────────────────────────────────────────────────────────────────

function DocumentsCard({ docs }: { docs: Docs }) {
  const cols: Column<Doc>[] = [
    { key: "doc", header: "Document", primary: true, render: (d) => (
      <a href={d.slug ? `/${d.slug}` : undefined} target="_blank" rel="noopener noreferrer" className="md-focus group flex min-w-0 items-center gap-2.5 rounded-sm">
        <span className={`grid size-5 shrink-0 place-items-center ${d.encrypted ? "text-text-muted" : d.kind === "artifact" ? "text-cat-artifact" : "text-cat-document"}`}>
          <Icon name={d.encrypted ? "key" : d.kind === "artifact" ? "doc" : "lines"} size={18} />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className={`max-w-72 truncate group-hover:underline ${d.encrypted ? "italic text-text-secondary" : "text-text"}`} dir="auto">
            {d.encrypted ? "Encrypted document" : d.title || "Untitled"}
          </span>
          <span className="truncate font-mono text-micro text-text-muted">/{d.slug}{d.kind === "artifact" ? " · artifact" : ""}</span>
        </span>
      </a>
    ) },
    { key: "views", header: "Views", align: "right", render: (d) => <span className="font-semibold">{compact(d.views)}</span> },
    { key: "readers", header: "Readers", align: "right", render: (d) => compact(d.visitors) },
    { key: "read", header: "Read time", align: "right", render: (d) => (d.reads ? duration(d.avg_seconds) : <span className="text-text-muted">—</span>) },
    { key: "finished", header: "Finished", align: "right", render: (d) => (d.reads ? `${Math.round(d.finished)}%` : <span className="text-text-muted">—</span>) },
    { key: "from", header: "Came from", render: (d) => (
      <span className="flex flex-wrap gap-1">
        {d.referrers.length ? d.referrers.slice(0, 3).map((r) => <Badge key={r.host} size="sm" tone="neutral">{r.host} {r.views}</Badge>) : <span className="text-text-muted">—</span>}
      </span>
    ) },
  ];
  return (
    <Card aria-labelledby="docs-h">
      <CardTitle id="docs-h" title="Documents" sub="Most-viewed published documents and artifacts, and where their readers came from" />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem] [&>*]:min-w-0">
        <Table compact hover={false} columns={cols} rows={docs.documents} rowKey={(d) => d.doc_id} caption="Most-viewed documents" empty="No document views in this range." />
        <div>
          <Eyebrow>Where document readers came from</Eyebrow>
          {!docs.referrers.length ? (
            <p className="text-caption text-text-secondary">Recorded for views since Oct 8. This fills in as people arrive from links.</p>
          ) : (
            <BarRows rows={docs.referrers.slice(0, 10).map((r) => ({ key: r.host, n: r.views }))} />
          )}
        </div>
      </div>
    </Card>
  );
}

function BarRows({ rows }: { rows: { key: string; n: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <ul className="flex flex-col gap-1">
      {rows.map((r) => (
        <li key={r.key} className="relative flex h-8 items-center justify-between gap-2 px-2 text-caption">
          <span aria-hidden className="absolute inset-y-0.5 left-0 rounded-sm" style={{ width: `${(r.n / max) * 100}%`, background: C.wash }} />
          <span className="relative flex min-w-0 items-center gap-2 truncate text-text"><HostBadge host={r.key} /><span className="truncate">{r.key}</span></span>
          <span className="relative font-semibold tabular-nums text-text">{compact(r.n)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A site's initial, drawn locally. Fetching real favicons would send every referring hostname to a
 * third-party icon service from the admin's browser. Neutral tile, so no brand colours.
 */
const KNOWN: Record<string, string> = {
  "t.co": "X", "x.com": "X", "twitter.com": "X", "google.com": "G", "linkedin.com": "in", "facebook.com": "f",
  "reddit.com": "r", "chatgpt.com": "AI", "github.com": "gh", "news.ycombinator.com": "Y", "bing.com": "b", "claude.ai": "C",
};
function HostBadge({ host }: { host: string }) {
  const base = host.replace(/^www\./, "").replace(/^(l|lm|m|out|accounts)\./, "");
  const known = KNOWN[base] ?? Object.entries(KNOWN).find(([k]) => base.endsWith("." + k) || base.startsWith(k.split(".")[0] + "."))?.[1];
  return (
    <span aria-hidden className="inline-grid size-4 shrink-0 place-items-center rounded-xs bg-surface-active text-micro font-bold leading-none text-text">
      {(known ?? base.charAt(0).toUpperCase()).slice(0, 2)}
    </span>
  );
}
