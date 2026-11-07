"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Alert, Badge, Button, Drawer, Icon, Input, Meter, Pagination, Progress, SegmentedControl, Table, Tooltip, useToast, type Column,
} from "@/components/ui";
import { Card, CardError, Eyebrow } from "../analytics/ui";
import { LoadingBlock, fmtDateTime, plural } from "../shared";
import { AudienceSelect, LeftOutNote, type LeftOut, type UsageAudience } from "./audience";
import { DailyByFeature, FeatureLegend, type DayRow, type FeatureRef, type Metric } from "./charts";
import {
  RANGE_OPTIONS, WS_FEATURE_ORDER, WS_OTHER, ago, capText, featureLabel, n0, tokensShort, usd, useAiDownload, useAiFetch, useLoad,
  wsFeatureColor, wsFeatureKey, type RangeKey,
} from "./common";

/**
 * Admin → AI → Workspaces: what AI costs per workspace (backend/app/routers/admin_ai_workspaces.py).
 * One row per workspace that used AI in the range, plus "No workspace" (personal pages, public
 * visitors). System jobs that run for a workspace (Team memory, Ask suggestions, the weekly summary,
 * meeting summaries after an auto-import) count towards it. A row opens the workspace: cost over
 * time by feature, per person, per feature, its system jobs and the caps it spends against.
 * Feature colours follow the workspace order (common.WS_FEATURE_ORDER), never rank.
 */

type Actor = "people" | "apps" | "system" | "public";
interface Small { requests: number; cost_usd: number }
interface Tok { input: number; output: number; cache_read: number; cache_write: number }
interface Totals extends Small { tokens: Tok; tokens_in: number; tokens_out: number; total_tokens: number; last_used: string | null }
interface Person { user_id: string; email: string; name: string; deleted: boolean }
interface CapRow {
  feature: string; label: string; today_usd: number; month_usd: number; daily_cap_usd: number | null; monthly_cap_usd: number | null;
  today_pct: number | null; month_pct: number | null; feature_today_usd: number; feature_month_usd: number;
}
interface WsMeta {
  workspace_id: string; none: boolean; name: string; deleted: boolean; owner: Person | null; members: number | null;
  switches?: { page_ai: boolean; team_memory: boolean };
}
interface FeatureCost extends Small { key: string; label: string; tokens_in: number; tokens_out: number }
interface WsRow extends WsMeta, Totals {
  people: number; by_actor: Record<Actor, Small>; test: Small; features: FeatureCost[]; spark: number[];
  top_users: (Person & Small)[]; caps: CapRow[];
}
interface ListRes {
  range: RangeKey; audience: UsageAudience; left_out: LeftOut; days: string[];
  totals: { requests: number; cost_usd: number; workspaces: number; no_workspace_usd: number };
  sort: Sort; order: "asc" | "desc"; page: number; pages: number; total: number; items: WsRow[];
}
interface Detail {
  audience: UsageAudience; left_out: LeftOut; workspace: WsMeta;
  kpis: Totals & { people: number }; by_actor: Record<Actor, Small>; test: Small;
  features: FeatureRef[]; series: (DayRow & { cost_usd: number; requests: number })[];
  users: (Person & Totals & { role: string | null; member: boolean | null; apps: Small; features: string[] })[];
  by_feature: (Totals & { key: string; label: string; people: number; share_pct: number | null })[];
  jobs: (Totals & { job: string; feature: string; label: string })[];
  public: Totals; caps: CapRow[];
}

type Sort = "cost" | "requests" | "tokens" | "name" | "members" | "last_used";
const ACTOR_LABEL: Record<Actor, string> = { people: "People", system: "System", apps: "AI apps", public: "Public" };
const ACTORS: Actor[] = ["people", "system", "apps", "public"];

/** Opens the Requests tab on one workspace's conversations. */
export interface RequestsLink { workspace: { value: string; label: string }; range: RangeKey; audience: UsageAudience }

/** Wide enough for every column (a tablet in portrait gets the essentials and scrolls the rest). */
function useWide(query = "(min-width: 1180px)") {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setWide(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return wide;
}

/** The workspace view's features: its fixed order, then "Other" for everything else. */
function foldFeatures(rows: FeatureCost[]): FeatureCost[] {
  const by = new Map<string, FeatureCost>();
  for (const r of rows) {
    const k = wsFeatureKey(r.key);
    const cur = by.get(k) ?? { key: k, label: k === WS_OTHER ? "Other" : r.label, requests: 0, cost_usd: 0, tokens_in: 0, tokens_out: 0 };
    by.set(k, { ...cur, requests: cur.requests + r.requests, cost_usd: cur.cost_usd + r.cost_usd });
  }
  return [...WS_FEATURE_ORDER, WS_OTHER].map((k) => by.get(k)).filter((x): x is FeatureCost => !!x && x.cost_usd > 0);
}

function SortHeader({ label, k, sort, order, onSort, align }: { label: string; k: Sort; sort: Sort; order: "asc" | "desc"; onSort: (k: Sort) => void; align?: "right" }) {
  const active = sort === k;
  return (
    <button type="button" onClick={() => onSort(k)} aria-label={`Sort by ${label}`}
      style={{ font: "inherit", letterSpacing: "inherit", textTransform: "inherit" }}
      className={`md-focus inline-flex items-center gap-1 rounded-sm ${align === "right" ? "flex-row-reverse" : ""} ${active ? "text-text" : "text-inherit"}`}>
      {label}
      <span aria-hidden className={active ? "opacity-100" : "opacity-30"}><Icon name={active && order === "asc" ? "arrowUp" : "arrowDown"} size={12} /></span>
    </button>
  );
}

/** One row's cost by feature: a thin stacked bar (2px gaps, rounded ends), named on hover/focus. */
function FeatureStack({ features, width = 132 }: { features: FeatureCost[]; width?: number }) {
  const folded = foldFeatures(features);
  const total = folded.reduce((a, f) => a + f.cost_usd, 0);
  if (!total) return <span className="text-text-muted">—</span>;
  const text = folded.map((f) => `${f.label} ${usd(f.cost_usd)} (${Math.round((f.cost_usd / total) * 100)}%)`).join(", ");
  const topF = [...folded].sort((a, b) => b.cost_usd - a.cost_usd)[0];
  return (
    <Tooltip focusable content={<span className="flex flex-col gap-0.5">{folded.map((f) => (
      <span key={f.key} className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-xs" style={{ background: wsFeatureColor(f.key) }} />{f.label}</span>
        <b className="tabular-nums">{usd(f.cost_usd)}</b>
      </span>
    ))}</span>}>
      <span className="flex flex-col gap-1" role="img" aria-label={`Cost by feature: ${text}`}>
        <span className="flex h-2 gap-[2px]" style={{ width }}>
          {folded.map((f, i) => (
            <span key={f.key} className={`h-full ${i === 0 ? "rounded-l-[4px]" : ""} ${i === folded.length - 1 ? "rounded-r-[4px]" : ""}`}
              style={{ width: `${Math.max(2, (f.cost_usd / total) * 100)}%`, background: wsFeatureColor(f.key) }} />
          ))}
        </span>
        <span className="max-w-[9rem] truncate text-micro text-text-muted">{topF.label} {Math.round((topF.cost_usd / total) * 100)}%</span>
      </span>
    </Tooltip>
  );
}

/** The range's daily cost as a 2px line scaled to its own peak (decorative: the cost is in the row). */
function CostSpark({ values, width = 96, height = 26 }: { values: number[]; width?: number; height?: number }) {
  const max = Math.max(0, ...values);
  if (values.length < 2 || max <= 0) return <span aria-hidden className="block h-px" style={{ width, background: "var(--chart-grid)" }} />;
  const x = (i: number) => (i / (values.length - 1)) * (width - 6) + 3;
  const y = (v: number) => height - 3 - (v / max) * (height - 6);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const last = values.length - 1;
  return (
    <svg width={width} height={height} aria-hidden className="overflow-visible">
      <line x1={3} x2={width - 3} y1={height - 3} y2={height - 3} style={{ stroke: "var(--chart-grid)" }} strokeWidth={1} />
      <path d={d} fill="none" style={{ stroke: "var(--chart-1)" }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last)} cy={y(values[last])} r={2.5} style={{ fill: "var(--chart-1)", stroke: "var(--surface)" }} strokeWidth={1.5} />
    </svg>
  );
}

function ActorSplit({ a }: { a: Record<Actor, Small> }) {
  const parts = ACTORS.filter((k) => a[k].requests > 0);
  if (!parts.length) return <span className="text-text-muted">—</span>;
  return (
    <span className="flex flex-col text-micro leading-4">
      {parts.map((k) => (
        <span key={k} className="flex justify-between gap-2 whitespace-nowrap">
          <span className="text-text-muted">{ACTOR_LABEL[k]}</span><span className="tabular-nums text-text-secondary">{usd(a[k].cost_usd)}</span>
        </span>
      ))}
    </span>
  );
}

/** The cap this workspace is closest to (its share of a global feature cap), all of them on hover. */
function CapCell({ caps, wide = false }: { caps: CapRow[]; wide?: boolean }) {
  const capped = caps.filter((c) => c.month_pct !== null || c.today_pct !== null);
  if (!capped.length) return <span className="text-text-muted">{caps.length ? "No cap" : "—"}</span>;
  const top = capped[0];
  const pctOf = (c: CapRow) => Math.max(c.today_pct ?? 0, c.month_pct ?? 0);
  const p = pctOf(top);
  return (
    <Tooltip focusable content={<span className="flex flex-col gap-0.5">{capped.map((c) => (
      <span key={c.feature}>{c.label}: today {usd(c.today_usd)} of {capText(c.daily_cap_usd)}, month {usd(c.month_usd)} of {capText(c.monthly_cap_usd)}</span>
    ))}</span>}>
      <span className={`flex ${wide ? "w-32" : "w-24"} flex-col gap-1`} aria-label={`${top.label}: ${p}% of its cap`}>
        <span className="flex justify-between gap-2 text-micro"><span className="truncate text-text-secondary">{top.label}</span><span className="tabular-nums text-text">{p}%</span></span>
        <span className="h-1 w-full rounded-full" style={{ background: "var(--chart-track)" }}>
          <span className="block h-full rounded-full" style={{ width: `${Math.min(100, p)}%`, background: p >= 80 ? "var(--warning)" : "var(--chart-1)" }} />
        </span>
      </span>
    </Tooltip>
  );
}

function WsName({ w }: { w: WsMeta }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className={`max-w-[14rem] truncate ${w.none ? "italic text-text-secondary" : "text-text"}`} title={w.name}>{w.name}</span>
        {w.deleted && !w.none && <Badge size="sm" tone="neutral">Deleted</Badge>}
      </span>
      <span className="max-w-[14rem] truncate text-micro text-text-muted">
        {w.none ? "Personal pages, public visitors" : [w.owner?.email, w.members !== null ? plural(w.members, "member") : null].filter(Boolean).join(" · ") || "—"}
      </span>
    </span>
  );
}

export function WorkspacesTab({ token, openId, onOpen, onOpenUser, onRequests }: {
  token: string; openId: string | null; onOpen: (id: string | null) => void; onOpenUser: (id: string) => void; onRequests: (l: RequestsLink) => void;
}) {
  const get = useAiFetch(token);
  const download = useAiDownload(token);
  const toast = useToast();
  const wide = useWide();
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const [range, setRange] = useState<RangeKey>("30d");
  const [audience, setAudience] = useState<UsageAudience>("live");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("cost");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const list = useLoad(() => get<ListRes>("usage/workspaces", { range, tz, audience, q: query, sort, order, page, limit: 25 }),
    [get, range, tz, audience, query, sort, order, page]);

  useEffect(() => {
    const t = setTimeout(() => { setPage(1); setQuery(q.trim()); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const onSort = (k: Sort) => {
    if (k === sort) setOrder((o) => (o === "desc" ? "asc" : "desc"));
    else { setSort(k); setOrder(k === "name" ? "asc" : "desc"); }
    setPage(1);
  };
  const sh = (label: string, k: Sort, align?: "right") => <SortHeader label={label} k={k} sort={sort} order={order} onSort={onSort} align={align} />;

  const cols: Column<WsRow>[] = [
    { key: "ws", header: sh("Workspace", "name"), primary: true, render: (w) => <WsName w={w} /> },
    { key: "cost", header: sh("Cost", "cost", "right"), align: "right", render: (w) => (
      <span className="flex flex-col items-end">
        <span className="font-medium text-text">{usd(w.cost_usd)}</span>
        {!wide && <span className="whitespace-nowrap text-micro text-text-muted">{plural(w.requests, "call")}</span>}
      </span>
    ) },
    ...(wide ? [{ key: "calls", header: sh("Calls", "requests", "right"), align: "right" as const, render: (w: WsRow) => (
      <span className="flex flex-col items-end">
        <span>{n0(w.requests)}</span>
        <span className="whitespace-nowrap text-micro text-text-muted" title="Tokens in / out">{tokensShort(w.tokens_in)} / {tokensShort(w.tokens_out)} tok</span>
      </span>
    ) }] : []),
    { key: "who", header: "By whom", render: (w) => <ActorSplit a={w.by_actor} /> },
    { key: "features", header: "Features", render: (w) => <FeatureStack features={w.features} width={wide ? 120 : 84} /> },
    ...(wide ? [{ key: "trend", header: "Trend", render: (w: WsRow) => <CostSpark values={w.spark} /> }] : []),
    ...(wide ? [{ key: "top", header: "Top people", render: (w: WsRow) => (w.top_users.length === 0 ? <span className="text-text-muted">—</span> : (
      <Tooltip focusable content={<span className="flex flex-col gap-0.5">{w.top_users.map((u) => (
        <span key={u.user_id} className="flex justify-between gap-3"><span>{u.email || u.name || "Deleted account"}</span><b className="tabular-nums">{usd(u.cost_usd)}</b></span>
      ))}</span>}>
        <span className="flex min-w-0 flex-col text-micro leading-4" aria-label={`Top people: ${w.top_users.map((u) => `${u.email || u.name} ${usd(u.cost_usd)}`).join(", ")}`}>
          <span className="max-w-[9.5rem] truncate text-text-secondary">{w.top_users[0].email || w.top_users[0].name || "Deleted account"}</span>
          <span className="text-text-muted">{usd(w.top_users[0].cost_usd)}{w.top_users.length > 1 ? ` · +${w.top_users.length - 1} more` : ""}</span>
        </span>
      </Tooltip>
    )) }] : []),
    { key: "caps", header: "Closest cap", render: (w) => <CapCell caps={w.caps} wide={wide} /> },
  ];

  async function exportCsv() {
    setExporting(true);
    try {
      await download("usage/workspaces.csv", { range, tz, audience, q: query }, "markdrop-ai-workspaces.csv");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't export.");
    } finally {
      setExporting(false);
    }
  }

  const d = list.data;
  const legend = useMemo(() => {
    const keys = new Set((d?.items ?? []).flatMap((w) => foldFeatures(w.features).map((f) => f.key)));
    return [...WS_FEATURE_ORDER, WS_OTHER].filter((k) => keys.has(k)).map((k) => ({ key: k, label: k === WS_OTHER ? "Other" : featureLabel(k) }));
  }, [d]);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <form className="flex min-w-0 flex-wrap items-center gap-2" role="search" onSubmit={(e) => { e.preventDefault(); setPage(1); setQuery(q.trim()); }}>
          <Input aria-label="Search workspaces" placeholder="Search workspace or owner" iconPrefix="search" value={q} onChange={(e) => setQ(e.target.value)} wrapClassName="w-64" />
          <AudienceSelect value={audience} onChange={(v) => { setAudience(v); setPage(1); }} />
        </form>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl<RangeKey> size="sm" aria-label="Date range" value={range} onChange={(v) => { setRange(v); setPage(1); }} options={RANGE_OPTIONS} />
          <Button size="sm" variant="secondary" iconLeft="download" loading={exporting} onClick={exportCsv}>Workspaces CSV</Button>
        </div>
      </div>
      {list.loading && d && <Progress indeterminate size="sm" aria-label="Updating" valueText="Loading" />}
      {list.error && !d ? <CardError title="AI cost by workspace" onRetry={list.reload} /> : (
        <Card aria-label="AI cost by workspace">
          {!d ? <LoadingBlock label="Loading workspaces" minHeight={280} /> : (
            <>
              <div className="mb-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <p className="text-caption text-text-secondary" data-testid="ai-ws-summary">
                    <b className="text-text">{usd(d.totals.cost_usd)}</b> across {plural(d.totals.workspaces, "workspace")}
                    {d.totals.no_workspace_usd > 0 && <> and no workspace ({usd(d.totals.no_workspace_usd)})</>} · {plural(d.totals.requests, "call")}.
                    {" "}System jobs count towards the workspace they ran for. Open a row for the breakdown.
                  </p>
                  <LeftOutNote audience={audience} leftOut={d.left_out} />
                </div>
                {legend.length > 0 && <FeatureLegend features={legend} colorOf={wsFeatureColor} />}
              </div>
              <Table compact columns={cols} rows={d.items} rowKey={(w) => w.workspace_id} caption="AI cost by workspace"
                onRowClick={(w) => onOpen(w.workspace_id)} selected={(w) => w.workspace_id === openId}
                empty={query ? "No workspace matches that search." : "No AI use in this range."} />
              {d.pages > 1 && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-caption text-text-secondary">Page {page} of {d.pages}</p>
                  <Pagination page={page} pageCount={d.pages} onChange={setPage} />
                </div>
              )}
              <p className="mt-3 text-micro text-text-muted">
                Caps are per feature and shared by every workspace: &ldquo;Closest cap&rdquo; is this workspace&apos;s own spend as a share of one,
                today or this month, counting all traffic as the caps do.
              </p>
            </>
          )}
        </Card>
      )}
      <WorkspaceDrawer token={token} id={openId} range={range} audience={audience} tz={tz} onClose={() => onOpen(null)}
        onOpenUser={onOpenUser} onRequests={onRequests} />
    </div>
  );
}

// ── One workspace ────────────────────────────────────────────────────────────

function WorkspaceDrawer({ token, id, range, audience, tz, onClose, onOpenUser, onRequests }: {
  token: string; id: string | null; range: RangeKey; audience: UsageAudience; tz: string; onClose: () => void;
  onOpenUser: (id: string) => void; onRequests: (l: RequestsLink) => void;
}) {
  const get = useAiFetch(token);
  const download = useAiDownload(token);
  const toast = useToast();
  const [state, setState] = useState<{ data?: Detail; id?: string; error?: string }>({});
  const [metric, setMetric] = useState<Metric>("cost");
  const [exporting, setExporting] = useState(false);
  useEffect(() => {
    if (!id) return;
    let live = true;
    setState((s) => (s.id === id ? s : {}));
    get<Detail>(`usage/workspaces/${encodeURIComponent(id)}`, { range, tz, audience })
      .then((data) => live && setState({ data, id }))
      .catch((e) => live && setState({ id, error: e instanceof Error && e.message === "Workspace not found" ? "That workspace isn't there any more." : "Couldn't load this workspace." }));
    return () => { live = false; };
  }, [get, id, range, tz, audience]);
  const d = state.id === id ? state.data : undefined;
  const w = d?.workspace;

  // The chart: the workspace order, everything else folded into Other (one series, one grey).
  const chart = useMemo(() => {
    if (!d) return null;
    const keys = [...WS_FEATURE_ORDER, WS_OTHER].filter((k) => d.features.some((f) => wsFeatureKey(f.key) === k));
    const series: DayRow[] = d.series.map((s) => {
      const by: Record<string, number> = {};
      const req: Record<string, number> = {};
      for (const f of d.features) {
        const k = wsFeatureKey(f.key);
        by[k] = (by[k] ?? 0) + (s.by_feature[f.key] ?? 0);
        req[k] = (req[k] ?? 0) + (s.requests_by_feature[f.key] ?? 0);
      }
      return { t: s.t, by_feature: by, requests_by_feature: req };
    });
    const other = d.features.filter((f) => wsFeatureKey(f.key) === WS_OTHER).map((f) => f.label);
    return { series, features: keys.map((k) => ({ key: k, label: k === WS_OTHER ? `Other (${other.join(", ")})` : featureLabel(k) })) };
  }, [d]);

  async function exportCsv() {
    if (!id) return;
    setExporting(true);
    try {
      await download("usage/export.csv", { kind: "requests", range, audience, workspace: id }, "markdrop-ai-requests.csv");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't export.");
    } finally {
      setExporting(false);
    }
  }

  const rangeLabel = RANGE_OPTIONS.find((r) => r.value === range)?.label ?? range;
  return (
    <Drawer open={!!id} onClose={onClose} width={880} title={w?.name ?? "Workspace"}
      description={w ? (w.none ? "AI calls with no workspace: personal pages, docs Ask AI visitors and anything else not filed in one"
        : [w.owner ? `Owner ${w.owner.email || w.owner.name}` : null, w.members !== null ? plural(w.members, "member") : null,
          w.switches ? `Team memory ${w.switches.team_memory ? "on" : "off"}` : null, w.switches ? `Page AI ${w.switches.page_ai ? "on" : "off"}` : null,
          w.deleted ? "deleted" : null].filter(Boolean).join(" · ")) : undefined}
      bodyClassName="flex flex-col gap-5">
      {state.error ? <Alert tone="danger">{state.error}</Alert> : !d || !chart ? <LoadingBlock label="Loading workspace" minHeight={280} /> : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {!d.workspace.none && (
              <Button size="sm" variant="secondary" iconLeft="inbox" onClick={() => onRequests({ workspace: { value: d.workspace.workspace_id, label: d.workspace.name }, range, audience })}>
                Its conversations in Requests
              </Button>
            )}
            <Button size="sm" variant="secondary" iconLeft="download" loading={exporting} onClick={exportCsv}>Requests CSV</Button>
            <LeftOutNote audience={audience} leftOut={d.left_out} />
          </div>

          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Cost", usd(d.kpis.cost_usd), `in ${rangeLabel}`],
              ["Calls", n0(d.kpis.requests), d.kpis.last_used ? `last ${ago(d.kpis.last_used)}` : "—"],
              ["Tokens in / out", `${tokensShort(d.kpis.tokens_in)} / ${tokensShort(d.kpis.tokens_out)}`, `cache read ${tokensShort(d.kpis.tokens.cache_read)}`],
              ["People", n0(d.kpis.people), d.workspace.members !== null ? `of ${plural(d.workspace.members, "member")}` : "signed in"],
            ].map(([k, v, sub]) => (
              <div key={k} className="rounded-lg border border-border p-3">
                <dt className="text-micro text-text-secondary">{k}</dt>
                <dd className="mt-0.5 text-body-strong tabular-nums text-text">{v}</dd>
                <dd className="truncate text-micro text-text-muted">{sub}</dd>
              </div>
            ))}
          </dl>

          <section aria-labelledby="ws-who">
            <Eyebrow><span id="ws-who">By whom</span></Eyebrow>
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {ACTORS.map((a) => (
                <li key={a} className="rounded-lg bg-surface-inset px-3 py-2">
                  <p className="text-micro text-text-secondary">{ACTOR_LABEL[a]}</p>
                  <p className="tabular-nums text-text"><b>{usd(d.by_actor[a].cost_usd)}</b>
                    <span className="ml-1.5 text-micro text-text-muted">{plural(d.by_actor[a].requests, "call")}</span></p>
                </li>
              ))}
            </ul>
            {d.test.requests > 0 && <p className="mt-1.5 text-micro text-text-muted">Includes {plural(d.test.requests, "test/internal call")} ({usd(d.test.cost_usd)}).</p>}
          </section>

          <section aria-labelledby="ws-daily">
            <div className="mb-2 flex items-center justify-between gap-2">
              <Eyebrow><span id="ws-daily">Cost over time, by feature</span></Eyebrow>
              <SegmentedControl<Metric> size="sm" aria-label="Metric" value={metric} onChange={setMetric}
                options={[{ value: "cost", label: "Cost" }, { value: "requests", label: "Calls" }]} />
            </div>
            <DailyByFeature series={chart.series} features={chart.features} metric={metric} height={160} colorOf={wsFeatureColor}
              label={metric === "cost" ? "Spend" : "Calls"} />
          </section>

          <section aria-labelledby="ws-people">
            <Eyebrow><span id="ws-people">People</span></Eyebrow>
            <Table compact columns={[
              { key: "who", header: "Person", primary: true, render: (u) => (
                <span className="flex min-w-0 flex-col">
                  <span className="max-w-[16rem] truncate text-text" title={u.email}>{u.email || (u.deleted ? "Deleted account" : u.name || "—")}</span>
                  <span className="text-micro text-text-muted">{u.role ? u.role[0].toUpperCase() + u.role.slice(1) : d.workspace.none ? (u.name || "") : "Not a member"}</span>
                </span>
              ) },
              { key: "features", header: "Features", render: (u) => (
                <span className="flex items-center gap-1" aria-label={u.features.map(featureLabel).join(", ")}>
                  {u.features.map((f) => <span key={f} title={featureLabel(f)} className="size-2.5 rounded-xs" style={{ background: wsFeatureColor(wsFeatureKey(f)) }} />)}
                </span>
              ) },
              { key: "calls", header: "Calls", align: "right", render: (u) => n0(u.requests) },
              { key: "tok", header: "Tokens in / out", align: "right", render: (u) => <span className="whitespace-nowrap">{tokensShort(u.tokens_in)} / {tokensShort(u.tokens_out)}</span> },
              { key: "apps", header: "Via AI apps", align: "right", render: (u) => (u.apps.requests ? usd(u.apps.cost_usd) : <span className="text-text-muted">—</span>) },
              { key: "cost", header: "Cost", align: "right", render: (u) => <span className="font-medium text-text">{usd(u.cost_usd)}</span> },
              { key: "last", header: "Last used", render: (u) => <span className="whitespace-nowrap">{ago(u.last_used)}</span> },
            ] satisfies Column<Detail["users"][number]>[]} rows={d.users} rowKey={(u) => u.user_id} caption="People in this workspace using AI"
              onRowClick={(u) => onOpenUser(u.user_id)} empty="No signed-in person used AI here in this range." />
            {d.users.length > 0 && <p className="mt-1.5 text-micro text-text-muted">Open a person for their own usage, Block and a daily cap (Users).</p>}
          </section>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <section aria-labelledby="ws-feat">
              <Eyebrow><span id="ws-feat">Features</span></Eyebrow>
              <Table compact hover={false} columns={[
                { key: "f", header: "Feature", primary: true, render: (f) => (
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <span aria-hidden className="size-2.5 shrink-0 rounded-xs" style={{ background: wsFeatureColor(wsFeatureKey(f.key)) }} />
                    <span className="truncate text-text">{f.label}</span>
                  </span>
                ) },
                { key: "calls", header: "Calls", align: "right", render: (f) => n0(f.requests) },
                { key: "people", header: "People", align: "right", render: (f) => n0(f.people) },
                { key: "cost", header: "Cost", align: "right", render: (f) => (
                  <span className="whitespace-nowrap"><span className="font-medium text-text">{usd(f.cost_usd)}</span>
                    {f.share_pct !== null && <span className="ml-1 text-micro text-text-muted">{f.share_pct}%</span>}</span>
                ) },
              ] satisfies Column<Detail["by_feature"][number]>[]} rows={d.by_feature} rowKey={(f) => f.key} caption="Cost by feature" empty="Nothing in this range." />
            </section>
            <section aria-labelledby="ws-jobs">
              <Eyebrow><span id="ws-jobs">System jobs</span></Eyebrow>
              <Table compact hover={false} columns={[
                { key: "job", header: "Job", primary: true, render: (j) => (
                  <span className="flex min-w-0 flex-col"><span className="truncate text-text">{j.job}</span><span className="text-micro text-text-muted">{j.label}</span></span>
                ) },
                { key: "calls", header: "Calls", align: "right", render: (j) => n0(j.requests) },
                { key: "cost", header: "Cost", align: "right", render: (j) => <span className="font-medium text-text">{usd(j.cost_usd)}</span> },
                { key: "last", header: "Last run", render: (j) => <span className="whitespace-nowrap" title={j.last_used ? fmtDateTime(j.last_used) : undefined}>{ago(j.last_used)}</span> },
              ] satisfies Column<Detail["jobs"][number]>[]} rows={d.jobs} rowKey={(j) => `${j.job}:${j.feature}`} caption="System jobs"
                empty="No background jobs ran for this workspace in this range." />
              {d.public.requests > 0 && (
                <p className="mt-2 text-caption text-text-secondary">Public visitors: {plural(d.public.requests, "call")}, {usd(d.public.cost_usd)}.</p>
              )}
            </section>
          </div>

          <section aria-labelledby="ws-caps">
            <Eyebrow><span id="ws-caps">Caps</span></Eyebrow>
            {d.caps.length === 0 ? <p className="text-caption text-text-secondary">No AI spend here this month.</p> : (
              <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {d.caps.map((c) => (
                  <li key={c.feature} className="flex flex-col gap-2 rounded-lg border border-border p-3">
                    <p className="flex items-center justify-between gap-2 text-caption">
                      <span className="inline-flex items-center gap-1.5 text-text">
                        {c.feature !== "*" && <span aria-hidden className="size-2.5 rounded-xs" style={{ background: wsFeatureColor(wsFeatureKey(c.feature)) }} />}{c.label}
                      </span>
                      <span className="text-micro text-text-muted">all workspaces: {usd(c.feature_today_usd)} today · {usd(c.feature_month_usd)} this month</span>
                    </p>
                    <CapMeter label="Today" value={c.today_usd} cap={c.daily_cap_usd} pct={c.today_pct} />
                    <CapMeter label="This month" value={c.month_usd} cap={c.monthly_cap_usd} pct={c.month_pct} />
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-micro text-text-muted">
              No workspace has a cap of its own: these are the global per-feature caps (Budgets), and the meters show this workspace&apos;s share.
              They count all traffic, test calls included, and today and this month are UTC, as the caps count them.
            </p>
          </section>
          <p className="text-micro text-text-muted">
            Days are in your timezone. What was asked and answered is never shown here: the Requests tab keeps 30 days of conversations.
          </p>
        </>
      )}
    </Drawer>
  );
}

function CapMeter({ label, value, cap, pct }: { label: string; value: number; cap: number | null; pct: number | null }) {
  if (cap === null) {
    return (
      <div className="flex items-baseline justify-between gap-2 text-caption">
        <span className="text-text-secondary">{label}</span>
        <span className="tabular-nums text-text">{usd(value)} <span className="text-text-muted">· no cap</span></span>
      </div>
    );
  }
  return (
    <Meter size="sm" label={label} value={value} max={cap || 0.000001} threshold={0.8}
      meta={`${usd(value)} of ${usd(cap)}${pct !== null ? ` · ${pct}%` : ""}`} valueText={`${usd(value)} of the ${usd(cap)} cap`} />
  );
}
