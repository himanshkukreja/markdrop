"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Alert, Badge, Button, ConfirmDialog, Drawer, Field, Icon, Input, Pagination, Progress, SegmentedControl, Select, Table,
  useToast, type Column,
} from "@/components/ui";
import { Card, CardError, Eyebrow } from "../analytics/ui";
import { LoadingBlock, fmtDate, fmtDateTime, plural } from "../shared";
import { AudienceSelect, LeftOutNote, type LeftOut, type UsageAudience } from "./audience";
import { DailyByFeature, FeatureBars, type DayRow, type Metric } from "./charts";
import {
  FEATURE_LABEL, LIMIT_LABEL, OUTCOME_LABEL, OUTCOME_TONE, RANGE_OPTIONS, ago, capText, featureColor, n0, pct, secs, tokensShort, usd,
  useAiDownload, useAiFetch, useAiSend, useLoad, type RangeKey,
} from "./common";

/** Admin → AI → Users: everyone who used AI, with a drill-down, Block and a per-person daily cap.
 *  Never shows what anyone asked or got back (that is the Requests tab). System jobs are one row
 *  (user_id "system"); test & internal traffic is left out unless the audience filter asks for it. */

type Tok = { input: number; output: number; cache_read: number; cache_write: number };
interface Agg { requests: number; ok: number; errors: number; limited: number; cost_usd: number; tokens: Tok; total_tokens: number; cache_hit_pct: number | null }
interface UserRow extends Agg {
  user_id: string; anonymous: boolean; system?: boolean; email: string; name: string; deleted?: boolean; visitors?: number;
  blocked: boolean; daily_cap_usd: number | null; effective_daily_cap_usd: number | null; today_usd: number | null;
  features: string[]; last_used: string | null;
}
interface UsersRes {
  total: number; pages: number; page: number; items: UserRow[]; default_daily_cap_usd: number | null;
  audience?: UsageAudience; left_out?: LeftOut;
}
interface RequestRow {
  request_id: string; ts: string; feature: string; action: string | null; site: string | null; slug: string | null; page: string | null;
  workspace_id: string | null; conversation_id: string | null; outcome: string; limit_reason: string | null; error_code: string | null;
  tokens: Tok; cost_usd: number; latency_ms: number | null; model: string | null;
  actor?: string | null; job?: string | null; app?: string | null; test?: boolean;
}
interface UserDetail {
  user: { user_id: string; anonymous: boolean; system?: boolean; email: string; name: string; created_at: string | null; deleted: boolean };
  settings: null | {
    blocked: boolean; daily_cap_usd: number | null; effective_daily_cap_usd: number | null; default_daily_cap_usd: number | null;
    today_usd: number; burst: { per_minute: number; per_day: number };
  };
  kpis: Agg & { last_used: string | null; visitors: number | null };
  by_feature: (Agg & { key: string; label: string })[];
  by_action: (Agg & { feature: string; label: string; action: string })[];
  series: DayRow[];
  recent: RequestRow[];
}

type Sort = "cost" | "requests" | "tokens" | "last_used" | "email" | "errors";
const fLabel = (k: string) => FEATURE_LABEL[k] ?? k;
const ORDER = Object.keys(FEATURE_LABEL);
/** Features in the registry's fixed order (colour follows the feature, never its rank). */
const byRegistry = (fs: string[]) => [...fs].sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));

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

function Who({ u }: { u: Pick<UserRow, "anonymous" | "system" | "email" | "name" | "deleted" | "visitors"> }) {
  if (u.system) {
    return (
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-text">System jobs</span>
        <span className="truncate text-micro text-text-muted">Background and scheduled AI work</span>
      </span>
    );
  }
  if (u.anonymous) {
    return (
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-text">Anonymous visitors</span>
        <span className="truncate text-micro text-text-muted">{plural(u.visitors ?? 0, "visitor")}, signed out</span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-col">
      <span className="max-w-[18rem] truncate text-text" title={u.email}>{u.email || (u.deleted ? "Deleted account" : "—")}</span>
      {u.name && <span className="max-w-[18rem] truncate text-micro text-text-muted">{u.name}</span>}
    </span>
  );
}

export function UsersTab({ token, openId, onOpen }: { token: string; openId: string | null; onOpen: (id: string | null) => void }) {
  const get = useAiFetch(token);
  const download = useAiDownload(token);
  const toast = useToast();
  const [range, setRange] = useState<RangeKey>("30d");
  const [feature, setFeature] = useState("");
  const [audience, setAudience] = useState<UsageAudience>("live");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("cost");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [bump, setBump] = useState(0);
  const [exporting, setExporting] = useState<string | null>(null);
  const list = useLoad(() => get<UsersRes>("usage/users", { range, feature, q: query, sort, order, page, limit: 25, audience }),
    [get, range, feature, query, sort, order, page, audience, bump]);

  // Search as you type, a beat after the last key.
  useEffect(() => {
    const t = setTimeout(() => { setPage(1); setQuery(q.trim()); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const onSort = (k: Sort) => {
    if (k === sort) setOrder((o) => (o === "desc" ? "asc" : "desc"));
    else { setSort(k); setOrder(k === "email" ? "asc" : "desc"); }
    setPage(1);
  };
  const sh = (label: string, k: Sort, align?: "right") => <SortHeader label={label} k={k} sort={sort} order={order} onSort={onSort} align={align} />;

  const cols: Column<UserRow>[] = [
    { key: "who", header: sh("Person", "email"), primary: true, render: (u) => (
      <span className="flex min-w-0 items-center gap-2">
        <Who u={u} />
        {u.blocked && <Badge size="sm" tone="danger">Blocked</Badge>}
      </span>
    ) },
    { key: "features", header: "Features", render: (u) => (
      <span className="flex items-center gap-1" aria-label={u.features.map(fLabel).join(", ") || "None"}>
        {u.features.length === 0 ? <span className="text-text-muted">—</span> : byRegistry(u.features).map((f) => (
          <span key={f} title={fLabel(f)} className="size-2.5 rounded-xs" style={{ background: featureColor(f) }} />
        ))}
      </span>
    ) },
    { key: "requests", header: sh("Requests", "requests", "right"), align: "right", render: (u) => (
      <span>{n0(u.requests)}{u.errors > 0 && <span className="ml-1 text-micro text-danger-text">{u.errors} err</span>}</span>
    ) },
    { key: "tokens", header: sh("Tokens in / out", "tokens", "right"), align: "right", render: (u) => `${tokensShort(u.tokens.input + u.tokens.cache_read + u.tokens.cache_write)} / ${tokensShort(u.tokens.output)}` },
    { key: "cost", header: sh("Cost", "cost", "right"), align: "right", render: (u) => <span className="font-medium">{usd(u.cost_usd)}</span> },
    { key: "cap", header: "Today / cap", align: "right", render: (u) => (u.anonymous || u.system ? <span className="text-text-muted">—</span> : (
      <span className={u.daily_cap_usd !== null ? "text-text" : "text-text-secondary"}>{usd(u.today_usd)} / {capText(u.effective_daily_cap_usd)}</span>
    )) },
    { key: "last", header: sh("Last used", "last_used"), render: (u) => <span className="whitespace-nowrap">{ago(u.last_used)}</span> },
  ];

  async function exportCsv(kind: "users" | "requests") {
    setExporting(kind);
    try {
      await download("usage/export.csv", { kind, range, feature, audience }, `markdrop-ai-${kind}.csv`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't export.");
    } finally {
      setExporting(null);
    }
  }

  const d = list.data;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <form className="flex min-w-0 flex-wrap items-center gap-2" role="search" onSubmit={(e) => { e.preventDefault(); setPage(1); setQuery(q.trim()); }}>
          <Input aria-label="Search people" placeholder="Search email or name" iconPrefix="search" value={q} onChange={(e) => setQ(e.target.value)} wrapClassName="w-64" />
          <Select aria-label="Feature" value={feature} onChange={(e) => { setFeature(e.target.value); setPage(1); }}
            options={[{ value: "", label: "All features" }, ...Object.entries(FEATURE_LABEL).map(([value, label]) => ({ value, label }))]} />
          <AudienceSelect value={audience} onChange={(v) => { setAudience(v); setPage(1); }} />
        </form>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl<RangeKey> size="sm" aria-label="Date range" value={range} onChange={(v) => { setRange(v); setPage(1); }} options={RANGE_OPTIONS} />
          <Button size="sm" variant="secondary" iconLeft="download" loading={exporting === "users"} onClick={() => exportCsv("users")}>Users CSV</Button>
          <Button size="sm" variant="secondary" iconLeft="download" loading={exporting === "requests"} onClick={() => exportCsv("requests")}>Requests CSV</Button>
        </div>
      </div>
      {list.loading && d && <Progress indeterminate size="sm" aria-label="Updating" valueText="Loading" />}
      {list.error && !d ? <CardError title="People using AI" onRetry={list.reload} /> : (
        <Card aria-label="People using AI">
          {!d ? <LoadingBlock label="Loading people" minHeight={280} /> : (
            <>
              <p className="mb-3 text-caption text-text-secondary">
                {plural(d.total, "row")} · default per-person daily cap {capText(d.default_daily_cap_usd)}. Open a row for the breakdown, recent requests, Block and a daily cap.
              </p>
              <div className="-mt-2 mb-3"><LeftOutNote audience={audience} leftOut={d.left_out} /></div>
              <Table compact columns={cols} rows={d.items} rowKey={(u) => u.user_id} caption="People using AI"
                onRowClick={(u) => onOpen(u.user_id)} selected={(u) => u.user_id === openId}
                empty={query ? "Nobody matches that search." : "No AI use in this range."} />
              {d.pages > 1 && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-caption text-text-secondary">Page {page} of {d.pages}</p>
                  <Pagination page={page} pageCount={d.pages} onChange={setPage} />
                </div>
              )}
            </>
          )}
        </Card>
      )}
      <UserDrawer token={token} id={openId} range={range} onClose={() => onOpen(null)} onChanged={() => setBump((b) => b + 1)} />
    </div>
  );
}

// ── Drill-down ───────────────────────────────────────────────────────────────

function UserDrawer({ token, id, range, onClose, onChanged }: { token: string; id: string | null; range: RangeKey; onClose: () => void; onChanged: () => void }) {
  const get = useAiFetch(token);
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const [state, setState] = useState<{ data?: UserDetail; error?: string }>({});
  const [bump, setBump] = useState(0);
  const [metric, setMetric] = useState<Metric>("cost");
  useEffect(() => {
    if (!id) return;
    let live = true;
    setState((s) => (s.data?.user.user_id === id ? s : {}));
    get<UserDetail>(`usage/users/${encodeURIComponent(id)}`, { range, tz, limit: 50 })
      .then((data) => live && setState({ data }))
      .catch((e) => live && setState({ error: e instanceof Error && e.message === "User not found" ? "That person isn't there any more." : "Couldn't load this person." }));
    return () => { live = false; };
  }, [get, id, range, tz, bump]);
  const d = state.data && state.data.user.user_id === id ? state.data : undefined;
  const title = d ? (d.user.system ? "System jobs" : d.user.anonymous ? "Anonymous visitors" : d.user.email || "Deleted account") : "AI usage";
  return (
    <Drawer open={!!id} onClose={onClose} width={760} title={title}
      description={d ? (d.user.system ? "Background and scheduled AI work (team memory, summaries, cover art)" : d.user.anonymous ? "Everyone signed out, together" : `${d.user.name ? `${d.user.name} · ` : ""}joined ${fmtDate(d.user.created_at)}`) : undefined}
      bodyClassName="flex flex-col gap-5">
      {state.error ? <Alert tone="danger">{state.error}</Alert> : !d ? <LoadingBlock label="Loading usage" minHeight={280} /> : (
        <>
          {d.settings && <Controls token={token} detail={d} onSaved={() => { setBump((b) => b + 1); onChanged(); }} />}
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Requests", n0(d.kpis.requests), `${d.kpis.errors} errors · ${d.kpis.limited} refused`],
              ["Cost", usd(d.kpis.cost_usd), `in ${RANGE_OPTIONS.find((r) => r.value === range)?.label ?? range}`],
              ["Tokens", `${tokensShort(d.kpis.tokens.input + d.kpis.tokens.cache_read + d.kpis.tokens.cache_write)} / ${tokensShort(d.kpis.tokens.output)}`, `in / out · cache hit ${pct(d.kpis.cache_hit_pct)}`],
              ["Last used", ago(d.kpis.last_used), d.kpis.last_used ? fmtDateTime(d.kpis.last_used) : "—"],
            ].map(([k, v, sub]) => (
              <div key={k} className="rounded-lg border border-border p-3">
                <dt className="text-micro text-text-secondary">{k}</dt>
                <dd className="mt-0.5 text-body-strong tabular-nums text-text">{v}</dd>
                <dd className="truncate text-micro text-text-muted">{sub}</dd>
              </div>
            ))}
          </dl>

          <section aria-labelledby="ud-daily">
            <div className="mb-2 flex items-center justify-between gap-2">
              <Eyebrow><span id="ud-daily">Each day</span></Eyebrow>
              <SegmentedControl<Metric> size="sm" aria-label="Metric" value={metric} onChange={setMetric}
                options={[{ value: "cost", label: "Cost" }, { value: "requests", label: "Requests" }]} />
            </div>
            <DailyByFeature series={d.series} features={d.by_feature.map((f) => ({ key: f.key, label: f.label }))} metric={metric} height={140} />
          </section>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <section aria-labelledby="ud-feat">
              <Eyebrow><span id="ud-feat">By feature</span></Eyebrow>
              <FeatureBars rows={d.by_feature.map((f) => ({ key: f.key, label: f.label, value: f.cost_usd, sub: plural(f.requests, "request") }))} />
            </section>
            <section aria-labelledby="ud-act">
              <Eyebrow><span id="ud-act">By action</span></Eyebrow>
              {d.by_action.length === 0 ? <p className="py-3 text-caption text-text-secondary">Nothing in this range.</p> : (
                <ul className="flex flex-col divide-y divide-border text-caption">
                  {d.by_action.slice(0, 8).map((a) => (
                    <li key={`${a.feature}:${a.action}`} className="flex items-center justify-between gap-3 py-1.5">
                      <span className="inline-flex min-w-0 items-center gap-2">
                        <span aria-hidden className="size-2 shrink-0 rounded-xs" style={{ background: featureColor(a.feature) }} />
                        <span className="truncate text-text">{a.action}</span>
                        <span className="truncate text-micro text-text-muted">{a.label}</span>
                      </span>
                      <span className="shrink-0 tabular-nums text-text-secondary">{n0(a.requests)} · <span className="text-text">{usd(a.cost_usd)}</span></span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section aria-labelledby="ud-recent">
            <Eyebrow><span id="ud-recent">Recent requests</span></Eyebrow>
            <RecentTable rows={d.recent} />
            <p className="mt-2 text-micro text-text-muted">What was asked and answered is never shown here: the Requests tab has every conversation.</p>
          </section>
        </>
      )}
    </Drawer>
  );
}

function RecentTable({ rows }: { rows: RequestRow[] }) {
  const cols: Column<RequestRow>[] = [
    { key: "when", header: "When", render: (r) => <span className="whitespace-nowrap">{fmtDateTime(r.ts)}</span> },
    { key: "what", header: "What", primary: true, render: (r) => (
      <span className="flex min-w-0 flex-col">
        <span className="inline-flex items-center gap-1.5 text-text">
          <span aria-hidden className="size-2 shrink-0 rounded-xs" style={{ background: featureColor(r.feature) }} />
          <span className="truncate">{fLabel(r.feature)}{r.action ? ` · ${r.action}` : ""}</span>
          <ActorTag r={r} />
        </span>
        <span className="max-w-[16rem] truncate text-micro text-text-muted" title={[r.slug, r.site, r.page].filter(Boolean).join(" · ")}>
          {[r.slug && `/${r.slug}`, r.site && `site ${r.site.length > 12 ? `${r.site.slice(0, 8)}…` : r.site}`, r.page].filter(Boolean).join(" · ") || "—"}
        </span>
      </span>
    ) },
    { key: "out", header: "Outcome", render: (r) => (
      <Badge size="sm" tone={OUTCOME_TONE[r.outcome] ?? "neutral"} title={r.limit_reason ?? r.error_code ?? undefined}>
        {r.outcome === "limit" && r.limit_reason ? LIMIT_LABEL[r.limit_reason] ?? r.limit_reason : OUTCOME_LABEL[r.outcome] ?? r.outcome}
      </Badge>
    ) },
    { key: "tok", header: "Tokens", align: "right", render: (r) => <span className="whitespace-nowrap">{tokensShort(r.tokens.input + r.tokens.cache_read + r.tokens.cache_write)} / {tokensShort(r.tokens.output)}</span> },
    { key: "cost", header: "Cost", align: "right", render: (r) => usd(r.cost_usd) },
    { key: "time", header: "Time", align: "right", render: (r) => <span className="whitespace-nowrap">{secs(r.latency_ms)}</span> },
  ];
  return <Table compact hover={false} columns={cols} rows={rows} rowKey={(r) => r.request_id} caption="Recent requests" empty="No requests in this range." />;
}

/** Who made a recent call, when it isn't the person themselves: a test, a job, or an AI app. */
function ActorTag({ r }: { r: RequestRow }) {
  if (r.test) return <Badge size="sm" tone="warning" title="Test & internal traffic">Test</Badge>;
  if (r.actor === "system") return <Badge size="sm" tone="neutral" icon="server" title="System job">{r.job || "System"}</Badge>;
  if (r.actor === "api") return <Badge size="sm" tone="info" title="Through an AI app">{r.app ? `via ${r.app}` : "AI app"}</Badge>;
  if (r.actor === "public") return <Badge size="sm" tone="neutral" title="A public visitor">Public</Badge>;
  return null;
}

// ── Block and cap ────────────────────────────────────────────────────────────

function Controls({ token, detail, onSaved }: { token: string; detail: UserDetail; onSaved: () => void }) {
  const send = useAiSend(token);
  const toast = useToast();
  const s = detail.settings!;
  const [confirm, setConfirm] = useState<null | "block" | "unblock" | "cap">(null);
  const [cap, setCap] = useState(s.daily_cap_usd === null ? "" : String(s.daily_cap_usd));
  const [capErr, setCapErr] = useState<string | null>(null);
  useEffect(() => { setCap(s.daily_cap_usd === null ? "" : String(s.daily_cap_usd)); }, [s.daily_cap_usd]);
  const who = detail.user.email || "this person";
  const capValue = cap.trim() === "" ? null : Number(cap);
  const capChanged = capValue !== s.daily_cap_usd;

  async function save(body: { blocked?: boolean; daily_usd?: number | null }, done: string) {
    await send(`users/${encodeURIComponent(detail.user.user_id)}`, body);
    toast.success(done);
    setConfirm(null);
    onSaved();
  }

  return (
    <section aria-label="AI access" className="flex flex-col gap-3 rounded-lg border border-border bg-surface-inset p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-body-strong text-text">
            AI access {s.blocked ? <Badge size="sm" tone="danger">Blocked</Badge> : <Badge size="sm" tone="success" dot>Allowed</Badge>}
          </p>
          <p className="text-caption text-text-secondary">
            Today {usd(s.today_usd)} of {capText(s.effective_daily_cap_usd)}{s.daily_cap_usd === null && s.effective_daily_cap_usd !== null ? " (the default)" : ""} ·
            burst {s.burst.per_minute}/min, {s.burst.per_day}/day
          </p>
        </div>
        {s.blocked
          ? <Button size="sm" variant="secondary" iconLeft="check" onClick={() => setConfirm("unblock")}>Unblock</Button>
          : <Button size="sm" variant="danger" iconLeft="userX" onClick={() => setConfirm("block")}>Block from AI</Button>}
      </div>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
        e.preventDefault();
        if (capValue !== null && (!Number.isFinite(capValue) || capValue < 0)) { setCapErr("A number of dollars, 0 or more. Leave empty for the default."); return; }
        setCapErr(null);
        setConfirm("cap");
      }}>
        <Field label="Own daily cap (USD)" error={capErr ?? undefined}>
          <Input size="sm" inputMode="decimal" textPrefix="$" placeholder={s.default_daily_cap_usd === null ? "No cap" : String(s.default_daily_cap_usd)}
            value={cap} onChange={(e) => setCap(e.target.value)} wrapClassName="w-32" invalid={!!capErr} />
        </Field>
        <Button size="sm" type="submit" variant="secondary" disabled={!capChanged}>Set daily cap</Button>
        <span className="pb-1.5 text-micro text-text-muted">Empty: the default ({capText(s.default_daily_cap_usd)})</span>
      </form>
      <ConfirmDialog open={confirm === "block"} onClose={() => setConfirm(null)} tone="danger" confirmLabel="Block from AI"
        title={`Block ${who} from AI?`}
        body="Every AI feature refuses their requests at once (Docs Ask AI, Guides editor AI, Pages AI). Their usage stays on record. You can unblock them any time."
        onConfirm={() => save({ blocked: true }, "Blocked from AI")} />
      <ConfirmDialog open={confirm === "unblock"} onClose={() => setConfirm(null)} tone="default" confirmLabel="Unblock"
        title={`Unblock ${who}?`} body="They can use AI again, within the caps." onConfirm={() => save({ blocked: false }, "Unblocked")} />
      <ConfirmDialog open={confirm === "cap"} onClose={() => setConfirm(null)} tone="default" confirmLabel="Set cap"
        title={capValue === null ? "Back to the default cap?" : `Cap ${who} at ${usd(capValue)} a day?`}
        body={capValue === null
          ? `Their own cap is removed; the default (${capText(s.default_daily_cap_usd)}) applies.`
          : `Once their AI spend today reaches ${usd(capValue)}, every AI feature refuses their requests until midnight UTC. Spent today so far: ${usd(s.today_usd)}.`}
        onConfirm={() => save({ daily_usd: capValue }, capValue === null ? "Cap removed" : "Daily cap set")} />
    </section>
  );
}
