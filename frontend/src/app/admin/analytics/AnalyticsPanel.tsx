"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setTrackingDisabled, trackingDisabled } from "@/lib/track";
import { ACCENT, FUNNEL_RAMP, Sparkline, TrendChart, bucketLabel, compact, heat } from "./charts";

const API = process.env.NEXT_PUBLIC_API_URL || "https://api.markdrop.in";

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
type Doc = { doc_id: string; slug: string | null; title: string | null; encrypted: boolean; kind: string; views: number; visitors: number; referrers: { host: string; views: number }[] };
type Docs = { documents: Doc[]; referrers: { host: string; views: number }[] };
type Realtime = { visitors: number; pages: { key: string; n: number }[]; sources: { key: string; n: number }[]; recent: { path: string; country: string | null; city: string | null; device: string | null; channel: string | null; ts: string }[] };
type EventsRes = { events: { name: string; count: number; visitors: number }[]; props?: Record<string, { value: string; n: number }[]> };
type Step = { t: "visit" | "page" | "event"; v?: string };
type FunnelRes = { steps: (Step & { visitors: number; from_start: number; from_prev: number })[] };
type Retention = { cohorts: { week: string; size: number; cells: { n: number; pct: number }[] }[] };

type Filters = Record<string, string>;

const RANGES: { key: string; label: string }[] = [
  { key: "24h", label: "Last 24 hours" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "12m", label: "Last 12 months" },
];

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
];

const EVENT_LABELS: Record<string, string> = {
  doc_published: "Document published", builder_published: "README builder published",
  artifact_uploaded: "Artifact uploaded", logged_in: "Signed in", workspace_created: "Workspace created",
  google_docs_export: "Exported to Google Docs", vscode_connected: "VS Code connected",
  share_started: "File share started", share_files_added: "Files added to a share",
  share_download: "Shared files downloaded", doc_copy_link: "Document link copied",
  doc_export_pdf: "Document exported to PDF",
};

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

// ── Data ──────────────────────────────────────────────────────────────────────

function useAdminFetch(token: string) {
  return useCallback(async <T,>(path: string, params: Record<string, string | undefined>): Promise<T> => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]);
    const res = await fetch(`${API}/api/v1/admin/analytics/${path}?${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }, [token]);
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export default function AnalyticsPanel({ token }: { token: string }) {
  const get = useAdminFetch(token);
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const [range, setRange] = useState("30d");
  const [custom, setCustom] = useState<{ start: string; end: string } | null>(null);
  const [filters, setFilters] = useState<Filters>({});
  const [metric, setMetric] = useState<"visitors" | "pageviews" | "sessions">("visitors");

  const [overview, setOverview] = useState<Overview | null>(null);
  const [product, setProduct] = useState<Product | null>(null);
  const [docs, setDocs] = useState<Docs | null>(null);
  const [events, setEvents] = useState<EventsRes | null>(null);
  const [retention, setRetention] = useState<Retention | null>(null);
  const [live, setLive] = useState<Realtime | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [excluded, setExcluded] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => setExcluded(trackingDisabled()), []);

  const params = useMemo(() => ({
    range: custom ? "custom" : range,
    start: custom?.start, end: custom?.end, tz,
    filters: Object.keys(filters).length ? JSON.stringify(filters) : undefined,
  }), [range, custom, tz, filters]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    const { filters: _f, ...unfiltered } = params; // product & documents ignore traffic filters
    Promise.all([
      get<Overview>("overview", params),
      get<Product>("product", unfiltered),
      get<Docs>("documents", unfiltered),
      get<EventsRes>("events", params),
    ]).then(([o, p, d, e]) => {
      if (cancelled) return;
      setOverview(o); setProduct(p); setDocs(d); setEvents(e);
    }).catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [get, params, tick]);

  useEffect(() => {
    get<Retention>("retention", { tz, weeks: "8" }).then(setRetention).catch(() => {});
  }, [get, tz, tick]);

  useEffect(() => {
    let alive = true;
    const load = () => get<Realtime>("realtime", {}).then((r) => alive && setLive(r)).catch(() => {});
    load();
    const id = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(id); };
  }, [get]);

  const addFilter = (k: string, v: string | null) => setFilters((f) => ({ ...f, [k]: v ?? "(none)" }));
  const removeFilter = (k: string) => setFilters((f) => { const n = { ...f }; delete n[k]; return n; });

  const o = overview;
  return (
    <div className="space-y-5">
      <Toolbar
        range={range} custom={custom} setRange={(r) => { setCustom(null); setRange(r); }} setCustom={setCustom}
        filters={filters} removeFilter={removeFilter} clear={() => setFilters({})}
        live={live?.visitors ?? null} excluded={excluded}
        toggleExcluded={() => { setTrackingDisabled(!excluded); setExcluded(!excluded); }}
        refresh={() => setTick((t) => t + 1)} loading={loading}
      />

      {error && (
        <div className="rounded-xl border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          Couldn&apos;t load analytics ({error}). The data may still be arriving — try refreshing.
        </div>
      )}

      {!o ? <Skeleton /> : (
        <div className={`space-y-5 transition-opacity ${loading ? "opacity-60" : ""}`}>
          {/* Headline numbers */}
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
            <Stat label="Visitors" value={compact(o.kpis.visitors)} now={o.kpis.visitors} prev={o.prev.visitors}
              active={metric === "visitors"} onClick={() => setMetric("visitors")}
              foot={o.kpis.visitors ? `${Math.round((100 * o.kpis.new_visitors) / o.kpis.visitors)}% new · ${o.kpis.signed_in_visitors} signed in` : "—"} />
            <Stat label="Page views" value={compact(o.kpis.pageviews)} now={o.kpis.pageviews} prev={o.prev.pageviews}
              active={metric === "pageviews"} onClick={() => setMetric("pageviews")} foot={`${o.kpis.views_per_session} per session`} />
            <Stat label="Sessions" value={compact(o.kpis.sessions)} now={o.kpis.sessions} prev={o.prev.sessions}
              active={metric === "sessions"} onClick={() => setMetric("sessions")} foot={`${o.kpis.returning_visitors} returning visitors`} />
            <Stat label="Bounce rate" value={`${o.kpis.bounce_rate}%`} now={o.kpis.bounce_rate} prev={o.prev.bounce_rate} lowerIsBetter
              foot="Sessions with one page view" />
            <Stat label="Engaged time" value={duration(o.kpis.avg_duration_s)} now={o.kpis.avg_duration_s} prev={o.prev.avg_duration_s}
              foot="Avg. visible time per session" />
            <Stat label="Live now" value={live ? String(live.visitors) : "—"} foot="Visitors in the last 5 min" live />
          </div>

          {/* Trend */}
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <div>
                <h3 className="text-sm font-semibold text-gray-100">
                  {metric === "visitors" ? "Visitors" : metric === "pageviews" ? "Page views" : "Sessions"}
                </h3>
                <p className="text-xs text-gray-500">
                  {o.range.unit === "hour" ? "Per hour" : o.range.unit === "week" ? "Per week" : "Per day"} · {tz}
                </p>
              </div>
              <Segmented value={metric} onChange={(v) => setMetric(v as typeof metric)}
                options={[["visitors", "Visitors"], ["pageviews", "Page views"], ["sessions", "Sessions"]]} />
            </div>
            <TrendChart points={o.series.map((p) => ({ t: p.t, v: p[metric] }))} unit={o.range.unit} tz={tz}
              label={metric === "visitors" ? "Visitors" : metric === "pageviews" ? "Page views" : "Sessions"} />
          </Card>

          {/* Breakdowns */}
          <div className="grid lg:grid-cols-2 gap-5 [&>*]:min-w-0">
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
                <span className="inline-flex items-center gap-2"><span className="w-7 text-[10px] font-mono text-gray-500">{k ?? "--"}</span>{countryName(k)}</span>
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

          {product && <ProductSection product={product} tz={tz} />}

          <div className="grid lg:grid-cols-2 gap-5 [&>*]:min-w-0">
            <FunnelCard get={get} params={params} events={events} pages={o.breakdowns.pages} />
            <RetentionCard data={retention} tz={tz} />
          </div>

          <div className="grid lg:grid-cols-2 gap-5 [&>*]:min-w-0">
            <EventsCard data={events} get={get} params={params} />
            <LiveCard data={live} />
          </div>

          {docs && <DocumentsCard docs={docs} />}
        </div>
      )}
    </div>
  );
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

function Toolbar({ range, custom, setRange, setCustom, filters, removeFilter, clear, live, excluded, toggleExcluded, refresh, loading }: {
  range: string; custom: { start: string; end: string } | null; setRange: (r: string) => void;
  setCustom: (c: { start: string; end: string } | null) => void;
  filters: Filters; removeFilter: (k: string) => void; clear: () => void;
  live: number | null; excluded: boolean; toggleExcluded: () => void; refresh: () => void; loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const label = custom ? `${custom.start} → ${custom.end}` : RANGES.find((r) => r.key === range)?.label;

  return (
    <div className="sticky top-0 z-20 -mx-1 px-1 py-2 bg-gray-950/85 backdrop-blur border-b border-gray-900">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative" ref={ref}>
          <button onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-gray-800 bg-gray-900 text-sm font-medium text-gray-100 hover:border-gray-700 transition-colors">
            <svg className="w-4 h-4 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 9.5h17M8 3v4M16 3v4" /></svg>
            {label}
            <svg className="w-3.5 h-3.5 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
          </button>
          {open && (
            <div className="absolute left-0 mt-1.5 w-64 rounded-xl border border-gray-800 bg-gray-950 shadow-2xl shadow-black/50 p-1.5 z-30">
              {RANGES.map((r) => {
                const on = !custom && r.key === range;
                return (
                  <button key={r.key} onClick={() => { setRange(r.key); setOpen(false); }}
                    className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-sm text-gray-200 hover:bg-white/5">
                    {r.label}
                    {on && <svg className="w-4 h-4 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 13l4 4L19 7" /></svg>}
                  </button>
                );
              })}
              <div className="mt-1.5 pt-2 border-t border-gray-800 px-1.5 pb-1 space-y-2">
                <p className="text-[11px] font-medium text-gray-500">Custom range</p>
                <div className="flex gap-1.5">
                  <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="min-w-0 flex-1 h-8 px-2 rounded-md bg-gray-900 border border-gray-800 text-xs text-gray-200 [color-scheme:dark]" />
                  <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="min-w-0 flex-1 h-8 px-2 rounded-md bg-gray-900 border border-gray-800 text-xs text-gray-200 [color-scheme:dark]" />
                </div>
                <button disabled={!start || !end || start > end} onClick={() => { setCustom({ start, end }); setOpen(false); }}
                  className="w-full h-8 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-xs font-semibold text-white">Apply</button>
              </div>
            </div>
          )}
        </div>

        {Object.entries(filters).map(([k, v]) => (
          <span key={k} className="inline-flex items-center gap-1.5 h-9 pl-3 pr-1.5 rounded-lg bg-blue-500/10 ring-1 ring-blue-500/30 text-sm text-blue-200">
            <span className="text-blue-300/70">{FILTER_LABELS[k] ?? k}</span>
            <span className="font-medium max-w-[14rem] truncate">{k === "country" ? countryName(v) : v === "(none)" ? "none" : v}</span>
            <button onClick={() => removeFilter(k)} aria-label={`Remove ${FILTER_LABELS[k] ?? k} filter`} className="p-1 rounded hover:bg-blue-500/20">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          </span>
        ))}
        {Object.keys(filters).length > 1 && (
          <button onClick={clear} className="h-9 px-2 text-xs text-gray-400 hover:text-gray-200">Clear all</button>
        )}
        {Object.keys(filters).length === 0 && (
          <span className="hidden md:inline text-xs text-gray-500">Click any row below to filter the whole page</span>
        )}

        <div className="w-full sm:w-auto sm:ml-auto flex items-center gap-2">
          {live !== null && (
            <span className="inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-gray-800 text-sm text-gray-300">
              <span className="relative flex w-2 h-2">
                {live > 0 && <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping" />}
                <span className={`relative inline-flex w-2 h-2 rounded-full ${live > 0 ? "bg-emerald-500" : "bg-gray-600"}`} />
              </span>
              <span className="tabular-nums font-medium text-gray-100">{live}</span> online
            </span>
          )}
          <button onClick={toggleExcluded} role="switch" aria-checked={excluded}
            title="Stops this browser from being counted — your own visits skew a small site's numbers"
            className="inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-gray-800 text-xs text-gray-300 hover:border-gray-700">
            <span className={`relative w-7 h-4 rounded-full transition-colors ${excluded ? "bg-blue-600" : "bg-gray-700"}`}>
              <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${excluded ? "left-3.5" : "left-0.5"}`} />
            </span>
            Exclude my visits
          </button>
          <button onClick={refresh} aria-label="Refresh" className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-gray-800 text-gray-400 hover:text-gray-200 hover:border-gray-700">
            <svg className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M20 12a8 8 0 11-2.34-5.66M20 4v4h-4" /></svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Building blocks ───────────────────────────────────────────────────────────

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`min-w-0 rounded-2xl border border-gray-800/80 bg-gray-900/40 p-4 sm:p-5 ${className}`}>{children}</div>;
}

function CardTitle({ title, sub, right }: { title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-100">{title}</h3>
        {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

function Segmented({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div className="inline-flex min-w-0 max-w-full p-0.5 rounded-lg bg-gray-950 border border-gray-800 overflow-x-auto [scrollbar-width:none]">
      {options.map(([k, l]) => (
        <button key={k} onClick={() => onChange(k)}
          className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${value === k ? "bg-gray-800 text-gray-50" : "text-gray-400 hover:text-gray-200"}`}>
          {l}
        </button>
      ))}
    </div>
  );
}

function Delta({ now, prev, lowerIsBetter }: { now: number; prev: number; lowerIsBetter?: boolean }) {
  if (!prev && !now) return null;
  if (!prev) return <span className="text-[11px] font-medium text-gray-400">New</span>;
  const pct = Math.round(((now - prev) / prev) * 100);
  if (pct === 0) return <span className="text-[11px] font-medium text-gray-500">0%</span>;
  const up = pct > 0;
  const good = lowerIsBetter ? !up : up;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-semibold ${good ? "text-[#0ca30c]" : "text-[#e66767]"}`}
      title={`${up ? "Up" : "Down"} ${Math.abs(pct)}% vs the previous period`}>
      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={up ? "M7 14l5-5 5 5" : "M7 10l5 5 5-5"} />
      </svg>
      {Math.abs(pct)}%
    </span>
  );
}

function Stat({ label, value, now, prev, foot, active, onClick, lowerIsBetter, live }: {
  label: string; value: string; now?: number; prev?: number; foot?: string; active?: boolean;
  onClick?: () => void; lowerIsBetter?: boolean; live?: boolean;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag onClick={onClick}
      className={`text-left rounded-2xl border p-4 transition-colors ${active
        ? "border-blue-500/60 bg-blue-500/[0.07] ring-1 ring-blue-500/30"
        : "border-gray-800/80 bg-gray-900/40"} ${onClick ? "hover:border-gray-700 cursor-pointer" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-gray-400 flex items-center gap-1.5">
          {live && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />}
          {label}
        </p>
        {now !== undefined && prev !== undefined && <Delta now={now} prev={prev} lowerIsBetter={lowerIsBetter} />}
      </div>
      <p className="mt-1.5 text-2xl font-semibold tracking-tight text-gray-50">{value}</p>
      {foot && <p className="mt-1 text-[11px] text-gray-500 truncate">{foot}</p>}
    </Tag>
  );
}

type Tab = {
  key: string; label: string; filter: string; rows: Row[]; none?: string; mono?: boolean;
  sessions?: boolean; favicon?: boolean; render?: (k: string | null) => React.ReactNode;
};

function Breakdown({ title, tabs, onPick }: { title: string; tabs: Tab[]; onPick: (k: string, v: string | null) => void }) {
  const [active, setActive] = useState(tabs[0].key);
  const [all, setAll] = useState(false);
  const tab = tabs.find((t) => t.key === active) ?? tabs[0];
  const rows = tab.rows ?? [];
  const shown = all ? rows : rows.slice(0, 8);
  const max = Math.max(1, ...rows.map((r) => (tab.sessions ? r.sessions ?? 0 : r.visitors)));
  return (
    <Card className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3 min-w-0 [&>*]:min-w-0">
        <h3 className="text-sm font-semibold text-gray-100">{title}</h3>
        <Segmented value={tab.key} onChange={(k) => { setActive(k); setAll(false); }} options={tabs.map((t) => [t.key, t.label])} />
      </div>
      <div className="flex items-center justify-between px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
        <span>{tab.label}</span>
        <span className="flex gap-6 tabular-nums">
          <span className="w-14 text-right">{tab.sessions ? "Sessions" : "Visitors"}</span>
          <span className="w-14 text-right hidden sm:inline">{tab.sessions ? "Bounce" : "Views"}</span>
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="py-10 text-center text-xs text-gray-500">No data for this range yet.</p>
      ) : (
        <ul className={`space-y-1 ${all ? "max-h-[26rem] overflow-y-auto pr-1" : ""}`}>
          {shown.map((r) => {
            const v = tab.sessions ? r.sessions ?? 0 : r.visitors;
            const text = tab.render ? tab.render(r.key) : (r.key ?? tab.none ?? "(none)");
            return (
              <li key={String(r.key)}>
                <button onClick={() => onPick(tab.filter, r.key)} title={`Filter by ${tab.label.toLowerCase()}: ${r.key ?? tab.none ?? "none"}`}
                  className="group relative w-full flex items-center justify-between gap-3 h-8 px-2 rounded-md text-left text-[13px] hover:bg-white/[0.03]">
                  <span aria-hidden className="absolute inset-y-0.5 left-0 rounded-[4px] transition-[width]"
                    style={{ width: `${(v / max) * 100}%`, background: ACCENT, opacity: 0.16 }} />
                  <span className={`relative min-w-0 flex items-center gap-2 truncate text-gray-200 ${tab.mono ? "font-mono text-xs" : ""}`}>
                    {tab.favicon && r.key && <HostBadge host={r.key} />}
                    <span className="truncate">{text}</span>
                  </span>
                  <span className="relative flex gap-6 tabular-nums text-xs">
                    <span className="w-14 text-right font-semibold text-gray-100">{compact(v)}</span>
                    <span className="w-14 text-right text-gray-400 hidden sm:inline">
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
        <button onClick={() => setAll((a) => !a)} className="mt-2 self-start px-2 text-xs font-medium text-blue-400 hover:text-blue-300">
          {all ? "Show less" : `Show all ${rows.length}`}
        </button>
      )}
    </Card>
  );
}

// ── Product ───────────────────────────────────────────────────────────────────

function ProductSection({ product }: { product: Product; tz: string }) {
  const m = product.metrics;
  const items: [string, string, string][] = [
    ["signups", "New accounts", "users"],
    ["documents", "Documents published", "markdown"],
    ["artifacts", "Artifacts uploaded", "files"],
    ["file_shares", "File shares", "P2P"],
    ["workspaces", "Workspaces created", "teams"],
  ];
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 mb-2 px-1">
        <h3 className="text-sm font-semibold text-gray-100">Product</h3>
        <p className="text-[11px] text-gray-500">From Markdrop&apos;s own records — exact, and not affected by filters</p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
        {items.map(([k, label]) => {
          const x = m[k];
          if (!x) return null;
          return (
            <div key={k} className="rounded-2xl border border-gray-800/80 bg-gray-900/40 p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-gray-400">{label}</p>
                <Delta now={x.total} prev={x.prev ?? 0} />
              </div>
              <p className="mt-1.5 text-2xl font-semibold tracking-tight text-gray-50">{compact(x.total)}</p>
              <div className="mt-2"><Sparkline values={(x.series ?? []).map((p) => p.n)} width={140} height={26} /></div>
            </div>
          );
        })}
        <div className="rounded-2xl border border-gray-800/80 bg-gray-900/40 p-4">
          <p className="text-xs font-medium text-gray-400">Active accounts</p>
          <p className="mt-1.5 text-2xl font-semibold tracking-tight text-gray-50">{compact(m.active_users?.total ?? 0)}</p>
          <p className="mt-2 text-[11px] text-gray-500 leading-snug">Signed-in people seen or logging in during the range</p>
        </div>
      </div>
    </div>
  );
}

// ── Funnel ────────────────────────────────────────────────────────────────────

function FunnelCard({ get, params, events, pages }: {
  get: <T>(p: string, q: Record<string, string | undefined>) => Promise<T>;
  params: Record<string, string | undefined>; events: EventsRes | null; pages: Row[];
}) {
  const [preset, setPreset] = useState(0);
  const [steps, setSteps] = useState<Step[]>(FUNNEL_PRESETS[0].steps);
  const [editing, setEditing] = useState(false);
  const [res, setRes] = useState<FunnelRes | null>(null);

  useEffect(() => {
    let alive = true;
    get<FunnelRes>("funnel", { ...params, steps: JSON.stringify(steps) }).then((r) => alive && setRes(r)).catch(() => alive && setRes(null));
    return () => { alive = false; };
  }, [get, params, steps]);

  const options: { key: string; label: string; step: Step }[] = [
    { key: "visit", label: "Any visit", step: { t: "visit" } },
    ...Array.from(new Set([...Object.keys(EVENT_LABELS), ...(events?.events.map((e) => e.name) ?? [])])).map((n) => ({ key: `event:${n}`, label: `Event · ${EVENT_LABELS[n] ?? n}`, step: { t: "event" as const, v: n } })),
    ...Array.from(new Set(["/", "/new", "/upload", "/share", "/share/[id]", "/login", "/dashboard", "/builder", "/[slug]", ...pages.map((p) => p.key ?? "")].filter(Boolean)))
      .map((p) => ({ key: `page:${p}`, label: `Page · ${p}`, step: { t: "page" as const, v: p } })),
  ];
  const keyOf = (s: Step) => (s.t === "visit" ? "visit" : `${s.t}:${s.v}`);
  const first = res?.steps[0]?.visitors ?? 0;
  const overall = res && first ? Math.round((100 * res.steps[res.steps.length - 1].visitors) / first) : 0;

  return (
    <Card>
      <CardTitle title="Funnel" sub={res && first ? `${overall}% of visitors completed every step` : "Visitors who did each step, in order"}
        right={
          <div className="flex items-center gap-2">
            <select value={editing ? -1 : preset} onChange={(e) => { const i = Number(e.target.value); setPreset(i); setSteps(FUNNEL_PRESETS[i].steps); setEditing(false); }}
              className="h-8 max-w-[13rem] rounded-lg bg-gray-950 border border-gray-800 px-2 text-xs text-gray-200">
              {editing && <option value={-1}>Custom funnel</option>}
              {FUNNEL_PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
            </select>
            <button onClick={() => setEditing((e) => !e)} className="h-8 px-2.5 rounded-lg border border-gray-800 text-xs text-gray-300 hover:border-gray-700">
              {editing ? "Done" : "Edit steps"}
            </button>
          </div>
        } />

      {editing && (
        <div className="mb-4 space-y-1.5">
          {steps.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-5 text-right text-xs text-gray-500 tabular-nums">{i + 1}</span>
              <select value={keyOf(s)} onChange={(e) => { const o = options.find((x) => x.key === e.target.value); if (o) setSteps((st) => st.map((x, j) => (j === i ? o.step : x))); }}
                className="flex-1 min-w-0 h-8 rounded-lg bg-gray-950 border border-gray-800 px-2 text-xs text-gray-200">
                {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
              <button disabled={steps.length <= 2} onClick={() => setSteps((st) => st.filter((_, j) => j !== i))} aria-label="Remove step"
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-200 disabled:opacity-30">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>
          ))}
          {steps.length < 6 && (
            <button onClick={() => setSteps((st) => [...st, { t: "event", v: "doc_published" }])} className="ml-7 text-xs font-medium text-blue-400 hover:text-blue-300">+ Add step</button>
          )}
        </div>
      )}

      {!res ? <p className="py-10 text-center text-xs text-gray-500">Loading…</p> : (
        <ol className="space-y-3">
          {res.steps.map((s, i) => (
            <li key={i}>
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="truncate text-gray-200"><span className="text-gray-500 mr-1.5 tabular-nums">{i + 1}.</span>{stepLabel(s)}</span>
                <span className="shrink-0 tabular-nums text-gray-400">
                  <span className="font-semibold text-gray-100">{compact(s.visitors)}</span>
                  {i > 0 && <span className="ml-2" title="Of those who did the previous step">{s.from_prev}% of prev.</span>}
                </span>
              </div>
              <div className="mt-1.5 h-2.5 rounded-full bg-gray-800/70 overflow-hidden" title={`${s.from_start}% of step 1`}>
                <div className="h-full rounded-full transition-[width] duration-500"
                  style={{ width: `${first ? Math.max(s.visitors ? 1.5 : 0, s.from_start) : 0}%`, background: FUNNEL_RAMP[Math.min(i, FUNNEL_RAMP.length - 1)] }} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

// ── Retention ─────────────────────────────────────────────────────────────────

function RetentionCard({ data: raw, tz }: { data: Retention | null; tz: string }) {
  // Weeks before the first visitor are noise, not information.
  const firstReal = raw ? raw.cohorts.findIndex((c) => c.size > 0) : -1;
  const data = raw && firstReal > 0 ? { cohorts: raw.cohorts.slice(firstReal) } : raw;
  const weeks = data?.cohorts.length ?? 0;
  return (
    <Card>
      <CardTitle title="Retention" sub="Share of each week's new visitors who came back in later weeks" />
      {!data ? <p className="py-10 text-center text-xs text-gray-500">Loading…</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] border-separate" style={{ borderSpacing: 2 }}>
            <thead>
              <tr className="text-gray-500">
                <th className="text-left font-medium pr-2 pb-1">Cohort</th>
                <th className="text-right font-medium pr-2 pb-1">New</th>
                {Array.from({ length: weeks }, (_, k) => <th key={k} className="font-medium pb-1 w-9">W{k}</th>)}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {data.cohorts.map((c) => (
                <tr key={c.week}>
                  <td className="pr-2 text-gray-400 whitespace-nowrap">{bucketLabel(c.week, "day", tz)}</td>
                  <td className="pr-2 text-right text-gray-200 font-medium">{c.size}</td>
                  {Array.from({ length: weeks }, (_, k) => {
                    const cell = c.cells[k];
                    if (!cell) return <td key={k} />;
                    if (!c.size) return <td key={k} className="h-7 rounded bg-gray-900/60" />;
                    const h = heat(k === 0 ? 100 : cell.pct);
                    return (
                      <td key={k} className="h-7 rounded text-center font-medium" style={{ background: h.bg, color: h.fg }}
                        title={`${cell.n} of ${c.size} (${cell.pct}%)`}>
                        {k === 0 ? "100" : cell.pct ? Math.round(cell.pct) : "·"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-gray-500">Percentages. W0 is the week of the first visit; visitors with privacy signals on are excluded.</p>
        </div>
      )}
    </Card>
  );
}

// ── Events ────────────────────────────────────────────────────────────────────

function EventsCard({ data, get, params }: {
  data: EventsRes | null; get: <T>(p: string, q: Record<string, string | undefined>) => Promise<T>;
  params: Record<string, string | undefined>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [props, setProps] = useState<EventsRes["props"] | null>(null);
  useEffect(() => {
    if (!open) return;
    get<EventsRes>("events", { ...params, name: open }).then((r) => setProps(r.props ?? {})).catch(() => setProps({}));
  }, [open, get, params]);
  const max = Math.max(1, ...(data?.events.map((e) => e.count) ?? [0]));
  return (
    <Card>
      <CardTitle title="Product events" sub="What people did, tracked in the app" />
      {!data?.events.length ? <p className="py-10 text-center text-xs text-gray-500">No events in this range yet.</p> : (
        <ul className="space-y-1">
          {data.events.map((e) => (
            <li key={e.name}>
              <button onClick={() => setOpen((o) => (o === e.name ? null : e.name))}
                className="relative w-full flex items-center justify-between gap-3 h-8 px-2 rounded-md text-left text-[13px] hover:bg-white/[0.03]">
                <span aria-hidden className="absolute inset-y-0.5 left-0 rounded-[4px]" style={{ width: `${(e.count / max) * 100}%`, background: ACCENT, opacity: 0.16 }} />
                <span className="relative truncate text-gray-200">{EVENT_LABELS[e.name] ?? e.name}</span>
                <span className="relative flex gap-4 tabular-nums text-xs">
                  <span className="font-semibold text-gray-100">{compact(e.count)}</span>
                  <span className="w-20 text-right text-gray-400">{compact(e.visitors)} {e.visitors === 1 ? "person" : "people"}</span>
                </span>
              </button>
              {open === e.name && (
                <div className="mx-2 mt-1 mb-2 rounded-lg border border-gray-800 bg-gray-950/60 p-3">
                  {!props ? <p className="text-xs text-gray-500">Loading…</p> : !Object.keys(props).length ? (
                    <p className="text-xs text-gray-500">No properties on this event.</p>
                  ) : (
                    <div className="grid sm:grid-cols-2 gap-3">
                      {Object.entries(props).map(([k, vals]) => (
                        <div key={k}>
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-1">{k}</p>
                          {vals.slice(0, 6).map((v) => (
                            <p key={v.value} className="flex justify-between text-xs text-gray-300"><span className="truncate">{v.value}</span><span className="tabular-nums text-gray-400">{v.n}</span></p>
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
  return (
    <Card>
      <CardTitle title="Right now" sub="Last 5 minutes · refreshes every 15 seconds"
        right={<span className="text-2xl font-semibold text-gray-50 tabular-nums">{data?.visitors ?? "—"}<span className="ml-1 text-xs font-normal text-gray-500">online</span></span>} />
      {!data || (!data.pages.length && !data.recent.length) ? (
        <p className="py-10 text-center text-xs text-gray-500">Nobody on the site right now.</p>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5">On page</p>
            {data.pages.map((p) => (
              <p key={p.key} className="flex justify-between py-0.5 text-xs"><span className="font-mono text-gray-300 truncate">{p.key}</span><span className="tabular-nums text-gray-100 font-semibold">{p.n}</span></p>
            ))}
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mt-3 mb-1.5">From</p>
            {data.sources.map((s) => (
              <p key={s.key} className="flex justify-between py-0.5 text-xs"><span className="text-gray-300 truncate">{s.key}</span><span className="tabular-nums text-gray-100 font-semibold">{s.n}</span></p>
            ))}
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5">Latest page views</p>
            <ul className="space-y-1.5 max-h-64 overflow-y-auto">
              {data.recent.map((r, i) => (
                <li key={i} className="text-xs">
                  <p className="flex justify-between gap-2"><span className="font-mono text-gray-200 truncate">{r.path}</span><span className="shrink-0 text-gray-500">{ago(r.ts)}</span></p>
                  <p className="text-[11px] text-gray-500 truncate">{[r.city, countryName(r.country)].filter(Boolean).join(", ")} · {r.device} · {r.channel}</p>
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
  const max = Math.max(1, ...docs.referrers.map((r) => r.views));
  return (
    <Card>
      <CardTitle title="Documents" sub="Most-viewed published documents and artifacts, and where their readers came from" />
      <div className="grid lg:grid-cols-[1fr_18rem] gap-5">
        <div className="overflow-x-auto">
          {!docs.documents.length ? <p className="py-10 text-center text-xs text-gray-500">No document views in this range.</p> : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-gray-500">
                  <th className="text-left font-semibold pb-2">Document</th>
                  <th className="text-right font-semibold pb-2 px-2">Views</th>
                  <th className="text-right font-semibold pb-2 px-2">Readers</th>
                  <th className="text-left font-semibold pb-2 pl-3">Came from</th>
                </tr>
              </thead>
              <tbody>
                {docs.documents.map((d) => (
                  <tr key={d.doc_id} className="border-t border-gray-800/70">
                    <td className="py-2 pr-2 max-w-[18rem]">
                      <a href={d.slug ? `/${d.slug}` : undefined} target="_blank" rel="noopener noreferrer" className="group block min-w-0">
                        <span className="block truncate text-gray-100 group-hover:text-blue-300">
                          {d.encrypted ? <span className="text-gray-400 italic">Encrypted document</span> : d.title || "Untitled"}
                        </span>
                        <span className="block truncate font-mono text-[10px] text-gray-500">/{d.slug}{d.kind === "artifact" ? " · artifact" : ""}</span>
                      </a>
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums font-semibold text-gray-100">{compact(d.views)}</td>
                    <td className="py-2 px-2 text-right tabular-nums text-gray-400">{compact(d.visitors)}</td>
                    <td className="py-2 pl-3">
                      <div className="flex flex-wrap gap-1">
                        {d.referrers.length ? d.referrers.slice(0, 3).map((r) => (
                          <span key={r.host} className="px-1.5 py-0.5 rounded bg-gray-800 text-[10px] text-gray-300">{r.host} <span className="text-gray-500">{r.views}</span></span>
                        )) : <span className="text-[10px] text-gray-600">—</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-2">Where document readers came from</p>
          {!docs.referrers.length ? (
            <p className="text-xs text-gray-500 leading-relaxed">Recorded for views since Oct 8 — this fills in as people arrive from links.</p>
          ) : (
            <ul className="space-y-1">
              {docs.referrers.slice(0, 10).map((r) => (
                <li key={r.host} className="relative flex items-center justify-between h-7 px-2 text-xs">
                  <span aria-hidden className="absolute inset-y-0.5 left-0 rounded-[4px]" style={{ width: `${(r.views / max) * 100}%`, background: ACCENT, opacity: 0.16 }} />
                  <span className="relative flex items-center gap-2 truncate text-gray-200">
                    <HostBadge host={r.host} />
                    {r.host}
                  </span>
                  <span className="relative tabular-nums font-semibold text-gray-100">{compact(r.views)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

/**
 * A site's initial, drawn locally. Fetching real favicons would send every
 * referring hostname to a third-party icon service from the admin's browser.
 */
const KNOWN: Record<string, [string, string]> = {
  "t.co": ["𝕏", "#1d1d1f"], "x.com": ["𝕏", "#1d1d1f"], "twitter.com": ["𝕏", "#1d1d1f"],
  "google.com": ["G", "#1a73e8"], "linkedin.com": ["in", "#0a66c2"], "facebook.com": ["f", "#1877f2"],
  "reddit.com": ["r", "#ff4500"], "chatgpt.com": ["AI", "#10a37f"], "github.com": ["gh", "#24292f"],
  "news.ycombinator.com": ["Y", "#ff6600"], "bing.com": ["b", "#008373"], "claude.ai": ["C", "#c96442"],
};
function HostBadge({ host }: { host: string }) {
  const base = host.replace(/^www\./, "").replace(/^(l|lm|m|out|accounts)\./, "");
  const known = KNOWN[base] ?? Object.entries(KNOWN).find(([k]) => base.endsWith("." + k) || base.startsWith(k.split(".")[0] + "."))?.[1];
  const [txt, bg] = known ?? [base.charAt(0).toUpperCase(), "#374151"];
  return (
    <span aria-hidden className="inline-flex items-center justify-center w-4 h-4 shrink-0 rounded text-[8px] font-bold text-white" style={{ background: bg }}>
      {txt}
    </span>
  );
}

function Skeleton() {
  return (
    <div className="space-y-5 animate-pulse">
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
        {Array.from({ length: 6 }, (_, i) => <div key={i} className="h-[104px] rounded-2xl bg-gray-900/60" />)}
      </div>
      <div className="h-72 rounded-2xl bg-gray-900/60" />
      <div className="grid lg:grid-cols-2 gap-5 [&>*]:min-w-0">{[0, 1].map((i) => <div key={i} className="h-80 rounded-2xl bg-gray-900/60" />)}</div>
    </div>
  );
}
